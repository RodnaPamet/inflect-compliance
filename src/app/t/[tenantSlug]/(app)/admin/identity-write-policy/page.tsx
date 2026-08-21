'use client';

/**
 * The identity write ladder — OWNER-only.
 *
 * The admin layout gates this subtree on `admin.view`, which is not enough: the
 * endpoint behind the page is `admin.tenant_lifecycle`, because deciding whether
 * this product may disable accounts in a customer's directory is authority of the
 * same class as tenant deletion and DEK rotation. Without a matching client-side
 * gate an ADMIN who is not an OWNER would reach a rendered page and be told the
 * policy "couldn't load" — a permission refusal wearing the costume of a broken
 * backend.
 */
import { useTranslations } from 'next-intl';

import { RequirePermission } from '@/components/require-permission';
import { ForbiddenPage } from '@/components/ForbiddenPage';

import { WriteLadderClient } from './WriteLadderClient';

export default function IdentityWritePolicyPage() {
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
                <ForbiddenPage message={t('writeLadder.forbidden')} />
            }
        >
            <WriteLadderClient />
        </RequirePermission>
    );
}
