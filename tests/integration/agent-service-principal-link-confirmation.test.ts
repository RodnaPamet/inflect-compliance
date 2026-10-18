/**
 * #3671 — a person confirms an agent's Entra service-principal link, on real
 * rows (owner decision, 2026-10-18).
 *
 *   1. CONFIRM CONFIRMS THE SCANNER'S LINK; IT DOES NOT MAKE ONE. A link the
 *      harness does not hold, an agent with two principals, and a discovered
 *      agent that is not an Entra principal are all refused; a repeat is
 *      idempotent; the act is audited.
 *   2. ONLY THE REGISTER KEY CONFIRMS. A READER is refused; AI_ADMIN, which
 *      holds the key on READER's coarse tier, is admitted.
 *   3. ONE-WAY AT THE DATABASE. A confirmation is never re-pointed or
 *      rewritten, an invalidation is never undone, and `app_user` cannot
 *      DELETE one — whatever the application does.
 *   4. A RE-LINK INVALIDATES IT, through the REAL harness ingest: the principal
 *      re-linked to another agent (PRINCIPAL_RELINKED), the agent re-linked to
 *      another principal (AGENT_RELINKED). A scan that moves the link BACK does
 *      not revive it.
 *   5. TWO TENANTS. One tenant cannot confirm, or see, another's.
 */
import { MembershipStatus, PrismaClient, Role } from '@prisma/client';
import { randomUUID } from 'crypto';

import { prismaTestClient } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { createFakeScanner, validReportBody, type FakeScanner } from '../helpers/agent-harness-fake-scanner';
import { createRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { ingestHarnessReport } from '@/app-layer/usecases/agent-harness-scans';
import { addHarnessScannerKey } from '@/app-layer/usecases/agent-harness-scanner-keys';
import {
    confirmServicePrincipalLink,
    getServicePrincipalLinkState,
    liveConfirmationFor,
    servicePrincipalLinkConfirmed,
} from '@/app-layer/usecases/agent-service-principal-confirmation';
import type { HarnessReportBody } from '@/lib/agentic/harness-contract';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const SUITE = randomUUID().slice(0, 8);
const T1 = `spconfirm-one-${SUITE}`;
const T2 = `spconfirm-two-${SUITE}`;
const TENANTS = [T1, T2];

interface Seeded {
    ownerUserId: string;
    scannerAgentId: string;
    agentA: string;
    agentB: string;
    scanner: FakeScanner;
}
const seeded: Record<string, Seeded> = {};
let scanSeq = 0;

const ctxFor = (tenantId: string, role: string = 'OWNER'): RequestContext =>
    makeRequestContext(role, { tenantId, tenantSlug: tenantId, userId: seeded[tenantId].ownerUserId });

const emailOf = (tenantId: string) => `owner@${tenantId}.test`;

async function seedTenant(tenantId: string): Promise<void> {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
    const user = await prisma.user.create({
        data: { email: emailOf(tenantId), emailHash: hashForLookup(emailOf(tenantId)) },
    });
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
    const scannerAgent = await agent(`Scanner ${tenantId}`);
    const a = await agent(`Agent A ${tenantId}`);
    const b = await agent(`Agent B ${tenantId}`);
    const scanner = createFakeScanner();
    await addHarnessScannerKey(ctxFor(tenantId), { agentId: scannerAgent.id, publicKey: scanner.publicKeyHex });
    Object.assign(seeded[tenantId], { scannerAgentId: scannerAgent.id, agentA: a.id, agentB: b.id, scanner });
}

/**
 * Ingest a scan reconciling each given principal to the given agent (or none).
 * Through the REAL ingest, signed by the tenant's registered scanner key.
 */
async function scan(tenantId: string, links: Array<{ sp: string; agentId: string | null }>) {
    const s = seeded[tenantId];
    const base = validReportBody();
    const template = base.agents[1];
    scanSeq += 1;
    const body: HarnessReportBody = {
        ...base,
        scan: { ...base.scan, id: `scan_${SUITE}_${scanSeq}`, scanner: { ...base.scan.scanner, agentId: s.scannerAgentId } },
        agents: links.map((l) => ({
            ...template,
            discoveredId: `entra:sp:${l.sp}`,
            registeredAgentId: l.agentId,
        })),
        findings: [],
    };
    return ingestHarnessReport(ctxFor(tenantId), s.scanner.serialise(body));
}

let agentSeq = 0;
/** A fresh registered agent, so each re-link test starts from one link. */
async function freshAgent(tenantId: string, label: string): Promise<string> {
    agentSeq += 1;
    const name = `${label} ${SUITE} ${agentSeq}`;
    const agent = await createRegisteredAgent(ctxFor(tenantId), {
        aiSystemId: (
            await prisma.aiSystem.create({
                data: { tenantId, name: `Host of ${name}`, ownerUserId: seeded[tenantId].ownerUserId },
            })
        ).id,
        name,
        autonomyLevel: 2,
        dataAccessScope: 'READ_TENANT_DATA',
        reversibility: 'COMPENSABLE',
        provenance: 'FIRST_PARTY',
        ownerUserId: seeded[tenantId].ownerUserId,
    });
    return agent.id;
}

const discoveredOf = async (tenantId: string, sp: string) =>
    prisma.discoveredAgent.findFirstOrThrow({
        where: { tenantId, discoveredId: `entra:sp:${sp}` },
        select: { id: true, discoveredId: true },
    });

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: TENANTS } };
    await prisma.agentServicePrincipalConfirmation.deleteMany({ where: t });
    await prisma.agentHarnessAcceptance.deleteMany({ where: t });
    await prisma.agentHarnessScanItem.deleteMany({ where: t });
    await prisma.agentHarnessScan.deleteMany({ where: t });
    await prisma.discoveredAgent.deleteMany({ where: t });
    await prisma.agentHarnessScannerKey.deleteMany({ where: t });
    await prisma.finding.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, TENANTS);
    });
    await prisma.user.deleteMany({ where: { emailHash: { in: TENANTS.map((t2) => hashForLookup(emailOf(t2))) } } });
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
}

async function asTenant<T>(tenantId: string | null, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        if (tenantId) await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
        return fn(tx as unknown as PrismaClient);
    });
}

beforeAll(async () => {
    for (const t of TENANTS) await seedTenant(t);
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

// ═════════════════════════════════════════════════════════════════════
// 1. CONFIRM CONFIRMS THE SCANNER'S LINK
// ═════════════════════════════════════════════════════════════════════

describe('a confirmation confirms the scanner\'s link and does not make one', () => {
    const sp = randomUUID();

    it('confirms the one principal the harness links to the agent, idempotently, and audits it', async () => {
        await scan(T1, [{ sp, agentId: seeded[T1].agentA }]);
        const d = await discoveredOf(T1, sp);
        const first = await confirmServicePrincipalLink(ctxFor(T1), seeded[T1].agentA, { discoveredAgentId: d.id });
        expect(first).toMatchObject({ created: true, agentId: seeded[T1].agentA, servicePrincipalId: sp });
        const again = await confirmServicePrincipalLink(ctxFor(T1), seeded[T1].agentA, { discoveredAgentId: d.id });
        expect(again).toMatchObject({ created: false, confirmationId: first.confirmationId });

        const row = await prisma.agentServicePrincipalConfirmation.findUniqueOrThrow({
            where: { id: first.confirmationId },
        });
        expect(row).toMatchObject({
            tenantId: T1,
            discoveredAgentId: d.id,
            registeredAgentId: seeded[T1].agentA,
            discoveredId: `entra:sp:${sp}`,
            confirmedByUserId: seeded[T1].ownerUserId,
            invalidatedAt: null,
        });
        const audit = await prisma.auditLog.count({
            where: { tenantId: T1, action: 'AGENT_SERVICE_PRINCIPAL_LINK_CONFIRMED', entityId: seeded[T1].agentA },
        });
        expect(audit).toBe(1);

        expect(await servicePrincipalLinkConfirmed(ctxFor(T1), sp)).toBe(true);
        const state = await getServicePrincipalLinkState(ctxFor(T1), seeded[T1].agentA);
        expect(state.confirmable).toBe(true);
        expect(state.links[0].confirmation?.id).toBe(first.confirmationId);
    });

    it('refuses a principal the harness links to a DIFFERENT agent', async () => {
        const d = await discoveredOf(T1, sp);
        await expect(
            confirmServicePrincipalLink(ctxFor(T1), seeded[T1].agentB, { discoveredAgentId: d.id }),
        ).rejects.toThrow(/does not currently link that principal to this agent/);
    });

    it('refuses a discovered agent that is not an Entra service principal', async () => {
        const other = await prisma.discoveredAgent.create({
            data: {
                tenantId: T1,
                discoveredId: `mcp:server-${SUITE}`,
                discoveredVia: ['mcp'],
                registeredAgentId: seeded[T1].agentB,
                firstSeenAt: new Date(),
                lastSeenAt: new Date(),
                lastScanId: 'scan-x',
                lastLevel: 'H1',
                lastReach: 'READ_ONLY',
            },
        });
        await expect(
            confirmServicePrincipalLink(ctxFor(T1), seeded[T1].agentB, { discoveredAgentId: other.id }),
        ).rejects.toThrow(/Only an Entra service principal/);
        await prisma.discoveredAgent.delete({ where: { id: other.id } });
    });

    it('refuses an unknown agent or discovered agent as not found, and a malformed body', async () => {
        const d = await discoveredOf(T1, sp);
        await expect(
            confirmServicePrincipalLink(ctxFor(T1), 'no-such-agent', { discoveredAgentId: d.id }),
        ).rejects.toThrow(/Registered agent not found/);
        await expect(
            confirmServicePrincipalLink(ctxFor(T1), seeded[T1].agentA, { discoveredAgentId: 'nope' }),
        ).rejects.toThrow(/Discovered agent not found/);
        await expect(
            confirmServicePrincipalLink(ctxFor(T1), seeded[T1].agentA, { discoveredAgentId: d.id, extra: 1 }),
        ).rejects.toThrow(/Invalid confirmation/);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. ONLY THE REGISTER KEY
// ═════════════════════════════════════════════════════════════════════

describe('only a holder of admin.agent_registry confirms', () => {
    it('refuses a READER, and admits AI_ADMIN on its key', async () => {
        const sp = randomUUID();
        await scan(T1, [{ sp, agentId: seeded[T1].agentB }]);
        const d = await discoveredOf(T1, sp);
        await expect(
            confirmServicePrincipalLink(ctxFor(T1, 'READER'), seeded[T1].agentB, { discoveredAgentId: d.id }),
        ).rejects.toThrow(/permission/);
        const ok = await confirmServicePrincipalLink(ctxFor(T1, 'AI_ADMIN'), seeded[T1].agentB, {
            discoveredAgentId: d.id,
        });
        expect(ok.created).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. ONE-WAY AT THE DATABASE
// ═════════════════════════════════════════════════════════════════════

describe('the confirmation is one-way at the database', () => {
    let id = '';
    beforeAll(async () => {
        const row = await prisma.agentServicePrincipalConfirmation.findFirstOrThrow({
            where: { tenantId: T1, registeredAgentId: seeded[T1].agentB, invalidatedAt: null },
            select: { id: true },
        });
        id = row.id;
    });

    it.each([
        ['re-pointed at another agent', { registeredAgentId: 'x' }],
        ['re-pointed at another principal', { discoveredId: 'entra:sp:11111111-2222-4333-8444-555555555555' }],
        ['re-attributed', { confirmedByUserId: 'someone-else' }],
        ['re-dated', { confirmedAt: new Date('2020-01-01T00:00:00.000Z') }],
    ])('refuses being %s', async (_label, data) => {
        await expect(
            prisma.agentServicePrincipalConfirmation.update({ where: { id }, data }),
        ).rejects.toThrow(/AGENT_SP_CONFIRMATION_ONE_WAY/);
    });

    it('refuses an unknown invalidation reason, and an invalidation without one', async () => {
        await expect(
            prisma.agentServicePrincipalConfirmation.update({
                where: { id },
                data: { invalidatedAt: new Date(), invalidatedReason: 'BECAUSE' },
            }),
        ).rejects.toThrow(/invalidation_shape/);
        await expect(
            prisma.agentServicePrincipalConfirmation.update({ where: { id }, data: { invalidatedAt: new Date() } }),
        ).rejects.toThrow(/invalidation_shape/);
    });

    it('allows exactly one invalidation, and never its undoing', async () => {
        await prisma.agentServicePrincipalConfirmation.update({
            where: { id },
            data: { invalidatedAt: new Date(), invalidatedReason: 'AGENT_RELINKED' },
        });
        await expect(
            prisma.agentServicePrincipalConfirmation.update({
                where: { id },
                data: { invalidatedAt: null, invalidatedReason: null },
            }),
        ).rejects.toThrow(/AGENT_SP_CONFIRMATION_ONE_WAY/);
    });

    it('app_user holds no DELETE on the table', async () => {
        const [row] = await prisma.$queryRawUnsafe<{ ok: boolean }[]>(
            `SELECT has_table_privilege('app_user', '"AgentServicePrincipalConfirmation"', 'DELETE') AS ok`,
        );
        expect(row.ok).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 4. A RE-LINK INVALIDATES IT — THROUGH THE REAL INGEST
// ═════════════════════════════════════════════════════════════════════

describe('a scan that moves the link invalidates the confirmation, and never re-points it', () => {
    it('PRINCIPAL_RELINKED: the principal reconciled to another agent; moving it back does not revive it', async () => {
        const sp = randomUUID();
        const x = await freshAgent(T1, 'X');
        const y = await freshAgent(T1, 'Y');
        await scan(T1, [{ sp, agentId: x }]);
        const d = await discoveredOf(T1, sp);
        const c = await confirmServicePrincipalLink(ctxFor(T1), x, { discoveredAgentId: d.id });
        const triple = { agentId: x, discoveredAgentId: d.id, discoveredId: d.discoveredId };
        expect(await liveConfirmationFor(ctxFor(T1), triple)).not.toBeNull();

        await scan(T1, [{ sp, agentId: y }]);
        const after = await prisma.agentServicePrincipalConfirmation.findUniqueOrThrow({ where: { id: c.confirmationId } });
        expect(after.invalidatedReason).toBe('PRINCIPAL_RELINKED');
        expect(after.invalidatedAt).toBeInstanceOf(Date);
        // Never re-pointed: the row still names agent X.
        expect(after.registeredAgentId).toBe(x);
        expect(await servicePrincipalLinkConfirmed(ctxFor(T1), sp)).toBe(false);

        // Back to X: the old confirmation stays dead; a person must confirm again.
        await scan(T1, [{ sp, agentId: x }]);
        expect(await liveConfirmationFor(ctxFor(T1), triple)).toBeNull();
        expect(await servicePrincipalLinkConfirmed(ctxFor(T1), sp)).toBe(false);
        const again = await confirmServicePrincipalLink(ctxFor(T1), x, { discoveredAgentId: d.id });
        expect(again.created).toBe(true);
        expect(await servicePrincipalLinkConfirmed(ctxFor(T1), sp)).toBe(true);

        const invalidations = await prisma.auditLog.count({
            where: { tenantId: T1, action: 'AGENT_SERVICE_PRINCIPAL_LINK_INVALIDATED' },
        });
        expect(invalidations).toBeGreaterThanOrEqual(1);
    });

    it('PRINCIPAL_RELINKED: the principal reconciled to NO agent (a shadow)', async () => {
        const sp = randomUUID();
        const x = await freshAgent(T1, 'shadowed');
        await scan(T1, [{ sp, agentId: x }]);
        const d = await discoveredOf(T1, sp);
        const c = await confirmServicePrincipalLink(ctxFor(T1), x, { discoveredAgentId: d.id });
        await scan(T1, [{ sp, agentId: null }]);
        const after = await prisma.agentServicePrincipalConfirmation.findUniqueOrThrow({
            where: { id: c.confirmationId },
        });
        expect(after.invalidatedReason).toBe('PRINCIPAL_RELINKED');
    });

    it('AGENT_RELINKED: the agent reconciled to a second principal', async () => {
        const first = randomUUID();
        const second = randomUUID();
        const agent = await freshAgent(T1, 'two-principals');
        await scan(T1, [{ sp: first, agentId: agent }]);
        const d = await discoveredOf(T1, first);
        const c = await confirmServicePrincipalLink(ctxFor(T1), agent, { discoveredAgentId: d.id });

        await scan(T1, [
            { sp: first, agentId: agent },
            { sp: second, agentId: agent },
        ]);
        const after = await prisma.agentServicePrincipalConfirmation.findUniqueOrThrow({ where: { id: c.confirmationId } });
        expect(after.invalidatedReason).toBe('AGENT_RELINKED');
        expect(await servicePrincipalLinkConfirmed(ctxFor(T1), first)).toBe(false);
    });

    it('a scan that leaves the link as it is invalidates nothing', async () => {
        const sp = randomUUID();
        const agent = await freshAgent(T1, 'steady');
        await scan(T1, [{ sp, agentId: agent }]);
        const d = await discoveredOf(T1, sp);
        const c = await confirmServicePrincipalLink(ctxFor(T1), agent, { discoveredAgentId: d.id });
        await scan(T1, [{ sp, agentId: agent }]);
        const after = await prisma.agentServicePrincipalConfirmation.findUniqueOrThrow({ where: { id: c.confirmationId } });
        expect(after.invalidatedAt).toBeNull();
        expect(await servicePrincipalLinkConfirmed(ctxFor(T1), sp)).toBe(true);
    });
});

// ═════════════════════════════════════════════════════════════════════
// 5. TWO TENANTS
// ═════════════════════════════════════════════════════════════════════

describe('two tenants', () => {
    it('one tenant cannot confirm another\'s link, nor see its confirmations under app_user', async () => {
        const sp = randomUUID();
        await scan(T2, [{ sp, agentId: seeded[T2].agentA }]);
        const d = await discoveredOf(T2, sp);
        // T1 naming T2's agent and principal finds neither.
        await expect(
            confirmServicePrincipalLink(ctxFor(T1), seeded[T2].agentA, { discoveredAgentId: d.id }),
        ).rejects.toThrow(/not found/);
        await confirmServicePrincipalLink(ctxFor(T2), seeded[T2].agentA, { discoveredAgentId: d.id });

        const seenByT1 = await asTenant(T1, (tx) =>
            tx.agentServicePrincipalConfirmation.count({ where: { tenantId: T2 } }),
        );
        const seenByT2 = await asTenant(T2, (tx) =>
            tx.agentServicePrincipalConfirmation.count({ where: { tenantId: T2 } }),
        );
        const seenUnbound = await asTenant(null, (tx) => tx.agentServicePrincipalConfirmation.count());
        expect(seenByT1).toBe(0);
        expect(seenByT2).toBe(1);
        expect(seenUnbound).toBe(0);
        // And T1's confirmation question about T2's principal is "no".
        expect(await servicePrincipalLinkConfirmed(ctxFor(T1), sp)).toBe(false);
        expect(await servicePrincipalLinkConfirmed(ctxFor(T2), sp)).toBe(true);
    });

    it('an app_user INSERT naming another tenant is refused by RLS', async () => {
        const d = await prisma.discoveredAgent.findFirstOrThrow({ where: { tenantId: T2 }, select: { id: true, discoveredId: true } });
        await expect(
            asTenant(T1, (tx) =>
                tx.agentServicePrincipalConfirmation.create({
                    data: {
                        tenantId: T2,
                        discoveredAgentId: d.id,
                        registeredAgentId: seeded[T2].agentA,
                        discoveredId: d.discoveredId,
                        confirmedByUserId: 'x',
                    },
                }),
            ),
        ).rejects.toThrow();
    });
});
