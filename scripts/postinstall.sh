#!/usr/bin/env sh
# Install zsh completions for clone

COMP_SOURCE="$(dirname "$0")/../completions/clone.zsh"

# Only proceed if zsh is available and the completion file exists
if ! command -v zsh >/dev/null 2>&1 || [ ! -f "$COMP_SOURCE" ]; then
  exit 0
fi

# Try user-local and system site-functions directories (in fpath by default)
for dir in \
  "${HOME}/.local/share/zsh/site-functions" \
  "/usr/local/share/zsh/site-functions" \
  "/usr/share/zsh/site-functions"; do

  if [ -d "$dir" ] && [ -w "$dir" ]; then
    cp "$COMP_SOURCE" "$dir/_clone" 2>/dev/null && \
      echo "clone: zsh completions installed to $dir/_clone" && \
      echo "clone: refresh your shell's cache to use them: rm -f ~/.zcompdump* && compinit (or restart your shell)" && \
      exit 0
  fi
done

echo "clone: could not auto-install zsh completions."
echo "clone: run  'clone completions zsh --install'  to install them from the binary,"
echo "clone: then 'rm -f ~/.zcompdump* && compinit'  (or restart your shell)."
