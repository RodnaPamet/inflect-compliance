/**
 * A month of harness scans becomes evidence — and an incomplete month is never
 * emitted as complete evidence (#3687).
 *
 * Every scan here goes through the real ingest (`ingestHarnessReport`, signed by
 * a fake scanner whose key the tenant registered), and every artefact through
 * the real emitter against a real database, because the properties pinned are
 * properties of rows:
 *
 *   1. STATUS IS COMPLETENESS. `APPROVED` (the status coverage counts) only when
 *      every scanner's LATEST scan of the month read all of its sources and
 *      found at least one agent; otherwise `NEEDS_REVIEW`, with the reason in
 *      the title and the body. That holds on create, on update, and against a
 *      hand-approval of an incomplete month — the emitter owns the status.
 *   2. ZERO IS NEVER COMPLETE. An all-COMPLETE report that found nobody, and a
 *      month with no scan at all, are both findings.
 *   3. OPT-IN. A tenant that never registered a scanner key gets no harness
 *      artefact: there is no capability to evidence.
 *   4. APPEND-ONLY. An artefact whose obligation is unmapped is withdrawn and its
 *      Evidence archived, never deleted.
 *   5. DPIA CONDITION 8. The body carries no owner reference, user id,
 *      justification, evidence pointer, credential reference, tool server
 *      address or agent name — each planted as a canary in its source row first.
 *   6. TS ⊆ CHECK. Every kind the code knows is one the migrated CHECK accepts.
 *   7. A SILENT SCANNER IS A GAP. A scanner holding a trusted key in the month
 *      that reported nothing makes the month INCOMPLETE, however complete the
 *      other scanners' scans are.
 *   8. A MONTH IS NOT CLOSED BY ITS LAST TICK. The scan sent after it, and a
 *      report backfilled into an older month, reach the artefact on a later
 *      tick (`reconcileClosedHarnessPeriods`), and an incomplete closed month
 *      found APPROVED is put back.
 *   9. ONE DIRECTION. The emitter demotes an unsafe approval and undoes its own
 *      demotion; a review decision — REJECTED, SUBMITTED, a sweep's
 *      NEEDS_REVIEW — stands, and every status it does change is audited.
 *
 * The scanners' keys are backdated to before every month here: a key
 * registered while the suite runs would post-date the months it evidences, and
 * the silent-scanner rule (7) would then never bite.
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
import { addHarnessScannerKey, revokeHarnessScannerKey } from '@/app-layer/usecases/agent-harness-scanner-keys';
import { acceptHarnessShortfall, listHarnessAcceptances } from '@/app-layer/usecases/agent-harness-acceptance';
import { getHarnessMatrix } from '@/app-layer/usecases/agent-harness-matrix';
import {
    emitAgenticEvidence,
    reconcileClosedHarnessPeriods,
    withdrawStaleAgenticEvidence,
} from '@/app-layer/usecases/agentic-evidence-emission';
import {
    AGENTIC_ARTEFACT_KINDS,
    ARTEFACT_KIND_HARNESS_SCANS,
    ASI_LIBRARY_URN,
    isPerAgentKind,
} from '@/lib/agentic/evidence-artefact';
import { isCoverageQualifyingEvidence } from '@/lib/compliance/coverage-evidence';
import type { HarnessReportAgentV1, HarnessReportBodyV1 } from '@/lib/agentic/harness-contract';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(180_000);

const T = 'harness-evidence-tenant';
/** Holds ASI10/ASI03 controls and never registers a scanner key. */
const T_NO_KEY = 'harness-evidence-no-key';
/** Registered a scanner key once, and revoked it. */
const T_REVOKED = 'harness-evidence-revoked';
const ALL_TENANTS = [T, T_NO_KEY, T_REVOKED];
const FRAMEWORK_KEY = 'TEST-ASI-HARNESS-REPRESENTATION';

/** A fixed month, so nothing depends on when the suite runs. */
const AS_OF = new Date('2026-09-28T12:00:00.000Z');
const IN_MONTH = (day: number) => new Date(Date.UTC(2026, 8, day, 3, 0, 0)).toISOString();
/** A month in which no scan is ingested. */
const EMPTY_MONTH = new Date('2026-07-15T12:00:00.000Z');
/** Before every month the suite evidences: when the scanners' keys are dated. */
const KEYS_REGISTERED = new Date('2026-06-01T00:00:00.000Z');

// Canaries — each reaches its source row and must never reach Evidence.
const OWNER_REF_CANARY = 'usr_canary_evidence_owner_ref_3687';
const POINTER_CANARY = 'https://evidence-pointer-canary-3687.example/proof';
const CREDENTIAL_CANARY = 'kv://credential-ref-canary-3687';
const TOOL_SERVER_CANARY = 'https://tool-server-canary-3687.example/mcp';
const JUSTIFICATION_CANARY = 'Justification canary 3687: compensating weekly review until the credential is bound.';
const AGENT_NAME_CANARY = 'Agent name canary 3687';
const DISCOVERED_ID_CANARY = 'entra:sp:discovered-id-canary-3687';
const HASH = `sha256:${'c'.repeat(64)}`;

const seeded: {
    ownerUserId: string;
    noKeyOwnerUserId: string;
    revokedOwnerUserId: string;
    scannerA: { agentId: string; scanner: FakeScanner };
    scannerB: { agentId: string; scanner: FakeScanner };
    targetAgentId: string;
    controls: Record<'ASI10' | 'ASI03', string>;
} = {} as never;

const ownerCtx = (): RequestContext =>
    makeRequestContext('OWNER', { tenantId: T, tenantSlug: T, userId: seeded.ownerUserId });
const noKeyCtx = (): RequestContext =>
    makeRequestContext('OWNER', { tenantId: T_NO_KEY, tenantSlug: T_NO_KEY, userId: seeded.noKeyOwnerUserId });
const revokedCtx = (): RequestContext =>
    makeRequestContext('OWNER', { tenantId: T_REVOKED, tenantSlug: T_REVOKED, userId: seeded.revokedOwnerUserId });

const emails = [`owner@${T}.test`, `owner@${T_NO_KEY}.test`, `owner@${T_REVOKED}.test`];

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: ALL_TENANTS } };
    await prisma.agenticEvidenceArtefact.deleteMany({ where: t });
    await prisma.evidenceControlLink.deleteMany({ where: t });
    await prisma.evidence.deleteMany({ where: t });
    await prisma.agentHarnessAcceptance.deleteMany({ where: t });
    await prisma.agentHarnessScanItem.deleteMany({ where: t });
    await prisma.agentHarnessScan.deleteMany({ where: t });
    await prisma.discoveredAgent.deleteMany({ where: t });
    await prisma.agentHarnessScannerKey.deleteMany({ where: t });
    await prisma.finding.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await prisma.controlRequirementLink.deleteMany({ where: t });
    await prisma.control.deleteMany({ where: t });
    await prisma.frameworkRequirement.deleteMany({ where: { framework: { key: FRAMEWORK_KEY } } });
    await prisma.framework.deleteMany({ where: { key: FRAMEWORK_KEY } });
    await deleteAuditRowsForTenants(prisma, ALL_TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, ALL_TENANTS);
    });
    await prisma.user.deleteMany({ where: { emailHash: { in: emails.map(hashForLookup) } } });
    await prisma.tenant.deleteMany({ where: { id: { in: ALL_TENANTS } } });
}

async function member(tenantId: string, email: string): Promise<string> {
    const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await prisma.tenantMembership.create({
        data: { tenantId, userId: user.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
    return user.id;
}

/**
 * The framework carries the shipped `sourceUrn` under a key of its own — the
 * emitter resolves by family, so this is the case it must survive, not a
 * shortcut around the seed.
 */
async function installControls(): Promise<void> {
    const framework = await prisma.framework.create({
        data: {
            key: FRAMEWORK_KEY,
            name: 'OWASP Agentic AI Top 10',
            version: '1.0',
            kind: 'INDUSTRY_STANDARD',
            sourceUrn: ASI_LIBRARY_URN,
        },
    });
    const controls = {} as Record<'ASI10' | 'ASI03', string>;
    for (const [code, title] of [
        ['ASI10', 'Rogue Agents'],
        ['ASI03', 'Identity and Privilege Abuse'],
    ] as const) {
        const requirement = await prisma.frameworkRequirement.create({
            data: { frameworkId: framework.id, code, title },
        });
        for (const tenantId of ALL_TENANTS) {
            const control = await prisma.control.create({
                data: { tenantId, code: `CTL-${code}`, name: `Control for ${code}`, status: 'IMPLEMENTED' },
            });
            await prisma.controlRequirementLink.create({
                data: { tenantId, controlId: control.id, requirementId: requirement.id },
            });
            if (tenantId === T) controls[code] = control.id;
        }
    }
    seeded.controls = controls;
}

async function registeredAgent(name: string, ctx: RequestContext = ownerCtx()): Promise<string> {
    const aiSystem = await prisma.aiSystem.create({
        data: { tenantId: ctx.tenantId, name: `Host of ${name}`, ownerUserId: ctx.userId },
    });
    const agent = await createRegisteredAgent(ctx, {
        aiSystemId: aiSystem.id,
        name,
        autonomyLevel: 2,
        dataAccessScope: 'READ_TENANT_DATA',
        reversibility: 'COMPENSABLE',
        provenance: 'FIRST_PARTY',
        ownerUserId: ctx.userId,
    });
    return agent.id;
}

async function keyedScanner(name: string, ctx: RequestContext = ownerCtx()): Promise<{ agentId: string; scanner: FakeScanner }> {
    const agentId = await registeredAgent(name, ctx);
    const scanner = createFakeScanner();
    const key = await addHarnessScannerKey(ctx, { agentId, publicKey: scanner.publicKeyHex });
    await prisma.agentHarnessScannerKey.update({ where: { id: key.id }, data: { createdAt: KEYS_REGISTERED } });
    return { agentId, scanner };
}

/** Run `body` with scanner B's key revoked as of `at`, restoring it after. */
async function withScannerBRevokedAt<R>(at: Date, run: () => Promise<R>): Promise<R> {
    const where = { tenantId: T, agentId: seeded.scannerB.agentId };
    await prisma.agentHarnessScannerKey.updateMany({ where, data: { revokedAt: at, revokedByUserId: seeded.ownerUserId } });
    try {
        return await run();
    } finally {
        await prisma.agentHarnessScannerKey.updateMany({ where, data: { revokedAt: null, revokedByUserId: null } });
    }
}

/** The audit rows recording an Evidence status the emitter changed. */
async function statusChangesOf(evidenceId: string) {
    return prisma.auditLog.findMany({
        where: { tenantId: T, entity: 'Evidence', entityId: evidenceId, action: 'STATUS_CHANGE' },
        select: { detailsJson: true },
        orderBy: { createdAt: 'asc' },
    });
}

/** One agent of a report, carrying every canary the DPIA case looks for. */
function reportAgent(discoveredId: string, opts: { registeredAgentId?: string | null } = {}): HarnessReportAgentV1 {
    return {
        discoveredId,
        discoveredVia: ['entra-sp'],
        registeredAgentId: opts.registeredAgentId ?? null,
        owner: { kind: 'user', id: OWNER_REF_CANARY, source: 'entra-owner-tag' },
        credentials: [{ ref: CREDENTIAL_CANARY, ageDays: 3, expires: true, boundToAgent: true, grant: 'delegated' }],
        tools: [{ server: TOOL_SERVER_CANARY, name: 'update_record', manifestHash: HASH, pinned: true, readOnlyHint: false }],
        skills: [],
        // H1 with a write tool: below the report-only bar, so it can be accepted.
        verdicts: [
            { criterion: 'H1.registered', met: true, evidence: POINTER_CANARY },
            { criterion: 'H1.owner', met: true, evidence: POINTER_CANARY },
            { criterion: 'H1.axes_declared', met: true, evidence: POINTER_CANARY },
            { criterion: 'H1.tier_scored_fresh', met: true, evidence: POINTER_CANARY },
        ],
    };
}

type Source = HarnessReportBodyV1['population']['sources'][number];
const ALL_COMPLETE: Source[] = [
    { kind: 'entra-sp', status: 'COMPLETE', rows: 10 },
    { kind: 'mcp', status: 'COMPLETE', rows: 2 },
];
const MCP_INCOMPLETE: Source[] = [
    { kind: 'entra-sp', status: 'COMPLETE', rows: 10 },
    { kind: 'mcp', status: 'INCOMPLETE', reason: 'TIME_BOX', rows: 1 },
];

function body(
    scannerAgentId: string,
    scanRef: string,
    asOf: string,
    agents: HarnessReportAgentV1[],
    sources: Source[] = ALL_COMPLETE,
): HarnessReportBodyV1 {
    const b = validReportBody();
    b.scan = { id: scanRef, asOf, scanner: { ...b.scan.scanner, agentId: scannerAgentId } };
    b.population = { sources };
    b.agents = agents;
    b.findings = [];
    return b;
}

/** A report from scanner A (or B), with the standard two agents unless told otherwise. */
async function ingest(
    which: 'A' | 'B',
    scanRef: string,
    day: number,
    opts: { sources?: Source[]; agents?: HarnessReportAgentV1[] } = {},
) {
    const s = which === 'A' ? seeded.scannerA : seeded.scannerB;
    const agents = opts.agents ?? [
        reportAgent(DISCOVERED_ID_CANARY, { registeredAgentId: seeded.targetAgentId }),
        reportAgent(`entra:sp:shadow-${which}`),
    ];
    return ingestHarnessReport(ownerCtx(), s.scanner.serialise(body(s.agentId, scanRef, IN_MONTH(day), agents, opts.sources)));
}

/** The tenant's harness artefacts with their Evidence, ASI03 then ASI10 by control id. */
async function harnessArtefacts(tenantId = T) {
    return prisma.agenticEvidenceArtefact.findMany({
        where: { tenantId, kind: ARTEFACT_KIND_HARNESS_SCANS },
        orderBy: { controlId: 'asc' },
        select: {
            id: true,
            controlId: true,
            periodStart: true,
            recordCount: true,
            status: true,
            withdrawnReason: true,
            evidence: {
                select: {
                    id: true,
                    title: true,
                    content: true,
                    status: true,
                    isArchived: true,
                    deletedAt: true,
                    expiredAt: true,
                },
            },
        },
    });
}

beforeAll(async () => {
    await clearOwnRows();
    for (const tenantId of ALL_TENANTS) {
        await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
    }
    seeded.ownerUserId = await member(T, emails[0]);
    seeded.noKeyOwnerUserId = await member(T_NO_KEY, emails[1]);
    seeded.revokedOwnerUserId = await member(T_REVOKED, emails[2]);
    await installControls();
    seeded.scannerA = await keyedScanner('Scanner A');
    seeded.scannerB = await keyedScanner('Scanner B');
    seeded.targetAgentId = await registeredAgent(AGENT_NAME_CANARY);
    // T_REVOKED trusted a scanner once and has since revoked every key.
    await keyedScanner('Retired scanner', revokedCtx());
    for (const k of await prisma.agentHarnessScannerKey.findMany({ where: { tenantId: T_REVOKED }, select: { id: true } })) {
        await revokeHarnessScannerKey(revokedCtx(), { keyId: k.id });
    }
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

beforeEach(async () => {
    // Each case starts from no scans and no evidence; controls, agents and keys
    // persist. The artefacts cascade from their Evidence rows.
    const t = { tenantId: { in: ALL_TENANTS } };
    await prisma.agenticEvidenceArtefact.deleteMany({ where: t });
    await prisma.evidenceControlLink.deleteMany({ where: t });
    await prisma.evidence.deleteMany({ where: t });
    await prisma.agentHarnessAcceptance.deleteMany({ where: t });
    await prisma.agentHarnessScanItem.deleteMany({ where: t });
    await prisma.agentHarnessScan.deleteMany({ where: t });
    await prisma.discoveredAgent.deleteMany({ where: t });
    await prisma.finding.deleteMany({ where: t });
    // Restore the canonical control → requirement mapping (the withdrawal case removes one).
    const requirements = await prisma.frameworkRequirement.findMany({
        where: { framework: { key: FRAMEWORK_KEY } },
        select: { id: true, code: true },
    });
    await prisma.controlRequirementLink.deleteMany({ where: t });
    const controls = await prisma.control.findMany({ where: t, select: { id: true, tenantId: true, code: true } });
    for (const c of controls) {
        const r = requirements.find((x) => `CTL-${x.code}` === c.code);
        if (r && c.tenantId) {
            await prisma.controlRequirementLink.create({ data: { tenantId: c.tenantId, controlId: c.id, requirementId: r.id } });
        }
    }
});

describe('an incomplete scan is never emitted as complete evidence', () => {
    it('emits an INCOMPLETE month as NEEDS_REVIEW, naming the source, on both controls, counting toward neither', async () => {
        await ingest('A', 'inc-1', 5, { sources: MCP_INCOMPLETE });
        const report = await emitAgenticEvidence(ownerCtx(), { asOf: AS_OF });
        expect(report.anyTargetInstalled).toBe(true);

        const rows = await harnessArtefacts();
        expect(new Set(rows.map((r) => r.controlId))).toEqual(new Set([seeded.controls.ASI10, seeded.controls.ASI03]));
        for (const row of rows) {
            expect(row.evidence.status).toBe('NEEDS_REVIEW');
            expect(row.evidence.title).toContain('— INCOMPLETE');
            expect(row.evidence.content).toContain('Artefact completeness: INCOMPLETE');
            expect(row.evidence.content).toContain('mcp: INCOMPLETE — TIME_BOX (1 rows)');
            expect(row.recordCount).toBe(1);
            // The predicate every coverage scorer routes through.
            expect(isCoverageQualifyingEvidence(row.evidence)).toBe(false);
        }
    });

    it('approves the month once every scanner\'s latest scan is complete, and demotes it again when a later one is not — in place', async () => {
        await ingest('A', 'seq-1', 5, { sources: MCP_INCOMPLETE });
        // B holds a key too, so it must report for the month to be complete.
        await ingest('B', 'seq-b', 6);
        await emitAgenticEvidence(ownerCtx(), { asOf: AS_OF });
        const [first] = await harnessArtefacts();
        expect(first.evidence.status).toBe('NEEDS_REVIEW');

        await ingest('A', 'seq-2', 10);
        const second = await emitAgenticEvidence(ownerCtx(), { asOf: AS_OF });
        expect(second.artefacts.filter((a) => a.kind === ARTEFACT_KIND_HARNESS_SCANS).map((a) => a.outcome)).toEqual([
            'updated',
            'updated',
        ]);
        const approved = await harnessArtefacts();
        expect(approved).toHaveLength(2);
        expect(approved.map((r) => r.evidence.id)).toContain(first.evidence.id);
        for (const row of approved) {
            expect(row.evidence.status).toBe('APPROVED');
            expect(row.evidence.title).not.toContain('INCOMPLETE');
            expect(row.evidence.content).toContain('Artefact completeness: COMPLETE');
            expect(isCoverageQualifyingEvidence(row.evidence)).toBe(true);
        }

        // The UPDATE branch writes the status too, not only the create.
        await ingest('A', 'seq-3', 15, { sources: MCP_INCOMPLETE });
        await emitAgenticEvidence(ownerCtx(), { asOf: AS_OF });
        const demoted = await harnessArtefacts();
        expect(demoted.map((r) => r.evidence.id).sort()).toEqual(approved.map((r) => r.evidence.id).sort());
        for (const row of demoted) {
            expect(row.evidence.status).toBe('NEEDS_REVIEW');
            expect(row.recordCount).toBe(4);
        }
        // Each status the emitter changed is on the trail, both ways.
        expect((await statusChangesOf(first.evidence.id)).map((r) => {
            const d = r.detailsJson as { fromStatus: string; toStatus: string };
            return `${d.fromStatus}->${d.toStatus}`;
        })).toEqual(['NEEDS_REVIEW->APPROVED', 'APPROVED->NEEDS_REVIEW']);
    });

    it('takes "latest" by asOf: a complete report backfilled for an earlier moment does not cover a later incomplete one', async () => {
        await ingest('A', 'late-incomplete', 20, { sources: MCP_INCOMPLETE });
        // Ingested AFTER, describing an EARLIER moment.
        await ingest('A', 'backfilled-complete', 2);
        await emitAgenticEvidence(ownerCtx(), { asOf: AS_OF });
        for (const row of await harnessArtefacts()) {
            expect(row.evidence.status).toBe('NEEDS_REVIEW');
            expect(row.evidence.content).toContain('latest scan (late-incomplete) did not read all of its sources in full');
        }
    });

    it('needs every scanner\'s latest scan complete — one scanner\'s complete scan does not cover another\'s gap', async () => {
        await ingest('A', 'two-a', 10);
        await ingest('B', 'two-b', 11, { sources: MCP_INCOMPLETE });
        await emitAgenticEvidence(ownerCtx(), { asOf: AS_OF });
        for (const row of await harnessArtefacts()) {
            expect(row.evidence.status).toBe('NEEDS_REVIEW');
            expect(row.evidence.content).toContain(`scanner ${seeded.scannerB.agentId}'s latest scan (two-b)`);
        }
    });

    it('puts a hand-approved incomplete month back to NEEDS_REVIEW on the next tick, though nothing else changed', async () => {
        await ingest('A', 'hand-1', 5, { sources: MCP_INCOMPLETE });
        await emitAgenticEvidence(ownerCtx(), { asOf: AS_OF });
        const [row] = await harnessArtefacts();
        await prisma.evidence.update({ where: { id: row.evidence.id }, data: { status: 'APPROVED' } });

        const again = await emitAgenticEvidence(ownerCtx(), { asOf: AS_OF });
        const outcome = again.artefacts.find((a) => a.evidenceId === row.evidence.id)?.outcome;
        // The digest did not move, so only the status drift makes this a change.
        expect(outcome).toBe('updated');
        const after = await prisma.evidence.findUniqueOrThrow({ where: { id: row.evidence.id }, select: { status: true } });
        expect(after.status).toBe('NEEDS_REVIEW');
        const [audit] = await statusChangesOf(row.evidence.id);
        expect(audit.detailsJson).toMatchObject({ category: 'status_change', fromStatus: 'APPROVED', toStatus: 'NEEDS_REVIEW' });
    });
});

describe('a scanner that holds a trusted key and sends nothing is a gap, not a clean month', () => {
    it('emits the month INCOMPLETE, naming the silent scanner, though the scanner that did report is complete', async () => {
        await ingest('A', 'only-a', 10);
        await emitAgenticEvidence(ownerCtx(), { asOf: AS_OF });
        const rows = await harnessArtefacts();
        expect(rows).toHaveLength(2);
        for (const row of rows) {
            expect(row.evidence.status).toBe('NEEDS_REVIEW');
            expect(row.evidence.title).toContain('— INCOMPLETE');
            expect(row.evidence.content).toContain(
                `scanner ${seeded.scannerB.agentId} held a trusted key in the period but reported no scan in it`,
            );
            expect(row.evidence.content).not.toContain('Artefact completeness: COMPLETE');
            expect(isCoverageQualifyingEvidence(row.evidence)).toBe(false);
        }
    });

    it('still counts a scanner whose key was revoked DURING the month: it was trusted, and sent nothing', async () => {
        await ingest('A', 'only-a-mid', 10);
        await withScannerBRevokedAt(new Date(Date.UTC(2026, 8, 15)), () => emitAgenticEvidence(ownerCtx(), { asOf: AS_OF }));
        for (const row of await harnessArtefacts()) expect(row.evidence.status).toBe('NEEDS_REVIEW');
    });

    it('does not count a scanner whose key was revoked BEFORE the month began', async () => {
        await ingest('A', 'only-a-before', 10);
        await withScannerBRevokedAt(new Date(Date.UTC(2026, 7, 20)), () => emitAgenticEvidence(ownerCtx(), { asOf: AS_OF }));
        for (const row of await harnessArtefacts()) {
            expect(row.evidence.status).toBe('APPROVED');
            expect(row.evidence.content).not.toContain(seeded.scannerB.agentId);
        }
    });
});

describe('a month is not closed by its last tick', () => {
    it('demotes an APPROVED month when its true latest scan, sent after the month\'s last tick, is incomplete', async () => {
        await ingest('A', 'eom-a', 28);
        await ingest('B', 'eom-b', 28);
        // The month's final 06:30 tick: every scanner's latest is complete.
        await emitAgenticEvidence(ownerCtx(), { asOf: new Date('2026-09-30T06:30:00.000Z') });
        for (const row of await harnessArtefacts()) expect(row.evidence.status).toBe('APPROVED');

        // Later that day A reports again, short of its sources.
        const s = seeded.scannerA;
        await ingestHarnessReport(
            ownerCtx(),
            s.scanner.serialise(body(s.agentId, 'eom-a-late', '2026-09-30T12:00:00.000Z', [reportAgent('entra:sp:late')], MCP_INCOMPLETE)),
        );

        // The first tick of October re-asserts September.
        const closed = await reconcileClosedHarnessPeriods(ownerCtx(), { now: new Date('2026-10-01T06:30:00.000Z') });
        expect(closed.periodLabels).toEqual(['2026-09']);
        const rows = await harnessArtefacts();
        expect(rows).toHaveLength(2);
        for (const row of rows) {
            expect(row.periodStart.toISOString()).toBe('2026-09-01T00:00:00.000Z');
            expect(row.evidence.status).toBe('NEEDS_REVIEW');
            expect(row.evidence.content).toContain('latest scan (eom-a-late) did not read all of its sources in full');
        }
    });

    it('re-emits an older month a report was backfilled into, and only that one', async () => {
        await emitAgenticEvidence(ownerCtx(), { asOf: EMPTY_MONTH });
        const july = await harnessArtefacts();
        expect(july.every((r) => r.evidence.title.includes('NO SCAN RECEIVED'))).toBe(true);

        // Nothing new for July: a tick in September re-emits August (the
        // previous month) and leaves July alone.
        const quiet = await reconcileClosedHarnessPeriods(ownerCtx(), { now: new Date('2026-09-02T06:30:00.000Z') });
        expect(quiet.periodLabels).toEqual(['2026-08']);

        // Both scanners backfill July, complete.
        const backfill = async (which: 'A' | 'B') => {
            const sc = which === 'A' ? seeded.scannerA : seeded.scannerB;
            await ingestHarnessReport(
                ownerCtx(),
                sc.scanner.serialise(body(sc.agentId, `july-${which}`, '2026-07-10T03:00:00.000Z', [reportAgent(`entra:sp:july-${which}`)])),
            );
        };
        await backfill('A');
        await backfill('B');
        const closed = await reconcileClosedHarnessPeriods(ownerCtx(), { now: new Date('2026-09-02T06:30:00.000Z') });
        expect(closed.periodLabels).toEqual(['2026-08', '2026-07']);
        const after = (await harnessArtefacts()).filter((r) => r.periodStart.toISOString() === '2026-07-01T00:00:00.000Z');
        expect(after.map((r) => r.evidence.id).sort()).toEqual(july.map((r) => r.evidence.id).sort());
        for (const row of after) {
            expect(row.evidence.status).toBe('APPROVED');
            expect(row.evidence.content).toContain('Artefact completeness: COMPLETE');
        }
    });

    it('puts back an incomplete closed month approved by hand long after it closed', async () => {
        await emitAgenticEvidence(ownerCtx(), { asOf: EMPTY_MONTH });
        const [row] = await harnessArtefacts();
        await prisma.evidence.update({ where: { id: row.evidence.id }, data: { status: 'APPROVED' } });

        // December: July is neither the previous month nor reached by a late scan.
        const closed = await reconcileClosedHarnessPeriods(ownerCtx(), { now: new Date('2026-12-02T06:30:00.000Z') });
        expect(closed.periodLabels).toEqual(['2026-11']);
        expect(closed.demotedEvidenceIds).toEqual([row.evidence.id]);
        const after = await prisma.evidence.findUniqueOrThrow({ where: { id: row.evidence.id }, select: { status: true } });
        expect(after.status).toBe('NEEDS_REVIEW');
        expect((await statusChangesOf(row.evidence.id)).map((r) => (r.detailsJson as { toStatus: string }).toStatus)).toEqual([
            'NEEDS_REVIEW',
        ]);
    });
});

describe('the emitter corrects a status in one direction, and a review decision stands', () => {
    it('leaves a REJECTED month rejected when its scans later become complete', async () => {
        await ingest('A', 'rej-1', 5, { sources: MCP_INCOMPLETE });
        await emitAgenticEvidence(ownerCtx(), { asOf: AS_OF });
        const [row] = await harnessArtefacts();
        await prisma.evidence.update({ where: { id: row.evidence.id }, data: { status: 'REJECTED' } });

        await ingest('A', 'rej-2', 10);
        await ingest('B', 'rej-b', 10);
        await emitAgenticEvidence(ownerCtx(), { asOf: AS_OF });
        const after = (await harnessArtefacts()).find((r) => r.evidence.id === row.evidence.id)!;
        // The body is rewritten — the month IS complete now — but the
        // reviewer's decision is not overwritten by the emitter.
        expect(after.evidence.content).toContain('Artefact completeness: COMPLETE');
        expect(after.evidence.status).toBe('REJECTED');
        expect(isCoverageQualifyingEvidence(after.evidence)).toBe(false);
        expect(await statusChangesOf(row.evidence.id)).toEqual([]);
    });

    it('leaves a re-submitted incomplete month in the reviewer\'s queue', async () => {
        await ingest('A', 'sub-1', 5, { sources: MCP_INCOMPLETE });
        await emitAgenticEvidence(ownerCtx(), { asOf: AS_OF });
        const [row] = await harnessArtefacts();
        await prisma.evidence.update({ where: { id: row.evidence.id }, data: { status: 'SUBMITTED' } });

        const again = await emitAgenticEvidence(ownerCtx(), { asOf: AS_OF });
        expect(again.artefacts.find((a) => a.evidenceId === row.evidence.id)?.outcome).toBe('unchanged');
        const after = await prisma.evidence.findUniqueOrThrow({ where: { id: row.evidence.id }, select: { status: true } });
        expect(after.status).toBe('SUBMITTED');
    });

    it('does not re-approve a complete month the stale-review sweep sent back, even when a new scan arrives', async () => {
        await ingest('A', 'sweep-a1', 5);
        await ingest('B', 'sweep-b1', 5);
        await emitAgenticEvidence(ownerCtx(), { asOf: AS_OF });
        const [row] = await harnessArtefacts();
        expect(row.evidence.status).toBe('APPROVED');
        // What `evidence-stale-review-sweep` does to an APPROVED row past its review date.
        await prisma.evidence.update({ where: { id: row.evidence.id }, data: { status: 'NEEDS_REVIEW' } });

        await emitAgenticEvidence(ownerCtx(), { asOf: AS_OF });
        await ingest('A', 'sweep-a2', 12);
        const changed = await emitAgenticEvidence(ownerCtx(), { asOf: AS_OF });
        expect(changed.artefacts.find((a) => a.evidenceId === row.evidence.id)?.outcome).toBe('updated');
        const after = await prisma.evidence.findUniqueOrThrow({ where: { id: row.evidence.id }, select: { status: true } });
        expect(after.status).toBe('NEEDS_REVIEW');
    });
});

describe('"latest" is one row on the tab and in the evidence, however a tie on asOf falls', () => {
    it('breaks an asOf tie on arrival: the scan received last is the latest on both surfaces', async () => {
        const s = seeded.scannerA;
        const at = IN_MONTH(14);
        const send = (ref: string, sources: Source[]) =>
            ingestHarnessReport(ownerCtx(), s.scanner.serialise(body(s.agentId, ref, at, [reportAgent(`entra:sp:${ref}`)], sources)));
        await send('tie-1', ALL_COMPLETE);
        await send('tie-2', ALL_COMPLETE);
        await send('tie-3', MCP_INCOMPLETE);
        await ingest('B', 'tie-b', 3);

        // Give the row received last neither the lowest nor the highest heap
        // position, so neither an index scan nor a sort that ignores the
        // tie-break can land on it by physical order alone: rewrite tie-2's
        // indexed `asOf` (away and back) so its tuple moves past tie-3's.
        const tie2 = await prisma.agentHarnessScan.findFirstOrThrow({ where: { tenantId: T, scanRef: 'tie-2' } });
        await prisma.agentHarnessScan.update({ where: { id: tie2.id }, data: { asOf: new Date(Date.parse(at) + 1) } });
        await prisma.agentHarnessScan.update({ where: { id: tie2.id }, data: { asOf: new Date(at) } });

        const section = (await getHarnessMatrix(ownerCtx())).sections.find((x) => x.scannerAgentId === s.agentId);
        expect(section?.latest.scanRef).toBe('tie-3');

        await emitAgenticEvidence(ownerCtx(), { asOf: AS_OF });
        for (const row of await harnessArtefacts()) {
            expect(row.evidence.status).toBe('NEEDS_REVIEW');
            expect(row.evidence.content).toContain('latest scan (tie-3) did not read all of its sources in full');
        }
    });
});

describe('the body says what is true as of the emission', () => {
    it('rewrites "not in the register" when a register row is deleted after the scan, though no scan moved', async () => {
        await ingest('A', 'reg-1', 10);
        await emitAgenticEvidence(ownerCtx(), { asOf: AS_OF });
        for (const row of await harnessArtefacts()) {
            // The shadow agent only.
            expect(row.evidence.content).toContain('Not in the agent register as of this emission: 1');
        }

        // The FK is NO ACTION, so the scan item keeps pointing at a register
        // row that is gone; it must count as not in the register.
        await prisma.registeredAgent.update({ where: { id: seeded.targetAgentId }, data: { deletedAt: new Date() } });
        try {
            const again = await emitAgenticEvidence(ownerCtx(), { asOf: AS_OF });
            expect(
                again.artefacts.filter((a) => a.kind === ARTEFACT_KIND_HARNESS_SCANS).map((a) => a.outcome),
            ).toEqual(['updated', 'updated']);
            for (const row of await harnessArtefacts()) {
                expect(row.evidence.content).toContain('Not in the agent register as of this emission: 2');
            }
        } finally {
            await prisma.registeredAgent.update({ where: { id: seeded.targetAgentId }, data: { deletedAt: null } });
        }
    });
});

describe('zero is never complete', () => {
    it('emits an all-COMPLETE report that found nobody as NEEDS_REVIEW, saying the scan was EMPTY', async () => {
        await ingest('A', 'empty-1', 8, { agents: [] });
        await emitAgenticEvidence(ownerCtx(), { asOf: AS_OF });
        const rows = await harnessArtefacts();
        expect(rows).toHaveLength(2);
        for (const row of rows) {
            expect(row.evidence.status).toBe('NEEDS_REVIEW');
            expect(row.evidence.content).toContain('Completeness: EMPTY — no agent found; an empty population evidences nothing');
        }
    });

    it('emits a month with no scan, for a tenant that registered a scanner, as NO SCAN RECEIVED', async () => {
        await emitAgenticEvidence(ownerCtx(), { asOf: EMPTY_MONTH });
        const rows = await harnessArtefacts();
        expect(rows).toHaveLength(2);
        for (const row of rows) {
            expect(row.periodStart.toISOString()).toBe('2026-07-01T00:00:00.000Z');
            expect(row.recordCount).toBe(0);
            expect(row.evidence.status).toBe('NEEDS_REVIEW');
            expect(row.evidence.title).toContain('— NO SCAN RECEIVED');
            expect(row.evidence.content).toContain('the agent inventory is UNEVIDENCED for 2026-07');
        }
    });

    it('still emits NO SCAN RECEIVED for a tenant whose every scanner key is revoked — it stopped scanning', async () => {
        expect(
            await prisma.agentHarnessScannerKey.count({ where: { tenantId: T_REVOKED, revokedAt: null } }),
        ).toBe(0);
        await emitAgenticEvidence(revokedCtx(), { asOf: EMPTY_MONTH });
        const rows = await harnessArtefacts(T_REVOKED);
        expect(rows).toHaveLength(2);
        for (const row of rows) {
            expect(row.evidence.status).toBe('NEEDS_REVIEW');
            expect(row.evidence.title).toContain('— NO SCAN RECEIVED');
        }
    });

    it('emits no harness artefact for a tenant that has never registered a scanner key', async () => {
        const report = await emitAgenticEvidence(noKeyCtx(), { asOf: AS_OF });
        // Its controls ARE installed, so this is the opt-in gate and not an
        // absent framework.
        expect(report.anyTargetInstalled).toBe(true);
        expect(report.artefacts).toEqual([]);
        expect(await harnessArtefacts(T_NO_KEY)).toEqual([]);
    });
});

describe('evidence is withdrawn, never deleted', () => {
    it('withdraws the ASI10 artefact when its link goes, archives its Evidence, and leaves ASI03 standing', async () => {
        await ingest('A', 'wd-1', 10);
        await emitAgenticEvidence(ownerCtx(), { asOf: AS_OF });
        const before = await harnessArtefacts();
        expect(before.every((r) => r.status === 'CURRENT')).toBe(true);

        await prisma.controlRequirementLink.deleteMany({ where: { tenantId: T, controlId: seeded.controls.ASI10 } });
        const withdrawn = await withdrawStaleAgenticEvidence(ownerCtx());
        expect(withdrawn.map((w) => w.reason)).toEqual(['OBLIGATION_UNMAPPED']);

        const after = await harnessArtefacts();
        const asi10 = after.find((r) => r.controlId === seeded.controls.ASI10);
        const asi03 = after.find((r) => r.controlId === seeded.controls.ASI03);
        expect(asi10?.status).toBe('WITHDRAWN');
        expect(asi10?.withdrawnReason).toBe('OBLIGATION_UNMAPPED');
        expect(asi10?.evidence.isArchived).toBe(true);
        expect(asi10?.evidence.deletedAt).toBeNull();
        expect(asi10?.evidence.content).toContain('WITHDRAWN');
        expect(asi03?.status).toBe('CURRENT');
    });
});

describe('what a harness artefact must not contain (DPIA condition 8)', () => {
    it('carries no owner reference, user id, justification, pointer, credential, tool server or agent name', async () => {
        await ingest('A', 'dpia-1', 12);
        const discovered = await prisma.discoveredAgent.findUniqueOrThrow({
            where: { tenantId_discoveredId: { tenantId: T, discoveredId: DISCOVERED_ID_CANARY } },
            select: { id: true, ownerRef: true },
        });
        const accepted = await acceptHarnessShortfall(ownerCtx(), {
            discoveredAgentId: discovered.id,
            justification: JUSTIFICATION_CANARY,
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        });

        // Each canary is really in its source row — otherwise its absence
        // below proves nothing.
        expect(discovered.ownerRef).toBe(OWNER_REF_CANARY);
        const item = await prisma.agentHarnessScanItem.findFirstOrThrow({
            where: { tenantId: T, discoveredAgentId: discovered.id },
            select: { verdictsJson: true, toolsJson: true },
        });
        expect(JSON.stringify(item.verdictsJson)).toContain(POINTER_CANARY);
        expect(JSON.stringify(item.toolsJson)).toContain(TOOL_SERVER_CANARY);
        // The justification is field-encrypted at rest, so it is read back the
        // way the emitter's own tenant client would see it: decrypted.
        const [acceptance] = await listHarnessAcceptances(ownerCtx(), discovered.id);
        expect(acceptance.id).toBe(accepted.id);
        expect(acceptance.justification).toBe(JUSTIFICATION_CANARY);
        expect(acceptance.acceptedByUserId).toBe(seeded.ownerUserId);

        await emitAgenticEvidence(ownerCtx(), { asOf: AS_OF });
        const rows = await harnessArtefacts();
        expect(rows).toHaveLength(2);
        const forbidden = [
            OWNER_REF_CANARY,
            POINTER_CANARY,
            CREDENTIAL_CANARY,
            TOOL_SERVER_CANARY,
            JUSTIFICATION_CANARY,
            AGENT_NAME_CANARY,
            DISCOVERED_ID_CANARY,
            seeded.ownerUserId,
            seeded.targetAgentId,
        ];
        for (const row of rows) {
            const text = `${row.evidence.title}\n${row.evidence.content}`;
            for (const canary of forbidden) expect(text).not.toContain(canary);
            expect(row.evidence.content).toContain('REDACTION CONTRACT');
            // What it does carry: identifiers, counts, completeness.
            expect(row.evidence.content).toContain('scan dpia-1');
            expect(row.evidence.content).toContain('Agents: 2 · by level');
        }
    });

    it('sanitises and bounds the scanner-chosen scan reference', async () => {
        const hostile = `<img src=x onerror=alert(1)>${'r'.repeat(220)}`;
        await ingest('A', hostile, 9);
        await emitAgenticEvidence(ownerCtx(), { asOf: AS_OF });
        const [row] = await harnessArtefacts();
        expect(row.evidence.content).not.toContain('<img');
        expect(row.evidence.content).not.toContain('r'.repeat(200));
        expect(row.evidence.content).toContain(`${'r'.repeat(100)}…`);
    });
});

describe('every kind the code knows is one the migrated CHECK accepts', () => {
    // A per-agent kind (#3700) must name its agent — `AgenticEvidenceArtefact_
    // agent_scope` — so it is inserted with one; every other kind without.
    const insert = async (kind: string) => {
        const evidence = await prisma.evidence.create({
            data: { tenantId: T, type: 'TEXT', title: `check pin ${kind}`, content: 'x', status: 'DRAFT' },
            select: { id: true },
        });
        return prisma.$executeRawUnsafe(
            `INSERT INTO "AgenticEvidenceArtefact"
               ("id", "tenantId", "controlId", "kind", "agentId", "periodStart", "periodEnd", "evidenceId", "sourceDigest", "updatedAt")
             VALUES ($1, $2, $3, $4, $5, '2020-01-01T00:00:00Z', '2020-02-01T00:00:00Z', $6, 'pin', now())`,
            randomUUID(),
            T,
            seeded.controls.ASI10,
            kind,
            isPerAgentKind(kind) ? seeded.targetAgentId : null,
            evidence.id,
        );
    };

    it.each(AGENTIC_ARTEFACT_KINDS.map((k) => [k]))('accepts %s', async (kind) => {
        await expect(insert(kind)).resolves.toBe(1);
    });

    it('refuses a kind it does not know', async () => {
        await expect(insert('NOT_A_KIND')).rejects.toThrow(/AgenticEvidenceArtefact_kind_known/);
    });
});
