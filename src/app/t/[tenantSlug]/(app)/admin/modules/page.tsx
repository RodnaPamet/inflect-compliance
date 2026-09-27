'use client';

/**
 * Optional product modules — OWNER-only.
 *
 * The admin layout gates this subtree on `admin.view`, which is not enough: the
 * endpoint behind the page is `admin.tenant_lifecycle`, because granting or
 * removing a whole product surface is authority of the same class as tenant
 * deletion and the identity write ladder. Without a matching client-side gate
 * an ADMIN who is not an OWNER would reach a rendered page and be told the
 * settings "couldn't load" — a permission refusal wearing the costume of a
 * broken backend.
 */
import { useTranslations } from 'next-intl';

import { RequirePermission } from '@/components/require-permission';
import { ForbiddenPage } from '@/components/ForbiddenPage';

import { ModulesClient } from './ModulesClient';

export default function ModulesPage() {
    const t = useTranslations('admin');
    return (
        <RequirePermission
            resource="admin"
            action="tenant_lifecycle"
            fallback={
                // Title left at its default; only the MESSAGE is overridden.
                // The default tells the reader to contact their workspace
                // administrator, and for this permission an administrator is
                // exactly who cannot help — it is owner-only.
                <ForbiddenPage message={t('modules.forbidden')} />
            }
        >
            <ModulesClient />
        </RequirePermission>
    );
}
