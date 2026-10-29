'use client';

import { useTranslations } from 'next-intl';

import { RequirePermission } from '@/components/require-permission';
import { ForbiddenPage } from '@/components/ForbiddenPage';

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
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
    const t = useTranslations('admin');
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
