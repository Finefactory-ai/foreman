# Foreman's container runner (runner/README.md). Build it from the root of a Foreman checkout,
# so the plugin is in the build context:
#
#   docker build -f runner/Dockerfile -t foreman-runner .
#
# Add --build-arg SALESFORCE=1 for the Salesforce tools (the -salesforce image).
#
# No secret goes into the image: every key is passed when the container starts.
FROM node:22.22-bookworm-slim

# Kept equal to CLAUDE_CODE_VERSION in plugin/lib/cloud/versions.mjs (a test checks). Claude Code
# is Anthropic's, so it is not put in the image: /usr/local/bin/claude (runner/claude.sh) fetches
# this version from npm into the volume the first time the container needs it.
ARG CLAUDE_CODE_VERSION=2.1.292

# git, ssh, certificates and ps (procps: the check slots and check jobs read processes with it) from Debian; gh from GitHub's own apt repository.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git gnupg openssh-client procps \
 && install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && apt-get purge -y gnupg \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

# The Salesforce tools, for projects with "pack": "salesforce", only with --build-arg SALESFORCE=1:
# sf, its agent plugin, sfdx-git-delta and Code Analyzer v5, with the Python 3 and Java that
# Code Analyzer's engines need. The versions must stay at or above MIN_VERSIONS in
# plugin/packs/salesforce/doctor-salesforce.mjs (a test checks).
ARG SALESFORCE=0
ARG SF_CLI_VERSION=2.155.7
ARG SF_PLUGIN_AGENT_VERSION=2.2.3
ARG CODE_ANALYZER_VERSION=5.16.0
ARG SGD_VERSION=6.45.1

# sf keeps its plugins in its data dir, under HOME by default; HOME is /root while building and
# /work when running, so a fixed one lets the foreman user see them. Harmless without sf.
ENV SF_DATA_DIR=/opt/sf/data SF_AUTOUPDATE_DISABLE=true SF_DISABLE_TELEMETRY=true

# sfdx-git-delta is not signed by Salesforce, so its install asks first (`echo y`, as its own
# README does). The foreman user (uid 10001) owns the data dir, so sf can add plugins it needs at
# run time. man1 lets openjdk's postinst run on a slim image.
RUN if [ "$SALESFORCE" = 1 ]; then \
      mkdir -p /usr/share/man/man1 "$SF_DATA_DIR" \
   && apt-get update \
   && apt-get install -y --no-install-recommends python3 openjdk-17-jre-headless \
   && rm -rf /var/lib/apt/lists/* \
   && npm install --global "@salesforce/cli@${SF_CLI_VERSION}" \
   && sf plugins install "@salesforce/plugin-agent@${SF_PLUGIN_AGENT_VERSION}" \
   && sf plugins install "@salesforce/plugin-code-analyzer@${CODE_ANALYZER_VERSION}" \
   && echo y | sf plugins install "sfdx-git-delta@${SGD_VERSION}" \
   && chown -R 10001 /opt/sf \
   && npm cache clean --force \
   && rm -rf /root/.cache /root/.sf /root/.sfdx /root/.config/sf /root/.local/share/sf; \
    elif [ "$SALESFORCE" != 0 ]; then echo 'SALESFORCE must be 0 or 1' >&2; exit 1; fi

COPY plugin /opt/foreman/plugin
COPY runner/entrypoint.sh /usr/local/bin/foreman-entrypoint
COPY runner/claude.sh /usr/local/bin/claude
# The licences of the other software in this image (Foreman's own is in the plugin folder).
COPY runner/THIRD-PARTY.md /opt/foreman/THIRD-PARTY.md

RUN chmod 0755 /usr/local/bin/foreman-entrypoint /usr/local/bin/claude \
 && useradd --uid 10001 --home-dir /work --no-create-home --shell /bin/sh foreman \
 && mkdir -p /work \
 && chown foreman:foreman /work

# HOME is on the volume: the Jira sign-in (~/.config/foreman) rotates and must outlive restarts.
ENV FOREMAN_PLUGIN_DIR=/opt/foreman/plugin \
    PATH=/opt/foreman/plugin/bin:$PATH \
    HOME=/work \
    FOREMAN_WORK=/work \
    FOREMAN_DASHBOARD_HOST=0.0.0.0 \
    FOREMAN_TOOLS=/work/.foreman-tools \
    CLAUDE_CODE_VERSION=${CLAUDE_CODE_VERSION} \
    DISABLE_AUTOUPDATER=1

USER foreman
WORKDIR /work
VOLUME /work
EXPOSE 4317
ENTRYPOINT ["foreman-entrypoint"]
