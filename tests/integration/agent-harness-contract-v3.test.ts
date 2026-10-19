/**
 * `inflect-agent-harness/3` through the real ingest, against a real database
 * (#3785).
 *
 *   1. `/3` INGESTS: its `gcp-sa` source round-trips into the stored scan and
 *      its readers, and the service account it found is a discovered agent.
 *   2. `/2` STILL INGESTS beside it, and a `/2` report that names `gcp-sa` is
 *      refused and writes nothing: each report is held to its own id.
 *   3. AN ESTATE MAY DECLARE THE KIND: the database CHECK follows the contract,
 *      and the health view reads the source from the latest complete scan.
 *   4. A KEY NO ACCOUNT HOLDS opens ORPHAN_CREDENTIAL, because `gcp-sa` is an
 *      identity-bearing kind read in full.
 *   5. TWO TENANTS. One tenant's `/3` scan is invisible to the other.
 */
import { MembershipStatus, PrismaClient, Role } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import {
    createFakeScanner,
    GCP_SA_ID,
    GCP_SA_KEY_REF,
    validV2ReportBody,
    validV3ReportBody,
    type FakeScanner,
} from '../helpers/agent-harness-fake-scanner';
import { createRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { ingestHarnessReport, listHarnessScans } from '@/app-layer/usecases/agent-harness-scans';
import { getHarnessMatrix } from '@/app-layer/usecases/agent-harness-matrix';
import { addHarnessScannerKey } from '@/app-layer/usecases/agent-harness-scanner-keys';
import { createHarnessEstate, getHarnessEstateHealth } from '@/app-layer/usecases/agent-harness-estates';
import {
    HARNESS_CONTRACT_V2,
    parseStoredHarnessSources,
    type HarnessReportBodyV2,
    type HarnessReportBodyV3,
} from '@/lib/agentic/harness-contract';
import { orphanCredentialRefOf } from '@/lib/agentic/harness-findings';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const T1 = 'harness-v3-one';
const T2 = 'harness-v3-two';
const ALL_TENANTS = [T1, T2];

interface Seeded {
    ownerUserId: string;
    scannerAgentId: string;
    targetAgentId: string;
    scanner: FakeScanner;
}
const seeded: Record<string, Seeded> = {};

const ctxFor = (tenantId: string): RequestContext =>
    makeRequestContext('OWNER', { tenantId, tenantSlug: tenantId, userId: seeded[tenantId].ownerUserId });
const ownerEmail = (tenantId: string) => `owner@${tenantId}.test`;

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: ALL_TENANTS } };
    await prisma.agentHarnessEstateSource.deleteMany({ where: t });
    await prisma.agentHarnessEstate.deleteMany({ where: t });
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
    await prisma.user.deleteMany({ where: { emailHash: { in: ALL_TENANTS.map(ownerEmail).map(hashForLookup) } } });
    await prisma.tenant.deleteMany({ where: { id: { in: ALL_TENANTS } } });
}

async function seedTenant(tenantId: string): Promise<void> {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
    const email = ownerEmail(tenantId);
    const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await prisma.tenantMembership.create({ data: { tenantId, userId: user.id, role: Role.OWNER, status: MembershipStatus.ACTIVE } });
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

let scanSeq = 0;

/** A body pointed at this tenant's register rows, as of `asOf`. */
function pointed<B extends HarnessReportBodyV2 | HarnessReportBodyV3>(tenantId: string, body: B, asOf = new Date()): B {
    body.scan.id = `scan_v3_${++scanSeq}`;
    body.scan.asOf = asOf.toISOString();
    body.scan.scanner.agentId = seeded[tenantId].scannerAgentId;
    body.agents[0].registeredAgentId = seeded[tenantId].targetAgentId;
    return body;
}

const ingest = (tenantId: string, body: unknown) => ingestHarnessReport(ctxFor(tenantId), seeded[tenantId].scanner.serialise(body));

async function harnessRowCounts(tenantId: string) {
    const t = { tenantId };
    return {
        scans: await prisma.agentHarnessScan.count({ where: t }),
        items: await prisma.agentHarnessScanItem.count({ where: t }),
        agents: await prisma.discoveredAgent.count({ where: t }),
        findings: await prisma.finding.count({ where: { ...t, sourceKind: 'AGENT_HARNESS' } }),
    };
}

beforeAll(async () => {
    await clearOwnRows();
    for (const t of ALL_TENANTS) await seedTenant(t);
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('1. a /3 report verifies and ingests', () => {
    it('round-trips its gcp-sa source, and the service account it found is a discovered agent', async () => {
        const body = pointed(T1, validV3ReportBody());
        expect(await ingest(T1, body)).toMatchObject({ scanRef: body.scan.id, complete: true, agentCount: 3 });

        const stored = await prisma.agentHarnessScan.findFirstOrThrow({ where: { tenantId: T1, scanRef: body.scan.id } });
        expect(parseStoredHarnessSources(stored.sourcesJson)).toContainEqual({ kind: 'gcp-sa', status: 'COMPLETE', rows: 3, reason: null });
        expect(await prisma.discoveredAgent.count({ where: { tenantId: T1, discoveredId: GCP_SA_ID } })).toBe(1);

        // Its readers read it, rather than reading the scan as unreadable.
        expect((await listHarnessScans(ctxFor(T1))).map((s) => s.scanRef)).toContain(body.scan.id);
        const matrix = await getHarnessMatrix(ctxFor(T1));
        expect(JSON.stringify(matrix)).toContain(GCP_SA_ID);
    });
});

describe('2. each report is held to its own id', () => {
    it('a /2 report still ingests beside /3', async () => {
        const body = pointed(T1, validV2ReportBody());
        expect(await ingest(T1, body)).toMatchObject({ scanRef: body.scan.id });
    });

    it('a /2 report that names gcp-sa is refused, and writes nothing', async () => {
        const before = await harnessRowCounts(T1);
        const body = pointed(T1, { ...validV3ReportBody(), contract: HARNESS_CONTRACT_V2 } as unknown as HarnessReportBodyV3);
        await expect(ingest(T1, body)).rejects.toThrow(/SCHEMA|schema/);
        expect(await harnessRowCounts(T1)).toEqual(before);
    });
});

describe('3. an estate may declare the gcp-sa source', () => {
    it('the CHECK admits it, and the health view reads it from the latest complete scan', async () => {
        await createHarnessEstate(ctxFor(T1), {
            name: 'Acme Google Cloud',
            scannerAgentId: seeded[T1].scannerAgentId,
            cadenceHours: 24,
            sources: [{ kind: 'gcp-sa', ownerUserId: seeded[T1].ownerUserId }],
        });
        await ingest(T1, pointed(T1, validV3ReportBody()));
        const view = await getHarnessEstateHealth(ctxFor(T1), { now: new Date() });
        const row = view.estates.rows.find((r) => r.name === 'Acme Google Cloud')!;
        expect(row.sources.map((s) => [s.kind, s.status, s.latest?.state])).toEqual([['gcp-sa', 'FRESH', 'COMPLETE']]);
    });

    it('and still refuses a kind the contract does not define, at the database', async () => {
        const estate = await prisma.agentHarnessEstate.findFirstOrThrow({ where: { tenantId: T1, name: 'Acme Google Cloud' } });
        await expect(
            prisma.agentHarnessEstateSource.create({
                data: { tenantId: T1, estateId: estate.id, kind: 'gcp-folder', ownerUserId: seeded[T1].ownerUserId },
            }),
        ).rejects.toThrow(/AgentHarnessEstateSource_kind_known/);
    });
});

describe('4. a key no account holds is an orphan', () => {
    it('opens ORPHAN_CREDENTIAL under the gcp-sa kind, every identity-bearing source having been read in full', async () => {
        const body = pointed(T1, validV3ReportBody());
        body.agents = body.agents.filter((a) => a.discoveredId !== GCP_SA_ID);
        body.unboundCredentials = [{ ref: GCP_SA_KEY_REF, sourceKind: 'gcp-sa' }];
        await ingest(T1, body);
        const ref = orphanCredentialRefOf(seeded[T1].scannerAgentId, 'gcp-sa', GCP_SA_KEY_REF);
        const finding = await prisma.finding.findFirst({ where: { tenantId: T1, sourceKind: 'AGENT_HARNESS', sourceRef: ref, deletedAt: null } });
        expect(finding?.status).toBe('OPEN');
    });
});

describe('5. two tenants', () => {
    it('one tenant\'s /3 scan reaches nothing of the other\'s', async () => {
        expect(await prisma.discoveredAgent.count({ where: { tenantId: T2, discoveredId: GCP_SA_ID } })).toBe(0);
        expect(await listHarnessScans(ctxFor(T2))).toEqual([]);
        // T1's scanner key is not T2's: its report is refused there.
        const body = pointed(T2, validV3ReportBody());
        await expect(ingestHarnessReport(ctxFor(T2), seeded[T1].scanner.serialise(body))).rejects.toThrow();
        expect(await harnessRowCounts(T2)).toEqual({ scans: 0, items: 0, agents: 0, findings: 0 });
    });
});
