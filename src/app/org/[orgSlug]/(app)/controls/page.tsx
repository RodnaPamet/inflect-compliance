import { notFound } from 'next/navigation';

import { getOrgCtx } from '@/app-layer/context';
import { listNonPerformingControls } from '@/app-layer/usecases/portfolio';
import { getTranslations } from 'next-intl/server';
import { OrgForbiddenPage } from '../_components/OrgForbiddenPage';
import { toPlainJson } from '@/lib/server/to-plain-json';
import { ControlsTable } from './ControlsTable';

/**
 * Epic O-4 — Non-performing controls (cross-tenant).
 *
 * Aggregates `applicability=APPLICABLE` controls whose `status` is
 * NOT `IMPLEMENTED` from every linked tenant, attributed to the
 * source tenant. Each row links to the tenant's own control detail
 * page where the CISO's auto-provisioned AUDITOR membership unlocks
 * read access under RLS.
 */
export const dynamic = 'force-dynamic';

interface PageProps {
    params: Promise<{ orgSlug: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function OrgControlsPage({ params, searchParams }: PageProps) {
    const { orgSlug } = await params;
    const sp = await searchParams;

    let ctx;
    try {
        ctx = await getOrgCtx({ orgSlug });
    } catch {
        notFound();
    }

    // A Reader holds the portfolio summary only; this list names items
    // inside the workspaces (#4845). The usecase refuses too.
    if (!ctx.permissions.canDrillDown) {
        const t = await getTranslations('org.forbidden');
        return <OrgForbiddenPage orgSlug={orgSlug} message={t('drillDown')} />;
    }

    const cursor = typeof sp.cursor === 'string' ? sp.cursor : undefined;
    const result = await listNonPerformingControls(ctx, { cursor });

    // Server→client RSC boundary — see `toPlainJson` for rationale.
    return (
        <ControlsTable
            rows={toPlainJson(result.rows)}
            nextCursor={result.nextCursor}
            orgSlug={orgSlug}
        />
    );
}
