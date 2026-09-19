/**
 * Structural ratchet — DSAR workflow (GDPR Art. 15 / 17).
 *
 * The DSAR feature is a multi-PR sequence (see docs/dsar.md). This ratchet
 * holds the foundation's shape AND the safety invariants that every later
 * stage must preserve:
 *   - the DataSubjectRequest model + the two job files exist,
 *   - the erasure path carries a 24h cooling-off guard,
 *   - the rejection criteria are enumerated as constants,
 *   - docs/dsar.md has its five canonical sections (including the
 *     pseudonymization-not-deletion one),
 *   - data-retention.md cross-links to it.
 *
 * A future stage that drops the cooling-off guard or removes a rejection
 * reason fails CI here.
 *
 * The GDPR pseudonymization invariant is held BEHAVIOURALLY (#2287): the
 * `erasure pseudonymizes the audit trail` block below RUNS `eraseUser` against
 * an instrumented in-memory client and asserts on what it did. No assertion in
 * that block reads the source of `dsar-erasure.ts`, because the pair it
 * replaced was satisfied by that file's JSDoc.
 *
 * As of Stage 3 that grading is LIVE rather than pinned: `eraseUser` executes,
 * so the `B.` block below grades a real erasure instead of an empty list. Read
 * tests/helpers/dsar-erasure-probe.ts before adding to it.
 */
import fs from 'fs';
import path from 'path';
import { codeOf } from '../helpers/source-blocks';
import { eraseUser } from '@/app-layer/jobs/dsar-erasure';
import {
    BYSTANDER_ID,
    codesOf,
    driveErasure,
    erasureViolations,
    SUBJECT_ID,
    type ErasureImpl,
    type ProbeAuditRow,
} from '../helpers/dsar-erasure-probe';

// The probe injects through two seams (see its header): the injectable-`db`
// option, and this mock of the `@/lib/prisma` singleton. Stage 3's `eraseUser`
// takes the injectable-`db` option, so that is the seam actually exercised
// here; the mock stays because the module's DEFAULT path resolves a client
// through `@/lib/db-context` -> `@/lib/prisma`, and without it an
// implementation that stopped honouring `options.db` would build a real one.
jest.mock('@/lib/prisma', () => ({
    get prisma() {
        return require('../helpers/dsar-erasure-probe').activeErasureClient();
    },
}));

const ROOT = path.resolve(__dirname, '../..');
const readRaw = (rel: string) =>
    fs.existsSync(path.join(ROOT, rel)) ? fs.readFileSync(path.join(ROOT, rel), 'utf-8') : '';
const read = (rel: string) => codeOf(readRaw(rel));

const authSchema = read('prisma/schema/auth.prisma');
const enums = read('prisma/schema/enums.prisma');
const dsarLib = read('src/lib/dsar.ts');
const erasure = read('src/app-layer/jobs/dsar-erasure.ts');
const exportJob = read('src/app-layer/jobs/dsar-export.ts');
// Markdown: RAW — these two assertions are deliberately about prose, and
// codeOf() would mask `//` inside links/URLs.
const doc = readRaw('docs/dsar.md');
const retention = readRaw('docs/data-retention.md');

describe('DSAR schema + jobs', () => {
    it('DataSubjectRequest model + its enums exist', () => {
        expect(authSchema).toMatch(/model\s+DataSubjectRequest\s*\{/);
        expect(enums).toMatch(/enum\s+DataSubjectRequestType\s*\{/);
        expect(enums).toMatch(/enum\s+DataSubjectRequestStatus\s*\{/);
    });

    it('both job files exist', () => {
        expect(erasure.length).toBeGreaterThan(0);
        expect(exportJob.length).toBeGreaterThan(0);
    });
});

describe('erasure safety invariants', () => {
    it('the erasure path carries a 24h cooling-off check', () => {
        expect(dsarLib).toMatch(/DSAR_COOLING_OFF_HOURS\s*=\s*24/);
        expect(erasure).toMatch(/coolingOffElapsed/);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// The pseudonymization-not-deletion invariant (#2287, from #2246 Class A).
//
// WHAT THIS REPLACED. Until #2246 this was two source-text needles:
//
//     expect(erasure).toMatch(/userId\s*=\s*NULL/i);
//     expect(erasure).toMatch(/NOT deletion|not delet/i);
//
// Both strings exist only in the JSDoc of `eraseUser`. Measured on the
// pre-#2246 guard, both directions: prose present + a body of
// `prisma.auditLog.deleteMany({ where: { userId } })` → 7/7 GREEN; prose
// removed + a CORRECT pseudonymizing body → RED on exactly that assertion.
// The needle tracked the paragraph. #2246 replaced it with a source-text
// tripwire on the stub's shape (`Promise<never>` + the unconditional throw);
// #2417 replaced THAT with the behavioural form, and the tripwire is gone.
//
// WHAT IS PROVEN. Stage 3 landed and `eraseUser` executes, so the grading is
// live. Two blocks, and the distinction between them is the whole point:
//
//   B — THE REAL `eraseUser`, driven through the probe and graded. This is
//       the invariant, on the shipped function. It used to be vacuous (the
//       stub refused, so there was nothing to grade); it is not any more.
//   C — the oracle's own discrimination, proved by driving deliberately
//       broken implementations through the SAME harness. These grade
//       SYNTHETIC code, and they are what makes B's green mean something:
//       an oracle that cannot fail would report B green whatever `eraseUser`
//       did. C2 is the exact mutation that the pre-#2246 guard passed.
//
// A1/A2 USED TO LIVE HERE AND ARE DELETED (Stage 3). They asserted the stub
// was still a stub — that `eraseUser` refused at runtime and touched nothing
// — precisely so they would go RED the day somebody implemented it. They went
// red. That failure was the handshake, and deleting them is the other half of
// it: leaving them is how a half-done erasure looks finished. Their duty did
// not vanish with them, it INVERTED — B1 now requires the outcome to be
// EXECUTED, so reverting `eraseUser` to a refusing stub reddens here instead
// of passing quietly.
// ─────────────────────────────────────────────────────────────────────────

/** Narrow view of the probe client the synthetic implementations use. */
const dbOf = (options?: { db?: unknown }) =>
    options!.db as {
        auditLog: {
            findMany(a: unknown): Promise<ProbeAuditRow[]>;
            updateMany(a: unknown): Promise<unknown>;
            deleteMany(a: unknown): Promise<unknown>;
        };
        notification: { deleteMany(a: unknown): Promise<unknown> };
        $executeRawUnsafe(sql: string): Promise<number>;
    };

describe('erasure pseudonymizes the audit trail, it does not delete it', () => {
    // ── B. THE REAL ERASURE, GRADED ───────────────────────────────────
    it('B1 — the real eraseUser executes and satisfies the invariant', async () => {
        const run = await driveErasure();
        // Violations FIRST: their detail carries the instruction a reader
        // needs when the run turns out not to be gradeable at all. UNOBSERVED
        // (returned without touching the probe — it reached a database this
        // harness is not wired to) and ERRORED are reported as violations,
        // never as a pass.
        expect(erasureViolations(run)).toEqual([]);
        // NOT `['REFUSED', 'EXECUTED']`, which is what this line said while
        // erasure was a stub. REFUSED is no longer an acceptable answer from
        // this function, and an oracle that still accepted it would grade a
        // reverted stub as compliant.
        expect(run.outcome).toBe('EXECUTED');
    });

    it('B2 — the audit rows survive it: de-attributed, otherwise intact', async () => {
        const run = await driveErasure();
        const before = run.before.auditLog as unknown as ProbeAuditRow[];
        const after = run.after.auditLog as unknown as ProbeAuditRow[];

        // SURVIVE — every row still there, by id.
        expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
        // DE-ATTRIBUTED — the subject is gone from all of them...
        expect(after.filter((r) => r.userId === SUBJECT_ID)).toEqual([]);
        // ...and ONLY the subject. The bystander is the blast-radius control:
        // an erasure that nulls every `userId` in the table satisfies the line
        // above while destroying everyone else's attribution.
        expect(after.filter((r) => r.userId === BYSTANDER_ID).map((r) => r.id)).toEqual(
            before.filter((r) => r.userId === BYSTANDER_ID).map((r) => r.id),
        );
        // INTACT — the hash chain is the thing deletion would break, so it is
        // asserted column by column rather than left to the generic diff.
        expect(after.map((r) => r.entryHash)).toEqual(before.map((r) => r.entryHash));
        expect(after.map((r) => r.previousHash)).toEqual(before.map((r) => r.previousHash));
    });

    it('B3 — it never ISSUES a delete or raw SQL against the audit trail', async () => {
        const run = await driveErasure();
        // INTENT, not outcome, and that is the point of reading `ops`. The
        // before/after diff reports AUDIT_ROW_DELETED only for rows that were
        // actually removed — so an implementation whose delete matched nothing
        // on this fixture would pass it. "An empty selection is a PASS" is the
        // exact shape that let 21 audit-deleting teardowns survive (#2510).
        const auditOps = run.ops.filter((op) => op.table === 'auditLog');
        expect(auditOps.map((op) => op.method)).toEqual(['updateMany']);
        expect(run.ops.filter((op) => op.table === '$raw')).toEqual([]);
        // Non-vacuous: `auditOps` being empty would satisfy neither line
        // above, and the run really did reach more than the audit table.
        expect(run.ops.length).toBeGreaterThan(auditOps.length);
    });

    it('B4 — a subject it cannot see is refused, and nothing is written', async () => {
        // The blindness case, and the reason `eraseUser` opens with a read it
        // does not otherwise need: a wrong column or a mistyped id makes an
        // erasure that touched nothing look exactly like one that had nothing
        // to touch — and the second reports success.
        const run = await driveErasure(eraseUser as unknown as ErasureImpl, 'user-absent-2287');
        expect(run.error?.message).toMatch(/not visible to this connection/i);
        expect(run.after).toEqual(run.before);
    });

    // ── C. THE ORACLE DISCRIMINATES (synthetic implementations) ───────
    const pseudonymizing: ErasureImpl = async (userId, options) => {
        await dbOf(options).auditLog.updateMany({
            where: { userId },
            data: { userId: null },
        });
    };

    it('C1 — a compliant erasure passes: rows survive, userId is NULL', async () => {
        const run = await driveErasure(pseudonymizing);
        expect(run.outcome).toBe('EXECUTED');
        expect(erasureViolations(run)).toEqual([]);
        // The rows are still there, and the subject is gone from them.
        const after = run.after.auditLog as unknown as ProbeAuditRow[];
        expect(after).toHaveLength((run.before.auditLog as unknown[]).length);
        expect(after.filter((r) => r.userId === SUBJECT_ID)).toEqual([]);
        expect(after.map((r) => r.entryHash)).toEqual(
            (run.before.auditLog as unknown as ProbeAuditRow[]).map((r) => r.entryHash),
        );
    });

    it('C2 — deleting the audit rows fails (the mutation #2246 measured as green)', async () => {
        const run = await driveErasure(async (userId, options) => {
            await dbOf(options).auditLog.deleteMany({ where: { userId } });
        });
        expect(run.outcome).toBe('EXECUTED');
        expect(codesOf(erasureViolations(run))).toEqual([
            'AUDIT_DELETE_ISSUED',
            'AUDIT_ROW_DELETED',
            'AUDIT_ROW_DELETED',
            'AUDIT_ROW_DELETED',
        ]);
    });

    it('C3 — an erasure that leaves the subject linked fails', async () => {
        const run = await driveErasure(async (userId, options) => {
            await dbOf(options).auditLog.findMany({ where: { userId } });
        });
        expect(codesOf(erasureViolations(run))).toEqual([
            'SUBJECT_STILL_LINKED',
            'SUBJECT_STILL_LINKED',
            'SUBJECT_STILL_LINKED',
        ]);
    });

    it('C4 — nulling userId but rewriting the hash chain fails', async () => {
        const run = await driveErasure(async (userId, options) => {
            await dbOf(options).auditLog.updateMany({
                where: { userId },
                data: { userId: null, entryHash: 'rewritten', previousHash: null },
            });
        });
        const codes = codesOf(erasureViolations(run));
        expect(codes).toContain('AUDIT_HISTORY_MUTATED');
        expect(codes).not.toContain('SUBJECT_STILL_LINKED');
    });

    it('C5 — anonymizing every row, not just the subject\'s, fails', async () => {
        const run = await driveErasure(async (_userId, options) => {
            await dbOf(options).auditLog.updateMany({ where: {}, data: { userId: null } });
        });
        expect(codesOf(erasureViolations(run))).toEqual([
            'FOREIGN_ROW_TOUCHED',
            'FOREIGN_ROW_TOUCHED',
        ]);
    });

    it('C6 — raw SQL against AuditLog is unverifiable, not compliant', async () => {
        const run = await driveErasure(async (userId, options) => {
            await dbOf(options).$executeRawUnsafe(
                `UPDATE "AuditLog" SET "userId" = NULL WHERE "userId" = '${userId}'`,
            );
        });
        expect(codesOf(erasureViolations(run))).toContain('UNVERIFIABLE_RAW_SQL');
    });

    it('C7 — writing to a table with no declared disposition fails', async () => {
        const run = await driveErasure(async (userId, options) => {
            await dbOf(options).auditLog.updateMany({
                where: { userId },
                data: { userId: null },
            });
            await dbOf(options).notification.deleteMany({ where: { userId } });
        });
        expect(codesOf(erasureViolations(run))).toEqual(['UNDECLARED_TABLE_TOUCHED']);
    });

    it('C8 — an implementation the probe cannot see is not a pass', async () => {
        const run = await driveErasure(async () => {
            /* reaches a database the probe is not wired to */
        });
        expect(run.outcome).toBe('UNOBSERVED');
        expect(codesOf(erasureViolations(run))).toEqual(['UNOBSERVED_EXECUTION']);
    });

    it('C9 — an implementation that fails before touching anything is not a pass', async () => {
        const run = await driveErasure(async () => {
            throw new Error('connection refused');
        });
        expect(run.outcome).toBe('ERRORED');
        expect(codesOf(erasureViolations(run))).toEqual(['UNOBSERVED_EXECUTION']);
    });
});

describe('rejection criteria are enumerated', () => {
    it('LAST_OWNER, OUTSTANDING_BALANCE, LEGAL_HOLD are constants', () => {
        for (const k of ['LAST_OWNER', 'OUTSTANDING_BALANCE', 'LEGAL_HOLD']) {
            expect(dsarLib).toContain(k);
        }
        expect(dsarLib).toMatch(/export function evaluateDsarRejection/);
    });
});

describe('documentation', () => {
    const REQUIRED = [
        '## Workflow',
        '## Rejection criteria',
        '## Audit-log pseudonymization (not deletion)',
        '## Export bundle contents',
        '## What happens to authored content',
    ];
    it('docs/dsar.md has the five canonical sections', () => {
        expect(doc.length).toBeGreaterThan(0);
        const missing = REQUIRED.filter((h) => !doc.includes(`\n${h}\n`));
        expect(missing).toEqual([]);
    });

    it('data-retention.md cross-links to dsar.md', () => {
        expect(retention).toMatch(/dsar\.md/);
    });
});
