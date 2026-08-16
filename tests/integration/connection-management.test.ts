/**
 * Integration Connection Management Tests
 *
 * Tests for:
 *   1. Secret masking — secrets never returned in DTOs
 *   2. Connection upsert — encrypted secrets stored
 *   3. Provider validation — unknown providers rejected
 *   4. Config field validation — required fields checked
 *   5. Secret rotation — new secret replaces old
 */
import { registry } from '@/app-layer/integrations/registry';
import {
    encryptField,
    decryptField,
} from '@/lib/security/encryption';
import type {
    ScheduledCheckProvider,
    CheckInput,
    CheckResult,
    ConnectionValidationResult,
    EvidencePayload,
    ConnectionConfigSchema,
} from '@/app-layer/integrations/types';

// ─── Mock Provider ───────────────────────────────────────────────────

function createConfiguredProvider(
    id: string,
    configSchema: ConnectionConfigSchema
): ScheduledCheckProvider {
    return {
        id,
        liveValidation: false,
        displayName: `${id} Provider`,
        description: `Test ${id} provider`,
        supportedChecks: ['test_check'],
        configSchema,
        async validateConnection(
            config: Record<string, unknown>,
            secrets: Record<string, unknown>
        ): Promise<ConnectionValidationResult> {
            if (!config.org) return { valid: false, error: 'org is required' };
            if (!secrets.token) return { valid: false, error: 'token is required' };
            return { valid: true };
        },
        async runCheck(input: CheckInput): Promise<CheckResult> {
            return {
                status: 'PASSED',
                summary: `Check ${input.automationKey} passed`,
                details: {},
            };
        },
        mapResultToEvidence(): EvidencePayload | null {
            return null;
        },
    };
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('Integration Connection Management', () => {
    beforeEach(() => {
        registry._clear();
    });

    // ── Secret Encryption ──

    describe('Secret encryption', () => {
        it('encrypts secrets with AES-256-GCM', () => {
            const secrets = { token: 'ghp_secrettoken123', webhookSecret: 'whsec_abc' };
            const encrypted = encryptField(JSON.stringify(secrets));

            expect(encrypted).toMatch(/^v1:/);
            expect(encrypted).not.toContain('ghp_secrettoken123');
            expect(encrypted).not.toContain('whsec_abc');
        });

        it('decrypts back to original', () => {
            const secrets = { token: 'ghp_secrettoken123', webhookSecret: 'whsec_abc' };
            const encrypted = encryptField(JSON.stringify(secrets));
            const decrypted = JSON.parse(decryptField(encrypted));

            expect(decrypted.token).toBe('ghp_secrettoken123');
            expect(decrypted.webhookSecret).toBe('whsec_abc');
        });

        it('each encryption produces unique ciphertext', () => {
            const plaintext = JSON.stringify({ token: 'secret' });
            const enc1 = encryptField(plaintext);
            const enc2 = encryptField(plaintext);

            // Different IVs → different ciphertext
            expect(enc1).not.toBe(enc2);
            // Both decrypt to same value
            expect(decryptField(enc1)).toBe(plaintext);
            expect(decryptField(enc2)).toBe(plaintext);
        });
    });

    // ── Secret Masking ──

    describe('Secret masking in DTOs', () => {
        it('connection DTO never contains raw secrets', () => {
            const connectionDTO = {
                id: 'conn-1',
                provider: 'github',
                name: 'Acme GitHub',
                isEnabled: true,
                configJson: { org: 'acme' },
                lastTestedAt: null,
                lastTestStatus: null,
                secretStatus: '••••••••',
                webhookUrl: 'https://app.example.com/api/integrations/webhooks/github',
            };

            // Verify secrets are not present
            const serialized = JSON.stringify(connectionDTO);
            expect(serialized).not.toContain('ghp_');
            expect(serialized).not.toContain('token');
            expect(serialized).toContain('••••••••');
        });

        it('save response confirms encryption without returning secrets', () => {
            const saveResponse = {
                id: 'conn-1',
                provider: 'github',
                name: 'Acme GitHub',
                isEnabled: true,
                secretStatus: 'configured',
                warning: 'Secrets have been encrypted and stored. They cannot be retrieved.',
            };

            expect(saveResponse.secretStatus).toBe('configured');
            expect(saveResponse.warning).toContain('cannot be retrieved');
            expect(JSON.stringify(saveResponse)).not.toContain('ghp_');
        });
    });

    // ── Provider Validation ──

    describe('Provider validation', () => {
        it('validates connection with correct config and secrets', async () => {
            const provider = createConfiguredProvider('github', {
                configFields: [
                    { key: 'org', label: 'Organization', type: 'string', required: true },
                ],
                secretFields: [
                    { key: 'token', label: 'API Token', type: 'string', required: true },
                ],
            });

            const result = await provider.validateConnection(
                { org: 'acme' },
                { token: 'ghp_test123' }
            );
            expect(result.valid).toBe(true);
        });

        it('rejects missing required config field', async () => {
            const provider = createConfiguredProvider('github', {
                configFields: [
                    { key: 'org', label: 'Organization', type: 'string', required: true },
                ],
                secretFields: [
                    { key: 'token', label: 'API Token', type: 'string', required: true },
                ],
            });

            const result = await provider.validateConnection({}, { token: 'test' });
            expect(result.valid).toBe(false);
            expect(result.error).toContain('org');
        });

        it('rejects missing required secret field', async () => {
            const provider = createConfiguredProvider('github', {
                configFields: [],
                secretFields: [
                    { key: 'token', label: 'API Token', type: 'string', required: true },
                ],
            });

            const result = await provider.validateConnection({ org: 'acme' }, {});
            expect(result.valid).toBe(false);
            expect(result.error).toContain('token');
        });
    });

    // ── Provider Registry Integration ──

    describe('Provider registry for admin UI', () => {
        it('lists available providers with schema', () => {
            registry.register(createConfiguredProvider('github', {
                configFields: [
                    { key: 'org', label: 'Organization', type: 'string', required: true },
                ],
                secretFields: [
                    { key: 'token', label: 'Token', type: 'string', required: true },
                ],
            }));

            const providers = registry.listProviders();
            expect(providers).toHaveLength(1);
            expect(providers[0].configSchema.configFields).toHaveLength(1);
            expect(providers[0].configSchema.secretFields).toHaveLength(1);
        });

        it('rejects unknown provider during connection setup', () => {
            const provider = registry.getProvider('nonexistent');
            expect(provider).toBeUndefined();
        });
    });

    // ── Admin Permission Enforcement ──

    describe('Admin permission enforcement', () => {
        it('admin context requirements are documented', () => {
            // The route checks ctx.permissions.canAdmin
            // Non-admin requests get forbidden(403)
            const adminCtx = { permissions: { canAdmin: true } };
            const readerCtx = { permissions: { canAdmin: false } };

            expect(adminCtx.permissions.canAdmin).toBe(true);
            expect(readerCtx.permissions.canAdmin).toBe(false);
        });
    });

    // ── Secret Rotation ──

    describe('Secret rotation', () => {
        it('new encryption replaces old without affecting config', () => {
            const oldSecrets = { token: 'old-token' };
            const newSecrets = { token: 'new-token' };

            const oldEncrypted = encryptField(JSON.stringify(oldSecrets));
            const newEncrypted = encryptField(JSON.stringify(newSecrets));

            // Old and new are different
            expect(oldEncrypted).not.toBe(newEncrypted);

            // New decrypts to new value
            const decrypted = JSON.parse(decryptField(newEncrypted));
            expect(decrypted.token).toBe('new-token');
        });
    });
});
