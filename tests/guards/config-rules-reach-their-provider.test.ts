/**
 * A rules table keyed to something no caller passes validates nothing.
 *
 * ── THE SHAPE OF THE DEFECT ─────────────────────────────────────────────────
 *
 * `validateProviderConfig(providerId, configJson)` looks its rules up by
 * PROVIDER ID and, finding none, returns the config unchanged:
 *
 *     const rules = CONFIG_FIELD_RULES[providerId];
 *     if (!rules) return config;
 *
 * So a table entry keyed to anything other than a provider id is not a weak
 * rule — it is NO rule, silently. BambooHR's entry was keyed `hris` (the
 * directory's name) while its provider id is `bamboohr`, so from the day it
 * was written until #2837 its `subdomain` check never ran. That check is an
 * INJECTION GUARD: the value is interpolated into `{subdomain}.bamboohr.com`,
 * and one carrying a dot or a slash leaves the intended host.
 *
 * Nothing could see it. The entry existed, read correctly, had a sensible
 * regex, and was covered by no test that called it with a real provider id.
 *
 * ── WHAT IS ASSERTED ────────────────────────────────────────────────────────
 *
 *  1. Every key in the table is a provider id something actually passes, or is
 *     listed below with a reason. A key that matches nothing is dead.
 *  2. Every registered provider either HAS rules or is listed below. This is
 *     the `if (!rules) return config` arm made visible: a provider with no
 *     entry accepts any key into `configJson`, which is stored unencrypted and
 *     returned by the admin API, and today six do.
 *  3. No rule permits a CREDENTIAL-NAMED field. `configJson` is the wrong
 *     place for one by construction, and a provider that needs a secret has
 *     `secretFields` and the encrypted bag for it.
 *
 * None of these can be satisfied by an empty scan: each asserts a denominator
 * first.
 */
import {
    CONFIG_FIELD_RULES,
    validateProviderConfig,
} from '@/app-layer/integrations/config-schema';

/**
 * Provider ids with no rules entry, each with the reason it is not a hole.
 *
 * This list is the POINT of the guard, not an exemption from it: adding a
 * provider here is a decision someone makes in a diff, rather than a silence
 * nobody notices. Everything on it is a provider whose connections carry no
 * admin-authored `configJson` — if that changes, it needs rules, and the
 * change will show up here.
 */
const NO_CONFIG_RULES: Readonly<Record<string, string>> = {
    'azure-posture': 'posture collector; configuration is the credential, which lives in the secrets bag',
    'gcp-posture': 'posture collector; same shape as azure-posture',
    device: 'device inventory is imported, not configured per-connection',
    personnel: 'the internal roster provider — no external connection to configure',
    training: 'training records are imported, not configured per-connection',
};


/** Names that must never be accepted into the unencrypted config column. */
const CREDENTIAL_NAME = /(password|secret|token|apikey|api_key|credential|privatekey|passphrase)/i;

/**
 * Fields whose NAME matches the credential pattern but which are not secrets.
 *
 * Exempted by hand, with the reason, rather than by narrowing the pattern:
 * `deltaTokens` is caught by `token`, and the right answer is to keep the
 * pattern broad and argue the one exception. Narrowing it to exclude "delta"
 * would silently also admit the next field that happens to contain the word.
 */
const NOT_ACTUALLY_SECRET: Readonly<Record<string, string>> = {
    'sharepoint.deltaTokens':
        'Microsoft Graph continuation cursors, written by the delta-import path rather than an ' +
        'admin. They identify a position in a change feed, grant nothing, and are useless to a ' +
        'holder without the credential that lives in the secrets bag.',
};

/**
 * Registered provider ids, read from the provider modules rather than
 * hand-listed — a hand-list would drift the same way the table key did.
 */
function registeredProviderIds(): string[] {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path') as typeof import('path');
    const root = path.resolve(__dirname, '../../src/app-layer/integrations/providers');

    // WALK, don't assume a layout. The first version of this read only
    // `<dir>/index.ts` and missed `github` — which declares its id in
    // `legacy-provider.ts` — and the two posture providers, which are
    // top-level files rather than directories. A scan that silently covers
    // less than it appears to is the same class of defect this guard exists
    // to catch, one level up.
    const ids: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.ts')) {
                const src = fs.readFileSync(full, 'utf8');
                for (const m of src.matchAll(/readonly (?:id|providerId) = '([a-z0-9-]+)'/g)) {
                    ids.push(m[1]);
                }
            }
        }
    };
    walk(root);
    return [...new Set(ids)].sort();
}

const IDS = registeredProviderIds();
const KEYS = Object.keys(CONFIG_FIELD_RULES).sort();

describe('every rules entry reaches a provider, and every provider is accounted for', () => {
    it('found a real provider population and a real table — neither scan is empty', () => {
        // The denominator. Every assertion below is satisfied by an empty list,
        // and an empty list is exactly what a broken reader produces.
        expect(IDS.length).toBeGreaterThan(8);
        expect(KEYS.length).toBeGreaterThan(5);
        expect(IDS).toContain('bamboohr');
    });

    it('no rules entry is keyed to something no caller passes', () => {
        const dead = KEYS.filter((k) => !IDS.includes(k));
        expect({
            why:
                'validateProviderConfig looks rules up BY PROVIDER ID and returns the config ' +
                'unchanged when it finds none, so an entry keyed to anything else is not a weak ' +
                'rule, it is no rule. Rekey it to the id a caller actually passes (#2837).',
            dead,
        }).toEqual({ why: expect.any(String), dead: [] });
    });

    it('every registered provider either has rules or is listed as needing none', () => {
        const unaccounted = IDS.filter((id) => !KEYS.includes(id) && !(id in NO_CONFIG_RULES));
        expect({
            why:
                'A provider with no rules entry accepts ANY key into configJson, which is stored ' +
                'unencrypted and returned by the admin API. Give it rules, or add it to ' +
                'NO_CONFIG_RULES with the reason it carries no admin-authored config (#2837).',
            unaccounted,
        }).toEqual({ why: expect.any(String), unaccounted: [] });
    });

    it('the exemption lists carry no STALE entries', () => {
        // An exemption that no longer matches anything is not harmless: it
        // pre-authorises whatever later takes that name. This is the same rule
        // the npm-audit allowlist enforces on itself, applied here rather than
        // learned again later.
        const staleNoConfig = Object.keys(NO_CONFIG_RULES).filter(
            (id) => !IDS.includes(id) || KEYS.includes(id),
        );
        const staleNotSecret = Object.keys(NOT_ACTUALLY_SECRET).filter((q) => {
            const [provider, field] = q.split('.');
            return !(provider in CONFIG_FIELD_RULES) || !(field in CONFIG_FIELD_RULES[provider]);
        });
        expect({ staleNoConfig, staleNotSecret }).toEqual({
            staleNoConfig: [],
            staleNotSecret: [],
        });
    });

    it('no rule permits a credential-named field into configJson', () => {
        const offenders: string[] = [];
        for (const [provider, rules] of Object.entries(CONFIG_FIELD_RULES)) {
            for (const field of Object.keys(rules)) {
                const qualified = `${provider}.${field}`;
                if (CREDENTIAL_NAME.test(field) && !(qualified in NOT_ACTUALLY_SECRET)) {
                    offenders.push(qualified);
                }
            }
        }
        expect({
            why:
                'configJson is stored in the clear and returned by the admin API. A provider that ' +
                'needs a credential declares it in secretFields, where it reaches the encrypted ' +
                'bag instead (#2837).',
            offenders,
        }).toEqual({ why: expect.any(String), offenders: [] });
    });
});

describe("BambooHR's subdomain guard actually runs now", () => {
    // The behavioural half. The assertions above are about the TABLE; these
    // call the validator the way production calls it, with the provider id.

    it('rejects a subdomain that would escape the intended host', () => {
        // `{subdomain}.bamboohr.com` — a dot or slash leaves the host.
        expect(() =>
            validateProviderConfig('bamboohr', { subdomain: 'evil.example.com' }),
        ).toThrow(/bare subdomain/i);
        expect(() => validateProviderConfig('bamboohr', { subdomain: 'a/b' })).toThrow(
            /bare subdomain/i,
        );
    });

    it('accepts a bare subdomain — the positive control', () => {
        // Without this, a rule that rejected EVERYTHING would pass the test
        // above while breaking every real connection.
        expect(validateProviderConfig('bamboohr', { subdomain: 'acme-corp' })).toEqual({
            subdomain: 'acme-corp',
        });
    });

    it('refuses an apiKey in configJson — it belongs in the secrets bag', () => {
        expect(() => validateProviderConfig('bamboohr', { apiKey: 'sk-live-xxx' })).toThrow(
            /Unknown configuration field/i,
        );
    });

    it("the old key is gone, so the mismatch cannot come back quietly", () => {
        expect(Object.keys(CONFIG_FIELD_RULES)).not.toContain('hris');
    });
});
