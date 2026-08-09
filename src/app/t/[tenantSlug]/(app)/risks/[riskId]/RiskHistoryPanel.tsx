'use client';

/* RQ-9 — Risk history tab: score + ALE trend over snapshots. */
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/typography';
import { useMoneyFormatter } from '@/lib/tenant-context-provider';
import { formatDate } from '@/lib/format-date';
import { sparkline } from '@/lib/ascii-sparkline';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { StatTile } from '../_shared/StatTile';

interface Snap { id: string; score: number; ale: number | null; snapshotAt: string }
// RQ3-OB-A — money speaks the tenant's currency (useMoneyFormatter).

export function RiskHistoryPanel({ riskId }: { riskId: string }) {
    const t = useTranslations('risks');
    const money = useMoneyFormatter();
    // B2-2 — `useTenantSWR` owns the fetch, the loading flag, the error and
    // the retry. The hand-rolled version needed a `reloadKey` counter purely
    // to re-run the effect on retry; `mutate()` is that, without the state.
    const { data, error, isLoading, mutate } = useTenantSWR<{ history?: Snap[] }>(
        `/risks/${riskId}/history`,
    );
    const history = data ? data.history ?? [] : null;

    if (error) {
        return (
            <Card className="space-y-default p-6" data-testid="risk-history-error">
                <p className="text-sm text-content-error">{t('history.loadFailed')}</p>
                <Button size="sm" variant="secondary" onClick={() => void mutate()}>
                    {t('history.retry')}
                </Button>
            </Card>
        );
    }
    if (isLoading || !history) return <Card className="p-6"><p className="text-sm text-content-muted">{t('history.loading')}</p></Card>;
    if (history.length === 0) {
        return <Card className="p-6"><p className="text-sm text-content-muted">{t('history.empty')}</p></Card>;
    }

    const aleSeries = history.map((s) => s.ale ?? 0);
    const scoreSeries = history.map((s) => s.score);
    const first = history[0]; const last = history[history.length - 1];
    const aleDelta = (last.ale ?? 0) - (first.ale ?? 0);

    return (
        <Card className="space-y-default p-6" data-testid="risk-history">
            <Heading level={2}>{t('history.title')}</Heading>
            <p className="text-xs text-content-muted">{t('history.snapshotsCount', { count: history.length })} · {formatDate(new Date(first.snapshotAt))} → {formatDate(new Date(last.snapshotAt))}</p>
            <div className="grid grid-cols-1 gap-default sm:grid-cols-2">
                <StatTile tone="subtle">
                    <div className="text-xs text-content-muted">{t('history.aleTrend')}</div>
                    <div className="font-mono text-lg leading-none text-content-emphasis" aria-label={t('history.aleTrend')}>{sparkline(aleSeries)}</div>
                    <div className="mt-tight text-sm tabular-nums text-content-muted">{money(first.ale)} → {money(last.ale)} ({aleDelta >= 0 ? '+' : '−'}{money(Math.abs(aleDelta))})</div>
                </StatTile>
                <StatTile tone="subtle">
                    <div className="text-xs text-content-muted">{t('history.scoreTrend')}</div>
                    <div className="font-mono text-lg leading-none text-content-emphasis" aria-label={t('history.scoreTrend')}>{sparkline(scoreSeries)}</div>
                    <div className="mt-tight text-sm tabular-nums text-content-muted">{first.score} → {last.score}</div>
                </StatTile>
            </div>
        </Card>
    );
}
