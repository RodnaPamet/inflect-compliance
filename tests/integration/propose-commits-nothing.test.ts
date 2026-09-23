/**
 * PROPOSE-NOT-COMMIT, asserted against a real database, for EVERY propose tool
 * and EVERY business table any of them could touch.
 *
 * ── WHY THIS FILE EXISTS WHEN A TEST ALREADY SAID SO ────────────────────────
 *
 * `tests/integration/agentic-engine.test.ts` already counts `Risk` rows either
 * side of a PROPOSE step and asserts the number did not move. That is the right
 * assertion and it covers one quarter of the claim:
 *
 *   · ONE entity kind. `propose_controls`, `draft_policy` and `propose_finding`
 *     were never checked, so a tool that wrote its own table would have passed.
 *   · ONE path. It goes through the STATIC driver's PROPOSE step. Since #2777 a
 *     FLUE agent calls `runProposeTool` directly, which is a different caller
 *     reaching the same funnel — and the funnel is where the guarantee lives.
 *   · ONE TABLE PER CALL. Checking only the table a tool targets cannot catch a
 *     tool that writes the WRONG one, which is the more interesting bug.
 *
 * So this walks the real funnel once per tool and counts every business table
 * before and after each call.
 *
 * ── THE POPULATION IS DERIVED ───────────────────────────────────────────────
 *
 * From `PROPOSE_TOOLS` itself, not a list written here. A fifth propose tool
 * joins this test the day it is added, and joins it UNCOVERED — the mapping
 * below throws on a kind it does not know rather than skipping it, because a
 * test that silently ignores a new tool is how the original gap survived.
 *
 * ── AND THE POSITIVE CONTROL IS NOT OPTIONAL ────────────────────────────────
 *
 * "No business rows were written" is satisfied perfectly by a call that did
 * nothing at all — a refusal at the gate, a thrown conversion, an empty loop.
 * Every case below therefore asserts the `AgentProposal` row WAS created in the
 * same breath. Without that, this entire file passes against a funnel that is
 * simply broken.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { PROPOSE_TOOLS, runProposeTool } from '@/lib/mcp/tools/propose-tools';
import { resolveMcpInvocation } from '@/lib/mcp/auth';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import type { RequestContext } from '@/app-layer/types';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

import { DB_URL, DB_AVAILABLE } from './db-helper';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const TENANT = 'pcn-tenant';

/**
 * The business table each proposal kind would commit to, if it committed.
 *
 * Keyed by `AgentProposalKind` so the mapping is against the vocabulary rather
 * than against tool names, and EXHAUSTIVE: `tableFor` throws on an unknown
 * kind. A `?? skip` here would let a new proposal kind arrive with no coverage
 * and a green suite, which is the exact shape of the gap this file closes.
 */
const TABLE_FOR_KIND: Record<string, 'risk' | 'control' | 'policy' | 'finding'> = {
    RISK: 'risk',
    CONTROL: 'control',
    POLICY: 'policy',
    FINDING: 'finding',
};

function tableFor(kind: string): 'risk' | 'control' | 'policy' | 'finding' {
    const t = TABLE_FOR_KIND[kind];
    if (!t) {
        throw new Error(
            `No business table mapped for proposal kind "${kind}". A new propose tool ` +
                'must be covered here, not skipped — add its table to TABLE_FOR_KIND.',
        );
    }
    return t;
}

/** Every business table any propose tool could reach, counted as one snapshot. */
async function countBusinessRows(): Promise<Record<string, number>> {
    const tables = [...new Set(Object.values(TABLE_FOR_KIND))];
    const entries = await Promise.all(
        tables.map(async (t) => [
            t,
            await (prisma[t] as { count: (a: unknown) => Promise<number> }).count({
                where: { tenantId: TENANT },
            }),
        ] as const),
    );
    return Object.fromEntries(entries);
}

async function seedUser(userId: string): Promise<string> {
    const email = `${userId}@example.test`;
    await prisma.user.upsert({
        where: { id: userId },
        update: {},
        create: { id: userId, email, emailHash: hashForLookup(email) },
    });
    return userId;
}

let agentId = '';
let ownerId = '';

function agentCtx(): RequestContext {
    return makeRequestContext('OWNER', {
        tenantId: TENANT,
        tenantSlug: TENANT,
        userId: ownerId,
        agentId,
    });
}

/** One item of the minimum shape each kind's create-schema accepts. */
function itemFor(kind: string): Record<string, unknown> {
    switch (kind) {
        case 'RISK':
            return { title: 'pcn risk', description: 'proposed, not committed' };
        case 'CONTROL':
            // `name`, not `title` — `CreateControlSchema` requires it, and
            // `createAgentProposal` re-validates each item against the real
            // create-schema. Getting this wrong is the funnel WORKING.
            return { name: 'pcn control', category: 'proposed, not committed' };
        case 'POLICY':
            return { title: 'pcn policy', contentText: 'proposed, not committed' };
        case 'FINDING':
            // `severity` and `type` are required alongside `title`.
            return {
                title: 'pcn finding',
                severity: 'LOW',
                type: 'OBSERVATION',
                description: 'proposed, not committed',
            };
        default:
            throw new Error(`no fixture item for kind "${kind}"`);
    }
}

describeFn('a propose tool queues, and commits nothing', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.upsert({
            where: { id: TENANT },
            update: {},
            create: { id: TENANT, name: TENANT, slug: TENANT },
        });
        // IDEMPOTENT. The cumulative assertion at the end counts rows, so a
        // previous run's leftovers make it fail for a reason that has nothing
        // to do with the claim — which is exactly how an integration test
        // earns a reputation for flaking and gets deleted.
        await prisma.agentProposal.deleteMany({ where: { tenantId: TENANT } });
        await prisma.registeredAgentTool.deleteMany({ where: { tenantId: TENANT } });
        await prisma.registeredAgent.deleteMany({ where: { tenantId: TENANT } });
        await prisma.aiSystem.deleteMany({ where: { tenantId: TENANT } });

        ownerId = await seedUser(`${TENANT}-owner`);
        await prisma.tenantMembership.upsert({
            where: { tenantId_userId: { tenantId: TENANT, userId: ownerId } },
            update: { role: 'OWNER', status: 'ACTIVE' },
            create: { tenantId: TENANT, userId: ownerId, role: 'OWNER', status: 'ACTIVE' },
        });

        const aiSystem = await prisma.aiSystem.create({
            data: { tenantId: TENANT, name: 'pcn host', ownerUserId: ownerId },
        });
        const agent = await prisma.registeredAgent.create({
            data: {
                tenantId: TENANT,
                aiSystemId: aiSystem.id,
                name: 'pcn agent',
                // Rung 4: above the propose class's 2, so the AUTONOMY term is
                // never what refuses. A ceiling-refused call writes no business
                // rows either, and would pass every assertion below for the
                // wrong reason.
                autonomyLevel: 4,
                dataAccessScope: 'READ_TENANT_DATA',
                reversibility: 'REVERSIBLE',
                provenance: 'FIRST_PARTY',
                ownerUserId: ownerId,
                status: 'ACTIVE',
                // Scored, for the same reason: an UNSCORED agent is denied
                // every tool at the boundary.
                riskTier: 'LOW',
                riskTierScoredAt: new Date(),
            },
        });
        agentId = agent.id;

        // Granted EVERY propose tool, derived rather than listed.
        for (const tool of PROPOSE_TOOLS) {
            await prisma.registeredAgentTool.create({
                data: { tenantId: TENANT, agentId, toolName: tool.name, grantedByUserId: ownerId },
            });
        }
    });

    afterAll(async () => {
        await deleteAuditRowsForTenants(prisma, [TENANT]);
        await prisma.$disconnect();
    });

    it('examined every propose tool the build ships', () => {
        // The denominator. Every assertion below is satisfied by zero tools.
        expect(PROPOSE_TOOLS.length).toBeGreaterThanOrEqual(4);
        expect(PROPOSE_TOOLS.map((t) => t.kind).sort()).toEqual(
            Object.keys(TABLE_FOR_KIND).sort(),
        );
    });

    it.each(PROPOSE_TOOLS.map((t) => [t.name, t.kind] as const))(
        '%s queues a PENDING %s and writes NO business row anywhere',
        async (toolName, kind) => {
            const before = await countBusinessRows();
            const proposalsBefore = await prisma.agentProposal.count({
                where: { tenantId: TENANT, kind },
            });

            const inv = await resolveMcpInvocation(agentCtx());
            await runProposeTool(inv, toolName, { items: [itemFor(kind)] });

            // THE POSITIVE CONTROL, first: without it "nothing was written"
            // is satisfied by a call that did nothing at all.
            const proposalsAfter = await prisma.agentProposal.count({
                where: { tenantId: TENANT, kind },
            });
            expect(proposalsAfter).toBe(proposalsBefore + 1);

            const queued = await prisma.agentProposal.findFirst({
                where: { tenantId: TENANT, kind },
                orderBy: { createdAt: 'desc' },
            });
            expect(queued?.status).toBe('PENDING');

            // EVERY table, not just this tool's. A tool writing the WRONG
            // business table is the more interesting bug, and a per-tool check
            // cannot see it.
            expect(await countBusinessRows()).toEqual(before);
            // And the table this tool would have committed to, named, so the
            // failure says which guarantee broke.
            expect({ table: tableFor(kind), rows: (await countBusinessRows())[tableFor(kind)] })
                .toEqual({ table: tableFor(kind), rows: before[tableFor(kind)] });
        },
    );

    it('and the queued rows are still the only thing there after all of them', async () => {
        // The cumulative claim. Each case above is individually green even if
        // every call wrote one row and deleted it again; this asserts the end
        // state after the whole surface has been exercised.
        const rows = await countBusinessRows();
        expect(rows).toEqual({ risk: 0, control: 0, policy: 0, finding: 0 });
        expect(await prisma.agentProposal.count({ where: { tenantId: TENANT } })).toBe(
            PROPOSE_TOOLS.length,
        );
    });
});
