'use client';

/**
 * INLINE APPROVE / REJECT FOR A RUN PARKED ON A HUMAN CHECKPOINT (#3472, plan
 * point 08 — "HUMAN_CHECKPOINT renders a paused badge with inline
 * approve/reject").
 *
 * ## The decision goes through the proposals usecase, not a new one
 *
 * The plan's constraint is "approve/reject from the canvas goes through the
 * SAME usecase as /agents/proposals — no second approval path", and it is
 * satisfied literally: this panel POSTs to
 * `/agent-proposals/:id/approve|reject`, the routes that queue surface uses.
 * Nothing here decides anything. Every rule the queue applies therefore
 * applies here without being restated — quarantine refused before status,
 * expiry checked against the clock rather than the sweep, four-eyes refusing
 * edits after a first signature, and the `baseDigest` re-check below.
 *
 * It also renders the SAME `ProposalDiffPanel`, which is why that component
 * moved out of the proposals route directory. Its invariant is structural: the
 * approve control is a CHILD of the branch that has rendered a diff body, so
 * there is no state in which a reviewer reaches the button without the
 * evidence. A second surface with its own layout is exactly how that invariant
 * gets lost, and reusing the component is what keeps it from being a comment.
 *
 * ## A FLAGGED proposal is not approvable from here
 *
 * The queue allows it behind an explicit confirmation dialog naming the rule
 * ids. This panel withdraws approval entirely and sends the reviewer there.
 *
 * That is deliberately MORE friction than the queue, never less — a canvas
 * cannot be the cheaper door to the decision the guard asked a human to look
 * hardest at. A flagged proposal is also the case where the surrounding
 * context matters most (the run's step, the rule ids, the audit trail), and
 * the queue has that context while a panel over a process map does not. It is
 * the same move `ProposalDiffPanel` makes for TARGET_MISSING and
 * PAYLOAD_UNREADABLE: where the evidence is not all present, the control goes
 * away rather than being rendered beside a gap.
 *
 * ## Two namespaces, on purpose
 *
 * `agents` for the vocabulary this panel SHARES with the queue — Approve,
 * Reject, the guard badges, the two failure messages — because a second key
 * meaning "Approve" is how two surfaces come to disagree about what the button
 * says. `processes` for the framing that is only true here: the panel's title,
 * the empty and error states, the links out. `route-import-boundaries` exists
 * because a component that borrowed one namespace rendered another page's copy
 * on four surfaces; picking both deliberately is the opposite of that.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Xmark } from '@inflect/ui/components/ui/icons/nucleo/xmark';

import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge } from '@/components/ui/status-badge';
import { ProposalDiffPanel } from '@/components/agentic/ProposalDiffPanel';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { useCheckpointReview } from '@/lib/processes/canvas-checkpoint-review';
import { resolveProposalGuardState } from '@/lib/agentic/proposal-guard-state';
import type { AgentGuardVerdict } from '@/app-layer/ai/guard/proposal-guard';

/**
 * DERIVED from what the usecase returns, never restated.
 *
 * `#3546` is the whole argument: the execution overlay declared a `running`
 * field the endpoint has never returned, so that branch never executed and
 * three test fixtures passed by constructing the field themselves. A derived
 * type makes the same mistake a compile error.
 *
 * No `Jsonified<T>` wrapper is needed here, unlike the overlay: that
 * projection returns `Date`s and the client receives strings, so the raw
 * return type lies about two fields. `getRunCheckpointReview` serialises its
 * own timestamps, so its return type IS the wire shape.
 */
type CheckpointResponse = Awaited<
    ReturnType<typeof import('@/app-layer/usecases/run-checkpoint-review').getRunCheckpointReview>
>;
type CheckpointProposalRow = CheckpointResponse['proposals'][number];

/** The badge each guard state wears — the queue's vocabulary, not a second one. */
const GUARD_BADGE = {
    FLAGGED: { variant: 'error', key: 'proposals.guard.flaggedBadge' },
    CLEAN: { variant: 'success', key: 'proposals.guard.cleanBadge' },
    UNSCANNED: { variant: 'neutral', key: 'proposals.guard.unscannedBadge' },
} as const;

export function CheckpointReviewPanel() {
    const { openRunId, canOperate, close } = useCheckpointReview();
    const ta = useTranslations('agents');
    const tp = useTranslations('processes');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    /** "your signature was recorded, a second reviewer is still required". */
    const [notice, setNotice] = useState<string | null>(null);
    /** Ids this reviewer has decided, so a decided row leaves without a refetch. */
    const [decided, setDecided] = useState<ReadonlySet<string>>(new Set());

    const { data, error: loadError, isLoading, mutate } = useTenantSWR<CheckpointResponse>(
        openRunId ? CACHE_KEYS.agentRuns.checkpoint(openRunId) : null,
        {
            // ALL THREE OFF, and this is the one read on the canvas where that
            // is right. The Run-Mode overlays exist to notice change nobody
            // asked about; a diff is computed against the target's state at
            // fetch time, so a background refresh would silently swap the rows
            // a reviewer is part-way through reading — and swap the
            // `baseDigest` their next click would send with them.
            //
            // `refreshInterval: 0` is stated rather than left undefined, for
            // the reason the workspace's own gating test gives about its
            // siblings: "either alone still schedules work". Omitting it reads
            // as "nobody decided", and this is a decision.
            refreshInterval: 0,
            revalidateOnFocus: false,
            revalidateOnReconnect: false,
        },
    );

    if (!openRunId) return null;

    const forbidden =
        loadError !== undefined &&
        typeof loadError === 'object' &&
        loadError !== null &&
        (loadError as { status?: number }).status === 403;

    async function act(p: CheckpointProposalRow, action: 'approve' | 'reject') {
        setBusy(p.id);
        setError(null);
        setNotice(null);
        const fallback = ta(`proposals.${action}Failed`);
        try {
            const res = await fetch(apiUrl(`/agent-proposals/${p.id}/${action}`), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                // The fingerprint of the base this reviewer actually read.
                // Sent only on approve, and only when the diff produced one
                // (an UPDATE). The server treats its ABSENCE on an update as a
                // refusal, so there is nothing to gain by omitting it — and
                // because the diff came from the SAME fetch that rendered,
                // this is the digest of what is on screen rather than of a
                // fresher read the reviewer never saw.
                body: JSON.stringify(
                    action === 'approve' && p.diff.baseDigest
                        ? { baseDigest: p.diff.baseDigest }
                        : {},
                ),
            });
            if (!res.ok) {
                const body = (await res.json().catch(() => null)) as
                    | { error?: { message?: string } }
                    | null;
                throw new Error(body?.error?.message ?? fallback);
            }
            // TWO SUCCESS SHAPES, AND THEY MEAN OPPOSITE THINGS — the same
            // reconciliation the queue does, for the same reason. A tiered
            // proposal's FIRST approval records a signature and applies
            // nothing: a 200 whose body says AWAITING_APPROVAL. Dropping the
            // row on that would teach a reviewer that clicking the button is
            // what approval means, which is this epic's own failure mode.
            const body = (await res.json().catch(() => ({}))) as {
                status?: string;
                approvalsRecorded?: number;
                approvalsRequired?: number;
            };
            if (action === 'approve' && body.status === 'AWAITING_APPROVAL') {
                setNotice(
                    ta('proposals.signatureRecorded', {
                        recorded: body.approvalsRecorded ?? 1,
                        required: body.approvalsRequired ?? 2,
                    }),
                );
                return;
            }
            setDecided((prev) => new Set(prev).add(p.id));
            // REFETCHED, not patched. Approving one proposal can settle the
            // run — the engine resumes once the checkpoint's work is done — so
            // the panel's header is stale the moment a decision lands, and the
            // row list is the server's answer rather than this component's
            // arithmetic over it.
            void mutate();
        } catch (e) {
            setError(e instanceof Error ? e.message : fallback);
        } finally {
            setBusy(null);
        }
    }

    const rows = (data?.proposals ?? []).filter((p) => !decided.has(p.id));

    return (
        <aside
            data-testid="checkpoint-review-panel"
            data-run-id={openRunId}
            className="absolute right-0 top-0 z-20 flex h-full w-[28rem] max-w-full flex-col gap-default overflow-y-auto border-l border-canvas-border bg-canvas-frame p-default"
            aria-label={tp('checkpoint.title')}
        >
            <div className="flex items-start justify-between gap-tight">
                <div className="flex flex-col">
                    <span className="text-sm font-semibold text-content-emphasis">
                        {tp('checkpoint.title')}
                    </span>
                    {data ? (
                        <span
                            className="text-xs text-content-muted"
                            data-testid="checkpoint-subtitle"
                        >
                            {tp('checkpoint.subtitle', {
                                workflowKey: data.workflowKey,
                                status: data.status,
                            })}
                        </span>
                    ) : null}
                </div>
                <Button
                    variant="ghost"
                    size="sm"
                    data-testid="checkpoint-close"
                    onClick={close}
                    aria-label={tp('checkpoint.close')}
                >
                    <Xmark className="h-4 w-4" aria-hidden="true" />
                </Button>
            </div>

            {/* ── EVERY FETCH STATE IS NAMED ─────────────────────────────
                The plan is explicit: "No stuck-loading states: every fetch has
                an explicit error state with retry. This repo has been bitten
                by `.catch(() => {})` leaving skeletons forever." So loading,
                forbidden, failed and empty are four different renderings and
                none of them is a spinner that never resolves. */}
            {isLoading && !data ? (
                <p data-testid="checkpoint-loading" className="text-sm text-content-muted">
                    {tp('checkpoint.loading')}
                </p>
            ) : forbidden ? (
                <InlineNotice variant="warning" data-testid="checkpoint-forbidden">
                    {tp('checkpoint.forbidden')}
                </InlineNotice>
            ) : loadError ? (
                <div className="flex flex-col items-start gap-tight" data-testid="checkpoint-load-failed">
                    <InlineNotice variant="error">{tp('checkpoint.loadFailed')}</InlineNotice>
                    <Button
                        variant="secondary"
                        size="sm"
                        data-testid="checkpoint-retry"
                        onClick={() => void mutate()}
                    >
                        {tp('checkpoint.retry')}
                    </Button>
                </div>
            ) : (
                <>
                    {error ? <InlineNotice variant="error">{error}</InlineNotice> : null}
                    {notice ? <InlineNotice variant="info">{notice}</InlineNotice> : null}

                    {/* The run's own window, which no proposal carries. A
                        reviewer can approve everything here and still find the
                        run will not continue, because `resumeWorkflowRun`
                        refuses past this instant — so it is shown rather than
                        discovered. */}
                    {data?.approvalExpiresAt ? (
                        <p className="text-xs text-content-subtle" data-testid="checkpoint-window">
                            {tp('checkpoint.windowCloses', { at: data.approvalExpiresAt })}
                        </p>
                    ) : null}

                    {/* AWAITING_APPROVAL DOES NOT MEAN THERE ARE PROPOSALS.
                        A HUMAN_CHECKPOINT pauses a run whether or not it
                        queued anything, and a content-guard flag pauses one
                        that queued nothing at all. An empty list on a parked
                        run is therefore a real answer about the RUN, and the
                        action is on the run page — not an empty approve queue
                        implying the reviewer has nothing to do. */}
                    {data && rows.length === 0 ? (
                        <div className="flex flex-col items-start gap-tight" data-testid="checkpoint-none">
                            <p className="text-sm text-content-muted">
                                {data.awaitingHuman
                                    ? tp('checkpoint.noneAwaiting')
                                    : tp('checkpoint.noneSettled', { status: data.status })}
                            </p>
                            <a
                                className="text-xs text-content-link underline"
                                href={tenantHref(`/agents/runs/${openRunId}`)}
                                data-testid="checkpoint-open-run"
                            >
                                {tp('checkpoint.openRun')}
                            </a>
                        </div>
                    ) : null}

                    {rows.length > 0 ? (
                        <ul className="flex flex-col gap-default">
                            {rows.map((p) => {
                                const guardState = resolveProposalGuardState({
                                    guardVerdict: p.guardVerdict as AgentGuardVerdict,
                                    guardInputDigest: p.guardInputDigest,
                                });
                                const badge = GUARD_BADGE[guardState];
                                const flagged = guardState === 'FLAGGED';
                                return (
                                    <li
                                        key={p.id}
                                        data-testid={`checkpoint-proposal-${p.id}`}
                                        data-guard-state={guardState}
                                        className="flex flex-col gap-tight rounded-md border border-border-subtle bg-bg-default p-compact"
                                    >
                                        <div className="flex items-center justify-between gap-tight">
                                            <span className="text-sm font-medium text-content-default">
                                                {p.kind} · {p.operation}
                                            </span>
                                            <StatusBadge variant={badge.variant}>
                                                {ta(badge.key)}
                                            </StatusBadge>
                                        </div>
                                        {p.stepSeq !== null ? (
                                            <span className="text-xs text-content-subtle">
                                                {tp('checkpoint.stepLabel', { seq: p.stepSeq + 1 })}
                                            </span>
                                        ) : null}
                                        {p.rationale ? (
                                            <p className="text-sm text-content-muted">
                                                <span className="font-medium text-content-default">
                                                    {ta('proposals.rationale')}
                                                </span>
                                                {p.rationale}
                                            </p>
                                        ) : null}

                                        {/* THE SAME COMPONENT THE QUEUE USES,
                                            with the approve control in its
                                            slot — a child of the rendered diff
                                            body, never a sibling of it. */}
                                        <ProposalDiffPanel
                                            proposalId={p.id}
                                            diff={p.diff}
                                            approveAction={
                                                flagged ? (
                                                    <InlineNotice
                                                        variant="warning"
                                                        data-testid={`checkpoint-flagged-${p.id}`}
                                                    >
                                                        {tp('checkpoint.flaggedBlocked', {
                                                            rules:
                                                                p.guardRuleIds.length > 0
                                                                    ? p.guardRuleIds.join(', ')
                                                                    : ta('guard.noRules'),
                                                        })}
                                                    </InlineNotice>
                                                ) : !canOperate ? (
                                                    <InlineNotice variant="info">
                                                        {ta('runs.needsWrite')}
                                                    </InlineNotice>
                                                ) : (
                                                    <Button
                                                        variant="secondary"
                                                        size="sm"
                                                        data-testid={`checkpoint-approve-${p.id}`}
                                                        disabled={busy === p.id}
                                                        onClick={() => void act(p, 'approve')}
                                                    >
                                                        {ta('proposals.approve')}
                                                    </Button>
                                                )
                                            }
                                        />

                                        {/* Reject sits OUTSIDE the diff panel,
                                            which is where the queue puts it
                                            too: refusing a proposal you cannot
                                            read is always safe, and is the only
                                            action available when the diff could
                                            not be computed. */}
                                        {canOperate ? (
                                            <div className="flex justify-end">
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    data-testid={`checkpoint-reject-${p.id}`}
                                                    disabled={busy === p.id}
                                                    onClick={() => void act(p, 'reject')}
                                                >
                                                    {ta('proposals.reject')}
                                                </Button>
                                            </div>
                                        ) : null}
                                    </li>
                                );
                            })}
                        </ul>
                    ) : null}

                    {/* A SILENT CAP READS AS COMPLETE COVERAGE. */}
                    {data?.truncated ? (
                        <InlineNotice variant="info" data-testid="checkpoint-truncated">
                            {tp('checkpoint.truncated')}
                        </InlineNotice>
                    ) : null}

                    <a
                        className="text-xs text-content-link underline"
                        href={tenantHref('/agents/proposals')}
                        data-testid="checkpoint-open-queue"
                    >
                        {tp('checkpoint.openQueue')}
                    </a>
                </>
            )}
        </aside>
    );
}
