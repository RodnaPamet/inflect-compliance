/**
 * Behavioural tests for `tests/helpers/source-blocks.ts`.
 *
 * The helpers are the shared bounding layer under ~24 call sites in
 * `tests/guards` / `tests/guardrails`, so a hole in them is a hole in every
 * guard that stands on them — and it is a hole of the *silent* kind: a wrong
 * extraction makes `expect(block).not.toMatch(…)` pass vacuously and the
 * guard stays green while checking nothing.
 *
 * That is not hypothetical, and it bit TWICE, one step apart:
 *
 *   1. The first `callExpressionOf()` skipped comments while scanning
 *      FORWARD but located its ANCHOR with a plain `src.search(…)` on the raw
 *      source, so a comment mentioning the call ahead of the real one
 *      anchored the whole extraction inside the comment.
 *   2. With the anchor fixed, the RETURN was still `src.slice(…)` — raw text,
 *      comments included — so a stale comment left inside the extracted
 *      callback satisfied the positive assertion instead.
 *
 * Both were measured: `tests/guards/p-polish-d.test.ts` stayed 20/20 GREEN
 * with the poll interval inverted to `runFetch(false)`, once per defect. The
 * two describes below are one per half — the anchor reads code, and so does
 * the result — plus the deliberate exception (string literals survive,
 * because a guard asserting `'/api/health'` is still in an array is asserting
 * about code).
 */

import {
    braceBlockAfter,
    callExpressionOf,
    codeOf,
    declarationOf,
    functionBodyOf,
    interfaceBodyOf,
} from '../helpers/source-blocks';

describe('source-blocks — the anchor reads CODE, not prose', () => {
    it('callExpressionOf skips a comment that mentions the callee', () => {
        const src = [
            '// Historical note: this used to read',
            '//   setInterval(() => { void runFetch(true); }, pollMs)',
            '// before the cadence was made configurable.',
            'timer = setInterval(() => {',
            '    void runFetch(false);',
            '}, pollMs);',
        ].join('\n');

        const call = callExpressionOf(src, 'setInterval');
        expect(call).toContain('runFetch(false)');
        expect(call).not.toContain('runFetch(true)');
    });

    it('callExpressionOf skips a string literal that mentions the callee', () => {
        const src = [
            'const doc = "call setInterval(cb, ms) to poll";',
            'setInterval(() => run(1), 30);',
        ].join('\n');

        expect(callExpressionOf(src, 'setInterval')).toBe(
            'setInterval(() => run(1), 30)',
        );
    });

    it('callExpressionOf still ignores a bare mention in a type position', () => {
        const src = [
            'let timer: ReturnType<typeof setInterval> | null = null;',
            'timer = setInterval(tick, 30);',
        ].join('\n');

        expect(callExpressionOf(src, 'setInterval')).toBe('setInterval(tick, 30)');
    });

    it('declarationOf skips a comment that mentions the declaration', () => {
        const src = [
            '// const target = legacyThing();',
            'const target = realThing();',
        ].join('\n');

        expect(declarationOf(src, 'target')).toBe('const target = realThing();');
    });

    it('declarationOf is not truncated by a semicolon inside a comment', () => {
        const src = [
            'const target = compute(',
            '    // a; semicolon in prose',
            '    input,',
            ');',
        ].join('\n');

        const decl = declarationOf(src, 'target');
        expect(decl).toContain('input,');
        expect(decl.endsWith(');')).toBe(true);
    });

    it('functionBodyOf skips a comment that mentions the function', () => {
        const src = [
            '/** Superseded: export async function handler() { legacy(); } */',
            'export async function handler() {',
            '    real();',
            '}',
        ].join('\n');

        const body = functionBodyOf(src, 'handler');
        expect(body).toContain('real();');
        expect(body).not.toContain('legacy();');
    });

    it('interfaceBodyOf skips a comment that mentions the interface', () => {
        const src = [
            '// Was: export interface TenantControlOption { status: string | null }',
            'export interface TenantControlOption {',
            '    id: string;',
            '}',
        ].join('\n');

        const body = interfaceBodyOf(src, 'Tenant\\w+Option');
        expect(body).toContain('id: string;');
        expect(body).not.toContain('status: string | null');
    });

    it('interfaceBodyOf stops at the interface’s own closing brace', () => {
        // The shape the lazy `[\s\S]*?` span in p-polish-d could not see:
        // the field is gone from the option type and present on a LATER one.
        const src = [
            'export interface TenantControlOption {',
            '    id: string;',
            '}',
            '',
            'interface TenantControlsState {',
            '    status: string | null;',
            '}',
        ].join('\n');

        const body = interfaceBodyOf(src, 'Tenant\\w+Option');
        expect(body).toContain('id: string;');
        expect(body).not.toContain('status: string | null;');
    });

    it('interfaceBodyOf is not closed early by a brace in a method signature', () => {
        const src = [
            'export interface Shape {',
            '    fn(o: { a: string }): void;',
            '    tail: number;',
            '}',
        ].join('\n');

        expect(interfaceBodyOf(src, 'Shape')).toContain('tail: number;');
    });
});

/**
 * The second half, and the reason the extractors do the masking themselves
 * instead of documenting `codeOf(...)` as a call-site duty: an extractor that
 * returns raw text is correct only while every caller remembers, which is the
 * same shape as the bug. Each case below is the exact mutation a reviewer
 * used to keep a guard green — a plausible refactor that leaves a stale
 * comment describing the behaviour it just inverted.
 */
describe('source-blocks — the RESULT is code, so prose cannot satisfy an assertion', () => {
    it('callExpressionOf: a stale comment inside the callback does not stand in for the call', () => {
        const src = [
            'const POLL_REVALIDATES = false;',
            'timer = setInterval(() => {',
            '    // Poll revalidation — equivalent to runFetch(true): keeps',
            '    // the last-good options on a transient blip.',
            '    void runFetch(POLL_REVALIDATES);',
            '}, pollMs);',
        ].join('\n');

        const call = callExpressionOf(src, 'setInterval');
        // The assertion p-polish-d makes. Green against raw text; red here.
        expect(call).not.toMatch(/runFetch\(true\)/);
        expect(call).toContain('runFetch(POLL_REVALIDATES)');
    });

    it('declarationOf: a comment inside the declaration is blanked', () => {
        const src = [
            'const query = build({',
            '    // tenantId: ctx.tenantId,  ← removed, the caller scopes it now',
            '    id,',
            '});',
        ].join('\n');

        const decl = declarationOf(src, 'query');
        expect(decl).not.toMatch(/tenantId:/);
        expect(decl).toContain('id,');
    });

    it('functionBodyOf: a comment naming the gate is not the gate', () => {
        const src = [
            'export async function bulkDelete(ctx) {',
            '    // assertCanAdmin(ctx) is applied by the route wrapper now.',
            '    return repo.deleteMany(ctx);',
            '}',
        ].join('\n');

        const body = functionBodyOf(src, 'bulkDelete');
        expect(body).not.toMatch(/assertCanAdmin\(/);
        expect(body).toContain('repo.deleteMany(ctx)');
    });

    it('interfaceBodyOf: a field promised in a docblock is not a field', () => {
        const src = [
            'export interface TenantControlOption {',
            '    id: string;',
            '    /** Carries status: string | null through from the API row. */',
            '    label: string;',
            '}',
        ].join('\n');

        const body = interfaceBodyOf(src, 'Tenant\\w+Option');
        expect(body).not.toMatch(/status:\s*string \| null/);
        expect(body).toContain('label: string;');
    });

    it('STRING LITERALS SURVIVE — a guard asserting on literal content still works', () => {
        // The deliberate limit of the masking, and why `codeOf` blanks
        // comments only. Blanking literals too would have silently emptied
        // the exclusion-list assertions in
        // tests/guardrails/api-read-rate-limit.test.ts and the `code: '…'`
        // harvest in tests/guardrails/soc2-starter-pack-coverage.test.ts.
        const src = [
            'const EXCLUDED_PATHS = [',
            "    // '/api/docs' — dropped, now throttled",
            "    '/api/health',",
            '];',
        ].join('\n');

        const decl = declarationOf(src, 'EXCLUDED_PATHS');
        expect(decl).toMatch(/'\/api\/health'/);
        expect(decl).not.toMatch(/'\/api\/docs'/);
    });

    it('offsets are preserved, so a block still lines up with codeOf(src)', () => {
        // The extractors slice out of `codeOf(src)`, not `src`. A caller that
        // subtracts one block from the whole file (p-polish-d does, to assert
        // the cold-load flag OUTSIDE the interval) needs that to hold.
        const src = [
            'void runFetch(false);',
            'timer = setInterval(() => {',
            '    void runFetch(true);',
            '}, pollMs);',
        ].join('\n');

        const call = callExpressionOf(src, 'setInterval');
        const code = codeOf(src);
        expect(code).toContain(call);
        expect(code.replace(call, '')).not.toContain('runFetch(true)');
    });
});

describe('source-blocks — codeOf', () => {
    it('blanks comments, KEEPS strings, and preserves length and line count', () => {
        const src = [
            'const a = "status: string | null"; // and: status: string | null',
            'const b = 1;',
        ].join('\n');

        const masked = codeOf(src);
        expect(masked).toHaveLength(src.length);
        expect(masked.split('\n')).toHaveLength(2);
        // The literal survives …
        expect(masked).toContain('"status: string | null"');
        // … the comment does not.
        expect(masked).not.toContain('and:');
        expect(masked).toContain('const b = 1;');
    });

    it('does not treat // inside a string as a comment', () => {
        const src = 'const url = "https://example.test/x"; const kept = 2;';
        expect(codeOf(src)).toContain('const kept = 2;');
        expect(codeOf(src)).toContain('"https://example.test/x"');
    });

    it('is idempotent, so wrapping an already-extracted block is harmless', () => {
        const src = [
            'export async function handler() {',
            '    // legacy();',
            '    real();',
            '}',
        ].join('\n');

        const body = functionBodyOf(src, 'handler');
        expect(codeOf(body)).toBe(body);
    });
});

describe('source-blocks — a missing or unbalanced target fails loudly', () => {
    it('every helper throws when its target is absent rather than returning an empty block', () => {
        expect(() => callExpressionOf('const x = 1;', 'setInterval')).toThrow(
            /call expression not found/,
        );
        expect(() => declarationOf('const x = 1;', 'missing')).toThrow(
            /declaration not found/,
        );
        expect(() => functionBodyOf('const x = 1;', 'missing')).toThrow(
            /function not found/,
        );
        expect(() => interfaceBodyOf('const x = 1;', 'Missing')).toThrow(
            /interface not found/,
        );
    });

    it('an unterminated block throws rather than returning a wrong one', () => {
        expect(() => callExpressionOf('setInterval(cb, 30', 'setInterval')).toThrow(
            /unterminated call expression/,
        );
        expect(() => interfaceBodyOf('interface Shape {', 'Shape')).toThrow(
            /unterminated interface body/,
        );
    });

    it('a target that exists ONLY in a comment throws, rather than returning the comment', () => {
        // The first defect, restated as a contract: not "returns something
        // wrong" but "refuses". A guard whose anchor has been renamed away
        // must go red, not assert against prose.
        expect(() =>
            callExpressionOf('// setInterval(tick, 30);\nconst x = 1;', 'setInterval'),
        ).toThrow(/call expression not found/);
        expect(() =>
            functionBodyOf('/* export function gone() {} */', 'gone'),
        ).toThrow(/function not found/);
    });
});

describe('source-blocks — the anchor is the FIRST match, and that is a limit', () => {
    /**
     * Recorded rather than argued, because the measurement is the point.
     *
     * All five anchors are `maskNonCode(src).search(...)`, so when a file
     * holds TWO constructs matching the anchor, the extraction binds to the
     * EARLIER one and the guard asserts about the wrong construct. That is
     * loud in the ordinary case: an unrelated second construct in front of
     * the intended one does not satisfy the guard's positive assertion, so
     * the guard goes red and a contributor has to look. It is silent only
     * when the decoy ITSELF carries the token being asserted.
     *
     * Measured on the real guard, not inferred from reading it. Against
     * `src/lib/processes/use-tenant-controls.ts` with the real poll inverted
     * to `runFetch(false)`:
     *
     *   • a NEUTRAL second `setInterval` ahead of the poll →
     *     `tests/guards/p-polish-d.test.ts` 1 failed / 19 passed, on the
     *     assertion that names the flag. Loud.
     *   • a second `setInterval` ahead of the poll whose own callback calls
     *     `runFetch(true)` → 20/20 GREEN with the poll inverted. Silent.
     *
     * The silent case needs a diff that adds a whole extra interval AND
     * writes the passing token into it, which is why this is recorded as a
     * bound on the helper rather than fixed by making a second match throw:
     * `declarationOf()` and `braceBlockAfter()` are shared across ~24 call
     * sites, and a repo-wide ambiguity error is a far larger change than the
     * residual justifies. A guard that needs uniqueness should pass a
     * NARROWER anchor — the assignment target, not the bare callee — rather
     * than rely on there being only one match. See #2238.
     */
    const TWO_INTERVALS = [
        'timerA = setInterval(() => {',
        '    void runFetch(true);',
        '}, fast);',
        'timerB = setInterval(() => {',
        '    void runFetch(false);',
        '}, slow);',
    ].join('\n');

    it('callExpressionOf binds to the first matching call, not the last', () => {
        const block = callExpressionOf(TWO_INTERVALS, 'setInterval');

        expect(block).toMatch(/runFetch\(true\)/);
        // The SECOND interval is outside the extraction entirely — the whole
        // hazard, in one assertion.
        expect(block).not.toMatch(/runFetch\(false\)/);
    });

    it('and there is no supported way to reach the SECOND call of a callee', () => {
        // The obvious escape hatch does not exist, which is why the bound
        // above is a bound rather than a style note. `callExpressionOf` takes
        // a bare callee identifier — there is no pattern parameter to narrow
        // with — and `braceBlockAfter` cannot stand in for it: its paren guard
        // deliberately ignores any `{` seen at paren depth > 0, so a callback
        // brace INSIDE `setInterval(...)` is never read as the block's opening
        // brace and the scan runs to EOF.
        //
        // It throws rather than returning a wrong block, so the failure mode
        // is loud. A guard that genuinely needs the second call must either
        // keep one such call per file or grow the helper a narrowing anchor.
        expect(() => braceBlockAfter(TWO_INTERVALS, 'timerB = setInterval')).toThrow(
            /unterminated/,
        );
    });

    it('a narrower anchor DOES work where the block is not inside parens', () => {
        // The same escape hatch on a brace-bounded construct, so the limit
        // above reads as specific to call expressions rather than general.
        const src = [
            'function first() {',
            '    return "a";',
            '}',
            'function second() {',
            '    return "b";',
            '}',
        ].join('\n');

        const block = braceBlockAfter(src, 'function second');

        expect(block).toMatch(/"b"/);
        expect(block).not.toMatch(/"a"/);
    });

    it('declarationOf shares the first-match rule', () => {
        const src = ['const target = { a: 1 };', 'const target = { b: 2 };'].join('\n');

        expect(declarationOf(src, 'target')).toMatch(/a: 1/);
        expect(declarationOf(src, 'target')).not.toMatch(/b: 2/);
    });
});
