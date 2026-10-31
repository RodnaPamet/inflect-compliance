'use client';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Heading } from '@/components/ui/typography';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { KPIStat } from '@/components/ui/metric';
import { cardVariants } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { cn } from '@inflect/ui/lib/cn';

// computeRequirementsDiff (framework/fixtures.ts) — inline literal return.
interface DiffRequirement {
    code: string;
    title: string;
    section: string | null | undefined;
}
interface ChangedSide {
    title: string;
    section: string | null | undefined;
    description?: string | null;
}
interface RequirementsDiff {
    from: { key: string; name: string; version: string | null };
    to: { key: string; name: string; version: string | null };
    added: DiffRequirement[];
    removed: DiffRequirement[];
    changed: Array<{
        code: string;
        changes: string[];
        from: ChangedSide;
        to: ChangedSide;
    }>;
    summary: {
        added: number;
        removed: number;
        changed: number;
        unmappedNewRequirements: number;
    };
}
/** listFrameworks (framework/catalog.ts), the fields the picker reads. */
interface FrameworkOption {
    key: string;
    name: string;
    version: string | null;
}

/** The refusals the diff names (framework/fixtures.ts). */
const DIFF_REFUSALS = ['DIFF_FROM_NOT_FOUND', 'DIFF_TO_NOT_FOUND'] as const;
type DiffRefusal = (typeof DIFF_REFUSALS)[number];
function diffRefusal(body: unknown): DiffRefusal | null {
    const reason = (body as { error?: { details?: { reason?: unknown } } } | null)?.error?.details?.reason;
    return typeof reason === 'string' && (DIFF_REFUSALS as readonly string[]).includes(reason)
        ? (reason as DiffRefusal)
        : null;
}

/** The fields a change can name, in the order the page shows them. */
const CHANGE_FIELDS = ['title', 'section', 'description'] as const;

type Outcome =
    | { request: string; diff: RequirementsDiff }
    | { request: string; failure: { reason: DiffRefusal | null } | 'network' };

export default function DiffPage() {
    const t = useTranslations('frameworks');
    const params = useParams();
    const router = useRouter();
    const searchParams = useSearchParams();
    const tenantSlug = params.tenantSlug as string;
    const frameworkKey = params.frameworkKey as string;
    const apiUrl = useCallback((path: string) => `/api/t/${tenantSlug}${path}`, [tenantSlug]);

    const fromKey = searchParams.get('from') || '';
    const [attempt, setAttempt] = useState(0);
    // The settled answer for one request (from key + attempt). A request is
    // loading until its own answer lands, so no state is set synchronously in
    // the effect. #4732 — a failure is kept as data and worded at render:
    // which framework was missing, or a retry for anything else.
    const request = `${fromKey}#${attempt}`;
    const [outcome, setOutcome] = useState<Outcome | null>(null);
    const [activeTab, setActiveTab] = useState<'added' | 'removed' | 'changed'>('added');
    const [frameworks, setFrameworks] = useState<FrameworkOption[] | null>(null);
    const [frameworksFailed, setFrameworksFailed] = useState(false);

    // The "from" side is chosen on the page, from the catalogue by name. It
    // used to be a `?from=FRAMEWORK_KEY` the person had to type into the
    // address bar (#4732).
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const res = await fetch(apiUrl('/frameworks'));
                if (cancelled) return;
                if (!res.ok) { setFrameworksFailed(true); return; }
                setFrameworks(await res.json());
            } catch {
                if (!cancelled) setFrameworksFailed(true);
            }
        })();
        return () => { cancelled = true; };
    }, [apiUrl]);

    useEffect(() => {
        if (!fromKey) return;
        let cancelled = false;
        const thisRequest = `${fromKey}#${attempt}`;
        void (async () => {
            try {
                const res = await fetch(apiUrl(`/frameworks/${frameworkKey}?action=diff&from=${encodeURIComponent(fromKey)}`));
                const body = await res.json().catch(() => null);
                if (cancelled) return;
                setOutcome(res.ok
                    ? { request: thisRequest, diff: body as RequirementsDiff }
                    : { request: thisRequest, failure: { reason: diffRefusal(body) } });
            } catch {
                if (!cancelled) setOutcome({ request: thisRequest, failure: 'network' });
            }
        })();
        return () => { cancelled = true; };
    }, [apiUrl, frameworkKey, fromKey, attempt]);

    const current = fromKey && outcome?.request === request ? outcome : null;
    const loadingDiff = fromKey !== '' && current === null;
    const diff = current && 'diff' in current ? current.diff : null;
    const failure = current && 'failure' in current ? current.failure : null;

    /** A framework's name, with its version only when it has one ("vnull" otherwise). */
    const label = (f: { name: string; version: string | null }) =>
        f.version ? t('diff.nameVersion', { name: f.name, version: f.version }) : f.name;

    const options: ComboboxOption<string>[] = useMemo(
        () =>
            (frameworks ?? [])
                .filter((f) => f.key !== frameworkKey)
                .map((f) => ({ value: f.key, label: f.version ? `${f.name} v${f.version}` : f.name })),
        [frameworks, frameworkKey],
    );
    const chosen = options.find((o) => o.value === fromKey) ?? null;
    const choose = (key: string) => {
        router.replace(`/t/${tenantSlug}/frameworks/${frameworkKey}/diff?from=${encodeURIComponent(key)}`);
    };

    const failureText =
        failure === null
            ? ''
            : failure === 'network'
                ? t('diff.loadDataFailed')
                : failure.reason
                    ? t(`diff.refused.${failure.reason}`)
                    : t('diff.computeFailed');

    const changeNames = (changes: string[]) =>
        CHANGE_FIELDS.filter((f) => changes.includes(f)).map((f) => t(`diff.field.${f}`)).join(', ');

    return (
        <div className="space-y-section animate-fadeIn">
            <BackAffordance />
            <div>
                <Heading level={1} className="mt-2" id="diff-heading">
                    {t('diff.heading')}
                </Heading>
                {diff && (
                    <p className="text-sm text-content-muted mt-1">
                        {t('diff.comparing')} <span className="text-[var(--brand-default)]">{label(diff.from)}</span>
                        {' → '}
                        <span className="text-[var(--brand-default)]">{label(diff.to)}</span>
                    </p>
                )}
            </div>

            <div className={cn(cardVariants(), 'space-y-tight')} id="diff-from-picker">
                <FormField label={t('diff.compareFrom')}>
                    <Combobox
                        options={options}
                        selected={chosen}
                        onSelect={(o) => { if (o.value) choose(o.value); }}
                        placeholder={frameworks === null && !frameworksFailed ? t('diff.loadingFrameworks') : t('diff.chooseFramework')}
                        disabled={frameworks === null}
                        matchTriggerWidth
                        aria-label={t('diff.compareFrom')}
                    />
                </FormField>
                {frameworksFailed && <p className="text-xs text-content-error" id="diff-frameworks-failed">{t('diff.frameworksFailed')}</p>}
                {!fromKey && <p className="text-xs text-content-subtle" id="diff-choose-hint">{t('diff.chooseHint')}</p>}
            </div>

            {loadingDiff && <div className="animate-pulse text-content-muted">{t('diff.loading')}</div>}

            {failure && (
                <InlineNotice variant="error" id="diff-error">
                    <span>{failureText}</span>
                    {(failure === 'network' || !failure.reason) && (
                        <Button variant="secondary" size="sm" className="ml-2" onClick={() => setAttempt((n) => n + 1)} id="diff-retry">
                            {t('diff.retry')}
                        </Button>
                    )}
                </InlineNotice>
            )}

            {diff && (
                <>
                    {/* Summary cards — Polish PR-2: KPIStat primitive. */}
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-default" id="diff-summary">
                        <div className={cardVariants({ density: 'none' })}>
                            <KPIStat value={diff.summary.added} label={t('diff.added')} tone="success" />
                        </div>
                        <div className={cardVariants({ density: 'none' })}>
                            <KPIStat value={diff.summary.removed} label={t('diff.removed')} tone="critical" />
                        </div>
                        <div className={cardVariants({ density: 'none' })}>
                            <KPIStat value={diff.summary.changed} label={t('diff.changed')} tone="attention" />
                        </div>
                        <div className={cardVariants({ density: 'none' })}>
                            <KPIStat
                                value={diff.summary.unmappedNewRequirements}
                                label={t('diff.newUnmapped')}
                                tone={diff.summary.unmappedNewRequirements > 0 ? 'critical' : 'success'}
                            />
                        </div>
                    </div>

                    {/* Tabs */}
                    <div className="flex gap-1 bg-bg-default/50 p-1 rounded-lg w-fit" id="diff-tabs">
                        {(['added', 'removed', 'changed'] as const).map(tab => (
                            <button
                                key={tab}
                                onClick={() => setActiveTab(tab)}
                                className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${activeTab === tab ? 'bg-brand-600 text-content-emphasis' : 'text-content-muted hover:text-content-emphasis'
                                    }`}
                                id={`diff-tab-${tab}`}
                            >
                                {t(`diff.${tab}`)} ({diff[tab].length})
                            </button>
                        ))}
                    </div>

                    {/* Content */}
                    <div className="space-y-tight" id="diff-content">
                        {activeTab === 'added' && diff.added.map((r, i: number) => (
                            <div key={i} className={cn(cardVariants({ density: 'none' }), 'flex items-center gap-compact')}>
                                <span className="text-content-success text-lg font-bold">+</span>
                                <code className="text-xs text-[var(--brand-default)] font-mono w-28 flex-shrink-0">{r.code}</code>
                                <span className="text-sm text-content-default">{r.title}</span>
                                {r.section && <span className="text-xs text-content-subtle ml-auto">{r.section}</span>}
                            </div>
                        ))}

                        {activeTab === 'removed' && diff.removed.map((r, i: number) => (
                            <div key={i} className={cn(cardVariants({ density: 'none' }), 'flex items-center gap-compact')}>
                                <span className="text-content-error text-lg font-bold">−</span>
                                <code className="text-xs text-content-muted font-mono w-28 flex-shrink-0 line-through">{r.code}</code>
                                <span className="text-sm text-content-subtle line-through">{r.title}</span>
                                {r.section && <span className="text-xs text-content-subtle ml-auto">{r.section}</span>}
                            </div>
                        ))}

                        {activeTab === 'changed' && diff.changed.map((r, i: number) => (
                            <div key={i} className={cardVariants({ density: 'none' })} data-testid="diff-changed-row">
                                <div className="flex items-center gap-compact mb-2">
                                    <span className="text-content-warning text-lg font-bold">~</span>
                                    <code className="text-xs text-[var(--brand-default)] font-mono">{r.code}</code>
                                    <span className="text-xs text-content-subtle">{t('diff.changedList', { changes: changeNames(r.changes) })}</span>
                                </div>
                                <div className="ml-8 space-y-1">
                                    {r.changes.includes('title') && (
                                        <div className="text-xs">
                                            <span className="text-content-error line-through">{r.from.title}</span>
                                            <span className="text-content-subtle mx-2">→</span>
                                            <span className="text-content-success">{r.to.title}</span>
                                        </div>
                                    )}
                                    {r.changes.includes('section') && (
                                        <div className="text-xs">
                                            <span className="text-content-subtle">{t('diff.section')} </span>
                                            <span className="text-content-error">{r.from.section || t('diff.none')}</span>
                                            <span className="text-content-subtle mx-2">→</span>
                                            <span className="text-content-success">{r.to.section || t('diff.none')}</span>
                                        </div>
                                    )}
                                    {/* #4732 — a description change was named and never shown. */}
                                    {r.changes.includes('description') && (
                                        <div className="text-xs space-y-1" data-testid="diff-description-change">
                                            <p>
                                                <span className="text-content-subtle">{t('diff.before')} </span>
                                                <span className="text-content-default whitespace-pre-line">{r.from.description || t('diff.none')}</span>
                                            </p>
                                            <p>
                                                <span className="text-content-subtle">{t('diff.after')} </span>
                                                <span className="text-content-default whitespace-pre-line">{r.to.description || t('diff.none')}</span>
                                            </p>
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))}

                        {diff[activeTab].length === 0 && (
                            <div className={cn(cardVariants({ density: 'none' }), 'text-center py-6 text-content-subtle')}>
                                {t(`diff.empty${activeTab.charAt(0).toUpperCase()}${activeTab.slice(1)}`)}
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
