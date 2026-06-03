# clone

Git repository package manager — clone, index, search, build/install, and organize GitHub repos like `pacman` + `paru` manage packages.

## Install

```bash
npm install -g @nxac/clone
```

## Usage

```bash
# Clone repos
clone owner/repo
clone https://github.com/owner/repo.git

# Search & query
clone search mobile                          # search the local index (like pacman -Qs)
clone search llm --long                      # -l: verbose cards with descriptions + topics

# Search ALL of GitHub (like pacman -Ss)
clone search tui --remote                    # -r: search every public repo
clone search llm -r --language python --stars ">1000"
clone search cli -r --topic terminal --sort stars -n 30
clone search agent -r --user anthropics      # restrict to an owner/org
clone search tui -r -n 500                   # up to 1000 (paginated), sorted by stars
clone search tui -r -n 500 -i                # fuzzy-pick from the list (fzf) → clone the picks
clone search tui -r -q | fzf | xargs clone install   # -q = one owner/repo per line; pipe anywhere

clone info anthropics/claude-code
clone info anthropics/claude-code --remote   # GitHub info even if not cloned (pacman -Si)
clone list --language python
clone list --owner openai --long
clone list --installed              # only repos you've built/installed
clone list --trending
clone list --recent 7
clone stats

# View trending (read-only — nothing is cloned)
clone trending                  # daily trending
clone trending --all            # daily + weekly + monthly
clone trending rust             # filter by programming language
clone trending --period weekly  # weekly (or monthly)
clone trending --spoken zh      # filter by spoken language code
clone trending -n 10            # limit to top 10
clone trending --json           # machine-readable output
clone t                         # alias

# Clone trending
clone daily
clone weekly
clone monthly
clone all
clone daily --dry
clone missing                   # list trending repos not yet cloned

# Build from source & install (like paru -S / makepkg -si)
clone install owner/repo        # clone if needed → detect build → review → build → link binary onto PATH
clone install owner/repo -y     # skip the review prompt (build unattended)
clone install owner/repo --build-only   # build but don't put on PATH
clone install owner/repo --keep-build   # keep the build worktree for incremental rebuilds (symlink, not copy)
clone install owner/repo --ask          # interactively set build command + binary; offer to save a .clone-recipe
clone install owner/repo --needed       # skip if already installed at the current commit
clone install .                 # build/install a local repo in place (like paru -B)
clone in owner/repo             # alias
clone uninstall owner/repo      # unlink the binary, KEEP the source (revert to "cloned")
clone un owner/repo             # alias

# Manage
clone update                  # pull all; rebuild+relink any installed repo whose HEAD moved
clone update --no-rebuild     # pull only, never rebuild
clone update owner/repo       # pull one (and rebuild if it was installed)
clone outdated                # repos with upstream commits — no fetch (git ls-remote); installed repos
clone outdated --all          # check every cloned repo
clone outdated --update       # update (and rebuild) all outdated repos
clone outdated --ignore a/b,c/d   # skip some repos (adds to config ignore list)
clone check                   # verify installed repos: dir, binaries, git health (pacman -Qk)
clone check --source          # audit the source tree: build artifacts, in-place apps/services, moved repos
clone check --build           # audit the build tree: clone-tracked vs redundant (has source clone) vs orphan
clone doctor                  # full health check: integrity + source + build + lifecycle, one unified verdict
clone reason owner/repo --explicit   # protect from orphan cleanup (pacman -D --asexplicit)
clone reason owner/repo --asdeps     # mark as a dependency (orphan-eligible)
clone changelog owner/repo    # commits landed upstream since you installed it (pacman -Qc)
clone owns ~/.local/bin/foo   # which repo owns a path / symlink (pacman -Qo)
clone path yazi               # print a repo's directory (resolves bare names)
cd "$(clone path yazi)"       # …jump to it (a CLI can't cd your shell — wrap it)
clone path                    # no arg → fzf-pick a repo, print its path
clone remove owner/repo       # DELETE the repo, its linked binaries, and its index entry
clone remove owner/repo -f    # skip the uncommitted-changes safety prompt
clone remove owner/repo -s    # also remove deps pulled in only by this repo (like pacman -Rs)
clone orphans                 # repos installed as deps that nothing needs now (like -Qdt)
clone orphans --remove        # remove them
clone clean                   # prune broken bin symlinks + dangling index entries (hints at _duplicates)
clone clean --builds --cache  # also remove build worktrees under build/ + clear trending cache
clone clean --source          # delete regenerable build artifacts from source (node_modules/dist/…); skips committed dirs
clone clean --source --dry-run  # preview what would be reclaimed, delete nothing
clone clean --source owner/repo # scope to one (or more) repos instead of the whole tree
clone clean --source --backup ~/bak  # MOVE artifacts to ~/bak (reversible) instead of deleting
clone clean --duplicates      # delete the redundant copies set aside in _duplicates/ (pacman -Sc)
clone log                     # trending history
clone log owner/repo

# Maintenance
clone reindex                 # rebuild index from disk
clone sync                    # detect, restructure & index untracked repos (INSIDE the repos root)
clone adopt                   # adopt the repo in the current dir (organize into the tree + index)
clone adopt ~/somewhere/foo   # adopt a repo you cloned anywhere else
clone adopt ~/grab-bag        # a FOLDER of gathered repos → sort each into owner/repo by remote, deduped
clone adopt ~/grab-bag --dry-run         # preview the sort + dedup without moving anything
clone adopt ~/somewhere/foo --in-place   # index it where it sits, don't move it
clone adopt --app build/owner/app        # track an app/service that runs in place (reindex-safe; ▣ in lists)
clone adopt --app build/owner/app --with-source   # …and also clone a pristine source mirror into source/
```

## How it works

- Repos are stored in `~/Dev/Github-Repos/source/<owner>/<repo>` (configurable via `CLONE_ROOT` env var)
- Metadata (stars, language, topics, description) is fetched from the GitHub API and stored in a local SQLite database at `~/.local/state/clone/clone.db`
- Trending history is tracked in `~/.local/state/clone/manifest.tsv`
- Deduplication: repos are never cloned twice, regardless of whether they're found via trending or manual clone

## Install / build lifecycle

clone keeps a clean separation of **source / build / install**, the way pacman/paru/Gentoo do
(pristine source → build area → installed binary):

- **source** — `~/Dev/Github-Repos/source/<owner>/<repo>` stays **pristine**: a clean checkout,
  updated by `git pull`, *never built in*.
- **build** — `clone install` spins up a **git worktree** in `~/Dev/Github-Repos/build/<owner>/<repo>`
  (shares the source's `.git`), compiles there, and — by default — **removes it afterward**
  (`makepkg -c` / paru `CleanAfter`). `--keep-build` keeps it for fast incremental rebuilds
  (paru `KeepSrc`); npm installs always keep it (a node bin needs its package).
- **install** — the built binary is placed in `~/.local/bin`:
  - **self-contained binaries (compiled)** are **copied** (decoupled — deleting the repo can't dangle them);
  - **interpreted (npm) / `--keep-build`** are **symlinked** into the kept build worktree.

clone tracks each repo's lifecycle state like pacman tracks packages:

| state | meaning |
|---|---|
| `cloned` | source on disk, not built |
| `built` | compiled, but no binary on PATH (library, or `--build-only`) |
| `installed` | compiled and its binary placed in the bindir |
| `failed` | last build failed |

`clone info <repo>` shows the state, install reason, detected build system, installed commit,
and which binaries are placed. `clone list`/`search` show a marker — `●` installed · `◐` built
· `·` cloned — and `clone list --installed` filters to what you've built.

**How the build is detected.** A repo has no `PKGBUILD`, so `clone` auto-detects the build
system from files in the repo, then *shows you the commands before running them*:

| file | build system | commands |
|---|---|---|
| `Cargo.toml` | cargo | `cargo build --release` |
| `package.json` | npm | `npm install` (+ `npm run build` if present) |
| `go.mod` | go | `go build ./...` |
| `meson.build` | meson | `meson setup build && meson compile -C build` |
| `CMakeLists.txt` | cmake | `cmake -B build … && cmake --build build` |
| `Makefile` | make | `make` |
| `pyproject.toml` / `setup.py` | python | `pip install --user .` (pip places its own scripts) |

**Override with `.clone-recipe`.** Drop a `.clone-recipe` file in the repo to take full
control. Lines are build commands (run in order); `bin: path` lines declare which built
files to link onto PATH; `dep: owner/repo` lines declare other repos to install first (as
dependencies):

```
# .clone-recipe
dep: someorg/libfoo
make release
bin: build/mytool
```

**App vs. CLI honesty.** Not every repo is a CLI tool. Before building, `clone` warns when
a repo looks like an **app/service/library** rather than something that belongs on your PATH —
e.g. a `package.json` with no `bin` entry, or an interpreted project with a `Dockerfile`/
`compose.yaml`. The source is still cloned; you just get a heads-up that an install won't
produce a command.

**`--ask` (interactive setup).** When nothing is auto-detected, or when you pass `--ask`,
`clone` prompts you for the build command(s) and which file to put on PATH, then offers to
save your answers as a `.clone-recipe` so the next install is reproducible — no AI, no
guessing, just a one-time "teach it how":

```
$ clone install someorg/weird-tool --ask
How should clone build someorg/weird-tool?
  (no build system auto-detected)
  Build command(s), chain with ' && ' [blank = don't build]: make all
  Binary to put on PATH (relative path; blank = auto/none): bin/weird
  Save this as .clone-recipe (reproducible)? [y/N]: y
```

**`uninstall` vs `remove`:** `uninstall` only unlinks the binary and reverts the repo to
`cloned` — the source stays. `remove` deletes everything (source + binaries + index entry),
and refuses to nuke a repo with uncommitted changes unless you pass `--force`.

**Keeping `source/` pristine — `clone check --source`.** The model only holds if the source
tree stays *pristine* (you build in a worktree under `build/`, not in `source/`). Over time
things drift: you build in place, set up a venv, run a service out of a source dir. This
read-only audit reports the drift so you can fix it — it never deletes anything:

```
$ clone check --source
  Apps/services living in source (belong in build/):
    ⚑ google-research/timesfm — has a virtualenv
    ⚑ bebe-acme/monitorator   — running as a systemd service

  Source repos polluted with build artifacts:
    ◐ alibaba/page-agent      — node_modules (323M)
    ◐ microsoft/vscode        — build (12M)

  Indexed under source but missing on disk (moved/deleted?):
    ✗ pewdiepie-archdaemon/odysseus
    → run 'clone reindex' to reconcile the index.

  200 pristine · 25 with artifacts · 6 app/service · 1 missing  (of 229 source repos)
  ~3.3G of build artifacts in source. These regenerate on build — safe to delete.
```

It flags three kinds of drift: **build artifacts** (`target/`, `node_modules/`, `build/`,
`dist/`, `__pycache__/`, … — `vendor/` is *not* flagged, since Go vendoring is legitimately
committed), **in-place apps/services** (a `venv/` or a path referenced by a systemd user unit),
and **moved/deleted** repos still in the index.

Crucially, it only counts artifacts git treats as **regenerable output** — a `build/` or
`dist/` dir that's *committed source* (e.g. vscode's tracked `build/` tooling) is left alone
and noted separately, never reported as pollution. Then it points you at the fix:

```
clone clean --source            # delete the regenerable artifacts (frees the ~3.3G), confirm first
clone clean --source --dry-run  # preview only
clone adopt --app <path> --with-source   # relocate an in-place app to build/ and track it
```

**`clone clean --source` is safe by construction**: it deletes a dir only when git tracks *no
files* under it (so it can be rebuilt), and it skips repos tracked as apps. A committed
`build/`/`dist/` is never removed. As always, it shows the list + total and asks before
deleting (or `--dry-run` to just look, `-y` to skip the prompt). Pass repo names to scope it to
specific repos, or `--backup <dir>` to **move** the artifacts into a backup tree (instant on the
same filesystem, fully reversible) instead of deleting — verify everything still builds, then
delete the backup to reclaim the space.

The proper end state for, say, an npm tool is reached with two steps — `clone clean --source`
(sweep the misplaced output) then `clone install owner/repo` (rebuild it in a `build/` worktree
and link the binary). The source stays pristine; the rebuilt `node_modules` lives under `build/`;
only the package's *declared* binary is linked (dependency CLIs in `node_modules/.bin` are never
swept onto your PATH).

**Auditing `build/` — `clone check --build`.** The mirror of `check --source`, for the other
tree. It classifies every `build/` dir as **tracked** (clone-managed: an install or an `adopt
--app`), **redundant** (a flat dir that duplicates a pristine `source/` clone — rebuildable on
demand, so reclaimable), or **orphan** (no `source/` clone — the only copy here). It flags `venv`
and unique `.env` state so you don't reclaim something with config in it. Read-only — it reports
the drift; you reclaim redundant dirs (rebuild from `source/` later) or `clone adopt` orphans.

**`clone doctor` — the whole physical.** `check` is three focused, scriptable modes; `doctor`
runs them all at once (installed/app **integrity** + `source/` **purity** + `build/` **audit** +
**lifecycle** health: failed builds, orphaned deps) and ends with a single verdict — either
"✓ Everything healthy" or a numbered list of issues, each with the exact command to fix it
(`clone clean --source`, `clone adopt --app …`, `clone reindex`, `clone orphans --remove`, …) and
the total reclaimable space. The `brew doctor` / `rustup check` of clone.

**Tracking apps/services — `clone adopt --app`.** Some repos aren't CLI tools you put on
PATH — they're apps you *run in place* (a FastAPI service with a `venv/`, a daemon behind a
systemd unit). Those belong in `build/`, not pristine `source/`. Tell clone to track one where
it lives:

```
$ clone adopt --app build/pewdiepie-archdaemon/odysseus
Tracking app ▣ pewdiepie-archdaemon/odysseus
  at /home/you/Dev/Github-Repos/build/pewdiepie-archdaemon/odysseus
  service odysseus (active)
  Reindex-safe: clone keeps this even though it lives outside source/.
```

A tracked app gets the `install_state = app` lifecycle (the `▣` marker in `list`/`search`/
`info`), and — crucially — **`clone reindex` never prunes it** even though it lives outside the
`source/` tree that reindex scans (`reindex` reports `kept N app/service`). `clone info` and
`clone check` show its systemd unit and whether it's running; if the directory is genuinely
gone, reindex prunes it like any other missing repo.

Add **`--with-source`** to also keep a *pristine source mirror* alongside the running instance —
restoring clone's normal source/build split for an app:

```
$ clone adopt --app build/pewdiepie-archdaemon/odysseus --with-source
Cloning pristine source mirror → …/source/pewdiepie-archdaemon/odysseus
Tracking app ▣ pewdiepie-archdaemon/odysseus
  source  …/source/pewdiepie-archdaemon/odysseus (pristine)
  running …/build/pewdiepie-archdaemon/odysseus
  service odysseus (active)
```

The mirror is cloned from the running instance's git, so it captures the exact deployed commit
but copies **only committed content** — your `venv/`, `data/`, and `logs/` stay with the running
instance and never pollute the mirror — then repoints `origin` at upstream so `git pull` tracks
GitHub. The index `path` becomes the pristine mirror (so `clone check --source` sees it clean)
while `build_path` stays the running instance (shown as `running` in `clone info`).

If the app you point at is **still inside `source/`** (you built/ran it there by mistake),
`--with-source` *relocates* it in one step: it moves the running instance (venv and all) to
`build/owner/repo`, then restores a pristine `source/owner/repo` clone. Preview with `--dry-run`
first; if a systemd unit points at the old path it warns you to repoint + restart it.

## Dependencies & orphans

When a repo's `.clone-recipe` lists `dep: owner/repo` lines, `clone install` installs those
first (marked as `dependency`, not `explicit`) and records a dependency edge. This drives:

- **`clone orphans`** — dependency repos that nothing requires anymore (pacman `-Qdt`).
- **`clone remove <repo> -s`** — also removes dependencies pulled in only by that repo
  (pacman `-Rs`). A dep is kept if anything else still requires it, or if you'd installed it
  explicitly yourself (explicit installs are never auto-removed).

## Hooks

Drop JSON files in `~/.config/clone/hooks/*.json` to run commands around install/update/remove
transactions (modeled on `alpm-hooks`):

```json
{
  "description": "refresh font cache after installs",
  "on": ["install", "update"],
  "when": "post",
  "exec": "fc-cache -f"
}
```

The command runs via `sh -c` with `$CLONE_REPO`, `$CLONE_EVENT`, `$CLONE_WHEN` in its
environment, and cwd set to the repo. `when` is `pre` or `post` (default `post`); a `pre`
hook with `"abortOnFail": true` cancels the transaction if it exits non-zero. Post hooks
don't run if the transaction fails.

## Shell Completions

### Zsh

The `postinstall` step installs them automatically. To (re)install them from the
running binary at any time — the surest way to stay current after an upgrade:

```bash
clone completions zsh --install        # → ~/.local/share/zsh/site-functions/_clone
rm -f ~/.zcompdump* && compinit        # refresh zsh's completion cache (or restart your shell)
```

Or pipe the script wherever you want:

```bash
clone completions zsh > ~/.local/share/zsh/site-functions/_clone
```

Make sure your completions dir is in `fpath` before `compinit` runs:

```bash
fpath=(~/.local/share/zsh/site-functions $fpath)
autoload -Uz compinit && compinit
```

## Configuration

| Env Var | Default | Description |
|---|---|---|
| `CLONE_ROOT` | `~/Dev/Github-Repos/source` | Root directory for cloned repos |
| `CLONE_BIN` | `~/.local/bin` | Where `install` places built binaries (must be on your PATH) |
| `CLONE_BUILD` | sibling `build/` of the repos root | Build worktrees (ephemeral by default) |
| `CLONE_DATA` | (unset) | Master override: collapse config+state+cache into one dir (used to sandbox) |
| `XDG_CONFIG_HOME` | `~/.config` | `config.json` + `hooks/` live in `$XDG_CONFIG_HOME/clone` |
| `XDG_STATE_HOME` | `~/.local/state` | `clone.db` + `manifest.tsv` live in `$XDG_STATE_HOME/clone` |
| `XDG_CACHE_HOME` | `~/.cache` | Trending cache lives in `$XDG_CACHE_HOME/clone` |
| `GITHUB_TOKEN` | (from `gh auth token`) | GitHub API token for metadata |

Storage follows the XDG Base Directory spec, like `paru`: **config** (precious) is separate
from **state** (the DB) and **cache** (disposable). Existing `~/.config/clone` data is
auto-migrated to the new locations on first run.

### Config file (optional)

`~/.config/clone/config.json` (paru.conf analogue) — all fields optional:

```json
{
  "ignore": ["torvalds/linux", "some/huge-repo"],
  "keepBuild": false,
  "build": {
    "cargo": ["cargo build --release --locked"],
    "make":  ["make", "make extras"]
  }
}
```

- **`ignore`** — owner/repo to skip during `update` / `outdated` (merged with any `--ignore` flag).
- **`keepBuild`** — keep build worktrees after install (paru `KeepSrc`); same as always passing `--keep-build`.
- **`build`** — per-build-system step overrides; replaces the auto-detected commands for that
  system (a per-repo `.clone-recipe` still wins over this).

## Jump to a repo's directory

A CLI can't change your shell's working directory (a child process can't `cd` the parent) —
so, like `zoxide`, wrap the path-printing command in a shell function. Add to your zsh:

```zsh
clcd() { local d; d="$(clone path "$@")" && cd "$d"; }
```

Then:

```zsh
clcd yazi      # cd straight to the yazi repo (bare name resolves)
clcd           # no arg → fuzzy-pick (fzf) a repo and cd into it
```

## Development

```bash
npm run build      # compile TypeScript → dist/
npm test           # build, then run the sandboxed self-test (scripts/selftest.sh)
```

`npm test` exercises every feature — clone, search, the full build/install lifecycle across
make/cargo/cmake/npm/recipe, dependencies, orphans, recursive remove, outdated, hooks, and
clean — in a throwaway sandbox (`CLONE_ROOT`/`CLONE_BIN`/`CLONE_DATA` redirected to a temp
dir), so it never touches your real index. It exits non-zero on any failure and runs in CI
(`.github/workflows/ci.yml`).

## License

MIT
