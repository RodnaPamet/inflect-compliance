/**
 * The tenant purge keeps every access-review campaign, whole (#3716, #3724).
 *
 * Owner decision, 2026-10-18: a purge RETAINS each `AccessReview` and its
 * decision, pack, narrowing and sample rows, as `docs/data-retention.md`
 * promises for regulatory artefacts. Before it, the evidence tables were in
 * `TENANT_PURGE_RETAINED` but cascaded from `AccessReview`, which was not —
 * so the purge's `DELETE FROM "AccessReview"` took every one of them with it,
 * inside a run that reported success.
 *
 * This runs the REAL purge (`purgeSoftDeletedTenants`, the live FK graph, the
 * real per-tenant transaction) against a tenant holding one closed campaign of
 * every decision model — member, connected, legacy and agent with packs — and
 * asserts EXACTLY which rows remain: the population is every tenant-scoped
 * table in the database, read from the catalogue, so a row surviving that
 * should not, or one vanishing that should stay, both fail here.
 *
 * It also holds the other half of the day's decisions (open question 10): an
 * `IncidentEvidence` junction and an `AgenticEvidenceArtefact`, two of the five
 * models classed with a purged parent, which the purge must now REMOVE while it
 * keeps the incident the junction pointed at.
 *
 * Two tenants. The second is never purged and must come through byte-for-byte
 * untouched in every table: a purge scoped by `WHERE "tenantId" = $1` that
 * reached across would be a far worse defect than the one being fixed.
 */
import { PrismaClient, Role } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import { purgeSoftDeletedTenants } from '@/app-layer/usecases/tenant-purge';
// The client the purge itself runs on (`runInGlobalContext` defaults to it).
import { prisma as appPrisma } from '@/lib/prisma';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(180_000);

const PURGED = 'tprar-purged';
const KEPT = 'tprar-kept';
const TENANTS = [PURGED, KEPT];
const AT = new Date('2026-09-30T12:00:00Z');
const SHA = (c: string) => `sha256:${c.repeat(64)}`;

/** The access-review models that must survive the purge. */
const RETAINED_CAMPAIGN_TABLES = [
    'AccessReview',
    'AccessReviewAgentNarrowing',
    'AccessReviewAgentPack',
    'AccessReviewConnectedDecision',
    'AccessReviewDecision',
    'AccessReviewDecisionSampleAudit',
];

type Person = 'owner' | 'reviewer' | 'alice' | 'bob';
const PEOPLE: Person[] = ['owner', 'reviewer', 'alice', 'bob'];
const ROLE: Record<Person, Role> = { owner: Role.OWNER, reviewer: Role.ADMIN, alice: Role.EDITOR, bob: Role.READER };
const emailOf = (tenantId: string, who: Person) => `${who}@${tenantId}.test`;

const users: Record<string, Record<Person, string>> = {};
const ids: Record<string, Record<string, string>> = {};

/** Every base table carrying a `tenantId`, from the live catalogue. */
async function tenantTables(): Promise<string[]> {
    const rows = (await prisma.$queryRawUnsafe(`
        SELECT c.table_name AS t
          FROM information_schema.columns c
          JOIN information_schema.tables tb
            ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
         WHERE c.table_schema = 'public' AND c.column_name = 'tenantId' AND tb.table_type = 'BASE TABLE'
    `)) as Array<{ t: string }>;
    return rows.map((r) => r.t).sort();
}

/** Non-zero row counts per table for one tenant — tables with no rows omitted. */
async function rowCounts(tenantId: string): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const t of await tenantTables()) {
        const [{ n }] = (await prisma.$queryRawUnsafe(
            `SELECT count(*)::int AS n FROM "${t}" WHERE "tenantId" = $1`,
            tenantId,
        )) as Array<{ n: number }>;
        if (n > 0) out[t] = n;
    }
    return out;
}

/** Every row of every tenant table for one tenant, as JSON — the "untouched" witness. */
async function fullDump(tenantId: string): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const t of await tenantTables()) {
        const rows = (await prisma.$queryRawUnsafe(
            `SELECT to_jsonb(x)::text AS j FROM "${t}" x WHERE "tenantId" = $1`,
            tenantId,
        )) as Array<{ j: string }>;
        if (rows.length > 0) out[t] = rows.map((r) => r.j).sort();
    }
    return out;
}

async function seedTenant(tenantId: string): Promise<void> {
    const u = (users[tenantId] = {} as Record<Person, string>);
    const id: Record<string, string> = (ids[tenantId] = {});
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
    for (const who of PEOPLE) {
        const email = emailOf(tenantId, who);
        u[who] = (await prisma.user.create({ data: { email, emailHash: hashForLookup(email), name: who } })).id;
    }
    for (const who of PEOPLE) {
        id[`mem_${who}`] = (await prisma.tenantMembership.create({
            data: { tenantId, userId: u[who], role: ROLE[who], status: 'ACTIVE' },
        })).id;
    }

    // Ordinary business data, which the purge MUST remove — the control that
    // proves the purge ran at all.
    id.control = (await prisma.control.create({ data: { tenantId, name: 'Quarterly access review', code: 'AC-2' } })).id;

    // Two of the five models that USED to be "retained" while cascading from a
    // purged parent, and are classed with that parent since 2026-10-18 (open
    // question 10). Each hangs off an `Evidence` row the purge deletes; the
    // incident is a regulatory artefact the purge keeps, which is what makes
    // the junction the interesting case — one parent stays, one goes.
    id.evidence = (await prisma.evidence.create({ data: { tenantId, type: 'TEXT', title: 'Forensic notes' } })).id;
    id.incident = (await prisma.incident.create({
        data: {
            tenantId, reference: `INC-${tenantId}`, title: 'Phishing', description: 'Credential phish',
            severity: 'HIGH', incidentType: 'phishing', detectedAt: AT, createdByUserId: u.owner,
        },
    })).id;
    await prisma.incidentEvidence.create({ data: { tenantId, incidentId: id.incident, evidenceId: id.evidence } });
    await prisma.agenticEvidenceArtefact.create({
        data: {
            tenantId, controlId: id.control, kind: 'AGENT_ACTION_RECEIPTS', evidenceId: id.evidence,
            periodStart: new Date('2026-09-01T00:00:00Z'), periodEnd: new Date('2026-10-01T00:00:00Z'),
            sourceDigest: SHA('c'),
        },
    });

    // ── 1. A closed MEMBER campaign, with its signed evidence PDF ─────────
    id.file = (await prisma.fileRecord.create({
        data: {
            tenantId,
            pathKey: `tprar/${tenantId}/evidence.pdf`,
            originalName: 'access-review-evidence.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 1024,
            sha256: 'f'.repeat(64),
            status: 'STORED',
            uploadedByUserId: u.reviewer,
        },
    })).id;
    id.member = (await prisma.accessReview.create({
        data: {
            tenantId, name: 'Q3 member review', scope: 'ALL_USERS',
            periodStartAt: new Date('2026-07-01T00:00:00Z'), periodEndAt: new Date('2026-09-30T00:00:00Z'),
            reviewerUserId: u.reviewer, createdByUserId: u.owner,
            status: 'CLOSED', closedAt: AT, closedByUserId: u.owner, evidenceFileRecordId: id.file,
        },
    })).id;
    for (const [who, decision] of [['alice', 'CONFIRM'], ['bob', 'REVOKE']] as const) {
        await prisma.accessReviewDecision.create({
            data: {
                tenantId, accessReviewId: id.member, membershipId: id[`mem_${who}`], subjectUserId: u[who],
                snapshotRole: ROLE[who], snapshotMembershipStatus: 'ACTIVE',
                decision, decidedAt: AT, decidedByUserId: u.reviewer,
                notes: decision === 'REVOKE' ? 'left the team' : null,
                executedAt: AT, executedByUserId: u.owner,
            },
        });
    }

    // ── 2. A closed CONNECTED_APP campaign over one directory account ─────
    id.conn = (await prisma.integrationConnection.create({
        data: { tenantId, provider: 'okta', name: 'Okta' },
    })).id;
    id.account = (await prisma.connectedIdentityAccount.create({
        data: {
            tenantId, provider: 'okta', externalUserId: 'okta-carol', email: `carol@${tenantId}.test`,
            connectionId: id.conn, syncedAt: AT,
        },
    })).id;
    id.connected = (await prisma.accessReview.create({
        data: {
            tenantId, name: 'Q3 Okta review', scope: 'CONNECTED_APP',
            reviewerUserId: u.reviewer, createdByUserId: u.owner, status: 'CLOSED', closedAt: AT, closedByUserId: u.owner,
        },
    })).id;
    await prisma.accessReviewConnectedDecision.create({
        data: {
            tenantId, accessReviewId: id.connected, connectedAccountId: id.account,
            subjectRef: `okta:okta-carol`, snapshotJson: { provider: 'okta', email: `carol@${tenantId}.test`, isAdmin: true, mfaEnrolled: false },
            decision: 'REVOKE', decidedAt: AT, decidedByUserId: u.reviewer,
        },
    });

    // ── 3. A closed LEGACY_APP campaign — no directory account at all ─────
    id.legacy = (await prisma.accessReview.create({
        data: {
            tenantId, name: 'Q3 ledger recertification', scope: 'LEGACY_APP',
            reviewerUserId: u.reviewer, createdByUserId: u.owner, status: 'CLOSED', closedAt: AT, closedByUserId: u.owner,
        },
    })).id;
    await prisma.accessReviewConnectedDecision.create({
        data: {
            tenantId, accessReviewId: id.legacy, connectedAccountId: null,
            subjectRef: 'legacy-conn:dpatel', snapshotJson: { accountKey: 'dpatel', isPrivileged: true },
            decision: 'CONFIRM', decidedAt: AT, decidedByUserId: u.reviewer,
        },
    });

    // ── 4. An AGENT campaign, with packs, a narrowing and a sample ────────
    // Agents are plain ids by design: no FK to the register, which the purge
    // deletes.
    const preparer = `agent-prep-${tenantId}`;
    const subject = `agent-a-${tenantId}`;
    id.agent = (await prisma.accessReview.create({
        data: {
            tenantId, name: 'Q3 agent recertification', scope: 'AGENT', preparerAgentId: preparer,
            reviewerUserId: u.reviewer, createdByUserId: u.owner, status: 'CLOSED', closedAt: AT, closedByUserId: u.owner,
        },
    })).id;
    for (const agentId of [subject, preparer]) {
        id[`dec_${agentId}`] = (await prisma.accessReviewConnectedDecision.create({
            data: {
                tenantId, accessReviewId: id.agent, subjectRef: `agent:${agentId}`,
                subjectAgentId: agentId, subjectOwnerUserId: u.alice,
                snapshotJson: { kind: 'AGENT', agentId, agentName: agentId, ownerUserId: u.alice },
                decision: 'CONFIRM', decidedAt: AT, decidedByUserId: u.reviewer,
            },
        })).id;
    }
    const window = { windowStart: new Date('2026-07-02T00:00:00Z'), windowEnd: new Date('2026-09-30T00:00:00Z') };
    id.pack = (await prisma.accessReviewAgentPack.create({
        data: {
            tenantId, accessReviewId: id.agent, decisionId: id[`dec_${subject}`], agentId: subject,
            preparedByRunId: 'run-1', preparedByAgentId: preparer, preparationBasis: 'AGENT_RUN',
            campaignPreparerAgentId: preparer, preparedByUserId: u.owner, ...window,
            sectionsJson: { grants: [] }, contentHash: SHA('a'),
        },
    })).id;
    await prisma.accessReviewAgentPack.create({
        data: {
            tenantId, accessReviewId: id.agent, decisionId: id[`dec_${preparer}`], agentId: preparer,
            preparedByRunId: 'static', preparedByAgentId: null, preparationBasis: 'PERSON_STATIC_SELF_PACK',
            campaignPreparerAgentId: preparer, preparedByUserId: u.owner, ...window,
            sectionsJson: { grants: [] }, contentHash: SHA('b'),
        },
    });
    await prisma.accessReviewAgentNarrowing.create({
        data: {
            tenantId, accessReviewId: id.agent, decisionId: id[`dec_${subject}`], packId: id.pack,
            agentId: subject, grantId: 'grant-1', toolName: 'list_risks', grantedByUserId: u.owner, grantedAt: window.windowStart,
            basis: 'NO_RECORDED_CALL_IN_WINDOW', subjectOwnerUserId: u.alice,
            outcome: 'ACCEPTED', decidedAt: AT, decidedByUserId: u.reviewer,
            executedAt: AT, executionResult: 'GRANT_DELETED',
        },
    });
    await prisma.accessReviewDecisionSampleAudit.create({
        data: {
            tenantId, accessReviewId: id.agent, decisionId: id[`dec_${subject}`],
            samplingEpoch: `${id.agent}@2026-09-30`, outcome: 'CONCURRED', reviewedByUserId: u.bob, reviewedAt: AT,
        },
    });
}

/**
 * Teardown through the purge itself, then the retained remainder. Retained rows
 * are exactly what a purge cannot remove, so a suite that purges must clear
 * them explicitly or it leaks a Tenant row per run.
 */
async function clearOwnRows(): Promise<void> {
    const existing = await prisma.tenant.findMany({ where: { id: { in: TENANTS } }, select: { id: true } });
    for (const { id } of existing) {
        await prisma.tenant.update({ where: { id }, data: { deletedAt: new Date('2026-01-01T00:00:00Z') } });
        await purgeSoftDeletedTenants({ tenantId: id });
    }
    const t = { tenantId: { in: TENANTS } };
    await prisma.accessReviewDecisionSampleAudit.deleteMany({ where: t });
    await prisma.accessReviewAgentNarrowing.deleteMany({ where: t });
    await prisma.accessReviewAgentPack.deleteMany({ where: t });
    await prisma.accessReviewConnectedDecision.deleteMany({ where: t });
    await prisma.accessReviewDecision.deleteMany({ where: t });
    await prisma.accessReview.deleteMany({ where: t });
    // Retained by the purge too, as the regulatory artefact it is.
    await prisma.incident.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, TENANTS);
    await prisma.user.deleteMany({
        where: { emailHash: { in: TENANTS.flatMap((tn) => PEOPLE.map((p) => hashForLookup(emailOf(tn, p)))) } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
}

let keptBefore: Record<string, string[]>;
let purgedBefore: Record<string, number>;
let result: Awaited<ReturnType<typeof purgeSoftDeletedTenants>>;

beforeAll(async () => {
    await clearOwnRows();
    await seedTenant(PURGED);
    await seedTenant(KEPT);
    purgedBefore = await rowCounts(PURGED);
    keptBefore = await fullDump(KEPT);
    // Soft-deleted past the grace period, exactly as `deleteTenantUnderOrg`
    // leaves a tenant — the last-OWNER trigger exempts it on that basis.
    await prisma.tenant.update({ where: { id: PURGED }, data: { deletedAt: new Date('2026-01-01T00:00:00Z') } });
    // Scoped to the one tenant: an unscoped run would also purge any other
    // suite's soft-deleted leftovers in a shared test database.
    result = await purgeSoftDeletedTenants({ tenantId: PURGED });
});

afterAll(async () => {
    await clearOwnRows();
    await appPrisma.$disconnect();
    await prisma.$disconnect();
});

describe('a tenant purge keeps every access-review campaign, whole', () => {
    it('the fixture is what it claims — every campaign table and the business data are populated', () => {
        // POSITIVE CONTROL: an assertion about what survives is vacuous over
        // tables that were empty before the purge.
        expect(purgedBefore).toMatchObject({
            AccessReview: 4,
            AccessReviewDecision: 2,
            AccessReviewConnectedDecision: 4,
            AccessReviewAgentPack: 2,
            AccessReviewAgentNarrowing: 1,
            AccessReviewDecisionSampleAudit: 1,
            Control: 1,
            Evidence: 1,
            Incident: 1,
            IncidentEvidence: 1,
            AgenticEvidenceArtefact: 1,
            TenantMembership: 4,
            FileRecord: 1,
            ConnectedIdentityAccount: 1,
            IntegrationConnection: 1,
        });
    });

    it('purged the one tenant, and reported deleting its rows', () => {
        const mine = result.filter((r) => TENANTS.includes(r.tenantId));
        expect(mine.map((r) => r.tenantId)).toEqual([PURGED]);
        expect(mine[0].totalRows).toBeGreaterThan(0);
        expect(mine[0].deleted.Control).toBe(1);
        // The two formerly "retained" models are now in the DELETE list
        // themselves, children before their parents.
        expect(mine[0].deleted.IncidentEvidence).toBe(1);
        expect(mine[0].deleted.AgenticEvidenceArtefact).toBe(1);
        // A retained table is never in the DELETE list, so it reports nothing.
        for (const t of RETAINED_CAMPAIGN_TABLES) expect(mine[0].deleted[t]).toBeUndefined();
    });

    it('leaves EXACTLY the campaign rows — nothing more of the tenant, and nothing fewer', async () => {
        expect(await rowCounts(PURGED)).toEqual({
            AccessReview: 4,
            AccessReviewAgentNarrowing: 1,
            AccessReviewAgentPack: 2,
            AccessReviewConnectedDecision: 4,
            AccessReviewDecision: 2,
            AccessReviewDecisionSampleAudit: 1,
            Incident: 1,
        });
        // And the tombstone the campaign rows point at.
        expect(await prisma.tenant.findUnique({ where: { id: PURGED }, select: { id: true } })).toEqual({ id: PURGED });
    });

    it('a member campaign is still readable: reviewer, scope, period, closer and every decision', async () => {
        const review = await prisma.accessReview.findUniqueOrThrow({
            where: { id: ids[PURGED].member },
            include: {
                reviewer: { select: { id: true } },
                closedBy: { select: { id: true } },
                decisions: { orderBy: { decision: 'asc' } },
            },
        });
        expect(review.scope).toBe('ALL_USERS');
        expect(review.status).toBe('CLOSED');
        expect(review.periodStartAt).toEqual(new Date('2026-07-01T00:00:00Z'));
        expect(review.reviewer.id).toBe(users[PURGED].reviewer);
        expect(review.closedBy?.id).toBe(users[PURGED].owner);
        expect(review.decisions.map((d) => [d.subjectUserId, d.snapshotRole, d.decision, d.executedAt])).toEqual([
            [users[PURGED].alice, 'EDITOR', 'CONFIRM', AT],
            [users[PURGED].bob, 'READER', 'REVOKE', AT],
        ]);
        expect(review.decisions.find((d) => d.decision === 'REVOKE')?.notes).toBe('left the team');
    });

    it('what the campaign pointed at that IS purged is detached, not cascaded', async () => {
        // The membership and the evidence PDF's FileRecord are business data
        // and go; the column-scoped SET NULL keeps the row and drops only the
        // pointer — the frozen snapshot is the record of what it pointed at.
        const review = await prisma.accessReview.findUniqueOrThrow({ where: { id: ids[PURGED].member } });
        expect(review.evidenceFileRecordId).toBeNull();
        const decisions = await prisma.accessReviewDecision.findMany({ where: { accessReviewId: ids[PURGED].member } });
        expect(decisions.map((d) => d.membershipId)).toEqual([null, null]);
        const connected = await prisma.accessReviewConnectedDecision.findFirstOrThrow({
            where: { accessReviewId: ids[PURGED].connected },
        });
        expect(connected.connectedAccountId).toBeNull();
        expect(connected.snapshotJson).toMatchObject({ provider: 'okta', isAdmin: true });
        expect(connected.decision).toBe('REVOKE');
    });

    it('the legacy and agent campaigns keep their decisions, packs, narrowing and sample', async () => {
        const legacy = await prisma.accessReviewConnectedDecision.findFirstOrThrow({
            where: { accessReviewId: ids[PURGED].legacy },
        });
        expect([legacy.subjectRef, legacy.decision]).toEqual(['legacy-conn:dpatel', 'CONFIRM']);

        const packs = await prisma.accessReviewAgentPack.findMany({
            where: { accessReviewId: ids[PURGED].agent },
            orderBy: { contentHash: 'asc' },
            select: { contentHash: true, preparationBasis: true },
        });
        expect(packs).toEqual([
            { contentHash: SHA('a'), preparationBasis: 'AGENT_RUN' },
            { contentHash: SHA('b'), preparationBasis: 'PERSON_STATIC_SELF_PACK' },
        ]);
        const narrowing = await prisma.accessReviewAgentNarrowing.findFirstOrThrow({
            where: { accessReviewId: ids[PURGED].agent },
        });
        expect([narrowing.outcome, narrowing.executionResult]).toEqual(['ACCEPTED', 'GRANT_DELETED']);
        const sample = await prisma.accessReviewDecisionSampleAudit.findFirstOrThrow({
            where: { accessReviewId: ids[PURGED].agent },
        });
        expect(sample.outcome).toBe('CONCURRED');
    });

    it('keeps none of the models classed with a purged parent — the incident stays, its evidence link goes', async () => {
        // Owner decision 2026-10-18, open question 10: `IncidentEvidence` and
        // `AgenticEvidenceArtefact` (with `AgentPolicyCardVersion`,
        // `AgentProposalApproval` and `AgentProposalSampleAudit`) live and die
        // with their parent. The incident is retained; the forensic evidence
        // and the junction to it are not.
        expect(await prisma.incident.count({ where: { tenantId: PURGED } })).toBe(1);
        expect(await prisma.evidence.count({ where: { tenantId: PURGED } })).toBe(0);
        expect(await prisma.incidentEvidence.count({ where: { tenantId: PURGED } })).toBe(0);
        expect(await prisma.agenticEvidenceArtefact.count({ where: { tenantId: PURGED } })).toBe(0);
    });

    it('the other tenant is untouched — every row of every table, byte for byte', async () => {
        const after = await fullDump(KEPT);
        // Denominator first: the witness covers the tables the purge emptied
        // for the other tenant, so "equal" is not "equal and empty".
        expect(Object.keys(after)).toEqual(
            expect.arrayContaining(['Control', 'TenantMembership', 'FileRecord', 'IncidentEvidence', ...RETAINED_CAMPAIGN_TABLES]),
        );
        expect(after).toEqual(keptBefore);
    });
});
