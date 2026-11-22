/**
 * SCIM 2.0 Groups collection endpoint (EI-3).
 *
 * GET  /api/scim/v2/Groups — list groups
 * POST /api/scim/v2/Groups — create group (mirrors an Entra group → ScimGroup)
 *
 * Tenant-scoped SCIM bearer auth (same as Users).
 */
import { NextRequest } from 'next/server';
import { authenticateScimRequest, ScimAuthError } from '@/lib/scim/auth';
import { ScimFilterError, scimPage } from '@/lib/scim/filter';
import { scimError, scimListResponse, isScimGroupExternalId } from '@/lib/scim/types';
import {
    scimListGroups,
    scimCreateGroup,
    scimGroupResource,
} from '@/app-layer/usecases/scim-groups';
import { jsonResponse } from '@/lib/api-response';

export async function GET(req: NextRequest) {
    try {
        const ctx = await authenticateScimRequest(req);
        const params = req.nextUrl.searchParams;
        const page = scimPage(params.get('startIndex'), params.get('count'), { count: 100, max: 200 });
        const { groups, total, startIndex } = await scimListGroups(ctx, { ...page, filter: params.get('filter') });
        const resources = groups.map(scimGroupResource);
        return jsonResponse(scimListResponse(resources, total, startIndex), {
            headers: { 'Content-Type': 'application/scim+json' },
        });
    } catch (e) {
        if (e instanceof ScimFilterError) {
            return jsonResponse(scimError(e.status, e.message, e.scimType), { status: e.status });
        }
        if (e instanceof ScimAuthError) {
            return jsonResponse(scimError(e.status, e.message, e.scimType), { status: e.status });
        }
        return jsonResponse(scimError(500, 'Internal server error'), { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const ctx = await authenticateScimRequest(req);
        const body = (await req.json()) as {
            externalId?: string;
            displayName?: string;
            members?: Array<{ value: string; display?: string }>;
        };
        if (!body.displayName) {
            return jsonResponse(scimError(400, 'displayName is required', 'invalidValue'), { status: 400 });
        }
        // No `?? displayName` fallback: a display name is not an identifier, and
        // this value is what the group→role mapping join keys on.
        if (!isScimGroupExternalId(body.externalId)) {
            return jsonResponse(
                scimError(400, 'externalId is required and must be an opaque identifier (no spaces; a display name is not an identifier)', 'invalidValue'),
                { status: 400 },
            );
        }
        const group = await scimCreateGroup(ctx, {
            externalId: body.externalId,
            displayName: body.displayName,
            members: body.members,
        });
        return jsonResponse(scimGroupResource(group), {
            status: 201,
            headers: { 'Content-Type': 'application/scim+json' },
        });
    } catch (e) {
        if (e instanceof ScimAuthError) {
            return jsonResponse(scimError(e.status, e.message, e.scimType), { status: e.status });
        }
        return jsonResponse(scimError(500, 'Internal server error'), { status: 500 });
    }
}
