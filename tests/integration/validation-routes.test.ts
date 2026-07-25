/* eslint-disable @typescript-eslint/no-explicit-any -- test
 * mocks, fixtures, and adapter shims that mirror runtime contracts
 * (Prisma extensions, NextRequest mocks, JSON-loaded fixtures,
 * spy harnesses). Per-line typing has poor cost/benefit ratio in
 * test files; the file-level disable is the codebase's standard
 * pattern for these surfaces (see also
 * tests/guards/helm-chart-foundation.test.ts and
 * tests/integration/audit-middleware.test.ts). */
import { NextRequest } from 'next/server';

// Mock auth to avoid importing next-auth (which causes ESM Jest parsing errors)
jest.mock('@/lib/auth', () => ({
    getSessionOrThrow: jest.fn().mockImplementation(() => {
        throw new Error('Not reached - validation should fail first');
    }),
    requireRole: jest.fn(),
}));

import { POST as TasksPost } from '@/app/api/tasks/route';
import { POST as PoliciesPost } from '@/app/api/t/[tenantSlug]/policies/route';

// Mock getTenantCtx to avoid real DB lookups. The tenant routes now gate
// with `requirePermission(...)`, which resolves ctx + checks the granular
// permission BEFORE the handler parses the body — so the mock must RESOLVE
// with an appPermissions bag that grants the needed key (policies.create),
// otherwise the route 403s before reaching the body-validation under test.
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: jest.fn().mockResolvedValue({
        tenantId: 't-test',
        userId: 'u-test',
        role: 'OWNER',
        appPermissions: {
            policies: { view: true, create: true, edit: true, approve: true },
            // The risk PUT gates on `risks.edit` before body validation —
            // grant it so the assertion under test (400, not 403) is reached.
            risks: { view: true, create: true, edit: true },
        },
    }),
}));

// The non-tenant-scoped `/api/risks/[id]` duplicate was deleted; the
// tenant-scoped route is the only risk-update surface now.
import { PUT as RisksPut } from '@/app/api/t/[tenantSlug]/risks/[id]/route';
import { POST as EvidencePost } from '@/app/api/evidence/route';

describe('Validation Layer Integration', () => {
    describe('JSON Body Validation', () => {
        it('POST /api/tasks returns 400 VALIDATION_ERROR when required fields are missing', async () => {
            const req = new NextRequest('http://localhost/api/tasks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}), // Empty body, missing 'title'
            });
            const res = await TasksPost(req, { params: {} } as any);
            expect(res.status).toBe(400);

            const data = await res.json();
            expect(data.error.code).toBe('VALIDATION_ERROR');
            expect(data.error.message).toBe('Invalid request payload');
            // 'title' is a required field in CreateTaskSchema
            expect(data.error.details.some((issue: any) => issue.path.includes('title'))).toBe(true);
        });

        it('POST /api/t/:tenantSlug/policies returns 400 on invalid JSON payload', async () => {
            const req = new NextRequest('http://localhost/api/t/acme/policies', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: 'this-is-not-json',
            });
            const res = await PoliciesPost(req, { params: { tenantSlug: 'acme' } } as any);
            expect(res.status).toBe(400);

            const data = await res.json();
            expect(data.error.code).toBe('BAD_REQUEST');
            expect(data.error.message).toBe('Invalid JSON payload');
        });

        it('PUT /api/t/:tenantSlug/risks/:id returns 400 on out-of-bounds numbers', async () => {
            const req = new NextRequest('http://localhost/api/t/acme/risks/123', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ impact: 99 }), // max is 10
            });
            const res = await RisksPut(req, { params: { tenantSlug: 'acme', id: '123' } } as any);
            expect(res.status).toBe(400);

            const data = await res.json();
            expect(data.error.code).toBe('VALIDATION_ERROR');
        });
    });

    describe('JSON Body Validation — Evidence', () => {
        it('POST /api/evidence returns 400 when required fields are missing', async () => {
            const req = new NextRequest('http://localhost/api/evidence', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'FILE' }),
                // Missing 'title' which is strictly required by CreateEvidenceSchema
            });
            const res = await EvidencePost(req, { params: {} } as any);

            expect(res.status).toBe(400);
            const data = await res.json();
            expect(data.error.code).toBe('VALIDATION_ERROR');
            expect(data.error.details.some((issue: any) => issue.path.includes('title'))).toBe(true);
        });
    });
});
