import { execSync, execFileSync, execFile } from "child_process";
import { existsSync, statSync, readdirSync } from "fs";
import { join, dirname, basename } from "path";

export interface CloneOptions {
  shallow?: boolean;
  deep?: boolean;
  progress?: boolean;
  branch?: string;
  bare?: boolean;
  ssh?: boolean;
  noRecursive?: boolean;
  partial?: "blobless" | "treeless";
}

export function gitClone(
  ownerRepo: string,
  dest: string,
  opts: CloneOptions = {}
): boolean {
  const args = ["clone"];

  // Depth: default shallow unless deep is requested
  if (opts.deep) {
    // full clone, no --depth
  } else if (opts.shallow !== false) {
    args.push("--depth", "1");
  }

  if (opts.bare) args.push("--bare");
  if (opts.branch) args.push("--branch", opts.branch, "--single-branch");
  if (opts.noRecursive) args.push("--no-recurse-submodules");
  if (opts.partial === "blobless") args.push("--filter=blob:none");
  if (opts.partial === "treeless") args.push("--filter=tree:0");
  if (opts.progress !== false) args.push("--progress");

  const url = opts.ssh
    ? `git@github.com:${ownerRepo}.git`
    : `https://github.com/${ownerRepo}.git`;
  args.push(url, dest);

  try {
    execFileSync("git", args, {
      stdio: "inherit",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return true;
  } catch {
    return false;
  }
}

// Clone a pristine mirror from a LOCAL repo. Only committed content is copied,
// so untracked build artifacts (venv/, data/, logs/, node_modules/) are left
// behind — exactly what we want for a clean source copy of a running app. The
// clone matches the instance's current commit; origin is repointed at upstream
// so `git pull` works against GitHub.
export function gitCloneLocal(
  srcPath: string,
  dest: string,
  originUrl?: string
): boolean {
  try {
    execFileSync("git", ["clone", srcPath, dest], {
      stdio: "inherit",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    if (originUrl) {
      execFileSync("git", ["-C", dest, "remote", "set-url", "origin", originUrl], {
        stdio: "ignore",
      });
    }
    return true;
  } catch {
    return false;
  }
}

// Resolve a ref (tag/branch/commit) to its commit SHA in a repo, or null.
export function gitResolveRef(repoPath: string, ref: string): string | null {
  try {
    return execFileSync("git", ["-C", repoPath, "rev-parse", "--verify", `${ref}^{commit}`], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

// Fetch a specific ref (tag/branch/commit) into a repo — needed because a
// shallow clone won't already have arbitrary tags/history. Returns success.
export function gitFetchRef(repoPath: string, ref: string): boolean {
  try {
    execFileSync("git", ["-C", repoPath, "fetch", "--depth", "1", "origin", ref], {
      stdio: "ignore",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return true;
  } catch {
    // Fall back to a full fetch of tags (some servers reject by-sha shallow fetch).
    try {
      execFileSync("git", ["-C", repoPath, "fetch", "--tags", "origin"], {
        stdio: "ignore",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      return true;
    } catch {
      return false;
    }
  }
}

export function gitPull(
  repoPath: string,
  opts: { ffOnly?: boolean; quiet?: boolean } = {}
): boolean {
  const args = ["pull"];
  if (opts.ffOnly) args.push("--ff-only");
  if (opts.quiet) args.push("-q");

  try {
    execFileSync("git", args, {
      cwd: repoPath,
      stdio: opts.quiet ? "pipe" : "inherit",
    });
    return true;
  } catch {
    return false;
  }
}

export function gitRemoteUrl(repoPath: string): string | null {
  try {
    return execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: repoPath,
      encoding: "utf-8",
      // Suppress git's "No such remote 'origin'" on repos without a remote.
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

// Current checked-out commit — the "installed version" baseline (paru devel.json analogue).
export function gitHeadCommit(repoPath: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoPath,
      encoding: "utf-8",
      // Suppress git's "ambiguous argument 'HEAD'" fatal for unborn/empty repos.
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

// True if the working tree has uncommitted changes or untracked files.
// Used as the `.pacsave` safety guard before destroying a repo.
export function gitIsDirty(repoPath: string): boolean {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], {
      cwd: repoPath,
      encoding: "utf-8",
    }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

// Remote HEAD sha WITHOUT fetching — paru's devel trick for cheap "is there an
// update?" checks. One network round-trip, no objects downloaded. null if the
// repo has no reachable remote (e.g. purely local repos). Async so many repos
// can be checked concurrently (see cmdOutdated).
export function gitRemoteHeadAsync(repoPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-remote", "origin", "HEAD"],
      {
        cwd: repoPath,
        encoding: "utf-8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        timeout: 20000,
      },
      (err, stdout) => {
        if (err) return resolve(null); // no remote / unreachable — stderr is swallowed
        const sha = String(stdout).trim().split(/\s+/)[0];
        resolve(/^[0-9a-f]{40}$/.test(sha) ? sha : null);
      }
    );
  });
}

// Add a detached build worktree of `sourceRepo` at `commitish` (shares .git, cheap).
export function gitWorktreeAdd(
  sourceRepo: string,
  worktreePath: string,
  commitish = "HEAD"
): boolean {
  try {
    execFileSync(
      "git",
      ["-C", sourceRepo, "worktree", "add", "--force", "--detach", worktreePath, commitish],
      { stdio: ["ignore", "ignore", "ignore"] }
    );
    return true;
  } catch {
    return false;
  }
}

// Hard-checkout a worktree to a commit (used to sync a kept build worktree to the
// source's new HEAD before an incremental rebuild). Build artifacts (gitignored) survive.
export function gitCheckoutDetached(repoPath: string, commitish: string): boolean {
  try {
    execFileSync(
      "git",
      ["-C", repoPath, "checkout", "--force", "--detach", commitish],
      { stdio: ["ignore", "ignore", "ignore"] }
    );
    return true;
  } catch {
    return false;
  }
}

// Remove a build worktree (and prune the source's worktree list).
export function gitWorktreeRemove(sourceRepo: string, worktreePath: string): boolean {
  try {
    execFileSync(
      "git",
      ["-C", sourceRepo, "worktree", "remove", "--force", worktreePath],
      { stdio: ["ignore", "ignore", "ignore"] }
    );
    execFileSync("git", ["-C", sourceRepo, "worktree", "prune"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

// True if `sha` exists as a commit in the repo (for changelog range validity).
export function gitHasCommit(repoPath: string, sha: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
      cwd: repoPath,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

// One-line git log for a range (e.g. "abc123..HEAD") or a count flag ("-20").
export function gitLog(repoPath: string, range: string): string {
  try {
    return execFileSync(
      "git",
      ["log", "--oneline", "--no-decorate", range],
      { cwd: repoPath, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
    ).trimEnd();
  } catch {
    return "";
  }
}

export function parseGitHubUrl(input: string): string | null {
  // https://github.com/owner/repo.git
  // https://github.com/owner/repo
  // git@github.com:owner/repo.git
  // owner/repo
  let cleaned = input
    .replace(/^https?:\/\/github\.com\//, "")
    .replace(/^git@github\.com:/, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");

  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(cleaned)) {
    return cleaned;
  }
  return null;
}

export function getDiskSize(path: string): string {
  try {
    return execSync(`du -sh "${path}" 2>/dev/null`, {
      encoding: "utf-8",
    })
      .split("\t")[0]
      .trim();
  } catch {
    return "0";
  }
}

export function findGitRepos(
  baseDir: string,
  exclude: string[] = ["_duplicates", "_local"]
): { path: string; ownerRepo: string }[] {
  const repos: { path: string; ownerRepo: string }[] = [];

  if (!existsSync(baseDir)) return repos;

  for (const ownerDir of readdirSync(baseDir)) {
    if (exclude.includes(ownerDir)) continue;
    if (ownerDir.startsWith(".")) continue;

    const ownerPath = join(baseDir, ownerDir);
    if (!statSync(ownerPath).isDirectory()) continue;

    // Check if this owner dir is itself a git repo (flat clone)
    if (existsSync(join(ownerPath, ".git"))) {
      repos.push({ path: ownerPath, ownerRepo: ownerDir });
      continue;
    }

    for (const repoDir of readdirSync(ownerPath)) {
      const repoPath = join(ownerPath, repoDir);
      if (!statSync(repoPath).isDirectory()) continue;
      if (existsSync(join(repoPath, ".git"))) {
        repos.push({
          path: repoPath,
          ownerRepo: `${ownerDir}/${repoDir}`,
        });
      }
    }
  }

  return repos;
}

// Recursively find git repositories under `root` (a folder of gathered repos).
// Stops descending once a repo is found (won't recurse into a repo's subdirs),
// skips dotdirs / node_modules / the _duplicates|_local staging dirs.
export function findGitReposDeep(root: string, maxDepth = 5): string[] {
  const out: string[] = [];
  const skip = new Set(["node_modules", "_duplicates", "_local"]);
  const walk = (dir: string, depth: number) => {
    if (existsSync(join(dir, ".git"))) {
      out.push(dir);
      return; // it's a repo — don't descend into it
    }
    if (depth >= maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.startsWith(".") || skip.has(e)) continue;
      const p = join(dir, e);
      try {
        if (statSync(p).isDirectory()) walk(p, depth + 1);
      } catch {
        /* ignore */
      }
    }
  };
  walk(root, 0);
  return out;
}

export function ownerRepoFromRemote(remote: string): string | null {
  const match = remote.match(
    /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/
  );
  if (match) return `${match[1]}/${match[2]}`;
  return null;
}
