#!/bin/sh
# The runner image's `claude`. Claude Code is Anthropic's and is not part of the image: the
# first time it is needed, this fetches it from npm at the pinned version into the volume, then
# runs it. Later calls run it at once. A new image with another pinned version fetches again.
set -e
dir="${FOREMAN_TOOLS:-/work/.foreman-tools}"
want="${CLAUDE_CODE_VERSION:?CLAUDE_CODE_VERSION is not set}"
real="$dir/bin/claude"
marker="$dir/.claude-code-version"
if [ ! -x "$real" ] || [ "$(cat "$marker" 2>/dev/null)" != "$want" ]; then
  echo "foreman: fetching Claude Code $want from npm (first use)" >&2
  if ! npm install --global --prefix "$dir" --no-audit --no-fund --loglevel=error "@anthropic-ai/claude-code@$want" >&2; then
    echo "foreman: could not fetch Claude Code $want. The runner must be able to reach registry.npmjs.org and write to $dir." >&2
    exit 1
  fi
  echo "$want" > "$marker"
fi
exec "$real" "$@"
