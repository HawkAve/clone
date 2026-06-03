# `clone` as pacman + paru — grounding notes

Source of truth: `docs/reference/pacman/doc/*.asciidoc` and `docs/reference/paru/man/*`.
This file is the conceptual map used to design the install / build / uninstall / update update.
It is *notes*, not a spec — no code decisions are locked until the maintainer signs off.

## 1. The core translation

pacman manages **packages** (prebuilt binary tarballs from a repo DB).
paru adds **AUR**: a recipe (PKGBUILD) you **build from source**, then hand the result to pacman.
`clone` manages **git repos**. A repo is closer to an AUR package than a binary package:
you already have the *source*, the question is what "install" means.

The key realisation from the bibles:

| pacman/paru concept            | what it is                                  | `clone` equivalent |
|--------------------------------|---------------------------------------------|--------------------|
| sync repo (`-S`)               | download prebuilt pkg + deps                | `git clone` (already done) |
| AUR / PKGBUILD (paru `-B`)     | **build from source** locally               | the *missing* piece — build a cloned repo |
| `makepkg` lifecycle            | prepare→build→check→package                 | detected build recipe (make / cargo / go / npm / cmake…) |
| install reason (explicit/dep)  | why a pkg is on the system                  | track per repo: did *you* ask for it, or pulled as a dep/trending |
| local DB (`/var/lib/pacman`)   | what's installed + metadata                 | `clone.db` (sql.js) — already exists, needs new columns |
| `-Qu` / devel.json (paru)      | what's out of date                          | `git fetch` + compare HEAD; devel = `git ls-remote` |
| `-R` remove                    | delete files + DB entry (+ .pacsave)        | `clone remove` (exists) + **uninstall built artifacts** |
| orphans (`-Qdt`)               | deps no longer needed                       | repos cloned only as a dep, now unreferenced |
| `-Sc` clean                    | prune cache                                  | prune build artifacts / stale clones |

**The crux:** in pacman "download" and "install" are one step. For `clone` they split:
- `git clone` = acquire source (done today).
- **build/install** = compile + place runnable artifacts somewhere on PATH.
A repo has no PKGBUILD telling us *how*. So `clone` must either (a) auto-detect the build
system, or (b) read an optional per-repo recipe. paru's PKGBUILD is the model for (b);
makepkg's job is the model for what (a) must reproduce.

## 2. Operation model (pacman `-Q/-S/-R/-U/-D/-T/-F`, paru extensions)

pacman is one binary with operation letters. `clone` uses subcommands; keep that, but make
the verbs map cleanly so the mental model transfers:

- **acquire**: `clone <owner/repo>` (= `-S` download). Already done.
- **build/install**: NEW. `clone install <repo>` = build from source + link artifacts.
  - paru `-B` (build a PKGBUILD dir) and `makepkg -si` (syncdeps + install) are the references.
  - makepkg lifecycle to imitate: `prepare() → build() → check() → package()`
    (makepkg.8 / PKGBUILD.5). For us: detected steps, e.g. `cargo build --release`,
    `npm i && npm run build`, `make`, `go build`, `cmake`.
  - flags worth stealing: `-s/--syncdeps` (install build deps), `-i/--install`,
    `-c/--clean` (rm work files), `--check` / `--nocheck`, `-f/--force` rebuild,
    `--needed` (skip if up-to-date), `--noconfirm`.
- **uninstall**: extend `clone remove` (= `-R`). Must also undo what `install` placed
  (symlinks/binaries), like pacman removing owned files. pacman saves config as `.pacsave`;
  our analogue is *don't* nuke uncommitted/untracked work without asking.
  - `-s/--recursive` (also remove now-orphan deps), `-c/--cascade`, `-n/--nosave`.
- **update**: extend `clone update` (= `-Syu`). Today it only `git pull`s. Pacman semantics:
  - `-y` refresh (fetch), `-u` upgrade (apply), combined `-Syu`.
  - For us: `git fetch` → show outdated (`-Qu`) → `git pull` → **rebuild if it was installed**.
  - paru `--devel`: VCS packages tracked by `git ls-remote` HEAD hash, upgraded when the
    remote commit changes (paru state dir `devel.json`). This is *exactly* how a repo manager
    should detect "new commits upstream" cheaply — steal it wholesale.
- **query/track**: extend `list`/`info`/`stats` (= `-Q…`). New filters mirroring pacman:
  - `-e/--explicit`, `-d/--deps`, `-t/--unrequired` (orphans), `-u/--upgrades`,
    `-m/--foreign` (no upstream / local-only), `-n/--native`.
- **clean**: NEW `clone clean` (= `-Sc`, paru `-Sc` cleans build dirs / untracked).

## 3. State to track ("keep track of everything")

Today `repos` table (db.ts) stores discovery metadata only: stars, language, topics,
license, fork, archived, cloned_at, disk_size, source(manual|trending|local), path.

To be a package manager it needs **lifecycle** state. New columns / tables:

- `install_reason`  — `explicit` | `dependency` (pacman's central distinction; drives orphans).
- `install_state`   — `cloned` | `built` | `installed` | `failed`.
- `build_system`    — detected: cargo|npm|go|make|cmake|meson|python|… (or `recipe`).
- `installed_at`    — commit hash + timestamp at last successful build (devel baseline).
- `head_remote`     — last-seen `git ls-remote` HEAD (paru devel.json trick) for cheap `-Qu`.
- `artifacts`       — JSON list of what install placed (symlinks/bins) so `remove` can undo
  it precisely (pacman tracks owned files; we track owned symlinks/bins).
- `dep_of` / deps   — edges for orphan detection (`-Qdt`) and recursive remove (`-Rs`).
- optional `recipe` — per-repo build override (our PKGBUILD-lite), path or inline.

makepkg has explicit **exit codes** (0 ok, 4 PKGBUILD fn error, 8 dep install fail,
13 already built, 14 install fail…). Worth mirroring a small set so scripting `clone install`
is sane.

## 4. Config & directories (paru.conf model)

paru splits config into `[options]`, `[bin]` (tool paths), `[env]`, and per-repo sections,
with XDG locations + a state dir holding `devel.json`. `clone` today has only env vars
(`CLONE_ROOT`, `GITHUB_TOKEN`) and `~/.config/clone/{clone.db,manifest.tsv}`. To support
build/install we likely add:
- a build/work dir (paru CloneDir/BUILDDIR analogue) — though we build in-tree by default,
- an install/bin dir on PATH for linked artifacts (e.g. `~/.local/bin` or `~/.local/clone/bin`),
- optional `~/.config/clone/config` (paru.conf-style) for: default build commands per language,
  `CleanAfter`, `Devel`, `RemoveMake`, `--needed` defaults, review-before-build toggle.

## 5. Safety / UX lessons from the bibles

- **Review before build** (paru `--review` / SkipReview): building from source = running
  arbitrary upstream code. paru *defaults to showing you the PKGBUILD diff first*. Our analogue:
  show what build command will run (and ideally the diff since last build) before executing.
- **Install reason matters**: only explicit installs survive `-Rs`/orphan cleanup. Get this
  right or `clone clean` will delete things the user wanted.
- **`.pacsave`/`.pacnew` philosophy**: never silently destroy user-modified state. For us:
  refuse to wipe a repo with uncommitted changes / untracked build output without `--force`.
- **PostTransaction hooks don't run on failure** (alpm-hooks.5). If we add hooks, same rule.
- **Cheap upgrade detection**: `git ls-remote` (paru devel) avoids fetching the whole repo
  just to know if there's an update. Use it for `clone update -Qu`-style listing.

## 6. Locked decisions (2026-06-02)

1. **Install = build + link to PATH.** Detect build system → compile → symlink produced
   binary into `~/.local/bin` (already on PATH). Libraries with no binary just get built
   (state `built` not `installed`).
2. **Auto-detect + optional override.** Detect cargo/npm/go/make/cmake/meson/python from
   repo files; a per-repo `.clone-recipe` file overrides the detected commands.
3. **Bindir = `~/.local/bin`** by default (overridable later via config / env).
4. **v1 scope = core lifecycle:** `install`, `uninstall`, `update` (with rebuild), and DB
   lifecycle state tracking, plus review-before-build. **Deferred to v2:** `clean` (-Sc),
   orphans (-Qdt), `git ls-remote` devel tracking, hooks, dependency-edge graph.

## 7. v1 implementation shape

- **db.ts** — add lifecycle columns (`install_reason`, `install_state`, `build_system`,
  `installed_commit`, `installed_at`, `artifacts` JSON). Migrate existing DB via
  `PRAGMA table_info` + `ALTER TABLE ADD COLUMN`. **Rewrite `upsert` to `ON CONFLICT DO
  UPDATE` only the discovery columns** so re-index/clone never clobbers lifecycle state.
- **detect.ts** — `detectBuildSystem(path)`: file-signature → ordered build steps; reads
  `.clone-recipe` override. Returns `{ system, steps[], binHints[] }`.
- **build.ts** — `buildRepo()`: snapshot executable files → run steps → diff to discover
  produced binaries (general trick), narrowed by ecosystem `binHints` (e.g. cargo
  `target/release`). `linkArtifacts()` / `unlinkArtifacts()` manage the bindir symlinks.
- **git.ts** — add `gitHeadCommit(path)` and `gitIsDirty(path)` (uncommitted-work guard).
- **index.ts** — `cmdInstall` (clone-if-needed → review → build → link → record),
  `cmdUninstall` (unlink artifacts, state→cloned, keep source), enhance `cmdRemove`
  (unlink artifacts + dirty-tree guard) and `cmdUpdate` (rebuild+relink if installed &
  commit changed).
