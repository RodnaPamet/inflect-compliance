/**
 * THE ONE VALUE A DOWNSTREAM PRODUCT CHANGES (T01, #3014).
 *
 * `src/lib/ui-storage.ts` exists so a product that vendors these UI files
 * byte-identical changes one constant instead of carrying a diff at every call
 * site. Two things therefore need holding:
 *
 *   1. the PRODUCED KEYS, because they address data already sitting in real
 *      users' browsers — a changed key is not a migration, it is a silent reset
 *      of everyone's theme, view modes and saved filters;
 *   2. the SHAPE, because the whole point is that changing the prefix changes
 *      every key, and a helper that ignored the prefix would look identical
 *      today and fail the one job it has.
 */
import { UI_STORAGE_PREFIX, uiStorageKey, uiCookieName } from '@/lib/ui-storage';

describe('the keys it produces are the ones already in users browsers', () => {
    it.each([
        [['theme'], 'inflect:theme'],
        [['view-mode'], 'inflect:view-mode'],
        [['nav', 'prev'], 'inflect:nav:prev'],
        [['palette', 'recents'], 'inflect:palette:recents'],
        [['filters', 'acme', 'risks'], 'inflect:filters:acme:risks'],
    ])('uiStorageKey(%j) === %s', (parts, expected) => {
        expect(uiStorageKey(...(parts as string[]))).toBe(expected);
    });

    it('cookie names use "_", because ":" is not valid in an RFC 6265 token', () => {
        expect(uiCookieName('theme')).toBe('inflect_theme');
        expect(uiCookieName('locale')).toBe('inflect_locale');
    });
});

describe('the prefix is actually load-bearing', () => {
    it('every key begins with it — not a coincidence of hard-coded strings', () => {
        // The assertion that would fail on a helper that ignored its own prefix
        // and returned the literals. Without it, every expectation above could
        // be satisfied by `return 'inflect:theme'`.
        expect(uiStorageKey('theme').startsWith(`${UI_STORAGE_PREFIX}:`)).toBe(true);
        expect(uiCookieName('theme').startsWith(`${UI_STORAGE_PREFIX}_`)).toBe(true);
    });

    it('is free of ":" and "=", so cookie names stay valid tokens', () => {
        expect(UI_STORAGE_PREFIX).not.toMatch(/[:=;,\s]/);
    });
});

describe('empty parts are dropped rather than producing an empty slot', () => {
    it('a nullish optional segment does not yield "inflect::theme"', () => {
        // A caller threading an optional segment would otherwise produce a key
        // that READS like the intended one and addresses different storage.
        expect(uiStorageKey('filters', undefined, 'risks')).toBe('inflect:filters:risks');
        expect(uiStorageKey('filters', '', 'risks')).toBe('inflect:filters:risks');
        expect(uiStorageKey('filters', null, 'risks')).toBe('inflect:filters:risks');
    });

    it('with no parts at all it is just the prefix', () => {
        expect(uiStorageKey()).toBe('inflect');
    });
});
