/**
 * DN containment for the Active Directory provider.
 *
 * ── WHY THIS IS A SHARED MODULE ─────────────────────────────────────────────
 *
 * These three functions lived inside `writer.ts`, private to it, and guarded
 * the one DN the LEAVER path addresses. The provisioner has DNs too, and one
 * of them was never checked: `assignGroup` passes the caller-supplied
 * `groupId` straight to `c.modify()` as a DN. Every other DN in that file
 * comes from `dnFor()` — a `baseDN`-scoped search, so contained by
 * construction — which is exactly why the exception was easy to miss.
 *
 * Moved rather than copied. A containment test that exists twice is one that
 * gets fixed once: `splitDn`'s escaped-comma handling below is the kind of
 * detail a second implementation reliably gets wrong, and `CN=Smith\, Jane`
 * is an ordinary name, not a corner case.
 *
 * @module integrations/providers/active-directory/dn-containment
 */
/**
 * Split a DN on its RDN separators, respecting backslash escaping.
 *
 * `CN=Smith\, Jane,OU=Staff,DC=corp` is THREE components, not four. A naive
 * `split(',')` on a DN carrying an escaped comma produces fragments that match
 * nothing, which would turn the containment check below into a refusal of a
 * perfectly ordinary account name.
 */
export function splitDn(dn: string): string[] {
    const parts: string[] = [];
    let current = '';
    for (let i = 0; i < dn.length; i += 1) {
        const ch = dn[i];
        if (ch === '\\') {
            current += ch + (dn[i + 1] ?? '');
            i += 1;
            continue;
        }
        if (ch === ',') {
            parts.push(current);
            current = '';
            continue;
        }
        current += ch;
    }
    parts.push(current);
    return parts;
}

/** Lower-case, trim each RDN, drop empties. Enough for a containment test. */
export function normalizeDn(dn: string): string {
    return splitDn(dn)
        .map((part) => part.trim().toLowerCase())
        .filter((part) => part !== '')
        .join(',');
}

/**
 * Whether `dn` names an object strictly beneath `baseDN`.
 *
 * Deliberately a SUFFIX test on normalised components rather than a real DN
 * parse: AD compares DN components case-insensitively and ignores the optional
 * whitespace after a separator, and those two are the whole difference between
 * two spellings of one object. Anything this cannot place confidently reads as
 * "not contained", which is the fail-closed direction — the remedy for a false
 * refusal is a correctly formed `baseDN` on the connection, and the alternative
 * is acting on an object nobody scoped.
 *
 * The base itself returns false. It is a naming context, not a user object, and
 * a disable aimed at it is not a case worth admitting.
 */
export function isUnderBaseDn(dn: string, baseDN: string): boolean {
    const target = normalizeDn(dn);
    const root = normalizeDn(baseDN);
    if (target === '' || root === '') return false;
    return target.endsWith(`,${root}`);
}
