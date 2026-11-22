/**
 * An API key other than `*` reaches only the tenant REST paths its scopes name
 * (`src/lib/auth/api-key-path-scope.ts`, owner decision 2026-11-12: refuse
 * unmapped). Its coarse tier comes from ANY of its scopes, and much of the
 * REST surface is gated by that tier alone, so without this a `risks:write`
 * key wrote audits and every key read the evidence register.
 *
 * Runs the real `getTenantCtx` with a real key hash, as
 * `api-key-tenant-binding.test.ts` does. Each refusal writes one
 * `AUTHZ_DENIED` row.
 */
const mockPrisma = {
    tenantApiKey: { findUnique: jest.fn(), update: jest.fn() },
};
const mockAppendAuditEntry = jest.fn();

jest.mock('@/lib/prisma', () => ({ __esModule: true, default: mockPrisma, prisma: mockPrisma }));
jest.mock('@/lib/observability/context', () => ({ mergeRequestContext: jest.fn() }));
jest.mock('@/lib/auth', () => ({
    getSessionOrThrow: jest.fn(async () => {
        throw new Error('session path must not be reached for an API key');
    }),
}));
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntry: (...args: unknown[]) => mockAppendAuditEntry(...args),
    }),
);

import * as fs from 'node:fs';
import * as path from 'node:path';
import { NextRequest } from 'next/server';
import { strictMock } from '../helpers/strict-mock';
import { getTenantCtx } from '@/app-layer/context';
import { generateApiKey } from '@/lib/auth/api-key-auth';
import { API_KEY_PATH_RESOURCES, apiKeyPathRefusal } from '@/lib/auth/api-key-path-scope';

const { plaintext, keyHash } = generateApiKey();

function withScopes(scopes: string[]) {
    mockPrisma.tenantApiKey.findUnique.mockImplementation(async ({ where }: { where: { keyHash: string } }) =>
        where.keyHash === keyHash
            ? {
                  id: 'key-1',
                  keyHash,
                  tenantId: 'tenant-acme',
                  createdById: 'user-1',
                  revokedAt: null,
                  expiresAt: null,
                  scopes,
                  tenant: { slug: 'acme' },
              }
            : null,
    );
}
const call = (method: string, pathname: string) =>
    getTenantCtx(
        { tenantSlug: 'acme' },
        new NextRequest(`http://localhost:3000${pathname}`, {
            method,
            headers: new Headers({ authorization: `Bearer ${plaintext}` }),
        }),
    );
function denials() {
    return mockAppendAuditEntry.mock.calls
        .map((c) => c[0] as { action: string; detailsJson: { gate: string; reason: string } })
        .filter((e) => e.action === 'AUTHZ_DENIED');
}

beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.tenantApiKey.update.mockResolvedValue({});
    mockAppendAuditEntry.mockResolvedValue({});
});

describe('a key reaches only the paths its scopes name', () => {
    it('a write scope on one register does not write another', async () => {
        withScopes(['risks:write']);
        await expect(call('POST', '/api/t/acme/audits')).rejects.toMatchObject({ status: 403 });
        expect(denials()).toEqual([
            expect.objectContaining({ detailsJson: expect.objectContaining({ gate: 'api_key_path_scope', reason: 'no_scope_on_resource' }) }),
        ]);
        await expect(call('PATCH', '/api/t/acme/risks/r-1/status')).resolves.toMatchObject({ apiKeyId: 'key-1' });
    });

    it('a read scope reads its register and writes nothing there', async () => {
        withScopes(['risks:read']);
        await expect(call('GET', '/api/t/acme/risks')).resolves.toMatchObject({ apiKeyId: 'key-1' });
        await expect(call('POST', '/api/t/acme/risks/r-1/fair')).rejects.toMatchObject({ status: 403 });
        expect(denials()[0].detailsJson.reason).toBe('read_only_scope');
    });

    it("a harness scanner's key posts its scans and reads no register", async () => {
        withScopes(['admin:harness_ingest', 'mcp:read']);
        await expect(call('POST', '/api/t/acme/admin/agents/harness-scans')).resolves.toMatchObject({ apiKeyId: 'key-1' });
        await expect(call('GET', '/api/t/acme/evidence')).rejects.toMatchObject({ status: 403 });
        await expect(call('GET', '/api/t/acme/audits/packs')).rejects.toMatchObject({ status: 403 });
    });

    it('an unmapped path is refused to every key but *', async () => {
        withScopes(['controls:*', 'risks:*', 'admin:write']);
        await expect(call('GET', '/api/t/acme/dashboard')).rejects.toMatchObject({ status: 403 });
        expect(denials()[0].detailsJson.reason).toBe('unmapped_path');
        withScopes(['*']);
        await expect(call('GET', '/api/t/acme/dashboard')).resolves.toMatchObject({ apiKeyId: 'key-1' });
    });

    it('an admin scope does not reach identity reconciliation, which has its own', async () => {
        withScopes(['admin:write']);
        await expect(call('POST', '/api/t/acme/admin/identity-reconciliation/confirm')).rejects.toMatchObject({ status: 403 });
        withScopes(['identity_reconciliation:admin']);
        await expect(call('POST', '/api/t/acme/admin/identity-reconciliation/confirm')).resolves.toBeTruthy();
    });
});

describe('the rule', () => {
    it.each([
        [['*'], 'POST', '/api/t/a/anything', null],
        [['evidence:read'], 'GET', '/api/t/a/evidence/e-1', null],
        [['evidence:read'], 'HEAD', '/api/t/a/files/f-1', null],
        [['evidence:write'], 'POST', '/api/t/a/evidence', null],
        [['evidence:read'], 'DELETE', '/api/t/a/evidence/e-1', 'read_only_scope'],
        [['vendors:*'], 'PUT', '/api/t/a/vendor-assessment-templates/t-1', null],
        [['tasks:write'], 'GET', '/api/t/a/risks', 'no_scope_on_resource'],
        [['tasks:write'], 'GET', '/api/t/a/search', 'unmapped_path'],
        [['tasks:write'], 'GET', '/api/findings', 'unmapped_path'],
    ])('%j %s %s → %s', (scopes, method, pathname, expected) => {
        const refusal = apiKeyPathRefusal(scopes as string[], method as string, pathname as string);
        expect(refusal?.reason ?? null).toBe(expected);
    });
});

describe('every tenant API segment is classified', () => {
    // A segment absent from the map is reachable by `*` keys only. That is
    // the safe default, but it must be a decision: a new segment fails here
    // until it is mapped or listed below.
    const UNMAPPED = new Set([
        'agent-receipts', 'agents', 'ai', 'ai-systems', 'assistant',
        'calendar', 'dashboard', 'notifications', 'onboarding', 'search', 'users',
    ]);

    it('names each segment once, as mapped or as reachable by * keys only', () => {
        const dir = path.join(__dirname, '../../src/app/api/t/[tenantSlug]');
        const segments = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
        const unclassified = segments.filter((s) => !(s in API_KEY_PATH_RESOURCES) && !UNMAPPED.has(s));
        const both = segments.filter((s) => s in API_KEY_PATH_RESOURCES && UNMAPPED.has(s));
        const stale = [...Object.keys(API_KEY_PATH_RESOURCES), ...UNMAPPED].filter((s) => !segments.includes(s));
        expect({ unclassified, both, stale }).toEqual({ unclassified: [], both: [], stale: [] });
    });
});
