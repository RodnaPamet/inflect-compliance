/**
 * The harness matrix read model against a real database (#3687).
 *
 * Every report here goes through the real ingest (`ingestHarnessReport`, signed
 * by a fake scanner whose key the tenant registered), so the rows the matrix
 * reads are the rows production would hold. What is pinned:
 *
 *   1. THE GATE and TWO-TENANT ISOLATION.
 *   2. "LATEST" IS `asOf`, not arrival: a backfilled older report ingested
 *      last does not pose as current, and the row that disagrees says so.
 *   3. DRIFT COMPARES A SCANNER ONLY WITH ITSELF, and a too-small window says
 *      the baseline is outside it rather than calling this a first scan.
 *   4. ZERO IS NEVER COMPLETE, and unreadable stored JSON fails CLOSED.
 *   5. THE ACCEPT AFFORDANCE IS THE OWNER'S, by the same rule the usecase
 *      refuses with — and the acceptances card holds the calendar's population.
 *   6. THE CLIENT PAYLOAD carries no owner reference, tool server address,
 *      justification or user id.
 *   7. THE KEY REGISTER the tab lists is every key, with no user id and no key
 *      bytes, and offers only the register rows the key usecase accepts.
 *   8. THE CALENDAR projects exactly the acceptances still on the clock on a
 *      live register row — a subset of the acceptances card, so every
 *      deep-link lands on a rendered anchor.
 *   9. "NONE" NEEDS EVERY SCANNER. An empty shadow list reads as "none" only
 *      when every trusted scanner's latest scan is complete and shown.
 *  10. BOUNDS ARE STATED. Rows are the worst of a WHOLE latest scan or none;
 *      the previous scans' agents cannot crowd the latest ones out; hidden
 *      scanners and truncated lists are counted, never dropped silently.
 */
import { MembershipStatus, PrismaClient, Role } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { createFakeScanner, validReportBody, type FakeScanner } from '../helpers/agent-harness-fake-scanner';
import { getPermissionsForRole } from '@/lib/permissions';
import { createRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { ingestHarnessReport } from '@/app-layer/usecases/agent-harness-scans';
import { addHarnessScannerKey, revokeHarnessScannerKey } from '@/app-layer/usecases/agent-harness-scanner-keys';
import {
    acceptHarnessShortfall,
    listHarnessAcceptances,
    reopenExpiredHarnessAcceptances,
} from '@/app-layer/usecases/agent-harness-acceptance';
import { getHarnessMatrix, getHarnessScannerKeysView } from '@/app-layer/usecases/agent-harness-matrix';
import { getComplianceCalendarEvents } from '@/app-layer/usecases/compliance-calendar';
import {
    HARNESS_CRITERIA,
    HARNESS_LEVELS,
    rungOf,
    type CriterionVerdict,
    type HarnessCriterionId,
    type HarnessLevel,
} from '@/lib/agentic/harness-ladder';
import type { HarnessReportAgentV2, HarnessReportBodyV2 } from '@/lib/agentic/harness-contract';
import type { HarnessMatrixView, HarnessScannerSection } from '@/lib/agentic/harness-read-model';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(180_000);

const T1 = 'harness-matrix-one';
const T2 = 'harness-matrix-two';
const T3 = 'harness-matrix-three';
/** Two trusted scanners, reporting in a sequence that walks the shadow basis. */
const T4 = 'harness-matrix-four';
const ALL_TENANTS = [T1, T2, T3, T4];

// Canaries: each must reach its source row and never the client payload.
const OWNER_REF_CANARY = 'usr_canary_owner_ref_3687';
/** A credential REFERENCE the report must carry; the ingest stores no credential at all. */
const CREDENTIAL_REF = 'kv://canary-credential-ref-3687';
const TOOL_SERVER_CANARY = 'https://canary-tool-server-3687.example/mcp';
const JUSTIFICATION_CANARY = 'Canary justification 3687: compensating review of every write until pinned.';
const HASH = `sha256:${'c'.repeat(64)}`;

interface Seeded {
    ownerUserId: string;
    otherUserId: string;
    scannerA: { agentId: string; scanner: FakeScanner };
    scannerB: { agentId: string; scanner: FakeScanner };
    targetAgentId: string;
    doomedAgentId: string;
    atBarAgentId: string;
}
const seeded: Record<string, Seeded> = {};

const ownerCtx = (tenantId: string): RequestContext =>
    makeRequestContext('OWNER', { tenantId, tenantSlug: tenantId, userId: seeded[tenantId].ownerUserId });
/** A second administrator in the same tenant, who owns none of the agents. */
const otherAdminCtx = (tenantId: string): RequestContext =>
    makeRequestContext('ADMIN', { tenantId, tenantSlug: tenantId, userId: seeded[tenantId].otherUserId });

const emails = (tenantId: string) => [`owner@${tenantId}.test`, `other@${tenantId}.test`];

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

async function member(tenantId: string, email: string, role: Role): Promise<string> {
    const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await prisma.tenantMembership.create({ data: { tenantId, userId: user.id, role, status: MembershipStatus.ACTIVE } });
    return user.id;
}

async function seedTenant(tenantId: string): Promise<void> {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
    const [ownerEmail, otherEmail] = emails(tenantId);
    const ownerUserId = await member(tenantId, ownerEmail, Role.OWNER);
    const otherUserId = await member(tenantId, otherEmail, Role.ADMIN);
    seeded[tenantId] = { ownerUserId, otherUserId } as Seeded;

    const agent = async (name: string) =>
        createRegisteredAgent(ownerCtx(tenantId), {
            aiSystemId: (await prisma.aiSystem.create({ data: { tenantId, name: `Host of ${name}`, ownerUserId } })).id,
            name,
            autonomyLevel: 2,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'COMPENSABLE',
            provenance: 'FIRST_PARTY',
            ownerUserId,
        });
    const keyed = async (name: string) => {
        const a = await agent(name);
        const scanner = createFakeScanner();
        await addHarnessScannerKey(ownerCtx(tenantId), { agentId: a.id, publicKey: scanner.publicKeyHex });
        return { agentId: a.id, scanner };
    };
    Object.assign(seeded[tenantId], {
        scannerA: await keyed(`Scanner A ${tenantId}`),
        scannerB: await keyed(`Scanner B ${tenantId}`),
        targetAgentId: (await agent(`Reporting agent ${tenantId}`)).id,
        doomedAgentId: (await agent(`Doomed agent ${tenantId}`)).id,
        atBarAgentId: (await agent(`At-bar agent ${tenantId}`)).id,
    });
}

/** Evidenced verdicts for every criterion up to and including `level`. */
function verdictsThrough(level: HarnessLevel): CriterionVerdict[] {
    return HARNESS_LEVELS.slice(1, rungOf(level) + 1).flatMap((l) =>
        (HARNESS_CRITERIA[l] as readonly HarnessCriterionId[]).map((criterion) => ({
            criterion,
            met: true,
            evidence: `https://evidence.example/${criterion}`,
        })),
    );
}

function reportAgent(
    discoveredId: string,
    level: HarnessLevel,
    opts: { registeredAgentId?: string | null; write?: boolean; verdicts?: CriterionVerdict[] } = {},
): HarnessReportAgentV2 {
    return {
        discoveredId,
        discoveredVia: ['entra-sp'],
        registeredAgentId: opts.registeredAgentId ?? null,
        owner: { kind: 'user', id: OWNER_REF_CANARY, source: 'entra-owner-tag' },
        credentials: [{ ref: CREDENTIAL_REF, ageDays: 3, expires: true, boundToAgent: true, grant: 'delegated' }],
        tools: [
            { server: TOOL_SERVER_CANARY, name: 'do_thing', manifestHash: HASH, pinned: true, readOnlyHint: opts.write ? false : true },
        ],
        skills: [],
        verdicts: opts.verdicts ?? verdictsThrough(level),
    };
}

type Source = HarnessReportBodyV2['population']['sources'][number];
const ALL_COMPLETE: Source[] = [
    { kind: 'entra-sp', status: 'COMPLETE', rows: 10 },
    { kind: 'vault', status: 'COMPLETE', rows: 4 },
    { kind: 'mcp', status: 'COMPLETE', rows: 2 },
];

function body(
    scannerAgentId: string,
    scanRef: string,
    asOf: string,
    agents: HarnessReportAgentV2[],
    sources: Source[] = ALL_COMPLETE,
): HarnessReportBodyV2 {
    const b = validReportBody();
    b.scan = { id: scanRef, asOf, scanner: { ...b.scan.scanner, agentId: scannerAgentId } };
    b.population = { sources };
    b.agents = agents;
    b.findings = [];
    return b;
}

const ingest = (tenantId: string, which: 'A' | 'B', b: HarnessReportBodyV2) => {
    const s = which === 'A' ? seeded[tenantId].scannerA : seeded[tenantId].scannerB;
    return ingestHarnessReport(ownerCtx(tenantId), s.scanner.serialise(b));
};

const sectionOf = (view: HarnessMatrixView, scannerAgentId: string): HarnessScannerSection => {
    const s = view.sections.find((x) => x.scannerAgentId === scannerAgentId);
    if (!s) throw new Error(`no section for ${scannerAgentId}`);
    return s;
};
const rowOf = (section: HarnessScannerSection, discoveredId: string) => {
    const r = section.rows.find((x) => x.discoveredId === discoveredId);
    if (!r) throw new Error(`no row for ${discoveredId}`);
    return r;
};

/**
 * T1's estate, ingested once for every describe that reads it, so each block
 * runs alone (`-t`) as well as in sequence.
 */
async function ingestT1Estate(): Promise<void> {
    const s = seeded[T1];
    const A = s.scannerA.agentId;
    // A1: the baseline. Every source read in full.
    await ingest(T1, 'A', body(A, 't1-a1', '2026-10-01T03:00:00.000Z', [
        reportAgent('entra:sp:target', 'H3', { registeredAgentId: s.targetAgentId, write: true }),
        reportAgent('entra:sp:shadow-1', 'H0', { write: true }),
        reportAgent('entra:sp:doomed', 'H2', { registeredAgentId: s.doomedAgentId }),
    ]));
    // A2: the latest. The target fell a rung, a newcomer appeared (reporting
    // one criterion twice, contradictorily), mcp went incomplete, vault went
    // unreported.
    await ingest(T1, 'A', body(A, 't1-a2', '2026-10-10T03:00:00.000Z', [
        reportAgent('entra:sp:target', 'H2', { registeredAgentId: s.targetAgentId, write: true }),
        reportAgent('entra:sp:shadow-1', 'H0', { write: true }),
        reportAgent('entra:sp:doomed', 'H2', { registeredAgentId: s.doomedAgentId }),
        reportAgent('entra:sp:new-1', 'H1', {
            verdicts: [
                ...verdictsThrough('H1'),
                { criterion: 'H1.registered', met: false, evidence: null },
            ],
        }),
    ], [
        { kind: 'entra-sp', status: 'COMPLETE', rows: 11 },
        { kind: 'mcp', status: 'INCOMPLETE', reason: 'TIME_BOX', rows: 1 },
    ]));
    // B1: a second scanner that sees an agent A never does.
    await ingest(T1, 'B', body(s.scannerB.agentId, 't1-b1', '2026-10-08T03:00:00.000Z', [
        reportAgent('entra:sp:only-b', 'H1'),
    ]));
}

beforeAll(async () => {
    await clearOwnRows();
    for (const t of ALL_TENANTS) await seedTenant(t);
    await ingestT1Estate();
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('the gate', () => {
    it('refuses a principal holding neither inventory key before reading anything', async () => {
        const admin = getPermissionsForRole('ADMIN');
        const ctx = makeRequestContext('ADMIN', {
            tenantId: T1,
            tenantSlug: T1,
            userId: seeded[T1].ownerUserId,
            appPermissions: {
                ...admin,
                admin: { ...admin.admin, agent_registry: false, agent_registry_view: false },
            },
        });
        await expect(getHarnessMatrix(ctx)).rejects.toThrow(/admin\.agent_registry_view/);
    });
});

describe('no scan at all is a finding, not an empty estate', () => {
    it('returns no scans, no sections, and a shadow list that cannot be read as "none"', async () => {
        const view = await getHarnessMatrix(ownerCtx(T2));
        expect(view.scans).toEqual({ rows: [], truncated: false });
        expect(view.sections).toEqual([]);
        expect(view.shadow).toEqual({ rows: [], truncated: false, basis: 'NOT_EVIDENCED', basisAsOf: null });
        expect(view.acceptances).toEqual({ rows: [], truncated: false });
        // Both trusted scanners are named as having sent nothing.
        expect(view.scannersWithoutScan.truncated).toBe(false);
        expect(view.scannersWithoutScan.rows.map((r) => r.name).sort()).toEqual([`Scanner A ${T2}`, `Scanner B ${T2}`]);
    });
});

describe('latest, previous and drift — per scanner, by asOf', () => {
    let A: string;
    let B: string;

    beforeAll(() => {
        A = seeded[T1].scannerA.agentId;
        B = seeded[T1].scannerB.agentId;
    });

    it('the latest scan per scanner is the newest asOf, and its baseline is the same scanner\'s previous', async () => {
        const view = await getHarnessMatrix(ownerCtx(T1));
        expect(view.scans.rows.map((r) => r.scanRef)).toEqual(['t1-a2', 't1-b1', 't1-a1']);
        expect(view.sections.map((s) => s.latest.scanRef)).toEqual(['t1-a2', 't1-b1']);
        const a = sectionOf(view, A);
        expect(a.previous?.scanRef).toBe('t1-a1');
        expect(a.baseline).toBe('PREVIOUS_SCAN');
        expect(a.scannerName).toBe(`Scanner A ${T1}`);
        const b = sectionOf(view, B);
        expect(b.previous).toBeNull();
        expect(b.baseline).toBe('FIRST_SCAN');
        expect(b.drift).toBeNull();
        expect(b.driftUnavailableReason).toBe('FIRST_SCAN');
    });

    it('drift states the drop, the newcomer and the lost source coverage — from stored rows', async () => {
        const drift = sectionOf(await getHarnessMatrix(ownerCtx(T1)), A).drift;
        expect(drift).not.toBeNull();
        expect(drift?.baselineScanRef).toBe('t1-a1');
        expect(drift?.baselineCompleteness).toBe('COMPLETE');
        expect(drift?.levelDrops.map((d) => [d.discoveredId, d.from, d.to])).toEqual([['entra:sp:target', 'H3', 'H2']]);
        expect(drift?.newlySeen.map((n) => n.discoveredId)).toEqual(['entra:sp:new-1']);
        expect(drift?.sourcesGoneIncomplete).toEqual([{ kind: 'mcp', reason: 'TIME_BOX' }]);
        expect(drift?.sourcesDropped).toEqual(['vault']);
    });

    it('never compares two scanners: B\'s agent is not "newly seen" in A\'s drift', async () => {
        const view = await getHarnessMatrix(ownerCtx(T1));
        const a = sectionOf(view, A);
        expect(a.drift?.newlySeen.map((n) => n.discoveredId)).not.toContain('entra:sp:only-b');
        expect(a.rows.map((r) => r.discoveredId)).not.toContain('entra:sp:only-b');
        expect(sectionOf(view, B).rows.map((r) => r.discoveredId)).toEqual(['entra:sp:only-b']);
    });

    it('a window too small to hold the baseline says so, rather than calling it a first scan', async () => {
        const view = await getHarnessMatrix(ownerCtx(T1), { scanWindow: 2 });
        expect(view.scans.truncated).toBe(true);
        expect(view.scans.rows).toHaveLength(2);
        const a = sectionOf(view, A);
        expect(a.baseline).toBe('OUTSIDE_WINDOW');
        expect(a.drift).toBeNull();
        expect(a.driftUnavailableReason).toBe('OUTSIDE_WINDOW');
    });

    it('an incomplete latest scan reads INCOMPLETE; a complete non-empty one COMPLETE', async () => {
        const view = await getHarnessMatrix(ownerCtx(T1));
        expect(sectionOf(view, A).latest.completeness).toBe('INCOMPLETE');
        expect(sectionOf(view, B).latest.completeness).toBe('COMPLETE');
        // B's complete scan says nothing about the sources A could not read,
        // so an empty shadow list could NOT be read as "none".
        expect(view.shadow.basis).toBe('NOT_EVIDENCED');
        expect(view.shadow.basisAsOf).toBeNull();
        expect(view.scannersWithoutScan.rows).toEqual([]);
    });

    it('rows are worst rung first, and carry the collapsed verdicts — one per criterion, the least favourable', async () => {
        const a = sectionOf(await getHarnessMatrix(ownerCtx(T1)), A);
        // H0 before H2; within a rung, below-bar first (all are here: the
        // read-only ones have UNKNOWN reach because mcp was not read in full),
        // then by discovered id.
        expect(a.rows.map((r) => r.discoveredId)).toEqual([
            'entra:sp:new-1',
            'entra:sp:shadow-1',
            'entra:sp:doomed',
            'entra:sp:target',
        ]);
        const newcomer = rowOf(a, 'entra:sp:new-1');
        const registered = newcomer.verdicts.filter((v) => v.criterion === 'H1.registered');
        expect(registered).toEqual([{ criterion: 'H1.registered', met: false, evidence: null }]);
        expect(newcomer.verdicts).toHaveLength(HARNESS_CRITERIA.H1.length);
        // ...and the level the ingest stored agrees: the contradiction cost H1.
        expect(newcomer.level).toBe('H0');
        expect(newcomer.verdictsUnreadable).toBe(false);
    });

    it('a row carries the scan item\'s reading, its bar and whether it is short of it', async () => {
        const a = sectionOf(await getHarnessMatrix(ownerCtx(T1)), A);
        const target = rowOf(a, 'entra:sp:target');
        expect(target).toMatchObject({
            level: 'H2',
            reach: 'WRITE_OR_EXTERNAL',
            bar: 'H3',
            belowBar: true,
            registered: { agentId: seeded[T1].targetAgentId, name: `Reporting agent ${T1}` },
            latestIngestedLevel: null,
        });
        expect(rowOf(a, 'entra:sp:shadow-1').registered).toBeNull();
    });

    it('the view crosses the server/client boundary unchanged', async () => {
        const view = await getHarnessMatrix(ownerCtx(T1));
        expect(JSON.parse(JSON.stringify(view))).toEqual(view);
    });

    it('a backfilled older report ingested LAST does not become latest, and the row says a later-received scan disagrees', async () => {
        const s = seeded[T1];
        // Describes 10-05 — between A1 and A2 — and arrives after both.
        await ingest(T1, 'A', body(A, 't1-a3-backfill', '2026-10-05T03:00:00.000Z', [
            reportAgent('entra:sp:target', 'H4', { registeredAgentId: s.targetAgentId, write: true }),
        ]));
        const a = sectionOf(await getHarnessMatrix(ownerCtx(T1)), A);
        expect(a.latest.scanRef).toBe('t1-a2');
        expect(a.previous?.scanRef).toBe('t1-a3-backfill');
        const target = rowOf(a, 'entra:sp:target');
        expect(target.level).toBe('H2');
        // The acceptance usecase reads the latest INGESTED level; the row names it.
        expect(target.latestIngestedLevel).toBe('H4');
        expect(target.acceptAffordance).toBe('NONE');
    });
});

describe('stored JSON that does not re-validate fails CLOSED', () => {
    it('unreadable sources make the scan INCOMPLETE with sources null', async () => {
        const scan = await prisma.agentHarnessScan.findFirstOrThrow({ where: { tenantId: T1, scanRef: 't1-b1' } });
        await prisma.agentHarnessScan.update({
            where: { id: scan.id },
            data: { sourcesJson: [{ kind: 'entra-sp', status: 'COMPLETE', rows: 1, unknownMember: true }] },
        });
        try {
            const view = await getHarnessMatrix(ownerCtx(T1));
            const row = view.scans.rows.find((r) => r.id === scan.id);
            expect(row?.sources).toBeNull();
            expect(row?.completeness).toBe('INCOMPLETE');
            expect(view.shadow.basis).toBe('NOT_EVIDENCED');
        } finally {
            await prisma.agentHarnessScan.update({ where: { id: scan.id }, data: { sourcesJson: scan.sourcesJson ?? [] } });
        }
    });

    it('unreadable verdicts render every criterion unanswered', async () => {
        const scan = await prisma.agentHarnessScan.findFirstOrThrow({ where: { tenantId: T1, scanRef: 't1-b1' } });
        const item = await prisma.agentHarnessScanItem.findFirstOrThrow({ where: { tenantId: T1, scanId: scan.id } });
        await prisma.agentHarnessScanItem.update({
            where: { id: item.id },
            data: { verdictsJson: [{ criterion: 'H9.made_up', met: true, evidence: 'x' }] },
        });
        try {
            const b = sectionOf(await getHarnessMatrix(ownerCtx(T1)), seeded[T1].scannerB.agentId);
            const row = rowOf(b, 'entra:sp:only-b');
            expect(row.verdictsUnreadable).toBe(true);
            expect(row.verdicts).toEqual([]);
        } finally {
            await prisma.agentHarnessScanItem.update({ where: { id: item.id }, data: { verdictsJson: item.verdictsJson ?? [] } });
        }
    });
});

describe('the shadow list', () => {
    it('holds the never-registered agents, and a register row deleted after the scan linked it', async () => {
        await prisma.registeredAgent.update({ where: { id: seeded[T1].doomedAgentId }, data: { deletedAt: new Date() } });
        const view = await getHarnessMatrix(ownerCtx(T1));
        const reasons = Object.fromEntries(view.shadow.rows.map((r) => [r.discoveredId, r.reason]));
        expect(reasons).toEqual({
            'entra:sp:shadow-1': 'UNREGISTERED',
            'entra:sp:new-1': 'UNREGISTERED',
            'entra:sp:only-b': 'UNREGISTERED',
            'entra:sp:doomed': 'REGISTER_ROW_DELETED',
        });
        // The matrix row agrees: a deleted register row is no registration.
        expect(rowOf(sectionOf(view, seeded[T1].scannerA.agentId), 'entra:sp:doomed').registered).toBeNull();
    });
});

describe('isolation', () => {
    it('another tenant\'s view names none of this tenant\'s rows', async () => {
        const t1 = await getHarnessMatrix(ownerCtx(T1));
        const t2 = JSON.stringify(await getHarnessMatrix(ownerCtx(T2)));
        const ids = [
            ...t1.scans.rows.map((r) => r.id),
            ...t1.sections.flatMap((s) => s.rows.map((r) => r.discoveredAgentId)),
            ...t1.shadow.rows.map((r) => r.discoveredAgentId),
        ];
        expect(ids.length).toBeGreaterThan(5);
        for (const id of ids) expect(t2).not.toContain(id);
    });
});

describe('zero is never complete', () => {
    it('an all-COMPLETE report with no agents reads EMPTY and has no rows', async () => {
        await ingest(T2, 'A', body(seeded[T2].scannerA.agentId, 't2-empty', '2026-10-12T03:00:00.000Z', []));
        const view = await getHarnessMatrix(ownerCtx(T2));
        const section = sectionOf(view, seeded[T2].scannerA.agentId);
        expect(section.latest.completeness).toBe('EMPTY');
        expect(section.rows).toEqual([]);
        expect(section.rowsTruncated).toBe(false);
        // An empty scan evidences nothing, so an empty shadow list is unstated.
        expect(view.shadow.basis).toBe('NOT_EVIDENCED');
        expect(section.rowsUnread).toBe(false);
    });
});

describe('the accept affordance is the owner\'s, and the acceptances card is the calendar\'s population', () => {
    let A: string;
    let targetDiscoveredAgentId: string;

    beforeAll(async () => {
        A = seeded[T3].scannerA.agentId;
        const s = seeded[T3];
        await ingest(T3, 'A', body(A, 't3-a1', '2026-10-15T03:00:00.000Z', [
            reportAgent('entra:sp:target', 'H2', { registeredAgentId: s.targetAgentId, write: true }),
            reportAgent('entra:sp:shadow-1', 'H0', { write: true }),
            reportAgent('entra:sp:at-bar', 'H3', { registeredAgentId: s.atBarAgentId, write: true }),
            reportAgent('entra:sp:doomed', 'H1', { registeredAgentId: s.doomedAgentId, write: true }),
        ]));
        targetDiscoveredAgentId = (
            await prisma.discoveredAgent.findFirstOrThrow({ where: { tenantId: T3, discoveredId: 'entra:sp:target' } })
        ).id;
    });

    it('offers ACCEPT to the owner only; another admin gets a note; shadow and at-bar agents get what they get', async () => {
        const mine = sectionOf(await getHarnessMatrix(ownerCtx(T3)), A);
        const theirs = sectionOf(await getHarnessMatrix(otherAdminCtx(T3)), A);
        expect(rowOf(mine, 'entra:sp:target').acceptAffordance).toBe('ACCEPT');
        expect(rowOf(theirs, 'entra:sp:target').acceptAffordance).toBe('OWNER_ONLY');
        expect(rowOf(mine, 'entra:sp:shadow-1').acceptAffordance).toBe('REGISTER_FIRST');
        expect(rowOf(mine, 'entra:sp:at-bar').acceptAffordance).toBe('NONE');
        expect(rowOf(mine, 'entra:sp:target').acceptance).toBeNull();
    });

    it('after the owner accepts: RENEW, the expiry on the row, and a card row with the calendar\'s anchor key', async () => {
        const expiresAt = new Date(Date.now() + 30 * 86_400_000);
        const accepted = await acceptHarnessShortfall(ownerCtx(T3), {
            discoveredAgentId: targetDiscoveredAgentId,
            justification: JUSTIFICATION_CANARY,
            expiresAt: expiresAt.toISOString(),
        });
        const view = await getHarnessMatrix(ownerCtx(T3));
        const row = rowOf(sectionOf(view, A), 'entra:sp:target');
        expect(row.acceptAffordance).toBe('RENEW');
        expect(row.acceptance).toEqual({
            id: accepted.id,
            expiresAt: accepted.expiresAt.toISOString(),
            acceptedLevel: 'H2',
            renewal: false,
        });
        expect(view.acceptances.rows).toEqual([
            {
                id: accepted.id,
                discoveredAgentId: targetDiscoveredAgentId,
                agentLabel: `Reporting agent ${T3}`,
                acceptedLevel: 'H2',
                expiresAt: accepted.expiresAt.toISOString(),
                inForce: true,
                acceptAffordance: 'RENEW',
            },
        ]);
        // Another admin sees the expiry, and still no action — on the matrix
        // row AND on the acceptances card, which is computed separately.
        const theirView = await getHarnessMatrix(otherAdminCtx(T3));
        const theirs = rowOf(sectionOf(theirView, A), 'entra:sp:target');
        expect(theirs.acceptance?.id).toBe(accepted.id);
        expect(theirs.acceptAffordance).toBe('OWNER_ONLY');
        expect(theirView.acceptances.rows.map((a) => [a.id, a.inForce, a.acceptAffordance])).toEqual([
            [accepted.id, true, 'OWNER_ONLY'],
        ]);
    });

    it('the owner of the agent, holding only the view key, reads the matrix and is offered nothing', async () => {
        const accepted = await ensureAcceptance();
        const owner = getPermissionsForRole('OWNER');
        const viewOnly = makeRequestContext('OWNER', {
            tenantId: T3,
            tenantSlug: T3,
            userId: seeded[T3].ownerUserId,
            appPermissions: { ...owner, admin: { ...owner.admin, agent_registry: false } },
        });
        const view = await getHarnessMatrix(viewOnly);
        // The same rows the owner is offered ACCEPT / RENEW / REGISTER_FIRST on.
        const section = sectionOf(view, A);
        expect(rowOf(section, 'entra:sp:target').acceptance?.id).toBe(accepted.id);
        expect(section.rows.map((r) => r.acceptAffordance).filter((a) => a !== 'NONE')).toEqual([]);
        expect(view.acceptances.rows.map((a) => [a.id, a.acceptAffordance])).toEqual([[accepted.id, 'NONE']]);
    });

    /** The acceptance still on the clock, recorded here if no earlier test did, so each test runs alone. */
    async function ensureAcceptance(): Promise<{ id: string; expiresAt: Date }> {
        const onClock = (await listHarnessAcceptances(ownerCtx(T3), targetDiscoveredAgentId)).find(
            (a) => a.revokedAt === null && a.expiryProcessedAt === null,
        );
        if (onClock) return onClock;
        return acceptHarnessShortfall(ownerCtx(T3), {
            discoveredAgentId: targetDiscoveredAgentId,
            justification: JUSTIFICATION_CANARY,
            expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        });
    }

    it('a lapsed acceptance the monitor has not handled stays on the card as lapsed; a handled one leaves it', async () => {
        const row = await ensureAcceptance();
        const later = new Date(row.expiresAt.getTime() + 86_400_000);

        const lapsed = await getHarnessMatrix(ownerCtx(T3), { now: later });
        expect(lapsed.acceptances.rows.map((a) => [a.id, a.inForce, a.acceptAffordance])).toEqual([
            [row.id, false, 'ACCEPT'],
        ]);
        expect(rowOf(sectionOf(lapsed, A), 'entra:sp:target').acceptance).toBeNull();

        await reopenExpiredHarnessAcceptances(prisma, later, T3);
        const handled = await getHarnessMatrix(ownerCtx(T3), { now: later });
        expect(handled.acceptances.rows).toEqual([]);
    });

    it('a register row deleted after the scan sends the owner to register it again', async () => {
        await prisma.registeredAgent.update({ where: { id: seeded[T3].doomedAgentId }, data: { deletedAt: new Date() } });
        const row = rowOf(sectionOf(await getHarnessMatrix(ownerCtx(T3)), A), 'entra:sp:doomed');
        expect(row.registered).toBeNull();
        expect(row.acceptAffordance).toBe('REGISTER_FIRST');
    });

    it('the client payload carries no owner reference, tool address, justification or user id', async () => {
        // First prove each canary really is in its source row, so the absences
        // below are the projection working rather than the canary missing.
        const da = await prisma.discoveredAgent.findFirstOrThrow({ where: { tenantId: T3, discoveredId: 'entra:sp:target' } });
        expect(da.ownerRef).toBe(OWNER_REF_CANARY);
        const item = await prisma.agentHarnessScanItem.findFirstOrThrow({ where: { tenantId: T3, discoveredAgentId: da.id } });
        expect(JSON.stringify(item.toolsJson)).toContain(TOOL_SERVER_CANARY);
        // Through the usecase, so the encrypted justification reads as written.
        const { id } = await ensureAcceptance();
        const acceptance = (await listHarnessAcceptances(ownerCtx(T3), da.id)).find((a) => a.id === id);
        expect(acceptance?.justification).toContain('Canary justification 3687');
        expect(acceptance?.acceptedByUserId).toBe(seeded[T3].ownerUserId);

        const payload = JSON.stringify(await getHarnessMatrix(ownerCtx(T3)));
        for (const canary of [
            OWNER_REF_CANARY,
            TOOL_SERVER_CANARY,
            'Canary justification 3687',
            seeded[T3].ownerUserId,
            seeded[T3].otherUserId,
        ]) {
            expect(payload).not.toContain(canary);
        }
    });
});

describe('the scanner-key register the tab lists (#3687)', () => {
    it('lists every key — a revoked one with its day — and carries no user id and no key bytes', async () => {
        const stored = await prisma.agentHarnessScannerKey.findMany({
            where: { tenantId: T2 },
            select: { id: true, agentId: true, publicKey: true, createdByUserId: true },
            orderBy: { createdAt: 'asc' },
        });
        expect(stored).toHaveLength(2);
        const [toRevoke, kept] = stored;
        await revokeHarnessScannerKey(ownerCtx(T2), { keyId: toRevoke.id });

        const view = await getHarnessScannerKeysView(ownerCtx(T2));
        expect(view.keys.truncated).toBe(false);
        expect(view.keys.rows.map((r) => r.id).sort()).toEqual(stored.map((k) => k.id).sort());
        const byId = new Map(view.keys.rows.map((r) => [r.id, r]));
        expect(byId.get(toRevoke.id)?.revokedAt).toEqual(expect.any(String));
        expect(byId.get(kept.id)?.revokedAt).toBeNull();
        const scannerNames = new Map([
            [seeded[T2].scannerA.agentId, `Scanner A ${T2}`],
            [seeded[T2].scannerB.agentId, `Scanner B ${T2}`],
        ]);
        for (const k of stored) expect(byId.get(k.id)?.agentName).toBe(scannerNames.get(k.agentId));

        // The row's whole shape — nothing about WHO, nothing of the key itself.
        for (const r of view.keys.rows) {
            expect(Object.keys(r).sort()).toEqual(['agentId', 'agentName', 'createdAt', 'id', 'keyFingerprint', 'revokedAt']);
        }
        const payload = JSON.stringify(view);
        expect(stored.every((k) => k.createdByUserId === seeded[T2].ownerUserId)).toBe(true);
        expect(payload).not.toContain(seeded[T2].ownerUserId);
        for (const k of stored) expect(payload).not.toContain(k.publicKey);
    });

    it('offers as candidates only the live, non-retired register rows the key usecase accepts', async () => {
        await prisma.registeredAgent.update({ where: { id: seeded[T2].atBarAgentId }, data: { status: 'RETIRED' } });
        await prisma.registeredAgent.update({ where: { id: seeded[T2].doomedAgentId }, data: { deletedAt: new Date() } });

        const names = (await getHarnessScannerKeysView(ownerCtx(T2))).candidates.rows.map((c) => c.name);
        expect(names).toContain(`Reporting agent ${T2}`);
        expect(names).toContain(`Scanner A ${T2}`);
        expect(names).not.toContain(`At-bar agent ${T2}`);
        expect(names).not.toContain(`Doomed agent ${T2}`);
        // …and the API agrees about the retired one, so the picker offers no refusal.
        const scanner = createFakeScanner();
        await expect(
            addHarnessScannerKey(ownerCtx(T2), { agentId: seeded[T2].atBarAgentId, publicKey: scanner.publicKeyHex }),
        ).rejects.toThrow(/retired/i);
    });

    it('another tenant\'s register is not listed', async () => {
        const mine = new Set((await getHarnessScannerKeysView(ownerCtx(T2))).keys.rows.map((r) => r.id));
        const theirs = (await getHarnessScannerKeysView(ownerCtx(T1))).keys.rows.map((r) => r.id);
        expect(mine.size).toBeGreaterThan(0);
        expect(theirs.length).toBeGreaterThan(0);
        expect(theirs.filter((id) => mine.has(id))).toEqual([]);
    });

    it('refuses a principal without admin.agent_registry', async () => {
        const admin = getPermissionsForRole('ADMIN');
        const ctx = makeRequestContext('ADMIN', {
            tenantId: T2,
            tenantSlug: T2,
            userId: seeded[T2].ownerUserId,
            appPermissions: { ...admin, admin: { ...admin.admin, agent_registry: false } },
        });
        await expect(getHarnessScannerKeysView(ctx)).rejects.toThrow(/admin\.agent_registry/);
    });
});

describe('the calendar projects the acceptances still on the clock, onto the tab\'s anchors (#3687)', () => {
    const DAY = 86_400_000;

    it('projects exactly the live acceptances on a live register row — every one an anchor on the card', async () => {
        const ctx = ownerCtx(T3);
        const da = async (discoveredId: string) =>
            (await prisma.discoveredAgent.findFirstOrThrow({ where: { tenantId: T3, discoveredId } })).id;
        const target = await da('entra:sp:target');
        const shadow = await da('entra:sp:shadow-1');
        const doomed = await da('entra:sp:doomed');

        // The owner's acceptance on the clock — recorded here if no earlier test left one.
        const onClock = (await listHarnessAcceptances(ctx, target)).find(
            (a) => a.revokedAt === null && a.expiryProcessedAt === null,
        );
        const liveId =
            onClock?.id ??
            (
                await acceptHarnessShortfall(ctx, {
                    discoveredAgentId: target,
                    justification: JUSTIFICATION_CANARY,
                    expiresAt: new Date(Date.now() + 30 * DAY).toISOString(),
                })
            ).id;

        // Rows the calendar must NOT project, written directly because no
        // usecase would write them: on a shadow agent, on a deleted register
        // row, revoked, and already handled by the expiry monitor.
        await prisma.registeredAgent.update({ where: { id: seeded[T3].doomedAgentId }, data: { deletedAt: new Date() } });
        const soon = new Date(Date.now() + 20 * DAY);
        const raw = (discoveredAgentId: string, extra: Record<string, unknown> = {}) =>
            prisma.agentHarnessAcceptance.create({
                data: {
                    tenantId: T3,
                    discoveredAgentId,
                    acceptedLevel: 'H1',
                    justification: 'A row the calendar must not project.',
                    acceptedByUserId: seeded[T3].ownerUserId,
                    expiresAt: soon,
                    ...extra,
                },
                select: { id: true },
            });
        const onShadow = await raw(shadow);
        const onDeleted = await raw(doomed);
        const revoked = await raw(target, { revokedAt: new Date(), revokedByUserId: seeded[T3].ownerUserId });
        const processed = await raw(target, { expiryProcessedAt: new Date() });

        const now = new Date();
        const res = await getComplianceCalendarEvents(ctx, {
            from: new Date(now.getTime() - DAY),
            to: new Date(now.getTime() + 400 * DAY),
            now,
            types: ['agent-harness-acceptance-expiry'],
        });
        expect(res.failedSources).toEqual([]);
        expect(res.omittedSources).not.toContain('agent-harness-acceptance');
        const ids = res.events.map((e) => e.entityId);
        expect(ids).toContain(liveId);
        for (const excluded of [onShadow, onDeleted, revoked, processed]) expect(ids).not.toContain(excluded.id);

        const event = res.events.find((e) => e.entityId === liveId)!;
        expect(event.href).toBe(`/t/${T3}/agents/reports?tab=harness#harness-acceptance-${target}`);
        expect(event.entityName).toBe(`Reporting agent ${T3}`);
        expect(event.title).toBe(`Harness acceptance expires: Reporting agent ${T3}`);
        expect(event.ownerUserId).toBe(seeded[T3].ownerUserId);
        expect(JSON.stringify(res.events)).not.toContain(OWNER_REF_CANARY);
        expect(JSON.stringify(res.events)).not.toContain('Canary justification 3687');

        // Every projected event's anchor is a row the acceptances card renders —
        // the card holds MORE (the shadow and deleted-row acceptances), never less.
        const cardRows = (await getHarnessMatrix(ctx)).acceptances.rows;
        const card = cardRows.map((a) => a.discoveredAgentId);
        for (const e of res.events) {
            expect(card).toContain(e.href.split('#harness-acceptance-')[1]);
        }
        expect(card).toEqual(expect.arrayContaining([shadow, doomed]));
        // A card row whose agent has no live register row sends the owner to
        // register it — never an accept the API would refuse as SHADOW.
        const affordance = new Map(cardRows.map((a) => [a.discoveredAgentId, a.acceptAffordance]));
        expect(affordance.get(shadow)).toBe('REGISTER_FIRST');
        expect(affordance.get(doomed)).toBe('REGISTER_FIRST');
        await expect(
            acceptHarnessShortfall(ctx, {
                discoveredAgentId: shadow,
                justification: JUSTIFICATION_CANARY,
                expiresAt: new Date(Date.now() + 10 * DAY).toISOString(),
            }),
        ).rejects.toThrow();
    });
});

describe('an empty shadow list reads as "none" only when EVERY trusted scanner has a complete latest scan', () => {
    it('walks the basis: one scanner silent, both complete, then one gone incomplete', async () => {
        const s = seeded[T4];
        const sendA = (ref: string, asOf: string, sources: Source[] = ALL_COMPLETE) =>
            ingest(T4, 'A', body(s.scannerA.agentId, ref, asOf, [reportAgent('entra:sp:t4-a', 'H3', { registeredAgentId: s.targetAgentId })], sources));
        const sendB = (ref: string, asOf: string, sources: Source[] = ALL_COMPLETE) =>
            ingest(T4, 'B', body(s.scannerB.agentId, ref, asOf, [reportAgent('entra:sp:t4-b', 'H3', { registeredAgentId: s.atBarAgentId })], sources));

        // A is complete; B holds a key and has sent nothing.
        await sendA('t4-a1', '2026-10-05T03:00:00.000Z');
        const silent = await getHarnessMatrix(ownerCtx(T4));
        expect(sectionOf(silent, s.scannerA.agentId).latest.completeness).toBe('COMPLETE');
        expect(silent.scannersWithoutScan.rows).toEqual([{ agentId: s.scannerB.agentId, name: `Scanner B ${T4}` }]);
        expect(silent.shadow).toMatchObject({ rows: [], basis: 'NOT_EVIDENCED', basisAsOf: null });

        // B reports, complete: now "none" holds — as of the OLDER of the two.
        await sendB('t4-b1', '2026-10-09T03:00:00.000Z');
        const both = await getHarnessMatrix(ownerCtx(T4));
        expect(both.scannersWithoutScan.rows).toEqual([]);
        expect(both.shadow).toMatchObject({ rows: [], basis: 'EVIDENCED', basisAsOf: '2026-10-05T03:00:00.000Z' });

        // A scanner that is not shown is not evidenced either.
        const oneShown = await getHarnessMatrix(ownerCtx(T4), { limits: { sections: 1 } });
        expect(oneShown.sections).toHaveLength(1);
        expect(oneShown.scannersNotShown).toBe(1);
        expect(oneShown.shadow.basis).toBe('NOT_EVIDENCED');

        // B's latest falls short of a source: A's complete scan does not cover it.
        await sendB('t4-b2', '2026-10-11T03:00:00.000Z', [
            { kind: 'entra-sp', status: 'COMPLETE', rows: 10 },
            { kind: 'vault', status: 'INCOMPLETE', reason: 'AUTH_FAILED', rows: 0 },
        ]);
        const gap = await getHarnessMatrix(ownerCtx(T4));
        expect(sectionOf(gap, s.scannerB.agentId).latest.completeness).toBe('INCOMPLETE');
        expect(gap.shadow).toMatchObject({ basis: 'NOT_EVIDENCED', basisAsOf: null });
    });
});

describe('every bound is stated, and rows are the worst of a WHOLE scan', () => {
    const A = () => seeded[T1].scannerA.agentId;
    const B = () => seeded[T1].scannerB.agentId;

    it('reads the latest scans whole even when they and the previous ones together exceed the bound', async () => {
        // T1's latest scans hold 4 + 1 agents; with A's previous scan the read
        // is larger than 5. The latest ones must not be cut for it.
        const view = await getHarnessMatrix(ownerCtx(T1), { limits: { items: 5 } });
        const a = sectionOf(view, A());
        expect(a.rowsUnread).toBe(false);
        expect(a.rowsTruncated).toBe(false);
        expect(a.rows.map((r) => r.discoveredId)).toEqual([
            'entra:sp:new-1',
            'entra:sp:shadow-1',
            'entra:sp:doomed',
            'entra:sp:target',
        ]);
        expect(sectionOf(view, B()).rowsUnread).toBe(false);
        expect(a.drift).not.toBeNull();
    });

    it('shows NO rows for a latest scan whose agents were not all read, and says so', async () => {
        const view = await getHarnessMatrix(ownerCtx(T1), { limits: { items: 4 } });
        const sections = [sectionOf(view, A()), sectionOf(view, B())];
        const unread = sections.filter((x) => x.rowsUnread);
        expect(unread).toHaveLength(1);
        for (const x of unread) {
            expect(x.rows).toEqual([]);
            // Not "showing 0 of N, worst first".
            expect(x.rowsTruncated).toBe(false);
        }
        for (const x of sections.filter((y) => !y.rowsUnread)) {
            expect(x.rows).toHaveLength(x.latest.agentCount);
        }
    });

    it('withholds drift, not rows, when the previous scan\'s agents could not all be read', async () => {
        const a = sectionOf(await getHarnessMatrix(ownerCtx(T1)), A());
        expect(a.previous).not.toBeNull();
        const previousId = a.previous!.id;
        const stored = await prisma.agentHarnessScan.findUniqueOrThrow({ where: { id: previousId }, select: { agentCount: true } });
        await prisma.agentHarnessScan.update({ where: { id: previousId }, data: { agentCount: stored.agentCount + 50 } });
        try {
            const after = sectionOf(await getHarnessMatrix(ownerCtx(T1)), A());
            expect(after.drift).toBeNull();
            expect(after.driftUnavailableReason).toBe('POPULATION_OVER_BOUND');
            expect(after.rowsUnread).toBe(false);
            expect(after.rows).toHaveLength(after.latest.agentCount);
        } finally {
            await prisma.agentHarnessScan.update({ where: { id: previousId }, data: { agentCount: stored.agentCount } });
        }
    });

    it('caps the rows at the worst N of the whole scan, and flags it', async () => {
        const a = sectionOf(await getHarnessMatrix(ownerCtx(T1), { limits: { rows: 2 } }), A());
        expect(a.rowsUnread).toBe(false);
        expect(a.rowsTruncated).toBe(true);
        expect(a.rows.map((r) => r.discoveredId)).toEqual(['entra:sp:new-1', 'entra:sp:shadow-1']);
    });

    it('counts the scanners it does not show, rather than dropping them', async () => {
        const view = await getHarnessMatrix(ownerCtx(T1), { limits: { sections: 1 } });
        expect(view.sections).toHaveLength(1);
        expect(view.scannersNotShown).toBe(1);
        // The hidden scanner's scans are still in the history.
        expect(new Set(view.scans.rows.map((r) => r.scannerAgentId))).toEqual(new Set([A(), B()]));
    });

    it('flags a shadow list and an acceptances card cut at their bound', async () => {
        const shadow = (await getHarnessMatrix(ownerCtx(T1), { limits: { shadow: 2 } })).shadow;
        expect(shadow.rows).toHaveLength(2);
        expect(shadow.truncated).toBe(true);
        expect((await getHarnessMatrix(ownerCtx(T1))).shadow.truncated).toBe(false);

        // Two acceptances on the clock, written directly (on shadow agents no
        // usecase would accept for), so the card has more than the bound.
        const shadows = await prisma.discoveredAgent.findMany({
            where: { tenantId: T1, discoveredId: { in: ['entra:sp:shadow-1', 'entra:sp:new-1'] } },
            select: { id: true },
        });
        expect(shadows).toHaveLength(2);
        const written = await Promise.all(
            shadows.map((d) =>
                prisma.agentHarnessAcceptance.create({
                    data: {
                        tenantId: T1,
                        discoveredAgentId: d.id,
                        acceptedLevel: 'H0',
                        justification: 'A row written only to exceed the card bound.',
                        acceptedByUserId: seeded[T1].ownerUserId,
                        expiresAt: new Date(Date.now() + 5 * 86_400_000),
                    },
                    select: { id: true },
                }),
            ),
        );
        try {
            const capped = (await getHarnessMatrix(ownerCtx(T1), { limits: { acceptances: 1 } })).acceptances;
            expect(capped.rows).toHaveLength(1);
            expect(capped.truncated).toBe(true);
            const whole = (await getHarnessMatrix(ownerCtx(T1))).acceptances;
            expect(whole.rows).toHaveLength(2);
            expect(whole.truncated).toBe(false);
        } finally {
            await prisma.agentHarnessAcceptance.deleteMany({ where: { id: { in: written.map((w) => w.id) } } });
        }
    });
});
