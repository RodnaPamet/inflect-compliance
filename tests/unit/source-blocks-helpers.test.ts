/**
 * Behavioural tests for `tests/helpers/source-blocks.ts`.
 *
 * The helpers are the shared bounding layer under ~24 call sites in
 * `tests/guards` / `tests/guardrails`, so a hole in them is a hole in every
 * guard that stands on them — and it is a hole of the *silent* kind: a wrong
 * extraction makes `expect(block).not.toMatch(…)` pass vacuously and the
 * guard stays green while checking nothing.
 *
 * That is not hypothetical. The first version of `callExpressionOf()` skipped
 * comments while scanning FORWARD but located its anchor with a plain
 * `src.search(…)` on the RAW source, so a comment mentioning the call ahead
 * of the real one anchored the whole extraction inside the comment.
 * `tests/guards/p-polish-d.test.ts` was measured 20/20 GREEN with the poll
 * interval inverted to `runFetch(false)`, asserting against prose. Each test
 * below fails if that masking is removed again.
 */

import {
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

    it('codeOf blanks comments and strings, preserving length and line count', () => {
        const src = [
            'const a = "status: string | null"; // status: string | null',
            'const b = 1;',
        ].join('\n');

        const masked = codeOf(src);
        expect(masked).toHaveLength(src.length);
        expect(masked.split('\n')).toHaveLength(2);
        expect(masked).not.toContain('status');
        expect(masked).toContain('const a = ');
        expect(masked).toContain('const b = 1;');
    });

    it('codeOf does not treat // inside a string as a comment', () => {
        const src = 'const url = "https://example.test/x"; const kept = 2;';
        expect(codeOf(src)).toContain('const kept = 2;');
    });

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
});
