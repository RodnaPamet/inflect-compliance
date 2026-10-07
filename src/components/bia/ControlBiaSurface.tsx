'use client';

/**
 * Conditional BIA surface for a control (the no-dead-tab UI). Fetches the
 * server-resolved `getControlBiaSurface` and renders EXACTLY one of:
 *   - continuity → a "Business Continuity" section listing the linked BIAs
 *     as evidence the requirement (NIS2 Art.21(2)(c)) is operationalised;
 *   - process    → a one-line derived impact chip ("Protects … MTPD 4h");
 *   - none       → nothing at all.
 * A generic control with no continuity/process link renders NOTHING — the
 * component itself is the enforcement of the conditional-wiring contract.
 */
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ShieldCheck } from '@/components/ui/icons/nucleo/shield-check';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { cardVariants } from '@/components/ui/card';
import { Heading } from '@/components/ui/typography';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { cn } from '@inflect/ui/lib/cn';

type Surface =
    | { kind: 'none' }
    | { kind: 'continuity'; bias: { id: string; name: string; criticality: string; mtpdHours: number | null }[] }
    | { kind: 'process'; processLabel: string; biaId: string; name: string; mtpdHours: number | null; recoveryRank: number };

const CRITICALITY_VARIANT: Record<string, StatusBadgeVariant> = {
    CRITICAL: 'error',
    HIGH: 'error',
    MEDIUM: 'warning',
    LOW: 'info',
};

export function ControlBiaSurface({ controlId }: { controlId: string }) {
    const { tenantSlug } = useParams<{ tenantSlug: string }>();
    const tenantHref = (path: string) => `/t/${tenantSlug}${path}`;
    const t = useTranslations('panels.bia');
    const tr = useTranslations();
    const CRIT_LABELS: Record<string, string> = {
        LOW: tr('panels.criticalityLabels.LOW'), MEDIUM: tr('panels.criticalityLabels.MEDIUM'),
        HIGH: tr('panels.criticalityLabels.HIGH'), CRITICAL: tr('panels.criticalityLabels.CRITICAL'),
    };
    const { data, error, mutate } = useTenantSWR<Surface>(`/controls/${controlId}/bia-surface`);

    // R2-P4 — a load failure was previously swallowed (error not even read),
    // so the surface vanished silently. Show a small recoverable notice.
    if (error && !data) {
        return (
            <button
                type="button"
                onClick={() => void mutate()}
                className="inline-flex items-center gap-tight rounded-md border border-border-subtle bg-bg-default/50 px-2 py-1 text-xs text-content-muted hover:border-border-emphasis"
                data-testid="control-bia-error"
            >
                {t('loadError')}
            </button>
        );
    }

    if (!data || data.kind === 'none') return null;

    if (data.kind === 'process') {
        return (
            <Link
                href={tenantHref(`/audits/business-continuity/${data.biaId}`)}
                className="inline-flex items-center gap-tight rounded-md border border-border-subtle bg-bg-default/50 px-2 py-1 text-xs text-content-muted hover:border-border-emphasis"
                data-testid="control-bia-chip"
            >
                <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-content-subtle" aria-hidden="true" />
                {t('protects')} <span className="font-medium text-content-default">{data.processLabel}</span>
                {data.mtpdHours != null && <> · {t('mtpd', { hours: data.mtpdHours })}</>}
                {' '}· {t('recovery', { rank: data.recoveryRank })}
            </Link>
        );
    }

    // continuity
    return (
        <div className={cn(cardVariants({ density: 'none' }), 'space-y-default')} data-testid="control-bia-continuity">
            <div className="flex items-center gap-tight">
                <ShieldCheck className="h-4 w-4 text-content-success" aria-hidden="true" />
                <Heading level={3}>{t('businessContinuity')}</Heading>
            </div>
            <p className="text-sm text-content-muted">
                {t('continuityEvidence')}
            </p>
            {data.bias.length === 0 ? (
                <p className="text-sm text-content-subtle">{t('biaLinkedEmpty')}</p>
            ) : (
                <ul className="space-y-tight">
                    {data.bias.map((b) => (
                        <li key={b.id} className="flex items-center gap-compact text-sm">
                            <StatusBadge variant={CRITICALITY_VARIANT[b.criticality] ?? 'neutral'}>{CRIT_LABELS[b.criticality] ?? b.criticality}</StatusBadge>
                            <Link href={tenantHref(`/audits/business-continuity/${b.id}`)} className="text-content-link hover:underline">
                                {b.name}
                            </Link>
                            {b.mtpdHours != null && <span className="text-content-subtle">{t('mtpd', { hours: b.mtpdHours })}</span>}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
