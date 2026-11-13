/**
 * Backfill Encryption Script
 *
 * Populates *Encrypted and *Hash columns from existing plaintext fields.
 * Safe to re-run (idempotent — skips already-encrypted rows).
 *
 * NOT A KEY-ROTATION TOOL (#5244). It skips every value that is already
 * encrypted, so after a DATA_ENCRYPTION_KEY change it re-encrypts nothing.
 * Rotate through DATA_ENCRYPTION_KEY_PREVIOUS and the `key-rotation` job
 * (docs/encryption-data-protection.md, "Key rotation"). For a first-time
 * backfill prefer scripts/encrypt-existing-data.ts, which covers these
 * columns in its PII mode, dry-runs by default and verifies a round trip.
 *
 * Usage: node scripts/backfill-encryption.ts
 */
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { encryptField, hashForLookup, isEncryptedValue } = require('../src/lib/security/encryption');

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }) });

const BATCH_SIZE = 100;

interface BackfillTarget {
    model: string;
    fields: Array<{
        plain: string;
        encrypted: string;
        hash?: string;
    }>;
}

const TARGETS: BackfillTarget[] = [
    {
        model: 'User',
        fields: [
            { plain: 'email', encrypted: 'emailEncrypted', hash: 'emailHash' },
            { plain: 'name', encrypted: 'nameEncrypted' },
        ],
    },
    {
        model: 'VendorContact',
        fields: [
            { plain: 'name', encrypted: 'nameEncrypted' },
            { plain: 'email', encrypted: 'emailEncrypted', hash: 'emailHash' },
            { plain: 'phone', encrypted: 'phoneEncrypted' },
        ],
    },
    {
        model: 'AuditorAccount',
        fields: [
            { plain: 'email', encrypted: 'emailEncrypted', hash: 'emailHash' },
            { plain: 'name', encrypted: 'nameEncrypted' },
        ],
    },
    {
        model: 'NotificationOutbox',
        fields: [
            { plain: 'toEmail', encrypted: 'toEmailEncrypted' },
        ],
    },
    {
        model: 'UserIdentityLink',
        fields: [
            { plain: 'emailAtLinkTime', encrypted: 'emailAtLinkTimeEncrypted', hash: 'emailAtLinkTimeHash' },
        ],
    },
];

async function backfillModel(target: BackfillTarget): Promise<number> {
    const modelName = target.model;
    // @ts-expect-error dynamic model access
    const delegate = prisma[modelName.charAt(0).toLowerCase() + modelName.slice(1)];
    if (!delegate) {
        console.warn(`  ⚠️  Model ${modelName} not found, skipping`);
        return 0;
    }

    let processed = 0;
    let skip = 0;

    while (true) {
        // Use $queryRawUnsafe to bypass middleware (which would auto-encrypt)
        const rows = await delegate.findMany({
            take: BATCH_SIZE,
            skip,
            orderBy: { id: 'asc' },
        });

        if (rows.length === 0) break;

        for (const row of rows) {
            const updates: Record<string, string> = {};
            let needsUpdate = false;

            for (const { plain, encrypted, hash } of target.fields) {
                const plainValue = row[plain];
                const encValue = row[encrypted];

                // Skip if already encrypted or no plaintext to encrypt
                if (!plainValue || isEncryptedValue(encValue)) continue;

                updates[encrypted] = encryptField(plainValue);
                if (hash) {
                    updates[hash] = hashForLookup(plainValue);
                }
                needsUpdate = true;
            }

            if (needsUpdate) {
                // Use $executeRawUnsafe to bypass middleware
                const setClauses = Object.entries(updates)
                    .map(([col], i) => `"${col}" = $${i + 2}`)
                    .join(', ');
                const values = Object.values(updates);

                await prisma.$executeRawUnsafe(
                    `UPDATE "${modelName}" SET ${setClauses} WHERE "id" = $1`,
                    row.id,
                    ...values,
                );
                processed++;
            }
        }

        skip += BATCH_SIZE;
        if (rows.length < BATCH_SIZE) break;
    }

    return processed;
}

async function main() {
    console.log('🔐 Starting PII encryption backfill...\n');

    for (const target of TARGETS) {
        console.log(`  ▸ ${target.model}...`);
        const count = await backfillModel(target);
        console.log(`    ✅ ${count} records encrypted`);
    }

    console.log('\n🎉 Backfill complete!');
}

main()
    .catch((e) => {
        console.error('❌ Backfill failed:', e);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
