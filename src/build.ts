import { execSync } from "child_process";
import {
  existsSync,
  readdirSync,
  statSync,
  lstatSync,
  symlinkSync,
  unlinkSync,
  mkdirSync,
  chmodSync,
  readlinkSync,
  copyFileSync,
} from "fs";
import { join, basename, isAbsolute, resolve } from "path";
import type { BuildRecipe } from "./detect.js";

export interface ProducedBinary {
  name: string;
  path: string; // absolute path to the produced executable
}

export interface BuildResult {
  ok: boolean;
  producedBinaries: ProducedBinary[];
  failedStep?: string;
  error?: string;
}

// A file is "executable" if it's a regular file with any execute bit set.
function isExecutableFile(p: string): boolean {
  try {
    const st = statSync(p);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

// Non-recursively snapshot executable files in the given dirs → abs path -> mtimeMs.
// Non-recursive on purpose: avoids cargo target/release/deps and similar noise.
function snapshotExecutables(repoPath: string, dirs: string[]): Map<string, number> {
  const snap = new Map<string, number>();
  for (const d of dirs) {
    const abs = resolve(repoPath, d);
    if (!existsSync(abs)) continue;
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(abs, e);
      if (isExecutableFile(p)) {
        try {
          snap.set(p, statSync(p).mtimeMs);
        } catch {
          /* ignore */
        }
      }
    }
  }
  return snap;
}

// Run the recipe's steps in the repo, then discover what binaries it produced.
export function buildRepo(
  repoPath: string,
  recipe: BuildRecipe,
  opts: { onStep?: (cmd: string) => void } = {}
): BuildResult {
  // Explicitly declared bins (npm "bin" field, recipe `bin:` lines) — resolved
  // directly, no guessing needed.
  const declared: ProducedBinary[] = [];
  for (const b of recipe.declaredBins ?? []) {
    declared.push({ name: b.name, path: resolve(repoPath, b.file) });
  }

  // Snapshot before, for the discover-by-diff path.
  const before = recipe.external
    ? new Map<string, number>()
    : snapshotExecutables(repoPath, recipe.binHints);

  // Building from source means we've chosen to trust this repo, so its build
  // steps are allowed to run install scripts. npm 11.16 blocks dependency
  // lifecycle scripts by default and rejects the legacy `allow-scripts=*` config
  // form (EALLOWSCRIPTS) on project-scoped installs — so neutralise any ambient
  // allow-scripts and explicitly allow all scripts for the build. Inert for
  // non-npm steps (make/cargo/cmake ignore npm_config_*).
  const buildEnv = {
    ...process.env,
    npm_config_allow_scripts: "",
    npm_config_dangerously_allow_all_scripts: "true",
  };

  for (const step of recipe.steps) {
    opts.onStep?.(step);
    try {
      execSync(step, { cwd: repoPath, stdio: "inherit", env: buildEnv });
    } catch (err) {
      return {
        ok: false,
        producedBinaries: [],
        failedStep: step,
        error: (err as Error).message,
      };
    }
  }

  // External installers (pip) place their own bins — nothing to discover/link.
  if (recipe.external) {
    return { ok: true, producedBinaries: [] };
  }

  // Discover: executables in hint dirs that are new or freshly rebuilt.
  const after = snapshotExecutables(repoPath, recipe.binHints);
  const discovered: ProducedBinary[] = [];
  for (const [p, mtime] of after) {
    const prev = before.get(p);
    if (prev === undefined || prev !== mtime) {
      discovered.push({ name: basename(p), path: p });
    }
  }

  // Declared bins (npm "bin" field, recipe `bin:` lines) are AUTHORITATIVE: when
  // a package says what its binary is, link only that. Discovery (snapshot-diff)
  // is the fallback for builds that declare nothing — it must never sweep in
  // dependency CLIs that `npm install` drops into node_modules/.bin (tsc, etc.).
  const usableDeclared = declared.filter((b) => existsSync(b.path));
  const chosen = usableDeclared.length ? usableDeclared : discovered;
  const seen = new Set<string>();
  const producedBinaries = chosen.filter((b) => {
    if (seen.has(b.path)) return false;
    seen.add(b.path);
    return true;
  });

  return { ok: true, producedBinaries };
}

export interface LinkResult {
  linked: { name: string; link: string; target: string }[];
  skipped: { name: string; reason: string }[];
}

// Symlink produced binaries into binDir. Never clobbers a file/symlink we didn't
// create (the .pacsave philosophy). Returns the link paths for DB recording.
export function linkArtifacts(
  bins: ProducedBinary[],
  binDir: string
): LinkResult {
  const linked: LinkResult["linked"] = [];
  const skipped: LinkResult["skipped"] = [];

  if (bins.length > 0) mkdirSync(binDir, { recursive: true });

  for (const bin of bins) {
    const link = join(binDir, bin.name);
    const target = isAbsolute(bin.path) ? bin.path : resolve(bin.path);

    if (existsSync(link) || isSymlink(link)) {
      // If it already points at our target, treat as success (idempotent).
      if (isSymlink(link) && safeReadlink(link) === target) {
        linked.push({ name: bin.name, link, target });
        continue;
      }
      skipped.push({
        name: bin.name,
        reason: `${link} already exists (not created by clone)`,
      });
      continue;
    }

    try {
      chmodSync(target, statSync(target).mode | 0o111); // ensure runnable (npm shebang files)
    } catch {
      /* best-effort */
    }
    try {
      symlinkSync(target, link);
      linked.push({ name: bin.name, link, target });
    } catch (err) {
      skipped.push({ name: bin.name, reason: (err as Error).message });
    }
  }

  return { linked, skipped };
}

// Copy produced binaries into binDir (for self-contained binaries). Never clobbers
// a file we didn't create — callers remove their own old artifacts first.
export function copyArtifacts(bins: ProducedBinary[], binDir: string): LinkResult {
  const linked: LinkResult["linked"] = [];
  const skipped: LinkResult["skipped"] = [];

  if (bins.length > 0) mkdirSync(binDir, { recursive: true });

  for (const bin of bins) {
    const dest = join(binDir, bin.name);
    const src = isAbsolute(bin.path) ? bin.path : resolve(bin.path);
    if (existsSync(dest) || isSymlink(dest)) {
      skipped.push({ name: bin.name, reason: `${dest} already exists (not created by clone)` });
      continue;
    }
    try {
      copyFileSync(src, dest);
      chmodSync(dest, statSync(dest).mode | 0o111);
      linked.push({ name: bin.name, link: dest, target: src });
    } catch (err) {
      skipped.push({ name: bin.name, reason: (err as Error).message });
    }
  }
  return { linked, skipped };
}

// Remove only symlinks (the artifacts we created). Returns how many were removed.
// Used by `clean` for broken-symlink pruning (symlink-only is the safe scope there).
export function unlinkArtifacts(artifactLinks: string[]): number {
  let removed = 0;
  for (const link of artifactLinks) {
    if (isSymlink(link)) {
      try {
        unlinkSync(link);
        removed++;
      } catch {
        /* ignore */
      }
    }
  }
  return removed;
}

// Remove recorded artifacts whether they're symlinks OR copied files (uninstall/remove).
// We only ever pass paths the DB recorded as ours, so removing the file is safe.
export function removeArtifacts(paths: string[]): number {
  let removed = 0;
  for (const p of paths) {
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink() || st.isFile()) {
        unlinkSync(p);
        removed++;
      }
    } catch {
      /* already gone */
    }
  }
  return removed;
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function safeReadlink(p: string): string | null {
  try {
    return resolve(readlinkSync(p));
  } catch {
    return null;
  }
}
