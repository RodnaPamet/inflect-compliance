/**
 * Integration — an automation UPDATE_STATUS action is subject to the SAME
 * gates as a human clicking the same button.
 *
 * The handler used to write `db.task.updateMany({ status })` directly, with
 * no authority check and no audit row, while its allowlist permitted
 * `Task.status → RESOLVED`/`CLOSED`. That made it the third route around the
 * four-eyes reviewer gate after `/issues/bulk/status` and
 * `/issues/bulk/assign`: any rule author could close a reviewer-gated task
 * with nobody reviewing it, and the close left nothing in the trail.
 *
 * It now routes each target through the usecase that owns its gates —
 * `setTaskStatus` / `setControlStatus` / `bulkSetRiskStatus` — executing as
 * the RULE AUTHOR's real membership (#1874's `resolveActorCtx`).
 *
 * What this proves against a real database, through the real dispatcher and
 * the real usecases (nothing mocked in the authorization path):
 *
 *   • a reviewer-gated task is NOT closed by a rule whose author is not the
 *     reviewer — the execution settles FAILED carrying the gate's own reason;
 *   • the same rule authored by the REVIEWER does close it, and that close
 *     writes the TASK_STATUS_CHANGED audit row, a resolution naming the rule,
 *     and reconciles the source Finding;
 *   • a type-irrelevant close (AUDIT_FINDING with no control and no link) is
 *     refused, as it is on the HTTP path;
 *   • a READER-authored rule has no authority to move a status at all;
 *   • a rule triggered by TASK_STATUS_CHANGED cannot drive UPDATE_STATUS on
 *     the entity that fired it — the recursion the usecase's own emission
 *     would otherwise open;
 *   • Control goes through `setControlStatus`, so its authority gate binds too.
 *
 * Every refusal is asserted to leave the row UNCHANGED as well as FAILED — a
 * gate that reports a refusal after writing would be the same bug wearing a
 * better error message.
 *
 * Setup + assertions use a raw (superuser) client; the executions under test
 * run through `runAutomationEventDispatch`, exactly as the BullMQ worker
 * invokes them. Each test owns exactly one ENABLED rule (afterEach disables
 * them) because a dispatch fans out to every matching rule in the tenant.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { createTask, getTask } from '@/app-layer/usecases/task';
import { runAutomationEventDispatch } from '@/app-layer/jobs/automation-event-dispatch';
import { toDispatchPayload } from '@/app-layer/automation';
import type { AutomationEventDispatchPayload } from '@/app-layer/jobs/types';

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `aus-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${TAG}`;

let reviewerId: string;
let adminId: string;
let readerId: string;
/** An OWNER context used only to BUILD fixtures — never the actor under test. */
let seedCtx: ReturnType<typeof makeRequestContext>;

async function makeMember(label: string, role: Role): Promise<string> {
    const email = `${TAG}-${label}@example.test`;
    const u = await db.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await db.tenantMembership.create({
        data: { tenantId: TENANT, userId: u.id, role, status: MembershipStatus.ACTIVE },
    });
    return u.id;
}

/** An ENABLED UPDATE_STATUS rule attributed to `authorId`. */
async function makeRule(opts: {
    label: string;
    authorId: string | null;
    triggerEvent?: string;
    entityType?: string;
    toStatus?: string;
}) {
    return db.automationRule.create({
        data: {
            tenantId: TENANT,
            name: `${TAG}-${opts.label}`,
            triggerEvent: opts.triggerEvent ?? 'TASK_CREATED',
            actionType: 'UPDATE_STATUS',
            actionConfigJson: {
                entityType: opts.entityType ?? 'Task',
                field: 'status',
                toStatus: opts.toStatus ?? 'CLOSED',
            },
            status: 'ENABLED',
            priority: 0,
            createdByUserId: opts.authorId,
        },
    });
}

function payload(
    entityId: string,
    opts: { event?: string; entityType?: string; firedBy?: string | null } = {},
): AutomationEventDispatchPayload {
    return toDispatchPayload({
        event: opts.event ?? 'TASK_CREATED',
        tenantId: TENANT,
        entityType: opts.entityType ?? 'Task',
        entityId,
        actorUserId: opts.firedBy ?? null,
        emittedAt: new Date(),
        stableKey: `${entityId}:${randomUUID().slice(0, 6)}`,
        data: {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
}

async function executionFor(ruleId: string) {
    const rows = await db.automationExecution.findMany({
        where: { tenantId: TENANT, ruleId },
        orderBy: { createdAt: 'desc' },
    });
    return rows[0];
}

const statusOf = async (taskId: string) =>
    (await db.task.findUniqueOrThrow({ where: { id: taskId } })).status;

const statusAudits = (taskId: string) =>
    db.auditLog.findMany({
        where: { tenantId: TENANT, entity: 'Task', entityId: taskId, action: 'TASK_STATUS_CHANGED' },
    });

/**
 * A reviewer-gated task parked at IN_REVIEW — the exact shape the four-eyes
 * gate protects. `controlId` satisfies type relevance so the ONLY thing that
 * can refuse the close is the reviewer gate, and `findingId` gives the source
 * reconciler something observable to write.
 */
async function makeGatedTask(label: string) {
    const control = await db.control.create({
        data: { tenantId: TENANT, code: `C-${TAG}-${label}`, name: `Control ${label}` },
    });
    const finding = await db.finding.create({
        data: {
            tenantId: TENANT,
            severity: 'MEDIUM',
            type: 'NONCONFORMITY',
            title: `Finding ${label}`,
            description: 'to remediate',
            status: 'OPEN',
        },
    });
    const task = await createTask(seedCtx, {
        title: `Remediate ${label}`,
        type: 'AUDIT_FINDING',
        source: 'AUDIT',
        controlId: control.id,
        findingId: finding.id,
        // Reviewer ≠ assignee is enforced at creation (SoD), so leave the
        // assignee unset rather than fighting that gate here.
        reviewerUserId: reviewerId,
    });
    await db.task.update({ where: { id: task.id }, data: { status: 'IN_REVIEW' } });
    return { task, finding, control };
}

describeFn('automation UPDATE_STATUS obeys the status gates', () => {
    beforeAll(async () => {
        await db.tenant.upsert({
            where: { id: TENANT },
            update: {},
            create: { id: TENANT, name: `t ${TAG}`, slug: TENANT },
        });
        reviewerId = await makeMember('reviewer', Role.ADMIN);
        adminId = await makeMember('admin', Role.ADMIN);
        readerId = await makeMember('reader', Role.READER);
        seedCtx = makeRequestContext('OWNER', {
            tenantId: TENANT,
            tenantSlug: TENANT,
            userId: adminId,
        });
    });

    afterEach(async () => {
        // A dispatch fans out to EVERY enabled rule matching the event, so a
        // rule left enabled would fire during the next test and mutate its
        // fixture. Each test enables exactly the rule it is about.
        await db.automationRule.updateMany({
            where: { tenantId: TENANT },
            data: { status: 'DISABLED' },
        });
    });

    afterAll(async () => {
        try {
            await db.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT);
            await db.automationExecution.deleteMany({ where: { tenantId: TENANT } });
            await db.automationRule.deleteMany({ where: { tenantId: TENANT } });
            await db.taskLink.deleteMany({ where: { tenantId: TENANT } });
            await db.task.deleteMany({ where: { tenantId: TENANT } });
            await db.finding.deleteMany({ where: { tenantId: TENANT } });
            await db.control.deleteMany({ where: { tenantId: TENANT } });
            await db.tenantMembership.deleteMany({ where: { tenantId: TENANT } });
            await db.user.deleteMany({ where: { id: { in: [reviewerId, adminId, readerId] } } });
            await db.tenant.delete({ where: { id: TENANT } });
        } catch {
            /* best effort */
        }
        await db.$disconnect();
    });

    test('a rule authored by someone OTHER than the reviewer cannot close a reviewer-gated task', async () => {
        const { task, finding } = await makeGatedTask('other-author');
        const rule = await makeRule({ label: 'other-author', authorId: adminId });

        const result = await runAutomationEventDispatch(payload(task.id, { firedBy: adminId }));
        expect(result.rulesMatched).toBe(1);

        const exec = await executionFor(rule.id);
        expect(exec.status).toBe('FAILED');
        // The gate's OWN message, verbatim on the execution row.
        expect(exec.errorMessage).toContain('Only the assigned reviewer can sign off');
        expect(exec.errorMessage).toContain(adminId);

        // Refused means UNCHANGED — not "refused after writing".
        expect(await statusOf(task.id)).toBe('IN_REVIEW');
        expect(await statusAudits(task.id)).toHaveLength(0);
        expect((await db.finding.findUniqueOrThrow({ where: { id: finding.id } })).status).toBe('OPEN');
    });

    test('a rule authored by the REVIEWER closes it, audits it, and reconciles the source', async () => {
        const { task, finding } = await makeGatedTask('reviewer-author');
        const rule = await makeRule({ label: 'reviewer-author', authorId: reviewerId });

        // Fired by the READER: the firing member is provenance, the AUTHOR is
        // authority — so the sign-off is credited to the reviewer, not to
        // whoever happened to trip the trigger.
        const result = await runAutomationEventDispatch(payload(task.id, { firedBy: readerId }));
        expect(result.rulesMatched).toBe(1);

        const exec = await executionFor(rule.id);
        expect(exec.status).toBe('SUCCEEDED');

        expect(await statusOf(task.id)).toBe('CLOSED');
        // A terminal close needs a resolution, and the config has no field for
        // one — the rule names itself so the trail points at the accountable
        // configuration rather than at an empty string. Read through the
        // usecase: `resolution` is an Epic-B encrypted column, so the raw
        // superuser client sees only the `v2:` envelope.
        const closed = await getTask(seedCtx, task.id);
        expect(closed?.resolution).toContain(rule.name);
        expect(closed?.resolution).toContain('CLOSED');

        const audits = await statusAudits(task.id);
        expect(audits).toHaveLength(1);
        expect(audits[0].userId).toBe(reviewerId);
        expect(audits[0].detailsJson).toMatchObject({ fromStatus: 'IN_REVIEW', toStatus: 'CLOSED' });

        // Source reconciliation — the step a raw updateMany skipped entirely.
        const reconciled = await db.finding.findUniqueOrThrow({ where: { id: finding.id } });
        expect(reconciled.status).toBe('CLOSED');
        expect(reconciled.verifiedBy).toBe(reviewerId);
    });

    test('a type-irrelevant close is refused', async () => {
        // AUDIT_FINDING with no controlId and no CONTROL / FRAMEWORK_REQUIREMENT
        // link — the shape the relevance rule exists to refuse on a terminal
        // move. No reviewer, so the ONLY gate that can fire is relevance.
        const task = await createTask(seedCtx, {
            title: `Irrelevant ${TAG}`,
            type: 'AUDIT_FINDING',
            source: 'AUDIT',
        });
        const rule = await makeRule({ label: 'type-irrelevant', authorId: adminId });

        await runAutomationEventDispatch(payload(task.id, { firedBy: adminId }));

        const exec = await executionFor(rule.id);
        expect(exec.status).toBe('FAILED');
        expect(exec.errorMessage).toContain('must have a controlId or a link to CONTROL');
        expect(await statusOf(task.id)).toBe('OPEN');
        expect(await statusAudits(task.id)).toHaveLength(0);
    });

    test('a READER-authored rule has no authority to move a status', async () => {
        const task = await createTask(seedCtx, {
            title: `Reader-driven ${TAG}`,
            type: 'TASK',
            source: 'MANUAL',
        });
        const rule = await makeRule({ label: 'reader-author', authorId: readerId });

        await runAutomationEventDispatch(payload(task.id, { firedBy: adminId }));

        const exec = await executionFor(rule.id);
        expect(exec.status).toBe('FAILED');
        expect(exec.errorMessage).toContain('READER');
        expect(await statusOf(task.id)).toBe('OPEN');
        expect(await statusAudits(task.id)).toHaveLength(0);
    });

    test('a TASK_STATUS_CHANGED-triggered rule cannot drive UPDATE_STATUS on the task that fired it', async () => {
        // Routing through `setTaskStatus` makes this handler EMIT
        // TASK_STATUS_CHANGED, which is itself a trigger — so this rule shape
        // feeds itself. It is refused rather than depth-bounded; see the
        // recursion-guard comment in the executor.
        const task = await createTask(seedCtx, {
            title: `Self-trigger ${TAG}`,
            type: 'TASK',
            source: 'MANUAL',
        });
        const rule = await makeRule({
            label: 'self-trigger',
            authorId: adminId,
            triggerEvent: 'TASK_STATUS_CHANGED',
        });

        await runAutomationEventDispatch(
            payload(task.id, { event: 'TASK_STATUS_CHANGED', firedBy: adminId }),
        );

        const exec = await executionFor(rule.id);
        expect(exec.status).toBe('FAILED');
        expect(exec.errorMessage).toContain('re-trigger itself');
        expect(await statusOf(task.id)).toBe('OPEN');
        // Exactly one execution: the refusal happened BEFORE any write, so
        // nothing emitted and nothing came back around.
        expect(
            await db.automationExecution.count({ where: { tenantId: TENANT, ruleId: rule.id } }),
        ).toBe(1);
    });

    test('Control status goes through setControlStatus, so its authority gate binds', async () => {
        const control = await db.control.create({
            data: { tenantId: TENANT, code: `C-${TAG}-authz`, name: 'Gated control', status: 'NOT_STARTED' },
        });
        const rule = await makeRule({
            label: 'control-reader',
            authorId: readerId,
            triggerEvent: 'CONTROL_CREATED',
            entityType: 'Control',
            toStatus: 'IMPLEMENTED',
        });

        await runAutomationEventDispatch(
            payload(control.id, { event: 'CONTROL_CREATED', entityType: 'Control', firedBy: adminId }),
        );

        const exec = await executionFor(rule.id);
        expect(exec.status).toBe('FAILED');
        expect(exec.errorMessage).toContain('permission to update controls');
        expect((await db.control.findUniqueOrThrow({ where: { id: control.id } })).status).toBe(
            'NOT_STARTED',
        );
    });
});
