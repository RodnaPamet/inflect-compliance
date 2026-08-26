/**
 * SCIM 2.0 User resource endpoint
 *
 * GET    /api/scim/v2/Users/:id — get single user
 * PATCH  /api/scim/v2/Users/:id — partial update (e.g. deactivate)
 * PUT    /api/scim/v2/Users/:id — full replace
 * DELETE /api/scim/v2/Users/:id — deactivate (soft-delete)
 *
 * All requests are authenticated via tenant-scoped SCIM bearer token.
 */
import { NextRequest, NextResponse } from 'next/server';
import { authenticateScimRequest, ScimAuthError } from '@/lib/scim/auth';
import { scimError, type ScimPatchOp } from '@/lib/scim/types';
import {
    scimGetUser,
    scimPatchUser,
    scimPutUser,
    scimDeleteUser,
    type ScimCreateUserInput,
} from '@/app-layer/usecases/scim-users';
import { jsonResponse } from '@/lib/api-response';
import { publicBaseUrl } from '@/lib/http/public-base-url';

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, props: RouteContext) {
    const params = await props.params;
    try {
        const ctx = await authenticateScimRequest(req);
        const baseUrl = publicBaseUrl(req);

        const user = await scimGetUser(ctx, params.id, baseUrl);
        if (!user) {
            return jsonResponse(
                scimError(404, `User ${params.id} not found`),
                { status: 404 }
            );
        }

        return jsonResponse(user, {
            headers: { 'Content-Type': 'application/scim+json' },
        });
    } catch (e) {
        if (e instanceof ScimAuthError) {
            return jsonResponse(scimError(e.status, e.message, e.scimType), { status: e.status });
        }
        return jsonResponse(scimError(500, 'Internal server error'), { status: 500 });
    }
}

export async function PATCH(req: NextRequest, props: RouteContext) {
    const params = await props.params;
    try {
        const ctx = await authenticateScimRequest(req);
        const baseUrl = publicBaseUrl(req);

        const body = await req.json() as ScimPatchOp;

        if (!body.Operations || !Array.isArray(body.Operations)) {
            return jsonResponse(
                scimError(400, 'Operations array is required', 'invalidValue'),
                { status: 400 }
            );
        }

        const user = await scimPatchUser(ctx, params.id, body.Operations, baseUrl);
        if (!user) {
            return jsonResponse(
                scimError(404, `User ${params.id} not found`),
                { status: 404 }
            );
        }

        return jsonResponse(user, {
            headers: { 'Content-Type': 'application/scim+json' },
        });
    } catch (e) {
        if (e instanceof ScimAuthError) {
            return jsonResponse(scimError(e.status, e.message, e.scimType), { status: e.status });
        }
        return jsonResponse(scimError(500, 'Internal server error'), { status: 500 });
    }
}

export async function PUT(req: NextRequest, props: RouteContext) {
    const params = await props.params;
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

        const user = await scimPutUser(ctx, params.id, body, baseUrl);
        if (!user) {
            return jsonResponse(
                scimError(404, `User ${params.id} not found`),
                { status: 404 }
            );
        }

        return jsonResponse(user, {
            headers: { 'Content-Type': 'application/scim+json' },
        });
    } catch (e) {
        if (e instanceof ScimAuthError) {
            return jsonResponse(scimError(e.status, e.message, e.scimType), { status: e.status });
        }
        return jsonResponse(scimError(500, 'Internal server error'), { status: 500 });
    }
}

export async function DELETE(req: NextRequest, props: RouteContext) {
    const params = await props.params;
    try {
        const ctx = await authenticateScimRequest(req);

        const deleted = await scimDeleteUser(ctx, params.id);
        if (!deleted) {
            return jsonResponse(
                scimError(404, `User ${params.id} not found`),
                { status: 404 }
            );
        }

        return new NextResponse(null, { status: 204 });
    } catch (e) {
        if (e instanceof ScimAuthError) {
            return jsonResponse(scimError(e.status, e.message, e.scimType), { status: e.status });
        }
        return jsonResponse(scimError(500, 'Internal server error'), { status: 500 });
    }
}
