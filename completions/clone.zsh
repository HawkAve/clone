#compdef clone

_clone() {
  local base_dir="${CLONE_ROOT:-$HOME/Dev/Github-Repos/source}"
  local db_dir="$HOME/.config/clone"
  local -a commands=(
    'search:Fuzzy search repos by name, description, topics'
    's:Alias for search'
    'info:Detailed info on a repo (like pacman -Qi)'
    'i:Alias for info'
    'browse:Open the repo on GitHub in the default browser'
    'open:Alias for browse'
    'list:List all repos with optional filters'
    'ls:Alias for list'
    'stats:Summary stats (counts, languages, top starred)'
    'st:Alias for stats'
    'install:Clone, build from source, and link binaries onto PATH'
    'in:Alias for install'
    'uninstall:Unlink built binaries and keep the source'
    'un:Alias for uninstall'
    'remove:Delete a repo, its binaries, and its index entry'
    'rm:Alias for remove'
    'outdated:Show repos with upstream commits (git ls-remote, no fetch)'
    'out:Alias for outdated'
    'orphans:List dependency repos nothing requires anymore'
    'clean:Prune broken bin symlinks, dangling entries, caches'
    'reason:Set install reason (--explicit / --asdeps)'
    'check:Verify installed repos are intact (dir, binaries, git)'
    'owns:Show which indexed repo owns a filesystem path'
    'path:Print a repo directory (cd "$(clone path <repo>)")'
    'changelog:Commits landed upstream since the repo was installed'
    'cl:Alias for changelog'
    'root:Show the repos root directory'
    'create:Create a new local repository under the root'
    'update:Pull latest changes (one or all)'
    'up:Alias for update'
    'reindex:Rebuild index from disk'
    'ri:Alias for reindex'
    'sync:Detect, restructure and index untracked repos'
    'adopt:Organize a repo you cloned yourself into the tree + index it'
    'completions:Print/install shell completion (zsh)'
    'log:Show trending history'
    'trending:View GitHub Trending repos (read-only)'
    't:Alias for trending'
    'missing:Show GitHub Trending repos not yet cloned (optionally clone them)'
    'm:Alias for missing'
    'daily:Clone daily trending repos'
    'weekly:Clone weekly trending repos'
    'monthly:Clone monthly trending repos'
    'all:Clone trending for all periods'
    'help:Show usage'
  )
  local -a list_opts=(
    '--language:Filter by programming language'
    '--owner:Filter by GitHub owner'
    '--recent:Recently cloned (default 7 days)'
    '--trending:Only trending-sourced repos (accepts optional daily|weekly|monthly)'
    '--missing:With --trending: fetch live Trending and show uncloned'
    '--fetch:With --missing: clone the missing repos immediately'
    '--json:With --missing: emit JSON (output-only)'
    '--no-cache:With --missing: bypass the 15-minute trending cache'
    '--source:Filter by source (manual/trending)'
    '--installed:Only repos you have built or installed'
    '-e:Exact match on repo or owner/repo name'
    '--exact:Exact match on repo or owner/repo name'
    '-p:Print full paths instead of table'
    '--full-path:Print full paths instead of table'
    '-l:Verbose card view with full descriptions'
    '--long:Verbose card view with full descriptions'
  )
  local -a trending_opts=(
    '--period:Period (daily|weekly|monthly)'
    '-a:Show all periods'
    '--all:Show all periods (daily, weekly, monthly)'
    '-s:Spoken language code (e.g. en, zh, es)'
    '--spoken:Spoken language code (e.g. en, zh, es)'
    '-n:Limit number of repos shown'
    '--limit:Limit number of repos shown'
    '-j:Emit JSON instead of a table'
    '--json:Emit JSON instead of a table'
    '--no-cache:Bypass the 15-minute trending cache'
  )
  local -a missing_opts=(
    '-f:Clone the missing repos immediately'
    '--fetch:Clone the missing repos immediately'
    '-j:Emit JSON (output-only; disables --fetch)'
    '--json:Emit JSON (output-only; disables --fetch)'
    '--no-cache:Bypass the 15-minute trending cache'
  )
  local -a clone_opts=(
    '--shallow:Shallow clone (depth 1, default)'
    '--deep:Full clone (no --depth)'
    '--bare:Bare clone'
    '--branch:Clone specific branch'
    '--ssh:Clone via SSH instead of HTTPS'
    '--no-recursive:Do not recurse submodules'
    '--partial:Partial clone (blobless or treeless)'
  )

  _arguments '1:command:->cmd' '*::arg:->args'
  case $state in
    cmd)
      _describe 'command' commands
      _describe 'option' clone_opts
      ;;
    args)
      case $words[1] in
        info|i|remove|rm|uninstall|un|install|in|update|up|browse|open|reason|check|changelog|cl|path)
          if [[ -f "$db_dir/clone.db" ]]; then
            local -a repos=(${(f)"$(sqlite3 "$db_dir/clone.db" "SELECT id FROM repos ORDER BY id" 2>/dev/null)"})
            compadd -a repos
          fi
          case $words[1] in
            remove|rm) compadd -- '--dry-run' '-f' '--force' '-s' '--recursive' ;;
            install|in) compadd -- '--build-only' '-f' '--force' '--needed' '-y' '--yes' '--asdeps' '--keep-build' '--ask' ;;
            update|up) compadd -- '--no-rebuild' '--ignore' ;;
            info|i) compadd -- '-r' '--remote' ;;
            reason) compadd -- '-e' '--explicit' '--asdeps' ;;
            check) compadd -- '-a' '--all' '--source' ;;
          esac
          ;;
        owns)
          _files
          ;;
        adopt)
          _files -/
          compadd -- '--in-place' '--app' '--with-source' '--dry-run'
          ;;
        completions)
          compadd zsh
          compadd -- '--install'
          ;;
        outdated|out)
          compadd -- '-a' '--all' '-u' '--update' '--ignore'
          ;;
        orphans)
          compadd -- '--remove' '-y' '--yes'
          ;;
        clean)
          compadd -- '--builds' '--cache' '--duplicates' '--dry-run' '-y' '--yes'
          ;;
        log)
          if [[ -f "$db_dir/clone.db" ]]; then
            local -a repos=(${(f)"$(sqlite3 "$db_dir/clone.db" "SELECT id FROM repos WHERE source='trending' ORDER BY id" 2>/dev/null)"})
            compadd -a repos
          fi
          ;;
        search|s)
          case $words[-2] in
            --sort)
              compadd stars forks updated best-match
              ;;
            --language)
              if [[ -f "$db_dir/clone.db" ]]; then
                local -a langs=(${(f)"$(sqlite3 "$db_dir/clone.db" "SELECT DISTINCT language FROM repos ORDER BY language" 2>/dev/null)"})
                compadd -a langs
              fi
              ;;
            *)
              compadd -- '-l' '--long' '-r' '--remote' '--language' \
                '--topic' '--user' '--stars' '--sort' '-n' '--limit' \
                '-q' '--quiet' '-i' '--interactive'
              ;;
          esac
          ;;
        trending|t)
          # Optional [language] positional + flags. Suggest known langs + options.
          case $words[-2] in
            --period)
              compadd daily weekly monthly
              ;;
            *)
              if [[ -f "$db_dir/clone.db" ]]; then
                local -a langs=(${(f)"$(sqlite3 "$db_dir/clone.db" "SELECT DISTINCT language FROM repos ORDER BY language" 2>/dev/null)"})
                compadd -a langs
              fi
              _describe 'option' trending_opts
              ;;
          esac
          ;;
        missing|m)
          # First positional: optional period. Flags always allowed.
          case $words[2] in
            daily|weekly|monthly)
              _describe 'option' missing_opts
              ;;
            *)
              compadd daily weekly monthly
              _describe 'option' missing_opts
              ;;
          esac
          ;;
        list|ls)
          _describe 'option' list_opts
          case $words[-2] in
            --language)
              if [[ -f "$db_dir/clone.db" ]]; then
                local -a langs=(${(f)"$(sqlite3 "$db_dir/clone.db" "SELECT DISTINCT language FROM repos ORDER BY language" 2>/dev/null)"})
                compadd -a langs
              fi
              ;;
            --owner)
              if [[ -f "$db_dir/clone.db" ]]; then
                local -a owners=(${(f)"$(sqlite3 "$db_dir/clone.db" "SELECT DISTINCT owner FROM repos ORDER BY owner" 2>/dev/null)"})
                compadd -a owners
              fi
              ;;
            --source)
              compadd manual trending
              ;;
            --trending)
              compadd daily weekly monthly
              ;;
            --partial)
              compadd blobless treeless
              ;;
          esac
          ;;
        create)
          compadd -- '--bare'
          ;;
        daily|weekly|monthly|all)
          compadd -- '--dry'
          ;;
      esac
      ;;
  esac
}

compdef _clone clone
