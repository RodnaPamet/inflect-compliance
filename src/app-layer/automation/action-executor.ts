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
import { TERMINAL_WORK_ITEM_STATUSES, isTerminalStatus } from '../domain/work-item-status';
import { createTask as createTaskUsecase, setTaskStatus } from '../usecases/task';
import { setControlStatus } from '../usecases/control/mutations';
import { bulkSetRiskStatus } from '../usecases/risk';
import { assertCanCreateTask } from '../policies/task.policies';
import { AppError } from '@/lib/errors/types';
import { getPermissionsForRole, parsePermissionsJson } from '@/lib/permissions';
import { computePermissions } from '@/lib/tenant-context';
import type { RequestContext } from '../types';
import type {
    NotifyUserActionConfig,
    CreateTaskActionConfig,
    UpdateStatusActionConfig,
    WebhookActionConfig,
} from './types';

type ActorResolution =
    | { ok: true; ctx: RequestContext }
    | { ok: false; summary: string };

/**
 * Build the RequestContext an automation action executes under.
 *
 * The principal is the RULE AUTHOR — authoring a rule requires `canAdmin`
 * (`assertCanManageAutomation`), so the author is the accountable party for
 * everything the rule does. The member whose action happened to FIRE the
 * trigger is provenance, not authority: they may be a READER who merely
 * created a risk, and borrowing their identity to run an admin-shaped action
 * would be an escalation in both directions. Only an author-less (legacy /
 * seeded) rule falls back to the firing actor, and that actor is resolved
 * through the same real-membership path.
 *
 * The role is re-resolved from `TenantMembership` on EVERY execution and
 * never fabricated, so:
 *   • a demoted or removed author loses the authority their rule carried;
 *   • a custom role that withholds a granular flag keeps withholding it here;
 *   • an INVITED / DEACTIVATED / REMOVED membership cannot execute at all.
 *
 * Mirrors `resolveTenantContext` (src/lib/tenant-context.ts) — same
 * customRole-aware resolution, same membership-status refusal — reusing its
 * `computePermissions` so the two can never drift.
 */
async function resolveActorCtx(db: Db, tenantId: string, userId: string): Promise<ActorResolution> {
    const membership = await db.tenantMembership.findUnique({
        where: { tenantId_userId: { tenantId, userId } },
        include: { customRole: true, tenant: { select: { slug: true } } },
    });
    if (!membership) {
        return { ok: false, summary: `Rule actor ${userId} is not a member of this tenant` };
    }
    if (membership.status !== 'ACTIVE') {
        return {
            ok: false,
            summary: `Rule actor ${userId} has a ${membership.status} membership — execution refused`,
        };
    }
    const effectiveRole = membership.customRole?.baseRole ?? membership.role;
    return {
        ok: true,
        ctx: {
            requestId: `automation-${tenantId}`,
            userId,
            tenantId,
            // Without a slug the usecase's assignee bell/email short-circuits
            // (`emitTaskAssignedNotification` opens on `!ctx.tenantSlug`), so
            // the docblock below would be promising a notification that never
            // fires.
            tenantSlug: membership.tenant?.slug,
            role: effectiveRole,
            permissions: computePermissions(effectiveRole),
            appPermissions: membership.customRole
                ? parsePermissionsJson(membership.customRole.permissionsJson, membership.customRole.baseRole)
                : getPermissionsForRole(membership.role),
        },
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
    // Author first, firing actor only as the author-less fallback — see
    // `resolveActorCtx`.
    const principalUserId = rule.createdByUserId ?? event.actorUserId;
    if (!principalUserId) return { ok: false, summary: 'No actor to own the created task' };
    // Resolve real authority BEFORE any read or write, so an unauthorised rule
    // leaves no trace beyond the FAILED execution row carrying the reason.
    const resolved = await resolveActorCtx(db, event.tenantId, principalUserId);
    if (!resolved.ok) return { ok: false, summary: resolved.summary };
    const ctx = resolved.ctx;
    try {
        // The canonical predicate, not a copy of it: `assertCanCreateTask`
        // reads both the coarse `canWrite` and the granular `tasks.create`
        // flag, so a custom role withholding either is refused here exactly as
        // it would be on the HTTP path.
        assertCanCreateTask(ctx);
    } catch {
        return {
            ok: false,
            summary: `Rule actor ${principalUserId} (role ${ctx.role}) lacks permission to create tasks`,
        };
    }
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

/**
 * The status-changed event each UPDATE_STATUS target emits once its write
 * lands. Read by the self-trigger guard in `updateStatus`.
 *
 * Cross-entity pairings are absent deliberately: UPDATE_STATUS only ever
 * writes `event.entityId`, so a rule triggered by `RISK_STATUS_CHANGED` whose
 * action targets `Task` would be addressing a Task table with a Risk id and
 * match nothing. The only reachable loop is entity-type-with-itself.
 */
const SELF_TRIGGER_EVENT: Record<string, string> = {
    Risk: 'RISK_STATUS_CHANGED',
    Task: 'TASK_STATUS_CHANGED',
    Control: 'CONTROL_STATUS_CHANGED',
};

/**
 * Render a refused status change as an execution summary.
 *
 * The reason is the gate's OWN message (`AppError.message`) — the four-eyes
 * refusal reads "Only the assigned reviewer can sign off and complete this
 * task.", the relevance refusal names the missing link. It lands verbatim on
 * `AutomationExecution.errorMessage`, so an operator staring at a FAILED row
 * learns which gate refused and why without opening the code.
 */
function refusedSummary(
    entityType: string,
    toStatus: string,
    ctx: RequestContext,
    err: unknown,
): string {
    const reason = err instanceof AppError || err instanceof Error ? err.message : String(err);
    return `Refused ${entityType} status change to ${toStatus} for rule actor ${ctx.userId} (role ${ctx.role}): ${reason}`;
}

/**
 * UPDATE_STATUS — route every target through its canonical status usecase.
 *
 * This handler used to write `db.{risk,task,control}.updateMany` directly. For
 * Task that was a bypass of SIX steps the HTTP path cannot skip: the
 * state-machine transition gate, the FOUR-EYES REVIEWER SIGN-OFF GATE, the
 * required-resolution rule, the type-relevance gate, the `TASK_STATUS_CHANGED`
 * audit row, and `reconcileTaskSource`. Since the allowlist permits
 * `Task.status → RESOLVED`/`CLOSED`, any rule author could close a
 * reviewer-gated task with nobody reviewing it and nothing in the audit
 * trail — the third bypass of that gate after `/issues/bulk/status` and
 * `/issues/bulk/assign`.
 *
 * Each target now goes through the usecase that owns its gates:
 *
 *   • Task    → `setTaskStatus` — the full sequence, single-path ordering,
 *               shared with the bulk path since #1868.
 *   • Control → `setControlStatus` — `assertCanUpdateControl` (coarse +
 *               granular), the global-library refusal, the
 *               `CONTROL_STATUS_CHANGED` audit row, and the cache bump.
 *   • Risk    → `bulkSetRiskStatus` with a one-element array. Risk has NO
 *               state machine and NO reviewer gate to inherit, so the
 *               available gain is authority + audit, and `bulkSetRiskStatus`
 *               is the usecase that writes a `status_change`-categorised
 *               audit row carrying real from/to. (`updateRisk` also accepts
 *               `status`, but it is a whole-entity patch whose audit row does
 *               not describe a status transition.) What Risk still LACKS —
 *               and would need before automation can be trusted to close a
 *               risk — is a transition state machine and an
 *               acceptance-authority check on `ACCEPTED`/`CLOSED`; neither
 *               exists on the HTTP path either, so this handler is now no
 *               weaker than a human clicking the same button.
 *
 * The write is authorised as the RULE AUTHOR (see `resolveActorCtx`), so a
 * reviewer-gated task can only be closed by a rule whose author IS the named
 * reviewer. Everything else FAILS the execution with the gate's own reason on
 * `errorMessage` — never a silent no-op.
 */
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

    // ── Recursion guard ──
    //
    // Routing through the usecases buys the audit row and the gates; it also
    // makes this handler EMIT. `setTaskStatus` fires `TASK_STATUS_CHANGED`
    // post-commit and `setControlStatus` fires `CONTROL_STATUS_CHANGED` — both
    // are automation triggers, which the old `updateMany` never produced. So a
    // rule `on TASK_STATUS_CHANGED → set this Task's status` now feeds itself.
    //
    // It does not run forever by accident: the second hop's target status
    // equals the current one, `checkWorkItemTransition` refuses the no-op, and
    // the loop dies at depth 2. But that is the state machine catching a
    // mistake, not a decision — and it does not hold for a PAIR of rules that
    // drive a task A → B → A, where every hop is a legal transition, every hop
    // has a distinct `stableKey`, and the dispatcher's `(ruleId, event,
    // stableKey)` idempotency key is therefore fresh each time. That loop is
    // unbounded.
    //
    // The guard is a refusal rather than a depth budget because a budget would
    // need the hop count carried through the event, and `emitAutomationEvent`
    // in `setTaskStatus` carries no such field (unlike `__subflowDepth`, which
    // subflow-dispatcher stamps for exactly this reason). Refusing costs
    // nothing that worked before — the old handler emitted no event, so no
    // existing rule can be relying on the loop — and the one shape it forbids
    // (auto-advance a task on its own status change) is precisely what the
    // four-eyes gate exists to prevent. If a legitimate use appears, the fix is
    // to carry a depth on the status event and bound it, not to drop this.
    if (event.event === SELF_TRIGGER_EVENT[cfg.entityType]) {
        return {
            ok: false,
            summary:
                `Refused: an UPDATE_STATUS action on ${cfg.entityType} cannot be driven by ` +
                `${event.event} — it writes the entity that fired it, so the rule would re-trigger itself`,
        };
    }

    // Authority BEFORE any write, so an unauthorised rule leaves no trace
    // beyond the FAILED execution row carrying the reason (the #1874 pattern).
    const principalUserId = rule.createdByUserId ?? event.actorUserId;
    if (!principalUserId) return { ok: false, summary: 'No actor to authorise the status change' };
    const resolved = await resolveActorCtx(db, event.tenantId, principalUserId);
    if (!resolved.ok) return { ok: false, summary: resolved.summary };
    const ctx = resolved.ctx;
    const entityId = event.entityId;

    // Explicit per-model dispatch (no dynamic index) so the model name can
    // never be attacker-influenced and the call stays type-checked.
    try {
        switch (cfg.entityType) {
            case 'Task':
                // A terminal write needs a non-empty resolution ("closed
                // without why" was a recurring SOC 2 finding), and
                // `UpdateStatusActionConfig` has no field for one. The rule is
                // the reason, so the rule names itself — the audit row and the
                // task body both end up pointing at the accountable
                // configuration rather than at an empty string.
                await setTaskStatus(
                    ctx,
                    entityId,
                    cfg.toStatus,
                    isTerminalStatus(cfg.toStatus)
                        ? `Set to ${cfg.toStatus} by automation rule "${rule.name}" (${rule.id}).`
                        : null,
                );
                break;
            case 'Control':
                await setControlStatus(ctx, entityId, cfg.toStatus);
                break;
            case 'Risk': {
                const { updated } = await bulkSetRiskStatus(
                    ctx,
                    [entityId],
                    // Membership was proven by the allowlist check above; the
                    // cast only re-states it for the compiler.
                    cfg.toStatus as Parameters<typeof bulkSetRiskStatus>[2],
                );
                if (updated === 0) {
                    return { ok: false, summary: `No Risk matched ${entityId}` };
                }
                break;
            }
            default:
                // 'Issue' has no standalone model (issues are Tasks via
                // WorkItemType) — unsupported here rather than guessing the
                // backing table. Unreachable: STATUS_ALLOWLIST has no entry.
                return { ok: false, summary: `Unsupported entityType: ${cfg?.entityType}` };
        }
    } catch (err) {
        return { ok: false, summary: refusedSummary(cfg.entityType, cfg.toStatus, ctx, err) };
    }

    return {
        ok: true,
        summary: `Set ${cfg.entityType}.${cfg.field} = ${cfg.toStatus}`,
        detail: { updated: 1, entityId, actorUserId: ctx.userId, actorRole: ctx.role },
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
