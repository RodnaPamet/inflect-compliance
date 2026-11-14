/**
 * The third-party application ingest against a real database.
 *
 *   1. A REFUSED REPORT WRITES NOTHING: an untrusted signer, a harness report
 *      given here, a scanner naming another agent, a key revoked.
 *   2. A VERIFIED REPORT IS STORED AS PLANNED, and a REPLAY is a conflict —
 *      the usecase's read and, behind it, the `(tenantId, scanRef)` unique.
 *   3. TWO TENANTS. One tenant's scanner key is not trusted by the other, and
 *      the usecases of one tenant read nothing of the other's: the inventory,
 *      the scan list and the findings.
 *   4. RLS. All three tables under `app_user`, with each tenant bound, with
 *      none, and against a write into another tenant.
 */
import { MembershipStatus, PrismaClient, Role } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { createFakeScanner, validV3ReportBody, type FakeScanner } from '../helpers/agent-harness-fake-scanner';
import { integrationsBody, quietEntraApp, threeProductBody } from '../helpers/third-party-app-fake-report';
import { createRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { addHarnessScannerKey, revokeHarnessScannerKey } from '@/app-layer/usecases/agent-harness-scanner-keys';
import {
    getThirdPartyAppInventory,
    ingestThirdPartyAppReport,
    listThirdPartyAppScans,
    THIRD_PARTY_APP_FINDING_SOURCE_KIND,
} from '@/app-layer/usecases/third-party-app-scans';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const T1 = 'tpa-ingest-one';
const T2 = 'tpa-ingest-two';
const ALL_TENANTS = [T1, T2];

interface Seeded {
    ownerUserId: string;
    scannerAgentId: string;
    scanner: FakeScanner;
    keyId: string;
}
const seeded: Record<string, Seeded> = {};

const ctxFor = (tenantId: string): RequestContext =>
    makeRequestContext('OWNER', { tenantId, tenantSlug: tenantId, userId: seeded[tenantId].ownerUserId });

const emailOf = (tenantId: string) => `owner@${tenantId}.test`;

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: ALL_TENANTS } };
    await prisma.thirdPartyAppScanItem.deleteMany({ where: t });
    await prisma.thirdPartyAppScan.deleteMany({ where: t });
    await prisma.discoveredThirdPartyApp.deleteMany({ where: t });
    await prisma.agentHarnessScannerKey.deleteMany({ where: t });
    await prisma.finding.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, ALL_TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, ALL_TENANTS);
    });
    await prisma.user.deleteMany({ where: { emailHash: { in: ALL_TENANTS.map(emailOf).map(hashForLookup) } } });
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
    const aiSystem = await prisma.aiSystem.create({ data: { tenantId, name: `Host of scanner ${tenantId}`, ownerUserId: user.id } });
    const scannerAgent = await createRegisteredAgent(ctxFor(tenantId), {
        aiSystemId: aiSystem.id,
        name: `Integrations scanner ${tenantId}`,
        autonomyLevel: 2,
        dataAccessScope: 'READ_TENANT_DATA',
        reversibility: 'COMPENSABLE',
        provenance: 'FIRST_PARTY',
        ownerUserId: user.id,
    });
    const scanner = createFakeScanner();
    const key = await addHarnessScannerKey(ctxFor(tenantId), { agentId: scannerAgent.id, publicKey: scanner.publicKeyHex });
    Object.assign(seeded[tenantId], { scannerAgentId: scannerAgent.id, scanner, keyId: key.id });
}

const ingest = (tenantId: string, body: unknown, scanner = seeded[tenantId].scanner) =>
    ingestThirdPartyAppReport(ctxFor(tenantId), scanner.serialise(body));

async function counts(tenantId: string) {
    const t = { tenantId };
    return {
        scans: await prisma.thirdPartyAppScan.count({ where: t }),
        apps: await prisma.discoveredThirdPartyApp.count({ where: t }),
        items: await prisma.thirdPartyAppScanItem.count({ where: t }),
        findings: await prisma.finding.count({ where: { ...t, sourceKind: THIRD_PARTY_APP_FINDING_SOURCE_KIND } }),
    };
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

describe('1. a refused report writes nothing', () => {
    it('an untrusted signer, a harness report, a scanner naming another agent', async () => {
        const before = await counts(T1);
        await expect(
            ingestThirdPartyAppReport(ctxFor(T1), createFakeScanner().serialise(integrationsBody(seeded[T1].scannerAgentId, 'r1'))),
        ).rejects.toThrow('third_party_app_report_refused: UNTRUSTED_SIGNER');

        const harness = validV3ReportBody();
        harness.scan.scanner.agentId = seeded[T1].scannerAgentId;
        await expect(ingest(T1, harness)).rejects.toThrow('third_party_app_report_refused: SCHEMA');

        await expect(ingest(T1, integrationsBody('agent-that-is-not-the-scanner', 'r2'))).rejects.toThrow(
            'third_party_app_report_refused: SCANNER_MISMATCH',
        );
        expect(await counts(T1)).toEqual(before);
    });
});

describe('2. a verified report is stored as planned, and a replay is a conflict', () => {
    it('stores the scan, its applications, items and findings', async () => {
        const result = await ingest(T1, threeProductBody(seeded[T1].scannerAgentId, 'scan-1'));
        expect(result).toMatchObject({ scanRef: 'scan-1', complete: true, applicationCount: 3 });
        expect(result.findingsOpened).toBeGreaterThan(0);
        expect(await counts(T1)).toEqual({ scans: 1, apps: 3, items: 3, findings: result.findingsOpened });

        const scan = await prisma.thirdPartyAppScan.findFirstOrThrow({ where: { tenantId: T1, scanRef: 'scan-1' } });
        expect(scan).toMatchObject({ scannerAgentId: seeded[T1].scannerAgentId, scannerKeyId: seeded[T1].keyId, unusedDays: 90 });
        expect(scan.reportDigest).toMatch(/^[0-9a-f]{64}$/);

        const audit = await prisma.auditLog.findFirst({
            where: { tenantId: T1, action: 'THIRD_PARTY_APP_SCAN_INGESTED', entityId: scan.id },
        });
        expect(audit).not.toBeNull();
    });

    it('refuses a replay of the same scan id, and writes nothing more', async () => {
        const before = await counts(T1);
        await expect(ingest(T1, threeProductBody(seeded[T1].scannerAgentId, 'scan-1'))).rejects.toThrow(
            'third_party_app_report_refused: REPLAY',
        );
        expect(await counts(T1)).toEqual(before);
    });

    it('the database holds the replay rule on its own', async () => {
        const scan = await prisma.thirdPartyAppScan.findFirstOrThrow({ where: { tenantId: T1, scanRef: 'scan-1' } });
        const { id: _id, createdAt: _c, ...copy } = scan;
        await expect(
            prisma.thirdPartyAppScan.create({ data: { ...copy, sourcesJson: copy.sourcesJson as object } }),
        ).rejects.toThrow();
    });

    it('a revoked key verifies nothing', async () => {
        const extra = createFakeScanner();
        const key = await addHarnessScannerKey(ctxFor(T1), { agentId: seeded[T1].scannerAgentId, publicKey: extra.publicKeyHex });
        await revokeHarnessScannerKey(ctxFor(T1), { keyId: key.id });
        const before = await counts(T1);
        await expect(ingest(T1, integrationsBody(seeded[T1].scannerAgentId, 'scan-revoked'), extra)).rejects.toThrow(
            'UNTRUSTED_SIGNER',
        );
        expect(await counts(T1)).toEqual(before);
    });
});

describe('3. two tenants', () => {
    it("one tenant's scanner key is not trusted by the other", async () => {
        const before = await counts(T2);
        await expect(
            ingest(T2, integrationsBody(seeded[T1].scannerAgentId, 'cross'), seeded[T1].scanner),
        ).rejects.toThrow('UNTRUSTED_SIGNER');
        expect(await counts(T2)).toEqual(before);
    });

    it("each tenant's usecases read its own scans, applications and findings only", async () => {
        await ingest(T2, integrationsBody(seeded[T2].scannerAgentId, 'scan-1', { applications: [quietEntraApp(7)] }));

        const one = await getThirdPartyAppInventory(ctxFor(T1));
        const two = await getThirdPartyAppInventory(ctxFor(T2));
        expect(one.sections.map((s) => s.scan.scannerAgentId)).toEqual([seeded[T1].scannerAgentId]);
        expect(two.sections.map((s) => s.scan.scannerAgentId)).toEqual([seeded[T2].scannerAgentId]);
        expect(one.sections[0].rows).toHaveLength(3);
        expect(two.sections[0].rows.map((r) => r.applicationId)).toEqual([quietEntraApp(7).id]);
        // T2's application has nothing to say against it; T1's findings stay T1's.
        expect(two.sections[0].rows[0].openFindings).toEqual([]);

        expect((await listThirdPartyAppScans(ctxFor(T1))).map((s) => s.scanRef)).toEqual(['scan-1']);
        expect((await listThirdPartyAppScans(ctxFor(T2))).map((s) => s.scanRef)).toEqual(['scan-1']);
        expect(await prisma.finding.count({ where: { tenantId: T2, sourceKind: THIRD_PARTY_APP_FINDING_SOURCE_KIND } })).toBe(0);
    });
});

describe('4. RLS on the three tables', () => {
    const TABLES = ['thirdPartyAppScan', 'discoveredThirdPartyApp', 'thirdPartyAppScanItem'] as const;

    it.each(TABLES)('%s: a bound tenant reads its own rows only', async (table) => {
        const own = await asTenant(T1, (tx) => (tx[table] as unknown as { findMany: () => Promise<{ tenantId: string }[]> }).findMany());
        expect(own.length).toBeGreaterThan(0);
        expect(new Set(own.map((r) => r.tenantId))).toEqual(new Set([T1]));
    });

    it.each(TABLES)('%s: with no tenant bound, app_user reads nothing', async (table) => {
        const none = await asTenant(null, (tx) => (tx[table] as unknown as { count: () => Promise<number> }).count());
        expect(none).toBe(0);
    });

    it('app_user cannot write a row into another tenant', async () => {
        await expect(
            asTenant(T2, (tx) =>
                tx.discoveredThirdPartyApp.create({
                    data: {
                        tenantId: T1,
                        applicationId: 'entra:0d1e2c3b-0000-4000-8000-000000003686:sp:a0000006-0000-4000-8000-000000000999',
                        sourceKind: 'entra-integrations',
                        firstSeenScanId: 'x',
                        lastSeenScanId: 'x',
                        firstSeenAt: new Date(),
                        lastSeenAt: new Date(),
                    },
                }),
            ),
        ).rejects.toThrow();
    });
});
