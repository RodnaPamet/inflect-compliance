/**
 * The secrets bag cannot be used to get around the config validator
 * (#2843 finding 16).
 *
 * ═══ THE BYPASS ═══
 *
 * `validateProviderConfig` throws `Unknown configuration field` on a key a
 * provider does not declare. The secrets bag had NO validation — it went
 * straight to `encryptField(JSON.stringify(...))` — and `mergeConnection`
 * returns `{ ...config, ...secrets }`, so a secret shadows a config field of
 * the same name.
 *
 * Composed, those two facts are a way around the validator. The AD write gate
 * reads its opt-in off the merged view, so `secrets: { writesEnabled: true }`
 * granted offboarding write authority over a customer's directory without ever
 * passing the check that exists to stop it.
 */
import { validateProviderSecrets } from '@/app-layer/integrations/config-schema';

const AD = {
    configFields: [
        { key: 'url' },
        { key: 'baseDN' },
        { key: 'writesEnabled' },
        { key: 'allowSelfSignedTls' },
    ],
    secretFields: [{ key: 'bindDN' }, { key: 'bindPassword' }, { key: 'writeBindDN' }],
};

/** A provider that has not described its secrets yet. */
const UNDESCRIBED = { configFields: [{ key: 'host' }], secretFields: [] };

describe('validateProviderSecrets', () => {
    it('accepts the secrets a provider declares', () => {
        expect(
            validateProviderSecrets('active-directory', { bindDN: 'CN=svc', bindPassword: 'x' }, AD),
        ).toEqual({ bindDN: 'CN=svc', bindPassword: 'x' });
    });

    // ─── rule 1: the bypass ───

    it('REFUSES a secret that shadows a config field', () => {
        // The defect verbatim. `writesEnabled` is a declared CONFIG field for
        // active-directory and is not a secret field, so before this it could
        // only be set through the validator — or through this bag, unchecked.
        expect(() =>
            validateProviderSecrets('active-directory', { writesEnabled: true }, AD),
        ).toThrow(/configuration field .* cannot be sent as a secret/i);
    });

    it('names WHY, because the reason is the whole point', () => {
        try {
            validateProviderSecrets('active-directory', { writesEnabled: true }, AD);
            throw new Error('expected a refusal');
        } catch (e) {
            expect((e as Error).message).toMatch(/overrides the configured value/i);
        }
    });

    it('refuses the shadow even for a provider that declares no secrets', () => {
        // Rule 1 is unconditional. The shadowing is a property of
        // `mergeConnection`, not of the provider, so a provider that has not
        // described its secrets is not thereby exempt.
        expect(() => validateProviderSecrets('someprovider', { host: 'evil' }, UNDESCRIBED)).toThrow(
            /configuration field/i,
        );
    });

    // ─── rule 2: undeclared secrets ───

    it('refuses a secret the provider never declared', () => {
        expect(() =>
            validateProviderSecrets('active-directory', { somethingElse: 'x' }, AD),
        ).toThrow(/Unknown secret field/i);
    });

    it('stays quiet for a provider that has declared none', () => {
        // Not the same as "anything goes" — rule 1 still applied above. A
        // provider with no declared secrets has not been described yet, and
        // refusing every secret it has would break it.
        expect(validateProviderSecrets('someprovider', { apiToken: 'x' }, UNDESCRIBED)).toEqual({
            apiToken: 'x',
        });
    });

    // ─── shape ───

    it('treats an absent bag as empty rather than throwing', () => {
        expect(validateProviderSecrets('active-directory', null, AD)).toEqual({});
        expect(validateProviderSecrets('active-directory', undefined, AD)).toEqual({});
    });

    it('refuses a non-object, which cannot be a bag of secrets', () => {
        expect(() => validateProviderSecrets('active-directory', 'bindPassword', AD)).toThrow(
            /must be a plain object/i,
        );
        expect(() => validateProviderSecrets('active-directory', ['x'], AD)).toThrow(
            /must be a plain object/i,
        );
    });
});
