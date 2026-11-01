import { notFound } from 'next/navigation';

import { getTranslations } from 'next-intl/server';

import { getOrgCtx } from '@/app-layer/context';
import { OrgForbiddenPage } from '../../_components/OrgForbiddenPage';
import { NewTenantForm } from './NewTenantForm';

/**
 * Epic O-4 — Create a new workspace under the org.
 *
 * Server component: resolves the OrgContext, gates on
 * `canManageTenants` (organization owners, #4576), and renders the client
 * form. The form POSTs to `/api/org/{slug}/tenants` (Epic O-2), which makes
 * the creator the workspace's OWNER and provisions every other owner and
 * admin of the organization as ADMIN in it.
 *
 * A non-member collapses to the standard 404 surface through `getOrgCtx`,
 * as the rest of the org tree does. A MEMBER who may not create workspaces
 * is told so, with `OrgForbiddenPage` (#4844): throwing `forbidden(...)`
 * here reached the root error boundary, which showed "an unexpected error
 * has occurred" and reported the refusal as a crash.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
    params: Promise<{ orgSlug: string }>;
}

export default async function NewTenantPage({ params }: PageProps) {
    const { orgSlug } = await params;

    let ctx;
    try {
        ctx = await getOrgCtx({ orgSlug });
    } catch {
        notFound();
    }

    if (!ctx.permissions.canManageTenants) {
        const t = await getTranslations('org');
        return <OrgForbiddenPage orgSlug={orgSlug} message={t('forbidden.newWorkspace')} />;
    }

    return <NewTenantForm orgSlug={orgSlug} />;
}
