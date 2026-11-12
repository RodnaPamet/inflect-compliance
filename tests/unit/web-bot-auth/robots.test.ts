/**
 * Web Bot Auth Phase 2 — robots.txt is read the way RFC 9309 says a crawler
 * reads it (D-L1-6). The cases are the RFC's own rules: group selection by
 * product token, falling back to `*` only when no group names the token;
 * longest match wins; allow wins a tie; wildcards and `$`.
 */
import { robotsAllows } from '@/lib/web-bot-auth/robots';

const TOKEN = 'ExampleBot';

describe('group selection', () => {
    it('obeys the group that names its token, case-insensitively, over the `*` group', () => {
        const txt = 'User-agent: *\nDisallow: /\n\nUser-agent: examplebot\nAllow: /\n';
        expect(robotsAllows(txt, TOKEN, '/')).toBe(true);
        expect(robotsAllows(txt, 'OtherBot', '/')).toBe(false);
    });

    it('falls back to the `*` group when no group names the token', () => {
        expect(robotsAllows('User-agent: *\nDisallow: /\n', TOKEN, '/')).toBe(false);
    });

    it('merges every group that names the token', () => {
        const txt = 'User-agent: ExampleBot\nDisallow: /a\n\nUser-agent: ExampleBot\nDisallow: /\n';
        expect(robotsAllows(txt, TOKEN, '/')).toBe(false);
    });

    it('lets consecutive user-agent lines share one group', () => {
        const txt = 'User-agent: OtherBot\nUser-agent: ExampleBot\nDisallow: /\n';
        expect(robotsAllows(txt, TOKEN, '/')).toBe(false);
    });

    it('allows everything when no group applies, or there is no robots.txt', () => {
        expect(robotsAllows('User-agent: OtherBot\nDisallow: /\n', TOKEN, '/')).toBe(true);
        expect(robotsAllows(null, TOKEN, '/')).toBe(true);
        expect(robotsAllows('', TOKEN, '/')).toBe(true);
    });
});

describe('rule matching', () => {
    it('treats an empty Disallow as no rule', () => {
        expect(robotsAllows('User-agent: *\nDisallow:\n', TOKEN, '/')).toBe(true);
    });

    it('lets the longest match win, and allow win a tie', () => {
        const txt = 'User-agent: *\nDisallow: /\nAllow: /$\n';
        expect(robotsAllows(txt, TOKEN, '/')).toBe(true);
        expect(robotsAllows(txt, TOKEN, '/private')).toBe(false);
        expect(robotsAllows('User-agent: *\nDisallow: /x\nAllow: /x\n', TOKEN, '/x')).toBe(true);
    });

    it('honours `*` and a trailing `$`', () => {
        const txt = 'User-agent: *\nDisallow: /*.pdf$\n';
        expect(robotsAllows(txt, TOKEN, '/a/b.pdf')).toBe(false);
        expect(robotsAllows(txt, TOKEN, '/a/b.pdf?x=1')).toBe(true);
    });

    it('ignores comments, unknown fields and a rule before any group', () => {
        const txt = 'Disallow: /\n# User-agent: *\nCrawl-delay: 10\nSitemap: https://x/s.xml\nUser-agent: * # all\nAllow: /\n';
        expect(robotsAllows(txt, TOKEN, '/')).toBe(true);
    });
});
