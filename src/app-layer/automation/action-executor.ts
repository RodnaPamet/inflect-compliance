/**
 * Automation action executor (Action Execution Engine).
 *
 * The piece the Epic 60 foundation deferred: this turns a matched rule into a
 * REAL side effect. The dispatchers (event / chain / sub-flow) call
 * `executeAction` after they claim an execution row; the result decides whether
 * the row settles SUCCEEDED or FAILED.
 *
 * Every action type is handled here — there is no longer a "no-op" branch. A
 * structural ratchet (tests/guards/automation-action-executor-coverage.test.ts)
 * fails CI if a new `AutomationActionType` is added without a handler, or if a
 * dispatcher regresses to a hardcoded outcome note.
 */
import { createHmac } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { enqueue } from '../jobs/queue';
import { UPDATE_STATUS_TARGETS } from '@/lib/automation/status-allowlist';
import { safeFetch, SsrfBlockedError, RedirectNotAllowedError } from './webhook-safety';
import { isNotificationsEnabled } from '../notifications/settings';
import { TERMINAL_WORK_ITEM_STATUSES } from '../domain/work-item-status';
import { createTask as createTaskUsecase } from '../usecases/task';
import { getPermissionsForRole } from '@/lib/permissions';
import type { RequestContext } from '../types';
import type {
    NotifyUserActionConfig,
    CreateTaskActionConfig,
    UpdateStatusActionConfig,
    WebhookActionConfig,
} from './types';

/**
 * A system RequestContext for an automation-spawned task. The rule's
 * resolved actor (event actor, else rule author) owns the task; ADMIN
 * permissions clear `assertCanWriteTasks`. Mirrors the makeSystemCtx
 * pattern used by the background-job monitors.
 */
function buildAutomationCtx(tenantId: string, userId: string): RequestContext {
    return {
        requestId: `automation-${tenantId}`,
        userId,
        tenantId,
        role: 'ADMIN',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: false },
        appPermissions: getPermissionsForRole('ADMIN'),
    };
}

export interface ActionResult {
    ok: boolean;
    summary: string;
    detail?: Record<string, unknown>;
}

/** The slice of an AutomationRule the executor needs. */
export interface ExecutableRule {
    id: string;
    name: string;
    actionType: string;
    actionConfigJson: unknown;
    createdByUserId: string | null;
    /**
     * WEBHOOK HMAC key, decrypted on read by the Epic B middleware.
     *
     * Optional so the many call sites that build an ExecutableRule by hand do
     * not all have to change at once; absent means "fall back to the legacy
     * `actionConfig.secretRef`" during the migration window.
     */
    webhookSecretEncrypted?: string | null;
}

/** The slice of the firing event the executor needs. */
export interface ActionEvent {
    tenantId: string;
    event: string;
    entityType?: string;
    entityId?: string;
    actorUserId?: string | null;
    data?: Record<string, unknown>;
}

// A loose Prisma surface — the dispatchers pass the singleton client or a tx.
type Db = PrismaClient | Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const WEBHOOK_TIMEOUT_MS = 8000;

/**
 * UPDATE_STATUS transition allowlist — an automation rule may only write the
 * canonical `status` field, and only to a legal value for that entity. Without
 * this a rule config could write any column to any string.
 */
// PR-E — sourced from the client-safe shared allowlist so the builder's
// entity + status dropdowns and this server-side enforcement can never drift.
const STATUS_ALLOWLIST: Record<string, { field: string; values: ReadonlySet<string> }> =
    Object.fromEntries(
        Object.entries(UPDATE_STATUS_TARGETS).map(([entity, spec]) => [
            entity,
            { field: spec.field, values: new Set(spec.values) },
        ]),
    );

/**
 * Execute a rule's action. Never throws — failures are returned as
 * `{ ok: false }` so the dispatcher records a clean FAILED row.
 */
export async function executeAction(
    db: Db,
    rule: ExecutableRule,
    event: ActionEvent,
): Promise<ActionResult> {
    try {
        switch (rule.actionType) {
            case 'NOTIFY_USER':
                return await notifyUser(db, rule, event);
            case 'CREATE_TASK':
                return await createTask(db, rule, event);
            case 'UPDATE_STATUS':
                return await updateStatus(db, rule, event);
            case 'WEBHOOK':
                return await fireWebhook(rule, event);
            case 'INVOKE_SUBFLOW':
                return await invokeSubflow(rule, event);
            default:
                return { ok: false, summary: `Unknown action type: ${rule.actionType}` };
        }
    } catch (err) {
        return {
            ok: false,
            summary: `Action ${rule.actionType} failed: ${(err as Error).message}`,
        };
    }
}

async function notifyUser(db: Db, rule: ExecutableRule, event: ActionEvent): Promise<ActionResult> {
    const cfg = rule.actionConfigJson as NotifyUserActionConfig;
    const requested = Array.isArray(cfg?.userIds) ? cfg.userIds.filter(Boolean) : [];
    if (requested.length === 0) return { ok: true, summary: 'No recipients configured', detail: { notified: 0 } };
    // Respect the tenant's notification kill-switch (mirrors the retention job).
    if (!(await isNotificationsEnabled(db as never, event.tenantId))) {
        return { ok: true, summary: 'Notifications disabled for tenant', detail: { notified: 0 } };
    }
    // Only notify actual members of the firing tenant — drops stale/foreign ids
    // (tenant-isolation safety + avoids a dangling-FK insert).
    const members = await db.tenantMembership.findMany({
        where: { tenantId: event.tenantId, userId: { in: requested } },
        select: { userId: true },
    });
    const userIds = members.map((m: { userId: string }) => m.userId);
    if (userIds.length === 0) return { ok: true, summary: 'No valid recipients', detail: { notified: 0 } };
    await db.notification.createMany({
        data: userIds.map((userId: string) => ({
            tenantId: event.tenantId,
            userId,
            type: 'GENERAL',
            title: rule.name,
            message: cfg.message ?? rule.name,
            linkUrl: cfg.linkUrl ?? null,
        })),
        skipDuplicates: true,
    });
    return { ok: true, summary: `Notified ${userIds.length} user(s)`, detail: { notified: userIds.length } };
}

async function createTask(db: Db, rule: ExecutableRule, event: ActionEvent): Promise<ActionResult> {
    const cfg = rule.actionConfigJson as CreateTaskActionConfig;
    const createdByUserId = event.actorUserId ?? rule.createdByUserId;
    if (!createdByUserId) return { ok: false, summary: 'No actor to own the created task' };
    // Resolve an optional linked control from the event payload.
    const controlId =
        cfg.linkEntityType === 'Control' && cfg.linkEntityIdField
            ? (event.data?.[cfg.linkEntityIdField] as string | undefined) ?? null
            : null;
    // Dedupe: a rule firing repeatedly on the same entity shouldn't spawn a
    // new task each time. The dedupe key rides `metadataJson` (the canonical
    // createTask mints the visible TSK-N key, so it can no longer live in
    // `key`); the execution-claim row already prevents concurrent double-fire
    // of the same rule+event, so this is the over-time idempotency guard.
    const dedupeKey = `auto:${rule.id}:${event.entityId ?? 'noentity'}`;
    const existing = await db.task.findFirst({
        where: {
            tenantId: event.tenantId,
            status: { notIn: [...TERMINAL_WORK_ITEM_STATUSES] },
            deletedAt: null,
            metadataJson: { path: ['automationDedupeKey'], equals: dedupeKey },
        },
        select: { id: true },
    });
    if (existing) {
        return { ok: true, summary: `Task already open (${existing.id})`, detail: { taskId: existing.id, deduped: true } };
    }
    // Route through the canonical usecase so an automation-spawned task
    // carries the same TSK-N key, TASK_CREATED audit row, automation event,
    // and assignee bell/email as every other task. The executor runs on the
    // Prisma singleton (not inside a tx), so opening a fresh tenant context
    // here does not nest transactions.
    const ctx = buildAutomationCtx(event.tenantId, createdByUserId);
    const task = await createTaskUsecase(ctx, {
        type: 'TASK',
        title: cfg.title ?? rule.name,
        severity: cfg.severity ?? 'MEDIUM',
        priority: cfg.priority ?? 'P2',
        source: 'INTEGRATION',
        assigneeUserId: cfg.assigneeUserId ?? null,
        controlId,
        metadataJson: { automationDedupeKey: dedupeKey, ruleId: rule.id },
    });
    return { ok: true, summary: `Created task ${task.key}`, detail: { taskId: task.id, key: task.key } };
}

async function updateStatus(db: Db, rule: ExecutableRule, event: ActionEvent): Promise<ActionResult> {
    const cfg = rule.actionConfigJson as UpdateStatusActionConfig;
    if (!event.entityId) return { ok: false, summary: 'Event carries no entityId to update' };
    // Allowlist: only the canonical `status` field, only a legal target value.
    const allow = STATUS_ALLOWLIST[cfg?.entityType];
    if (!allow) return { ok: false, summary: `Unsupported entityType: ${cfg?.entityType}` };
    if (cfg.field !== allow.field) {
        return { ok: false, summary: `Field ${cfg.field} is not writable by automation` };
    }
    if (!allow.values.has(cfg.toStatus)) {
        return { ok: false, summary: `Illegal ${cfg.entityType} status: ${cfg.toStatus}` };
    }
    const where = { id: event.entityId, tenantId: event.tenantId };
    const data = { [allow.field]: cfg.toStatus };
    // Explicit per-model dispatch (no dynamic index) so the model name can
    // never be attacker-influenced and the call stays type-checked.
    let updated: number;
    switch (cfg?.entityType) {
        case 'Risk':
            updated = (await db.risk.updateMany({ where, data })).count;
            break;
        case 'Task':
            updated = (await db.task.updateMany({ where, data })).count;
            break;
        case 'Control':
            updated = (await db.control.updateMany({ where, data })).count;
            break;
        default:
            // 'Issue' has no standalone model (issues are Tasks via WorkItemType)
            // — unsupported here rather than guessing the backing table.
            return { ok: false, summary: `Unsupported entityType: ${cfg?.entityType}` };
    }
    return {
        ok: updated > 0,
        summary:
            updated > 0
                ? `Set ${cfg.entityType}.${cfg.field} = ${cfg.toStatus}`
                : `No ${cfg.entityType} matched ${event.entityId}`,
        detail: { updated },
    };
}

async function fireWebhook(rule: ExecutableRule, event: ActionEvent): Promise<ActionResult> {
    const cfg = rule.actionConfigJson as WebhookActionConfig;
    if (!cfg?.url) return { ok: false, summary: 'No webhook URL configured' };
    const body = JSON.stringify({
        rule: { id: rule.id, name: rule.name },
        event: { name: event.event, entityType: event.entityType, entityId: event.entityId },
        data: event.data ?? {},
    });
    // Caller headers are applied FIRST so the platform's own headers win.
    //
    // The spread used to come last, so a rule could override Content-Type and
    // User-Agent — and, when `secretRef` was unset, inject its own
    // `X-Inflect-Signature` and `Authorization`. A rule author is not
    // necessarily the person who owns the destination, so letting rule config
    // forge the platform's authenticity header is the sharp end of it.
    //
    // Reserved names are stripped rather than merely overwritten, so the
    // rejection is explicit and greppable rather than depending on key order.
    const RESERVED_HEADERS = ['content-type', 'user-agent', 'x-inflect-signature', 'authorization'];
    const callerHeaders = Object.fromEntries(
        Object.entries(cfg.headers ?? {}).filter(
            ([k]) => !RESERVED_HEADERS.includes(k.toLowerCase()),
        ),
    );
    const headers: Record<string, string> = {
        ...callerHeaders,
        'Content-Type': 'application/json',
        'User-Agent': 'Inflect-Automation/1',
    };
    // Sign the body so the consumer can verify authenticity (mirrors the
    // audit-stream's X-Inflect-Signature contract).
    // Prefer the ENCRYPTED column. `actionConfig.secretRef` is the legacy
    // location — a plain JSON column that stored the raw key in clear despite
    // the type claiming otherwise. The fallback keeps already-configured
    // webhooks signing until `scripts/migrate-webhook-secrets.ts` has swept
    // them across; it is removed once that reports zero remaining.
    const signingSecret = rule.webhookSecretEncrypted ?? cfg.secretRef;
    if (signingSecret) {
        const sig = createHmac('sha256', signingSecret).update(body).digest('hex');
        headers['X-Inflect-Signature'] = `sha256=${sig}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
        // safeFetch enforces the SSRF egress guard (https-only, private/metadata
        // block, DNS-rebinding re-check, IP-pin) on the tenant-supplied URL.
        const res = await safeFetch(cfg.url, {
            method: cfg.method ?? 'POST',
            headers,
            body,
            signal: controller.signal,
        });
        return {
            ok: res.ok,
            summary: `Webhook ${cfg.url} → ${res.status}`,
            detail: { status: res.status },
        };
    } catch (err) {
        if (err instanceof SsrfBlockedError) {
            return { ok: false, summary: `Webhook blocked: ${err.message}` };
        }
        if (err instanceof RedirectNotAllowedError) {
            // A redirect is a configuration error, not a transient failure.
            // Reported as a clean execution outcome rather than rethrown, so a
            // misconfigured endpoint fails the ONE rule instead of escaping as
            // an unhandled throw through the dispatcher.
            return { ok: false, summary: `Webhook redirect refused: ${err.message}` };
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

async function invokeSubflow(rule: ExecutableRule, event: ActionEvent): Promise<ActionResult> {
    const cfg = rule.actionConfigJson as { targetGroupId?: string };
    if (!cfg?.targetGroupId) return { ok: false, summary: 'No sub-flow target configured' };
    // The chained execution is created by the subflow-dispatch job; here we
    // only enqueue it. parentExecutionId is wired by the caller via the event.
    // Carry the recursion depth forward. `__subflowDepth` is stamped by
    // subflow-dispatcher on the data it hands to `executeAction`; absent on
    // the first hop, so an initial invoke enqueues depth 1. The dispatcher
    // refuses above MAX_SUBFLOW_DEPTH — a group whose entry rule invokes its
    // own group used to recurse without bound.
    const currentDepth = Number(event.data?.__subflowDepth ?? 0);
    await enqueue('subflow-dispatch', {
        tenantId: event.tenantId,
        targetGroupId: cfg.targetGroupId,
        parentExecutionId: (event.data?.__parentExecutionId as string) ?? '',
        triggerEvent: event.event,
        data: event.data ?? {},
        depth: (Number.isFinite(currentDepth) ? currentDepth : 0) + 1,
    });
    return { ok: true, summary: `Enqueued sub-flow ${cfg.targetGroupId}` };
}
