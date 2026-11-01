/**
 * The receipt export is a FILE (#4897). The page's Export link used to
 * navigate the tab to a JSON document; the route now answers as an attachment
 * with a name, and the body is still the full receipt an auditor verifies.
 */
const mockReceipt = { id: 'rcpt_1', toolName: 'list_risks', signature: 'sig', signingKeyId: 'key' };
jest.mock('@/app-layer/context', () => ({ getTenantCtx: jest.fn(async () => ({ tenantId: 't1' })) }));
jest.mock('@/app-layer/usecases/agent-action-receipt', () => ({
    getReceiptForExport: jest.fn(async () => mockReceipt),
}));

import { NextRequest } from 'next/server';
import { GET } from '@/app/api/t/[tenantSlug]/agent-receipts/[id]/export/route';

it('answers as a named attachment carrying the receipt', async () => {
    const res = await GET(new NextRequest('http://localhost/api/t/acme/agent-receipts/rcpt_1/export'), {
        params: Promise.resolve({ tenantSlug: 'acme', id: 'rcpt_1' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="agent-receipt-rcpt_1.json"');
    expect(await res.json()).toEqual(mockReceipt);
});
