/**
 * #5616 — which provider `getStorageProvider()` returns when STORAGE_PROVIDER
 * is UNSET.
 *
 * Its docblock said `'local'` and the line underneath read
 * `env.STORAGE_PROVIDER || 's3'`. The two had disagreed for a long time, and
 * the only test that claimed to cover the question could not notice: the
 * factory case in `storage-provider.test.ts` was named "returns local provider
 * by default" while its env mock set `STORAGE_PROVIDER: 'local'` EXPLICITLY, so
 * it drove the explicit branch and would have passed whatever the default was.
 * That test is now named for what it drives, and the default has these.
 *
 * `jest.doMock` + `resetModules`, because the env mock has to vary per case and
 * a hoisted `jest.mock` factory cannot read a per-test value.
 */
describe('getStorageProvider — the default when STORAGE_PROVIDER is unset (#5616)', () => {
    beforeEach(() => {
        jest.resetModules();
    });

    it("defaults to 's3', which is the opposite of what the docblock used to claim", () => {
        jest.doMock('@/env', () => ({ env: { S3_BUCKET: 'a-bucket', NODE_ENV: 'test' } }));
        const { getStorageProvider, resetStorageProvider } = require('@/lib/storage/index');
        resetStorageProvider();
        expect(getStorageProvider().name).toBe('s3');
    });

    it('reproduces the operator failure the wrong docblock produced', () => {
        // An operator who trusted "Default: 'local'" ran with neither variable
        // set, expecting local disk, and got this instead — an error naming a
        // variable they had no reason to set.
        jest.doMock('@/env', () => ({ env: { NODE_ENV: 'test' } }));
        const { getStorageProvider, resetStorageProvider } = require('@/lib/storage/index');
        resetStorageProvider();
        expect(() => getStorageProvider()).toThrow(/S3_BUCKET/);
    });

    it("still honours an explicit 'local'", () => {
        jest.doMock('@/env', () => ({ env: { STORAGE_PROVIDER: 'local', FILE_STORAGE_ROOT: '/tmp/x', NODE_ENV: 'test' } }));
        const { getStorageProvider, resetStorageProvider } = require('@/lib/storage/index');
        resetStorageProvider();
        expect(getStorageProvider().name).toBe('local');
    });

    it('an empty string is not a provider name, and falls back like an unset one', () => {
        // `||` rather than `??` is load-bearing here: STORAGE_PROVIDER='' must
        // not be passed through to the switch, where it would match no arm.
        jest.doMock('@/env', () => ({ env: { STORAGE_PROVIDER: '', S3_BUCKET: 'a-bucket', NODE_ENV: 'test' } }));
        const { getStorageProvider, resetStorageProvider } = require('@/lib/storage/index');
        resetStorageProvider();
        expect(getStorageProvider().name).toBe('s3');
    });
});
