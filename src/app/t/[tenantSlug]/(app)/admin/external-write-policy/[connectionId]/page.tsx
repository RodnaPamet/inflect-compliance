'use client';

/**
 * The external-write ladder for one MCP connection — OWNER-only.
 *
 * The admin layout gates this subtree on `admin.view`, which is not enough: the
 * endpoint behind the page is `admin.tenant_lifecycle`, because deciding whether
 * an agent may CHANGE something in a customer's own third-party system is
 * authority of the same class as tenant deletion and DEK rotation. Without a
 * matching client-side gate an ADMIN who is not an OWNER would reach a rendered
 * page and be told the policy "couldn't load" — a permission refusal wearing the
 * costume of a broken backend.
 *
 * `params` is a Promise in Next 15+; `use()` unwraps it in a client component,
 * which is the pattern the App Router documents for exactly this.
 */
import { use } from 'react';
import { useTranslations } from 'next-intl';

import { RequirePermission } from '@/components/require-permission';
import { ForbiddenPage } from '@/components/ForbiddenPage';

import { ExternalWriteLadderClient } from './ExternalWriteLadderClient';

export default function ExternalWritePolicyPage({
    params,
}: {
    params: Promise<{ connectionId: string }>;
}) {
    const t = useTranslations('admin');
    const { connectionId } = use(params);
    return (
        <RequirePermission
            resource="admin"
            action="tenant_lifecycle"
            fallback={
                // Title left at its default; only the MESSAGE is overridden. The
                // default tells the reader to contact their workspace
                // administrator, and for this permission an administrator is
                // exactly who cannot help — it is owner-only.
                <ForbiddenPage message={t('externalWriteLadder.forbidden')} />
            }
        >
            <ExternalWriteLadderClient connectionId={connectionId} />
        </RequirePermission>
    );
}
