/**
 * The server-side gate every admin SERVER page applies before it reads.
 *
 * Usage, as the FIRST statement of the page:
 *
 *     const gate = await gateAdminPage('/admin/personnel', params);
 *     if (!gate.allowed) return gate.forbidden;
 *     const rows = await listEmployees(gate.ctx);
 *
 * The context exists only on the admitted branch, so a page cannot reach its
 * data without checking `allowed` first: `gate.ctx` does not type-check above
 * the `if`. A refused caller gets the same forbidden page the admin layout
 * renders, and the page reads nothing.
 *
 * Why the layout's own check does not do this, and how each page's
 * requirement was chosen: `./admin-page-requirements.ts`.
 */
import type { ReactElement } from 'react';
import { getTranslations } from 'next-intl/server';

import { getTenantCtx } from '@/app-layer/context';
import type { RequestContext } from '@/app-layer/types';
import { ForbiddenPage } from '@/components/ForbiddenPage';

import {
    ADMIN_PAGE_REQUIREMENTS,
    admitsAdminPage,
    type AdminPageRoute,
} from './admin-page-requirements';

export type AdminPageGate =
    | { readonly allowed: true; readonly ctx: RequestContext; readonly tenantSlug: string }
    | { readonly allowed: false; readonly forbidden: ReactElement };

export async function gateAdminPage(
    route: AdminPageRoute,
    params: Promise<{ tenantSlug: string }>,
): Promise<AdminPageGate> {
    const { tenantSlug } = await params;
    const ctx = await getTenantCtx({ tenantSlug });
    if (admitsAdminPage(ctx, ADMIN_PAGE_REQUIREMENTS[route])) {
        return { allowed: true, ctx, tenantSlug };
    }
    const t = await getTranslations('admin');
    return {
        allowed: false,
        forbidden: <ForbiddenPage title={t('forbidden.title')} message={t('forbidden.message')} />,
    };
}
