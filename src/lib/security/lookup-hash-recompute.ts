/**
 * Recompute every stored lookup hash under the current lookup-hash key — #5071.
 *
 * `hashForLookup` keys its HMAC on the dedicated `LOOKUP_HASH_KEY` when the
 * deploy sets one (see `encryption.ts`). Rows written before it was set carry
 * hashes under the master-derived key, so every lookup by email would miss
 * them. This walks the four columns that hold such hashes, recomputes each from
 * the row's own plaintext (decrypted by the PII middleware on read), and writes
 * the ones that differ.
 *
 *   User.emailHash                         plaintext `email` (encrypted column)
 *   AuditorAccount.emailHash               plaintext `email` (encrypted column)
 *   UserIdentityLink.emailAtLinkTimeHash   plaintext `emailAtLinkTime`
 *   VendorContact.emailHash                plaintext `email` (legacy dual-write)
 *
 * IDEMPOTENT: a row whose hash already matches is not written, so a second run
 * writes nothing and the container start can run it every time. The writes are
 * raw SQL so the PII middleware, which would recompute a hash from a plaintext
 * it was handed, is not involved in a write that names only the hash.
 *
 * The tenant system users (`sys_<tenantId>`, #4400) carry `system:<tenantId>`,
 * a value no lookup by email can compute, by design. They are skipped.
 *
 * The caller supplies the client: it must see every tenant's rows, so it is the
 * RLS-bypassing client the container-start script obtains with an
 * `admin-script` reason, never a tenant-scoped one.
 */
import type { PrismaClient } from '@prisma/client';
import { hashForLookup } from './encryption';

/** One page of rows per read; every model is walked by id. */
const PAGE = 500;

/** The system users' ids, whose hash is a fixed non-lookup value (#4400). */
const SYSTEM_USER_ID_PREFIX = 'sys_';

export interface LookupHashRecomputeResult {
    /** Rows read, per column. */
    readonly scanned: Record<string, number>;
    /** Rows rewritten, per column. */
    readonly rewritten: Record<string, number>;
}

type Row = { id: string; plain: string | null; hash: string | null };

/**
 * Walk one model by id, recomputing its hash column. `read` returns a page
 * after `cursor`; `write` stores one new hash.
 */
async function walk(
    read: (cursor: string | null) => Promise<Row[]>,
    write: (id: string, hash: string) => Promise<unknown>,
    skip: (row: Row) => boolean = () => false,
): Promise<{ scanned: number; rewritten: number }> {
    let cursor: string | null = null;
    let scanned = 0;
    let rewritten = 0;
    for (;;) {
        const page = await read(cursor);
        if (page.length === 0) break;
        for (const row of page) {
            scanned += 1;
            if (skip(row) || !row.plain) continue;
            const next = hashForLookup(row.plain);
            if (next === row.hash) continue;
            await write(row.id, next);
            rewritten += 1;
        }
        cursor = page[page.length - 1].id;
        if (page.length < PAGE) break;
    }
    return { scanned, rewritten };
}

/** Page after `cursor` by id; the first page has none. */
const after = (cursor: string | null) => ({
    cursor: cursor === null ? undefined : { id: cursor },
    skip: cursor === null ? 0 : 1,
});

export async function recomputeLookupHashes(db: PrismaClient): Promise<LookupHashRecomputeResult> {
    const scanned: Record<string, number> = {};
    const rewritten: Record<string, number> = {};
    const record = (key: string, r: { scanned: number; rewritten: number }) => {
        scanned[key] = r.scanned;
        rewritten[key] = r.rewritten;
    };

    record(
        'User.emailHash',
        await walk(
            async (cursor) =>
                (
                    await db.user.findMany({
                        select: { id: true, email: true, emailHash: true },
                        orderBy: { id: 'asc' },
                        take: PAGE,
                        ...after(cursor),
                    })
                ).map((u) => ({ id: u.id, plain: u.email, hash: u.emailHash })),
            (id, hash) => db.$executeRaw`UPDATE "User" SET "emailHash" = ${hash} WHERE "id" = ${id}`,
            (row) => row.id.startsWith(SYSTEM_USER_ID_PREFIX),
        ),
    );

    record(
        'AuditorAccount.emailHash',
        await walk(
            async (cursor) =>
                (
                    await db.auditorAccount.findMany({
                        select: { id: true, email: true, emailHash: true },
                        orderBy: { id: 'asc' },
                        take: PAGE,
                        ...after(cursor),
                    })
                ).map((a) => ({ id: a.id, plain: a.email, hash: a.emailHash })),
            (id, hash) => db.$executeRaw`UPDATE "AuditorAccount" SET "emailHash" = ${hash} WHERE "id" = ${id}`,
        ),
    );

    record(
        'UserIdentityLink.emailAtLinkTimeHash',
        await walk(
            async (cursor) =>
                (
                    await db.userIdentityLink.findMany({
                        select: { id: true, emailAtLinkTime: true, emailAtLinkTimeHash: true },
                        orderBy: { id: 'asc' },
                        take: PAGE,
                        ...after(cursor),
                    })
                ).map((l) => ({ id: l.id, plain: l.emailAtLinkTime, hash: l.emailAtLinkTimeHash })),
            (id, hash) =>
                db.$executeRaw`UPDATE "UserIdentityLink" SET "emailAtLinkTimeHash" = ${hash} WHERE "id" = ${id}`,
        ),
    );

    record(
        'VendorContact.emailHash',
        await walk(
            async (cursor) =>
                (
                    await db.vendorContact.findMany({
                        select: { id: true, email: true, emailHash: true },
                        orderBy: { id: 'asc' },
                        take: PAGE,
                        ...after(cursor),
                    })
                ).map((c) => ({ id: c.id, plain: c.email, hash: c.emailHash })),
            (id, hash) => db.$executeRaw`UPDATE "VendorContact" SET "emailHash" = ${hash} WHERE "id" = ${id}`,
        ),
    );

    return { scanned, rewritten };
}
