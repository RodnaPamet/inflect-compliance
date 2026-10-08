/**
 * Step 1c: the `legacy-mcp` provider, and the two things that make its
 * configuration a security boundary rather than a form.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TWO PROPERTIES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 1. **The endpoint cannot be a destination we would refuse to dial.** `https:`
 *    only, no literal private, loopback, link-local or metadata address, no
 *    credentials in the URL — settled when the configuration is SAVED, so a bad
 *    endpoint never reaches a row.
 * 2. **The credential cannot be redirected.** Changing the endpoint without
 *    re-entering the token is refused. Without that, an `admin.manage` holder
 *    could point the connection at a host they control and keep the customer's
 *    bearer token — the attack `redirectsStoredCredential` exists to close, which
 *    only covers a field if its rule kind is an ORIGIN kind.
 *
 * The second is the one that needed work beyond adding a rule: `originFieldsFor`
 * filtered on two kinds spelled out inline, beneath a docstring promising a third
 * would be covered automatically. It would not have been.
 */

import { readFileSync } from 'node:fs';

import { codeOf } from '../helpers/source-blocks';
import { repoRelativeFiles } from '../helpers/repo-files';
import {
    CONFIG_FIELD_RULES,
    originFieldsFor,
    redirectsStoredCredential,
    validateProviderConfig,
} from '@/app-layer/integrations/config-schema';
import { LegacyMcpProvider, LEGACY_MCP_PROVIDER_ID } from '@/app-layer/integrations/providers/legacy-mcp';

const P = LEGACY_MCP_PROVIDER_ID;
const GOOD = 'https://legacy-mcp.example.com/rpc';

// ─── Classified, not unclassified ──────────────────────────────────────────

describe('1c — legacy-mcp is classified in CONFIG_FIELD_RULES', () => {
    it('has a rule for every config field it declares', () => {
        // An UNCLASSIFIED provider's configuration passes through
        // `validateProviderConfig` untouched (`if (!rules) return config`), which
        // is the hole the design document names. A provider whose fields are
        // declared but unclassified is the same hole with a form in front of it.
        const rules = CONFIG_FIELD_RULES[P];
        expect(rules).toBeDefined();
        const declared = new LegacyMcpProvider().configSchema.configFields.map((f) => f.key);
        expect(declared.length).toBeGreaterThan(0);
        for (const key of declared) {
            expect({ key, classified: Boolean(rules![key]) }).toEqual({ key, classified: true });
        }
    });

    it('classifies the endpoint as an ORIGIN kind, which is what arms the redirect check', () => {
        expect(CONFIG_FIELD_RULES[P]!.endpointUrl).toEqual({ kind: 'publicOrigin' });
        // The consequence, asserted rather than assumed: being an origin kind is
        // the ONLY thing that puts the field in `originFieldsFor`, and that
        // function is the whole of `redirectsStoredCredential`'s population.
        expect(originFieldsFor(P)).toContain('endpointUrl');
    });

    it('does not classify the display name as an origin — it bears no host', () => {
        expect(CONFIG_FIELD_RULES[P]!.applicationName).toEqual({ kind: 'inert' });
        expect(originFieldsFor(P)).not.toContain('applicationName');
    });

    it('rejects a config field nobody classified', () => {
        expect(() =>
            validateProviderConfig(P, { endpointUrl: GOOD, somethingNew: 'x' })
        ).toThrow(/Unknown configuration field/);
    });
});

// ─── Save-time URL refusals ────────────────────────────────────────────────

describe('1c — the endpoint is refused at save time', () => {
    it('accepts a public https URL', () => {
        expect(() => validateProviderConfig(P, { endpointUrl: GOOD })).not.toThrow();
    });

    it.each([
        ['http://legacy-mcp.example.com/rpc', 'http: is not https'],
        ['https://127.0.0.1/rpc', 'loopback'],
        ['https://localhost/rpc', 'blocked name'],
        ['https://10.0.0.5/rpc', 'private range'],
        ['https://192.168.1.10/rpc', 'private range'],
        ['https://172.16.0.1/rpc', 'private range'],
        ['https://169.254.169.254/latest/meta-data', 'metadata address'],
        ['https://[::1]/rpc', 'IPv6 loopback'],
        ['https://mcp.internal/rpc', 'blocked suffix'],
        ['https://mcp.local/rpc', 'blocked suffix'],
        ['not-a-url', 'malformed'],
    ])('refuses %s (%s)', (url) => {
        expect(() => validateProviderConfig(P, { endpointUrl: url })).toThrow(/Invalid endpointUrl/);
    });

    it('refuses a URL carrying credentials', () => {
        // A URL with userinfo would put a secret in `configJson`, which is NOT
        // encrypted — the token belongs in `secretEncrypted` and nowhere else.
        expect(() =>
            validateProviderConfig(P, { endpointUrl: 'https://user:pw@legacy.example.com/rpc' })
        ).toThrow(/must not carry credentials/);
    });

    it('names the field in the message, so an operator knows which input to fix', () => {
        try {
            validateProviderConfig(P, { endpointUrl: 'http://x.example.com' });
            throw new Error('expected a refusal');
        } catch (e) {
            expect((e as Error).message).toContain('endpointUrl');
        }
    });
});

// ─── The credential cannot be redirected ───────────────────────────────────

describe('1c — a host change cannot inherit the stored token', () => {
    it('refuses an endpoint change', () => {
        const before = { endpointUrl: GOOD };
        const after = { endpointUrl: 'https://attacker.example.net/rpc' };
        expect(redirectsStoredCredential(P, before, after)).toBe('endpointUrl');
    });

    it('allows an unchanged endpoint', () => {
        expect(redirectsStoredCredential(P, { endpointUrl: GOOD }, { endpointUrl: GOOD })).toBeNull();
    });

    it('treats an ABSENT endpoint in the update as unchanged, not as a redirect', () => {
        // An update that omits the field is "leave it alone". Reading that as a
        // redirect would refuse every unrelated configuration edit.
        expect(redirectsStoredCredential(P, { endpointUrl: GOOD }, {})).toBeNull();
    });

    it('ignores case and surrounding whitespace', () => {
        expect(
            redirectsStoredCredential(P, { endpointUrl: GOOD }, { endpointUrl: `  ${GOOD.toUpperCase()}  ` })
        ).toBeNull();
    });

    it('does NOT fire on a display-name change', () => {
        expect(
            redirectsStoredCredential(
                P,
                { endpointUrl: GOOD, applicationName: 'Payroll' },
                { endpointUrl: GOOD, applicationName: 'Payroll (legacy)' }
            )
        ).toBeNull();
    });

    it('the origin-kind set covers publicOrigin — the regression this nearly was', () => {
        // `originFieldsFor` filtered on `vendorOrigin` and `internalOrigin` spelled
        // out inline, under a docstring promising a third kind would be covered the
        // day it was added. Adding `publicOrigin` to the union alone would have
        // left `endpointUrl` OUTSIDE the redirect check — silently, with the
        // comment asserting otherwise. This asserts the behaviour, not the comment.
        expect(originFieldsFor(P)).toEqual(['endpointUrl']);
    });
});

// ─── validateConnection: shape, then a real probe ──────────────────────────

describe('1c — validateConnection', () => {
    const provider = new LegacyMcpProvider();

    it('declares liveValidation honestly', () => {
        // A real handshake and manifest read happen, so `true` is not a claim the
        // implementation fails to honour.
        expect(provider.liveValidation).toBe(true);
    });

    it('requires the URL and the token separately, naming which is missing', () => {
        return Promise.all([
            provider.validateConnection({}, { bearerToken: 'x' }).then((r) => {
                expect(r.valid).toBe(false);
                expect(r.error).toMatch(/URL is required/);
            }),
            provider.validateConnection({ endpointUrl: GOOD }, {}).then((r) => {
                expect(r.valid).toBe(false);
                expect(r.error).toMatch(/token is required/);
            }),
        ]);
    });

    it('declares the token as a SECRET field, never a config field', async () => {
        const secretKeys = provider.configSchema.secretFields.map((f) => f.key);
        const configKeys = provider.configSchema.configFields.map((f) => f.key);
        expect(secretKeys).toContain('bearerToken');
        expect(configKeys).not.toContain('bearerToken');
        // `configJson` is not encrypted; `secretEncrypted` is. A token declared as
        // a config field would be stored in plaintext and returned by the list API.
    });

    it('declares no supported checks, and that is a statement', () => {
        // This provider is a data source for recertification, not a compliance
        // check with a pass/fail verdict. An empty array by decision, not by
        // omission — the registry logs `checks: []` at startup.
        expect(provider.supportedChecks).toEqual([]);
    });
});

// ─── The token never escapes ───────────────────────────────────────────────

describe('1c — the bearer token appears nowhere', () => {
    const provider = new LegacyMcpProvider();
    const TOKEN = 'legacy-bearer-must-not-leak-9876543210'; // pragma: allowlist secret — a fixture; the test is that it never escapes

    it('is absent from every validation failure, for every reachable cause', async () => {
        const cases: Array<[string, Record<string, unknown>]> = [
            ['unreachable host', { endpointUrl: 'https://nonexistent.example.invalid/rpc' }],
            ['refused destination', { endpointUrl: 'https://127.0.0.1/rpc' }],
            ['missing url', {}],
        ];
        const leaks: string[] = [];
        for (const [name, config] of cases) {
            const r = await provider.validateConnection(config, { bearerToken: TOKEN });
            if (JSON.stringify(r).includes(TOKEN)) leaks.push(name);
        }
        expect(leaks).toEqual([]);
    });

    it('is absent from the provider\'s own declared surface', () => {
        // Every string a provider publishes reaches an admin screen: the setup
        // guide, the field descriptions, the display name.
        const surface = JSON.stringify({
            id: provider.id,
            displayName: provider.displayName,
            description: provider.description,
            setupGuide: provider.setupGuide,
            configSchema: provider.configSchema,
        });
        expect(surface).not.toContain(TOKEN);
        // And the field description says the token is never returned, which is the
        // promise the two assertions above keep.
        const field = provider.configSchema.secretFields.find((f) => f.key === 'bearerToken')!;
        expect(field.description).toMatch(/never returned/);
    });

    it('the error messages are OUR text, not the server\'s', async () => {
        // A remote server's own message must never be rendered into an admin screen
        // as though this deployment vouched for it — and a message built from a
        // response body is also how untrusted content reaches a log line.
        const r = await provider.validateConnection(
            { endpointUrl: 'https://127.0.0.1/rpc' },
            { bearerToken: TOKEN }
        );
        expect(r.valid).toBe(false);
        expect(r.error).toBeTruthy();
        // Each message is a fixed sentence chosen from a closed switch over the
        // error kind; none interpolates a response.
        expect(r.error).not.toMatch(/\{|\}|<|>/);
    });
});

// ─── Resolved-address refusal is safeFetch's job, and it is wired ──────────

describe('1c — a name that only RESOLVES to a private address', () => {
    it('is refused at fetch time by safeFetch, which the client is registered as using', () => {
        // Not settleable at save time: a hostname resolving to 169.254.169.254
        // looks like any other hostname, and `checkWebhookUrl` only inspects
        // literals. The defence is `safeFetch` re-resolving and re-checking every
        // address at USE time.
        //
        // Asserted through the registry rather than by resolving a real name: the
        // client is listed in `SINKS` in `tests/guards/ssrf-egress-coverage.test.ts`,
        // which asserts it calls `safeFetch` and imports it from the egress module,
        // and that file pins its own membership so the entry cannot leave silently.
        // A DNS-dependent assertion here would be a test whose verdict depends on
        // somebody else's resolver.
        const sinks = require('node:fs').readFileSync(
            require('node:path').resolve(__dirname, '../guards/ssrf-egress-coverage.test.ts'),
            'utf8'
        ) as string;
        const arrayOnly = sinks.slice(sinks.indexOf('const SINKS'), sinks.indexOf('describe(', sinks.indexOf('const SINKS')));
        expect(arrayOnly).toContain('src/lib/mcp/client/index.ts');
    });
});

// ─── The Test button is not a background pull ──────────────────────────────

describe('1c — pressing Test cannot flag the credential as broken', () => {
    it('markAuthFailure is reached only from background sweeps, never from validateConnection', () => {
        // An operator pressing Test with a half-typed token must not mark the
        // connection's credential broken: that flag is read by the freshness
        // surface and the leaver pass, which would then treat a typo as evidence
        // the integration is down. Only a background pull, which nobody is
        // watching, is entitled to record that conclusion.
        //
        // `codeOf` masks comments, so this provider's own docblock saying it never
        // calls `markAuthFailure` cannot satisfy the assertion — the same trap the
        // as-any ratchet sprang on a comment earlier in this roadmap.
        const callers = repoRelativeFiles()
            .filter((f) => f.startsWith('src/') && f.endsWith('.ts'))
            .filter((f) => /(?<![\w.])markAuthFailure\s*\(/.test(codeOf(readFileSync(f, 'utf8'))));

        // The denominator: if the scan found nothing, "no test-path caller" would
        // pass vacuously.
        expect(callers.length).toBeGreaterThan(0);

        // Every caller is a background job or sweep. None is the provider, and none
        // is the usecase the Test button calls.
        expect(callers).not.toContain('src/app-layer/integrations/providers/legacy-mcp/index.ts');
        expect(callers).not.toContain('src/app-layer/usecases/integrations.ts');
    });
});
