/**
 * D-EV-8 (owner decision 2026-11-15) — one run's EU AI Act Art 12 rows, as JSON.
 *
 * `readRunDecisionRows` serves `GET /agent-runs/:id/decisions`, which the
 * Inspect harness reads to count a run's decision rows against its model calls.
 * Against a real database, real RLS and the append-only table:
 *
 *   1. THE RUN'S ROWS AND NO OTHERS. A row is the run's when its `sessionRef` is
 *      the run id on a run feature; a sibling run's rows, and a row of another
 *      feature that happens to carry the same `sessionRef`, are not.
 *   2. FIVE FIELDS AND NO TEXT. The row's id, input digest, agent, time and
 *      outcome code; never the output summary the decisions page shows.
 *   3. TWO TENANTS. Tenant A reading tenant B's run, and B reading A's, is
 *      not-found, asserted after proving the run EXISTS, so the refusal is the
 *      tenant predicate and not a wrong id.
 *   4. THE DECISION LOG'S OWN RULE. An AUDITOR passes the run's gate (the view
 *      key) and reads the rows only while the owner's switch lets Auditors read
 *      the log, exactly as on `/agents/decisions`.
 *   5. BOUNDED, AND SAYS SO. A run with more rows than the cap returns the cap
 *      and `truncated: true`, never a prefix posing as the whole.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { readRunDecisionRows, RUN_DECISION_ROWS_CAP } from '@/app-layer/usecases/ai-decision-log';
import { makeRequestContext } from '../helpers/make-context';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `rdr-${randomUUID().slice(0, 8)}`;
const TENANT_A = `ta-${SUITE}`;
const TENANT_B = `tb-${SUITE}`;
const USER_A = `ua-${SUITE}`;
const USER_B = `ub-${SUITE}`;
const RUN_A = `run-a-${SUITE}`;
const RUN_A2 = `run-a2-${SUITE}`;
const RUN_BIG = `run-big-${SUITE}`;
const RUN_B = `run-b-${SUITE}`;
const DIGEST_1 = `sha256:${'1'.repeat(64)}`;
const DIGEST_2 = `sha256:${'2'.repeat(64)}`;
const SUMMARY = `${SUITE} the model said something a reviewer reads`;

const ctx = (role: 'OWNER' | 'AUDITOR', tenantId: string, userId: string) =>
    makeRequestContext(role, { tenantId, tenantSlug: tenantId, userId });

async function makeTenant(id: string, userId: string) {
    await prisma.tenant.create({ data: { id, name: id, slug: id } });
    const email = `${id}@example.test`;
    await prisma.user.create({ data: { id: userId, email, emailHash: hashForLookup(email) } });
    await prisma.tenantMembership.create({ data: { tenantId: id, userId, role: 'OWNER', status: 'ACTIVE' } });
}

async function makeRun(id: string, tenantId: string, userId: string) {
    await prisma.workflowRun.create({
        data: { id, tenantId, workflowKey: 'ad-hoc-question', status: 'COMPLETED', startedByUserId: userId },
    });
}

function row(tenantId: string, sessionRef: string, inputDigest: string, feature = 'agentic-run:ad-hoc-question') {
    return {
        tenantId,
        feature,
        provider: 'anthropic',
        model: 'conformance-model',
        inputDigest,
        outputSummary: SUMMARY,
        sessionRef,
        agentId: 'agent-1',
    };
}

describeFn('one run’s decision rows (D-EV-8, real DB, real RLS)', () => {
    const runRowIds: string[] = [];

    beforeAll(async () => {
        await prisma.$connect();
        await makeTenant(TENANT_A, USER_A);
        await makeTenant(TENANT_B, USER_B);
        await makeRun(RUN_A, TENANT_A, USER_A);
        await makeRun(RUN_A2, TENANT_A, USER_A);
        await makeRun(RUN_BIG, TENANT_A, USER_A);
        await makeRun(RUN_B, TENANT_B, USER_B);

        // The run's own: two model calls over one dispatch, then a second
        // dispatch, then an outside tool call the run made.
        const mine = [
            row(TENANT_A, RUN_A, DIGEST_1),
            row(TENANT_A, RUN_A, DIGEST_1),
            row(TENANT_A, RUN_A, DIGEST_2),
            row(TENANT_A, RUN_A, DIGEST_2, 'agentic-tool:external'),
        ];
        for (const [i, data] of mine.entries()) {
            const created = await prisma.aiDecisionLog.create({
                data: { ...data, createdAt: new Date(Date.UTC(2026, 10, 15, 10, 0, i)) },
                select: { id: true },
            });
            runRowIds.push(created.id);
        }
        // Not the run's: a sibling run's, another feature carrying the run id as
        // its session, and tenant B's.
        await prisma.aiDecisionLog.create({ data: row(TENANT_A, RUN_A2, DIGEST_1) });
        await prisma.aiDecisionLog.create({ data: row(TENANT_A, RUN_A, DIGEST_1, 'risk-suggestions') });
        await prisma.aiDecisionLog.create({ data: row(TENANT_B, RUN_B, DIGEST_1) });
        // Past the cap, so the read must say it holds a prefix.
        await prisma.aiDecisionLog.createMany({
            data: Array.from({ length: RUN_DECISION_ROWS_CAP + 1 }, () => row(TENANT_A, RUN_BIG, DIGEST_1)),
        });
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    it('returns the run’s rows, oldest first, and no other run’s or feature’s', async () => {
        const read = await readRunDecisionRows(ctx('OWNER', TENANT_A, USER_A), RUN_A);
        expect(read.runId).toBe(RUN_A);
        expect(read.truncated).toBe(false);
        expect(read.rows.map((r) => r.id)).toEqual(runRowIds);
        expect(read.rows.map((r) => r.inputDigest)).toEqual([DIGEST_1, DIGEST_1, DIGEST_2, DIGEST_2]);
    });

    it('carries five fields and no text', async () => {
        const read = await readRunDecisionRows(ctx('OWNER', TENANT_A, USER_A), RUN_A);
        for (const r of read.rows) {
            expect(Object.keys(r).sort()).toEqual(['agentId', 'createdAt', 'humanOutcome', 'id', 'inputDigest']);
        }
        expect(read.rows[0]).toMatchObject({ agentId: 'agent-1', humanOutcome: 'PENDING', createdAt: '2026-11-15T10:00:00.000Z' });
        expect(JSON.stringify(read)).not.toContain(SUMMARY);
    });

    it('a run in the other tenant is not found, from either side', async () => {
        // The runs exist: the refusal below is the tenant predicate, not a wrong id.
        expect(await prisma.workflowRun.count({ where: { id: { in: [RUN_A, RUN_B] } } })).toBe(2);
        await expect(readRunDecisionRows(ctx('OWNER', TENANT_A, USER_A), RUN_B)).rejects.toMatchObject({ status: 404 });
        await expect(readRunDecisionRows(ctx('OWNER', TENANT_B, USER_B), RUN_A)).rejects.toMatchObject({ status: 404 });
        // And B reads its own, which carries none of A's rows.
        const own = await readRunDecisionRows(ctx('OWNER', TENANT_B, USER_B), RUN_B);
        expect(own.rows).toHaveLength(1);
    });

    it('an AUDITOR reads the rows only while the owner lets Auditors read the decision log', async () => {
        const auditor = ctx('AUDITOR', TENANT_A, USER_A);
        // The run's gate admits the AUDITOR (the view key); the log's own rule does not, by default.
        expect(auditor.appPermissions.admin.agent_registry_view).toBe(true);
        expect(auditor.appPermissions.admin.agent_registry).toBe(false);
        await expect(readRunDecisionRows(auditor, RUN_A)).rejects.toMatchObject({ status: 403 });

        await prisma.tenantSecuritySettings.upsert({
            where: { tenantId: TENANT_A },
            create: { tenantId: TENANT_A, auditorReadsAiDecisionLog: true },
            update: { auditorReadsAiDecisionLog: true },
        });
        try {
            const read = await readRunDecisionRows(auditor, RUN_A);
            expect(read.rows).toHaveLength(4);
        } finally {
            await prisma.tenantSecuritySettings.update({
                where: { tenantId: TENANT_A },
                data: { auditorReadsAiDecisionLog: false },
            });
        }
        await expect(readRunDecisionRows(auditor, RUN_A)).rejects.toMatchObject({ status: 403 });
    });

    it('a run past the cap returns the cap and says it is truncated', async () => {
        const read = await readRunDecisionRows(ctx('OWNER', TENANT_A, USER_A), RUN_BIG);
        expect(read.rows).toHaveLength(RUN_DECISION_ROWS_CAP);
        expect(read.truncated).toBe(true);
    });
});
