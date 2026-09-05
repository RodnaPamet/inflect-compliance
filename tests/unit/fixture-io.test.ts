/**
 * The checked-read helpers turn a silent, distant failure into a located one.
 *
 * Each case here is a shape a real fixture actually took on 2026-09-05, when
 * three reshapes in a row broke the seed through `as` casts that kept
 * compiling. The value being tested is not the throw — it is the MESSAGE: a
 * cast fails somewhere else as something else, and these have to say which
 * file and what was wrong.
 */
import { fixtureArray, fixtureObject } from '../../prisma/fixture-io';

describe('fixtureArray', () => {
    it('passes an array straight through', () => {
        expect(fixtureArray<number>('f.json', [1, 2, 3])).toEqual([1, 2, 3]);
    });

    it('names the file and the actual shape when an array became an object', () => {
        // THE SOC 2 FAILURE. `soc2-control-templates.json` became
        // `{ framework, requirements, templates, pack }` and the consumer's
        // `as Array<...>` still compiled; `for...of` threw forty lines into
        // the seed, which died and reported success.
        expect(() =>
            fixtureArray('fixtures/soc2-control-templates.json', {
                framework: {},
                requirements: [],
                templates: [],
                pack: {},
            }),
        ).toThrow(/soc2-control-templates\.json: expected a JSON array, got an object with keys \[framework/);
    });

    it('reports null distinctly from an object', () => {
        // `typeof null === 'object'` is the classic way a shape check reports
        // the wrong thing, and a null fixture means something different from a
        // reshaped one.
        expect(() => fixtureArray('f.json', null)).toThrow(/got null/);
    });

    it('says how many elements an unexpected array holds', () => {
        expect(() => fixtureObject('f.json', [1, 2])).toThrow(/got an array of 2/);
    });
});

describe('fixtureObject', () => {
    it('passes an object carrying its keys straight through', () => {
        const v = fixtureObject<{ templates: number[] }>('f.json', { templates: [1] }, 'templates');
        expect(v.templates).toEqual([1]);
    });

    it('names the missing key AND what the file actually holds', () => {
        // A renamed key is the quiet version: the object is still an object,
        // so a shape-only check passes and the caller reads undefined.
        expect(() =>
            fixtureObject(
                'fixtures/policy-templates-imported.json',
                { source: 'x', items: [] },
                'templates',
            ),
        ).toThrow(
            /policy-templates-imported\.json: object is missing required key\(s\) \[templates\].*keys \[source, items\]/,
        );
    });

    it('lists every missing key at once, not just the first', () => {
        // Reporting one at a time turns a single fix into three round trips
        // through a slow seed run.
        expect(() => fixtureObject('f.json', {}, 'a', 'b', 'c')).toThrow(/\[a, b, c\]/);
    });

    it('accepts a key whose value is null — present is present', () => {
        // `'k' in obj` deliberately, not a truthiness check: a fixture may
        // legitimately carry an explicit null, and rejecting it would fail on
        // valid data, which is worse than the bug being prevented.
        expect(() => fixtureObject('f.json', { k: null }, 'k')).not.toThrow();
    });
});
