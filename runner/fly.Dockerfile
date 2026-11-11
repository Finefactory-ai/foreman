# Fly.io mounts volumes owned by root, so on Fly the runner starts as root just long enough for
# its entrypoint to give /work to the foreman user, which then runs everything.
FROM ghcr.io/finefactory-ai/foreman-runner:0.12.0
USER root
