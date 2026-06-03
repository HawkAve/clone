import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

function uvAvailable(): boolean {
  try {
    execSync("command -v uv", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Best-effort Python package name (for `uv tool install` / `uv tool uninstall`):
// pyproject [project] name, else setup.py name=, else null.
function pyPackageName(repoPath: string): string | null {
  try {
    const pp = join(repoPath, "pyproject.toml");
    if (existsSync(pp)) {
      const m = readFileSync(pp, "utf-8").match(/^\s*name\s*=\s*["']([^"']+)["']/m);
      if (m) return m[1];
    }
    const sp = join(repoPath, "setup.py");
    if (existsSync(sp)) {
      const m = readFileSync(sp, "utf-8").match(/name\s*=\s*["']([^"']+)["']/);
      if (m) return m[1];
    }
  } catch {
    /* unreadable — fall through */
  }
  return null;
}

// A build recipe: the ordered shell commands to run (in the repo dir) plus hints
// about where produced binaries land. Modelled on makepkg's build()/package()
// split, but auto-detected since a git repo has no PKGBUILD.
export interface BuildRecipe {
  system: string; // cargo|npm|go|cmake|meson|make|python|recipe
  steps: string[]; // shell commands, run in order, cwd = repo root
  binHints: string[]; // dirs (relative to repo) likely to hold produced binaries
  declaredBins?: { name: string; file: string }[]; // explicitly known bins (npm, recipe)
  external?: boolean; // installer places its own bins (pip) — skip snapshot-linking
  interpreted?: boolean; // bin references its package (npm) — keep build dir + symlink, don't copy
  deps?: string[]; // other owner/repo this repo needs (from `dep:` recipe lines)
  uvtool?: boolean; // python: install via `uv tool install` (isolated venv) not pip --user
  pkgName?: string; // python package/tool name (for `uv tool uninstall`)
}

const RECIPE_FILE = ".clone-recipe";

// Parse a `.clone-recipe` override. Format (simple, line-based):
//   # comments
//   bin: relative/path/to/binary      (repeatable — explicit artifacts to link)
//   dep: owner/repo                    (repeatable — install this first, as a dependency)
//   <any other non-empty line>        (a build command, run in order)
function parseRecipe(repoPath: string): BuildRecipe | null {
  const file = join(repoPath, RECIPE_FILE);
  if (!existsSync(file)) return null;

  const steps: string[] = [];
  const declaredBins: { name: string; file: string }[] = [];
  const deps: string[] = [];
  for (const raw of readFileSync(file, "utf-8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const binMatch = line.match(/^bin\s*[:=]\s*(.+)$/i);
    const depMatch = line.match(/^dep\s*[:=]\s*(.+)$/i);
    if (binMatch) {
      const f = binMatch[1].trim();
      declaredBins.push({ name: f.split("/").pop()!, file: f });
    } else if (depMatch) {
      deps.push(depMatch[1].trim());
    } else {
      steps.push(line);
    }
  }

  return {
    system: "recipe",
    steps,
    binHints: [".", "target/release", "build", "bin", "dist"],
    declaredBins: declaredBins.length ? declaredBins : undefined,
    deps: deps.length ? deps : undefined,
  };
}

function has(repoPath: string, ...names: string[]): boolean {
  return names.some((n) => existsSync(join(repoPath, n)));
}

// Read npm "bin" field → explicit {name, file} pairs, and whether a build script exists.
function npmRecipe(repoPath: string): BuildRecipe {
  const steps = ["npm install"];
  let declaredBins: { name: string; file: string }[] | undefined;
  try {
    const pkg = JSON.parse(readFileSync(join(repoPath, "package.json"), "utf-8"));
    if (pkg.scripts && typeof pkg.scripts.build === "string") {
      steps.push("npm run build");
    }
    if (typeof pkg.bin === "string") {
      declaredBins = [{ name: pkg.name?.split("/").pop() ?? pkg.name, file: pkg.bin }];
    } else if (pkg.bin && typeof pkg.bin === "object") {
      declaredBins = Object.entries(pkg.bin).map(([name, file]) => ({
        name,
        file: String(file),
      }));
    }
  } catch {
    /* malformed package.json — still attempt install */
  }
  return {
    system: "npm",
    steps,
    binHints: ["bin", "dist", "node_modules/.bin"],
    declaredBins,
    interpreted: true, // node bins require their package — keep build dir + symlink
  };
}

// Detect how to build a repo. `.clone-recipe` wins; otherwise file-signature
// detection, preferring the language-native tool over a generic Makefile.
// `overrides` (from config.json `build`) replaces the steps for a detected system.
export function detectBuildSystem(
  repoPath: string,
  overrides: Record<string, string[]> = {}
): BuildRecipe | null {
  const recipe = detectRaw(repoPath);
  // A user `.clone-recipe` is explicit and always wins; only override auto-detected systems.
  if (recipe && recipe.system !== "recipe" && overrides[recipe.system]) {
    return { ...recipe, steps: overrides[recipe.system] };
  }
  return recipe;
}

function detectRaw(repoPath: string): BuildRecipe | null {
  const recipe = parseRecipe(repoPath);
  if (recipe) return recipe;

  if (has(repoPath, "Cargo.toml")) {
    return {
      system: "cargo",
      steps: ["cargo build --release"],
      binHints: ["target/release"],
    };
  }
  if (has(repoPath, "go.mod")) {
    return {
      system: "go",
      steps: ["go build ./..."],
      binHints: [".", "bin"],
    };
  }
  if (has(repoPath, "meson.build")) {
    return {
      system: "meson",
      steps: ["meson setup build", "meson compile -C build"],
      binHints: ["build"],
    };
  }
  if (has(repoPath, "CMakeLists.txt")) {
    return {
      system: "cmake",
      steps: [
        "cmake -B build -DCMAKE_BUILD_TYPE=Release",
        "cmake --build build",
      ],
      binHints: ["build", "build/bin"],
    };
  }
  if (has(repoPath, "package.json")) {
    return npmRecipe(repoPath);
  }
  if (has(repoPath, "pyproject.toml", "setup.py")) {
    const pkgName = pyPackageName(repoPath);
    // Prefer `uv tool install`: isolated per-tool venv, bins on PATH, clean
    // uninstall. Falls back to `pip install --user` when uv or the name is absent.
    if (uvAvailable() && pkgName) {
      return {
        system: "python",
        steps: [], // buildAndRecord runs `uv tool install` directly
        binHints: [],
        external: true,
        uvtool: true,
        pkgName,
      };
    }
    return {
      system: "python",
      steps: ["pip install --user ."],
      binHints: [],
      external: true,
    };
  }
  if (has(repoPath, "Makefile", "makefile", "GNUmakefile")) {
    return {
      system: "make",
      steps: ["make"],
      binHints: [".", "bin", "build"],
    };
  }

  return null;
}
