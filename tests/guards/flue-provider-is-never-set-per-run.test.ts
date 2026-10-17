/**
 * No file under `src/` calls the Flue runtime's `setProvider` (#3650).
 *
 * `flue/model-selection.ts` said it "deliberately does NOT call `setProvider`"
 * and named `tests/guards/flue-provider-registration-is-not-per-run.test.ts` as
 * what "keeps it that way". That file has never existed here.
 *
 * WHY THIS ONE IS THE URGENT MEMBER OF #3650. The hazard is not a style
 * regression. `setProvider` mutates a MODULE-SCOPED SINGLETON, so provider
 * registration is process-wide, and `model-selection.ts` spells out what a
 * per-run call costs in its own words:
 *
 *   "Two concurrent runs in one Node process would race, and the loser executes
 *    against the winner's provider. In a product where `aiResidency: LOCAL_ONLY`
 *    is documented as a HARD invariant, that race is a cross-tenant egress: a
 *    LOCAL_ONLY tenant's reasoning could be streamed to an external endpoint
 *    another tenant registered a millisecond earlier, with nothing in the audit
 *    trail to show it."
 *
 * A residency invariant that a race can defeat is not an invariant, and the
 * only thing standing between that paragraph and a regression was the
 * paragraph.
 *
 * COMMENTS ARE MASKED, and that is load-bearing here rather than hygiene: this
 * guard's own subject file quotes `setProvider()` three times while explaining
 * why it never calls it, and `@flue/runtime`'s own config docblock mentions it
 * too. Scanning raw text would report the explanation as the breach — the "a
 * scar is not a wound" failure.
 *
 * @see https://github.com/RodnaPamet/inflect-compliance/issues/3650
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { repoFiles } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');

/**
 * A CALL to `setProvider`, not a mention of the word.
 *
 * The `\b` before and the `\(` after are both doing work. Without the word
 * boundary this matches `unsetProvider`; without the paren it matches a
 * reference passed as a value. And the negative lookahead on `s` is what keeps
 * `setProviders(...)` out — the React state setter, which appears twice in
 * `src/app/.../admin/` and has nothing to do with the runtime.
 */
const SET_PROVIDER_CALL = /\bsetProvider\s*\(/;

interface Hit {
    readonly file: string;
    readonly line: number;
}

function callSites(): Hit[] {
    const out: Hit[] = [];
    for (const abs of repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] })) {
        const code = codeOf(fs.readFileSync(abs, 'utf-8'));
        code.split('\n').forEach((text, i) => {
            if (SET_PROVIDER_CALL.test(text)) {
                out.push({ file: path.relative(ROOT, abs).split(path.sep).join('/'), line: i + 1 });
            }
        });
    }
    return out;
}

describe('the Flue provider is never set per run (#3650)', () => {
    it('scans a real population of source files', () => {
        // The denominator. A `repoFiles` call that returned nothing would make
        // the assertion below pass over zero files, which is indistinguishable
        // from "no call sites" in its output.
        expect(repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] }).length).toBeGreaterThan(500);
    });

    it('no source file calls setProvider', () => {
        // If this fires: the provider must be registered ONCE at boot
        // (`runtime-bootstrap.ts`), never per run. `resolveFlueModel` returns a
        // specifier for the caller to dispatch with; it does not mutate the
        // registry, and that asymmetry is the fix for the race above.
        expect(callSites()).toEqual([]);
    });

    it('sees a real call, and is not fooled by the React setter or by prose', () => {
        // The control, driving the real regex through the real comment masker.
        expect(SET_PROVIDER_CALL.test('setProvider({ id: "x" });')).toBe(true);
        expect(SET_PROVIDER_CALL.test('  await setProvider(p);')).toBe(true);

        // `setProviders` is the useState setter in two admin pages. A guard that
        // matched it would fail on correct code, which is the fastest way to get
        // a guard deleted.
        expect(SET_PROVIDER_CALL.test('setProviders(data);')).toBe(false);
        expect(SET_PROVIDER_CALL.test('const [providers, setProviders] = useState([]);')).toBe(false);
        expect(SET_PROVIDER_CALL.test('unsetProvider();')).toBe(false);

        // And a mention inside a comment must not count, which is the case this
        // guard's own subject file produces three times over.
        expect(SET_PROVIDER_CALL.test(codeOf('// those with `setProvider()` in app.ts'))).toBe(false);
        expect(SET_PROVIDER_CALL.test(codeOf('/* It deliberately does NOT call setProvider(); */'))).toBe(false);
    });
});
