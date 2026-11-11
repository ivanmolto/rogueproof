# RogueProof sandbox: the container that runs the agent's local tools
# (read_file, write_file, run_command) via `docker exec`. Nothing else lives
# here: no agent CLI, no keys, no network client, no package manager.
#
# Plain Debian bookworm + Node, pinned by tag and digest (docs/VERSIONS.md).
# bookworm-slim ships coreutils and dash; it has no curl, wget, git, ssh or
# python, and nothing is installed on top. The build needs no network beyond
# pulling the base image.
FROM node:22.21.1-bookworm-slim@sha256:25b3eb23a00590b7499f2a2ce939322727fcce1b15fdd69754fcd09536a3ae2c

# The container never has a network (compose: network_mode none), so package
# managers are dead weight; removing them keeps "coreutils and nothing else" true.
RUN rm -rf /usr/local/lib/node_modules /opt/yarn-* \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg

# Unprivileged by default; compose overrides the uid with the operator's own so
# files written to the bind mount stay owned by them. The root fs is read-only
# at run time, so HOME points at the tmpfs.
ENV HOME=/tmp
USER node
WORKDIR /work

# Idle. Every tool call is a separate `docker exec` made by the orchestrator.
CMD ["sleep", "infinity"]
