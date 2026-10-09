/**
 * The `configJson` key declarations for `legacy-mcp`, and the regression they fix.
 *
 * `CONFIG_FIELD_RULES` is an ALLOWLIST: `validateProviderConfig` throws on a key
 * it cannot find. So registering a provider makes every `configJson` key written
 * for it a declaration that must exist — and Step 1c registered `legacy-mcp`
 * naming only `endpointUrl` and `applicationName`, which broke Step 4a's
 * `adoptUsernameConvention` for the one provider that feature exists for (#3315).
 *
 * `usecases/legacy-username-convention.ts` had PREDICTED that in prose, naming the
 * step that would break it. A predicted regression with no test is an un-run
 * assertion. This file is the assertion.
 */
import { validateProviderConfig } from '@/app-layer/integrations/config-schema';
import { CONVENTION_CONFIG_KEY } from '@/app-layer/usecases/legacy-username-convention';
import { MAPPING_CONFIG_KEY } from '@/lib/legacy-access/canonical';

const PROVIDER = 'legacy-mcp';

describe('legacy-mcp configJson key declarations (#3315)', () => {
    it('accepts the username-convention key — the write path Step 1c broke', () => {
        expect(() =>
            validateProviderConfig(PROVIDER, {
                [CONVENTION_CONFIG_KEY]: { template: '{first}{last}', version: 1 },
            })
        ).not.toThrow();
    });

    it('accepts the access-mapping key', () => {
        expect(() =>
            validateProviderConfig(PROVIDER, {
                [MAPPING_CONFIG_KEY]: { version: 1, fields: { accountKey: 'LOGIN' } },
            })
        ).not.toThrow();
    });

    it('accepts both alongside the provider own settings, which is the real shape', () => {
        // The usecases SPREAD over the existing object, so the validator always
        // sees every key at once. A declaration that only works in isolation
        // would not survive a connection that has been configured.
        expect(() =>
            validateProviderConfig(PROVIDER, {
                endpointUrl: 'https://legacy.example.com/rpc',
                applicationName: 'Payroll',
                [CONVENTION_CONFIG_KEY]: { template: '{f}{last}', version: 2 },
                [MAPPING_CONFIG_KEY]: { version: 3, fields: { accountKey: 'LOGIN' } },
            })
        ).not.toThrow();
    });

    it('STILL refuses a key nobody declared — the allowlist is intact', () => {
        // The fix must not have widened the rule to "accept anything structured".
        expect(() => validateProviderConfig(PROVIDER, { somethingElse: { a: 1 } }))
            .toThrow(/Unknown configuration field/);
    });

    it('STILL refuses a non-https endpoint — publicOrigin is intact', () => {
        expect(() => validateProviderConfig(PROVIDER, { endpointUrl: 'http://legacy.example.com/rpc' }))
            .toThrow();
    });

    it('STILL refuses an endpoint carrying userinfo', () => {
        expect(() =>
            validateProviderConfig(PROVIDER, { endpointUrl: 'https://u:p@legacy.example.com/rpc' })
        ).toThrow();
    });

    it('STILL refuses a private-address endpoint', () => {
        expect(() => validateProviderConfig(PROVIDER, { endpointUrl: 'https://127.0.0.1/rpc' }))
            .toThrow();
    });
});
