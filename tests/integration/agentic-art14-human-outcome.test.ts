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
 *
 * ── WHY THE KEY IS THE PROPOSAL, NOT THE DIGEST (#5191) ─────────────────────
 *
 * The digest is a pure function of the proposal's content, and identical
 * content is not de-duplicated, so a digest-keyed stamp moved every identical
 * proposal's row on the first decision. The row now names its proposal, and
 * the digest is read only for a LEGACY row that names none — and only when it
 * is the single pending row for that digest.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { recordDecisionOutcomeForProposal } from '@/app-layer/ai/decision-log';
import { makeRequestContext } from '../helpers/make-context';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const TENANT = 'art14-tenant';
const OTHER = 'art14-other-tenant';
const DIGEST = 'sha256:aaaabbbbccccddddeeeeffff00001111222233334444555566667777888899990';
const OTHER_DIGEST = 'sha256:ffff0000111122223333444455556666777788889999aaaabbbbccccddddeeee';

const ctx = () => ({ ...makeRequestContext('ADMIN'), tenantId: TENANT });

/**
 * One Art 12 row. `agentProposalId` is the proposal it records — what
 * `createAgentProposal` writes since #5191 — and `null` is a LEGACY row, written
 * before that column existed.
 */
async function seedDecision(
    id: string,
    tenantId: string,
    inputDigest: string,
    agentProposalId: string | null,
    humanOutcome: 'PENDING' | 'ACCEPTED' | 'REJECTED' = 'PENDING',
) {
    await prisma.aiDecisionLog.create({
        data: {
            id,
            tenantId,
            feature: 'agent-proposal',
            provider: 'mcp-agent',
            inputDigest,
            agentProposalId,
            humanOutcome,
        },
    });
}

const outcomeOf = async (id: string) =>
    (await prisma.aiDecisionLog.findUnique({ where: { id }, select: { humanOutcome: true } }))
        ?.humanOutcome;

const stamp = (
    proposalId: string,
    inputDigest: string | null,
    outcome: 'ACCEPTED' | 'EDITED' | 'REJECTED',
) =>
    prisma.$transaction((db) =>
        recordDecisionOutcomeForProposal(db, ctx(), { proposalId, inputDigest }, outcome),
    );

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

    it('stamps the PENDING row that names the proposal, and SAYS it stamped one', async () => {
        await seedDecision('art14-a', TENANT, DIGEST, 'prop-a');

        const stamped = await stamp('prop-a', DIGEST, 'ACCEPTED');

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
        await seedDecision('art14-b', TENANT, DIGEST, 'prop-b');
        expect(await stamp('prop-b', DIGEST, 'EDITED')).toBe(1);
        expect(await outcomeOf('art14-b')).toBe('EDITED');
    });

    it('is ONE-WAY: an already-stamped row is not re-stamped', async () => {
        // The record of a decision must not be rewritten by a later one.
        await seedDecision('art14-c', TENANT, DIGEST, 'prop-c', 'ACCEPTED');

        expect(await stamp('prop-c', DIGEST, 'REJECTED')).toBe(0);
        expect(await outcomeOf('art14-c')).toBe('ACCEPTED');
    });

    it("does not fall back to the digest when the proposal's own row is already decided", async () => {
        // The proposal HAS its row; it is merely stamped. A legacy row with the
        // same digest belongs to some other proposal and must stay untouched.
        await seedDecision('art14-decided', TENANT, DIGEST, 'prop-d', 'ACCEPTED');
        await seedDecision('art14-legacy-bystander', TENANT, DIGEST, null);

        expect(await stamp('prop-d', DIGEST, 'REJECTED')).toBe(0);
        expect(await outcomeOf('art14-legacy-bystander')).toBe('PENDING');
    });

    it("does not reach another tenant's decision row", async () => {
        await seedDecision('art14-mine', TENANT, DIGEST, 'prop-shared');
        await seedDecision('art14-theirs', OTHER, DIGEST, 'prop-shared');

        expect(await stamp('prop-shared', DIGEST, 'ACCEPTED')).toBe(1);
        expect({
            mine: await outcomeOf('art14-mine'),
            theirs: await outcomeOf('art14-theirs'),
        }).toEqual({ mine: 'ACCEPTED', theirs: 'PENDING' });
    });

    it('does not reach a different digest in the same tenant', async () => {
        await seedDecision('art14-target', TENANT, DIGEST, 'prop-t');
        await seedDecision('art14-bystander', TENANT, OTHER_DIGEST, 'prop-other');

        await stamp('prop-t', DIGEST, 'REJECTED');

        expect({
            target: await outcomeOf('art14-target'),
            bystander: await outcomeOf('art14-bystander'),
        }).toEqual({ target: 'REJECTED', bystander: 'PENDING' });
    });

    it("stamps ONLY the decided proposal's row when another proposal has identical content (#5191)", async () => {
        // Identical kind/payload/rationale means an identical digest. The
        // digest-keyed stamp this replaced moved BOTH rows here, recording one
        // reviewer's decision on a proposal nobody had looked at.
        await seedDecision('art14-twin-1', TENANT, DIGEST, 'prop-twin-1');
        await seedDecision('art14-twin-2', TENANT, DIGEST, 'prop-twin-2');

        expect(await stamp('prop-twin-1', DIGEST, 'ACCEPTED')).toBe(1);
        expect({
            one: await outcomeOf('art14-twin-1'),
            two: await outcomeOf('art14-twin-2'),
        }).toEqual({ one: 'ACCEPTED', two: 'PENDING' });

        expect(await stamp('prop-twin-2', DIGEST, 'REJECTED')).toBe(1);
        expect(await outcomeOf('art14-twin-2')).toBe('REJECTED');
    });

    it('LEGACY: stamps a row that names no proposal when it is the ONLY pending row for the digest', async () => {
        // A proposal created before the column existed has a row with no id.
        await seedDecision('art14-legacy-only', TENANT, DIGEST, null);

        expect(await stamp('prop-legacy', DIGEST, 'REJECTED')).toBe(1);
        expect(await outcomeOf('art14-legacy-only')).toBe('REJECTED');
    });

    it('LEGACY: stamps NOTHING when two pending rows share the digest — never several, never a guess', async () => {
        await seedDecision('art14-legacy-1', TENANT, DIGEST, null);
        await seedDecision('art14-legacy-2', TENANT, DIGEST, null);

        expect(await stamp('prop-legacy', DIGEST, 'ACCEPTED')).toBe(0);
        expect({
            one: await outcomeOf('art14-legacy-1'),
            two: await outcomeOf('art14-legacy-2'),
        }).toEqual({ one: 'PENDING', two: 'PENDING' });
    });

    it("LEGACY: ignores rows that name a proposal — they are some other proposal's record", async () => {
        await seedDecision('art14-legacy-mine', TENANT, DIGEST, null);
        await seedDecision('art14-linked-other', TENANT, DIGEST, 'prop-someone-else');

        expect(await stamp('prop-legacy', DIGEST, 'ACCEPTED')).toBe(1);
        expect({
            legacy: await outcomeOf('art14-legacy-mine'),
            linked: await outcomeOf('art14-linked-other'),
        }).toEqual({ legacy: 'ACCEPTED', linked: 'PENDING' });
    });

    it('reports zero — rather than throwing — when there is nothing to stamp', async () => {
        // The caller treats the stamp as best-effort so a logging failure never
        // undoes an applied proposal. That makes the RETURNED COUNT the only
        // signal, which is why it is asserted everywhere above.
        expect(await stamp('prop-none', 'sha256:nothing-matches-this', 'ACCEPTED')).toBe(0);
        expect(await stamp('prop-none', null, 'ACCEPTED')).toBe(0);
    });

    it('the proposal id is frozen: the trigger refuses moving a row onto another proposal', async () => {
        await seedDecision('art14-frozen', TENANT, DIGEST, 'prop-frozen');
        await expect(
            prisma.aiDecisionLog.update({
                where: { id: 'art14-frozen' },
                data: { agentProposalId: 'prop-elsewhere' },
            }),
        ).rejects.toThrow(/append-only/);
    });

    it('one decision row per proposal: a second row naming the same proposal is refused', async () => {
        await seedDecision('art14-unique-1', TENANT, DIGEST, 'prop-unique');
        await expect(seedDecision('art14-unique-2', TENANT, DIGEST, 'prop-unique')).rejects.toThrow(
            /Unique constraint/,
        );
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
