/**
 * EU AI Act Art 14 — the human-oversight outcome reaches the decision log.
 *
 * ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
 *
 * `createAgentProposal` has written the Art 12 record since the agentic work
 * landed: an input digest, a bounded summary, the guard verdict. Nothing ever
 * stamped its OUTCOME. `recordDecisionOutcome` existed and was called only from
 * `risk-suggestions.ts`, so every agentic decision sat at `humanOutcome:
 * PENDING` for ever and the oversight half of the register was open.
 *
 * ── WHY EVERY TEST HERE ASSERTS A COUNT ─────────────────────────────────────
 *
 * The stamp is an `updateMany`. When its filter matches nothing it reports
 * `count: 0` and raises no error — so a wrong join key produces a loop that
 * LOOKS closed, on a control whose entire job is to be evidence. That is not a
 * hypothetical: the obvious key is `sessionRef`, and for an ordinary agent
 * proposal `sessionRef` is NULL, so a session-keyed stamp matches nothing and
 * succeeds. The tests below assert the row actually moved, not that the call
 * returned.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { recordDecisionOutcomeForDigest } from '@/app-layer/ai/decision-log';
import { makeRequestContext } from '../helpers/make-context';
import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const TENANT = 'art14-tenant';
const OTHER = 'art14-other-tenant';
const DIGEST = 'sha256:aaaabbbbccccddddeeeeffff00001111222233334444555566667777888899990';
const OTHER_DIGEST = 'sha256:ffff0000111122223333444455556666777788889999aaaabbbbccccddddeeee';

const ctx = () => ({ ...makeRequestContext('ADMIN'), tenantId: TENANT });

async function seedDecision(
    id: string,
    tenantId: string,
    inputDigest: string,
    humanOutcome: 'PENDING' | 'ACCEPTED' | 'REJECTED' = 'PENDING',
) {
    await prisma.aiDecisionLog.create({
        data: {
            id,
            tenantId,
            feature: 'agent-proposal',
            provider: 'mcp-agent',
            inputDigest,
            humanOutcome,
        },
    });
}

const outcomeOf = async (id: string) =>
    (await prisma.aiDecisionLog.findUnique({ where: { id }, select: { humanOutcome: true } }))
        ?.humanOutcome;

describeFn('the Art 14 stamp lands on the right rows and no others', () => {
    beforeAll(async () => {
        for (const t of [TENANT, OTHER]) {
            await prisma.aiDecisionLog.deleteMany({ where: { tenantId: t } });
            await prisma.tenant.deleteMany({ where: { id: t } });
            await prisma.tenant.create({ data: { id: t, name: t, slug: t } });
        }
    });

    beforeEach(async () => {
        await prisma.aiDecisionLog.deleteMany({ where: { tenantId: { in: [TENANT, OTHER] } } });
    });

    afterAll(async () => {
        if (TENANT && OTHER) {
            await prisma.aiDecisionLog.deleteMany({ where: { tenantId: { in: [TENANT, OTHER] } } });
            await prisma.tenant.deleteMany({ where: { id: { in: [TENANT, OTHER] } } });
        }
        await prisma.$disconnect();
    });

    it('stamps the PENDING row for that digest, and SAYS it stamped one', async () => {
        await seedDecision('art14-a', TENANT, DIGEST);

        const stamped = await prisma.$transaction((db) =>
            recordDecisionOutcomeForDigest(db, ctx(), DIGEST, 'ACCEPTED'),
        );

        // The count is the assertion. `updateMany` matching nothing returns 0
        // and throws nothing, so "the call succeeded" proves precisely nothing.
        expect(stamped).toBe(1);
        expect(await outcomeOf('art14-a')).toBe('ACCEPTED');
    });

    it('carries EDITED rather than flattening a reviewer edit to ACCEPTED', async () => {
        // `approveAgentProposal` already returns 'ACCEPTED' | 'EDITED'; the
        // register should keep the distinction, because "a human accepted what
        // the agent proposed" and "a human had to change it first" are
        // different facts about oversight.
        await seedDecision('art14-b', TENANT, DIGEST);
        const stamped = await prisma.$transaction((db) =>
            recordDecisionOutcomeForDigest(db, ctx(), DIGEST, 'EDITED'),
        );
        expect(stamped).toBe(1);
        expect(await outcomeOf('art14-b')).toBe('EDITED');
    });

    it('is ONE-WAY: an already-stamped row is not re-stamped', async () => {
        // The record of a decision must not be rewritten by a later one.
        await seedDecision('art14-c', TENANT, DIGEST, 'ACCEPTED');

        const stamped = await prisma.$transaction((db) =>
            recordDecisionOutcomeForDigest(db, ctx(), DIGEST, 'REJECTED'),
        );

        expect(stamped).toBe(0);
        expect(await outcomeOf('art14-c')).toBe('ACCEPTED');
    });

    it('does not reach another tenant\'s decision with the same digest', async () => {
        // A digest is a hash of content, so two tenants proposing identical
        // content genuinely collide on it. The tenant term is what keeps that
        // from being a cross-tenant write.
        await seedDecision('art14-mine', TENANT, DIGEST);
        await seedDecision('art14-theirs', OTHER, DIGEST);

        const stamped = await prisma.$transaction((db) =>
            recordDecisionOutcomeForDigest(db, ctx(), DIGEST, 'ACCEPTED'),
        );

        expect(stamped).toBe(1);
        expect({
            mine: await outcomeOf('art14-mine'),
            theirs: await outcomeOf('art14-theirs'),
        }).toEqual({ mine: 'ACCEPTED', theirs: 'PENDING' });
    });

    it('does not reach a different digest in the same tenant', async () => {
        await seedDecision('art14-target', TENANT, DIGEST);
        await seedDecision('art14-bystander', TENANT, OTHER_DIGEST);

        await prisma.$transaction((db) =>
            recordDecisionOutcomeForDigest(db, ctx(), DIGEST, 'REJECTED'),
        );

        expect({
            target: await outcomeOf('art14-target'),
            bystander: await outcomeOf('art14-bystander'),
        }).toEqual({ target: 'REJECTED', bystander: 'PENDING' });
    });

    it('stamps EVERY pending row for a digest, not just the first', async () => {
        // A retried proposal writes a second Art 12 row with the same digest.
        // Leaving one of them PENDING would be a register that reports a human
        // is still deciding something already decided.
        await seedDecision('art14-dup-1', TENANT, DIGEST);
        await seedDecision('art14-dup-2', TENANT, DIGEST);

        const stamped = await prisma.$transaction((db) =>
            recordDecisionOutcomeForDigest(db, ctx(), DIGEST, 'ACCEPTED'),
        );

        expect(stamped).toBe(2);
    });

    it('reports zero — rather than throwing — when there is nothing to stamp', async () => {
        // The caller treats the stamp as best-effort so a logging failure never
        // undoes an applied proposal. That makes the RETURNED COUNT the only
        // signal, which is why it is asserted everywhere above.
        const stamped = await prisma.$transaction((db) =>
            recordDecisionOutcomeForDigest(db, ctx(), 'sha256:nothing-matches-this', 'ACCEPTED'),
        );
        expect(stamped).toBe(0);
    });
});

describeFn('the index the stamp relies on exists', () => {
    afterAll(async () => {
        await prisma.$disconnect();
    });

    it('has a (tenantId, inputDigest) composite on AiDecisionLog', async () => {
        // The table grows one row per AI-feature invocation. Without this the
        // stamp scans everything the tenant has ever generated, on a path a
        // reviewer waits for — a correctness-neutral, latency-fatal omission
        // that no behavioural test would ever notice.
        const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`
            SELECT indexdef FROM pg_indexes
            WHERE tablename = 'AiDecisionLog'
              AND indexdef LIKE '%inputDigest%'
        `;
        expect(rows.length).toBeGreaterThan(0);
        expect(rows[0].indexdef).toContain('tenantId');
    });
});
