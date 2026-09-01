'use client';

/**
 * Leaver passes — the OWNER-only read surface. Not dry-run only since #2187
 * raised the clamp; the page reports whatever rung the tenant is on.
 *
 * The admin layout already gates this subtree on `admin.view`, which is not
 * enough here. The endpoint behind the page is gated `admin.tenant_lifecycle`,
 * because naming which of a customer's people the product would have disabled is
 * authority of the same class as granting the disable. Without a matching
 * client-side gate an ADMIN who is not an OWNER would reach a rendered page and
 * be told the report "couldn't load" — a permission refusal wearing the costume
 * of a broken backend. `ForbiddenPage` says the true thing instead.
 *
 * The gate lives here rather than inside `LeaverPassesClient` so the report
 * component stays a plain renderer of a payload the server already authorised,
 * and so the rendered test exercises the report without needing a permission
 * fixture to say anything about what it renders.
 */
import { useTranslations } from 'next-intl';

import { RequirePermission } from '@/components/require-permission';
import { ForbiddenPage } from '@/components/ForbiddenPage';

import { LeaverPassesClient } from './LeaverPassesClient';

export default function LeaverPassesPage() {
    const t = useTranslations('admin');
    return (
        <RequirePermission
            resource="admin"
            action="tenant_lifecycle"
            fallback={
                <ForbiddenPage
                    title={t('forbidden.title')}
                    message={t('leaverPasses.forbidden')}
                />
            }
        >
            <LeaverPassesClient />
        </RequirePermission>
    );
}
