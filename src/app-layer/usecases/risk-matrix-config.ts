/**
 * Tenant-scoped risk-matrix configuration usecase — Epic 44.
 *
 * The frontend matrix renderer used to bake 5×5 + Low/Medium/High/
 * Critical thresholds inline. This usecase pulls those concerns into
 * a tenant-scoped config — admins can grow / shrink dimensions,
 * relabel axes, and re-band severity without a code change. Tenants
 * that haven't customised resolve to the canonical default in
 * `@/lib/risk-matrix/defaults`.
 *
 * Two functions live here:
 *   - `getRiskMatrixConfig(ctx)` — read-mostly, returns the fully-
 *     populated effective config (DB row merged over the default).
 *     Read access piggybacks on `risks.view`; the matrix shape is
 *     read every time the risks page or a PDF report renders.
 *   - `updateRiskMatrixConfig(ctx, payload)` — admin-only upsert.
 *     Patches over the prior effective config, validates the merged
 *     result, then writes a single row.
 *
 * Why merge-on-write rather than store-the-patch:
 *   - simpler read path (no merge logic per consumer)
 *   - DB row is always self-describing (auditable)
 *   - bands + levelLabels round-trip cleanly without "is this a
 *     partial?" ambiguity
 */

import type { Prisma } from '@prisma/client';

import { runInTenantContext } from '@/lib/db/rls-middleware';
import { assertCanRead } from '@/app-layer/policies/common';
import { forbidden, badRequest } from '@/lib/errors/types';
import { logEvent } from '@/app-layer/events/audit';
import { bumpEntityCacheVersion } from '@/lib/cache/list-cache';
import {
    DEFAULT_RISK_MATRIX_CONFIG,
} from '@/lib/risk-matrix/defaults';
import {
    updateRiskMatrixConfigSchema,
    validateBandsCoverage,
    validateLevelLabelsLength,
    type UpdateRiskMatrixConfigPayload,
} from '@/lib/risk-matrix/schema';
import type {
    RiskMatrixBand,
    RiskMatrixConfigShape,
    RiskMatrixLevelLabels,
} from '@/lib/risk-matrix/types';
import { foldRiskLevelGroups, type RiskLevelsInUse } from '@/lib/risk-matrix/levels-in-use';
import type { RequestContext } from '@/app-layer/types';

// ─── Read ───────────────────────────────────────────────────────────

/**
 * Resolve the effective risk-matrix config for the caller's tenant.
 * Reads the persisted row when present; otherwise returns a fresh
 * copy of `DEFAULT_RISK_MATRIX_CONFIG`. Always returns a fully-
 * populated shape — consumers don't have to handle "no config".
 *
 * Gated by `risks.view` (matches the rest of the risks domain). The
 * matrix shape isn't sensitive on its own; what's gated is the
 * tenant-scoping itself — only callers with risk-domain access read
 * the config of any given tenant.
 */
export async function getRiskMatrixConfig(
    ctx: RequestContext,
): Promise<RiskMatrixConfigShape> {
    assertCanRead(ctx);
    const row = await runInTenantContext(ctx, (db) =>
        db.riskMatrixConfig.findUnique({
            where: { tenantId: ctx.tenantId },
        }),
    );
    if (!row) {
        // Fresh copy so callers can mutate locally without poisoning
        // the module-scope default.
        return cloneConfig(DEFAULT_RISK_MATRIX_CONFIG);
    }
    return rowToShape(row);
}

/**
 * The highest levels the workspace's live risks use, grouped (#4823). The
 * editor reads it to warn before a smaller grid leaves risks with no cell on
 * the heat map. Gated as the config read is: the counts say nothing a
 * `risks.view` holder cannot already see on the Risks page.
 *
 * One `groupBy` over four small integer columns, so the result is bounded by
 * the distinct level combinations (at most 10^4, in practice a few dozen),
 * never by the number of risks.
 */
export async function listRiskLevelsInUse(ctx: RequestContext): Promise<RiskLevelsInUse[]> {
    assertCanRead(ctx);
    const groups = await runInTenantContext(ctx, (db) =>
        db.risk.groupBy({
            by: ['likelihood', 'impact', 'residualLikelihood', 'residualImpact'],
            where: { tenantId: ctx.tenantId, deletedAt: null },
            _count: { _all: true },
        }),
    );
    return foldRiskLevelGroups(
        groups.map((g) => ({
            likelihood: g.likelihood,
            impact: g.impact,
            residualLikelihood: g.residualLikelihood,
            residualImpact: g.residualImpact,
            count: g._count._all,
        })),
    );
}

// ─── Update ─────────────────────────────────────────────────────────

/**
 * Admin-only upsert of a tenant's risk-matrix config. Every patch is
 * merged over the current effective shape, validated end-to-end
 * (per-field via Zod, then cross-field for band coverage + label
 * lengths), and written as a single row.
 *
 * Returns the new effective config so the caller can render the
 * post-update view without an extra GET round-trip.
 *
 * ## Concurrency caveat
 *
 * No optimistic-concurrency control today (no `If-Match` header /
 * `version` column). Two admins editing the same tenant's config
 * simultaneously will both succeed and the second write silently
 * overwrites the first. Acceptable while admin-concurrency is rare;
 * a follow-up should add ETag-based `If-Match` once the admin UI
 * grows beyond a single editor pane.
 */
export async function updateRiskMatrixConfig(
    ctx: RequestContext,
    payload: UpdateRiskMatrixConfigPayload,
): Promise<RiskMatrixConfigShape> {
    if (!ctx.appPermissions.admin.manage) {
        throw forbidden(
            'admin.manage permission is required to edit the risk matrix config.',
        );
    }
    const parsed = updateRiskMatrixConfigSchema.parse(payload);
    const current = await getRiskMatrixConfig(ctx);
    const merged = mergePatch(current, parsed);

    // Cross-field invariants. We run these on the MERGED shape so a
    // caller patching just `bands` against a previously-customised
    // dimension doesn't false-pass with the default.
    const issues = [
        ...validateLevelLabelsLength({
            levelLabels: merged.levelLabels,
            likelihoodLevels: merged.likelihoodLevels,
            impactLevels: merged.impactLevels,
        }),
        ...validateBandsCoverage(
            merged.bands,
            merged.likelihoodLevels * merged.impactLevels,
        ),
    ];
    if (issues.length > 0) {
        throw badRequest(issues.join(' '), {
            code: 'INVALID_RISK_MATRIX_CONFIG',
            issues,
        });
    }

    const saved = await runInTenantContext(ctx, async (db) => {
        const existing = await db.riskMatrixConfig.findUnique({
            where: { tenantId: ctx.tenantId },
        });
        // Prisma's generated `Json` input type is the structural
        // `InputJsonValue`, not our domain-typed shape. Funnelling the
        // cast through one place keeps the rest of the usecase honest.
        const labelsJson = merged.levelLabels as unknown as Prisma.InputJsonValue;
        const bandsJson = merged.bands as unknown as Prisma.InputJsonValue;
        const row = existing
            ? await db.riskMatrixConfig.update({
                  where: { tenantId: ctx.tenantId },
                  data: {
                      likelihoodLevels: merged.likelihoodLevels,
                      impactLevels: merged.impactLevels,
                      axisLikelihoodLabel: merged.axisLikelihoodLabel,
                      axisImpactLabel: merged.axisImpactLabel,
                      levelLabels: labelsJson,
                      bands: bandsJson,
                  },
              })
            : await db.riskMatrixConfig.create({
                  data: {
                      tenantId: ctx.tenantId,
                      likelihoodLevels: merged.likelihoodLevels,
                      impactLevels: merged.impactLevels,
                      axisLikelihoodLabel: merged.axisLikelihoodLabel,
                      axisImpactLabel: merged.axisImpactLabel,
                      levelLabels: labelsJson,
                      bands: bandsJson,
                  },
              });
        // Audit row in the same transaction as the upsert. logEvent
        // failure must not bounce the write — swallow inside the catch.
        await logEvent(db, ctx, {
            action: 'risk_matrix_config.updated',
            entityType: 'TENANT',
            entityId: ctx.tenantId,
            details: 'Risk matrix configuration updated.',
            detailsJson: {
                likelihoodLevels: merged.likelihoodLevels,
                impactLevels: merged.impactLevels,
                bandCount: merged.bands.length,
                customLevelLabels: !!merged.levelLabels,
            },
        }).catch(() => undefined);
        return row;
    });

    // The /risks page SSR-caches its payload (risks + matrixConfig) per
    // tenant for a short TTL (`cachedSsrPayload`, route 'risks'). Saving the
    // matrix config here MUST invalidate it, or the live matrix keeps
    // rendering the STALE axis labels / bands until the TTL lapses — the
    // "custom axis title doesn't propagate to /risks" bug the E2E caught.
    // `bumpEntityCacheVersion` bumps the tenant-wide SSR version, orphaning
    // the cached payload so the next /risks render recomputes with the new
    // config. (Uses the 'risk' entity — any entity bumps the tenant version.)
    await bumpEntityCacheVersion(ctx, 'risk');

    return rowToShape(saved);
}

// ─── Helpers ────────────────────────────────────────────────────────

interface RawRow {
    likelihoodLevels: number;
    impactLevels: number;
    axisLikelihoodLabel: string;
    axisImpactLabel: string;
    levelLabels: unknown;
    bands: unknown;
}

function rowToShape(row: RawRow): RiskMatrixConfigShape {
    const levelLabels = row.levelLabels as RiskMatrixLevelLabels | null;
    const bandsRaw = row.bands as RiskMatrixBand[] | null;
    return {
        likelihoodLevels: row.likelihoodLevels,
        impactLevels: row.impactLevels,
        axisLikelihoodLabel: row.axisLikelihoodLabel,
        axisImpactLabel: row.axisImpactLabel,
        levelLabels:
            levelLabels && Array.isArray(levelLabels.likelihood) && Array.isArray(levelLabels.impact)
                ? levelLabels
                : DEFAULT_RISK_MATRIX_CONFIG.levelLabels,
        bands:
            bandsRaw && bandsRaw.length > 0
                ? bandsRaw
                : DEFAULT_RISK_MATRIX_CONFIG.bands.map((b) => ({ ...b })),
    };
}

function cloneConfig(c: RiskMatrixConfigShape): RiskMatrixConfigShape {
    return {
        likelihoodLevels: c.likelihoodLevels,
        impactLevels: c.impactLevels,
        axisLikelihoodLabel: c.axisLikelihoodLabel,
        axisImpactLabel: c.axisImpactLabel,
        levelLabels: {
            likelihood: [...c.levelLabels.likelihood],
            impact: [...c.levelLabels.impact],
        },
        bands: c.bands.map((b) => ({ ...b })),
    };
}

function mergePatch(
    base: RiskMatrixConfigShape,
    patch: UpdateRiskMatrixConfigPayload,
): RiskMatrixConfigShape {
    return {
        likelihoodLevels: patch.likelihoodLevels ?? base.likelihoodLevels,
        impactLevels: patch.impactLevels ?? base.impactLevels,
        axisLikelihoodLabel:
            patch.axisLikelihoodLabel ?? base.axisLikelihoodLabel,
        axisImpactLabel: patch.axisImpactLabel ?? base.axisImpactLabel,
        levelLabels:
            patch.levelLabels === undefined
                ? base.levelLabels
                : patch.levelLabels === null
                  ? base.levelLabels
                  : {
                        likelihood: [...patch.levelLabels.likelihood],
                        impact: [...patch.levelLabels.impact],
                    },
        bands:
            patch.bands !== undefined
                ? patch.bands.map((b) => ({ ...b }))
                : base.bands.map((b) => ({ ...b })),
    };
}
