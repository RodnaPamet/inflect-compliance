#!/bin/sh
set -e

echo "╔══════════════════════════════════════════╗"
echo "║  Inflect Compliance — Container Start    ║"
echo "╚══════════════════════════════════════════╝"

# ── 1. Apply Prisma migrations (idempotent) ──
#
# Runs the CLI ALREADY IN THE IMAGE, the same way this script runs
# `next` at the end. `prisma` is a production dependency (^7.9.1), so it
# survives `npm prune --omit=dev` and the binary is at
# `node_modules/.bin/prisma`.
#
# This replaced `npx --yes prisma@7.8.0`, for three reasons:
#
#   1. It FETCHED. An explicit version that differs from the installed
#      one sends npx to the registry, so every container start
#      downloaded and tar-extracted a second copy of the CLI. Verified
#      on the running production container — the artefact is still there
#      at ~/.npm/_npx/<hash>/node_modules/prisma.
#
#   2. That extraction is the only thing in the runner that exercises
#      npm's bundled `tar`, which CVE-2026-73566 (HIGH, DoS via a
#      crafted long-path archive) now affects. No npm release fixes it:
#      npm 12.0.2 still vendors tar 7.5.19 even though 7.5.21 shipped a
#      month earlier, because bundled deps freeze at publish time.
#      Removing the fetch removes the reachability.
#
#   3. The pin had drifted from the thing it claimed to match. The
#      comment here said "pin the CLI version to match @prisma/client",
#      while pinning 7.8.0 against a declared ^7.9.1 — so it fetched an
#      OLDER CLI than the one already present. Using the local binary
#      makes the version match structural instead of asserted.
#
# Prisma 7 — connection URLs are NOT in the schema any more (they moved
# to `prisma.config.ts` at the repo root). The CLI auto-discovers that
# config from the cwd, so `--schema` is redundant but kept explicit.
# Proved against the production image before this change: the local
# 7.9.1 binary loads prisma.config.ts, resolves the multi-file schema,
# connects, and reads all 255 migrations.
echo ""
echo "→ Applying database migrations..."
./node_modules/.bin/prisma migrate deploy --schema=./prisma/schema
echo "✓ Migrations applied"

# ── 1b. Seed self-assessment library content (idempotent) ──
#
# The NIS2 gap-assessment + AI-governance question sets live in global
# reference tables populated from fixtures, NOT by migrations. Migrations
# create the empty tables; without this step a fresh (or pre-existing, since
# these sets were added after the initial seed) production DB serves ZERO
# questions and the onboarding wizard's self-assessment steps render blank.
# The seeder is upsert-only + confined to those global tables, so it is safe
# to re-run on every start. Non-fatal: a seed hiccup must never block the app.
echo ""
echo "→ Seeding self-assessment library content..."
node dist/seed-self-assessments.mjs || echo "⚠ self-assessment seed skipped (non-fatal)"

# ── 1c. Seed the global policy-template library (idempotent) ──
#
# Same rationale as 1b: the global PolicyTemplate rows come from vendored
# fixtures via prisma/seed.ts (not run on prod deploys), so templates added to a
# fixture never reach an already-seeded env. Upsert-only over the global
# template fixtures — safe to re-run. Non-fatal.
echo ""
echo "→ Seeding policy-template library..."
node dist/seed-policy-templates.mjs || echo "⚠ policy-template seed skipped (non-fatal)"

# ── 1d. Seed built-in vendor-assessment questionnaires (idempotent) ──
#
# The Supplier Due Diligence + Supplier Security Assessment templates are
# RLS-tenant-scoped VendorAssessmentTemplate rows, seeded per-tenant from
# vendored fixtures. prisma/seed.ts (not run on prod) only seeds the demo
# tenant, so existing tenants never receive them otherwise. Upsert-by-existence
# over every tenant — safe to re-run. Non-fatal.
echo ""
echo "→ Seeding vendor-assessment questionnaires..."
node dist/seed-vendor-questionnaires.mjs || echo "⚠ vendor-questionnaire seed skipped (non-fatal)"

# ── 1e. Seed authored control-template tasks (idempotent) ──
#
# The authored task content on global ControlTemplate rows lives in
# prisma/fixtures/internal-controls.json. prisma/seed.ts is not run on prod
# deploys, so authored tasks would otherwise never reach an already-seeded
# environment — and until 2026-09-04 they reached NO environment, because the
# seed loop read that fixture through a cast with no `tasks` field and wrote
# ControlTemplateTask nowhere.
#
# Writes go through reconcileTemplateTasks: contentHash-keyed, update-in-place,
# deprecate-by-absence, never delete. Safe to re-run. Non-fatal.
echo ""
echo "→ Seeding control-template tasks..."
node dist/seed-control-template-tasks.mjs || echo "⚠ control-template task seed skipped (non-fatal)"

# ── 2. Create upload directory if missing ──
FILE_DIR="${FILE_STORAGE_ROOT:-/data/uploads}"
mkdir -p "$FILE_DIR" 2>/dev/null || true
echo "✓ Upload directory ready: $FILE_DIR"

# ── 3. Start Next.js ──
echo ""
echo "→ Starting Next.js server on port ${PORT:-3000}..."
exec node_modules/.bin/next start -p "${PORT:-3000}" -H "${HOSTNAME:-0.0.0.0}"
