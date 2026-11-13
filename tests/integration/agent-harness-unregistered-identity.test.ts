/**
 * An unregistered automated identity, against a real database (owner decisions,
 * 2026-11-13).
 *
 * A principal no register row is linked to, and that shows no sign of running a
 * model, is not a shadow agent. This file drives the rule end to end through
 * the real ingest and the readers of the record:
 *
 *   1. THE INGEST. One MEDIUM `UNREGISTERED_IDENTITY` finding, no SHADOW_AGENT
 *      and no HARNESS_SHORTFALL; the principal keeps its row and its level.
 *   2. AN INCOMPLETE SCAN CLOSES NOTHING, AND NOTHING FLAPS. A sign makes it a
 *      shadow agent on any scan; a missing sign takes that back only on a
 *      complete one. The class on record is the open finding, so the ingest's
 *      own writes are what the next scan reads.
 *   3. THE MATRIX. A section of its own, off the shadow list, held to no bar.
 *   4. THE ACCEPTANCE. It has no shortfall to accept.
 *   5. THE INTAKE. Its finding registers exactly as a shadow agent's does, and a
 *      complete scan that then sees it in the register closes the finding.
 *   6. ISOLATION. Another tenant's identity is on nobody else's list.
 */
import { MembershipStatus, PrismaClient, Role } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { createFakeScanner, validReportBody, type FakeScanner } from '../helpers/agent-harness-fake-scanner';
import { createRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { ingestHarnessReport } from '@/app-layer/usecases/agent-harness-scans';
import { addHarnessScannerKey } from '@/app-layer/usecases/agent-harness-scanner-keys';
import { acceptHarnessShortfall } from '@/app-layer/usecases/agent-harness-acceptance';
import { getHarnessMatrix } from '@/app-layer/usecases/agent-harness-matrix';
import { registerShadowAgent } from '@/app-layer/usecases/agent-registration-intake';
import { shadowRefOf, shortfallRefOf, unregisteredIdentityRefOf } from '@/lib/agentic/harness-findings';
import type { HarnessReportBody } from '@/lib/agentic/harness-contract';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const T1 = 'harness-identity-one';
const T2 = 'harness-identity-two';
const ALL_TENANTS = [T1, T2];

/** A service principal nothing names; by default it lists no tool and no model. */
const IDENTITY = 'entra:sp:build-identity';
/** The same shape, taken through the intake in section 5. */
const REGISTERED_LATER = 'entra:sp:build-registered-later';
const SHADOW = 'entra:sp:shadow-1';

interface Seeded {
    ownerUserId: string;
    scannerAgentId: string;
    targetAgentId: string;
    scanner: FakeScanner;
}
const seeded: Record<string, Seeded> = {};
let scanSeq = 0;

const ctxFor = (tenantId: string): RequestContext =>
    makeRequestContext('OWNER', { tenantId, tenantSlug: tenantId, userId: seeded[tenantId].ownerUserId });

const emailOf = (tenantId: string) => `owner@${tenantId}.test`;

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
    await prisma.user.deleteMany({ where: { emailHash: { in: ALL_TENANTS.map((t) => hashForLookup(emailOf(t))) } } });
    await prisma.tenant.deleteMany({ where: { id: { in: ALL_TENANTS } } });
}

async function seedTenant(tenantId: string): Promise<void> {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
    const email = emailOf(tenantId);
    const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await prisma.tenantMembership.create({
        data: { tenantId, userId: user.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
    seeded[tenantId] = { ownerUserId: user.id } as Seeded;

    const agent = async (name: string) =>
        createRegisteredAgent(ctxFor(tenantId), {
            aiSystemId: (await prisma.aiSystem.create({ data: { tenantId, name: `Host of ${name}`, ownerUserId: user.id } })).id,
            name,
            autonomyLevel: 2,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'COMPENSABLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: user.id,
        });
    const scannerAgent = await agent(`Harness scanner ${tenantId}`);
    const targetAgent = await agent(`Reporting agent ${tenantId}`);
    const scanner = createFakeScanner();
    await addHarnessScannerKey(ctxFor(tenantId), { agentId: scannerAgent.id, publicKey: scanner.publicKeyHex });
    Object.assign(seeded[tenantId], { scannerAgentId: scannerAgent.id, targetAgentId: targetAgent.id, scanner });
}

type ReportAgent = HarnessReportBody['agents'][number];
const TOOL: ReportAgent['tools'][number] = {
    server: 'https://mcp.internal.example/crm',
    name: 'list_accounts',
    manifestHash: null,
    pinned: true,
    readOnlyHint: true,
};

/** One principal no register row names: found by the directory source, no tool, no model. */
function principal(discoveredId: string, over: Partial<ReportAgent> = {}): ReportAgent {
    return {
        discoveredId,
        discoveredVia: ['entra-sp'],
        registeredAgentId: null,
        owner: null,
        credentials: [{ ref: 'kv://prod/build/deploy-key', ageDays: 400, expires: false, boundToAgent: true, grant: 'app-only' }],
        tools: [],
        skills: [],
        verdicts: [],
        ...over,
    } as ReportAgent;
}

/**
 * The fake scanner's valid body (its registered agent, and its shadow agent,
 * which lists a tool) plus `extra`. `incomplete` reports the mcp source cut
 * short, which makes the whole scan incomplete.
 */
function bodyFor(tenantId: string, extra: ReportAgent[], opts: { incomplete?: boolean } = {}): HarnessReportBody {
    const s = seeded[tenantId];
    const body = validReportBody();
    body.scan.id = `scan_${tenantId}_${++scanSeq}`;
    body.scan.scanner.agentId = s.scannerAgentId;
    body.agents[0].registeredAgentId = s.targetAgentId;
    body.agents = [...body.agents, ...extra] as typeof body.agents;
    body.findings = [];
    if (opts.incomplete) {
        body.population.sources = body.population.sources.map((src) =>
            src.kind === 'mcp' ? { kind: 'mcp', status: 'INCOMPLETE', reason: 'BYTE_CAP', rows: 1 } : src,
        );
    }
    return body;
}

const scan = (tenantId: string, extra: ReportAgent[], opts: { incomplete?: boolean } = {}) =>
    ingestHarnessReport(ctxFor(tenantId), seeded[tenantId].scanner.serialise(bodyFor(tenantId, extra, opts)));

/** The open harness findings that name one principal, by code. */
async function openCodesFor(tenantId: string, discoveredId: string): Promise<string[]> {
    const rows = await prisma.finding.findMany({
        where: {
            tenantId,
            sourceKind: 'AGENT_HARNESS',
            status: { not: 'CLOSED' },
            deletedAt: null,
            sourceRef: { in: [shadowRefOf(discoveredId), unregisteredIdentityRefOf(discoveredId), shortfallRefOf(discoveredId)] },
        },
        select: { sourceRef: true },
    });
    return rows.map((r) => (r.sourceRef as string).slice(0, (r.sourceRef as string).indexOf(':'))).sort();
}

const AGENT = ['HARNESS_SHORTFALL', 'SHADOW_AGENT'];
const ID = ['UNREGISTERED_IDENTITY'];

beforeAll(async () => {
    await clearOwnRows();
    for (const t of ALL_TENANTS) await seedTenant(t);
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('1. the ingest raises one MEDIUM finding, and none about the ladder', () => {
    it('a complete scan classes it an unregistered identity, and keeps its row and its level', async () => {
        const result = await scan(T1, [principal(IDENTITY)]);
        expect(result.complete).toBe(true);

        expect(await openCodesFor(T1, IDENTITY)).toEqual(ID);
        const finding = await prisma.finding.findFirstOrThrow({
            where: { tenantId: T1, sourceKind: 'AGENT_HARNESS', sourceRef: unregisteredIdentityRefOf(IDENTITY) },
            select: { severity: true, type: true, title: true, description: true, status: true },
        });
        expect(finding).toMatchObject({
            severity: 'MEDIUM',
            type: 'OBSERVATION',
            status: 'OPEN',
            title: `Unregistered automated identity ${IDENTITY}`,
        });
        expect(finding.description).toContain('The scan cannot show that it runs no model.');

        const row = await prisma.discoveredAgent.findFirstOrThrow({
            where: { tenantId: T1, discoveredId: IDENTITY },
            select: { registeredAgentId: true, lastLevel: true },
        });
        expect(row).toEqual({ registeredAgentId: null, lastLevel: 'H0' });

        // The fake scanner's shadow agent lists a tool, so it is unchanged: the
        // pair proves it is the missing sign that decides.
        expect(await openCodesFor(T1, SHADOW)).toEqual(AGENT);
    });

    it('the scan\'s audit row counts the identities and names none', async () => {
        const audit = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: T1, action: 'AGENT_HARNESS_SCAN_INGESTED' },
            orderBy: { createdAt: 'desc' },
            select: { detailsJson: true },
        });
        const after = (audit.detailsJson as { after: Record<string, unknown> }).after;
        expect(after.unregisteredIdentityCount).toBe(1);
        expect(JSON.stringify(audit.detailsJson)).not.toContain(IDENTITY);
    });
});

describe('2. an incomplete scan closes nothing, and the class does not flap', () => {
    it('an identity stays one through an incomplete scan', async () => {
        const result = await scan(T1, [principal(IDENTITY)], { incomplete: true });
        expect(result.complete).toBe(false);
        expect(await openCodesFor(T1, IDENTITY)).toEqual(ID);
    });

    it('a sign seen on an incomplete scan makes it a shadow agent, held to the bar, and closes the identity finding', async () => {
        await scan(T1, [principal(IDENTITY, { tools: [TOOL] })], { incomplete: true });
        expect(await openCodesFor(T1, IDENTITY)).toEqual(AGENT);
    });

    it('the sign going missing on incomplete scans closes neither the shadow finding nor the shortfall, twice over', async () => {
        for (let i = 0; i < 2; i++) {
            await scan(T1, [principal(IDENTITY)], { incomplete: true });
            expect(await openCodesFor(T1, IDENTITY)).toEqual(AGENT);
        }
    });

    it('only a complete scan with no sign takes it back, and the next incomplete one leaves it there', async () => {
        await scan(T1, [principal(IDENTITY)]);
        expect(await openCodesFor(T1, IDENTITY)).toEqual(ID);
        await scan(T1, [principal(IDENTITY)], { incomplete: true });
        expect(await openCodesFor(T1, IDENTITY)).toEqual(ID);
    });
});

describe('3. the matrix lists it in a section of its own, held to no bar', () => {
    it('it is on the identity list with its own finding, and off the shadow list', async () => {
        const view = await getHarnessMatrix(ctxFor(T1));
        const identity = view.unregisteredIdentities.rows.find((r) => r.discoveredId === IDENTITY);
        expect(identity).toMatchObject({ kind: 'UNREGISTERED_IDENTITY', reason: 'UNREGISTERED', lastLevel: 'H0', intake: null });
        const finding = await prisma.finding.findFirstOrThrow({
            where: { tenantId: T1, sourceKind: 'AGENT_HARNESS', sourceRef: unregisteredIdentityRefOf(IDENTITY) },
            select: { id: true },
        });
        expect(identity?.findingId).toBe(finding.id);
        expect(view.shadow.rows.map((r) => r.discoveredId)).not.toContain(IDENTITY);

        // The shadow agent is where it was, and on that list only.
        expect(view.shadow.rows.find((r) => r.discoveredId === SHADOW)).toMatchObject({ kind: 'SHADOW_AGENT' });
        expect(view.unregisteredIdentities.rows.map((r) => r.discoveredId)).not.toContain(SHADOW);
    });

    it('its matrix row keeps its level and is never below a bar, with no shortfall action or note', async () => {
        // The latest scan must be one that names it: a complete one.
        await scan(T1, [principal(IDENTITY)]);
        const view = await getHarnessMatrix(ctxFor(T1));
        const rows = view.sections.flatMap((s) => s.rows);
        expect(rows.find((r) => r.discoveredId === IDENTITY)).toMatchObject({
            registered: null,
            unregisteredIdentity: true,
            level: 'H0',
            belowBar: false,
            acceptAffordance: 'NONE',
        });
        expect(rows.find((r) => r.discoveredId === SHADOW)).toMatchObject({
            registered: null,
            unregisteredIdentity: false,
            belowBar: true,
            acceptAffordance: 'REGISTER_FIRST',
        });
        // Both lists rest on the same evidence.
        expect(view.unregisteredIdentities.basis).toBe(view.shadow.basis);
        expect(view.unregisteredIdentities.basisAsOf).toBe(view.shadow.basisAsOf);
    });
});

describe('4. it has no shortfall to accept', () => {
    it('the acceptance refuses it as an identity; a shadow agent is still told to register first', async () => {
        const input = {
            justification: 'The owner has reviewed this agent and carries the risk until the next quarter.',
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        };
        const idOf = async (discoveredId: string) =>
            (await prisma.discoveredAgent.findFirstOrThrow({ where: { tenantId: T1, discoveredId }, select: { id: true } })).id;
        await expect(acceptHarnessShortfall(ctxFor(T1), { ...input, discoveredAgentId: await idOf(IDENTITY) })).rejects.toThrow(
            /held to no harness bar/,
        );
        await expect(acceptHarnessShortfall(ctxFor(T1), { ...input, discoveredAgentId: await idOf(SHADOW) })).rejects.toThrow(
            /register it first/,
        );
        expect(await prisma.agentHarnessAcceptance.count({ where: { tenantId: T1 } })).toBe(0);
    });
});

describe('5. its finding registers exactly as a shadow agent\'s does', () => {
    it('the intake takes an UNREGISTERED_IDENTITY finding into the register as a DRAFT row, and writes no finding', async () => {
        await scan(T1, [principal(IDENTITY), principal(REGISTERED_LATER)]);
        const finding = await prisma.finding.findFirstOrThrow({
            where: { tenantId: T1, sourceKind: 'AGENT_HARNESS', sourceRef: unregisteredIdentityRefOf(REGISTERED_LATER) },
            select: { id: true },
        });
        const result = await registerShadowAgent(ctxFor(T1), {
            findingId: finding.id,
            ownerUserId: seeded[T1].ownerUserId,
            confirmOwner: true,
            name: 'Build bot',
            autonomyLevel: 3,
            dataAccessScope: 'WRITE_TENANT_DATA',
            reversibility: 'COMPENSABLE',
            provenance: 'FIRST_PARTY',
        });
        expect(result).toMatchObject({ status: 'DRAFT', discoveredId: REGISTERED_LATER, findingId: finding.id });
        // The finding is still open: an observation closes it, not the act it asked for.
        expect(await openCodesFor(T1, REGISTERED_LATER)).toEqual(ID);

        const view = await getHarnessMatrix(ctxFor(T1));
        const row = view.unregisteredIdentities.rows.find((r) => r.discoveredId === REGISTERED_LATER);
        expect(row?.intake).toMatchObject({ agentId: result.agentId, linkable: true });
    });

    it('a finding of another kind is still refused', async () => {
        const unpinned = await prisma.finding.findFirstOrThrow({
            where: { tenantId: T1, sourceKind: 'AGENT_HARNESS', sourceRef: `UNPINNED_WRITE_TOOL:${SHADOW}` },
            select: { id: true },
        });
        await expect(
            registerShadowAgent(ctxFor(T1), {
                findingId: unpinned.id,
                ownerUserId: seeded[T1].ownerUserId,
                confirmOwner: true,
                name: 'Not registrable',
                autonomyLevel: 3,
                dataAccessScope: 'WRITE_TENANT_DATA',
                reversibility: 'COMPENSABLE',
                provenance: 'FIRST_PARTY',
            }),
        ).rejects.toMatchObject({ details: { reason: 'NOT_A_SHADOW_AGENT_FINDING' } });
    });

    it('an incomplete scan links it and leaves the finding; the next complete one closes it, and it is scored as an agent', async () => {
        await scan(T1, [principal(REGISTERED_LATER)], { incomplete: true });
        const linked = await prisma.discoveredAgent.findFirstOrThrow({
            where: { tenantId: T1, discoveredId: REGISTERED_LATER },
            select: { registeredAgentId: true },
        });
        expect(linked.registeredAgentId).not.toBeNull();
        // Held: not closed on an incomplete scan. It is scored as an agent from
        // the moment it is linked, so its shortfall is raised beside it.
        expect(await openCodesFor(T1, REGISTERED_LATER)).toEqual(['HARNESS_SHORTFALL', 'UNREGISTERED_IDENTITY']);

        await scan(T1, [principal(REGISTERED_LATER)]);
        expect(await openCodesFor(T1, REGISTERED_LATER)).toEqual(['HARNESS_SHORTFALL']);
        const view = await getHarnessMatrix(ctxFor(T1));
        expect(view.unregisteredIdentities.rows.map((r) => r.discoveredId)).not.toContain(REGISTERED_LATER);
        expect(view.shadow.rows.map((r) => r.discoveredId)).not.toContain(REGISTERED_LATER);
    });
});

describe('6. isolation', () => {
    it('one tenant\'s identity is on no list of another\'s, and raises no finding there', async () => {
        await scan(T2, []);
        const t2 = await getHarnessMatrix(ctxFor(T2));
        expect(t2.unregisteredIdentities.rows).toEqual([]);
        expect(JSON.stringify(t2)).not.toContain(IDENTITY);
        expect(await openCodesFor(T2, IDENTITY)).toEqual([]);
        // Positive anchor: T1 still holds it.
        const t1 = await getHarnessMatrix(ctxFor(T1));
        expect(t1.unregisteredIdentities.rows.map((r) => r.discoveredId)).toContain(IDENTITY);
    });
});
