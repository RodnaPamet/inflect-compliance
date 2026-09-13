/**
 * TP-3 (Tasks roadmap) — behavioural integration test for task → source
 * reconciliation. Completing an auto-created remediation task must write
 * back to the SOURCE that raised it, not dead-end on the task's own row.
 *
 * Covered:
 *   • CONTROL_GAP task close → the control is observably re-checked
 *     (Control.lastTested advances). Automated plan → a fresh PLANNED
 *     ControlTestRun is queued too.
 *   • vulnerability remediation task close → AssetVulnerability
 *     OPEN/MITIGATING → MITIGATED.
 *   • AUDIT_FINDING task (findingId FK) close → Finding → CLOSED.
 *   • Two-tenant: a tenant-B setTaskStatus on a tenant-A task id fails
 *     and touches nothing in tenant A.
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
// Direct import satisfies the usecase-test-coverage guardrail for the
// new task-source-reconcile.ts module (exercised via setTaskStatus).
import { reconcileTaskSource } from '@/app-layer/usecases/task-source-reconcile';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `tsr-${randomUUID().slice(0, 8)}`;
const TENANT_A = `t-a-${TAG}`;
const TENANT_B = `t-b-${TAG}`;

let userAId: string;
let userBId: string;
let ctxA: ReturnType<typeof makeRequestContext>;
let ctxB: ReturnType<typeof makeRequestContext>;

async function makeUser(tenantId: string, label: string): Promise<string> {
    const email = `${TAG}-${label}@example.test`;
    const u = await db.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await db.tenantMembership.create({
        data: { tenantId, userId: u.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
    return u.id;
}

describeFn('task-source reconciliation (integration)', () => {
    beforeAll(async () => {
        for (const [id, slug] of [[TENANT_A, TENANT_A], [TENANT_B, TENANT_B]] as const) {
            await db.tenant.upsert({
                where: { id },
                update: {},
                create: { id, name: `t ${slug}`, slug },
            });
        }
        userAId = await makeUser(TENANT_A, 'owner-a');
        userBId = await makeUser(TENANT_B, 'owner-b');
        ctxA = makeRequestContext('OWNER', { tenantId: TENANT_A, tenantSlug: TENANT_A, userId: userAId });
        ctxB = makeRequestContext('OWNER', { tenantId: TENANT_B, tenantSlug: TENANT_B, userId: userBId });
    });

    afterAll(async () => {
        const ids = [TENANT_A, TENANT_B];
        try {
            await deleteAuditRowsForTenants(db, ids);
            await db.$executeRawUnsafe(`DELETE FROM "ControlTestRun" WHERE "tenantId" = ANY($1)`, ids);
            await db.$executeRawUnsafe(`DELETE FROM "ControlTestPlan" WHERE "tenantId" = ANY($1)`, ids);
            await db.$executeRawUnsafe(`DELETE FROM "AssetVulnerability" WHERE "tenantId" = ANY($1)`, ids);
            await db.$executeRawUnsafe(`DELETE FROM "Cve" WHERE "id" LIKE $1`, `CVE-${TAG}%`);
            await db.$executeRawUnsafe(`DELETE FROM "Asset" WHERE "tenantId" = ANY($1)`, ids);
            await db.$executeRawUnsafe(`DELETE FROM "TaskLink" WHERE "tenantId" = ANY($1)`, ids);
            await db.$executeRawUnsafe(`DELETE FROM "RiskAppetiteBreach" WHERE "tenantId" = ANY($1)`, ids);
            await db.$executeRawUnsafe(`DELETE FROM "KriReading" WHERE "tenantId" = ANY($1)`, ids);
            await db.$executeRawUnsafe(`DELETE FROM "KeyRiskIndicator" WHERE "tenantId" = ANY($1)`, ids);
            await db.$executeRawUnsafe(`DELETE FROM "Evidence" WHERE "tenantId" = ANY($1)`, ids);
            await db.$executeRawUnsafe(`DELETE FROM "Policy" WHERE "tenantId" = ANY($1)`, ids);
            await db.$executeRawUnsafe(`DELETE FROM "Task" WHERE "tenantId" = ANY($1)`, ids);
            await db.$executeRawUnsafe(`DELETE FROM "Finding" WHERE "tenantId" = ANY($1)`, ids);
            await db.$executeRawUnsafe(`DELETE FROM "Control" WHERE "tenantId" = ANY($1)`, ids);
            await db.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1)`, ids);
            await db.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = ANY($1)`, ids);
            await db.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = ANY($1)`, [userAId, userBId]);
        } catch (e) {
            // best-effort cleanup
            void e;
        }
        await db.$disconnect().catch(() => {});
    });

    it('exports the reconciler entrypoint', () => {
        expect(typeof reconcileTaskSource).toBe('function');
    });

    // ─── Reconciler 1 — CONTROL_GAP → control re-check ───────────────

    it('closing a CONTROL_GAP task advances the control (manual attestation)', async () => {
        const control = await db.control.create({
            data: { tenantId: TENANT_A, code: `C-${TAG}-1`, name: 'Gap control', frequency: 'MONTHLY' },
        });
        expect(control.lastTested).toBeNull();

        const task = await createTask(ctxA, {
            title: 'Test failed: remediate',
            type: 'CONTROL_GAP',
            controlId: control.id,
            source: 'INTEGRATION',
        });

        await setTaskStatus(ctxA, task.id, 'CLOSED', 'Gap remediated — control re-checked');

        const after = await db.control.findUniqueOrThrow({ where: { id: control.id } });
        // The gap is NOT silently open — the control's tested-state moved.
        expect(after.lastTested).not.toBeNull();
    });

    it('closing an automated CONTROL_GAP task queues a fresh PLANNED test run', async () => {
        const control = await db.control.create({
            data: { tenantId: TENANT_A, code: `C-${TAG}-2`, name: 'Auto control', frequency: 'DAILY' },
        });
        const plan = await db.controlTestPlan.create({
            data: {
                tenantId: TENANT_A,
                controlId: control.id,
                name: 'Automated check',
                method: 'AUTOMATED',
                automationType: 'INTEGRATION',
                createdByUserId: userAId,
            },
        });

        const task = await createTask(ctxA, {
            title: 'Automated test failed',
            type: 'CONTROL_GAP',
            controlId: control.id,
            source: 'INTEGRATION',
            metadataJson: { testPlanId: plan.id },
        });

        await setTaskStatus(ctxA, task.id, 'CLOSED', 'Remediated — re-run queued');

        const runs = await db.controlTestRun.findMany({
            where: { tenantId: TENANT_A, testPlanId: plan.id, status: 'PLANNED' },
        });
        expect(runs.length).toBe(1);
    });

    // ─── Reconciler 2 — vulnerability → MITIGATED ────────────────────

    it('closing a vulnerability remediation task sets the vuln MITIGATED', async () => {
        const asset = await db.asset.create({
            data: { tenantId: TENANT_A, name: 'Server 1', type: 'SYSTEM' },
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
                tenantId: TENANT_A,
                assetId: asset.id,
                cveId: cve.id,
                status: 'OPEN',
                matchedVia: 'MANUAL',
            },
        });

        const task = await createTask(ctxA, {
            title: `Remediate ${cve.id}`,
            type: 'TASK',
            source: 'MANUAL',
        });
        await db.assetVulnerability.update({
            where: { id: vuln.id },
            data: { remediationTaskId: task.id },
        });

        await setTaskStatus(ctxA, task.id, 'CLOSED', 'Patched');

        const after = await db.assetVulnerability.findUniqueOrThrow({ where: { id: vuln.id } });
        expect(after.status).toBe('MITIGATED');
    });

    // ─── Reconciler 3 — AUDIT_FINDING → Finding CLOSED ───────────────

    it('closing an AUDIT_FINDING task (findingId FK) closes the Finding', async () => {
        const control = await db.control.create({
            data: { tenantId: TENANT_A, code: `C-${TAG}-3`, name: 'Finding control' },
        });
        const finding = await db.finding.create({
            data: {
                tenantId: TENANT_A,
                severity: 'MEDIUM',
                type: 'NONCONFORMITY',
                title: 'Nonconformity X',
                description: 'A finding to remediate',
                status: 'OPEN',
            },
        });

        const task = await createTask(ctxA, {
            title: 'Remediate finding',
            type: 'AUDIT_FINDING',
            // controlId satisfies validateTypeRelevance on the terminal move.
            controlId: control.id,
            findingId: finding.id,
            source: 'AUDIT',
        });
        // The FK is persisted on the task row.
        const taskRow = await db.task.findUniqueOrThrow({ where: { id: task.id } });
        expect(taskRow.findingId).toBe(finding.id);

        await setTaskStatus(ctxA, task.id, 'CLOSED', 'Finding remediated');

        const after = await db.finding.findUniqueOrThrow({ where: { id: finding.id } });
        expect(after.status).toBe('CLOSED');
        expect(after.verifiedBy).toBe(userAId);
    });

    // ─── Reconciler 4 — risk-appetite breach → resolved ─────────────

    it('closing a risk-appetite remediation task resolves the breach', async () => {
        const breach = await db.riskAppetiteBreach.create({
            data: {
                tenantId: TENANT_A,
                breachType: 'PORTFOLIO_ALE',
                thresholdValue: 100,
                actualValue: 250,
            },
        });
        expect(breach.resolvedAt).toBeNull();

        const task = await createTask(ctxA, {
            title: 'Remediate appetite breach',
            type: 'TASK',
            source: 'RISK_MONITOR',
        });
        await db.riskAppetiteBreach.update({
            where: { id: breach.id },
            data: { remediationTaskId: task.id },
        });

        await setTaskStatus(ctxA, task.id, 'CLOSED', 'Brought back within appetite');

        const after = await db.riskAppetiteBreach.findUniqueOrThrow({ where: { id: breach.id } });
        expect(after.resolvedAt).not.toBeNull();
    });

    // ─── Reconciler 5 — KRI breach → addressed ──────────────────────

    it('closing a KRI remediation task marks the breaching reading addressed', async () => {
        const kri = await db.keyRiskIndicator.create({
            data: { tenantId: TENANT_A, name: `KRI ${TAG}` },
        });
        const reading = await db.kriReading.create({
            data: { tenantId: TENANT_A, kriId: kri.id, value: 99, ragStatus: 'RED' },
        });
        expect(reading.addressedAt).toBeNull();

        const task = await createTask(ctxA, {
            title: 'Remediate breached KRI',
            type: 'TASK',
            source: 'RISK_MONITOR',
        });
        await db.kriReading.update({
            where: { id: reading.id },
            data: { remediationTaskId: task.id },
        });

        await setTaskStatus(ctxA, task.id, 'CLOSED', 'KRI back within appetite');

        const after = await db.kriReading.findUniqueOrThrow({ where: { id: reading.id } });
        expect(after.addressedAt).not.toBeNull();
    });

    // ─── Reconciler 6 — policy-review reminder → review advanced ────

    it('closing a POLICY_REVIEW reminder task advances the policy review cycle', async () => {
        const policy = await db.policy.create({
            data: {
                tenantId: TENANT_A,
                slug: `pol-${TAG}`,
                title: 'Acceptable Use',
                reviewFrequencyDays: 90,
                nextReviewAt: new Date(Date.now() - 86_400_000), // overdue
            },
        });
        expect(policy.lastReviewedAt).toBeNull();

        const task = await createTask(ctxA, {
            title: 'Review policy: Acceptable Use',
            type: 'TASK',
            source: 'POLICY_REVIEW',
        });
        await addTaskLink(ctxA, task.id, 'POLICY', policy.id);

        await setTaskStatus(ctxA, task.id, 'CLOSED', 'Reviewed');

        const after = await db.policy.findUniqueOrThrow({ where: { id: policy.id } });
        expect(after.lastReviewedAt).not.toBeNull();
        // Review cycle rolled forward ~90 days into the future.
        expect(after.nextReviewAt).not.toBeNull();
        expect(after.nextReviewAt!.getTime()).toBeGreaterThan(Date.now());
    });

    // ─── Reconciler 7 — evidence-expiry reminder → review serviced ──

    it('closing an EVIDENCE_EXPIRY reminder task services the review cadence', async () => {
        const evidence = await db.evidence.create({
            data: {
                tenantId: TENANT_A,
                type: 'FILE',
                title: 'SOC 2 report',
                reviewCycle: 'QUARTERLY',
            },
        });

        const task = await createTask(ctxA, {
            title: 'Refresh expiring evidence: SOC 2 report',
            type: 'TASK',
            source: 'EVIDENCE_EXPIRY',
        });
        await addTaskLink(ctxA, task.id, 'EVIDENCE', evidence.id);

        await setTaskStatus(ctxA, task.id, 'CLOSED', 'Refreshed');

        const after = await db.evidence.findUniqueOrThrow({ where: { id: evidence.id } });
        // nextReviewDate rolled forward by the QUARTERLY cadence.
        expect(after.nextReviewDate).not.toBeNull();
        expect(after.nextReviewDate!.getTime()).toBeGreaterThan(Date.now());
    });

    // ─── Two-tenant isolation ────────────────────────────────────────

    it('a tenant-B close on a tenant-A task fails and reconciles nothing', async () => {
        const control = await db.control.create({
            data: { tenantId: TENANT_A, code: `C-${TAG}-iso`, name: 'Isolated control', frequency: 'MONTHLY' },
        });
        const task = await createTask(ctxA, {
            title: 'Tenant A gap',
            type: 'CONTROL_GAP',
            controlId: control.id,
            source: 'INTEGRATION',
        });

        await expect(setTaskStatus(ctxB, task.id, 'CLOSED', 'cross-tenant')).rejects.toThrow();

        // Tenant A's task is untouched (still OPEN) and its control was
        // never re-attested by the failed cross-tenant call.
        const taskAfter = await db.task.findUniqueOrThrow({ where: { id: task.id } });
        expect(taskAfter.status).toBe('OPEN');
        const controlAfter = await db.control.findUniqueOrThrow({ where: { id: control.id } });
        expect(controlAfter.lastTested).toBeNull();
    });
});
