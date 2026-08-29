/**
 * SSO Configuration Schema Validation Tests
 *
 * Tests Zod schemas for tenant identity provider configuration,
 * ensuring valid SAML/OIDC configs are accepted and invalid ones rejected.
 */
import {
    UpsertSsoConfigInput,
    SamlConfigSchema,
    OidcConfigSchema,
    IdentityProviderTypeSchema,
} from '../../src/app-layer/schemas/sso-config.schemas';

describe('SSO Config Schemas', () => {
    // ─── IdentityProviderType ────────────────────────────────────────

    describe('IdentityProviderType', () => {
        it('accepts SAML', () => {
            expect(IdentityProviderTypeSchema.parse('SAML')).toBe('SAML');
        });

        it('accepts OIDC', () => {
            expect(IdentityProviderTypeSchema.parse('OIDC')).toBe('OIDC');
        });

        it('rejects invalid type', () => {
            expect(() => IdentityProviderTypeSchema.parse('LDAP')).toThrow();
        });
    });

    // ─── SAML Config ─────────────────────────────────────────────────

    describe('SamlConfigSchema', () => {
        it('REJECTS config with metadataUrl alone — it is reference-only, never fetched', () => {
            const result = SamlConfigSchema.safeParse({
                metadataUrl: 'https://idp.example.com/metadata',
            });
            expect(result.success).toBe(false);
        });

        it('accepts config with entityId + ssoUrl + certificate', () => {
            const result = SamlConfigSchema.safeParse({
                entityId: 'https://idp.example.com',
                ssoUrl: 'https://idp.example.com/sso',
                certificate: 'MIICzjCCAb...',
            });
            expect(result.success).toBe(true);
        });

        it('rejects config with neither metadataUrl nor required manual fields', () => {
            const result = SamlConfigSchema.safeParse({
                entityId: 'https://idp.example.com',
                // missing ssoUrl and certificate
            });
            expect(result.success).toBe(false);
        });

        it('rejects invalid metadataUrl', () => {
            const result = SamlConfigSchema.safeParse({
                entityId: 'https://idp.example.com',
                ssoUrl: 'https://idp.example.com/sso',
                certificate: 'MIICzjCCAb...',
                metadataUrl: 'not-a-url',
            });
            expect(result.success).toBe(false);
        });

        it('defaults signRequests to false', () => {
            const result = SamlConfigSchema.parse({
                entityId: 'https://idp.example.com',
                ssoUrl: 'https://idp.example.com/sso',
                certificate: 'MIICzjCCAb...',
            });
            expect(result.signRequests).toBe(false);
        });
    });

    // ─── OIDC Config ─────────────────────────────────────────────────

    describe('OidcConfigSchema', () => {
        const validOidc = {
            issuer: 'https://login.example.com',
            clientId: 'client-123',
            clientSecret: 'secret-456',
        };

        it('accepts valid OIDC config', () => {
            const result = OidcConfigSchema.safeParse(validOidc);
            expect(result.success).toBe(true);
        });

        it('defaults scopes to openid email profile', () => {
            const result = OidcConfigSchema.parse(validOidc);
            expect(result.scopes).toEqual(['openid', 'email', 'profile']);
        });

        it('accepts custom scopes', () => {
            const result = OidcConfigSchema.parse({
                ...validOidc,
                scopes: ['openid', 'email', 'groups'],
            });
            expect(result.scopes).toEqual(['openid', 'email', 'groups']);
        });

        it('rejects missing issuer', () => {
            const result = OidcConfigSchema.safeParse({
                clientId: 'client-123',
                clientSecret: 'secret-456',
            });
            expect(result.success).toBe(false);
        });

        it('rejects missing clientId', () => {
            const result = OidcConfigSchema.safeParse({
                issuer: 'https://login.example.com',
                clientSecret: 'secret-456',
            });
            expect(result.success).toBe(false);
        });

        it('rejects missing clientSecret', () => {
            const result = OidcConfigSchema.safeParse({
                issuer: 'https://login.example.com',
                clientId: 'client-123',
            });
            expect(result.success).toBe(false);
        });
    });

    // ─── UpsertSsoConfigInput ────────────────────────────────────────

    describe('UpsertSsoConfigInput', () => {
        it('accepts valid SAML input', () => {
            const result = UpsertSsoConfigInput.safeParse({
                name: 'Okta SSO',
                type: 'SAML',
                config: {
                    entityId: 'https://okta.example.com',
                    ssoUrl: 'https://okta.example.com/sso',
                    certificate: 'MIICzjCCAb...',
                    metadataUrl: 'https://okta.example.com/metadata',
                },
            });
            expect(result.success).toBe(true);
        });

        it('rejects SAML input whose config is metadataUrl-only', () => {
            const result = UpsertSsoConfigInput.safeParse({
                name: 'Okta SSO',
                type: 'SAML',
                config: {
                    metadataUrl: 'https://okta.example.com/metadata',
                },
            });
            expect(result.success).toBe(false);
        });

        it('accepts valid OIDC input', () => {
            const result = UpsertSsoConfigInput.safeParse({
                name: 'Azure AD',
                type: 'OIDC',
                config: {
                    issuer: 'https://login.microsoftonline.com/tenant-id/v2.0',
                    clientId: 'client-123',
                    clientSecret: 'secret-456',
                },
            });
            expect(result.success).toBe(true);
        });

        it('rejects OIDC input with SAML config', () => {
            const result = UpsertSsoConfigInput.safeParse({
                name: 'Azure AD',
                type: 'OIDC',
                config: {
                    metadataUrl: 'https://okta.example.com/metadata',
                    // Missing OIDC fields
                },
            });
            expect(result.success).toBe(false);
        });

        it('rejects empty name', () => {
            const result = UpsertSsoConfigInput.safeParse({
                name: '',
                type: 'SAML',
                config: { entityId: 'https://idp.example.com', ssoUrl: 'https://idp.example.com/sso', certificate: 'MIICzjCCAb...' },
            });
            expect(result.success).toBe(false);
        });

        it('validates email domains format', () => {
            const result = UpsertSsoConfigInput.safeParse({
                name: 'Okta',
                type: 'SAML',
                emailDomains: ['acme.com', 'acme.io'],
                config: { entityId: 'https://idp.example.com', ssoUrl: 'https://idp.example.com/sso', certificate: 'MIICzjCCAb...' },
            });
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.emailDomains).toEqual(['acme.com', 'acme.io']);
            }
        });

        it('rejects invalid email domain format', () => {
            const result = UpsertSsoConfigInput.safeParse({
                name: 'Okta',
                type: 'SAML',
                emailDomains: ['@invalid', ''],
                config: { entityId: 'https://idp.example.com', ssoUrl: 'https://idp.example.com/sso', certificate: 'MIICzjCCAb...' },
            });
            expect(result.success).toBe(false);
        });

        it('lowercases email domains', () => {
            const result = UpsertSsoConfigInput.parse({
                name: 'Okta',
                type: 'SAML',
                emailDomains: ['ACME.COM'],
                config: { entityId: 'https://idp.example.com', ssoUrl: 'https://idp.example.com/sso', certificate: 'MIICzjCCAb...' },
            });
            expect(result.emailDomains).toEqual(['acme.com']);
        });

        it('defaults isEnabled and isEnforced to false', () => {
            const result = UpsertSsoConfigInput.parse({
                name: 'Okta',
                type: 'SAML',
                config: { entityId: 'https://idp.example.com', ssoUrl: 'https://idp.example.com/sso', certificate: 'MIICzjCCAb...' },
            });
            expect(result.isEnabled).toBe(false);
            expect(result.isEnforced).toBe(false);
        });

        it('accepts an id for update operations', () => {
            const result = UpsertSsoConfigInput.safeParse({
                id: 'clxyz123456789',
                name: 'Okta Updated',
                type: 'SAML',
                config: { entityId: 'https://idp.example.com', ssoUrl: 'https://idp.example.com/sso', certificate: 'MIICzjCCAb...' },
            });
            expect(result.success).toBe(true);
        });
    });
});
