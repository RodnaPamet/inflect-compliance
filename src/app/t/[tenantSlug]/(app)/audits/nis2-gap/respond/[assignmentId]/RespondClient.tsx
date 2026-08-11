'use client';

import { useCallback, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/typography';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { PageHeader } from '@/components/layout/PageHeader';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { cardVariants } from '@/components/ui/card';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantMutation } from '@/lib/hooks/use-tenant-mutation';
import { ApiClientError } from '@/lib/api-client';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { cn } from '@/lib/cn';

// CC BY 4.0 attribution — carries everywhere derived NIS2 content renders.
const NIS2_ATTRIBUTION =
    'NIS2 gap-assessment questions © NISD2 contributors (Kardashev Catalyst UG / nisd2.eu), CC BY 4.0';
const NIS2_SOURCE_URL = 'https://github.com/NISD2/nis2-gap-assessment-schema';
const ANSWERS = ['YES', 'PARTIALLY', 'NO', 'NA'] as const;

type Bilingual = { en: string; de: string };
type Question = { id: string; domainId: number; plainText: Bilingual; legalBasis: string; criticality: string };
type Domain = { id: number; code: string; name: Bilingual };
// `assessmentId` is on the row the API already returns — declared here because
// the owner's per-role assignment table is keyed on it, and that table shows
// the status badge this page's submit flips.
type Assignment = { id: string; assessmentId: string; respondentRole: string; status: string; questionIds: string[] };
type Payload = { assignment: Assignment; questions: Question[]; domains: Domain[]; answers: Array<{ questionId: string; answer: string }> };
type AnswerInput = { questionId: string; answer: string };

export function RespondClient({ tenantSlug, assignmentId }: { tenantSlug: string; assignmentId: string }) {
    const tx = useTranslations('audits');
    const locale = useLocale();
    const lang = locale === 'de' ? 'de' : 'en';
    const apiUrl = useCallback((path: string) => `/api/t/${tenantSlug}${path}`, [tenantSlug]);

    // ─── Read ───
    //
    // The fetch + useEffect + useState triple became one SWR key, named in the
    // registry so the submit below targets the same string by construction — a
    // mutation keyed on a near-miss string updates nothing and reads as a slow
    // network.
    //
    // The failure distinction survives: SWR's `error` is the failed request
    // (carrying the API envelope's own message where there is one, exactly as
    // the old hand-rolled `error.message ?? loadFailed` did), while `data`
    // absent WITHOUT an error is still loading. A blip never renders as an
    // empty assignment.
    const assignmentKey = CACHE_KEYS.gapAssignments.detail(assignmentId);
    const assignmentQuery = useTenantSWR<Payload>(assignmentKey);
    const data = assignmentQuery.data ?? null;
    const loading = assignmentQuery.isLoading;
    // Only an envelope-derived message is shown; anything else falls back to the
    // localized string. `handleErrorResponse` synthesises
    // `Request failed with status NNN` when the body carries no `{ error: … }`
    // (a gateway 502, a non-JSON body) and leaves `code` at `UNKNOWN` — and that
    // synthetic string is truthy, so a bare `error.message || fallback` would
    // put untranslated English on screen where the old code showed
    // `respond.loadFailed`. The server's own message stays preferred when there
    // IS one, because it names the actual problem ("not your assignment").
    const loadError = assignmentQuery.error
        ? (assignmentQuery.error instanceof ApiClientError &&
           assignmentQuery.error.code !== 'UNKNOWN'
              ? assignmentQuery.error.message
              : tx('respond.loadFailed'))
        : null;

    // The saved answers are the baseline; `edits` holds ONLY what the user has
    // changed in this session, and the rendered map is the two merged. This is
    // deliberately a derivation rather than a state seeded from the payload:
    // `useTenantSWR` revalidates on window focus, and a seeding effect would
    // wipe half-finished answers every time the respondent tabbed away and back
    // — the old code got away with it only because it fetched exactly once.
    const [edits, setEdits] = useState<Record<string, string>>({});
    const answers = useMemo(() => {
        const saved: Record<string, string> = Object.fromEntries(
            (data?.answers ?? []).map((a) => [a.questionId, a.answer]),
        );
        return { ...saved, ...edits };
    }, [data, edits]);

    const [notice, setNotice] = useState<string | null>(null);
    const [submitError, setSubmitError] = useState<string | null>(null);

    const byDomain = useMemo(() => {
        const groups = new Map<number, Question[]>();
        for (const q of data?.questions ?? []) {
            const arr = groups.get(q.domainId) ?? [];
            arr.push(q);
            groups.set(q.domainId, arr);
        }
        return groups;
    }, [data]);

    // Both siblings render what this write changes: the owner's per-role table
    // shows each assignment's status badge (and gates finalize on all-submitted),
    // and the gap dashboard's score / answered counts are computed from the very
    // answers being written here.
    const assessmentId = data?.assignment.assessmentId ?? null;
    const invalidate = useMemo(
        () => [
            CACHE_KEYS.audits.nis2Gap(),
            ...(assessmentId ? [CACHE_KEYS.gapAssessments.assignments(assessmentId)] : []),
        ],
        [assessmentId],
    );

    const submitMutation = useTenantMutation<Payload, AnswerInput[], { written: number } | null>({
        key: assignmentKey,
        // NO optimistic update, deliberately. The status flip to SUBMITTED is
        // derivable — the usecase sets it unconditionally on success — but
        // predicting it here would unmount the submit button (its render is
        // gated on that field), taking the in-flight spinner with it and
        // painting the page's TERMINAL state over a request that can genuinely
        // fail: an out-of-bucket question id is a 403 at the data layer. A user
        // who reads "already submitted" and navigates away in that second never
        // sees the rollback. Waiting one round trip is the honest answer for a
        // form submit; the cycle-status control predicts because its control
        // stays on screen either way.
        mutationFn: async (payload) => {
            const res = await fetch(apiUrl(`${assignmentKey}/submit`), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ answers: payload }),
            });
            if (!res.ok) {
                const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
                throw new Error(body?.error?.message ?? tx('respond.submitFailed'));
            }
            return res.json().catch(() => null);
        },
        invalidate,
    });
    const saving = submitMutation.isMutating;

    const handleSubmit = useCallback(async () => {
        setSubmitError(null);
        setNotice(null);
        try {
            // The hook revalidates `assignmentKey` on success, which is what the
            // explicit `await load()` used to do — minus the full-page spinner,
            // since `keepPreviousData` holds the answered list on screen.
            await submitMutation.trigger(
                Object.entries(answers).map(([questionId, answer]) => ({ questionId, answer })),
            );
            setNotice(tx('respond.submitted'));
        } catch (e) {
            setSubmitError(e instanceof Error ? e.message : tx('respond.submitFailed'));
        }
    }, [answers, submitMutation, tx]);

    // One line, two sources, same slot as before: a submit failure is the
    // freshest thing the user did, so it wins over a stale load error.
    const error = submitError ?? loadError;
    const answeredCount = Object.keys(answers).length;

    return (
        <div className="space-y-section animate-fadeIn">
            <BackAffordance />
            <PageHeader
                breadcrumbs={[
                    { label: tx('crumb.dashboard'), href: `/t/${tenantSlug}/dashboard` },
                    { label: tx('crumb.audits'), href: `/t/${tenantSlug}/audits` },
                    { label: tx('nav.nis2Gap'), href: `/t/${tenantSlug}/audits/nis2-gap` },
                    { label: tx('crumb.respond') },
                ]}
                title={tx('respond.title')}
                description={tx('respond.description')}
                actions={
                    data && data.assignment.status !== 'SUBMITTED' ? (
                        <Button variant="primary" onClick={handleSubmit} disabled={saving || answeredCount === 0} id="nis2-respond-submit-btn">
                            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                            {answeredCount > 0 ? tx('respond.submitN', { count: answeredCount }) : tx('respond.submitZero')}
                        </Button>
                    ) : undefined
                }
            />

            {notice && <InlineNotice variant="success">{notice}</InlineNotice>}
            {error && <p className="text-sm text-content-error">{error}</p>}

            {loading ? (
                <div className="flex items-center gap-tight p-6 text-content-muted text-sm">
                    <Loader2 className="w-4 h-4 animate-spin" /> {tx('respond.loading')}
                </div>
            ) : !data ? null : (
                <>
                    {data.assignment.status === 'SUBMITTED' && (
                        <InlineNotice variant="info">{tx('respond.alreadySubmitted')}</InlineNotice>
                    )}
                    {data.domains
                        .filter((d) => (byDomain.get(d.id) ?? []).length > 0)
                        .map((d) => (
                            <div key={d.id} className="space-y-default">
                                <Heading level={3}>{d.name?.[lang] ?? d.code}</Heading>
                                <ul className="space-y-tight">
                                    {(byDomain.get(d.id) ?? []).map((q) => (
                                        <li key={q.id} className={cn(cardVariants({ density: 'compact' }), 'space-y-tight')}>
                                            <div className="flex items-start gap-tight flex-wrap">
                                                <StatusBadge variant="neutral" size="sm">{q.criticality}</StatusBadge>
                                                <span className="text-sm font-medium text-content-emphasis">{q.plainText?.[lang] ?? q.id}</span>
                                            </div>
                                            <p className="text-xs text-content-muted">{tx('respond.legalBasis', { legalBasis: q.legalBasis })}</p>
                                            <RadioGroup
                                                value={answers[q.id] ?? ''}
                                                onValueChange={(v) => setEdits((prev) => ({ ...prev, [q.id]: v }))}
                                                className="flex gap-default flex-wrap"
                                            >
                                                {ANSWERS.map((a) => (
                                                    <label key={a} className="flex items-center gap-tight text-sm cursor-pointer">
                                                        <RadioGroupItem value={a} /> {a}
                                                    </label>
                                                ))}
                                            </RadioGroup>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        ))}

                    <p className="text-xs text-content-subtle">
                        {NIS2_ATTRIBUTION}{' '}
                        <a href={NIS2_SOURCE_URL} target="_blank" rel="noopener noreferrer" className="underline hover:text-content-muted">{tx('nis2Gap.sourceLink')}</a>
                    </p>
                </>
            )}
        </div>
    );
}
