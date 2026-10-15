/**
 * Backfill `NotificationOutbox.dedupeKey` to pseudonymise the recipient (#3577)
 *
 * The key format was `{tenantId}:{type}:{toEmail}:{entityId}:{YYYY-MM-DD}` — so
 * the key carried a SECOND copy of the recipient's address, in a uniquely
 * indexed column with no retention rule of its own. Anything that redacted,
 * encrypted or dropped `toEmail` would have left the address intact there. This
 * rewrites the third segment to `hashForLookup(address)`, the same keyed blind
 * index behind the `emailHash` columns in `auth.ts`.
 *
 * ─── WHY THE BACKFILL MATTERS BEYOND THE PRIVACY FIX ───────────────────────
 *
 * It also removes the transition risk. Old and new keys do not dedupe against
 * each other, so a row left in the old format could be re-enqueued the same day
 * and sent twice. Rewriting EVERY row means no old-format key survives to be
 * missed. Measured before writing this: 1,085 rows, 0 PENDING, 14 created
 * today — so the window was small, and after the backfill it is nil.
 *
 * ─── THE COLLISION CHECK THAT HAD TO COME FIRST ────────────────────────────
 *
 * `hashForLookup` lowercases and trims, so two rows whose addresses differ only
 * by case would collapse onto ONE key and the second UPDATE would violate the
 * unique index. Measured against production first: 1,085 rows produce 1,085
 * distinct new keys, 0 colliding groups, 0 addresses differing only by case.
 * The script re-checks this itself and refuses rather than trusting that
 * measurement to still hold.
 *
 * Features, following `backfill-token-encryption.ts`:
 *   - Dry-run by DEFAULT: counts and verifies, writes nothing
 *   - Idempotent: skips rows whose recipient segment is already a 64-hex digest
 *   - Refuses malformed keys rather than guessing at them
 *   - Per-row error isolation: one bad row does not abandon the rest
 *   - NEVER logs an address, not even on failure
 *
 * Usage:
 *   npx tsx scripts/backfill-notification-dedupe-key.ts            # dry-run
 *   npx tsx scripts/backfill-notification-dedupe-key.ts --execute  # write
 */

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { hashForLookup } from '../src/lib/security/encryption';

// Constructed the way the other bundled scripts do (`scripts/catalog-check.ts`):
// Prisma 7 REQUIRES a driver adapter, and `new PrismaClient()` with no options
// throws outright. `?? ''` rather than `undefined` is load-bearing — passing
// undefined to `connectionString` fails inside the minified adapter with
// "p is not a function", which `src/lib/prisma.ts` documents at length.
//
// Deliberately NOT `@/lib/prisma`: that module installs the RLS and PII
// middleware, and this script writes a column the middleware has no business
// rewriting. The precedent (`backfill-token-encryption.ts`) reaches for raw
// queries for the same reason.
const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }),
});
const BATCH_SIZE = 200;
const ALREADY_HASHED = /^[0-9a-f]{64}$/;

interface Row {
    id: string;
    dedupeKey: string;
}

/** The new key, or a reason it cannot be computed. */
function rewrite(key: string): { next: string } | { skip: string } | { refuse: string } {
    const parts = key.split(':');
    if (parts.length !== 5) return { refuse: `expected 5 segments, found ${parts.length}` };
    const [tenantId, type, recipient, entityId, day] = parts;
    if (ALREADY_HASHED.test(recipient)) return { skip: 'already hashed' };
    if (!recipient.includes('@')) return { refuse: 'third segment is neither a digest nor an address' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { refuse: 'fifth segment is not a date' };
    return { next: `${tenantId}:${type}:${hashForLookup(recipient)}:${entityId}:${day}` };
}

async function main(): Promise<void> {
    const execute = process.argv.includes('--execute');
    console.log(execute ? '── EXECUTING ──' : '── DRY RUN (pass --execute to write) ──');

    const rows = await prisma.$queryRawUnsafe<Row[]>(
        'SELECT id, "dedupeKey" FROM "NotificationOutbox" ORDER BY "createdAt" ASC',
    );
    console.log(`rows: ${rows.length}`);

    // ── Plan every row BEFORE writing any of them ──
    const planned: { id: string; next: string }[] = [];
    let skipped = 0;
    const refusals: string[] = [];
    for (const row of rows) {
        const r = rewrite(row.dedupeKey);
        if ('skip' in r) skipped += 1;
        else if ('refuse' in r) refusals.push(`${row.id}: ${r.refuse}`);
        else planned.push({ id: row.id, next: r.next });
    }

    // ── REFUSE THE WHOLE RUN on a malformed key or a collision ──
    //
    // A partial backfill is the worst outcome: some rows pseudonymised, some
    // not, and no way to tell which without re-deriving. So every check is made
    // across the whole set before the first UPDATE.
    if (refusals.length > 0) {
        console.error(`REFUSING: ${refusals.length} key(s) could not be parsed`);
        for (const r of refusals.slice(0, 20)) console.error(`  ${r}`);
        process.exitCode = 1;
        return;
    }
    const nextKeys = new Set(planned.map((p) => p.next));
    if (nextKeys.size !== planned.length) {
        console.error(
            `REFUSING: ${planned.length} rows collapse onto ${nextKeys.size} keys — ` +
                'normalising the address would violate the unique index. ' +
                'Resolve the duplicates first.',
        );
        process.exitCode = 1;
        return;
    }
    // And no planned key may already exist on a DIFFERENT row.
    const existing = new Set(rows.map((r) => r.dedupeKey));
    const clashes = planned.filter(
        (p) => existing.has(p.next) && rows.find((r) => r.dedupeKey === p.next)?.id !== p.id,
    );
    if (clashes.length > 0) {
        console.error(`REFUSING: ${clashes.length} planned key(s) already exist on another row`);
        process.exitCode = 1;
        return;
    }

    console.log(`to rewrite: ${planned.length}   already hashed: ${skipped}`);
    if (!execute) {
        console.log('dry run complete — nothing written');
        console.log(`verified: ${planned.length} planned keys are distinct and unclaimed`);
        return;
    }

    let written = 0;
    const failures: string[] = [];
    for (let i = 0; i < planned.length; i += BATCH_SIZE) {
        for (const p of planned.slice(i, i + BATCH_SIZE)) {
            try {
                await prisma.$executeRawUnsafe(
                    'UPDATE "NotificationOutbox" SET "dedupeKey" = $1 WHERE id = $2',
                    p.next,
                    p.id,
                );
                written += 1;
            } catch (e) {
                // The id, never the key — a failed key still holds the address.
                failures.push(`${p.id}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
        console.log(`  ${Math.min(i + BATCH_SIZE, planned.length)}/${planned.length}`);
    }

    // ── Verify by re-reading, not by trusting the writes ──
    const after = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM "NotificationOutbox"
          WHERE split_part("dedupeKey", ':', 3) !~ '^[0-9a-f]{64}$'`,
    );
    const stillPlain = Number(after[0]?.n ?? -1);
    console.log(`written: ${written}   failures: ${failures.length}`);
    console.log(`rows whose recipient segment is still NOT a digest: ${stillPlain}`);
    for (const f of failures.slice(0, 20)) console.error(`  ${f}`);
    if (failures.length > 0 || stillPlain !== 0) process.exitCode = 1;
}

main()
    .catch((e) => {
        console.error(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
    })
    .finally(() => void prisma.$disconnect());
