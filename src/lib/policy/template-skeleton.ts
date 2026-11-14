/**
 * Canonical policy-template skeleton + best-effort structured extraction.
 *
 * The ciso-toolkit policies (MIT — see prisma/fixtures/
 * policy-templates-ciso-toolkit.LICENSE.md) share a consistent section
 * skeleton. This module adopts it as IC's canonical policy-template
 * STRUCTURE and extracts the two operationally-useful sections:
 *
 *   - "Document Control" → review cadence (feeds Policy.reviewFrequencyDays)
 *   - "Evidence to Retain" → checklist items (tenant links real Evidence)
 *
 * The skeleton lint is a WARNING, not a hard gate — some policies
 * legitimately omit sections. Parsing is best-effort: a missing or
 * differently-shaped section yields null/[] rather than throwing.
 */

/** The canonical section headings every policy template SHOULD carry, in order. */
export const CANONICAL_POLICY_SECTIONS = [
    'Purpose & Scope',
    'Applicability',
    'References',
    'Roles & RACI',
    'Requirements',
    'Procedures',
    'Evidence to Retain',
    'Exceptions & Deviations',
    'Document Control',
] as const;

export interface SkeletonLintResult {
    present: string[];
    missing: string[];
    /** True when no canonical section is missing. */
    conforms: boolean;
}

/** Lowercased set of all H1–H3 heading texts in the markdown. */
function headingSet(markdown: string): Set<string> {
    const out = new Set<string>();
    for (const m of markdown.matchAll(/^#{1,3}[ \t]+(.+?)[ \t]*$/gm)) {
        out.add(m[1].trim().toLowerCase());
    }
    return out;
}

/**
 * Warning-level skeleton check — reports which canonical sections are
 * present/missing. Never throws; callers decide whether to surface the
 * warning (the 15 imported templates conform; hand-written ones get nudged).
 */
export function lintPolicySkeleton(markdown: string): SkeletonLintResult {
    const headings = headingSet(markdown);
    const present: string[] = [];
    const missing: string[] = [];
    for (const section of CANONICAL_POLICY_SECTIONS) {
        if (headings.has(section.toLowerCase())) present.push(section);
        else missing.push(section);
    }
    return { present, missing, conforms: missing.length === 0 };
}

/** Slice a markdown section body: from its heading to the next same-or-higher heading. */
function sectionBody(markdown: string, heading: string): string | null {
    const re = new RegExp(`^#{1,3}[ \\t]+${heading.replace(/[.*+?^${}()|[\]\\&]/g, '\\$&')}[ \\t]*$`, 'im');
    const m = re.exec(markdown);
    if (!m) return null;
    const start = m.index + m[0].length;
    // Stop at the next H1/H2 heading (sections are H2; sub-parts are H3).
    const rest = markdown.slice(start);
    const next = rest.search(/^#{1,2}[ \t]+\S/m);
    return next >= 0 ? rest.slice(0, next) : rest;
}

/**
 * Best-effort review cadence in DAYS, parsed from the "Document Control"
 * section. Strategy: the gap between the earliest date and the stated
 * "Next Review Date" (the toolkit policies express an annual cadence as a
 * 2024→2025 date pair). Falls back to cadence keywords, then null.
 *
 * Returns days (IC's Policy.reviewFrequencyDays unit), not months — IC
 * already models cadence in days, so we map to the existing field rather
 * than introduce a redundant months column.
 */
/** Snap a raw day-gap to the nearest standard cadence (within ±20 days). */
function snapCadence(days: number): number {
    const standard = [30, 60, 90, 182, 365, 730];
    for (const s of standard) {
        if (Math.abs(days - s) <= 20) return s;
    }
    return days;
}

export function parseReviewCadenceDays(markdown: string): number | null {
    const region = sectionBody(markdown, 'Document Control') ?? markdown;

    const nextRev = region.match(/Next Review Date\**[ \t]*:[ \t]*\**[ \t]*(\d{4}-\d{2}-\d{2})/i)?.[1];
    const dates = [...region.matchAll(/(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]).sort();
    if (nextRev && dates.length) {
        const earliest = Date.parse(`${dates[0]}T00:00:00Z`);
        const next = Date.parse(`${nextRev}T00:00:00Z`);
        if (!Number.isNaN(earliest) && !Number.isNaN(next)) {
            const days = Math.round((next - earliest) / 86_400_000);
            if (days > 0) return snapCadence(days);
        }
    }

    const lc = region.toLowerCase();
    // Six-monthly BEFORE annual: `\bannually\b` matches inside
    // `semi-annually` (the hyphen is a word boundary), so the other order
    // read a six-month cadence as a year (#5316).
    if (/\b(semi-?annual|bi-?annual|every six months)/.test(lc)) return 182;
    if (/\b(annual|annually|yearly|every year)\b/.test(lc)) return 365;
    if (/\bquarterly\b/.test(lc)) return 90;
    if (/\bmonthly\b/.test(lc)) return 30;
    return null;
}

/**
 * Best-effort checklist of evidence-to-retain items, one per bullet under
 * the "Evidence to Retain" section. Each becomes a suggested checklist item
 * the tenant links to a real Evidence record. Deduped + capped.
 */
export function parseEvidenceToRetain(markdown: string): string[] {
    const body = sectionBody(markdown, 'Evidence to Retain');
    if (!body) return [];
    const bullets = [...body.matchAll(/^[ \t]*[-*][ \t]+(.+?)[ \t]*$/gm)].map((m) => m[1].trim());
    return [...new Set(bullets.filter(Boolean))].slice(0, 50);
}
