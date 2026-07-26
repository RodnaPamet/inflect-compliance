/**
 * Branch-coverage integration test for the control-test usecases —
 * exercises the error paths and conditional branches the happy-path
 * suites skip: not-found throws, READER/permission denials, badRequest
 * validation (paused plan, already-completed run, retest-from-incomplete),
 * status-change vs metadata-update event branches, frequency recompute,
 * the FAIL → CONTROL_GAP task branch, the automated-run bridge (PASS /
 * FAIL / with evidence links), control-effectiveness rollup, and the
 * bulk-action empty / non-empty branches.
 *
 * Hits a real DB (project convention).
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    listControlTestPlans,
    getTestPlan,
    getTestRun,
    listRunEvidence,
    computeControlEffectivenessMap,
    createTestPlan,
    updateTestPlan,
    createTestRun,
    completeTestRun,
    retestFromRun,
    linkEvidenceToRun,
    unlinkEvidenceFromRun,
    createAutomatedTestRun,
    bulkSetTestPlanStatus,
    bulkDeleteTestPlan,
    bulkAssignTestPlan,
} from '@/app-layer/usecases/control-test';
import { setTaskStatus } from '@/app-layer/usecases/task';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE_TAG = `ct-br-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE_TAG}`;

let ownerUserId: string;
let readerUserId: string;
let controlId: string;
let effControlId: string;
let ctx: ReturnType<typeof makeRequestContext>;
let reader: ReturnType<typeof makeRequestContext>;

async function makeUser(label: string, role: Role): Promise<string> {
    const email = `${SUITE_TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await globalPrisma.tenantMembership.create({
        data: { tenantId: TENANT_ID, userId: u.id, role, status: MembershipStatus.ACTIVE },
    });
    return u.id;
}

describeFn('control-test usecase — branch coverage (integration)', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({
            where: { id: TENANT_ID },
            update: {},
            create: { id: TENANT_ID, name: `t ${SUITE_TAG}`, slug: SUITE_TAG },
        });
        ownerUserId = await makeUser('owner', Role.OWNER);
        readerUserId = await makeUser('reader', Role.READER);
        const control = await globalPrisma.control.create({
            data: { tenantId: TENANT_ID, code: 'CT-1', name: 'Test control' },
        });
        controlId = control.id;
        const effControl = await globalPrisma.control.create({
            data: { tenantId: TENANT_ID, code: 'CT-2', name: 'Effectiveness control' },
        });
        effControlId = effControl.id;
        ctx = makeRequestContext('OWNER', { tenantId: TENANT_ID, tenantSlug: SUITE_TAG, userId: ownerUserId });
        reader = makeRequestContext('READER', { tenantId: TENANT_ID, tenantSlug: SUITE_TAG, userId: readerUserId });
    });

    afterAll(async () => {
        await globalPrisma.controlTestEvidenceLink.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.controlTestStep.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.controlTestRun.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.controlTestPlan.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.notification.deleteMany({ where: { tenantId: TENANT_ID } }).catch(() => {});
        await globalPrisma.notificationOutbox.deleteMany({ where: { tenantId: TENANT_ID } }).catch(() => {});
        await globalPrisma.task.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.evidence.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.control.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT_ID);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT_ID);
        });
        await globalPrisma.user.deleteMany({ where: { id: { in: [ownerUserId, readerUserId] } } });
        await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
        await globalPrisma.$disconnect();
    });

    it('not-found paths throw across read + mutation usecases', async () => {
        await expect(getTestPlan(ctx, 'nope')).rejects.toThrow(/not found/i);
        await expect(getTestRun(ctx, 'nope')).rejects.toThrow(/not found/i);
        await expect(createTestRun(ctx, 'nope')).rejects.toThrow(/not found/i);
        await expect(updateTestPlan(ctx, 'nope', { name: 'x' })).rejects.toThrow(/not found/i);
        await expect(completeTestRun(ctx, 'nope', { result: 'PASS' })).rejects.toThrow(/not found/i);
        await expect(retestFromRun(ctx, 'nope')).rejects.toThrow(/not found/i);
        await expect(linkEvidenceToRun(ctx, 'nope', { kind: 'LINK', url: 'https://x.test' })).rejects.toThrow(/not found/i);
        await expect(unlinkEvidenceFromRun(ctx, 'run-nope', 'nope')).rejects.toThrow(/not found/i);
        await expect(createAutomatedTestRun(ctx, 'nope', { result: 'PASS' })).rejects.toThrow(/not found/i);
        expect(Array.isArray(await listControlTestPlans(ctx, controlId))).toBe(true);
    });

    it('READER is denied manage/execute/link actions', async () => {
        await expect(createTestPlan(reader, controlId, { name: 'x' })).rejects.toThrow(/permission/i);
        await expect(updateTestPlan(reader, 'x', { name: 'x' })).rejects.toThrow(/permission/i);
        await expect(createTestRun(reader, 'x')).rejects.toThrow(/permission/i);
        await expect(completeTestRun(reader, 'x', { result: 'PASS' })).rejects.toThrow(/permission/i);
        await expect(retestFromRun(reader, 'x')).rejects.toThrow(/permission/i);
        await expect(linkEvidenceToRun(reader, 'x', { kind: 'LINK' })).rejects.toThrow(/permission/i);
        await expect(unlinkEvidenceFromRun(reader, 'x', 'x')).rejects.toThrow(/permission/i);
        await expect(bulkSetTestPlanStatus(reader, ['x'], 'PAUSED')).rejects.toThrow(/permission/i);
        await expect(bulkDeleteTestPlan(reader, ['x'])).rejects.toThrow(/permission/i);
        await expect(bulkAssignTestPlan(reader, ['x'], null)).rejects.toThrow(/permission/i);
        // reads allowed
        await expect(listControlTestPlans(reader, controlId)).resolves.toBeDefined();
    });

    it('createTestPlan covers steps + frequency + description sanitise branches', async () => {
        // AD_HOC (default) → computeNextDueAt returns null, no updateNextDueAt call.
        const adhoc = await createTestPlan(ctx, controlId, { name: 'Ad hoc plan' });
        expect(adhoc.id).toBeTruthy();
        expect(adhoc.nextDueAt).toBeNull();

        // With description + steps (expectedOutput null AND string) + MONTHLY frequency.
        const full = await createTestPlan(ctx, controlId, {
            name: 'Full plan',
            description: 'verify monthly',
            frequency: 'MONTHLY',
            ownerUserId,
            steps: [
                { instruction: 'do thing', expectedOutput: 'ok' },
                { instruction: 'do other', expectedOutput: null },
            ],
        });
        expect(full.nextDueAt).toBeTruthy();
        const fetched = await getTestPlan(ctx, full.id);
        expect(fetched.steps).toHaveLength(2);
    });

    it('updateTestPlan covers status-change, frequency recompute, and plain-update branches', async () => {
        const plan = await createTestPlan(ctx, controlId, { name: 'Update target', frequency: 'WEEKLY' });

        // Plain metadata update (no status change) → emitTestPlanUpdated branch.
        const u1 = await updateTestPlan(ctx, plan.id, { name: 'Renamed', description: 'new desc' });
        expect(u1.name).toBe('Renamed');

        // description null three-state branch.
        await updateTestPlan(ctx, plan.id, { description: null });

        // frequency change → recompute nextDueAt branch.
        await updateTestPlan(ctx, plan.id, { frequency: 'QUARTERLY' });

        // status change → emitTestPlanStatusChanged branch.
        const u2 = await updateTestPlan(ctx, plan.id, { status: 'PAUSED' });
        expect(u2.status).toBe('PAUSED');

        // createTestRun on a PAUSED plan → badRequest.
        await expect(createTestRun(ctx, plan.id)).rejects.toThrow(/paused/i);
    });

    it('method is DERIVED from automationType and can never drift', async () => {
        const plan = await createTestPlan(ctx, controlId, { name: 'Derivation' });
        // A fresh plan is MANUAL/MANUAL.
        expect(plan.method).toBe('MANUAL');

        // Acquiring an automationType flips method with it…
        const automated = await updateTestPlan(ctx, plan.id, { automationType: 'SCRIPT' });
        expect(automated.automationType).toBe('SCRIPT');
        expect(automated.method).toBe('AUTOMATED');

        // …and reverting to MANUAL strips the automation AND the schedule, so
        // the scheduler can't keep firing a plan the operator thinks is manual.
        const back = await updateTestPlan(ctx, plan.id, { automationType: 'MANUAL' });
        expect(back.automationType).toBe('MANUAL');
        expect(back.method).toBe('MANUAL');
        expect(back.schedule ?? null).toBeNull();
        expect(back.nextRunAt ?? null).toBeNull();
    });

    it('single-plan ARCHIVE works and matches the bulk-archive end state', async () => {
        const viaSingle = await createTestPlan(ctx, controlId, { name: 'Archive single' });
        const viaBulk = await createTestPlan(ctx, controlId, { name: 'Archive bulk' });

        // The detail form's ARCHIVED option used to 400 at the schema.
        const archived = await updateTestPlan(ctx, viaSingle.id, { status: 'ARCHIVED' });
        expect(archived.status).toBe('ARCHIVED');

        await bulkSetTestPlanStatus(ctx, [viaBulk.id], 'ARCHIVED');
        const bulkRow = await getTestPlan(ctx, viaBulk.id);

        // Same end state on both paths — archive is archive however you got there.
        expect(archived.status).toBe(bulkRow.status);
        expect(archived.schedule ?? null).toBe(bulkRow.schedule ?? null);
        expect(archived.nextRunAt ?? null).toEqual(bulkRow.nextRunAt ?? null);
    });

    it('an INCONCLUSIVE run does NOT attest the control or roll the cadence', async () => {
        // The bug: attestControlTested + the plan-cadence roll ran BEFORE the
        // result branch, so a control whose only runs were INCONCLUSIVE read
        // "tested & on-schedule" while its effectiveness stayed null.
        const plan = await createTestPlan(ctx, controlId, { name: 'Inconclusive plan', frequency: 'MONTHLY' });
        const before = await globalPrisma.control.findUnique({
            where: { id: controlId }, select: { lastTested: true, nextDueAt: true },
        });
        const planBefore = await getTestPlan(ctx, plan.id);

        const run = await createTestRun(ctx, plan.id);
        const done = await completeTestRun(ctx, run.id, { result: 'INCONCLUSIVE', notes: 'could not determine' });
        expect(done.result).toBe('INCONCLUSIVE');

        const after = await globalPrisma.control.findUnique({
            where: { id: controlId }, select: { lastTested: true, nextDueAt: true },
        });
        // Control tested-state untouched — nothing was established.
        expect(after?.lastTested ?? null).toEqual(before?.lastTested ?? null);
        expect(after?.nextDueAt ?? null).toEqual(before?.nextDueAt ?? null);
        // …and the plan's due date did not roll forward either.
        const planAfter = await getTestPlan(ctx, plan.id);
        expect(planAfter.nextDueAt ?? null).toEqual(planBefore.nextDueAt ?? null);
    });

    it('a PASS run DOES attest the control (the gate only blocks non-verdicts)', async () => {
        const plan = await createTestPlan(ctx, controlId, { name: 'Verdict plan', frequency: 'MONTHLY' });
        const run = await createTestRun(ctx, plan.id);
        await completeTestRun(ctx, run.id, { result: 'PASS', notes: 'ok' });

        const after = await globalPrisma.control.findUnique({
            where: { id: controlId }, select: { lastTested: true },
        });
        expect(after?.lastTested).not.toBeNull();
    });

    it('manually completing a SCHEDULED plan rolls nextRunAt so it is not perpetually overdue', async () => {
        // effectiveDueAt = min(nextDueAt, nextRunAt). Advancing only nextDueAt
        // left the stale PAST nextRunAt pinning the plan as overdue forever.
        const plan = await createTestPlan(ctx, controlId, { name: 'Scheduled plan', frequency: 'MONTHLY' });
        const past = new Date(Date.now() - 60 * 60 * 1000);
        await globalPrisma.controlTestPlan.update({
            where: { id: plan.id },
            data: { schedule: '0 3 * * *', scheduleTimezone: 'UTC', nextRunAt: past },
        });

        const run = await createTestRun(ctx, plan.id);
        await completeTestRun(ctx, run.id, { result: 'PASS', notes: 'done by hand' });

        const after = await getTestPlan(ctx, plan.id);
        // nextRunAt moved into the future → min(nextDueAt, nextRunAt) is no
        // longer in the past, so the plan leaves the overdue surfaces.
        expect(after.nextRunAt).not.toBeNull();
        expect(new Date(after.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    });

    it('test-run lifecycle: create → complete PASS, double-complete, retest guard', async () => {
        const plan = await createTestPlan(ctx, controlId, { name: 'Run plan', frequency: 'MONTHLY' });
        const run = await createTestRun(ctx, plan.id);
        expect(run.status).toBe('PLANNED');

        // retest from a non-completed run → badRequest.
        await expect(retestFromRun(ctx, run.id)).rejects.toThrow(/completed run/i);

        const completed = await completeTestRun(ctx, run.id, { result: 'PASS', notes: 'all good' });
        expect(completed.status).toBe('COMPLETED');
        expect(completed.result).toBe('PASS');

        // already completed → badRequest.
        await expect(completeTestRun(ctx, run.id, { result: 'PASS' })).rejects.toThrow(/already completed/i);

        // retest from the completed run → new PLANNED run.
        const retest = await retestFromRun(ctx, run.id);
        expect(retest.status).toBe('PLANNED');

        // evidence link + list + unlink.
        const link = await linkEvidenceToRun(ctx, retest.id, { kind: 'LINK', url: 'https://e.test', note: 'shot' });
        expect(link.id).toBeTruthy();
        const evList = await listRunEvidence(ctx, retest.id);
        expect(evList).toHaveLength(1);
        await unlinkEvidenceFromRun(ctx, retest.id, link.id);
        expect(await listRunEvidence(ctx, retest.id)).toHaveLength(0);
    });

    it('completeTestRun FAIL creates a CONTROL_GAP task', async () => {
        const plan = await createTestPlan(ctx, controlId, { name: 'Fail plan', frequency: 'AD_HOC', ownerUserId });
        const run = await createTestRun(ctx, plan.id);
        const completed = await completeTestRun(ctx, run.id, {
            result: 'FAIL',
            findingSummary: 'control failed',
            notes: 'details',
        });
        expect(completed.result).toBe('FAIL');
        const tasks = await globalPrisma.task.findMany({ where: { tenantId: TENANT_ID, type: 'CONTROL_GAP' } });
        expect(tasks.length).toBeGreaterThanOrEqual(1);

        // FAIL with null findingSummary + null notes → sanitizeOptional null
        // branch + the description fallback string branch.
        const run2 = await createTestRun(ctx, plan.id);
        const c2 = await completeTestRun(ctx, run2.id, { result: 'FAIL', findingSummary: null, notes: null });
        expect(c2.result).toBe('FAIL');
    });

    it('a re-run of a failing test reuses the open gap task (idempotent, no duplicate)', async () => {
        // Dedicated control so the count is isolated from other tests.
        const idemControl = await globalPrisma.control.create({
            data: { tenantId: TENANT_ID, code: `CT-IDEM-${randomUUID().slice(0, 6)}`, name: 'Idempotency control' },
        });
        const plan = await createTestPlan(ctx, idemControl.id, { name: 'Flaky plan', frequency: 'AD_HOC', ownerUserId });

        // First failing run → one CONTROL_GAP task.
        const run1 = await createTestRun(ctx, plan.id);
        await completeTestRun(ctx, run1.id, { result: 'FAIL', findingSummary: 'first fail' });

        // Second failing run on the SAME control+plan → must NOT duplicate.
        const run2 = await createTestRun(ctx, plan.id);
        await completeTestRun(ctx, run2.id, { result: 'FAIL', findingSummary: 'second fail' });

        const openGaps = await globalPrisma.task.findMany({
            where: {
                tenantId: TENANT_ID,
                type: 'CONTROL_GAP',
                controlId: idemControl.id,
                status: { notIn: ['RESOLVED', 'CLOSED', 'CANCELED'] },
            },
        });
        expect(openGaps.length).toBe(1);

        // Close the gap, then fail again → a fresh task may now be raised.
        await setTaskStatus(ctx, openGaps[0].id, 'CLOSED', 'remediated');
        const run3 = await createTestRun(ctx, plan.id);
        await completeTestRun(ctx, run3.id, { result: 'FAIL', findingSummary: 'third fail' });
        const openAfter = await globalPrisma.task.findMany({
            where: {
                tenantId: TENANT_ID,
                type: 'CONTROL_GAP',
                controlId: idemControl.id,
                status: { notIn: ['RESOLVED', 'CLOSED', 'CANCELED'] },
            },
        });
        expect(openAfter.length).toBe(1);
    });

    it('createAutomatedTestRun covers PASS, FAIL+task, and evidence-link branches', async () => {
        const plan = await createTestPlan(ctx, effControlId, { name: 'Auto plan', frequency: 'MONTHLY', ownerUserId });

        // PASS, no evidence.
        const pass = await createAutomatedTestRun(ctx, plan.id, { result: 'PASS' });
        expect(pass.result).toBe('PASS');

        // FAIL with evidence links → task + links.
        const fail = await createAutomatedTestRun(ctx, plan.id, {
            result: 'FAIL',
            notes: 'auto failed',
            integrationResultId: 'ir-1',
            evidenceLinks: [
                { kind: 'LINK', url: 'https://auto.test' },
                { kind: 'INTEGRATION_RESULT' },
            ],
        });
        expect(fail.result).toBe('FAIL');

        // FAIL with no notes → the 'Automated check failed' fallback branch.
        const failNoNotes = await createAutomatedTestRun(ctx, plan.id, { result: 'FAIL' });
        expect(failNoNotes.result).toBe('FAIL');

        // INCONCLUSIVE — third result arm.
        const inc = await createAutomatedTestRun(ctx, plan.id, { result: 'INCONCLUSIVE' });
        expect(inc.result).toBe('INCONCLUSIVE');
    });

    it('computeControlEffectivenessMap rolls up pass rate and returns null on empty', async () => {
        // PR-R — the gated getControlEffectiveness wrapper was removed; call the
        // live batched map function directly (gating happens at the real call
        // sites). globalPrisma is a valid PrismaTx for the groupBy read.
        const eff = (await computeControlEffectivenessMap(globalPrisma as never, TENANT_ID, [effControlId])).get(effControlId)!;
        expect(eff.total).toBeGreaterThanOrEqual(2);
        expect(eff.passRate).not.toBeNull();
        expect(eff.windowDays).toBe(90);

        // custom window + a control with no completed runs → null passRate.
        const empty = (await computeControlEffectivenessMap(globalPrisma as never, TENANT_ID, [controlId], 7)).get(controlId)!;
        // controlId may have completed runs from earlier tests; assert shape only.
        expect(empty).toHaveProperty('passRate');
        const fresh = await globalPrisma.control.create({
            data: { tenantId: TENANT_ID, code: 'CT-3', name: 'Fresh' },
        });
        const none = (await computeControlEffectivenessMap(globalPrisma as never, TENANT_ID, [fresh.id])).get(fresh.id)!;
        expect(none.passRate).toBeNull();
        expect(none.total).toBe(0);
    });

    it('bulk actions cover empty + non-empty branches', async () => {
        // empty id sets → zero, no rows.
        expect(await bulkSetTestPlanStatus(ctx, [], 'ARCHIVED')).toEqual({ updated: 0 });
        expect(await bulkDeleteTestPlan(ctx, [])).toEqual({ deleted: 0 });
        expect(await bulkAssignTestPlan(ctx, [], null)).toEqual({ updated: 0 });

        const p1 = await createTestPlan(ctx, controlId, { name: 'Bulk 1' });
        const p2 = await createTestPlan(ctx, controlId, { name: 'Bulk 2' });

        const set = await bulkSetTestPlanStatus(ctx, [p1.id, p2.id], 'PAUSED');
        expect(set.updated).toBe(2);

        const assigned = await bulkAssignTestPlan(ctx, [p1.id], ownerUserId);
        expect(assigned.updated).toBe(1);
        const cleared = await bulkAssignTestPlan(ctx, [p1.id], null);
        expect(cleared.updated).toBe(1);

        const del = await bulkDeleteTestPlan(ctx, [p1.id, p2.id]);
        expect(del.deleted).toBe(2);
    });
});
