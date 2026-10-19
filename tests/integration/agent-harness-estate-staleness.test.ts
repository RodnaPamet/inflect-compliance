/**
 * A stale scanner estate raises a finding and a metric (#3741), against a real
 * database, with scans posted through the real ingest.
 *
 *   1. WIRED: scheduled daily at its stated minute, one attempt, registered.
 *   2. ONE FINDING PER STALE ESTATE: a stale estate opens exactly one, named for
 *      the estate, its scanner and its sources; a second run opens no other.
 *   3. IT CLOSES ONLY WHEN A COMPLETE SCAN ARRIVES: never on an edit that makes
 *      the estate fresh (a widened cadence, a dropped source), never on the
 *      estate's removal; a stale estate whose finding was closed reopens THAT
 *      finding.
 *   4. ZERO IS NEVER COMPLETE: a tenant with no estate records evaluated 0,
 *      NOT_APPLICABLE — never PASSED.
 *   5. ISOLATION: one tenant's stale estate opens nothing in another, and the
 *      sweep visits only tenants using the harness.
 *   6. THE RUN IS RECORDED, and the metric is emitted from it.
 */
import { MembershipStatus, PrismaClient, Role } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { runInTenantContext } from '@/lib/db-context';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { createFakeScanner, validReportBody, type FakeScanner } from '../helpers/agent-harness-fake-scanner';
import { createRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { ingestHarnessReport } from '@/app-layer/usecases/agent-harness-scans';
import { addHarnessScannerKey } from '@/app-layer/usecases/agent-harness-scanner-keys';
import {
    createHarnessEstate,
    deleteHarnessEstate,
    updateHarnessEstate,
    type CreateHarnessEstateInput,
} from '@/app-layer/usecases/agent-harness-estates';
import { runHarnessEstateStaleness } from '@/app-layer/usecases/agent-harness-estate-staleness';
import { runHarnessEstateStalenessSweep } from '@/app-layer/jobs/agent-harness-estate-staleness';
import { SCHEDULED_JOBS } from '@/app-layer/jobs/schedules';
import { JOB_DEFAULTS } from '@/app-layer/jobs/types';
import { executorRegistry } from '@/app-layer/jobs/executor-registry';
import { recordHarnessEstateStaleness } from '@/lib/observability/integration-metrics';
import { ESTATE_STALENESS_AUTOMATION_KEY, staleEstateRefOf } from '@/lib/agentic/harness-estate-staleness';
import type { HarnessReportBody } from '@/lib/agentic/harness-contract';
import type { RequestContext } from '@/app-layer/types';

jest.mock('@/lib/observability/integration-metrics', () => ({
    ...jest.requireActual('@/lib/observability/integration-metrics'),
    recordHarnessEstateStaleness: jest.fn(),
}));
const recorded = recordHarnessEstateStaleness as jest.MockedFunction<typeof recordHarnessEstateStaleness>;

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(180_000);

const T1 = 'estate-staleness-one';
const T2 = 'estate-staleness-two';
const T3 = 'estate-staleness-keyonly';
const T4 = 'estate-staleness-unused';
const ALL_TENANTS = [T1, T2, T3, T4];
const HOUR = 3_600_000;

interface Seeded {
    ownerUserId: string;
    sourceOwnerId: string;
    scanners: { agentId: string; fake: FakeScanner }[];
}
const seeded: Record<string, Seeded> = {};

const ctxFor = (tenantId: string): RequestContext =>
    makeRequestContext('OWNER', { tenantId, tenantSlug: tenantId, userId: seeded[tenantId].ownerUserId });

const emails = (tenantId: string) => [`owner@${tenantId}.test`, `sources@${tenantId}.test`];

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: ALL_TENANTS } };
    await prisma.integrationExecution.deleteMany({ where: t });
    await prisma.agentHarnessEstateSource.deleteMany({ where: t });
    await prisma.agentHarnessEstate.deleteMany({ where: t });
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

async function member(tenantId: string, email: string, role: Role): Promise<string> {
    const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await prisma.tenantMembership.create({ data: { tenantId, userId: user.id, role, status: MembershipStatus.ACTIVE } });
    return user.id;
}

/** A tenant, its people, and `scanners` registered scanner agents each holding a trusted key. */
async function seedTenant(tenantId: string, scanners: number): Promise<void> {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
    const [ownerEmail, sourcesEmail] = emails(tenantId);
    const ownerUserId = await member(tenantId, ownerEmail, Role.OWNER);
    seeded[tenantId] = { ownerUserId, sourceOwnerId: await member(tenantId, sourcesEmail, Role.EDITOR), scanners: [] };
    for (let i = 0; i < scanners; i++) {
        const agent = await createRegisteredAgent(ctxFor(tenantId), {
            aiSystemId: (await prisma.aiSystem.create({ data: { tenantId, name: `Scanner host ${i}`, ownerUserId } })).id,
            name: `Harness scanner ${i} of ${tenantId}`,
            autonomyLevel: 1,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'COMPENSABLE',
            provenance: 'FIRST_PARTY',
            ownerUserId,
        });
        const fake = createFakeScanner();
        await addHarnessScannerKey(ctxFor(tenantId), { agentId: agent.id, publicKey: fake.publicKeyHex });
        seeded[tenantId].scanners.push({ agentId: agent.id, fake });
    }
}

let scanSeq = 0;
/**
 * Post one signed report from scanner `i` through the real ingest, describing
 * the estate `hoursAgo` ago. Every source it reports is read in full unless
 * `edit` says otherwise; the vault and mcp sources are what the estates declare.
 */
async function postScan(tenantId: string, i: number, hoursAgo: number, edit?: (b: HarnessReportBody) => void) {
    const s = seeded[tenantId].scanners[i];
    const body = validReportBody();
    scanSeq += 1;
    body.scan.id = `scan_staleness_${tenantId}_${scanSeq}`;
    body.scan.asOf = new Date(Date.now() - hoursAgo * HOUR).toISOString();
    body.scan.scanner.agentId = s.agentId;
    edit?.(body);
    return ingestHarnessReport(ctxFor(tenantId), s.fake.serialise(body));
}

type SourceKind = CreateHarnessEstateInput['sources'][number]['kind'];
const sourcesOf = (tenantId: string, kinds: SourceKind[]) => kinds.map((kind) => ({ kind, ownerUserId: seeded[tenantId].sourceOwnerId }));

const declare = (tenantId: string, i: number, name: string, kinds: SourceKind[], cadenceHours = 24) =>
    createHarnessEstate(ctxFor(tenantId), {
        name,
        scannerAgentId: seeded[tenantId].scanners[i].agentId,
        cadenceHours,
        sources: sourcesOf(tenantId, kinds),
    });

const staleFindings = (tenantId: string) =>
    prisma.finding.findMany({
        where: { tenantId, sourceKind: 'AGENT_HARNESS', sourceRef: { startsWith: 'STALE_ESTATE:' } },
        orderBy: { createdAt: 'asc' },
    });

const findingOf = async (tenantId: string, estateId: string) => {
    const rows = await prisma.finding.findMany({ where: { tenantId, sourceRef: staleEstateRefOf(estateId) } });
    expect(rows).toHaveLength(1);
    return rows[0];
};

/** A finding as the product reads it: inside the tenant's context, so its encrypted fields decrypt. */
const readFinding = (tenantId: string, id: string) =>
    runInTenantContext(ctxFor(tenantId), (db) => db.finding.findFirstOrThrow({ where: { id, tenantId } }));

const executionOf = (id: string | null) => prisma.integrationExecution.findUniqueOrThrow({ where: { id: id as string } });

const estateIds: Record<string, string> = {};

beforeAll(async () => {
    await clearOwnRows();
    await seedTenant(T1, 4);
    await seedTenant(T2, 1);
    await seedTenant(T3, 1);
    await prisma.tenant.create({ data: { id: T4, name: T4, slug: T4 } });
    seeded[T4] = { ownerUserId: await member(T4, emails(T4)[0], Role.OWNER), sourceOwnerId: '', scanners: [] };
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

beforeEach(() => recorded.mockClear());

describe('1. wired', () => {
    it('is scheduled daily at 06:47 UTC with one attempt, and registered', () => {
        expect(SCHEDULED_JOBS.find((j) => j.name === 'agent-harness-estate-staleness')?.pattern).toBe('47 6 * * *');
        expect(JOB_DEFAULTS['agent-harness-estate-staleness'].attempts).toBe(1);
        expect(executorRegistry.has('agent-harness-estate-staleness')).toBe(true);
    });
});

describe('2. a stale estate opens exactly one finding', () => {
    beforeAll(async () => {
        // Acme: its only complete scan describes 40 hours ago, past 1.5 × 24.
        estateIds.acme = (await declare(T1, 0, 'Acme production', ['vault', 'mcp'])).id;
        await postScan(T1, 0, 40);
        // Beta: its scanner has never reported at all.
        estateIds.beta = (await declare(T1, 1, 'Beta identity', ['vault'])).id;
        // Gamma: fresh — a complete scan two hours ago.
        estateIds.gamma = (await declare(T1, 2, 'Gamma secrets', ['vault', 'mcp'])).id;
        await postScan(T1, 2, 2);
    });

    it('opens one finding per stale estate, naming the estate, its scanner and the sources', async () => {
        const r = await runHarnessEstateStaleness({ tenantId: T1, jobRunId: 'staleness-run-1' });
        expect(r).toMatchObject({ status: 'PASSED', evaluated: 3, stale: 2, opened: 2, reopened: 0, resolved: 0, held: 0 });

        const rows = await staleFindings(T1);
        expect(rows.map((f) => f.sourceRef).sort()).toEqual([staleEstateRefOf(estateIds.acme), staleEstateRefOf(estateIds.beta)].sort());
        for (const f of rows) {
            expect(f).toMatchObject({ status: 'OPEN', severity: 'HIGH', type: 'OBSERVATION', assigneeUserId: seeded[T1].ownerUserId });
        }

        const acme = await readFinding(T1, (await findingOf(T1, estateIds.acme)).id);
        expect(acme.title).toBe('Harness estate Acme production has no complete scan within 36 hours');
        const scannerName = `Harness scanner 0 of ${T1}`;
        for (const part of [
            `Estate Acme production (${estateIds.acme})`,
            `${scannerName} (agent ${seeded[T1].scanners[0].agentId})`,
            'No scan of this estate took effect in that window',
            'mcp (no scan in the window); vault (no scan in the window)',
        ]) {
            expect(acme.description.split(part)).toHaveLength(2);
        }

        // The pass's own audit row per finding, beside the trail's automatic one.
        const raised = await prisma.auditLog.findMany({
            where: { tenantId: T1, entity: 'Finding', action: 'CREATE', details: { startsWith: 'Harness estate staleness raised' } },
            select: { entityId: true, actorType: true },
        });
        expect(raised.map((a) => a.entityId).sort()).toEqual(rows.map((f) => f.id).sort());
        expect(raised.every((a) => a.actorType === 'JOB')).toBe(true);
    });

    it('a second run opens no other: the stale estates\' findings are left as they are', async () => {
        const before = await staleFindings(T1);
        const r = await runHarnessEstateStaleness({ tenantId: T1 });
        expect(r).toMatchObject({ evaluated: 3, stale: 2, opened: 0, reopened: 0, stillOpen: 2, resolved: 0 });
        const after = await staleFindings(T1);
        expect(after.map((f) => [f.id, f.status, f.updatedAt.toISOString()])).toEqual(
            before.map((f) => [f.id, f.status, f.updatedAt.toISOString()]),
        );
    });

    it('two passes at once still leave one finding per estate', async () => {
        // A scheduled tick and a manual run of the same tenant: the per-tenant
        // lock serialises them, and the second finds the first's finding.
        const delta = (await declare(T1, 3, 'Delta race', ['okta-app'])).id;
        await Promise.all([runHarnessEstateStaleness({ tenantId: T1 }), runHarnessEstateStaleness({ tenantId: T1 })]);
        expect(await prisma.finding.count({ where: { tenantId: T1, sourceRef: staleEstateRefOf(delta) } })).toBe(1);
        // Out of the way of what follows, which counts three estates.
        await deleteHarnessEstate(ctxFor(T1), delta);
        await prisma.finding.deleteMany({ where: { tenantId: T1, sourceRef: staleEstateRefOf(delta) } });
    });
});

describe('3. it closes only when a complete scan arrives', () => {
    it('an edit that widens the cadence around an old scan holds the finding open', async () => {
        // 40 hours old is fresh against 48 hours (stale after 72) — by the edit alone.
        await updateHarnessEstate(ctxFor(T1), estateIds.acme, { cadenceHours: 48 });
        const r = await runHarnessEstateStaleness({ tenantId: T1 });
        expect(r).toMatchObject({ resolved: 0, held: 1 });
        expect((await findingOf(T1, estateIds.acme)).status).toBe('OPEN');
        const row = await executionOf(r.executionId);
        expect((row.resultJson as { held: unknown[] }).held).toEqual([
            { findingId: (await findingOf(T1, estateIds.acme)).id, estateId: estateIds.acme, reason: 'FRESH_ONLY_BY_DECLARATION_CHANGE' },
        ]);
    });

    it('a complete scan that arrives after the edit closes it, and says which', async () => {
        const posted = await postScan(T1, 0, 0.05);
        const r = await runHarnessEstateStaleness({ tenantId: T1 });
        expect(r).toMatchObject({ resolved: 1, held: 0 });
        const f = await readFinding(T1, (await findingOf(T1, estateIds.acme)).id);
        expect(f.status).toBe('CLOSED');
        expect(f.verifiedAt).not.toBeNull();
        expect(f.verificationNotes?.split(`complete scan ${posted.scanRef} arrived at`)).toHaveLength(2);
        const closed = await prisma.auditLog.count({ where: { tenantId: T1, entity: 'Finding', entityId: f.id, action: 'STATUS_CHANGE' } });
        expect(closed).toBe(1);
    });

    it('stale again reopens THAT finding, naming the source it now misses', async () => {
        const original = await findingOf(T1, estateIds.acme);
        // A declared source no scan reports: NOT_REPORTED, never complete.
        await updateHarnessEstate(ctxFor(T1), estateIds.acme, { sources: sourcesOf(T1, ['vault', 'mcp', 'okta-app']) });
        const r = await runHarnessEstateStaleness({ tenantId: T1 });
        expect(r).toMatchObject({ opened: 0, reopened: 1 });
        const reopened = await readFinding(T1, original.id);
        expect(reopened.status).toBe('OPEN');
        expect(reopened.description.split('okta-app (NOT_REPORTED in the latest scan)')).toHaveLength(2);
        expect(await prisma.finding.count({ where: { tenantId: T1, sourceRef: staleEstateRefOf(estateIds.acme) } })).toBe(1);
    });

    it('dropping that source makes the estate fresh by the edit alone, which holds it', async () => {
        await updateHarnessEstate(ctxFor(T1), estateIds.acme, { sources: sourcesOf(T1, ['vault', 'mcp']) });
        const r = await runHarnessEstateStaleness({ tenantId: T1 });
        expect(r).toMatchObject({ resolved: 0, held: 1 });
        expect((await findingOf(T1, estateIds.acme)).status).toBe('OPEN');

        await postScan(T1, 0, 0.05);
        expect(await runHarnessEstateStaleness({ tenantId: T1 })).toMatchObject({ resolved: 1 });
        expect((await findingOf(T1, estateIds.acme)).status).toBe('CLOSED');
    });

    it('removing an estate holds its finding open — and a later scan by its scanner closes nothing', async () => {
        const beta = await findingOf(T1, estateIds.beta);
        expect(beta.status).toBe('OPEN');
        await deleteHarnessEstate(ctxFor(T1), estateIds.beta);

        const r = await runHarnessEstateStaleness({ tenantId: T1 });
        expect(r).toMatchObject({ evaluated: 2, held: 1, resolved: 0 });
        expect((await executionOf(r.executionId)).resultJson).toMatchObject({
            held: [{ findingId: beta.id, estateId: estateIds.beta, reason: 'ESTATE_NOT_DECLARED' }],
        });

        await postScan(T1, 1, 0.05);
        await runHarnessEstateStaleness({ tenantId: T1 });
        expect((await findingOf(T1, estateIds.beta)).status).toBe('OPEN');
    });

    it('an incomplete scan never closes one', async () => {
        // Gamma, fresh so far, goes stale: its next scans cannot read mcp.
        const gammaId = estateIds.gamma;
        const incomplete = (b: HarnessReportBody) => {
            // The fake scanner's third source is mcp: honestly reported as cut short.
            expect(b.population.sources[2].kind).toBe('mcp');
            b.population.sources[2] = { kind: 'mcp', status: 'INCOMPLETE', reason: 'BYTE_CAP', rows: 1 };
        };
        await updateHarnessEstate(ctxFor(T1), gammaId, { cadenceHours: 1 });
        await prisma.agentHarnessScan.updateMany({
            where: { tenantId: T1, scannerAgentId: seeded[T1].scanners[2].agentId },
            data: { asOf: new Date(Date.now() - 5 * HOUR) },
        });
        expect(await runHarnessEstateStaleness({ tenantId: T1 })).toMatchObject({ opened: 1 });
        await postScan(T1, 2, 0.05, incomplete);
        expect(await runHarnessEstateStaleness({ tenantId: T1 })).toMatchObject({ resolved: 0, stillOpen: 1 });
        const gamma = await readFinding(T1, (await findingOf(T1, gammaId)).id);
        expect(gamma.status).toBe('OPEN');
    });
});

describe('4. zero is never complete', () => {
    it('a tenant with no estate records evaluated 0 as NOT_APPLICABLE, never PASSED', async () => {
        const r = await runHarnessEstateStaleness({ tenantId: T3, jobRunId: 'staleness-empty' });
        expect(r).toMatchObject({ status: 'NOT_APPLICABLE', refusal: 'NO_ESTATES', evaluated: 0, opened: 0 });
        const row = await executionOf(r.executionId);
        expect(row).toMatchObject({ provider: 'agentic', automationKey: ESTATE_STALENESS_AUTOMATION_KEY, status: 'NOT_APPLICABLE', jobRunId: 'staleness-empty' });
        expect(row.resultJson).toMatchObject({ refusal: 'NO_ESTATES', evaluated: 0, stale: 0 });
        expect(await prisma.integrationExecution.count({ where: { tenantId: T3, status: 'PASSED' } })).toBe(0);
        expect(recorded.mock.calls).toEqual([[{ outcome: 'no_estates', evaluated: 0, staleByReason: {} }]]);
    });
});

describe('5. isolation', () => {
    it('one tenant\'s stale estate opens nothing in another, and each pass judges only its own estates', async () => {
        const t2Estate = (await declare(T2, 0, 'Acme production', ['vault'])).id;
        const t1Before = (await staleFindings(T1)).map((f) => [f.id, f.status]);

        const t1 = await runHarnessEstateStaleness({ tenantId: T1 });
        expect(await staleFindings(T2)).toEqual([]);
        expect((await executionOf(t1.executionId)).resultJson).toMatchObject({ evaluated: 2 });
        expect(
            ((await executionOf(t1.executionId)).resultJson as { estates: { estateId: string }[] }).estates.map((e) => e.estateId),
        ).not.toContain(t2Estate);

        const t2 = await runHarnessEstateStaleness({ tenantId: T2 });
        expect(t2).toMatchObject({ evaluated: 1, opened: 1 });
        expect((await staleFindings(T2)).map((f) => f.sourceRef)).toEqual([staleEstateRefOf(t2Estate)]);
        expect((await staleFindings(T1)).map((f) => [f.id, f.status])).toEqual(t1Before);
        expect(await prisma.finding.count({ where: { tenantId: T1, sourceRef: staleEstateRefOf(t2Estate) } })).toBe(0);
    });
});

describe('6. the sweep, and its record', () => {
    it('visits every tenant using the harness — a key alone counts — and records a row each; a tenant that never did is not visited', async () => {
        const r = await runHarnessEstateStalenessSweep({}, 'staleness-sweep');
        const mine = r.results.filter((x) => ALL_TENANTS.includes(x.tenantId));
        expect(mine.map((x) => [x.tenantId, x.status]).sort()).toEqual(
            [
                [T1, 'PASSED'],
                [T2, 'PASSED'],
                [T3, 'NOT_APPLICABLE'],
            ].sort(),
        );
        const rows = await prisma.integrationExecution.findMany({
            where: { tenantId: { in: ALL_TENANTS }, jobRunId: 'staleness-sweep', automationKey: ESTATE_STALENESS_AUTOMATION_KEY },
            select: { tenantId: true, status: true },
        });
        expect(rows.map((x) => x.tenantId).sort()).toEqual([T1, T2, T3].sort());
        expect(await prisma.integrationExecution.count({ where: { tenantId: T4 } })).toBe(0);

        // The metric, from the same passes: tenant-free, with the denominator.
        const calls = recorded.mock.calls.map(([a]) => a);
        expect(calls).toEqual(
            expect.arrayContaining([
                { outcome: 'evaluated', evaluated: 2, staleByReason: { NO_COMPLETE_SCAN: 1 } },
                { outcome: 'evaluated', evaluated: 1, staleByReason: { NO_SCAN_IN_WINDOW: 1 } },
                { outcome: 'no_estates', evaluated: 0, staleByReason: {} },
            ]),
        );
        for (const [a] of recorded.mock.calls) expect(Object.keys(a).sort()).toEqual(['evaluated', 'outcome', 'staleByReason']);
    });

    it('the rows are not control checks: the agentic provider keeps them off that list', async () => {
        const rows = await prisma.integrationExecution.findMany({
            where: { tenantId: T1, automationKey: ESTATE_STALENESS_AUTOMATION_KEY },
            select: { provider: true, controlId: true },
        });
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((x) => x.provider === 'agentic' && x.controlId === null)).toBe(true);
    });
});
