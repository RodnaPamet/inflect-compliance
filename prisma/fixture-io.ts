/**
 * Read a vendored fixture and CHECK its top-level shape.
 *
 * ═══ WHY ═══
 *
 * Every seeder read its fixtures like this:
 *
 *     const rows = require('./fixtures/x.json') as Array<{ code: string; … }>;
 *
 * A cast is a claim the compiler stops checking. When a fixture's top-level
 * shape changes — an array becoming an object, most often — the cast still
 * compiles and the failure surfaces later, somewhere else, as something else.
 *
 * That happened three times on 2026-09-05, and every time the visible symptom
 * pointed away from the cause:
 *
 *   • `soc2-control-templates.json` became a CatalogFile. `for...of` threw on
 *     an object forty lines into the seed. The seed died, reported success, and
 *     CI failed on E2E specs for ISO 27001 and AI governance.
 *   • The same for four more fixtures in the next change.
 *   • A too-broad rename made `title` undefined in twelve unrelated loops, and
 *     the seed died again with the same misattribution.
 *
 * ═══ WHAT THIS FIXES, AND WHAT IT DOES NOT ═══
 *
 * It checks the TOP-LEVEL shape — array vs object, and required keys — which is
 * the part that actually changed in all three incidents, and throws at the read
 * site naming the file. A silent TypeError deep in a loop becomes an immediate,
 * located failure.
 *
 * It does NOT validate element types; the callers' `as` on the element shape
 * remains. Writing a schema for all 55 fixture shapes is a larger job, and the
 * element types were never what broke. Where a fixture DOES have a schema —
 * catalog files, authored tasks — use the validating loader instead
 * (`loadAndValidateCatalogFile`, `loadAuthoredControlTasks`), which is stricter
 * than anything here.
 */

/**
 * The label names the fixture WITHOUT its extension, and this adds it back.
 *
 * Not cosmetic. Callers pass the label beside a `require` of the same path, so
 * a label carrying `.json` puts the filename in the source twice — which
 * silently doubles the match count for every existing assertion that greps a
 * seeder for that filename, and an assertion matching two places no longer
 * pins the one it names. The Class D reach ratchet caught exactly that across
 * twelve sites.
 */
function label(name: string): string {
    return name.endsWith('.json') ? name : `${name}.json`;
}

/** Describe what we actually got, for an error message worth reading. */
function describe(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return `an array of ${value.length}`;
    if (typeof value === 'object') {
        const keys = Object.keys(value as object);
        return `an object with keys [${keys.slice(0, 6).join(', ')}${keys.length > 6 ? ', …' : ''}]`;
    }
    return typeof value;
}

/**
 * A fixture that must be a JSON array.
 *
 * @param label  The fixture path, for the error message. Callers pass the same
 *               string they `require`, so a failure names the file to open.
 */
export function fixtureArray<T>(name: string, value: unknown): T[] {
    if (!Array.isArray(value)) {
        throw new Error(
            `${label(name)}: expected a JSON array, got ${describe(value)}. ` +
                `If this fixture was reshaped, its consumer needs updating too — ` +
                `a cast would have compiled and thrown later somewhere else.`,
        );
    }
    return value as T[];
}

/**
 * A fixture that must be a JSON object carrying `keys`.
 *
 * The keys are the ones the caller goes on to read. Checking them here turns
 * "undefined is not iterable" three frames later into a message naming the
 * fixture and the key it lacks.
 */
export function fixtureObject<T>(name: string, value: unknown, ...keys: string[]): T {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label(name)}: expected a JSON object, got ${describe(value)}.`);
    }
    const missing = keys.filter((k) => !(k in (value as Record<string, unknown>)));
    if (missing.length > 0) {
        throw new Error(
            `${label(name)}: object is missing required key(s) [${missing.join(', ')}] — got ${describe(value)}.`,
        );
    }
    return value as T;
}
