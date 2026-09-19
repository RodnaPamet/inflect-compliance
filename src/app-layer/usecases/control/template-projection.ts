/**
 * ONE projection from `ControlTemplate` to a `Control`.
 *
 * Two endpoints install control templates, and until 2026-08-06 they
 * produced DIFFERENT controls from the same template:
 *
 *   framework/install.ts  — copied objective / successCriteria /
 *                           testingMethodology and resolved relatedPolicies
 *                           into PolicyControlLink rows.
 *   control/templates.ts  — wrote code/name/category/frequency only.
 *
 * `controls.prisma:194-203` documents the FIRST behaviour as the contract
 * ("Copied onto the Control on install", "resolved to PolicyControlLink
 * per-tenant on install"), so the second was simply wrong — a control
 * installed through POST /controls/templates/install silently lost its
 * objective, success criteria, testing methodology and policy links, and
 * nothing surfaced the difference.
 *
 * Both paths now build their `data` here, so the contract has one
 * implementation. Anything a template should carry onto a control belongs
 * in this file and nowhere else.
 */

/** The template fields the projection reads. Structural, so both callers' row types fit. */
export interface ControlTemplateProjectionSource {
    code: string | null;
    title: string;
    /**
     * Optional because it is a FALLBACK, not a projected field in its own
     * right: `Control` has no `description` column, so this can only ever
     * arrive as an `objective`. See the fallback below.
     */
    description?: string | null;
    category: string | null;
    objective: string | null;
    successCriteria: string | null;
    testingMethodology: string | null;
    defaultFrequency: string | null;
}

/**
 * Build the `Control.create` data for a template install.
 *
 * `isCustom` is a caller decision rather than a template property: a control
 * installed from the shared catalogue is not custom, which is what both
 * paths mean, but the framework wizard historically left it to the column
 * default. Passing it explicitly makes the two paths agree without changing
 * either one's observable behaviour by accident.
 */
export function controlDataFromTemplate(
    template: ControlTemplateProjectionSource,
    ctx: { tenantId: string; userId: string },
    options: { isCustom?: boolean } = {},
) {
    return {
        tenantId: ctx.tenantId,
        code: template.code,
        name: template.title,
        category: template.category,
        // The three internal-controls import fields. These are the ones the
        // thin path dropped; the detail Overview and Tests tabs render them,
        // so their absence looked like an empty template rather than a bug.
        //
        // `?? description` because those three arrived WITH the internal-controls
        // import and the framework catalogues authored in this repo never adopted
        // them: all 473 framework templates carry none, so every control installed
        // from a framework showed "No objective." while its `description` — which
        // is written as exactly such a statement ("Keep one register of every ICT
        // and information asset…") — sat unused, unable to project because
        // `Control` has no column for it. Measured 2026-09-19: 473 of 893
        // production controls had no objective, and every one of them had a
        // template description available. #2664.
        //
        // The fallback direction is deliberate. A template that states a real
        // objective keeps it; only a template with none borrows its description.
        objective: template.objective ?? template.description ?? null,
        successCriteria: template.successCriteria,
        testingMethodology: template.testingMethodology,
        frequency: template.defaultFrequency as never,
        status: 'NOT_STARTED' as const,
        isCustom: options.isCustom ?? false,
        createdByUserId: ctx.userId,
    };
}

/**
 * Resolve a template's pipe-delimited `relatedPolicies` titles to this
 * tenant's policy ids.
 *
 * Titles are matched case-insensitively on trimmed text, and unknown titles
 * are dropped rather than erroring — a shared template names policies that
 * a given tenant may simply not have written yet, and failing the whole
 * install for that would be wrong.
 */
export function resolveRelatedPolicyIds(
    relatedPolicies: string | null,
    policyIdByLowerTitle: Map<string, string>,
): string[] {
    if (!relatedPolicies) return [];
    const ids = relatedPolicies
        .split('|')
        .map((name) => policyIdByLowerTitle.get(name.trim().toLowerCase()))
        .filter((id): id is string => Boolean(id));
    return [...new Set(ids)];
}
