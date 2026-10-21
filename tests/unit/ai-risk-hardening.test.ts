/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
/**
 * AI Risk Assessment — Enterprise Hardening Tests
 *
 * Tests: privacy sanitizer, rate limiter, feature gate.
 */
/*
    THE GATE READS THE DATABASE NOW, so this unit needs the seam.

    `enforceFeatureGate` checks the tenant's four AI toggles through
    `runInTenantContext`, which is a real transaction. Without this mock the
    cases below reach the live pool, and under contention the read fails with
    "Unable to start a transaction in the given time" — whereupon the gate
    FAILS CLOSED and refuses, which looks exactly like a broken feature gate
    rather than an absent mock.

    `findUnique` resolving to `null` is the right default here: no settings row
    means "never configured", the four columns default to true, and all-on is
    the state every case in this file assumes.
*/
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({ tenantSecuritySettings: { findUnique: async () => null } }),
}));

import { sanitizeAsset, sanitizeProviderInput, describePayload } from '@/app-layer/ai/risk-assessment/privacy-sanitizer';
import { checkRateLimit, recordGeneration, getUsageInfo, _resetForTesting, LIMITS } from '@/app-layer/ai/risk-assessment/rate-limiter';
import { checkFeatureGate, enforceFeatureGate, isAIRiskEnabled } from '@/app-layer/ai/risk-assessment/feature-gate';
import type { RiskAssessmentInput, RiskAssessmentAsset } from '@/app-layer/ai/risk-assessment/types';
import type { RequestContext } from '@/app-layer/types';
import { AppError } from '@/lib/errors/types';
import { getPermissionsForRole } from '@/lib/permissions';

// ─── Test Helpers ───

function makeCtx(overrides: Partial<RequestContext> = {}): RequestContext {
    return {
        requestId: 'test-req-1',
        userId: 'user-1',
        tenantId: 'tenant-1',
        tenantSlug: 'acme',
        role: 'ADMIN',
        permissions: {
            canRead: true,
            canWrite: true,
            canAdmin: true,
            canAudit: false,
            canExport: false,
        },
        appPermissions: getPermissionsForRole((overrides.role ?? 'ADMIN') as any),
        ...overrides,
    };
}

// ─── Privacy Sanitizer Tests ───

describe('Privacy Sanitizer', () => {
    const fullAsset: RiskAssessmentAsset = {
        id: 'uuid-secret-12345',
        name: 'Customer Database',
        type: 'DATA_STORE',
        criticality: 'HIGH',
        classification: 'CONFIDENTIAL',
        confidentiality: 5,
        integrity: 4,
        availability: 3,
    };

    describe('sanitizeAsset', () => {
        it('strips internal ID', () => {
            const sanitized = sanitizeAsset(fullAsset);
            expect(sanitized.id).toBe('');
        });

        it('preserves name and type', () => {
            const sanitized = sanitizeAsset(fullAsset);
            expect(sanitized.name).toBe('Customer Database');
            expect(sanitized.type).toBe('DATA_STORE');
        });

        it('preserves criticality', () => {
            const sanitized = sanitizeAsset(fullAsset);
            expect(sanitized.criticality).toBe('HIGH');
        });

        it('strips classification (may reveal data categories)', () => {
            const sanitized = sanitizeAsset(fullAsset);
            expect(sanitized.classification).toBeNull();
        });

        it('strips CIA scores', () => {
            const sanitized = sanitizeAsset(fullAsset);
            expect(sanitized.confidentiality).toBeNull();
            expect(sanitized.integrity).toBeNull();
            expect(sanitized.availability).toBeNull();
        });

        it('truncates long names', () => {
            const longAsset = { ...fullAsset, name: 'A'.repeat(500) };
            const sanitized = sanitizeAsset(longAsset);
            expect(sanitized.name.length).toBeLessThanOrEqual(200);
        });

        it('strips control characters from name', () => {
            const dirtyAsset = { ...fullAsset, name: 'DB\x00\x01\x02Server' };
            const sanitized = sanitizeAsset(dirtyAsset);
            expect(sanitized.name).toBe('DBServer');
        });
    });

    describe('sanitizeProviderInput', () => {
        it('sanitizes all assets in the input', () => {
            const input: RiskAssessmentInput = {
                frameworks: ['ISO27001'],
                assets: [fullAsset, { ...fullAsset, id: 'other-id', name: 'API Gateway' }],
                tenantIndustry: 'Financial Services',
                tenantContext: 'PCI-DSS scope',
                existingControls: ['MFA', 'Encryption'],
                maxRiskScale: 5,
            };

            const sanitized = sanitizeProviderInput(input);

            // All asset IDs should be stripped
            for (const a of sanitized.assets) {
                expect(a.id).toBe('');
                expect(a.classification).toBeNull();
                expect(a.confidentiality).toBeNull();
            }

            // Other fields preserved
            expect(sanitized.frameworks).toEqual(['ISO27001']);
            expect(sanitized.tenantIndustry).toBe('Financial Services');
            expect(sanitized.tenantContext).toBe('PCI-DSS scope');
            expect(sanitized.existingControls).toEqual(['MFA', 'Encryption']);
        });

        it('truncates context to 2000 chars', () => {
            const input: RiskAssessmentInput = {
                frameworks: [],
                assets: [],
                tenantContext: 'X'.repeat(3000),
            };
            const sanitized = sanitizeProviderInput(input);
            expect(sanitized.tenantContext!.length).toBeLessThanOrEqual(2000);
        });

        it('limits controls to 50', () => {
            const input: RiskAssessmentInput = {
                frameworks: [],
                assets: [],
                existingControls: Array.from({ length: 100 }, (_, i) => `Control ${i}`),
            };
            const sanitized = sanitizeProviderInput(input);
            expect(sanitized.existingControls!.length).toBeLessThanOrEqual(50);
        });

        it('handles null/undefined industry and context', () => {
            const input: RiskAssessmentInput = {
                frameworks: ['SOC2'],
                assets: [],
            };
            const sanitized = sanitizeProviderInput(input);
            expect(sanitized.tenantIndustry).toBeNull();
            expect(sanitized.tenantContext).toBeNull();
        });
    });

    describe('describePayload', () => {
        it('summarizes payload for audit logging', () => {
            const input: RiskAssessmentInput = {
                frameworks: ['ISO27001', 'NIS2'],
                assets: [
                    { id: '1', name: 'App', type: 'APPLICATION' },
                    { id: '2', name: 'DB', type: 'DATA_STORE' },
                ],
                tenantIndustry: 'Healthcare',
                tenantContext: 'HIPAA scope',
                existingControls: ['MFA', 'DLP', 'SIEM'],
            };

            const desc = describePayload(input);
            expect(desc).toContain('ISO27001');
            expect(desc).toContain('2'); // 2 assets
            expect(desc).toContain('Healthcare');
            expect(desc).toContain('3'); // 3 controls
        });
    });
});

// ─── Rate Limiter Tests ───

describe('Rate Limiter', () => {
    beforeEach(() => {
        _resetForTesting();
    });

    it('allows requests within limits', async () => {
        await expect(checkRateLimit('tenant-1', 'user-1')).resolves.toBeUndefined();
    });

    it('throws 429 when user per-minute limit exceeded', async () => {
        // Record enough to exceed per-minute limit
        for (let i = 0; i < LIMITS.USER_PER_MINUTE_LIMIT; i++) {
            await recordGeneration('tenant-1', 'user-1');
        }

        await expect(checkRateLimit('tenant-1', 'user-1')).rejects.toThrow(AppError);
        try {
            await checkRateLimit('tenant-1', 'user-1');
        } catch (e) {
            expect(e).toBeInstanceOf(AppError);
            expect((e as AppError).status).toBe(429);
            expect((e as AppError).code).toBe('RATE_LIMITED');
        }
    });

    it('allows different users to have separate limits', async () => {
        // Exhaust user-1's limit
        for (let i = 0; i < LIMITS.USER_PER_MINUTE_LIMIT; i++) {
            await recordGeneration('tenant-1', 'user-1');
        }

        // user-2 should still be allowed
        await expect(checkRateLimit('tenant-1', 'user-2')).resolves.toBeUndefined();
    });

    it('throws 429 when tenant daily quota exceeded', async () => {
        // Record enough to exceed daily quota
        for (let i = 0; i < LIMITS.TENANT_DAILY_QUOTA; i++) {
            await recordGeneration('tenant-1', `user-${i}`);
        }

        await expect(checkRateLimit('tenant-1', 'user-new')).rejects.toThrow(AppError);
        try {
            await checkRateLimit('tenant-1', 'user-new');
        } catch (e) {
            expect(e).toBeInstanceOf(AppError);
            expect((e as AppError).status).toBe(429);
            expect((e as AppError).message).toContain('daily limit');
        }
    });

    it('different tenants have independent quotas', async () => {
        for (let i = 0; i < LIMITS.TENANT_DAILY_QUOTA; i++) {
            await recordGeneration('tenant-1', `user-${i}`);
        }

        // tenant-2 should still be allowed
        await expect(checkRateLimit('tenant-2', 'user-1')).resolves.toBeUndefined();
    });

    it('returns correct usage info', async () => {
        await recordGeneration('tenant-1', 'user-1');
        await recordGeneration('tenant-1', 'user-2');

        const usage = await getUsageInfo('tenant-1');
        expect(usage.used).toBe(2);
        expect(usage.limit).toBe(LIMITS.TENANT_DAILY_QUOTA);
        expect(usage.resetAt).not.toBeNull();
    });

    it('returns zero usage for unknown tenant', async () => {
        const usage = await getUsageInfo('unknown-tenant');
        expect(usage.used).toBe(0);
    });
});

// ─── Feature Gate Tests ───

describe('Feature Gate', () => {
    it('allows admin users', () => {
        const ctx = makeCtx({ role: 'ADMIN' });
        const result = checkFeatureGate(ctx);
        expect(result.allowed).toBe(true);
    });

    it('allows editor users', () => {
        const ctx = makeCtx({
            role: 'EDITOR',
            permissions: { canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: false },
        });
        const result = checkFeatureGate(ctx);
        expect(result.allowed).toBe(true);
    });

    it('blocks reader users', () => {
        const ctx = makeCtx({
            role: 'READER',
            permissions: { canRead: true, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
        });
        const result = checkFeatureGate(ctx);
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('Editor or Admin');
    });

    it('blocks auditor users', () => {
        const ctx = makeCtx({
            role: 'AUDITOR',
            permissions: { canRead: true, canWrite: false, canAdmin: false, canAudit: true, canExport: true },
        });
        const result = checkFeatureGate(ctx);
        expect(result.allowed).toBe(false);
    });

    it('enforceFeatureGate throws for blocked users', () => {
        const ctx = makeCtx({
            role: 'READER',
            permissions: { canRead: true, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
        });
        // SYNCHRONOUSLY. A role refusal needs no I/O, so it is thrown from the
        // gate's synchronous prologue even though the gate also has database
        // predicates now — see "a forgotten `await` can never weaken the gate"
        // in feature-gate-plan-entitlement for why that split is deliberate.
        expect(() => enforceFeatureGate(ctx)).toThrow(AppError);
        try {
            enforceFeatureGate(ctx);
        } catch (e) {
            expect((e as AppError).status).toBe(403);
        }
    });

    it('enforceFeatureGate does not throw for allowed users', async () => {
        const ctx = makeCtx();
        expect(() => enforceFeatureGate(ctx)).not.toThrow();
        // AND the promise tail resolves. `not.toThrow()` alone only covers the
        // synchronous prologue; the tenant-toggle predicate lives past it, so
        // without this the case would pass while every real caller was refused.
        await expect(enforceFeatureGate(ctx)).resolves.toBeUndefined();
    });

    it('isAIRiskEnabled returns boolean', () => {
        const result = isAIRiskEnabled();
        expect(typeof result).toBe('boolean');
    });
});
