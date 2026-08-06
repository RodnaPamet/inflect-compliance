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
        objective: template.objective,
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
