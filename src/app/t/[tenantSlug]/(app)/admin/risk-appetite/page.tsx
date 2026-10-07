'use client';

/* RQ-2 — Risk appetite configuration + breach history. */
import { useState, useEffect, useCallback } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { StatusBadge } from '@/components/ui/status-badge';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { useTenantApiUrl, useTenantHref, useMoneyFormatter } from '@/lib/tenant-context-provider';
import { formatDate } from '@inflect/ui/lib/format-date';
import { useTranslations } from 'next-intl';

type Cadence = 'MONTHLY' | 'QUARTERLY' | 'SEMI_ANNUALLY' | 'ANNUALLY';
type TestedPercentile = 50 | 80 | 90 | 95 | 99;
interface Config {
    totalAleThreshold: number | null;
    singleRiskAleMax: number | null;
    qualScoreMax: number | null;
    /** RQ3-3 — which simulated percentile the ceiling is tested at. */
    testedPercentile: TestedPercentile;
    appetiteStatement: string | null;
    reviewCadence: Cadence;
}
interface Breach {
    id: string; breachType: string; thresholdValue: number; actualValue: number;
    detectedAt: string; resolvedAt: string | null; acknowledgedAt: string | null; riskId: string | null; category: string | null;
    /** RQ2-6 — the remediation task spawned from this breach. */
    remediationTaskId: string | null;
}
// RQ3-OB-A — the local $-formatter is dead; money speaks the
// tenant's currency via the canonical formatter.

export default function RiskAppetitePage() {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const money = useMoneyFormatter();
    const [cfg, setCfg] = useState<Config>({ totalAleThreshold: null, singleRiskAleMax: null, qualScoreMax: null, testedPercentile: 80, appetiteStatement: null, reviewCadence: 'ANNUALLY' });
    const [status, setStatus] = useState<{
        status: string;
        portfolioAle: number;
        /** RQ3-3 — the figure the ceiling was actually tested at. */
        portfolioTested: { value: number; percentile: number; simulated: boolean } | null;
        activeBreaches: number;
    } | null>(null);
    const [breaches, setBreaches] = useState<Breach[]>([]);
    const [saving, setSaving] = useState(false);
    const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

    const load = useCallback(async () => {
        try {
            const [c, b] = await Promise.all([
                fetch(apiUrl('/risk-appetite')).then((r) => r.ok ? r.json() : null),
                fetch(apiUrl('/risk-appetite/breaches')).then((r) => r.ok ? r.json() : null),
            ]);
            if (c?.config) setCfg({ ...cfg, ...c.config });
            if (c?.status) setStatus(c.status);
            if (b?.breaches) setBreaches(b.breaches);
        } catch { /* ignore */ }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [apiUrl]);
    useEffect(() => { void load(); }, [load]);

    const numField = (label: string, k: 'totalAleThreshold' | 'singleRiskAleMax' | 'qualScoreMax', hint: string) => (
        <label className="block">
            <span className="text-xs text-content-muted">{t('riskAppetite.fieldWithHint', { label, hint })}</span>
            <Input type="text" inputMode="decimal" value={cfg[k] ?? ''} onChange={(e) => setCfg({ ...cfg, [k]: e.target.value.trim() === '' ? null : Number(e.target.value) })} />
        </label>
    );

    const save = async () => {
        setSaving(true); setMsg(null);
        try {
            const res = await fetch(apiUrl('/risk-appetite'), {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg),
            });
            if (res.ok) { setMsg({ text: t('riskAppetite.saved'), ok: true }); await load(); } else setMsg({ text: t('riskAppetite.saveFailed'), ok: false });
        } finally { setSaving(false); }
    };

    const acknowledge = async (id: string) => {
        await fetch(apiUrl('/risk-appetite/breaches'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ breachId: id }) });
        await load();
    };

    // RQ2-6 — spawn THE remediation task for a breach (idempotent
    // server-side; a second click just re-fetches the same task).
    const [spawningTaskFor, setSpawningTaskFor] = useState<string | null>(null);
    const createRemediationTask = async (id: string) => {
        setSpawningTaskFor(id);
        try {
            await fetch(apiUrl(`/risk-appetite/breaches/${id}/remediation-task`), { method: 'POST' });
            await load();
        } finally {
            setSpawningTaskFor(null);
        }
    };

    const statusVariant = status?.status === 'BREACHED' ? 'error' : status?.status === 'APPROACHING' ? 'warning' : 'success';

    return (
        <div className="space-y-section">
            <BackAffordance />
            <PageBreadcrumbs items={[{ label: t('crumb.admin'), href: tenantHref('/admin') }, { label: t('riskAppetite.crumb') }]} />
            <div className="flex items-center justify-between">
                <Heading level={1}>{t('riskAppetite.title')}</Heading>
                {status && status.status !== 'NONE' && (
                    <StatusBadge variant={statusVariant}>
                        {status.status === 'BREACHED' ? t('riskAppetite.statusBreached', { count: status.activeBreaches }) : status.status === 'APPROACHING' ? t('riskAppetite.statusApproaching') : t('riskAppetite.statusWithin')} · {status.portfolioTested?.simulated
                            ? `P${status.portfolioTested.percentile} ${money(status.portfolioTested.value)}/yr`
                            : `${money(status.portfolioAle)}/yr`}
                    </StatusBadge>
                )}
            </div>

            <Card className="space-y-default p-6">
                <Heading level={2}>{t('riskAppetite.configuration')}</Heading>
                <label className="block">
                    <span className="text-xs text-content-muted">{t('riskAppetite.appetiteStatement')}</span>
                    <Textarea rows={3} value={cfg.appetiteStatement ?? ''} onChange={(e) => setCfg({ ...cfg, appetiteStatement: e.target.value })} />
                </label>
                <div className="grid grid-cols-1 gap-default sm:grid-cols-3">
                    {numField(t('riskAppetite.portfolioCeiling'), 'totalAleThreshold', t('riskAppetite.hintPerYear'))}
                    {numField(t('riskAppetite.singleRiskMax'), 'singleRiskAleMax', t('riskAppetite.hintDollar'))}
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
                {msg && <InlineNotice variant={msg.ok ? 'success' : 'error'}>{msg.text}</InlineNotice>}
                <div className="flex justify-end">
                    <Button variant="primary" onClick={save} disabled={saving}>{saving ? t('riskAppetite.saving') : t('riskAppetite.saveConfig')}</Button>
                </div>
            </Card>

            <Card className="space-y-default p-6">
                <Heading level={2}>{t('riskAppetite.breachHistory')}</Heading>
                {breaches.length === 0 ? (
                    <p className="text-sm text-content-muted">{t('riskAppetite.breachesEmpty')}</p>
                ) : (
                    <ul className="divide-y divide-border-subtle">
                        {breaches.map((b) => (
                            // polish #12 — the row anchors itself by
                            // breach id so a remediation task's
                            // /admin/risk-appetite#breach-{id} link
                            // scrolls the assignee to the source row.
                            <li key={b.id} id={`breach-${b.id}`} className="flex flex-wrap items-center gap-default py-default text-sm scroll-mt-default target:bg-bg-muted/50">
                                <StatusBadge variant={b.resolvedAt ? 'success' : 'error'}>{b.resolvedAt ? t('riskAppetite.resolved') : t('riskAppetite.active')}</StatusBadge>
                                <span className="font-mono text-xs">{b.breachType}</span>
                                <span className="text-content-muted">{t('riskAppetite.thresholdActual', { threshold: money(b.thresholdValue), actual: money(b.actualValue) })}</span>
                                <span className="ml-auto text-xs text-content-muted">{formatDate(new Date(b.detectedAt))}</span>
                                {!b.resolvedAt && !b.acknowledgedAt && (
                                    <Button size="sm" variant="ghost" onClick={() => acknowledge(b.id)}>{t('riskAppetite.acknowledge')}</Button>
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
