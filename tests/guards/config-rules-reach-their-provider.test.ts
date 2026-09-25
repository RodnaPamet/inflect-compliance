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
 *     returned by the admin API. `NO_CONFIG_RULES` below is the current set;
 *     the count is deliberately not repeated here, because it was wrong — this
 *     line said "today six do" while the list held three, and rule 2 passing
 *     is what proves three is the real number.
 *  3. No rule permits a CREDENTIAL-NAMED field. `configJson` is the wrong
 *     place for one by construction, and a provider that needs a secret has
 *     `secretFields` and the encrypted bag for it.
 *
 * None of these can be satisfied by an empty scan: each asserts a denominator
 * first.
 */
import '@/app-layer/integrations/bootstrap';
import {
    CONFIG_FIELD_RULES,
    validateProviderConfig,
} from '@/app-layer/integrations/config-schema';
import { registry } from '@/app-layer/integrations/registry';

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
    'aws-posture': 'posture collector; configuration is the credential, which lives in the secrets bag',
};

/**
 * Rules keyed to something the REGISTRY does not list.
 *
 * Restored after being deleted as "dead" — it was not dead, my scanner was
 * wrong. `sharepoint` has no `configSchema` descriptor and is not a registry
 * provider; the delta-import path merges `deltaTokens` through this entry
 * rather than an admin form, so `validateProviderConfig` is never called with
 * it and the rules are documentation of a write that happens elsewhere.
 */
const NON_PROVIDER_KEYS: Readonly<Record<string, string>> = {
    sharepoint:
        'not a registry provider; the delta-import path merges deltaTokens through this entry ' +
        'rather than an admin form',
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
 * Registered provider ids — from the REGISTRY, which is the authority.
 *
 * This walked `src/app-layer/integrations/providers/**` for `readonly id =`
 * until the outbound MCP provider landed. That scraper found `mcp-server`,
 * which declares an id and a `configField` but is NOT in the bootstrap
 * registry — so `validateProviderConfig` is never called with it, and a rules
 * entry for it would have been DEAD ON ARRIVAL. Precisely the `hris` defect
 * this guard exists to prevent, reintroduced by the guard itself.
 *
 * `config-field-classification` already read the registry, so the two guards
 * disagreed about what a provider IS. They now share one source, and it is the
 * one the validator is actually keyed by.
 */
function registeredProviderIds(): string[] {
    return [...new Set(registry.listProviders().map((p) => (p as { id: string }).id))].sort();
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
        const dead = KEYS.filter((k) => !IDS.includes(k) && !(k in NON_PROVIDER_KEYS));
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
        const staleNonProvider = Object.keys(NON_PROVIDER_KEYS).filter(
            (k) => !(k in CONFIG_FIELD_RULES) || IDS.includes(k),
        );
        const staleNotSecret = Object.keys(NOT_ACTUALLY_SECRET).filter((q) => {
            const [provider, field] = q.split('.');
            return !(provider in CONFIG_FIELD_RULES) || !(field in CONFIG_FIELD_RULES[provider]);
        });
        expect({ staleNoConfig, staleNonProvider, staleNotSecret }).toEqual({
            staleNoConfig: [],
            staleNonProvider: [],
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
