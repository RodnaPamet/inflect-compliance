/**
 * The categories the evidence forms offer (#5018, owner decision 2026-11-10).
 *
 * `Evidence.category` stays free text: the API accepts any string, rows written
 * before this list keep theirs, and a person may still type a new one. This list
 * is what the forms offer FIRST, so the same kind of evidence stops being filed
 * under several spellings. The stored value is the English name below; it is a
 * data value that the list, the filter and exports show as written, not a label
 * to translate.
 *
 * Client-safe: imported by the evidence forms, so it imports nothing.
 */
export const EVIDENCE_CATEGORY_PRESETS = [
    'Policy or procedure',
    'Configuration or screenshot',
    'Log or report',
    'Contract or agreement',
    'Audit or assessment',
    'Training record',
    'Approval or sign-off',
    'Certificate or attestation',
    'Ticket or change record',
    'Other',
] as const;

/**
 * What a category picker offers: the presets in their order, then every other
 * category the workspace already uses (sorted), then the current value when it
 * is in neither — so editing a row never drops the category it has. Blank and
 * duplicate values (case-insensitive, after trimming) are dropped.
 */
export function evidenceCategoryChoices(
    existing: ReadonlyArray<string | null | undefined>,
    current?: string | null,
): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const add = (raw: string | null | undefined) => {
        const v = (raw ?? '').trim();
        if (!v || seen.has(v.toLowerCase())) return;
        seen.add(v.toLowerCase());
        out.push(v);
    };
    for (const p of EVIDENCE_CATEGORY_PRESETS) add(p);
    for (const e of [...existing].map((x) => (x ?? '').trim()).filter(Boolean).sort((a, b) => a.localeCompare(b))) add(e);
    add(current);
    return out;
}
