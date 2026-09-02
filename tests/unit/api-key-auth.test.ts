/**
 * API Key Authentication Tests
 *
 * Verifies:
 * 1. Key generation produces correct format + hashed storage
 * 2. Valid API key authenticates and builds RequestContext
 * 3. Expired key is rejected
 * 4. Revoked key is rejected
 * 5. Unknown key is rejected
 * 6. Non-API-key tokens fall through to session auth
 * 7. Bearer token extraction works correctly
 * 8. Key hash is deterministic and never stores plaintext
 */

// ─── Mock prisma before imports ───
const mockPrisma = {
    tenantApiKey: {
        findUnique: jest.fn(),
        update: jest.fn(),
    },
};

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: mockPrisma,
}));

jest.mock('@/lib/observability/context', () => ({
    mergeRequestContext: jest.fn(),
}));

import {
    generateApiKey,
    hashApiKey,
    verifyApiKey,
    extractBearerToken,
    isApiKeyToken,
    API_KEY_PREFIX,
} from '@/lib/auth/api-key-auth';

beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.tenantApiKey.update.mockResolvedValue({});
});

// ─── Key Generation ───

describe('API Key — Generation', () => {
    it('generates a key with the correct prefix', () => {
        const { plaintext } = generateApiKey();
        expect(plaintext.startsWith(API_KEY_PREFIX)).toBe(true);
    });

    it('generates unique keys each time', () => {
        const key1 = generateApiKey();
        const key2 = generateApiKey();
        expect(key1.plaintext).not.toBe(key2.plaintext);
        expect(key1.keyHash).not.toBe(key2.keyHash);
    });

    it('keyPrefix is the first chars of plaintext', () => {
        const { plaintext, keyPrefix } = generateApiKey();
        expect(plaintext.startsWith(keyPrefix)).toBe(true);
        expect(keyPrefix.length).toBeGreaterThan(API_KEY_PREFIX.length);
    });

    it('keyHash is a SHA-256 hex digest (64 chars)', () => {
        const { keyHash } = generateApiKey();
        expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('never stores plaintext — hash is different from plaintext', () => {
        const { plaintext, keyHash } = generateApiKey();
        expect(keyHash).not.toBe(plaintext);
    });
});

// ─── Key Hashing ───

describe('API Key — Hashing', () => {
    it('is deterministic', () => {
        const key = 'iflk_test123456789abcdef';
        expect(hashApiKey(key)).toBe(hashApiKey(key));
    });

    it('produces different hashes for different keys', () => {
        expect(hashApiKey('iflk_key1')).not.toBe(hashApiKey('iflk_key2'));
    });
});

// ─── Bearer Token Extraction ───

describe('API Key — extractBearerToken', () => {
    it('extracts token from valid Bearer header', () => {
        expect(extractBearerToken('Bearer iflk_abc123')).toBe('iflk_abc123');
    });

    it('returns null for missing header', () => {
        expect(extractBearerToken(null)).toBeNull();
        expect(extractBearerToken(undefined)).toBeNull();
    });

    it('returns null for non-Bearer auth', () => {
        expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBeNull();
    });

    it('is case-insensitive for "Bearer"', () => {
        expect(extractBearerToken('bearer iflk_abc')).toBe('iflk_abc');
    });

    it('returns null for malformed header', () => {
        expect(extractBearerToken('Bearer')).toBeNull();
        expect(extractBearerToken('Bearer a b')).toBeNull();
    });
});

// ─── isApiKeyToken ───

describe('API Key — isApiKeyToken', () => {
    it('returns true for API key tokens', () => {
        expect(isApiKeyToken('iflk_abc123')).toBe(true);
    });

    it('returns false for JWT tokens', () => {
        expect(isApiKeyToken('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')).toBe(false);
    });
});

// ─── Key Verification ───

describe('API Key — Verification', () => {
    const MOCK_TENANT = {
        id: 'tenant-1',
        name: 'Acme',
        slug: 'acme-co',
    };

    function makeMockApiKey(overrides: Record<string, unknown> = {}) {
        const { plaintext, keyHash } = generateApiKey();
        return {
            plaintext,
            record: {
                id: 'ak-1',
                tenantId: 'tenant-1',
                name: 'CI/CD Key',
                keyPrefix: 'iflk_test',
                keyHash,
                scopes: [],
                expiresAt: null,
                revokedAt: null,
                lastUsedAt: null,
                lastUsedIp: null,
                createdById: 'user-1',
                createdAt: new Date(),
                updatedAt: new Date(),
                tenant: MOCK_TENANT,
                ...overrides,
            },
        };
    }

    it('authenticates a valid API key', async () => {
        const { plaintext, record } = makeMockApiKey();
        mockPrisma.tenantApiKey.findUnique.mockResolvedValue(record);

        const result = await verifyApiKey(plaintext);

        expect(result.valid).toBe(true);
        if (result.valid) {
            expect(result.ctx.tenantId).toBe('tenant-1');
            expect(result.ctx.tenantSlug).toBe('acme-co');
            expect(result.ctx.apiKeyId).toBe('ak-1');
            expect(result.ctx.userId).toBe('user-1');
        }
    });

    it('rejects expired key', async () => {
        const { plaintext, record } = makeMockApiKey({
            expiresAt: new Date(Date.now() - 1000), // 1 second ago
        });
        mockPrisma.tenantApiKey.findUnique.mockResolvedValue(record);

        const result = await verifyApiKey(plaintext);

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.reason).toBe('expired');
        }
    });

    it('rejects revoked key', async () => {
        const { plaintext, record } = makeMockApiKey({
            revokedAt: new Date(),
        });
        mockPrisma.tenantApiKey.findUnique.mockResolvedValue(record);

        const result = await verifyApiKey(plaintext);

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.reason).toBe('revoked');
        }
    });

    it('rejects a key whose TENANT has been soft-deleted', async () => {
        // This path deliberately skips `resolveTenantContext`, which is where
        // `deletedAt` is otherwise enforced and which its own docstring calls
        // "the single authoritative gate". For a key caller it is not one, so
        // the check has to be repeated in verifyApiKey.
        //
        // `deleteTenantUnderOrg` soft-deletes a tenant and does NOT revoke its
        // TenantApiKey rows, so without this an offboarded customer's
        // integration key keeps reading and writing every tenant route — while
        // that usecase's docstring says the tenant becomes "inaccessible
        // immediately, everywhere".
        const { plaintext, record } = makeMockApiKey({
            tenant: { ...MOCK_TENANT, deletedAt: new Date('2026-01-01') },
        });
        mockPrisma.tenantApiKey.findUnique.mockResolvedValue(record);

        const result = await verifyApiKey(plaintext);

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.reason).toBe('tenant_deleted');
        }
    });

    it('rejects unknown key (not found)', async () => {
        mockPrisma.tenantApiKey.findUnique.mockResolvedValue(null);

        const result = await verifyApiKey('iflk_unknown_key_that_does_not_exist');

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.reason).toBe('not_found');
        }
    });

    it('rejects non-API-key format', async () => {
        const result = await verifyApiKey('not_an_api_key');

        expect(result.valid).toBe(false);
        if (!result.valid) {
            expect(result.reason).toBe('invalid_format');
        }
        // Should NOT hit the database
        expect(mockPrisma.tenantApiKey.findUnique).not.toHaveBeenCalled();
    });

    it('accepts key with null expiresAt (no expiry)', async () => {
        const { plaintext, record } = makeMockApiKey({ expiresAt: null });
        mockPrisma.tenantApiKey.findUnique.mockResolvedValue(record);

        const result = await verifyApiKey(plaintext);
        expect(result.valid).toBe(true);
    });

    it('accepts key with future expiresAt', async () => {
        const { plaintext, record } = makeMockApiKey({
            expiresAt: new Date(Date.now() + 86400 * 1000), // 1 day from now
        });
        mockPrisma.tenantApiKey.findUnique.mockResolvedValue(record);

        const result = await verifyApiKey(plaintext);
        expect(result.valid).toBe(true);
    });

    it('updates lastUsedAt on successful auth', async () => {
        const { plaintext, record } = makeMockApiKey();
        mockPrisma.tenantApiKey.findUnique.mockResolvedValue(record);

        await verifyApiKey(plaintext, '1.2.3.4');

        // Wait a tick for the fire-and-forget update
        await new Promise((r) => setTimeout(r, 50));

        expect(mockPrisma.tenantApiKey.update).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'ak-1' },
                data: expect.objectContaining({
                    lastUsedAt: expect.any(Date),
                    lastUsedIp: '1.2.3.4',
                }),
            }),
        );
    });

    it('does not call update on failed auth', async () => {
        mockPrisma.tenantApiKey.findUnique.mockResolvedValue(null);

        await verifyApiKey('iflk_nonexistent_key');

        await new Promise((r) => setTimeout(r, 50));
        expect(mockPrisma.tenantApiKey.update).not.toHaveBeenCalled();
    });
});

// ─── Hashed Storage Integrity ───

describe('API Key — Hash Storage Integrity', () => {
    it('only the hash is stored, never the plaintext', () => {
        const { plaintext, keyHash } = generateApiKey();
        // Hash is a 64-char hex string
        expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
        // Hash can't be reversed to plaintext
        expect(keyHash).not.toContain(plaintext);
        // Re-hashing plaintext produces the same hash (verifiable)
        expect(hashApiKey(plaintext)).toBe(keyHash);
    });
});
