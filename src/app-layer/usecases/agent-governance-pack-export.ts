/**
 * #2467 — file the agent-governance pack into the evidence library.
 *
 * The pack has been readable since 4/4 rendered it, and readable is not filed.
 * An assessor's request is not "show me on screen"; it is "give me the document,
 * and show me it was retained". Until this file existed the answer was a
 * screenshot, which is evidence of a screen and not of a register.
 *
 * ── THIS IS DELIBERATELY NOT IDEMPOTENT ────────────────────────────────────
 *
 * `agentic-evidence-emission.ts` identifies an artefact by
 * `(tenant, control, kind, period)` and updates in place, because a monthly
 * receipt artefact is a RECOMPUTATION of one fixed claim about one fixed month:
 * running it twice should not produce two documents.
 *
 * An export is the opposite. It is a snapshot of a moving register at the
 * instant somebody asked for it, and two exports a week apart are two different
 * true documents. Collapsing them onto one row would overwrite a document an
 * assessor may already be holding — destroying the only record of what the
 * workspace looked like when it was handed over. So every export is a new
 * Evidence row, and the generation instant is in the title.
 *
 * ── IT IS ALSO NOT ATTACHED TO A CONTROL ───────────────────────────────────
 *
 * The pack is workspace-wide and discharges no single control, so there is no
 * honest `(control)` to link it to. Creating the link anyway — to whichever
 * control looked closest — would be a fabricated attachment inside the one
 * artefact whose whole value is that it does not fabricate. The record lands in
 * a named folder instead, and the evidence library's existing multi-select
 * already lets the operator link it to the controls THEY say it discharges.
 *
 * ── TWO GATES, BOTH ASSERTED HERE ──────────────────────────────────────────
 *
 * Reading the pack needs `admin.agent_registry`. Writing into the evidence
 * library needs `evidence.edit`, which is the evidence subsystem's own rule and
 * is not mine to route around. Both are asserted UP FRONT rather than left to
 * fire from inside `createEvidence`, so a user with one and not the other is
 * refused before a five-report read runs, with a message naming which
 * permission is missing.
 *
 * ── RETENTION ──────────────────────────────────────────────────────────────
 *
 * `DAYS_AFTER_UPLOAD`, 2555 days ≈ 7 years: the horizon over which an AI
 * governance question can still be asked about a period. Set explicitly rather
 * than inherited, because the library's default is tuned for operational
 * evidence that ages out, and a governance pack that ages out silently is worse
 * than one that was never filed — the absence looks like a retention policy
 * rather than a gap.
 */
import { RetentionPolicy } from '@prisma/client';

import { runInTenantContext } from '@/lib/db-context';
import { logEvent } from '@/app-layer/events/audit';
import { assertCanRead } from '@/app-layer/policies/common';
import { assertCanEditEvidence } from '@/app-layer/policies/evidence.policies';
import { forbidden } from '@/lib/errors/types';
import { bumpEntityCacheVersion } from '@/lib/cache/list-cache';
import {
    packExportTitle,
    renderGovernancePackDocument,
} from '@/lib/agentic/pack-document';
import { buildAgentGovernancePack } from '@/app-layer/usecases/agent-governance-reports';
import { getAgentGovernanceStatus } from '@/app-layer/usecases/agent-registry';
import type { RequestContext } from '@/app-layer/types';

/** ~7 years. See the header. */
export const PACK_RETENTION_DAYS = 2555;

/** Where filed packs land, so a library with thousands of rows still groups. */
export const PACK_EVIDENCE_FOLDER = 'Agent governance';

/**
 * `control-test-runner`'s convention, shared with the agentic artefact emitter
 * so every generated artefact filters together.
 */
export const PACK_EVIDENCE_CATEGORY = 'integration';

export interface PackExportResult {
    readonly evidenceId: string;
    readonly title: string;
    /** The pack's own instant, not the write's. */
    readonly generatedAt: Date;
    /** Carried out so the caller can warn without re-reading the flag. */
    readonly enforcing: boolean;
    readonly retentionUntil: Date | null;
    readonly documentBytes: number;
}

/**
 * Build the pack, render it, and file it.
 *
 * The read is done BEFORE the write and outside it: five reports opening their
 * own tenant transactions inside an evidence-write transaction is a pool
 * exhaustion waiting for the one quarter somebody exports during a busy hour.
 */
export async function exportAgentGovernancePack(
    ctx: RequestContext,
    opts: { windowDays?: number } = {},
): Promise<PackExportResult> {
    // Gate 1 — the same permission that gates reading the pack at all.
    assertCanRead(ctx);
    if (!ctx.appPermissions?.admin?.agent_registry) {
        throw forbidden(
            'You do not have permission to export the agent governance pack. It ' +
                'reports on the agent register, which requires the agent registry ' +
                'permission to read.',
        );
    }
    // Gate 2 — the evidence library's own rule, asserted here so the refusal
    // arrives before the work rather than out of the middle of it.
    assertCanEditEvidence(ctx);

    const [pack, status] = await Promise.all([
        buildAgentGovernancePack(ctx, opts),
        getAgentGovernanceStatus(ctx),
    ]);

    const workspaceName = await runInTenantContext(ctx, async (db) => {
        const tenant = await db.tenant.findFirst({
            where: { id: ctx.tenantId },
            select: { name: true },
        });
        return tenant?.name ?? '';
    });

    const document = renderGovernancePackDocument({
        pack,
        enforcing: status.enforcing,
        unboundCredentials: status.unboundCredentials,
        exportedByUserId: ctx.userId,
        workspaceName,
    });
    const title = packExportTitle(pack.generatedAt);

    const { evidenceId, retentionUntil } = await runInTenantContext(ctx, async (db) => {
        const created = await db.evidence.create({
            data: {
                tenantId: ctx.tenantId,
                type: 'TEXT',
                title,
                content: document,
                category: PACK_EVIDENCE_CATEGORY,
                folder: PACK_EVIDENCE_FOLDER,
                // APPROVED, matching the artefact emitter: this was generated
                // from the record by the platform, so there is no draft state
                // for a person to move it out of.
                status: 'APPROVED',
                ownerUserId: ctx.userId,
                retentionPolicy: RetentionPolicy.DAYS_AFTER_UPLOAD,
                retentionDays: PACK_RETENTION_DAYS,
                // Computed here rather than via a follow-up
                // `updateEvidenceRetention` call: that usecase derives the date
                // from `createdAt`, which does not exist until this insert
                // returns, so the two-step version would either race or need the
                // row read back. One insert, one date, no window where a filed
                // pack has no retention at all.
                retentionUntil: new Date(
                    pack.generatedAt.getTime() + PACK_RETENTION_DAYS * 86_400_000,
                ),
            },
            select: { id: true, retentionUntil: true },
        });

        await logEvent(db, ctx, {
            action: 'AGENT_GOVERNANCE_PACK_EXPORTED',
            entityType: 'Evidence',
            entityId: created.id,
            details: JSON.stringify({
                generatedAt: pack.generatedAt.toISOString(),
                // Recorded because it qualifies every figure in the filed
                // document, and the flag can be flipped afterwards. An audit
                // row saying only "a pack was exported" cannot answer whether
                // the pack meant anything when it was.
                enforcing: status.enforcing,
                unboundCredentials: status.unboundCredentials,
                windowDays: pack.approvals.window?.days ?? null,
                documentBytes: Buffer.byteLength(document, 'utf8'),
                retentionDays: PACK_RETENTION_DAYS,
            }),
        });

        return { evidenceId: created.id, retentionUntil: created.retentionUntil };
    });

    await bumpEntityCacheVersion(ctx, 'evidence');

    return {
        evidenceId,
        title,
        generatedAt: pack.generatedAt,
        enforcing: status.enforcing,
        retentionUntil,
        documentBytes: Buffer.byteLength(document, 'utf8'),
    };
}
