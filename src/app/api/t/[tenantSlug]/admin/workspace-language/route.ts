import { NextRequest } from 'next/server';

import { requirePermission } from '@/lib/security/permission-middleware';
import { getWorkspaceLanguage, setWorkspaceLanguage } from '@/app-layer/usecases/workspace-language';
import { UpdateWorkspaceLanguageInput } from '@/app-layer/schemas/workspace-language.schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { badRequest } from '@/lib/errors/types';
import { jsonResponse } from '@/lib/api-response';

/**
 * The workspace default language (owner decision 2026-11-24): the language of
 * text the product writes into this workspace's records on its behalf — first,
 * the NIS2 gap-assessment dispatch task titles. Not an interface language.
 *
 * Both verbs take `admin.manage`, the key of the other workspace-wide admin
 * settings; the usecase asserts it again.
 */

export const GET = withApiErrorHandling(
    requirePermission('admin.manage', async (_req: NextRequest, _routeArgs, ctx) =>
        jsonResponse(await getWorkspaceLanguage(ctx)),
    ),
);

export const PUT = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        const raw = await req.json().catch(() => ({}));
        const parsed = UpdateWorkspaceLanguageInput.safeParse(raw);
        if (!parsed.success) {
            throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid body');
        }
        return jsonResponse(await setWorkspaceLanguage(ctx, parsed.data));
    }),
);
