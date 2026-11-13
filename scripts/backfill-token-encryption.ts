/**
 * Backfill Token Encryption Script
 *
 * Encrypts existing plaintext access_token / refresh_token values in the
 * Account table into the new accessTokenEncrypted / refreshTokenEncrypted
 * columns. Optionally nulls plaintext columns after verified migration.
 *
 * Features:
 *   - Dry-run mode (default): counts and previews without writing
 *   - Idempotent: safely skips already-encrypted rows
 *   - Per-row roundtrip verification: decrypts ciphertext and compares
 *   - Per-row error isolation: failures don't corrupt other rows
 *   - Plaintext nulling: --null-plaintext removes plaintext after verified write
 *   - Never logs plaintext token values
 *
 * Usage:
 *   npx tsx scripts/backfill-token-encryption.ts              # dry-run
 *   npx tsx scripts/backfill-token-encryption.ts --execute     # encrypt
 *   npx tsx scripts/backfill-token-encryption.ts --execute --null-plaintext  # encrypt + null
 *
 * Safety:
 *   The script uses $executeRawUnsafe to bypass the PII middleware (which
 *   would double-encrypt). It reads via $queryRawUnsafe for the same reason.
 */

const { encryptField: _encryptField, decryptField: _decryptField, isEncryptedValue: _isEncryptedValue } = require('../src/lib/security/encryption');

const BATCH_SIZE = 100;

// ─── Types ──────────────────────────────────────────────────────────

interface AccountRow {
    id: string;
    access_token: string | null;
    refresh_token: string | null;
    accessTokenEncrypted: string | null;
    refreshTokenEncrypted: string | null;
    provider: string;
}

interface MigrationStats {
    total: number;
    migrated: number;
    skipped: number;
    failed: number;
    alreadyDone: number;
    failedIds: string[];
}

// ─── Pure Logic (testable without DB) ───────────────────────────────

function needsMigration(row: AccountRow): boolean {
    // Row needs migration if it has plaintext tokens but no encrypted versions
    const hasPlaintextAccess = !!row.access_token && !_isEncryptedValue(row.access_token);
    const hasPlaintextRefresh = !!row.refresh_token && !_isEncryptedValue(row.refresh_token);
    const missingEncAccess = !row.accessTokenEncrypted || !_isEncryptedValue(row.accessTokenEncrypted);
    const missingEncRefresh = !row.refreshTokenEncrypted || !_isEncryptedValue(row.refreshTokenEncrypted);

    return (hasPlaintextAccess && missingEncAccess) ||
           (hasPlaintextRefresh && missingEncRefresh);
}

// ─── DB Operations (only used when running as script) ───────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchBatch(prisma: any, offset: number): Promise<AccountRow[]> {
    return prisma.$queryRawUnsafe(
        `SELECT "id", "access_token", "refresh_token",
                "accessTokenEncrypted", "refreshTokenEncrypted",
                "provider"
         FROM "Account"
         ORDER BY "id" ASC
         LIMIT $1 OFFSET $2`,
        BATCH_SIZE,
        offset,
    );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function migrateRow(prisma: any, row: AccountRow, nullPlaintext: boolean): Promise<boolean> {
    const updates: string[] = [];
    const values: (string | null)[] = [row.id]; // $1 = id
    let paramIdx = 2;

    // ── Encrypt access_token ──
    if (row.access_token && !_isEncryptedValue(row.access_token)) {
        if (!row.accessTokenEncrypted || !_isEncryptedValue(row.accessTokenEncrypted)) {
            const encrypted = _encryptField(row.access_token);

            // Roundtrip verification
            const decrypted = _decryptField(encrypted);
            if (decrypted !== row.access_token) {
                throw new Error(`Roundtrip verification failed for access_token on Account ${row.id}`);
            }

            updates.push(`"accessTokenEncrypted" = $${paramIdx++}`);
            values.push(encrypted);

            if (nullPlaintext) {
                updates.push(`"access_token" = $${paramIdx++}`);
                values.push(null);
            }
        }
    }

    // ── Encrypt refresh_token ──
    if (row.refresh_token && !_isEncryptedValue(row.refresh_token)) {
        if (!row.refreshTokenEncrypted || !_isEncryptedValue(row.refreshTokenEncrypted)) {
            const encrypted = _encryptField(row.refresh_token);

            // Roundtrip verification
            const decrypted = _decryptField(encrypted);
            if (decrypted !== row.refresh_token) {
                throw new Error(`Roundtrip verification failed for refresh_token on Account ${row.id}`);
            }

            updates.push(`"refreshTokenEncrypted" = $${paramIdx++}`);
            values.push(encrypted);

            if (nullPlaintext) {
                updates.push(`"refresh_token" = $${paramIdx++}`);
                values.push(null);
            }
        }
    }

    if (updates.length === 0) return false;

    await prisma.$executeRawUnsafe(
        `UPDATE "Account" SET ${updates.join(', ')} WHERE "id" = $1`,
        ...values,
    );

    return true;
}

// ─── Main ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function main(prisma: any, execute: boolean, nullPlaintext: boolean): Promise<MigrationStats> {
    const isDryRun = !execute;
    const stats: MigrationStats = {
        total: 0,
        migrated: 0,
        skipped: 0,
        failed: 0,
        alreadyDone: 0,
        failedIds: [],
    };

    console.log('🔐 Token Encryption Backfill');
    console.log(`   Mode: ${isDryRun ? '🔍 DRY RUN (no writes)' : '⚡ EXECUTE'}`);
    if (execute && nullPlaintext) {
        console.log('   ⚠️  Plaintext nulling ENABLED — plaintext will be removed after verified encryption');
    }
    console.log('');

    let offset = 0;

    while (true) {
        const rows = await fetchBatch(prisma, offset);
        if (rows.length === 0) break;

        for (const row of rows) {
            stats.total++;

            if (!needsMigration(row)) {
                // Already fully migrated or nothing to encrypt
                if (row.accessTokenEncrypted || row.refreshTokenEncrypted) {
                    stats.alreadyDone++;
                } else {
                    stats.skipped++; // No tokens at all
                }
                continue;
            }

            if (isDryRun) {
                stats.migrated++; // Would migrate
                continue;
            }

            // Execute migration with per-row error isolation
            try {
                const didUpdate = await migrateRow(prisma, row, nullPlaintext);
                if (didUpdate) {
                    stats.migrated++;
                } else {
                    stats.skipped++;
                }
            } catch (err) {
                stats.failed++;
                stats.failedIds.push(row.id);
                // Log error without revealing token values
                console.error(`   ❌ Row ${row.id} (${row.provider}): ${(err as Error).message}`);
            }
        }

        offset += BATCH_SIZE;
        if (rows.length < BATCH_SIZE) break;
    }

    // ── Summary ──
    console.log('┌──────────────────────────────────────────┐');
    console.log(`│ Total Account rows scanned:  ${String(stats.total).padStart(10)} │`);
    console.log(`│ ${isDryRun ? 'Would migrate' : 'Migrated'}:               ${String(stats.migrated).padStart(10)} │`);
    console.log(`│ Already encrypted:           ${String(stats.alreadyDone).padStart(10)} │`);
    console.log(`│ Skipped (no tokens):         ${String(stats.skipped).padStart(10)} │`);
    console.log(`│ Failed:                      ${String(stats.failed).padStart(10)} │`);
    console.log('└──────────────────────────────────────────┘');

    if (stats.failedIds.length > 0) {
        console.log(`\n⚠️  Failed row IDs: ${stats.failedIds.join(', ')}`);
    }

    if (isDryRun && stats.migrated > 0) {
        console.log('\n💡 Run with --execute to perform the migration.');
    }

    if (execute && nullPlaintext && stats.migrated > 0) {
        console.log('\n🗑️  Plaintext columns nulled for migrated rows.');
    }

    if (stats.failed > 0) {
        console.log('\n⚠️  Some rows failed. Rerun is safe — successfully migrated rows will be skipped.');
        process.exitCode = 1;
    } else if (execute) {
        console.log('\n✅ Migration complete. All rows verified.');
    }

    return stats;
}

// ─── Exports ────────────────────────────────────────────────────────

// Export pure logic for testing (no DB dependency)
module.exports = { needsMigration, main, BATCH_SIZE };

// ─── Entry Point ────────────────────────────────────────────────────

if (require.main === module) {
    // Only instantiate PrismaClient when running as a standalone script

    const { PrismaClient } = require('@prisma/client');

    const { PrismaPg } = require('@prisma/adapter-pg');
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }) });

    const args = process.argv.slice(2);
    const execute = args.includes('--execute');
    const nullPlaintext = args.includes('--null-plaintext');

    main(prisma, execute, nullPlaintext)
        .catch((e: Error) => {
            console.error('❌ Backfill failed:', e.message);
            process.exit(1);
        })
        .finally(() => prisma.$disconnect());
}
