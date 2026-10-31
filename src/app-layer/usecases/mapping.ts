import { RequestContext } from '../types';
import { MappingRepository } from '../repositories/MappingRepository';
import { assertCanRead } from '../policies/common';
import {
    getSOC2Requirements,
    getNIS2Requirements,
    getFrameworkMappings as getGuidanceMappings,
} from '@/app-layer/libraries';
import { runInTenantContext } from '@/lib/db-context';
import { isCoverageQualifyingEvidence } from '@/lib/compliance/coverage-evidence';
import { parseIsoClause } from '@/lib/controls/control-taxonomy';
import { isFrameworkInUse } from './framework/coverage';

/**
 * The catalogue keys each estimated framework is stored under: the seeded
 * catalogue's short key and the YAML library's versioned one.
 */
const SOC2_FRAMEWORK_KEYS = ['SOC2', 'SOC2-2017'] as const;
const NIS2_FRAMEWORK_KEYS = ['NIS2', 'NIS2-2022'] as const;

async function anyInUse(ctx: RequestContext, keys: readonly string[]): Promise<boolean> {
    const answers = await Promise.all(keys.map((key) => isFrameworkInUse(ctx, key)));
    return answers.some(Boolean);
}

/**
 * The ISO 27001 Annex A clause a control refers to, or null.
 *
 * One clause has three spellings in this codebase and they never matched:
 * a FrameworkRequirement is coded `5.1`, a ControlTemplate (and so the
 * Control installed from it) is coded `A-5.1`, and the guidance mapping
 * table in `src/data/frameworks.ts` says `A.5.1`. Comparing any two of
 * them directly yields nothing.
 *
 * `annexId` is checked first and `code` second, mirroring
 * `categorizeControl`. The fallback is the load-bearing half: NOTHING
 * populates `annexId` on a control installed from a framework catalogue —
 * `template-projection.ts` writes `code` and never `annexId` — so before
 * this fallback existed the join matched only controls a user had created by
 * hand and typed an annexId into.
 */
function controlIsoClause(control: { annexId?: string | null; code?: string | null }): string | null {
    return parseIsoClause(control.annexId) ?? parseIsoClause(control.code);
}

export async function getFrameworkMappings(ctx: RequestContext) {
    assertCanRead(ctx);

    // Load framework data from YAML-backed provider (with hardcoded fallback)
    const SOC2_REQS = getSOC2Requirements();
    const NIS2_REQS = getNIS2Requirements();
    const MAPPINGS = getGuidanceMappings();

    const readiness = await runInTenantContext(ctx, async (db) => {
        const controls = await MappingRepository.getControlsWithEvidence(db, ctx);

        // Build SOC 2 readiness view
        const soc2Categories = SOC2_REQS.map((req) => {
            const relatedMappings = MAPPINGS.filter((m) => m.soc2Codes.includes(req.code));
            const relatedControls = controls.filter((c) => {
                const clause = controlIsoClause(c);
                return (
                    clause !== null &&
                    relatedMappings.some((m) => parseIsoClause(m.isoControlId) === clause)
                );
            });
            const implemented = relatedControls.filter((c) => c.status === 'IMPLEMENTED').length;
            // Shared coverage definition. A bare status check counted
            // archived / expired / soft-deleted evidence that coverage.ts
            // rejects, so the same control read as covered here and not
            // there.
            const withEvidence = relatedControls.filter((c) =>
                c.evidence.some((e) => isCoverageQualifyingEvidence(e)),
            ).length;
            const total = relatedControls.length;

            return {
                ...req,
                mappings: relatedMappings,
                controlCount: total,
                implementedCount: implemented,
                evidenceCount: withEvidence,
                coverage: total > 0 ? Math.round((implemented / total) * 100) : 0,
            };
        });

        // Build NIS2 readiness view
        const nis2Areas = NIS2_REQS.map((req) => {
            const relatedMappings = MAPPINGS.filter((m) => m.nis2Codes.includes(req.code));
            const relatedControls = controls.filter((c) => {
                const clause = controlIsoClause(c);
                return (
                    clause !== null &&
                    relatedMappings.some((m) => parseIsoClause(m.isoControlId) === clause)
                );
            });
            const implemented = relatedControls.filter((c) => c.status === 'IMPLEMENTED').length;
            // Evidence the same way as the SOC 2 fold (#4737: the page
            // showed neither).
            const withEvidence = relatedControls.filter((c) =>
                c.evidence.some((e) => isCoverageQualifyingEvidence(e)),
            ).length;
            const total = relatedControls.length;

            return {
                ...req,
                mappings: relatedMappings,
                controlCount: total,
                implementedCount: implemented,
                evidenceCount: withEvidence,
                coverage: total > 0 ? Math.round((implemented / total) * 100) : 0,
            };
        });

        return { soc2: soc2Categories, nis2: nis2Areas, mappings: MAPPINGS };
    });

    // Whether the workspace already uses each framework (the Frameworks
    // page's "Installed" rule). The estimate is shown only for a framework
    // that is not in use: once it is, its own page has the real coverage and
    // an estimate beside it would only compete with it.
    const [soc2InUse, nis2InUse] = await Promise.all([
        anyInUse(ctx, SOC2_FRAMEWORK_KEYS),
        anyInUse(ctx, NIS2_FRAMEWORK_KEYS),
    ]);

    return { ...readiness, inUse: { soc2: soc2InUse, nis2: nis2InUse } };
}
