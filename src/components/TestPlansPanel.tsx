'use client';
/* TODO(swr-migration): this file has fetch-on-mount + setState
 * patterns flagged by react-hooks/set-state-in-effect. Each call site
 * carries an inline disable directive; collectively they should
 * migrate to useTenantSWR (Epic 69 shape) so the rule can lift. */

import { formatDate } from '@/lib/format-date';
import { useEffect, useState, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AppIcon } from '@/components/icons/AppIcon';
import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons/nucleo';
import { useTenantApiUrl, useTenantHref, useTenantContext } from '@/lib/tenant-context-provider';
import { usePublishDisplayedOrder } from '@/lib/hooks/use-entity-list-ids';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { useToast } from '@/components/ui/hooks/use-toast';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';

interface TestPlan {
    id: string;
    name: string;
    method: string;
    frequency: string;
    status: string;
    nextDueAt: string | null;
    owner?: { id: string; name: string | null; email: string } | null;
    _count?: { runs: number; steps: number };
    runs?: Array<{
        id: string;
        result: string | null;
        executedAt: string | null;
        status: string;
    }>;
}

const RESULT_BADGE: Record<string, StatusBadgeVariant> = {
    PASS: 'success', FAIL: 'error', INCONCLUSIVE: 'warning',
};
const STATUS_BADGE: Record<string, StatusBadgeVariant> = {
    ACTIVE: 'success', PAUSED: 'warning',
};

export default function TestPlansPanel({ controlId }: { controlId: string }) {
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const router = useRouter();
    const { permissions } = useTenantContext();
    const t = useTranslations('panels.testPlans');
    const tc = useTranslations('common');
    const tr = useTranslations();
    const toast = useToast();
    const FREQ_LABELS = useMemo<Record<string, string>>(() => ({
        AD_HOC: tr('controls.freq.adHoc'), DAILY: tr('controls.freq.daily'), WEEKLY: tr('controls.freq.weekly'),
        MONTHLY: tr('controls.freq.monthly'), QUARTERLY: tr('controls.freq.quarterly'), ANNUALLY: tr('controls.freq.annually'),
    }), [tr]);

    const [plans, setPlans] = useState<TestPlan[]>([]);
    const [loading, setLoading] = useState(true);
    const [showForm, setShowForm] = useState(false);
    const [name, setName] = useState('');
    const [frequency, setFrequency] = useState('QUARTERLY');
    const [saving, setSaving] = useState(false);
    const [creatingRunFor, setCreatingRunFor] = useState<string | null>(null);

    const fetchPlans = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(apiUrl(`/controls/${controlId}/tests/plans`));
            if (res.ok) setPlans(await res.json());
        } finally {
            setLoading(false);
        }
    }, [apiUrl, controlId]);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    useEffect(() => { fetchPlans(); }, [fetchPlans]);

    // #107 PUBLISH side. This panel is the only surface that lists ONE
    // control's test plans, so it owns their order — the control-scoped plan
    // detail at /controls/{controlId}/tests/{planId} steps within this set,
    // which is a different (and usually much shorter) sibling list than the
    // tenant-wide /tests register. `plans` is server order with no client
    // filter or sort, so what was fetched is what is painted.
    usePublishDisplayedOrder(CACHE_KEYS.controls.testPlans(controlId), plans);

    const createPlan = async () => {
        if (!name.trim()) return;
        setSaving(true);
        try {
            const res = await fetch(apiUrl(`/controls/${controlId}/tests/plans`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name, frequency }),
            });
            if (!res.ok) throw new Error(await res.text());
            setShowForm(false);
            setName('');
            await fetchPlans();
        } catch {
            toast.error(t('createFailed'));
        } finally {
            setSaving(false);
        }
    };

    const createRun = async (planId: string) => {
        setCreatingRunFor(planId);
        try {
            const res = await fetch(apiUrl(`/tests/plans/${planId}/runs`), { method: 'POST' });
            if (!res.ok) throw new Error(await res.text());
            const run = await res.json();
            // Client navigation (not a full page reload) for parity with
            // the rest of the app.
            router.push(tenantHref(`/tests/runs/${run.id}`));
        } catch {
            toast.error(t('runFailed'));
        } finally {
            setCreatingRunFor(null);
        }
    };

    const getLastRun = (plan: TestPlan) => {
        if (!plan.runs || plan.runs.length === 0) return null;
        return plan.runs[0];
    };

    const isOverdue = (d: string | null) => {
        if (!d) return false;
        return new Date(d) < new Date();
    };

    if (loading) return <div className="animate-pulse text-content-subtle text-sm py-4">{t('loading')}</div>;

    return (
        <div className="space-y-default">
            <div className="flex items-center justify-between">
                <Heading level={3}>{t('title')}</Heading>
                {permissions.canWrite && (
                    <Button
                        variant="primary"
                        icon={showForm ? undefined : <Plus className="-ml-0.5 -mr-2.5" />}
                        onClick={() => setShowForm(!showForm)}
                        id="create-test-plan-btn"
                    >
                        {showForm ? tc('cancel') : t('testPlan')}
                    </Button>
                )}
            </div>

            {showForm && (
                <div className={cn(cardVariants({ density: 'compact' }), 'space-y-compact animate-fadeIn')}>
                    <div>
                        <label className="text-xs text-content-muted block mb-1">{t('planNameLabel')}</label>
                        <input
                            className="input w-full"
                            value={name}
                            onChange={e => setName(e.target.value)}
                            placeholder={t('planNamePlaceholder')}
                            id="test-plan-name-input"
                        />
                    </div>
                    <div className="grid grid-cols-2 gap-compact">
                        <div>
                            <label className="text-xs text-content-muted block mb-1">{t('frequency')}</label>
                            <select className="input w-full" value={frequency} onChange={e => setFrequency(e.target.value)} id="test-plan-frequency-select">
                                {Object.entries(FREQ_LABELS).map(([v, l]) => (
                                    <option key={v} value={v}>{l}</option>
                                ))}
                            </select>
                        </div>
                        {/* PR-Q — the MANUAL/AUTOMATED method select was removed here
                            too: createTestPlan never mapped it to an automationType
                            or a schedule, so it was inert. Plans create MANUAL;
                            cadence is configured via the plan's schedule section. */}
                    </div>
                    <Button variant="primary" size="sm" onClick={createPlan} disabled={saving || !name.trim()} id="save-test-plan-btn">
                        {saving ? t('creating') : <><AppIcon name="save" size={14} className="inline-block mr-1" /> {t('createPlan')}</>}
                    </Button>
                </div>
            )}

            {plans.length === 0 && !showForm && (
                <div className="text-sm text-content-subtle py-4">{t('empty')}</div>
            )}

            {plans.length > 0 && (
                <div className="divide-y divide-slate-700/50">
                    {plans.map(plan => {
                        const lastRun = getLastRun(plan);
                        return (
                            <div key={plan.id} className="py-3 flex items-center justify-between group hover:bg-bg-muted/50 px-2 rounded transition">
                                <div className="flex-1 min-w-0">
                                    <Link
                                        href={tenantHref(`/controls/${controlId}/tests/${plan.id}`)}
                                        className="text-sm font-medium text-content-emphasis hover:text-[var(--brand-default)] transition"
                                        id={`test-plan-link-${plan.id}`}
                                    >
                                        {plan.name}
                                    </Link>
                                    <div className="flex items-center gap-tight mt-0.5 flex-wrap">
                                        <StatusBadge variant={STATUS_BADGE[plan.status] || 'neutral'} size="sm">
                                            {plan.status}
                                        </StatusBadge>
                                        <span className="text-xs text-content-subtle">{FREQ_LABELS[plan.frequency] || plan.frequency}</span>
                                        <span className="text-xs text-content-subtle">•</span>
                                        <span className="text-xs text-content-subtle">{plan.method}</span>
                                        {plan.nextDueAt && (
                                            <>
                                                <span className="text-xs text-content-subtle">•</span>
                                                <span className={`text-xs ${isOverdue(plan.nextDueAt) ? 'text-content-error font-semibold' : 'text-content-muted'}`}>
                                                    {t('due', { date: formatDate(plan.nextDueAt) })}
                                                </span>
                                            </>
                                        )}
                                        {plan.owner && (
                                            <>
                                                <span className="text-xs text-content-subtle">•</span>
                                                <span className="text-xs text-content-muted">{plan.owner.name || plan.owner.email}</span>
                                            </>
                                        )}
                                    </div>
                                </div>
                                <div className="flex items-center gap-tight ml-4">
                                    {lastRun?.result && (
                                        <StatusBadge variant={RESULT_BADGE[lastRun.result] || 'neutral'} size="sm">
                                            {lastRun.result}
                                        </StatusBadge>
                                    )}
                                    <span className="text-xs text-content-subtle">
                                        {t('runs', { count: plan._count?.runs ?? 0 })}
                                    </span>
                                    {permissions.canWrite && plan.status === 'ACTIVE' && (
                                        <Button
                                            variant="ghost"
                                            size="xs"
                                            className="opacity-0 group-hover:opacity-100 transition"
                                            onClick={() => createRun(plan.id)}
                                            disabled={creatingRunFor === plan.id}
                                            id={`run-test-btn-${plan.id}`}
                                        >
                                            {creatingRunFor === plan.id ? '...' : <><AppIcon name="run" size={14} className="inline-block mr-1" /> {t('run')}</>}
                                        </Button>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
