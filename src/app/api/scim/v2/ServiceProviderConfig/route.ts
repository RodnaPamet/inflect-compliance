/**
 * SCIM 2.0 ServiceProviderConfig endpoint
 *
 * GET /api/scim/v2/ServiceProviderConfig
 *
 * This is a public endpoint (no auth required per SCIM spec).
 * Returns the capabilities of this SCIM service provider.
 */
import { NextRequest } from 'next/server';
import { scimServiceProviderConfig } from '@/lib/scim/types';
import { jsonResponse } from '@/lib/api-response';
import { publicBaseUrl } from '@/lib/http/public-base-url';

export async function GET(req: NextRequest) {
    const baseUrl = publicBaseUrl(req);
    return jsonResponse(scimServiceProviderConfig(baseUrl), {
        headers: { 'Content-Type': 'application/scim+json' },
    });
}
