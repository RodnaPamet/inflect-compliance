'use client';

import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { RequirePermission } from '@/components/require-permission';
import { ForbiddenPage } from '@/components/ForbiddenPage';
import { useTenantContext } from '@/lib/tenant-context-provider';

import {
    ADMIN_PAGE_REQUIREMENTS,
    adminPageRouteForPath,
    admitsAdminPage,
} from './_lib/admin-page-requirements';

/**
 * Admin layout guard — what the /t/:tenantSlug/admin/* subtree SHOWS a
 * caller without `admin.view`: a consistent "Access Denied" via ForbiddenPage.
 *
 * It is a CLIENT component, so it is a display rule and not a data boundary.
 * By the time it runs, every server-component page below it has already
 * rendered on the server and its props are in the RSC payload, whatever this
 * guard then decides to show. The edge does not refuse an admin PAGE request
 * either (`src/middleware.ts` lets a denied page through to the App Router).
 *
 * So the boundary is per page, on the server:
 *   1. Every admin server page calls `gateAdminPage` (`./_lib/admin-page-gate`)
 *      before it reads anything — `tests/guardrails/admin-layout-guard.test.ts`.
 *   2. API routes — `requirePermission` (separate concern).
 *   3. This layout — the on-screen fallback.
 *
 * The one exception to `admin.view` is read off the server gate's own table:
 * a page whose row in `ADMIN_PAGE_REQUIREMENTS` admits the caller is shown.
 * Every row but the audit log's includes `admin.view`, so that adds nobody
 * anywhere else; on the audit log it shows an AUDITOR the page the server
 * renders for them (owner decision 2026-10-29).
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
    const t = useTranslations('admin');
    const tenant = useTenantContext();
    const route = adminPageRouteForPath(usePathname() ?? '');

    if (route !== null && admitsAdminPage(tenant, ADMIN_PAGE_REQUIREMENTS[route])) {
        return <>{children}</>;
    }

    return (
        <RequirePermission
            resource="admin"
            action="view"
            fallback={
                <ForbiddenPage
                    title={t('forbidden.title')}
                    message={t('forbidden.message')}
                />
            }
        >
            {children}
        </RequirePermission>
    );
}
