'use client';

/* RQ-7 — Bow-tie analysis: threat → event → consequence with control barriers.
   A read-time projection rendered either as an interactive xyflow canvas
   (default) or the accessible column list. */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';
import { ShieldCheck } from '@/components/ui/icons/nucleo/shield-check';
import { Bolt } from '@/components/ui/icons/nucleo/bolt';
import { TriangleWarning } from '@/components/ui/icons/nucleo/triangle-warning';
import { CurrencyDollar } from '@/components/ui/icons/nucleo/currency-dollar';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { useMoneyFormatter } from '@/lib/tenant-context-provider';
import type { BowTieGraph } from './BowTieCanvas';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';

// xyflow is client-only + heavy — load the canvas on demand.
const BowTieCanvas = dynamic(() => import('./BowTieCanvas').then((m) => m.BowTieCanvas), {
    ssr: false,
    loading: () => <div className="h-[480px] w-full rounded-md border border-border-default bg-bg-muted/20" />,
});

interface Barrier { controlId: string; title: string; status: string; effectiveness: number | null }
interface Projection {
    event: { riskId: string; title: string; category: string | null; score: number; ale: number | null };
    threats: Array<{ id: string; label: string; tef: number | null; vulnerability: number | null }>;
    preventiveBarriers: Barrier[];
    consequences: Array<{ id: string; label: string; magnitude: number | null; type: string }>;
    mitigatingBarriers: Barrier[];
}
// RQ3-OB-A — money speaks the tenant's currency (useMoneyFormatter).
const effVariant = (e: number | null) => (e == null ? 'neutral' : e >= 70 ? 'success' : e >= 40 ? 'warning' : 'error');

function BarrierChip({ b }: { b: Barrier }) {
    return (
        <div className="rounded-md border border-border-subtle bg-bg-muted/20 px-default py-tight text-sm">
            <div className="flex items-center justify-between gap-tight">
                <span className="flex items-center gap-tight truncate text-content-emphasis"><ShieldCheck className="size-3.5 shrink-0" />{b.title}</span>
                <StatusBadge variant={effVariant(b.effectiveness)}>{b.effectiveness == null ? '—' : `${b.effectiveness}%`}</StatusBadge>
            </div>
        </div>
    );
}

export function BowTiePanel({ riskId }: { riskId: string }) {
    const t = useTranslations('risks');
    const money = useMoneyFormatter();
    const [view, setView] = useState<'canvas' | 'list'>('canvas');
    // B2-2 — see RiskHistoryPanel: the `reloadKey` counter existed only to
    // re-run the effect on retry. `mutate()` replaces it.
    const { data, error, mutate } = useTenantSWR<{
        projection: Projection;
        graph?: BowTieGraph | null;
    }>(`/risks/${riskId}/bowtie`);
    const p = data?.projection ?? null;
    const graph = data?.graph ?? null;

    if (error) {
        return (
            <Card className="space-y-default p-6" data-testid="risk-bowtie-error">
                <p className="text-sm text-content-error">{t('bowtie.loadFailed')}</p>
                <Button size="sm" variant="secondary" onClick={() => void mutate()}>
                    {t('bowtie.retry')}
                </Button>
            </Card>
        );
    }
    if (!p) return <Card className="p-6"><p className="text-sm text-content-muted">{t('bowtie.loading')}</p></Card>;

    return (
        <Card className="space-y-default p-6" data-testid="risk-bowtie">
            <div className="flex flex-wrap items-center justify-between gap-default">
                <Heading level={2}>{t('bowtie.title')}</Heading>
                <span className="flex gap-tight">
                    <Button size="sm" variant={view === 'canvas' ? 'primary' : 'secondary'} onClick={() => setView('canvas')}>{t('bowtie.diagram')}</Button>
                    <Button size="sm" variant={view === 'list' ? 'primary' : 'secondary'} onClick={() => setView('list')}>{t('bowtie.list')}</Button>
                </span>
            </div>
            <p className="text-xs text-content-muted">{t('bowtie.description')}</p>

            {/* A projection can load with `graph: null` (nothing to draw yet —
                no threats/consequences mapped). That used to render as a blank
                area with no explanation; say so, and point at the list view. */}
            {view === 'canvas' && (graph
                ? <BowTieCanvas graph={graph} />
                : (
                    <div
                        className="flex h-[240px] flex-col items-center justify-center gap-tight rounded-md border border-border-subtle bg-bg-muted/20 text-center"
                        data-testid="risk-bowtie-empty"
                    >
                        <TriangleWarning className="size-5 text-content-subtle" />
                        <p className="text-sm text-content-muted">{t('bowtie.emptyTitle')}</p>
                        <p className="max-w-sm text-xs text-content-subtle">{t('bowtie.emptyDesc')}</p>
                    </div>
                )
            )}

            {view === 'list' && (
            <div className="grid grid-cols-1 gap-section lg:grid-cols-5">
                {/* Threats */}
                <div className="space-y-tight">
                    <Heading level={3} className="text-xs uppercase text-content-subtle">{t('bowtie.threats')}</Heading>
                    {p.threats.map((threat) => (
                        <div key={threat.id} className="flex items-center gap-tight rounded-md border border-border-subtle px-default py-tight text-sm text-content-emphasis"><Bolt className="size-3.5 shrink-0" />{threat.label}</div>
                    ))}
                </div>
                {/* Preventive barriers */}
                <div className="space-y-tight">
                    <Heading level={3} className="text-xs uppercase text-content-subtle">{t('bowtie.preventive')}</Heading>
                    {p.preventiveBarriers.length === 0 ? <p className="text-xs text-content-subtle">{t('bowtie.none')}</p> : p.preventiveBarriers.map((b) => <BarrierChip key={b.controlId} b={b} />)}
                </div>
                {/* Event */}
                <div className="flex flex-col items-center justify-center">
                    <div className="w-full rounded-lg border border-border-emphasis bg-bg-muted/30 p-default text-center">
                        <TriangleWarning className="mx-auto size-6 text-content-muted" />
                        <div className="font-medium text-content-emphasis">{p.event.title}</div>
                        <div className="mt-tight text-xs text-content-muted">{t('bowtie.scoreLabel')} {p.event.score} · {money(p.event.ale)}{t('perYear')}</div>
                    </div>
                </div>
                {/* Mitigating barriers */}
                <div className="space-y-tight">
                    <Heading level={3} className="text-xs uppercase text-content-subtle">{t('bowtie.mitigating')}</Heading>
                    {p.mitigatingBarriers.length === 0 ? <p className="text-xs text-content-subtle">{t('bowtie.none')}</p> : p.mitigatingBarriers.map((b) => <BarrierChip key={b.controlId} b={b} />)}
                </div>
                {/* Consequences */}
                <div className="space-y-tight">
                    <Heading level={3} className="text-xs uppercase text-content-subtle">{t('bowtie.consequences')}</Heading>
                    {p.consequences.map((c) => (
                        <div key={c.id} className="rounded-md border border-border-subtle px-default py-tight text-sm">
                            <div className="flex justify-between gap-tight">
                                <span className="flex items-center gap-tight truncate text-content-emphasis"><CurrencyDollar className="size-3.5 shrink-0" />{c.label}</span>
                                <span className="tabular-nums text-content-muted">{money(c.magnitude)}</span>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
            )}
        </Card>
    );
}
