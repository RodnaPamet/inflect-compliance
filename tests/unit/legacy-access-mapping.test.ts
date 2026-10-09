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
import { MAPPING_CONFIG_KEY, type StoredMapping } from '@/lib/legacy-access/canonical';
import { diffMappings } from '@/app-layer/usecases/legacy-access-mapping';

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

describe('diffMappings — what an auditor is actually asking', () => {
    const base = (over: Partial<StoredMapping> = {}): StoredMapping => ({
        version: 1,
        columnSetFingerprint: 'a'.repeat(64),
        fields: { accountKey: 'LOGIN', email: 'EMAIL' },
        entitlements: { kind: 'wide', columns: ['ROLE_1'] },
        confirmedAt: '2026-10-09T00:00:00.000Z',
        confirmedByUserId: 'u1',
        ...over,
    });

    it('reports a first save as all-added, with no removals', () => {
        const d = diffMappings(null, base());
        expect(d.fieldsAdded).toEqual({ accountKey: 'LOGIN', email: 'EMAIL' });
        expect(d.fieldsRemoved).toEqual({});
        expect(d.fieldsChanged).toEqual({});
        // No previous version means nothing CHANGED, so these stay null rather
        // than reporting a change from nothing.
        expect(d.layoutChanged).toBeNull();
        expect(d.fingerprintChanged).toBeNull();
    });

    it('separates added, removed and MOVED fields', () => {
        const d = diffMappings(
            base({ fields: { accountKey: 'LOGIN', email: 'EMAIL', title: 'JOB' } }),
            base({ fields: { accountKey: 'USER_ID', email: 'EMAIL', department: 'DEPT' } }),
        );
        expect(d.fieldsChanged).toEqual({ accountKey: { from: 'LOGIN', to: 'USER_ID' } });
        expect(d.fieldsAdded).toEqual({ department: 'DEPT' });
        expect(d.fieldsRemoved).toEqual({ title: 'JOB' });
    });

    it('a moved accountKey is reported as a CHANGE, not an add plus a remove', () => {
        // The single most consequential edit in this screen: it re-keys every
        // account in every future snapshot. An add-and-remove pair makes it look
        // like two unrelated edits.
        const d = diffMappings(base(), base({ fields: { accountKey: 'EMP_ID', email: 'EMAIL' } }));
        expect(Object.keys(d.fieldsChanged)).toEqual(['accountKey']);
        expect(d.fieldsAdded).toEqual({});
        expect(d.fieldsRemoved).toEqual({});
    });

    it('reports a layout change as a readable before/after', () => {
        const d = diffMappings(base(), base({ entitlements: { kind: 'long', column: 'ROLE' } }));
        expect(d.layoutChanged).toEqual({ from: 'wide(ROLE_1)', to: 'long(ROLE)' });
    });

    it('is quiet when the layout only reorders its columns', () => {
        // A wide layout is a SET of columns; reordering it changes nothing.
        const d = diffMappings(
            base({ entitlements: { kind: 'wide', columns: ['R1', 'R2'] } }),
            base({ entitlements: { kind: 'wide', columns: ['R2', 'R1'] } }),
        );
        expect(d.layoutChanged).toBeNull();
    });

    it('reports a REMOVED status fold as loudly as an added one', () => {
        // Dropping a fold silently re-routes that status to UNKNOWN. That is the
        // fail-closed direction, but it is still a change somebody made.
        const d = diffMappings(
            base({ statusValues: { A: 'ACTIVE', LOCKD: 'LOCKED' } }),
            base({ statusValues: { A: 'ACTIVE' } }),
        );
        expect(d.statusValueKeysChanged).toEqual(['LOCKD']);
    });

    it('reports a RETARGETED status fold', () => {
        const d = diffMappings(
            base({ statusValues: { A: 'ACTIVE' } }),
            base({ statusValues: { A: 'LOCKED' } }),
        );
        expect(d.statusValueKeysChanged).toEqual(['A']);
    });

    it('reports a fingerprint change, which is the re-confirmation after drift', () => {
        const d = diffMappings(base(), base({ columnSetFingerprint: 'b'.repeat(64) }));
        expect(d.fingerprintChanged).toEqual({ from: 'a'.repeat(64), to: 'b'.repeat(64) });
    });

    it('an identical re-save diffs to nothing', () => {
        const d = diffMappings(base(), base());
        expect(d).toEqual({
            fieldsAdded: {}, fieldsRemoved: {}, fieldsChanged: {},
            layoutChanged: null, statusValueKeysChanged: [], fingerprintChanged: null,
        });
    });
});
