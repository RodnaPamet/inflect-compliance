/**
 * The harness ingest against a real database (#3665).
 *
 *   1. A REFUSED REPORT WRITES NOTHING. Every malformation the contract names is
 *      driven through the usecase, and the five harness tables plus the
 *      findings register are counted afterwards.
 *   2. A VERIFIED REPORT MEANS WHAT THE PLANNER SAYS. The level on each row is
 *      the ladder's, the register link is the register's, and the findings are
 *      raised on the conditions they name — whatever the report claimed.
 *   3. THE SIGNER IS HELD TO ITS IDENTITY. A key verifies one scanner's reports,
 *      a revoked key verifies nothing, a replay is refused, and one tenant's key
 *      is not trusted by another.
 *   4. ISOLATION. All five tables under `app_user`, with each tenant bound and
 *      with none.
 *   5. AN ACCEPTANCE IS THE OWNER'S, AND IT LAPSES. It closes the shortfall,
 *      only the agent's owner may record it, and the expiry monitor reopens the
 *      shortfall exactly once.
 */
import { MembershipStatus, PrismaClient, Role } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import {
    createFakeScanner,
    malformedReport,
    MALFORMATIONS,
    validReportBody,
    type FakeScanner,
    type Malformation,
} from '../helpers/agent-harness-fake-scanner';
import { createRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { ingestHarnessReport, listHarnessScans } from '@/app-layer/usecases/agent-harness-scans';
import { addHarnessScannerKey, revokeHarnessScannerKey } from '@/app-layer/usecases/agent-harness-scanner-keys';
import {
    acceptHarnessShortfall,
    reopenExpiredHarnessAcceptances,
} from '@/app-layer/usecases/agent-harness-acceptance';
import type { HarnessReportBody } from '@/lib/agentic/harness-contract';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const T1 = 'harness-ingest-one';
const T2 = 'harness-ingest-two';
const ALL_TENANTS = [T1, T2];

interface Seeded {
    ownerUserId: string;
    otherOwnerUserId: string;
    scannerAgentId: string;
    targetAgentId: string;
    scanner: FakeScanner;
    keyId: string;
}
const seeded: Record<string, Seeded> = {};

const ctxFor = (tenantId: string, userId = seeded[tenantId].ownerUserId): RequestContext =>
    makeRequestContext('OWNER', { tenantId, tenantSlug: tenantId, userId });

const emails = (tenantId: string) => [`owner@${tenantId}.test`, `other-owner@${tenantId}.test`];

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: ALL_TENANTS } };
    await prisma.agentHarnessAcceptance.deleteMany({ where: t });
    await prisma.agentHarnessScanItem.deleteMany({ where: t });
    await prisma.agentHarnessScan.deleteMany({ where: t });
    await prisma.discoveredAgent.deleteMany({ where: t });
    await prisma.agentHarnessScannerKey.deleteMany({ where: t });
    await prisma.finding.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, ALL_TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, ALL_TENANTS);
    });
    await prisma.user.deleteMany({ where: { emailHash: { in: ALL_TENANTS.flatMap(emails).map(hashForLookup) } } });
    await prisma.tenant.deleteMany({ where: { id: { in: ALL_TENANTS } } });
}

async function member(tenantId: string, email: string): Promise<string> {
    const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await prisma.tenantMembership.create({
        data: { tenantId, userId: user.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
    return user.id;
}

async function seedTenant(tenantId: string): Promise<void> {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
    const [ownerEmail, otherEmail] = emails(tenantId);
    const ownerUserId = await member(tenantId, ownerEmail);
    const otherOwnerUserId = await member(tenantId, otherEmail);
    seeded[tenantId] = { ownerUserId, otherOwnerUserId } as Seeded;

    // One AI system per agent: the register holds at most one agent per system.
    const agent = async (name: string) =>
        createRegisteredAgent(ctxFor(tenantId), {
            aiSystemId: (await prisma.aiSystem.create({ data: { tenantId, name: `Host of ${name}`, ownerUserId } })).id,
            name,
            autonomyLevel: 2,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'COMPENSABLE',
            provenance: 'FIRST_PARTY',
            ownerUserId,
        });
    const scannerAgent = await agent(`Harness scanner ${tenantId}`);
    const targetAgent = await agent(`Reporting agent ${tenantId}`);
    const scanner = createFakeScanner();
    const key = await addHarnessScannerKey(ctxFor(tenantId), { agentId: scannerAgent.id, publicKey: scanner.publicKeyHex });
    Object.assign(seeded[tenantId], { scannerAgentId: scannerAgent.id, targetAgentId: targetAgent.id, scanner, keyId: key.id });
}

/** The fake scanner's valid body, pointed at this tenant's real register rows. */
function bodyFor(tenantId: string, scanId: string, edit?: (b: HarnessReportBody) => void): HarnessReportBody {
    const s = seeded[tenantId];
    const body = validReportBody();
    body.scan.id = scanId;
    body.scan.scanner.agentId = s.scannerAgentId;
    body.agents[0].registeredAgentId = s.targetAgentId;
    edit?.(body);
    return body;
}

const ingest = (tenantId: string, body: HarnessReportBody, scanner = seeded[tenantId].scanner) =>
    ingestHarnessReport(ctxFor(tenantId), scanner.serialise(body));

async function harnessRowCounts(tenantId: string) {
    const t = { tenantId };
    return {
        scans: await prisma.agentHarnessScan.count({ where: t }),
        items: await prisma.agentHarnessScanItem.count({ where: t }),
        agents: await prisma.discoveredAgent.count({ where: t }),
        acceptances: await prisma.agentHarnessAcceptance.count({ where: t }),
        findings: await prisma.finding.count({ where: { ...t, sourceKind: 'AGENT_HARNESS' } }),
    };
}

async function openRefs(tenantId: string): Promise<string[]> {
    const rows = await prisma.finding.findMany({
        where: { tenantId, sourceKind: 'AGENT_HARNESS', status: { not: 'CLOSED' }, deletedAt: null },
        select: { sourceRef: true },
    });
    return rows.map((r) => r.sourceRef as string).sort();
}

async function asTenant<T>(tenantId: string | null, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        if (tenantId) await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
        return fn(tx as unknown as PrismaClient);
    });
}

beforeAll(async () => {
    await clearOwnRows();
    for (const t of ALL_TENANTS) await seedTenant(t);
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('a refused report writes nothing', () => {
    it.each(Object.keys(MALFORMATIONS) as Malformation[])('%s', async (kind) => {
        const before = await harnessRowCounts(T1);
        const { raw, expected } = malformedReport(seeded[T1].scanner, kind);
        await expect(ingestHarnessReport(ctxFor(T1), raw)).rejects.toThrow(`harness_report_refused: ${expected}`);
        expect(await harnessRowCounts(T1)).toEqual(before);
    });

    it('a scanner that names another agent as itself is refused', async () => {
        const before = await harnessRowCounts(T1);
        const body = bodyFor(T1, 'scan_mismatch', (b) => {
            b.scan.scanner.agentId = seeded[T1].targetAgentId;
        });
        await expect(ingest(T1, body)).rejects.toThrow('harness_report_refused: SCANNER_MISMATCH');
        expect(await harnessRowCounts(T1)).toEqual(before);
    });

    it('a credential bound to another agent may not submit the scanner’s report', async () => {
        const ctx = { ...ctxFor(T1), agentId: seeded[T1].targetAgentId };
        await expect(ingestHarnessReport(ctx, seeded[T1].scanner.serialise(bodyFor(T1, 'scan_submitter')))).rejects.toThrow(
            'harness_report_refused: SUBMITTER_MISMATCH',
        );
    });

    it('a principal without agent_harness_ingest is refused before anything is read', async () => {
        const reader = makeRequestContext('READER', { tenantId: T1, tenantSlug: T1, userId: seeded[T1].ownerUserId });
        await expect(ingestHarnessReport(reader, seeded[T1].scanner.serialise(bodyFor(T1, 'scan_reader')))).rejects.toThrow();
        expect(await prisma.agentHarnessScan.count({ where: { tenantId: T1, scanRef: 'scan_reader' } })).toBe(0);
    });

    it('another tenant’s key is not trusted here', async () => {
        await expect(ingest(T1, bodyFor(T1, 'scan_foreign_key'), seeded[T2].scanner)).rejects.toThrow(
            'harness_report_refused: UNTRUSTED_SIGNER',
        );
    });
});

describe('a verified report means what the planner says', () => {
    it('derives levels, checks the register, and raises the named findings', async () => {
        const body = bodyFor(T1, 'scan_first', (b) => {
            // The report's own findings and claims are not what decides.
            b.findings = [];
        });
        const result = await ingest(T1, body);
        expect(result).toMatchObject({ scanRef: 'scan_first', complete: true, agentCount: 2, findingsOpened: 3 });

        const agents = await prisma.discoveredAgent.findMany({
            where: { tenantId: T1 },
            select: { discoveredId: true, registeredAgentId: true, lastLevel: true, lastReach: true },
            orderBy: { discoveredId: 'asc' },
        });
        expect(agents).toEqual([
            { discoveredId: 'entra:sp:registered-1', registeredAgentId: seeded[T1].targetAgentId, lastLevel: 'H2', lastReach: 'READ_ONLY' },
            { discoveredId: 'entra:sp:shadow-1', registeredAgentId: null, lastLevel: 'H0', lastReach: 'WRITE_OR_EXTERNAL' },
        ]);
        expect(await prisma.agentHarnessScanItem.count({ where: { tenantId: T1, scanId: result.scanId } })).toBe(2);
        expect(await openRefs(T1)).toEqual([
            'HARNESS_SHORTFALL:entra:sp:shadow-1',
            'SHADOW_AGENT:entra:sp:shadow-1',
            'UNPINNED_WRITE_TOOL:entra:sp:shadow-1',
        ]);
        const audit = await prisma.auditLog.count({
            where: { tenantId: T1, action: 'AGENT_HARNESS_SCAN_INGESTED', entityId: result.scanId },
        });
        expect(audit).toBe(1);
    });

    it('a replay of the same scan is refused', async () => {
        await expect(ingest(T1, bodyFor(T1, 'scan_first'))).rejects.toThrow('harness_report_refused: REPLAY');
    });

    it('a register id the register does not hold is SHADOW, whatever the report claims', async () => {
        await ingest(T1, bodyFor(T1, 'scan_bogus_link', (b) => {
            b.agents = [{ ...b.agents[0], discoveredId: 'entra:sp:claims-a-link', registeredAgentId: 'agt_not_in_register' }];
        }));
        const row = await prisma.discoveredAgent.findFirst({
            where: { tenantId: T1, discoveredId: 'entra:sp:claims-a-link' },
            select: { registeredAgentId: true },
        });
        expect(row?.registeredAgentId).toBeNull();
        expect(await openRefs(T1)).toContain('SHADOW_AGENT:entra:sp:claims-a-link');
    });

    it('closes a finding on positive evidence only, and absence closes nothing', async () => {
        // The shadow agent is fixed: registered, owned, its tool pinned.
        await ingest(T1, bodyFor(T1, 'scan_fixed', (b) => {
            const fixed = { ...b.agents[0], discoveredId: 'entra:sp:shadow-1' };
            b.agents = [fixed];
        }));
        const open = await openRefs(T1);
        expect(open).not.toContain('SHADOW_AGENT:entra:sp:shadow-1');
        expect(open).not.toContain('HARNESS_SHORTFALL:entra:sp:shadow-1');
        // claims-a-link was absent from that scan, so its finding stands.
        expect(open).toContain('SHADOW_AGENT:entra:sp:claims-a-link');
    });

    it('a scan with no agents is a finding, not a clean bill', async () => {
        await ingest(T1, bodyFor(T1, 'scan_empty', (b) => {
            b.agents = [];
            b.findings = [];
        }));
        expect(await openRefs(T1)).toContain(`EMPTY_SCAN:${seeded[T1].scannerAgentId}`);
        await ingest(T1, bodyFor(T1, 'scan_after_empty'));
        expect(await openRefs(T1)).not.toContain(`EMPTY_SCAN:${seeded[T1].scannerAgentId}`);
    });

    it('a revoked key verifies nothing from then on', async () => {
        const spare = createFakeScanner();
        const key = await addHarnessScannerKey(ctxFor(T1), { agentId: seeded[T1].scannerAgentId, publicKey: spare.publicKeyHex });
        await ingest(T1, bodyFor(T1, 'scan_spare_key'), spare);
        await revokeHarnessScannerKey(ctxFor(T1), { keyId: key.id });
        await expect(ingest(T1, bodyFor(T1, 'scan_after_revoke'), spare)).rejects.toThrow(
            'harness_report_refused: UNTRUSTED_SIGNER',
        );
    });
});

describe('isolation', () => {
    beforeAll(async () => {
        await ingest(T2, bodyFor(T2, 'scan_first'));
    });

    it('each tenant sees only its own rows in every harness table', async () => {
        for (const [own, other] of [[T1, T2], [T2, T1]]) {
            const seen = await asTenant(own, async (tx) => ({
                scans: await tx.agentHarnessScan.findMany({ select: { tenantId: true } }),
                items: await tx.agentHarnessScanItem.findMany({ select: { tenantId: true } }),
                agents: await tx.discoveredAgent.findMany({ select: { tenantId: true } }),
                keys: await tx.agentHarnessScannerKey.findMany({ select: { tenantId: true } }),
                acceptances: await tx.agentHarnessAcceptance.findMany({ select: { tenantId: true } }),
            }));
            expect(seen.scans.length).toBeGreaterThan(0);
            expect(seen.agents.length).toBeGreaterThan(0);
            expect(seen.keys.length).toBeGreaterThan(0);
            for (const rows of Object.values(seen)) {
                expect(rows.every((r) => r.tenantId === own)).toBe(true);
                expect(rows.some((r) => r.tenantId === other)).toBe(false);
            }
        }
    });

    it('with no tenant bound, app_user reads nothing', async () => {
        const seen = await asTenant(null, async (tx) => [
            await tx.agentHarnessScan.count(),
            await tx.agentHarnessScanItem.count(),
            await tx.discoveredAgent.count(),
            await tx.agentHarnessScannerKey.count(),
            await tx.agentHarnessAcceptance.count(),
        ]);
        expect(seen).toEqual([0, 0, 0, 0, 0]);
    });

    it('app_user cannot write a row into another tenant', async () => {
        // A well-formed row in every respect but its tenant, so the policy is
        // the only thing that can refuse it.
        const t2Scan = await prisma.agentHarnessScan.findFirstOrThrow({ where: { tenantId: T2 }, select: { id: true } });
        await expect(
            asTenant(T1, (tx) =>
                tx.discoveredAgent.create({
                    data: {
                        tenantId: T2,
                        discoveredId: 'entra:sp:smuggled',
                        discoveredVia: ['entra-sp'],
                        lastScanId: t2Scan.id,
                        firstSeenAt: new Date(),
                        lastSeenAt: new Date(),
                        lastLevel: 'H0',
                        lastReach: 'UNKNOWN',
                    },
                }),
            ),
        ).rejects.toThrow(/row-level security/);
    });

    it('the list usecase is tenant-scoped', async () => {
        const t2 = await listHarnessScans(ctxFor(T2));
        expect(t2.length).toBeGreaterThan(0);
        expect(t2.every((s) => s.scanRef === 'scan_first')).toBe(true);
    });
});

describe('an acceptance is the owner’s, and it lapses', () => {
    /** A write-capable registered agent at H2 falls short of the H3 bar. */
    const writingAgent = (b: HarnessReportBody) => {
        b.agents = [{ ...b.agents[0], tools: [{ ...b.agents[0].tools[0], readOnlyHint: false }] }];
    };
    let discoveredAgentId = '';

    beforeAll(async () => {
        await ingest(T2, bodyFor(T2, 'scan_writer', writingAgent));
        const row = await prisma.discoveredAgent.findFirstOrThrow({
            where: { tenantId: T2, discoveredId: 'entra:sp:registered-1' },
            select: { id: true },
        });
        discoveredAgentId = row.id;
        expect(await openRefs(T2)).toContain('HARNESS_SHORTFALL:entra:sp:registered-1');
    });

    const input = (days: number) => ({
        discoveredAgentId,
        justification: 'Compensating review of every write by the operations lead until the manifests are pinned.',
        expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(),
    });

    it('only the agent’s owner may accept, and never for more than a year', async () => {
        await expect(acceptHarnessShortfall(ctxFor(T2, seeded[T2].otherOwnerUserId), input(30))).rejects.toThrow(/owner/);
        await expect(acceptHarnessShortfall(ctxFor(T2), input(400))).rejects.toThrow(/at most 365 days/);
    });

    it('a shadow agent cannot be accepted', async () => {
        const shadow = await prisma.discoveredAgent.findFirstOrThrow({
            where: { tenantId: T2, discoveredId: 'entra:sp:shadow-1' },
            select: { id: true },
        });
        await expect(acceptHarnessShortfall(ctxFor(T2), { ...input(30), discoveredAgentId: shadow.id })).rejects.toThrow(/register it first/);
    });

    it('closes the shortfall, holds it closed across a scan, and reopens it once on expiry', async () => {
        const acceptance = await acceptHarnessShortfall(ctxFor(T2), input(30));
        expect(await openRefs(T2)).not.toContain('HARNESS_SHORTFALL:entra:sp:registered-1');

        // A scan while the acceptance is in force does not reopen it.
        await ingest(T2, bodyFor(T2, 'scan_while_accepted', writingAgent));
        expect(await openRefs(T2)).not.toContain('HARNESS_SHORTFALL:entra:sp:registered-1');

        const later = new Date(acceptance.expiresAt.getTime() + 86_400_000);
        expect(await reopenExpiredHarnessAcceptances(prisma, later, T2)).toBe(1);
        expect(await openRefs(T2)).toContain('HARNESS_SHORTFALL:entra:sp:registered-1');
        // Claimed once: a second monitor pass reopens nothing.
        expect(await reopenExpiredHarnessAcceptances(prisma, later, T2)).toBe(0);

        const expired = await prisma.auditLog.count({
            where: { tenantId: T2, action: 'AGENT_HARNESS_ACCEPTANCE_EXPIRED', entityId: acceptance.id },
        });
        expect(expired).toBe(1);
    });

    it('the justification is encrypted at rest', async () => {
        const rows = await prisma.$queryRawUnsafe<Array<{ justification: string }>>(
            `SELECT "justification" FROM "AgentHarnessAcceptance" WHERE "tenantId" = $1`,
            T2,
        );
        expect(rows.length).toBeGreaterThan(0);
        for (const r of rows) expect(r.justification).toMatch(/^v[12]:/);
    });
});
