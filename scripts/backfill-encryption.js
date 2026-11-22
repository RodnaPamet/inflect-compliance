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
 * Usage: node scripts/backfill-encryption.js
 */
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const crypto = require('crypto');

// ─── Inline Crypto (matches src/lib/security/encryption.ts) ───

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const VERSION_PREFIX = 'v1:';
const ENCRYPT_INFO = 'inflect-data-encryption';
const HMAC_INFO = 'inflect-data-lookup-hash';

function getRawKeyMaterial() {
    const key = process.env.DATA_ENCRYPTION_KEY;
    if (key && key.length >= 32) return key;
    return 'inflect-dev-encryption-key-not-for-production-use!!';
}

function deriveKey(rawMaterial, info) {
    const salt = Buffer.from('inflect-data-protection-salt-v1', 'utf8');
    const ikm = Buffer.from(rawMaterial, 'utf8');
    const infoBuffer = Buffer.from(info, 'utf8');
    const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
    return crypto.createHmac('sha256', prk)
        .update(Buffer.concat([infoBuffer, Buffer.from([1])]))
        .digest();
}

const raw = getRawKeyMaterial();
const encKey = deriveKey(raw, ENCRYPT_INFO);
const hmacKey = deriveKey(raw, HMAC_INFO);

function encryptField(plaintext) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, encKey, iv, { authTagLength: AUTH_TAG_LENGTH });
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return VERSION_PREFIX + Buffer.concat([iv, encrypted, tag]).toString('base64');
}

function hashForLookup(value) {
    const normalised = value.toLowerCase().trim();
    return crypto.createHmac('sha256', hmacKey).update(normalised, 'utf8').digest('hex');
}

function isEncryptedValue(value) {
    return typeof value === 'string' && value.startsWith(VERSION_PREFIX);
}

// ─── Backfill Logic ───

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }) });
const BATCH_SIZE = 100;

const TARGETS = [
    {
        model: 'user', table: 'User',
        fields: [
            { plain: 'email', encrypted: 'emailEncrypted', hash: 'emailHash' },
            { plain: 'name', encrypted: 'nameEncrypted' },
        ],
    },
    {
        model: 'vendorContact', table: 'VendorContact',
        fields: [
            { plain: 'name', encrypted: 'nameEncrypted' },
            { plain: 'email', encrypted: 'emailEncrypted', hash: 'emailHash' },
            { plain: 'phone', encrypted: 'phoneEncrypted' },
        ],
    },
    {
        model: 'auditorAccount', table: 'AuditorAccount',
        fields: [
            { plain: 'email', encrypted: 'emailEncrypted', hash: 'emailHash' },
            { plain: 'name', encrypted: 'nameEncrypted' },
        ],
    },
    {
        model: 'notificationOutbox', table: 'NotificationOutbox',
        fields: [{ plain: 'toEmail', encrypted: 'toEmailEncrypted' }],
    },
    {
        model: 'userIdentityLink', table: 'UserIdentityLink',
        fields: [{ plain: 'emailAtLinkTime', encrypted: 'emailAtLinkTimeEncrypted', hash: 'emailAtLinkTimeHash' }],
    },
];

async function backfillModel(target) {
    const delegate = prisma[target.model];
    if (!delegate) {
        console.warn(`  ⚠️  Model ${target.table} not found, skipping`);
        return 0;
    }

    let processed = 0;
    let skip = 0;

    while (true) {
        const rows = await delegate.findMany({
            take: BATCH_SIZE, skip,
            orderBy: { id: 'asc' },
        });
        if (rows.length === 0) break;

        for (const row of rows) {
            const updates = {};
            let needsUpdate = false;

            for (const { plain, encrypted, hash } of target.fields) {
                const plainValue = row[plain];
                const encValue = row[encrypted];
                if (!plainValue || isEncryptedValue(encValue)) continue;

                updates[encrypted] = encryptField(plainValue);
                if (hash) updates[hash] = hashForLookup(plainValue);
                needsUpdate = true;
            }

            if (needsUpdate) {
                const setClauses = Object.entries(updates)
                    .map(([col], i) => `"${col}" = $${i + 2}`)
                    .join(', ');
                const values = Object.values(updates);
                await prisma.$executeRawUnsafe(
                    `UPDATE "${target.table}" SET ${setClauses} WHERE "id" = $1`,
                    row.id, ...values,
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
        console.log(`  ▸ ${target.table}...`);
        const count = await backfillModel(target);
        console.log(`    ✅ ${count} records encrypted`);
    }
    console.log('\n🎉 Backfill complete!');
}

main()
    .catch((e) => { console.error('❌ Backfill failed:', e); process.exit(1); })
    .finally(() => prisma.$disconnect());
