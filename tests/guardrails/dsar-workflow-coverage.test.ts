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
 * replaced was satisfied by that file's JSDoc. What it can and cannot prove
 * while erasure is a Stage-1 stub is spelled out above the block and in
 * tests/helpers/dsar-erasure-probe.ts — read that before adding to it.
 */
import fs from 'fs';
import path from 'path';
import { codeOf } from '../helpers/source-blocks';
import { eraseUser } from '@/app-layer/jobs/dsar-erasure';
import {
    codesOf,
    driveErasure,
    erasureViolations,
    SUBJECT_ID,
    type ErasureImpl,
    type ProbeAuditRow,
} from '../helpers/dsar-erasure-probe';

// The probe injects through two seams (see its header): the injectable-`db`
// option, and this mock of the `@/lib/prisma` singleton. `eraseUser` imports
// no client today, so the mock is inert until Stage 3 — at which point it is
// already in the path rather than something someone has to remember.
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
// this replaces THAT with the behavioural form, and the tripwire is gone —
// A1/A2 below cover the same "it goes red when erasure starts working" duty
// by running the function instead of reading it.
//
// WHAT IS PROVEN, AND WHAT IS NOT. Erasure is a Stage-1 stub. There is no
// erasure behaviour in this repo to verify and nothing here claims there is:
//
//   A — true TODAY, observed by running the real `eraseUser`.
//   B — the invariant, wired to the real `eraseUser` but grading nothing yet,
//       because A is what the real function does. Marked vacuous where it is.
//   C — the oracle's own discrimination, proved by driving deliberately
//       broken implementations through the SAME harness. These are the only
//       assertions here that see an executed erasure, and the implementations
//       they grade are synthetic. C2 is the exact mutation that the pre-#2246
//       guard passed.
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
    // ── A. WHAT IS TRUE TODAY ─────────────────────────────────────────
    it('A1 — the real eraseUser refuses at runtime (Stage-1 stub)', async () => {
        await expect(eraseUser(SUBJECT_ID)).rejects.toThrow(/execution is not enabled/i);
    });

    it('A2 — the refusal is total: no table touched, no row changed', async () => {
        const run = await driveErasure();
        expect(run.outcome).toBe('REFUSED');
        expect(run.ops).toEqual([]);
        expect(run.after).toEqual(run.before);
    });

    // ── B. THE INVARIANT, PINNED ──────────────────────────────────────
    it('B1 — the real eraseUser either refuses or satisfies the invariant', async () => {
        const run = await driveErasure();
        // VACUOUS TODAY, AND SAID OUT LOUD: `run.outcome` is REFUSED (A2), so
        // there is no executed erasure to grade — this asserts the empty list
        // against an empty list. It stops being vacuous the moment A1/A2 go
        // red, which is the moment somebody implements Stage 3; the C block
        // below is what proves it discriminates when that happens. Asserted
        // FIRST because its violation detail carries the instruction a reader
        // needs when the run turns out not to be gradeable at all.
        expect(erasureViolations(run)).toEqual([]);
        // UNOBSERVED (reached a database the probe is not wired to) and
        // ERRORED are failures, not passes.
        expect(['REFUSED', 'EXECUTED']).toContain(run.outcome);
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
