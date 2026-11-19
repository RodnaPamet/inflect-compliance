/**
 * The live facts a `control` node's card shows: code, name, status,
 * effectiveness and last test, read fresh for each request.
 *
 * ═══ WHY NOTHING IS COPIED ONTO THE CANVAS ═══
 *
 * A control node stores only the link (`ProcessNodeControl.controlId`). The
 * edge-control table copies the control's `label` and so shows a renamed
 * control under its old name; the node card asks here instead, every time the
 * canvas opens, saves or regains focus.
 *
 * ═══ WHY THE CLIENT NAMES THE IDS ═══
 *
 * A link the user has just picked is on the canvas before autosave writes it,
 * and its card should fill in at once. So the request carries the ids on the
 * canvas, scoped to a map the caller can read, and the answer is read under the
 * caller's own tenant: an id that is not this tenant's control comes back as
 * missing, exactly as a deleted one does, and says nothing more about it.
 *
 * ═══ A VIEWER WHO CANNOT SEE CONTROLS ═══
 *
 * Gets `restricted: true` and no facts, rather than a 403. The canvas is
 * readable to them; the cards say "restricted" and show no name. A 403 here
 * would write an AUTHZ_DENIED row every time such a viewer opened a map.
 */
import type { RequestContext } from '../types';
import { assertCanRead } from '../policies/common';
import { canReadControls } from '../policies/control.policies';
import { notFound } from '@/lib/errors/types';
import { runInTenantContext } from '@/lib/db-context';
import {
    MAX_CONTROL_FACT_IDS,
    type ControlFact,
    type ProcessMapControlFacts,
} from '@/lib/processes/control-facts-types';

export async function getProcessMapControlFacts(
    ctx: RequestContext,
    mapId: string,
    ids: readonly string[],
): Promise<ProcessMapControlFacts> {
    assertCanRead(ctx);
    const wanted = Array.from(new Set(ids.filter((id) => id.length > 0))).slice(
        0,
        MAX_CONTROL_FACT_IDS,
    );

    return runInTenantContext(ctx, async (db) => {
        const map = await db.processMap.findFirst({
            where: { id: mapId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true },
        });
        if (!map) throw notFound('Process map not found');

        if (!canReadControls(ctx)) {
            return { restricted: true, controls: {}, missing: [] };
        }
        if (wanted.length === 0) {
            return { restricted: false, controls: {}, missing: [] };
        }

        // Bounded by `wanted` (at most MAX_CONTROL_FACT_IDS). The default read
        // hides a soft-deleted control, so a trashed one reads as missing —
        // which is what the card should say about it.
        const rows = await db.control.findMany({ // guardrail-allow: unbounded
            where: { id: { in: wanted }, tenantId: ctx.tenantId },
            select: {
                id: true,
                code: true,
                name: true,
                status: true,
                effectiveness: true,
                lastTested: true,
            },
        });
        const controls: Record<string, ControlFact> = {};
        for (const r of rows) {
            controls[r.id] = {
                id: r.id,
                code: r.code ?? null,
                name: r.name,
                status: r.status,
                effectiveness: r.effectiveness ?? null,
                lastTested: r.lastTested ? r.lastTested.toISOString() : null,
            };
        }
        return {
            restricted: false,
            controls,
            missing: wanted.filter((id) => !(id in controls)),
        };
    });
}
