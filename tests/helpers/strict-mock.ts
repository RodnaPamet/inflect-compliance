/**
 * A module mock that fails LOUDLY when the code under test reaches for an
 * export the factory omitted (#2897).
 *
 * ═══ THE FAILURE THIS PREVENTS IS A SILENT `undefined` ═══
 *
 * A `jest.mock` factory that is a SUBSET of the real module does not fail at
 * the mock. The missing export resolves to `undefined`, and what happens next
 * happens somewhere else — so the symptom reads as a defect in the code under
 * test rather than in the fixture. Four of those in one day:
 *
 *   · a `context-system` mock without `SYSTEM_PRINCIPAL` labelled every
 *     scheduled run `manual`, with every assertion still green;
 *   · a registry mock without `register`/`listProviders` failed the suite at
 *     LOAD, which jest reports as `Tests: 0 total` — a line that reads as a
 *     pass to anything counting failures rather than tests.
 *
 * Wrapping the factory's return in this Proxy converts both into an error that
 * names the module and the missing export at the moment of access.
 *
 * ```ts
 * jest.mock('@/lib/audit', () =>
 *     strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
 *         logEvent: jest.fn(),
 *     }),
 * );
 * ```
 *
 * WHY NOT JUST SPREAD `requireActual`. Because that silently runs the real
 * implementation for everything the factory forgot, which is a different bug
 * with the same cause — the test passes while exercising production code it
 * meant to replace. This makes the omission a decision: supply it, or state
 * that the real one is wanted by spreading it explicitly.
 */

/**
 * Keys an ES-module interop layer probes on every import. They must answer
 * quietly: throwing here fails the import itself, before any test runs, and
 * the error would name the interop rather than the omission.
 */
const INTEROP_KEYS = new Set(['__esModule', 'then', 'default', 'constructor', 'prototype']);

export function strictMock<T extends object>(
    moduleId: string,
    actual: T,
    overrides: Partial<T> & Record<string, unknown>,
): T {
    return new Proxy(overrides as T, {
        get(target, prop, receiver) {
            if (typeof prop === 'symbol' || INTEROP_KEYS.has(prop as string)) {
                return Reflect.get(target, prop, receiver);
            }
            if (prop in target) return Reflect.get(target, prop, receiver);
            if (prop in (actual as object)) {
                throw new Error(
                    `The mock for '${moduleId}' omits '${String(prop)}', and the code under ` +
                        `test just reached for it. A subset mock resolves the missing export to ` +
                        `undefined and fails somewhere else, which reads as a defect in the code ` +
                        `rather than in this fixture. Add '${String(prop)}' to the factory, or ` +
                        `spread the real one in deliberately.`,
                );
            }
            return undefined;
        },
        has(target, prop) {
            return prop in target || prop in (actual as object);
        },
        ownKeys(target) {
            return Reflect.ownKeys(target);
        },
    });
}
