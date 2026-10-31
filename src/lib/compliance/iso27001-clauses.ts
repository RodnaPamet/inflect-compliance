/**
 * Which frameworks the ISO 27001 clause tracker (`/clauses`) belongs to.
 *
 * The tracker covers ISO 27001's management-system clauses 4–10, so it is
 * offered from that framework's page and no other (#4738). Both spellings of
 * the key are in use: the seeded catalogue's `ISO27001` and the YAML
 * library's `ISO27001-2022`.
 *
 * Client-safe: no imports.
 */
const ISO27001_FRAMEWORK_KEYS: ReadonlySet<string> = new Set(['ISO27001', 'ISO27001-2022']);

export function frameworkHasClauseTracker(frameworkKey: string): boolean {
    return ISO27001_FRAMEWORK_KEYS.has(frameworkKey);
}
