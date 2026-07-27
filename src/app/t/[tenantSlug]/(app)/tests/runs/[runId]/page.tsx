'use client';
/* Routing note (Task 2): this RUN lives at the top-level
 * /tests/runs/{runId} while its parent PLAN lives under
 * /controls/{controlId}/tests/{planId}. That split route tree is
 * deliberate (moving it is riskier + out of scope) — the breadcrumbs
 * below bridge the hop back through the control's plan so the parent
 * context never flips between Controls and Tests. */

import { formatDate } from '@/lib/format-date';
import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useParams, useRouter } from 'next/navigation';
import { Paperclip } from 'lucide-react';
import { textLinkVariants } from '@/components/ui/typography';
import { useTenantApiUrl, useTenantHref, useTenantContext } from '@/lib/tenant-context-provider';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { Combobox, ComboboxOption } from '@/components/ui/combobox';
import { useToast } from '@/components/ui/hooks/use-toast';
import { Tooltip } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ApiClientError } from '@/lib/api-client';
import { Plus } from '@/components/ui/icons/nucleo';
import { buttonVariants } from '@/components/ui/button-variants';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { type BreadcrumbItem } from '@/components/ui/breadcrumbs';
import { StatusBadge } from '@/components/ui/status-badge';
import { buildRunStatusLabels, buildResultLabels, RESULT_BADGE } from '../../_components/test-plan-labels';
import { Heading } from '@/components/ui/typography';
import { MetaStrip } from '@/components/ui/meta-strip';
import { Card, cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';

const buildEvKindOptions = (t: (key: string) => string): ComboboxOption[] => [
    { value: 'FILE_UPLOAD', label: t('evKind.fileUpload') },
    { value: 'LINK', label: t('evKind.link') },
    { value: 'EVIDENCE', label: t('evKind.evidence') },
];

interface EvidenceLink {
    id: string;
    kind: string;
    url: string | null;
    note: string | null;
    fileId: string | null;
    evidenceId: string | null;
    evidence?: { id: string; title: string; type: string } | null;
    createdBy?: { name: string | null; email: string } | null;
    createdAt: string;
}

interface TestStepRef {
    id: string;
    sortOrder: number;
    instruction: string;
    expectedOutput: string | null;
}

interface TestRunDetail {
    id: string;
    status: string;
    result: string | null;
    notes: string | null;
    findingSummary: string | null;
    executedAt: string | null;
    controlId: string;
    testPlanId: string;
    testPlan?: { id: string; name: string; controlId: string; frequency: string; steps?: TestStepRef[] } | null;
    executedBy?: { name: string | null; email: string } | null;
    createdBy?: { name: string | null; email: string } | null;
    evidence: EvidenceLink[];
    createdAt: string;
}

export default function TestRunPage() {
    const t = useTranslations('controlTests');
    const EV_KIND_OPTIONS = useMemo(() => buildEvKindOptions(t), [t]);
    // R4-P3 #11 — render enums through the SHARED label builders so the run page
    // speaks the same localized vocabulary ("Completed" / "Pass") as the plan
    // detail + register, instead of the raw enum it printed before.
    const RUN_STATUS_LABELS = useMemo(() => buildRunStatusLabels(t), [t]);
    const RESULT_LABELS = useMemo(() => buildResultLabels(t), [t]);
    // Localized labels for the linked-evidence KIND badge (FILE / LINK / EVIDENCE),
    // which the list rendered as the raw enum.
    const EVIDENCE_KIND_LABELS = useMemo<Record<string, string>>(() => ({
        FILE: t('run.evidenceKind.file'),
        LINK: t('run.evidenceKind.link'),
        EVIDENCE: t('run.evidenceKind.evidence'),
    }), [t]);
    const params = useParams();
    const router = useRouter();
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const { permissions } = useTenantContext();
    const toast = useToast();
    const runId = params?.runId as string;

    // Epic 69 — canonical tenant-aware read. Guided-runner mutations
    // (start / complete / evidence link+unlink / retest) refetch via
    // mutate() instead of the old imperative fetchRun().
    const { data: run, isLoading, error, mutate } = useTenantSWR<TestRunDetail>(`/tests/runs/${runId}`);

    // Guided run — RUNNING transition + per-step checklist (ephemeral aid).
    const [starting, setStarting] = useState(false);
    const [checkedSteps, setCheckedSteps] = useState<Set<string>>(new Set());

    // Complete form
    const [result, setResult] = useState<'PASS' | 'FAIL' | 'INCONCLUSIVE'>('PASS');
    const [notes, setNotes] = useState('');
    const [findingSummary, setFindingSummary] = useState('');
    const [completing, setCompleting] = useState(false);
    const [confirmingComplete, setConfirmingComplete] = useState(false);

    // Evidence form
    const [showEvForm, setShowEvForm] = useState(false);
    const [evKind, setEvKind] = useState<'LINK' | 'EVIDENCE' | 'FILE_UPLOAD'>('FILE_UPLOAD');
    const [evUrl, setEvUrl] = useState('');
    const [evNote, setEvNote] = useState('');
    const [evEvidenceId, setEvEvidenceId] = useState('');
    const [evFile, setEvFile] = useState<File | null>(null);
    const [evFileTitle, setEvFileTitle] = useState('');
    const [evError, setEvError] = useState('');
    const [linkingEv, setLinkingEv] = useState(false);
    const [unlinkingId, setUnlinkingId] = useState<string | null>(null);

    const [retesting, setRetesting] = useState(false);

    // PR-R — hardening surface: integrity verify, evidence-bundle export,
    // and snapshot-to-audit-pack (all previously routed but unsurfaced).
    const [verifying, setVerifying] = useState(false);
    const [integrity, setIntegrity] = useState<null | {
        integrityOk: boolean; fileLinks: number; verified: number; mismatches: number; unverifiable: number;
    }>(null);
    const [snapshotPackId, setSnapshotPackId] = useState('');
    const [snapshotting, setSnapshotting] = useState(false);

    // Draft audit packs a completed run can be snapshotted into.
    const { data: packsData } = useTenantSWR<Array<{ id: string; name: string; status: string }>>('/audits/packs');
    const draftPackOptions = useMemo<ComboboxOption[]>(
        () => (packsData ?? []).filter((p) => p.status === 'DRAFT').map((p) => ({ value: p.id, label: p.name })),
        [packsData],
    );

    const verifyIntegrity = async () => {
        setVerifying(true);
        try {
            const res = await fetch(apiUrl(`/tests/runs/${runId}/verify-evidence`));
            if (!res.ok) throw new Error(await res.text());
            setIntegrity(await res.json());
        } catch {
            toast.error(t('run.integrity.error'));
        } finally {
            setVerifying(false);
        }
    };

    const snapshotToPack = async () => {
        if (!snapshotPackId) return;
        setSnapshotting(true);
        try {
            const res = await fetch(apiUrl(`/tests/runs/${runId}/snapshot`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ auditPackId: snapshotPackId }),
            });
            if (!res.ok) throw new Error((await res.text()) || '');
            toast.success(t('run.snapshot.success'));
            setSnapshotPackId('');
        } catch (err) {
            // Surface the server's actual reason (pack CLOSED, run not
            // completed, …) instead of a blanket "failed" that reassures
            // the user nothing went wrong.
            const msg = err instanceof Error && err.message ? err.message : t('run.snapshot.failed');
            toast.error(msg);
        } finally {
            setSnapshotting(false);
        }
    };

    const handleRetest = async () => {
        setRetesting(true);
        try {
            const res = await fetch(apiUrl(`/tests/runs/${runId}/retest`), { method: 'POST' });
            if (!res.ok) throw new Error(await res.text());
            const newRun = await res.json();
            router.push(tenantHref(`/tests/runs/${newRun.id}`));
        } catch {
            toast.error(t('run.errors.retestFailed'));
        } finally {
            setRetesting(false);
        }
    };

    // Evidence library for the EVIDENCE-kind picker — read via SWR and
    // derived to options, replacing the old fetch-into-setState effect.
    // The endpoint may return a bare array or a `{ items }` envelope.
    const { data: evidenceData } = useTenantSWR<
        { id: string; title: string }[] | { items?: { id: string; title: string }[] }
    >('/evidence');
    const evidenceOptions = useMemo<ComboboxOption[]>(() => {
        const items = Array.isArray(evidenceData) ? evidenceData : (evidenceData?.items ?? []);
        return items.map((e) => ({ value: e.id, label: e.title }));
    }, [evidenceData]);

    const startRun = async () => {
        setStarting(true);
        try {
            const res = await fetch(apiUrl(`/tests/runs/${runId}/start`), { method: 'POST' });
            if (!res.ok) throw new Error(await res.text());
            await mutate();
        } catch {
            toast.error(t('run.errors.startFailed'));
        } finally {
            setStarting(false);
        }
    };

    const completeRun = async () => {
        setCompleting(true);
        try {
            const body: Record<string, unknown> = { result, notes: notes || null };
            if (result === 'FAIL') body.findingSummary = findingSummary || null;
            const res = await fetch(apiUrl(`/tests/runs/${runId}/complete`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error(await res.text());
            toast.success(t('run.completedToast'));
            setConfirmingComplete(false);
            await mutate();
        } catch {
            toast.error(t('run.errors.completeFailed'));
        } finally {
            setCompleting(false);
        }
    };

    // Attach evidence to this run. Both new uploads (FILE) and new links
    // (LINK) are created as first-class Evidence Library records LINKED TO
    // THE CONTROL (run.controlId) — so they surface in the control's
    // Evidence tab and the Evidence Library, not just on this run. The
    // created (or pre-existing) evidence record is then linked to the run.
    const linkEvidence = async () => {
        if (!run) return;
        setLinkingEv(true);
        setEvError('');
        try {
            let evidenceId = evEvidenceId;
            // PR-R — when a real file is uploaded we link it to the run as
            // kind:'FILE' with its fileId, so the backend freezes the file's
            // SHA-256 on the link and verifyRunEvidence can detect tampering.
            let uploadedFileId: string | null = null;

            if (evKind === 'FILE_UPLOAD') {
                if (!evFile) return;
                // Canonical multipart upload — creates FileRecord +
                // Evidence(FILE) + the ControlEvidenceLink in one flow.
                const formData = new FormData();
                formData.append('file', evFile);
                formData.append('title', evFileTitle || evFile.name);
                formData.append('controlId', run.controlId);
                const uploadRes = await fetch(apiUrl('/evidence/uploads'), {
                    method: 'POST',
                    body: formData,
                });
                if (!uploadRes.ok) {
                    throw new Error((await uploadRes.text()) || t('run.errors.uploadFailed'));
                }
                const uploaded = await uploadRes.json();
                evidenceId = uploaded.id;
                uploadedFileId = uploaded.fileRecordId ?? null;
            } else if (evKind === 'LINK') {
                if (!evUrl) return;
                // Create a LINK evidence record in the library, linked to
                // the control. `content` carries the URL (createEvidence
                // maps it onto the control evidence-link's `url`).
                const createRes = await fetch(apiUrl('/evidence'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        type: 'LINK',
                        title: evFileTitle || evUrl,
                        content: evUrl,
                        controlId: run.controlId,
                    }),
                });
                if (!createRes.ok) {
                    throw new Error((await createRes.text()) || t('run.errors.createLinkFailed'));
                }
                evidenceId = (await createRes.json()).id;
            }

            // Link to the run. An uploaded file links as FILE-kind (with
            // fileId → hashed for integrity); library picks / URLs link as
            // EVIDENCE-kind pointing at the library record.
            const linkBody = uploadedFileId
                ? { kind: 'FILE', fileId: uploadedFileId, note: evNote || null }
                : { kind: 'EVIDENCE', evidenceId, note: evNote || null };
            const linkRes = await fetch(apiUrl(`/tests/runs/${runId}/evidence`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(linkBody),
            });
            if (!linkRes.ok) throw new Error(t('run.errors.linkFailed'));

            setShowEvForm(false);
            setEvUrl('');
            setEvNote('');
            setEvEvidenceId('');
            setEvFile(null);
            setEvFileTitle('');
            // The integrity verdict was computed against the PREVIOUS evidence
            // set — adding a link makes it stale. Clear it so the badge doesn't
            // keep asserting "verified" over evidence it never saw.
            setIntegrity(null);
            toast.success(t('run.evidenceAddedToast'));
            await mutate();
        } catch (err) {
            setEvError(err instanceof Error ? err.message : t('run.errors.addFailed'));
        } finally {
            setLinkingEv(false);
        }
    };

    const unlinkEvidence = async (linkId: string) => {
        setUnlinkingId(linkId);
        try {
            const res = await fetch(apiUrl(`/tests/runs/${runId}/evidence/${linkId}`), { method: 'DELETE' });
            if (!res.ok) throw new Error(await res.text());
            // Removing a link also invalidates any prior integrity verdict.
            setIntegrity(null);
            toast.success(t('run.evidenceRemovedToast'));
            await mutate();
        } catch {
            toast.error(t('run.errors.unlinkFailed'));
        } finally {
            setUnlinkingId(null);
        }
    };

    // Task 2 — ONE coherent chain in every state. Always route the
    // parent hop back through the control's plan (falling back to
    // /controls when ids aren't known yet) so the ancestor context never
    // flips between Controls and Tests. `run` is optional here so the
    // same chain renders in the loading/error states too.
    const breadcrumbs: BreadcrumbItem[] = [
        { label: t('crumb.dashboard'), href: tenantHref('/dashboard') },
        { label: t('run.controls'), href: tenantHref('/controls') },
        ...(run?.controlId && run?.testPlanId
            ? [{
                label: run.testPlan?.name ?? t('run.plan'),
                href: tenantHref(`/controls/${run.controlId}/tests/${run.testPlanId}`),
            }]
            : []),
        { label: t('run.run') },
    ];

    if (isLoading && !run) {
        return (
            <EntityDetailLayout loading title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }
    if (error) {
        // Don't collapse every failure to "not found" — a 403 (no access to
        // this run's tenant/plan) and a 500 (server fault) are different
        // stories, and telling a permitted user their run "doesn't exist" is
        // its own bug. Only a real 404 reads as not-found.
        const status = error instanceof ApiClientError ? error.status : 0;
        const message =
            status === 403
                ? t('run.errors.forbidden')
                : status === 404
                  ? t('run.errors.notFound')
                  : t('run.errors.loadFailed');
        return (
            <EntityDetailLayout error={message} title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }
    if (!run) {
        return (
            <EntityDetailLayout empty={{ message: t('run.notFoundEmpty') }} title="" breadcrumbs={breadcrumbs}>
                <></>
            </EntityDetailLayout>
        );
    }

    const isCompleted = run.status === 'COMPLETED';
    const isRunning = run.status === 'RUNNING';
    const isPlanned = run.status === 'PLANNED';
    const steps = run.testPlan?.steps ?? [];

    // Determine if "Link" button should be disabled
    const canSubmitEvidence = evKind === 'LINK' ? !!evUrl : evKind === 'EVIDENCE' ? !!evEvidenceId : !!evFile;

    return (
        <EntityDetailLayout
            id="test-run-detail-page"
            back={{ smart: true }}
            breadcrumbs={breadcrumbs}

            title={
                <span id="test-run-title">
                    {t('run.title')}{run.testPlan ? ` — ${run.testPlan.name}` : ''}
                </span>
            }
            meta={
                <MetaStrip
                    items={[
                        {
                            kind: 'status',
                            id: 'test-run-status',
                            label: t('run.meta.status'),
                            value: RUN_STATUS_LABELS[run.status] ?? run.status,
                            variant:
                                run.status === 'COMPLETED'
                                    ? 'success'
                                    : run.status === 'RUNNING'
                                      ? 'info'
                                      : 'neutral',
                        },
                        ...(run.result
                            ? [
                                  {
                                      kind: 'status' as const,
                                      id: 'test-run-result',
                                      label: t('run.meta.result'),
                                      value: RESULT_LABELS[run.result] ?? run.result,
                                      variant:
                                          RESULT_BADGE[run.result] ?? 'neutral',
                                  },
                              ]
                            : []),
                        ...(run.executedAt
                            ? [
                                  {
                                      label: t('run.meta.executed'),
                                      value: formatDate(run.executedAt),
                                  } as const,
                              ]
                            : []),
                    ]}
                />
            }
        >
            {/* R3-P2 — guided run. PLANNED: preview the procedure + Start.
                RUNNING: walk the steps as a checklist, then record the result. */}
            {!isCompleted && steps.length > 0 && (
                <Card className="space-y-default">
                    <Heading level={3}>{t('run.procedureHeading')}</Heading>
                    {/* PR-R — honest labeling: the checkboxes are a working aid, not
                        a recorded verdict. Only the overall result is persisted. */}
                    <p className="text-xs text-content-subtle">{t('run.stepsGuidanceNote')}</p>
                    <ol className="space-y-tight">
                        {steps.map((step, i) => {
                            const checked = checkedSteps.has(step.id);
                            return (
                                <li key={step.id} className="flex gap-compact text-sm items-start">
                                    {isRunning && permissions.canWrite ? (
                                        <input
                                            type="checkbox"
                                            className="mt-1 flex-shrink-0"
                                            checked={checked}
                                            onChange={() => setCheckedSteps((prev) => {
                                                const next = new Set(prev);
                                                if (next.has(step.id)) next.delete(step.id); else next.add(step.id);
                                                return next;
                                            })}
                                            id={`run-step-check-${i}`}
                                            aria-label={step.instruction}
                                        />
                                    ) : (
                                        <span className="w-6 h-6 rounded-full bg-[var(--brand-subtle)] text-[var(--brand-default)] text-xs flex items-center justify-center flex-shrink-0 mt-0.5">
                                            {i + 1}
                                        </span>
                                    )}
                                    <div className={checked ? 'opacity-60' : ''}>
                                        <p className={`text-content-default ${checked ? 'line-through' : ''}`}>{step.instruction}</p>
                                        {step.expectedOutput && (
                                            <p className="text-xs text-content-subtle mt-0.5">{t('run.stepExpected', { output: step.expectedOutput })}</p>
                                        )}
                                    </div>
                                </li>
                            );
                        })}
                    </ol>
                    {isRunning && (
                        <p className="text-xs text-content-subtle">{t('run.stepsProgress', { done: checkedSteps.size, total: steps.length })}</p>
                    )}
                </Card>
            )}

            {/* PLANNED — begin the run before recording a result. */}
            {isPlanned && permissions.canWrite && (
                <Card className="flex items-center justify-between border-l-4 border-[var(--brand-default)]">
                    <div>
                        <Heading level={3}>{t('run.startHeading')}</Heading>
                        <p className="text-sm text-content-muted mt-1">{t('run.startHint')}</p>
                    </div>
                    <Button variant="primary" onClick={startRun} disabled={starting} id="start-test-run-btn">
                        {starting ? t('run.starting') : t('run.startTest')}
                    </Button>
                </Card>
            )}

            {/* Complete Form — only while the run is in progress */}
            {isRunning && permissions.canWrite && (
                <Card className="space-y-default border-l-4 border-[var(--brand-default)]">
                    <Heading level={3}>{t('run.completeHeading')}</Heading>

                    <div>
                        <label className="text-xs text-content-muted block mb-1">{t('run.resultLabel')}</label>
                        <div className="flex gap-compact">
                            {(['PASS', 'FAIL', 'INCONCLUSIVE'] as const).map(r => (
                                <button
                                    key={r}
                                    className={buttonVariants({ variant: result === r ? (r === 'FAIL' ? 'destructive' : 'primary') : 'ghost', size: 'sm', className: result === r ? (r === 'PASS' ? 'bg-bg-success-emphasis text-content-emphasis' : r === 'FAIL' ? 'bg-bg-error-emphasis text-content-emphasis' : 'bg-bg-warning-emphasis text-content-emphasis') : '' })}
                                    onClick={() => setResult(r)}
                                    id={`result-btn-${r}`}
                                >
                                    {RESULT_LABELS[r] ?? r}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div>
                        <label className="text-xs text-content-muted block mb-1">{t('run.notes')}</label>
                        <Textarea
                            className="w-full h-20"
                            value={notes}
                            onChange={e => setNotes(e.target.value)}
                            placeholder={t('run.notesPlaceholder')}
                            id="test-run-notes"
                        />
                    </div>

                    {result === 'FAIL' && (
                        <div className="animate-fadeIn">
                            <label className="text-xs text-content-muted block mb-1">{t('run.findingLabel')}</label>
                            <Textarea
                                className="w-full h-16"
                                value={findingSummary}
                                onChange={e => setFindingSummary(e.target.value)}
                                placeholder={t('run.findingPlaceholder')}
                                id="test-run-finding-summary"
                            />
                        </div>
                    )}

                    <Button
                        variant="primary"
                        size="sm"
                        onClick={() => setConfirmingComplete(true)}
                        disabled={completing}
                        id="complete-test-run-btn"
                    >
                        {completing ? t('run.completing') : t('run.completeAs', { result: RESULT_LABELS[result] ?? result })}
                    </Button>
                </Card>
            )}

            {/* Completed Info */}
            {isCompleted && (
                <div className={cn(cardVariants({ density: 'compact' }), 'space-y-tight')}>
                    {run.notes && (
                        <div>
                            <span className="text-xs text-content-muted">{t('run.notesColon')}</span>
                            <p className="text-sm text-content-default whitespace-pre-wrap mt-1">{run.notes}</p>
                        </div>
                    )}
                    {run.findingSummary && (
                        <div>
                            <span className="text-xs text-content-error">{t('run.findingColon')}</span>
                            <p className="text-sm text-content-error whitespace-pre-wrap mt-1">{run.findingSummary}</p>
                        </div>
                    )}
                    {run.executedBy && (
                        <div className="text-xs text-content-subtle mt-2">
                            {t('run.executedBy', { name: run.executedBy.name || run.executedBy.email, date: formatDate(run.executedAt) })}
                        </div>
                    )}

                    {/* Retest button for FAIL/INCONCLUSIVE */}
                    {permissions.canWrite && (run.result === 'FAIL' || run.result === 'INCONCLUSIVE') && (
                        <div className="mt-3 pt-3 border-t border-border-default/50">
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={handleRetest}
                                disabled={retesting}
                                id="retest-btn"
                            >
                                {retesting ? t('run.creating') : t('run.retest')}
                            </Button>
                            <span className="text-xs text-content-subtle ml-2">{t('run.retestHint')}</span>
                        </div>
                    )}
                </div>
            )}

            {/* Evidence Section */}
            <div className={cardVariants({ density: 'compact' })}>
                <div className="flex items-center justify-between mb-3">
                    <Heading level={3}>{t('run.evidenceHeading', { count: run.evidence?.length ?? 0 })}</Heading>
                    {/* A completed run is frozen audit evidence — its evidence
                        set is immutable server-side, so hide the add affordance. */}
                    {permissions.canWrite && !isCompleted && (
                        <Button
                            variant="primary"
                            icon={showEvForm ? undefined : <Plus className="-ml-0.5 -mr-2.5" />}
                            onClick={() => { setShowEvForm(!showEvForm); setEvError(''); }}
                            id="link-evidence-btn"
                        >
                            {showEvForm ? t('run.cancel') : t('run.evidence')}
                        </Button>
                    )}
                </div>

                {showEvForm && (
                    <div className="space-y-compact mb-4 p-3 rounded bg-bg-default/50 animate-fadeIn">
                        {evError && (
                            <div className="rounded border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error" role="alert" id="evidence-error">
                                {evError}
                            </div>
                        )}
                        <div>
                            <label className="text-xs text-content-muted block mb-1">{t('run.evidenceType')}</label>
                            <Combobox
                                hideSearch
                                id="evidence-kind-select"
                                selected={EV_KIND_OPTIONS.find(o => o.value === evKind) ?? null}
                                setSelected={(opt) => setEvKind((opt?.value ?? 'FILE_UPLOAD') as 'LINK' | 'EVIDENCE' | 'FILE_UPLOAD')}
                                options={EV_KIND_OPTIONS}
                                matchTriggerWidth
                            />
                        </div>
                        {evKind === 'FILE_UPLOAD' && (
                            <>
                                <div>
                                    <label className="text-xs text-content-muted block mb-1">{t('run.file')}</label>
                                    <label className="flex flex-col items-center justify-center w-full p-4 border-2 border-dashed border-border-emphasis rounded-lg cursor-pointer hover:border-[var(--brand-default)]/50 transition-colors bg-bg-page/30">
                                        <input
                                            type="file"
                                            className="hidden"
                                            onChange={e => {
                                                const f = e.target.files?.[0] || null;
                                                setEvFile(f);
                                                if (f && !evFileTitle) setEvFileTitle(f.name);
                                            }}
                                            id="evidence-file-input"
                                        />
                                        {evFile ? (
                                            <div className="text-sm text-content-emphasis flex items-center gap-tight">
                                                <Paperclip className="w-4 h-4 text-[var(--brand-default)]" aria-hidden="true" />
                                                <span>{evFile.name}</span>
                                                <span className="text-xs text-content-subtle">({(evFile.size / 1024).toFixed(1)} KB)</span>
                                            </div>
                                        ) : (
                                            <div className="text-center">
                                                <p className="text-sm text-content-muted">{t('run.selectFile')}</p>
                                                <p className="text-xs text-content-subtle mt-1">{t('run.fileHint')}</p>
                                            </div>
                                        )}
                                    </label>
                                </div>
                            </>
                        )}
                        {evKind === 'LINK' && (
                            <div>
                                <label className="text-xs text-content-muted block mb-1">{t('run.url')}</label>
                                <Input className="w-full" value={evUrl} onChange={e => setEvUrl(e.target.value)} placeholder="https://..." id="evidence-url-input" />
                            </div>
                        )}
                        {evKind === 'EVIDENCE' && (
                            <div>
                                <label className="text-xs text-content-muted block mb-1">{t('run.evidenceRecord')}</label>
                                <Combobox
                                    id="evidence-id-input"
                                    options={evidenceOptions}
                                    selected={evidenceOptions.find(o => o.value === evEvidenceId) ?? null}
                                    setSelected={(opt) => setEvEvidenceId(opt?.value ?? '')}
                                    placeholder={t('run.evidenceRecordPlaceholder')}
                                    matchTriggerWidth
                                />
                            </div>
                        )}
                        {(evKind === 'FILE_UPLOAD' || evKind === 'LINK') && (
                            <div>
                                <label className="text-xs text-content-muted block mb-1">{t('run.title2')}</label>
                                <Input className="w-full" value={evFileTitle} onChange={e => setEvFileTitle(e.target.value)} placeholder={t('run.titlePlaceholder')} id="evidence-file-title-input" />
                            </div>
                        )}
                        <div>
                            <label className="text-xs text-content-muted block mb-1">{t('run.note')}</label>
                            <Input className="w-full" value={evNote} onChange={e => setEvNote(e.target.value)} placeholder={t('run.notePlaceholder')} id="evidence-note-input" />
                        </div>
                        <Button
                            variant="primary"
                            size="xs"
                            onClick={linkEvidence}
                            disabled={linkingEv || !canSubmitEvidence}
                            id="save-evidence-link-btn"
                        >
                            {linkingEv ? (evKind === 'FILE_UPLOAD' ? t('run.uploading') : t('run.linking')) : (evKind === 'FILE_UPLOAD' ? t('run.uploadLink') : t('run.link'))}
                        </Button>
                    </div>
                )}

                {run.evidence.length === 0 ? (
                    <p className="text-sm text-content-subtle">{t('run.evidenceEmpty')}</p>
                ) : (
                    <div className="divide-y divide-border-default/50">
                        {run.evidence.map(ev => (
                            <div key={ev.id} className="flex items-center justify-between py-2 group">
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-tight">
                                        <StatusBadge variant="neutral" size="sm">{EVIDENCE_KIND_LABELS[ev.kind] ?? ev.kind}</StatusBadge>
                                        {ev.evidence && (
                                            <span className="text-sm text-content-default">{ev.evidence.title}</span>
                                        )}
                                        {ev.url && (
                                            <a href={ev.url} target="_blank" rel="noopener noreferrer" className={`${textLinkVariants({ tone: 'link' })} text-sm truncate`}>
                                                {ev.url}
                                            </a>
                                        )}
                                    </div>
                                    {ev.note && <p className="text-xs text-content-subtle mt-0.5">{ev.note}</p>}
                                    <p className="text-xs text-content-subtle mt-0.5">
                                        {ev.createdBy?.name || ev.createdBy?.email} • {formatDate(ev.createdAt)}
                                    </p>
                                </div>
                                {permissions.canWrite && !isCompleted && (
                                    <Tooltip content={t('run.unlinkTooltip')}>
                                        <Button
                                            variant="ghost"
                                            size="xs"
                                            className="text-content-error opacity-0 group-hover:opacity-100 transition"
                                            onClick={() => unlinkEvidence(ev.id)}
                                            disabled={unlinkingId === ev.id}
                                            aria-label={t('run.unlinkAria')}
                                        >
                                            {unlinkingId === ev.id ? '...' : <span aria-hidden="true">×</span>}
                                        </Button>
                                    </Tooltip>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            {/* PR-R — Audit & integrity: verify evidence hashes, export the
                evidence bundle, and snapshot a completed run into an audit pack.
                All three were routed but had no UI. No navbar change. */}
            <div className={cn(cardVariants({ density: 'compact' }), 'space-y-default')} id="run-hardening-section">
                <Heading level={3}>{t('run.hardening.heading')}</Heading>

                {/* Integrity */}
                <div className="flex flex-wrap items-center gap-compact">
                    <Button variant="secondary" size="sm" onClick={verifyIntegrity} disabled={verifying} id="verify-integrity-btn">
                        {verifying ? t('run.integrity.verifying') : t('run.integrity.verify')}
                    </Button>
                    {integrity && (
                        <>
                            <StatusBadge
                                variant={integrity.fileLinks === 0 ? 'neutral' : integrity.integrityOk ? 'success' : 'error'}
                                size="sm"
                            >
                                {integrity.fileLinks === 0
                                    ? t('run.integrity.none')
                                    : integrity.integrityOk
                                      ? t('run.integrity.ok')
                                      : t('run.integrity.failed')}
                            </StatusBadge>
                            <span className="text-xs text-content-subtle">
                                {t('run.integrity.counts', {
                                    verified: integrity.verified,
                                    mismatches: integrity.mismatches,
                                    unverifiable: integrity.unverifiable,
                                })}
                            </span>
                        </>
                    )}
                </div>

                {/* Export bundle */}
                <div className="flex flex-wrap items-center gap-compact">
                    <span className="text-xs text-content-muted">{t('run.export.label')}</span>
                    <a
                        href={apiUrl(`/tests/export?controlId=${run.controlId}&format=csv`)}
                        className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                        id="export-bundle-csv"
                    >
                        {t('run.export.csv')}
                    </a>
                    <a
                        href={apiUrl(`/tests/export?controlId=${run.controlId}&format=json`)}
                        className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                        target="_blank"
                        rel="noopener noreferrer"
                        id="export-bundle-json"
                    >
                        {t('run.export.json')}
                    </a>
                </div>

                {/* Snapshot to audit pack — completed runs only */}
                {isCompleted && permissions.canWrite && (
                    <div className="flex flex-wrap items-end gap-compact">
                        <div className="w-full sm:w-64">
                            <label className="text-xs text-content-muted block mb-1">{t('run.snapshot.label')}</label>
                            <Combobox
                                id="snapshot-pack-select"
                                options={draftPackOptions}
                                selected={draftPackOptions.find((o) => o.value === snapshotPackId) ?? null}
                                setSelected={(opt) => setSnapshotPackId(opt?.value ?? '')}
                                placeholder={draftPackOptions.length === 0 ? t('run.snapshot.noPacks') : t('run.snapshot.choose')}
                                disabled={draftPackOptions.length === 0}
                                matchTriggerWidth
                            />
                        </div>
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={snapshotToPack}
                            disabled={!snapshotPackId || snapshotting}
                            id="snapshot-to-pack-btn"
                        >
                            {snapshotting ? t('run.snapshot.snapshotting') : t('run.snapshot.confirm')}
                        </Button>
                        {/* Divergence cue — a snapshot copies this run's evidence
                            into the pack. If integrity was never verified (or was
                            invalidated), flag it so unverified evidence isn't
                            snapshotted as if it were checked. */}
                        {(run.evidence?.length ?? 0) > 0 && !integrity && (
                            <p className="w-full text-xs text-content-warning" id="snapshot-unverified-hint">
                                {t('run.snapshot.unverifiedHint')}
                            </p>
                        )}
                    </div>
                )}
            </div>

            {/* Meta */}
            <div className="text-xs text-content-subtle">
                {t('run.createdBy', { date: formatDate(run.createdAt), name: run.createdBy?.name || run.createdBy?.email || t('run.unknown') })}
            </div>

            {/* Completing a run is a significant, irreversible act — it freezes
                the evidence set and attests the control. Confirm before firing. */}
            <ConfirmDialog
                showModal={confirmingComplete}
                setShowModal={setConfirmingComplete}
                tone="warning"
                title={t('run.confirmComplete.title')}
                description={t('run.confirmComplete.description', { result })}
                confirmLabel={t('run.confirmComplete.confirm')}
                cancelLabel={t('run.confirmComplete.cancel')}
                onConfirm={completeRun}
            />
        </EntityDetailLayout>
    );
}
