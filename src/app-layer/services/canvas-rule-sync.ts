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
 *     `nextRuleId`/`nextRuleDelay`). It never copies node logic to the rule.
 *   Rules → Canvas (on load): merge each rule's live status + executionCount
 *     + a derived subtitle into the node for DISPLAY only (not persisted).
 */
import type { PrismaTx } from '@/lib/db-context';
import type { RequestContext } from '../types';
import { AutomationRuleRepository } from '../automation';
import { assertCanManageAutomation } from '../automation/policies';
import { assertNoChainCycle } from '../usecases/automation-rules';
import { logEvent } from '../events/audit';

const ACTION_KIND = 'action';
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
): Promise<SyncResult> {
    const nodes = (await db.processNode.findMany({
        where: { processMapId, tenantId: ctx.tenantId, nodeType: ACTION_KIND },
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
        const rule = await AutomationRuleRepository.create(db, ctx, {
            name: `Canvas rule · ${node.nodeKey}`,
            triggerEvent: 'RISK_CREATED',
            actionType: 'NOTIFY_USER',
            actionConfig: { userIds: [], message: '' },
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

    // Audit the RULE writes specifically. `saveProcessMap` already emits a
    // ProcessMap/UPDATE row, but it carries no rule ids — so a chain rewire
    // through the canvas left no trace naming which automation rules changed,
    // which is exactly what a reviewer would need. Emitted only when something
    // was written, so a read-only save stays quiet.
    if (rulesCreated > 0 || chainsLinked > 0) {
        await logEvent(db, ctx, {
            action: 'AUTOMATION_RULES_SYNCED_FROM_CANVAS',
            entityType: 'ProcessMap',
            entityId: processMapId,
            details: `Canvas sync wrote ${rulesCreated} rule(s) and ${chainsLinked} chain link(s)`,
            detailsJson: {
                category: 'relationship',
                entityName: 'ProcessMap',
                operation: 'updated',
                rulesCreated,
                chainsLinked,
                ruleIds: Array.from(new Set(ruleByNodeKey.values())),
            },
        });
    }

    return { rulesCreated, chainsLinked };
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
        .filter((n) => n.nodeType === ACTION_KIND)
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
