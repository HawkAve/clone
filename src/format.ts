import chalk from "chalk";
import type { RepoEntry } from "./db.js";
import type { TrendingRepo, RemoteRepo } from "./github.js";

const PERIOD_LABEL: Record<string, string> = {
  daily: "today",
  weekly: "this week",
  monthly: "this month",
};

// A few well-known language colours (GitHub-ish) for a touch of polish.
const LANG_COLOR: Record<string, (s: string) => string> = {
  python: (s) => chalk.hex("#3572A5")(s),
  javascript: (s) => chalk.hex("#F1E05A")(s),
  typescript: (s) => chalk.hex("#3178C6")(s),
  rust: (s) => chalk.hex("#DEA584")(s),
  go: (s) => chalk.hex("#00ADD8")(s),
  c: (s) => chalk.hex("#555555")(s),
  "c++": (s) => chalk.hex("#F34B7D")(s),
  java: (s) => chalk.hex("#B07219")(s),
  ruby: (s) => chalk.hex("#701516")(s),
  shell: (s) => chalk.hex("#89E051")(s),
  swift: (s) => chalk.hex("#F05138")(s),
  kotlin: (s) => chalk.hex("#A97BFF")(s),
  html: (s) => chalk.hex("#E34C26")(s),
  css: (s) => chalk.hex("#563D7C")(s),
};

function colorLang(language: string): string {
  const fn = LANG_COLOR[language.toLowerCase()];
  return fn ? fn(language) : chalk.gray(language);
}

// Install/build lifecycle markers, shared by the table and card views.
const STATE_GLYPH: Record<string, { g: string; c: (s: string) => string }> = {
  installed: { g: "●", c: chalk.green },
  built: { g: "◐", c: chalk.cyan },
  app: { g: "▣", c: chalk.magenta },
  failed: { g: "✗", c: chalk.red },
};

function stateGlyph(state?: string): string {
  const m = STATE_GLYPH[state || "cloned"];
  return m ? m.c(m.g) : chalk.dim("·");
}

// Word-wrap plain text to a max width, returning the lines.
function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (!line) {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function printTrending(
  repos: TrendingRepo[],
  opts: { period?: string; cloned?: Set<string>; title?: string } = {}
) {
  if (repos.length === 0) {
    console.log(chalk.dim("  No trending repos found for that filter."));
    return;
  }

  const period = opts.period || "daily";
  const periodLabel = PERIOD_LABEL[period] || period;
  const cloned = opts.cloned ?? new Set<string>();
  if (opts.title) {
    console.log();
    console.log(chalk.bold(opts.title));
  }

  const indent = "      "; // aligns under the repo name
  const termWidth = Math.min(process.stdout.columns || 80, 100);
  const wrapWidth = Math.max(40, termWidth - indent.length);

  repos.forEach((r, i) => {
    const isCloned = cloned.has(r.repo.toLowerCase());
    const rank = chalk.dim(`${String(i + 1).padStart(2)}.`);
    const dot = isCloned ? chalk.green("●") : chalk.dim("○");
    const name = isCloned ? chalk.green.bold(r.repo) : chalk.cyan.bold(r.repo);
    const badge = isCloned ? chalk.dim(" (cloned)") : "";

    console.log();
    console.log(`  ${rank} ${dot} ${name}${badge}`);

    // meta line: stars · gain · language
    const stars = chalk.yellow(`★ ${formatStars(r.stars)}`);
    const gain =
      r.starsInPeriod > 0
        ? chalk.green(`▲ ${formatNumber(r.starsInPeriod)} ${periodLabel}`)
        : chalk.dim("· no change");
    const lang = r.language && r.language !== "unknown" ? colorLang(r.language) : "";
    const meta = [stars, gain, lang].filter(Boolean).join(chalk.dim("  ·  "));
    console.log(`${indent}${meta}`);

    if (r.description) {
      for (const ln of wrapText(r.description, wrapWidth)) {
        console.log(`${indent}${chalk.reset(ln)}`);
      }
    }
  });

  if (cloned.size > 0) {
    console.log();
    console.log(chalk.dim(`  ● already cloned   ○ not yet cloned`));
  }
}

export function formatStars(stars: number): string {
  if (stars >= 1000) {
    return `${Math.floor(stars / 1000)}.${Math.floor((stars % 1000) / 100)}k`;
  }
  return String(stars);
}

export function formatNumber(n: number): string {
  return n.toLocaleString();
}

export function printRepoTable(
  repos: RepoEntry[],
  columns: ("state" | "id" | "language" | "stars" | "source" | "description")[] = [
    "state",
    "id",
    "language",
    "stars",
    "source",
  ]
) {
  if (repos.length === 0) {
    console.log("No repos match the filter.");
    return;
  }

  console.log(chalk.bold(`${repos.length} repos:\n`));

  const header: Record<string, string> = {
    state: "",
    id: "REPO",
    language: "LANGUAGE",
    stars: "STARS",
    source: "SOURCE",
    description: "DESCRIPTION",
  };
  const widths: Record<string, number> = {
    state: 2,
    id: 42,
    language: 16,
    stars: 10,
    source: 10,
    description: 50,
  };

  // Pad to width but always guarantee at least one trailing space (truncate if needed).
  const fit = (s: string, w: number) =>
    (s.length >= w ? s.slice(0, w - 1) + " " : s.padEnd(w));

  const headerLine = columns.map((c) => fit(header[c], widths[c])).join("");
  console.log(`  ${chalk.dim(headerLine)}`);

  let anyInstalled = false;
  for (const repo of repos) {
    const line = columns
      .map((c) => {
        switch (c) {
          case "state": {
            const s = repo.install_state || "cloned";
            if (s === "installed" || s === "built" || s === "app") anyInstalled = true;
            return `${stateGlyph(s)} `; // glyph (1) + space = width 2
          }
          case "id": {
            const cell = fit(repo.id, widths.id);
            return repo.source === "trending"
              ? chalk.cyan(cell)
              : chalk.white(cell);
          }
          case "language":
            return chalk.gray(fit(repo.language, widths.language));
          case "stars":
            return chalk.yellow(fit(`★ ${formatStars(repo.stars)}`, widths.stars));
          case "source":
            return chalk.dim(fit(repo.source, widths.source));
          case "description":
            return chalk.dim(fit(repo.description || "", widths.description));
          default:
            return "";
        }
      })
      .join("");
    console.log(`  ${line}`);
  }

  if (anyInstalled && columns.includes("state")) {
    console.log(
      `\n  ${chalk.green("● installed")}   ${chalk.cyan("◐ built")}   ${chalk.magenta("▣ app/service")}   ${chalk.dim("· cloned")}`
    );
  }
}

// Verbose card view: full, word-wrapped descriptions — like `clone trending`.
export function printRepoDetailed(repos: RepoEntry[]) {
  if (repos.length === 0) {
    console.log("No repos match the filter.");
    return;
  }

  console.log(chalk.bold(`${repos.length} repos:`));

  const indent = "      ";
  const termWidth = Math.min(process.stdout.columns || 80, 100);
  const wrapWidth = Math.max(40, termWidth - indent.length);

  repos.forEach((repo, i) => {
    const rank = chalk.dim(`${String(i + 1).padStart(2)}.`);
    const name = chalk.cyan.bold(repo.id);
    console.log();
    console.log(`  ${rank} ${name}`);

    const stars = chalk.yellow(`★ ${formatStars(repo.stars)}`);
    const lang =
      repo.language && repo.language !== "unknown" ? colorLang(repo.language) : "";
    const source =
      repo.source === "trending"
        ? chalk.magenta("trending")
        : chalk.dim("manual");
    const st = repo.install_state || "cloned";
    const stateBadge =
      st === "installed" || st === "built" || st === "failed"
        ? STATE_GLYPH[st].c(`${STATE_GLYPH[st].g} ${st}`)
        : "";
    const meta = [stars, lang, source, stateBadge]
      .filter(Boolean)
      .join(chalk.dim("  ·  "));
    console.log(`${indent}${meta}`);

    if (repo.description) {
      for (const ln of wrapText(repo.description, wrapWidth)) {
        console.log(`${indent}${chalk.reset(ln)}`);
      }
    }

    const topics: string[] = JSON.parse(repo.topics || "[]");
    if (topics.length > 0) {
      const tagStr = topics.map((t) => `#${t}`).join(" ");
      for (const ln of wrapText(tagStr, wrapWidth)) {
        console.log(`${indent}${chalk.dim(ln)}`);
      }
    }
  });
}

// Results from a GitHub-wide search (`pacman -Ss` style). Marks repos you
// already have cloned with an [installed] tag.
export function printRemoteRepos(
  repos: RemoteRepo[],
  opts: { installed?: Set<string>; total?: number; long?: boolean } = {}
) {
  if (repos.length === 0) {
    console.log(chalk.dim("  No repositories found on GitHub for that query."));
    return;
  }

  const installed = opts.installed ?? new Set<string>();
  const countNote =
    opts.total && opts.total > repos.length
      ? chalk.dim(` (showing ${repos.length} of ${formatNumber(opts.total)})`)
      : "";
  console.log(chalk.bold(`${repos.length} repositories`) + countNote + ":");

  const indent = "      ";
  const termWidth = Math.min(process.stdout.columns || 80, 100);
  const wrapWidth = Math.max(40, termWidth - indent.length);

  repos.forEach((r, i) => {
    const isInstalled = installed.has(r.repo.toLowerCase());
    const rank = chalk.dim(`${String(i + 1).padStart(2)}.`);
    const name = isInstalled
      ? chalk.green.bold(r.repo)
      : chalk.cyan.bold(r.repo);
    const tags = [
      isInstalled ? chalk.green("[cloned]") : "",
      r.archived ? chalk.yellow("[archived]") : "",
      r.fork ? chalk.dim("[fork]") : "",
    ]
      .filter(Boolean)
      .join(" ");

    console.log();
    console.log(`  ${rank} ${name}${tags ? " " + tags : ""}`);

    const stars = chalk.yellow(`★ ${formatStars(r.stars)}`);
    const forks = chalk.dim(`⑂ ${formatStars(r.forks)}`);
    const lang =
      r.language && r.language !== "unknown" ? colorLang(r.language) : "";
    const lic = r.license ? chalk.dim(r.license) : "";
    const updated = r.updatedAt
      ? chalk.dim(`updated ${r.updatedAt.slice(0, 10)}`)
      : "";
    const meta = [stars, forks, lang, lic, updated]
      .filter(Boolean)
      .join(chalk.dim("  ·  "));
    console.log(`${indent}${meta}`);

    if (r.description) {
      for (const ln of wrapText(r.description, wrapWidth)) {
        console.log(`${indent}${chalk.reset(ln)}`);
      }
    }
    if (opts.long && r.topics.length > 0) {
      const tagStr = r.topics.map((t) => `#${t}`).join(" ");
      for (const ln of wrapText(tagStr, wrapWidth)) {
        console.log(`${indent}${chalk.dim(ln)}`);
      }
    }
  });

  if (installed.size > 0 || repos.some((r) => !installed.has(r.repo.toLowerCase()))) {
    console.log();
    console.log(
      chalk.dim(`  Install with: `) + chalk.cyan(`clone <owner/repo>`)
    );
  }
}

export function printRepoInfo(repo: RepoEntry) {
  const topics: string[] = JSON.parse(repo.topics || "[]");
  const artifacts: string[] = JSON.parse(repo.artifacts || "[]");
  const state = repo.install_state || "cloned";
  const termWidth = Math.min(process.stdout.columns || 80, 100);
  const wrapWidth = Math.max(40, termWidth - 4);
  const indent = "  ";

  // Header: status glyph + repo name, then a thin rule.
  console.log();
  console.log(`${indent}${stateGlyph(state)} ${chalk.cyan.bold(repo.id)}`);
  console.log(indent + chalk.dim("─".repeat(Math.min(repo.id.length + 2, wrapWidth))));

  // Meta line: repo-intrinsic facts only — stars · language · license · flags.
  const meta = [
    chalk.yellow(`★ ${formatStars(repo.stars)}`),
    repo.language && repo.language !== "unknown" ? colorLang(repo.language) : "",
    repo.license ? chalk.dim(repo.license) : "",
    repo.fork ? chalk.yellow("⑂ fork") : "",
    repo.archived ? chalk.yellow("⚑ archived") : "",
  ]
    .filter(Boolean)
    .join(chalk.dim("  ·  "));
  console.log(`${indent}${meta}`);

  // Description (word-wrapped).
  if (repo.description) {
    console.log();
    for (const ln of wrapText(repo.description, wrapWidth)) {
      console.log(`${indent}${chalk.reset(ln)}`);
    }
  }

  // Topics as #tags (wrap on plain text, then dim).
  if (topics.length) {
    console.log();
    for (const ln of wrapText(topics.map((t) => `#${t}`).join(" "), wrapWidth)) {
      console.log(`${indent}${chalk.cyan.dim(ln)}`);
    }
  }

  // Aligned details block.
  console.log();
  const row = (label: string, value: string) =>
    console.log(`${indent}${chalk.dim((label + "  ").padEnd(11))}${value}`);

  const stateColored = STATE_GLYPH[state]
    ? STATE_GLYPH[state].c(state)
    : chalk.dim(state);
  row("state", `${stateGlyph(state)} ${stateColored}`);
  if (repo.install_reason) row("reason", repo.install_reason);
  if (repo.build_system) row("build", repo.build_system);
  if (repo.installed_commit) {
    row(
      "installed",
      chalk.yellow(repo.installed_commit.slice(0, 7)) +
        (repo.installed_at ? chalk.dim(`  ${repo.installed_at.slice(0, 10)}`) : "")
    );
  }
  if (artifacts.length) {
    row("binaries", artifacts.map((a) => chalk.green(a)).join(`\n${indent}${" ".repeat(11)}`));
  }
  row("source", repo.source === "trending" ? chalk.magenta("trending") : repo.source);
  row("cloned", repo.cloned_at);
  row("disk", repo.disk_size);
  row("url", chalk.dim(repo.html_url));
  row("path", chalk.dim(repo.path));
  console.log();
}

// Info for a repo from the GitHub API (pacman -Si) — may not be cloned locally.
export function printRemoteInfo(
  ownerRepo: string,
  meta: {
    description: string;
    language: string;
    stars: number;
    topics: string[];
    license: string;
    fork: boolean;
    archived: boolean;
    html_url: string;
  },
  localState?: string
) {
  const termWidth = Math.min(process.stdout.columns || 80, 100);
  const wrapWidth = Math.max(40, termWidth - 4);
  const indent = "  ";

  console.log();
  console.log(`${indent}${chalk.cyan.bold(ownerRepo)}  ${chalk.dim("(remote)")}`);
  console.log(indent + chalk.dim("─".repeat(Math.min(ownerRepo.length + 9, wrapWidth))));

  const metaLine = [
    chalk.yellow(`★ ${formatStars(meta.stars)}`),
    meta.language && meta.language !== "unknown" ? colorLang(meta.language) : "",
    meta.license ? chalk.dim(meta.license) : "",
    meta.fork ? chalk.yellow("⑂ fork") : "",
    meta.archived ? chalk.yellow("⚑ archived") : "",
  ]
    .filter(Boolean)
    .join(chalk.dim("  ·  "));
  console.log(`${indent}${metaLine}`);

  if (meta.description) {
    console.log();
    for (const ln of wrapText(meta.description, wrapWidth)) {
      console.log(`${indent}${chalk.reset(ln)}`);
    }
  }
  if (meta.topics.length) {
    console.log();
    for (const ln of wrapText(meta.topics.map((t) => `#${t}`).join(" "), wrapWidth)) {
      console.log(`${indent}${chalk.cyan.dim(ln)}`);
    }
  }

  console.log();
  const row = (label: string, value: string) =>
    console.log(`${indent}${chalk.dim((label + "  ").padEnd(11))}${value}`);
  row("url", chalk.dim(meta.html_url));
  const local = !localState
    ? chalk.dim("not cloned")
    : localState === "installed"
      ? chalk.green("● installed")
      : localState === "built"
        ? chalk.cyan("◐ built")
        : chalk.dim("· cloned");
  row("local", local);
  console.log();
}

export function printStats(stats: {
  total: number;
  totalDisk: string;
  bySource: Record<string, number>;
  byState: Record<string, number>;
  orphans: number;
  byLanguage: { language: string; count: number }[];
  byOwner: { owner: string; count: number }[];
  topStarred: RepoEntry[];
}) {
  console.log();
  console.log(`  ${chalk.bold("Clone Stats")}`);
  console.log();
  console.log(`  ${chalk.dim("Total repos:")}     ${stats.total}`);
  console.log(`  ${chalk.dim("Disk usage:")}      ${stats.totalDisk}`);
  console.log();

  // Lifecycle health (paru -Ps).
  const st = stats.byState;
  console.log(`  ${chalk.dim("Lifecycle:")}`);
  console.log(
    `    ${chalk.green(`● ${st.installed || 0} installed`)}   ` +
      `${chalk.cyan(`◐ ${st.built || 0} built`)}   ` +
      `${chalk.dim(`· ${st.cloned || 0} cloned`)}` +
      (st.failed ? `   ${chalk.red(`✗ ${st.failed} failed`)}` : "")
  );
  if (stats.orphans > 0) {
    console.log(`    ${chalk.yellow(`⚠ ${stats.orphans} orphaned dependency(s)`)} ${chalk.dim("(clone orphans)")}`);
  }
  console.log();

  console.log(`  ${chalk.dim("By source:")}`);
  for (const [source, count] of Object.entries(stats.bySource)) {
    console.log(`    ${source}: ${count}`);
  }
  console.log();

  console.log(`  ${chalk.dim("Top languages:")}`);
  for (const { language, count } of stats.byLanguage) {
    console.log(`    ${language}: ${count}`);
  }
  console.log();

  console.log(`  ${chalk.dim("Top owners:")}`);
  for (const { owner, count } of stats.byOwner) {
    console.log(`    ${owner}: ${count}`);
  }
  console.log();

  console.log(`  ${chalk.dim("Most starred:")}`);
  for (const repo of stats.topStarred) {
    console.log(`    ★ ${formatNumber(repo.stars)}  ${repo.id}`);
  }
  console.log();
}
