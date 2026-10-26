/**
 * THE AUDITOR AGENT'S FIVE PROCEDURES, THROUGH THE REAL CONTROL-TEST RUNNER
 * (#3676, step 3c).
 *
 * Every procedure case goes through `runControlTestRunner` — the function the
 * BullMQ executor calls — against a real database, so what is asserted is the
 * whole chain: plan → the INTEGRATION handler → the procedure → the funnel's
 * `propose_finding` as the auditor → ControlTestRun + Evidence → ONE workpaper.
 *
 * Each procedure is run over a PASSING fixture, a FAILING fixture and an EMPTY
 * population, and every failing fixture carries a STORED FIGURE THAT IS WRONG —
 * a leaver pass's result, an `executedAt` stamp, a task's copied end date, an
 * MFA check's result, a window's verdict — that says the control worked. The
 * procedure FAILs anyway, because it re-performs from the raw rows.
 *
 * Procedure 2's population always holds the memberships unit while an auditor
 * exists (its owner is an ACTIVE member, by the independence rule), so its
 * empty population is unreachable through the runner; the module is asserted
 * to return no unit when no membership is active, and the orchestrator's
 * empty-population path is the one the other four exercise.
 */
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { hashForLookup, deriveSubkey } from '@/lib/security/encryption';
import { runInTenantContext } from '@/lib/db-context';
import { ConflictError, ForbiddenError } from '@/lib/errors/types';
import { runControlTestRunner, runnerHandlerRegistry } from '@/app-layer/jobs/control-test-runner';
import { registerAgenticControlTestHandler } from '@/app-layer/services/agent-control-tests';
import { recertificationCompleteness } from '@/app-layer/services/audit-procedures/recertification-completeness';
import { grantAgentTool } from '@/app-layer/usecases/agent-tool-exposure';
import { updateRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { scheduleTestPlan } from '@/app-layer/usecases/test-scheduling';
import {
    AUDIT_PROCEDURE_LIBRARY_V1,
    auditSampleSeedPurpose,
    auditSampleSize,
    drawAuditSample,
    seedFingerprint,
} from '@/lib/agentic/audit-procedure-library';
import { populationDigest } from '@/lib/agentic/audit-workpaper';
import { listAuditWorkpapersForPeriod } from '@/app-layer/usecases/audit-workpaper';

const prisma: PrismaClient = prismaTestClient();
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(300_000);

const SUITE = `aproc-${randomUUID().slice(0, 8)}`;
const U_OWNER = `${SUITE}-owner`;
const U_SECOND = `${SUITE}-second`;
const MONTH = '2026-08';
const QUARTER = '2026-Q3';
const at = (iso: string) => new Date(iso);
const NOW = () => new Date();

interface Fixture {
    tenantId: string;
    auditorId: string;
    controlId: string;
    ownerMembershipId: string | null;
    secondMembershipId: string;
}

let seq = 0;
const next = () => `${SUITE}-${(seq += 1)}`;

async function seedUser(id: string): Promise<void> {
    const email = `${id}@example.test`;
    await prisma.user.upsert({ where: { id }, update: {}, create: { id, email, emailHash: hashForLookup(email) } });
}

/** A tenant with a second-line auditor owner, its auditor agent (granted `propose_finding`) and a control. */
async function seedTenant(label: string, opts: { ownerMember?: boolean } = {}): Promise<Fixture> {
    const tenantId = `${SUITE}-${label}`;
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
    const second = await prisma.tenantMembership.create({
        data: { tenantId, userId: U_SECOND, role: 'EDITOR', status: 'ACTIVE', lineOfDefence: 'SECOND' },
    });
    const owner =
        opts.ownerMember === false
            ? null
            : await prisma.tenantMembership.create({ data: { tenantId, userId: U_OWNER, role: 'OWNER', status: 'ACTIVE' } });
    const sys = await prisma.aiSystem.create({ data: { tenantId, name: `${tenantId} host`, ownerUserId: U_SECOND } });
    const auditor = await prisma.registeredAgent.create({
        data: {
            tenantId,
            aiSystemId: sys.id,
            name: `${tenantId} auditor`,
            autonomyLevel: 2,
            dataAccessScope: 'WRITE_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: U_SECOND,
            status: 'ACTIVE',
            riskTier: 'LOW',
            riskTierScoredAt: NOW(),
            isAuditor: true,
        },
    });
    await prisma.registeredAgentTool.create({
        data: { tenantId, agentId: auditor.id, toolName: 'propose_finding', grantedByUserId: U_SECOND },
    });
    const control = await prisma.control.create({ data: { tenantId, name: `${label} control`, createdByUserId: U_SECOND } });
    return {
        tenantId,
        auditorId: auditor.id,
        controlId: control.id,
        ownerMembershipId: owner?.id ?? null,
        secondMembershipId: second.id,
    };
}

async function seedPlan(f: Fixture, config: Record<string, unknown>): Promise<string> {
    const plan = await prisma.controlTestPlan.create({
        data: {
            tenantId: f.tenantId,
            controlId: f.controlId,
            name: `${String(config.procedure)} plan`,
            createdByUserId: U_SECOND,
            ownerUserId: U_SECOND,
            automationType: 'INTEGRATION',
            status: 'ACTIVE',
            schedule: '0 3 * * *',
            automationConfig: { auditorAgentId: f.auditorId, ...config },
        },
    });
    return plan.id;
}

async function run(f: Fixture, planId: string) {
    const result = await runControlTestRunner({
        tenantId: f.tenantId,
        testPlanId: planId,
        scheduledForIso: NOW().toISOString(),
        schedulerJobRunId: next(),
    });
    const workpapers = await prisma.auditWorkpaper.findMany({ where: { controlTestRunId: result.runId ?? '' } });
    const control = await prisma.control.findUnique({ where: { id: f.controlId }, select: { lastTested: true } });
    const proposals = await prisma.agentProposal.findMany({
        where: { tenantId: f.tenantId, agentId: f.auditorId },
        select: { id: true, kind: true, status: true },
    });
    const findings = await prisma.finding.count({ where: { tenantId: f.tenantId } });
    const evidence = result.evidenceId
        ? ((await prisma.evidence.findUnique({ where: { id: result.evidenceId }, select: { content: true } }))?.content ?? '')
        : '';
    return { result, workpapers, lastTested: control?.lastTested ?? null, proposals, findings, evidence };
}

type Exception = { unitId: string | null; code: string; proposalId?: string };
const exceptionsOf = (wp: { exceptionsJson: unknown }) => wp.exceptionsJson as Exception[];

async function identityConnection(tenantId: string, provider: string, fresh = true): Promise<string> {
    const conn = await prisma.integrationConnection.create({
        data: { tenantId, provider, name: `${provider}-${next()}`, isEnabled: true },
    });
    if (fresh) {
        await prisma.integrationExecution.create({
            data: {
                tenantId,
                connectionId: conn.id,
                provider,
                automationKey: `${provider}.sync`,
                status: 'PASSED',
                executedAt: NOW(),
                completedAt: NOW(),
            },
        });
    }
    return conn.id;
}

async function account(
    tenantId: string,
    connectionId: string,
    provider: string,
    extra: Record<string, unknown> = {},
): Promise<{ id: string; externalUserId: string }> {
    const ext = next();
    return prisma.connectedIdentityAccount.create({
        data: {
            tenantId,
            connectionId,
            provider,
            externalUserId: ext,
            email: `${ext}@example.test`,
            syncedAt: NOW(),
            ...extra,
        },
        select: { id: true, externalUserId: true },
    });
}

async function fileRecord(tenantId: string): Promise<string> {
    const f = await prisma.fileRecord.create({
        data: {
            tenantId,
            pathKey: `${tenantId}/${next()}.pdf`,
            originalName: 'evidence.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 1,
            sha256: 'a'.repeat(64),
            uploadedByUserId: U_SECOND,
        },
    });
    return f.id;
}

/** An unhashed history row at a past instant; the chain verifier grades only hashed rows. */
async function historyRow(tenantId: string, row: { entity: string; entityId: string; action: string; createdAt: Date; detailsJson: object }) {
    await prisma.auditLog.create({ data: { tenantId, userId: U_OWNER, actorType: 'USER', ...row } });
}

describeFn('library v1 audit procedures, run as the registered auditor agent', () => {
    beforeAll(async () => {
        runnerHandlerRegistry._reset();
        registerAgenticControlTestHandler();
        await seedUser(U_OWNER);
        await seedUser(U_SECOND);
    });

    afterAll(async () => {
        runnerHandlerRegistry._reset();
    });

    // ─────────────────────────────────────────────────────────────────
    // 1. Leaver timeliness
    // ─────────────────────────────────────────────────────────────────

    describe('iam.leaver_timeliness', () => {
        const config = { procedure: 'iam.leaver_timeliness', periodLabel: MONTH, parameters: { leaverWindowHours: 24 } };
        let pass: Fixture;
        let passIds: string[] = [];

        beforeAll(async () => {
            pass = await seedTenant('leaver-pass');
            const conn = await identityConnection(pass.tenantId, 'entra-id');
            // Twelve leavers, every account disabled twelve hours after the end date.
            for (let i = 0; i < 12; i += 1) {
                const end = at(`2026-08-${String(5 + i).padStart(2, '0')}T00:00:00Z`);
                const emp = await prisma.employee.create({
                    data: { tenantId: pass.tenantId, fullName: `Leaver ${i}`, workEmail: `${next()}@example.test`, status: 'TERMINATED', endDate: end },
                });
                passIds.push(emp.id);
                const acc = await account(pass.tenantId, conn, 'entra-id', { status: 'SUSPENDED' });
                const link = await prisma.identityAccountLink.create({
                    data: { tenantId: pass.tenantId, employeeId: emp.id, connectedAccountId: acc.id, matchMethod: 'EMAIL_EXACT', lastVerifiedAt: NOW() },
                });
                await prisma.identityWriteJournal.create({
                    data: {
                        tenantId: pass.tenantId,
                        linkId: link.id,
                        provider: 'entra-id',
                        externalUserId: acc.externalUserId,
                        action: 'DISABLE_ACCOUNT',
                        mode: 'AUTOMATIC',
                        priorStateJson: {},
                        outcome: 'APPLIED',
                        settledAt: new Date(end.getTime() + 12 * 3_600_000),
                    },
                });
            }
            passIds = passIds.sort();
        });

        it('PASSES a period whose every sampled leaver was disabled inside the window', async () => {
            const planId = await seedPlan(pass, config);
            const r = await run(pass, planId);
            expect(r.result.runResult).toBe('PASS');
            expect(r.workpapers).toHaveLength(1);
            const wp = r.workpapers[0];
            expect(wp).toMatchObject({ conclusion: 'PASS', conclusionBasis: 'ALL_SAMPLED_UNITS_PASSED', populationCount: 12, sampleSize: 2 });
            expect(wp.sampleEpoch).toBe(`iam.leaver_timeliness@${MONTH}`);
            expect(r.lastTested).not.toBeNull();
            expect(r.proposals).toHaveLength(0);
        });

        it('draws a sample anyone holding the seed reproduces from its epoch and the frozen ids', async () => {
            const wp = await prisma.auditWorkpaper.findFirstOrThrow({
                where: { tenantId: pass.tenantId, procedureId: 'iam.leaver_timeliness', periodLabel: MONTH, sampleEpoch: { not: null } },
                orderBy: { createdAt: 'asc' },
            });
            const seed = deriveSubkey(auditSampleSeedPurpose(pass.tenantId)).toString('hex');
            expect(wp.seedFingerprint).toBe(seedFingerprint(seed));
            expect(wp.populationDigest).toBe(populationDigest('iam.leaver_timeliness', MONTH, passIds));
            const redrawn = drawAuditSample({
                seed,
                epoch: wp.sampleEpoch as string,
                unitIds: passIds,
                size: auditSampleSize(passIds.length, null),
            });
            expect(redrawn).toEqual(wp.sampledUnitIds);
            // And the epoch, not the run, fixes it: another epoch draws another order.
            const other = drawAuditSample({ seed, epoch: `iam.leaver_timeliness@2026-07`, unitIds: passIds, size: passIds.length });
            expect(other).not.toEqual(drawAuditSample({ seed, epoch: wp.sampleEpoch as string, unitIds: passIds, size: passIds.length }));
        });

        it('writes exactly one workpaper per run, and a re-run reuses the binding sample', async () => {
            const planId = await seedPlan(pass, config);
            const first = await run(pass, planId);
            const second = await run(pass, planId);
            expect(first.workpapers).toHaveLength(1);
            expect(second.workpapers).toHaveLength(1);
            expect(second.workpapers[0].id).not.toBe(first.workpapers[0].id);
            expect(second.workpapers[0].sampledUnitIds).toEqual(first.workpapers[0].sampledUnitIds);
            const all = await prisma.auditWorkpaper.findMany({
                where: { tenantId: pass.tenantId, procedureId: 'iam.leaver_timeliness', periodLabel: MONTH },
                select: { controlTestRunId: true },
            });
            // One per run, never two for one run.
            expect(new Set(all.map((w) => w.controlTestRunId)).size).toBe(all.length);
        });

        it('FAILS on an active leaver account whatever the leaver pass stored, and raises each exception as a proposal', async () => {
            const f = await seedTenant('leaver-fail');
            const conn = await identityConnection(f.tenantId, 'okta');
            const dated = await prisma.employee.create({
                data: { tenantId: f.tenantId, fullName: 'Dated Leaver', workEmail: 'dated@leaver.example.test', status: 'TERMINATED', endDate: at('2026-08-12T00:00:00Z') },
            });
            // Reached by the email join only, ignoring case.
            await account(f.tenantId, conn, 'okta', { status: 'ACTIVE', email: 'DATED@leaver.example.test' });
            const undated = await prisma.employee.create({
                data: { tenantId: f.tenantId, fullName: 'Undated Leaver', workEmail: 'undated@leaver.example.test', status: 'TERMINATED' },
            });
            await account(f.tenantId, conn, 'okta', { status: 'ACTIVE', email: 'undated@leaver.example.test' });
            // THE WRONG STORED FIGURE: the leaver pass recorded a clean month.
            await prisma.integrationExecution.create({
                data: {
                    tenantId: f.tenantId,
                    connectionId: conn,
                    provider: 'okta',
                    automationKey: 'identity.leaver-pass',
                    status: 'PASSED',
                    resultJson: { leavers: 1, disabled: 1, stillActive: 0 },
                    executedAt: NOW(),
                    completedAt: NOW(),
                },
            });
            // A finding that exists already: nothing the auditor does may touch it.
            const existing = await prisma.finding.create({
                data: { tenantId: f.tenantId, title: 'pre-existing', description: 'pre-existing', severity: 'LOW', type: 'OBSERVATION', status: 'OPEN' },
            });

            const planId = await seedPlan(f, config);
            const r = await run(f, planId);
            expect(r.result.runResult).toBe('FAIL');
            expect(r.result.findingCreated).toBe(false);
            const wp = r.workpapers[0];
            expect(wp.conclusion).toBe('FAIL');
            const ex = exceptionsOf(wp);
            expect(ex.map((e) => [e.unitId, e.code]).sort()).toEqual(
                [
                    [dated.id, 'LEAVER_ACCOUNT_ACTIVE'],
                    [undated.id, 'LEAVER_ACCOUNT_ACTIVE_UNDATED'],
                ].sort(),
            );
            // Every exception names its own proposal, the proposals are the
            // auditor's FINDING proposals pending a person, and no Finding was written.
            expect(ex.every((e) => typeof e.proposalId === 'string')).toBe(true);
            expect(new Set(ex.map((e) => e.proposalId)).size).toBe(ex.length);
            expect([...wp.proposalIds].sort()).toEqual(ex.map((e) => e.proposalId as string).sort());
            expect(r.proposals.map((p) => [p.kind, p.status])).toEqual([
                ['FINDING', 'PENDING'],
                ['FINDING', 'PENDING'],
            ]);
            expect(r.findings).toBe(1);
            const after = await prisma.finding.findUniqueOrThrow({ where: { id: existing.id } });
            expect(after.status).toBe('OPEN');

            // What a person is shown: codes and identifiers, the library's
            // standing, and the plan's control — never a name or an address.
            const raised = await runInTenantContext(makeRequestContext('ADMIN', { tenantId: f.tenantId, userId: U_SECOND }), (db) =>
                db.agentProposal.findMany({
                    where: { tenantId: f.tenantId, agentId: f.auditorId },
                    select: { payloadJson: true, policyCardVersion: true },
                }),
            );
            for (const p of raised) {
                const payload = JSON.parse(p.payloadJson) as Record<string, string>;
                expect(payload).toMatchObject({ type: 'NONCONFORMITY', sourceKind: 'AUDIT_PROCEDURE', controlId: f.controlId });
                expect(payload.description).toMatch(/not an approved or agreed definition/);
                expect(JSON.stringify(payload)).not.toMatch(/leaver\.example\.test|Dated Leaver|Undated Leaver/i);
                // Pinned by the funnel that allowed it: this auditor has no card.
                expect(p.policyCardVersion).toBe(0);
            }
            expect(r.evidence).toMatch(/Library v1 status: PROPOSED/);

            // A re-run of the same period raises nothing twice: it names the live proposals.
            const again = await run(f, planId);
            expect(again.proposals).toHaveLength(2);
            expect(exceptionsOf(again.workpapers[0]).map((e) => e.proposalId).sort()).toEqual(
                ex.map((e) => e.proposalId as string).sort(),
            );
            expect(again.findings).toBe(1);
        });

        it('is INCONCLUSIVE on an empty population, and does not stamp lastTested', async () => {
            const f = await seedTenant('leaver-empty');
            const planId = await seedPlan(f, config);
            const r = await run(f, planId);
            expect(r.result.runResult).toBe('INCONCLUSIVE');
            expect(r.workpapers).toHaveLength(1);
            expect(r.workpapers[0]).toMatchObject({ conclusion: 'INCONCLUSIVE', conclusionBasis: 'EMPTY_POPULATION', sampleEpoch: null });
            expect(r.lastTested).toBeNull();
            expect(r.proposals).toHaveLength(0);
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // 2. Recertification completeness
    // ─────────────────────────────────────────────────────────────────

    describe('iam.recertification_completeness', () => {
        const config = { procedure: 'iam.recertification_completeness', periodLabel: QUARTER, parameters: { remediationWindowDays: 14 } };

        async function membershipCampaign(f: Fixture, decisions: (m: { owner: string; second: string }) => object[]) {
            const evidence = await fileRecord(f.tenantId);
            const review = await prisma.accessReview.create({
                data: {
                    tenantId: f.tenantId,
                    name: 'Q3 review',
                    scope: 'ALL_USERS',
                    reviewerUserId: U_SECOND,
                    createdByUserId: U_SECOND,
                    status: 'CLOSED',
                    dueAt: at('2026-09-30T00:00:00Z'),
                    closedAt: at('2026-09-20T00:00:00Z'),
                    evidenceFileRecordId: evidence,
                },
            });
            for (const d of decisions({ owner: f.ownerMembershipId as string, second: f.secondMembershipId })) {
                await prisma.accessReviewDecision.create({
                    data: { tenantId: f.tenantId, accessReviewId: review.id, snapshotMembershipStatus: 'ACTIVE', ...d } as never,
                });
            }
        }

        it('PASSES when every population was covered by a complete, closed campaign', async () => {
            const f = await seedTenant('recert-pass');
            await membershipCampaign(f, (m) => [
                { membershipId: m.owner, subjectUserId: U_OWNER, snapshotRole: 'OWNER', decision: 'CONFIRM', decidedAt: at('2026-09-10T00:00:00Z'), decidedByUserId: U_SECOND },
                { membershipId: m.second, subjectUserId: U_SECOND, snapshotRole: 'EDITOR', decision: 'CONFIRM', decidedAt: at('2026-09-10T00:00:00Z'), decidedByUserId: U_OWNER },
            ]);
            // A directory, covered by a closed CONNECTED_APP campaign whose
            // revocation a sync after the remediation window saw take effect.
            const conn = await identityConnection(f.tenantId, 'google-workspace');
            const kept = await account(f.tenantId, conn, 'google-workspace', { status: 'ACTIVE' });
            const revoked = await account(f.tenantId, conn, 'google-workspace', { status: 'DEPROVISIONED' });
            const campaign = await prisma.accessReview.create({
                data: {
                    tenantId: f.tenantId,
                    name: 'Q3 directory',
                    scope: 'CONNECTED_APP',
                    reviewerUserId: U_OWNER,
                    createdByUserId: U_SECOND,
                    status: 'CLOSED',
                    closedAt: at('2026-09-20T00:00:00Z'),
                    evidenceFileRecordId: await fileRecord(f.tenantId),
                },
            });
            for (const [acc, decision] of [[kept, 'CONFIRM'], [revoked, 'REVOKE']] as const) {
                await prisma.accessReviewConnectedDecision.create({
                    data: {
                        tenantId: f.tenantId,
                        accessReviewId: campaign.id,
                        connectedAccountId: acc.id,
                        subjectRef: `${conn}:${acc.externalUserId}`,
                        snapshotJson: { email: `${acc.externalUserId}@example.test`, connectionId: conn },
                        decision,
                        decidedAt: at('2026-09-15T00:00:00Z'),
                        decidedByUserId: U_OWNER,
                    },
                });
            }

            const r = await run(f, await seedPlan(f, config));
            expect([r.result.runResult, r.workpapers[0]?.conclusionBasis]).toEqual(['PASS', 'ALL_SAMPLED_UNITS_PASSED']);
            // The whole population is the sample.
            expect(r.workpapers[0]).toMatchObject({ conclusion: 'PASS', populationCount: 2, sampleSize: 2 });
            expect([...r.workpapers[0].sampledUnitIds].sort()).toEqual([`connection:${conn}`, 'memberships'].sort());
            expect(r.proposals).toHaveLength(0);
        });

        it('FAILS on a revocation the executedAt stamp says happened and the membership row says did not', async () => {
            const f = await seedTenant('recert-fail');
            await membershipCampaign(f, (m) => [
                // THE WRONG STORED FIGURE: executedAt is stamped, the membership is still ACTIVE.
                { membershipId: m.owner, subjectUserId: U_OWNER, snapshotRole: 'OWNER', decision: 'REVOKE', decidedAt: at('2026-09-10T00:00:00Z'), decidedByUserId: U_SECOND, executedAt: at('2026-09-20T00:00:00Z'), executedByUserId: U_SECOND },
                { membershipId: m.second, subjectUserId: U_SECOND, snapshotRole: 'EDITOR', decision: 'CONFIRM', decidedAt: at('2026-09-10T00:00:00Z'), decidedByUserId: U_OWNER },
            ]);
            // A directory nobody recertified this quarter.
            const conn = await identityConnection(f.tenantId, 'google-workspace');
            await account(f.tenantId, conn, 'google-workspace', { status: 'ACTIVE' });

            const r = await run(f, await seedPlan(f, config));
            expect(r.result.runResult).toBe('FAIL');
            expect(exceptionsOf(r.workpapers[0]).map((e) => [e.unitId, e.code]).sort()).toEqual(
                [
                    [`connection:${conn}`, 'NOT_RECERTIFIED_IN_PERIOD'],
                    ['memberships', 'REVOCATION_NOT_EXECUTED'],
                ].sort(),
            );
            expect(r.proposals).toHaveLength(2);
            expect(r.findings).toBe(0);
        });

        // ── R3 and a legacy application's population coverage (#3325; owner
        // decision, 2026-10-26). `snapshotTruncated = false` says the campaign
        // took every account its snapshot held; whether the snapshot held every
        // account the APPLICATION has is the coverage its subjects were frozen
        // with. Every legacy fixture below meets R1, R2 and R4–R7, so R3 is the
        // only attribute that can raise anything.

        type Coverage = 'UNKNOWN' | 'VERIFIED';
        interface Legacy { conn: string; snapshotId: string }

        /** An enabled legacy-mcp connection holding a COMPLETE snapshot — a unit — whose LIVE coverage is `live`. */
        async function legacyConnection(f: Fixture, live: Coverage): Promise<Legacy> {
            const conn = await prisma.integrationConnection.create({
                data: { tenantId: f.tenantId, provider: 'legacy-mcp', name: `legacy-${next()}`, isEnabled: true },
            });
            const snap = await prisma.legacyAccessSnapshot.create({
                data: {
                    tenantId: f.tenantId,
                    connectionId: conn.id,
                    remoteSnapshotId: next(),
                    mappingVersion: 1,
                    columnSetFingerprint: 'f'.repeat(64),
                    payloadHash: 'a'.repeat(64),
                    rowCount: 2,
                    rowsReceived: 2,
                    status: 'COMPLETE',
                    completedAt: at('2026-09-01T00:00:00Z'),
                    populationCoverage: live,
                },
            });
            return { conn: conn.id, snapshotId: snap.id };
        }

        /**
         * A closed LEGACY_APP campaign over `legacy`: two CONFIRM subjects in the
         * shape the legacy create freezes, with `frozen` as the provenance's
         * coverage — `undefined` is a subject frozen before the column existed.
         */
        async function legacyCampaign(f: Fixture, legacy: Legacy, frozen: Coverage | undefined, truncated: boolean) {
            const review = await prisma.accessReview.create({
                data: {
                    tenantId: f.tenantId,
                    name: `Q3 legacy ${next()}`,
                    scope: 'LEGACY_APP',
                    reviewerUserId: U_OWNER,
                    createdByUserId: U_SECOND,
                    status: 'CLOSED',
                    closedAt: at('2026-09-20T00:00:00Z'),
                    snapshotTruncated: truncated,
                    evidenceFileRecordId: await fileRecord(f.tenantId),
                },
            });
            for (const accountKey of ['acc_1', 'acc_2']) {
                await prisma.accessReviewConnectedDecision.create({
                    data: {
                        tenantId: f.tenantId,
                        accessReviewId: review.id,
                        connectedAccountId: null,
                        subjectRef: `${legacy.conn}:${accountKey}`,
                        snapshotJson: {
                            accountKey,
                            email: `${accountKey}@legacy.test`,
                            provenance: {
                                snapshotId: legacy.snapshotId,
                                payloadHash: 'a'.repeat(64),
                                mappingVersion: 1,
                                connectionId: legacy.conn,
                                ...(frozen === undefined ? {} : { populationCoverage: frozen }),
                            },
                        },
                        decision: 'CONFIRM',
                        decidedAt: at('2026-09-15T00:00:00Z'),
                        decidedByUserId: U_OWNER,
                    },
                });
            }
        }

        /** A closed CONNECTED_APP campaign over one ACTIVE account of a fresh directory: R1, R2 and R4–R7 met. */
        async function directoryCampaign(f: Fixture, truncated: boolean): Promise<string> {
            const conn = await identityConnection(f.tenantId, 'google-workspace');
            const acc = await account(f.tenantId, conn, 'google-workspace', { status: 'ACTIVE' });
            const review = await prisma.accessReview.create({
                data: {
                    tenantId: f.tenantId,
                    name: `Q3 directory ${next()}`,
                    scope: 'CONNECTED_APP',
                    reviewerUserId: U_OWNER,
                    createdByUserId: U_SECOND,
                    status: 'CLOSED',
                    closedAt: at('2026-09-20T00:00:00Z'),
                    snapshotTruncated: truncated,
                    evidenceFileRecordId: await fileRecord(f.tenantId),
                },
            });
            await prisma.accessReviewConnectedDecision.create({
                data: {
                    tenantId: f.tenantId,
                    accessReviewId: review.id,
                    connectedAccountId: acc.id,
                    subjectRef: `${conn}:${acc.externalUserId}`,
                    snapshotJson: { email: `${acc.externalUserId}@example.test`, connectionId: conn },
                    decision: 'CONFIRM',
                    decidedAt: at('2026-09-15T00:00:00Z'),
                    decidedByUserId: U_OWNER,
                },
            });
            return `connection:${conn}`;
        }

        /** The module's judgement of exactly `units`, keyed by unit, as `[outcome, exceptionCodes]`. */
        async function judge(f: Fixture, units: string[]): Promise<Record<string, [string, readonly string[]]>> {
            const ctx = makeRequestContext('ADMIN', { tenantId: f.tenantId, userId: U_SECOND });
            return runInTenantContext(ctx, async (db) => {
                const reading = await recertificationCompleteness.read({
                    db,
                    tenantId: f.tenantId,
                    periodLabel: QUARTER,
                    periodStart: at('2026-07-01T00:00:00Z'),
                    periodEnd: at('2026-10-01T00:00:00Z'),
                    now: NOW(),
                    parameters: { remediationWindowDays: 14 },
                });
                expect([...reading.unitIds].sort()).toEqual(expect.arrayContaining([...units].sort()));
                const { units: judged } = await reading.evaluate(units);
                return Object.fromEntries(judged.map((u) => [u.unitId, [u.outcome, u.exceptionCodes]]));
            });
        }

        it('rules R3 for a legacy application on the coverage its subjects were FROZEN with, and every other scope as before', async () => {
            const f = await seedTenant('recert-coverage');
            await membershipCampaign(f, (m) => [
                { membershipId: m.owner, subjectUserId: U_OWNER, snapshotRole: 'OWNER', decision: 'CONFIRM', decidedAt: at('2026-09-10T00:00:00Z'), decidedByUserId: U_SECOND },
                { membershipId: m.second, subjectUserId: U_SECOND, snapshotRole: 'EDITOR', decision: 'CONFIRM', decidedAt: at('2026-09-10T00:00:00Z'), decidedByUserId: U_OWNER },
            ]);
            // The LIVE snapshot row says the opposite of what was frozen, on
            // both sides: the procedure reads what the campaign certified.
            const unknown = await legacyConnection(f, 'VERIFIED');
            await legacyCampaign(f, unknown, 'UNKNOWN', false);
            const verified = await legacyConnection(f, 'UNKNOWN');
            await legacyCampaign(f, verified, 'VERIFIED', false);
            const beforeColumn = await legacyConnection(f, 'VERIFIED');
            await legacyCampaign(f, beforeColumn, undefined, false);
            // Truncated AND unverified: truncation is the observed fact, and R3
            // has one result.
            const truncatedUnknown = await legacyConnection(f, 'UNKNOWN');
            await legacyCampaign(f, truncatedUnknown, 'UNKNOWN', true);
            const truncatedVerified = await legacyConnection(f, 'VERIFIED');
            await legacyCampaign(f, truncatedVerified, 'VERIFIED', true);
            const directory = await directoryCampaign(f, false);
            const truncatedDirectory = await directoryCampaign(f, true);

            const legacy = (l: Legacy) => `legacy:${l.conn}`;
            expect(
                await judge(f, [
                    'memberships',
                    directory,
                    truncatedDirectory,
                    legacy(unknown),
                    legacy(verified),
                    legacy(beforeColumn),
                    legacy(truncatedUnknown),
                    legacy(truncatedVerified),
                ]),
            ).toEqual({
                memberships: ['PASS', []],
                [directory]: ['PASS', []],
                [truncatedDirectory]: ['EXCEPTION', ['CAMPAIGN_TRUNCATED']],
                [legacy(unknown)]: ['EXCEPTION', ['POPULATION_COVERAGE_UNVERIFIED']],
                [legacy(verified)]: ['PASS', []],
                [legacy(beforeColumn)]: ['EXCEPTION', ['POPULATION_COVERAGE_UNVERIFIED']],
                [legacy(truncatedUnknown)]: ['EXCEPTION', ['CAMPAIGN_TRUNCATED']],
                [legacy(truncatedVerified)]: ['EXCEPTION', ['CAMPAIGN_TRUNCATED']],
            });
        });

        it('FAILS a quarter whose only shortfall is a legacy campaign of unverified coverage, and proposes it as a finding', async () => {
            const f = await seedTenant('recert-coverage-run');
            await membershipCampaign(f, (m) => [
                { membershipId: m.owner, subjectUserId: U_OWNER, snapshotRole: 'OWNER', decision: 'CONFIRM', decidedAt: at('2026-09-10T00:00:00Z'), decidedByUserId: U_SECOND },
                { membershipId: m.second, subjectUserId: U_SECOND, snapshotRole: 'EDITOR', decision: 'CONFIRM', decidedAt: at('2026-09-10T00:00:00Z'), decidedByUserId: U_OWNER },
            ]);
            const legacy = await legacyConnection(f, 'UNKNOWN');
            await legacyCampaign(f, legacy, 'UNKNOWN', false);

            const r = await run(f, await seedPlan(f, config));
            expect([r.result.runResult, r.workpapers[0]?.conclusion, r.workpapers[0]?.conclusionBasis]).toEqual([
                'FAIL',
                'FAIL',
                'EXCEPTIONS_FOUND',
            ]);
            expect(exceptionsOf(r.workpapers[0]).map((e) => [e.unitId, e.code])).toEqual([
                [`legacy:${legacy.conn}`, 'POPULATION_COVERAGE_UNVERIFIED'],
            ]);
            expect(r.proposals).toHaveLength(1);
            expect(r.findings).toBe(0);
            // Written under the catalogue version that holds this rule (#4379).
            // A literal, not the constant: reading the constant passes whatever
            // the build stamps.
            expect(r.workpapers[0].catalogueVersion).toBe(2);
        });

        // ── A period audited under version 1, run again under version 2. The
        // binding key is (tenant, procedure, period), with no catalogue version
        // in it — in the trigger and in `findBindingSample` alike. So the re-run
        // is a SECOND workpaper, recording version 2, held to the version 1
        // sample and re-judging it under version 2's rules. Version 2 changes an
        // attribute, not the population or the draw, so the sample a version 2
        // run would have drawn is the same one. The version 1 row is untouched
        // and still reads as version 1.
        it('re-runs a period holding a version 1 workpaper as a second workpaper, version 2, on the version 1 sample', async () => {
            const f = await seedTenant('recert-v1-then-v2');
            await membershipCampaign(f, (m) => [
                { membershipId: m.owner, subjectUserId: U_OWNER, snapshotRole: 'OWNER', decision: 'CONFIRM', decidedAt: at('2026-09-10T00:00:00Z'), decidedByUserId: U_SECOND },
                { membershipId: m.second, subjectUserId: U_SECOND, snapshotRole: 'EDITOR', decision: 'CONFIRM', decidedAt: at('2026-09-10T00:00:00Z'), decidedByUserId: U_OWNER },
            ]);
            const legacy = await legacyConnection(f, 'UNKNOWN');
            await legacyCampaign(f, legacy, 'UNKNOWN', false);

            // The row a version 1 build wrote for the quarter: the whole
            // population, drawn in keyed order, and a PASS, because version 1's
            // R3 asked about truncation alone.
            const procedure = 'iam.recertification_completeness';
            const units = ['memberships', `legacy:${legacy.conn}`];
            const seed = deriveSubkey(auditSampleSeedPurpose(f.tenantId)).toString('hex');
            const epoch = `${procedure}@${QUARTER}`;
            const sampled = drawAuditSample({ seed, epoch, unitIds: units, size: units.length });
            const v1 = await prisma.auditWorkpaper.create({
                data: {
                    tenantId: f.tenantId,
                    procedureId: procedure,
                    catalogueVersion: 1,
                    periodLabel: QUARTER,
                    populationDefinition: AUDIT_PROCEDURE_LIBRARY_V1[procedure].populationDefinition,
                    populationCount: units.length,
                    populationDigest: populationDigest(procedure, QUARTER, units),
                    sampleEpoch: epoch,
                    seedFingerprint: seedFingerprint(seed),
                    sampleSize: sampled.length,
                    sampledUnitIds: sampled,
                    parametersJson: { remediationWindowDays: 14 },
                    attributesTested: [...AUDIT_PROCEDURE_LIBRARY_V1[procedure].attributes],
                    itemOutcomesJson: sampled.map((unitId) => ({ unitId, outcome: 'PASS', code: null })),
                    exceptionsJson: [],
                    exceptionCount: 0,
                    conclusion: 'PASS',
                    conclusionBasis: 'ALL_SAMPLED_UNITS_PASSED',
                    auditorAgentId: f.auditorId,
                    controlTestRunId: `${SUITE}-v1-run`,
                },
            });

            const r = await run(f, await seedPlan(f, config));
            expect(r.workpapers).toHaveLength(1);
            const v2 = r.workpapers[0];
            expect(v2.id).not.toBe(v1.id);
            expect([v2.catalogueVersion, v2.sampleEpoch, v2.seedFingerprint, v2.sampledUnitIds]).toEqual([
                2,
                v1.sampleEpoch,
                v1.seedFingerprint,
                v1.sampledUnitIds,
            ]);
            expect([v2.conclusion, exceptionsOf(v2).map((e) => [e.unitId, e.code])]).toEqual([
                'FAIL',
                [[`legacy:${legacy.conn}`, 'POPULATION_COVERAGE_UNVERIFIED']],
            ]);
            expect(r.evidence).toContain(`the binding sample of workpaper ${v1.id}, reused`);

            // The version 1 row is as it was written, and every reader takes the
            // version from the row.
            const stored = await prisma.auditWorkpaper.findUniqueOrThrow({ where: { id: v1.id } });
            expect([stored.catalogueVersion, stored.conclusion, stored.exceptionCount]).toEqual([1, 'PASS', 0]);
            const view = await listAuditWorkpapersForPeriod(
                makeRequestContext('ADMIN', { tenantId: f.tenantId, userId: U_SECOND }),
                QUARTER,
            );
            expect(
                view.workpapers
                    .filter((w) => w.procedureId === procedure)
                    .map((w) => [w.workpaperId, w.catalogueVersion, w.conclusion])
                    .sort(),
            ).toEqual(
                [
                    [v1.id, 1, 'PASS'],
                    [v2.id, 2, 'FAIL'],
                ].sort(),
            );

            // And the database holds a version 2 row to the version 1 sample
            // whoever writes it: a different draw is refused.
            const insertOther = prisma.auditWorkpaper.create({
                data: {
                    tenantId: f.tenantId,
                    procedureId: procedure,
                    catalogueVersion: 2,
                    periodLabel: QUARTER,
                    populationDefinition: AUDIT_PROCEDURE_LIBRARY_V1[procedure].populationDefinition,
                    populationCount: units.length,
                    populationDigest: populationDigest(procedure, QUARTER, units),
                    sampleEpoch: epoch,
                    seedFingerprint: seedFingerprint(seed),
                    sampleSize: 1,
                    sampledUnitIds: [sampled[0]],
                    itemOutcomesJson: [],
                    exceptionsJson: [],
                    exceptionCount: 0,
                    conclusion: 'INCONCLUSIVE',
                    conclusionBasis: 'ITEM_UNTESTABLE',
                    auditorAgentId: f.auditorId,
                    controlTestRunId: `${SUITE}-v2-other-run`,
                },
            });
            await expect(insertOther).rejects.toThrow(/AUDIT_WORKPAPER_SAMPLE_NOT_BINDING/);
        });

        it('has no unit to test when no membership is active (the module, since an auditor\'s owner always is one)', async () => {
            const tenantId = `${SUITE}-recert-none`;
            await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
            const ctx = makeRequestContext('ADMIN', { tenantId, userId: U_SECOND });
            const reading = await runInTenantContext(ctx, (db) =>
                recertificationCompleteness.read({
                    db,
                    tenantId,
                    periodLabel: QUARTER,
                    periodStart: at('2026-07-01T00:00:00Z'),
                    periodEnd: at('2026-10-01T00:00:00Z'),
                    now: NOW(),
                    parameters: { remediationWindowDays: 14 },
                }),
            );
            expect(reading.unitIds).toEqual([]);
            expect(reading.populationExceptions).toEqual([]);
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // 3. Time-bounded access expiry
    // ─────────────────────────────────────────────────────────────────

    describe('iam.time_bounded_access_expiry', () => {
        const config = { procedure: 'iam.time_bounded_access_expiry', periodLabel: MONTH };

        async function grant(tenantId: string, row: { attemptedAt: Date; end: string; outcome?: 'APPLIED' | 'ACCEPTED'; verified?: Date; raised?: Date }) {
            return prisma.externalWriteJournal.create({
                data: {
                    tenantId,
                    connectionName: 'entra-grants',
                    endpointUrl: 'https://mcp.example.test/entra-grant',
                    toolName: 'grant_time_bounded_access',
                    advertisedToolName: 'grant_time_bounded_access',
                    mode: 'AUTOMATIC',
                    argumentsJson: JSON.stringify({ endDateTime: row.end }),
                    priorStateJson: JSON.stringify({}),
                    outcome: row.outcome ?? 'APPLIED',
                    attemptedAt: row.attemptedAt,
                    settledAt: row.attemptedAt,
                    expiryVerifiedAt: row.verified ?? null,
                    expiryRaisedAt: row.raised ?? null,
                },
            });
        }

        it('PASSES a grant that was bounded, delivered and seen gone', async () => {
            const f = await seedTenant('expiry-pass');
            await grant(f.tenantId, { attemptedAt: at('2026-07-20T00:00:00Z'), end: '2026-08-15T00:00:00Z', verified: at('2026-08-16T00:00:00Z') });
            const r = await run(f, await seedPlan(f, config));
            expect(r.result.runResult).toBe('PASS');
            expect(r.workpapers[0]).toMatchObject({ conclusion: 'PASS', populationCount: 1 });
        });

        it('FAILS an unbounded grant whatever end date its remediation task copied, and an outlived grant nobody tasked', async () => {
            const f = await seedTenant('expiry-fail');
            const unbounded = await grant(f.tenantId, { attemptedAt: at('2026-08-03T00:00:00Z'), end: '2026-12-01T00:00:00Z' });
            // THE WRONG STORED FIGURE: the task copied an in-bound end date.
            await prisma.task.create({
                data: {
                    tenantId: f.tenantId,
                    title: 'grant follow-up',
                    createdByUserId: U_SECOND,
                    source: 'GRANT_EXPIRY',
                    metadataJson: { externalWriteJournalId: unbounded.id, endDateTime: '2026-08-20T00:00:00Z', overdueDays: 0 },
                },
            });
            const outlived = await grant(f.tenantId, { attemptedAt: at('2026-07-25T00:00:00Z'), end: '2026-08-20T00:00:00Z', raised: at('2026-08-22T00:00:00Z') });

            const r = await run(f, await seedPlan(f, { ...config, sampleSize: 2 }));
            expect(r.result.runResult).toBe('FAIL');
            expect(exceptionsOf(r.workpapers[0]).map((e) => [e.unitId, e.code]).sort()).toEqual(
                [
                    [unbounded.id, 'GRANT_UNBOUNDED'],
                    [outlived.id, 'GRANT_OUTLIVED_WINDOW'],
                    [outlived.id, 'OUTLIVED_GRANT_NOT_TASKED'],
                ].sort(),
            );
            expect(r.proposals).toHaveLength(3);
            expect(r.findings).toBe(0);
        });

        it('is INCONCLUSIVE when no time-bounded grant ended in the period', async () => {
            const f = await seedTenant('expiry-empty');
            const r = await run(f, await seedPlan(f, config));
            expect(r.result.runResult).toBe('INCONCLUSIVE');
            expect(r.workpapers[0].conclusionBasis).toBe('EMPTY_POPULATION');
            expect(r.lastTested).toBeNull();
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // 4. Privileged access
    // ─────────────────────────────────────────────────────────────────

    describe('iam.privileged_access', () => {
        const config = { procedure: 'iam.privileged_access', periodLabel: QUARTER };

        it('PASSES privileged accounts and memberships that are attributable, MFA-enrolled and recertified', async () => {
            const f = await seedTenant('priv-pass');
            const conn = await identityConnection(f.tenantId, 'google-workspace');
            const admin = await account(f.tenantId, conn, 'google-workspace', { isAdmin: true, mfaEnrolled: true });
            const emp = await prisma.employee.create({
                data: { tenantId: f.tenantId, fullName: 'Admin Person', workEmail: `${next()}@example.test`, status: 'ACTIVE' },
            });
            await prisma.identityAccountLink.create({
                data: { tenantId: f.tenantId, employeeId: emp.id, connectedAccountId: admin.id, matchMethod: 'EMAIL_EXACT', lastVerifiedAt: NOW() },
            });
            const connected = await prisma.accessReview.create({
                data: { tenantId: f.tenantId, name: 'gw', scope: 'CONNECTED_APP', reviewerUserId: U_SECOND, createdByUserId: U_SECOND, status: 'CLOSED', closedAt: at('2026-09-10T00:00:00Z') },
            });
            await prisma.accessReviewConnectedDecision.create({
                data: { tenantId: f.tenantId, accessReviewId: connected.id, connectedAccountId: admin.id, subjectRef: `${conn}:${admin.externalUserId}`, snapshotJson: {}, decision: 'CONFIRM', decidedAt: at('2026-09-05T00:00:00Z'), decidedByUserId: U_OWNER },
            });
            const members = await prisma.accessReview.create({
                data: { tenantId: f.tenantId, name: 'admins', scope: 'ADMIN_ONLY', reviewerUserId: U_SECOND, createdByUserId: U_SECOND, status: 'CLOSED', closedAt: at('2026-09-12T00:00:00Z') },
            });
            await prisma.accessReviewDecision.create({
                data: { tenantId: f.tenantId, accessReviewId: members.id, membershipId: f.ownerMembershipId, subjectUserId: U_OWNER, snapshotRole: 'OWNER', snapshotMembershipStatus: 'ACTIVE', decision: 'CONFIRM', decidedAt: at('2026-09-11T00:00:00Z'), decidedByUserId: U_SECOND },
            });

            const r = await run(f, await seedPlan(f, config));
            expect(r.result.runResult).toBe('PASS');
            const wp = r.workpapers[0];
            // Two sub-populations, each sampled on its own; one frozen list.
            expect(wp.populationCount).toBe(2);
            expect([...wp.sampledUnitIds].sort()).toEqual([`directory:${admin.id}`, `membership:${f.ownerMembershipId}`].sort());
            expect(wp.sampleEpoch).toBe(`iam.privileged_access@${QUARTER}`);
        });

        it('FAILS an admin without MFA on a provider that reports it, whatever the MFA check stored', async () => {
            const f = await seedTenant('priv-fail');
            const conn = await identityConnection(f.tenantId, 'google-workspace');
            const admin = await account(f.tenantId, conn, 'google-workspace', { isAdmin: true, mfaEnrolled: false });
            // THE WRONG STORED FIGURE: the provider's admin-MFA check reported every admin enrolled.
            await prisma.integrationExecution.create({
                data: {
                    tenantId: f.tenantId,
                    connectionId: conn,
                    provider: 'google-workspace',
                    automationKey: 'google-workspace.admin_mfa',
                    status: 'PASSED',
                    resultJson: { admins: 1, adminsWithoutMfa: 0 },
                    executedAt: NOW(),
                    completedAt: NOW(),
                },
            });
            const r = await run(f, await seedPlan(f, config));
            expect(r.result.runResult).toBe('FAIL');
            expect(exceptionsOf(r.workpapers[0]).map((e) => [e.unitId, e.code]).sort()).toEqual(
                [
                    [`directory:${admin.id}`, 'PRIVILEGED_UNATTRIBUTED'],
                    [`directory:${admin.id}`, 'PRIVILEGED_WITHOUT_MFA'],
                    [`directory:${admin.id}`, 'PRIVILEGE_NOT_RECERTIFIED'],
                    [`membership:${f.ownerMembershipId}`, 'PRIVILEGE_NOT_RECERTIFIED'],
                ].sort(),
            );
            expect(r.proposals).toHaveLength(4);
            expect(r.findings).toBe(0);
        });

        it('is INCONCLUSIVE when both sub-populations are empty', async () => {
            const f = await seedTenant('priv-empty', { ownerMember: false });
            const r = await run(f, await seedPlan(f, config));
            expect(r.result.runResult).toBe('INCONCLUSIVE');
            expect(r.workpapers[0].conclusionBasis).toBe('EMPTY_POPULATION');
            expect(r.lastTested).toBeNull();
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // 5. Agent authority conformance
    // ─────────────────────────────────────────────────────────────────

    describe('agent.authority_conformance', () => {
        const config = { procedure: 'agent.authority_conformance', periodLabel: MONTH };

        async function auditedAgentHour(f: Fixture, permittedTools: string[]) {
            const sys = await prisma.aiSystem.create({ data: { tenantId: f.tenantId, name: `${next()} host`, ownerUserId: U_OWNER } });
            const agent = await prisma.registeredAgent.create({
                data: {
                    tenantId: f.tenantId,
                    aiSystemId: sys.id,
                    name: `${next()} agent`,
                    autonomyLevel: 2,
                    dataAccessScope: 'READ_TENANT_DATA',
                    reversibility: 'REVERSIBLE',
                    provenance: 'FIRST_PARTY',
                    ownerUserId: U_OWNER,
                    status: 'ACTIVE',
                    riskTier: 'LOW',
                    riskTierScoredAt: NOW(),
                },
            });
            await historyRow(f.tenantId, { entity: 'RegisteredAgent', entityId: agent.id, action: 'AGENT_REGISTERED', createdAt: at('2026-07-01T00:00:00Z'), detailsJson: { after: { status: 'ACTIVE' } } });
            await historyRow(f.tenantId, { entity: 'RegisteredAgent', entityId: agent.id, action: 'AGENT_TOOL_GRANTED', createdAt: at('2026-07-01T00:01:00Z'), detailsJson: { after: { toolName: 'list_risks', agentId: agent.id } } });
            await prisma.registeredAgentTool.create({
                data: { tenantId: f.tenantId, agentId: agent.id, toolName: 'list_risks', grantedByUserId: U_OWNER, createdAt: at('2026-07-01T00:01:00Z') },
            });
            const card = await prisma.agentPolicyCard.create({
                // THE WRONG STORED FIGURE, for the failing fixture: the card's own window count.
                data: { tenantId: f.tenantId, agentId: agent.id, currentVersion: 1, actionsInWindow: 0, createdByUserId: U_OWNER },
            });
            await prisma.agentPolicyCardVersion.create({
                data: {
                    tenantId: f.tenantId,
                    cardId: card.id,
                    version: 1,
                    permittedTools,
                    maxDataScope: 'READ_TENANT_DATA',
                    maxAutonomyLevel: 2,
                    maxActionsPerRun: 10,
                    maxActionsPerDay: 100,
                    escalationTriggers: [],
                    approvalRung: 'SINGLE_APPROVER',
                    createdByUserId: U_OWNER,
                },
            });
            const window = await prisma.agentBehaviourWindow.create({
                // …and the circuit breaker's verdict on the window, which said all was well.
                data: { tenantId: f.tenantId, agentId: agent.id, windowStart: at('2026-08-05T10:00:00Z'), readCalls: 1, toolNames: ['list_risks'], anomalous: false, verdict: 'STEADY' },
            });
            await historyRow(f.tenantId, { entity: 'McpTool', entityId: 'list_risks', action: 'MCP_TOOL_INVOKED', createdAt: at('2026-08-05T10:15:00Z'), detailsJson: { tool: 'list_risks', agentId: agent.id, policyCardVersion: 1 } });
            return window.id;
        }

        it('PASSES an hour whose every call sat inside the grant, the card and an ACTIVE registration', async () => {
            const f = await seedTenant('authority-pass');
            await auditedAgentHour(f, ['list_risks']);
            const r = await run(f, await seedPlan(f, config));
            expect([r.result.runResult, r.workpapers[0]?.conclusionBasis]).toEqual(['PASS', 'ALL_SAMPLED_UNITS_PASSED']);
            expect(r.workpapers[0]).toMatchObject({ conclusion: 'PASS', populationCount: 1, sampleSize: 1 });
        });

        it('FAILS a call outside the card version that allowed it, whatever the window verdict said', async () => {
            const f = await seedTenant('authority-fail');
            const windowId = await auditedAgentHour(f, ['list_controls']);
            const r = await run(f, await seedPlan(f, config));
            expect([r.result.runResult, r.workpapers[0]?.conclusionBasis]).toEqual(['FAIL', 'EXCEPTIONS_FOUND']);
            expect(exceptionsOf(r.workpapers[0]).map((e) => [e.unitId, e.code])).toEqual([[windowId, 'TOOL_NOT_ON_CARD']]);
            expect(r.proposals).toHaveLength(1);
            expect(r.findings).toBe(0);
        });

        it('does not audit the auditor: its own windows are excluded, and an empty population is INCONCLUSIVE', async () => {
            const f = await seedTenant('authority-empty');
            await prisma.agentBehaviourWindow.create({
                data: { tenantId: f.tenantId, agentId: f.auditorId, windowStart: at('2026-08-07T09:00:00Z'), readCalls: 0, proposeCalls: 1, toolNames: ['propose_finding'] },
            });
            const r = await run(f, await seedPlan(f, config));
            expect(r.result.runResult).toBe('INCONCLUSIVE');
            expect(r.workpapers[0].conclusionBasis).toBe('EMPTY_POPULATION');
            expect(r.lastTested).toBeNull();
            expect(r.evidence).toContain('auditorWindowsExcluded=1');
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // The auditor reads and proposes; it holds nothing else
    // ─────────────────────────────────────────────────────────────────

    describe('the auditor holds only read tools and propose_finding', () => {
        let f: Fixture;
        beforeAll(async () => {
            f = await seedTenant('remit');
        });
        const ownerCtx = () => makeRequestContext('OWNER', { tenantId: f.tenantId, userId: U_OWNER });

        async function reason(p: Promise<unknown>): Promise<string | undefined> {
            const err = await p.then(() => null, (e: unknown) => e);
            expect(err).toBeInstanceOf(ConflictError);
            return ((err as ConflictError).details as { reason?: string } | undefined)?.reason;
        }

        it('refuses granting an auditor any tool outside its remit, and grants a read tool', async () => {
            expect(await reason(grantAgentTool(ownerCtx(), f.auditorId, { toolName: 'propose_risks' }))).toBe('AUDITOR_REMIT_EXCEEDED');
            await expect(grantAgentTool(ownerCtx(), f.auditorId, { toolName: 'list_findings' })).resolves.toMatchObject({ toolName: 'list_findings' });
        });

        it('refuses marking an agent an auditor while it holds a tool outside the remit', async () => {
            const sys = await prisma.aiSystem.create({ data: { tenantId: f.tenantId, name: `${next()} host`, ownerUserId: U_SECOND } });
            const agent = await prisma.registeredAgent.create({
                data: {
                    tenantId: f.tenantId,
                    aiSystemId: sys.id,
                    name: `${next()} would-be auditor`,
                    autonomyLevel: 2,
                    dataAccessScope: 'WRITE_TENANT_DATA',
                    reversibility: 'REVERSIBLE',
                    provenance: 'FIRST_PARTY',
                    ownerUserId: U_SECOND,
                    status: 'DRAFT',
                    riskTier: 'LOW',
                    riskTierScoredAt: NOW(),
                },
            });
            await prisma.registeredAgentTool.create({
                data: { tenantId: f.tenantId, agentId: agent.id, toolName: 'propose_controls', grantedByUserId: U_SECOND },
            });
            // Its owner is independent (the only other agent they own is an
            // auditor, which is not audited), so the refusal is the remit's.
            expect(await reason(updateRegisteredAgent(ownerCtx(), agent.id, { isAuditor: true }))).toBe(
                'AUDITOR_REMIT_EXCEEDED',
            );
        });

        it('refuses to run an auditor whose grants exceed its remit: INCONCLUSIVE, no workpaper, no proposal', async () => {
            const g = await seedTenant('remit-run');
            await prisma.registeredAgentTool.create({
                data: { tenantId: g.tenantId, agentId: g.auditorId, toolName: 'propose_risks', grantedByUserId: U_SECOND },
            });
            const r = await run(g, await seedPlan(g, { procedure: 'iam.leaver_timeliness', periodLabel: MONTH, parameters: { leaverWindowHours: 24 } }));
            expect(r.result.runResult).toBe('INCONCLUSIVE');
            expect(r.workpapers).toHaveLength(0);
            expect(r.proposals).toHaveLength(0);
            expect(r.evidence).toContain('AUDITOR_REMIT_EXCEEDED');
            expect(r.lastTested).toBeNull();
        });

        it('refuses to run an auditor a kill switch has stopped', async () => {
            const g = await seedTenant('killed');
            await prisma.agentKillSwitch.create({
                data: { tenantId: g.tenantId, agentId: g.auditorId, engagedByUserId: U_SECOND, reason: 'stopped for the test' },
            });
            const r = await run(g, await seedPlan(g, { procedure: 'iam.leaver_timeliness', periodLabel: MONTH, parameters: { leaverWindowHours: 24 } }));
            expect(r.result.runResult).toBe('INCONCLUSIVE');
            expect(r.workpapers).toHaveLength(0);
            expect(r.evidence).toContain('AUDITOR_KILLED');
        });
    });

    // ─────────────────────────────────────────────────────────────────
    // The second line sets the plan; the parameter is a precondition
    // ─────────────────────────────────────────────────────────────────

    describe('the procedure plan', () => {
        it('is set only by the auditor\'s owner, and a malformed one is refused', async () => {
            const f = await seedTenant('schedule');
            const plan = await prisma.controlTestPlan.create({
                data: { tenantId: f.tenantId, controlId: f.controlId, name: 'p', createdByUserId: U_SECOND },
            });
            const config = { procedure: 'iam.leaver_timeliness', auditorAgentId: f.auditorId, parameters: { leaverWindowHours: 24 } };
            const input = { schedule: '0 3 1 * *', automationType: 'INTEGRATION' as const, automationConfig: config };
            await expect(
                scheduleTestPlan(makeRequestContext('OWNER', { tenantId: f.tenantId, userId: U_OWNER }), plan.id, input),
            ).rejects.toBeInstanceOf(ForbiddenError);
            await expect(
                scheduleTestPlan(makeRequestContext('EDITOR', { tenantId: f.tenantId, userId: U_SECOND }), plan.id, input),
            ).resolves.toBeTruthy();
            await expect(
                scheduleTestPlan(makeRequestContext('EDITOR', { tenantId: f.tenantId, userId: U_SECOND }), plan.id, {
                    ...input,
                    automationConfig: { ...config, procedure: 'agent.stop_control' },
                }),
            ).rejects.toThrow(/PROCEDURE_NOT_IN_LIBRARY_V1/);
        });

        it('is INCONCLUSIVE on PARAMETER_UNSET, with no sample drawn', async () => {
            const f = await seedTenant('param');
            const r = await run(f, await seedPlan(f, { procedure: 'iam.leaver_timeliness', periodLabel: MONTH }));
            expect(r.result.runResult).toBe('INCONCLUSIVE');
            expect(r.workpapers[0]).toMatchObject({ conclusionBasis: 'PARAMETER_UNSET', sampleEpoch: null });
        });
    });
});
