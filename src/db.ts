import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { Config } from "./config.js";

export interface RepoEntry {
  id: string;
  owner: string;
  repo: string;
  description: string;
  language: string;
  stars: number;
  topics: string;
  license: string;
  fork: boolean;
  archived: boolean;
  html_url: string;
  cloned_at: string;
  disk_size: string;
  source: string;
  path: string;
  // --- lifecycle (v1) — defaulted, never clobbered by a discovery upsert ---
  install_reason?: string; // 'explicit' | 'dependency' | ''
  install_state?: string; // 'cloned' | 'built' | 'installed' | 'failed'
  build_system?: string; // detected: cargo|npm|go|make|cmake|meson|python|recipe
  installed_commit?: string; // git HEAD at last successful build
  installed_at?: string; // ISO timestamp of last successful build
  artifacts?: string; // JSON array of bin paths placed on PATH
  install_method?: string; // 'copy' (self-contained binary) | 'symlink' (into kept worktree)
  build_path?: string; // kept build worktree path (empty if ephemeral build was removed)
}

// Fields that may be updated via setInstall().
export type InstallFields = Partial<
  Pick<
    RepoEntry,
    | "install_reason"
    | "install_state"
    | "build_system"
    | "installed_commit"
    | "installed_at"
    | "artifacts"
    | "install_method"
    | "build_path"
  >
>;

// Lifecycle columns + their SQL definitions, used for both schema creation and
// migrating pre-lifecycle databases via ALTER TABLE.
const LIFECYCLE_COLUMNS: Record<string, string> = {
  install_reason: "TEXT DEFAULT ''",
  install_state: "TEXT DEFAULT 'cloned'",
  build_system: "TEXT DEFAULT ''",
  installed_commit: "TEXT DEFAULT ''",
  installed_at: "TEXT DEFAULT ''",
  artifacts: "TEXT DEFAULT '[]'",
  install_method: "TEXT DEFAULT ''",
  build_path: "TEXT DEFAULT ''",
};

export class CloneDB {
  private db!: SqlJsDatabase;
  private dbPath: string;
  private ready: Promise<void>;

  constructor(config: Config) {
    this.dbPath = config.dbPath;
    this.ready = this.init();
  }

  private async init() {
    const SQL = await initSqlJs();

    if (existsSync(this.dbPath)) {
      const buffer = readFileSync(this.dbPath);
      this.db = new SQL.Database(buffer);
    } else {
      mkdirSync(dirname(this.dbPath), { recursive: true });
      this.db = new SQL.Database();
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS repos (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        repo TEXT NOT NULL,
        description TEXT DEFAULT '',
        language TEXT DEFAULT 'unknown',
        stars INTEGER DEFAULT 0,
        topics TEXT DEFAULT '[]',
        license TEXT DEFAULT '',
        fork INTEGER DEFAULT 0,
        archived INTEGER DEFAULT 0,
        html_url TEXT DEFAULT '',
        cloned_at TEXT NOT NULL,
        disk_size TEXT DEFAULT '',
        source TEXT DEFAULT 'manual',
        path TEXT NOT NULL,
        install_reason TEXT DEFAULT '',
        install_state TEXT DEFAULT 'cloned',
        build_system TEXT DEFAULT '',
        installed_commit TEXT DEFAULT '',
        installed_at TEXT DEFAULT '',
        artifacts TEXT DEFAULT '[]',
        install_method TEXT DEFAULT '',
        build_path TEXT DEFAULT ''
      )
    `);
    this.migrate();
    // Dependency edges: `parent` requires `child` (child installed as a dep of parent).
    // Drives orphan detection (-Qdt) and recursive remove (-Rs).
    this.db.run(`
      CREATE TABLE IF NOT EXISTS deps (
        parent TEXT NOT NULL,
        child TEXT NOT NULL,
        PRIMARY KEY (parent, child)
      )
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_owner ON repos(owner)"
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_language ON repos(language)"
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_source ON repos(source)"
    );
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_stars ON repos(stars DESC)"
    );
    this.save();
  }

  // Bring pre-lifecycle databases up to date: add any missing lifecycle column.
  private migrate() {
    const existing = new Set<string>();
    const stmt = this.db.prepare("PRAGMA table_info(repos)");
    while (stmt.step()) {
      existing.add((stmt.getAsObject() as any).name);
    }
    stmt.free();

    for (const [col, def] of Object.entries(LIFECYCLE_COLUMNS)) {
      if (!existing.has(col)) {
        this.db.run(`ALTER TABLE repos ADD COLUMN ${col} ${def}`);
      }
    }
  }

  async ensureReady() {
    await this.ready;
  }

  private save() {
    const data = this.db.export();
    writeFileSync(this.dbPath, Buffer.from(data));
  }

  private rowToEntry(row: any): RepoEntry {
    return {
      id: row.id,
      owner: row.owner,
      repo: row.repo,
      description: row.description || "",
      language: row.language || "unknown",
      stars: row.stars || 0,
      topics: row.topics || "[]",
      license: row.license || "",
      fork: !!row.fork,
      archived: !!row.archived,
      html_url: row.html_url || "",
      cloned_at: row.cloned_at,
      disk_size: row.disk_size || "",
      source: row.source || "manual",
      path: row.path,
      install_reason: row.install_reason || "",
      install_state: row.install_state || "cloned",
      build_system: row.build_system || "",
      installed_commit: row.installed_commit || "",
      installed_at: row.installed_at || "",
      artifacts: row.artifacts || "[]",
      install_method: row.install_method || "",
      build_path: row.build_path || "",
    };
  }

  private queryAll(sql: string, params: any[] = []): RepoEntry[] {
    const stmt = this.db.prepare(sql);
    if (params.length) stmt.bind(params);

    const results: RepoEntry[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      results.push(this.rowToEntry(row));
    }
    stmt.free();
    return results;
  }

  has(id: string): boolean {
    const stmt = this.db.prepare("SELECT 1 FROM repos WHERE id = ?");
    stmt.bind([id]);
    const found = stmt.step();
    stmt.free();
    return found;
  }

  // Upsert discovery metadata. On conflict we update ONLY the discovery columns
  // (and preserve the original cloned_at) so a re-index/clone never clobbers the
  // lifecycle state set by install/build. New rows get lifecycle schema defaults.
  upsert(entry: RepoEntry) {
    this.db.run(
      `INSERT INTO repos (id, owner, repo, description, language, stars, topics, license, fork, archived, html_url, cloned_at, disk_size, source, path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         owner = excluded.owner,
         repo = excluded.repo,
         description = excluded.description,
         language = excluded.language,
         stars = excluded.stars,
         topics = excluded.topics,
         license = excluded.license,
         fork = excluded.fork,
         archived = excluded.archived,
         html_url = excluded.html_url,
         disk_size = excluded.disk_size,
         source = excluded.source,
         path = excluded.path`,
      [
        entry.id,
        entry.owner,
        entry.repo,
        entry.description,
        entry.language,
        entry.stars,
        entry.topics,
        entry.license,
        entry.fork ? 1 : 0,
        entry.archived ? 1 : 0,
        entry.html_url,
        entry.cloned_at,
        entry.disk_size,
        entry.source,
        entry.path,
      ]
    );
    this.save();
  }

  // Update lifecycle columns for an existing repo (set by install/build/uninstall).
  setInstall(id: string, fields: InstallFields) {
    const keys = Object.keys(fields) as (keyof InstallFields)[];
    if (keys.length === 0) return;
    const assignments = keys.map((k) => `${k} = ?`).join(", ");
    const params = keys.map((k) => fields[k] ?? "");
    this.db.run(`UPDATE repos SET ${assignments} WHERE id = ?`, [
      ...params,
      id,
    ]);
    this.save();
  }

  get(id: string): RepoEntry | undefined {
    const results = this.queryAll(
      "SELECT * FROM repos WHERE id = ?",
      [id]
    );
    return results[0];
  }

  // Resolve a bare name to indexed entries: exact repo-name match first (the
  // common case, e.g. "odysseus"), else fall back to an id/repo substring match.
  resolveName(name: string): RepoEntry[] {
    const exact = this.queryAll(
      "SELECT * FROM repos WHERE LOWER(repo) = LOWER(?) ORDER BY stars DESC",
      [name]
    );
    if (exact.length) return exact;
    const like = `%${name}%`;
    return this.queryAll(
      `SELECT * FROM repos WHERE id LIKE ? COLLATE NOCASE OR repo LIKE ? COLLATE NOCASE
       ORDER BY stars DESC`,
      [like, like]
    );
  }

  remove(id: string) {
    this.db.run("DELETE FROM repos WHERE id = ?", [id]);
    // Drop any dependency edges touching this repo.
    this.db.run("DELETE FROM deps WHERE parent = ? OR child = ?", [id, id]);
    this.save();
  }

  // --- dependency edges ---------------------------------------------------

  addDep(parent: string, child: string) {
    if (parent === child) return;
    this.db.run(
      "INSERT OR IGNORE INTO deps (parent, child) VALUES (?, ?)",
      [parent, child]
    );
    this.save();
  }

  private depColumn(col: "child" | "parent", whereCol: string, value: string): string[] {
    const stmt = this.db.prepare(`SELECT ${col} FROM deps WHERE ${whereCol} = ?`);
    stmt.bind([value]);
    const out: string[] = [];
    while (stmt.step()) out.push((stmt.getAsObject() as any)[col]);
    stmt.free();
    return out;
  }

  // Deps of `parent` (the repos it requires).
  childrenOf(parent: string): string[] {
    return this.depColumn("child", "parent", parent);
  }

  // Repos that require `child` (its reverse deps).
  parentsOf(child: string): string[] {
    return this.depColumn("parent", "child", child);
  }

  // Orphans (-Qdt): installed as a dependency, but nothing requires them now.
  orphans(): RepoEntry[] {
    return this.queryAll(
      `SELECT * FROM repos
       WHERE install_reason = 'dependency'
         AND id NOT IN (SELECT child FROM deps)
       ORDER BY id`
    );
  }

  search(query: string): RepoEntry[] {
    const q = `%${query}%`;
    return this.queryAll(
      `SELECT * FROM repos
       WHERE id LIKE ? COLLATE NOCASE
          OR owner LIKE ? COLLATE NOCASE
          OR repo LIKE ? COLLATE NOCASE
          OR description LIKE ? COLLATE NOCASE
          OR topics LIKE ? COLLATE NOCASE
          OR language LIKE ? COLLATE NOCASE
       ORDER BY stars DESC`,
      [q, q, q, q, q, q]
    );
  }

  list(filters: {
    language?: string;
    owner?: string;
    source?: string;
    trending?: boolean;
    recentDays?: number;
    installed?: boolean;
  }): RepoEntry[] {
    const conditions: string[] = [];
    const params: any[] = [];

    if (filters.installed) {
      // "installed" in the user's sense = anything you've built or linked.
      conditions.push("install_state IN ('installed', 'built')");
    }

    if (filters.language) {
      conditions.push("LOWER(language) = LOWER(?)");
      params.push(filters.language);
    }
    if (filters.owner) {
      conditions.push("LOWER(owner) = LOWER(?)");
      params.push(filters.owner);
    }
    if (filters.source) {
      conditions.push("source = ?");
      params.push(filters.source);
    }
    if (filters.trending) {
      conditions.push("source = 'trending'");
    }
    if (filters.recentDays) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - filters.recentDays);
      conditions.push("cloned_at >= ?");
      params.push(cutoff.toISOString().split("T")[0]);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return this.queryAll(
      `SELECT * FROM repos ${where} ORDER BY stars DESC`,
      params
    );
  }

  stats(): {
    total: number;
    bySource: Record<string, number>;
    byState: Record<string, number>;
    orphans: number;
    byLanguage: { language: string; count: number }[];
    byOwner: { owner: string; count: number }[];
    topStarred: RepoEntry[];
  } {
    const totalStmt = this.db.prepare(
      "SELECT COUNT(*) as c FROM repos"
    );
    totalStmt.step();
    const total = (totalStmt.getAsObject() as any).c;
    totalStmt.free();

    const sourceStmt = this.db.prepare(
      "SELECT source, COUNT(*) as c FROM repos GROUP BY source"
    );
    const bySource: Record<string, number> = {};
    while (sourceStmt.step()) {
      const row = sourceStmt.getAsObject() as any;
      bySource[row.source] = row.c;
    }
    sourceStmt.free();

    // Lifecycle breakdown (paru -Ps style health).
    const stateStmt = this.db.prepare(
      "SELECT install_state, COUNT(*) as c FROM repos GROUP BY install_state"
    );
    const byState: Record<string, number> = {};
    while (stateStmt.step()) {
      const row = stateStmt.getAsObject() as any;
      byState[row.install_state || "cloned"] = row.c;
    }
    stateStmt.free();
    const orphans = this.orphans().length;

    const langStmt = this.db.prepare(
      "SELECT language, COUNT(*) as count FROM repos GROUP BY language ORDER BY count DESC LIMIT 10"
    );
    const byLanguage: { language: string; count: number }[] = [];
    while (langStmt.step()) {
      const row = langStmt.getAsObject() as any;
      byLanguage.push({ language: row.language, count: row.count });
    }
    langStmt.free();

    const ownerStmt = this.db.prepare(
      "SELECT owner, COUNT(*) as count FROM repos GROUP BY owner ORDER BY count DESC LIMIT 10"
    );
    const byOwner: { owner: string; count: number }[] = [];
    while (ownerStmt.step()) {
      const row = ownerStmt.getAsObject() as any;
      byOwner.push({ owner: row.owner, count: row.count });
    }
    ownerStmt.free();

    const topStarred = this.queryAll(
      "SELECT * FROM repos ORDER BY stars DESC LIMIT 5"
    );

    return { total, bySource, byState, orphans, byLanguage, byOwner, topStarred };
  }

  count(): number {
    const stmt = this.db.prepare(
      "SELECT COUNT(*) as c FROM repos"
    );
    stmt.step();
    const c = (stmt.getAsObject() as any).c;
    stmt.free();
    return c;
  }

  clear() {
    this.db.run("DELETE FROM repos");
    this.save();
  }

  close() {
    this.save();
    this.db.close();
  }
}
