/**
 * A workflow definition may only read run inputs it declared (#3650).
 *
 * `workflows/required-input.ts` said a definition reading a key it never
 * declared is "a bug in the definition, not in the request", and named
 * `tests/guards/workflow-required-input-is-declared.test.ts` as "what actually
 * prevents that mismatch from shipping". That file has never existed, so the
 * mismatch was prevented by nothing: `requiredString` throws at RUNTIME, inside
 * a run, after the operator has started it.
 *
 * `requiredInput` is checked at ADMISSION (`workflow-runs.ts` refuses a run
 * whose caller omitted a declared key), so a key that is read but not declared
 * is the one combination admission cannot catch: the run is admitted and then
 * dies on the read. This closes that gap at CI time instead.
 *
 * WHY A STATIC CHECK AND NOT A TYPE. `ctx.input` is a bag of unknowns by
 * construction — the whole reason `requiredString` exists is to narrow one key
 * out of it with an explicit throw. A type cannot relate the string literal
 * passed to `requiredString` to the string literals in a sibling array
 * property, so the relationship is only checkable by reading the source.
 *
 * @see https://github.com/RodnaPamet/inflect-compliance/issues/3650
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { repoFiles } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');

/** Keys read out of `ctx.input` through the narrowing helpers. */
const READS = /\brequired(?:String|Number|Boolean)\s*\(\s*ctx\s*,\s*'([^']+)'/g;
/** The `requiredInput: [...]` declaration, as its raw array text. */
const DECLARES = /requiredInput\s*:\s*\[([^\]]*)\]/;

interface Definition {
    readonly file: string;
    readonly reads: string[];
    readonly declared: string[];
}

function definitions(): Definition[] {
    const out: Definition[] = [];
    for (const abs of repoFiles({ under: 'src/lib/agentic/workflows', extensions: ['.ts'] })) {
        const code = codeOf(fs.readFileSync(abs, 'utf-8'));
        const reads = [...new Set(Array.from(code.matchAll(READS), (m) => m[1]!))];
        if (reads.length === 0) continue;
        const declaredText = DECLARES.exec(code)?.[1] ?? '';
        const declared = Array.from(declaredText.matchAll(/'([^']+)'/g), (m) => m[1]!);
        out.push({
            file: path.relative(ROOT, abs).split(path.sep).join('/'),
            reads,
            declared,
        });
    }
    return out;
}

describe('a workflow reads only the input it declared (#3650)', () => {
    it('finds definitions that read input at all', () => {
        // The population, asserted. Two definitions read `frameworkKey` today;
        // if this drops to zero the rule below is decoration, and the most
        // likely cause is a rename of the helper rather than a real change.
        const defs = definitions();
        expect(defs.length).toBeGreaterThanOrEqual(2);
        expect(defs.every((d) => d.reads.length > 0)).toBe(true);
    });

    it('every key a definition reads is declared in its requiredInput', () => {
        const undeclared = definitions().flatMap((d) =>
            d.reads.filter((k) => !d.declared.includes(k)).map((k) => `${d.file} reads ${k}`),
        );
        // If this fires: add the key to that definition's `requiredInput`, so a
        // run missing it is refused at admission rather than thrown out of
        // mid-flight.
        expect(undeclared).toEqual([]);
    });

    it('catches an undeclared read, and does not flag a declared one', () => {
        // The control, driving the real regexes over synthetic sources. Without
        // it a pair of regexes that matched nothing would agree with each other
        // and with no source file anywhere.
        const bad = "requiredString(ctx, 'tenantKey');\nrequiredInput: ['frameworkKey'],";
        const badReads = Array.from(bad.matchAll(READS), (m) => m[1]);
        const badDeclared = Array.from(
            (DECLARES.exec(bad)?.[1] ?? '').matchAll(/'([^']+)'/g),
            (m) => m[1],
        );
        expect(badReads).toEqual(['tenantKey']);
        expect(badDeclared).toEqual(['frameworkKey']);
        expect(badReads.filter((k) => !badDeclared.includes(k!))).toEqual(['tenantKey']);

        const good = "requiredString(ctx, 'frameworkKey');\nrequiredInput: ['frameworkKey'],";
        const goodReads = Array.from(good.matchAll(READS), (m) => m[1]);
        const goodDeclared = Array.from(
            (DECLARES.exec(good)?.[1] ?? '').matchAll(/'([^']+)'/g),
            (m) => m[1],
        );
        expect(goodReads.filter((k) => !goodDeclared.includes(k!))).toEqual([]);

        // A read inside a comment must not count — the helper's own docblock
        // shows the call shape it replaced.
        expect(Array.from(codeOf("// requiredString(ctx, 'ghost')").matchAll(READS))).toEqual([]);
    });
});
