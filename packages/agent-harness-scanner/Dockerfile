# The harness scanner's container (#3686, owner decisions of 2026-10-19 on that
# issue): built and smoke-tested in CI. A client builds it from a checkout of
# this repository, at its root. The one published copy is Inflect's own, pushed
# by digest to the repository's private GHCR package by the dispatch-only
# `.github/workflows/scanner-image.yml` for the production VM (owner decision,
# 2026-10-20):
#
#   docker build -f packages/agent-harness-scanner/Dockerfile -t agent-harness-scanner .
#
# Running it, its configuration and the environment it reads are in
# packages/agent-harness-scanner/README.md, Container.
#
# WHAT IT HOLDS, AND NOTHING ELSE. The scanner's source, the eight application
# modules it imports (the wire contract and what that imports), and the four
# packages the image's own manifest pins exactly: tsx, which runs it; the
# TypeScript parser the `code` source reads JavaScript and TypeScript with;
# js-yaml, which the `cicd` source reads workflow files with; and zod. The build context is limited to those files by `Dockerfile.dockerignore`
# beside this file, and the COPY lines below name the same set. Both are held
# to the import closure of `src/cli.ts` by
# tests/unit/agent-harness-scanner/scanner-image.test.ts, so a contract module that
# gains an import fails a test rather than the image's first start.
#
# The base image is pinned by digest. This image runs in a client's estate and
# holds the key its reports are signed with, so the bytes a client builds are
# the bytes CI scanned. Dependabot proposes the digest's updates.

# ─── Stage 1: the four packages, from the image's own lockfile ───
FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS deps
WORKDIR /app
COPY packages/agent-harness-scanner/container/package.json packages/agent-harness-scanner/container/package-lock.json ./
# `npm ci`: exactly the lockfile's tree, or a failure. No install script runs:
# esbuild's only checks the platform binary that its optional dependency
# already installed.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ─── Stage 2: the runtime ───
FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS runtime

# No package manager at run time: the scanner installs nothing, and npm's own
# bundled dependencies are the image's largest source of Trivy findings.
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm \
           /usr/local/bin/npx \
           /usr/local/bin/corepack \
           /root/.npm \
    && ! command -v npm \
    && ! command -v npx

WORKDIR /app
ENV NODE_ENV=production
# tsx caches what it compiles under the temporary directory. The image runs
# with a read-only root filesystem, so it compiles each start instead.
ENV TSX_DISABLE_CACHE=1

COPY --from=deps /app/node_modules ./node_modules
COPY packages/agent-harness-scanner/container/package.json packages/agent-harness-scanner/container/tsconfig.json ./
COPY packages/agent-harness-scanner/src ./packages/agent-harness-scanner/src
COPY src/lib/agentic/harness-contract.ts src/lib/agentic/harness-contract-rules.ts src/lib/agentic/harness-findings.ts src/lib/agentic/harness-ladder.ts ./src/lib/agentic/
COPY src/lib/audit-redact.ts src/lib/canonical-json.ts ./src/lib/
COPY src/lib/mcp/receipt-verification.ts ./src/lib/mcp/
COPY src/lib/security/cidr.ts ./src/lib/security/

# The image's `node` user, never root. Nothing under /app is writable by it.
USER node

# `node --import tsx` runs the scanner in this one process, so the signal
# `docker stop` sends reaches the scanner rather than a wrapper.
ENTRYPOINT ["node", "--import", "tsx", "/app/packages/agent-harness-scanner/src/cli.ts"]
CMD ["schedule", "--config", "/etc/agent-harness-scanner/config.json"]
