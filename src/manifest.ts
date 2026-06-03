import { existsSync, readFileSync, appendFileSync, writeFileSync } from "fs";
import type { Config } from "./config.js";

export class Manifest {
  private path: string;

  constructor(config: Config) {
    this.path = config.manifestPath;
  }

  log(date: string, period: string, repo: string) {
    appendFileSync(this.path, `${date}\t${period}\t${repo}\n`);
  }

  has(repo: string): boolean {
    if (!existsSync(this.path)) return false;
    const content = readFileSync(this.path, "utf-8");
    return content.includes(repo);
  }

  getHistory(repo?: string): { date: string; period: string; repo: string }[] {
    if (!existsSync(this.path)) return [];
    const lines = readFileSync(this.path, "utf-8").trim().split("\n");
    return lines
      .filter((l) => l.trim())
      .map((line) => {
        const [date, period, r] = line.split("\t");
        return { date, period, repo: r };
      })
      .filter((entry) => !repo || entry.repo.includes(repo));
  }

  /**
   * Build an index: owner/repo -> Set<period> of distinct periods it has
   * trended in across all history. Used for grouping in `clone list --trending`.
   */
  getPeriodsByRepo(): Map<string, Set<string>> {
    const map = new Map<string, Set<string>>();
    if (!existsSync(this.path)) return map;
    const lines = readFileSync(this.path, "utf-8").trim().split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      const [, period, repo] = line.split("\t");
      if (!period || !repo) continue;
      if (!map.has(repo)) map.set(repo, new Set());
      map.get(repo)!.add(period);
    }
    return map;
  }

  /**
   * For each repo, return the most recent (date, period) it appeared under.
   * Useful for "last seen trending" staleness checks.
   */
  getLatestByRepo(): Map<string, { date: string; period: string }> {
    const map = new Map<string, { date: string; period: string }>();
    const history = this.getHistory();
    for (const h of history) {
      const existing = map.get(h.repo);
      if (!existing || h.date > existing.date) {
        map.set(h.repo, { date: h.date, period: h.period });
      }
    }
    return map;
  }
}
