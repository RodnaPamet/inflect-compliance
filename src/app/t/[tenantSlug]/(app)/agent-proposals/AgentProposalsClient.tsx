'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { PageHeader } from '@/components/layout/PageHeader';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format-date';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import type { ProposalDiff } from '@/lib/agentic/proposal-diff';
// TYPE-ONLY, and that matters: `proposal-guard` imports `node:crypto`, so a
// value import would drag the guard (and its scanners) into the browser
// bundle. `import type` is erased at compile time, which lets the client share
// the ONE definition of the verdict vocabulary instead of keeping a second
// copy that can drift from the Prisma enum it mirrors.
import type { AgentGuardVerdict } from '@/app-layer/ai/guard/proposal-guard';

import { ProposalDiffPanel } from './ProposalDiffPanel';

export interface ProposalRow {
    id: string;
    kind: string;
    /** CREATE or UPDATE — decides which rendering the diff panel produces. */
    operation: string;
    status: string;
    /** The record an UPDATE would change; null for a CREATE. */
    targetEntityId: string | null;
    rationale: string | null;
    proposedViaKeyId: string | null;
    createdAt: string;
    /**
     * The agentic output guard's verdict on this proposal's content.
     *
     * NOT NULLABLE — the column is `AgentGuardVerdict NOT NULL DEFAULT 'CLEAN'`,
     * so every row has one. That default is the trap: it is also what a row
     * written before the guard existed carries. Read this through
     * `resolveProposalGuardState`, never on its own.
     */
    guardVerdict: AgentGuardVerdict;
    /**
     * The stable ids of the rules that fired. IDS ONLY — the column never holds
     * the matched text, which is why this surface can render them at all. They
     * are the difference between "something was odd about this" and "this
     * matched a known injection pattern", so they are shown, not summarised.
     */
    guardRuleIds: string[];
    /**
     * `sha256:<hex>` over the guarded content, or null.
     *
     * Rendered nowhere. It is here as the EVIDENCE THAT A SCAN RAN: the guard
     * writes it on every proposal it decides, so a null means this row predates
     * the guard. Without it, `guardVerdict === 'CLEAN'` cannot distinguish a
     * clean scan from no scan at all.
     */
    guardInputDigest: string | null;
    /**
     * The diff, computed SERVER-SIDE against the target's state at page render.
     *
     * The raw `payloadJson` is deliberately no longer sent to the client. It was
     * the whole of the old review surface — a `<pre>` of the payload — and that
     * is exactly the opaque blob this page exists to stop a reviewer approving.
     * Shipping it alongside the diff would leave the failure one `JSON.stringify`
     * away from returning.
     */
    diff: ProposalDiff;
    /**
     * This viewer's signature is recorded and the proposal still needs another.
     *
     * Client-side only and deliberately so: it is set from the approve response,
     * which is the one moment the browser learns it. The authoritative count
     * lives on the server; this exists so the row does not silently vanish.
     */
    awaitingSecondApproval?: boolean;
}

/**
 * WHAT THE GUARD SAYS ABOUT ONE ROW — three states, not three verdicts.
 *
 * `AgentGuardVerdict` has three values and this has three states, and they do
 * not line up. `guardVerdict` is `NOT NULL DEFAULT 'CLEAN'`, and the migration
 * that added it deliberately ran NO BACKFILL: "every existing row entered a
 * queue that had no guard, so CLEAN here means 'not refused', not 'scanned and
 * found clean'". So the column alone cannot tell a clean scan from no scan, and
 * a surface that reads it alone tells a reviewer a row was checked when nobody
 * checked it. `guardInputDigest` is the discriminator — the guard writes it on
 * every proposal it decides, and it is NULL for exactly the pre-guard rows.
 *
 * QUARANTINED maps to FLAGGED rather than to a fourth state. It cannot arrive
 * here — `listAgentProposals` parses `?status=` against the REVIEWABLE
 * vocabulary and names that set in the query even with no filter — but if it
 * ever does, the safe reading of "the guard refused this" is the alarming one,
 * not silence. The quarantine page is where such a row is investigated.
 */
export type ProposalGuardState = 'FLAGGED' | 'CLEAN' | 'UNSCANNED';

export function resolveProposalGuardState(row: {
    guardVerdict: AgentGuardVerdict;
    guardInputDigest: string | null;
}): ProposalGuardState {
    if (row.guardVerdict !== 'CLEAN') return 'FLAGGED';
    return row.guardInputDigest ? 'CLEAN' : 'UNSCANNED';
}

/**
 * The badge each guard state wears in the LIST.
 *
 * Every state gets one, including CLEAN — which is the opposite of the call
 * `QuarantineClient` makes, and for the opposite reason. There the population is
 * `status = 'QUARANTINED'`, so the verdict is a constant and a column of one
 * repeated badge would cost width and carry nothing. Here the population is
 * MIXED: a badge only on the flagged rows would leave the clean ones and the
 * unscanned ones sharing a single rendering — an absence — and this whole issue
 * is that an absence was being read as "the guard found nothing". Three states,
 * three badges; the flagged one is `solid` so it separates from the two quiet
 * ones at a glance rather than by reading.
 */
const GUARD_BADGE: Record<
    ProposalGuardState,
    { variant: 'warning' | 'success' | 'neutral'; tone: 'solid' | 'subtle'; key: string }
> = {
    FLAGGED: { variant: 'warning', tone: 'solid', key: 'proposals.guard.flaggedBadge' },
    CLEAN: { variant: 'success', tone: 'subtle', key: 'proposals.guard.cleanBadge' },
    UNSCANNED: { variant: 'neutral', tone: 'subtle', key: 'proposals.guard.unscannedBadge' },
};

/**
 * The rule ids, comma-joined — the same rendering the quarantine table gives
 * them, including the fallback when a non-clean verdict carries none. Reused
 * rather than re-invented: an operator who has learnt to read
 * `injection.role_declaration` on the triage page must not meet a second
 * vocabulary for the same column here.
 */
function guardRuleText(
    row: Pick<ProposalRow, 'guardRuleIds'>,
    t: (key: string) => string,
): string {
    return row.guardRuleIds.length > 0
        ? row.guardRuleIds.join(', ')
        : t('guard.noRules');
}

/**
 * The review-queue client.
 *
 * Each proposal renders its DIFF, and the approve control lives INSIDE that
 * diff panel (see `ProposalDiffPanel` for why it is a child rather than a
 * sibling). Reject stays in the card header: refusing a proposal you cannot
 * read is always safe, and is the only action available when the diff could not
 * be computed.
 *
 * Approving an UPDATE sends back the `baseDigest` of the diff that was
 * rendered. The server recomputes it and refuses the approval if the record has
 * moved since — so "a human approved this delta" stays a checkable claim rather
 * than a checkbox.
 */
export function AgentProposalsClient({
    initialProposals,
}: {
    tenantSlug: string;
    initialProposals: ProposalRow[];
}) {
    const t = useTranslations('agents');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const [proposals, setProposals] = useState(initialProposals);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    /** "your signature was recorded, a second reviewer is still required". */
    const [notice, setNotice] = useState<string | null>(null);
    /**
     * The FLAGGED proposal whose approval is waiting on an explicit second
     * click. Holds the whole row, not an id, because the dialog names the rule
     * ids and the row is where they live.
     */
    const [confirmingFlagged, setConfirmingFlagged] = useState<ProposalRow | null>(null);

    async function act(p: ProposalRow, action: 'approve' | 'reject') {
        setBusy(p.id);
        setError(null);
        setNotice(null);
        const fallback = t(`proposals.${action}Failed`);
        try {
            const res = await fetch(apiUrl(`/agent-proposals/${p.id}/${action}`), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                // The fingerprint of the base this reviewer actually read. Sent
                // only on approve, and only when the diff produced one (an
                // UPDATE). The server treats its ABSENCE on an update as a
                // refusal, so there is nothing to gain by omitting it.
                body: JSON.stringify(
                    action === 'approve' && p.diff.baseDigest
                        ? { baseDigest: p.diff.baseDigest }
                        : {},
                ),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                throw new Error(body?.error?.message ?? fallback);
            }

            // TWO SUCCESS SHAPES, AND THEY MEAN OPPOSITE THINGS.
            //
            // A tiered proposal's FIRST approval records a signature and applies
            // nothing — a 200 whose body says `AWAITING_APPROVAL`. Treating that
            // as "done" and dropping the row is this epic's own failure in
            // miniature: a reviewer told "approved" for a proposal that has not
            // been approved learns that clicking the button is what approval
            // means, and the queue hides the fact that a second human is still
            // required. So the row STAYS, and it says what is missing.
            const body: { status?: string; approvalsRecorded?: number; approvalsRequired?: number } =
                await res.json().catch(() => ({}));
            if (action === 'approve' && body.status === 'AWAITING_APPROVAL') {
                const recorded = body.approvalsRecorded ?? 1;
                const required = body.approvalsRequired ?? 2;
                setProposals((prev) =>
                    prev.map((row) =>
                        row.id === p.id ? { ...row, awaitingSecondApproval: true } : row,
                    ),
                );
                setNotice(t('proposals.signatureRecorded', { recorded, required }));
                return;
            }
            setProposals((prev) => prev.filter((row) => row.id !== p.id));
        } catch (e) {
            setError(e instanceof Error ? e.message : fallback);
        } finally {
            setBusy(null);
        }
    }

    /**
     * The approve button's handler, and the ONE place the guard verdict becomes
     * friction rather than decoration.
     *
     * A badge in the row is read while scanning; the click that creates the real
     * record is a different moment, and a reviewer working through a queue can
     * reach it without the badge ever having been the thing they were looking
     * at. So a FLAGGED proposal takes a second, deliberate confirmation that
     * repeats the verdict and names the rules — the reviewer either read the
     * ladder or refused it, and either way the queue can say which.
     *
     * CLEAN and UNSCANNED rows keep the single click. Putting a dialog in front
     * of every approval is how a dialog becomes a thing people dismiss without
     * reading, which would spend the interruption budget on the rows that do not
     * need it and leave nothing for the ones that do — the automation-bias
     * failure (ASI09) this queue already exists to resist. UNSCANNED is named in
     * the row instead: it is the absence of a check, not the result of one, and
     * no click by this reviewer can resolve it.
     */
    function onApproveClick(p: ProposalRow) {
        if (resolveProposalGuardState(p) === 'FLAGGED') {
            setConfirmingFlagged(p);
            return;
        }
        void act(p, 'approve');
    }

    return (
        <div className="space-y-section animate-fadeIn">
            <PageHeader
                back={{ smart: true }}
                breadcrumbs={[
                    { label: t('crumbDashboard'), href: tenantHref('/dashboard') },
                    { label: t('crumbAdmin'), href: tenantHref('/admin') },
                    { label: t('crumbMcp'), href: tenantHref('/admin/mcp') },
                    { label: t('proposals.crumb') },
                ]}
                title={t('proposals.title')}
                description={t('proposals.description')}
            />

            {notice && (
                <div
                    data-testid="proposal-awaiting-second"
                    className={cn(cardVariants({ density: 'compact' }), 'text-sm text-content-muted')}
                >
                    {notice}
                </div>
            )}

            {error && (
                <div
                    data-testid="proposal-action-error"
                    className={cn(cardVariants({ density: 'compact' }), 'text-sm text-content-error')}
                >
                    {error}
                </div>
            )}

            {proposals.length === 0 ? (
                <EmptyState
                    title={t('proposals.emptyTitle')}
                    description={t('proposals.emptyDesc')}
                />
            ) : (
                <ul className="space-y-default">
                    {proposals.map((p) => {
                        const guardState = resolveProposalGuardState(p);
                        const guardBadge = GUARD_BADGE[guardState];
                        return (
                        <li
                            key={p.id}
                            id={`proposal-${p.id}`}
                            className={cn(cardVariants({ density: 'comfortable' }), 'space-y-default')}
                        >
                            <div className="flex items-center justify-between gap-default">
                                <div className="flex items-center gap-tight">
                                    <StatusBadge variant="info">{p.kind}</StatusBadge>
                                    <StatusBadge
                                        variant={p.operation === 'UPDATE' ? 'warning' : 'neutral'}
                                    >
                                        {p.operation === 'UPDATE'
                                            ? t('proposals.diff.operationUpdate')
                                            : t('proposals.diff.operationCreate')}
                                    </StatusBadge>
                                    {/*
                                      The output guard's verdict, IN THE LIST.
                                      Not behind the diff panel and not in a
                                      tooltip: a reviewer triaging a queue
                                      decides which rows to open from this line,
                                      so a signal only visible after opening a
                                      row cannot change which rows get opened.
                                    */}
                                    <StatusBadge
                                        variant={guardBadge.variant}
                                        tone={guardBadge.tone}
                                        data-testid={`proposal-guard-badge-${p.id}`}
                                    >
                                        {t(guardBadge.key)}
                                    </StatusBadge>
                                    <span className="text-xs text-content-subtle">
                                        {t('proposals.proposedAt', {
                                            date: formatDateTime(p.createdAt),
                                        })}
                                        {p.proposedViaKeyId
                                            ? t('proposals.keySuffix', {
                                                key: p.proposedViaKeyId.slice(0, 8),
                                            })
                                            : ''}
                                    </span>
                                </div>
                                {/*
                                  Reject only. The approve control is NOT here —
                                  it is rendered by the diff panel below, in the
                                  branch that has already rendered a diff body.
                                */}
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    data-testid={`proposal-reject-${p.id}`}
                                    disabled={busy === p.id}
                                    onClick={() => act(p, 'reject')}
                                >
                                    {t('proposals.reject')}
                                </Button>
                            </div>

                            {p.targetEntityId && (
                                <p
                                    data-testid={`proposal-target-${p.id}`}
                                    className="text-xs text-content-subtle"
                                >
                                    {t('proposals.diff.targetLabel', { id: p.targetEntityId })}
                                </p>
                            )}

                            {guardState === 'FLAGGED' && (
                                // The rule ids are the payload of this notice.
                                // "Something was odd" is not actionable; a rule
                                // id is a thing an operator can look up, match
                                // against the quarantine page, and recognise on
                                // the next proposal from the same agent.
                                <InlineNotice
                                    variant="warning"
                                    data-testid={`proposal-guard-flagged-${p.id}`}
                                >
                                    {t('proposals.guard.flaggedNotice')}{' '}
                                    <span className="font-medium">
                                        {t('proposals.guard.rulesLabel')}
                                    </span>{' '}
                                    <span
                                        className="font-mono"
                                        data-testid={`proposal-guard-rules-${p.id}`}
                                    >
                                        {guardRuleText(p, t)}
                                    </span>
                                </InlineNotice>
                            )}

                            {guardState === 'UNSCANNED' && (
                                // A DIFFERENT CLAIM FROM "clean", and it has to
                                // read as one. This row predates the guard, so
                                // nothing scanned it — rendering that the same
                                // way as a clean scan would manufacture an
                                // assurance no code ever produced.
                                <p
                                    data-testid={`proposal-guard-unscanned-${p.id}`}
                                    className="text-xs text-content-subtle"
                                >
                                    {t('proposals.guard.unscannedNotice')}
                                </p>
                            )}

                            {p.rationale && (
                                <p
                                    data-testid={`proposal-rationale-${p.id}`}
                                    className="text-sm text-content-muted"
                                >
                                    <span className="font-medium text-content-default">
                                        {t('proposals.rationale')}
                                    </span>
                                    {p.rationale}
                                </p>
                            )}

                            <ProposalDiffPanel
                                proposalId={p.id}
                                diff={p.diff}
                                approveAction={
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        data-testid={`proposal-approve-${p.id}`}
                                        disabled={busy === p.id}
                                        onClick={() => onApproveClick(p)}
                                    >
                                        {t('proposals.approve')}
                                    </Button>
                                }
                            />
                        </li>
                        );
                    })}
                </ul>
            )}

            {/*
              ONE dialog for the list, keyed by the row it holds — not one per
              card. A confirmation rendered inside the map would mount a modal
              per proposal, and a queue is exactly where that multiplies.
            */}
            <ConfirmDialog
                showModal={confirmingFlagged !== null}
                setShowModal={(next) => {
                    const open =
                        typeof next === 'function' ? next(confirmingFlagged !== null) : next;
                    if (!open) setConfirmingFlagged(null);
                }}
                // WARNING, not danger, and the distinction is the repo's not
                // mine: `danger` is reserved for irreversible erasure and its
                // confirm label must open with a canonical destructive verb
                // (Delete / Remove / Revoke / …) — see
                // `tests/guards/destructive-vocabulary.test.ts`. Approving a
                // proposal CREATES a compliance record; it is the "significant
                // consequence" rung, which is what `warning` means here. Wearing
                // the erasure tone to look serious would put this dialog in a
                // vocabulary whose verbs cannot describe what the button does.
                tone="warning"
                title={t('proposals.guard.confirmTitle')}
                description={
                    confirmingFlagged ? (
                        // The rule ids are a CHILD here, not a `{rules}`
                        // placeholder inside the sentence — same shape as the
                        // notice in the row. Interpolating them would put
                        // machine identifiers through a translator's hands and,
                        // worse, make them disappear entirely on any locale
                        // whose catalogue is missing this key: next-intl falls
                        // back to rendering the key itself, and a fallback that
                        // silently drops the evidence is the failure this whole
                        // change is about.
                        <span data-testid="proposal-guard-confirm-body">
                            {t('proposals.guard.confirmBody')}{' '}
                            <span className="font-medium">
                                {t('proposals.guard.rulesLabel')}
                            </span>{' '}
                            <span
                                className="font-mono"
                                data-testid="proposal-guard-confirm-rules"
                            >
                                {guardRuleText(confirmingFlagged, t)}
                            </span>
                        </span>
                    ) : undefined
                }
                confirmLabel={t('proposals.guard.confirmApprove')}
                cancelLabel={t('proposals.guard.confirmCancel')}
                onConfirm={() => {
                    // The row is held until `act` settles: the dialog closes
                    // itself afterwards (which clears it), and clearing first
                    // would blank the description under the pending button.
                    // `act` never throws — it surfaces failures through the
                    // page-level error notice — so the close always happens.
                    const p = confirmingFlagged;
                    return p ? act(p, 'approve') : undefined;
                }}
                onCancel={() => setConfirmingFlagged(null)}
            />
        </div>
    );
}
