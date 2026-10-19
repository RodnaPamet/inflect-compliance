/**
 * The registration intake against a real database (#3669, step 2a; deploy 2 of
 * the UNCLASSIFIED tier).
 *
 *   1. A SHADOW_AGENT FINDING BECOMES A DRAFT REGISTER ROW through a provisional
 *      AI-system entry at UNCLASSIFIED, in one transaction, owned by the person
 *      the request CONFIRMS. The finding stays open and the discovered agent is
 *      not written; the next scan that reports the agent registered closes it.
 *   2. EVERY REFUSAL IS NAMED AND WRITES NOTHING — no register row, no AI-system
 *      entry, no audit row.
 *   3. ONE DISCOVERED AGENT, ONE REGISTER ROW — a second intake is refused, and
 *      two racing intakes make one row and no orphaned AI-system entry.
 *   4. TWO TENANTS — another tenant's finding and another tenant's member are
 *      refused, and each tenant's shadow agent is its own.
 *   5. THE AGENT CANNOT GO INTO SERVICE UNCLASSIFIED — activation is refused
 *      `AI_SYSTEM_UNCLASSIFIED` until the entry is classified, after which that
 *      reason is gone.
 *   6. THE ROUTE carries a literal `requirePermission('admin.agent_registry')`.
 *
 * Findings and discovered agents are made the only way the product makes them:
 * a signed report through the real ingest.
 */
const getTenantCtxMock = jest.fn();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

import { MembershipStatus, PrismaClient, Role } from '@prisma/client';
import { NextRequest } from 'next/server';

import { prismaTestClient } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { createFakeScanner, validReportBody, type FakeScanner } from '../helpers/agent-harness-fake-scanner';
import { activateRegisteredAgent, createRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { ingestHarnessReport } from '@/app-layer/usecases/agent-harness-scans';
import { addHarnessScannerKey } from '@/app-layer/usecases/agent-harness-scanner-keys';
import { registerShadowAgent } from '@/app-layer/usecases/agent-registration-intake';
import { classifyAiSystemEntry } from '@/app-layer/usecases/ai-system';
import { RegisteredAgentRepository } from '@/app-layer/repositories/RegisteredAgentRepository';
import { verifyAuditChain } from '@/lib/audit';
import { POST as INTAKE } from '@/app/api/t/[tenantSlug]/admin/agents/intake/route';
import type { HarnessReportAgentV1, HarnessReportBodyV1 } from '@/lib/agentic/harness-contract';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const T1 = 'reg-intake-one';
const T2 = 'reg-intake-two';
const ALL_TENANTS = [T1, T2];
const PEOPLE = ['owner', 'other', 'admin', 'editor', 'departed'] as const;
type Person = (typeof PEOPLE)[number];
const ROLE: Record<Person, Role> = {
    owner: Role.OWNER,
    other: Role.OWNER,
    admin: Role.ADMIN,
    editor: Role.EDITOR,
    departed: Role.ADMIN,
};

/** The shadow agents the seeded scan reports, besides the one registered agent. */
const SHADOWS = ['shadow-flow', 'shadow-again', 'shadow-race', 'shadow-refusals', 'shadow-route', 'shadow-other', 'shadow-ai-admin'] as const;
type Shadow = (typeof SHADOWS)[number];
const discoveredIdOf = (s: Shadow) => `entra:sp:${s}`;

interface Seeded {
    users: Record<Person, string>;
    scannerAgentId: string;
    targetAgentId: string;
    scanner: FakeScanner;
    /** The SHADOW_AGENT finding id per shadow. */
    shadowFinding: Record<Shadow, string>;
    /** The DiscoveredAgent row id per shadow. */
    discovered: Record<Shadow, string>;
    /** A harness finding that is NOT a shadow finding. */
    unpinnedFinding: string;
}
const seeded: Record<string, Seeded> = {};

const emailOf = (tenantId: string, who: Person) => `${who}@${tenantId}.test`;

const ctxFor = (tenantId: string, who: Person = 'owner'): RequestContext =>
    makeRequestContext(ROLE[who], {
        tenantId,
        tenantSlug: tenantId,
        userId: seeded[tenantId].users[who],
    });

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: ALL_TENANTS } };
    await prisma.agentHarnessAcceptance.deleteMany({ where: t });
    await prisma.agentHarnessScanItem.deleteMany({ where: t });
    await prisma.agentHarnessScan.deleteMany({ where: t });
    await prisma.discoveredAgent.deleteMany({ where: t });
    await prisma.agentHarnessScannerKey.deleteMany({ where: t });
    await prisma.finding.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystemRequirementLink.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, ALL_TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, ALL_TENANTS);
    });
    await prisma.user.deleteMany({
        where: { emailHash: { in: ALL_TENANTS.flatMap((t) => PEOPLE.map((p) => hashForLookup(emailOf(t, p)))) } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: ALL_TENANTS } } });
}

function shadowAgent(template: HarnessReportAgentV1, s: Shadow): HarnessReportAgentV1 {
    return { ...template, discoveredId: discoveredIdOf(s), registeredAgentId: null };
}

/** The fake scanner's valid body, pointed at this tenant's register, with every shadow in it. */
function bodyFor(tenantId: string, scanId: string, registered: Partial<Record<Shadow, string>> = {}): HarnessReportBodyV1 {
    const s = seeded[tenantId];
    const body = validReportBody();
    body.scan.id = scanId;
    body.scan.scanner.agentId = s.scannerAgentId;
    body.agents[0].registeredAgentId = s.targetAgentId;
    const template = body.agents[1];
    body.agents = [
        body.agents[0],
        ...SHADOWS.map((sh) => ({ ...shadowAgent(template, sh), registeredAgentId: registered[sh] ?? null })),
    ];
    body.findings = [];
    return body;
}

async function seedTenant(tenantId: string): Promise<void> {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
    const users = {} as Record<Person, string>;
    for (const who of PEOPLE) {
        const email = emailOf(tenantId, who);
        const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        users[who] = user.id;
        await prisma.tenantMembership.create({
            data: {
                tenantId,
                userId: user.id,
                role: ROLE[who],
                status: who === 'departed' ? MembershipStatus.DEACTIVATED : MembershipStatus.ACTIVE,
            },
        });
    }
    seeded[tenantId] = { users } as Seeded;

    const agent = async (name: string) =>
        createRegisteredAgent(ctxFor(tenantId), {
            aiSystemId: (await prisma.aiSystem.create({ data: { tenantId, name: `Host of ${name}`, ownerUserId: users.owner } })).id,
            name,
            autonomyLevel: 2,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'COMPENSABLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: users.owner,
        });
    const scannerAgent = await agent(`Harness scanner ${tenantId}`);
    const targetAgent = await agent(`Reporting agent ${tenantId}`);
    const scanner = createFakeScanner();
    await addHarnessScannerKey(ctxFor(tenantId), { agentId: scannerAgent.id, publicKey: scanner.publicKeyHex });
    Object.assign(seeded[tenantId], { scannerAgentId: scannerAgent.id, targetAgentId: targetAgent.id, scanner });

    await ingestHarnessReport(ctxFor(tenantId), scanner.serialise(bodyFor(tenantId, `scan_${tenantId}_1`)));

    const findings = await prisma.finding.findMany({
        where: { tenantId, sourceKind: 'AGENT_HARNESS' },
        select: { id: true, sourceRef: true },
    });
    const byRef = new Map(findings.map((f) => [f.sourceRef as string, f.id]));
    const discovered = await prisma.discoveredAgent.findMany({ where: { tenantId }, select: { id: true, discoveredId: true } });
    const daByDiscoveredId = new Map(discovered.map((d) => [d.discoveredId, d.id]));
    seeded[tenantId].shadowFinding = Object.fromEntries(
        SHADOWS.map((s) => [s, byRef.get(`SHADOW_AGENT:${discoveredIdOf(s)}`) as string]),
    ) as Record<Shadow, string>;
    seeded[tenantId].discovered = Object.fromEntries(
        SHADOWS.map((s) => [s, daByDiscoveredId.get(discoveredIdOf(s)) as string]),
    ) as Record<Shadow, string>;
    seeded[tenantId].unpinnedFinding = byRef.get(`UNPINNED_WRITE_TOOL:${discoveredIdOf('shadow-flow')}`) as string;
}

/** A complete, valid intake body for one shadow of one tenant. */
function intakeBody(tenantId: string, s: Shadow, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        findingId: seeded[tenantId].shadowFinding[s],
        ownerUserId: seeded[tenantId].users.owner,
        confirmOwner: true,
        name: `Sales bot (${s})`,
        description: 'Found by the harness scan, registered from its finding.',
        autonomyLevel: 3,
        dataAccessScope: 'WRITE_TENANT_DATA',
        reversibility: 'COMPENSABLE',
        provenance: 'FIRST_PARTY',
        ...overrides,
    };
}

/** An attribution answer the 1d contract accepts, naming `ref` as the owner. */
function suggestion(discoveredAgentId: string, ref: string) {
    return {
        discoveredAgentId,
        status: 'SUGGESTED',
        proposedOwnerRef: ref,
        grade: 'STRONG',
        signals: [
            { kind: 'IDENTITY_OWNER', evidence: 'entra-sp:servicePrincipals/sales#owners', personRef: ref, personActive: true },
            { kind: 'NAMING_PATTERN', evidence: 'entra-sp:servicePrincipals/sales#displayName', personRef: null, personActive: null },
        ],
    };
}

const INTAKE_AUDIT_ACTIONS = ['AI_SYSTEM_REGISTERED', 'AGENT_REGISTERED', 'AGENT_REGISTRATION_INTAKE'];

async function rowCounts(tenantId: string) {
    return {
        agents: await prisma.registeredAgent.count({ where: { tenantId } }),
        aiSystems: await prisma.aiSystem.count({ where: { tenantId } }),
        audit: await prisma.auditLog.count({ where: { tenantId } }),
        intakeAudit: await prisma.auditLog.count({ where: { tenantId, action: { in: INTAKE_AUDIT_ACTIONS } } }),
        discovered: await prisma.discoveredAgent.count({ where: { tenantId, registeredAgentId: { not: null } } }),
    };
}

/**
 * The counts a rolled-back WRITE leaves unchanged. Not the raw audit count: the
 * client's audit extension records each statement on its own connection as it
 * runs (`src/lib/prisma.ts`), so a transaction that inserted and then rolled
 * back leaves that extension's CREATE row behind — a property of every
 * rolled-back write in the product, not of the intake. The intake's own rows
 * are counted instead.
 */
async function rolledBackCounts(tenantId: string) {
    const { audit: _extensionRows, ...rest } = await rowCounts(tenantId);
    return rest;
}

/** The refusal's named reason, from the error the usecase threw. */
async function reasonOf(p: Promise<unknown>): Promise<string> {
    try {
        await p;
    } catch (err) {
        return ((err as { details?: { reason?: string } }).details?.reason) ?? `UNNAMED: ${(err as Error).message}`;
    }
    throw new Error('expected a refusal, and the call succeeded');
}

beforeAll(async () => {
    await clearOwnRows();
    for (const t of ALL_TENANTS) await seedTenant(t);
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('a SHADOW_AGENT finding becomes a DRAFT register row through an UNCLASSIFIED entry', () => {
    it('one transaction: a provisional entry, a DRAFT agent owned by the confirmed person, and nothing else', async () => {
        const s = seeded[T1];
        const before = await rowCounts(T1);
        const result = await registerShadowAgent(
            ctxFor(T1),
            intakeBody(T1, 'shadow-flow', {
                purpose: 'Updates opportunities in the CRM',
                attribution: suggestion(s.discovered['shadow-flow'], emailOf(T1, 'owner').toUpperCase()),
            }),
        );

        expect(result).toMatchObject({
            status: 'DRAFT',
            aiActRiskTier: 'UNCLASSIFIED',
            findingId: s.shadowFinding['shadow-flow'],
            discoveredAgentId: s.discovered['shadow-flow'],
            discoveredId: discoveredIdOf('shadow-flow'),
            ownerUserId: s.users.owner,
        });

        const agent = await prisma.registeredAgent.findUniqueOrThrow({ where: { id: result.agentId } });
        expect(agent).toMatchObject({
            tenantId: T1,
            aiSystemId: result.aiSystemId,
            status: 'DRAFT',
            riskTier: null,
            ownerUserId: s.users.owner,
            intakeDiscoveredAgentId: s.discovered['shadow-flow'],
            autonomyLevel: 3,
            dataAccessScope: 'WRITE_TENANT_DATA',
        });
        const system = await prisma.aiSystem.findUniqueOrThrow({ where: { id: result.aiSystemId } });
        expect(system).toMatchObject({
            riskTier: 'UNCLASSIFIED',
            classificationClauseId: null,
            classificationRationale: null,
            classificationAnswersJson: null,
            ownerUserId: s.users.owner,
        });
        // Stored (encrypted at rest; this client does not decrypt it).
        expect(system.purpose).not.toBeNull();
        expect(await prisma.aiSystemRequirementLink.count({ where: { aiSystemId: system.id } })).toBe(0);

        // Exactly one of each, and the discovered agent is NOT linked: the
        // ingest is that table's only writer, and the next scan links it.
        const after = await rowCounts(T1);
        expect(after.agents).toBe(before.agents + 1);
        expect(after.aiSystems).toBe(before.aiSystems + 1);
        expect(after.discovered).toBe(before.discovered);
        const da = await prisma.discoveredAgent.findUniqueOrThrow({ where: { id: s.discovered['shadow-flow'] } });
        expect(da.registeredAgentId).toBeNull();

        // The finding is not closed by the act it asked for.
        const finding = await prisma.finding.findUniqueOrThrow({ where: { id: s.shadowFinding['shadow-flow'] } });
        expect(finding.status).toBe('OPEN');
    });

    it('records the suggestion as provenance — its signals, and that the confirmed owner is the one it named', async () => {
        const s = seeded[T1];
        const agent = await prisma.registeredAgent.findFirstOrThrow({
            where: { tenantId: T1, intakeDiscoveredAgentId: s.discovered['shadow-flow'] },
        });
        const rows = await prisma.auditLog.findMany({
            where: {
                tenantId: T1,
                entityId: { in: [agent.id, agent.aiSystemId, s.shadowFinding['shadow-flow']] },
                action: { in: ['AI_SYSTEM_REGISTERED', 'AGENT_REGISTERED', 'AGENT_REGISTRATION_INTAKE'] },
            },
            select: { action: true, entity: true, entityId: true, detailsJson: true },
        });
        // One row per entity the intake touched.
        expect(rows.map((r) => [r.entity, r.action, r.entityId]).sort()).toEqual(
            [
                ['AiSystem', 'AI_SYSTEM_REGISTERED', agent.aiSystemId],
                ['Finding', 'AGENT_REGISTRATION_INTAKE', s.shadowFinding['shadow-flow']],
                ['RegisteredAgent', 'AGENT_REGISTERED', agent.id],
            ].sort(),
        );
        const registered = rows.find((r) => r.action === 'AGENT_REGISTERED')!.detailsJson as {
            operation: string;
            sourceId: string;
            after: Record<string, unknown>;
        };
        expect(registered.operation).toBe('intake');
        expect(registered.sourceId).toBe(s.shadowFinding['shadow-flow']);
        expect(registered.after).toMatchObject({
            aiActRiskTier: 'UNCLASSIFIED',
            ownerUserId: s.users.owner,
            ownerConfirmed: true,
            ownerSuggestion: {
                status: 'SUGGESTED',
                grade: 'STRONG',
                confirmedOwnerIsSuggested: true,
                signals: [
                    { kind: 'IDENTITY_OWNER', evidence: 'entra-sp:servicePrincipals/sales#owners', namesPerson: true },
                    { kind: 'NAMING_PATTERN', evidence: 'entra-sp:servicePrincipals/sales#displayName', namesPerson: false },
                ],
            },
        });
        // The suggested person's reference never reaches the audit row.
        expect(JSON.stringify(registered)).not.toContain(emailOf(T1, 'owner'));
        expect(JSON.stringify(registered).toLowerCase()).not.toContain(emailOf(T1, 'owner'));
    });

    it('the next scan that reports the agent registered links it and closes the finding; a further intake is ALREADY_REGISTERED', async () => {
        const s = seeded[T1];
        const agent = await prisma.registeredAgent.findFirstOrThrow({
            where: { tenantId: T1, intakeDiscoveredAgentId: s.discovered['shadow-flow'] },
        });
        await ingestHarnessReport(
            ctxFor(T1),
            s.scanner.serialise(bodyFor(T1, `scan_${T1}_2`, { 'shadow-flow': agent.id })),
        );
        const da = await prisma.discoveredAgent.findUniqueOrThrow({ where: { id: s.discovered['shadow-flow'] } });
        expect(da.registeredAgentId).toBe(agent.id);
        const finding = await prisma.finding.findUniqueOrThrow({ where: { id: s.shadowFinding['shadow-flow'] } });
        expect(finding.status).toBe('CLOSED');

        const before = await rowCounts(T1);
        expect(await reasonOf(registerShadowAgent(ctxFor(T1), intakeBody(T1, 'shadow-flow')))).toBe('ALREADY_REGISTERED');
        expect(await rowCounts(T1)).toEqual(before);
    });

    it('a confirmed owner other than the suggested one is the owner, and the provenance says they differ', async () => {
        const s = seeded[T1];
        const result = await registerShadowAgent(
            ctxFor(T1),
            intakeBody(T1, 'shadow-route', {
                ownerUserId: s.users.other,
                attribution: suggestion(s.discovered['shadow-route'], emailOf(T1, 'owner')),
            }),
        );
        expect(result.ownerUserId).toBe(s.users.other);
        expect(result.suggestion).toMatchObject({ status: 'SUGGESTED', confirmedOwnerIsSuggested: false });
        expect((await prisma.registeredAgent.findUniqueOrThrow({ where: { id: result.agentId } })).ownerUserId).toBe(
            s.users.other,
        );
    });
});

describe('one discovered agent, one register row', () => {
    it('a second intake before any scan is refused ALREADY_REGISTERED_BY_INTAKE, and writes nothing', async () => {
        await registerShadowAgent(ctxFor(T1), intakeBody(T1, 'shadow-again'));
        const before = await rowCounts(T1);
        expect(await reasonOf(registerShadowAgent(ctxFor(T1), intakeBody(T1, 'shadow-again', { name: 'Twice' })))).toBe(
            'ALREADY_REGISTERED_BY_INTAKE',
        );
        expect(await rowCounts(T1)).toEqual(before);
        expect(
            await prisma.registeredAgent.count({
                where: { tenantId: T1, intakeDiscoveredAgentId: seeded[T1].discovered['shadow-again'] },
            }),
        ).toBe(1);
    });

    it('when the claim read misses (the race window), the unique index refuses the insert and the entry rolls back', async () => {
        // Deterministic form of the race: the read that would have refused is
        // made to see nothing, so only the database stands in the way.
        const spy = jest.spyOn(RegisteredAgentRepository, 'findIntakeClaim').mockResolvedValueOnce(null);
        const before = await rolledBackCounts(T1);
        try {
            expect(await reasonOf(registerShadowAgent(ctxFor(T1), intakeBody(T1, 'shadow-again', { name: 'Raced' })))).toBe(
                'ALREADY_REGISTERED_BY_INTAKE',
            );
            // The read really was bypassed, so the refusal came from the index.
            expect(spy).toHaveBeenCalledTimes(1);
        } finally {
            spy.mockRestore();
        }
        expect(await rolledBackCounts(T1)).toEqual(before);
    });

    it('two intakes racing make ONE register row and leave no orphaned AI-system entry', async () => {
        const before = await rowCounts(T1);
        const outcomes = await Promise.allSettled([
            registerShadowAgent(ctxFor(T1), intakeBody(T1, 'shadow-race', { name: 'Racer A' })),
            registerShadowAgent(ctxFor(T1, 'admin'), intakeBody(T1, 'shadow-race', { name: 'Racer B' })),
        ]);
        expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
        const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
        expect(rejected).toHaveLength(1);
        expect((rejected[0].reason as { details?: { reason?: string } }).details?.reason).toBe(
            'ALREADY_REGISTERED_BY_INTAKE',
        );

        const after = await rowCounts(T1);
        expect(after.agents).toBe(before.agents + 1);
        // The loser's provisional entry rolled back with its transaction, and
        // only the winner wrote the intake's three audit rows.
        expect(after.aiSystems).toBe(before.aiSystems + 1);
        expect(after.intakeAudit).toBe(before.intakeAudit + 3);
        expect(
            await prisma.registeredAgent.count({
                where: { tenantId: T1, intakeDiscoveredAgentId: seeded[T1].discovered['shadow-race'] },
            }),
        ).toBe(1);
    });
});

describe('every refusal is named and writes nothing', () => {
    const shadow = 'shadow-refusals' as const;
    const cases: Array<[string, () => Promise<unknown>, string]> = [
        ['an unknown finding', () => registerShadowAgent(ctxFor(T1), intakeBody(T1, shadow, { findingId: 'no-such-finding' })), 'FINDING_NOT_FOUND'],
        [
            'a harness finding that is not a SHADOW_AGENT finding',
            () => registerShadowAgent(ctxFor(T1), intakeBody(T1, shadow, { findingId: seeded[T1].unpinnedFinding })),
            'NOT_A_SHADOW_AGENT_FINDING',
        ],
        ['no owner named', () => registerShadowAgent(ctxFor(T1), intakeBody(T1, shadow, { ownerUserId: undefined })), 'OWNER_NOT_CONFIRMED'],
        ['an owner named and not confirmed', () => registerShadowAgent(ctxFor(T1), intakeBody(T1, shadow, { confirmOwner: undefined })), 'OWNER_NOT_CONFIRMED'],
        ['an owner named and confirmOwner false', () => registerShadowAgent(ctxFor(T1), intakeBody(T1, shadow, { confirmOwner: false })), 'OWNER_NOT_CONFIRMED'],
        [
            'a suggestion and no confirmed owner — the suggestion never becomes the owner',
            () =>
                registerShadowAgent(
                    ctxFor(T1),
                    intakeBody(T1, shadow, {
                        ownerUserId: undefined,
                        confirmOwner: undefined,
                        attribution: suggestion(seeded[T1].discovered[shadow], seeded[T1].users.owner),
                    }),
                ),
            'OWNER_NOT_CONFIRMED',
        ],
        [
            'a deactivated member as the owner',
            () => registerShadowAgent(ctxFor(T1), intakeBody(T1, shadow, { ownerUserId: seeded[T1].users.departed })),
            'OWNER_NOT_ACTIVE_MEMBER',
        ],
        [
            'an attribution that records an owner',
            () =>
                registerShadowAgent(
                    ctxFor(T1),
                    intakeBody(T1, shadow, {
                        attribution: { ...suggestion(seeded[T1].discovered[shadow], seeded[T1].users.owner), ownerUserId: seeded[T1].users.owner },
                    }),
                ),
            'SUGGESTION_INVALID',
        ],
        [
            'an attribution claiming a LINKED owner',
            () =>
                registerShadowAgent(
                    ctxFor(T1),
                    intakeBody(T1, shadow, {
                        attribution: { ...suggestion(seeded[T1].discovered[shadow], seeded[T1].users.owner), status: 'LINKED' },
                    }),
                ),
            'SUGGESTION_INVALID',
        ],
        [
            'an attribution about another discovered agent',
            () =>
                registerShadowAgent(
                    ctxFor(T1),
                    intakeBody(T1, shadow, { attribution: suggestion(seeded[T1].discovered['shadow-other'], seeded[T1].users.owner) }),
                ),
            'SUGGESTION_FOR_ANOTHER_AGENT',
        ],
    ];

    it.each(cases)('%s', async (_label, call, reason) => {
        const before = await rowCounts(T1);
        expect(await reasonOf(call())).toBe(reason);
        expect(await rowCounts(T1)).toEqual(before);
    });

    it('a request that states a tier is refused by the schema, whatever the tier', async () => {
        const before = await rowCounts(T1);
        await expect(registerShadowAgent(ctxFor(T1), intakeBody(T1, shadow, { riskTier: 'MINIMAL' }))).rejects.toThrow();
        await expect(registerShadowAgent(ctxFor(T1), intakeBody(T1, shadow, { riskTier: 'UNCLASSIFIED' }))).rejects.toThrow();
        expect(await rowCounts(T1)).toEqual(before);
    });

    it('a principal without the register key is refused before anything is read', async () => {
        const editor = ctxFor(T1, 'editor');
        expect(editor.appPermissions.admin.agent_registry).toBe(false);
        const before = await rowCounts(T1);
        await expect(registerShadowAgent(editor, intakeBody(T1, shadow))).rejects.toThrow(/agent register/);
        expect(await rowCounts(T1)).toEqual(before);
    });
});

describe('two tenants', () => {
    it("another tenant's finding is FINDING_NOT_FOUND, and another tenant's member is not an owner here", async () => {
        const before = { one: await rowCounts(T1), two: await rowCounts(T2) };
        expect(
            await reasonOf(registerShadowAgent(ctxFor(T2), intakeBody(T2, 'shadow-other', { findingId: seeded[T1].shadowFinding['shadow-other'] }))),
        ).toBe('FINDING_NOT_FOUND');
        expect(
            await reasonOf(registerShadowAgent(ctxFor(T1), intakeBody(T1, 'shadow-other', { ownerUserId: seeded[T2].users.owner }))),
        ).toBe('OWNER_NOT_ACTIVE_MEMBER');
        expect({ one: await rowCounts(T1), two: await rowCounts(T2) }).toEqual(before);
    });

    it("each tenant's shadow agent is its own: the same discovered id registers once in each", async () => {
        const one = await registerShadowAgent(ctxFor(T1), intakeBody(T1, 'shadow-other'));
        const two = await registerShadowAgent(ctxFor(T2), intakeBody(T2, 'shadow-other'));
        expect(one.discoveredId).toBe(two.discoveredId);
        expect(one.discoveredAgentId).not.toBe(two.discoveredAgentId);
        expect((await prisma.registeredAgent.findUniqueOrThrow({ where: { id: one.agentId } })).tenantId).toBe(T1);
        expect((await prisma.registeredAgent.findUniqueOrThrow({ where: { id: two.agentId } })).tenantId).toBe(T2);
        expect((await prisma.aiSystem.findUniqueOrThrow({ where: { id: two.aiSystemId } })).tenantId).toBe(T2);
    });
});

describe('an intake agent cannot go into service until its entry is classified', () => {
    it('activation refuses AI_SYSTEM_UNCLASSIFIED; after classification that reason is gone', async () => {
        const s = seeded[T1];
        const agent = await prisma.registeredAgent.findFirstOrThrow({
            where: { tenantId: T1, intakeDiscoveredAgentId: s.discovered['shadow-again'] },
        });

        // Unclassified AND unscored: the classification is asked first.
        expect(await reasonOf(activateRegisteredAgent(ctxFor(T1), agent.id))).toBe('AI_SYSTEM_UNCLASSIFIED');
        expect((await prisma.registeredAgent.findUniqueOrThrow({ where: { id: agent.id } })).status).toBe('DRAFT');

        // The classification must ANSWER every question.
        await expect(classifyAiSystemEntry(ctxFor(T1), agent.aiSystemId, { classification: {} })).rejects.toThrow();
        await expect(
            classifyAiSystemEntry(ctxFor(T1), agent.aiSystemId, {
                classification: { prohibitedPractice: null, isAnnexIProductSafetyComponent: null, annexIIIArea: null, transparencyCase: null },
                riskTier: 'MINIMAL',
            }),
        ).rejects.toThrow();

        const classified = await classifyAiSystemEntry(ctxFor(T1, 'editor'), agent.aiSystemId, {
            classification: {
                prohibitedPractice: null,
                isAnnexIProductSafetyComponent: false,
                annexIIIArea: null,
                transparencyCase: 'direct_interaction',
            },
        });
        expect(classified).toMatchObject({ riskTier: 'LIMITED', clauseId: 'Art.50(1)' });
        const system = await prisma.aiSystem.findUniqueOrThrow({ where: { id: agent.aiSystemId } });
        expect(system.riskTier).toBe('LIMITED');
        expect(system.classificationAnswersJson).toMatchObject({ transparencyCase: 'direct_interaction', annexIIIArea: null });
        expect(await prisma.aiSystemRequirementLink.count({ where: { aiSystemId: system.id } })).toBe(classified.obligationsLinked);

        // The UNCLASSIFIED refusal is gone; the agent is still unscored.
        expect(await reasonOf(activateRegisteredAgent(ctxFor(T1), agent.id))).toBe('UNSCORED');

        // Classification is one-way and once.
        expect(
            await classifyAiSystemEntry(ctxFor(T1), agent.aiSystemId, {
                classification: { prohibitedPractice: null, isAnnexIProductSafetyComponent: null, annexIIIArea: null, transparencyCase: null },
            }).then(
                () => 'classified twice',
                (err: Error) => (/ALREADY_CLASSIFIED/.test(err.message) ? 'ALREADY_CLASSIFIED' : err.message),
            ),
        ).toBe('ALREADY_CLASSIFIED');

        // Scored, it goes into service.
        await prisma.registeredAgent.update({
            where: { id: agent.id },
            data: { riskTier: 'LOW', riskTierScoredAt: new Date() },
        });
        await expect(activateRegisteredAgent(ctxFor(T1), agent.id)).resolves.toEqual({ id: agent.id, status: 'ACTIVE' });
    });

    it("classification is tenant-scoped: another tenant's entry is not found", async () => {
        const agent = await prisma.registeredAgent.findFirstOrThrow({
            where: { tenantId: T2, intakeDiscoveredAgentId: seeded[T2].discovered['shadow-other'] },
        });
        await expect(
            classifyAiSystemEntry(ctxFor(T1), agent.aiSystemId, {
                classification: { prohibitedPractice: null, isAnnexIProductSafetyComponent: null, annexIIIArea: null, transparencyCase: null },
            }),
        ).rejects.toThrow(/not found/i);
        expect((await prisma.aiSystem.findUniqueOrThrow({ where: { id: agent.aiSystemId } })).riskTier).toBe('UNCLASSIFIED');
    });
});

describe('the intake route', () => {
    const url = (tenantId: string) => `http://localhost/api/t/${tenantId}/admin/agents/intake`;
    const req = (tenantId: string, body: unknown) =>
        new NextRequest(url(tenantId), {
            method: 'POST',
            headers: new Headers({ 'content-type': 'application/json' }),
            body: JSON.stringify(body),
        });
    const routeArgs = (tenantId: string) => ({ params: Promise.resolve({ tenantSlug: tenantId }) });
    const denials = () => prisma.auditLog.count({ where: { tenantId: T2, action: 'AUTHZ_DENIED' } });

    it('an EDITOR is refused by the literal requirePermission, with exactly one AUTHZ_DENIED row', async () => {
        getTenantCtxMock.mockResolvedValue(ctxFor(T2, 'editor'));
        const before = { denials: await denials(), rows: await rowCounts(T2) };
        const res = await INTAKE(req(T2, intakeBody(T2, 'shadow-route')), routeArgs(T2));
        expect(res.status).toBe(403);
        expect(JSON.stringify(await res.json())).not.toContain('agent_registry');
        expect(await denials()).toBe(before.denials + 1);
        const row = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: T2, action: 'AUTHZ_DENIED' },
            orderBy: { createdAt: 'desc' },
        });
        expect(row.entityId).toBe('admin.agent_registry');
        expect((await rowCounts(T2)).agents).toBe(before.rows.agents);
    });

    it('an ADMIN registers (201), and a refusal carries its reason in error.details', async () => {
        getTenantCtxMock.mockResolvedValue(ctxFor(T2, 'admin'));
        const created = await INTAKE(req(T2, intakeBody(T2, 'shadow-route')), routeArgs(T2));
        expect(created.status).toBe(201);
        expect(await created.json()).toMatchObject({ status: 'DRAFT', aiActRiskTier: 'UNCLASSIFIED' });

        const again = await INTAKE(req(T2, intakeBody(T2, 'shadow-route')), routeArgs(T2));
        expect(again.status).toBe(409);
        expect(await again.json()).toMatchObject({ error: { details: { reason: 'ALREADY_REGISTERED_BY_INTAKE' } } });
    });

    it('an AI_ADMIN — the register key on a READER tier — runs the intake (#3699)', async () => {
        // The usecase floor is the agent-governance floor: the coarse write
        // tier OR the register key. AI_ADMIN holds the key and not the tier.
        const aiAdmin = makeRequestContext(Role.AI_ADMIN, {
            tenantId: T2,
            tenantSlug: T2,
            userId: seeded[T2].users.editor,
        });
        expect(aiAdmin.permissions.canWrite).toBe(false);
        expect(aiAdmin.appPermissions.admin.agent_registry).toBe(true);
        const registered = await registerShadowAgent(aiAdmin, intakeBody(T2, 'shadow-ai-admin'));
        expect(registered).toMatchObject({ status: 'DRAFT', aiActRiskTier: 'UNCLASSIFIED' });
    });

    it('the hash chain still verifies with the intake rows in it', async () => {
        for (const t of ALL_TENANTS) {
            const result = await verifyAuditChain(t, prisma);
            expect(result.valid).toBe(true);
            expect(result.unhashedEntries).toBe(0);
        }
    });
});
