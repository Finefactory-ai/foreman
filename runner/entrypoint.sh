#!/bin/sh
# The runner image's entrypoint. It runs as the foreman user. Started as root (on Fly.io, or
# when the volume at /work belongs to root), it first gives /work to foreman, then starts
# itself again as foreman.
#
# Claude Code is not in the image: `claude` here fetches it into /work on first use
# (runner/claude.sh). Asking for its version before the run starts does that fetch once, so
# story sessions that start together never race to fetch it.
set -e
if [ "$(id -u)" = 0 ]; then
  chown foreman:foreman /work
  exec setpriv --reuid=foreman --regid=foreman --init-groups "$0" "$@"
fi
claude --version > /dev/null
exec foreman cloud run "$@"
