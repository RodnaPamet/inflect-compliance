/**
 * The three report templates every tenant is given, and their names in the
 * reader's language.
 *
 * `listTemplates` seeds them lazily as `ReportTemplate` rows with
 * `isSystem: true` and these English names, so the stored name is the
 * product's words, not the tenant's. A page shows a system template still
 * under its stock name in the reader's language (`riskReportTemplates.<type>`);
 * a tenant's own template, or one whose name no longer matches the stock one,
 * is shown as written. Both report pages read the same rows through this, so
 * one template has one name on both (#5924).
 *
 * Client-safe: no server imports.
 */
export const SYSTEM_REPORT_TEMPLATES = [
    { name: 'Portfolio Risk Summary', type: 'PORTFOLIO_SUMMARY', description: 'Executive VaR + top risks + appetite + BIA.' },
    { name: 'Risk Deep Dive', type: 'RISK_DEEP_DIVE', description: 'Single-risk FAIR decomposition + history.' },
    { name: 'Business Impact Analysis', type: 'BIA', description: 'RTO/RPO/MTPD + impact + revenue at risk.' },
] as const;

export type SystemReportTemplateType = (typeof SYSTEM_REPORT_TEMPLATES)[number]['type'];

export interface ReportTemplateLike {
    name: string;
    type: string;
    description?: string | null;
    isSystem?: boolean | null;
}

/** The stock template `tpl` still is, or `null` for a tenant's own or a renamed one. */
export function stockSystemTemplate(tpl: ReportTemplateLike): (typeof SYSTEM_REPORT_TEMPLATES)[number] | null {
    if (!tpl.isSystem) return null;
    return SYSTEM_REPORT_TEMPLATES.find((s) => s.type === tpl.type && s.name === tpl.name) ?? null;
}

/** A translator rooted at `riskReportTemplates`. */
export type ReportTemplateTranslator = (key: string) => string;

/** The name and description to show for `tpl`, in the reader's language where the product wrote them. */
export function reportTemplateText(
    tpl: ReportTemplateLike,
    t: ReportTemplateTranslator,
): { name: string; description: string | null } {
    const stock = stockSystemTemplate(tpl);
    if (!stock) return { name: tpl.name, description: tpl.description ?? null };
    return {
        name: t(`${stock.type}.name`),
        description: tpl.description === stock.description ? t(`${stock.type}.description`) : tpl.description ?? null,
    };
}
