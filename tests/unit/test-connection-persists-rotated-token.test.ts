/**
 * #5194 / #5195 — a Test that rotates the refresh token writes the new one back.
 *
 * Workday and OrangeHRM rotate the refresh token on every exchange and
 * invalidate the old one. The Test button made such an exchange and dropped
 * the result, so testing a healthy connection left it holding a dead token
 * and the next sync failed. The usecase now hands the provider a persist hook
 * when it is testing the STORED credential, and only then.
 */
import { testConnectionCredentials } from '@/app-layer/usecases/integrations';
import { registry } from '@/app-layer/integrations/registry';

const mockDb = { integrationConnection: { findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() } };
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb),
}));

const STORED = { refreshToken: 'r1', accessToken: 'a1', expiresAt: 0, clientSecret: 'fixture-client-secret' }; // pragma: allowlist secret
jest.mock('@/lib/security/encryption', () => {
    const actual = jest.requireActual('@/lib/security/encryption');
    return { ...actual, decryptField: () => JSON.stringify(STORED) };
});
const { decryptField: realDecrypt } = jest.requireActual('@/lib/security/encryption') as typeof import('@/lib/security/encryption');

const CTX = { tenantId: 't-1', userId: 'u-1' } as never;
const ROTATED = { accessToken: 'a2', refreshToken: 'r2', expiresAt: 4_000_000_000 };

const validateConnection = jest.fn();
beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    jest.spyOn(registry, 'getProvider').mockReturnValue({
        validateConnection: (...a: unknown[]) => validateConnection(...a),
    } as never);
    validateConnection.mockImplementation(
        async (_c: unknown, _s: unknown, opts?: { persistSecret?: (p: Record<string, unknown>) => Promise<void> }) => {
            await opts?.persistSecret?.(ROTATED);
            return { valid: true };
        },
    );
    mockDb.integrationConnection.findFirst.mockResolvedValue({
        provider: 'workday',
        configJson: { host: 'wd5-impl-services1.workday.com' },
        secretEncrypted: 'ciphertext',
    });
    mockDb.integrationConnection.update.mockResolvedValue({});
    mockDb.integrationConnection.updateMany.mockResolvedValue({ count: 1 });
});

it('testing a saved connection writes the rotated pair over the stored one, keeping the other secrets', async () => {
    const r = await testConnectionCredentials(CTX, { connectionId: 'c-1', provider: 'workday' });
    expect(r.valid).toBe(true);
    expect(mockDb.integrationConnection.update).toHaveBeenCalledTimes(1);
    const { where, data } = mockDb.integrationConnection.update.mock.calls[0][0];
    expect(where).toEqual({ id: 'c-1' });
    expect(JSON.parse(realDecrypt(data.secretEncrypted))).toEqual({ ...STORED, ...ROTATED });
});

it('a credential typed into the form is not saved by testing it', async () => {
    await testConnectionCredentials(CTX, { connectionId: 'c-1', provider: 'workday', secrets: { refreshToken: 'typed' } });
    const opts = validateConnection.mock.calls[0][2] as { persistSecret?: unknown };
    expect(opts.persistSecret).toBeUndefined();
    expect(mockDb.integrationConnection.update).not.toHaveBeenCalled();
});

it('an unsaved connection has nothing to persist to', async () => {
    await testConnectionCredentials(CTX, { provider: 'workday', configJson: { host: 'x' } });
    const opts = validateConnection.mock.calls[0][2] as { persistSecret?: unknown };
    expect(opts.persistSecret).toBeUndefined();
});
