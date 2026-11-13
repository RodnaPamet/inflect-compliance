/**
 * #5070 — re-encrypt the GLOBAL PII columns under the current primary KEK.
 *
 * The per-tenant rotation job (`POST /api/t/{slug}/admin/key-rotation`) cannot
 * do this. Its sweep skips any model with no `tenantId` column, deliberately:
 * a per-tenant sweep over a global table would either run once per tenant or
 * race with itself. `User` and `Account` are those tables, and until this
 * script existed NOTHING re-encrypted them — `scripts/backfill-encryption.ts`
 * skips values that are already encrypted, and the manifest sweep only walks
 * `ENCRYPTED_FIELDS`, which these columns are not in.
 *
 * So the runbook's "every tenant reports zero v1 rows, remove
 * DATA_ENCRYPTION_KEY_PREVIOUS" was true of the manifest and false of the
 * database, and the next read of `User.email` after that step returned null
 * for the whole deployment, recoverable only with the archived old key.
 *
 * ## Where this goes in the rotation
 *
 *   1. LOOKUP_HASH_KEY pinned to the outgoing key (#5071).
 *   2. Deploy the new DATA_ENCRYPTION_KEY with the old as _PREVIOUS.
 *   3. Per tenant: POST .../admin/key-rotation  ← tenant-scoped columns
 *   4. THIS SCRIPT, once                        ← global PII columns
 *   5. Only when 3 AND 4 report zero v1 rows: remove _PREVIOUS.
 *
 * ## Usage
 *
 *   npx tsx scripts/rotate-global-pii.ts              # dry run: counts only
 *   npx tsx scripts/rotate-global-pii.ts --execute    # rewrite
 *
 * Idempotent, and safe to re-run after a partial failure: it selects only
 * `v1:%` rows and each UPDATE is conditional on the value it read, so a row a
 * concurrent writer has already moved on is left alone.
 *
 * It never prints a plaintext, a ciphertext or any key material — only model,
 * column and counts.
 */
import { prisma } from '@/lib/prisma';
import {
    PII_ENCRYPTED_COLUMNS,
    PII_GLOBAL_MODELS,
} from '@/lib/security/pii-middleware';
import { rotateGlobalPiiColumns } from '@/app-layer/jobs/key-rotation';

async function countV1(model: string, column: string): Promise<number> {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*)::bigint AS n FROM "${model}" WHERE "${column}" LIKE 'v1:%'`,
    );
    return Number(rows[0]?.n ?? 0);
}

async function main(): Promise<void> {
    const execute = process.argv.slice(2).includes('--execute');

    // The dry run COUNTS and writes nothing — it does not call the sweep with
    // a flag, because a sweep that takes a "don't write" flag is a sweep one
    // careless edit away from writing during a dry run.
    if (!execute) {
        let total = 0;
        for (const model of PII_GLOBAL_MODELS) {
            for (const column of PII_ENCRYPTED_COLUMNS[model] ?? []) {
                const n = await countV1(model, column);
                total += n;
                console.log(`[rotate-global-pii] ${model}.${column}: ${n} v1 row(s)`);
            }
        }
        console.log(
            `[rotate-global-pii] DRY RUN — ${total} row(s) would be rewritten. `
                + 'Re-run with --execute.',
        );
        return;
    }

    const result = await rotateGlobalPiiColumns();
    for (const f of result.perField) {
        console.log(
            `[rotate-global-pii] ${f.model}.${f.field}: scanned=${f.scanned} `
                + `rewritten=${f.rewritten} errors=${f.errors}`,
        );
    }
    console.log(
        `[rotate-global-pii] done — scanned=${result.scanned} `
            + `rewritten=${result.rewritten} errors=${result.errors}`,
    );

    // A non-zero exit on errors, so an operator following the runbook cannot
    // read a partial sweep as a completed one and go on to remove the previous
    // key. That removal is the irreversible step.
    if (result.errors > 0) {
        console.error(
            `[rotate-global-pii] ${result.errors} row(s) FAILED — do NOT remove `
                + 'DATA_ENCRYPTION_KEY_PREVIOUS until this reports zero.',
        );
        process.exitCode = 1;
    }
}

main()
    .catch((err) => {
        console.error('[rotate-global-pii] FAILED:', err instanceof Error ? err.message : err);
        process.exitCode = 1;
    })
    .finally(() => {
        void prisma.$disconnect();
    });
