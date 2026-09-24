/**
 * The cross-walk `config-schema.ts` says exists.
 *
 * `CONFIG_FIELD_RULES`'s own docblock states:
 *
 *   "Every field a provider DECLARES must appear here.
 *    `tests/guards/config-field-classification.test.ts` cross-walks this
 *    against each registered provider's `configSchema.configFields`, so a
 *    new field cannot be added without someone deciding what it is."
 *
 * That file did not exist. `find tests -name '*config-field*'` returned
 * nothing, and no test imported `CONFIG_FIELD_RULES` for that purpose — so
 * the hand-maintained list the docblock says is checked was checked by
 * nobody. This is that file.
 *
 * ═══ WHY THE THIRD AXIS MATTERS MORE THAN THE FIRST TWO ═══
 *
 * A field declared in `secretFields` is a credential. It is encrypted into
 * `secretEncrypted` and never returned by the API. A field with an entry in
 * `CONFIG_FIELD_RULES` is accepted by `validateProviderConfig` into
 * `configJson` — which is a plain Json column, is selected by
 * `listIntegrationConnections`, and is served by the admin GET.
 *
 * A key that is BOTH is a credential the config validator will accept into
 * the unencrypted bag. Nothing rejects it and nothing warns: the response
 * even carries `secretStatus: '••••••••'`, which masks the SECRETS bag and
 * says nothing about this one. See the issue this guard was written for.
 *
 * ═══ NOT THE SAME AS ITS SIBLING ═══
 *
 * `tests/guards/integration-credential-placement.test.ts` asserts that no
 * provider DECLARES a credential in `configFields`. That is a different
 * structure and it did not catch this: active-directory declared
 * `bindPassword` correctly, in `secretFields`, and carried a
 * `CONFIG_FIELD_RULES` entry for it anyway. The sibling never reads that
 * table. Declaration and accept-list are two lists, and only one of them was
 * guarded. #2837 emptied the second one; this file is what keeps it empty.
 */
import '@/app-layer/integrations/bootstrap';
import { CONFIG_FIELD_RULES } from '@/app-layer/integrations/config-schema';
import { registry } from '@/app-layer/integrations/registry';

interface Declared {
    readonly config: ReadonlySet<string>;
    readonly secret: ReadonlySet<string>;
}

function declaredFields(): Map<string, Declared> {
    const out = new Map<string, Declared>();
    for (const p of registry.listProviders()) {
        const schema = (p as { configSchema?: { configFields?: { key: string }[]; secretFields?: { key: string }[] } })
            .configSchema;
        out.set(p.id, {
            config: new Set((schema?.configFields ?? []).map((f) => f.key)),
            secret: new Set((schema?.secretFields ?? []).map((f) => f.key)),
        });
    }
    return out;
}

/**
 * Secret-declared keys that also carry a config rule.
 *
 * EMPTY, and it may only grow back over somebody's explicit objection. It
 * held ten entries when this guard was written — every one a credential
 * `validateProviderConfig` would admit into the unencrypted bag — and #2837
 * removed all ten rules from `CONFIG_FIELD_RULES`:
 *
 *   active-directory.bindDN          active-directory.bindPassword
 *   entra-id.clientSecret            github.token
 *   github.webhookSecret             google-workspace.serviceAccountJson
 *   okta.apiToken                    orangehrm.clientSecret
 *   servicenow.password              workday.clientSecret
 *
 * They were pinned rather than deleted here because removing a rule changes
 * what the endpoint accepts, and that deserved its own diff and its own
 * review. It got one.
 *
 * The asymmetry was the tell that the list was drift rather than design:
 * active-directory pinned `bindDN` and `bindPassword` while its OTHER two
 * secret fields, `writeBindDN` and `writeBindPassword`, had no config rule
 * at all. Nobody decided that; it accumulated.
 */
const SECRET_FIELDS_WITH_CONFIG_RULES: readonly string[] = [];

/**
 * Rules whose field no registered provider declares. Dead entries, and one of
 * them is a whole provider that no longer exists.
 */
const ORPHAN_RULES: readonly string[] = [
    'hris: rules exist for an UNREGISTERED provider',
    'servicenow.sysparm_query: rule for a field no provider schema declares',
    'sharepoint: rules exist for an UNREGISTERED provider',
];

/**
 * Providers that declare config fields and have no rules entry at all, so
 * `validateProviderConfig` falls back to `?? {}` and rejects EVERY field.
 */
const PROVIDERS_WITHOUT_RULES: readonly string[] = [
    'aws-posture: declares config fields but has NO rules entry',
    'azure-posture: declares config fields but has NO rules entry',
    'bamboohr: declares config fields but has NO rules entry',
    'gcp-posture: declares config fields but has NO rules entry',
];

describe('config field classification — the cross-walk config-schema.ts claims', () => {
    it('the population is real: providers are registered and rules exist', () => {
        const declared = declaredFields();
        expect(declared.size).toBeGreaterThan(5);
        expect(Object.keys(CONFIG_FIELD_RULES).length).toBeGreaterThan(5);
    });

    it('every CONFIG_FIELD_RULES key is a field its provider actually declares', () => {
        const declared = declaredFields();
        const orphans: string[] = [];
        for (const [provider, rules] of Object.entries(CONFIG_FIELD_RULES)) {
            const d = declared.get(provider);
            if (!d) {
                orphans.push(`${provider}: rules exist for an UNREGISTERED provider`);
                continue;
            }
            for (const key of Object.keys(rules)) {
                if (!d.config.has(key) && !d.secret.has(key)) {
                    orphans.push(`${provider}.${key}: rule for a field no provider schema declares`);
                }
            }
        }
        expect(orphans.sort()).toEqual([...ORPHAN_RULES].sort());
    });

    it('every declared configField has a rule, so a new field cannot arrive unclassified', () => {
        const declared = declaredFields();
        const unclassified: string[] = [];
        for (const [provider, d] of declared) {
            const rules = CONFIG_FIELD_RULES[provider];
            if (!rules) {
                if (d.config.size > 0) unclassified.push(`${provider}: declares config fields but has NO rules entry`);
                continue;
            }
            for (const key of d.config) {
                if (!(key in rules)) unclassified.push(`${provider}.${key}`);
            }
        }
        expect(unclassified.sort()).toEqual([...PROVIDERS_WITHOUT_RULES].sort());
    });

    it('a SECRET-declared field must not also carry a config rule — baseline may only shrink', () => {
        const declared = declaredFields();
        const found: string[] = [];
        // THE DENOMINATOR, and it is part of the result. With the baseline at
        // zero this assertion's whole content is `found === []`, which a
        // cross-walk that examined NOTHING would also satisfy — a registry that
        // failed to bootstrap, a `secretFields` key renamed out from under
        // `declaredFields()`, a `CONFIG_FIELD_RULES` reduced to `{}`. Counting
        // the pairs actually compared makes an empty selection distinguishable
        // from a clean one.
        let comparedPairs = 0;
        let secretFieldsSeen = 0;
        for (const [provider, rules] of Object.entries(CONFIG_FIELD_RULES)) {
            const d = declared.get(provider);
            if (!d) continue;
            secretFieldsSeen += d.secret.size;
            for (const key of Object.keys(rules)) {
                comparedPairs += 1;
                if (d.secret.has(key)) found.push(`${provider}.${key}`);
            }
        }
        // Both sides of the comparison are non-empty: there are rules to check
        // AND secret fields they could collide with.
        expect(comparedPairs).toBeGreaterThan(20);
        expect(secretFieldsSeen).toBeGreaterThan(5);
        expect(found.sort()).toEqual([...SECRET_FIELDS_WITH_CONFIG_RULES].sort());
    });

    it('the baseline is honest: every entry in it is really a secret field today', () => {
        // VACUOUS WHILE THE BASELINE IS EMPTY, and kept for the day it is not.
        // It exists so an entry cannot be re-added for a key that has since
        // stopped being a secret field — which would read as a real pin while
        // pinning nothing. The test with teeth today is the one above.
        const declared = declaredFields();
        const stale = SECRET_FIELDS_WITH_CONFIG_RULES.filter((entry) => {
            const idx = entry.lastIndexOf('.');
            const [p, k] = [entry.slice(0, idx), entry.slice(idx + 1)];
            return !declared.get(p)?.secret.has(k);
        });
        expect(stale).toEqual([]);
    });
});
