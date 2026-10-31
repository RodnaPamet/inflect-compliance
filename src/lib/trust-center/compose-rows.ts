/**
 * The rows the trust-center compose form publishes (#4824).
 *
 * The form used to drop, without a word, any framework or document row with an
 * empty field, and the server dropped a document whose address was not http(s)
 * the same way: an owner could save, see "saved", and find a row missing from
 * the public page. These rules say which rows are complete, which are left
 * blank (and so are simply not published), and which are half-filled or carry
 * an address the server will refuse, so the form can say so on the row.
 *
 * Pure: the client form and its tests import it.
 */

export interface ComposeFramework {
    key: string;
    statusLabel: string;
    badge?: string;
}

export interface ComposeDocument {
    label: string;
    url: string;
}

/** What is wrong with a row, if anything. A blank row is not wrong: it is not published. */
export type ComposeRowProblem = 'incomplete' | 'badUrl' | null;

const blank = (v: string | undefined) => !v || v.trim() === '';

/** True when the address is an absolute http or https URL, as the server requires. */
export function isPublishableUrl(raw: string): boolean {
    try {
        const u = new URL(raw.trim());
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
}

export function frameworkRowProblem(f: ComposeFramework): ComposeRowProblem {
    if (blank(f.key) && blank(f.statusLabel)) return null;
    return blank(f.key) || blank(f.statusLabel) ? 'incomplete' : null;
}

export function documentRowProblem(d: ComposeDocument): ComposeRowProblem {
    if (blank(d.label) && blank(d.url)) return null;
    if (blank(d.label) || blank(d.url)) return 'incomplete';
    return isPublishableUrl(d.url) ? null : 'badUrl';
}

/** The rows that are published: every row with something in it. Blank rows are left out. */
export function publishedFrameworks(rows: readonly ComposeFramework[]): ComposeFramework[] {
    return rows.filter((f) => !(blank(f.key) && blank(f.statusLabel)));
}

export function publishedDocuments(rows: readonly ComposeDocument[]): ComposeDocument[] {
    return rows.filter((d) => !(blank(d.label) && blank(d.url)));
}
