/**
 * The named refusals a template install can get (#4735).
 *
 * Each travels in `error.details.reason`, beside an English `error.message`.
 * The template library words a known reason from
 * `frameworks.templates.refused.<reason>`, so the reader is not shown the
 * server's English sentence.
 *
 * Client-safe: no server imports, so the page can read the reasons.
 */

export const FRAMEWORK_TEMPLATE_REFUSALS = [
    /** A template code names no template in the catalogue. */
    'TEMPLATE_NOT_FOUND',
    /** A bulk install named no template. */
    'NO_TEMPLATE_CHOSEN',
    /** A bulk install named more templates than one batch takes. */
    'TOO_MANY_TEMPLATES',
] as const;

export type FrameworkTemplateRefusal = (typeof FRAMEWORK_TEMPLATE_REFUSALS)[number];

const KNOWN: ReadonlySet<string> = new Set<string>(FRAMEWORK_TEMPLATE_REFUSALS);

/** The named reason in a parsed API error body, or null when it names none of these. */
export function frameworkTemplateRefusal(body: unknown): FrameworkTemplateRefusal | null {
    const reason = (body as { error?: { details?: { reason?: unknown } } } | null)?.error
        ?.details?.reason;
    return typeof reason === 'string' && KNOWN.has(reason) ? (reason as FrameworkTemplateRefusal) : null;
}
