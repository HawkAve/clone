import { Octokit } from "octokit";

import { execSync } from "child_process";

let octokit: Octokit | null = null;

function getGhToken(): string | undefined {
  // Try env vars first
  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (envToken) return envToken;

  // Fall back to gh CLI token
  try {
    return execSync("gh auth token 2>/dev/null", { encoding: "utf-8" }).trim();
  } catch {
    return undefined;
  }
}

function getOctokit(): Octokit {
  if (!octokit) {
    const auth = getGhToken();
    octokit = new Octokit(auth ? { auth } : {});
  }
  return octokit;
}

export interface RepoMeta {
  description: string;
  language: string;
  stars: number;
  topics: string[];
  license: string;
  fork: boolean;
  archived: boolean;
  html_url: string;
}

export async function fetchRepoMeta(
  owner: string,
  repo: string
): Promise<RepoMeta> {
  try {
    const { data } = await getOctokit().rest.repos.get({ owner, repo });
    return {
      description: data.description || "",
      language: data.language || "unknown",
      stars: data.stargazers_count,
      topics: data.topics || [],
      license: data.license?.spdx_id || "",
      fork: data.fork,
      archived: data.archived,
      html_url: data.html_url,
    };
  } catch {
    return {
      description: "",
      language: "unknown",
      stars: 0,
      topics: [],
      license: "",
      fork: false,
      archived: false,
      html_url: `https://github.com/${owner}/${repo}`,
    };
  }
}

export interface RemoteRepo {
  repo: string; // owner/repo
  description: string;
  language: string;
  stars: number;
  forks: number;
  topics: string[];
  license: string;
  archived: boolean;
  fork: boolean;
  updatedAt: string;
  url: string;
}

export interface RemoteSearchOptions {
  language?: string;
  topic?: string;
  user?: string;
  stars?: string; // raw qualifier value, e.g. ">1000", "100..500"
  sort?: "stars" | "forks" | "updated" | "best-match";
  order?: "asc" | "desc";
  limit?: number;
}

// GitHub's Search API only ever returns the first 1000 results for any query.
const GITHUB_SEARCH_MAX = 1000;
const SEARCH_PER_PAGE = 100; // GitHub's per_page maximum

function mapRemoteRepo(d: any): RemoteRepo {
  return {
    repo: d.full_name,
    description: d.description || "",
    language: d.language || "unknown",
    stars: d.stargazers_count,
    forks: d.forks_count,
    topics: d.topics || [],
    license: d.license?.spdx_id || "",
    archived: d.archived,
    fork: d.fork,
    updatedAt: d.pushed_at || d.updated_at || "",
    url: d.html_url,
  };
}

// Search ALL of GitHub (the equivalent of `pacman -Ss`).
// The query may include raw GitHub qualifiers; the option flags append more.
// Paginates (100/page) until `limit` results are collected or GitHub runs out.
export async function searchRemoteRepos(
  query: string,
  opts: RemoteSearchOptions = {}
): Promise<{ items: RemoteRepo[]; total: number }> {
  const qualifiers: string[] = [query.trim()];
  if (opts.language) qualifiers.push(`language:${opts.language}`);
  if (opts.topic) qualifiers.push(`topic:${opts.topic}`);
  if (opts.user) qualifiers.push(`user:${opts.user}`);
  if (opts.stars) qualifiers.push(`stars:${opts.stars}`);
  const q = qualifiers.filter(Boolean).join(" ");

  const want = Math.min(Math.max(opts.limit ?? 20, 1), GITHUB_SEARCH_MAX);
  const sort = opts.sort && opts.sort !== "best-match" ? opts.sort : undefined;
  const octokit = getOctokit();

  const items: RemoteRepo[] = [];
  let total = 0;
  const lastPage = Math.ceil(want / SEARCH_PER_PAGE);

  for (let page = 1; page <= lastPage; page++) {
    const per_page = Math.min(SEARCH_PER_PAGE, want - items.length);
    const { data } = await octokit.rest.search.repos({
      q,
      sort,
      order: opts.order ?? "desc",
      per_page,
      page,
    });
    total = data.total_count;

    for (const d of data.items) {
      items.push(mapRemoteRepo(d));
      if (items.length >= want) break;
    }
    // Stop when we've got enough, or GitHub returned a short/empty page (no more).
    if (items.length >= want || data.items.length < per_page) break;
  }

  return { items, total };
}

export async function fetchTrending(
  period: string
): Promise<string[]> {
  const url = `https://github.com/trending?since=${period}`;
  const res = await fetch(url);
  const html = await res.text();

  const repoPattern = /href="\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)"/g;
  const exclude =
    /^(apps|trending|sponsors|github\.com|githubassets|site|login|signup|settings|orgs|collections|features|enterprise|pricing|marketplace|explore|about|security|docs\.|community|copilot|advanced-security|accessibility|github-code-search|github\.blog|browser)\//;

  const repos = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = repoPattern.exec(html)) !== null) {
    const repo = match[1];
    if (!exclude.test(repo)) {
      repos.add(repo);
    }
  }

  return [...repos].sort();
}

export interface TrendingRepo {
  repo: string; // owner/repo
  description: string;
  language: string;
  stars: number; // total stars
  starsInPeriod: number; // stars gained in the selected period
  url: string;
}

export interface TrendingOptions {
  period?: string; // daily | weekly | monthly
  language?: string; // programming language slug, e.g. "rust", "c++"
  spoken?: string; // spoken language code, e.g. "en", "zh"
}

function trendingUrl(opts: TrendingOptions): string {
  let url = "https://github.com/trending";
  if (opts.language) url += `/${encodeURIComponent(opts.language.toLowerCase())}`;
  const params = new URLSearchParams();
  params.set("since", opts.period || "daily");
  if (opts.spoken) params.set("spoken_language_code", opts.spoken);
  return `${url}?${params.toString()}`;
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Richer trending fetch: parses each repo row for description, language and stars.
export async function fetchTrendingDetailed(
  opts: TrendingOptions = {}
): Promise<TrendingRepo[]> {
  const res = await fetch(trendingUrl(opts));
  const html = await res.text();

  const out: TrendingRepo[] = [];
  const blocks = html.split('<article class="Box-row">').slice(1);

  for (const block of blocks) {
    const h2 = block.slice(block.indexOf("<h2"), block.indexOf("</h2>"));
    const hrefMatch = h2.match(/href="\/([^"]+)"/);
    if (!hrefMatch) continue;
    const repo = hrefMatch[1].trim();

    let description = "";
    const descMatch = block.match(
      /<p[^>]*class="[^"]*color-fg-muted[^"]*"[^>]*>(.*?)<\/p>/s
    );
    if (descMatch) description = stripTags(descMatch[1]);

    const langMatch = block.match(
      /<span itemprop="programmingLanguage">([^<]+)<\/span>/
    );
    const language = langMatch ? langMatch[1].trim() : "unknown";

    let stars = 0;
    const starsMatch = block.match(
      /href="\/[^"]+\/stargazers"[^>]*>(.*?)<\/a>/s
    );
    if (starsMatch) {
      stars = parseInt(stripTags(starsMatch[1]).replace(/[^\d]/g, ""), 10) || 0;
    }

    let starsInPeriod = 0;
    const periodMatch = block.match(
      /([\d,]+)\s+stars\s+(today|this week|this month)/
    );
    if (periodMatch) {
      starsInPeriod = parseInt(periodMatch[1].replace(/,/g, ""), 10) || 0;
    }

    out.push({
      repo,
      description,
      language,
      stars,
      starsInPeriod,
      url: `https://github.com/${repo}`,
    });
  }

  return out;
}
