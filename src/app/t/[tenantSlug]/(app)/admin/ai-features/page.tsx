'use client';

/**
 * The four AI switches — OWNER-only.
 *
 * The admin layout gates this subtree on `admin.view`, which is not enough: the
 * endpoint behind the page is `admin.tenant_lifecycle`. Without a matching
 * client-side gate an ADMIN who is not an OWNER would reach a rendered page and
 * be told the settings "couldn't load" — a permission refusal wearing the
 * costume of a broken backend. Same shape as `admin/modules`, for the same
 * reason.
 */
import { useTranslations } from 'next-intl';

import { RequirePermission } from '@/components/require-permission';
import { ForbiddenPage } from '@/components/ForbiddenPage';

import { AiFeaturesClient } from './AiFeaturesClient';

export default function AiFeaturesPage() {
    const t = useTranslations('admin');
    return (
        <RequirePermission
            resource="admin"
            action="tenant_lifecycle"
            fallback={
                // Title left at its default; only the MESSAGE is overridden. The
                // default tells the reader to contact their workspace
                // administrator, and for this permission an administrator is
                // exactly who cannot help — it is owner-only.
                <ForbiddenPage message={t('aiFeatures.forbidden')} />
            }
        >
            <AiFeaturesClient />
        </RequirePermission>
    );
}
