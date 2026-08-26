/**
 * SCIM 2.0 Users collection endpoint
 *
 * GET  /api/scim/v2/Users — list users (with optional filter)
 * POST /api/scim/v2/Users — create user
 *
 * All requests are authenticated via tenant-scoped SCIM bearer token.
 */
import { NextRequest } from 'next/server';
import { authenticateScimRequest, ScimAuthError } from '@/lib/scim/auth';
import { scimError, scimListResponse } from '@/lib/scim/types';
import { scimListUsers, scimCreateUser, type ScimCreateUserInput } from '@/app-layer/usecases/scim-users';
import { jsonResponse } from '@/lib/api-response';
import { publicBaseUrl } from '@/lib/http/public-base-url';

export async function GET(req: NextRequest) {
    try {
        const ctx = await authenticateScimRequest(req);
        const baseUrl = publicBaseUrl(req);

        const startIndex = parseInt(req.nextUrl.searchParams.get('startIndex') || '1', 10);
        const count = parseInt(req.nextUrl.searchParams.get('count') || '100', 10);
        const filter = req.nextUrl.searchParams.get('filter') || undefined;

        const { resources, total } = await scimListUsers(ctx, baseUrl, { startIndex, count, filter });

        return jsonResponse(scimListResponse(resources, total, startIndex), {
            headers: { 'Content-Type': 'application/scim+json' },
        });
    } catch (e) {
        if (e instanceof ScimAuthError) {
            return jsonResponse(scimError(e.status, e.message, e.scimType), { status: e.status });
        }
        return jsonResponse(scimError(500, 'Internal server error'), { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const ctx = await authenticateScimRequest(req);
        const baseUrl = publicBaseUrl(req);

        const body = await req.json() as ScimCreateUserInput;

        if (!body.userName) {
            return jsonResponse(
                scimError(400, 'userName is required', 'invalidValue'),
                { status: 400 }
            );
        }

        const { user, created } = await scimCreateUser(ctx, body, baseUrl);

        return jsonResponse(user, {
            status: created ? 201 : 200,
            headers: {
                'Content-Type': 'application/scim+json',
                ...(created ? { Location: user.meta.location } : {}),
            },
        });
    } catch (e) {
        if (e instanceof ScimAuthError) {
            return jsonResponse(scimError(e.status, e.message, e.scimType), { status: e.status });
        }
        return jsonResponse(scimError(500, 'Internal server error'), { status: 500 });
    }
}
