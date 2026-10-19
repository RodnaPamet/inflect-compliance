/**
 * AUDIT WORKPAPERS (#3675, step 3b) — stored once, stamped once, linking
 * findings and never closing one, and isolated per tenant. Proved on real rows
 * under `app_user` + RLS where the claim is about the database.
 *
 *   • A workpaper is the AUDITOR's: written by a job or by a context speaking
 *     for the auditor agent, never by a person; the agent must be an ACTIVE,
 *     INDEPENDENT auditor.
 *   • ONE-WAY: every column is fixed at insert, and the review stamp is set
 *     once by a THIRD-line member who does not own the auditor. The trigger
 *     refuses any other UPDATE from every role; `app_user` holds no DELETE.
 *   • The first sample for a procedure and period is BINDING.
 *   • A workpaper LINKS findings, insert-only, and nothing on its path writes
 *     a finding.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrismaClient, MembershipStatus, Role } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { codeOf } from '../helpers/source-blocks';
import { hashForLookup } from '@/lib/security/encryption';
import { resolveTenantContext } from '@/lib/tenant-context';
import {
    getAuditWorkpaper,
    getBindingWorkpaperSample,
    linkFindingsToAuditWorkpaper,
    listAuditWorkpapers,
    recordAuditWorkpaper,
    stampAuditWorkpaperReview,
} from '@/app-layer/usecases/audit-workpaper';
import { setMembershipLineOfDefence } from '@/app-layer/usecases/membership-line-of-defence';
import { purgeSoftDeletedTenants, TENANT_PURGE_RETAINED } from '@/app-layer/usecases/tenant-purge';
import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/errors/types';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const T1 = 'workpaper-one';
const T2 = 'workpaper-two';
/** A tenant that is soft-deleted and purged by the purge test. */
const T3 = 'workpaper-purged';
const TENANTS = [T1, T2];
const ALL_TENANTS = [T1, T2, T3];
const HEX = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const ENDED = '2026-09';

type Person = 'ownerA' | 'second' | 'third' | 'first' | 'undeclared' | 'admin' | 'reader';
const PEOPLE: Person[] = ['ownerA', 'second', 'third', 'first', 'undeclared', 'admin', 'reader'];
const ROLE: Record<Person, Role> = {
    ownerA: Role.OWNER,
    second: Role.READER,
    third: Role.AUDITOR,
    first: Role.READER,
    undeclared: Role.READER,
    admin: Role.ADMIN,
    reader: Role.READER,
};
const LINE: Partial<Record<Person, 'FIRST' | 'SECOND' | 'THIRD'>> = {
    second: 'SECOND',
    third: 'THIRD',
    first: 'FIRST',
};

interface TenantFixture {
    users: Record<Person, string>;
    memberships: Record<Person, string>;
    contexts: Record<Person, RequestContext>;
    job: RequestContext;
    auditorId: string;
    asAuditor: RequestContext;
    plainAgentId: string;
    draftAuditorId: string;
    runId: string;
    findingId: string;
    evidenceId: string;
}
const fx: Record<string, TenantFixture> = {};
const emailOf = (tenantId: string, who: Person) => `${who}@${tenantId}.test`;
let seq = 0;

async function asTenant<T>(tenantId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
        return fn(tx as unknown as PrismaClient);
    });
}

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: ALL_TENANTS } };
    await prisma.auditWorkpaper.deleteMany({ where: t });
    await prisma.finding.deleteMany({ where: t });
    await prisma.evidence.deleteMany({ where: t });
    await prisma.controlTestRun.deleteMany({ where: t });
    await prisma.controlTestPlan.deleteMany({ where: t });
    await prisma.control.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, ALL_TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, ALL_TENANTS);
    });
    await prisma.user.deleteMany({
        where: { emailHash: { in: ALL_TENANTS.flatMap((tn) => PEOPLE.map((p) => hashForLookup(emailOf(tn, p)))) } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: ALL_TENANTS } } });
}

async function makeAgent(
    tenantId: string,
    owner: string,
    extra: { isAuditor?: boolean; status?: 'DRAFT' | 'ACTIVE' } = {},
) {
    seq += 1;
    const sys = await prisma.aiSystem.create({ data: { tenantId, name: `wp host ${seq}`, ownerUserId: owner } });
    return prisma.registeredAgent.create({
        data: {
            tenantId,
            aiSystemId: sys.id,
            name: `wp agent ${seq}`,
            autonomyLevel: 1,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: owner,
            status: extra.status ?? 'ACTIVE',
            riskTier: 'LOW',
            riskTierScoredAt: new Date(),
            isAuditor: extra.isAuditor ?? false,
        },
    });
}

/** A valid PASS workpaper for tenant `t`, with overrides. */
function workpaper(t: string, overrides: Record<string, unknown> = {}) {
    return {
        procedureId: 'iam.leaver_timeliness',
        catalogueVersion: 1,
        periodLabel: ENDED,
        populationDefinition: 'Employee rows with status TERMINATED and endDate inside the period',
        populationCount: 4,
        populationDigest: HEX,
        sample: { epoch: `iam.leaver_timeliness@${ENDED}`, seedFingerprint: HEX, sampledUnitIds: ['emp_1', 'emp_2'] },
        attributesTested: ['L1', 'L2', 'L3'],
        itemOutcomes: [
            { unitId: 'emp_1', outcome: 'PASS', code: null },
            { unitId: 'emp_2', outcome: 'PASS', code: null },
        ],
        exceptions: [],
        conclusion: 'PASS',
        conclusionBasis: 'ALL_SAMPLED_UNITS_PASSED',
        evidenceRefs: [fx[t].evidenceId],
        proposalIds: [],
        findingIds: [fx[t].findingId],
        auditorAgentId: fx[t].auditorId,
        controlTestRunId: fx[t].runId,
        ...overrides,
    };
}

/** A fresh period per test, so the binding-sample rule does not couple tests. */
function freshPeriod(): string {
    seq += 1;
    const year = 2000 + (seq % 25);
    const month = String((seq % 12) + 1).padStart(2, '0');
    return `${year}-${month}`;
}
function workpaperFor(t: string, period: string, overrides: Record<string, unknown> = {}) {
    return workpaper(t, {
        periodLabel: period,
        sample: { epoch: `iam.leaver_timeliness@${period}`, seedFingerprint: HEX, sampledUnitIds: ['emp_1', 'emp_2'] },
        ...overrides,
    });
}

async function refusal(p: Promise<unknown>): Promise<string | undefined> {
    const err = await p.then(
        () => null,
        (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConflictError);
    return ((err as ConflictError).details as { reason?: string } | undefined)?.reason;
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();
    for (const tenantId of TENANTS) {
        await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
        const users = {} as Record<Person, string>;
        const memberships = {} as Record<Person, string>;
        for (const who of PEOPLE) {
            const email = emailOf(tenantId, who);
            const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
            users[who] = user.id;
            const m = await prisma.tenantMembership.create({
                data: { tenantId, userId: user.id, role: ROLE[who], status: MembershipStatus.ACTIVE },
            });
            memberships[who] = m.id;
        }
        const contexts = {} as Record<Person, RequestContext>;
        for (const who of PEOPLE) {
            const resolved = await resolveTenantContext({ tenantId }, users[who]);
            contexts[who] = makeRequestContext(resolved.role, {
                tenantId,
                tenantSlug: tenantId,
                userId: users[who],
                permissions: resolved.permissions,
                appPermissions: resolved.appPermissions,
            });
        }
        for (const [who, line] of Object.entries(LINE) as [Person, 'FIRST' | 'SECOND' | 'THIRD'][]) {
            await setMembershipLineOfDefence(contexts.ownerA, memberships[who], { lineOfDefence: line });
        }

        const auditor = await makeAgent(tenantId, users.second, { isAuditor: true });
        const draftAuditor = await makeAgent(tenantId, users.second, { isAuditor: true, status: 'DRAFT' });
        const plain = await makeAgent(tenantId, users.ownerA);
        const control = await prisma.control.create({
            data: { tenantId, name: `wp control ${tenantId}`, createdByUserId: users.admin },
        });
        const plan = await prisma.controlTestPlan.create({
            data: { tenantId, controlId: control.id, name: 'Leaver timeliness', createdByUserId: users.admin },
        });
        const run = await prisma.controlTestRun.create({
            data: { tenantId, controlId: control.id, testPlanId: plan.id, createdByUserId: users.admin },
        });
        const finding = await prisma.finding.create({
            data: {
                tenantId,
                severity: 'MEDIUM',
                type: 'NONCONFORMITY',
                title: 'Leaver account still active',
                description: 'raised by a person on the auditor proposal',
                status: 'OPEN',
            },
        });
        const evidence = await prisma.evidence.create({
            data: { tenantId, type: 'TEXT', title: 'population ids', ownerUserId: users.admin },
        });

        fx[tenantId] = {
            users,
            memberships,
            contexts,
            job: makeRequestContext('ADMIN', {
                tenantId,
                tenantSlug: tenantId,
                userId: users.admin,
                actorType: 'JOB',
            }),
            auditorId: auditor.id,
            asAuditor: makeRequestContext('READER', {
                tenantId,
                tenantSlug: tenantId,
                userId: users.second,
                apiKeyId: 'auditor-key',
                agentId: auditor.id,
            }),
            plainAgentId: plain.id,
            draftAuditorId: draftAuditor.id,
            runId: run.id,
            findingId: finding.id,
            evidenceId: evidence.id,
        };
    }
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

// ─── Recording ──────────────────────────────────────────────────────

describe('a workpaper is stored by the auditor, once, with what the catalogue says it records', () => {
    it('the job the auditor runs on stores a PASS, links its finding, and audits the record', async () => {
        const period = freshPeriod();
        const stored = await recordAuditWorkpaper(fx[T1].job, workpaperFor(T1, period));
        expect(stored.findingsLinked).toBe(1);

        const row = await prisma.auditWorkpaper.findUniqueOrThrow({
            where: { id: stored.id },
            include: { findingLinks: true },
        });
        expect(row).toMatchObject({
            tenantId: T1,
            procedureId: 'iam.leaver_timeliness',
            catalogueVersion: 1,
            periodLabel: period,
            populationCount: 4,
            populationDigest: HEX,
            sampleEpoch: `iam.leaver_timeliness@${period}`,
            seedFingerprint: HEX,
            sampleSize: 2,
            sampledUnitIds: ['emp_1', 'emp_2'],
            attributesTested: ['L1', 'L2', 'L3'],
            exceptionCount: 0,
            conclusion: 'PASS',
            conclusionBasis: 'ALL_SAMPLED_UNITS_PASSED',
            evidenceRefs: [fx[T1].evidenceId],
            auditorAgentId: fx[T1].auditorId,
            controlTestRunId: fx[T1].runId,
            reviewedAt: null,
            reviewedByUserId: null,
        });
        expect(row.findingLinks.map((l) => l.findingId)).toEqual([fx[T1].findingId]);
        const audit = await prisma.auditLog.findFirst({ where: { entityId: stored.id, action: 'AUDIT_WORKPAPER_RECORDED' } });
        expect(audit?.actorType).toBe('JOB');
    });

    it('a context speaking for the auditor agent may store one; another agent may not', async () => {
        await recordAuditWorkpaper(fx[T1].asAuditor, workpaperFor(T1, freshPeriod()));
        const otherAgent = { ...fx[T1].asAuditor, agentId: fx[T1].plainAgentId };
        await expect(recordAuditWorkpaper(otherAgent, workpaperFor(T1, freshPeriod()))).rejects.toBeInstanceOf(
            ForbiddenError,
        );
    });

    it('a person never writes a workpaper, an OWNER included', async () => {
        for (const who of ['ownerA', 'second', 'third'] as const) {
            await expect(
                recordAuditWorkpaper(fx[T1].contexts[who], workpaperFor(T1, freshPeriod())),
            ).rejects.toBeInstanceOf(ForbiddenError);
        }
    });

    it('refuses an author that is not a live, ACTIVE auditor of this tenant', async () => {
        expect(await refusal(recordAuditWorkpaper(fx[T1].job, workpaperFor(T1, freshPeriod(), { auditorAgentId: 'nobody' })))).toBe(
            'AUDITOR_NOT_FOUND',
        );
        expect(
            await refusal(recordAuditWorkpaper(fx[T1].job, workpaperFor(T1, freshPeriod(), { auditorAgentId: fx[T1].plainAgentId }))),
        ).toBe('NOT_AN_AUDITOR');
        expect(
            await refusal(recordAuditWorkpaper(fx[T1].job, workpaperFor(T1, freshPeriod(), { auditorAgentId: fx[T1].draftAuditorId }))),
        ).toBe('AUDITOR_NOT_ACTIVE');
        // Another tenant's auditor is simply not found here.
        expect(
            await refusal(recordAuditWorkpaper(fx[T1].job, workpaperFor(T1, freshPeriod(), { auditorAgentId: fx[T2].auditorId }))),
        ).toBe('AUDITOR_NOT_FOUND');
    });

    it('refuses a period that has not ended unless the workpaper says exactly that', async () => {
        const now = new Date();
        const open = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
        expect(await refusal(recordAuditWorkpaper(fx[T1].job, workpaperFor(T1, open)))).toBe('PERIOD_OPEN');
        const stored = await recordAuditWorkpaper(
            fx[T1].job,
            workpaperFor(T1, open, {
                sample: null,
                itemOutcomes: [],
                findingIds: [],
                conclusion: 'INCONCLUSIVE',
                conclusionBasis: 'PERIOD_OPEN',
            }),
        );
        expect(stored.id).toBeDefined();
    });

    it('refuses a reference that does not resolve in this tenant', async () => {
        expect(await refusal(recordAuditWorkpaper(fx[T1].job, workpaperFor(T1, freshPeriod(), { controlTestRunId: fx[T2].runId })))).toBe(
            'RUN_NOT_FOUND',
        );
        expect(await refusal(recordAuditWorkpaper(fx[T1].job, workpaperFor(T1, freshPeriod(), { findingIds: [fx[T2].findingId] })))).toBe(
            'FINDING_NOT_FOUND',
        );
        expect(await refusal(recordAuditWorkpaper(fx[T1].job, workpaperFor(T1, freshPeriod(), { evidenceRefs: [fx[T2].evidenceId] })))).toBe(
            'EVIDENCE_NOT_FOUND',
        );
        expect(await refusal(recordAuditWorkpaper(fx[T1].job, workpaperFor(T1, freshPeriod(), { proposalIds: ['prop_missing'] })))).toBe(
            'PROPOSAL_NOT_FOUND',
        );
    });

    it('the database refuses an author that is not an auditor, a row born reviewed, and a PASS over nothing', async () => {
        const base = {
            tenantId: T1,
            procedureId: 'iam.leaver_timeliness',
            catalogueVersion: 1,
            periodLabel: freshPeriod(),
            populationDefinition: 'x',
            populationCount: 0,
            populationDigest: HEX,
            itemOutcomesJson: [],
            exceptionsJson: [],
            exceptionCount: 0,
            conclusion: 'INCONCLUSIVE' as const,
            conclusionBasis: 'EMPTY_POPULATION',
            auditorAgentId: fx[T1].auditorId,
            controlTestRunId: fx[T1].runId,
        };
        await expect(
            prisma.auditWorkpaper.create({ data: { ...base, auditorAgentId: fx[T1].plainAgentId } }),
        ).rejects.toThrow(/AUDIT_WORKPAPER_AUTHOR_NOT_AUDITOR/);
        await expect(
            prisma.auditWorkpaper.create({
                data: { ...base, reviewedAt: new Date(), reviewedByUserId: fx[T1].users.third },
            }),
        ).rejects.toThrow(/AUDIT_WORKPAPER_BORN_REVIEWED/);
        await expect(prisma.auditWorkpaper.create({ data: { ...base, conclusion: 'PASS' } })).rejects.toThrow(
            /AuditWorkpaper_conclusion_is_earned/,
        );
        await expect(
            prisma.auditWorkpaper.create({ data: { ...base, conclusionBasis: 'not a code' } }),
        ).rejects.toThrow(/AuditWorkpaper_shapes/);
        await expect(prisma.auditWorkpaper.create({ data: base })).resolves.toBeDefined();
    });
});

describe('an auditor that is not independent writes no workpaper', () => {
    it('refuses AUDITOR_NOT_INDEPENDENT once its owner is no longer second line', async () => {
        const second = fx[T1].memberships.second;
        await setMembershipLineOfDefence(fx[T1].contexts.ownerA, second, { lineOfDefence: 'FIRST' });
        try {
            const err = await recordAuditWorkpaper(fx[T1].job, workpaperFor(T1, freshPeriod())).catch((e: unknown) => e);
            expect(err).toBeInstanceOf(ConflictError);
            expect((err as ConflictError).details).toMatchObject({
                reason: 'AUDITOR_NOT_INDEPENDENT',
                independenceReasons: ['OWNER_NOT_SECOND_LINE'],
            });
        } finally {
            await setMembershipLineOfDefence(fx[T1].contexts.ownerA, second, { lineOfDefence: 'SECOND' });
        }
    });
});

// ─── The binding sample ─────────────────────────────────────────────

describe('the first sample for a procedure and period is binding', () => {
    it('a later run reuses it; a different one is refused, by the usecase and by the database', async () => {
        const period = freshPeriod();
        const first = await recordAuditWorkpaper(fx[T1].job, workpaperFor(T1, period));
        const binding = await getBindingWorkpaperSample(fx[T1].job, {
            auditorAgentId: fx[T1].auditorId,
            procedureId: 'iam.leaver_timeliness',
            periodLabel: period,
        });
        expect(binding).toMatchObject({ id: first.id, sampledUnitIds: ['emp_1', 'emp_2'] });

        // The same sample, a fresh evaluation: stored.
        await recordAuditWorkpaper(fx[T1].job, workpaperFor(T1, period, { populationCount: 5 }));

        // A different draw: refused by name.
        expect(
            await refusal(
                recordAuditWorkpaper(
                    fx[T1].job,
                    workpaperFor(T1, period, {
                        sample: { epoch: `iam.leaver_timeliness@${period}`, seedFingerprint: HEX, sampledUnitIds: ['emp_3', 'emp_4'] },
                        itemOutcomes: [
                            { unitId: 'emp_3', outcome: 'PASS', code: null },
                            { unitId: 'emp_4', outcome: 'PASS', code: null },
                        ],
                    }),
                ),
            ),
        ).toBe('SAMPLE_NOT_BINDING');
        expect(
            await refusal(
                recordAuditWorkpaper(
                    fx[T1].job,
                    workpaperFor(T1, period, {
                        sample: { epoch: `iam.leaver_timeliness@${period}`, seedFingerprint: HEX_B, sampledUnitIds: ['emp_1', 'emp_2'] },
                    }),
                ),
            ),
        ).toBe('SAMPLE_NOT_BINDING');

        // And a writer that skips the usecase meets the trigger.
        await expect(
            prisma.auditWorkpaper.create({
                data: {
                    tenantId: T1,
                    procedureId: 'iam.leaver_timeliness',
                    catalogueVersion: 1,
                    periodLabel: period,
                    populationDefinition: 'x',
                    populationCount: 4,
                    populationDigest: HEX,
                    sampleEpoch: `iam.leaver_timeliness@${period}`,
                    seedFingerprint: HEX,
                    sampleSize: 1,
                    sampledUnitIds: ['emp_9'],
                    itemOutcomesJson: [],
                    exceptionsJson: [],
                    exceptionCount: 0,
                    conclusion: 'INCONCLUSIVE',
                    conclusionBasis: 'ITEM_UNTESTABLE',
                    auditorAgentId: fx[T1].auditorId,
                    controlTestRunId: fx[T1].runId,
                },
            }),
        ).rejects.toThrow(/AUDIT_WORKPAPER_SAMPLE_NOT_BINDING/);
        expect(await prisma.auditWorkpaper.count({ where: { tenantId: T1, periodLabel: period } })).toBe(2);
    });

    it('a run that stopped at a precondition drew no sample and fixes nothing', async () => {
        const period = freshPeriod();
        await recordAuditWorkpaper(
            fx[T1].job,
            workpaperFor(T1, period, {
                populationCount: 0,
                sample: null,
                itemOutcomes: [],
                findingIds: [],
                conclusion: 'INCONCLUSIVE',
                conclusionBasis: 'EMPTY_POPULATION',
            }),
        );
        expect(
            await getBindingWorkpaperSample(fx[T1].job, {
                auditorAgentId: fx[T1].auditorId,
                procedureId: 'iam.leaver_timeliness',
                periodLabel: period,
            }),
        ).toBeNull();
        await recordAuditWorkpaper(fx[T1].job, workpaperFor(T1, period));
    });
});

// ─── The review stamp ───────────────────────────────────────────────

describe('a workpaper review stamp is set once and cannot change, enforced by the database', () => {
    it('a THIRD-line member stamps it; the stamp is refused a second time', async () => {
        const stored = await recordAuditWorkpaper(fx[T1].job, workpaperFor(T1, freshPeriod()));
        const stamped = await stampAuditWorkpaperReview(fx[T1].contexts.third, stored.id);
        expect(stamped.reviewedByUserId).toBe(fx[T1].users.third);
        const row = await prisma.auditWorkpaper.findUniqueOrThrow({ where: { id: stored.id } });
        expect(row.reviewedAt?.getTime()).toBe(stamped.reviewedAt.getTime());
        expect(await refusal(stampAuditWorkpaperReview(fx[T1].contexts.third, stored.id))).toBe('ALREADY_REVIEWED');
        expect(
            await prisma.auditLog.count({ where: { entityId: stored.id, action: 'AUDIT_WORKPAPER_REVIEWED' } }),
        ).toBe(1);
    });

    it('the database refuses changing or removing a stamp, and any other column, for every role', async () => {
        const stored = await recordAuditWorkpaper(fx[T1].job, workpaperFor(T1, freshPeriod()));
        await stampAuditWorkpaperReview(fx[T1].contexts.third, stored.id);

        // The table owner: the trigger, not the grant, is what stops it.
        await expect(
            prisma.auditWorkpaper.update({ where: { id: stored.id }, data: { reviewedAt: new Date(0) } }),
        ).rejects.toThrow(/IMMUTABLE_AUDIT_WORKPAPER_REVIEW/);
        await expect(
            prisma.auditWorkpaper.update({ where: { id: stored.id }, data: { reviewedByUserId: fx[T1].users.ownerA } }),
        ).rejects.toThrow(/IMMUTABLE_AUDIT_WORKPAPER_REVIEW/);
        await expect(
            prisma.auditWorkpaper.update({ where: { id: stored.id }, data: { reviewedAt: null, reviewedByUserId: null } }),
        ).rejects.toThrow(/IMMUTABLE_AUDIT_WORKPAPER_REVIEW/);
        await expect(
            prisma.auditWorkpaper.update({ where: { id: stored.id }, data: { conclusion: 'FAIL' } }),
        ).rejects.toThrow(/IMMUTABLE_AUDIT_WORKPAPER/);

        // `app_user`, the application's role: same refusal, and no DELETE at all.
        await expect(
            asTenant(T1, (tx) => tx.$executeRawUnsafe(`UPDATE "AuditWorkpaper" SET "reviewedAt" = now() WHERE "id" = $1`, stored.id)),
        ).rejects.toThrow(/IMMUTABLE_AUDIT_WORKPAPER_REVIEW/);
        await expect(
            asTenant(T1, (tx) => tx.$executeRawUnsafe(`DELETE FROM "AuditWorkpaper" WHERE "id" = $1`, stored.id)),
        ).rejects.toThrow(/permission denied/);

        const row = await prisma.auditWorkpaper.findUniqueOrThrow({ where: { id: stored.id } });
        expect(row.reviewedByUserId).toBe(fx[T1].users.third);
        expect(row.conclusion).toBe('PASS');
    });

    it('an unstamped workpaper cannot be edited either: the stamp is the only write', async () => {
        const stored = await recordAuditWorkpaper(fx[T1].job, workpaperFor(T1, freshPeriod()));
        await expect(
            prisma.auditWorkpaper.update({ where: { id: stored.id }, data: { populationCount: 1 } }),
        ).rejects.toThrow(/IMMUTABLE_AUDIT_WORKPAPER/);
        await expect(
            prisma.auditWorkpaper.update({ where: { id: stored.id }, data: { reviewedAt: new Date() } }),
        ).rejects.toThrow(/AuditWorkpaper_review_stamp_pairing/);
    });

    it('only internal audit stamps, never the auditor\'s owner, never a credential', async () => {
        const stored = await recordAuditWorkpaper(fx[T1].job, workpaperFor(T1, freshPeriod()));
        expect(await refusal(stampAuditWorkpaperReview(fx[T1].contexts.first, stored.id))).toBe('REVIEWER_NOT_THIRD_LINE');
        expect(await refusal(stampAuditWorkpaperReview(fx[T1].contexts.second, stored.id))).toBe('REVIEWER_NOT_THIRD_LINE');
        expect(await refusal(stampAuditWorkpaperReview(fx[T1].contexts.undeclared, stored.id))).toBe(
            'REVIEWER_LINE_UNDECLARED',
        );
        await expect(stampAuditWorkpaperReview(fx[T1].job, stored.id)).rejects.toBeInstanceOf(ForbiddenError);
        await expect(stampAuditWorkpaperReview(fx[T1].asAuditor, stored.id)).rejects.toBeInstanceOf(ForbiddenError);

        // The auditor's owner, moved to THIRD after the workpaper was written,
        // is still its owner and still refused.
        const second = fx[T1].memberships.second;
        await setMembershipLineOfDefence(fx[T1].contexts.ownerA, second, { lineOfDefence: 'THIRD' });
        try {
            expect(await refusal(stampAuditWorkpaperReview(fx[T1].contexts.second, stored.id))).toBe('REVIEWER_OWNS_AUDITOR');
        } finally {
            await setMembershipLineOfDefence(fx[T1].contexts.ownerA, second, { lineOfDefence: 'SECOND' });
        }
        expect((await prisma.auditWorkpaper.findUniqueOrThrow({ where: { id: stored.id } })).reviewedAt).toBeNull();
    });
});

// ─── Findings ───────────────────────────────────────────────────────

describe('a workpaper links findings and has no path that closes one', () => {
    it('links a finding at record and later, and the finding is untouched', async () => {
        const later = await prisma.finding.create({
            data: { tenantId: T1, severity: 'LOW', type: 'OBSERVATION', title: 'later', description: 'later', status: 'OPEN' },
        });
        const before = await prisma.finding.findUniqueOrThrow({ where: { id: fx[T1].findingId } });
        const stored = await recordAuditWorkpaper(fx[T1].job, workpaperFor(T1, freshPeriod()));
        const linked = await linkFindingsToAuditWorkpaper(fx[T1].job, stored.id, [later.id, fx[T1].findingId]);
        expect(linked.linked).toBe(1); // the record's own link is skipped, not duplicated

        const after = await prisma.finding.findUniqueOrThrow({ where: { id: fx[T1].findingId } });
        expect(after.status).toBe('OPEN');
        expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
        expect((await prisma.finding.findUniqueOrThrow({ where: { id: later.id } })).status).toBe('OPEN');

        const read = await getAuditWorkpaper(fx[T1].contexts.admin, stored.id);
        expect(read.findingLinks.map((l) => l.findingId).sort()).toEqual([fx[T1].findingId, later.id].sort());
    });

    it('a person cannot link one; a link is insert-only at the database', async () => {
        const stored = await recordAuditWorkpaper(fx[T1].job, workpaperFor(T1, freshPeriod()));
        await expect(
            linkFindingsToAuditWorkpaper(fx[T1].contexts.ownerA, stored.id, [fx[T1].findingId]),
        ).rejects.toBeInstanceOf(ForbiddenError);
        const link = await prisma.auditWorkpaperFinding.findFirstOrThrow({ where: { workpaperId: stored.id } });
        await expect(
            prisma.auditWorkpaperFinding.update({ where: { id: link.id }, data: { findingId: fx[T1].findingId } }),
        ).rejects.toThrow(/IMMUTABLE_AUDIT_WORKPAPER_FINDING/);
        await expect(
            asTenant(T1, (tx) => tx.$executeRawUnsafe(`DELETE FROM "AuditWorkpaperFinding" WHERE "id" = $1`, link.id)),
        ).rejects.toThrow(/permission denied/);
    });

    it('the database binds a link to a finding of the same tenant, and the link outlives the finding', async () => {
        const stored = await recordAuditWorkpaper(fx[T1].job, workpaperFor(T1, freshPeriod(), { findingIds: [] }));
        const insertLink = (findingId: string) =>
            prisma.auditWorkpaperFinding.create({ data: { tenantId: T1, workpaperId: stored.id, findingId } });
        await expect(insertLink(fx[T2].findingId)).rejects.toThrow(/AUDIT_WORKPAPER_FINDING_NOT_IN_TENANT/);
        await expect(insertLink('no-such-finding')).rejects.toThrow(/AUDIT_WORKPAPER_FINDING_NOT_IN_TENANT/);

        const doomed = await prisma.finding.create({
            data: { tenantId: T1, severity: 'LOW', type: 'OBSERVATION', title: 'doomed', description: 'd', status: 'OPEN' },
        });
        await linkFindingsToAuditWorkpaper(fx[T1].job, stored.id, [doomed.id]);
        // A hard delete — the 90-day purge of a soft-deleted finding, or the
        // tenant purge — takes the finding and leaves the record that the
        // workpaper raised it.
        await prisma.finding.delete({ where: { id: doomed.id } });
        expect(
            (await prisma.auditWorkpaperFinding.findMany({ where: { workpaperId: stored.id } })).map((l) => l.findingId),
        ).toEqual([doomed.id]);
    });

    it('nothing on the workpaper path writes a finding', () => {
        // Every Finding write verb, and the repository that owns them, collected
        // as a list rather than asserted with a matcher over the whole file:
        // the list names each offender, and an empty list is the claim.
        const root = path.resolve(__dirname, '../..');
        const writers = ['src/app-layer/usecases/audit-workpaper.ts', 'src/app-layer/repositories/AuditWorkpaperRepository.ts']
            .flatMap((rel) => {
                const code = codeOf(fs.readFileSync(path.join(root, rel), 'utf8'));
                const verbs = /\bfinding\.(?:update|updateMany|upsert|delete|deleteMany|create|createMany)\b|\bFindingRepository\b/g;
                return [...code.matchAll(verbs)].map((m) => `${rel}: ${m[0]}`);
            });
        expect(writers).toEqual([]);
        // The positive control: the scan reads the files it names, which link
        // findings through the join table.
        const repo = codeOf(fs.readFileSync(path.join(root, 'src/app-layer/repositories/AuditWorkpaperRepository.ts'), 'utf8'));
        expect([...repo.matchAll(/\bauditWorkpaperFinding\.createMany\b/g)]).toHaveLength(1);
    });
});

// ─── Reading, and two tenants ───────────────────────────────────────

describe('reading takes audits.manage', () => {
    it('an ADMIN lists and reads; a READER and an AUDITOR are refused', async () => {
        const stored = await recordAuditWorkpaper(fx[T1].job, workpaperFor(T1, freshPeriod()));
        const list = await listAuditWorkpapers(fx[T1].contexts.admin);
        expect(list.map((w) => w.id)).toContain(stored.id);
        for (const who of ['reader', 'third'] as const) {
            await expect(listAuditWorkpapers(fx[T1].contexts[who])).rejects.toBeInstanceOf(ForbiddenError);
            await expect(getAuditWorkpaper(fx[T1].contexts[who], stored.id)).rejects.toBeInstanceOf(ForbiddenError);
        }
    });
});

describe('two-tenant isolation holds on AuditWorkpaper and AuditWorkpaperFinding', () => {
    it('tenant two reads, stamps and links nothing of tenant one', async () => {
        const stored = await recordAuditWorkpaper(fx[T1].job, workpaperFor(T1, freshPeriod()));
        await expect(getAuditWorkpaper(fx[T2].contexts.admin, stored.id)).rejects.toBeInstanceOf(NotFoundError);
        expect((await listAuditWorkpapers(fx[T2].contexts.admin)).map((w) => w.id)).not.toContain(stored.id);
        await expect(stampAuditWorkpaperReview(fx[T2].contexts.third, stored.id)).rejects.toBeInstanceOf(NotFoundError);
        await expect(linkFindingsToAuditWorkpaper(fx[T2].job, stored.id, [fx[T2].findingId])).rejects.toBeInstanceOf(
            NotFoundError,
        );
        expect((await prisma.auditWorkpaper.findUniqueOrThrow({ where: { id: stored.id } })).reviewedAt).toBeNull();
    });

    it('under app_user, RLS hides tenant one\'s rows and refuses writes into it', async () => {
        const stored = await recordAuditWorkpaper(fx[T1].job, workpaperFor(T1, freshPeriod()));
        const seen = await asTenant(T2, async (tx) => ({
            workpapers: await tx.auditWorkpaper.count({ where: { id: stored.id } }),
            links: await tx.auditWorkpaperFinding.count({ where: { workpaperId: stored.id } }),
            stamped: await tx.$executeRawUnsafe(
                `UPDATE "AuditWorkpaper" SET "reviewedAt" = now(), "reviewedByUserId" = 'x' WHERE "id" = $1`,
                stored.id,
            ),
        }));
        expect(seen).toEqual({ workpapers: 0, links: 0, stamped: 0 });
        await expect(
            asTenant(T2, (tx) =>
                tx.$executeRawUnsafe(
                    `INSERT INTO "AuditWorkpaperFinding" ("id","tenantId","workpaperId","findingId") VALUES ('x-link',$1,$2,$3)`,
                    T1,
                    stored.id,
                    fx[T1].findingId,
                ),
            ),
        // Refused before RLS's WITH CHECK is reached: the insert guard runs
        // under the caller's RLS context, so tenant two's session cannot see
        // tenant one's finding and the row never gets as far as the policy.
        // Either refusal is the claim; that no link was written is the proof.
        ).rejects.toThrow(/AUDIT_WORKPAPER_FINDING_NOT_IN_TENANT|row-level security/);
        expect(await prisma.auditWorkpaperFinding.count({ where: { id: 'x-link' } })).toBe(0);
        // Tenant one's own app_user context sees its own row.
        expect(await asTenant(T1, (tx) => tx.auditWorkpaper.count({ where: { id: stored.id } }))).toBe(1);
    });
});

// ─── The tenant purge ───────────────────────────────────────────────

describe('the tenant purge keeps a workpaper, a Regulatory artefact, and still completes', () => {
    it('purges the register under it and leaves the workpaper standing', async () => {
        await prisma.tenant.create({ data: { id: T3, name: T3, slug: T3 } });
        const email = emailOf(T3, 'second');
        const owner = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        await prisma.tenantMembership.create({
            data: { tenantId: T3, userId: owner.id, role: Role.OWNER, status: MembershipStatus.ACTIVE, lineOfDefence: 'SECOND' },
        });
        const auditor = await makeAgent(T3, owner.id, { isAuditor: true });
        const control = await prisma.control.create({ data: { tenantId: T3, name: 'purge control', createdByUserId: owner.id } });
        const plan = await prisma.controlTestPlan.create({
            data: { tenantId: T3, controlId: control.id, name: 'p', createdByUserId: owner.id },
        });
        const run = await prisma.controlTestRun.create({
            data: { tenantId: T3, controlId: control.id, testPlanId: plan.id, createdByUserId: owner.id },
        });
        const workpaper = await prisma.auditWorkpaper.create({
            data: {
                tenantId: T3,
                procedureId: 'iam.leaver_timeliness',
                catalogueVersion: 1,
                periodLabel: ENDED,
                populationDefinition: 'x',
                populationCount: 0,
                populationDigest: HEX,
                itemOutcomesJson: [],
                exceptionsJson: [],
                exceptionCount: 0,
                conclusion: 'INCONCLUSIVE',
                conclusionBasis: 'EMPTY_POPULATION',
                auditorAgentId: auditor.id,
                controlTestRunId: run.id,
            },
        });
        const finding = await prisma.finding.create({
            data: { tenantId: T3, severity: 'LOW', type: 'OBSERVATION', title: 'purged', description: 'p', status: 'OPEN' },
        });
        await prisma.auditWorkpaperFinding.create({ data: { tenantId: T3, workpaperId: workpaper.id, findingId: finding.id } });
        await prisma.tenant.update({ where: { id: T3 }, data: { deletedAt: new Date(Date.now() - 365 * 86_400_000) } });

        const [result] = await purgeSoftDeletedTenants({ tenantId: T3 });
        expect(result.tenantId).toBe(T3);
        expect(result.deleted.RegisteredAgent).toBe(1);
        expect(result.deleted.AuditWorkpaper).toBeUndefined();
        expect(await prisma.registeredAgent.count({ where: { tenantId: T3 } })).toBe(0);
        const kept = await prisma.auditWorkpaper.findUniqueOrThrow({ where: { id: workpaper.id } });
        expect(kept.auditorAgentId).toBe(auditor.id);
        // The finding is a Business record and goes; the link is retained.
        expect(result.deleted.Finding).toBe(1);
        expect(result.deleted.AuditWorkpaperFinding).toBeUndefined();
        expect(await prisma.auditWorkpaperFinding.count({ where: { tenantId: T3, workpaperId: workpaper.id } })).toBe(1);
    });

    it('neither table has a foreign key to anything the purge deletes', async () => {
        const keys = await prisma.$queryRaw<Array<{ child: string; parent: string; ondelete: string }>>`
            SELECT child.relname AS child, parent.relname AS parent, con.confdeltype::text AS ondelete
              FROM pg_constraint con
              JOIN pg_class child  ON child.oid  = con.conrelid
              JOIN pg_class parent ON parent.oid = con.confrelid
             WHERE con.contype = 'f' AND child.relname IN ('AuditWorkpaper', 'AuditWorkpaperFinding')
             ORDER BY 1, 2`;
        expect(keys).toEqual([
            { child: 'AuditWorkpaper', parent: 'Tenant', ondelete: 'c' },
            { child: 'AuditWorkpaperFinding', parent: 'AuditWorkpaper', ondelete: 'c' },
            { child: 'AuditWorkpaperFinding', parent: 'Tenant', ondelete: 'c' },
        ]);
        expect(keys.filter((k) => !TENANT_PURGE_RETAINED.has(k.parent))).toEqual([]);
    });
});
