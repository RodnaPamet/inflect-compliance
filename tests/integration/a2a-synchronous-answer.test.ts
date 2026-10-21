/**
 * WHERE THE SYNCHRONOUS ANSWER'S WORDS COME FROM (#3863).
 *
 * The two engines record an answer in different places, and the same workflow
 * key settles on either depending on what the deployment permits — so both have
 * to be read, and which one wins when both exist has to be decided rather than
 * left to query order.
 *
 *   FLUE    `AiDecisionLog.outputSummary`, joined to the run by `sessionRef`
 *   STATIC  the last SYNTHESIS `WorkflowStep.outputJson`, as `{ text, data }`
 *
 * The last test here is the one that protects the whole design: this reader
 * creates a sink for model prose OUTSIDE the Art 12 row, and what makes that
 * safe is the egress scan the A2A answer already passes. So a planted secret in
 * model output is caught — asserted against the real guard rather than assumed
 * from its presence in the call chain.
 */
import { PrismaClient } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { buildSystemContext } from '@/app-layer/context-system';
import { guardEgress } from '@/app-layer/ai/guard';
import { A2A_ANSWER_TEXT_MAX, settledRunAnswerText } from '@/app-layer/usecases/a2a-run-answer';

const prisma: PrismaClient = prismaTestClient();

const T = 'hcsync1';
const OTHER = 'hcsync2';
const TENANTS = [T, OTHER];

const ctx = (tenantId = T) => buildSystemContext({ tenantId, tenantSlug: tenantId, job: 'a2a-sync-test' });

let agentId = '';
let userId = '';

async function makeRun(tenantId: string, status = 'COMPLETED'): Promise<string> {
    const run = await prisma.workflowRun.create({
        data: {
            tenantId,
            workflowKey: 'sap-transaction-review',
            status: status as never,
            ...(tenantId === T ? { agentId } : {}),
        },
        select: { id: true },
    });
    return run.id;
}

/** A Flue run's answer: the model's final text on the Art 12 row. */
async function recordModelAnswer(tenantId: string, runId: string, text: string): Promise<void> {
    await prisma.aiDecisionLog.create({
        data: {
            tenantId,
            feature: 'agentic.flue',
            provider: 'anthropic',
            inputDigest: `digest-${runId}`,
            outputSummary: text,
            sessionRef: runId,
        },
    });
}

/** A static run's answer: the SYNTHESIS step's recorded output. */
async function recordSynthesisStep(tenantId: string, runId: string, payload: string, seq = 3): Promise<void> {
    await prisma.workflowStep.create({
        data: { tenantId, runId, seq, kind: 'SYNTHESIS', outputJson: payload },
    });
}

beforeAll(async () => {
    await deleteAuditRowsForTenants(prisma, TENANTS);
    await resetDatabase(prisma);
    await prisma.user.deleteMany({ where: { email: `owner@${T}.test` } });
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });

    for (const t of TENANTS) await prisma.tenant.create({ data: { id: t, name: t, slug: t } });
    const user = await prisma.user.create({
        data: { email: `owner@${T}.test`, name: 'Owner', passwordHash: 'x' },
    });
    userId = user.id;
    await prisma.tenantMembership.create({ data: { tenantId: T, userId, role: 'OWNER', status: 'ACTIVE' } });
    const sys = await prisma.aiSystem.create({ data: { tenantId: T, name: 'sys' } });
    const agent = await prisma.registeredAgent.create({
        data: {
            tenantId: T,
            aiSystemId: sys.id,
            name: 'receiver',
            autonomyLevel: 1,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: userId,
        },
    });
    agentId = agent.id;
}, 120_000);

afterAll(async () => {
    await prisma.$disconnect();
});

describe('a FLUE run answers from the Art 12 row', () => {
    it('returns the model’s recorded text', async () => {
        const runId = await makeRun(T);
        await recordModelAnswer(T, runId, 'PO 4500001234 breaches CTL-SOD-01: creator and approver are usr_1182.');
        expect(await settledRunAnswerText(ctx(), runId)).toContain('CTL-SOD-01');
    });

    it('takes the LATEST row when a run decided more than once', async () => {
        const runId = await makeRun(T);
        await recordModelAnswer(T, runId, 'first pass, incomplete');
        await new Promise((r) => setTimeout(r, 5));
        await recordModelAnswer(T, runId, 'the settled answer');
        expect(await settledRunAnswerText(ctx(), runId)).toBe('the settled answer');
    });

    it('ignores a row whose summary is null rather than returning empty words', async () => {
        const runId = await makeRun(T);
        await prisma.aiDecisionLog.create({
            data: {
                tenantId: T,
                feature: 'agentic.flue',
                provider: 'anthropic',
                inputDigest: `d-${runId}`,
                sessionRef: runId,
                outputSummary: null,
            },
        });
        expect(await settledRunAnswerText(ctx(), runId)).toBeNull();
    });
});

describe('a STATIC run answers from its SYNTHESIS step', () => {
    it('returns the step’s text', async () => {
        const runId = await makeRun(T);
        await recordSynthesisStep(T, runId, JSON.stringify({ text: 'Two documents supplied; no approver given.' }));
        expect(await settledRunAnswerText(ctx(), runId)).toContain('no approver given');
    });

    it('takes the LAST synthesis when a definition synthesises twice', async () => {
        const runId = await makeRun(T);
        await recordSynthesisStep(T, runId, JSON.stringify({ text: 'interim' }), 2);
        await recordSynthesisStep(T, runId, JSON.stringify({ text: 'final' }), 7);
        expect(await settledRunAnswerText(ctx(), runId)).toBe('final');
    });

    it('is null for a payload with no text member, not a throw', async () => {
        const runId = await makeRun(T);
        await recordSynthesisStep(T, runId, JSON.stringify({ data: { documents: 2 } }));
        expect(await settledRunAnswerText(ctx(), runId)).toBeNull();
    });

    it('is null for a payload that is not JSON at all, not a throw', async () => {
        // This runs inside a response path: a parse error here would turn a
        // settled run into a failed request.
        const runId = await makeRun(T);
        await recordSynthesisStep(T, runId, '{not json');
        await expect(settledRunAnswerText(ctx(), runId)).resolves.toBeNull();
    });

    it('ignores a READ step’s output — only a SYNTHESIS answers', async () => {
        const runId = await makeRun(T);
        await prisma.workflowStep.create({
            data: { tenantId: T, runId, seq: 1, kind: 'READ', outputJson: JSON.stringify({ text: 'tool output' }) },
        });
        expect(await settledRunAnswerText(ctx(), runId)).toBeNull();
    });
});

describe('when both sources exist, the model wins', () => {
    it('prefers the Art 12 text over the step', async () => {
        // A Flue run carries step rows too, so preferring the step would return
        // scaffolding instead of the answer. Decided, not left to query order.
        const runId = await makeRun(T);
        await recordSynthesisStep(T, runId, JSON.stringify({ text: 'engine scaffolding' }));
        await recordModelAnswer(T, runId, 'the model’s judgement');
        expect(await settledRunAnswerText(ctx(), runId)).toBe('the model’s judgement');
    });
});

describe('bounds and isolation', () => {
    it('truncates a very long answer WITH a marker', async () => {
        const runId = await makeRun(T);
        await recordModelAnswer(T, runId, 'x'.repeat(A2A_ANSWER_TEXT_MAX + 500));
        const text = await settledRunAnswerText(ctx(), runId);
        expect(text).not.toBeNull();
        expect(text!.length).toBeLessThan(A2A_ANSWER_TEXT_MAX + 200);
        // Marked rather than silent: a sentence stopping mid-word with nothing
        // saying why is a wrong answer, not a short one.
        expect(text).toContain('truncated');
    });

    it('does not return another tenant’s answer for the same run id', async () => {
        // The run belongs to OTHER; reading it under T must find nothing, which
        // is the property RLS is there for and worth asserting rather than
        // assuming.
        const runId = await makeRun(OTHER);
        await recordModelAnswer(OTHER, runId, 'another tenant’s review');
        expect(await settledRunAnswerText(ctx(T), runId)).toBeNull();
        // The positive control: under its OWN tenant the same row is found, so
        // the null above is isolation rather than a broken fixture.
        expect(await settledRunAnswerText(ctx(OTHER), runId)).toBe('another tenant’s review');
    });

    it('is null for a run that recorded nothing at all', async () => {
        expect(await settledRunAnswerText(ctx(), await makeRun(T))).toBeNull();
    });
});

describe('the egress scan is what makes this sink safe', () => {
    it('catches a planted secret in model output before it could leave', async () => {
        // THE ASSERTION THE DESIGN RESTS ON. Model free-text is not scanned on
        // the way out of the model; the reason sending it to another
        // organisation is acceptable is that the A2A answer passes `guardEgress`
        // first. Proved against the real guard, with the payload shaped as the
        // response is.
        // A SYNTHETIC key shape, never a real credential: it has to look like one
        // or the guard has nothing to catch, which is why the line carries the
        // allowlist pragma the repo's own scanner documents. The repo scanner and
        // the egress guard are looking for the same shape, so a test that proves
        // the second necessarily trips the first.
        const planted =
            'Review complete. Credentials: sk-ant-api03-'
            + 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; // pragma: allowlist secret
        const outcome = await guardEgress(ctx(), { status: { message: { parts: [{ text: planted }] } } }, {
            source: 'a2a-inbound-answer',
        });
        expect(outcome.reviewRequired || outcome.blocked).toBe(true);
    });

    it('lets an ordinary review answer through, so the scan is not refusing everything', async () => {
        // The discriminating control. A guard that flagged every answer would
        // satisfy the test above and make the feature useless.
        const ordinary = 'PO 4500001234 breaches CTL-SOD-01: createdBy and approvedBy are both usr_1182.';
        const outcome = await guardEgress(ctx(), { status: { message: { parts: [{ text: ordinary }] } } }, {
            source: 'a2a-inbound-answer',
        });
        expect(outcome.reviewRequired || outcome.blocked).toBe(false);
    });
});
