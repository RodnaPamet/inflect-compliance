/**
 * Safe-URL util contract.
 */
import { isSafeHref, normaliseHref, EXTERNAL_LINK_ATTRS } from '@/lib/security/safe-url';

describe('isSafeHref', () => {
    it.each([
        ['https://acme.com', true],
        ['http://acme.com', true],
        ['/t/acme/dashboard', true],
        ['mailto:alice@acme.com', true],
    ])('allows %s', (url, expected) => {
        expect(isSafeHref(url)).toBe(expected);
    });

    it.each([
        'javascript:alert(1)',
        'JavaScript:alert(1)',
        '  javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'vbscript:msgbox("x")',
        'file:///etc/passwd',
    ])('blocks dangerous protocol: %s', (url) => {
        expect(isSafeHref(url)).toBe(false);
    });

    it.each([
        'java\tscript:alert(1)',
        'java\nscript:alert(1)',
        'j\ra\tv\nascript:alert(1)',
        '\u0000javascript:alert(1)',
        '\u0001 javascript:alert(1)',
    ])('blocks a dangerous protocol split by characters a browser drops: %j', (url) => {
        // The URL parser removes tab and newline anywhere, and ignores leading
        // control characters, so each of these opens as `javascript:`.
        expect(isSafeHref(url)).toBe(false);
    });

    it('blocks null / undefined / empty', () => {
        expect(isSafeHref(null)).toBe(false);
        expect(isSafeHref(undefined)).toBe(false);
        expect(isSafeHref('')).toBe(false);
    });
});

describe('normaliseHref', () => {
    it('returns trimmed URL for safe inputs', () => {
        expect(normaliseHref('  https://acme.com  ')).toBe('https://acme.com');
    });

    it('returns null for unsafe inputs', () => {
        expect(normaliseHref('javascript:alert(1)')).toBeNull();
        expect(normaliseHref(null)).toBeNull();
    });
});

describe('EXTERNAL_LINK_ATTRS', () => {
    it('pairs target=_blank with rel="noopener noreferrer"', () => {
        expect(EXTERNAL_LINK_ATTRS).toEqual({
            target: '_blank',
            rel: 'noopener noreferrer',
        });
    });
});
