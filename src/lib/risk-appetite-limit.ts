/**
 * A risk-appetite limit as typed (#4822): empty is "not checked", digits with
 * an optional decimal part are the number, and anything else — a thousands
 * separator, a letter — is refused rather than cast. `Number('1,000,000')` is
 * NaN, which JSON sends as null, so casting used to clear a limit and still say
 * "Saved.". Spaces are allowed and dropped, so "1 000 000" reads as it looks.
 */
export function parseLimit(raw: string): { ok: true; value: number | null } | { ok: false } {
    const s = raw.replace(/\s+/g, '');
    if (s === '') return { ok: true, value: null };
    if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false };
    return { ok: true, value: Number(s) };
}
