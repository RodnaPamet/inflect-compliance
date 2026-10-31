'use client';

/**
 * Risk appetite: the board's statement, the limits Inflect checks daily, and
 * every breach of them (#4822 made every failure on this page visible).
 *
 * - A limit is parsed, not cast. `Number('1,000,000')` is NaN, which JSON
 *   sends as null, so a thousands separator used to clear the limit and still
 *   say "Saved.". A value that does not parse now blocks the save, beside its
 *   field.
 * - A failed read says so, with a retry, rather than showing the defaults and
 *   "No breaches recorded." as if nothing were configured.
 * - Saving, acknowledging and creating a task say why they failed.
 */
import { useState, useEffect, useCallback } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { StatusBadge } from '@/components/ui/status-badge';
import { InlineNotice } from '@/components/ui/inline-notice';
import { ErrorState } from '@/components/ui/error-state';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { useToast } from '@/components/ui/hooks';
import { apiRefusalMessage } from '@/lib/api-error';
import { useTenantApiUrl, useTenantHref, useMoneyFormatter, useCurrencySymbol } from '@/lib/tenant-context-provider';
import { formatDate } from '@inflect/ui/lib/format-date';
import { parseLimit } from '@/lib/risk-appetite-limit';
import { useTranslations } from 'next-intl';

type Cadence = 'MONTHLY' | 'QUARTERLY' | 'SEMI_ANNUALLY' | 'ANNUALLY';
type TestedPercentile = 50 | 80 | 90 | 95 | 99;
type LimitKey = 'totalAleThreshold' | 'singleRiskAleMax' | 'qualScoreMax';
interface Config {
    totalAleThreshold: number | null;
    singleRiskAleMax: number | null;
    qualScoreMax: number | null;
    testedPercentile: TestedPercentile;
    appetiteStatement: string | null;
    reviewCadence: Cadence;
}
interface Breach {
    id: string; breachType: string; thresholdValue: number; actualValue: number;
    detectedAt: string; resolvedAt: string | null; acknowledgedAt: string | null; riskId: string | null; category: string | null;
    remediationTaskId: string | null;
}

const LIMIT_KEYS: readonly LimitKey[] = ['totalAleThreshold', 'singleRiskAleMax', 'qualScoreMax'];
const BREACH_TYPES = ['PORTFOLIO_ALE', 'SINGLE_RISK_ALE', 'QUAL_SCORE', 'CATEGORY_ALE'] as const;

/** The server's reason for a 4xx, or the fallback for anything else. */
async function refusalOf(res: Response, fallback: string): Promise<string> {
    if (res.status >= 500) return fallback;
    const body: unknown = await res.json().catch(() => null);
    return apiRefusalMessage(body, fallback);
}

const DEFAULT_CONFIG: Config = { totalAleThreshold: null, singleRiskAleMax: null, qualScoreMax: null, testedPercentile: 80, appetiteStatement: null, reviewCadence: 'ANNUALLY' };

export default function RiskAppetitePage() {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const money = useMoneyFormatter();
    const currency = useCurrencySymbol();
    const toast = useToast();
    const [cfg, setCfg] = useState<Config>(DEFAULT_CONFIG);
    // The limits as typed, so a value that does not parse is kept on screen
    // and refused, rather than silently becoming null.
    const [typed, setTyped] = useState<Record<LimitKey, string>>({ totalAleThreshold: '', singleRiskAleMax: '', qualScoreMax: '' });
    const [status, setStatus] = useState<{
        status: string;
        portfolioAle: number;
        portfolioTested: { value: number; percentile: number; simulated: boolean } | null;
        activeBreaches: number;
    } | null>(null);
    const [breaches, setBreaches] = useState<Breach[]>([]);
    const [loadFailed, setLoadFailed] = useState(false);
    const [breachesFailed, setBreachesFailed] = useState(false);
    const [saving, setSaving] = useState(false);
    const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

    const load = useCallback(async () => {
        const [c, b] = await Promise.all([
            fetch(apiUrl('/risk-appetite')).then((r) => (r.ok ? r.json() : null)).catch(() => null),
            fetch(apiUrl('/risk-appetite/breaches')).then((r) => (r.ok ? r.json() : null)).catch(() => null),
        ]);
        // Both flags are set from the answer, so a retry that succeeds clears
        // the failure it retried.
        setLoadFailed(c === null);
        setBreachesFailed(b === null);
        if (c !== null) {
            if (c.config) {
                const next = { ...DEFAULT_CONFIG, ...c.config } as Config;
                setCfg(next);
                setTyped({
                    totalAleThreshold: next.totalAleThreshold == null ? '' : String(next.totalAleThreshold),
                    singleRiskAleMax: next.singleRiskAleMax == null ? '' : String(next.singleRiskAleMax),
                    qualScoreMax: next.qualScoreMax == null ? '' : String(next.qualScoreMax),
                });
            }
            setStatus(c.status ?? null);
        }
        if (b !== null) setBreaches(b.breaches ?? []);
    }, [apiUrl]);
    // Fetch-on-mount; every state write in `load` follows its await. Same
    // pattern, and the same directive, as the other admin pages awaiting the
    // useTenantSWR migration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { void load(); }, [load]);

    const parsed = Object.fromEntries(LIMIT_KEYS.map((k) => [k, parseLimit(typed[k])])) as Record<LimitKey, ReturnType<typeof parseLimit>>;
    const invalid = LIMIT_KEYS.filter((k) => !parsed[k].ok);

    const numField = (label: string, k: LimitKey, hint: string) => (
        <label className="block">
            <span className="text-xs text-content-muted">{t('riskAppetite.fieldWithHint', { label, hint })}</span>
            <Input
                type="text"
                inputMode="decimal"
                id={`appetite-${k}`}
                value={typed[k]}
                aria-invalid={!parsed[k].ok}
                onChange={(e) => { setTyped((p) => ({ ...p, [k]: e.target.value })); setMsg(null); }}
            />
            {!parsed[k].ok && (
                <span className="text-xs text-content-error" data-testid={`appetite-invalid-${k}`}>{t('riskAppetite.invalidNumber')}</span>
            )}
        </label>
    );

    const save = async () => {
        if (invalid.length > 0) return;
        setSaving(true); setMsg(null);
        try {
            const body: Config = { ...cfg };
            for (const k of LIMIT_KEYS) {
                const p = parsed[k];
                if (p.ok) body[k] = p.value;
            }
            const res = await fetch(apiUrl('/risk-appetite'), {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            });
            if (res.ok) { setMsg({ text: t('riskAppetite.saved'), ok: true }); await load(); }
            else setMsg({ text: await refusalOf(res, t('riskAppetite.saveFailed')), ok: false });
        } catch {
            setMsg({ text: t('riskAppetite.saveFailed'), ok: false });
        } finally { setSaving(false); }
    };

    const acknowledge = async (id: string) => {
        try {
            const res = await fetch(apiUrl('/risk-appetite/breaches'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ breachId: id }) });
            if (!res.ok) { toast.error(await refusalOf(res, t('riskAppetite.actionFailed'))); return; }
            await load();
        } catch {
            toast.error(t('riskAppetite.actionFailed'));
        }
    };

    const [spawningTaskFor, setSpawningTaskFor] = useState<string | null>(null);
    const createRemediationTask = async (id: string) => {
        setSpawningTaskFor(id);
        try {
            const res = await fetch(apiUrl(`/risk-appetite/breaches/${id}/remediation-task`), { method: 'POST' });
            if (!res.ok) { toast.error(await refusalOf(res, t('riskAppetite.actionFailed'))); return; }
            await load();
        } catch {
            toast.error(t('riskAppetite.actionFailed'));
        } finally {
            setSpawningTaskFor(null);
        }
    };

    // A score breach is a likelihood × impact score, not an amount.
    const breachValue = (b: Breach, v: number) => (b.breachType === 'QUAL_SCORE' ? String(v) : money(v));
    const breachTypeLabel = (type: string) =>
        (BREACH_TYPES as readonly string[]).includes(type) ? t(`riskAppetite.breachType.${type as (typeof BREACH_TYPES)[number]}`) : type;

    const statusVariant = status?.status === 'BREACHED' ? 'error' : status?.status === 'APPROACHING' ? 'warning' : 'success';
    const statusAmount = status
        ? status.portfolioTested
            ? t('riskAppetite.testedAmount', { percentile: status.portfolioTested.percentile, amount: money(status.portfolioTested.value) })
            : t('riskAppetite.perYear', { amount: money(status.portfolioAle) })
        : '';

    return (
        <div className="space-y-section">
            <BackAffordance />
            <PageBreadcrumbs
                items={[
                    { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
                    { label: t('crumb.admin'), href: tenantHref('/admin') },
                    { label: t('riskAppetite.crumb') },
                ]}
            />
            <div className="flex items-center justify-between">
                <Heading level={1}>{t('riskAppetite.title')}</Heading>
                {status && status.status !== 'NONE' && (
                    <StatusBadge variant={statusVariant} id="appetite-status">
                        {status.status === 'BREACHED' ? t('riskAppetite.statusBreached', { count: status.activeBreaches }) : status.status === 'APPROACHING' ? t('riskAppetite.statusApproaching') : t('riskAppetite.statusWithin')}
                        {' · '}
                        {statusAmount}
                    </StatusBadge>
                )}
            </div>

            {loadFailed ? (
                <ErrorState title={t('riskAppetite.loadFailed')} onRetry={() => { void load(); }} />
            ) : (
                <Card className="space-y-default p-6">
                    <Heading level={2}>{t('riskAppetite.configuration')}</Heading>
                    <label className="block">
                        <span className="text-xs text-content-muted">{t('riskAppetite.appetiteStatement')}</span>
                        <Textarea rows={3} value={cfg.appetiteStatement ?? ''} onChange={(e) => setCfg({ ...cfg, appetiteStatement: e.target.value })} />
                    </label>
                    <div className="grid grid-cols-1 gap-default sm:grid-cols-3">
                        {numField(t('riskAppetite.portfolioCeiling'), 'totalAleThreshold', t('riskAppetite.hintPerYear', { currency }))}
                        {numField(t('riskAppetite.singleRiskMax'), 'singleRiskAleMax', t('riskAppetite.hintDollar', { currency }))}
                        {numField(t('riskAppetite.qualScoreMax'), 'qualScoreMax', t('riskAppetite.hintOf25'))}
                    </div>
                    {/* RQ3-3 — board-level policy: which simulated
                        percentile the portfolio ceiling is tested at.
                        P50 = a typical year; P95 = severe-tail planning. */}
                    <div className="flex flex-wrap items-center gap-tight" data-testid="appetite-tested-percentile">
                        <span className="text-xs text-content-muted">{t('riskAppetite.ceilingTestedAt')}</span>
                        {([50, 80, 90, 95, 99] as TestedPercentile[]).map((pVal) => (
                            <Button
                                key={pVal}
                                size="sm"
                                variant={cfg.testedPercentile === pVal ? 'secondary' : 'ghost'}
                                onClick={() => setCfg({ ...cfg, testedPercentile: pVal })}
                            >
                                P{pVal}
                            </Button>
                        ))}
                        <span className="text-[10px] text-content-subtle">
                            {t('riskAppetite.percentileHint')}
                        </span>
                    </div>
                    {msg && <InlineNotice variant={msg.ok ? 'success' : 'error'}><span data-testid="appetite-save-msg">{msg.text}</span></InlineNotice>}
                    <div className="flex justify-end">
                        <Button variant="primary" onClick={save} disabled={saving || invalid.length > 0} id="appetite-save">{saving ? t('riskAppetite.saving') : t('riskAppetite.saveConfig')}</Button>
                    </div>
                </Card>
            )}

            <Card className="space-y-default p-6">
                <Heading level={2}>{t('riskAppetite.breachHistory')}</Heading>
                {breachesFailed ? (
                    <InlineNotice variant="error" icon={null}>
                        <span data-testid="appetite-breaches-failed">{t('riskAppetite.breachesLoadFailed')}</span>
                    </InlineNotice>
                ) : breaches.length === 0 ? (
                    <p className="text-sm text-content-muted">{t('riskAppetite.breachesEmpty')}</p>
                ) : (
                    <ul className="divide-y divide-border-subtle">
                        {breaches.map((b) => (
                            <li key={b.id} id={`breach-${b.id}`} className="flex flex-wrap items-center gap-default py-default text-sm scroll-mt-default target:bg-bg-muted/50">
                                <StatusBadge variant={b.resolvedAt ? 'success' : 'error'}>{b.resolvedAt ? t('riskAppetite.resolved') : t('riskAppetite.active')}</StatusBadge>
                                {b.acknowledgedAt && !b.resolvedAt && (
                                    <StatusBadge variant="neutral" data-testid={`breach-acknowledged-${b.id}`}>{t('riskAppetite.acknowledged')}</StatusBadge>
                                )}
                                <span className="font-medium" data-testid={`breach-type-${b.id}`}>{breachTypeLabel(b.breachType)}</span>
                                <span className="text-content-muted" data-testid={`breach-values-${b.id}`}>{t('riskAppetite.thresholdActual', { threshold: breachValue(b, b.thresholdValue), actual: breachValue(b, b.actualValue) })}</span>
                                <span className="ml-auto text-xs text-content-muted">{formatDate(new Date(b.detectedAt))}</span>
                                {!b.resolvedAt && !b.acknowledgedAt && (
                                    <Button size="sm" variant="ghost" onClick={() => acknowledge(b.id)} data-testid={`breach-ack-${b.id}`}>{t('riskAppetite.acknowledge')}</Button>
                                )}
                                {/* RQ2-6 — breach → remediation task. */}
                                {b.remediationTaskId ? (
                                    <a
                                        href={tenantHref(`/tasks/${b.remediationTaskId}`)}
                                        className="text-xs underline text-content-default"
                                        data-testid={`breach-task-link-${b.id}`}
                                    >
                                        {t('riskAppetite.viewTask')}
                                    </a>
                                ) : !b.resolvedAt ? (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => createRemediationTask(b.id)}
                                        disabled={spawningTaskFor === b.id}
                                        data-testid={`breach-task-create-${b.id}`}
                                    >
                                        {spawningTaskFor === b.id ? t('riskAppetite.creating') : t('riskAppetite.createTask')}
                                    </Button>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                )}
            </Card>
        </div>
    );
}
