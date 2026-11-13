/**
 * Automation rule usecases (Workflow Automation Epic 1).
 *
 * Thin orchestration over `AutomationRuleRepository`: assert the
 * automation-domain policy, run inside the tenant RLS context, call the
 * repo, emit an audit event on mutation. The HTTP routes under
 * `/api/t/[slug]/automation/rules` call these — never the repo directly.
 *
 * RBAC uses the automation module's own policies (`assertCanReadAutomation`
 * / `assertCanManageAutomation`) rather than new `PermissionSet` keys: the
 * domain already ships dedicated RBAC (read = any member, manage = ADMIN),
 * and `/automation/` is not a `PRIVILEGED_ROOTS` entry in the
 * api-permission-coverage guard, so the usecase-policy pattern is correct
 * here (same as controls/risks/evidence).
 */
import { RequestContext } from '../types';
import {
    AutomationRuleRepository,
    assertCanReadAutomation,
    assertCanManageAutomation,
    type AutomationRuleListFilters,
    type CreateAutomationRuleInput,
    type UpdateAutomationRuleInput,
} from '../automation';
import { logEvent } from '../events/audit';
import { notFound, badRequest, conflict } from '@/lib/errors/types';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { ACTION_CONFIG_BY_TYPE } from '../schemas/automation.schemas';
import { recordAutomationRuleCreated } from '@/lib/observability/business-metrics';
import { resolveWebhookSecretWrite, toPublicRule } from '../automation/webhook-secret';
import { readinessRefusal, ruleReadinessProblems } from '../automation/rule-readiness';
import { findCanvasStepForRule } from '../services/canvas-rule-link';

type StoredRule = Parameters<typeof toPublicRule>[0] & Parameters<typeof ruleReadinessProblems>[0];

/**
 * A rule as it leaves this module: without its signing key
 * (`webhook-secret.ts`), and with what it still lacks before it can run
 * (`rule-readiness.ts`), so every surface shows the server's own answer.
 */
function present<T extends StoredRule>(rule: T) {
    return { ...toPublicRule(rule), readiness: ruleReadinessProblems(rule) };
}

/**
 * Refuse a rule that would be ENABLED while incomplete. Called on the row as
 * written, inside the write's transaction, so a refusal rolls the write back.
 */
function assertReadyIfEnabled(rule: StoredRule & { status: string }) {
    if (rule.status !== 'ENABLED') return;
    const problems = ruleReadinessProblems(rule);
    if (problems.length > 0) throw badRequest(readinessRefusal(problems), { reasons: problems });
}

/**
 * Pure cycle check (Epic 7): walking the chain from `nextRuleId` via
 * `nextOf`, would we ever reach `ruleId` (loop back) or revisit a node
 * (pre-existing cycle)? Exported for unit testing the algorithm.
 */
export function followChainHasCycle(
    ruleId: string,
    nextRuleId: string,
    nextOf: (id: string) => string | null,
    maxHops = 100,
): boolean {
    let cur: string | null = nextRuleId;
    const seen = new Set<string>();
    let hops = 0;
    while (cur && hops < maxHops) {
        if (cur === ruleId) return true;
        if (seen.has(cur)) return true;
        seen.add(cur);
        cur = nextOf(cur);
        hops++;
    }
    return false;
}

/**
 * Async cycle guard over the rule chain — the one both writers share.
 *
 * ── Why this exists ─────────────────────────────────────────────────
 *
 * `followChainHasCycle` above is the pure algorithm and is unit-tested, but it
 * was DEAD in production: it needs a SYNCHRONOUS `nextOf`, and the real walk
 * has to read each hop from the database. `updateAutomationRule` therefore
 * re-implemented the identical walk inline, and the canvas sync path had no
 * guard at all. The duplication was a signature mismatch, not laziness — so
 * the fix is a shared ASYNC walker that collects the reachable sub-graph and
 * then delegates the verdict to the pure function, which makes the tested
 * algorithm live again and removes the copy.
 *
 * ── Both edges, not just one ────────────────────────────────────────
 *
 * The old inline guard covered `nextRuleId` only, while
 * `rule-chain-dispatch` follows `elseRuleId` identically. A cycle built out of
 * `elseRuleId` hops was therefore unguarded. `MAX_CHAIN_DEPTH` bounds the
 * damage at run time, but a rejected cycle is better than a silently truncated
 * one.
 */
async function collectChainGraph(
    db: PrismaTx,
    ctx: RequestContext,
    roots: string[],
    maxHops = 100,
): Promise<Map<string, { next: string | null; else: string | null }>> {
    const graph = new Map<string, { next: string | null; else: string | null }>();
    const queue = [...roots.filter(Boolean)];
    let hops = 0;
    while (queue.length && hops < maxHops) {
        const id = queue.shift()!;
        if (graph.has(id)) continue;
        const r = await AutomationRuleRepository.getById(db, ctx, id);
        // A missing rule is not a cycle — it is either cross-tenant (RLS hid
        // it) or deleted. Record it as a terminal node so the walk stops.
        const node = { next: r?.nextRuleId ?? null, else: r?.elseRuleId ?? null };
        graph.set(id, node);
        if (node.next) queue.push(node.next);
        if (node.else) queue.push(node.else);
        hops++;
    }
    return graph;
}

export async function assertNoChainCycle(
    db: PrismaTx,
    ctx: RequestContext,
    ruleId: string,
    proposed: { nextRuleId?: string | null; elseRuleId?: string | null },
): Promise<void> {
    const roots = [proposed.nextRuleId, proposed.elseRuleId].filter(
        (v): v is string => typeof v === 'string' && v.length > 0,
    );
    if (roots.length === 0) return;

    const graph = await collectChainGraph(db, ctx, roots);

    for (const root of roots) {
        // Delegate to the pure, unit-tested algorithm — once per edge kind, so
        // a cycle reachable only through `elseRuleId` is caught too.
        const viaNext = followChainHasCycle(ruleId, root, (id) => graph.get(id)?.next ?? null);
        const viaElse = followChainHasCycle(ruleId, root, (id) => graph.get(id)?.else ?? null);
        if (viaNext || viaElse) {
            throw badRequest('Rule chain would create a cycle');
        }
    }
}

/** Optional free-text fields are sanitised before persistence. */
function sanitizeOptional(value: string | null | undefined): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    return sanitizePlainText(value);
}

export async function listAutomationRules(
    ctx: RequestContext,
    filters: AutomationRuleListFilters = {},
) {
    assertCanReadAutomation(ctx);
    // `toPublicRule` on every rule that leaves this module: the row carries
    // the decrypted webhook signing key (see `webhook-secret.ts`).
    return runInTenantContext(ctx, async (db) =>
        (await AutomationRuleRepository.list(db, ctx, filters)).map(present),
    );
}

export async function getAutomationRule(ctx: RequestContext, id: string) {
    assertCanReadAutomation(ctx);
    return runInTenantContext(ctx, async (db) => {
        const rule = await AutomationRuleRepository.getById(db, ctx, id);
        if (!rule) throw notFound('Automation rule not found');
        // The canvas step that owns it, for "Open on canvas"; null for a rule
        // written on the Rules tab.
        const canvas = await findCanvasStepForRule(db, ctx, id);
        return { ...present(rule), canvas };
    });
}

export async function createAutomationRule(
    ctx: RequestContext,
    input: CreateAutomationRuleInput,
) {
    assertCanManageAutomation(ctx);
    const created = await runInTenantContext(ctx, async (db) => {
        // The signing key goes to the encrypted column, never into the config.
        const secretWrite = resolveWebhookSecretWrite({
            effectiveActionType: input.actionType,
            incomingConfig: input.actionConfig,
            requestedSecret: input.webhookSecret,
        });
        const rule = await AutomationRuleRepository.create(db, ctx, {
            ...input,
            actionConfig: secretWrite.config as CreateAutomationRuleInput['actionConfig'],
            webhookSecret: secretWrite.secret ?? null,
            name: sanitizePlainText(input.name),
            description: sanitizeOptional(input.description),
        });
        assertReadyIfEnabled(rule);
        await logEvent(db, ctx, {
            action: 'AUTOMATION_RULE_CREATED',
            entityType: 'AutomationRule',
            entityId: rule.id,
            // `category` is REQUIRED by `AuditDetailsJsonSchema`. Without it
            // `logEvent` threw "Invalid detailsJson structure" and every rule
            // create, edit, toggle and archive failed with a 400.
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: rule.name,
                operation: 'created',
                after: {
                    triggerEvent: rule.triggerEvent,
                    actionType: rule.actionType,
                    status: rule.status,
                    // Whether a key was set, never the key.
                    webhookSecretSet: Boolean(rule.webhookSecretEncrypted),
                },
            },
        });
        return present(rule);
    });
    recordAutomationRuleCreated();
    return created;
}

export async function updateAutomationRule(
    ctx: RequestContext,
    id: string,
    input: UpdateAutomationRuleInput,
) {
    assertCanManageAutomation(ctx);
    return runInTenantContext(ctx, async (db) => {
        // Chain cycle guard (Epic 7). Was an inline copy of
        // `followChainHasCycle` covering nextRuleId ONLY; now the shared
        // async walker, which covers elseRuleId too — the dispatcher follows
        // both identically, so guarding one was arbitrary.
        await assertNoChainCycle(db, ctx, id, {
            nextRuleId: input.nextRuleId,
            elseRuleId: input.elseRuleId,
        });

        // An ARCHIVED rule's status does not move through this edit (#5284).
        // The toggle refuses an archived rule; this PUT took any status, so the
        // canvas inspector's switch, which used it, re-enabled archived rules.
        if (input.status !== undefined) {
            const current = await AutomationRuleRepository.getById(db, ctx, id);
            if (!current) throw notFound('Automation rule not found');
            if (current.status === 'ARCHIVED' && input.status !== 'ARCHIVED') {
                throw conflict('This rule is archived. An archived rule cannot be enabled or disabled.');
            }
        }

        // Cross-field action validation against the EFFECTIVE type.
        //
        // The Zod `superRefine` only fires when actionType AND actionConfig
        // arrive together, so two sequential PUTs slipped past it entirely:
        // send `actionConfig` alone (stored unvalidated), then `actionType`
        // alone (nothing left to validate against). The rule ends up ENABLED
        // with a config its own schema would reject.
        //
        // This cannot live in the schema: validating a config against the
        // STORED actionType requires reading the row, which Zod cannot do. So
        // it lives here, where both halves are available — the incoming value
        // when supplied, the persisted one otherwise.
        let secretWrite: ReturnType<typeof resolveWebhookSecretWrite> | null = null;
        if (
            input.actionType !== undefined ||
            input.actionConfig !== undefined ||
            input.webhookSecret !== undefined
        ) {
            const existing = await AutomationRuleRepository.getById(db, ctx, id);
            if (!existing) throw notFound('Automation rule not found');
            secretWrite = resolveWebhookSecretWrite({
                effectiveActionType: input.actionType ?? existing.actionType,
                incomingConfig: input.actionConfig,
                requestedSecret: input.webhookSecret,
                existing,
            });
            const effectiveType = input.actionType ?? existing.actionType;
            const effectiveConfig =
                input.actionConfig ?? (existing.actionConfigJson as unknown);
            const schema = ACTION_CONFIG_BY_TYPE[
                effectiveType as keyof typeof ACTION_CONFIG_BY_TYPE
            ];
            if (schema) {
                const res = schema.safeParse(effectiveConfig);
                if (!res.success) {
                    throw badRequest(
                        `Invalid config for ${effectiveType}: ${res.error.issues[0]?.message ?? 'invalid'}`,
                    );
                }
            }
        }
        const rule = await AutomationRuleRepository.update(db, ctx, id, {
            ...input,
            ...(secretWrite
                ? {
                      ...(input.actionConfig !== undefined
                          ? { actionConfig: secretWrite.config as UpdateAutomationRuleInput['actionConfig'] }
                          : {}),
                      webhookSecret: secretWrite.secret,
                  }
                : {}),
            ...(input.name !== undefined ? { name: sanitizePlainText(input.name) } : {}),
            ...(input.description !== undefined
                ? { description: sanitizeOptional(input.description) }
                : {}),
        });
        if (!rule) throw notFound('Automation rule not found');
        // An edit that enables the rule, or changes what it does while it is
        // enabled, must leave it complete.
        if (
            input.status !== undefined ||
            input.triggerEvent !== undefined ||
            input.actionType !== undefined ||
            input.actionConfig !== undefined ||
            input.scheduleConfig !== undefined
        ) {
            assertReadyIfEnabled(rule);
        }
        await logEvent(db, ctx, {
            action: 'AUTOMATION_RULE_UPDATED',
            entityType: 'AutomationRule',
            entityId: rule.id,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: rule.name,
                operation: 'updated',
                changedFields: Object.keys(input).filter(
                    (k) => (input as Record<string, unknown>)[k] !== undefined,
                ),
                after: {
                    status: rule.status,
                    // Whether the key changed, never the key.
                    ...(secretWrite?.secret === null ? { webhookSecret: 'removed' } : {}),
                    ...(typeof secretWrite?.secret === 'string' ? { webhookSecret: 'set' } : {}),
                },
            },
        });
        return present(rule);
    });
}

export async function toggleAutomationRule(
    ctx: RequestContext,
    id: string,
    status: 'ENABLED' | 'DISABLED',
) {
    assertCanManageAutomation(ctx);
    return runInTenantContext(ctx, async (db) => {
        const rule = await AutomationRuleRepository.toggle(db, ctx, id, status);
        if (!rule) {
            throw notFound('Automation rule not found, or it has been archived');
        }
        assertReadyIfEnabled(rule);
        await logEvent(db, ctx, {
            action: status === 'ENABLED' ? 'AUTOMATION_RULE_ENABLED' : 'AUTOMATION_RULE_DISABLED',
            entityType: 'AutomationRule',
            entityId: rule.id,
            detailsJson: {
                category: 'status_change',
                entityName: rule.name,
                toStatus: status,
            },
        });
        return present(rule);
    });
}

export async function archiveAutomationRule(ctx: RequestContext, id: string) {
    assertCanManageAutomation(ctx);
    return runInTenantContext(ctx, async (db) => {
        const existing = await AutomationRuleRepository.getById(db, ctx, id);
        if (!existing) throw notFound('Automation rule not found');
        const rule = await AutomationRuleRepository.archive(db, ctx, id);
        await logEvent(db, ctx, {
            action: 'AUTOMATION_RULE_ARCHIVED',
            entityType: 'AutomationRule',
            entityId: id,
            detailsJson: {
                category: 'entity_lifecycle',
                entityName: existing.name,
                operation: 'archived',
            },
        });
        return rule ? present(rule) : rule;
    });
}
