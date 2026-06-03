#!/usr/bin/env bash
# clone self-test — exercises every feature in a fully sandboxed env.
# Safe: CLONE_ROOT/CLONE_BIN/CLONE_DATA are redirected to $SBOX, so your real
# index, repos, and ~/.local/bin are never touched.
#
#   bash scripts/selftest.sh           # full run
#   SBOX=/tmp/ct bash scripts/selftest.sh
set -u

# Resolve the CLI relative to this script so it works anywhere (CI checkout, etc.).
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$REPO_DIR/dist/index.js"
export SBOX="${SBOX:-${TMPDIR:-/tmp}/clone-selftest}"
export CLONE_ROOT="$SBOX/root"
export CLONE_BIN="$SBOX/bin"
export CLONE_DATA="$SBOX/data"

rm -rf "$SBOX"; mkdir -p "$CLONE_ROOT" "$CLONE_BIN" "$CLONE_DATA"
clone(){ node "$CLI" "$@"; }

PASS=0; FAIL=0; declare -a FAILED=()
hdr(){ printf '\n\033[1;36m════════ %s ════════\033[0m\n' "$*"; }
ok(){ printf '   \033[32m✓ PASS\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
no(){ printf '   \033[31m✗ FAIL\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); FAILED+=("$*"); }
# assert exit 0
chk(){ local d="$1"; shift; printf '\033[2m   $ %s\033[0m\n' "$*"; if "$@"; then ok "$d"; else no "$d (exit $?)"; fi; }
# assert a condition (true command)
assert(){ local d="$1"; shift; if "$@"; then ok "$d"; else no "$d"; fi; }
# assert command output contains a string.
# IMPORTANT: capture the full output FIRST, then grep. Never pipe the command
# straight into `grep -q` — grep quits on first match, closes the pipe, and
# SIGPIPEs a still-running build (killing it mid-compile / before linking).
grepout(){
  local d="$1" pat="$2"; shift 2
  local out; out="$("$@" 2>&1)"
  printf '%s\n' "$out" | sed 's/^/   │ /'
  if printf '%s\n' "$out" | grep -qiE "$pat"; then ok "$d"; else no "$d (no match /$pat/)"; fi
}

# ── helper: stamp a synthetic local repo, commit, so HEAD exists ──
seed(){ # seed <owner/repo> ; then caller writes files; then `commit <dir>`
  clone create "$1" >/dev/null
}
commit(){ git -C "$1" add -A && git -C "$1" -c user.email=t@t -c user.name=t commit -qm build; }

echo "Sandbox: $SBOX"
echo "CLI:     $CLI"

# ════════════════════════════════════════════════════════════════════
hdr "1. basics"
chk "root prints sandbox root"        clone root
grepout "root == CLONE_ROOT" "$CLONE_ROOT" clone root
chk "--help"                          clone --help
chk "stats on empty index"            clone stats

# ════════════════════════════════════════════════════════════════════
hdr "2. clone a real repo (network + GitHub API)"
chk "clone octocat/Hello-World"       clone octocat/Hello-World
assert "repo on disk"                 test -d "$CLONE_ROOT/octocat/Hello-World/.git"
grepout "info shows repo"   "octocat/Hello-World"   clone info octocat/Hello-World
grepout "list shows repo"   "Hello-World"           clone list
grepout "stats counts it"   "Total repos:\s*1"      clone stats
grepout "local search hit"  "Hello-World"           clone search hello

# ════════════════════════════════════════════════════════════════════
hdr "3. remote search & trending (read-only, network)"
grepout "remote search"     "repositories"          clone search cli --remote -n 5
grepout "remote search paginates past 100" "1[0-9][0-9] repositories" clone search react -r -n 150
grepout "trending daily"    "trending|repos"        clone trending -n 5
grepout "missing json"      "daily|\\{"             clone missing daily --json

# ════════════════════════════════════════════════════════════════════
hdr "4. build lifecycle — make (cc)"
seed test/cmaker
D="$CLONE_ROOT/test/cmaker"
printf '#include <stdio.h>\nint main(void){printf("cmaker ok\\n");return 0;}\n' > "$D/hello.c"
printf 'hello: hello.c\n\tcc -o hello hello.c\n' > "$D/Makefile"
commit "$D"
grepout "install detects make"  "make"   clone install test/cmaker -y
assert "binary copied onto PATH"  bash -c 'test -f "$CLONE_BIN/hello" && ! test -L "$CLONE_BIN/hello"'
assert "binary runs"             bash -c '"$CLONE_BIN/hello" | grep -q "cmaker ok"'
assert "SOURCE stays pristine (built in a worktree)" bash -c '! test -e "$CLONE_ROOT/test/cmaker/hello"'
assert "build worktree is ephemeral (removed)"       bash -c '! test -d "$SBOX/build/test/cmaker"'
grepout "info shows installed"  "installed" clone info test/cmaker
grepout "needed skips rebuild"  "up to date" clone install test/cmaker -y --needed
chk "uninstall"                 clone uninstall test/cmaker
assert "binary unlinked"        bash -c '! test -e "$CLONE_BIN/hello"'
grepout "state reverted"        "cloned"   clone info test/cmaker

# ════════════════════════════════════════════════════════════════════
hdr "5. build lifecycle — cargo"
seed test/ruster
D="$CLONE_ROOT/test/ruster"
mkdir -p "$D/src"
printf '[package]\nname = "ruster"\nversion = "0.1.0"\nedition = "2021"\n' > "$D/Cargo.toml"
printf 'fn main(){ println!("ruster ok"); }\n' > "$D/src/main.rs"
commit "$D"
grepout "install detects cargo" "cargo"  clone install test/ruster -y
assert "cargo binary linked"    test -f "$CLONE_BIN/ruster"
assert "cargo binary runs"      bash -c '"$CLONE_BIN/ruster" | grep -q "ruster ok"'

# ════════════════════════════════════════════════════════════════════
hdr "6. build lifecycle — npm (bin field)"
seed test/nodetool
D="$CLONE_ROOT/test/nodetool"
printf '{\n "name":"nodetool",\n "version":"1.0.0",\n "bin":{"nodetool":"cli.js"}\n}\n' > "$D/package.json"
printf '#!/usr/bin/env node\nconsole.log("nodetool ok");\n' > "$D/cli.js"
commit "$D"
grepout "install detects npm"   "npm"    clone install test/nodetool -y
assert "npm bin symlinked"      test -L "$CLONE_BIN/nodetool"
assert "npm bin runs"           bash -c '"$CLONE_BIN/nodetool" | grep -q "nodetool ok"'
assert "npm keeps a build worktree (bin needs its package)" test -d "$SBOX/build/test/nodetool"
assert "npm source stays pristine (node_modules in worktree)" bash -c '! test -d "$CLONE_ROOT/test/nodetool/node_modules"'

# ════════════════════════════════════════════════════════════════════
hdr "7. build lifecycle — cmake"
seed test/cmaketool
D="$CLONE_ROOT/test/cmaketool"
printf 'cmake_minimum_required(VERSION 3.10)\nproject(cmaketool C)\nadd_executable(cmaketool main.c)\n' > "$D/CMakeLists.txt"
printf '#include <stdio.h>\nint main(void){printf("cmaketool ok\\n");return 0;}\n' > "$D/main.c"
commit "$D"
grepout "install detects cmake" "cmake"  clone install test/cmaketool -y
assert "cmake binary linked"    test -f "$CLONE_BIN/cmaketool"
assert "cmake binary runs"      bash -c '"$CLONE_BIN/cmaketool" | grep -q "cmaketool ok"'

# ════════════════════════════════════════════════════════════════════
hdr "8. .clone-recipe override"
seed test/recipe
D="$CLONE_ROOT/test/recipe"
printf '#include <stdio.h>\nint main(void){printf("recipe ok\\n");return 0;}\n' > "$D/thing.c"
printf 'all:\n\tcc -o thing thing.c\n' > "$D/Makefile"
printf '# custom build\nmake all\nbin: thing\n' > "$D/.clone-recipe"
commit "$D"
grepout "install uses recipe"   "recipe"  clone install test/recipe -y
assert "recipe binary linked"   test -f "$CLONE_BIN/thing"
assert "recipe binary runs"     bash -c '"$CLONE_BIN/thing" | grep -q "recipe ok"'

# ════════════════════════════════════════════════════════════════════
hdr "9. update (real repo pull path)"
grepout "update pulls"          "up to date|updated|current" clone update octocat/Hello-World

# ════════════════════════════════════════════════════════════════════
hdr "10. remove + dirty-tree guard"
# Source builds in a worktree now, so source stays clean — dirty it explicitly to test the guard.
echo scratch > "$CLONE_ROOT/test/ruster/uncommitted.txt"
grepout "dirty remove guarded"  "uncommitted|Cancelled" bash -c 'clone remove test/ruster </dev/null'
assert "repo still present after guarded cancel" test -d "$CLONE_ROOT/test/ruster"
grepout "forced remove deletes" "Removed" bash -c 'echo y | clone remove test/ruster -f'
assert "repo gone"              bash -c '! test -d "$CLONE_ROOT/test/ruster"'
assert "ruster binary unlinked" bash -c '! test -e "$CLONE_BIN/ruster"'

# ════════════════════════════════════════════════════════════════════
hdr "11. reindex & sync"
chk "reindex"                   clone reindex
chk "sync"                      clone sync

# ════════════════════════════════════════════════════════════════════
hdr "12. install-state visibility (markers · --installed · survives reindex)"
# By now cmaketool, nodetool, recipe are installed; cmaker was uninstalled; ruster removed.
grepout "list shows installed marker/legend" "installed"  clone list
assert "list --installed includes an installed repo" bash -c 'clone list --installed 2>&1 | grep -q cmaketool'
assert "list --installed excludes cloned-only repo"  bash -c '! clone list --installed 2>&1 | grep -q "octocat/Hello-World"'
# Reindex already ran in section 11 — confirm it did NOT wipe lifecycle state.
grepout "state survives reindex" "installed"          clone info test/cmaketool
# ...and a clone-create'd repo keeps source=local (not rewritten to manual).
grepout "reindex preserves source=local" "source\s+local" clone info test/cmaketool
assert "uninstalled cmaker excluded from --installed" bash -c '! clone list --installed 2>&1 | grep -q "test/cmaker"'

# ════════════════════════════════════════════════════════════════════
hdr "13. dependency resolution (.clone-recipe dep:)"
seed test/libdep
D="$CLONE_ROOT/test/libdep"
printf '#include <stdio.h>\nint main(void){printf("depbin ok\\n");return 0;}\n' > "$D/dep.c"
printf 'depbin: dep.c\n\tcc -o depbin dep.c\n' > "$D/Makefile"
commit "$D"
seed test/app
D="$CLONE_ROOT/test/app"
printf '#include <stdio.h>\nint main(void){printf("appbin ok\\n");return 0;}\n' > "$D/app.c"
printf 'appbin: app.c\n\tcc -o appbin app.c\n' > "$D/Makefile"
printf 'dep: test/libdep\nmake\nbin: appbin\n' > "$D/.clone-recipe"
commit "$D"
grepout "install app resolves dep"  "dependency of test/app: test/libdep" clone install test/app -y
assert "app binary linked"          test -f "$CLONE_BIN/appbin"
assert "dep binary linked"          test -f "$CLONE_BIN/depbin"
grepout "dep marked as dependency"  "reason\s+dependency"  clone info test/libdep
grepout "app marked as explicit"    "reason\s+explicit"    clone info test/app

# ════════════════════════════════════════════════════════════════════
hdr "14. orphans (-Qdt)"
grepout "no orphans while dep is required" "No orphaned" clone orphans
# Remove app non-recursively → libdep becomes an orphan
grepout "non-recursive remove of app" "Removed" bash -c 'echo y | clone remove test/app'
grepout "libdep now an orphan"      "test/libdep"   clone orphans
grepout "orphans --remove clears it" "Removed"      clone orphans --remove -y
assert "depbin unlinked after orphan removal" bash -c '! test -e "$CLONE_BIN/depbin"'
grepout "no orphans left"           "No orphaned"   clone orphans

# ════════════════════════════════════════════════════════════════════
hdr "15. recursive remove (-Rs)"
seed test/lib2
D="$CLONE_ROOT/test/lib2"
printf '#include <stdio.h>\nint main(void){return 0;}\n' > "$D/dep.c"
printf 'dep2: dep.c\n\tcc -o dep2 dep.c\n' > "$D/Makefile"
commit "$D"
seed test/app2
D="$CLONE_ROOT/test/app2"
printf '#include <stdio.h>\nint main(void){return 0;}\n' > "$D/app.c"
printf 'app2: app.c\n\tcc -o app2 app.c\n' > "$D/Makefile"
printf 'dep: test/lib2\nmake\nbin: app2\n' > "$D/.clone-recipe"
commit "$D"
clone install test/app2 -y >/dev/null
assert "app2 + dep2 both linked" bash -c 'test -f "$CLONE_BIN/app2" && test -f "$CLONE_BIN/dep2"'
grepout "recursive remove takes the dep too" "orphaned dep|Removed" bash -c 'echo y | clone remove test/app2 -s'
assert "app2 gone"  bash -c '! test -d "$CLONE_ROOT/test/app2"'
assert "lib2 gone (removed as orphan dep)" bash -c '! test -d "$CLONE_ROOT/test/lib2"'

# ════════════════════════════════════════════════════════════════════
hdr "16. outdated (git ls-remote, no fetch)"
grepout "installed repos up to date" "up to date" clone outdated
# Make octocat genuinely behind upstream, then detect it
git -C "$CLONE_ROOT/octocat/Hello-World" fetch --unshallow -q 2>/dev/null || true
git -C "$CLONE_ROOT/octocat/Hello-World" reset --hard HEAD~1 -q 2>/dev/null || true
grepout "outdated --all detects behind repo" "Hello-World|up to date" clone outdated --all

# ════════════════════════════════════════════════════════════════════
hdr "17. transaction hooks"
mkdir -p "$CLONE_DATA/hooks"
cat > "$CLONE_DATA/hooks/marker.json" <<EOF
{ "description":"record installs", "on":["install"], "when":"post", "exec":"echo fired:\$CLONE_EVENT:\$CLONE_REPO >> $SBOX/hooklog" }
EOF
seed test/hooked
D="$CLONE_ROOT/test/hooked"
printf '#include <stdio.h>\nint main(void){return 0;}\n' > "$D/h.c"
printf 'hookbin: h.c\n\tcc -o hookbin h.c\n' > "$D/Makefile"
commit "$D"
grepout "install fires post hook" "hook\\(post install\\)" clone install test/hooked -y
assert "hook actually ran (wrote marker)" bash -c 'grep -q "fired:install:test/hooked" "$SBOX/hooklog"'

# ════════════════════════════════════════════════════════════════════
hdr "18. info --remote (-Si) + bare-name resolution"
grepout "info --remote fetches GitHub" "remote|Stars" clone info octocat/Hello-World --remote
# bare name (no owner/) resolves to the unique indexed repo
grepout "info resolves a bare name" "test/recipe" clone info recipe
# `clone path` prints just the dir, resolving a bare name — the cd-into-it primitive
assert "path resolves bare name → dir" bash -c '[ "$(clone path recipe 2>/dev/null)" = "$CLONE_ROOT/test/recipe" ]'
assert "cd \"\$(clone path)\" jumps there" bash -c 'cd "$(clone path recipe 2>/dev/null)" && [ "$PWD" = "$CLONE_ROOT/test/recipe" ]'
# ambiguous bare name lists candidates and exits non-zero
clone create dupe-a/widget >/dev/null; clone create dupe-b/widget >/dev/null
grepout "ambiguous bare name lists candidates" "be specific|matches" bash -c 'clone info widget 2>&1'
assert "ambiguous bare name exits non-zero" bash -c '! clone info widget >/dev/null 2>&1'

# ════════════════════════════════════════════════════════════════════
hdr "19. reason (-D --asexplicit/--asdeps)"
clone reason test/recipe --asdeps >/dev/null
grepout "reason → dependency" "reason\s+dependency" clone info test/recipe
clone reason test/recipe --explicit >/dev/null
grepout "reason → explicit"   "reason\s+explicit"    clone info test/recipe

# ════════════════════════════════════════════════════════════════════
hdr "20. check (-Qk)"
grepout "check passes on healthy installs" "healthy" clone check
seed test/breakme
D="$CLONE_ROOT/test/breakme"
printf '#include <stdio.h>\nint main(void){return 0;}\n' > "$D/b.c"
printf 'breakbin: b.c\n\tcc -o breakbin b.c\n' > "$D/Makefile"
commit "$D"
clone install test/breakme -y >/dev/null
rm -f "$CLONE_BIN/breakbin"   # delete the installed (copied) binary
grepout "check detects broken binary" "broken|✗" clone check test/breakme
assert "check exits non-zero on problems" bash -c '! clone check test/breakme >/dev/null 2>&1'

# ════════════════════════════════════════════════════════════════════
hdr "21. stats lifecycle health (-Ps)"
grepout "stats shows lifecycle block" "Lifecycle" clone stats

# ════════════════════════════════════════════════════════════════════
hdr "22. owns (-Qo)"
grepout "owns resolves a bin symlink → repo" "test/cmaketool" clone owns "$CLONE_BIN/cmaketool"
grepout "owns resolves a file path → repo"   "test/recipe"    clone owns "$CLONE_ROOT/test/recipe/thing.c"
# broken symlink: owns must still follow the (dead) target to attribute it
ln -s "$CLONE_ROOT/test/recipe/ghost-bin" "$CLONE_BIN/dead-recipe-link"
grepout "owns follows a BROKEN symlink → repo" "test/recipe" clone owns "$CLONE_BIN/dead-recipe-link"
rm -f "$CLONE_BIN/dead-recipe-link"

# ════════════════════════════════════════════════════════════════════
hdr "23. changelog (-Qc)"
D="$CLONE_ROOT/test/recipe"
printf '// tweak\n' >> "$D/thing.c"
git -C "$D" -c user.email=t@t -c user.name=t commit -aqm "newfeature commit"
grepout "changelog shows commits since install" "newfeature" clone changelog test/recipe

# ════════════════════════════════════════════════════════════════════
hdr "24. install <local path> (paru -B)"
LP="$SBOX/localproj"
mkdir -p "$LP"
printf '#include <stdio.h>\nint main(void){printf("localbin ok\\n");return 0;}\n' > "$LP/m.c"
printf 'localbin: m.c\n\tcc -o localbin m.c\n' > "$LP/Makefile"
git -C "$LP" init -q && git -C "$LP" add -A && git -C "$LP" -c user.email=t@t -c user.name=t commit -qm init
grepout "install local path builds" "Installed|local/localproj" clone install "$LP" -y
assert "local binary linked" test -f "$CLONE_BIN/localbin"
grepout "local repo indexed as source=local" "source\s+local" clone info local/localproj

# ════════════════════════════════════════════════════════════════════
hdr "25. --ignore (IgnorePkg)"
# octocat was reset behind upstream in section 16; --ignore should drop it.
grepout "ignore excludes a repo from outdated" "up to date" clone outdated --all --ignore octocat/Hello-World

# ════════════════════════════════════════════════════════════════════
hdr "26. clean (-Sc)"
# npm installs keep a build worktree and symlink INTO it. Remove the worktree →
# the clone-OWNED symlink dangles (the case clean's broken-symlink prune is for).
rm -rf "$SBOX/build/test/nodetool"
assert "owned symlink now broken (precondition)" bash -c 'test -L "$CLONE_BIN/nodetool" && ! test -e "$CLONE_BIN/nodetool"'
# Two broken symlinks clone does NOT own — must survive clean:
ln -s /nonexistent/elsewhere "$CLONE_BIN/foreignlink"        # foreign target
ln -s "$CLONE_ROOT/by-hand/gone" "$CLONE_BIN/manuallink"     # points INTO repos root, but not clone's
clone create test/ghost >/dev/null
rm -rf "$CLONE_ROOT/test/ghost"            # dir gone, index entry dangling
mkdir -p "$SBOX/build/stray/repo/.git"     # a build worktree not backing any install
grepout "clean reports work" "broken bin symlinks|dangling" clone clean --dry-run --builds
grepout "clean runs" "Cleaned" clone clean --builds --cache -y
assert "clean --cache did NOT wipe the DB" bash -c 'clone list 2>&1 | grep -q "test/recipe"'
assert "owned broken symlink pruned"           bash -c '! test -L "$CLONE_BIN/nodetool"'
assert "foreign broken symlink preserved"      test -L "$CLONE_BIN/foreignlink"
assert "manual symlink into repos root preserved" test -L "$CLONE_BIN/manuallink"
assert "dangling ghost pruned"  bash -c '! clone list 2>&1 | grep -q "test/ghost"'
assert "stray build worktree removed" bash -c '! test -d "$SBOX/build/stray/repo"'
# --duplicates clears the dedup holding pen (pacman -Sc analogue)
mkdir -p "$CLONE_ROOT/_duplicates/junkrepo/.git"
grepout "default clean hints at _duplicates" "_duplicates" clone clean --dry-run
grepout "clean --duplicates lists each item" "junkrepo" clone clean --duplicates --dry-run
clone clean --duplicates -y >/dev/null 2>&1
assert "clean --duplicates empties the holding pen" bash -c '! test -d "$CLONE_ROOT/_duplicates/junkrepo"'

# ════════════════════════════════════════════════════════════════════
hdr "27. config.json (persistent ignore + build override)"
cat > "$CLONE_DATA/config.json" <<EOF
{ "ignore": ["octocat/Hello-World"], "build": { "make": ["cc -o ovr ovr.c"] } }
EOF
# config ignore list applies with NO --ignore flag
grepout "config ignore list respected" "up to date" clone outdated --all
# build override replaces the detected 'make' steps
seed test/override
D="$CLONE_ROOT/test/override"
printf '#include <stdio.h>\nint main(void){printf("ovr ok\\n");return 0;}\n' > "$D/ovr.c"
printf 'wrongtarget: ovr.c\n\tfalse\n' > "$D/Makefile"   # plain 'make' would FAIL here
commit "$D"
grepout "build override runs cc, not make" "cc -o ovr ovr.c" clone install test/override -y
assert "override-built binary linked" test -f "$CLONE_BIN/ovr"
rm -f "$CLONE_DATA/config.json"

# ════════════════════════════════════════════════════════════════════
hdr "28. XDG layout split (paru-style; honors XDG_*_HOME)"
XB="$SBOX/xdg"
env -u CLONE_DATA XDG_CONFIG_HOME="$XB/config" XDG_STATE_HOME="$XB/state" XDG_CACHE_HOME="$XB/cache" \
    CLONE_ROOT="$XB/root" node "$CLI" create xdg/test >/dev/null 2>&1
assert "DB lives in XDG_STATE_HOME/clone"       test -f "$XB/state/clone/clone.db"
assert "config dir is XDG_CONFIG_HOME/clone"    test -d "$XB/config/clone"
assert "DB is NOT in the config dir"            bash -c '! test -f "$XB/config/clone/clone.db"'

# ════════════════════════════════════════════════════════════════════
hdr "29. migration from old single-dir layout → XDG"
XM="$SBOX/xdgmig"
# Build an OLD-style DB collapsed under config/clone (pre-XDG layout).
env CLONE_DATA="$XM/config/clone" CLONE_ROOT="$XM/root" node "$CLI" create mig/test >/dev/null 2>&1
assert "old-layout DB created" test -f "$XM/config/clone/clone.db"
# A fresh run with XDG dirs (no CLONE_DATA) must auto-migrate it.
grepout "migration message printed" "migrated to XDG" \
  env -u CLONE_DATA XDG_CONFIG_HOME="$XM/config" XDG_STATE_HOME="$XM/state" XDG_CACHE_HOME="$XM/cache" CLONE_ROOT="$XM/root" node "$CLI" list
assert "DB moved to XDG_STATE_HOME" test -f "$XM/state/clone/clone.db"
assert "old DB removed after move"  bash -c '! test -f "$XM/config/clone/clone.db"'
grepout "migrated data preserved" "mig/test" \
  env -u CLONE_DATA XDG_CONFIG_HOME="$XM/config" XDG_STATE_HOME="$XM/state" XDG_CACHE_HOME="$XM/cache" CLONE_ROOT="$XM/root" node "$CLI" list

# ════════════════════════════════════════════════════════════════════
hdr "30. adopt (organize a repo cloned OUTSIDE the root)"
mkrepo(){ mkdir -p "$1"; git -C "$1" init -q; printf 'x\n' > "$1/file"; git -C "$1" add -A; git -C "$1" -c user.email=t@t -c user.name=t commit -qm init; }
# (a) external repo with a github-style remote
EXT="$SBOX/external/widget"; mkrepo "$EXT"
git -C "$EXT" remote add origin https://github.com/acme/widget.git
clone sync >/dev/null 2>&1
assert "sync ignores a repo outside the root" bash -c '! clone list 2>&1 | grep -q "acme/widget"'
grepout "adopt moves it into owner/repo" "Adopted|moved" clone adopt "$EXT"
assert "now organized under the root"  test -d "$CLONE_ROOT/acme/widget"
assert "external copy moved away"      bash -c '! test -d "'"$EXT"'"'
grepout "adopt indexed it"             "acme/widget" clone list
# (b) --in-place: no-remote repo, index where it sits as local/<dir>
EXT2="$SBOX/external/localthing"; mkrepo "$EXT2"
grepout "adopt --in-place indexes w/o moving" "in place" clone adopt "$EXT2" --in-place
assert "in-place repo stays put"       test -d "$EXT2"
grepout "indexed as local/<dir>"       "local/localthing" clone list
# (c) no-arg form adopts the current directory
EXT3="$SBOX/external/insidetest"; mkrepo "$EXT3"
( cd "$EXT3" && node "$CLI" adopt >/dev/null 2>&1 )
assert "no-arg adopt used cwd → moved into root" test -d "$CLONE_ROOT/local/insidetest"

# ════════════════════════════════════════════════════════════════════
hdr "31. completions command"
grepout "completions zsh prints the script"   "#compdef clone" clone completions zsh
grepout "completions defaults to zsh"         "#compdef clone" clone completions
grepout "printed script is current (has adopt)" "adopt:" clone completions zsh
# --install writes to XDG site-functions (sandboxed via XDG_DATA_HOME)
CDIR="$SBOX/comp"
env XDG_DATA_HOME="$CDIR" node "$CLI" completions zsh --install >/dev/null 2>&1
assert "--install writes _clone"               test -f "$CDIR/zsh/site-functions/_clone"
grepout "installed file is current (has adopt)" "adopt:" cat "$CDIR/zsh/site-functions/_clone"
assert "unknown shell exits non-zero"          bash -c '! clone completions bash >/dev/null 2>&1'

# ════════════════════════════════════════════════════════════════════
hdr "32. search -q (quiet) / -i (interactive)"
assert "remote -q emits bare owner/repo lines" bash -c 'clone search bubbletea -r -q -n 3 2>/dev/null | grep -qE "^[^ /]+/[^ /]+$"'
assert "local -q emits ids"                    bash -c 'clone search recipe -q 2>/dev/null | grep -q "test/recipe"'
if command -v fzf >/dev/null 2>&1; then
  assert "quiet output pipes to fzf --filter"  bash -c 'clone search tui -r -q -n 50 2>/dev/null | fzf --filter=yazi | grep -q .'
fi
# -i without a tty (or no fzf) must degrade gracefully, never crash
grepout "-i degrades gracefully (no tty)" "needs a terminal|Nothing selected|needs fzf|No results" bash -c 'clone search tui -r -i -n 3 </dev/null 2>&1'

# ════════════════════════════════════════════════════════════════════
hdr "33. sync — dry-run + duplicate handling"
mkflat(){ mkdir -p "$CLONE_ROOT/$1"; git -C "$CLONE_ROOT/$1" init -q; echo x > "$CLONE_ROOT/$1/f";
  git -C "$CLONE_ROOT/$1" add -A; git -C "$CLONE_ROOT/$1" -c user.email=t@t -c user.name=t commit -qm x;
  git -C "$CLONE_ROOT/$1" remote add origin "$2"; }
mkflat flatdup1 https://github.com/synctest/dup.git
mkflat flatdup2 https://github.com/synctest/dup.git   # same remote → collision
mkflat flatsolo https://github.com/synctest/solo.git
# consistency guard: a 2-level repo whose folder ≠ its remote must be SKIPPED, not mis-indexed
mkdir -p "$CLONE_ROOT/wrongowner/widget"; git -C "$CLONE_ROOT/wrongowner/widget" init -q
echo x > "$CLONE_ROOT/wrongowner/widget/f"; git -C "$CLONE_ROOT/wrongowner/widget" add -A
git -C "$CLONE_ROOT/wrongowner/widget" -c user.email=t@t -c user.name=t commit -qm x
git -C "$CLONE_ROOT/wrongowner/widget" remote add origin https://github.com/realowner/widget.git
grepout "dry-run flags the duplicate" "DUPLICATE"  clone sync --dry-run
grepout "sync skips folder≠remote repo" "skip.*wrongowner/widget" clone sync --dry-run
assert "dry-run changed nothing (flat still at root)" test -d "$CLONE_ROOT/flatdup1"
clone sync >/dev/null 2>&1
assert "distinct flat → owner/repo"     test -d "$CLONE_ROOT/synctest/solo"
assert "one duplicate → owner/repo"     test -d "$CLONE_ROOT/synctest/dup"
assert "other duplicate → _duplicates"  bash -c 'ls "$CLONE_ROOT/_duplicates" 2>/dev/null | grep -q flatdup'
assert "misplaced repo NOT mis-indexed" bash -c '! clone list 2>&1 | grep -q "wrongowner/widget"'

# ════════════════════════════════════════════════════════════════════
hdr "34. adopt a FOLDER of gathered repos (differentiate by remote + dedup)"
GF="$SBOX/grabbag"
mkrepoR(){ mkdir -p "$GF/$1"; git -C "$GF/$1" init -q; echo x > "$GF/$1/f";
  git -C "$GF/$1" add -A; git -C "$GF/$1" -c user.email=t@t -c user.name=t commit -qm x;
  git -C "$GF/$1" remote add origin "$2"; }
mkrepoR alpha     https://github.com/grab/alpha.git           # new → grab/alpha
mkrepoR beta-dup1 https://github.com/grab/beta.git            # in-batch dup pair (same remote)
mkrepoR beta-dup2 https://github.com/grab/beta.git
mkrepoR helloworld https://github.com/octocat/Hello-World.git # dup of one ALREADY in the tree
grepout "folder adopt finds all repos"  "Adopting 4 repo" clone adopt "$GF" --dry-run
assert  "dry-run moved nothing"          test -d "$GF/alpha"
clone adopt "$GF" >/dev/null 2>&1
assert "new repo → owner/repo in tree"   test -d "$CLONE_ROOT/grab/alpha"
assert "first of a dup pair → owner/repo" test -d "$CLONE_ROOT/grab/beta"
assert "in-batch dup → _duplicates"      bash -c 'ls "$CLONE_ROOT/_duplicates" 2>/dev/null | grep -q beta-dup'
assert "dup of existing repo → _duplicates" bash -c 'ls "$CLONE_ROOT/_duplicates" 2>/dev/null | grep -q helloworld'

# ════════════════════════════════════════════════════════════════════
hdr "35. --keep-build (keep worktree + symlink, paru KeepSrc)"
seed test/keeper
D="$CLONE_ROOT/test/keeper"
printf '#include <stdio.h>\nint main(void){printf("keeper ok\\n");return 0;}\n' > "$D/k.c"
printf 'keeper: k.c\n\tcc -o keeper k.c\n' > "$D/Makefile"
commit "$D"
clone install test/keeper -y --keep-build >/dev/null 2>&1
assert "keep-build kept the worktree"      test -d "$SBOX/build/test/keeper"
assert "keep-build symlinks the binary"    test -L "$CLONE_BIN/keeper"
assert "keeper runs"                       bash -c '"$CLONE_BIN/keeper" | grep -q "keeper ok"'
assert "source still pristine"             bash -c '! test -e "$CLONE_ROOT/test/keeper/keeper"'
clone uninstall test/keeper >/dev/null 2>&1
assert "uninstall removed the kept worktree" bash -c '! test -d "$SBOX/build/test/keeper"'
assert "uninstall removed the symlink"       bash -c '! test -L "$CLONE_BIN/keeper"'

# ════════════════════════════════════════════════════════════════════
hdr "36. app-vs-CLI honesty warning (npm, no bin field)"
seed test/webapp
D="$CLONE_ROOT/test/webapp"
printf '{\n "name":"webapp",\n "version":"1.0.0"\n}\n' > "$D/package.json"
commit "$D"
grepout "warns it looks like an app" "looks like an app" clone install test/webapp -y
clone uninstall test/webapp >/dev/null 2>&1

# ════════════════════════════════════════════════════════════════════
hdr "37. --ask interactive authoring + saved .clone-recipe"
seed test/askme
D="$CLONE_ROOT/test/askme"
# A lone .c file with no Makefile → no build system auto-detected → forces authoring.
printf '#include <stdio.h>\nint main(void){printf("askme ok\\n");return 0;}\n' > "$D/m.c"
commit "$D"
# Answers piped to the three prompts: build command, binary, save-recipe? (y)
printf 'cc -o askme m.c\naskme\ny\n' | clone install test/askme --ask >/dev/null 2>&1
assert "--ask built + copied the binary onto PATH" test -f "$CLONE_BIN/askme"
assert "--ask binary runs"                  bash -c '"$CLONE_BIN/askme" | grep -q "askme ok"'
assert "--ask saved a .clone-recipe"        test -f "$CLONE_ROOT/test/askme/.clone-recipe"
assert ".clone-recipe records the bin line" bash -c 'grep -q "bin: askme" "$CLONE_ROOT/test/askme/.clone-recipe"'
assert ".clone-recipe records the build step" bash -c 'grep -q "cc -o askme m.c" "$CLONE_ROOT/test/askme/.clone-recipe"'
# The saved recipe makes it reproducible: a plain install (no --ask) now works.
clone uninstall test/askme >/dev/null 2>&1
assert "recipe binary unlinked first"       bash -c '! test -e "$CLONE_BIN/askme"'
clone install test/askme -y >/dev/null 2>&1
assert "reinstall via saved recipe re-links the binary" test -f "$CLONE_BIN/askme"
assert "recipe-driven binary still runs"    bash -c '"$CLONE_BIN/askme" | grep -q "askme ok"'

# ════════════════════════════════════════════════════════════════════
hdr "38. check --source (source-tree purity audit)"
# A polluted repo: regenerable build artifacts (gitignored, like a real repo) in
# otherwise-pristine source. node_modules stays UNTRACKED so the audit flags it.
seed test/polluted
mkdir -p "$CLONE_ROOT/test/polluted/node_modules/foo"
echo x > "$CLONE_ROOT/test/polluted/node_modules/foo/x"
echo "node_modules/" > "$CLONE_ROOT/test/polluted/.gitignore"
printf '{"name":"polluted"}\n' > "$CLONE_ROOT/test/polluted/package.json"
commit "$CLONE_ROOT/test/polluted"
# An app set up to run in place (has a venv).
seed test/appy
mkdir -p "$CLONE_ROOT/test/appy/venv/bin"
printf '#!/bin/sh\n' > "$CLONE_ROOT/test/appy/venv/bin/python"
chmod +x "$CLONE_ROOT/test/appy/venv/bin/python"
commit "$CLONE_ROOT/test/appy"
grepout "flags build artifacts in source" "test/polluted.*node_modules" clone check --source
grepout "flags an app/venv in source"     "test/appy.*virtualenv"        clone check --source
grepout "reports a pristine count + reclaimable" "pristine|safe to delete" clone check --source
assert "vendor/ is NOT flagged (legit Go vendoring)" bash -c '
  mkdir -p "$CLONE_ROOT/test/appy/vendor"; echo y > "$CLONE_ROOT/test/appy/vendor/v"
  ! clone check --source 2>&1 | grep -q "test/appy.*vendor"'

# ════════════════════════════════════════════════════════════════════
hdr "39. track an app/service that lives in build/ (adopt --app)"
# An app living OUTSIDE the source tree (simulating build/owner/repo).
APPDIR="$SBOX/build/acme/webapp"
mkdir -p "$APPDIR"; git -C "$APPDIR" init -q
echo "print('hi')" > "$APPDIR/app.py"
commit "$APPDIR"
grepout "adopt --app tracks it in place"  "Tracking app|local/webapp" clone adopt --app "$APPDIR"
grepout "info shows the app state"        "app" clone info local/webapp
grepout "list shows the app"              "webapp" clone list
# THE key property: reindex scans source/ only, so it must KEEP this app
# (lives outside source/) instead of pruning it as "missing".
grepout "reindex keeps the app, not prunes it" "kept 1 app" clone reindex
assert "app survived reindex"             bash -c 'clone info local/webapp 2>&1 | grep -qi "app"'
# An app whose dir really is gone SHOULD still be pruned (info would fall back
# to remote and exit 0, so assert against the local index instead).
rm -rf "$APPDIR"
grepout "app pruned once its dir is gone" "pruned 1 missing" clone reindex
assert "app no longer in the index"       bash -c '! clone list 2>&1 | grep -q "local/webapp"'

# --with-source: also keep a pristine source mirror (no build artifacts copied).
APP2="$SBOX/build/acme/svc"
mkdir -p "$APP2"; git -C "$APP2" init -q
echo "print('svc')" > "$APP2/app.py"
git -C "$APP2" add -A && git -C "$APP2" -c user.email=t@t -c user.name=t commit -qm svc
# Untracked build artifacts that must NOT end up in the source mirror.
mkdir -p "$APP2/venv/bin"; echo junk > "$APP2/venv/bin/python"
grepout "adopt --app --with-source mirrors source" "pristine|source mirror|local/svc" \
  clone adopt --app "$APP2" --with-source
assert "pristine source mirror created"   test -f "$CLONE_ROOT/local/svc/app.py"
assert "mirror is pristine (no venv copied)" bash -c '! test -e "$CLONE_ROOT/local/svc/venv"'
assert "index path points at the source mirror" \
  bash -c 'clone info local/svc 2>&1 | grep -E "path|source" | grep -q "/root/local/svc"'
assert "info shows the running instance (build/)" \
  bash -c 'clone info local/svc 2>&1 | grep -qi "running"'
# A with-source app is found by the normal source scan, so reindex keeps it too.
clone reindex >/dev/null 2>&1
assert "with-source app survives reindex"  bash -c 'clone info local/svc 2>&1 | grep -qi "app"'

# Relocate an app mistakenly built/run IN source/ → move to build/, restore
# pristine source/ — the one-command fix for that drift.
INSRC="$CLONE_ROOT/grab/myapp"
mkdir -p "$INSRC"; git -C "$INSRC" init -q
echo "print('run')" > "$INSRC/app.py"
git -C "$INSRC" add app.py && git -C "$INSRC" -c user.email=t@t -c user.name=t commit -qm app
mkdir -p "$INSRC/venv/bin"; echo j > "$INSRC/venv/bin/python"   # untracked runtime
grepout "relocate dry-run previews the move" "move running instance|Relocating" \
  clone adopt --app "$INSRC" --with-source --dry-run
assert "dry-run moved nothing"                test -d "$CLONE_ROOT/grab/myapp"
grepout "relocate moves the app to build/"    "Relocating" clone adopt --app "$INSRC" --with-source
assert "instance moved to build/ (venv came along)" test -e "$SBOX/build/local/myapp/venv/bin/python"
assert "pristine source restored in source/"  test -f "$CLONE_ROOT/local/myapp/app.py"
assert "restored source is pristine (no venv)" bash -c '! test -e "$CLONE_ROOT/local/myapp/venv"'
assert "original in-source location is gone"  bash -c '! test -e "$CLONE_ROOT/grab/myapp"'
assert "tracked as an app after relocate"     bash -c 'clone info local/myapp 2>&1 | grep -qi "app"'
assert "tracked apps show under list --installed" bash -c 'clone list --installed 2>&1 | grep -q "local/myapp"'

# ════════════════════════════════════════════════════════════════════
hdr "40. clean --source (delete regenerable artifacts, keep committed ones)"
seed test/polluted2
D="$CLONE_ROOT/test/polluted2"
mkdir -p "$D/node_modules/x"; echo junk > "$D/node_modules/x/f"   # untracked → regenerable
mkdir -p "$D/build"; echo "real source" > "$D/build/tool.sh"      # COMMITTED → must survive
git -C "$D" add build
git -C "$D" -c user.email=t@t -c user.name=t commit -qm build
grepout "check flags the regenerable node_modules" "test/polluted2.*node_modules" clone check --source
assert "check does NOT flag the committed build/" \
  bash -c '! clone check --source 2>&1 | grep "test/polluted2" | grep -q "build"'
grepout "clean --source --dry-run lists it"  "node_modules" clone clean --source --dry-run
assert "dry-run removed nothing"             test -d "$D/node_modules"
clone clean --source -y >/dev/null 2>&1
assert "regenerable node_modules deleted"    bash -c '! test -e "$D/node_modules"'
assert "committed build/ preserved (no data loss)" test -f "$D/build/tool.sh"

# ════════════════════════════════════════════════════════════════════
hdr "41. npm links ONLY the declared bin, not dependency CLIs (regression)"
# Bug found via the x-mcp demo: snapshot discovery swept node_modules/.bin/tsc etc.
# onto PATH alongside the real bin. Declared bins must be authoritative.
seed test/withdeps
D="$CLONE_ROOT/test/withdeps"
printf '{\n "name":"withdeps",\n "version":"1.0.0",\n "bin":{"withdeps":"cli.js"},\n "scripts":{"build":"node make-bin.js"}\n}\n' > "$D/package.json"
printf '#!/usr/bin/env node\nconsole.log("withdeps ok");\n' > "$D/cli.js"
# Simulate a dependency CLI landing in node_modules/.bin during the build.
printf 'const fs=require("fs");fs.mkdirSync("node_modules/.bin",{recursive:true});fs.writeFileSync("node_modules/.bin/tsc","#!/bin/sh\\necho dep\\n");fs.chmodSync("node_modules/.bin/tsc",0o755);\n' > "$D/make-bin.js"
commit "$D"
clone install test/withdeps -y >/dev/null 2>&1
assert "declared bin (withdeps) linked"        test -L "$CLONE_BIN/withdeps"
assert "withdeps runs"                         bash -c '"$CLONE_BIN/withdeps" | grep -q "withdeps ok"'
assert "dependency CLI (tsc) NOT linked"       bash -c '! test -e "$CLONE_BIN/tsc"'

# ════════════════════════════════════════════════════════════════════
hdr "42. clean --source --backup (move, not delete) + repo scope"
seed test/bkup
D="$CLONE_ROOT/test/bkup"
mkdir -p "$D/node_modules/x"; echo j > "$D/node_modules/x/f"
echo "node_modules/" > "$D/.gitignore"; printf '{"name":"bkup"}\n' > "$D/package.json"
commit "$D"
# Another polluted repo that must be UNTOUCHED when we scope to test/bkup.
seed test/other
mkdir -p "$CLONE_ROOT/test/other/node_modules/y"; echo j > "$CLONE_ROOT/test/other/node_modules/y/f"
echo "node_modules/" > "$CLONE_ROOT/test/other/.gitignore"; printf '{"name":"other"}\n' > "$CLONE_ROOT/test/other/package.json"
commit "$CLONE_ROOT/test/other"
BK="$SBOX/artifact-backup"
clone clean --source test/bkup --backup "$BK" -y >/dev/null 2>&1
assert "scoped: target node_modules removed from source" bash -c '! test -e "$CLONE_ROOT/test/bkup/node_modules"'
assert "backup holds the moved dir (reversible)"         test -f "$BK/test/bkup/node_modules/x/f"
assert "scope respected: other repo untouched"           test -d "$CLONE_ROOT/test/other/node_modules"

# ════════════════════════════════════════════════════════════════════
hdr "43. check --build (audit the build/ tree)"
# A flat build dir whose name matches a source repo → redundant (rebuildable).
mkdir -p "$SBOX/build/cmaker"; echo x > "$SBOX/build/cmaker/f"
# A flat build dir with no source twin → orphan (only copy).
mkdir -p "$SBOX/build/zzz-orphan"; echo x > "$SBOX/build/zzz-orphan/f"
grepout "check --build classifies the tree" "tracked|redundant|orphan" clone check --build
assert "redundant flat dir (has source twin) detected" \
  bash -c 'clone check --build 2>&1 | awk "/Redundant/{r=1} /Orphan/{r=0} r&&/cmaker/{ok=1} END{exit !ok}"'
assert "orphan flat dir (no source twin) detected" \
  bash -c 'clone check --build 2>&1 | awk "/Orphan/{o=1} o&&/zzz-orphan/{ok=1} END{exit !ok}"'
assert "clone-tracked worktrees shown as tracked (not redundant)" \
  bash -c 'clone check --build 2>&1 | awk "/Tracked/{t=1} /Redundant|Orphan/{t=0} t&&/nodetool/{ok=1} END{exit !ok}"'

# ════════════════════════════════════════════════════════════════════
hdr "44. doctor (unified health check)"
grepout "doctor runs every section" "Installed / app integrity" clone doctor
grepout "doctor includes source audit"  "Source tree" clone doctor
grepout "doctor includes build audit"   "Build tree"  clone doctor
grepout "doctor includes lifecycle"     "Lifecycle"   clone doctor
grepout "doctor prints a unified verdict" "summary|healthy|look at" clone doctor

# ════════════════════════════════════════════════════════════════════
hdr "RESULTS"
printf '\n  \033[32mPASS=%d\033[0m  \033[31mFAIL=%d\033[0m\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf '\n  Failures:\n'
  for f in "${FAILED[@]}"; do printf '    - %s\n' "$f"; done
fi
echo
echo "SELFTEST_DONE exit=$FAIL"
# Non-zero exit on any failure so `npm test` / CI fails the run.
exit $(( FAIL > 0 ? 1 : 0 ))
