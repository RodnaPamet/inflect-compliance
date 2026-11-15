import { NextRequest } from 'next/server';
import { z } from 'zod';
import { requestTrustCenterAccess } from '@/lib/trust-center/gated';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

const Body = z.object({ documentId: z.string().min(1), requesterName: z.string().min(1).max(200), requesterEmail: z.string().email(), company: z.string().max(200).optional(), ndaAccepted: z.boolean().optional() });

/** PR-8 — PUBLIC: a visitor requests access to a gated trust-center document. */
export const POST = withApiErrorHandling(async (req: NextRequest, { params: p }: { params: Promise<{ slug: string }> }) => {
    const { slug } = await p;
    const parsed = Body.parse(await req.json().catch(() => ({})));
    const result = await requestTrustCenterAccess(slug, parsed.documentId, parsed);
    if (!result) return jsonResponse({ error: 'not_found' }, { status: 404 });
    // The center requires its NDA and this request did not accept it (#5613).
    // 400, not the uniform 201: `ndaRequired` is already on the public page, so
    // saying so discloses nothing, and a visitor who posted without the form
    // needs to be told what is missing rather than left believing a request was
    // filed. Nothing was recorded.
    if (result.status === 'NDA_REQUIRED') return jsonResponse({ error: 'nda_required' }, { status: 400 });
    return jsonResponse(result, { status: 201 });
});
