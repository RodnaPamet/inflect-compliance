'use client';

/**
 * WHAT THIS AGENT SHOULD DO — its agent profile (Step 1b of
 * `docs/claude-agent-sdk-design.md`, #4144).
 *
 * A profile is versioned instructions plus the tools, skills, model tier,
 * effort, turn bound, output kind and triggers they run with. Step 1a holds
 * the rules; this tab is where a tenant writes, submits and reviews a version
 * in the product. Three regions, in the order a reviewer reads them:
 *
 *   In force   the APPROVED version, read-only, with who approved it and when
 *   Open       the one DRAFT or SUBMITTED version, if any: Submit for a draft;
 *              for a submitted one, a text diff against the version in force
 *              and Approve / Reject, offered by the server's `canDecide`
 *   History    every version, newest first: status, author, decider, hash
 *
 * Instructions are text, never markup: they render as React text inside a
 * `<pre>` (and as text inside the diff), so `<img onerror>` in them is
 * characters on the screen and no element.
 *
 * The four-eyes affordance is the server's (`canDecide`: a SUBMITTED version,
 * a signed-in person, never its author), and the usecase refuses the author
 * again if a request is crafted by hand. Approve sends the hash on screen, so
 * what is approved is the text the reviewer read.
 *
 * Test run is offered on a SUBMITTED or APPROVED version (Step 2c). It starts a
 * read-only run of that version as the agent, on the Tool Runner engine, and
 * opens the Runs tab. When it cannot start, it is disabled and says why: the
 * workspace's engine (named), the engine not in force, the agent not ready, or
 * a version that does not allow Test runs. The server refuses each of these
 * again.
 */
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/error-state';
import { useToast } from '@/components/ui/hooks';
import { InlineEmptyState } from '@/components/ui/inline-empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { SkeletonCard } from '@/components/ui/skeleton';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { VersionDiff } from '@/components/ui/VersionDiff';
import { apiErrorMessage } from '@/lib/api-error';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { formatDateTime } from '@inflect/ui/lib/format-date';
import { Plus } from '@inflect/ui/components/ui/icons/nucleo';

import { BehaviourEditorSheet } from './BehaviourEditorSheet';
import { BehaviourRejectModal } from './BehaviourRejectModal';
import type { ProfilePerson, ProfileVersionStatus, ProfileVersionView, ProfileView } from './behaviour-types';
import type { BehaviourTabProps } from './types';

const STATUS_VARIANT: Record<ProfileVersionStatus, StatusBadgeVariant> = {
    DRAFT: 'neutral',
    SUBMITTED: 'info',
    APPROVED: 'success',
    REJECTED: 'error',
    RETIRED: 'warning',
};

export function BehaviourTab({ agentId, refreshToken, retired, onOpenRuns }: BehaviourTabProps) {
    const t = useTranslations('agents.behaviour');
    const apiUrl = useTenantApiUrl();
    const toast = useToast();
    const { data, error, mutate } = useTenantSWR<ProfileView>(`/admin/agents/${agentId}/profile`);
    useEffect(() => {
        void mutate();
    }, [refreshToken, mutate]);

    const [editing, setEditing] = useState<{ from: ProfileVersionView | null } | null>(null);
    const [rejecting, setRejecting] = useState<ProfileVersionView | null>(null);
    const [rejectError, setRejectError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [actError, setActError] = useState<string | null>(null);

    /** Start a Test run of one version, then show it in the Runs tab. */
    const startTestRun = async (version: number) => {
        setBusy(true);
        try {
            const res = await fetch(apiUrl(`/admin/agents/${agentId}/profile/versions/${version}/test-run`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            });
            if (!res.ok) {
                toast.error(apiErrorMessage(await res.json().catch(() => null), t('testRun.failed')));
                return;
            }
            toast.success(t('testRun.started'));
            onOpenRuns?.();
        } catch {
            toast.error(t('testRun.failed'));
        } finally {
            setBusy(false);
        }
    };

    /** POST one act; the refusal, if any, is the server's sentence. */
    const act = async (version: number, verb: 'submit' | 'approve' | 'reject', body: unknown): Promise<string | null> => {
        setBusy(true);
        setActError(null);
        try {
            const res = await fetch(apiUrl(`/admin/agents/${agentId}/profile/versions/${version}/${verb}`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const message = apiErrorMessage(await res.json().catch(() => null), t('actionFailed'));
                toast.error(message);
                return message;
            }
            toast.success(t(`done.${verb}`));
            await mutate();
            return null;
        } catch {
            toast.error(t('actionFailed'));
            return t('actionFailed');
        } finally {
            setBusy(false);
        }
    };

    if (error) {
        return <ErrorState title={t('loadFailed')} onRetry={() => { void mutate(); }} />;
    }
    if (!data) return <SkeletonCard />;

    const inForce = data.versions.find((v) => v.status === 'APPROVED') ?? null;
    const open = data.versions.find((v) => v.status === 'DRAFT' || v.status === 'SUBMITTED') ?? null;
    const who = (p: ProfilePerson) => (p.isViewer ? t('you') : p.label ?? t('unknownMember'));

    const testRun = (v: ProfileVersionView) => {
        // Why the button is disabled, or null when it can start. The version's
        // own triggers decide last, so the engine and the agent are named first.
        const state = data.testRun;
        const reason = !state.available
            ? state.reason === 'ENGINE_DOES_NOT_RUN_PROFILES'
                ? t('testRun.reason.ENGINE_DOES_NOT_RUN_PROFILES', { engine: t(`testRun.engine.${state.engine}`) })
                : t(`testRun.reason.${state.reason}`)
            : !v.allowedTriggers.includes('TEST_RUN')
              ? t('testRun.reason.TRIGGER_NOT_ALLOWED')
              : null;
        return (
            <div className="space-y-tight" data-testid={`behaviour-test-run-${v.version}`}>
                <Button
                    variant="secondary"
                    size="sm"
                    disabled={reason !== null || busy || retired}
                    onClick={() => void startTestRun(v.version)}
                    data-testid={`behaviour-test-run-${v.version}-button`}
                >
                    {t('testRun.action')}
                </Button>
                {reason !== null && (
                    <p className="text-xs text-content-muted" data-testid={`behaviour-test-run-${v.version}-reason`}>
                        {reason}
                    </p>
                )}
            </div>
        );
    };

    return (
        <div className="space-y-section" data-testid="agent-behaviour-tab">
            <Card className="space-y-compact p-default">
                <div className="flex flex-wrap items-start justify-between gap-compact">
                    <div className="space-y-tight">
                        <Heading level={3}>{t('heading')}</Heading>
                        <p className="text-sm text-content-muted">{t('intro')}</p>
                    </div>
                    {!retired ? (
                        // Secondary: a card action inside a tab, the agent-detail
                        // precedent (`primary-secondary-ratio`).
                        <Button
                            variant="secondary"
                            size="sm"
                            icon={data.profile ? undefined : <Plus />}
                            disabled={busy}
                            data-testid="behaviour-write"
                            onClick={() => setEditing({ from: open ?? inForce })}
                        >
                            {data.profile ? t('editAction') : t('createAction')}
                        </Button>
                    ) : null}
                </div>
                {retired ? <InlineNotice variant="info" data-testid="behaviour-retired">{t('retired')}</InlineNotice> : null}
                {actError ? <InlineNotice variant="error" data-testid="behaviour-act-error">{actError}</InlineNotice> : null}
            </Card>

            <Card className="space-y-compact p-default" data-testid="behaviour-in-force">
                <Heading level={3}>{t('inForce.heading')}</Heading>
                {inForce ? (
                    <>
                        <p className="text-xs text-content-muted" data-testid="behaviour-in-force-approval">
                            {t('inForce.approval', {
                                version: inForce.version,
                                who: inForce.decidedBy ? who(inForce.decidedBy) : t('unknownMember'),
                                when: inForce.decidedAt ? formatDateTime(inForce.decidedAt) : '',
                            })}
                        </p>
                        <VersionBody v={inForce} />
                        {testRun(inForce)}
                    </>
                ) : (
                    <div data-testid="behaviour-in-force-empty">
                        <InlineEmptyState
                            title={t('inForce.noneTitle')}
                            description={data.profile ? t('inForce.noneDescription') : t('inForce.noProfileDescription')}
                        />
                    </div>
                )}
            </Card>

            {open ? (
                <Card className="space-y-compact p-default" data-testid="behaviour-open">
                    <div className="flex flex-wrap items-center justify-between gap-compact">
                        <Heading level={3}>{t('open.heading', { version: open.version })}</Heading>
                        <StatusBadge variant={STATUS_VARIANT[open.status]}>{t(`status.${open.status}`)}</StatusBadge>
                    </div>
                    <p className="text-xs text-content-muted">
                        {t('open.writtenBy', { who: who(open.author), when: formatDateTime(open.createdAt) })}
                    </p>
                    {open.status === 'SUBMITTED' && open.canDecide && inForce ? (
                        <div className="space-y-tight">
                            <p className="text-xs text-content-muted">
                                {t('review.diffIntro', { from: inForce.version, to: open.version })}
                            </p>
                            <VersionDiff
                                versions={[
                                    { id: inForce.id, versionNumber: inForce.version, text: inForce.instructions },
                                    { id: open.id, versionNumber: open.version, text: open.instructions },
                                ]}
                                fromVersionId={inForce.id}
                                toVersionId={open.id}
                                data-testid="behaviour-review-diff"
                            />
                        </div>
                    ) : null}
                    <VersionBody v={open} />
                    {open.status === 'SUBMITTED' && open.canDecide ? (
                        <p className="text-xs text-content-muted">
                            {t('review.hashNote')} <code className="break-all">{open.instructionsHash}</code>
                        </p>
                    ) : null}
                    {open.status === 'SUBMITTED' && open.author.isViewer ? (
                        <p className="text-xs text-content-muted" data-testid="behaviour-author-note">
                            {t('review.authorCannotDecide')}
                        </p>
                    ) : null}
                    <div className="flex flex-wrap justify-end gap-tight">
                        {open.status === 'DRAFT' && !retired ? (
                            <Button
                                variant="secondary"
                                size="sm"
                                disabled={busy}
                                data-testid="behaviour-submit"
                                onClick={async () => setActError(await act(open.version, 'submit', {}))}
                            >
                                {t('open.submit')}
                            </Button>
                        ) : null}
                        {open.status === 'SUBMITTED' && open.canDecide ? (
                            <Button
                                variant="secondary"
                                size="sm"
                                disabled={busy}
                                data-testid="behaviour-reject"
                                onClick={() => {
                                    setRejectError(null);
                                    setRejecting(open);
                                }}
                            >
                                {t('review.reject')}
                            </Button>
                        ) : null}
                        {open.status === 'SUBMITTED' && open.canDecide && !retired ? (
                            // Secondary, as the tenant-skill and parameter-set
                            // approvals are: the weight of a four-eyes approve is
                            // the hash it sends and the person it refuses.
                            <Button
                                variant="secondary"
                                size="sm"
                                disabled={busy}
                                data-testid="behaviour-approve"
                                onClick={async () =>
                                    setActError(await act(open.version, 'approve', { instructionsHash: open.instructionsHash }))
                                }
                            >
                                {t('review.approve')}
                            </Button>
                        ) : null}
                    </div>
                    {open.status === 'SUBMITTED' ? testRun(open) : null}
                </Card>
            ) : null}

            <Card className="space-y-compact p-default" data-testid="behaviour-history">
                <Heading level={3}>{t('history.heading')}</Heading>
                {data.versions.length === 0 ? (
                    <p className="text-sm text-content-muted">{t('history.empty')}</p>
                ) : (
                    <ul className="divide-y divide-border-subtle">
                        {data.versions.map((v) => (
                            <li key={v.id} className="space-y-tight py-tight" data-testid={`behaviour-version-${v.version}`}>
                                <div className="flex flex-wrap items-center gap-compact">
                                    <span className="text-sm font-medium text-content-emphasis">
                                        {t('version', { version: v.version })}
                                    </span>
                                    <StatusBadge variant={STATUS_VARIANT[v.status]} data-testid={`behaviour-version-${v.version}-status`}>
                                        {t(`status.${v.status}`)}
                                    </StatusBadge>
                                </div>
                                <dl className="grid grid-cols-2 gap-x-default gap-y-tight text-xs text-content-muted">
                                    <dt>{t('history.author')}</dt>
                                    <dd>{t('history.byOn', { who: who(v.author), when: formatDateTime(v.createdAt) })}</dd>
                                    {v.decidedBy ? (
                                        <>
                                            <dt>{t('history.decider')}</dt>
                                            <dd data-testid={`behaviour-version-${v.version}-decider`}>
                                                {t('history.byOn', {
                                                    who: who(v.decidedBy),
                                                    when: v.decidedAt ? formatDateTime(v.decidedAt) : '',
                                                })}
                                            </dd>
                                        </>
                                    ) : null}
                                    <dt>{t('history.hash')}</dt>
                                    <dd>
                                        <code className="break-all" data-testid={`behaviour-version-${v.version}-hash`}>
                                            {v.instructionsHash}
                                        </code>
                                    </dd>
                                </dl>
                                {v.rejectionReason !== null ? (
                                    <div className="space-y-tight text-xs">
                                        <p className="text-content-muted">{t('history.rejectionReason')}</p>
                                        <p className="whitespace-pre-wrap text-content-default" data-testid={`behaviour-version-${v.version}-reason`}>
                                            {v.rejectionReason}
                                        </p>
                                    </div>
                                ) : null}
                            </li>
                        ))}
                    </ul>
                )}
            </Card>

            {editing ? (
                <BehaviourEditorSheet
                    agentId={agentId}
                    view={data}
                    from={editing.from}
                    supersedes={open?.version ?? null}
                    onClose={() => setEditing(null)}
                    onSaved={() => {
                        setEditing(null);
                        void mutate();
                    }}
                />
            ) : null}
            {rejecting ? (
                <BehaviourRejectModal
                    version={rejecting.version}
                    maxChars={data.limits.rejectionReasonMaxChars}
                    busy={busy}
                    error={rejectError}
                    onCancel={() => setRejecting(null)}
                    onReject={async (reason) => {
                        const refusal = await act(rejecting.version, 'reject', { reason });
                        if (refusal === null) setRejecting(null);
                        else setRejectError(refusal);
                    }}
                />
            ) : null}
        </div>
    );
}

/** One version's instructions, as text, and the settings it runs with. */
function VersionBody({ v }: { v: ProfileVersionView }) {
    const t = useTranslations('agents.behaviour');
    return (
        <div className="space-y-tight">
            <p className="text-xs text-content-muted">{t('field.instructions')}</p>
            <pre
                className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded border border-border-subtle p-2 text-xs text-content-default"
                data-testid={`behaviour-version-${v.version}-instructions`}
            >
                {v.instructions}
            </pre>
            <dl className="grid grid-cols-2 gap-x-default gap-y-tight text-xs text-content-muted">
                <dt>{t('field.tools')}</dt>
                <dd data-testid={`behaviour-version-${v.version}-tools`}>{v.toolNames.join(', ')}</dd>
                <dt>{t('field.skills')}</dt>
                <dd>{v.skillRefs.length > 0 ? v.skillRefs.map((s) => s.name).join(', ') : t('none')}</dd>
                <dt>{t('field.modelTier')}</dt>
                <dd>{t(`tier.${v.modelTier}`)}</dd>
                <dt>{t('field.effort')}</dt>
                <dd>{t(`effort.${v.effort}`)}</dd>
                <dt>{t('field.maxTurns')}</dt>
                <dd>{v.maxTurns}</dd>
                <dt>{t('field.outputKind')}</dt>
                <dd>{t(`outputKind.${v.outputKind}`)}</dd>
                <dt>{t('field.triggers')}</dt>
                <dd>{v.allowedTriggers.map((x) => t(`trigger.${x}`)).join(', ')}</dd>
            </dl>
        </div>
    );
}
