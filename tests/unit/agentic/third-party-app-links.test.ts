/**
 * The vendor-console links on the Integrations tab
 * (`src/lib/agentic/third-party-app-links.ts`).
 *
 *   1. EACH PRODUCT builds the link its console answers at.
 *   2. EVERY MALFORMED PART yields no link — never a guessed or partial URL.
 *   3. A PROPERTY: whatever the input, every URL produced is https on one of
 *      the allowed hosts, with nothing before the host.
 */
import fc from 'fast-check';

import { isAllowedThirdPartyLinkHost, thirdPartyAppLinks } from '@/lib/agentic/third-party-app-links';

const DIR = '0d1e2c3b-0000-4000-8000-000000003686';
const SP = 'a0000006-0000-4000-8000-000000000001';
const APP = 'e0000006-0000-4000-8000-000000000001';
const NONE = { manageUrl: null, aboutUrl: null };

const links = (applicationId: string, publisherAppId: string | null = null, publisherAppSlug: string | null = null) =>
    thirdPartyAppLinks({ applicationId, publisherAppId, publisherAppSlug });

describe('1. each product', () => {
    it('GitHub: the organisation\'s installation settings, and the app\'s public page by slug', () => {
        expect(links('github:acme:installation:41', '9001', 'acme-deploy-bot')).toEqual({
            manageUrl: 'https://github.com/organizations/acme/settings/installations/41',
            aboutUrl: 'https://github.com/apps/acme-deploy-bot',
        });
    });

    it('GitHub without a slug: the installation link only', () => {
        expect(links('github:acme:installation:41', '9001', null)).toEqual({
            manageUrl: 'https://github.com/organizations/acme/settings/installations/41',
            aboutUrl: null,
        });
    });

    it('Entra: the enterprise application\'s properties blade, by object id and application id', () => {
        expect(links(`entra:${DIR}:sp:${SP}`, APP)).toEqual({
            manageUrl:
                'https://entra.microsoft.com/#view/Microsoft_AAD_IAM/ManagedAppMenuBlade/~/Properties'
                + `/objectId/${SP}/appId/${APP}`,
            aboutUrl: null,
        });
    });

    it('Okta: the org\'s admin console application list, on the -admin host', () => {
        expect(links('okta:acme.okta.com:app:0oa1abcdEFGH23ijk456', '0oa1abcdEFGH23ijk456')).toEqual({
            manageUrl: 'https://acme-admin.okta.com/admin/apps/active',
            aboutUrl: null,
        });
        expect(links('okta:acme.oktapreview.com:app:0oa1', '0oa1').manageUrl).toBe(
            'https://acme-admin.oktapreview.com/admin/apps/active',
        );
    });
});

describe('2. every malformed part yields no link', () => {
    it.each([
        ['an empty id', ''],
        ['an unknown product', 'slack:acme:app:1'],
        ['a GitHub webhook, not an installation', 'github:acme:hook:7'],
        ['a GitHub organisation with an upper-case letter', 'github:Acme:installation:41'],
        ['a GitHub organisation starting with a hyphen', 'github:-acme:installation:41'],
        ['a GitHub organisation of 40 characters', `github:${'a'.repeat(40)}:installation:41`],
        ['a GitHub organisation with a slash', 'github:acme/evil:installation:41'],
        ['a GitHub installation id with a leading zero', 'github:acme:installation:041'],
        ['a GitHub installation id of 21 digits', `github:acme:installation:${'1'.repeat(21)}`],
        ['a GitHub installation id that is not digits', 'github:acme:installation:41a'],
        ['a GitHub id with a trailing path', 'github:acme:installation:41/../../x'],
        ['an Entra id with an upper-case GUID', `entra:${DIR}:sp:${SP.toUpperCase()}`],
        ['an Entra id with a bad directory', `entra:not-a-guid:sp:${SP}`],
        ['an Entra id with a trailing segment', `entra:${DIR}:sp:${SP}:x`],
        ['an Okta host off Okta\'s domains', 'okta:acme.example.com:app:0oa1'],
        ['an Okta host that only ends like Okta', 'okta:evil.com.okta.com.example:app:0oa1'],
        ['an Okta host with an upper-case letter', 'okta:Acme.okta.com:app:0oa1'],
        ['an Okta host with a port', 'okta:acme.okta.com:443:app:0oa1'],
        ['an Okta host that is only the domain', 'okta:okta.com:app:0oa1'],
        ['an Okta app id with punctuation', 'okta:acme.okta.com:app:0oa-1'],
        ['an Okta first label too long for -admin', `okta:${'a'.repeat(60)}.okta.com:app:0oa1`],
        ['leading whitespace', ' github:acme:installation:41'],
        ['a trailing newline', 'github:acme:installation:41\n'],
    ])('%s', (_what, applicationId) => {
        expect(links(applicationId, APP, 'acme-deploy-bot')).toEqual(NONE);
    });

    it.each([
        ['no application id', null],
        ['an upper-case GUID', APP.toUpperCase()],
        ['a GUID with braces', `{${APP}}`],
        ['a GUID with a trailing path', `${APP}/x`],
        ['not a GUID', 'not-a-guid'],
    ])('Entra with %s: no link, rather than a blade that will not open', (_what, publisherAppId) => {
        expect(links(`entra:${DIR}:sp:${SP}`, publisherAppId)).toEqual(NONE);
    });

    it.each([
        ['an upper-case letter', 'Acme-deploy-bot'],
        ['a slash', 'acme/evil'],
        ['a leading hyphen', '-acme'],
        ['a dot', 'acme.bot'],
        ['an empty slug', ''],
        ['101 characters', 'a'.repeat(101)],
        ['a query', 'acme?x=1'],
    ])('a GitHub slug with %s builds no about link, and keeps the manage link', (_what, slug) => {
        expect(links('github:acme:installation:41', '9001', slug)).toEqual({
            manageUrl: 'https://github.com/organizations/acme/settings/installations/41',
            aboutUrl: null,
        });
    });
});

describe('3. property: every URL produced is https on an allowed host', () => {
    const check = (url: string | null) => {
        if (url === null) return;
        const parsed = new URL(url);
        expect(parsed.protocol).toBe('https:');
        expect(parsed.username).toBe('');
        expect(parsed.password).toBe('');
        expect(parsed.port).toBe('');
        expect(isAllowedThirdPartyLinkHost(parsed.hostname)).toBe(true);
        // The URL is exactly what was built: no parser normalisation moved a part.
        expect(parsed.href).toBe(url);
    };

    const part = fc.oneof(
        fc.string(),
        fc.stringMatching(/^[a-z0-9.-]{1,70}$/),
        fc.constantFrom('acme', 'acme.okta.com', 'a.b.oktapreview.com', DIR, SP, APP, '41', '0oa1', 'x/../y', '@evil.com', '#', '?'),
    );
    const applicationId = fc.oneof(
        fc.string(),
        fc.tuple(part, part).map(([o, i]) => `github:${o}:installation:${i}`),
        fc.tuple(part, part).map(([d, o]) => `entra:${d}:sp:${o}`),
        fc.tuple(part, part).map(([h, i]) => `okta:${h}:app:${i}`),
    );

    it('holds for arbitrary ids, publisher ids and slugs', () => {
        fc.assert(
            fc.property(applicationId, fc.option(part, { nil: null }), fc.option(part, { nil: null }), (id, appId, slug) => {
                const out = thirdPartyAppLinks({ applicationId: id, publisherAppId: appId, publisherAppSlug: slug });
                check(out.manageUrl);
                check(out.aboutUrl);
            }),
            { numRuns: 2000 },
        );
    });

    it('holds for the well-formed cases, which do produce URLs', () => {
        for (const out of [
            links('github:acme:installation:41', '9001', 'acme-deploy-bot'),
            links(`entra:${DIR}:sp:${SP}`, APP),
            links('okta:acme.okta.com:app:0oa1', '0oa1'),
            links('okta:a.b.oktapreview.com:app:0oa1', '0oa1'),
        ]) {
            expect(out.manageUrl).not.toBeNull();
            check(out.manageUrl);
            check(out.aboutUrl);
        }
    });

    it('the allowed-host list admits nothing else', () => {
        for (const host of ['evil.com', 'github.com.evil.com', 'entra.microsoft.com.evil', 'acme.okta.com', 'okta.com', '-admin.okta.com', 'acme-admin.okta.com.evil.com']) {
            expect(isAllowedThirdPartyLinkHost(host)).toBe(false);
        }
    });
});
