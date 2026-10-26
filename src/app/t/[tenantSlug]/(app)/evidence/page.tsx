import { getTranslations } from 'next-intl/server';
import { getTenantCtx } from '@/app-layer/context';
import { listEvidence, getEvidenceRetentionMetrics } from '@/app-layer/usecases/evidence';
import { listControls } from '@/app-layer/usecases/control';
import { canReadControls } from '@/app-layer/policies/control.policies';
import { EvidenceClient } from './EvidenceClient';

export const dynamic = 'force-dynamic';

// SSR fetch caps at SSR_PAGE_LIMIT rows for both evidence and the
// supporting controls list (used to populate filters / dropdowns).
// The Epic 69 SWR client immediately fetches the backfill-capped evidence
// list in the background, swapped in by SWR's keepPreviousData. Controls
// are read one row past the cap so the page knows whether the slice is the
// whole list; only when it is not does the client fetch the rest
// (`controlsComplete`). Mirrors the PR #146 Tasks pattern.
const SSR_PAGE_LIMIT = 100;

/**
 * Evidence — Server Component wrapper.
 * Fetches evidence + controls server-side, delegates all interaction to client island.
 */
export default async function EvidencePage({
    params,
}: {
    params: Promise<{ tenantSlug: string }>;
}) {
    const { tenantSlug } = await params;

    // Translations and tenant context are independent — fetch in parallel
    const [t, tc, ctx] = await Promise.all([
        getTranslations('evidence'),
        getTranslations('common'),
        getTenantCtx({ tenantSlug }),
    ]);

    // Controls are a supporting list here — the pickers and the Linked
    // control filter. A custom role may view evidence without viewing
    // controls, and `listControls` refuses that role, so asking it anyway
    // made the whole page fail to open. Such a role gets no control list.
    const canViewControls = canReadControls(ctx);

    // Data fetches depend on ctx but are independent of each other.
    // EP-4 — the KPI strips + "all current" celebration are SERVER-computed
    // (getEvidenceRetentionMetrics) rather than counted from the ≤100 SSR
    // rows, so the tiles stay correct past the SSR row cap. The client feeds
    // this as SWR fallbackData and revalidates against /evidence/retention
    // (the same usecase) — the two can never diverge.
    const [evidence, controlsRead, metrics] = await Promise.all([
        listEvidence(ctx, undefined, { take: SSR_PAGE_LIMIT }),
        canViewControls
            ? listControls(ctx, undefined, { take: SSR_PAGE_LIMIT + 1 })
            : Promise.resolve([]),
        getEvidenceRetentionMetrics(ctx),
    ]);
    const controlsComplete = controlsRead.length <= SSR_PAGE_LIMIT;
    const controls = controlsRead.slice(0, SSR_PAGE_LIMIT);

    return (
        <EvidenceClient
            initialEvidence={JSON.parse(JSON.stringify(evidence))}
            initialControls={JSON.parse(JSON.stringify(controls))}
            controlsComplete={controlsComplete}
            canViewControls={canViewControls}
            initialMetrics={JSON.parse(JSON.stringify(metrics))}
            tenantSlug={tenantSlug}
            permissions={ctx.permissions}
            // The custom-role grants the evidence usecases check. The coarse
            // `permissions` above come from a custom role's BASE role, so the
            // page offers a button only when both admit the user.
            grants={{
                evidenceEdit: ctx.appPermissions.evidence.edit,
                evidenceUpload: ctx.appPermissions.evidence.upload,
                adminManage: ctx.appPermissions.admin.manage,
                controlsEdit: ctx.appPermissions.controls.edit,
            }}
            translations={{
                title: t('title'),
                listDescription: t('listDescription'),
                evidenceItems: t('evidenceItems', { count: 0 }),
                evidenceTitle: t('evidenceTitle'),
                type: t('type'),
                control: t('control'),
                status: t('status'),
                ownerLabel: t('ownerLabel'),
                noEvidence: t('noEvidence'),
                submitForReview: t('submitForReview'),
                approveEvidence: t('approveEvidence'),
                rejectEvidence: t('rejectEvidence'),
                addEvidence: t('addEvidence'),
                createEvidence: t('createEvidence'),
                content: t('content'),
                contentPlaceholder: t('contentPlaceholder'),
                draft: t('draft'),
                submitted: t('submitted'),
                approved: t('approved'),
                rejected: t('rejected'),
                none: tc('none'),
                cancel: tc('cancel'),
                actions: tc('actions'),
            }}
        />
    );
}
