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
import { POLICY_CARD_RULES } from '@/lib/agentic/policy-card';

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
});
