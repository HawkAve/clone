import { homedir } from "os";
import { join, dirname } from "path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  copyFileSync,
  unlinkSync,
} from "fs";

export interface Config {
  baseDir: string; // pristine cloned repos (the library — never built in)
  buildDir: string; // build workspaces (git worktrees); ephemeral by default
  dbPath: string; // index DB (state)
  manifestPath: string; // trending manifest (state)
  cacheDir: string; // trending HTML cache (disposable)
  binDir: string; // installed binaries on PATH
  hooksDir: string; // transaction hooks (config)
  configFilePath: string; // config.json (config)
  ignore: string[];
  buildOverrides: Record<string, string[]>;
  keepBuild: boolean; // keep build worktrees after install (paru KeepSrc)
}

const DEFAULT_BASE_DIR = join(homedir(), "Dev", "Github-Repos", "source");
const DEFAULT_BIN_DIR = join(homedir(), ".local", "bin");

function loadConfigFile(path: string): {
  ignore: string[];
  buildOverrides: Record<string, string[]>;
  keepBuild: boolean;
} {
  const empty = { ignore: [], buildOverrides: {}, keepBuild: false };
  if (!existsSync(path)) return empty;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    const ignore = Array.isArray(raw.ignore)
      ? raw.ignore.filter((x: any) => typeof x === "string")
      : [];
    const buildOverrides: Record<string, string[]> = {};
    if (raw.build && typeof raw.build === "object") {
      for (const [k, v] of Object.entries(raw.build)) {
        if (Array.isArray(v) && v.every((s) => typeof s === "string")) {
          buildOverrides[k] = v as string[];
        }
      }
    }
    return { ignore, buildOverrides, keepBuild: !!raw.keepBuild };
  } catch {
    console.error("clone: ignoring malformed config.json");
    return empty;
  }
}

// Move a file across the XDG split, tolerating cross-filesystem moves
// (~/.cache is sometimes a separate mount/subvolume).
function moveFile(from: string, to: string) {
  if (!existsSync(from) || existsSync(to)) return;
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch {
    try {
      copyFileSync(from, to);
      unlinkSync(from);
    } catch {
      /* leave the original in place if we can't move it */
    }
  }
}

// One-time migration from the old single-dir layout (~/.config/clone holding the
// DB + manifest + cache) to the XDG split. Only runs in the real (non-sandboxed)
// case and only when the new DB doesn't exist yet.
function migrateToXdg(oldDir: string, stateDir: string, cacheDir: string) {
  const oldDb = join(oldDir, "clone.db");
  const newDb = join(stateDir, "clone.db");
  if (!existsSync(oldDb) || existsSync(newDb)) return;
  moveFile(oldDb, newDb);
  moveFile(join(oldDir, "manifest.tsv"), join(stateDir, "manifest.tsv"));
  const oldCache = join(oldDir, "cache");
  if (existsSync(oldCache) && !existsSync(cacheDir)) {
    mkdirSync(dirname(cacheDir), { recursive: true });
    try {
      renameSync(oldCache, cacheDir); // disposable — fine to skip on failure
    } catch {
      /* cache regenerates */
    }
  }
  console.error(
    `clone: migrated to XDG layout (DB → ${stateDir}, cache → ${cacheDir})`
  );
}

// Create a needed directory, or exit with a clear message instead of a raw stack trace.
function ensureDir(dir: string, label: string, envHint: string) {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.error(`clone: can't create the ${label} directory: ${dir}`);
    console.error(`  ${(e as Error).message}`);
    console.error(`  Check the path and permissions (set ${envHint} to a writable location).`);
    process.exit(1);
  }
}

export function getConfig(): Config {
  const home = homedir();
  const baseDir = process.env.CLONE_ROOT || DEFAULT_BASE_DIR;
  const binDir = process.env.CLONE_BIN || DEFAULT_BIN_DIR;
  // Build workspaces live in a sibling "build" dir (so they never pollute the
  // pristine source tree). Overridable via CLONE_BUILD.
  const buildDir = process.env.CLONE_BUILD || join(dirname(baseDir), "build");

  let configDir: string;
  let stateDir: string;
  let cacheDir: string;

  if (process.env.CLONE_DATA) {
    // Master override (used for sandboxing/tests): collapse all three into one dir.
    configDir = stateDir = cacheDir = process.env.CLONE_DATA;
  } else {
    // paru-style XDG split, honoring the standard env vars.
    const xdgConfig = process.env.XDG_CONFIG_HOME || join(home, ".config");
    const xdgState = process.env.XDG_STATE_HOME || join(home, ".local", "state");
    const xdgCache = process.env.XDG_CACHE_HOME || join(home, ".cache");
    configDir = join(xdgConfig, "clone");
    stateDir = join(xdgState, "clone");
    cacheDir = join(xdgCache, "clone");
    migrateToXdg(configDir, stateDir, cacheDir);
  }

  ensureDir(configDir, "config", "CLONE_DATA / XDG_CONFIG_HOME");
  ensureDir(stateDir, "state", "CLONE_DATA / XDG_STATE_HOME");
  ensureDir(baseDir, "repos root", "CLONE_ROOT");

  const { ignore, buildOverrides, keepBuild } = loadConfigFile(
    join(configDir, "config.json")
  );

  return {
    baseDir,
    buildDir,
    dbPath: join(stateDir, "clone.db"),
    manifestPath: join(stateDir, "manifest.tsv"),
    cacheDir,
    binDir,
    hooksDir: join(configDir, "hooks"),
    configFilePath: join(configDir, "config.json"),
    ignore,
    buildOverrides,
    keepBuild,
  };
}
