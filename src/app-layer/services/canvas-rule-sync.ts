/**
 * Canvas ↔ AutomationRule bidirectional bridge (Visual Rule Editor VR-3).
 *
 * The architectural keystone. Two sibling projections of one source of truth:
 *   • `ProcessNode` owns GEOMETRY (posX/posY/parentNodeKey/label) + the link
 *     (`dataJson.ruleId`).
 *   • `AutomationRule` owns LOGIC (triggerEvent / filter / action / chain).
 *
 * INVARIANT (locked by tests/guards/vr3-sync-invariant.test.ts):
 *   - Geometry fields NEVER appear in an AutomationRule write.
 *   - Logic fields (triggerFilterJson / actionConfigJson / triggerEvent)
 *     NEVER appear in a ProcessNode write. The only thing this bridge writes
 *     to a node is `dataJson.ruleId` (an opaque id).
 *
 * Model: an `action` node owns one rule (trigger + filter + action collapse
 * into the single AutomationRule row). Trigger/condition nodes feed that rule
 * via the inspector (VR-4), which edits the rule directly — NOT through this
 * sync. So this bridge's job is narrow + invariant-safe:
 *   Canvas → Rules (on save): create a stub rule for each NEW action node
 *     (write `ruleId` back), then wire chain topology (`chain-delay` edges →
 *     `nextRuleId`/`nextRuleDelay`), then sub-flow group membership
 *     (`subFlowGroupId`, #5477 — see canvas-subflow-membership.ts, which owns
 *     the one structural fact a rule takes from the canvas). It never copies
 *     node logic to the rule.
 *   Rules → Canvas (on load): merge each rule's live status + executionCount
 *     + a derived subtitle into the node for DISPLAY only (not persisted).
 */
import type { PrismaTx } from '@/lib/db-context';
import type { RequestContext } from '../types';
import { AutomationRuleRepository } from '../automation';
import type { CreateAutomationRuleInput } from '../automation/types';
import type { AutomationActionType } from '@prisma/client';
import { assertCanManageAutomation } from '../automation/policies';
import { assertNoChainCycle } from '../usecases/automation-rules';
import { logEvent } from '../events/audit';
import { UNSET_TRIGGER_EVENT } from '../automation/rule-readiness';
import { sanitizePlainText } from '@/lib/security/sanitize';
import { RULE_OWNING_KINDS } from './canvas-rule-link';
import { reconcileSubFlowMembership } from './canvas-subflow-membership';
import { HYDRATED_DISPLAY_KEYS } from '@/lib/processes/canvas-rule-wiring';

/** Rule names are capped at 200 by the rule schema. */
const MAX_RULE_NAME = 200;

/** A new step's rule is named after the step; the key only when it has no label. */
export function stubRuleName(node: { nodeKey: string; label: string }): string {
    const label = sanitizePlainText(node.label ?? '').trim();
    const name = label || `Canvas rule · ${node.nodeKey}`;
    return name.slice(0, MAX_RULE_NAME);
}

// Re-exported: the set lives in a leaf module so the rules usecase can read a
// rule's canvas step without importing this file, which imports that usecase.
export { RULE_OWNING_KINDS };

/**
 * The stub a NEW rule-owning node gets, by kind.
 *
 * Both are DRAFT and unconfigured on purpose: a node that created an ENABLED
 * rule would start firing on the next matching event because somebody dragged
 * a shape onto a canvas. The action type differs because that is the one thing
 * the KIND already decided — an `agent` node exists to invoke an agent, and
 * defaulting it to `NOTIFY_USER` would make the operator's first job undoing
 * the default.
 *
 * `INVOKE_AGENT`'s config is empty rather than carrying a placeholder agent id:
 * `agentId` and `workflowKey` are `z.string().min(1)`, so an empty object is
 * refused by the schema the moment somebody tries to ENABLE the rule, which is
 * exactly when it should be refused. A fabricated id would pass that check and
 * fail at dispatch with `agent_not_found` instead.
 */
export const STUB_BY_KIND: Record<
    string,
    { actionType: AutomationActionType; actionConfig: CreateAutomationRuleInput['actionConfig'] }
> = {
    action: { actionType: 'NOTIFY_USER', actionConfig: { userIds: [], message: '' } },
    agent: { actionType: 'INVOKE_AGENT', actionConfig: {} },
};
const CHAIN_EDGE_KIND = 'chain-delay';
const PASS_EDGE_KIND = 'condition-pass';
const FAIL_EDGE_KIND = 'condition-fail';

interface GraphNode {
    nodeKey: string;
    nodeType: string;
    label: string;
    dataJson: unknown;
}
interface GraphEdge {
    sourceKey: string;
    targetKey: string;
    edgeKind: string;
    dataJson: unknown;
}

export interface SyncResult {
    rulesCreated: number;
    chainsLinked: number;
    /** Rules whose sub-flow group membership this save changed (#5477). */
    subFlowMembershipChanged: number;
    /**
     * The rule every rule-owning step is linked to after the sync, by
     * `nodeKey`. The save returns it so the open canvas learns a NEW step's
     * rule at once, rather than on the next reload.
     */
    ruleIdByNodeKey: Record<string, string>;
}

// The display-only keys a save strips live with the client-safe wiring
// constants, so the canvas's version diff strips the same set (#5285).
export { HYDRATED_DISPLAY_KEYS };

interface SavedNodeLike {
    nodeKey: string;
    nodeType: string;
    dataJson?: unknown;
}

/**
 * Prepare a canvas save's nodes before the graph is replaced.
 *
 * ═══ WHY THE RULE LINK IS CARRIED FORWARD ═══
 *
 * `replaceGraph` writes each node's `dataJson` exactly as the browser sent it.
 * The sync that creates a NEW step's rule writes `ruleId` onto the stored node
 * AFTER that, so the open canvas never had it — and the next save, autosave
 * included, sent the step without one, overwrote the stored link, and the sync
 * created ANOTHER draft rule. One step, one save, one more "Canvas rule" on the
 * Rules tab, for as long as the map stayed open.
 *
 * So a rule-owning step that arrives without a `ruleId` keeps the one stored
 * for its `nodeKey`. Only the stored value for the SAME key is ever used, so
 * this cannot attach a step to a rule it was not already linked to; a step
 * that arrives WITH a `ruleId` is left to the sync, which verifies it.
 */
export async function prepareCanvasNodesForSave<T extends SavedNodeLike>(
    db: PrismaTx,
    ctx: RequestContext,
    processMapId: string,
    nodes: T[],
): Promise<T[]> {
    const stored = await db.processNode.findMany({
        where: { processMapId, tenantId: ctx.tenantId, nodeType: { in: [...RULE_OWNING_KINDS] } },
        select: { nodeKey: true, dataJson: true },
    });
    const storedRuleId = new Map<string, string>();
    for (const n of stored) {
        const id = ruleIdOf(n as GraphNode);
        if (id) storedRuleId.set(n.nodeKey, id);
    }
    return nodes.map((n) => {
        const data =
            n.dataJson && typeof n.dataJson === 'object' && !Array.isArray(n.dataJson)
                ? { ...(n.dataJson as Record<string, unknown>) }
                : null;
        if (data) for (const k of HYDRATED_DISPLAY_KEYS) delete data[k];
        if (!RULE_OWNING_KINDS.has(n.nodeType)) {
            return data ? { ...n, dataJson: data } : n;
        }
        const carried = storedRuleId.get(n.nodeKey);
        const hasOwn = data && typeof data.ruleId === 'string';
        if (hasOwn || !carried) return data ? { ...n, dataJson: data } : n;
        return { ...n, dataJson: { ...(data ?? {}), ruleId: carried } };
    });
}

function ruleIdOf(node: GraphNode): string | null {
    const d = node.dataJson as { ruleId?: unknown } | null;
    return d && typeof d === 'object' && typeof d.ruleId === 'string' ? d.ruleId : null;
}

/**
 * Canvas → Rules. Run AFTER the graph is persisted (replaceGraph). Creates a
 * DRAFT stub rule for each action node that lacks one, writes the `ruleId`
 * back onto the node's `dataJson`, then wires chain edges.
 */
export async function syncCanvasToRules(
    db: PrismaTx,
    ctx: RequestContext,
    processMapId: string,
    options: {
        /**
         * The map's group keys BEFORE the save replaced the graph, so a rule
         * whose group was deleted in this save leaves that group (#5477).
         */
        priorGroupKeys?: readonly string[];
    } = {},
): Promise<SyncResult> {
    const nodes = (await db.processNode.findMany({
        where: { processMapId, tenantId: ctx.tenantId, nodeType: { in: [...RULE_OWNING_KINDS] } },
        select: { nodeKey: true, nodeType: true, label: true, dataJson: true },
    })) as GraphNode[];
    const edges = (await db.processEdge.findMany({
        where: {
            processMapId,
            tenantId: ctx.tenantId,
            edgeKind: { in: [CHAIN_EDGE_KIND, PASS_EDGE_KIND, FAIL_EDGE_KIND] },
        },
        select: { sourceKey: true, targetKey: true, edgeKind: true, dataJson: true },
    })) as GraphEdge[];

    // ── Authorization (was entirely absent) ─────────────────────────────
    //
    // `saveProcessMap` gates on `assertCanWrite` (EDITOR), then called this
    // function, which creates and updates AutomationRule rows. Rule authoring
    // through REST requires ADMIN (`assertCanManageAutomation` → canAdmin), so
    // the canvas was a lower-privilege path to the same writes.
    //
    // The escalation was not theoretical. `dataJson.ruleId` is typed
    // `z.unknown()` in ProcessNodeInputSchema and `ruleIdOf` took it at face
    // value — so an EDITOR could craft an action node carrying an ADMIN's rule
    // id, add a chain edge from it, and have the loop below call
    // `AutomationRuleRepository.update` on a rule they cannot otherwise touch.
    //
    // The assert is conditional on the sync actually WRITING. A map with no
    // action nodes and no chain edges mutates no rule, and an EDITOR must stay
    // able to edit a plain document canvas — gating those saves on ADMIN would
    // be a functional regression unrelated to the vulnerability.
    const wouldWrite = nodes.length > 0 || edges.length > 0;
    if (wouldWrite) {
        assertCanManageAutomation(ctx);
    }

    // Claimed rule ids must be REAL and IN-TENANT before they are trusted as
    // chain endpoints. `getById` runs under the tenant-bound client, so a
    // cross-tenant or deleted id resolves to null and is dropped rather than
    // adopted — the repository's `create` writes these as raw FK scalars, and
    // FK checks bypass row security, so an unvalidated id would persist.
    const claimed = nodes.map(ruleIdOf).filter((v): v is string => typeof v === 'string');
    const verified = new Set<string>();
    for (const id of new Set(claimed)) {
        const row = await AutomationRuleRepository.getById(db, ctx, id);
        if (row) verified.add(id);
    }

    const ruleByNodeKey = new Map<string, string>();
    let rulesCreated = 0;

    for (const node of nodes) {
        const existing = ruleIdOf(node);
        if (existing && verified.has(existing)) {
            ruleByNodeKey.set(node.nodeKey, existing);
            continue;
        }
        // Create a stub rule. Default trigger/action are placeholders the
        // user refines via the inspector. NO geometry is written here.
        //
        // The ACTION TYPE comes from the node's KIND (#3541): an `agent` node
        // exists to invoke an agent, so defaulting it to `NOTIFY_USER` would
        // make the operator's first job undoing the default. The fallback is
        // the action stub, so a sixth rule-owning kind added to the set
        // without a stub gets the old behaviour rather than a crash — and the
        // test below asserts the two sets agree, so that fallback is a safety
        // net rather than a silent default.
        const stub = STUB_BY_KIND[node.nodeType] ?? STUB_BY_KIND.action;
        const rule = await AutomationRuleRepository.create(db, ctx, {
            // Named after the step, so the Rules tab says which step it is.
            name: stubRuleName(node),
            // UNSET, not a real event: a placeholder like `RISK_CREATED` read
            // as a choice somebody made, and an enabled stub would have fired
            // on it. Readiness refuses to enable a rule until it is chosen.
            triggerEvent: UNSET_TRIGGER_EVENT,
            actionType: stub.actionType,
            actionConfig: stub.actionConfig,
            status: 'DRAFT',
        });
        rulesCreated++;
        ruleByNodeKey.set(node.nodeKey, rule.id);
        // Write ONLY the ruleId back onto the node (preserve existing dataJson).
        const prev = (node.dataJson && typeof node.dataJson === 'object'
            ? (node.dataJson as Record<string, unknown>)
            : {});
        await db.processNode.updateMany({
            where: { processMapId, tenantId: ctx.tenantId, nodeKey: node.nodeKey },
            data: { dataJson: { ...prev, ruleId: rule.id } },
        });
    }

    // Wire chain topology — pure structure, no node logic copied:
    //   chain-delay     → nextRuleId (+ delay)   [linear next]
    //   condition-pass  → nextRuleId             [branch: filter matched]
    //   condition-fail  → elseRuleId             [branch: filter did not match]
    // The dispatcher (rule-chain-dispatch) evaluates the target rule's filter
    // at run time and follows nextRuleId on match / elseRuleId on miss.
    let chainsLinked = 0;
    for (const edge of edges) {
        const sourceRuleId = ruleByNodeKey.get(edge.sourceKey);
        const targetRuleId = ruleByNodeKey.get(edge.targetKey);
        if (!sourceRuleId || !targetRuleId) continue;
        // Cycle guard — the REST path has run one since Epic 7, the canvas
        // path never did. A canvas is the easiest place to draw a loop, so
        // this was the writer that most needed it.
        await assertNoChainCycle(db, ctx, sourceRuleId, {
            nextRuleId: edge.edgeKind === FAIL_EDGE_KIND ? null : targetRuleId,
            elseRuleId: edge.edgeKind === FAIL_EDGE_KIND ? targetRuleId : null,
        });
        if (edge.edgeKind === FAIL_EDGE_KIND) {
            await AutomationRuleRepository.update(db, ctx, sourceRuleId, {
                elseRuleId: targetRuleId,
            });
        } else {
            const delay =
                edge.edgeKind === CHAIN_EDGE_KIND
                    ? (edge.dataJson as { delayMinutes?: unknown } | null)?.delayMinutes
                    : undefined;
            await AutomationRuleRepository.update(db, ctx, sourceRuleId, {
                nextRuleId: targetRuleId,
                nextRuleDelay: typeof delay === 'number' ? delay : null,
            });
        }
        chainsLinked++;
    }

    // UNLINK what the canvas no longer draws (#5116). The loop above only ever
    // SET a link, so deleting a chain or branch edge left `nextRuleId` /
    // `elseRuleId` in place and the rule kept chaining to a step the canvas
    // showed as disconnected. A link is cleared only when its TARGET is a rule
    // on this canvas: the canvas owns the topology between its own steps,
    // while a link to a rule elsewhere may have been set from the Rules tab
    // and is not this save's to remove.
    const onCanvas = new Set(ruleByNodeKey.values());
    const drawnNext = new Set<string>();
    const drawnElse = new Set<string>();
    for (const edge of edges) {
        const sourceRuleId = ruleByNodeKey.get(edge.sourceKey);
        if (!sourceRuleId || !ruleByNodeKey.get(edge.targetKey)) continue;
        (edge.edgeKind === FAIL_EDGE_KIND ? drawnElse : drawnNext).add(sourceRuleId);
    }
    let chainsUnlinked = 0;
    if (onCanvas.size > 0) {
        const current = await db.automationRule.findMany({
            where: { id: { in: [...onCanvas] }, tenantId: ctx.tenantId },
            select: { id: true, nextRuleId: true, elseRuleId: true },
        });
        for (const rule of current) {
            const clearNext = !drawnNext.has(rule.id) && rule.nextRuleId !== null && onCanvas.has(rule.nextRuleId);
            const clearElse = !drawnElse.has(rule.id) && rule.elseRuleId !== null && onCanvas.has(rule.elseRuleId);
            if (!clearNext && !clearElse) continue;
            await AutomationRuleRepository.update(db, ctx, rule.id, {
                ...(clearNext ? { nextRuleId: null, nextRuleDelay: null } : {}),
                ...(clearElse ? { elseRuleId: null } : {}),
            });
            chainsUnlinked++;
        }
    }

    // Sub-flow group membership (#5477): a rule belongs to the group its step
    // is nested in. Written after the chain wiring so it sees every rule this
    // save linked, and gated by the same `assertCanManageAutomation` inside.
    const membershipChanged = await reconcileSubFlowMembership(
        db,
        ctx,
        processMapId,
        ruleByNodeKey,
        options.priorGroupKeys ?? [],
    );
    const subFlowMembershipChanged = membershipChanged.length;

    // Audit the RULE writes specifically. `saveProcessMap` already emits a
    // ProcessMap/UPDATE row, but it carries no rule ids — so a chain rewire
    // through the canvas left no trace naming which automation rules changed,
    // which is exactly what a reviewer would need. Emitted only when something
    // was written, so a read-only save stays quiet.
    if (rulesCreated > 0 || chainsLinked > 0 || chainsUnlinked > 0 || subFlowMembershipChanged > 0) {
        await logEvent(db, ctx, {
            action: 'AUTOMATION_RULES_SYNCED_FROM_CANVAS',
            entityType: 'ProcessMap',
            entityId: processMapId,
            details: `Canvas sync wrote ${rulesCreated} rule(s), ${chainsLinked} chain link(s), removed ${chainsUnlinked} and changed ${subFlowMembershipChanged} sub-flow membership(s)`,
            detailsJson: {
                category: 'relationship',
                entityName: 'ProcessMap',
                operation: 'updated',
                rulesCreated,
                chainsLinked,
                chainsUnlinked,
                subFlowMembershipChanged,
                ruleIds: Array.from(new Set([...ruleByNodeKey.values(), ...membershipChanged])),
            },
        });
    }

    return {
        rulesCreated,
        chainsLinked,
        subFlowMembershipChanged,
        ruleIdByNodeKey: Object.fromEntries(ruleByNodeKey),
    };
}

export interface HydratedNode extends GraphNode {
    /** Display-only enrichment merged from the live rule (not persisted). */
    dataJson: Record<string, unknown>;
}

/**
 * Rules → Canvas. Run on LOAD. For each action node with a ruleId, merge the
 * live rule's status + executionCount + a derived subtitle into the node's
 * dataJson for DISPLAY. This is read-only enrichment — never persisted.
 */
export async function hydrateCanvasFromRules<T extends GraphNode>(
    db: PrismaTx,
    ctx: RequestContext,
    nodes: T[],
): Promise<Array<T & { dataJson: Record<string, unknown> }>> {
    const ruleIds = nodes
        .filter((n) => RULE_OWNING_KINDS.has(n.nodeType))
        .map((n) => ruleIdOf(n))
        .filter((id): id is string => !!id);

    const rules =
        ruleIds.length > 0
            ? await db.automationRule.findMany({
                  where: { id: { in: ruleIds }, tenantId: ctx.tenantId },
                  select: {
                      id: true,
                      status: true,
                      executionCount: true,
                      triggerEvent: true,
                      actionType: true,
                  },
              })
            : [];
    const ruleById = new Map(rules.map((r) => [r.id, r]));

    return nodes.map((n) => {
        const base = (n.dataJson && typeof n.dataJson === 'object'
            ? (n.dataJson as Record<string, unknown>)
            : {}) as Record<string, unknown>;
        const id = ruleIdOf(n);
        const rule = id ? ruleById.get(id) : undefined;
        if (!rule) return { ...n, dataJson: base };
        return {
            ...n,
            dataJson: {
                ...base,
                ruleStatus: rule.status,
                executionCount: rule.executionCount,
                ruleSubtitle: `${rule.triggerEvent} · ${rule.actionType}`,
            },
        };
    });
}
