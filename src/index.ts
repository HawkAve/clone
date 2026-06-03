#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import {
  existsSync,
  mkdirSync,
  rmSync,
  rmdirSync,
  renameSync,
  readFileSync,
  writeFileSync,
  statSync,
  readdirSync,
  lstatSync,
  realpathSync,
  readlinkSync,
  cpSync,
} from "fs";
import { join, dirname, resolve, basename } from "path";
import { homedir } from "os";
import { execSync, execFileSync } from "child_process";
import { createInterface } from "readline";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8")
);

import { getConfig } from "./config.js";
import { CloneDB, type RepoEntry } from "./db.js";
import {
  fetchRepoMeta,
  fetchTrending,
  fetchTrendingDetailed,
  searchRemoteRepos,
} from "./github.js";
import type { TrendingRepo, TrendingOptions } from "./github.js";
import {
  gitClone,
  gitCloneLocal,
  gitPull,
  gitRemoteUrl,
  gitHeadCommit,
  gitRemoteHeadAsync,
  gitIsDirty,
  gitHasCommit,
  gitLog,
  gitWorktreeAdd,
  gitWorktreeRemove,
  gitCheckoutDetached,
  parseGitHubUrl,
  getDiskSize,
  findGitRepos,
  findGitReposDeep,
  ownerRepoFromRemote,
  type CloneOptions,
} from "./git.js";
import { detectBuildSystem, type BuildRecipe } from "./detect.js";
import {
  buildRepo,
  linkArtifacts,
  copyArtifacts,
  unlinkArtifacts,
  removeArtifacts,
} from "./build.js";
import { loadHooks, runHooks, type HookEvent } from "./hooks.js";
import { Manifest } from "./manifest.js";
import {
  printRepoTable,
  printRepoDetailed,
  printRepoInfo,
  printStats,
  printTrending,
  printRemoteRepos,
  printRemoteInfo,
  formatNumber,
  formatStars,
} from "./format.js";

const config = getConfig();
const db = new CloneDB(config);
const manifest = new Manifest(config);
const hooks = loadHooks(config.hooksDir);

await db.ensureReady();

// Fire transaction hooks for an event/phase (no-op when no hooks are configured).
function fireHooks(
  event: HookEvent,
  when: "pre" | "post",
  ctx: { repo: string; cwd?: string }
): boolean {
  if (hooks.length === 0) return true;
  return runHooks(hooks, event, when, ctx);
}

function fzfAvailable(): boolean {
  try {
    execSync("command -v fzf", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Run fzf over candidate lines (multi-select) and return the first token of each
// chosen line (owner/repo). Returns [] on cancel/no-selection. fzf draws its UI on
// the tty; we feed candidates on stdin and capture the selection on stdout.
function fzfPick(lines: string[], header: string): string[] {
  try {
    const out = execFileSync(
      "fzf",
      ["-m", "--reverse", "--ansi", "--prompt", "clone> ", "--header", header],
      { input: lines.join("\n"), encoding: "utf-8", stdio: ["pipe", "pipe", "inherit"] }
    );
    return out
      .split("\n")
      .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim().split(/\s+/)[0])
      .filter(Boolean);
  } catch {
    return []; // Esc / no match / non-zero exit
  }
}

// Interactive picker → clone (download) the chosen repos. Shared by local/remote search.
async function interactivePickClone(
  candidates: { repo: string; meta: string }[]
) {
  // fzf reads keys from /dev/tty directly, so it would hang on a real terminal
  // even with stdin redirected. If we're not attached to a TTY (piped/scripted/
  // CI), degrade gracefully instead of blocking.
  if (!process.stdin.isTTY) {
    console.error(chalk.yellow("Interactive mode (-i) needs a terminal."));
    console.error(
      chalk.dim(`  Pipe the quiet output instead: clone search <q> -r -q | fzf | xargs clone install`)
    );
    process.exitCode = 1;
    return;
  }
  if (!fzfAvailable()) {
    console.error(chalk.red("Interactive mode (-i) needs fzf."));
    console.error(
      chalk.dim(`  Install fzf, or pipe the quiet output yourself:`)
    );
    console.error(chalk.dim(`    clone search <q> -r -q | fzf | xargs clone install`));
    process.exitCode = 1;
    return;
  }
  if (candidates.length === 0) {
    console.log("No results to pick from.");
    return;
  }
  const lines = candidates.map((c) => `${c.repo}  ${chalk.dim(c.meta)}`);
  const picks = fzfPick(lines, "Tab=multi-select  Enter=clone  Esc=cancel");
  if (picks.length === 0) {
    console.log("Nothing selected.");
    return;
  }
  console.log(chalk.bold(`\nCloning ${picks.length} selected repo(s)...\n`));
  let cloned = 0,
    skipped = 0,
    failed = 0;
  for (const p of picks) {
    const s = await cloneSafe(p);
    if (s === "cloned") cloned++;
    else if (s === "skipped") skipped++;
    else failed++;
  }
  console.log(
    `\n  ${chalk.green(`cloned=${cloned}`)} ${chalk.yellow(`skipped=${skipped}`)} ${chalk.red(`failed=${failed}`)}`
  );
  console.log(chalk.dim(`  (build any of them with: clone install <owner/repo>)`));
}

// Set of repo ids to skip (config.json `ignore` + a --ignore flag), lower-cased.
function ignoreSet(extra?: string): Set<string> {
  const s = new Set(config.ignore.map((x) => x.toLowerCase()));
  if (extra) {
    for (const x of extra.split(",")) {
      const t = x.trim().toLowerCase();
      if (t) s.add(t);
    }
  }
  return s;
}

// Run an async fn over items with bounded concurrency, preserving order.
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
  return results;
}

function today(): string {
  return new Date().toISOString().split("T")[0];
}

async function buildEntry(
  ownerRepo: string,
  source: string,
  repoPath: string
): Promise<RepoEntry> {
  const [owner, repo] = ownerRepo.split("/");
  const meta = await fetchRepoMeta(owner, repo);
  const diskSize = getDiskSize(repoPath);

  return {
    id: ownerRepo,
    owner,
    repo,
    description: meta.description,
    language: meta.language,
    stars: meta.stars,
    topics: JSON.stringify(meta.topics),
    license: meta.license,
    fork: meta.fork,
    archived: meta.archived,
    html_url: meta.html_url,
    cloned_at: today(),
    disk_size: diskSize,
    source,
    path: repoPath,
  };
}

// Minimal index entry for an on-disk repo with no GitHub origin (no network).
function localEntry(ownerRepo: string, repoPath: string): RepoEntry {
  const [owner, repo] = ownerRepo.split("/");
  return {
    id: ownerRepo,
    owner,
    repo,
    description: "",
    language: "unknown",
    stars: 0,
    topics: "[]",
    license: "",
    fork: false,
    archived: false,
    html_url: "",
    cloned_at: today(),
    disk_size: getDiskSize(repoPath),
    source: "local",
    path: repoPath,
  };
}

// Move a directory, tolerating cross-filesystem moves (the source may have been
// cloned onto a different mount than the repos root).
function moveDir(from: string, to: string) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch {
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

// A single shared readline interface with a line QUEUE, created lazily. Reused
// across every prompt. We can't use readline's own `question()` per prompt:
// opening a fresh interface each time discards buffered stdin, and even one
// interface drops lines that arrive together in a single chunk (so piped runs
// like `printf 'a\nb\ny\n' | clone install --ask` would only read the first
// answer). Instead we collect 'line' events into a queue and hand them out one
// per ask — works for both interactive TTYs and piped/buffered input.
let _rl: ReturnType<typeof createInterface> | null = null;
let _lineQueue: string[] = [];
let _lineWaiter: ((line: string) => void) | null = null;
let _stdinClosed = false;
function ensureRl() {
  if (_rl) return;
  _rl = createInterface({ input: process.stdin });
  _rl.on("line", (line) => {
    if (_lineWaiter) {
      const w = _lineWaiter;
      _lineWaiter = null;
      w(line);
    } else {
      _lineQueue.push(line);
    }
  });
  _rl.on("close", () => {
    _stdinClosed = true;
    if (_lineWaiter) {
      const w = _lineWaiter;
      _lineWaiter = null;
      w("");
    }
  });
}
function rlAsk(question: string): Promise<string> {
  ensureRl();
  process.stdout.write(question);
  return new Promise((resolve) => {
    if (_lineQueue.length) return resolve((_lineQueue.shift() ?? "").trim());
    if (_stdinClosed) return resolve("");
    _lineWaiter = (line) => resolve((line ?? "").trim());
  });
}
// Close the shared interface so the process can exit cleanly after prompting.
function closePrompts() {
  if (_rl) {
    _rl.close();
    _rl = null;
    _lineQueue = [];
    _lineWaiter = null;
    _stdinClosed = false;
  }
}

async function confirm(message: string): Promise<boolean> {
  const answer = await rlAsk(`${message} [y/N] `);
  closePrompts();
  return /^[Yy]$/.test(answer);
}

// Free-text prompt (returns trimmed answer; empty string on blank/EOF).
async function prompt(question: string): Promise<string> {
  return rlAsk(question);
}

// --- Commands ---

async function cmdCloneRepo(input: string, cloneOpts: CloneOptions = {}) {
  const ownerRepo = parseGitHubUrl(input);
  if (!ownerRepo) {
    console.error(`Invalid repo: ${input}`);
    process.exit(1);
  }

  const [owner, repo] = ownerRepo.split("/");
  const suffix = cloneOpts.bare ? `${repo}.git` : repo;
  const dest = join(config.baseDir, owner, suffix);

  if (existsSync(dest)) {
    console.log(chalk.yellow(`Already cloned: ${ownerRepo} at ${dest}`));
    return;
  }

  const flags: string[] = [];
  if (cloneOpts.shallow) flags.push("shallow");
  if (cloneOpts.deep) flags.push("deep");
  if (cloneOpts.bare) flags.push("bare");
  if (cloneOpts.ssh) flags.push("ssh");
  if (cloneOpts.branch) flags.push(`branch:${cloneOpts.branch}`);
  if (cloneOpts.partial) flags.push(`partial:${cloneOpts.partial}`);
  if (cloneOpts.noRecursive) flags.push("no-recursive");
  const flagStr = flags.length ? ` (${flags.join(", ")})` : "";

  console.log(`${chalk.cyan("Cloning")} ${ownerRepo}${flagStr}...`);
  mkdirSync(join(config.baseDir, owner), { recursive: true });

  if (gitClone(ownerRepo, dest, cloneOpts)) {
    console.log(chalk.green("OK"));
    process.stdout.write(chalk.dim("Indexing... "));
    const entry = await buildEntry(ownerRepo, "manual", dest);
    db.upsert(entry);
    console.log(chalk.green("done"));
    console.log(`${chalk.green("Done:")} ${dest}`);
  } else {
    console.error(chalk.red(`Failed to clone ${ownerRepo}`));
    process.exit(1);
  }
}

async function cmdSearch(
  query: string,
  opts: {
    long?: boolean;
    remote?: boolean;
    language?: string;
    topic?: string;
    user?: string;
    stars?: string;
    sort?: string;
    limit?: string;
    quiet?: boolean;
    interactive?: boolean;
  } = {}
) {
  // --remote: search ALL of GitHub (pacman -Ss), not just the local index.
  if (opts.remote) {
    const limit = opts.limit ? parseInt(opts.limit, 10) : 20;
    if (opts.limit && (!limit || limit < 1)) {
      console.error(chalk.red(`Invalid --limit: ${opts.limit}`));
      process.exitCode = 1;
      return;
    }
    const validSort = ["stars", "forks", "updated", "best-match"];
    if (opts.sort && !validSort.includes(opts.sort)) {
      console.error(
        chalk.red(`Invalid --sort: ${opts.sort}. Use ${validSort.join(", ")}.`)
      );
      process.exitCode = 1;
      return;
    }

    // Quiet output must be machine-clean, so progress chatter goes to stderr.
    if (!opts.quiet) process.stdout.write(chalk.dim(`Searching GitHub for "${query}"... `));
    try {
      const { items, total } = await searchRemoteRepos(query, {
        language: opts.language,
        topic: opts.topic,
        user: opts.user,
        stars: opts.stars,
        sort: (opts.sort as any) ?? "stars",
        limit,
      });
      if (!opts.quiet) console.log(chalk.dim(`${formatNumber(total)} total matches`));

      if (opts.quiet) {
        for (const r of items) console.log(r.repo);
        return;
      }
      if (opts.interactive) {
        await interactivePickClone(
          items.map((r) => ({
            repo: r.repo,
            meta: `★${formatStars(r.stars)} ${r.language}  ${r.description}`,
          }))
        );
        return;
      }
      const installed = new Set(db.list({}).map((r) => r.id.toLowerCase()));
      printRemoteRepos(items, { installed, total, long: opts.long });
    } catch (err) {
      console.log(chalk.red("failed"));
      console.error(
        chalk.red(`  GitHub search error: ${(err as Error).message}`)
      );
      console.error(
        chalk.dim(
          `  Tip: set GITHUB_TOKEN or run \`gh auth login\` to raise the rate limit.`
        )
      );
      process.exitCode = 1;
    }
    return;
  }

  let results = db.search(query);

  // If DB has no results, scan the filesystem for unindexed repos
  if (results.length === 0) {
    const allOnDisk = findGitRepos(config.baseDir);
    const q = query.toLowerCase();
    const matches = allOnDisk.filter((r) =>
      r.ownerRepo.toLowerCase().includes(q)
    );

    if (matches.length > 0) {
      console.log(
        chalk.yellow(
          `Not in index — found ${matches.length} match(es) on disk. Indexing...\n`
        )
      );
      for (const { path: repoPath, ownerRepo } of matches) {
        if (!/^[^/]+\/[^/]+$/.test(ownerRepo)) continue;
        process.stdout.write(`  ${ownerRepo}... `);
        const source = manifest.has(ownerRepo) ? "trending" : "manual";
        const entry = await buildEntry(ownerRepo, source, repoPath);
        db.upsert(entry);
        console.log(chalk.green("indexed"));
      }
      console.log();
      results = db.search(query);
    }
  }

  if (opts.quiet) {
    for (const r of results) console.log(r.id);
    return;
  }
  if (opts.interactive) {
    await interactivePickClone(
      results.map((r) => ({ repo: r.id, meta: `★${formatStars(r.stars)} ${r.language}` }))
    );
    return;
  }
  if (opts.long) printRepoDetailed(results);
  else printRepoTable(results);
}

async function cmdInfo(ownerRepo: string, opts: { remote?: boolean } = {}) {
  let entry = db.get(ownerRepo);

  // Resolve a bare name (no slash) to a unique indexed repo — so `clone info
  // odysseus` works without the full owner/repo. (Local lookups only.)
  if (!entry && !opts.remote && !ownerRepo.includes("/")) {
    const matches = db.resolveName(ownerRepo);
    if (matches.length === 1) {
      entry = matches[0];
      ownerRepo = entry.id;
    } else if (matches.length > 1) {
      console.error(`"${ownerRepo}" matches ${matches.length} repos — be specific:`);
      for (const m of matches) console.error(`  ${m.id}`);
      process.exit(1);
    }
    // 0 matches → fall through to the remote/error branch below
  }

  // --remote (pacman -Si): GitHub metadata, even for a repo we haven't cloned.
  if (opts.remote || !entry) {
    const parsed = parseGitHubUrl(ownerRepo);
    if (!parsed) {
      console.error(`Invalid repo: ${ownerRepo} (expected owner/repo)`);
      process.exit(1);
    }
    if (!entry && !opts.remote) {
      console.error(
        chalk.dim(`${parsed} is not cloned — showing remote info (pacman -Si):`)
      );
    }
    const [owner, repo] = parsed.split("/");
    process.stdout.write(chalk.dim(`Fetching ${parsed} from GitHub... `));
    const meta = await fetchRepoMeta(owner, repo);
    console.log(chalk.dim("done"));
    printRemoteInfo(parsed, meta, entry?.install_state);
    return;
  }

  // Refresh disk size
  entry.disk_size = getDiskSize(entry.path);
  printRepoInfo(entry);

  // For a tracked app/service, show where it runs + its systemd unit status.
  if (entry.install_state === "app") {
    const runPath = entry.build_path || entry.path;
    if (runPath && runPath !== entry.path) {
      console.log(`  ${chalk.dim("running".padEnd(11))}${chalk.dim(runPath)}`);
    }
    const svc = serviceForPath(runPath || entry.path);
    if (svc) {
      const st = serviceActive(svc);
      const c = st === "active" ? chalk.green : chalk.yellow;
      console.log(`  ${chalk.dim("service".padEnd(11))}${svc} ${c(`(${st})`)}`);
    }
    console.log();
  }

  // Show trending history as one compact line, matching the info layout.
  const history = manifest.getHistory(ownerRepo);
  if (history.length > 0) {
    const parts = history
      .map((h) => `${h.date} ${chalk.magenta(h.period)}`)
      .join(chalk.dim("  ·  "));
    console.log(`  ${chalk.dim(("trending" + "  ").padEnd(11))}${parts}`);
    console.log();
  }
}

async function cmdBrowse(target: string) {
  // Try to find the repo URL — DB first, then fall back to constructing from owner/repo
  let url: string | undefined;
  let ownerRepo = target;

  // Resolve "." or any filesystem path to owner/repo via git remote
  const looksLikePath =
    target === "." ||
    target === ".." ||
    target.startsWith("./") ||
    target.startsWith("../") ||
    target.startsWith("/") ||
    target.startsWith("~");

  if (looksLikePath) {
    const resolved =
      target === "."
        ? process.cwd()
        : target.startsWith("~")
          ? join(process.env.HOME || "", target.slice(1))
          : target;

    if (!existsSync(join(resolved, ".git"))) {
      console.error(`Not a git repo: ${resolved}`);
      process.exit(1);
    }

    const remote = gitRemoteUrl(resolved);
    if (!remote) {
      console.error(`No git remote on: ${resolved}`);
      process.exit(1);
    }

    const parsed = ownerRepoFromRemote(remote);
    if (!parsed) {
      console.error(`Could not parse GitHub remote: ${remote}`);
      process.exit(1);
    }
    ownerRepo = parsed;
  }

  const entry = db.get(ownerRepo);
  if (entry?.html_url) {
    url = entry.html_url;
  } else if (/^[^/\s]+\/[^/\s]+$/.test(ownerRepo)) {
    url = `https://github.com/${ownerRepo}`;
  } else {
    console.error(`Invalid repo: ${ownerRepo}`);
    console.error("Expected format: owner/repo, a path, or .");
    process.exit(1);
  }

  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;

  try {
    execSync(cmd, { stdio: "ignore" });
    console.log(chalk.green(`Opened ${url}`));
  } catch (err) {
    console.error(chalk.red(`Failed to open browser: ${(err as Error).message}`));
    console.error(`URL: ${url}`);
    process.exit(1);
  }
}

// --- Trending HTML cache (15 min TTL) ------------------------------------

const TRENDING_CACHE_TTL_MS = 15 * 60 * 1000;

function trendingCacheDir(): string {
  return config.cacheDir;
}

function trendingCachePath(period: string): string {
  return join(trendingCacheDir(), `trending-${period}.json`);
}

async function getTrendingCached(
  period: string,
  opts: { noCache?: boolean } = {}
): Promise<{ repos: string[]; cached: boolean; ageSec: number }> {
  const path = trendingCachePath(period);
  if (!opts.noCache && existsSync(path)) {
    try {
      const stat = statSync(path);
      const age = Date.now() - stat.mtimeMs;
      if (age < TRENDING_CACHE_TTL_MS) {
        const raw = JSON.parse(readFileSync(path, "utf-8"));
        if (Array.isArray(raw.repos)) {
          return { repos: raw.repos as string[], cached: true, ageSec: Math.round(age / 1000) };
        }
      }
    } catch {
      /* fall through to fresh fetch */
    }
  }
  const repos = await fetchTrending(period);
  try {
    mkdirSync(trendingCacheDir(), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify(
        { fetchedAt: new Date().toISOString(), period, repos },
        null,
        2
      )
    );
  } catch {
    /* cache write is best-effort */
  }
  return { repos, cached: false, ageSec: 0 };
}

function trendingDetailedCachePath(opts: TrendingOptions): string {
  const slug = [
    opts.period || "daily",
    opts.language ? opts.language.toLowerCase().replace(/[^a-z0-9.+-]/g, "_") : "all",
    opts.spoken || "any",
  ].join("-");
  return join(trendingCacheDir(), `trending-detailed-${slug}.json`);
}

async function getTrendingDetailedCached(
  opts: TrendingOptions,
  cacheOpts: { noCache?: boolean } = {}
): Promise<{ repos: TrendingRepo[]; cached: boolean; ageSec: number }> {
  const path = trendingDetailedCachePath(opts);
  if (!cacheOpts.noCache && existsSync(path)) {
    try {
      const stat = statSync(path);
      const age = Date.now() - stat.mtimeMs;
      if (age < TRENDING_CACHE_TTL_MS) {
        const raw = JSON.parse(readFileSync(path, "utf-8"));
        if (Array.isArray(raw.repos)) {
          return {
            repos: raw.repos as TrendingRepo[],
            cached: true,
            ageSec: Math.round(age / 1000),
          };
        }
      }
    } catch {
      /* fall through to fresh fetch */
    }
  }
  const repos = await fetchTrendingDetailed(opts);
  try {
    mkdirSync(trendingCacheDir(), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ fetchedAt: new Date().toISOString(), ...opts, repos }, null, 2)
    );
  } catch {
    /* cache write is best-effort */
  }
  return { repos, cached: false, ageSec: 0 };
}

const VALID_TREND_PERIODS = ["daily", "weekly", "monthly"];

async function cmdViewTrending(
  language: string | undefined,
  opts: {
    period?: string;
    spoken?: string;
    limit?: string;
    all?: boolean;
    json?: boolean;
    cache?: boolean;
  }
) {
  const period = (opts.period || "daily").toLowerCase();
  if (!opts.all && !VALID_TREND_PERIODS.includes(period)) {
    console.error(
      chalk.red(`Invalid period: ${opts.period}. Use daily, weekly, or monthly.`)
    );
    process.exitCode = 1;
    return;
  }

  const limit = opts.limit ? parseInt(opts.limit, 10) : undefined;
  if (opts.limit && (!limit || limit < 1)) {
    console.error(chalk.red(`Invalid --limit: ${opts.limit}`));
    process.exitCode = 1;
    return;
  }

  const periods = opts.all ? VALID_TREND_PERIODS : [period];
  const clonedIds = new Set<string>(
    db.list({}).map((r) => r.id.toLowerCase())
  );

  const sections: {
    period: string;
    repos: TrendingRepo[];
    cached: boolean;
    ageSec: number;
  }[] = [];

  for (const p of periods) {
    if (!opts.json) {
      process.stdout.write(
        chalk.dim(
          `Fetching ${p} trending${language ? ` (${language})` : ""}${
            opts.spoken ? ` [${opts.spoken}]` : ""
          }... `
        )
      );
    }
    try {
      const { repos, cached, ageSec } = await getTrendingDetailedCached(
        { period: p, language, spoken: opts.spoken },
        { noCache: opts.cache === false }
      );
      const sliced = limit ? repos.slice(0, limit) : repos;
      sections.push({ period: p, repos: sliced, cached, ageSec });
      if (!opts.json) {
        console.log(
          cached
            ? chalk.dim(`${repos.length} repos (cached ${ageSec}s ago)`)
            : chalk.dim(`${repos.length} repos`)
        );
      }
    } catch (err) {
      if (!opts.json) console.log(chalk.red("failed"));
      else sections.push({ period: p, repos: [], cached: false, ageSec: 0 });
    }
  }

  if (opts.json) {
    const payload = opts.all
      ? Object.fromEntries(sections.map((s) => [s.period, s.repos]))
      : sections[0]?.repos ?? [];
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  for (const s of sections) {
    const heading =
      `${s.period.toUpperCase()} trending` +
      (language ? ` · ${language}` : "") +
      (opts.spoken ? ` · ${opts.spoken}` : "");
    printTrending(s.repos, {
      period: s.period,
      cloned: clonedIds,
      title: chalk.bold(`──  ${heading}  ──`),
    });
  }
  console.log();
  console.log(
    chalk.dim(
      `Tip: \`clone <owner/repo>\` to clone one, or \`clone missing\` to clone all not-yet-cloned trending.`
    )
  );
}

// Batch-safe clone: never exits the process, returns ok/fail/skipped.
async function cloneSafe(
  input: string
): Promise<"cloned" | "skipped" | "failed"> {
  const ownerRepo = parseGitHubUrl(input);
  if (!ownerRepo) {
    console.error(chalk.red(`  Invalid: ${input}`));
    return "failed";
  }
  const [owner, repo] = ownerRepo.split("/");
  const dest = join(config.baseDir, owner, repo);
  if (existsSync(dest)) {
    console.log(chalk.yellow(`  SKIP  ${ownerRepo} (already cloned)`));
    return "skipped";
  }
  console.log(`  ${chalk.cyan("CLONE")} ${ownerRepo}`);
  mkdirSync(join(config.baseDir, owner), { recursive: true });
  if (!gitClone(ownerRepo, dest)) {
    console.error(chalk.red(`  FAIL  ${ownerRepo}`));
    return "failed";
  }
  process.stdout.write(chalk.dim("    indexing... "));
  try {
    const entry = await buildEntry(ownerRepo, "trending", dest);
    db.upsert(entry);
    console.log(chalk.green("ok"));
  } catch (e) {
    console.log(chalk.yellow(`warn: ${(e as Error).message}`));
  }
  return "cloned";
}

async function printMissingTrending(
  periodFilter?: string,
  opts: { json?: boolean; fetch?: boolean; noCache?: boolean } = {}
) {
  const periods = periodFilter ? [periodFilter] : ["daily", "weekly", "monthly"];
  const local = new Set(db.list({}).map((r) => r.id.toLowerCase()));

  const result: Record<
    string,
    { total: number; cloned: number; missing: string[]; cached: boolean; ageSec: number }
  > = {};

  for (const p of periods) {
    if (!opts.json) process.stdout.write(chalk.dim(`Fetching ${p} trending... `));
    try {
      const { repos: remote, cached, ageSec } = await getTrendingCached(p, {
        noCache: opts.noCache,
      });
      const missing = remote.filter((r) => !local.has(r.toLowerCase()));
      const clonedCount = remote.length - missing.length;
      result[p] = {
        total: remote.length,
        cloned: clonedCount,
        missing,
        cached,
        ageSec,
      };
      if (!opts.json) {
        const tag = cached ? chalk.dim(`${remote.length} repos (cached ${ageSec}s ago)`) : chalk.dim(`${remote.length} repos`);
        console.log(tag);
      }
    } catch (e) {
      if (!opts.json) console.log(chalk.red(`failed: ${(e as Error).message}`));
      result[p] = { total: 0, cloned: 0, missing: [], cached: false, ageSec: 0 };
    }
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  let totalMissing = 0;
  for (const p of Object.keys(result)) {
    const { total, cloned, missing } = result[p];
    totalMissing += missing.length;
    console.log(
      chalk.bold.yellow(
        `\n──  ${p.toUpperCase()}  missing ${missing.length} of ${total}  (${cloned} cloned)  ──`
      )
    );
    if (missing.length === 0) {
      console.log(chalk.green("  All currently-trending repos are already cloned."));
      continue;
    }
    for (const r of missing) {
      console.log(`  ${chalk.cyan(r)}   ${chalk.dim(`clone ${r}`)}`);
    }
  }

  if (opts.fetch && totalMissing > 0) {
    // Union of missing across periods so we don't clone the same repo twice.
    const unique = new Set<string>();
    for (const p of Object.keys(result)) {
      for (const r of result[p].missing) unique.add(r);
    }
    console.log(
      chalk.bold(`\nCloning ${unique.size} missing repo${unique.size === 1 ? "" : "s"}...\n`)
    );
    let cloned = 0,
      skipped = 0,
      failed = 0;
    for (const r of unique) {
      const status = await cloneSafe(r);
      if (status === "cloned") cloned++;
      else if (status === "skipped") skipped++;
      else failed++;
    }
    console.log(
      `\n  ${chalk.green(`cloned=${cloned}`)} ${chalk.yellow(`skipped=${skipped}`)} ${chalk.red(`failed=${failed}`)}`
    );
  } else if (totalMissing > 0) {
    console.log(
      chalk.dim(
        `\nTip: add --fetch to clone them all now, or run \`clone daily\` / \`clone weekly\` / \`clone monthly\`.`
      )
    );
  }
}

async function cmdList(opts: {
  language?: string;
  owner?: string;
  source?: string;
  trending?: string | boolean;
  recent?: string;
  exact?: string;
  fullPath?: boolean;
  missing?: boolean;
  fetch?: boolean;
  json?: boolean;
  cache?: boolean;
  long?: boolean;
  installed?: boolean;
}) {
  const show = (list: RepoEntry[]) =>
    opts.long ? printRepoDetailed(list) : printRepoTable(list);
  const recentDays = opts.recent ? parseInt(opts.recent) || 7 : undefined;
  const trendingEnabled = opts.trending !== undefined && opts.trending !== false;
  const periodFilter =
    typeof opts.trending === "string" && opts.trending !== ""
      ? opts.trending.toLowerCase()
      : undefined;

  const VALID_PERIODS = ["daily", "weekly", "monthly"] as const;
  if (periodFilter && !VALID_PERIODS.includes(periodFilter as any)) {
    console.error(
      `Invalid period: ${periodFilter}. Use daily, weekly, or monthly (or --trending alone).`
    );
    process.exit(1);
  }

  if (opts.missing) {
    if (!trendingEnabled) {
      console.error("--missing requires --trending");
      process.exit(1);
    }
    if (opts.fetch && opts.json) {
      console.error("--fetch and --json can't be combined (JSON is output-only).");
      process.exit(1);
    }
    await printMissingTrending(periodFilter, {
      json: !!opts.json,
      fetch: !!opts.fetch,
      noCache: opts.cache === false,
    });
    return;
  }

  let repos = db.list({
    language: opts.language,
    owner: opts.owner,
    source: opts.source,
    trending: trendingEnabled,
    recentDays,
    installed: opts.installed,
  });

  if (opts.exact) {
    const q = opts.exact.toLowerCase();
    repos = repos.filter(
      (r) =>
        r.repo.toLowerCase() === q ||
        r.id.toLowerCase() === q
    );
  }

  if (opts.fullPath) {
    for (const r of repos) console.log(r.path);
    return;
  }

  // When --trending, split into daily/weekly/monthly sections using manifest.
  if (trendingEnabled) {
    const periodMap = manifest.getPeriodsByRepo();

    if (periodFilter) {
      repos = repos.filter((r) => periodMap.get(r.id)?.has(periodFilter));
    }

    const groups: Record<string, RepoEntry[]> = {
      daily: [],
      weekly: [],
      monthly: [],
    };
    const untracked: RepoEntry[] = [];

    for (const r of repos) {
      const periods = periodMap.get(r.id);
      if (!periods || periods.size === 0) {
        untracked.push(r);
        continue;
      }
      for (const p of VALID_PERIODS) {
        if (periods.has(p)) groups[p].push(r);
      }
    }

    const displayPeriods = periodFilter
      ? [periodFilter]
      : [...VALID_PERIODS];

    const divider = (label: string, count: number, dim = false) => {
      const tag = `──  ${label}  (${count})  ──`;
      console.log("\n" + (dim ? chalk.bold.dim(tag) : chalk.bold.cyan(tag)));
    };

    let printedAny = false;
    for (const p of displayPeriods) {
      const list = groups[p];
      if (!list || list.length === 0) continue;
      divider(p.toUpperCase(), list.length);
      show(list);
      printedAny = true;
    }

    if (!periodFilter && untracked.length > 0) {
      divider(
        `UNTRACKED  ${chalk.italic("(source=trending, no manifest entry)")}`,
        untracked.length,
        true
      );
      show(untracked);
      printedAny = true;
    }

    if (!printedAny) {
      console.log("No trending repos found.");
    }
    return;
  }

  show(repos);
}

async function cmdStats() {
  const stats = db.stats();
  if (stats.total === 0) {
    console.log("No repos indexed. Run: clone reindex");
    return;
  }

  let totalDisk: string;
  try {
    totalDisk = execSync(`du -sh "${config.baseDir}" 2>/dev/null`, {
      encoding: "utf-8",
    })
      .split("\t")[0]
      .trim();
  } catch {
    totalDisk = "unknown";
  }

  printStats({ ...stats, totalDisk });
}

// --- Build/install lifecycle (pacman -S build / paru -B) ------------------

function nowIso(): string {
  return new Date().toISOString();
}

// Print the detected recipe so the user can review what will run (paru review).
function printRecipe(recipe: BuildRecipe) {
  console.log(`  ${chalk.dim("Build system:")} ${chalk.cyan(recipe.system)}`);
  if (recipe.deps && recipe.deps.length) {
    console.log(`  ${chalk.dim("Dependencies:")} ${recipe.deps.join(", ")}`);
  }
  console.log(`  ${chalk.dim("Will run:")}`);
  if (recipe.steps.length === 0) {
    console.log(`    ${chalk.dim("(no build steps — link declared binaries only)")}`);
  }
  for (const step of recipe.steps) {
    console.log(`    ${chalk.yellow("$")} ${step}`);
  }
}

// Reconcile install reason: explicit always wins, and an already-explicit repo
// is never downgraded to a dependency (pacman's rule).
function reconcileReason(existing: string | undefined, incoming: string): string {
  if (incoming === "explicit") return "explicit";
  return existing === "explicit" ? "explicit" : incoming;
}

// Spot a repo that almost certainly WON'T yield a PATH binary — i.e. an app /
// service / library, not a CLI tool. Returned before building so we can be honest.
function appWarning(recipe: BuildRecipe, repoPath: string): string | null {
  const willProduceBin = !!(recipe.declaredBins && recipe.declaredBins.length);
  if (recipe.system === "npm" && !willProduceBin) {
    return `package.json has no "bin" entry — looks like an app/library, not a CLI tool`;
  }
  const interpreted = recipe.system === "npm" || recipe.system === "python" || recipe.external;
  if (interpreted && !willProduceBin) {
    for (const f of ["Dockerfile", "compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"]) {
      if (existsSync(join(repoPath, f))) {
        return `${f} present — looks like a service to deploy, not a CLI tool`;
      }
    }
  }
  return null;
}

// Write a .clone-recipe so an --ask choice is reproducible next time.
function writeRecipe(
  repoPath: string,
  steps: string[],
  bins: { name: string; file: string }[] | undefined
) {
  const lines = ["# .clone-recipe — generated by `clone install --ask`"];
  for (const b of bins ?? []) lines.push(`bin: ${b.file}`);
  for (const s of steps) lines.push(s);
  writeFileSync(join(repoPath, ".clone-recipe"), lines.join("\n") + "\n");
  console.log(chalk.green(`  saved ${join(repoPath, ".clone-recipe")}`));
}

// Interactively ask the user how to build a repo (--ask, or when nothing was
// detected). Returns the recipe to use, or null if they choose not to build.
async function authorRecipe(
  repoPath: string,
  ownerRepo: string,
  detected: BuildRecipe | null
): Promise<BuildRecipe | null> {
  console.log(chalk.bold(`\nHow should clone build ${ownerRepo}?`));
  if (detected) {
    console.log(
      chalk.dim(`  detected: ${detected.system} → ${detected.steps.join(" && ") || "(no steps)"}`)
    );
  } else {
    console.log(chalk.dim(`  (no build system auto-detected)`));
  }

  const defSteps = detected?.steps.join(" && ") || "";
  const cmdline = await prompt(
    `  Build command(s), chain with ' && ' [${defSteps || "blank = don't build"}]: `
  );
  const steps = cmdline
    ? cmdline.split("&&").map((s) => s.trim()).filter(Boolean)
    : detected?.steps ?? [];

  const binAns = await prompt(`  Binary to put on PATH (relative path; blank = auto/none): `);
  const declaredBins = binAns
    ? [{ name: basename(binAns), file: binAns }]
    : detected?.declaredBins;

  if (steps.length === 0 && (!declaredBins || declaredBins.length === 0)) {
    console.log(chalk.dim("  Nothing to build or link — leaving it as a plain clone."));
    closePrompts();
    return null;
  }

  const save = await prompt(`  Save this as .clone-recipe (reproducible)? [y/N]: `);
  if (/^y/i.test(save)) writeRecipe(repoPath, steps, declaredBins);
  closePrompts();

  return {
    system: detected?.system || "recipe",
    steps,
    binHints: detected?.binHints ?? [".", "target/release", "build", "bin", "dist"],
    declaredBins,
    interpreted: detected?.interpreted,
    external: detected?.external,
    deps: detected?.deps,
  };
}

// Run a recipe and record the outcome. Shared by install and update-rebuild.
// Returns true on a successful build.
// Build a repo in a git worktree off the pristine source, then place its binary.
//   - self-contained binary (compiled) → COPY to bindir, worktree is ephemeral (removed)
//   - interpreted (npm) or --keep-build → SYMLINK into a KEPT worktree (package persists)
//   - external (pip) → run installer, no bin artifacts
function buildAndRecord(
  ownerRepo: string,
  sourcePath: string,
  recipe: BuildRecipe,
  opts: { reason?: string; buildOnly?: boolean; keepBuild?: boolean }
): boolean {
  const buildPath = join(config.buildDir, ownerRepo);
  const keep = !!(config.keepBuild || opts.keepBuild || recipe.interpreted);

  // Set up the build workspace as a worktree of source — source stays pristine.
  let workDir = buildPath;
  let madeWorktree = false;
  if (existsSync(join(sourcePath, ".git"))) {
    if (existsSync(buildPath)) {
      gitCheckoutDetached(buildPath, gitHeadCommit(sourcePath) ?? "HEAD"); // reuse → incremental
      madeWorktree = true;
    } else {
      mkdirSync(dirname(buildPath), { recursive: true });
      if (gitWorktreeAdd(sourcePath, buildPath)) madeWorktree = true;
    }
  }
  if (!madeWorktree) {
    workDir = sourcePath; // rare fallback: no commit / not a git repo
    console.log(chalk.dim(`  (building in source — no worktree available)`));
  }

  const result = buildRepo(workDir, recipe, {
    onStep: (cmd) => console.log(`  ${chalk.yellow("$")} ${cmd}`),
  });

  const removeWorktreeIfEphemeral = () => {
    if (madeWorktree && !keep) {
      gitWorktreeRemove(sourcePath, buildPath);
      try {
        rmdirSync(dirname(buildPath)); // tidy the now-empty owner dir under build/
      } catch {
        /* not empty — another repo from the same owner is building/kept */
      }
    }
  };
  const base = { install_reason: opts.reason, build_system: recipe.system };
  const keptPath = keep && madeWorktree ? buildPath : "";

  if (!result.ok) {
    console.error(chalk.red(`\nBuild failed at: ${chalk.bold(result.failedStep ?? "?")}`));
    db.setInstall(ownerRepo, { ...base, install_state: "failed", build_path: keptPath });
    removeWorktreeIfEphemeral();
    return false;
  }

  const commit = gitHeadCommit(sourcePath) ?? ""; // record the pristine SOURCE head
  const stamp = nowIso();
  // Replace any prior binaries only after a successful build (a failed build keeps them).
  removeArtifacts(JSON.parse(db.get(ownerRepo)?.artifacts || "[]"));

  // external (pip) / build-only / nothing produced → no bin to place.
  if (opts.buildOnly || recipe.external || result.producedBinaries.length === 0) {
    const state = !opts.buildOnly && recipe.external ? "installed" : "built";
    db.setInstall(ownerRepo, {
      ...base,
      install_state: state,
      installed_commit: commit,
      installed_at: stamp,
      artifacts: "[]",
      install_method: recipe.external ? "external" : "",
      build_path: opts.buildOnly && madeWorktree ? buildPath : keptPath,
    });
    if (recipe.external && !opts.buildOnly) {
      console.log(chalk.green(`\nInstalled ${ownerRepo}`) + chalk.dim(` (${recipe.system} placed its own scripts)`));
    } else if (opts.buildOnly) {
      console.log(chalk.green(`\nBuilt ${ownerRepo}`) + chalk.dim(` (--build-only; build at ${buildPath})`));
    } else {
      console.log(chalk.green(`\nBuilt ${ownerRepo}`) + chalk.dim(" — no binary detected (library?)."));
    }
    if (!opts.buildOnly) removeWorktreeIfEphemeral();
    return true;
  }

  // Place produced binaries: symlink into a kept worktree, or copy out (then drop it).
  const { linked, skipped } =
    keptPath
      ? linkArtifacts(result.producedBinaries, config.binDir)
      : copyArtifacts(result.producedBinaries, config.binDir);
  const method = keptPath ? "symlink" : "copy";
  db.setInstall(ownerRepo, {
    ...base,
    install_state: linked.length ? "installed" : "built",
    installed_commit: commit,
    installed_at: stamp,
    artifacts: JSON.stringify(linked.map((l) => l.link)),
    install_method: method,
    build_path: keptPath,
  });
  if (method === "copy") removeWorktreeIfEphemeral();

  console.log(chalk.green(`\nInstalled ${ownerRepo}`) + chalk.dim(`  (${method})`));
  for (const l of linked) {
    console.log(`  ${chalk.green("→")} ${l.link}`);
  }
  for (const s of skipped) {
    console.log(`  ${chalk.yellow("skip")} ${s.name} ${chalk.dim(`(${s.reason})`)}`);
  }
  if (linked.length && !process.env.PATH?.split(":").includes(config.binDir)) {
    console.log(
      chalk.dim(`\n  Note: ${config.binDir} is not on your PATH — add it to use these.`)
    );
  }
  return true;
}

async function cmdInstall(
  input: string,
  opts: {
    buildOnly?: boolean;
    force?: boolean;
    needed?: boolean;
    yes?: boolean;
    asDeps?: boolean;
    keepBuild?: boolean;
    ask?: boolean;
  } = {},
  _chain: Set<string> = new Set() // cycle guard for recursive dep installs
) {
  // A local path target (paru -B): build a repo already on disk, in place.
  const looksLikePath =
    input === "." ||
    input === ".." ||
    input.startsWith("./") ||
    input.startsWith("../") ||
    input.startsWith("/") ||
    input.startsWith("~") ||
    (existsSync(input) && statSync(input).isDirectory());

  let ownerRepo: string;
  let dest: string;

  if (looksLikePath) {
    const p = input.startsWith("~")
      ? join(process.env.HOME || "", input.slice(1))
      : resolve(input);
    if (!existsSync(join(p, ".git"))) {
      console.error(`Not a git repo: ${p}`);
      process.exit(1);
    }
    dest = p;
    const remote = gitRemoteUrl(p);
    ownerRepo = (remote && ownerRepoFromRemote(remote)) || `local/${basename(p)}`;
    if (!db.has(ownerRepo)) {
      if (remote && ownerRepoFromRemote(remote)) {
        db.upsert(await buildEntry(ownerRepo, "manual", dest));
      } else {
        db.upsert(localEntry(ownerRepo, dest)); // no GitHub origin — minimal, no network
      }
    }
  } else {
    const parsed = parseGitHubUrl(input);
    if (!parsed) {
      console.error(`Invalid repo: ${input}`);
      process.exit(1);
    }
    ownerRepo = parsed;
    const [owner] = ownerRepo.split("/");
    dest = join(config.baseDir, ownerRepo);

    // 1. Acquire source if we don't have it (pacman -S download half).
    if (!existsSync(dest)) {
      console.log(`${chalk.cyan("Cloning")} ${ownerRepo}...`);
      mkdirSync(join(config.baseDir, owner), { recursive: true });
      if (!gitClone(ownerRepo, dest)) {
        console.error(chalk.red(`Failed to clone ${ownerRepo}`));
        process.exit(1);
      }
      db.upsert(await buildEntry(ownerRepo, "manual", dest));
    } else if (!db.has(ownerRepo)) {
      db.upsert(await buildEntry(ownerRepo, "manual", dest));
    }
  }

  const entry = db.get(ownerRepo);
  const reason = reconcileReason(
    entry?.install_reason,
    opts.asDeps ? "dependency" : "explicit"
  );
  const head = gitHeadCommit(dest);

  // --needed: already installed at this commit → skip rebuild.
  if (
    opts.needed &&
    !opts.force &&
    entry?.install_state === "installed" &&
    entry.installed_commit &&
    entry.installed_commit === head
  ) {
    console.log(
      chalk.green(`${ownerRepo} is up to date`) +
        chalk.dim(` (installed @ ${head?.slice(0, 7)})`)
    );
    if (entry.install_reason !== reason) db.setInstall(ownerRepo, { install_reason: reason });
    return;
  }

  // 2. Detect how to build.
  let recipe = detectBuildSystem(dest, config.buildOverrides);

  // 2.5. Interactive authoring (--ask, or nothing auto-detected).
  if (opts.ask || !recipe) {
    if (!recipe && !opts.ask) {
      console.error(chalk.red(`No build system detected for ${ownerRepo}.`));
      console.error(
        chalk.dim(
          `  Re-run with --ask to set it up interactively, or add a .clone-recipe` +
            ` (build commands + 'bin: path' lines) to teach clone how.`
        )
      );
      db.setInstall(ownerRepo, { install_reason: reason });
      process.exitCode = 1;
      return;
    }
    recipe = await authorRecipe(dest, ownerRepo, recipe);
    if (!recipe) {
      // User opted not to build — leave it as a plain clone.
      db.setInstall(ownerRepo, { install_reason: reason });
      return;
    }
  }
  if (!recipe) return; // (unreachable — narrows the type for TS)

  // 3. Review before building (we're about to run upstream code).
  console.log();
  console.log(chalk.bold(`Install ${ownerRepo}`));
  printRecipe(recipe);
  const warn = appWarning(recipe, dest);
  if (warn) {
    console.log();
    console.log(chalk.yellow(`  ⚠ ${warn}.`));
    console.log(
      chalk.dim(
        `    'clone install' builds CLI tools onto PATH. If this is an app/service,` +
          ` you may just want the source — it's already cloned. Use --ask to set a custom build.`
      )
    );
  }
  console.log();
  // Skip the confirm in --ask mode (the user just authored the recipe) and with -y.
  if (!opts.yes && !opts.ask) {
    const ok = await confirm(`Proceed with build?`);
    if (!ok) {
      console.log("Cancelled.");
      return;
    }
  }

  // 3.5. Resolve declared dependencies first (they may be build-time needs).
  if (recipe.deps && recipe.deps.length) {
    _chain.add(ownerRepo);
    for (const dep of recipe.deps) {
      const depId = parseGitHubUrl(dep) ?? dep;
      if (_chain.has(depId)) {
        console.log(chalk.yellow(`  ↻ skipping dependency cycle: ${depId}`));
        continue;
      }
      console.log(chalk.cyan(`\n→ dependency of ${ownerRepo}: ${depId}`));
      await cmdInstall(
        depId,
        { asDeps: true, yes: opts.yes, needed: true },
        _chain
      );
      db.addDep(ownerRepo, depId); // record edge even if the dep was already present
    }
  }

  // 4 + 5. Build (wrapped in transaction hooks), then link.
  if (!fireHooks("install", "pre", { repo: ownerRepo, cwd: dest })) {
    console.error(chalk.red(`Aborted by pre-install hook.`));
    process.exitCode = 1;
    return;
  }
  const built = buildAndRecord(ownerRepo, dest, recipe, {
    reason,
    buildOnly: opts.buildOnly,
    keepBuild: opts.keepBuild,
  });
  if (built) fireHooks("install", "post", { repo: ownerRepo, cwd: dest });
}

async function cmdUninstall(ownerRepo: string) {
  const entry = db.get(ownerRepo);
  if (!entry) {
    console.error(`Not in index: ${ownerRepo}`);
    process.exit(1);
  }

  const artifacts: string[] = JSON.parse(entry.artifacts || "[]");
  const removed = removeArtifacts(artifacts); // symlinks or copied files
  // Tear down the build worktree if one was kept (npm / --keep-build).
  if (entry.build_path) gitWorktreeRemove(entry.path, entry.build_path);

  db.setInstall(ownerRepo, {
    install_state: "cloned",
    installed_commit: "",
    installed_at: "",
    artifacts: "[]",
    install_method: "",
    build_path: "",
  });

  console.log(
    `${chalk.green("Uninstalled")} ${ownerRepo} ` +
      chalk.dim(`(removed ${removed} binar${removed === 1 ? "y" : "ies"}; source kept clean at ${entry.path})`)
  );
  if (entry.build_system === "python") {
    console.log(
      chalk.dim(`  Note: ${entry.build_system} scripts are pip-managed — run \`pip uninstall\` to remove them.`)
    );
  }
}

// Low-level delete of a single repo (artifacts + dir + index entry + hooks).
// No prompting — callers handle confirmation.
function deleteRepo(ownerRepo: string) {
  const entry = db.get(ownerRepo);
  const repoPath = entry?.path ?? join(config.baseDir, ownerRepo);
  const artifacts: string[] = entry ? JSON.parse(entry.artifacts || "[]") : [];

  fireHooks("remove", "pre", { repo: ownerRepo, cwd: repoPath });
  if (artifacts.length) removeArtifacts(artifacts); // copies or symlinks

  // Tear down the build worktree first (so git's worktree list stays sane), then source.
  const buildPath = join(config.buildDir, ownerRepo);
  if (existsSync(buildPath) && !gitWorktreeRemove(repoPath, buildPath)) {
    rmSync(buildPath, { recursive: true, force: true });
  }
  rmSync(repoPath, { recursive: true, force: true });
  db.remove(ownerRepo); // also drops dep edges touching this repo

  for (const owner of [dirname(repoPath), dirname(buildPath)]) {
    try {
      rmdirSync(owner); // remove now-empty owner dirs in source/ and build/
    } catch {
      // not empty, that's fine
    }
  }
  console.log(`${chalk.green("Removed")} ${ownerRepo}`);
  fireHooks("remove", "post", { repo: ownerRepo });
}

async function cmdRemove(
  ownerRepo: string,
  opts: { dryRun?: boolean; force?: boolean; recursive?: boolean } = {}
) {
  const repoPath = join(config.baseDir, ownerRepo);
  if (!existsSync(repoPath)) {
    console.error(`Not found: ${repoPath}`);
    process.exit(1);
  }

  const diskSize = getDiskSize(repoPath);
  const entry = db.get(ownerRepo);
  const artifacts: string[] = entry ? JSON.parse(entry.artifacts || "[]") : [];
  const dirty = gitIsDirty(repoPath);

  // -s/--recursive: also remove dep-children that nothing else needs (pacman -Rs).
  const collectOrphanedDeps = (): string[] => {
    if (!opts.recursive) return [];
    const out: string[] = [];
    const visit = (parent: string) => {
      for (const child of db.childrenOf(parent)) {
        const ce = db.get(child);
        // only auto-remove deps whose ONLY remaining requirer is what we're removing
        const otherParents = db.parentsOf(child).filter((p) => p !== parent && !out.includes(p));
        if (
          ce &&
          ce.install_reason === "dependency" &&
          otherParents.length === 0 &&
          !out.includes(child)
        ) {
          out.push(child);
          visit(child);
        }
      }
    };
    visit(ownerRepo);
    return out;
  };
  const orphanedDeps = collectOrphanedDeps();

  if (opts.dryRun) {
    console.log(`Would remove: ${ownerRepo} (${diskSize}) at ${repoPath}`);
    if (artifacts.length)
      console.log(chalk.dim(`  would unlink ${artifacts.length} binary symlink(s)`));
    if (orphanedDeps.length)
      console.log(chalk.dim(`  would also remove now-orphaned deps: ${orphanedDeps.join(", ")}`));
    if (dirty)
      console.log(chalk.yellow(`  ⚠ working tree has uncommitted changes / untracked files`));
    return;
  }

  // .pacsave philosophy: don't silently destroy modified work.
  if (dirty && !opts.force) {
    console.log(
      chalk.yellow(`⚠ ${ownerRepo} has uncommitted changes or untracked files.`)
    );
    console.log(
      chalk.dim(`  This delete is irreversible. Re-run with --force, or confirm below.`)
    );
  }
  if (orphanedDeps.length) {
    console.log(
      chalk.dim(`  Will also remove now-orphaned dependencies: ${orphanedDeps.join(", ")}`)
    );
  }

  const yes = await confirm(
    `Remove ${chalk.bold(ownerRepo)} (${diskSize})${
      artifacts.length
        ? ` and unlink ${artifacts.length} binar${artifacts.length === 1 ? "y" : "ies"}`
        : ""
    }${orphanedDeps.length ? ` + ${orphanedDeps.length} orphaned dep(s)` : ""}?`
  );

  if (yes) {
    deleteRepo(ownerRepo);
    for (const dep of orphanedDeps) {
      if (existsSync(join(config.baseDir, dep))) deleteRepo(dep);
    }
  } else {
    console.log("Cancelled.");
  }
}

async function cmdUpdate(
  target?: string,
  opts: { rebuild?: boolean; ignore?: string } = {}
) {
  const doRebuild = opts.rebuild !== false;
  const ignored = ignoreSet(opts.ignore);
  const wasInstalled = (e?: RepoEntry) =>
    !!e && (e.install_state === "installed" || e.install_state === "built");

  // Re-detect, unlink stale artifacts, rebuild and relink. Returns true if rebuilt.
  const rebuild = (entry: RepoEntry): boolean => {
    const recipe = detectBuildSystem(entry.path, config.buildOverrides);
    if (!recipe) {
      console.log(chalk.dim(`      (no build system — skipping rebuild)`));
      return false;
    }
    console.log(chalk.dim(`      rebuilding (${entry.install_state})...`));
    // buildAndRecord rebuilds in the worktree and swaps the binary (old kept on failure).
    return buildAndRecord(entry.id, entry.path, recipe, {
      reason: entry.install_reason || "explicit",
      keepBuild: !!entry.build_path, // preserve a kept-worktree install as kept
    });
  };

  if (!target || target === "all") {
    const repos = db.list({});
    console.log(chalk.bold(`Updating ${repos.length} repos...\n`));

    let updated = 0,
      rebuilt = 0,
      skipped = 0;
    let i = 0;
    for (const repo of repos) {
      i++;
      if (!existsSync(repo.path)) continue;
      if (ignored.has(repo.id.toLowerCase())) {
        console.log(`  [${i}/${repos.length}] ${repo.id} ${chalk.dim("ignored")}`);
        continue;
      }
      const before = gitHeadCommit(repo.path);
      const ok = gitPull(repo.path, { ffOnly: true, quiet: true });
      const after = gitHeadCommit(repo.path);
      const changed = !!before && !!after && before !== after;

      if (!ok) {
        console.log(`  [${i}/${repos.length}] ${repo.id} ${chalk.yellow("skipped")}`);
        skipped++;
        continue;
      }
      console.log(
        `  [${i}/${repos.length}] ${repo.id} ${
          changed ? chalk.green("updated") : chalk.dim("current")
        }`
      );
      if (changed) {
        updated++;
        if (doRebuild && wasInstalled(repo) && rebuild(repo)) rebuilt++;
        fireHooks("update", "post", { repo: repo.id, cwd: repo.path });
      }
    }
    console.log(
      `\n  ${chalk.green(`updated=${updated}`)} ${chalk.cyan(`rebuilt=${rebuilt}`)} ${chalk.yellow(`skipped=${skipped}`)}`
    );
  } else {
    const ownerRepo = parseGitHubUrl(target) ?? target;
    const repoPath = join(config.baseDir, ownerRepo);
    if (!existsSync(repoPath)) {
      console.error(`Not found: ${target}`);
      process.exit(1);
    }
    console.log(`Updating ${chalk.bold(ownerRepo)}...`);
    const before = gitHeadCommit(repoPath);
    gitPull(repoPath); // git prints its own "Already up to date." / progress
    const after = gitHeadCommit(repoPath);
    const changed = !!before && !!after && before !== after;

    const entry = db.get(ownerRepo);
    if (changed && doRebuild && wasInstalled(entry)) {
      rebuild(entry!);
    }
    if (changed) fireHooks("update", "post", { repo: ownerRepo, cwd: repoPath });
  }
}

async function cmdReindex() {
  console.log(chalk.bold("Reindexing all repos...\n"));

  // Refresh discovery metadata from disk WITHOUT db.clear(): upsert preserves
  // lifecycle state (install_state/artifacts/...) via ON CONFLICT, so reindex no
  // longer wipes what you've installed. Stale entries are pruned afterwards.
  const repos = findGitRepos(config.baseDir);
  const found = new Set<string>();
  let count = 0;

  for (const { path: repoPath, ownerRepo } of repos) {
    if (!/^[^/]+\/[^/]+$/.test(ownerRepo)) {
      console.log(`  ${chalk.yellow("SKIP")} ${ownerRepo} (not owner/repo format)`);
      continue;
    }

    count++;
    process.stdout.write(`  [${count}] ${ownerRepo}... `);

    const existing = db.get(ownerRepo);
    if (existing?.source === "local") {
      // Locally-created repos have no GitHub metadata — refresh disk/path only,
      // and keep source=local (don't re-fetch or rewrite it to "manual").
      db.upsert({ ...existing, disk_size: getDiskSize(repoPath), path: repoPath });
      found.add(ownerRepo);
      console.log(chalk.green("ok") + chalk.dim(" (local)"));
      continue;
    }

    // Preserve how the repo first entered the index; only compute for new repos.
    const source =
      existing?.source ?? (manifest.has(ownerRepo) ? "trending" : "manual");
    const entry = await buildEntry(ownerRepo, source, repoPath);
    db.upsert(entry);
    found.add(ownerRepo);
    console.log(chalk.green("ok"));
  }

  // Prune index entries whose repo is no longer on disk — but KEEP tracked
  // apps/services, which intentionally live outside the source tree (under
  // build/ or elsewhere) and so are never rediscovered by the source scan.
  let pruned = 0;
  let appsKept = 0;
  for (const e of db.list({})) {
    if (found.has(e.id)) continue;
    if (e.install_state === "app" && existsSync(e.path)) {
      appsKept++;
      continue;
    }
    db.remove(e.id);
    pruned++;
  }

  console.log(
    `\n${chalk.green(`Indexed ${count} repos`)}` +
      (appsKept ? chalk.dim(`, kept ${appsKept} app/service`) : "") +
      (pruned ? chalk.dim(`, pruned ${pruned} missing`) : "")
  );
}

// --- v2: outdated (devel) / clean / orphans -------------------------------

async function cmdOutdated(
  opts: { all?: boolean; update?: boolean; ignore?: string } = {}
) {
  // Default to installed/built repos (the ones you care about keeping current);
  // --all checks every indexed repo.
  const ignored = ignoreSet(opts.ignore);
  const repos = (opts.all ? db.list({}) : db.list({ installed: true })).filter(
    (r) => !ignored.has(r.id.toLowerCase())
  );
  if (repos.length === 0) {
    console.log(
      opts.all
        ? "No repos indexed."
        : "No installed repos. Use --all to check every cloned repo."
    );
    return;
  }

  console.log(
    chalk.dim(
      `Checking ${repos.length} repo(s) for upstream commits (git ls-remote, no fetch)...`
    )
  );

  // Check remotes concurrently — ls-remote is network-bound, so a serial loop
  // over hundreds of repos is painfully slow.
  const POOL = 16;
  const checked = await mapPool(repos, POOL, async (repo) => {
    if (!existsSync(repo.path)) return null;
    const local = gitHeadCommit(repo.path);
    const remote = await gitRemoteHeadAsync(repo.path);
    if (local && remote && local !== remote) return { entry: repo, local, remote };
    return null;
  });
  const outdated = checked.filter(
    (x): x is { entry: RepoEntry; local: string; remote: string } => x !== null
  );

  if (outdated.length === 0) {
    console.log(chalk.green("Everything is up to date."));
    return;
  }

  console.log(
    chalk.bold.yellow(`\n${outdated.length} repo(s) have upstream updates:\n`)
  );
  for (const o of outdated) {
    const tag =
      o.entry.install_state === "installed" || o.entry.install_state === "built"
        ? chalk.green(" ●")
        : "";
    console.log(
      `  ${chalk.cyan(o.entry.id)}${tag}  ${chalk.dim(
        `${o.local.slice(0, 7)} → ${o.remote.slice(0, 7)}`
      )}`
    );
  }

  if (opts.update) {
    console.log();
    for (const o of outdated) await cmdUpdate(o.entry.id);
  } else {
    console.log(
      chalk.dim(`\nRun \`clone outdated --update\` to update them all.`)
    );
  }
}

async function cmdClean(
  opts: {
    cache?: boolean;
    builds?: boolean;
    duplicates?: boolean;
    dryRun?: boolean;
    yes?: boolean;
  } = {}
) {
  // 1. Broken bindir symlinks — but ONLY ones clone recorded as its own artifacts.
  //    A broken symlink in a shared bindir (~/.local/bin) that the user created
  //    by hand must never be touched, even if it points into the repos root.
  const owned = new Set<string>();
  for (const e of db.list({})) {
    for (const a of JSON.parse(e.artifacts || "[]") as string[]) owned.add(a);
  }
  const brokenLinks: string[] = [];
  if (existsSync(config.binDir)) {
    for (const name of readdirSync(config.binDir)) {
      const link = join(config.binDir, name);
      try {
        if (
          lstatSync(link).isSymbolicLink() &&
          !existsSync(link) &&
          owned.has(link)
        ) {
          brokenLinks.push(link);
        }
      } catch {
        /* ignore */
      }
    }
  }

  // 2. Index entries whose repo dir is gone.
  const dangling = db.list({}).filter((e) => !existsSync(e.path));

  // 3. Build worktrees not backing a live install — kept ones (incremental) and
  //    buildOnly leftovers. npm/keep installs use a symlink INTO their worktree,
  //    so those are spared.
  const liveBuilds = new Set(
    db
      .list({})
      .filter((e) => e.install_method === "symlink")
      .map((e) => e.build_path)
      .filter(Boolean)
  );
  const buildDirs: { repo: string; dir: string; size: string; source: string }[] = [];
  if (opts.builds && existsSync(config.buildDir)) {
    for (const owner of readdirSync(config.buildDir)) {
      const ownerPath = join(config.buildDir, owner);
      let repos: string[];
      try {
        if (!statSync(ownerPath).isDirectory()) continue;
        repos = readdirSync(ownerPath);
      } catch {
        continue;
      }
      for (const repo of repos) {
        const p = join(ownerPath, repo);
        if (!existsSync(join(p, ".git"))) continue; // a worktree has a .git file
        if (liveBuilds.has(p)) continue; // backs a live npm/keep install — spare it
        const id = `${owner}/${repo}`;
        buildDirs.push({
          repo: id,
          dir: p,
          size: getDiskSize(p),
          source: db.get(id)?.path ?? join(config.baseDir, id),
        });
      }
    }
  }

  // 4. Redundant copies set aside in _duplicates/ (the dedup holding pen) — the
  //    `pacman -Sc` analogue. Only cleared with the explicit --duplicates flag.
  const dupDir = join(config.baseDir, "_duplicates");
  const dupItems = existsSync(dupDir) ? readdirSync(dupDir) : [];

  console.log(chalk.bold("clean — reclaimable:"));
  console.log(`  broken bin symlinks:    ${brokenLinks.length}`);
  console.log(`  dangling index entries: ${dangling.length}`);
  if (opts.builds)
    console.log(`  build worktrees:        ${buildDirs.length}`);
  if (opts.cache) console.log(`  trending cache:         (will clear)`);
  if (opts.duplicates) {
    console.log(
      `  duplicate repos:        ${dupItems.length}  ${chalk.dim(dupItems.length ? getDiskSize(dupDir) : "")}`
    );
    for (const d of dupItems) {
      console.log(chalk.dim(`    ${getDiskSize(join(dupDir, d))}\t${d}`));
    }
  } else if (dupItems.length)
    console.log(
      chalk.dim(`  (${dupItems.length} set aside in _duplicates/, ${getDiskSize(dupDir)} — add --duplicates to clear)`)
    );

  const nothing =
    !brokenLinks.length &&
    !dangling.length &&
    (!opts.builds || !buildDirs.length) &&
    (!opts.duplicates || !dupItems.length) &&
    !opts.cache;
  if (nothing) {
    console.log(chalk.green("\n  Nothing to clean."));
    return;
  }
  if (opts.builds && buildDirs.length) {
    for (const b of buildDirs)
      console.log(chalk.dim(`    ${b.size}\t${b.dir}`));
  }

  if (opts.dryRun) {
    console.log(chalk.dim("\n  (dry run — nothing changed)"));
    return;
  }

  const yes = opts.yes || (await confirm("\nProceed?"));
  if (!yes) {
    console.log("Cancelled.");
    return;
  }

  let actions = 0;
  if (brokenLinks.length) actions += unlinkArtifacts(brokenLinks);
  for (const e of dangling) {
    db.remove(e.id);
    actions++;
  }
  if (opts.builds) {
    for (const b of buildDirs) {
      if (!gitWorktreeRemove(b.source, b.dir)) {
        rmSync(b.dir, { recursive: true, force: true });
      }
      try {
        rmdirSync(dirname(b.dir)); // tidy empty owner dir under build/
      } catch {
        /* not empty */
      }
      actions++;
    }
  }
  if (opts.duplicates) {
    for (const d of dupItems) {
      rmSync(join(dupDir, d), { recursive: true, force: true });
      actions++;
    }
  }
  if (opts.cache) {
    // Delete only the trending cache FILES — never the dir itself. The cache dir
    // may coincide with the data dir (CLONE_DATA mode), so rm-ing it would wipe
    // clone.db / config.json / hooks.
    const dir = trendingCacheDir();
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (/^trending-.*\.json$/.test(f)) {
          rmSync(join(dir, f), { force: true });
          actions++;
        }
      }
    }
  }
  console.log(chalk.green(`\n  Cleaned (${actions} action${actions === 1 ? "" : "s"}).`));
}

async function cmdOrphans(opts: { remove?: boolean; yes?: boolean } = {}) {
  const orphans = db.orphans();
  if (orphans.length === 0) {
    console.log(chalk.green("No orphaned dependencies."));
    return;
  }
  console.log(
    chalk.bold(
      `${orphans.length} orphaned dependency repo(s) — installed as a dep, now required by nothing:\n`
    )
  );
  for (const o of orphans) {
    console.log(`  ${chalk.cyan(o.id)} ${chalk.dim(`(${o.install_state})`)}`);
  }

  if (opts.remove) {
    console.log();
    const yes = opts.yes || (await confirm(`Remove all ${orphans.length} orphan(s)?`));
    if (!yes) {
      console.log("Cancelled.");
      return;
    }
    for (const o of orphans) {
      if (existsSync(o.path)) deleteRepo(o.id);
    }
  } else {
    console.log(chalk.dim(`\nRun \`clone orphans --remove\` to remove them.`));
  }
}

// --- v3: reason / check / owns / changelog --------------------------------

// Change a repo's install reason (pacman -D --asexplicit / --asdeps).
async function cmdReason(
  ownerRepo: string,
  opts: { explicit?: boolean; asDeps?: boolean }
) {
  const entry = db.get(ownerRepo);
  if (!entry) {
    console.error(`Not in index: ${ownerRepo}`);
    process.exit(1);
  }
  if (opts.explicit === opts.asDeps) {
    console.error("Specify exactly one of --explicit or --asdeps.");
    process.exit(1);
  }
  const reason = opts.explicit ? "explicit" : "dependency";
  db.setInstall(ownerRepo, { install_reason: reason });
  console.log(
    `${chalk.green("Marked")} ${ownerRepo} as ${chalk.bold(reason)}` +
      (reason === "explicit"
        ? chalk.dim(" (won't be removed as an orphan)")
        : chalk.dim(" (eligible for orphan cleanup)"))
  );
}

// Verify installed repos are intact (pacman -Qk): dir present, artifact symlinks
// alive, git repo healthy. Read-only.
// Directories that only appear once a repo has been BUILT — they should never
// live in the pristine source tree (clone builds in a worktree under build/).
// 'vendor' is deliberately excluded: it's legitimately committed (Go modules).
const ARTIFACT_DIRS = [
  "target", "node_modules", "build", "dist", ".next", "out",
  "__pycache__", ".gradle", ".tox", ".pytest_cache",
];
// A virtualenv means the repo is set up to RUN in place — i.e. an app/service,
// not pristine source.
const VENV_DIRS = ["venv", ".venv"];

// Best-effort byte size of a directory (fast path via `du`, 0 on any failure).
function duBytes(dir: string): number {
  try {
    const out = execSync(`du -sb ${JSON.stringify(dir)}`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20000,
    });
    return parseInt(out.split(/\s+/)[0], 10) || 0;
  } catch {
    return 0;
  }
}

function humanSize(bytes: number): string {
  const u = ["B", "K", "M", "G", "T"];
  let n = bytes, i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)}${u[i]}`;
}

// Paths referenced by any systemd *user* unit (WorkingDirectory/ExecStart/...),
// so we can flag a repo that's actively running as a service in place.
function systemdReferencedPaths(): string[] {
  const out: string[] = [];
  const dir = join(homedir(), ".config", "systemd", "user");
  let files: string[];
  try { files = readdirSync(dir); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith(".service")) continue;
    try {
      const txt = readFileSync(join(dir, f), "utf-8");
      for (const m of txt.matchAll(
        /(?:WorkingDirectory|ExecStart|ExecStartPre|EnvironmentFile)=-?\s*(\/\S+)/g
      )) {
        out.push(m[1]);
      }
    } catch { /* unreadable unit — skip */ }
  }
  return out;
}

// The systemd *user* unit (if any) whose paths point into this repo — so clone
// can show that an app is wired up as a service. Returns the unit name (no .service).
function serviceForPath(repoPath: string): string | null {
  const dir = join(homedir(), ".config", "systemd", "user");
  let files: string[];
  try { files = readdirSync(dir); } catch { return null; }
  for (const f of files) {
    if (!f.endsWith(".service")) continue;
    try {
      const txt = readFileSync(join(dir, f), "utf-8");
      for (const m of txt.matchAll(
        /(?:WorkingDirectory|ExecStart|ExecStartPre|EnvironmentFile)=-?\s*(\/\S+)/g
      )) {
        if (m[1] === repoPath || m[1].startsWith(repoPath + "/")) {
          return f.replace(/\.service$/, "");
        }
      }
    } catch { /* skip */ }
  }
  return null;
}

// `systemctl --user is-active <unit>` → "active"/"inactive"/... (never throws).
function serviceActive(unit: string): string {
  try {
    return execSync(`systemctl --user is-active ${JSON.stringify(unit)}`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "inactive";
  }
}

// Track an app/service that lives and RUNS in place (e.g. under build/) rather
// than being a CLI installed onto PATH. Indexes it where it sits and marks it
// install_state='app' so reindex never prunes it for being outside source/.
// With --with-source it also clones a PRISTINE source mirror into source/owner/repo
// (so the index `path` is clean and `build_path` is the running instance).
async function registerApp(
  targetPath = ".",
  opts: { dryRun?: boolean; withSource?: boolean } = {}
) {
  const p = targetPath.startsWith("~")
    ? join(process.env.HOME || "", targetPath.slice(1))
    : resolve(targetPath);
  if (!existsSync(p) || !statSync(p).isDirectory()) {
    console.error(`Not a directory: ${p}`);
    process.exit(1);
  }
  if (!existsSync(join(p, ".git"))) {
    console.error(`Not a git repo: ${p}`);
    console.error(chalk.dim(`  'adopt --app' tracks a single app/service repo where it lives.`));
    process.exit(1);
  }
  const remote = gitRemoteUrl(p);
  const fromRemote = !!(remote && ownerRepoFromRemote(remote));
  const id = (remote && ownerRepoFromRemote(remote)) || `local/${basename(p)}`;
  const svc = serviceForPath(p);

  // The running instance is always the build_path; the index `path` is the
  // pristine source mirror when --with-source, otherwise the instance itself.
  const buildPath = p;
  const sourceDest = join(config.baseDir, id);
  const wantSource = !!opts.withSource;
  let sourcePath = p;

  if (opts.dryRun) {
    console.log(chalk.dim(`would track app ${id} (running at ${p})`));
    if (wantSource) {
      console.log(
        chalk.dim(
          existsSync(sourceDest)
            ? `  source mirror already present at ${sourceDest}`
            : `  would clone a pristine source mirror to ${sourceDest}`
        )
      );
    }
    if (svc) console.log(chalk.dim(`  service: ${svc}`));
    return;
  }

  if (wantSource) {
    if (existsSync(sourceDest)) {
      sourcePath = sourceDest; // already mirrored — reuse it
    } else {
      const originUrl = fromRemote ? `https://github.com/${id}.git` : remote ?? undefined;
      console.log(chalk.cyan(`Cloning pristine source mirror → ${sourceDest}`));
      mkdirSync(dirname(sourceDest), { recursive: true });
      if (gitCloneLocal(p, sourceDest, originUrl)) {
        sourcePath = sourceDest;
      } else {
        console.error(
          chalk.yellow(`  Couldn't clone the source mirror — tracking the instance in place instead.`)
        );
      }
    }
  }

  await indexRepoAt(id, fromRemote, sourcePath); // path = source mirror (or instance)
  db.setInstall(id, {
    install_state: "app",
    install_method: "external",
    build_path: buildPath,
  });

  console.log(`${chalk.green("Tracking app")} ${chalk.magenta("▣")} ${chalk.cyan(id)}`);
  if (sourcePath !== buildPath) {
    console.log(`  ${chalk.dim("source")}  ${sourcePath} ${chalk.dim("(pristine)")}`);
    console.log(`  ${chalk.dim("running")} ${buildPath}`);
  } else {
    console.log(`  ${chalk.dim("at")} ${buildPath}`);
  }
  if (svc) {
    const st = serviceActive(svc);
    const c = st === "active" ? chalk.green : chalk.yellow;
    console.log(`  ${chalk.dim("service")} ${svc} ${c(`(${st})`)}`);
  }
  console.log(
    chalk.dim(`  Reindex-safe: clone keeps this even though the instance lives outside source/.`)
  );
}

// Audit the pristine source tree (clone check --source): which repos are clean,
// which carry build artifacts, and which are really apps/services that belong
// in build/. Read-only — never deletes anything.
async function cmdCheckSource() {
  const repos = db.list({}).filter((r) => r.path.startsWith(config.baseDir + "/"));
  if (repos.length === 0) {
    console.log("No source repos indexed.");
    return;
  }
  const unitPaths = systemdReferencedPaths();

  let pristine = 0;
  let reclaimable = 0;
  const dirty: { id: string; arts: string[]; bytes: number }[] = [];
  const apps: { id: string; why: string }[] = [];
  const moved: string[] = [];

  for (const repo of repos) {
    if (!existsSync(repo.path)) {
      moved.push(repo.id); // indexed under source but gone (moved to build/, deleted, …)
      continue;
    }
    const arts: string[] = [];
    let bytes = 0;
    for (const d of ARTIFACT_DIRS) {
      const p = join(repo.path, d);
      if (existsSync(p)) {
        arts.push(d);
        bytes += duBytes(p);
      }
    }
    const hasVenv = VENV_DIRS.some((v) =>
      existsSync(join(repo.path, v, "bin", "python"))
    );
    const isService = unitPaths.some(
      (p) => p === repo.path || p.startsWith(repo.path + "/")
    );

    if (isService || hasVenv) {
      apps.push({
        id: repo.id,
        why: isService ? "running as a systemd service" : "has a virtualenv",
      });
    }
    if (arts.length) {
      dirty.push({ id: repo.id, arts, bytes });
      reclaimable += bytes;
    } else if (!isService && !hasVenv) {
      pristine++;
    }
  }

  if (apps.length) {
    console.log(chalk.bold("\n  Apps/services living in source (belong in build/):"));
    for (const a of apps) {
      console.log(`    ${chalk.magenta("⚑")} ${a.id} ${chalk.dim(`— ${a.why}`)}`);
    }
  }
  if (dirty.length) {
    console.log(chalk.bold("\n  Source repos polluted with build artifacts:"));
    dirty.sort((a, b) => b.bytes - a.bytes);
    for (const d of dirty) {
      console.log(
        `    ${chalk.yellow("◐")} ${d.id} ${chalk.dim(
          `— ${d.arts.join(", ")} (${humanSize(d.bytes)})`
        )}`
      );
    }
  }
  if (moved.length) {
    console.log(chalk.bold("\n  Indexed under source but missing on disk (moved/deleted?):"));
    for (const id of moved) console.log(`    ${chalk.red("✗")} ${id}`);
    console.log(chalk.dim(`    → run 'clone reindex' to reconcile the index.`));
  }

  console.log();
  console.log(
    `  ${chalk.green(`${pristine} pristine`)} · ` +
      `${chalk.yellow(`${dirty.length} with artifacts`)} · ` +
      `${chalk.magenta(`${apps.length} app/service`)} · ` +
      `${chalk.red(`${moved.length} missing`)}  (of ${repos.length} source repos)`
  );
  if (reclaimable > 0) {
    console.log(
      chalk.dim(
        `  ~${humanSize(reclaimable)} of build artifacts in source. ` +
          `These regenerate on build — safe to delete from the pristine tree.`
      )
    );
  }
  if (dirty.length || apps.length || moved.length) process.exitCode = 1;
}

async function cmdCheck(target?: string, opts: { all?: boolean; source?: boolean } = {}) {
  if (opts.source) return cmdCheckSource();
  let repos: RepoEntry[];
  if (target) {
    const e = db.get(parseGitHubUrl(target) ?? target);
    if (!e) {
      console.error(`Not in index: ${target}`);
      process.exit(1);
    }
    repos = [e];
  } else {
    repos = opts.all ? db.list({}) : db.list({ installed: true });
    // Tracked apps/services aren't "installed" binaries, but they're things
    // clone manages — fold them into the default check.
    if (!opts.all) {
      for (const a of db.list({})) {
        if (a.install_state === "app" && !repos.some((r) => r.id === a.id)) repos.push(a);
      }
    }
  }
  if (repos.length === 0) {
    console.log(
      opts.all ? "No repos indexed." : "No installed repos. Use --all to check everything."
    );
    return;
  }

  let problems = 0;
  for (const repo of repos) {
    const issues: string[] = [];
    if (!existsSync(repo.path)) {
      issues.push("repo dir missing");
    } else if (!gitHeadCommit(repo.path)) {
      issues.push("git repo unreadable/corrupt");
    }
    for (const link of JSON.parse(repo.artifacts || "[]") as string[]) {
      if (!existsSync(link)) issues.push(`broken binary: ${link}`);
    }
    // For an app/service, a stopped unit is a problem worth surfacing.
    if (repo.install_state === "app" && existsSync(repo.path)) {
      const svc = serviceForPath(repo.path);
      if (svc && serviceActive(svc) !== "active") {
        issues.push(`service ${svc} not running`);
      }
    }
    if (issues.length) {
      problems++;
      console.log(`  ${chalk.red("✗")} ${repo.id}`);
      for (const i of issues) console.log(`      ${chalk.red(i)}`);
    } else {
      console.log(`  ${chalk.green("✓")} ${repo.id}`);
    }
  }
  console.log(
    problems === 0
      ? chalk.green(`\n  All ${repos.length} repo(s) healthy.`)
      : chalk.yellow(`\n  ${problems} of ${repos.length} repo(s) have problems.`)
  );
  if (problems > 0) process.exitCode = 1;
}

// Which indexed repo owns a filesystem path (pacman -Qo).
async function cmdOwns(target: string) {
  const expanded = target.startsWith("~")
    ? join(process.env.HOME || "", target.slice(1))
    : target;
  const abs = resolve(expanded);

  // First: is it a recorded install artifact (a COPIED or symlinked binary)?
  // Copies aren't symlinks, so path-following won't catch them — match the record.
  for (const e of db.list({})) {
    if ((JSON.parse(e.artifacts || "[]") as string[]).includes(abs)) {
      console.log(`${abs} is the installed binary of ${chalk.cyan(e.id)}`);
      return;
    }
  }

  let real = abs;
  // Follow a symlink to its target — even a BROKEN one — so dead bin symlinks can
  // still be attributed to the repo they pointed at.
  try {
    if (lstatSync(real).isSymbolicLink()) {
      real = resolve(dirname(real), readlinkSync(real));
    }
    real = realpathSync(real); // fully canonicalise if the target exists
  } catch {
    /* broken/missing target — keep the best-effort resolved path */
  }
  const match = db
    .list({})
    .filter((r) => real === r.path || real.startsWith(r.path + "/"))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (match) {
    console.log(`${real} is owned by ${chalk.cyan(match.id)}`);
  } else {
    console.log(chalk.dim(`No indexed repo owns ${real}`));
    process.exitCode = 1;
  }
}

// Print a repo's directory — the primitive for shell `cd "$(clone path <repo>)"`.
// Resolves a bare name; with no arg (or an ambiguous one) fuzzy-picks via fzf.
// ONLY the path goes to stdout; prompts/errors go to stderr so command-substitution stays clean.
async function cmdPath(target?: string) {
  let entry: RepoEntry | undefined;

  if (!target) {
    const repos = db.list({});
    if (repos.length === 0) {
      console.error("No repos indexed.");
      process.exit(1);
    }
    if (!fzfAvailable()) {
      console.error("Pass a repo name, or install fzf to pick interactively.");
      process.exit(1);
    }
    const lines = repos.map(
      (r) => `${r.id}  ${chalk.dim(`★${formatStars(r.stars)} ${r.language}`)}`
    );
    const picks = fzfPick(lines, "Enter = print this repo's path");
    if (picks.length) entry = db.get(picks[0]);
  } else {
    entry = db.get(parseGitHubUrl(target) ?? target) ?? db.get(target);
    if (!entry && !target.includes("/")) {
      const matches = db.resolveName(target);
      if (matches.length === 1) {
        entry = matches[0];
      } else if (matches.length > 1) {
        if (fzfAvailable()) {
          const picks = fzfPick(
            matches.map((m) => m.id),
            `${matches.length} match "${target}" — pick one`
          );
          if (picks.length) entry = db.get(picks[0]);
        }
        if (!entry) {
          // no fzf, or the picker was cancelled/unavailable → list candidates
          console.error(`"${target}" matches ${matches.length} repos — be specific:`);
          for (const m of matches) console.error(`  ${m.id}`);
          process.exit(1);
        }
      }
    }
  }

  if (!entry) {
    console.error(`Not found: ${target ?? "(no selection)"}`);
    process.exit(1);
  }
  if (!existsSync(entry.path)) {
    console.error(chalk.yellow(`warning: ${entry.path} no longer exists on disk`));
  }
  console.log(entry.path); // stdout — the only thing meant for `cd "$(...)"`
}

// Commits landed since the repo was installed (pacman -Qc-ish).
async function cmdChangelog(ownerRepo: string) {
  const entry = db.get(parseGitHubUrl(ownerRepo) ?? ownerRepo);
  if (!entry) {
    console.error(`Not in index: ${ownerRepo}`);
    process.exit(1);
  }
  if (!existsSync(entry.path)) {
    console.error(`Repo dir missing: ${entry.path}`);
    process.exit(1);
  }
  const range =
    entry.installed_commit && gitHasCommit(entry.path, entry.installed_commit)
      ? `${entry.installed_commit}..HEAD`
      : "-20";
  console.log(
    chalk.bold(`${entry.id} changelog`) +
      (entry.installed_commit
        ? chalk.dim(` (since install @ ${entry.installed_commit.slice(0, 7)})`)
        : chalk.dim(" (last 20 commits)"))
  );
  const out = gitLog(entry.path, range);
  console.log(out || chalk.dim("  (no new commits since install)"));
}

// Index a repo at `path`: GitHub metadata if it has a remote, else a local entry.
async function indexRepoAt(id: string, fromRemote: boolean, path: string) {
  if (fromRemote) {
    db.upsert(await buildEntry(id, manifest.has(id) ? "trending" : "manual", path));
  } else {
    db.upsert(localEntry(id, path));
  }
}

// Adopt a SINGLE git repo into the managed tree + index it.
async function adoptOne(p: string, opts: { inPlace?: boolean; dryRun?: boolean }) {
  const dry = !!opts.dryRun;
  const remote = gitRemoteUrl(p);
  const fromRemote = !!(remote && ownerRepoFromRemote(remote));
  const ownerRepo = (remote && ownerRepoFromRemote(remote)) || `local/${basename(p)}`;

  if (opts.inPlace) {
    if (dry) return console.log(chalk.dim(`would index ${ownerRepo} in place at ${p}`));
    await indexRepoAt(ownerRepo, fromRemote, p);
    return console.log(`${chalk.green("Adopted")} ${ownerRepo} ${chalk.dim(`(in place at ${p})`)}`);
  }

  const dest = join(config.baseDir, ownerRepo);
  if (resolve(p) === resolve(dest)) {
    if (dry) return console.log(chalk.dim(`${ownerRepo} already in place; would index`));
    await indexRepoAt(ownerRepo, fromRemote, dest);
    return console.log(`${chalk.green("Adopted")} ${ownerRepo} ${chalk.dim("(already in place; indexed)")}`);
  }
  if (existsSync(dest)) {
    console.error(chalk.red(`Already have ${ownerRepo} at ${dest}.`));
    console.error(chalk.dim(`  Remove/rename that first, or use --in-place to track this copy where it is.`));
    process.exit(1);
  }
  if (dry) return console.log(chalk.dim(`would move ${p} → ${dest} and index ${ownerRepo}`));
  moveDir(p, dest);
  await indexRepoAt(ownerRepo, fromRemote, dest);
  console.log(`${chalk.green("Adopted")} ${ownerRepo}`);
  console.log(`  ${chalk.dim("moved")} ${p} ${chalk.dim("->")} ${dest}`);
}

// Adopt a repo you cloned yourself (anywhere) into the managed tree + index it.
// If the target is a FOLDER OF REPOS (not itself a git repo), sort each one into
// the tree by its remote, deduping against what's already there.
// Defaults to the current directory.
async function cmdAdopt(
  targetPath = ".",
  opts: { inPlace?: boolean; dryRun?: boolean } = {}
) {
  const p = targetPath.startsWith("~")
    ? join(process.env.HOME || "", targetPath.slice(1))
    : resolve(targetPath);
  if (!existsSync(p) || !statSync(p).isDirectory()) {
    console.error(`Not a directory: ${p}`);
    process.exit(1);
  }

  // Single repo → adopt it directly.
  if (existsSync(join(p, ".git"))) {
    await adoptOne(p, opts);
    return;
  }

  // Folder of gathered repos → sort each into the tree by its remote.
  const found = findGitReposDeep(p).sort();
  if (found.length === 0) {
    console.error(`No git repos found under ${p} (and it isn't a git repo itself).`);
    process.exit(1);
  }
  const dry = !!opts.dryRun;
  console.log(
    chalk.bold(`${dry ? "[dry run] " : ""}Adopting ${found.length} repo(s) from ${p}\n`)
  );

  const seen = new Set<string>(); // in-batch collision detection (for dry-run accuracy)
  let moved = 0,
    dup = 0,
    failed = 0;

  for (const repoPath of found) {
    const remote = gitRemoteUrl(repoPath);
    const fromRemote = !!(remote && ownerRepoFromRemote(remote));
    const id = (remote && ownerRepoFromRemote(remote)) || `local/${basename(repoPath)}`;
    const dest = join(config.baseDir, id);
    const label = basename(repoPath);

    if (resolve(repoPath) === resolve(dest)) {
      console.log(`  ${chalk.dim("in place")}  ${id}`);
      if (!dry) await indexRepoAt(id, fromRemote, dest);
      continue;
    }
    if (existsSync(dest) || seen.has(dest)) {
      dup++;
      console.log(
        `  ${chalk.yellow("DUPLICATE")} ${label} → ${id} ` +
          chalk.dim(dry ? "(would move to _duplicates)" : "(→ _duplicates)")
      );
      if (!dry) {
        const dd = join(config.baseDir, "_duplicates");
        mkdirSync(dd, { recursive: true });
        try {
          moveDir(repoPath, join(dd, label));
        } catch {
          /* leave it if the dup name already exists in _duplicates */
        }
      }
      continue;
    }
    seen.add(dest);
    console.log(
      `  ${chalk.cyan("MOVE")} ${label} → ${id}` +
        (dry ? chalk.dim("  (would move + index)") : "")
    );
    if (!dry) {
      try {
        moveDir(repoPath, dest);
        await indexRepoAt(id, fromRemote, dest);
        moved++;
      } catch (e) {
        failed++;
        console.log(`    ${chalk.red("failed: " + (e as Error).message)}`);
      }
    } else {
      moved++;
    }
  }

  console.log();
  const pfx = dry ? chalk.dim("[dry run] ") : "";
  console.log(
    `${pfx}${chalk.green(`${dry ? "would adopt" : "adopted"}=${moved}`)} ` +
      `${chalk.yellow(`duplicates=${dup}`)}${failed ? ` ${chalk.red(`failed=${failed}`)}` : ""}`
  );
}

// Emit (or install) the shell completion straight from the running binary, so it
// never goes stale — re-run after any upgrade. Standard CLI pattern (gh, rustup…).
async function cmdCompletions(shell = "zsh", opts: { install?: boolean } = {}) {
  if (shell !== "zsh") {
    console.error(
      `Only zsh completions are available right now (got: ${shell}).`
    );
    process.exit(1);
  }

  let script: string;
  try {
    script = readFileSync(
      new URL("../completions/clone.zsh", import.meta.url),
      "utf-8"
    );
  } catch {
    console.error("Could not locate the bundled completion script.");
    process.exit(1);
  }

  if (!opts.install) {
    process.stdout.write(script);
    return;
  }

  // Install into the XDG user completion dir (what zsh's fpath should include).
  const dir = join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "zsh",
    "site-functions"
  );
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, "_clone");
  writeFileSync(dest, script);

  console.log(`${chalk.green("Installed")} zsh completion → ${dest}`);
  if (!process.env.fpath?.includes(dir)) {
    console.log(chalk.dim(`  Make sure this dir is in your fpath:`));
    console.log(chalk.dim(`    fpath=(${dir} $fpath)   # before \`compinit\``));
  }
  console.log(
    chalk.dim(`  Then refresh the cache:  rm -f ~/.zcompdump* && compinit   (or restart your shell)`)
  );
}

async function cmdSync(opts: { dryRun?: boolean } = {}) {
  const dry = !!opts.dryRun;
  console.log(
    chalk.bold(
      dry ? "Sync — dry run (no changes will be made)\n" : "Scanning for untracked repos...\n"
    )
  );

  const repos = findGitRepos(config.baseDir);
  let indexed = 0;
  let reorganized = 0;
  let misplaced = 0;

  // Index untracked repos already in owner/repo format.
  for (const { path: repoPath, ownerRepo } of repos) {
    if (!/^[^/]+\/[^/]+$/.test(ownerRepo)) continue;
    if (db.has(ownerRepo)) continue;

    // Consistency guard (spirit of pacman -Dk): a repo's on-disk owner/repo must
    // match its git remote. A mismatch means it's a grab-bag / misplaced repo
    // (e.g. new/claude-code whose remote is xFrye/claude-code) — sync trusts the
    // folder layout, so don't mis-index it; leave it for `clone adopt` (which
    // sorts by remote). No remote → trust the folder and index as-is.
    const remote = gitRemoteUrl(repoPath);
    const realId = remote ? ownerRepoFromRemote(remote) : null;
    if (realId && realId !== ownerRepo) {
      misplaced++;
      console.log(
        `  ${chalk.yellow("skip")}  ${ownerRepo} ` +
          chalk.dim(`(remote says ${realId} — run 'clone adopt' to place it)`)
      );
      continue;
    }

    indexed++;
    if (dry) {
      console.log(`  ${chalk.cyan("index")}     ${ownerRepo}`);
      continue;
    }
    process.stdout.write(`  [${indexed}] ${ownerRepo}... `);
    const source = manifest.has(ownerRepo) ? "trending" : "manual";
    db.upsert(await buildEntry(ownerRepo, source, repoPath));
    console.log(chalk.green("indexed"));
  }

  // Restructure flat repos at the root. `seen` tracks targets we've already
  // (planned to) place, so two dirs resolving to the same owner/repo are caught
  // as duplicates even in a dry run.
  const seen = new Set<string>();
  for (const dirName of readdirSync(config.baseDir)) {
    if (["_duplicates", "_local"].includes(dirName)) continue;
    if (dirName.startsWith(".")) continue;
    const dirPath = join(config.baseDir, dirName);
    if (!statSync(dirPath).isDirectory()) continue;
    if (!existsSync(join(dirPath, ".git"))) continue;

    const remote = gitRemoteUrl(dirPath);
    if (!remote) {
      if (dry) {
        console.log(`  ${chalk.yellow("no-remote")} ${dirName}/ → _local/`);
        reorganized++;
        continue;
      }
      const yes = await confirm(
        `  ${chalk.yellow("NO REMOTE")} ${dirName}/ — move to _local?`
      );
      if (yes) {
        const localDir = join(config.baseDir, "_local");
        mkdirSync(localDir, { recursive: true });
        renameSync(dirPath, join(localDir, dirName));
        console.log(`  ${chalk.green("Moved")} to _local/${dirName}`);
        reorganized++;
      }
      continue;
    }

    const ownerRepo = ownerRepoFromRemote(remote);
    if (!ownerRepo) continue;
    const [ghOwner, ghRepo] = ownerRepo.split("/");
    const target = join(config.baseDir, ghOwner, ghRepo);
    const duplicate = existsSync(target) || seen.has(target);

    if (duplicate) {
      reorganized++;
      console.log(
        `  ${chalk.yellow("DUPLICATE")} ${dirName}/ → ${ownerRepo} ` +
          chalk.dim(dry ? "(would move to _duplicates)" : "(already exists → _duplicates)")
      );
      if (!dry) {
        const dupDir = join(config.baseDir, "_duplicates");
        mkdirSync(dupDir, { recursive: true });
        renameSync(dirPath, join(dupDir, dirName));
      }
      continue;
    }

    seen.add(target);
    reorganized++;
    console.log(
      `  ${chalk.cyan("MOVE")} ${dirName}/ → ${ownerRepo}/` +
        (dry ? chalk.dim("  (would move + index)") : "")
    );
    if (!dry) {
      mkdirSync(join(config.baseDir, ghOwner), { recursive: true });
      renameSync(dirPath, target);
      const source = manifest.has(ownerRepo) ? "trending" : "manual";
      db.upsert(await buildEntry(ownerRepo, source, target));
      indexed++;
    }
  }

  console.log();
  const prefix = dry ? chalk.dim("[dry run] ") : "";
  if (indexed === 0 && reorganized === 0 && misplaced === 0) {
    console.log(chalk.green(`All ${db.count()} repos are tracked and organized.`));
  } else {
    if (indexed > 0)
      console.log(`${prefix}${chalk.green(`${dry ? "would index" : "Indexed"} ${indexed} repos`)}`);
    if (reorganized > 0)
      console.log(`${prefix}${chalk.green(`${dry ? "would reorganize" : "Reorganized"} ${reorganized} repos`)}`);
  }
  if (misplaced > 0) {
    console.log(
      chalk.yellow(`\n  ${misplaced} repo(s) sit under a folder that doesn't match their remote.`)
    );
    console.log(
      chalk.dim(`  Those are a grab-bag — run \`clone adopt <folder>\` to sort them by remote (with dedup).`)
    );
  }
}

async function cmdRoot() {
  console.log(config.baseDir);
}

async function cmdCreate(input: string, opts: { bare?: boolean } = {}) {
  const ownerRepo = parseGitHubUrl(input);
  if (!ownerRepo) {
    console.error(`Invalid repo format: ${input} (expected owner/repo)`);
    process.exit(1);
  }

  const [owner, repo] = ownerRepo.split("/");
  const suffix = opts.bare ? `${repo}.git` : repo;
  const dest = join(config.baseDir, owner, suffix);

  if (existsSync(dest)) {
    console.log(chalk.yellow(`Already exists: ${dest}`));
    return;
  }

  mkdirSync(dest, { recursive: true });

  const initArgs = ["init"];
  if (opts.bare) initArgs.push("--bare");

  try {
    execSync(`git ${initArgs.join(" ")}`, { cwd: dest, stdio: "pipe" });
  } catch {
    console.error(chalk.red(`Failed to init ${dest}`));
    process.exit(1);
  }

  const entry: RepoEntry = {
    id: ownerRepo,
    owner,
    repo,
    description: "",
    language: "unknown",
    stars: 0,
    topics: "[]",
    license: "",
    fork: false,
    archived: false,
    html_url: `https://github.com/${ownerRepo}`,
    cloned_at: today(),
    disk_size: getDiskSize(dest),
    source: "local",
    path: dest,
  };
  db.upsert(entry);

  console.log(`${chalk.green("Created")} ${dest}`);
}

async function cmdMissing(
  period: string | undefined,
  opts: { fetch?: boolean; json?: boolean; cache?: boolean } = {}
) {
  const VALID_PERIODS = ["daily", "weekly", "monthly"];
  const periodLower = period?.toLowerCase();
  if (periodLower && !VALID_PERIODS.includes(periodLower)) {
    console.error(
      `Invalid period: ${period}. Use daily, weekly, or monthly (or omit for all).`
    );
    process.exit(1);
  }
  if (opts.fetch && opts.json) {
    console.error("--fetch and --json can't be combined (JSON is output-only).");
    process.exit(1);
  }
  await printMissingTrending(periodLower, {
    fetch: !!opts.fetch,
    json: !!opts.json,
    noCache: opts.cache === false,
  });
}

async function cmdLog(repo?: string) {
  const history = manifest.getHistory(repo);
  if (history.length === 0) {
    console.log(repo ? `No trending history for ${repo}` : "No trending history.");
    return;
  }

  console.log(
    chalk.bold(repo ? `Trending history for ${repo}:` : "Full trending history:")
  );
  for (const h of history) {
    console.log(`  ${h.date}  ${h.period}  ${h.repo}`);
  }
}

async function cmdTrending(period: string, dryRun: boolean) {
  const dateStr = today();

  console.log(
    chalk.bold(
      `=== ${period.charAt(0).toUpperCase() + period.slice(1)} Trending ===\n`
    )
  );

  const repos = await fetchTrending(period);
  if (repos.length === 0) {
    console.log("  No repos found. GitHub may have changed their HTML.");
    return;
  }

  console.log(`  Found ${repos.length} repos\n`);

  let cloned = 0,
    skipped = 0,
    failed = 0;

  for (let i = 0; i < repos.length; i++) {
    const repo = repos[i];
    const [owner, repoName] = repo.split("/");
    const dest = join(config.baseDir, owner, repoName);

    if (existsSync(dest)) {
      console.log(
        `  [${i + 1}/${repos.length}] ${chalk.yellow("SKIP")}  ${repo} (already cloned)`
      );
      skipped++;
      manifest.log(dateStr, period, repo);
      continue;
    }

    if (dryRun) {
      console.log(
        `  [${i + 1}/${repos.length}] ${chalk.cyan("CLONE")} ${repo}`
      );
      cloned++;
      continue;
    }

    console.log(
      `  [${i + 1}/${repos.length}] ${chalk.cyan("CLONE")} ${repo}`
    );
    mkdirSync(join(config.baseDir, owner), { recursive: true });

    if (gitClone(repo, dest)) {
      console.log(`  [${i + 1}/${repos.length}] ${chalk.green("OK")}`);
      cloned++;
      manifest.log(dateStr, period, repo);

      process.stdout.write(`  ${chalk.dim("Indexing...")} `);
      const entry = await buildEntry(repo, "trending", dest);
      db.upsert(entry);
      console.log(chalk.green("ok"));
    } else {
      console.log(`  [${i + 1}/${repos.length}] ${chalk.red("FAILED")}`);
      failed++;
    }
    console.log();
  }

  console.log();
  if (dryRun) {
    console.log(chalk.dim(`  [DRY RUN] would clone=${cloned} skip=${skipped}`));
  } else {
    console.log(
      `  Done: ${chalk.green(`cloned=${cloned}`)} ${chalk.yellow(`skipped=${skipped}`)} ${chalk.red(`failed=${failed}`)}`
    );
  }
  console.log();
}

// --- CLI ---

const program = new Command();

program
  .name("clone")
  .version(pkg.version)
  .description(
    "Git repository package manager — clone, index, search, and organize GitHub repos."
  )
  .addHelpText(
    "after",
    `
Examples:
  Find
    clone search tui                 search your local index
    clone search tui --remote        search all of GitHub (--language/--stars/--sort)
    clone search tui -r -n 500 -i    fuzzy-pick from a big list (fzf) and clone the picks
    clone search tui -r -q | fzf     or pipe the quiet owner/repo list anywhere
    clone info owner/repo --remote    repo details (un-cloned ok)
    clone trending                   GitHub trending (read-only)

  Download (no build)
    clone owner/repo                 clone + index the source
    clone owner/repo --deep          full history (default is shallow)

  Build + install onto PATH
    clone install owner/repo         detect build -> review -> build -> link binary
    clone install owner/repo -y      skip the review prompt
    clone install .                  build a repo you're inside
    clone uninstall owner/repo       unlink the binary, keep the source

  Look around
    clone list                       ● installed  ◐ built  ▣ app/service  · cloned
    clone list --installed           only what you've built
    clone stats                      counts + lifecycle health

  Keep current
    clone update                     pull all; rebuild changed installs
    clone outdated                   what's behind upstream (no fetch)
    clone changelog owner/repo       commits since you installed it

  Bring in repos you cloned by hand
    clone sync                       repos git-cloned INTO the root -> organize + index
    clone adopt ~/path/foo           a repo cloned ANYWHERE else -> move in + index

  Tidy up
    clone remove owner/repo          delete repo + binary + index entry (-s also removes deps)
    clone orphans                    deps nothing needs anymore
    clone clean                      prune broken symlinks / dangling entries

Model: 'clone' = download (pacman -S source); 'clone install' = build-from-source (paru).
Run 'clone <command> --help' for a command's flags.
`
  );

// Direct clone: clone <owner/repo> or clone <url>
program
  .argument("[target]", "owner/repo or GitHub URL to clone")
  .option("--shallow", "Shallow clone (depth 1) — this is the default")
  .option("--deep", "Full clone (no --depth)")
  .option("--bare", "Bare clone")
  .option("-b, --branch <branch>", "Clone specific branch (implies --single-branch)")
  .option("-p, --ssh", "Clone via SSH instead of HTTPS")
  .option("--no-recursive", "Don't recurse submodules")
  .option("--partial <mode>", "Partial clone: blobless or treeless")
  .action(async (target, opts) => {
    if (!target) {
      program.help();
      return;
    }
    await cmdCloneRepo(target, {
      shallow: opts.shallow,
      deep: opts.deep,
      bare: opts.bare,
      branch: opts.branch,
      ssh: opts.ssh,
      noRecursive: !opts.recursive,
      partial: opts.partial,
    });
  });

program
  .command("search <query>")
  .alias("s")
  .description("Search local index, or all of GitHub with --remote")
  .option("-l, --long", "Verbose card view with full descriptions")
  .option("-r, --remote", "Search ALL of GitHub, not just cloned repos (like pacman -Ss)")
  .option("--language <lang>", "With --remote: filter by language")
  .option("--topic <topic>", "With --remote: filter by topic")
  .option("--user <user>", "With --remote: restrict to an owner/org")
  .option("--stars <range>", "With --remote: star filter, e.g. '>1000' or '100..500'")
  .option("--sort <field>", "With --remote: stars | forks | updated | best-match")
  .option("-n, --limit <n>", "With --remote: max results, paginated (default 20, max 1000 — GitHub's ceiling)")
  .option("-q, --quiet", "One owner/repo per line (pipe to fzf/grep/less)")
  .option("-i, --interactive", "Fuzzy-pick from results with fzf, then clone the selection")
  .action(cmdSearch);

program
  .command("info <repo>")
  .alias("i")
  .description("Detailed info on a repo (like pacman -Qi); --remote for an un-cloned repo (-Si)")
  .option("-r, --remote", "Fetch info from GitHub even if not cloned (like pacman -Si)")
  .action((repo, opts) => cmdInfo(repo, { remote: opts.remote }));

program
  .command("browse <repo>")
  .alias("open")
  .description("Open the repo's GitHub page in the default browser")
  .action(cmdBrowse);

program
  .command("list")
  .alias("ls")
  .description("List all repos with optional filters")
  .option("--language <lang>", "Filter by programming language")
  .option("--owner <owner>", "Filter by GitHub owner")
  .option("--source <source>", "Filter by source (manual/trending)")
  .option("--installed", "Only repos you've built or installed")
  .option(
    "--trending [period]",
    "Only trending-sourced repos (groups by period); optionally filter: daily|weekly|monthly"
  )
  .option(
    "--missing",
    "With --trending: fetch live GitHub Trending and show repos not yet cloned"
  )
  .option("--fetch", "With --missing: clone the missing repos immediately")
  .option("--json", "With --missing: emit JSON (output-only; disables --fetch)")
  .option("--no-cache", "With --missing: bypass the 15-minute trending cache")
  .option("--recent [days]", "Recently cloned (default: 7)")
  .option("-e, --exact <query>", "Exact match on repo or owner/repo name")
  .option("-p, --full-path", "Print full paths instead of table")
  .option("-l, --long", "Verbose card view with full descriptions")
  .action(cmdList);

program
  .command("stats")
  .alias("st")
  .description("Summary stats (counts, languages, top starred)")
  .action(cmdStats);

program
  .command("install <repo>")
  .alias("in")
  .description(
    "Clone (if needed) or build a local path ('.'), build from source, link binaries onto PATH (paru -S/-B)"
  )
  .option("--build-only", "Build but do not put binaries on PATH")
  .option("-f, --force", "Rebuild even if already installed at the current commit")
  .option("--needed", "Skip if already installed at the current commit")
  .option("-y, --yes", "Skip the review prompt (run the build unattended)")
  .option("--asdeps", "Record install reason as 'dependency' rather than 'explicit'")
  .option("--keep-build", "Keep the build worktree (incremental rebuilds); symlink instead of copy")
  .option("--ask", "Interactively choose build commands + binary; offer to save a .clone-recipe")
  .action((repo, opts) =>
    cmdInstall(repo, {
      buildOnly: opts.buildOnly,
      force: opts.force,
      needed: opts.needed,
      yes: opts.yes,
      asDeps: opts.asdeps,
      keepBuild: opts.keepBuild,
      ask: opts.ask,
    })
  );

program
  .command("uninstall <repo>")
  .alias("un")
  .description("Unlink built binaries from PATH and keep the source (revert to cloned)")
  .action(cmdUninstall);

program
  .command("remove <repo>")
  .alias("rm")
  .description("Delete a repo, its binaries, and its index entry (like pacman -R)")
  .option("--dry-run", "Show what would be removed without removing")
  .option("-f, --force", "Skip the uncommitted-changes safety prompt")
  .option("-s, --recursive", "Also remove dependencies pulled in only by this repo (like -Rs)")
  .action((repo, opts) =>
    cmdRemove(repo, {
      dryRun: opts.dryRun,
      force: opts.force,
      recursive: opts.recursive,
    })
  );

program
  .command("root")
  .description("Show the repos root directory")
  .action(cmdRoot);

program
  .command("create <repo>")
  .description("Create a new local repository under the root")
  .option("--bare", "Create a bare repository")
  .action((repo, opts) => cmdCreate(repo, { bare: opts.bare }));

program
  .command("update [repo]")
  .alias("up")
  .description("Pull latest changes (one or all); rebuild+relink installed repos that changed")
  .option("--no-rebuild", "Pull only — don't rebuild installed repos that changed")
  .option("--ignore <repos>", "Comma-separated owner/repo to skip (adds to config ignore list)")
  .action((repo, opts) =>
    cmdUpdate(repo, { rebuild: opts.rebuild, ignore: opts.ignore })
  );

program
  .command("outdated")
  .alias("out")
  .description("Show repos with upstream commits (git ls-remote, no fetch; like pacman -Qu)")
  .option("-a, --all", "Check every cloned repo (default: only installed/built)")
  .option("-u, --update", "Update (and rebuild) all outdated repos")
  .option("--ignore <repos>", "Comma-separated owner/repo to skip (adds to config ignore list)")
  .action((opts) =>
    cmdOutdated({ all: opts.all, update: opts.update, ignore: opts.ignore })
  );

program
  .command("reason <repo>")
  .description("Set install reason: --explicit (keep) or --asdeps (orphan-eligible) (pacman -D)")
  .option("-e, --explicit", "Mark as explicitly installed")
  .option("--asdeps", "Mark as installed-as-dependency")
  .action((repo, opts) =>
    cmdReason(repo, { explicit: opts.explicit, asDeps: opts.asdeps })
  );

program
  .command("check [repo]")
  .description("Verify installed repos are intact: dir, binaries, git health (like pacman -Qk)")
  .option("-a, --all", "Check every cloned repo (default: only installed/built)")
  .option("--source", "Audit the source tree for purity: build artifacts, in-place apps/services")
  .action((repo, opts) => cmdCheck(repo, { all: opts.all, source: opts.source }));

program
  .command("owns <path>")
  .description("Show which indexed repo owns a filesystem path (like pacman -Qo)")
  .action(cmdOwns);

program
  .command("path [repo]")
  .description("Print a repo's directory — use as: cd \"$(clone path <repo>)\"; no arg = fzf-pick")
  .action(cmdPath);

program
  .command("changelog <repo>")
  .alias("cl")
  .description("Show commits landed upstream since the repo was installed (like pacman -Qc)")
  .action(cmdChangelog);

program
  .command("orphans")
  .description("List repos installed as dependencies that nothing requires anymore (-Qdt)")
  .option("--remove", "Remove the orphaned dependency repos")
  .option("-y, --yes", "Skip the confirmation prompt")
  .action((opts) => cmdOrphans({ remove: opts.remove, yes: opts.yes }));

program
  .command("clean")
  .description("Prune broken bin symlinks, dangling index entries, caches (like pacman -Sc)")
  .option("--builds", "Also remove build-artifact dirs (target/build/node_modules/...) from non-installed repos")
  .option("--cache", "Also clear the trending HTML cache")
  .option("--duplicates", "Also delete the redundant copies set aside in _duplicates/")
  .option("--dry-run", "Show what would be cleaned without removing")
  .option("-y, --yes", "Skip the confirmation prompt")
  .action((opts) =>
    cmdClean({
      builds: opts.builds,
      cache: opts.cache,
      duplicates: opts.duplicates,
      dryRun: opts.dryRun,
      yes: opts.yes,
    })
  );

program
  .command("reindex")
  .alias("ri")
  .description("Rebuild index from disk")
  .action(cmdReindex);

program
  .command("sync")
  .description("Detect, restructure and index untracked repos (inside the repos root)")
  .option("--dry-run", "Show what sync would move/index without changing anything")
  .action((opts) => cmdSync({ dryRun: opts.dryRun }));

program
  .command("adopt [path]")
  .description("Adopt a repo — or a whole FOLDER of repos — into the tree by their remotes (default: current dir)")
  .option("--in-place", "Index it where it sits instead of moving it into the repos root")
  .option("--app", "Track it as an app/service that runs in place (e.g. under build/); reindex-safe")
  .option("--with-source", "With --app: also clone a pristine source mirror into source/owner/repo")
  .option("--dry-run", "Show what would be adopted/deduped without moving anything")
  .action((path, opts) =>
    opts.app
      ? registerApp(path, { dryRun: opts.dryRun, withSource: opts.withSource })
      : cmdAdopt(path, { inPlace: opts.inPlace, dryRun: opts.dryRun })
  );

program
  .command("completions [shell]")
  .description("Print shell completion (zsh); --install writes it to your site-functions dir")
  .option("--install", "Write it to ~/.local/share/zsh/site-functions/_clone")
  .action((shell, opts) => cmdCompletions(shell, { install: opts.install }));

program
  .command("log [repo]")
  .description("Show trending history")
  .action(cmdLog);

program
  .command("missing [period]")
  .alias("m")
  .description(
    "Show GitHub Trending repos not yet cloned (optionally clone them). Period: daily|weekly|monthly."
  )
  .option("-f, --fetch", "Clone the missing repos immediately")
  .option("-j, --json", "Emit JSON (output-only; disables --fetch)")
  .option("--no-cache", "Bypass the 15-minute trending cache")
  .action(cmdMissing);

program
  .command("trending [language]")
  .alias("t")
  .description(
    "View GitHub Trending repos (read-only). Optionally filter by programming [language]."
  )
  .option("--period <period>", "daily | weekly | monthly", "daily")
  .option("-a, --all", "Show all periods (daily, weekly, monthly)")
  .option("-s, --spoken <code>", "Spoken language code, e.g. en, zh, es")
  .option("-n, --limit <n>", "Limit number of repos shown")
  .option("-j, --json", "Emit JSON instead of a table")
  .option("--no-cache", "Bypass the 15-minute trending cache")
  .action(cmdViewTrending);

for (const period of ["daily", "weekly", "monthly"]) {
  program
    .command(period)
    .description(`Clone ${period} trending repos`)
    .option("--dry", "Show what would be cloned without cloning")
    .action(async (opts) => {
      if (opts.dry) console.log(chalk.yellow("[DRY RUN MODE]\n"));
      await cmdTrending(period, !!opts.dry);
    });
}

program
  .command("all")
  .description("Clone trending for all periods")
  .option("--dry", "Show what would be cloned without cloning")
  .action(async (opts) => {
    if (opts.dry) console.log(chalk.yellow("[DRY RUN MODE]\n"));
    for (const period of ["daily", "weekly", "monthly"]) {
      await cmdTrending(period, !!opts.dry);
    }
  });

program.parse();
