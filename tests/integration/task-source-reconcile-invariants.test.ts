/**
 * Behavioural integration tests for three invariants of task → source
 * reconciliation. Each fails if the behaviour regresses — none of them
 * inspects the shape of the source.
 *
 *  1. REVIEW DATE SURVIVES.  Closing a policy-review reminder task never
 *     nulls `Policy.nextReviewAt`. A policy with a manually-set review
 *     date and NO cadence used to be wiped by the reconciler's private
 *     copy of the cadence rule, dropping it out of
 *     `processOverdueReminders`' `nextReviewAt: { not: null }` predicate
 *     permanently — never flagged for review again, while the task
 *     reported success. The reconciler now calls the same
 *     `applyPolicyReviewed` that `markPolicyReviewed` calls.
 *
 *  2. NO SILENT SKIP.  Every early exit in the reconciler logs, counts,
 *     and lands on the returned `ReconcileOutcome`. Closing a
 *     policy-review task whose policy has been purged must not report
 *     unqualified success.
 *
 *  3. POINTER-DRIVEN DISPATCH.  `Task.source` is NOT the discriminator
 *     for reconcilers keyed on an exclusive back-pointer (the real
 *     vulnerability producer writes `source: 'MANUAL'`), and IS the
 *     disambiguator for reconcilers keyed on a non-exclusive association
 *     (a task merely linked to a policy must not reset its review clock).
 *
 * Hits a real DB (project convention). Setup + assertions use a raw
 * (superuser) client; the mutations under test run through the usecases
 * (RLS-enforced).
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { createTask, setTaskStatus, addTaskLink } from '@/app-layer/usecases/task';
import {
    reconcileTaskSource,
    readReconcileTally,
    resetReconcileTally,
    type ReconcileOutcome,
} from '@/app-layer/usecases/task-source-reconcile';
import { processOverdueReminders } from '@/app-layer/jobs/policyReviewReminder';
import { runInTenantContext } from '@/lib/db-context';
import { logger } from '@/lib/observability/logger';

const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `tsri-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${TAG}`;

let userId: string;
let ctx: ReturnType<typeof makeRequestContext>;

/** Run the reconciler directly on a real tenant transaction so the test
 *  can read the outcome the API callers discard. */
function reconcile(taskId: string, status = 'CLOSED'): Promise<ReconcileOutcome> {
    return runInTenantContext(ctx, (tx) => reconcileTaskSource(tx, ctx, taskId, status));
}

describeFn('task→source reconciliation invariants (integration)', () => {
    beforeAll(async () => {
        await db.tenant.upsert({
            where: { id: TENANT },
            update: {},
            create: { id: TENANT, name: `t ${TENANT}`, slug: TENANT },
        });
        const email = `${TAG}-owner@example.test`;
        const u = await db.user.create({ data: { email, emailHash: hashForLookup(email) } });
        userId = u.id;
        await db.tenantMembership.create({
            data: { tenantId: TENANT, userId, role: Role.OWNER, status: MembershipStatus.ACTIVE },
        });
        ctx = makeRequestContext('OWNER', { tenantId: TENANT, tenantSlug: TENANT, userId });
    });

    afterAll(async () => {
        const tables = [
            'AuditLog', 'AutomationExecution', 'NotificationOutbox', 'Notification',
            'TaskComment', 'TaskWatcher', 'TaskLink',
            'AssetVulnerability', 'Asset',
            'KriReading', 'KeyRiskIndicator', 'RiskAppetiteBreach',
            'Evidence', 'Policy', 'Task', 'Finding', 'Control',
            'TenantMembership',
        ];
        for (const t of tables) {
            await db.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "tenantId" = $1`, TENANT).catch(() => {});
        }
        await db.$executeRawUnsafe(`DELETE FROM "Cve" WHERE "id" LIKE $1`, `CVE-${TAG}%`).catch(() => {});
        await db.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, TENANT).catch(() => {});
        await db.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, userId).catch(() => {});
        await db.$disconnect().catch(() => {});
    });

    beforeEach(() => {
        resetReconcileTally();
        jest.restoreAllMocks();
    });

    // ═══ 1. The review date survives the task close ═══════════════════

    it('preserves a manually-set nextReviewAt when the policy has no cadence, and the policy stays in the reminder sweep', async () => {
        // Overdue, manually dated, NO cadence — the exact row the private
        // copy of the rule used to null out.
        const manualDate = new Date(Date.now() - 3 * 86_400_000);
        const policy = await db.policy.create({
            data: {
                tenantId: TENANT,
                slug: `pol-nocadence-${TAG}`,
                title: 'Manually dated policy',
                reviewFrequencyDays: null,
                nextReviewAt: manualDate,
            },
        });

        const task = await createTask(ctx, {
            title: 'Review policy: Manually dated policy',
            type: 'TASK',
            source: 'POLICY_REVIEW',
        });
        await addTaskLink(ctx, task.id, 'POLICY', policy.id);

        await setTaskStatus(ctx, task.id, 'CLOSED', 'Reviewed');

        const after = await db.policy.findUniqueOrThrow({ where: { id: policy.id } });
        // The review happened…
        expect(after.lastReviewedAt).not.toBeNull();
        // …and the manual date was NOT wiped.
        expect(after.nextReviewAt).not.toBeNull();
        expect(after.nextReviewAt!.getTime()).toBe(manualDate.getTime());

        // The load-bearing consequence: the policy is still visible to the
        // reminder sweep, whose predicate is `nextReviewAt: { not: null }`.
        const swept = await processOverdueReminders(db, { tenantId: TENANT });
        expect(swept.policies.map((p) => p.id)).toContain(policy.id);
    });

    it('rolls nextReviewAt forward by the cadence when the policy has one', async () => {
        const policy = await db.policy.create({
            data: {
                tenantId: TENANT,
                slug: `pol-cadence-${TAG}`,
                title: 'Cadenced policy',
                reviewFrequencyDays: 90,
                nextReviewAt: new Date(Date.now() - 86_400_000),
            },
        });
        const task = await createTask(ctx, {
            title: 'Review policy: Cadenced policy',
            type: 'TASK',
            source: 'POLICY_REVIEW',
        });
        await addTaskLink(ctx, task.id, 'POLICY', policy.id);

        await setTaskStatus(ctx, task.id, 'CLOSED', 'Reviewed');

        const after = await db.policy.findUniqueOrThrow({ where: { id: policy.id } });
        const days = (after.nextReviewAt!.getTime() - Date.now()) / 86_400_000;
        expect(days).toBeGreaterThan(88);
        expect(days).toBeLessThan(91);
    });

    // ═══ 2. No early exit is silent ═══════════════════════════════════

    it('warns, counts and reports when the linked policy has been purged', async () => {
        const policy = await db.policy.create({
            data: { tenantId: TENANT, slug: `pol-purged-${TAG}`, title: 'Doomed policy' },
        });
        const task = await createTask(ctx, {
            title: 'Review policy: Doomed policy',
            type: 'TASK',
            source: 'POLICY_REVIEW',
        });
        await addTaskLink(ctx, task.id, 'POLICY', policy.id);
        // The policy goes away; the TaskLink row survives (entityId is a
        // plain string, not an FK).
        await db.policy.delete({ where: { id: policy.id } });

        const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
        const outcome = await reconcile(task.id);

        expect(outcome.applied).not.toContain('policy_review');
        expect(outcome.skipped).toContainEqual({
            reconciler: 'policy_review',
            reason: 'policy_missing',
            severity: 'MISSING_TARGET',
        });
        expect(readReconcileTally()['skip:policy_review:policy_missing']).toBe(1);

        const warned = warn.mock.calls.filter(
            ([, fields]) => (fields as Record<string, unknown> | undefined)?.reason === 'policy_missing',
        );
        expect(warned).toHaveLength(1);
        // The warn identifies the task and the reconciler.
        expect(warned[0][1]).toMatchObject({ taskId: task.id, reconciler: 'policy_review' });
    });

    it('reports a not-applicable back-pointer probe at debug, never as unqualified success', async () => {
        const task = await createTask(ctx, { title: 'Ordinary task', type: 'TASK', source: 'MANUAL' });

        const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
        const debug = jest.spyOn(logger, 'debug').mockImplementation(() => {});
        const outcome = await reconcile(task.id);

        // Nothing was reconciled, and every probe left a trace.
        expect(outcome.applied).toEqual([]);
        expect(outcome.skipped.map((s) => s.reason).sort()).toEqual([
            'appetite_breach_pointer_absent',
            'kri_reading_pointer_absent',
            'vulnerability_pointer_absent',
        ]);
        expect(outcome.skipped.every((s) => s.severity === 'NOT_APPLICABLE')).toBe(true);
        expect(readReconcileTally()['skip:vulnerability:vulnerability_pointer_absent']).toBe(1);

        // Routine probes must not drown the real MISSING_TARGET warnings.
        expect(debug).toHaveBeenCalledTimes(3);
        expect(warn).not.toHaveBeenCalled();
    });

    it('reports the non-terminal-status exit instead of returning blind', async () => {
        const task = await createTask(ctx, { title: 'Still open', type: 'TASK', source: 'MANUAL' });

        const outcome = await reconcile(task.id, 'IN_PROGRESS');

        expect(outcome.applied).toEqual([]);
        expect(outcome.skipped).toEqual([
            { reconciler: 'dispatch', reason: 'status_not_terminal', severity: 'NOT_APPLICABLE' },
        ]);
    });

    it('warns when the task itself is gone or foreign', async () => {
        const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
        const outcome = await reconcile('task-that-does-not-exist');

        expect(outcome.skipped).toEqual([
            { reconciler: 'dispatch', reason: 'task_not_found', severity: 'MISSING_TARGET' },
        ]);
        expect(readReconcileTally()['skip:dispatch:task_not_found']).toBe(1);
        expect(warn).toHaveBeenCalledTimes(1);
    });

    // ═══ 3. Dispatch is pointer-driven ════════════════════════════════

    it("reconciles a vulnerability whose task declares source 'MANUAL' (the real producer's value)", async () => {
        const asset = await db.asset.create({
            data: { tenantId: TENANT, name: 'Server X', type: 'SYSTEM' },
        });
        const cve = await db.cve.create({
            data: {
                id: `CVE-${TAG}-0001`,
                publishedAt: new Date(),
                lastModifiedAt: new Date(),
                summary: 'Test CVE',
            },
        });
        const vuln = await db.assetVulnerability.create({
            data: {
                tenantId: TENANT,
                assetId: asset.id,
                cveId: cve.id,
                status: 'OPEN',
                matchedVia: 'MANUAL',
            },
        });
        // `openVulnerabilityRemediationTask` writes source 'MANUAL'. If
        // dispatch keyed on `source`, this reconciliation would vanish.
        const task = await createTask(ctx, {
            title: `Remediate ${cve.id}`,
            type: 'TASK',
            source: 'MANUAL',
        });
        await db.assetVulnerability.update({
            where: { id: vuln.id },
            data: { remediationTaskId: task.id },
        });

        await setTaskStatus(ctx, task.id, 'CLOSED', 'Patched');

        const after = await db.assetVulnerability.findUniqueOrThrow({ where: { id: vuln.id } });
        expect(after.status).toBe('MITIGATED');
    });

    it('does NOT advance a policy review from a task that is merely linked to the policy', async () => {
        const policy = await db.policy.create({
            data: {
                tenantId: TENANT,
                slug: `pol-reword-${TAG}`,
                title: 'Reworded policy',
                reviewFrequencyDays: 90,
                nextReviewAt: new Date(Date.now() - 86_400_000),
            },
        });
        // A POLICY TaskLink is not exclusive — this task is about wording,
        // not the periodic review. Only `source: 'POLICY_REVIEW'` says
        // "this task IS the review".
        const task = await createTask(ctx, {
            title: 'Reword section 3',
            type: 'TASK',
            source: 'MANUAL',
        });
        await addTaskLink(ctx, task.id, 'POLICY', policy.id);

        const outcome = await reconcile(task.id);

        expect(outcome.applied).not.toContain('policy_review');
        const after = await db.policy.findUniqueOrThrow({ where: { id: policy.id } });
        expect(after.lastReviewedAt).toBeNull();
        expect(after.nextReviewAt!.getTime()).toBe(policy.nextReviewAt!.getTime());
    });

    it("treats RISK_MONITOR as non-discriminating: both breach probes run and both report", async () => {
        // One `source` value serves two reconcilers, so it cannot select
        // between them — the back-pointers do.
        const task = await createTask(ctx, {
            title: 'Risk monitor nudge',
            type: 'TASK',
            source: 'RISK_MONITOR',
        });
        const kri = await db.keyRiskIndicator.create({
            data: { tenantId: TENANT, name: `KRI ${TAG}` },
        });
        const reading = await db.kriReading.create({
            data: {
                tenantId: TENANT,
                kriId: kri.id,
                value: 99,
                ragStatus: 'RED',
                remediationTaskId: task.id,
            },
        });

        const outcome = await reconcile(task.id);

        // The KRI reconciler fired off its back-pointer…
        expect(outcome.applied).toContain('kri_breach');
        expect(
            (await db.kriReading.findUniqueOrThrow({ where: { id: reading.id } })).addressedAt,
        ).not.toBeNull();
        // …while the appetite reconciler, sharing the same `source`, is
        // correctly skipped on the absence of ITS pointer.
        expect(outcome.skipped).toContainEqual({
            reconciler: 'risk_appetite_breach',
            reason: 'appetite_breach_pointer_absent',
            severity: 'NOT_APPLICABLE',
        });
    });
});
