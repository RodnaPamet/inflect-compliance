/**
 * Framework-aware policy templates — control-link SUGGESTIONS.
 *
 * A policy template is generic markdown until it's connected to the
 * controls it satisfies. This module resolves a curated mapping
 * (prisma/fixtures/policy-template-framework-map.json) of
 * ciso-toolkit policy → framework requirement against the tenant's
 * INSTALLED frameworks, and surfaces the tenant Controls that cover
 * those requirements as SUGGESTED `PolicyControlLink` targets.
 *
 * Two load-bearing honesty constraints (see the implementation note):
 *   1. The mappings are SUGGESTIONS the tenant reviews + confirms,
 *      never an authoritative compliance attestation. Provenance is
 *      surfaced per suggestion: `from_toolkit` (traceable to a NIST-CSF
 *      ref the toolkit lists, crosswalked to ISO/NIS2) vs `curated`
 *      (our domain judgment).
 *   2. Linking is EXPLICIT. `createPolicyFromTemplate` never creates a
 *      `PolicyControlLink` — the only write path is `linkPolicyControls`,
 *      driven by an explicit tenant confirm. A compliance product must
 *      not silently assert that a policy satisfies a control.
 *
 * Attribution: mappings derived in part from ciso-toolkit (MIT) —
 * see prisma/fixtures/policy-templates-ciso-toolkit.LICENSE.md.
 */
import { RequestContext } from '../types';
import { assertCanRead, assertCanWrite } from '../policies/common';
import { logEvent } from '../events/audit';
import { PolicyTemplateRepository } from '../repositories/PolicyTemplateRepository';
import { runInTenantContext } from '@/lib/db-context';
import { bumpTenantCacheVersion } from '@/lib/cache/list-cache';
import { notFound, badRequest } from '@/lib/errors/types';
// Curated mapping fixture is the source of truth (mirrors seed-time
// fixture loading); bundled at build via resolveJsonModule.
import mappingFixture from '../../../prisma/fixtures/policy-template-framework-map.json';

// ─── Fixture types + access ───

export type MappingProvenance = 'from_toolkit' | 'curated';

interface MappingEntry {
    code: string;
    provenance: MappingProvenance;
}
interface PolicyMapping {
    iso27001?: MappingEntry[];
    nis2?: MappingEntry[];
}
interface MappingFixture {
    _meta: Record<string, unknown>;
    mappings: Record<string, PolicyMapping>;
}

const FIXTURE = mappingFixture as unknown as MappingFixture;

/**
 * Fixture grouping key (matches the framework `tags`) → the real
 * `Framework.key` seeded in the DB. The prompt's example used lowercase
 * keys; the seeded frameworks are uppercase (`ISO27001`, `NIS2`).
 */
const FRAMEWORK_KEY_MAP: Record<string, string> = {
    iso27001: 'ISO27001',
    nis2: 'NIS2',
};

/** Display labels for the picker badge, keyed by real Framework.key. */
export const FRAMEWORK_LABELS: Record<string, string> = {
    ISO27001: 'ISO 27001',
    NIS2: 'NIS2',
};

export function getTemplateMapping(externalRef: string | null | undefined): PolicyMapping | null {
    if (!externalRef) return null;
    return FIXTURE.mappings[externalRef] ?? null;
}

/** Real Framework.keys this template carries a mapping for (regardless of install state). */
export function getMappedFrameworkKeys(externalRef: string | null | undefined): string[] {
    const m = getTemplateMapping(externalRef);
    if (!m) return [];
    const keys: string[] = [];
    if (m.iso27001?.length) keys.push(FRAMEWORK_KEY_MAP.iso27001);
    if (m.nis2?.length) keys.push(FRAMEWORK_KEY_MAP.nis2);
    return keys;
}

/** Resolve a template's stable upstream externalRef (e.g. "POL-02") by id. */
export async function getTemplateExternalRef(
    ctx: RequestContext,
    templateId: string,
): Promise<string | null> {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const t = await PolicyTemplateRepository.getById(db, templateId);
        return t?.externalRef ?? null;
    });
}

// ─── Suggestion resolution ───

export interface SuggestedControl {
    controlId: string;
    controlName: string;
    controlCode: string | null;
    /** The mapped requirements this control covers (the reason it's suggested). */
    requirements: { code: string; title: string; provenance: MappingProvenance }[];
    /** from_toolkit if ANY covering mapping is from_toolkit, else curated. */
    provenance: MappingProvenance;
    /** UI pre-checks from_toolkit suggestions; curated start unchecked. */
    preChecked: boolean;
}
export interface SuggestedFrameworkGroup {
    frameworkKey: string;
    frameworkLabel: string;
    suggestions: SuggestedControl[];
}
export interface SuggestionResult {
    templateExternalRef: string;
    frameworks: SuggestedFrameworkGroup[];
    totalSuggested: number;
}

/**
 * Resolve the curated mapping for `templateExternalRef` against the
 * tenant's installed frameworks. Only frameworks the tenant has
 * actually installed (≥1 control linked to one of their requirements)
 * produce suggestions — a tenant with ISO 27001 but not NIS2 sees only
 * ISO suggestions.
 */
export async function getSuggestedControlLinks(
    ctx: RequestContext,
    templateExternalRef: string,
): Promise<SuggestionResult> {
    assertCanRead(ctx);

    const mapping = getTemplateMapping(templateExternalRef);
    if (!mapping) {
        return { templateExternalRef, frameworks: [], totalSuggested: 0 };
    }

    // Build (frameworkKey, code) → provenance lookup across both frameworks.
    const provByFwCode = new Map<string, MappingProvenance>();
    const allCodes: string[] = [];
    const candidateFwKeys: string[] = [];
    for (const [grp, fwKey] of Object.entries(FRAMEWORK_KEY_MAP)) {
        const entries = mapping[grp as keyof PolicyMapping];
        if (!entries?.length) continue;
        candidateFwKeys.push(fwKey);
        for (const e of entries) {
            provByFwCode.set(`${fwKey}::${e.code}`, e.provenance);
            allCodes.push(e.code);
        }
    }
    if (!candidateFwKeys.length) {
        return { templateExternalRef, frameworks: [], totalSuggested: 0 };
    }

    return runInTenantContext(ctx, async (db) => {
        // Which candidate frameworks does the tenant actually have installed?
        const installed = await db.framework.findMany({
            where: {
                key: { in: candidateFwKeys },
                requirements: { some: { controlLinks: { some: { tenantId: ctx.tenantId } } } },
            },
            select: { key: true, name: true },
        });
        if (!installed.length) {
            return { templateExternalRef, frameworks: [], totalSuggested: 0 };
        }
        const installedKeys = new Set(installed.map((f) => f.key));

        // Mapped requirements within the installed frameworks (bounded by mapping size).
        const reqRows = await db.frameworkRequirement.findMany({
            where: {
                framework: { key: { in: [...installedKeys] } },
                code: { in: allCodes },
            },
            select: { id: true, code: true, title: true, framework: { select: { key: true } } },
        });
        if (!reqRows.length) {
            return { templateExternalRef, frameworks: [], totalSuggested: 0 };
        }
        const reqById = new Map(reqRows.map((r) => [r.id, r]));

        // Tenant controls covering those requirements → the link candidates.
        const links = await db.controlRequirementLink.findMany({
            where: { tenantId: ctx.tenantId, requirementId: { in: reqRows.map((r) => r.id) } },
            select: {
                requirementId: true,
                control: { select: { id: true, name: true, code: true } },
            },
            take: 1000,
        });

        // Group by framework → control, accumulating covered requirements + provenance.
        const groups = new Map<string, Map<string, SuggestedControl>>();
        for (const link of links) {
            const req = reqById.get(link.requirementId);
            if (!req) continue;
            const fwKey = req.framework.key;
            const provenance = provByFwCode.get(`${fwKey}::${req.code}`);
            if (!provenance) continue; // requirement not in this template's mapping

            let byControl = groups.get(fwKey);
            if (!byControl) {
                byControl = new Map();
                groups.set(fwKey, byControl);
            }
            let sc = byControl.get(link.control.id);
            if (!sc) {
                sc = {
                    controlId: link.control.id,
                    controlName: link.control.name,
                    controlCode: link.control.code,
                    requirements: [],
                    provenance: 'curated',
                    preChecked: false,
                };
                byControl.set(link.control.id, sc);
            }
            sc.requirements.push({ code: req.code, title: req.title, provenance });
            if (provenance === 'from_toolkit') {
                sc.provenance = 'from_toolkit';
                sc.preChecked = true;
            }
        }

        let total = 0;
        const frameworks: SuggestedFrameworkGroup[] = [];
        for (const f of installed) {
            const byControl = groups.get(f.key);
            if (!byControl || !byControl.size) continue;
            const suggestions = [...byControl.values()].sort(
                (a, b) => (a.controlCode ?? a.controlName).localeCompare(b.controlCode ?? b.controlName),
            );
            for (const s of suggestions) {
                s.requirements.sort((a, b) => a.code.localeCompare(b.code));
            }
            total += suggestions.length;
            frameworks.push({
                frameworkKey: f.key,
                frameworkLabel: FRAMEWORK_LABELS[f.key] ?? f.name,
                suggestions,
            });
        }

        return { templateExternalRef, frameworks, totalSuggested: total };
    });
}

/**
 * Per-template badge metadata for the picker: the installed frameworks
 * this template would pre-map to. Empty if the template is not
 * framework-aware OR the tenant has none of its frameworks installed.
 */
export async function getInstalledMappedFrameworks(
    ctx: RequestContext,
    externalRefs: (string | null | undefined)[],
): Promise<Record<string, string[]>> {
    assertCanRead(ctx);

    // Union of all framework keys any of these templates map to.
    const candidate = new Set<string>();
    for (const ref of externalRefs) {
        for (const k of getMappedFrameworkKeys(ref)) candidate.add(k);
    }
    if (!candidate.size) return {};

    const installedKeys = await runInTenantContext(ctx, async (db) => {
        const installed = await db.framework.findMany({
            where: {
                key: { in: [...candidate] },
                requirements: { some: { controlLinks: { some: { tenantId: ctx.tenantId } } } },
            },
            select: { key: true },
        });
        return new Set(installed.map((f) => f.key));
    });

    const out: Record<string, string[]> = {};
    for (const ref of externalRefs) {
        if (!ref) continue;
        const mapped = getMappedFrameworkKeys(ref).filter((k) => installedKeys.has(k));
        if (mapped.length) out[ref] = mapped;
    }
    return out;
}

// ─── Explicit confirm-and-link (the ONLY PolicyControlLink write path from templates) ───

export interface LinkPolicyControlsResult {
    policyId: string;
    created: number;
    linkedControlIds: string[];
    alreadyLinked: string[];
}

/**
 * Create `PolicyControlLink` rows for an explicit, tenant-confirmed set
 * of controls. Idempotent (skips already-linked controls), validates
 * every control belongs to the tenant, and audits the relationship.
 * This is the explicit confirm path — `createPolicyFromTemplate` never
 * calls it.
 */
export async function linkPolicyControls(
    ctx: RequestContext,
    policyId: string,
    controlIds: string[],
): Promise<LinkPolicyControlsResult> {
    assertCanWrite(ctx);

    const uniqueIds = [...new Set(controlIds)];
    if (!uniqueIds.length) throw badRequest('No controls specified');

    const committed = await runInTenantContext(ctx, async (db) => {
        const policy = await db.policy.findFirst({
            where: { id: policyId, tenantId: ctx.tenantId },
            select: { id: true, title: true },
        });
        if (!policy) throw notFound('Policy not found');

        // Only tenant-owned controls are linkable (defence in depth over RLS).
        const controls = await db.control.findMany({
            where: { id: { in: uniqueIds }, tenantId: ctx.tenantId },
            select: { id: true },
        });
        const validIds = new Set(controls.map((c) => c.id));
        const toLink = uniqueIds.filter((id) => validIds.has(id));
        if (!toLink.length) throw badRequest('No valid controls to link');

        const existing = await db.policyControlLink.findMany({
            where: { policyId, controlId: { in: toLink } },
            select: { controlId: true },
        });
        const existingSet = new Set(existing.map((e) => e.controlId));
        const fresh = toLink.filter((id) => !existingSet.has(id));

        if (fresh.length) {
            await db.policyControlLink.createMany({
                data: fresh.map((controlId) => ({ tenantId: ctx.tenantId, policyId, controlId })),
                skipDuplicates: true,
            });
            await logEvent(db, ctx, {
                action: 'POLICY_CONTROL_LINKED',
                entityType: 'Policy',
                entityId: policyId,
                details: `Linked ${fresh.length} control(s) to policy "${policy.title}"`,
                detailsJson: {
                    category: 'relationship',
                    operation: 'linked',
                    sourceEntity: 'Policy',
                    sourceId: policyId,
                    targetEntity: 'Control',
                    relation: 'LINK',
                    summary: `Linked ${fresh.length} control(s) to policy`,
                },
                metadata: { controlIds: fresh },
            });
        }

        return {
            policyId,
            created: fresh.length,
            linkedControlIds: fresh,
            alreadyLinked: [...existingSet],
        };
    });
    await bumpTenantCacheVersion(ctx.tenantId);
    return committed;
}

export interface UnlinkPolicyControlsResult {
    policyId: string;
    removed: number;
    unlinkedControlIds: string[];
}

/**
 * Unlink one or more controls from a policy (the inverse of
 * `linkPolicyControls`). Idempotent — unlinking a control that isn't linked is
 * a no-op. `PolicyControlLink` is a pure M2M join, so no policy/control row is
 * touched.
 */
export async function unlinkPolicyControls(
    ctx: RequestContext,
    policyId: string,
    controlIds: string[],
): Promise<UnlinkPolicyControlsResult> {
    assertCanWrite(ctx);

    const uniqueIds = [...new Set(controlIds)];
    if (!uniqueIds.length) throw badRequest('No controls specified');

    const committed = await runInTenantContext(ctx, async (db) => {
        const policy = await db.policy.findFirst({
            where: { id: policyId, tenantId: ctx.tenantId },
            select: { id: true, title: true },
        });
        if (!policy) throw notFound('Policy not found');

        const res = await db.policyControlLink.deleteMany({
            where: { tenantId: ctx.tenantId, policyId, controlId: { in: uniqueIds } },
        });

        if (res.count > 0) {
            await logEvent(db, ctx, {
                action: 'POLICY_CONTROL_UNLINKED',
                entityType: 'Policy',
                entityId: policyId,
                details: `Unlinked ${res.count} control(s) from policy "${policy.title}"`,
                detailsJson: {
                    category: 'relationship',
                    operation: 'unlinked',
                    sourceEntity: 'Policy',
                    sourceId: policyId,
                    targetEntity: 'Control',
                    relation: 'UNLINK',
                    summary: `Unlinked ${res.count} control(s) from policy`,
                },
                metadata: { controlIds: uniqueIds },
            });
        }

        return { policyId, removed: res.count, unlinkedControlIds: uniqueIds };
    });
    await bumpTenantCacheVersion(ctx.tenantId);
    return committed;
}
