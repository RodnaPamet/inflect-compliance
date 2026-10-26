'use client';

/**
 * RQ3-OB-F — Unified first-run empty state for risk surfaces.
 *
 * Every analytical view on a tenant with zero risks used to render a
 * different shape:
 *
 *   - the risks list (RisksClient)          → <EmptyState> primitive
 *   - the dashboard's status breakdown      → plain <p>
 *   - the board's hygiene card              → plain <p>
 *   - the matrix's empty grid               → renders nothing at all
 *
 * Different copy, different CTA targets, sometimes no CTA at all.
 * This primitive collapses all four into ONE component with ONE
 * copy + ONE CTA target (`/risks?create=1`, which `RisksClient`
 * already auto-opens), so:
 *
 *   - the new operator sees the same nudge wherever they land,
 *   - the eventual product writer edits ONE file to retune the copy,
 *   - the ratchet pins the contract so a future "tidy-up" can't
 *     fork the shape again.
 *
 * Two sizes:
 *   - `size="md"` (default) — full card height, used on the risks
 *     list + the dashboard's top of page when the whole tenant is
 *     empty.
 *   - `size="sm"` — compact, used inside a card / aside (board
 *     hygiene line, dashboard status-breakdown slot).
 *
 * The href deliberately routes through the tenant-aware
 * `useTenantHref()` hook so the link stays tenant-scoped and
 * survives slug renames without per-call-site fix-ups.
 */

import { useTranslations } from 'next-intl';
import { useTenantHref } from '@/lib/tenant-context-provider';
import { EmptyState } from '@/components/ui/empty-state';

export interface RiskFirstRunEmptyProps {
    /** Compact form for in-card / aside usage. Default: 'md'. */
    size?: 'sm' | 'md';
    /** Override the primary CTA label. Default: "Create your first risk". */
    ctaLabel?: string;
    /**
     * When supplied, the CTA opens an in-page modal instead of
     * deep-linking to `/risks?create=1`. Used by the risks list
     * page, which already mounts `<NewRiskModal>` — clicking the
     * CTA there should open it directly, no navigation hop.
     * Every OTHER consumer omits this, so the CTA navigates and
     * the destination page auto-opens via its `?create=1` reader.
     */
    onCreateClick?: () => void;
    /**
     * False hides the CTA, for a user the create route would refuse.
     * Default: true. The risks list passes `riskCanCreate`.
     */
    canCreate?: boolean;
}

export function RiskFirstRunEmpty({
    size = 'md',
    ctaLabel,
    onCreateClick,
    canCreate = true,
}: RiskFirstRunEmptyProps = {}) {
    const tenantHref = useTenantHref();
    const t = useTranslations('panels.riskFirstRun');
    const ctaText = ctaLabel ?? t('cta');
    return (
        <EmptyState
            size={size}
            variant="no-records"
            title={t('title')}
            description={t('description')}
            primaryAction={
                !canCreate
                    ? undefined
                    : onCreateClick
                    ? {
                          label: ctaText,
                          onClick: onCreateClick,
                          'data-testid': 'risk-first-run-cta',
                      }
                    : {
                          label: ctaText,
                          href: tenantHref('/risks?create=1'),
                          'data-testid': 'risk-first-run-cta',
                      }
            }
            data-testid="risk-first-run-empty"
        />
    );
}
