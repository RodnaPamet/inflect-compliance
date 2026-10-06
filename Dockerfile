# ─── Stage 1: Dependencies ─────────────────────────────────
FROM node:24-alpine AS deps
WORKDIR /app

# `npm ci` — strict, deterministic install: installs exactly the
# package-lock.json tree and fails if it is out of sync with
# package.json. Never `npm install` in an image build (it can mutate
# the lockfile and resolve fresh versions, defeating reproducibility).
# `patches/` MUST be copied BEFORE `npm ci`. The `postinstall` hook is
# `patch-package`, which applies every patch in that directory — and exits 0
# with "No patch files found" when the directory is absent. So installing first
# and copying patches later (as this stage used to do) produced an image where
# every patch was silently skipped, while the same patch applied correctly
# locally and in CI. That divergence only ever manifests in production, with no
# failing check anywhere. See tests/guards/dockerfile-patch-ordering.test.ts.
COPY package.json package-lock.json ./
COPY patches ./patches
# The workspace manifest, and the failure it prevents is SILENT rather than
# loud. `package.json` declares `workspaces: ["packages/*"]`, so the lockfile
# carries a `packages/ui` node and a `node_modules/@inflect/ui` link entry. The
# design doc predicted `npm ci` would FAIL here without this file. Measured, it
# does not: it exits 0, installs 2004 packages instead of 2005, and simply omits
# `node_modules/@inflect/ui` — so the image would ship a tree where
# `import … from '@inflect/ui'` does not resolve, with nothing red anywhere. With
# this line the link is created (`node_modules/@inflect/ui -> ../../packages/ui`)
# and the count is 2005. The package is empty today, which is exactly why the
# line has to land now: the first moved file would otherwise fail in the builder,
# and the deps stage is the last place anyone would look.
COPY packages/ui/package.json ./packages/ui/
RUN npm ci

# ─── Stage 2: Builder ──────────────────────────────────────
FROM node:24-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Build Next.js (skip env validation — real vars provided at runtime).
# --webpack: build with webpack, NOT Next 16's default Turbopack. The
# strict production CSP (script-src 'nonce-…' 'strict-dynamic', no
# unsafe-eval) needs the bundler runtime to put the nonce on every
# dynamically-loaded chunk. Webpack does (via __webpack_nonce__ →
# script.setAttribute('nonce', …)); Turbopack's runtime sets no nonce and
# relies on strict-dynamic propagation, which left some dynamic chunks
# blocked by script-src-elem. See docs/implementation-notes/2026-06-05-csp-webpack-bundler.md.
ENV SKIP_ENV_VALIDATION=1
ENV NEXT_TELEMETRY_DISABLED=1
# The in-container `next build` OOM'd (JS heap) once the app grew — the PR
# CI Build job already runs with --max-old-space-size=6144, but the
# Dockerfile build had no heap bump, so the GHCR image publish (main-only)
# started failing and prod stopped receiving new images. Match CI headroom
# (runners have 16 GB) for both the Next build and the worker bundle.
ENV NODE_OPTIONS="--max-old-space-size=8192"
# `.next/trace` is Next.js's BUILD-time telemetry trace, ~83 MB on this
# project. Nothing reads it at runtime — there is no reference to it anywhere
# in src/, scripts/ or deploy/.
#
# It was not merely dead weight. Trivy's secret scanner walks every file in
# the image, and an 83 MB blob pushed the scan past its default 5-minute
# deadline:
#     FATAL run error: image scan error: ... context deadline exceeded
# The job then produced no SARIF at all. A security gate that intermittently
# TIMES OUT is worse than a slow one, because the cheapest response to it is
# to re-run until it passes — which is how a gate stops being a gate.
#
# Deleted HERE, in the builder, rather than in the runner stage. The runner
# does `COPY --from=builder /app/.next`, so removing it afterwards would
# shrink the working tree while leaving the bytes sitting in the COPY layer,
# and the image would still carry them.
RUN npx next build --webpack && rm -rf .next/trace

# Build the standalone BullMQ worker + scheduler bundles. esbuild is
# a devDependency, so this MUST run before the prune below. Produces
# self-contained dist/worker.mjs + dist/scheduler.mjs (node_modules
# external) — the `worker` compose service runs these.
RUN npm run build:worker

# Prune dev dependencies before the runner stage copies node_modules.
# Without this, the runtime image carries ts-jest, semantic-release,
# playwright, and friends — including their transitive CVEs (e.g.
# handlebars@4.7.8 via ts-jest) — which Trivy then reports as
# production vulnerabilities even though the runtime never executes
# those modules.
RUN npm prune --omit=dev

# ─── Stage 3: Runner ──────────────────────────────────────
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# System deps for Prisma, carrying an explicit SECURITY FLOOR.
#
# `apk add --no-cache openssl` was not enough, and the reason is Docker, not
# apk. `--no-cache` is an APK flag — "do not keep the package index" — and has
# nothing to do with Docker's layer cache. CI builds with `cache-from:
# type=gha`, so once this layer exists it is restored verbatim and keeps
# shipping whatever Alpine happened to have the day it was built.
#
# That is how CVE-2026-14456 (openssl QUIC DoS, HIGH) came to sit in the
# published image while `apk add openssl` against a current index would have
# fixed it on its own: verified against node:24-alpine, a fresh
# `apk add --no-cache openssl` upgrades libcrypto3/libssl3 3.5.7-r0 -> 3.5.8-r0
# unprompted. The package manager was right; the layer was old.
#
# The floor does two things a bare `add` cannot:
#   • RAISING IT BUSTS THIS LAYER. That is the documented remediation for the
#     next advisory — bump the floor, and every layer from here rebuilds. A
#     one-off edit would clear today's finding and then go stale again, which
#     is the failure being fixed, not a fix for it.
#   • IT FAILS THE BUILD. `apk add "openssl>=X"` exits 1 when Alpine cannot
#     satisfy the constraint (verified), so a version pulled from the repo is
#     loud at build time instead of quietly resolving to something older.
RUN apk add --no-cache "openssl>=3.5.8-r0"

# REMOVE the npm CLI from the runtime image.
#
# This used to `npm install -g npm@<pin>` to get newer copies of the
# packages npm vendors, because Trivy scans them as part of the image and
# no application dependency bump can reach them. That was a treadmill, and
# on 2026-09-30 it stopped moving: `.trivyignore` exempts BY CVE ID, so
# CVE-2026-102276 and CVE-2026-102278 — new ids against the same
# brace-expansion 5.0.7 that was already an accepted risk — re-broke the
# publish gate with no push required. The image had not changed; the
# advisory list had. Three HIGHs, every one of them under
# /usr/local/lib/node_modules/npm/.
#
# The comment that stood here said npm was NOT removable, because
# `scripts/entrypoint.sh` ran `npx --yes prisma@<pin> migrate deploy` on
# every container start. That stopped being true on 2026-08-22, when the
# entrypoint moved to the local binary — and
# `tests/guards/runner-never-invokes-npm.test.ts` was written to lock that
# change in. So the constraint was already gone; only the comment kept it
# alive, and with it the reason nobody revisited this.
#
# Nothing in the runtime needs the CLI. The app is
# `exec node_modules/.bin/next start`, migrations are
# `./node_modules/.bin/prisma migrate deploy`, the seeds are
# `node dist/*.mjs`, and the worker is `node dist/{scheduler,worker}.mjs`.
# `npm` is in neither `dependencies` nor `devDependencies`, and
# `npm prune --omit=dev` above strips the transitive copy, so removing the
# global tree leaves no npm in the image at all.
#
# This is the structural version of the exemptions' own argument. They each
# say the vendored copy is "unreachable because the server never invokes
# the npm CLI" — which is a reason not to SHIP it, not a reason to keep
# exempting it. A package that is absent needs no CVE triage.
#
# `corepack` goes too: it is a package-manager shim with no runtime caller
# here, and leaving it would keep a second vendored tree in the scan.
RUN rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm \
           /usr/local/bin/npx \
           /usr/local/bin/corepack \
           /root/.npm \
    && ! command -v npm \
    && ! command -v npx

# Non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy build output
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma
# Prisma 7 — connection URL config moved out of `datasource db {}`
# in `prisma/schema/base.prisma` into `prisma.config.ts`. The CLI
# (`prisma migrate deploy` from the entrypoint) reads URLs from
# this file. Without it, deploy fails with
# "datasource.url property is required in your Prisma config file".
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts
COPY --from=builder /app/scripts/entrypoint.sh ./scripts/entrypoint.sh
# The compiled BullMQ worker + scheduler bundles — run by the
# `worker` compose service, a separate process from `next start`.
COPY --from=builder /app/dist ./dist

# Ensure entrypoint is executable and upload dir exists
RUN chmod +x ./scripts/entrypoint.sh && \
    mkdir -p /data/uploads && \
    chown -R nextjs:nodejs /app /data/uploads

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

ENTRYPOINT ["./scripts/entrypoint.sh"]
