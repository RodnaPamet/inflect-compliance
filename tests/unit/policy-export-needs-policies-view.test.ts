/**
 * The policy PDF export renders a policy's full text, so it takes the key the
 * policy list and detail reads take: `policies.view`. A custom role (or an
 * API key's scopes) can withhold that key while the coarse read tier still
 * reads true. The route refuses such a caller before the generator runs, and
 * the refusal leaves an `AUTHZ_DENIED` row. A caller who holds it gets the PDF.
 */
const mockGetTenantCtx = jest.fn();
const mockAppendAuditEntry = jest.fn();
const mockGenerate = jest.fn();

jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (...args: unknown[]) => mockGetTenantCtx(...args),
}));
jest.mock('@/lib/audit', () => ({
    appendAuditEntryOrQueue: (...args: unknown[]) => mockAppendAuditEntry(...args),
    appendAuditEntry: (...args: unknown[]) => mockAppendAuditEntry(...args),
}));
jest.mock('@/app-layer/reports/pdf/policyDocument', () => ({
    generatePolicyDocumentPdf: (...args: unknown[]) => mockGenerate(...args),
}));
jest.mock('@/lib/entitlements-server', () => ({ requireFeature: jest.fn(async () => undefined) }));

import type { NextRequest } from 'next/server';
import { GET } from '@/app/api/t/[tenantSlug]/policies/[id]/export/route';
import { makeRequestContext } from './../helpers/make-context';
import { getPermissionsForRole } from '@/lib/permissions';

type Handler = (req: NextRequest, args: { params: Promise<{ tenantSlug: string; id: string }> }) => Promise<Response>;
const handler = GET as unknown as Handler;

function req(): NextRequest {
    const path = '/api/t/acme/policies/pol-1/export';
    return {
        method: 'GET',
        url: `https://app.example.com${path}`,
        headers: new Headers(),
        nextUrl: { pathname: path, protocol: 'https:', host: 'app.example.com', searchParams: new URLSearchParams() },
    } as unknown as NextRequest;
}
const args = () => ({ params: Promise.resolve({ tenantSlug: 'acme', id: 'pol-1' }) });

beforeEach(() => {
    mockGetTenantCtx.mockReset();
    mockAppendAuditEntry.mockReset();
    mockGenerate.mockReset();
    mockAppendAuditEntry.mockResolvedValue({ id: 'a1', entryHash: 'h', previousHash: null });
});

describe('GET /policies/:id/export', () => {
    it('refuses a role whose policies.view is off, before generating, and records the refusal', async () => {
        const editor = getPermissionsForRole('EDITOR');
        mockGetTenantCtx.mockResolvedValue(
            makeRequestContext('EDITOR', {
                appPermissions: { ...editor, policies: { ...editor.policies, view: false } },
            }),
        );
        const res = await handler(req(), args());
        expect(res.status).toBe(403);
        expect(mockGenerate).not.toHaveBeenCalled();
        const denials = mockAppendAuditEntry.mock.calls
            .map((c) => c[0] as { action: string; detailsJson?: { permissionKey?: string } })
            .filter((e) => e.action === 'AUTHZ_DENIED');
        expect(denials).toHaveLength(1);
        expect(JSON.stringify(denials[0])).toContain('policies.view');
    });

    it('serves the PDF to a reader who holds policies.view', async () => {
        mockGetTenantCtx.mockResolvedValue(makeRequestContext('READER'));
        mockGenerate.mockResolvedValue({
            on(event: string, cb: (arg?: unknown) => void) {
                if (event === 'data') setTimeout(() => cb(Buffer.from('%PDF')), 0);
                if (event === 'end') setTimeout(() => cb(), 1);
            },
            end() {},
        });
        const res = await handler(req(), args());
        expect(res.status).toBe(200);
        expect(mockGenerate).toHaveBeenCalledWith(expect.anything(), 'pol-1', { classification: 'INTERNAL' });
    });
});
