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
 * - The approval is its own act (#5313 item 11): a save sends only the fields
 *   it edits and never an approval, the server clears an approval when the
 *   statement or a limit changes, and Approve is offered only to a viewer the
 *   server would let approve (`admin.tenant_lifecycle`, OWNER-only), and only
 *   when what is on screen is what is stored.
 * - Approve is bound to the version on screen (owner decision 2026-11-15): it
 *   sends the id and `updatedAt` this page loaded, and a save made since then
 *   is refused (409, `RISK_APPETITE_CHANGED_SINCE_VIEWED`). The page says so
 *   and re-reads, so the approver sees the new terms before approving them.
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
import { useOffersAdminApiWrite } from '@/lib/auth/use-offers-admin-api-write';
import { isAppetiteChangedSinceViewed } from '@/lib/risk-appetite-approval';

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
    /** Not edited here, but sent back so a save keeps them. */
    categoryOverridesJson: Record<string, unknown> | null;
    nextReviewAt: string | null;
}
interface Approval { approvedAt: string; approverName: string | null }
/** The stored row this page last read: what an approval approves. */
interface Viewed { configId: string; viewedUpdatedAt: string }
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

const DEFAULT_CONFIG: Config = { totalAleThreshold: null, singleRiskAleMax: null, qualScoreMax: null, testedPercentile: 80, appetiteStatement: null, reviewCadence: 'ANNUALLY', categoryOverridesJson: null, nextReviewAt: null };

/**
 * The PUT body: the fields this page saves, and nothing else. The server's
 * schema is strict, so the row's own columns (id, the approval, timestamps)
 * must not be spread back into it.
 */
function bodyOf(c: Config): Config {
    return {
        totalAleThreshold: c.totalAleThreshold,
        singleRiskAleMax: c.singleRiskAleMax,
        qualScoreMax: c.qualScoreMax,
        testedPercentile: c.testedPercentile,
        appetiteStatement: c.appetiteStatement,
        reviewCadence: c.reviewCadence,
        categoryOverridesJson: c.categoryOverridesJson,
        nextReviewAt: c.nextReviewAt,
    };
}

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
    const [approval, setApproval] = useState<Approval | null>(null);
    // What is stored, as a PUT body: null until a configuration has been saved.
    const [stored, setStored] = useState<string | null>(null);
    // The version of what is stored, sent with Approve so the server stamps
    // only the terms this page showed.
    const [viewed, setViewed] = useState<Viewed | null>(null);
    const [approving, setApproving] = useState(false);
    // The route's key and the usecase's floor (#5313 item 11): OWNER-only.
    const mayApprove = useOffersAdminApiWrite({ key: 'admin.tenant_lifecycle', floor: 'canAdmin' });

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
                const next = bodyOf({ ...DEFAULT_CONFIG, ...c.config } as Config);
                setCfg(next);
                setStored(JSON.stringify(next));
                setViewed(
                    typeof c.config.id === 'string' && typeof c.config.updatedAt === 'string'
                        ? { configId: c.config.id, viewedUpdatedAt: c.config.updatedAt }
                        : null,
                );
                setTyped({
                    totalAleThreshold: next.totalAleThreshold == null ? '' : String(next.totalAleThreshold),
                    singleRiskAleMax: next.singleRiskAleMax == null ? '' : String(next.singleRiskAleMax),
                    qualScoreMax: next.qualScoreMax == null ? '' : String(next.qualScoreMax),
                });
            }
            setStatus(c.status ?? null);
            setApproval(c.approval ?? null);
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

    /** The body a save would send, or null while a limit does not parse. */
    const pendingBody = (): Config | null => {
        if (invalid.length > 0) return null;
        const body = bodyOf(cfg);
        for (const k of LIMIT_KEYS) {
            const p = parsed[k];
            if (p.ok) body[k] = p.value;
        }
        return body;
    };
    const pending = pendingBody();
    // Approve approves what is STORED, so it waits until the screen matches it.
    const unsaved = stored === null || pending === null || JSON.stringify(pending) !== stored;

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
        const body = pendingBody();
        if (body === null) return;
        setSaving(true); setMsg(null);
        try {
            const res = await fetch(apiUrl('/risk-appetite'), {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            });
            if (res.ok) { setMsg({ text: t('riskAppetite.saved'), ok: true }); await load(); }
            else setMsg({ text: await refusalOf(res, t('riskAppetite.saveFailed')), ok: false });
        } catch {
            setMsg({ text: t('riskAppetite.saveFailed'), ok: false });
        } finally { setSaving(false); }
    };

    const approve = async () => {
        if (viewed === null) return;
        setApproving(true); setMsg(null);
        try {
            const res = await fetch(apiUrl('/risk-appetite/approve'), {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(viewed),
            });
            if (res.ok) { setMsg({ text: t('riskAppetite.approvedMsg'), ok: true }); await load(); }
            else if (res.status === 409) {
                // Somebody saved since this page loaded: say so, then show
                // what is stored now, so it is reviewed before it is approved.
                const body: unknown = await res.json().catch(() => null);
                setMsg({
                    text: isAppetiteChangedSinceViewed(body)
                        ? t('riskAppetite.approveChangedSinceViewed')
                        : apiRefusalMessage(body, t('riskAppetite.approveFailed')),
                    ok: false,
                });
                await load();
            }
            else setMsg({ text: await refusalOf(res, t('riskAppetite.approveFailed')), ok: false });
        } catch {
            setMsg({ text: t('riskAppetite.approveFailed'), ok: false });
        } finally { setApproving(false); }
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
                        <span className="text-xs text-content-subtle">
                            {t('riskAppetite.percentileHint')}
                        </span>
                    </div>
                    <p className="text-sm text-content-muted" id="appetite-approval">
                        {approval
                            ? approval.approverName
                                ? t('riskAppetite.approvedBy', { name: approval.approverName, date: formatDate(new Date(approval.approvedAt)) })
                                : t('riskAppetite.approvedOn', { date: formatDate(new Date(approval.approvedAt)) })
                            : t('riskAppetite.notApproved')}
                    </p>
                    {msg && <InlineNotice variant={msg.ok ? 'success' : 'error'}><span data-testid="appetite-save-msg">{msg.text}</span></InlineNotice>}
                    <div className="flex flex-wrap items-center justify-end gap-tight">
                        {mayApprove && stored !== null && unsaved && (
                            <span className="text-xs text-content-muted" id="appetite-approve-save-first">{t('riskAppetite.approveSaveFirst')}</span>
                        )}
                        {mayApprove && stored !== null && (
                            <Button variant="secondary" onClick={approve} disabled={approving || saving || unsaved || viewed === null} id="appetite-approve">
                                {approving ? t('riskAppetite.approving') : t('riskAppetite.approve')}
                            </Button>
                        )}
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
