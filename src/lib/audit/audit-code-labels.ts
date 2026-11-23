/**
 * The audit log's codes as words in the reader's language.
 *
 * `AuditLog.action` and `AuditLog.entity` are stored codes (`ACCESS_REVIEW_
 * CLOSED`, `TenantCustomRole`, `RISK`) and stay codes: the row is hash-chained
 * and is never rewritten. A reader is shown a label for each, looked up in the
 * `auditCodes` catalog at display time:
 *
 *   auditCodes.action.<CODE>   — every action the source writes
 *   auditCodes.entity.<key>    — every entity type, keyed by `auditEntityKey`
 *
 * `tests/guards/bulgarian-ui-chrome-sources.test.ts` reads the population off
 * the source (`tests/helpers/audit-code-population.ts`) and fails when a code
 * has no label in either catalog, so a new `logEvent` call cannot reach the
 * page as English words on a Bulgarian screen.
 *
 * A code the catalog does not hold (a row written by a build that has since
 * dropped the code, a computed code) falls back to the caller's composition,
 * and in the end to the code as words.
 *
 * Pure and client-safe.
 */

/** The catalog key of an action code: the code itself, upper-cased. */
export function auditActionKey(action: string): string {
    return action.trim().toUpperCase();
}

/**
 * The catalog key of an entity type. Writers spell one type several ways
 * (`AccessReview`, `ACCESS_REVIEW`), so the key is the words, lower-cased and
 * joined with `_`: both of those are `access_review`.
 */
export function auditEntityKey(entity: string): string {
    return entity
        .trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .split(/[\s_.:/-]+/)
        .filter((w) => w !== '')
        .map((w) => w.toLowerCase())
        .join('_');
}

/** A translator rooted at `auditCodes`, with next-intl's optional `has`. */
export interface AuditCodeTranslator {
    (key: string): string;
    has?: (key: string) => boolean;
}

function lookup(t: AuditCodeTranslator, key: string): string | null {
    return typeof t.has === 'function' && t.has(key) ? t(key) : null;
}

/** The label of an action code, or null when the catalog has none. */
export function auditActionLabel(t: AuditCodeTranslator, action: string): string | null {
    const key = auditActionKey(action);
    return /^[A-Z][A-Z0-9_]*$/.test(key) ? lookup(t, `action.${key}`) : null;
}

/** The label of an entity type, or null when the catalog has none. */
export function auditEntityLabel(t: AuditCodeTranslator, entity: string): string | null {
    const key = auditEntityKey(entity);
    return key === '' ? null : lookup(t, `entity.${key}`);
}
