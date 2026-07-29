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
import { notFound, badRequest } from '@/lib/errors/types';
import { runInTenantContext, type PrismaTx } from '@/lib/db-context';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { recordAutomationRuleCreated } from '@/lib/observability/business-metrics';

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
    return runInTenantContext(ctx, (db) =>
        AutomationRuleRepository.list(db, ctx, filters),
    );
}

export async function getAutomationRule(ctx: RequestContext, id: string) {
    assertCanReadAutomation(ctx);
    return runInTenantContext(ctx, async (db) => {
        const rule = await AutomationRuleRepository.getById(db, ctx, id);
        if (!rule) throw notFound('Automation rule not found');
        return rule;
    });
}

export async function createAutomationRule(
    ctx: RequestContext,
    input: CreateAutomationRuleInput,
) {
    assertCanManageAutomation(ctx);
    const created = await runInTenantContext(ctx, async (db) => {
        const rule = await AutomationRuleRepository.create(db, ctx, {
            ...input,
            name: sanitizePlainText(input.name),
            description: sanitizeOptional(input.description),
        });
        await logEvent(db, ctx, {
            action: 'AUTOMATION_RULE_CREATED',
            entityType: 'AutomationRule',
            entityId: rule.id,
            detailsJson: {
                name: rule.name,
                triggerEvent: rule.triggerEvent,
                actionType: rule.actionType,
                status: rule.status,
            },
        });
        return rule;
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
        const rule = await AutomationRuleRepository.update(db, ctx, id, {
            ...input,
            ...(input.name !== undefined ? { name: sanitizePlainText(input.name) } : {}),
            ...(input.description !== undefined
                ? { description: sanitizeOptional(input.description) }
                : {}),
        });
        if (!rule) throw notFound('Automation rule not found');
        await logEvent(db, ctx, {
            action: 'AUTOMATION_RULE_UPDATED',
            entityType: 'AutomationRule',
            entityId: rule.id,
            detailsJson: { name: rule.name, status: rule.status },
        });
        return rule;
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
        await logEvent(db, ctx, {
            action: status === 'ENABLED' ? 'AUTOMATION_RULE_ENABLED' : 'AUTOMATION_RULE_DISABLED',
            entityType: 'AutomationRule',
            entityId: rule.id,
            detailsJson: { name: rule.name, status },
        });
        return rule;
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
            detailsJson: { name: existing.name },
        });
        return rule;
    });
}
