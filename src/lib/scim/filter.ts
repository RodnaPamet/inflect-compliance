/**
 * The SCIM `filter` query parameter, as far as this server supports it.
 *
 * One clause, `<attribute> eq "<value>"`, over an allowlist of attributes per
 * resource type. That is the whole of what Entra ID and Okta send for their
 * "does this user / group already exist?" lookups, and it is the only shape
 * we can answer exactly.
 *
 * Anything else is REFUSED with `invalidFilter` (RFC 7644 §3.4.2.2) rather
 * than ignored. Ignoring it returned the whole population for a lookup, and a
 * provisioning client reads "results came back" as "the object exists" — it
 * then patched the first user or group in the list instead of creating the
 * one it meant (#5079, #5208).
 */

export class ScimFilterError extends Error {
    readonly status = 400;
    readonly scimType = 'invalidFilter';
}

export interface ScimEqFilter<A extends string> {
    readonly attribute: A;
    readonly value: string;
}

const EQ_CLAUSE = /^\s*([A-Za-z][A-Za-z0-9.]*)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i;

/**
 * Parse `filter` into one equality clause on an allowed attribute.
 *
 * Returns `null` for an absent or blank filter. Throws `ScimFilterError` for
 * any filter that is not exactly one `eq` on an allowed attribute. Attribute
 * names compare case-insensitively, as RFC 7644 §3.4.2.2 requires, and come
 * back in the allowlist's spelling.
 */
export function parseScimEqFilter<A extends string>(
    filter: string | null | undefined,
    allowed: readonly A[],
): ScimEqFilter<A> | null {
    if (filter === null || filter === undefined || filter.trim() === '') return null;
    const m = EQ_CLAUSE.exec(filter);
    if (!m) {
        throw new ScimFilterError('Only a single `<attribute> eq "<value>"` filter is supported');
    }
    const attribute = allowed.find((a) => a.toLowerCase() === m[1].toLowerCase());
    if (!attribute) {
        throw new ScimFilterError(`Filtering on "${m[1]}" is not supported; supported: ${allowed.join(', ')}`);
    }
    return { attribute, value: m[2].replace(/\\(.)/g, '$1') };
}

/**
 * `startIndex` and `count` as RFC 7644 §3.4.2.4 defines them: a 1-based
 * index below 1 reads as 1, and a negative count as 0. Non-numbers take the
 * defaults. `count` is capped at `max`.
 */
export function scimPage(
    startIndexRaw: string | null,
    countRaw: string | null,
    defaults: { count: number; max: number },
): { startIndex: number; count: number } {
    const s = Number.parseInt(startIndexRaw ?? '', 10);
    const c = Number.parseInt(countRaw ?? '', 10);
    return {
        startIndex: Number.isFinite(s) && s >= 1 ? s : 1,
        count: Math.min(Number.isFinite(c) ? Math.max(c, 0) : defaults.count, defaults.max),
    };
}
