/**
 * Epic B.2 — Backfill wrapped DEKs for existing tenants.
 *
 * Iterates every tenant with `encryptedDek IS NULL`, generates a
 * random per-tenant DEK, wraps it under the global KEK, and writes
 * it back. Idempotent: a second run scans zero rows because the
 * `NULL` filter excludes everyone we already processed.
 *
 * ## Order-of-deployment
 *   1. Ship the Epic B.2 schema migration (`encryptedDek` column
 *      already added). ✅
 *   2. Ship `createTenantWithDek` wiring so new tenants get a DEK
 *      at creation time. ✅
 *   3. Run this backfill to cover existing tenants.
 *   4. Flip the Epic B.1 encryption middleware to per-tenant DEKs
 *      (next prompt).
 *
 * Running this BEFORE steps 1–2 is also safe — it just processes a
 * smaller set. Running it AFTER step 4 is fine; any remaining NULL
 * tenants would anyway get a lazy DEK on first encrypted write via
 * `getTenantDek`.
 *
 * ## Safety
 *   - `--dry-run` is the default. Writes require `--execute`.
 *   - UPDATE uses `WHERE id = ? AND encryptedDek IS NULL`, so a
 *     race with another writer (another script invocation, or the
 *     lazy-init path) simply no-ops for the loser.
 *   - Never logs DEK bytes. Logs carry `tenantId`, counts, and
 *     error messages only.
 *   - Per-tenant error isolation — one failed row doesn't abort
 *     the loop.
 *
 * ## Usage
 *   npx tsx scripts/generate-tenant-deks.ts                # dry-run
 *   npx tsx scripts/generate-tenant-deks.ts --execute       # backfill
 *   npx tsx scripts/generate-tenant-deks.ts --batch-size 50 # tune
 */


const {
    generateDek: _generateDek,
    wrapDek: _wrapDek,
} = require('../src/lib/security/tenant-keys') as typeof import('../src/lib/security/tenant-keys');


import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// ─── Types ──────────────────────────────────────────────────────────

export interface TenantDekBackfillOptions {
    /** Default false (dry-run). Writes require explicit opt-in. */
    execute: boolean;
    /** SELECT batch size; default 100. */
    batchSize: number;
}

export interface TenantDekBackfillResult {
    scanned: number;
    backfilled: number;
    skippedRaced: number;
    errors: number;
    durationMs: number;
}

/**
 * Minimal Prisma surface the script uses — declared as an explicit
 * interface (not via `Pick<PrismaClient, ...>`) so tests can inject a
 * plain-promise stub without wrestling with PrismaPromise's branded
 * type.
 */
export interface TenantDekBackfillPrisma {
    $queryRawUnsafe<T = unknown>(
        sql: string,
        ...params: unknown[]
    ): Promise<T>;
    $executeRawUnsafe(sql: string, ...params: unknown[]): Promise<number>;
}

export interface TenantDekBackfillDeps {
    prisma: TenantDekBackfillPrisma;
    log: (
        level: 'info' | 'warn' | 'error',
        msg: string,
        fields?: Record<string, unknown>,
    ) => void;
}

// ─── Core ───────────────────────────────────────────────────────────

/**
 * Backfill DEKs for every tenant currently missing one. Returns an
 * aggregate result; never throws for per-row failures (they're
 * counted + logged).
 */
export async function backfillTenantDeks(
    deps: TenantDekBackfillDeps,
    options: TenantDekBackfillOptions,
): Promise<TenantDekBackfillResult> {
    const started = Date.now();
    const batchSize = Math.max(1, options.batchSize);

    const result: TenantDekBackfillResult = {
        scanned: 0,
        backfilled: 0,
        skippedRaced: 0,
        errors: 0,
        durationMs: 0,
    };

    // SELECT excludes tenants that already have a DEK — that's the
    // idempotency gate. ORDER BY id keeps batches stable across a
    // crash-resume so we don't re-scan the same range.
    const selectSql = `
        SELECT id
        FROM "Tenant"
        WHERE "encryptedDek" IS NULL
        ORDER BY id
        LIMIT $1
    `;

    while (true) {
        let rows: Array<{ id: string }>;
        try {
            rows = await deps.prisma.$queryRawUnsafe<Array<{ id: string }>>(
                selectSql,
                batchSize,
            );
        } catch (err) {
            deps.log('error', 'backfill-tenant-deks.select_failed', {
                error: err instanceof Error ? err.message : String(err),
            });
            result.errors++;
            break;
        }

        if (rows.length === 0) break;
        result.scanned += rows.length;

        for (const row of rows) {
            let wrapped: string;
            try {
                const dek = _generateDek();
                wrapped = _wrapDek(dek);
            } catch (err) {
                result.errors++;
                deps.log('error', 'backfill-tenant-deks.wrap_failed', {
                    tenantId: row.id,
                    error: err instanceof Error ? err.message : String(err),
                });
                continue;
            }

            if (!options.execute) {
                // Dry-run — count without writing.
                result.backfilled++;
                continue;
            }

            try {
                const updated = await deps.prisma.$executeRawUnsafe(
                    `UPDATE "Tenant"
                     SET "encryptedDek" = $1
                     WHERE id = $2
                       AND "encryptedDek" IS NULL`,
                    wrapped,
                    row.id,
                );
                if (updated === 1) {
                    result.backfilled++;
                } else {
                    // Another writer won the race (lazy init, parallel
                    // invocation). No data corruption — the tenant has
                    // a DEK, just not ours.
                    result.skippedRaced++;
                }
            } catch (err) {
                result.errors++;
                deps.log('error', 'backfill-tenant-deks.update_failed', {
                    tenantId: row.id,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        deps.log('info', 'backfill-tenant-deks.batch_complete', {
            batchSize: rows.length,
            scannedSoFar: result.scanned,
            backfilledSoFar: result.backfilled,
            skippedRacedSoFar: result.skippedRaced,
        });

        // Short batch = caught up.
        if (rows.length < batchSize) break;
    }

    result.durationMs = Date.now() - started;
    return result;
}

// ─── CLI ────────────────────────────────────────────────────────────

function parseArgs(argv: readonly string[]): TenantDekBackfillOptions {
    const args = argv.slice(2);
    const execute = args.includes('--execute');

    let batchSize = 100;
    const batchArg = args.find((a) => a.startsWith('--batch-size='));
    if (batchArg) {
        const n = parseInt(batchArg.split('=')[1], 10);
        if (!Number.isFinite(n) || n < 1) {
            throw new Error(`Invalid --batch-size: ${batchArg}`);
        }
        batchSize = n;
    }

    return { execute, batchSize };
}

function printReport(
    options: TenantDekBackfillOptions,
    result: TenantDekBackfillResult,
): void {
    const mode = options.execute ? 'EXECUTE' : 'DRY RUN';
    const line = (s: string): void => console.log(s);
    line('');
    line(`── Epic B.2 tenant DEK backfill — ${mode} ──`);
    line('');
    if (!options.execute) {
        line('⚠  No writes performed. Rerun with --execute to persist.');
        line('');
    }
    const verb = options.execute ? 'backfilled' : 'would backfill';
    line(`  scanned:           ${result.scanned}`);
    line(`  ${verb}:        ${result.backfilled}`);
    line(`  skipped (raced):   ${result.skippedRaced}`);
    line(`  errors:            ${result.errors}`);
    line(`  duration:          ${result.durationMs}ms`);
    line('');
    if (result.errors > 0) {
        line(
            '❌ Completed with errors — investigate log lines prefixed `backfill-tenant-deks.` above.',
        );
    } else if (!options.execute) {
        line('✅ Dry run complete. Rerun with --execute to perform the backfill.');
    } else {
        line('✅ Backfill complete.');
    }
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv);
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }) });
    try {
        const deps: TenantDekBackfillDeps = {
            prisma,
            log: (level, msg, fields) => {
                const payload = {
                    component: 'backfill-tenant-deks',
                    ...fields,
                };
                if (level === 'error') console.error(msg, payload);
                else if (level === 'warn') console.warn(msg, payload);
                else console.log(msg, payload);
            },
        };
        const result = await backfillTenantDeks(deps, options);
        printReport(options, result);
        if (result.errors > 0) process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

if (require.main === module) {
    main().catch((err) => {
        console.error('backfill-tenant-deks.fatal', err);
        process.exit(2);
    });
}
