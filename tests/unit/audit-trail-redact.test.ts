/**
 * Unit tests for audit-redact.ts — sensitive field redaction and blob summarization.
 *
 * RUN: npx jest tests/unit/audit-trail-redact.test.ts
 */
import {
    isSensitiveField,
    isBlobField,
    redactSensitiveFields,
    extractChangedFields,
} from '@/lib/audit-redact';

describe('Audit Redaction — isSensitiveField', () => {
    const SENSITIVE = [
        'password',
        'passwordHash',
        'token',
        'accessToken',
        'refreshToken',
        'access_token',
        'refresh_token',
        'apiKey',
        'api_key',
        'secret',
        'AUTH_SECRET',
        'credential',
        'credentialsEncrypted',
        'authorization',
        'privateKey',
        'private_key',
        'encryptionKey',
        'cookie',
        'salt',
        'ssn',
    ];

    it.each(SENSITIVE)('detects "%s" as sensitive', (field) => {
        expect(isSensitiveField(field)).toBe(true);
    });

    const NOT_SENSITIVE = [
        'title',
        'name',
        'email',
        'tenantId',
        'status',
        'score',
        'inherentScore',
        'createdAt',
        'updatedAt',
        'description',
    ];

    it.each(NOT_SENSITIVE)('does NOT detect "%s" as sensitive', (field) => {
        expect(isSensitiveField(field)).toBe(false);
    });
});

describe('Audit Redaction — isBlobField', () => {
    it('detects contentText as blob', () => {
        expect(isBlobField('contentText')).toBe(true);
    });

    it('detects bodyHtml as blob', () => {
        expect(isBlobField('bodyHtml')).toBe(true);
    });

    it('does not detect title as blob', () => {
        expect(isBlobField('title')).toBe(false);
    });
});

describe('Audit Redaction — redactSensitiveFields', () => {
    it('returns null for null input', () => {
        expect(redactSensitiveFields(null)).toBeNull();
    });

    it('returns null for undefined input', () => {
        expect(redactSensitiveFields(undefined)).toBeNull();
    });

    it('redacts password fields', () => {
        const result = redactSensitiveFields({
            name: 'Alice',
            password: 'super-secret-123', // pragma: allowlist secret — test-only redaction input
        });
        expect(result).toEqual({
            name: 'Alice',
            password: '[REDACTED]',
        });
    });

    it('redacts token fields', () => {
        const result = redactSensitiveFields({
            accessToken: 'eyJhbG...',
            refreshToken: 'dGhpcyBpcyBh...',
            email: 'alice@test.com',
        });
        expect(result).toEqual({
            accessToken: '[REDACTED]',
            refreshToken: '[REDACTED]',
            email: 'alice@test.com',
        });
    });

    it('redacts apiKey and secret fields', () => {
        const result = redactSensitiveFields({
            apiKey: 'sk_live_abc123',
            secret: 'very-secret',
            name: 'Webhook',
        });
        expect(result).toEqual({
            apiKey: '[REDACTED]',
            secret: '[REDACTED]',
            name: 'Webhook',
        });
    });

    it('summarizes large strings (>2KB) as blobs', () => {
        const largeContent = 'x'.repeat(3000);
        const result = redactSensitiveFields({
            title: 'Short',
            description: largeContent,
        });
        expect(result!.title).toBe('Short');
        expect(result!.description).toMatch(/^\[BLOB len=3000 sha256=[a-f0-9]+\.\.\.\]$/);
    });

    it('summarizes blobs by field name even if short', () => {
        const result = redactSensitiveFields({
            contentText: 'short content',
        });
        expect(result!.contentText).toMatch(/^\[BLOB len=\d+ sha256=[a-f0-9]+\.\.\.\]$/);
    });

    it('handles nested objects recursively', () => {
        const result = redactSensitiveFields({
            user: {
                name: 'Alice',
                password: 'my-pass',
            },
        });
        expect(result!.user).toEqual({
            name: 'Alice',
            password: '[REDACTED]',
        });
    });

    it('truncates deeply nested objects at depth 3', () => {
        const result = redactSensitiveFields({
            l1: { l2: { l3: { l4: { deep: 'value' } } } },
        });
        expect(result!.l1!.l2!.l3!.l4).toEqual({ _truncated: true });
    });

    it('summarizes arrays without expanding them', () => {
        const result = redactSensitiveFields({
            tags: ['a', 'b', 'c'],
            name: 'Test',
        });
        expect(result!.tags).toBe('[Array len=3]');
        expect(result!.name).toBe('Test');
    });

    it('preserves null values', () => {
        const result = redactSensitiveFields({
            title: 'Test',
            description: null,
        });
        expect(result!.description).toBeNull();
    });

    it('preserves numeric and boolean values', () => {
        const result = redactSensitiveFields({
            score: 42,
            active: true,
        });
        expect(result).toEqual({ score: 42, active: true });
    });

    it('serializes Date objects to ISO strings', () => {
        const date = new Date('2025-01-01T00:00:00Z');
        const result = redactSensitiveFields({ createdAt: date });
        expect(result!.createdAt).toBe('2025-01-01T00:00:00.000Z');
    });

    it('skips internal Prisma fields starting with _', () => {
        const result = redactSensitiveFields({
            title: 'Test',
            _count: { risks: 5 },
        });
        expect(result).toEqual({ title: 'Test' });
        expect('_count' in result!).toBe(false);
    });

    it('combined scenario: mixed sensitive, blob, and normal fields', () => {
        const result = redactSensitiveFields({
            name: 'API Integration',
            apiKey: 'sk_live_xxx',
            token: 'bearer_yyy',
            description: 'Normal text',
            contentText: 'Some HTML body',
            score: 85,
        });
        expect(result!.name).toBe('API Integration');
        expect(result!.apiKey).toBe('[REDACTED]');
        expect(result!.token).toBe('[REDACTED]');
        expect(result!.description).toBe('Normal text');
        expect(result!.contentText).toMatch(/^\[BLOB/);
        expect(result!.score).toBe(85);
    });
});

describe('Audit Redaction — extractChangedFields', () => {
    it('returns empty array for null', () => {
        expect(extractChangedFields(null)).toEqual([]);
    });

    it('returns empty array for undefined', () => {
        expect(extractChangedFields(undefined)).toEqual([]);
    });

    it('returns field names from data object', () => {
        const fields = extractChangedFields({ title: 'New', score: 5 });
        expect(fields).toEqual(['title', 'score']);
    });

    it('filters out internal fields starting with _', () => {
        const fields = extractChangedFields({ title: 'New', _count: 1 });
        expect(fields).toEqual(['title']);
    });
});
