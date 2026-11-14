#!/usr/bin/env bash
# Self-hosted Postgres → S3 nightly dump.
#
# NOT DEPLOYED. The production database is the Postgres container in
# deploy/docker-compose.prod.yml, and its backup today is a daily disk
# snapshot. This script is rung 2 of the DR ladder in
# docs/disaster-recovery.md ("a scheduled dump off the VM"), kept in the
# repo for whoever turns it on. No restore-validation script exists for
# these dumps; docs/disaster-recovery.md holds the DR posture and the
# runbook for restoring from a disk snapshot.
#
# THE OUTPUT IS pg_dump CUSTOM FORMAT, named `.dump` (`.dump.gpg` when
# encrypted). It is NOT gzipped SQL: `gunzip | psql` does not restore it.
# Restore with pg_restore (decrypt first if it ends in .gpg):
#
#   pg_restore --no-owner --no-privileges -d <database> <file>.dump
#
# Schedule via cron on the deploy host (1am local, daily):
#
#   0 1 * * * /path/to/pg-dump-to-s3.sh \
#               > /var/log/inflect-pg-dump.log 2>&1
#
# Required env (set in cron environment or sourced from /etc/inflect/backup.env):
#   PG_HOST                 — e.g. 127.0.0.1 (or the compose service name)
#   PG_PORT                 — default 5432
#   PG_USER                 — superuser-or-equivalent
#   PG_PASSWORD             — exposed via PGPASSWORD env var below
#   PG_DATABASE             — default inflect_compliance
#   S3_BUCKET               — destination bucket (give it SSE-S3 default
#                             encryption; this script only reports the
#                             encryption the uploaded object carries)
#   S3_PREFIX               — default: pg-backups
#   AWS_REGION              — default: us-east-1
#   GPG_RECIPIENT           — optional. If set, the dump is GPG-encrypted
#                             before upload (defence in depth on top of S3
#                             SSE).
#
# Required tooling: pg_dump (matching server major version), aws cli,
# gpg (only if GPG_RECIPIENT is set).
#
# Retention: enforced server-side via S3 lifecycle, not by this script. Set
# the bucket's lifecycle configuration to expire `pg-backups/*` after 30 days.

set -euo pipefail

# ─── Defaults + required env ───
: "${PG_HOST:?PG_HOST must be set}"
: "${PG_PORT:=5432}"
: "${PG_USER:?PG_USER must be set}"
: "${PG_PASSWORD:?PG_PASSWORD must be set}"
: "${PG_DATABASE:=inflect_compliance}"
: "${S3_BUCKET:?S3_BUCKET must be set}"
: "${S3_PREFIX:=pg-backups}"
: "${AWS_REGION:=us-east-1}"

# ─── Tooling check ───
for tool in pg_dump aws; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "FATAL: required tool not found: $tool" >&2
        exit 2
    fi
done

if [ -n "${GPG_RECIPIENT:-}" ]; then
    if ! command -v gpg >/dev/null 2>&1; then
        echo "FATAL: GPG_RECIPIENT set but gpg is not installed" >&2
        exit 2
    fi
fi

# ─── Naming + paths ───
TIMESTAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
HOSTNAME="$(hostname -s 2>/dev/null || echo unknown)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# `.dump`, not `.sql.gz`: --format=custom below writes pg_dump's own archive
# format (compressed internally), which pg_restore reads and psql does not.
DUMP_FILE="$TMPDIR/${PG_DATABASE}_${TIMESTAMP}.dump"
S3_KEY="${S3_PREFIX}/${PG_DATABASE}/${TIMESTAMP}_${HOSTNAME}.dump"

if [ -n "${GPG_RECIPIENT:-}" ]; then
    DUMP_FILE="${DUMP_FILE}.gpg"
    S3_KEY="${S3_KEY}.gpg"
fi

echo "═══════════════════════════════════════════════════════════════"
echo "  pg_dump → S3"
echo "  Source: $PG_USER@$PG_HOST:$PG_PORT/$PG_DATABASE"
echo "  Target: s3://$S3_BUCKET/$S3_KEY"
[ -n "${GPG_RECIPIENT:-}" ] && echo "  GPG:    enabled (recipient: $GPG_RECIPIENT)"
echo "═══════════════════════════════════════════════════════════════"

# ─── Dump → compress → (optionally encrypt) → upload ───
export PGPASSWORD="$PG_PASSWORD"

echo ""
echo "── 1. pg_dump (custom format, compressed internally) ──"
if [ -n "${GPG_RECIPIENT:-}" ]; then
    pg_dump \
        -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" \
        --format=custom \
        --compress=9 \
        --no-owner \
        --no-privileges \
        | gpg --batch --yes --trust-model always \
              --encrypt --recipient "$GPG_RECIPIENT" \
              --output "$DUMP_FILE"
else
    pg_dump \
        -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" \
        --format=custom \
        --compress=9 \
        --no-owner \
        --no-privileges \
        --file="$DUMP_FILE"
fi

unset PGPASSWORD

DUMP_SIZE_BYTES="$(stat -c%s "$DUMP_FILE" 2>/dev/null || stat -f%z "$DUMP_FILE")"
echo "✓ Dumped: $DUMP_SIZE_BYTES bytes"

if [ "$DUMP_SIZE_BYTES" -lt 1024 ]; then
    echo "FATAL: dump file is suspiciously small (<1KB) — likely a failed dump" >&2
    exit 3
fi

# ─── Upload to S3 ───
echo ""
echo "── 2. Upload to s3://$S3_BUCKET/$S3_KEY ──"
aws s3 cp "$DUMP_FILE" "s3://$S3_BUCKET/$S3_KEY" \
    --region "$AWS_REGION" \
    --no-progress \
    --metadata "source-host=$HOSTNAME,source-database=$PG_DATABASE,timestamp=$TIMESTAMP"

echo "✓ Upload complete"

# ─── Sanity-check the upload ───
echo ""
echo "── 3. Verify upload ──"
aws s3api head-object \
    --bucket "$S3_BUCKET" \
    --key "$S3_KEY" \
    --region "$AWS_REGION" \
    --output text \
    --query "{size: ContentLength, sse: ServerSideEncryption}" \
    | awk '{ printf "  size=%s  sse=%s\n", $1, $2 }'

echo ""
echo "✓ pg_dump backup complete"
echo ""
echo "Note: 30-day retention is enforced server-side via S3 lifecycle."
echo "      Verify with:"
echo "        aws s3api get-bucket-lifecycle-configuration --bucket $S3_BUCKET"
