import { z } from 'zod';

import { SUPPORTED_LOCALES } from '@/lib/locale-constants';

/**
 * `PUT /api/t/:slug/admin/workspace-language` — one supported locale and
 * nothing else. The DB CHECK `Tenant_defaultLocale_supported` holds the same
 * set for every other writer.
 */
export const UpdateWorkspaceLanguageInput = z
    .object({ defaultLocale: z.enum(SUPPORTED_LOCALES) })
    .strict();

export type UpdateWorkspaceLanguageInput = z.infer<typeof UpdateWorkspaceLanguageInput>;
