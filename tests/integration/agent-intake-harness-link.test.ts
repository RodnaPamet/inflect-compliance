/**
 * The harness ingest honours the registration intake's link (#3712), against a
 * real database, through the real ingest and the real intake.
 *
 *   1. SCAN → INTAKE → SCAN WITH NO CLAIMED ID: a complete scan links the
 *      discovered agent to the intake's register row, closes its SHADOW_AGENT
 *      finding, and takes it off the shadow list.
 *   2. A REPORT NAMING A DIFFERENT REGISTER ROW WINS. The intake's record does
 *      not override it, and the intake row's history records the conflict.
 *   3. A RETIRED INTAKE ROW IS NEVER LINKED, and the finding it was registered
 *      from stays open.
 *   4. AN INCOMPLETE SCAN LINKS THE AGENT BUT DOES NOT CLOSE ITS FINDING; the
 *      next complete scan does.
 *   5. TWO TENANTS: an intake row of tenant B naming tenant A's discovered
 *      agent links nothing in tenant A, and tenant A's shadow list does not see
 *      it.
 *   6. 2c's SERVICE-PRINCIPAL CONFIRMATION COEXISTS with the intake link in the
 *      ingest transaction: the intake writes no confirmation (owner decision,
 *      2026-10-18), a person confirms the intake-made link through 2c's own
 *      usecase, and a scan that drops the link invalidates the confirmation.
 *
 * Findings and discovered agents are made the only way the product makes them:
 * a signed report through the real ingest. The shadow list's read model is
 * checked on the way, because it is what the Register action stands on.
 */
import { MembershipStatus, PrismaClient, Role } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { createFakeScanner, validReportBody, type FakeScanner } from '../helpers/agent-harness-fake-scanner';
import { createRegisteredAgent, retireRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { confirmServicePrincipalLink } from '@/app-layer/usecases/agent-service-principal-confirmation';
import { ingestHarnessReport } from '@/app-layer/usecases/agent-harness-scans';
import { addHarnessScannerKey } from '@/app-layer/usecases/agent-harness-scanner-keys';
import { getHarnessMatrix } from '@/app-layer/usecases/agent-harness-matrix';
import { registerShadowAgent } from '@/app-layer/usecases/agent-registration-intake';
import type { HarnessReportAgent, HarnessReportBody } from '@/lib/agentic/harness-contract';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const T1 = 'intake-link-one';
const T2 = 'intake-link-two';
const ALL_TENANTS = [T1, T2];
const PEOPLE = ['owner', 'other'] as const;
type Person = (typeof PEOPLE)[number];

/** The shadow agents T1's scans report, besides the one registered agent. */
const SHADOWS = ['link', 'conflict', 'retired', 'incomplete', 'foreign', 'principal'] as const;
type Shadow = (typeof SHADOWS)[number];
/** `principal` is a real Entra object-id shape, the only kind 2c can confirm. */
const discoveredIdOf = (s: Shadow) =>
    s === 'principal' ? 'entra:sp:3f2504e0-4f89-41d3-9a0c-0305e82c3301' : `entra:sp:intake-${s}`;

interface Seeded {
    users: Record<Person, string>;
    scannerAgentId: string;
    targetAgentId: string;
    scanner: FakeScanner;
    shadowFinding: Record<Shadow, string>;
    discovered: Record<Shadow, string>;
}
const seeded: Record<string, Seeded> = {};
let scanSeq = 0;

const emailOf = (tenantId: string, who: Person) => `${who}@${tenantId}.test`;
const ctxFor = (tenantId: string, who: Person = 'owner'): RequestContext =>
    makeRequestContext(Role.OWNER, { tenantId, tenantSlug: tenantId, userId: seeded[tenantId].users[who] });

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: ALL_TENANTS } };
    await prisma.agentServicePrincipalConfirmation.deleteMany({ where: t });
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

/**
 * The fake scanner's valid body for T1, every shadow in it with no claimed id
 * unless `claims` names one. `incomplete` reports the mcp source cut short.
 */
function bodyFor(claims: Partial<Record<Shadow, string>> = {}, opts: { incomplete?: boolean } = {}): HarnessReportBody {
    const s = seeded[T1];
    const body = validReportBody();
    body.scan.id = `scan_${T1}_${++scanSeq}`;
    body.scan.scanner.agentId = s.scannerAgentId;
    body.agents[0].registeredAgentId = s.targetAgentId;
    const template: HarnessReportAgent = body.agents[1];
    body.agents = [
        body.agents[0],
        ...SHADOWS.map((sh) => ({
            ...template,
            discoveredId: discoveredIdOf(sh),
            registeredAgentId: claims[sh] ?? null,
        })),
    ];
    body.findings = [];
    if (opts.incomplete) {
        body.population.sources = body.population.sources.map((src) =>
            src.kind === 'mcp' ? { kind: 'mcp', status: 'INCOMPLETE', reason: 'BYTE_CAP', rows: 1 } : src,
        );
    }
    return body;
}

const scan = (claims: Partial<Record<Shadow, string>> = {}, opts: { incomplete?: boolean } = {}) =>
    ingestHarnessReport(ctxFor(T1), seeded[T1].scanner.serialise(bodyFor(claims, opts)));

async function seedPeople(tenantId: string): Promise<void> {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
    const users = {} as Record<Person, string>;
    for (const who of PEOPLE) {
        const email = emailOf(tenantId, who);
        const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        users[who] = user.id;
        await prisma.tenantMembership.create({
            data: { tenantId, userId: user.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
        });
    }
    seeded[tenantId] = { users } as Seeded;
}

async function registerFirstParty(tenantId: string, name: string) {
    const s = seeded[tenantId];
    return createRegisteredAgent(ctxFor(tenantId), {
        aiSystemId: (await prisma.aiSystem.create({ data: { tenantId, name: `Host of ${name}`, ownerUserId: s.users.owner } })).id,
        name,
        autonomyLevel: 2,
        dataAccessScope: 'READ_TENANT_DATA',
        reversibility: 'COMPENSABLE',
        provenance: 'FIRST_PARTY',
        ownerUserId: s.users.owner,
    });
}

async function seedT1(): Promise<void> {
    await seedPeople(T1);
    const s = seeded[T1];
    const scannerAgent = await registerFirstParty(T1, 'Harness scanner');
    const targetAgent = await registerFirstParty(T1, 'Reporting agent');
    const scanner = createFakeScanner();
    await addHarnessScannerKey(ctxFor(T1), { agentId: scannerAgent.id, publicKey: scanner.publicKeyHex });
    Object.assign(s, { scannerAgentId: scannerAgent.id, targetAgentId: targetAgent.id, scanner });

    await scan();

    const findings = await prisma.finding.findMany({
        where: { tenantId: T1, sourceKind: 'AGENT_HARNESS' },
        select: { id: true, sourceRef: true },
    });
    const byRef = new Map(findings.map((f) => [f.sourceRef as string, f.id]));
    const discovered = await prisma.discoveredAgent.findMany({ where: { tenantId: T1 }, select: { id: true, discoveredId: true } });
    const daBy = new Map(discovered.map((d) => [d.discoveredId, d.id]));
    s.shadowFinding = Object.fromEntries(
        SHADOWS.map((sh) => [sh, byRef.get(`SHADOW_AGENT:${discoveredIdOf(sh)}`) as string]),
    ) as Record<Shadow, string>;
    s.discovered = Object.fromEntries(SHADOWS.map((sh) => [sh, daBy.get(discoveredIdOf(sh)) as string])) as Record<
        Shadow,
        string
    >;
}

/** The intake, as the Register dialog sends it. */
const intake = (s: Shadow, name = `Sales bot (${s})`) =>
    registerShadowAgent(ctxFor(T1), {
        findingId: seeded[T1].shadowFinding[s],
        ownerUserId: seeded[T1].users.other,
        confirmOwner: true,
        name,
        autonomyLevel: 3,
        dataAccessScope: 'WRITE_TENANT_DATA',
        reversibility: 'COMPENSABLE',
        provenance: 'FIRST_PARTY',
        deploymentRole: 'DEPLOYER',
    });

const da = (s: Shadow) => prisma.discoveredAgent.findUniqueOrThrow({ where: { id: seeded[T1].discovered[s] } });
const finding = (s: Shadow) => prisma.finding.findUniqueOrThrow({ where: { id: seeded[T1].shadowFinding[s] } });
const shadowRowOf = async (s: Shadow) =>
    (await getHarnessMatrix(ctxFor(T1))).shadow.rows.find((r) => r.discoveredId === discoveredIdOf(s));

beforeAll(async () => {
    await clearOwnRows();
    await seedT1();
    await seedPeople(T2);
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('the seeded scan', () => {
    it('raised an open SHADOW_AGENT finding and an unlinked discovered agent for every shadow', async () => {
        for (const s of SHADOWS) {
            expect((await finding(s)).status).toBe('OPEN');
            expect((await da(s)).registeredAgentId).toBeNull();
        }
    });

    it('the shadow list carries each row\'s finding id and no intake row yet', async () => {
        const row = await shadowRowOf('link');
        expect(row).toMatchObject({
            discoveredAgentId: seeded[T1].discovered.link,
            findingId: seeded[T1].shadowFinding.link,
            intake: null,
        });
    });
});

describe('scan → intake → scan with no claimed id → linked and closed', () => {
    it('after the intake, the shadow row names the intake row and offers no second registration', async () => {
        const registered = await intake('link');
        const row = await shadowRowOf('link');
        expect(row).toMatchObject({
            findingId: seeded[T1].shadowFinding.link,
            intake: { agentId: registered.agentId, name: 'Sales bot (link)', linkable: true },
        });
        // Still SHADOW until a scan: the intake writes no discovered agent.
        expect((await da('link')).registeredAgentId).toBeNull();
        expect((await finding('link')).status).toBe('OPEN');
    });

    it('a complete scan with no claimed id links the intake\'s register row and closes the SHADOW_AGENT finding', async () => {
        const agent = await prisma.registeredAgent.findFirstOrThrow({
            where: { tenantId: T1, intakeDiscoveredAgentId: seeded[T1].discovered.link },
        });
        const result = await scan();
        expect(result.complete).toBe(true);

        expect((await da('link')).registeredAgentId).toBe(agent.id);
        const closed = await finding('link');
        expect(closed.status).toBe('CLOSED');
        expect(closed.verifiedAt).not.toBeNull();
        // The resolution is audited against THIS scan.
        const resolution = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: T1, entityId: closed.id, action: 'STATUS_CHANGE' },
            orderBy: { createdAt: 'desc' },
            select: { detailsJson: true },
        });
        expect((resolution.detailsJson as { after: unknown }).after).toMatchObject({ status: 'CLOSED', scanRef: result.scanRef });
        // Off the shadow list, and the further intake is refused as a linked agent.
        expect(await shadowRowOf('link')).toBeUndefined();
        await expect(intake('link')).rejects.toMatchObject({ details: { reason: 'ALREADY_REGISTERED' } });

        // A later scan that still claims nothing keeps the link and the closure.
        await scan();
        expect((await da('link')).registeredAgentId).toBe(agent.id);
        expect((await finding('link')).status).toBe('CLOSED');
    });
});

describe('a report naming a different register row is not overridden by the intake link', () => {
    it('the report\'s row is linked, and the intake row\'s history records the conflict', async () => {
        const registered = await intake('conflict');
        const result = await scan({ conflict: seeded[T1].targetAgentId });

        expect((await da('conflict')).registeredAgentId).toBe(seeded[T1].targetAgentId);
        expect((await finding('conflict')).status).toBe('CLOSED');

        const rows = await prisma.auditLog.findMany({
            where: { tenantId: T1, action: 'AGENT_INTAKE_LINK_CONFLICT' },
            select: { entity: true, entityId: true, detailsJson: true },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ entity: 'RegisteredAgent', entityId: registered.agentId });
        expect((rows[0].detailsJson as { after: unknown }).after).toEqual({
            discoveredId: discoveredIdOf('conflict'),
            reportedRegisteredAgentId: seeded[T1].targetAgentId,
            intakeRegisteredAgentId: registered.agentId,
            scanRef: result.scanRef,
        });
    });
});

describe('a retired intake row is never linked', () => {
    it('a complete scan with no claimed id leaves the agent SHADOW and its finding open', async () => {
        const registered = await intake('retired');
        await retireRegisteredAgent(ctxFor(T1), registered.agentId);

        await scan();
        expect((await da('retired')).registeredAgentId).toBeNull();
        expect((await finding('retired')).status).toBe('OPEN');

        // The shadow row says what became of the intake, and offers no second one.
        const row = await shadowRowOf('retired');
        expect(row?.intake).toEqual({ agentId: registered.agentId, name: 'Sales bot (retired)', linkable: false });
        await expect(intake('retired')).rejects.toMatchObject({ details: { reason: 'ALREADY_REGISTERED_BY_INTAKE' } });
    });
});

describe('an incomplete scan links the agent but does not close its finding', () => {
    it('the finding stays open on the incomplete scan and closes on the next complete one', async () => {
        const registered = await intake('incomplete');

        const partial = await scan({}, { incomplete: true });
        expect(partial.complete).toBe(false);
        expect((await da('incomplete')).registeredAgentId).toBe(registered.agentId);
        expect((await finding('incomplete')).status).toBe('OPEN');

        await scan();
        expect((await da('incomplete')).registeredAgentId).toBe(registered.agentId);
        expect((await finding('incomplete')).status).toBe('CLOSED');
    });
});

describe('two tenants', () => {
    it('an intake row of tenant B naming tenant A\'s discovered agent links nothing in tenant A', async () => {
        // Hand-written, because the intake itself resolves the discovered agent
        // under RLS and could never name another tenant's: the claim column has
        // no FK, so the ingest's own tenant filter is what must hold.
        const foreign = await registerFirstParty(T2, 'Tenant B agent');
        await prisma.registeredAgent.update({
            where: { id: foreign.id },
            data: { intakeDiscoveredAgentId: seeded[T1].discovered.foreign },
        });

        await scan();
        expect((await da('foreign')).registeredAgentId).toBeNull();
        expect((await finding('foreign')).status).toBe('OPEN');
        // …and tenant A's shadow list does not see tenant B's row.
        const row = await shadowRowOf('foreign');
        expect(row).toMatchObject({ findingId: seeded[T1].shadowFinding.foreign, intake: null });
    });
});

describe('2c\'s service-principal confirmation coexists with the intake link (#3721)', () => {
    it('the intake writes no confirmation; a person confirms the intake-made link; a scan that drops it invalidates the confirmation', async () => {
        const registered = await intake('principal');
        const daId = seeded[T1].discovered.principal;
        await scan();
        expect((await da('principal')).registeredAgentId).toBe(registered.agentId);

        // The intake is not the confirmation (owner decision, 2026-10-18).
        expect(await prisma.agentServicePrincipalConfirmation.count({ where: { tenantId: T1, discoveredAgentId: daId } })).toBe(0);

        // 2c's confirm reads the link the ingest wrote, so it can confirm it.
        const confirmed = await confirmServicePrincipalLink(ctxFor(T1), registered.agentId, { discoveredAgentId: daId });
        expect(confirmed.created).toBe(true);

        // A scan that keeps the intake link moves nothing, so invalidates nothing.
        await scan();
        const kept = await prisma.agentServicePrincipalConfirmation.findUniqueOrThrow({ where: { id: confirmed.confirmationId } });
        expect(kept.invalidatedAt).toBeNull();

        // Retiring the intake row drops the link at the next scan, and the same
        // ingest transaction invalidates the confirmation.
        await retireRegisteredAgent(ctxFor(T1), registered.agentId);
        await scan();
        expect((await da('principal')).registeredAgentId).toBeNull();
        const dropped = await prisma.agentServicePrincipalConfirmation.findUniqueOrThrow({ where: { id: confirmed.confirmationId } });
        expect(dropped.invalidatedAt).not.toBeNull();
        expect(dropped.invalidatedReason).toBe('PRINCIPAL_RELINKED');
    });
});
