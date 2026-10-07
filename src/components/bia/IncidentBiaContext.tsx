'use client';

/**
 * Recovery-deadline context for a live incident — the BIA co-location
 * payoff. Fetches the BIAs reachable from the incident's linked controls
 * (control → process → BIA) and surfaces their MTPD as the recovery clock.
 * Renders nothing when no BIA resolves (no dead surface).
 */
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { LifeRing } from '@/components/ui/icons/nucleo/life-ring';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { cn } from '@inflect/ui/lib/cn';
import { cardVariants } from '@/components/ui/card';

interface BiaContextRow {
    id: string;
    name: string;
    criticality: string;
    mtpdHours: number | null;
    rtoHours: number | null;
}

export function IncidentBiaContext({ incidentId }: { incidentId: string }) {
    const { tenantSlug } = useParams<{ tenantSlug: string }>();
    const tenantHref = (path: string) => `/t/${tenantSlug}${path}`;
    const t = useTranslations('panels.bia');
    const { data } = useTenantSWR<{ rows: BiaContextRow[] }>(`/incidents/${incidentId}/bia-context`);
    const rows = data?.rows ?? [];
    if (rows.length === 0) return null;

    return (
        <div
            className={cn(cardVariants({ density: 'none' }), 'space-y-tight border-border-emphasis')}
            data-testid="incident-bia-context"
        >
            <div className="flex items-center gap-tight">
                <LifeRing className="h-4 w-4 text-content-attention" aria-hidden="true" />
                <span className="text-sm font-medium text-content-default">{t('recoveryDeadlines')}</span>
            </div>
            <ul className="space-y-tight">
                {rows.map((b) => (
                    <li key={b.id} className="text-sm text-content-muted">
                        {t('affects')}{' '}
                        <Link href={tenantHref(`/audits/business-continuity/${b.id}`)} className="text-content-link hover:underline">
                            {b.name}
                        </Link>
                        {b.mtpdHours != null ? (
                            <span className="text-content-default"> — {t('mtpd', { hours: b.mtpdHours })}</span>
                        ) : (
                            <span className="text-content-subtle">{t('noMtpd')}</span>
                        )}
                        {b.rtoHours != null && <span className="text-content-subtle">{t('rto', { hours: b.rtoHours })}</span>}
                    </li>
                ))}
            </ul>
        </div>
    );
}
