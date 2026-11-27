import { NextRequest } from 'next/server';
import { z } from 'zod';

import { getTenantCtx } from '@/app-layer/context';
import { assertCanRead } from '@/app-layer/policies/common';
import { withApiErrorHandling } from '@/lib/errors/api';
import { badRequest } from '@/lib/errors/types';
import { jsonResponse } from '@/lib/api-response';
import { API_READ_LIMIT } from '@/lib/security/rate-limit';
import { SUPPORTED_LOCALES } from '@/lib/locale-constants';
import { translateContentTexts } from '@/lib/content-i18n/dictionary';
import { CONTENT_TRANSLATION_BATCH, CONTENT_TRANSLATION_MAX_CHARS } from '@/lib/content-i18n/limits';

/**
 * Catalogue content in the reader's language (#5996).
 *
 * A READ, sent as a POST because the body is a list of texts. It reads no
 * database row: the texts are looked up in the shipped dictionaries, and the
 * answer holds only those the catalogue translates. Any member of the
 * workspace may ask; the read budget applies, not the mutation one.
 */
const Body = z
    .object({
        locale: z.enum(SUPPORTED_LOCALES),
        texts: z.array(z.string().max(CONTENT_TRANSLATION_MAX_CHARS)).max(CONTENT_TRANSLATION_BATCH),
    })
    .strict();

export const POST = withApiErrorHandling(
    async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        assertCanRead(ctx);
        const parsed = Body.safeParse(await req.json().catch(() => null));
        if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid body');
        return jsonResponse({ translations: translateContentTexts(parsed.data.locale, parsed.data.texts) });
    },
    { rateLimit: { config: API_READ_LIMIT, scope: 'content-translations' } },
);
