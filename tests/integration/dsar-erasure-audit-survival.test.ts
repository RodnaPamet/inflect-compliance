/**
 * #2287 Stage 3 — the BEHAVIOURAL half: erasure leaves the audit trail
 * standing, per table, and what that does to the hash chain.
 *
 * ═══════════════════════════════════════════════════════════════════
 * WHAT WAS MISSING, MEASURED RATHER THAN ASSUMED
 * ═══════════════════════════════════════════════════════════════════
 *
 * #2647 implemented `eraseUser`; #2651 proved the ROLLBACK against a real
 * `ON DELETE RESTRICT` refusal. Neither covered the clause this issue is
 * most specific about:
 *
 *   > assert the rows **still exist** with `userId IS NULL` **and their
 *   > hash chain intact** — not that they are gone.
 *
 * At the base commit, 16 suites under `tests/integration` reference
 * `entryHash` or `verifyAuditChain` and **none of them runs `eraseUser`**
 * (1 suite runs `eraseUser`: the rollback test, which seeds its audit rows
 * by raw INSERT with a NULL `entryHash`, so they are outside the chain the
 * verifier walks). The populations were disjoint, so nobody had ever asked
 * the question this file asks.
 *
 * ═══════════════════════════════════════════════════════════════════
 * THE ANSWER, AND IT IS NOT THE COMFORTABLE ONE
 * ═══════════════════════════════════════════════════════════════════
 *
 * "Hash chain intact" turns out to name TWO different properties, and
 * erasure satisfies one and breaks the other:
 *
 *   STORED CHAIN — INTACT. Every `entryHash` and `previousHash` survives
 *     erasure byte for byte, and every link still points where it did.
 *     That is the database's doing: `audit_log_immutable_guard()`
 *     (20260917130000) permits an UPDATE only when
 *     `to_jsonb(NEW) - 'userId' = to_jsonb(OLD) - 'userId'`, so a
 *     pseudonymization that rewrote a hash would be REFUSED. History
 *     cannot be forged in the name of erasure.
 *
 *   RECOMPUTED CHAIN — BROKEN. `verifyAuditChain` does not read the stored
 *     links and stop; it RECOMPUTES each `entryHash` from the row's current
 *     columns, and `actorUserId` is one of the ten `HASH_FIELDS`
 *     (src/lib/audit/canonical-hash.ts). A row hashed while `userId` held
 *     the subject no longer recomputes to its stored hash once `userId` is
 *     NULL. Measured on this fixture: `valid: true` before erasure,
 *     `valid: false` after, breaking at the FIRST pseudonymized row.
 *
 * That was the finding this file was written to PIN: a GDPR erasure was
 * indistinguishable from tampering to the only chain verifier the product
 * had. `tamperAuditRow` + a failed `verifyAuditChain` is exactly the
 * signature `tests/integration/audit-hash-chain.test.ts` uses to PROVE
 * tampering is detectable, and a lawful erasure produced that same signature.
 *
 * ═══════════════════════════════════════════════════════════════════
 * THE FIX, AND WHICH ASSERTIONS IT FLIPPED (#2682, 2026-09-20)
 * ═══════════════════════════════════════════════════════════════════
 *
 * The four available repairs were a decision somebody had to take on the
 * record, which is why the original version of this file asserted the broken
 * behaviour instead of repairing it. The owner took it on 2026-09-20, on the
 * issue: **record the erasure, and have the verifier consult the record.**
 * The three rejected options and why are in issue #2682; the mechanism and
 * its security argument are in `src/lib/audit/erasure-record.ts`.
 *
 * In one line: the erasure writes an `ERASURE_EXECUTED` entry — in the SAME
 * transaction — naming each row it pseudonymized together with the hash that
 * row will recompute to once `userId` is NULL, and the verifiers excuse a
 * mismatch only for a named row whose recomputation equals that committed
 * value. Any OTHER change to a named row, and any `userId` nulled on a row no
 * record names, still breaks the chain.
 *
 * TWO ASSERTIONS BELOW WERE FLIPPED DELIBERATELY, which is what this file
 * exists for:
 *
 *   `CHAIN, RECOMPUTED` (was `FINDING`) — `valid` went `false` -> `true`, and
 *     now also asserts `toleratedPseudonymizations`, so "the chain verifies"
 *     cannot quietly come to mean "nothing was erased".
 *   `TABLE SURFACE` — the cascade legitimately widened. It now issues
 *     `auditLog.findMany` (the rows the record must name: `updateMany`
 *     returns a count, and afterwards they are unfindable by `userId`) and
 *     raw SQL, because `appendAuditEntryWithin` is the one sanctioned
 *     `AuditLog` writer and it is raw by construction. The surface test keeps
 *     its teeth by grading the raw statements' VERBS and TABLES rather than
 *     by counting them.
 *
 * AND THE NEW ASSERTIONS ARE THE ONES THAT MATTER MOST: the three at the end
 * of this file tamper with live rows to show the tolerance is not a blanket
 * one. If those ever go green while asserting a broken chain, the fix has
 * become worse than the bug it replaced.
 *
 * ═══════════════════════════════════════════════════════════════════
 * WHY THE TABLE SURFACE IS DERIVED, NOT LISTED
 * ═══════════════════════════════════════════════════════════════════
 *
 * The issue asks for the pseudonymize-vs-delete split "per table". A list
 * written into this file would be a second enumeration to keep in step with
 * the cascade, which is the failure mode `eraseUser`'s own JSDoc refuses for
 * child tables. So the surface is RECORDED from the run: the client handed
 * to `eraseUser` is a proxy that logs every `(delegate, method)` pair the
 * function issues, against real Postgres. The denominator is whatever that
 * run touched — 2 delegate tables — and each one is then checked against the
 * disposition declared for it in `ERASURE_DISPOSITIONS`. A cascade that
 * widened to a third table would fail the surface test rather than slip
 * past a per-table check that never knew to look.
 *
 * THAT COVERS RAW SQL, and only because the proxy is written to make it. A
 * widening issued as `$executeRawUnsafe` goes through no model delegate, so a
 * proxy that bound every `$`-prefixed method straight through to the target
 * would record nothing, the surface would still read `['auditLog', 'user']`,
 * and the claim above would be false for precisely the escape hatch a
 * hand-written cascade reaches for. So every `$` call EXCEPT `$transaction`
 * (recursed into, above) and `$connect` / `$disconnect` (lifecycle — they
 * reach no table) is recorded as `table: '$raw'` and then executed unchanged,
 * the way the sibling probe records it
 * (`tests/helpers/dsar-erasure-probe.ts:314`).
 *
 * HOW `$raw` IS GRADED CHANGED WITH #2682, and this is the half worth reading
 * before touching the surface test. `$raw` used to be graded by PRESENCE: it
 * is not a key of `ERASURE_DISPOSITIONS`, so its arrival reddened the test.
 * That was the right rule while the cascade issued none, and it stopped being
 * available when erasure had to write its record through
 * `appendAuditEntryWithin` — the ONE sanctioned `AuditLog` writer, which is
 * raw by construction (it controls `createdAt` as a timestamp string, and
 * `tests/guards/audit-structured-events.test.ts` forbids a raw INSERT into
 * `AuditLog` anywhere else). So raw presence and the owner's decision cannot
 * both be satisfied.
 *
 * The teeth move to the STATEMENTS. Every recorded `$raw` call now carries its
 * args, and the surface test asserts that no raw statement names a table other
 * than "AuditLog" and that none of them carries a mutating verb
 * (UPDATE / DELETE / TRUNCATE / ALTER / DROP). A raw widening to another table
 * still reddens; so does a hand-rolled `UPDATE "AuditLog" SET "userId" = NULL`
 * that dodges the `updateMany` — which is the thing presence-grading was
 * actually protecting against.
 *
 * WHAT IS STILL OUTSIDE THE NET, said plainly rather than left to be
 * discovered: a cascade that reached a client this proxy never wrapped — a
 * module-level `@/lib/prisma` import instead of the injected `db` — is
 * invisible here, because the recording starts at the seam the injection
 * uses. That seam is the one `tests/guardrails/dsar-workflow-coverage.test.ts`
 * covers, by jest.mock()ing `@/lib/prisma` onto its own probe client.
 *
 * `options.db` rather than the default `runInGlobalContext` path: it is the
 * same `eraseUserWithin` cascade either way (`eraseUser` branches on the
 * option and calls the same private function), and
 * `dsar-erasure-rollback.test.ts` already drives the default path. Injecting
 * is what makes the surface observable at all.
 *
 * ═══════════════════════════════════════════════════════════════════
 * ORDER-INDEPENDENT ON PURPOSE
 * ═══════════════════════════════════════════════════════════════════
 *
 * The erasure runs ONCE in `beforeAll`, between a before-snapshot and an
 * after-snapshot, and every `it` below reads only captured state. So a
 * mutation reddens the assertion about the thing it broke, and only that
 * one — an erasure driven from inside an `it` would cascade a single
 * breakage into every later test and make "which test reddened" unreadable.
 * A throw from the erasure is captured (`erasureError`) and graded by its
 * own test for the same reason.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { appendAuditEntry, verifyAuditChain } from '@/lib/audit/audit-writer';
import type { ChainVerificationResult } from '@/lib/audit/audit-writer';
import { HASH_FIELDS } from '@/lib/audit/canonical-hash';
import { ERASURE_EXECUTED_ACTION, parseErasureRecordRows } from '@/lib/audit/erasure-record';
import { eraseUser } from '@/app-layer/jobs/dsar-erasure';
import type { ErasureDb, ErasureReceipt } from '@/app-layer/jobs/dsar-erasure';
import { ERASURE_DISPOSITIONS } from '../helpers/dsar-erasure-probe';
import { deleteAuditRowsForTenants, tamperAuditRow } from '../helpers/audit-cleanup';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});

const SUFFIX = randomUUID().slice(0, 8);
const TENANT = `t-survive-${SUFFIX}`;
/** The erasure subject. Two of the four seeded audit rows are theirs. */
const SUBJECT = `u-survive-subject-${SUFFIX}`;
/** The control. Same tenant, same chain, NOT erased. */
const BYSTANDER = `u-survive-bystander-${SUFFIX}`;

// ─── The recording client ───────────────────────────────────────────
//
// A pass-through proxy over a REAL Prisma client. It changes nothing about
// what the statements do — the writes below land in Postgres and the
// assertions read them back — it only records which delegate and which
// method each one went through, so the table surface is observed rather
// than declared.

interface RecordedOp {
    /** Prisma delegate name, e.g. `auditLog` — or `$raw` for a raw-SQL call. */
    table: string;
    /** Delegate method, e.g. `updateMany`, or the `$`-method for a raw call. */
    method: string;
    /**
     * The arguments, so a `$raw` call can be graded by what it SAYS rather
     * than merely counted. Added with #2682: erasure now legitimately issues
     * raw SQL (the audit record goes through the one sanctioned writer), so
     * "zero raw calls" stopped being an available assertion and the surface
     * test had to start reading the statements instead. Recorded for delegate
     * calls too — same reason the sibling probe records them.
     */
    args: unknown[];
}

const recordedOps: RecordedOp[] = [];

/**
 * The pseudo-table a raw-SQL call is recorded under, spelled as the sibling
 * probe spells it (`tests/helpers/dsar-erasure-probe.ts:314`). Deliberately
 * NOT a key of `ERASURE_DISPOSITIONS`: a raw widening has no declared
 * disposition, and the surface test should say so rather than accept it.
 */
const RAW_TABLE = '$raw';

/**
 * The `$` calls that reach no table, so recording them as `$raw` would be a
 * false positive. `$transaction` is not here because it is handled earlier —
 * it is recursed into, not recorded.
 */
const LIFECYCLE_METHODS = new Set(['$connect', '$disconnect']);

function recordingProxy<T extends object>(client: T, ops: RecordedOp[]): T {
    return new Proxy(client, {
        get(target, prop, receiver) {
            if (typeof prop !== 'string') return Reflect.get(target, prop, receiver);

            // `$transaction` must hand the CALLBACK a recorded client too,
            // or the whole cascade (which runs inside one) is invisible.
            if (prop === '$transaction') {
                return (fn: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) =>
                    (target as unknown as {
                        $transaction: (f: (tx: object) => Promise<unknown>, ...r: unknown[]) => Promise<unknown>;
                    }).$transaction((tx: object) => fn(recordingProxy(tx, ops)), ...rest);
            }

            const value = Reflect.get(target, prop, receiver) as unknown;
            if (prop.startsWith('$') || prop.startsWith('_')) {
                if (typeof value !== 'function') return value;
                const bound = (value as (...a: unknown[]) => unknown).bind(target);
                if (prop.startsWith('_') || LIFECYCLE_METHODS.has(prop)) return bound;
                // Everything else `$`-prefixed can reach a table without going
                // through a delegate — `$executeRawUnsafe` and
                // `$queryRawUnsafe` obviously, `$extends` by handing back a
                // client this proxy never wrapped, and whatever a future
                // Prisma adds. Recorded rather than enumerated, so a method
                // nobody anticipated is loud instead of silent; then executed
                // unchanged, because this proxy changes what is OBSERVED and
                // never what runs.
                return (...args: unknown[]) => {
                    ops.push({ table: RAW_TABLE, method: prop, args });
                    return bound(...args);
                };
            }
            if (!value || typeof value !== 'object') return value;

            // A model delegate: wrap its methods.
            return new Proxy(value as object, {
                get(delegate, method, delegateReceiver) {
                    if (typeof method !== 'string') return Reflect.get(delegate, method, delegateReceiver);
                    const fn = Reflect.get(delegate, method, delegateReceiver) as unknown;
                    if (typeof fn !== 'function') return fn;
                    return (...args: unknown[]) => {
                        ops.push({ table: prop, method, args });
                        return (fn as (...a: unknown[]) => unknown).apply(delegate, args);
                    };
                },
            });
        },
    });
}

// ─── Captured state ─────────────────────────────────────────────────

/** One audit row, split the way the immutability trigger splits it. */
interface AuditSnapshotRow {
    id: string;
    userId: string | null;
    entryHash: string | null;
    previousHash: string | null;
    /** Needed to find the `ERASURE_EXECUTED` record the fix appends (#2682). */
    action: string;
    /** Its payload: the named rows and their committed post-erasure hashes. */
    detailsJson: unknown;
    /** `to_jsonb(row) - 'userId'` — EVERY other column, as stored. */
    rest: unknown;
}

let snapshotBefore: AuditSnapshotRow[] = [];
let snapshotAfter: AuditSnapshotRow[] = [];
let chainBefore: ChainVerificationResult | null = null;
let chainAfter: ChainVerificationResult | null = null;
let receipt: ErasureReceipt | null = null;
let erasureError: unknown = null;
let subjectRowIdsBefore: string[] = [];
let userRowsAfter: Array<{ id: string }> = [];

async function snapshotAudit(): Promise<AuditSnapshotRow[]> {
    // `to_jsonb(a) - 'userId'` is the trigger's OWN predicate, read from the
    // application side. Comparing it before/after is therefore the same
    // question the database asks of each permitted UPDATE — and it covers
    // every column without naming one, so a column added next quarter is
    // inside the comparison automatically.
    return globalPrisma.$queryRawUnsafe<AuditSnapshotRow[]>(
        `SELECT a."id", a."userId", a."entryHash", a."previousHash",
                a."action", a."detailsJson",
                to_jsonb(a) - 'userId' AS "rest"
           FROM "AuditLog" a
          WHERE a."tenantId" = $1
          ORDER BY a."createdAt" ASC, a."id" ASC`,
        TENANT,
    );
}

async function mkUser(id: string) {
    const email = `${id}@example.test`;
    await globalPrisma.user.create({
        data: { id, email, emailHash: hashForLookup(email) },
    });
}

describeFn('#2287 Stage 3 — erasure pseudonymizes the audit trail, per table, and the chain', () => {
    beforeAll(async () => {
        await globalPrisma.$connect();
        await globalPrisma.tenant.create({ data: { id: TENANT, name: TENANT, slug: TENANT } });
        await mkUser(SUBJECT);
        await mkUser(BYSTANDER);

        // Seeded through `appendAuditEntry`, NOT a raw INSERT. That is the
        // difference from the rollback suite: only this path computes an
        // `entryHash`, and `verifyAuditChain` skips rows whose hash is NULL,
        // so raw-inserted rows are invisible to the very check this file is
        // about.
        //
        // The SYSTEM row is FIRST so that the chain has a verified link ahead
        // of the first pseudonymized one — otherwise "breaks at index 0" and
        // "breaks at the first subject row" are the same observation and the
        // break location proves nothing.
        const seed: Array<[string | null, string]> = [
            [null, 'sys'],
            [SUBJECT, 'subject-first'],
            [BYSTANDER, 'bystander'],
            [SUBJECT, 'subject-second'],
        ];
        for (const [userId, tag] of seed) {
            await appendAuditEntry(
                {
                    tenantId: TENANT,
                    userId,
                    actorType: userId ? 'USER' : 'SYSTEM',
                    entity: 'Control',
                    entityId: `ctrl-${tag}`,
                    action: `DSAR_SURVIVAL_${tag.toUpperCase().replace(/-/g, '_')}`,
                    details: `erasure survival fixture (${tag})`,
                },
                globalPrisma,
            );
            // Distinct millisecond per row. `createdAt` is millisecond
            // precision and the chain's total order is (createdAt, id); two
            // rows sharing a millisecond order by a random cuid, which can
            // put the verifier's walk out of step with the order the appends
            // chained in and break the chain for reasons that have nothing to
            // do with erasure.
            await new Promise((resolve) => setTimeout(resolve, 2));
        }

        snapshotBefore = await snapshotAudit();
        subjectRowIdsBefore = snapshotBefore.filter((r) => r.userId === SUBJECT).map((r) => r.id);
        chainBefore = await verifyAuditChain(TENANT, globalPrisma);

        try {
            receipt = await eraseUser(SUBJECT, {
                db: recordingProxy(globalPrisma, recordedOps) as unknown as ErasureDb,
            });
        } catch (error) {
            erasureError = error;
        }

        snapshotAfter = await snapshotAudit();
        chainAfter = await verifyAuditChain(TENANT, globalPrisma);
        userRowsAfter = await globalPrisma.user.findMany({
            where: { id: { in: [SUBJECT, BYSTANDER] } },
            select: { id: true },
        });
    });

    afterAll(async () => {
        // Guarded, and via the helper rather than a raw DELETE: the
        // immutability trigger refuses DELETE on "AuditLog" outright, and
        // surviving audit rows block the tenant delete through
        // AuditLog_tenantId_fkey (RESTRICT).
        if (TENANT) {
            await deleteAuditRowsForTenants(globalPrisma, TENANT);
            await globalPrisma.tenant.deleteMany({ where: { id: TENANT } });
            await globalPrisma.user.deleteMany({
                where: { id: { in: [SUBJECT, BYSTANDER] } },
            });
        }
        await globalPrisma.$disconnect();
    });

    // ── The denominator, before anything is claimed about a change ──

    it('DENOMINATOR — 4 hashed audit rows seeded: 2 for the subject, 1 bystander, 1 SYSTEM', () => {
        // Every "unchanged" and every "now NULL" below is read against these
        // four rows. Without this, an erasure that touched nothing and a
        // fixture that was never written produce identical output.
        expect(snapshotBefore).toHaveLength(4);
        expect(snapshotBefore.every((r) => r.entryHash !== null)).toBe(true);
        expect(subjectRowIdsBefore).toHaveLength(2);
        expect(snapshotBefore.filter((r) => r.userId === BYSTANDER)).toHaveLength(1);
        expect(snapshotBefore.filter((r) => r.userId === null)).toHaveLength(1);
    });

    it('POSITIVE CONTROL — the hash chain VERIFIES before erasure', () => {
        // The control for the finding two tests from the end: without it,
        // `valid: false` afterwards could just mean the fixture never
        // produced a valid chain in the first place.
        expect(chainBefore).toMatchObject({
            totalEntries: 4,
            hashedEntries: 4,
            unhashedEntries: 0,
            valid: true,
        });
    });

    it('the erasure ran and returned a receipt rather than throwing', () => {
        // Graded separately so that a change which makes the cascade THROW
        // reddens here, and the tests below still report what the database
        // actually holds instead of all failing on an undefined snapshot.
        expect(erasureError).toBeNull();
        expect(receipt).toMatchObject({
            userId: SUBJECT,
            auditRowsPseudonymized: 2,
            auditRowsDeleted: 0,
            userDeleted: true,
        });
    });

    // ── The per-table split: the surface first, then each table ──

    it('TABLE SURFACE — the erasure touches exactly 2 delegate tables, each with a declared disposition', () => {
        // Recorded from the run, not listed here. This is the denominator for
        // the two per-table tests that follow: if the cascade ever reaches a
        // third table, this fails rather than the new table going unchecked.
        const touched = [...new Set(recordedOps.map((op) => op.table))].sort();
        expect(touched).toEqual([RAW_TABLE, 'auditLog', 'user']);

        for (const table of touched.filter((t) => t !== RAW_TABLE)) {
            expect(Object.keys(ERASURE_DISPOSITIONS)).toContain(table);
        }
        expect(ERASURE_DISPOSITIONS.auditLog).toBe('PSEUDONYMIZE');
        expect(ERASURE_DISPOSITIONS.user).toBe('DELETE');

        // And the VERBS, per table — the split is not only which tables but
        // which operation each one received. `auditLog` must never see a
        // delete verb; that is the invariant in one line.
        //
        // `findMany` joined `updateMany` with #2682: the erasure record has
        // to NAME the rows it pseudonymized, `updateMany` returns a count,
        // and after it runs those rows are no longer findable by `userId`.
        const methodsOf = (table: string) =>
            [...new Set(recordedOps.filter((op) => op.table === table).map((op) => op.method))].sort();
        expect(methodsOf('auditLog')).toEqual(['findMany', 'updateMany']);
        expect(methodsOf('user')).toEqual(['delete', 'findUnique']);
    });

    it('TABLE SURFACE — the raw SQL only APPENDS, and reaches no table but AuditLog', () => {
        // THIS REPLACES `expect(touched).not.toContain('$raw')`. See the
        // header: presence-grading and "route the record through the one
        // sanctioned AuditLog writer" cannot both hold, so the teeth move
        // from counting raw calls to reading them.
        const rawOps = recordedOps.filter((op) => op.table === RAW_TABLE);

        // Non-vacuous first: an empty selection satisfies every `for` below.
        // Three statements per tenant — advisory lock, chain tip, INSERT —
        // and this fixture has one tenant.
        expect(rawOps.length).toBe(3);

        for (const op of rawOps) {
            const sql = typeof op.args[0] === 'string' ? (op.args[0] as string) : '';
            // A statement with no SQL string at all would pass the two checks
            // below vacuously.
            expect(sql.length).toBeGreaterThan(0);

            // No verb that can change or remove a row that already exists.
            // A hand-rolled `UPDATE "AuditLog" SET "userId" = NULL` dodging
            // the delegate reddens here.
            expect(sql).not.toMatch(/\b(update|delete|truncate|alter|drop)\b/i);

            // And no table but the audit trail. Prisma quotes table names
            // capitalised and columns lower-camel, so the capital filter
            // makes this a statement about TABLES.
            const tables = [...sql.matchAll(/"([A-Z][A-Za-z0-9_]*)"/g)].map((m) => m[1]);
            expect([...new Set(tables)].filter((t) => t !== 'AuditLog')).toEqual([]);
        }

        // POSITIVE CONTROL for the two `not` assertions above: at least one of
        // these statements really is the audit INSERT, so the loop graded a
        // population that contains the thing it is about.
        expect(rawOps.some((op) => String(op.args[0]).includes('INSERT INTO "AuditLog"'))).toBe(true);
    });

    it('TABLE 1 of 2 — auditLog is PSEUDONYMIZED: every row survives, none deleted, one APPENDED', () => {
        // Every pre-erasure row is still here, by id.
        const afterIds = new Set(snapshotAfter.map((r) => r.id));
        for (const before of snapshotBefore) {
            expect(afterIds.has(before.id)).toBe(true);
        }
        // The subject's own rows specifically — "every row survives" would
        // also hold if the erasure had deleted both of theirs and something
        // else had inserted two.
        for (const id of subjectRowIdsBefore) {
            expect(afterIds.has(id)).toBe(true);
        }

        // And EXACTLY ONE row is new: the ERASURE_EXECUTED record (#2682).
        // This used to be `toHaveLength(snapshotBefore.length)`, which the
        // fix necessarily flips — the record is an audit row like any other.
        // Asserting the exact surplus rather than `>=` keeps the old test's
        // real claim: an erasure that appended something ELSE, or appended
        // several, reddens here instead of hiding behind "the chain is fine".
        const beforeIds = new Set(snapshotBefore.map((r) => r.id));
        const appended = snapshotAfter.filter((r) => !beforeIds.has(r.id));
        expect(appended).toHaveLength(1);
        expect(appended[0].action).toBe(ERASURE_EXECUTED_ACTION);
        expect(appended[0].id).toBe(receipt?.erasureRecordIds[0]);
    });

    it('ATTRIBUTION SOURCE — the app pseudonymizes BEFORE the delete, and the FK would null it anyway', () => {
        // FOUND BY MUTATION, and it changes what the next two tests prove.
        // Neutering the `updateMany`'s `where` so it matched nothing left
        // EVERY assertion below green except the receipt count — because
        // `AuditLog_userId_fkey` is `ON DELETE SET NULL`
        // (20260308190244_init/migration.sql:927), so deleting the `User`
        // nulls the attribution by itself. That FK-driven UPDATE also
        // satisfies the immutability trigger, since setting `userId` to NULL
        // and touching nothing else is exactly the shape it permits.
        //
        // So "the rows survive with userId IS NULL" is OVER-DETERMINED: it is
        // true of an erasure whose pseudonymization step does nothing. Two
        // things discriminate, and both are asserted here rather than left
        // implicit:
        //
        //   1. the RECEIPT's own count — the application's report of how many
        //      rows IT pseudonymized, which an FK cascade cannot inflate;
        //   2. the ORDER — the `updateMany` is issued before the delete, so
        //      the application does the work in a state where the FK has not
        //      yet had the chance to.
        //
        // This is not a defect. Belt and braces is right here: the FK is what
        // makes a half-run erasure impossible to leave behind, and the
        // explicit `updateMany` is what produces auditable evidence of how
        // many rows were affected. But a test that graded only the end state
        // would be certifying the FK while claiming to certify `eraseUser`.
        expect(receipt?.auditRowsPseudonymized).toBe(subjectRowIdsBefore.length);

        const updateAt = recordedOps.findIndex(
            (op) => op.table === 'auditLog' && op.method === 'updateMany',
        );
        const deleteAt = recordedOps.findIndex(
            (op) => op.table === 'user' && op.method === 'delete',
        );
        expect(updateAt).toBeGreaterThanOrEqual(0);
        expect(deleteAt).toBeGreaterThanOrEqual(0);
        expect(updateAt).toBeLessThan(deleteAt);
    });

    it('TABLE 1 of 2 — auditLog: the subject link is NULL and NOTHING ELSE about the row moved', () => {
        const byId = new Map(snapshotAfter.map((r) => [r.id, r]));
        for (const id of subjectRowIdsBefore) {
            const before = snapshotBefore.find((r) => r.id === id)!;
            const after = byId.get(id)!;
            expect(after.userId).toBeNull();
            // Every other column, compared as the trigger compares them.
            expect(after.rest).toEqual(before.rest);
        }
    });

    it('TABLE 1 of 2 — auditLog: the bystander keeps their attribution (no over-anonymization)', () => {
        // The `where` clause's obligation. The trigger grades ONE ROW at a
        // time against a shape, so a statement that nulled `userId` across
        // the whole table satisfies it row by row — not over-anonymizing is
        // an application obligation, and this is where it is checked.
        //
        // The SYSTEM row is deliberately NOT the control here: it was already
        // NULL before the erasure, so it cannot distinguish "untouched" from
        // "nulled again".
        const bystanderAfter = snapshotAfter.filter((r) => r.userId === BYSTANDER);
        expect(bystanderAfter).toHaveLength(1);
        expect(snapshotAfter.filter((r) => r.userId === SUBJECT)).toHaveLength(0);
    });

    it('TABLE 2 of 2 — user is DELETED: the subject row is gone, the bystander survives', () => {
        // The other half of the split, asserted separately from auditLog
        // rather than as one blanket claim — the whole point of the per-table
        // form is that pseudonymize and delete can fail independently.
        const ids = userRowsAfter.map((u) => u.id);
        expect(ids).not.toContain(SUBJECT);
        expect(ids).toContain(BYSTANDER);
    });

    // ── The hash chain: both halves of "intact" ──

    it('CHAIN, STORED — every entryHash and previousHash survives byte-for-byte, and still links', () => {
        const byId = new Map(snapshotAfter.map((r) => [r.id, r]));
        for (const before of snapshotBefore) {
            const after = byId.get(before.id)!;
            expect(after.entryHash).toBe(before.entryHash);
            expect(after.previousHash).toBe(before.previousHash);
        }
        // Linkage, walked over the post-erasure rows in the verifier's order.
        for (let i = 1; i < snapshotAfter.length; i++) {
            expect(snapshotAfter[i].previousHash).toBe(snapshotAfter[i - 1].entryHash);
        }
        expect(snapshotAfter[0].previousHash).toBeNull();
    });

    it('CHAIN, RECOMPUTED — a lawful erasure NO LONGER reports as tampering (#2682)', () => {
        // ── THE FLIPPED ASSERTION ──────────────────────────────────
        //
        // This test was `FINDING — verifyAuditChain REPORTS THE CHAIN BROKEN
        // after erasure, at the first pseudonymized row`, and it asserted
        // `valid: false` with a `firstBreakAt` derived from the first
        // pseudonymized row. It was pinning a defect, not endorsing it — see
        // this file's header — and the owner decision on #2682 is what
        // entitles it to be flipped.
        //
        // What makes `valid: true` honest here rather than a verifier taught
        // to look away: the chain contains an `ERASURE_EXECUTED` entry naming
        // these exact rows and committing to the hash each one must recompute
        // to. The next three tests break that commitment three different ways
        // and require the chain to report broken each time.
        expect(chainAfter).toMatchObject({
            // 5, not 4: the erasure record is an audit row like any other.
            totalEntries: 5,
            hashedEntries: 5,
            unhashedEntries: 0,
            valid: true,
        });
        expect(chainAfter?.firstBreakAt).toBeUndefined();
        expect(chainAfter?.firstBreakId).toBeUndefined();

        // THE SECOND NUMBER, printed next to the green one. `valid: true`
        // alone would also be produced by an erasure that pseudonymized
        // NOTHING, or by a verifier that stopped recomputing at all. The
        // tolerance count says how many mismatches were excused, and it must
        // equal the rows the erasure actually de-attributed.
        expect(chainAfter?.toleratedPseudonymizations).toBe(subjectRowIdsBefore.length);
        expect(receipt?.auditRowsTolerated).toBe(subjectRowIdsBefore.length);
    });

    it('THE RECORD — is hash-chained, names exactly the erased rows, and identifies nobody', () => {
        const record = snapshotAfter.find((r) => r.action === ERASURE_EXECUTED_ACTION)!;
        expect(record).toBeDefined();

        // It is IN the chain, which is the property the owner decision turns
        // on — "no second source of truth outside the chain's protection".
        expect(record.entryHash).not.toBeNull();
        expect(record.previousHash).toBe(snapshotAfter[snapshotAfter.length - 2].entryHash);

        // It names exactly the rows this erasure pseudonymized. Not more —
        // a record naming a row the erasure did not touch would hand that
        // row a tolerance it has not earned.
        const named = parseErasureRecordRows(record);
        expect(named.map((n) => n.id).sort()).toEqual([...subjectRowIdsBefore].sort());
        for (const n of named) {
            expect(n.postErasureHash).toMatch(/^[0-9a-f]{64}$/);
        }

        // AND IT RE-IDENTIFIES NOBODY. The one thing this entry must not
        // contain is the subject, which is the natural thing to put in an
        // entry about their erasure — and would undo the erasure. Checked
        // against the whole stored row, not just `detailsJson`.
        expect(record.userId).toBeNull();
        expect(JSON.stringify(record.rest)).not.toContain(SUBJECT);
    });

    // ── THE TOLERANCE IS NOT A BLANKET ONE ──────────────────────────
    //
    // Each of the three below MUTATES a live row, verifies, and restores.
    // They run after the read-only tests above, which read captured snapshots
    // and are unaffected either way.
    //
    // THE RESTORE IS IN A `finally`, AND THAT IS NOT DEFENSIVE STYLING. The
    // first version restored on the happy path only. The un-named-row test
    // then failed on an assertion BEFORE its restore, left the bystander's
    // `userId` NULL, and the NEXT test — which forges the erasure record —
    // broke at the bystander row instead, reporting a `firstBreakId` that had
    // nothing to do with what it had just done. One stale row turned a
    // precise failure into a misleading one, which is exactly the cascade
    // this file's header refuses elsewhere.
    //
    // The restore is then VERIFIED against a fresh read rather than assumed:
    // a restore that silently failed would make the following test's red mean
    // nothing.
    async function withTamper(
        apply: () => Promise<unknown>,
        restore: () => Promise<unknown>,
        assertions: () => Promise<void>,
    ): Promise<void> {
        await apply();
        try {
            await assertions();
        } finally {
            await restore();
        }
        expect((await verifyAuditChain(TENANT, globalPrisma)).valid).toBe(true);
    }

    it('TOLERANCE IS userId-ONLY — editing another hashed field on a NAMED row still breaks the chain', async () => {
        // THE MUTATION THIS WHOLE FIX LIVES OR DIES BY. A general "ignore
        // mismatches for rows the erasure named" would pass every other test
        // in this file and let a tamperer hide arbitrary edits behind a
        // lawful erasure. `action` is one of the ten HASH_FIELDS and is NOT
        // `userId`, so a named row carrying a forged `action` must not be
        // excused.
        const target = subjectRowIdsBefore[0];
        const original = snapshotAfter.find((r) => r.id === target)!;
        const originalAction = (original.rest as { action: string }).action;

        await withTamper(
            () => tamperAuditRow(globalPrisma, target, 'action', `${originalAction}_FORGED`),
            () => tamperAuditRow(globalPrisma, target, 'action', originalAction),
            async () => {
                const tampered = await verifyAuditChain(TENANT, globalPrisma);
                expect(tampered.valid).toBe(false);
                expect(tampered.firstBreakId).toBe(target);
                // The row IS named — so this is the tolerance REFUSING, not
                // the tolerance never being consulted. Without this line a
                // fix that simply stopped recording the row would pass.
                const record = snapshotAfter.find((r) => r.action === ERASURE_EXECUTED_ACTION)!;
                expect(parseErasureRecordRows(record).map((n) => n.id)).toContain(target);
            },
        );

        const restored = await snapshotAudit();
        expect(restored.find((r) => r.id === target)!.rest).toEqual(original.rest);
    });

    it('AN UN-NAMED ROW — a userId nulled outside an erasure still breaks the chain', async () => {
        // The attack the owner decision names explicitly: the immutability
        // trigger PERMITS `userId` value -> NULL and nothing else, so nulling
        // a `userId` is precisely the one mutation an attacker CAN make
        // through the database's own rules. The bystander is not in the
        // erasure record, so their row gets no tolerance.
        const target = snapshotAfter.find((r) => r.userId === BYSTANDER)!;

        await withTamper(
            () => tamperAuditRow(globalPrisma, target.id, 'userId', null),
            () => tamperAuditRow(globalPrisma, target.id, 'userId', BYSTANDER),
            async () => {
                const tampered = await verifyAuditChain(TENANT, globalPrisma);
                expect(tampered.valid).toBe(false);
                expect(tampered.firstBreakId).toBe(target.id);
                // THE DISCRIMINATOR, and it is not a zero. Earlier rows in
                // this chain ARE named, so the walk legitimately excuses them
                // before reaching the bystander — asserting `0` here failed,
                // and it failed because the expectation was wrong, not the
                // verifier. What actually distinguishes "refused" from "never
                // consulted" is that the break lands on a row the record does
                // not name.
                const record = snapshotAfter.find((r) => r.action === ERASURE_EXECUTED_ACTION)!;
                expect(parseErasureRecordRows(record).map((n) => n.id)).not.toContain(target.id);
                // …and the walk stopped EARLY: fewer rows were excused than
                // on the untampered chain, because it never got that far.
                expect(tampered.toleratedPseudonymizations)
                    .toBeLessThan(chainAfter!.toleratedPseudonymizations);
            },
        );

        const restored = await snapshotAudit();
        expect(restored.find((r) => r.id === target.id)!.userId).toBe(BYSTANDER);
    });

    it('A FORGED RECORD — tampering with the erasure entry itself breaks the chain at the entry', async () => {
        // The record is not privileged. It sits inside the protection it
        // helps interpret, so an entry whose own hash does not recompute
        // breaks the chain where it stands — which is what "no second source
        // of truth outside the chain's protection" means operationally.
        const record = snapshotAfter.find((r) => r.action === ERASURE_EXECUTED_ACTION)!;
        const originalHash = record.entryHash!;

        await withTamper(
            () => tamperAuditRow(globalPrisma, record.id, 'entryHash', 'f'.repeat(64)),
            () => tamperAuditRow(globalPrisma, record.id, 'entryHash', originalHash),
            async () => {
                const tampered = await verifyAuditChain(TENANT, globalPrisma);
                expect(tampered.valid).toBe(false);
                expect(tampered.firstBreakId).toBe(record.id);
                // The rows it names are still excused — the break is at the
                // record, not a cascade that would make this test
                // indistinguishable from the two above.
                expect(tampered.toleratedPseudonymizations).toBe(subjectRowIdsBefore.length);
            },
        );

        const restored = await snapshotAudit();
        expect(restored.find((r) => r.id === record.id)!.entryHash).toBe(originalHash);
    });

    it('MECHANISM — actorUserId is one of the hashed fields, which is WHY the recomputation fails', () => {
        // The causal claim behind the finding, anchored where a fix would
        // land. Dropping `actorUserId` from the hash is one of the available
        // repairs; taking it silently would turn the finding above green for
        // a reason nobody recorded, and this line is what stops that.
        expect([...HASH_FIELDS]).toContain('actorUserId');
    });
});
