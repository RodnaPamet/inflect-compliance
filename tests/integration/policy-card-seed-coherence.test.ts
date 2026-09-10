/**
 * A CARD MAY NOT BE BORN PERMITTING WHAT IT FORBIDS.
 *
 * The defect this suite pins was a disagreement between two write paths about
 * what a valid policy card is, and it took a working agent dark with nobody
 * told.
 *
 *   • `createAgentPolicyCard` seeded `maxDataScope` from the register's own
 *     `dataAccessScope` and `permittedTools` from the grant list, and checked
 *     NOTHING. The three inputs are independent.
 *   • `updateAgentPolicyCard` ran `assertDeclarationsExercisable`, which refuses
 *     a card permitting a tool whose base data rung is above its own ceiling.
 *
 * So an agent registered as reaching `READ_METADATA` and granted `list_risks`
 * got a v1 card reading `{permittedTools:['list_risks'], maxDataScope:'READ_METADATA'}`
 * — a card the EDIT path rejects verbatim as impossible to write, and one whose
 * every `list_risks` call is refused `DATA_SCOPE_EXCEEDED`. The agent stopped
 * working at the moment its governance artefact was created.
 *
 * Two defects, and this suite proves both are closed at the seam where an
 * operator can still act:
 *
 *   1. THE GRANT ITSELF IS NOW REFUSED. `grantAgentTool` bounds a grant on the
 *      DATA axis the way it already bounded it on AUTONOMY. The contradictory
 *      pairing cannot be written in the first place, and the operator is told
 *      while "raise the declaration" is still a choice rather than a repair.
 *   2. A CARD IS COHERENT BY CONSTRUCTION. Where the contradiction already
 *      exists — a grant made before that gate, or an axis NARROWED after the
 *      grant, which is reachable through the product's own write paths today
 *      and is what this suite does — the seed WITHHOLDS the tool it cannot
 *      exercise and names it. Create and edit now run the same predicate.
 *
 * Everything below goes through the real usecases against the real database,
 * and the runtime arms go through the real MCP route with a real API key. A
 * suite that asserted the usecases' return values would have passed against the
 * original defect too: the seeded card's `value` was returned correctly and was
 * simply unusable.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { generateApiKey } from '@/lib/auth/api-key-auth';
import { POST as MCP_POST } from '@/app/api/mcp/route';
import { makeRequestContext } from '../helpers/make-context';
import {
    activateRegisteredAgent,
    createRegisteredAgent,
    updateRegisteredAgent,
} from '@/app-layer/usecases/agent-registry';
import { grantAgentTool } from '@/app-layer/usecases/agent-tool-exposure';
import { completeAgentRiskAssessment } from '@/app-layer/usecases/agent-risk-assessment';
import {
    createAgentPolicyCard,
    getAgentPolicyCard,
    updateAgentPolicyCard,
} from '@/app-layer/usecases/agent-policy-card';
import { ACTION_CAP_LADDER, POLICY_CARD_RULES } from '@/lib/agentic/policy-card';
import { ceilingForRiskTier } from '@/lib/agentic/autonomy-ceiling';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const SUITE = `pcseed-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const USER = `u-${SUITE}`;

// Deliberately WIDE. The key's scope list is a separate narrowing term, and a
// call refused for a missing scope would be indistinguishable, in these
// assertions, from one refused by the card — which is the thing under test.
const SCOPES = [
    'mcp:read',
    'mcp:propose',
    'risks:read',
    'frameworks:read',
    'audits:read',
    'findings:write',
];

const ctx = () =>
    makeRequestContext('OWNER', { tenantId: TENANT, tenantSlug: TENANT, userId: USER });

type Scope = 'NONE' | 'READ_METADATA' | 'READ_TENANT_DATA' | 'WRITE_TENANT_DATA';

/**
 * An agent through the REAL create usecase, then scored through the REAL
 * scorer. Never a hand-written row: the whole question here is what the
 * product's own write paths let an operator end up with.
 */
async function scoredAgent(name: string, dataAccessScope: Scope): Promise<string> {
    const aiSystem = await prisma.aiSystem.create({
        data: { tenantId: TENANT, name: `${name} host`, ownerUserId: USER },
    });
    const created = await createRegisteredAgent(ctx(), {
        aiSystemId: aiSystem.id,
        name: `${name} ${SUITE}`,
        // Rung 1 is READ. The agent has to be able to reach it or every runtime
        // arm below would be refused by the autonomy ceiling for a reason that
        // has nothing to do with the card.
        autonomyLevel: 1,
        dataAccessScope,
        reversibility: 'REVERSIBLE',
        provenance: 'FIRST_PARTY',
        ownerUserId: USER,
    });
    await completeAgentRiskAssessment(ctx(), created.id);
    return created.id;
}

async function mintKey(agentId: string): Promise<string> {
    const { plaintext, keyHash, keyPrefix } = generateApiKey();
    await prisma.tenantApiKey.create({
        data: {
            tenantId: TENANT,
            name: `k-${randomUUID().slice(0, 6)}`,
            keyPrefix,
            keyHash,
            scopes: SCOPES,
            createdById: USER,
            agentId,
        },
    });
    return plaintext;
}

async function callTool(token: string, name: string, args: unknown = {}) {
    const req = new NextRequest('http://localhost/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name, arguments: args },
        }),
    });
    const res = await MCP_POST(req, { params: Promise.resolve({}) } as never);
    let json: unknown = null;
    try {
        json = await res.json();
    } catch {
        /* empty body */
    }
    return { status: res.status, json };
}

function errorOf(json: unknown): string | undefined {
    return (json as { error?: { message?: string } })?.error?.message;
}

/** The whole card as a PUT body — the schema is strict and requires every field. */
function edit(
    expectedVersion: number,
    card: {
        permittedTools: string[];
        maxDataScope: Scope;
        maxAutonomyLevel: number;
        maxActionsPerRun: number;
        maxActionsPerDay: number;
    },
) {
    return {
        expectedVersion,
        card: {
            ...card,
            escalationTriggers: [...POLICY_CARD_RULES],
            approvalRung: 'SECOND_APPROVER' as const,
        },
    };
}

describeFn('a seeded policy card is one the tool boundary can actually exercise', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.upsert({
            where: { id: TENANT },
            update: {},
            create: { id: TENANT, name: TENANT, slug: TENANT },
        });
        const email = `${TENANT}@example.test`;
        await prisma.user.upsert({
            where: { id: USER },
            update: {},
            create: { id: USER, email, emailHash: hashForLookup(email) },
        });
        await prisma.tenantMembership.upsert({
            where: { tenantId_userId: { tenantId: TENANT, userId: USER } },
            update: { role: 'OWNER', status: 'ACTIVE' },
            create: { tenantId: TENANT, userId: USER, role: 'OWNER', status: 'ACTIVE' },
        });
        await prisma.tenantSecuritySettings.upsert({
            where: { tenantId: TENANT },
            update: { requireRegisteredAgent: true },
            create: { tenantId: TENANT, requireRegisteredAgent: true },
        });
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    // ─────────────────────────────────────────────────────────────────
    // 1. The reviewer's repro, at the seam where it is now caught.
    // ─────────────────────────────────────────────────────────────────
    describe('the contradiction is refused where the operator is asking for it', () => {
        it('refuses the grant that used to produce a self-contradictory card', async () => {
            const agentId = await scoredAgent('metadata-agent', 'READ_METADATA');
            // MODERATE caps autonomy at 3 and `list_risks` needs 1, so the
            // AUTONOMY rule is satisfied — which is exactly why this grant used
            // to go through. The data axis is the one in play.
            const tier = (
                await prisma.registeredAgent.findUniqueOrThrow({
                    where: { id: agentId },
                    select: { riskTier: true },
                })
            ).riskTier;
            expect(tier).toBe('MODERATE');

            const err = await grantAgentTool(ctx(), agentId, { toolName: 'list_risks' }).catch(
                (e: Error) => e,
            );
            expect((err as Error).message).toMatch(/READ_TENANT_DATA on every call/);
            expect((err as Error).message).toMatch(/registered as reaching READ_METADATA/);
            // Both remedies named. Either the declaration is wrong or the grant
            // is, and only the operator knows which.
            expect((err as Error).message).toMatch(/Raise the agent's data-access scope/);
            expect((err as Error).message).toMatch(/stays within READ_METADATA/);

            // No row. A refusal that left the grant behind would put the
            // register back in the state this gate exists to keep out of it.
            expect(
                await prisma.registeredAgentTool.count({
                    where: { tenantId: TENANT, agentId, toolName: 'list_risks' },
                }),
            ).toBe(0);
        });

        it('still allows a tool whose BASE rung fits — the refusal is not blanket', async () => {
            // `get_framework_status` returns the installable-framework catalogue
            // with no arguments and this tenant's coverage with a `frameworkKey`.
            // Its BASE is READ_METADATA, so a metadata agent may hold it: the
            // tool works and the wider ARGUMENT is refused at the boundary. A
            // rule written against the tool's maximum would have refused this
            // and made the argument-derived rung pointless.
            const agentId = await scoredAgent('metadata-positive', 'READ_METADATA');
            await expect(
                grantAgentTool(ctx(), agentId, { toolName: 'get_framework_status' }),
            ).resolves.toMatchObject({ toolName: 'get_framework_status' });
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // 2. The state that ALREADY exists — a grant, then a narrowed axis.
    // ─────────────────────────────────────────────────────────────────
    describe('when the contradiction already exists, the card is seeded coherent', () => {
        let agentId = '';

        beforeAll(async () => {
            // Reachable through the product's own write paths TODAY, with the
            // grant gate in place: grant while the declaration is wide, then
            // narrow the declaration. Narrowing authority is never refused —
            // that is the house rule — so this is not a hole to close at the
            // register, it is the case the card has to seed correctly.
            agentId = await scoredAgent('narrowed-agent', 'READ_TENANT_DATA');
            await grantAgentTool(ctx(), agentId, { toolName: 'list_risks' });
            await grantAgentTool(ctx(), agentId, { toolName: 'get_framework_status' });
            await updateRegisteredAgent(ctx(), agentId, { dataAccessScope: 'READ_METADATA' });
        });

        it('the narrowing left the grant standing and the tier unmoved', async () => {
            // The precondition, asserted rather than assumed: if the narrowing
            // had revoked the grant or re-scored the agent, every claim below
            // would be about a different situation than the one described.
            const row = await prisma.registeredAgent.findUniqueOrThrow({
                where: { id: agentId },
                select: { dataAccessScope: true, riskTier: true },
            });
            expect(row.dataAccessScope).toBe('READ_METADATA');
            expect(row.riskTier).toBe('HIGH');
            expect(
                await prisma.registeredAgentTool.count({ where: { tenantId: TENANT, agentId } }),
            ).toBe(2);
        });

        it('the PREVIEW names the withheld tool before anybody presses create', async () => {
            const preview = await getAgentPolicyCard(ctx(), agentId);
            expect(preview.card).toBeNull();
            // Narrowed on `card`, NOT on `'wouldSeed' in preview`. The read
            // returns one shape for an agent with a card and another for an
            // agent without one, but TypeScript normalises the two returns into
            // a union whose members carry each other's keys as `?: undefined` —
            // so BOTH members have a `wouldSeed` key and `in` discriminates
            // nothing. `card` is a real discriminant (`null` against an object),
            // and it is the field whose absence the preview shape is defined by.
            if (preview.card !== null) throw new Error('expected the no-card shape');
            expect(preview.wouldSeed.permittedTools).toEqual(['get_framework_status']);
            expect(preview.wouldWithhold).toEqual([
                {
                    toolName: 'list_risks',
                    reason: 'DATA_SCOPE_ABOVE_CARD',
                    requires: 'READ_TENANT_DATA',
                    permits: 'READ_METADATA',
                },
            ]);
        });

        it('creating it writes a card that permits only what it can exercise', async () => {
            const created = await createAgentPolicyCard(ctx(), agentId);

            expect(created.version).toBe(1);
            expect(created.value.maxDataScope).toBe('READ_METADATA');
            expect(created.value.permittedTools).toEqual(['get_framework_status']);
            expect(created.withheld).toEqual([
                {
                    toolName: 'list_risks',
                    reason: 'DATA_SCOPE_ABOVE_CARD',
                    requires: 'READ_TENANT_DATA',
                    permits: 'READ_METADATA',
                },
            ]);

            // Read back from the DATABASE, not from the return value. The
            // original defect returned a correct-looking object and stored a
            // card the boundary refused.
            const stored = await prisma.agentPolicyCardVersion.findFirstOrThrow({
                where: { tenantId: TENANT, version: 1, card: { agentId } },
                select: { permittedTools: true, maxDataScope: true },
            });
            expect(stored.permittedTools).toEqual(['get_framework_status']);
            expect(stored.maxDataScope).toBe('READ_METADATA');
        });

        it('and the audit row carries the withheld tool, for whoever asks later', async () => {
            // The response is read once, by whoever pressed the button. The row
            // is what the next person asking "why is this agent not calling the
            // tool we granted it" can actually find.
            const row = await prisma.auditLog.findFirstOrThrow({
                where: { tenantId: TENANT, entityId: agentId, action: 'AGENT_POLICY_CARD_CREATED' },
                select: { detailsJson: true },
            });
            const details = row.detailsJson as {
                summary?: string;
                after?: { withheld?: { toolName: string }[] };
            };
            expect(details.summary).toMatch(/1 granted tool\(s\) withheld as unexercisable/);
            expect(details.summary).toMatch(/list_risks/);
            expect(details.after?.withheld?.map((w) => w.toolName)).toEqual(['list_risks']);
        });

        it('the EDIT path accepts the card the CREATE path just wrote', async () => {
            // The whole defect in one assertion. Create and edit are two write
            // paths over one object, and they disagreed: create wrote a state
            // edit called impossible. Offering v1 back verbatim is the narrowest
            // possible test of the agreement — it changes nothing, so anything
            // that refuses it is refusing the seed itself.
            const current = await getAgentPolicyCard(ctx(), agentId);
            const inForce = current.card?.inForce;
            if (!inForce) throw new Error('expected a version in force');

            await expect(
                updateAgentPolicyCard(ctx(), agentId, {
                    expectedVersion: 1,
                    card: {
                        permittedTools: inForce.permittedTools,
                        maxDataScope: inForce.maxDataScope,
                        maxAutonomyLevel: inForce.maxAutonomyLevel,
                        maxActionsPerRun: inForce.maxActionsPerRun,
                        maxActionsPerDay: inForce.maxActionsPerDay,
                        escalationTriggers: inForce.escalationTriggers,
                        approvalRung: inForce.approvalRung,
                    },
                }),
            ).resolves.toMatchObject({ version: 2 });
        });

        it('and still refuses the card the create path USED to write', async () => {
            // The other half, and the one that says the agreement was reached by
            // fixing create rather than by loosening edit. This body is exactly
            // what v1 was before the fix.
            const err = await updateAgentPolicyCard(
                ctx(),
                agentId,
                edit(2, {
                    permittedTools: ['get_framework_status', 'list_risks'],
                    maxDataScope: 'READ_METADATA',
                    maxAutonomyLevel: 2,
                    maxActionsPerRun: 10,
                    maxActionsPerDay: 100,
                }),
            ).catch((e: Error) => e);
            // Each half on its own. A span joining them would re-form across a
            // message that had kept one fact and lost the other.
            expect((err as Error).message).toMatch(/"list_risks" reaches READ_TENANT_DATA/);
            expect((err as Error).message).toMatch(/this card stops at READ_METADATA/);
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // 3. What the agent actually does, and how the operator gets it back.
    // ─────────────────────────────────────────────────────────────────
    describe('at the real MCP boundary', () => {
        let agentId = '';
        let token = '';

        beforeAll(async () => {
            agentId = await scoredAgent('runtime-agent', 'READ_TENANT_DATA');
            await grantAgentTool(ctx(), agentId, { toolName: 'list_risks' });
            await grantAgentTool(ctx(), agentId, { toolName: 'get_framework_status' });
            await updateRegisteredAgent(ctx(), agentId, { dataAccessScope: 'READ_METADATA' });
            await createAgentPolicyCard(ctx(), agentId);
            await activateRegisteredAgent(ctx(), agentId);
            token = await mintKey(agentId);
        });

        it('the withheld tool is refused BY NAME, not silently', async () => {
            const res = await callTool(token, 'list_risks');
            const message = errorOf(res.json);
            // TOOL_NOT_PERMITTED, and it says which card and which version said
            // so. The pre-fix refusal was DATA_SCOPE_EXCEEDED on a card that
            // claimed to permit the tool — a contradiction the operator had to
            // resolve from an audit row rather than a sentence.
            expect(message).toMatch(/policy card/i);
            expect(message).toMatch(/does not permit/);
            expect(message).toMatch(/list_risks/);
        });

        it('everything the card DID permit still works', async () => {
            // The paired positive, and the reason withholding is not the same as
            // taking the agent dark. A suite that only showed the refusal would
            // pass against a fix that emptied the card.
            const res = await callTool(token, 'get_framework_status');
            expect(errorOf(res.json)).toBeUndefined();
        });

        it('the operator can walk it back, one ladder step at a time', async () => {
            // The whole remedy, through the product. This is what "intelligible
            // to an operator" has to mean: not only that they are told, but that
            // what they are told leads somewhere.

            // (a) The declaration was the wrong one. Raising it re-scores the
            //     agent on the spot — that is the price, and here the tier does
            //     not move.
            await updateRegisteredAgent(ctx(), agentId, { dataAccessScope: 'READ_TENANT_DATA' });
            expect(
                (
                    await prisma.registeredAgent.findUniqueOrThrow({
                        where: { id: agentId },
                        select: { riskTier: true },
                    })
                ).riskTier,
            ).toBe('HIGH');

            // (b) Both moves in one edit is refused — one dimension at a time.
            await expect(
                updateAgentPolicyCard(
                    ctx(),
                    agentId,
                    edit(1, {
                        permittedTools: ['get_framework_status', 'list_risks'],
                        maxDataScope: 'READ_TENANT_DATA',
                        maxAutonomyLevel: 2,
                        maxActionsPerRun: 10,
                        maxActionsPerDay: 100,
                    }),
                ),
            ).rejects.toThrow(/one dimension at a time/);

            // (c) And the tool BEFORE the ceiling is refused as unexercisable —
            //     so the order the error message names is the only order that
            //     works, in both directions.
            await expect(
                updateAgentPolicyCard(
                    ctx(),
                    agentId,
                    edit(1, {
                        permittedTools: ['get_framework_status', 'list_risks'],
                        maxDataScope: 'READ_METADATA',
                        maxAutonomyLevel: 2,
                        maxActionsPerRun: 10,
                        maxActionsPerDay: 100,
                    }),
                ),
            ).rejects.toThrow(/Raise maxDataScope first/);

            // (d) Ceiling first…
            await expect(
                updateAgentPolicyCard(
                    ctx(),
                    agentId,
                    edit(1, {
                        permittedTools: ['get_framework_status'],
                        maxDataScope: 'READ_TENANT_DATA',
                        maxAutonomyLevel: 2,
                        maxActionsPerRun: 10,
                        maxActionsPerDay: 100,
                    }),
                ),
            ).resolves.toMatchObject({ version: 2 });

            // (e) …then the tool.
            await expect(
                updateAgentPolicyCard(
                    ctx(),
                    agentId,
                    edit(2, {
                        permittedTools: ['get_framework_status', 'list_risks'],
                        maxDataScope: 'READ_TENANT_DATA',
                        maxAutonomyLevel: 2,
                        maxActionsPerRun: 10,
                        maxActionsPerDay: 100,
                    }),
                ),
            ).resolves.toMatchObject({ version: 3 });

            // (f) And the agent is working again — at the boundary, with the
            //     same key, the call that was refused in this same suite.
            const res = await callTool(token, 'list_risks');
            expect(errorOf(res.json)).toBeUndefined();
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // 4. The other direction: the declaration bounds the CARD too.
    // ─────────────────────────────────────────────────────────────────
    //
    // The grant seam now refuses a tool reaching past the agent's declared data
    // axis. The card seam is the other door into the same room, and the two
    // axes are not symmetric at the boundary: autonomy is
    // `min(key max, agent.autonomyLevel, tier cap)` on every call, so lowering
    // the register's autonomy narrows the agent immediately, while
    // `dataAccessScope` is read when a card is SEEDED and nowhere else. A card
    // edited above the declaration is therefore a widening the boundary HONOURS
    // — while the risk tier goes on standing on the smaller declaration.
    describe('a card may not be widened past the declaration it was seeded from', () => {
        let agentId = '';

        beforeAll(async () => {
            agentId = await scoredAgent('bounded-card', 'READ_TENANT_DATA');
            await createAgentPolicyCard(ctx(), agentId);
        });

        it('narrowing the card below the declaration is free, and raising it back is one rung', async () => {
            // The positive half, and it has to come first: a rule that only ever
            // refuses is indistinguishable from a rule that refuses everything.
            await expect(
                updateAgentPolicyCard(
                    ctx(),
                    agentId,
                    edit(1, {
                        permittedTools: [],
                        maxDataScope: 'READ_METADATA',
                        maxAutonomyLevel: 2,
                        maxActionsPerRun: 10,
                        maxActionsPerDay: 100,
                    }),
                ),
            ).resolves.toMatchObject({ version: 2 });

            await expect(
                updateAgentPolicyCard(
                    ctx(),
                    agentId,
                    edit(2, {
                        permittedTools: [],
                        maxDataScope: 'READ_TENANT_DATA',
                        maxAutonomyLevel: 2,
                        maxActionsPerRun: 10,
                        maxActionsPerDay: 100,
                    }),
                ),
            ).resolves.toMatchObject({ version: 3 });
        });

        it('but one rung PAST the declaration is refused, and the ladder is not what refuses it', async () => {
            // READ_TENANT_DATA → WRITE_TENANT_DATA is a single rung, so
            // `checkLadderStep` is satisfied. Only the declaration stops it,
            // which is what makes this a sole detector for the new bound.
            const err = await updateAgentPolicyCard(
                ctx(),
                agentId,
                edit(3, {
                    permittedTools: [],
                    maxDataScope: 'WRITE_TENANT_DATA',
                    maxAutonomyLevel: 2,
                    maxActionsPerRun: 10,
                    maxActionsPerDay: 100,
                }),
            ).catch((e: Error) => e);

            expect((err as Error).message).toMatch(/This card would reach WRITE_TENANT_DATA/);
            expect((err as Error).message).toMatch(/registered as reaching READ_TENANT_DATA/);
            expect((err as Error).message).toMatch(/Raise the agent's data-access scope first/);

            // Nothing was appended. A refusal that still moved the head would
            // leave the head naming a version composed against a different base.
            const card = await getAgentPolicyCard(ctx(), agentId);
            expect(card.card?.currentVersion).toBe(3);
            expect(
                await prisma.agentPolicyCardVersion.count({
                    where: { tenantId: TENANT, card: { agentId } },
                }),
            ).toBe(3);
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // 5. What narrowing the DECLARATION does to a card that already exists —
    //    which is nothing, deliberately, and is pinned here so that nobody
    //    reads the seeding as a live link between the two.
    // ─────────────────────────────────────────────────────────────────
    describe('narrowing the declaration does not reach back into a card already written', () => {
        let agentId = '';
        let token = '';

        beforeAll(async () => {
            agentId = await scoredAgent('narrow-after-card', 'READ_TENANT_DATA');
            await grantAgentTool(ctx(), agentId, { toolName: 'list_risks' });
            await createAgentPolicyCard(ctx(), agentId);
            await activateRegisteredAgent(ctx(), agentId);
            token = await mintKey(agentId);
        });

        it('the card keeps its ceiling and the boundary keeps honouring it', async () => {
            expect(errorOf((await callTool(token, 'list_risks')).json)).toBeUndefined();

            await updateRegisteredAgent(ctx(), agentId, { dataAccessScope: 'READ_METADATA' });
            expect(
                (
                    await prisma.registeredAgent.findUniqueOrThrow({
                        where: { id: agentId },
                        select: { dataAccessScope: true },
                    })
                ).dataAccessScope,
            ).toBe('READ_METADATA');

            // The card is a stored version, not a view over the register. It is
            // still at the rung it was seeded at, and the call still runs.
            //
            // DELIBERATE, and the reason is the one the whole subsystem keeps
            // repeating: a version has to mean the same thing when it is read
            // back as evidence, so nothing may rewrite one behind the operator's
            // back — and `AgentPolicyCardVersion` refuses UPDATE at two levels
            // to make sure of it. Narrowing the register therefore behaves the
            // way narrowing it behaves for GRANTS: the standing authority
            // stands, and the operator narrows the card (free, no ladder step)
            // or revokes the grant.
            //
            // The asymmetry with `autonomyLevel` — which IS a live term and so
            // narrows the agent on the next call — is recorded in
            // docs/implementation-notes/2026-09-05-policy-card-seed-coherence.md.
            const card = await getAgentPolicyCard(ctx(), agentId);
            expect(card.card?.inForce?.maxDataScope).toBe('READ_TENANT_DATA');
            expect(card.card?.inForce?.permittedTools).toEqual(['list_risks']);
            expect(errorOf((await callTool(token, 'list_risks')).json)).toBeUndefined();
        });

        it('and the card can still be narrowed — the new bound does not fight the repair', async () => {
            // The gate added in block 4 judges a RAISE, never the resulting
            // value, precisely so this edit is possible: the card sits above the
            // declaration and the operator is bringing it down.
            await expect(
                updateAgentPolicyCard(
                    ctx(),
                    agentId,
                    edit(1, {
                        permittedTools: [],
                        maxDataScope: 'READ_METADATA',
                        maxAutonomyLevel: 2,
                        maxActionsPerRun: 10,
                        maxActionsPerDay: 100,
                    }),
                ),
            ).resolves.toMatchObject({ version: 2 });

            const res = await callTool(token, 'list_risks');
            expect(errorOf(res.json)).toMatch(/does not permit/);
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // 6. And the same for the TIER: a re-assessment that lowers the cap
    //    does not reach back into the card either, so the card is left
    //    above it — and the editor must not then refuse every edit.
    // ─────────────────────────────────────────────────────────────────
    //
    // `assertAutonomyRaiseWithinTier` judges the MOVE, the shape its two
    // siblings already had (`assertRaiseWithinTier` in the register,
    // `assertDataScopeRaiseWithinDeclaration` above). It used to judge the
    // resulting VALUE, which refused every edit to a card left above the cap —
    // including the narrowings that make the agent smaller and touch no rung
    // the complaint is about. Nothing is loosened: the tier cap is a live term
    // in `min(key, agent.autonomyLevel, tierCap)` at every call, so the stale
    // rung on the card grants nothing while it stands.
    describe('a card left above a LOWERED tier cap can still be edited', () => {
        let agentId = '';

        beforeAll(async () => {
            // HIGH (score 17): autonomy 1 + READ_TENANT_DATA 4 + REVERSIBLE 0 +
            // first-party 0 + 12 for an unanswered questionnaire. Cap 2, which
            // is what the seed writes.
            agentId = await scoredAgent('tier-drop', 'READ_TENANT_DATA');
            await createAgentPolicyCard(ctx(), agentId);
        });

        it('the re-assessment lowers the cap under the card, and rewrites nothing', async () => {
            const before = await prisma.registeredAgent.findUniqueOrThrow({
                where: { id: agentId },
                select: { riskTier: true },
            });
            expect(before.riskTier).toBe('HIGH');

            // Through the register's own write path: egress floors at HIGH and
            // takes the score to 27 (1 + 8 + 6 + 0 + 12), which is CRITICAL —
            // cap 1, one rung BELOW the card's autonomy. The re-score writes
            // back because the new tier is higher; it never lowers a tier.
            await updateRegisteredAgent(ctx(), agentId, {
                dataAccessScope: 'EXTERNAL_EGRESS',
                reversibility: 'TERMINAL',
            });
            const after = await prisma.registeredAgent.findUniqueOrThrow({
                where: { id: agentId },
                select: { riskTier: true },
            });
            expect(after.riskTier).toBe('CRITICAL');
            expect(ceilingForRiskTier(after.riskTier)).toBe(1);

            // The card is untouched — a stored version is never rewritten — so
            // it now declares more autonomy than the tier permits. That state
            // is what the rest of this block is about.
            const card = await getAgentPolicyCard(ctx(), agentId);
            expect(card.card?.inForce?.maxAutonomyLevel).toBe(2);
            expect(card.card?.currentVersion).toBe(1);
        });

        it('a narrowing that touches no rung the cap is about is ACCEPTED', async () => {
            const card = await getAgentPolicyCard(ctx(), agentId);
            const inForce = card.card?.inForce;
            if (!inForce) throw new Error('expected a version in force');

            // One rung DOWN the budget ladder, and autonomy left exactly where
            // it is. This is the edit the value reading refused: it raises
            // nothing, it makes the agent smaller, and the only thing wrong
            // with the card is an axis it does not touch.
            const perDay = ACTION_CAP_LADDER[ACTION_CAP_LADDER.indexOf(
                inForce.maxActionsPerDay as (typeof ACTION_CAP_LADDER)[number],
            ) - 1];
            expect(perDay).toBeLessThan(inForce.maxActionsPerDay);

            await expect(
                updateAgentPolicyCard(
                    ctx(),
                    agentId,
                    edit(1, {
                        permittedTools: [...inForce.permittedTools],
                        maxDataScope: inForce.maxDataScope as Scope,
                        maxAutonomyLevel: inForce.maxAutonomyLevel,
                        maxActionsPerRun: inForce.maxActionsPerRun,
                        maxActionsPerDay: perDay,
                    }),
                ),
            ).resolves.toMatchObject({ version: 2 });
        });

        it('but a RAISE is still refused, and still names both numbers', async () => {
            // The half that says the gate was made one-directional rather than
            // deleted. One rung up from 2 is a legal ladder step, so only the
            // tier cap can refuse it.
            const card = await getAgentPolicyCard(ctx(), agentId);
            const inForce = card.card?.inForce;
            if (!inForce) throw new Error('expected a version in force');

            const err = await updateAgentPolicyCard(
                ctx(),
                agentId,
                edit(2, {
                    permittedTools: [...inForce.permittedTools],
                    maxDataScope: inForce.maxDataScope as Scope,
                    maxAutonomyLevel: inForce.maxAutonomyLevel + 1,
                    maxActionsPerRun: inForce.maxActionsPerRun,
                    maxActionsPerDay: inForce.maxActionsPerDay,
                }),
            ).catch((e: Error) => e);

            // Each half on its own — a span joining them would re-form across a
            // message that had kept one fact and lost the other.
            expect((err as Error).message).toMatch(/This card caps autonomy at 3/);
            expect((err as Error).message).toMatch(/caps it at 1/);

            // And nothing was appended.
            expect(
                await prisma.agentPolicyCardVersion.count({
                    where: { tenantId: TENANT, card: { agentId } },
                }),
            ).toBe(2);
        });

        it('and the repair — bringing autonomy under the cap — goes through', async () => {
            const card = await getAgentPolicyCard(ctx(), agentId);
            const inForce = card.card?.inForce;
            if (!inForce) throw new Error('expected a version in force');

            await expect(
                updateAgentPolicyCard(
                    ctx(),
                    agentId,
                    edit(2, {
                        permittedTools: [...inForce.permittedTools],
                        maxDataScope: inForce.maxDataScope as Scope,
                        maxAutonomyLevel: 1,
                        maxActionsPerRun: inForce.maxActionsPerRun,
                        maxActionsPerDay: inForce.maxActionsPerDay,
                    }),
                ),
            ).resolves.toMatchObject({ version: 3 });
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // 7. THE GET PAYLOAD ITSELF.
    //
    //    Blocks 1-6 go through the WRITE paths. This one pins the READ,
    //    because the read is the other half of the same contract and the
    //    half this issue is named after: the editor's ladders are bounded
    //    by `riskTier` and `dataAccessScope`, its disclosure is bounded by
    //    `withheld`, and its version trail names an actor — and every one
    //    of those was composed in the client from fields the GET did not
    //    send. A suite that asserted only the write paths would have
    //    passed against a GET that sent none of them, which is exactly the
    //    defect. So each field is asserted against a value the payload
    //    cannot have got from anywhere else on the response.
    // ─────────────────────────────────────────────────────────────────
    describe('the GET carries what the editor is bounded by', () => {
        let agentId = '';
        let token = '';
        const NAMED = `${USER}-named`;
        const NAMED_EMAIL = `${SUITE}-named@example.test`;
        const namedCtx = () =>
            makeRequestContext('OWNER', {
                tenantId: TENANT,
                tenantSlug: TENANT,
                userId: NAMED,
            });

        beforeAll(async () => {
            // A SECOND actor, and one who has a `name` — the suite's own USER
            // deliberately has none. Two versions written by two different
            // people is what makes `name ?? email` an assertion about
            // precedence rather than about whichever field happens to be set.
            await prisma.user.upsert({
                where: { id: NAMED },
                update: { name: 'Ada Lovelace' },
                create: {
                    id: NAMED,
                    email: NAMED_EMAIL,
                    emailHash: hashForLookup(NAMED_EMAIL),
                    name: 'Ada Lovelace',
                },
            });
            await prisma.tenantMembership.upsert({
                where: { tenantId_userId: { tenantId: TENANT, userId: NAMED } },
                update: { role: 'OWNER', status: 'ACTIVE' },
                create: { tenantId: TENANT, userId: NAMED, role: 'OWNER', status: 'ACTIVE' },
            });

            // Registered at READ_TENANT_DATA (HIGH, cap 2) and granted
            // `list_risks`, which the seeded card CAN exercise — so v1 withholds
            // nothing and the withheld disclosure below is produced by the edit
            // rather than by the seed.
            agentId = await scoredAgent('get-payload', 'READ_TENANT_DATA');
            await grantAgentTool(ctx(), agentId, { toolName: 'list_risks' });
            await createAgentPolicyCard(ctx(), agentId);
            await activateRegisteredAgent(ctx(), agentId);
            token = await mintKey(agentId);

            // v2, written by the OTHER user: the card narrows to READ_METADATA
            // and drops the tool. The GRANT is untouched — narrowing a card
            // never revokes anything — so `list_risks` is now a standing grant
            // the card in force cannot exercise.
            await updateAgentPolicyCard(
                namedCtx(),
                agentId,
                edit(1, {
                    permittedTools: [],
                    maxDataScope: 'READ_METADATA',
                    maxAutonomyLevel: 2,
                    maxActionsPerRun: 10,
                    maxActionsPerDay: 100,
                }),
            );
        });

        it("returns the AGENT's two ceilings, which are not the card's", async () => {
            const payload = await getAgentPolicyCard(ctx(), agentId);
            const agent = await prisma.registeredAgent.findUniqueOrThrow({
                where: { id: agentId },
                select: { riskTier: true, dataAccessScope: true },
            });

            expect(payload.riskTier).toBe(agent.riskTier);
            expect(payload.dataAccessScope).toBe(agent.dataAccessScope);

            // Neither is a constant, and neither can be read off the card: the
            // tier is SCORED (HIGH, cap 2) and the register still declares
            // READ_TENANT_DATA while the card in force now stops one rung
            // lower. A payload echoing the card, or defaulting either field,
            // gives a different answer here.
            expect(payload.riskTier).toBe('HIGH');
            expect(ceilingForRiskTier(payload.riskTier)).toBe(2);
            expect(payload.dataAccessScope).toBe('READ_TENANT_DATA');
            expect(payload.card?.inForce?.maxDataScope).toBe('READ_METADATA');
        });

        it('returns the grants the card in force cannot exercise, with the CEILING that stops each', async () => {
            const payload = await getAgentPolicyCard(ctx(), agentId);
            if (payload.card === null) throw new Error('expected a card');

            // The grant stands: narrowing the card revoked nothing.
            expect(
                (
                    await prisma.registeredAgentTool.findMany({
                        where: { tenantId: TENANT, agentId },
                        select: { toolName: true },
                    })
                ).map((t) => t.toolName),
            ).toEqual(['list_risks']);

            // NULL means "the version in force could not be read"; this card
            // reads fine, so the answer is a list.
            expect(payload.withheld).not.toBeNull();
            expect(payload.withheld?.map((w) => w.toolName)).toEqual(['list_risks']);

            // And the REASON is ceiling-based, not "the card does not permit
            // it". `withholdingReasonForTool` never consults `permittedTools` —
            // the card in force both drops the tool AND stops below its base
            // rung, and the disclosure reports the rung. That is what the copy
            // on this panel has to say, and why it says "the ceiling it ran
            // into" rather than "the card does not permit them".
            expect(payload.withheld?.map((w) => w.reason)).toEqual(['DATA_SCOPE_ABOVE_CARD']);
            expect(payload.withheld?.[0]?.requires).toBe('READ_TENANT_DATA');
            expect(payload.withheld?.[0]?.permits).toBe('READ_METADATA');

            // The runtime agrees, which is what makes "every call is refused"
            // a fact this panel reports rather than a claim it makes.
            expect(errorOf((await callTool(token, 'list_risks')).json)).toMatch(/does not permit/);
        });

        it('and answers with an EMPTY list, not null, for a card that withholds nothing', async () => {
            // The healthy shape, from the same code path. Without this the
            // withheld assertion above would pass against a payload that
            // returned every grant unconditionally.
            const clean = await scoredAgent('get-payload-clean', 'READ_TENANT_DATA');
            await grantAgentTool(ctx(), clean, { toolName: 'list_risks' });
            await createAgentPolicyCard(ctx(), clean);

            const payload = await getAgentPolicyCard(ctx(), clean);
            if (payload.card === null) throw new Error('expected a card');
            expect(payload.card.inForce?.permittedTools).toEqual(['list_risks']);
            expect(payload.withheld).toEqual([]);
        });

        it('resolves each version actor to a display name, and never invents one', async () => {
            const payload = await getAgentPolicyCard(ctx(), agentId);
            if (payload.card === null) throw new Error('expected a card');
            const byVersion = new Map(payload.versions.map((v) => [v.version, v]));
            expect(byVersion.size).toBe(2);

            // v2 was written by the user who HAS a name, so the name wins.
            expect(byVersion.get(2)?.createdByUserId).toBe(NAMED);
            expect(byVersion.get(2)?.createdByName).toBe('Ada Lovelace');

            // v1 was written by the user who has none — `name ?? email`,
            // resolved server-side so the client never holds an address it has
            // nothing to do with. Two different actors, two different answers,
            // out of ONE batched lookup.
            expect(byVersion.get(1)?.createdByUserId).toBe(USER);
            expect(byVersion.get(1)?.createdByName).toBe(`${TENANT}@example.test`);

            // The raw id stays on the row and is never a stand-in for a name:
            // a client that rendered `createdByName` can never print a cuid.
            for (const version of payload.versions) {
                expect(version.createdByName).not.toBe(version.createdByUserId);
            }
        });

        it('carries the same two ceilings BEFORE there is a card to bound', async () => {
            // The no-card branch. The editor is not open yet, but the seed
            // preview is derived from both fields and the surface names the
            // ceilings rather than only their consequences — and this is the
            // branch a `card: null` early return is easiest to forget on.
            const bare = await scoredAgent('get-payload-nocard', 'READ_METADATA');
            const payload = await getAgentPolicyCard(ctx(), bare);
            const agent = await prisma.registeredAgent.findUniqueOrThrow({
                where: { id: bare },
                select: { riskTier: true, dataAccessScope: true },
            });

            expect(payload.card).toBeNull();
            expect(payload.dataAccessScope).toBe('READ_METADATA');
            expect(payload.riskTier).toBe(agent.riskTier);
            expect(payload.riskTier).not.toBeNull();
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // 8. The sentinel is never a number in a sentence.
    // ─────────────────────────────────────────────────────────────────
    describe('an unscored tier names the assessment, never a cap of -1', () => {
        it('refuses the raise with the sentence its register sibling already uses', async () => {
            const agentId = await scoredAgent('unscored-cap', 'READ_TENANT_DATA');
            await createAgentPolicyCard(ctx(), agentId);

            // Written straight to the row on purpose. No product write path
            // clears `riskTier` today — `createAgentPolicyCard` refuses an
            // unscored agent outright, and a re-score never lowers a tier to
            // null — so this state is reachable only by a future path or a
            // hand-edited row. The sentence exists for exactly that case, and
            // `ceilingForRiskTier` resolving it to DENY_CEILING (-1) is what
            // used to leak "caps it at -1" into an operator's face.
            //
            // BOTH columns, because the schema will not have it otherwise:
            // `RegisteredAgent_riskTier_scoredAt_paired_check` asserts
            // `("riskTier" IS NULL) = ("riskTierScoredAt" IS NULL)`, so
            // UNSCORED is a state of the pair and not of one column. Clearing
            // the tier alone is refused by Postgres — which is itself worth
            // knowing here: the only unscored agent that can exist is one
            // nothing has ever scored.
            await prisma.registeredAgent.update({
                where: { id: agentId },
                data: { riskTier: null, riskTierScoredAt: null },
            });

            const err = await updateAgentPolicyCard(
                ctx(),
                agentId,
                edit(1, {
                    permittedTools: [],
                    maxDataScope: 'READ_TENANT_DATA',
                    maxAutonomyLevel: 3,
                    maxActionsPerRun: 10,
                    maxActionsPerDay: 100,
                }),
            ).catch((e: Error) => e);

            expect((err as Error).message).toMatch(/has not been risk-assessed/);
            expect((err as Error).message).toMatch(/Complete its agent risk assessment first/);
            // The sentinel itself never reaches the operator.
            expect((err as Error).message).not.toMatch(/-1/);
            // And it is still a REFUSAL, so nothing was appended.
            expect(
                await prisma.agentPolicyCardVersion.count({
                    where: { tenantId: TENANT, card: { agentId } },
                }),
            ).toBe(1);
        });
    });
});
