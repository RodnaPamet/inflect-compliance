'use client';

/* RQ-9 — Risk velocity card: portfolio direction + fastest rising/falling. */
import { ArrowTrendUp } from '@/components/ui/icons/nucleo/arrow-trend-up';
import { PercentageArrowDown } from '@/components/ui/icons/nucleo/percentage-arrow-down';
import { Card } from '@/components/ui/card';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { useMoneyFormatter } from '@/lib/tenant-context-provider';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';

interface Vel { riskId: string; title: string; deltaPercent: number }
interface VelocityResult {
    topRising: Vel[]; topFalling: Vel[];
    portfolioVelocity: { currentTotalAle: number; previousTotalAle: number; deltaPercent: number; trend: string };
}
// RQ3-OB-A — money speaks the tenant's currency (useMoneyFormatter).

export function VelocityCard() {
    const t = useTranslations('risks');
    const money = useMoneyFormatter();
    // B2-2 — this used to be a bare fetch whose `.catch(() => {})` left `v`
    // null forever, and `if (!v) return null` rendered NOTHING. That made a
    // failed load pixel-identical to the two states below that legitimately
    // render nothing (still loading; genuinely no movement to report), so a
    // broken endpoint was indistinguishable from a quiet quarter and nobody
    // would ever report it.
    const { data, error, isLoading, mutate } = useTenantSWR<{ velocity: VelocityResult }>(
        '/risks/velocity',
    );
    const v = data?.velocity ?? null;

    if (error) {
        return (
            <Card className="space-y-default" data-testid="risk-velocity-error">
                <p className="text-sm text-content-error">{t('velocity.loadFailed')}</p>
                <Button size="sm" variant="secondary" onClick={() => void mutate()}>
                    {t('velocity.retry')}
                </Button>
            </Card>
        );
    }
    // Loading and "nothing to report" both stay silent — this card is a
    // supplementary dashboard slot, and a skeleton for a card that may have
    // nothing to say is worse than no card. Only the ERROR state is new.
    if (isLoading || !v) return null;
    const pv = v.portfolioVelocity;
    const improving = pv.trend === 'FALLING'; // falling ALE = improving
    if (v.topRising.length === 0 && v.topFalling.length === 0 && pv.previousTotalAle === 0) return null;

    return (
        <Card data-testid="risk-velocity">
            <Heading level={2} className="mb-default">{t('velocity.title')}</Heading>
            <div className="mb-default flex items-center gap-default text-sm">
                <span className="text-content-muted">{t('velocity.portfolio')}</span>
                <span className="tabular-nums text-content-emphasis">{money(pv.previousTotalAle)} → {money(pv.currentTotalAle)}</span>
                <StatusBadge variant={improving ? 'success' : pv.trend === 'RISING' ? 'error' : 'neutral'}>
                    {pv.deltaPercent >= 0 ? '+' : ''}{pv.deltaPercent.toFixed(1)}% {improving ? t('velocity.improving') : pv.trend === 'RISING' ? t('velocity.worsening') : t('velocity.stable')}
                </StatusBadge>
            </div>
            <div className="grid grid-cols-1 gap-section md:grid-cols-2">
                <div>
                    <Heading level={3} className="mb-2 text-xs uppercase text-content-subtle">{t('velocity.fastestRising')}</Heading>
                    {v.topRising.length === 0 ? <p className="text-xs text-content-subtle">{t('velocity.none')}</p> : v.topRising.map((r) => (
                        <div key={r.riskId} className="flex items-center gap-tight py-tight text-sm">
                            <ArrowTrendUp className="size-3.5 shrink-0 text-content-error" />
                            <span className="truncate text-content-emphasis">{r.title}</span>
                            <span className="ml-auto tabular-nums text-content-error">+{r.deltaPercent.toFixed(0)}%</span>
                        </div>
                    ))}
                </div>
                <div>
                    <Heading level={3} className="mb-2 text-xs uppercase text-content-subtle">{t('velocity.fastestFalling')}</Heading>
                    {v.topFalling.length === 0 ? <p className="text-xs text-content-subtle">{t('velocity.none')}</p> : v.topFalling.map((r) => (
                        <div key={r.riskId} className="flex items-center gap-tight py-tight text-sm">
                            <PercentageArrowDown className="size-3.5 shrink-0 text-content-success" />
                            <span className="truncate text-content-emphasis">{r.title}</span>
                            <span className="ml-auto tabular-nums text-content-success">{r.deltaPercent.toFixed(0)}%</span>
                        </div>
                    ))}
                </div>
            </div>
        </Card>
    );
}
