'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast, useToastWithUndo } from '@/components/ui/hooks';
import { PermissionGated } from '../PermissionGated';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { PageHeader } from '@/components/layout/PageHeader';
import { AgentsViewsMenu } from '../AgentsViewsMenu';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@inflect/ui/lib/cn';
import { formatDateTime } from '@inflect/ui/lib/format-date';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { apiErrorMessage } from '@/lib/api-error';
import type { ProposalDiff } from '@/lib/agentic/proposal-diff-status';
// The guard's three states, and the rule that reads them. Shared with the
// governance pack, which counts the same three — see the module header for why
// a `'use client'` file cannot own a rule a server read also needs.
import {
    resolveProposalGuardState,
    type ProposalGuardState,
} from '@/lib/agentic/proposal-guard-state';
// TYPE-ONLY, and that matters: `proposal-guard` imports `node:crypto`, so a
// value import would drag the guard (and its scanners) into the browser
// bundle. `import type` is erased at compile time, which lets the client share
// the ONE definition of the verdict vocabulary instead of keeping a second
// copy that can drift from the Prisma enum it mirrors.
import type { AgentGuardVerdict } from '@/app-layer/ai/guard/proposal-guard';
// TYPE-ONLY, erased at compile time: the bulk route's skip reasons, so a reason
// added there fails to compile here until it is given a sentence.
import type { BulkRejectSkipReason } from '@/app-layer/usecases/agent-proposals';

// MOVED OUT OF THIS ROUTE DIRECTORY (#3472). The canvas's checkpoint
// panel renders the same component, and `route-import-boundaries` is
// explicit that a route directory is not a module other surfaces import
// from — so the second reader is what moved it, which is the decision
// that guard exists to force someone to make.
import { ProposalDiffPanel } from '@/components/agentic/ProposalDiffPanel';
import { proposalKindLabelKey } from '@/lib/agentic/proposal-labels';

export interface ProposalRow {
    id: string;
    kind: string;
    /** CREATE or UPDATE — decides which rendering the diff panel produces. */
    operation: string;
    status: string;
    /** The record an UPDATE would change; null for a CREATE. */
    targetEntityId: string | null;
    rationale: string | null;
    /** Set when the proposal came through an API key. Rendered nowhere. */
    proposedViaKeyId: string | null;
    /**
     * That key's `keyPrefix` — the identifier the API Keys page shows — or null
     * when there is no key or it cannot be read. What the card shows for the key.
     */
    proposedViaKeyPrefix: string | null;
    createdAt: string;
    /**
     * When the review window closes, pinned at propose time; null for a row
     * written before the deadline column, which has none.
     */
    expiresAt: string | null;
    /**
     * The window has closed, judged by the server's clock at page render. The
     * row still reads PENDING until the nightly sweep stamps it, and in that gap
     * nothing — approve or reject — can decide it.
     */
    windowClosed: boolean;
    /**
     * The run and step that produced this, or null for a proposal made outside
     * a workflow — a propose tool called directly by an agent that is not
     * executing one. NULL is an answer here, not missing data, so the link
     * below is conditional rather than a disabled control.
     */
    runId: string | null;
    stepSeq: number | null;
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
     * Distinct people whose approval is recorded. A PENDING row with one or more
     * is waiting for another approver: it would have been applied otherwise.
     *
     * Read from the signature table by the page, and updated from the approve
     * response in place. It used to be a client-only flag set from that
     * response, so after a reload a proposal holding one of its two approvals
     * looked exactly like one holding none.
     */
    approvalsRecorded: number;
    /**
     * The viewer is one of those approvers. Their Approve can only be refused
     * (four eyes: a second approval is somebody else's), so it is not offered.
     */
    signedByViewer: boolean;
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
 * Where a row's decision stands, when it is anything but "open, unsigned". A
 * closed window outranks a recorded signature: nothing can complete the
 * proposal now. Read from the row's data, so a reload shows what a click did.
 */
function decisionBadgeFor(
    p: Pick<ProposalRow, 'windowClosed' | 'approvalsRecorded'>,
): { variant: 'warning' | 'info'; key: string; testid: string } | null {
    if (p.windowClosed) {
        return { variant: 'warning', key: 'proposals.window.closed', testid: 'proposal-window-closed-badge' };
    }
    if (p.approvalsRecorded > 0) {
        return { variant: 'info', key: 'proposals.awaitingSecond', testid: 'proposal-awaiting-second-badge' };
    }
    return null;
}

/** The sentence each bulk-reject skip reason is reported with. */
type SkipCause = 'decided' | 'expired' | 'quarantined' | 'ownDissent' | 'unknownDissent';

const SKIP_CAUSE: Record<BulkRejectSkipReason, SkipCause> = {
    NOT_PENDING: 'decided',
    NOT_FOUND: 'decided',
    EXPIRED: 'expired',
    QUARANTINED: 'quarantined',
    DISSENT_AUTHOR_MAY_NOT_DECIDE: 'ownDissent',
    DISSENT_AUTHOR_UNKNOWN: 'unknownDissent',
};

/** The causes in the order they are worth reading: the caller's own first. */
const SKIP_CAUSE_ORDER: readonly SkipCause[] = [
    'ownDissent',
    'unknownDissent',
    'quarantined',
    'expired',
    'decided',
];

/**
 * The distinct causes a bulk reject's skipped rows report, each once. A reason
 * this client does not know names no cause rather than borrowing one: the count
 * is still reported, and a wrong cause is the defect this replaces.
 */
function skipCauses(skipped: ReadonlyArray<{ reason?: string }>): SkipCause[] {
    const seen = new Set<SkipCause>();
    for (const s of skipped) {
        const cause = s.reason ? SKIP_CAUSE[s.reason as BulkRejectSkipReason] : undefined;
        if (cause) seen.add(cause);
    }
    return SKIP_CAUSE_ORDER.filter((c) => seen.has(c));
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
    tenantSlug,
    initialProposals,
    canOperate,
    canCompose = false,
    canInvestigate = false,
    canReadReports = false,
    oversightReads,
    canSetOrphanPass = false,
    truncated = false,
}: {
    tenantSlug: string;
    initialProposals: ProposalRow[];
    /**
     * The page read one more proposal than it lists, and got it: more are
     * waiting than this page shows.
     */
    truncated?: boolean;
    /**
     * The role-tier `canWrite` (#2456). This page is gated on `admin.view` or
     * the inventory view key (#3710);
     * `approveAgentProposal` and `rejectAgentProposal` both open with
     * `assertCanWrite(ctx)`. Approve and Reject rendered enabled for readers
     * and returned 403 on press.
     */
    canOperate: boolean;
    /**
     * The views menu's other gates (#3710). This page's own gate — `admin.view`
     * OR the inventory view key — no longer implies any of them, so the page
     * passes each. ABSENT reads as `false`: a menu that drops an entry is a
     * missing shortcut, one that offers a refused page is a defect.
     */
    canCompose?: boolean;
    canInvestigate?: boolean;
    canReadReports?: boolean;
    /** Which assurance surfaces the viewer may read (`agent-oversight-settings.ts`). */
    oversightReads?: Readonly<{ decisions: boolean; receipts: boolean; quarantine: boolean }>;
    /** `admin.tenant_lifecycle` — the views menu offers Owner departures (#4903). */
    canSetOrphanPass?: boolean;
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
    /**
     * The rows ticked for a bulk reject, by id.
     *
     * A Set rather than a flag on the row: the list is re-created by every
     * single-row action, and a selection carried inside it would have to be
     * copied through each of those rewrites.
     */
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
    const toast = useToast();
    const triggerUndoToast = useToastWithUndo();

    function toggleSelected(id: string) {
        setSelected((prev) => {
            const next = new Set(prev);
            if (!next.delete(id)) next.add(id);
            return next;
        });
    }

    /**
     * Reject every ticked proposal, behind the undo window.
     *
     * The rows leave the list IMMEDIATELY and the request fires when the window
     * closes — which is why the API is a batch route rather than a loop over
     * the single-reject endpoint. A loop would send N requests that can half
     * succeed, leaving the operator with no statement about what happened; one
     * request answers with the ids it moved and the ids it did not.
     *
     * The count in the toast is necessarily the SELECTED count: it is composed
     * before the request exists. The server's answer is reconciled afterwards,
     * the way the register bulk deletes do it — a row somebody else decided in
     * the meantime is reported, not absorbed into a confident wrong number.
     */
    function bulkReject() {
        const ids = Array.from(selected);
        if (ids.length === 0) return;
        setError(null);
        setNotice(null);

        const previous = proposals;
        const restore = () => setProposals(previous);
        setProposals((prev) => prev.filter((row) => !selected.has(row.id)));
        setSelected(new Set());

        triggerUndoToast({
            message: t('proposals.bulk.rejectedToast', { count: ids.length }),
            undoMessage: t('proposals.bulk.undo'),
            action: async () => {
                const res = await fetch(apiUrl('/agent-proposals/bulk/reject'), {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ proposalIds: ids }),
                });
                if (!res.ok) throw new Error(t('proposals.bulk.failed'));
                const body = (await res.json().catch(() => null)) as
                    | { rejected?: string[]; skipped?: Array<{ id: string; reason?: string }> }
                    | null;
                const rejected = body?.rejected?.length ?? ids.length;
                const skipped = body?.skipped?.length ?? 0;
                if (skipped > 0) {
                    // The rows that could not be rejected are back on the list,
                    // because they are still open decisions for somebody. The
                    // optimistic removal above took them out on the assumption
                    // the whole batch would move.
                    setProposals((prev) => {
                        const live = new Set(prev.map((row) => row.id));
                        const movedIds = new Set(body?.rejected ?? []);
                        const returning = previous.filter(
                            (row) =>
                                ids.includes(row.id) &&
                                !movedIds.has(row.id) &&
                                !live.has(row.id),
                        );
                        return returning.length > 0 ? [...returning, ...prev] : prev;
                    });
                    // The count, then WHY, one sentence per cause the batch hit.
                    // The message used to name two causes whatever happened, so
                    // a row skipped because the reviewer raised its dissent was
                    // reported as somebody else's decision or the clock.
                    toast.info(
                        [
                            t('proposals.bulk.rejectedReconciled', { rejected, skipped }),
                            ...skipCauses(body?.skipped ?? []).map((cause) =>
                                t(`proposals.bulk.skipped.${cause}`),
                            ),
                        ].join(' '),
                    );
                }
            },
            undoAction: restore,
            onError: () => {
                restore();
                setError(t('proposals.bulk.failed'));
            },
        });
    }

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
                // The server's sentence, not a code: a four-eyes or a closed-
                // window refusal says why and what to do, in `error.message`.
                const body = await res.json().catch(() => null);
                throw new Error(apiErrorMessage(body, fallback));
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
                        row.id === p.id
                            ? { ...row, approvalsRecorded: recorded, signedByViewer: true }
                            : row,
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

    /** The kind's name; a kind this client does not know is shown as stored. */
    function kindLabel(kind: string): string {
        const key = proposalKindLabelKey(kind);
        return key ? t(key) : kind;
    }

    /**
     * The key a proposal came through, by the prefix the API Keys page shows.
     * It used to print eight characters of the key's internal id, which matches
     * nothing an operator can look up.
     */
    function keySuffix(p: ProposalRow): string {
        if (!p.proposedViaKeyId) return '';
        return p.proposedViaKeyPrefix
            ? t('proposals.keySuffix', { key: `${p.proposedViaKeyPrefix}…` })
            : t('proposals.keySuffixUnresolved');
    }

    return (
        <div className="space-y-section animate-fadeIn">
            <PageHeader
                back={{ smart: true }}
                breadcrumbs={[
                    { label: t('crumbDashboard'), href: tenantHref('/dashboard') },
                    { label: t('register.breadcrumb'), href: tenantHref('/agents') },
                    { label: t('proposals.crumb') },
                ]}
                title={t('proposals.title')}
                description={t('proposals.description')}
                // One click to any of the other agentic surfaces, and the menu
                // marks this one. Only this page's own gate is true by
                // construction: since #3710 a reader holding the view key alone
                // (AUDITOR, AI_ADMIN) reaches here, so the page passes the
                // other gates rather than the menu assuming them.
                actions={
                    <AgentsViewsMenu
                        current="proposals"
                        tenantSlug={tenantSlug}
                        canReviewProposals
                        canCompose={canCompose}
                        canInvestigate={canInvestigate}
                        canReadReports={canReadReports}
                        oversightReads={oversightReads}
                        canSetOrphanPass={canSetOrphanPass}
                    />
                }
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

            {truncated && (
                // The queue stops at a page; the views-menu badge counts every
                // waiting proposal. Saying so is the difference between "this
                // is the queue" and "this is the first page of it".
                <InlineNotice variant="warning" data-testid="proposal-queue-truncated">
                    {t('proposals.truncated', { shown: initialProposals.length })}
                </InlineNotice>
            )}

            {selected.size > 0 && (
                <div
                    data-testid="proposal-bulk-bar"
                    className={cn(
                        cardVariants({ density: 'compact' }),
                        'flex items-center justify-between gap-default text-sm',
                    )}
                >
                    <span className="text-content-muted">
                        {t('proposals.bulk.selected', { count: selected.size })}
                    </span>
                    <div className="flex items-center gap-tight">
                        <Button
                            variant="ghost"
                            size="sm"
                            data-testid="proposal-bulk-clear"
                            onClick={() => setSelected(new Set())}
                        >
                            {t('proposals.bulk.clear')}
                        </Button>
                        <PermissionGated allowed={canOperate} reason={t('runs.needsWrite')}>
                            <Button
                                variant="secondary"
                                size="sm"
                                data-testid="proposal-bulk-reject"
                                disabled={!canOperate}
                                onClick={bulkReject}
                            >
                                {t('proposals.bulk.reject')}
                            </Button>
                        </PermissionGated>
                    </div>
                </div>
            )}

            {proposals.length === 0 ? (
                <EmptyState
                    title={t('proposals.emptyTitle')}
                    // WHO CAN APPROVE, not just what lands here (#2458). An
                    // empty queue is the one moment an operator reads this
                    // screen, and "wait for something to appear" is the least
                    // useful thing it could say. The copy varies on the same
                    // role-tier term the buttons do, so a reader is told plainly
                    // that approving is not theirs rather than discovering it
                    // when the first proposal arrives and the button is greyed.
                    description={
                        canOperate
                            ? t('proposals.emptyDesc')
                            : t('proposals.emptyDescReader')
                    }
                />
            ) : (
                <ul className="space-y-default">
                    {proposals.map((p) => {
                        const guardState = resolveProposalGuardState(p);
                        const guardBadge = GUARD_BADGE[guardState];
                        const decisionBadge = decisionBadgeFor(p);
                        return (
                        <li
                            key={p.id}
                            id={`proposal-${p.id}`}
                            className={cn(cardVariants({ density: 'comfortable' }), 'space-y-default')}
                        >
                            <div className="flex items-center justify-between gap-default">
                                <div className="flex items-center gap-tight">
                                    {/*
                                      The tick that puts this row in a bulk
                                      reject. Rendered for readers too and
                                      disabled there, rather than hidden: a
                                      control that vanishes by role leaves a
                                      reader wondering whether the queue even
                                      has the affordance. Disabled too on a row
                                      whose window has closed: the batch would
                                      only report it back as skipped.
                                    */}
                                    <Checkbox
                                        size="sm"
                                        aria-label={t('proposals.bulk.selectRow')}
                                        data-testid={`proposal-select-${p.id}`}
                                        disabled={!canOperate || p.windowClosed}
                                        checked={selected.has(p.id)}
                                        onCheckedChange={() => toggleSelected(p.id)}
                                    />
                                    <StatusBadge variant="info" data-testid={`proposal-kind-${p.id}`}>
                                        {kindLabel(p.kind)}
                                    </StatusBadge>
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
                                    {/*
                                      WHERE THE DECISION STANDS, from the data —
                                      one badge, subtle, beside the guard's: the
                                      guard verdict stays the loud one on the row.
                                    */}
                                    {decisionBadge && (
                                        <StatusBadge
                                            variant={decisionBadge.variant}
                                            tone="subtle"
                                            data-testid={`${decisionBadge.testid}-${p.id}`}
                                        >
                                            {t(decisionBadge.key)}
                                        </StatusBadge>
                                    )}
                                    <span
                                        className="text-xs text-content-subtle"
                                        data-testid={`proposal-meta-${p.id}`}
                                    >
                                        {t('proposals.proposedAt', {
                                            date: formatDateTime(p.createdAt),
                                        })}
                                        {p.expiresAt && !p.windowClosed
                                            ? t('proposals.decideBy', {
                                                date: formatDateTime(p.expiresAt),
                                            })
                                            : ''}
                                        {keySuffix(p)}
                                    </span>
                                </div>
                                {/*
                                  Reject only. The approve control is NOT here —
                                  it is rendered by the diff panel below, in the
                                  branch that has already rendered a diff body.
                                  Not rendered once the window has closed: no
                                  role can reject then, and the notice below
                                  says why.
                                */}
                                {!p.windowClosed && (
                                    <PermissionGated allowed={canOperate} reason={t('runs.needsWrite')}>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            data-testid={`proposal-reject-${p.id}`}
                                            disabled={!canOperate || busy === p.id}
                                            onClick={() => act(p, 'reject')}
                                        >
                                            {t('proposals.reject')}
                                        </Button>
                                    </PermissionGated>
                                )}
                            </div>

                            {p.windowClosed && p.expiresAt && (
                                // The sweep that stamps EXPIRED runs overnight,
                                // so the row is still listed. Say what that
                                // means before anybody clicks.
                                <InlineNotice
                                    variant="warning"
                                    data-testid={`proposal-window-closed-${p.id}`}
                                >
                                    {t('proposals.window.closedNotice', {
                                        date: formatDateTime(p.expiresAt),
                                    })}
                                </InlineNotice>
                            )}

                            {p.targetEntityId && (
                                <p
                                    data-testid={`proposal-target-${p.id}`}
                                    className="text-xs text-content-subtle"
                                >
                                    {t('proposals.diff.targetLabel', { id: p.targetEntityId })}
                                </p>
                            )}

                            {/*
                              WHERE THIS CAME FROM. A reviewer approving an
                              agent's proposed write is consenting to reasoning
                              they cannot see from here — the step's tool call,
                              its input and its output live in the run's ledger.
                              The link is the shortest path from "should I
                              approve this" to the evidence for it.

                              Conditional on `runId`, because NULL is a real
                              answer: a propose tool called outside a workflow
                              has no step, and a disabled control would imply a
                              run existed and was unreachable.
                            */}
                            {p.runId && (
                                <p className="text-xs text-content-subtle">
                                    <a
                                        className="underline"
                                        data-testid={`proposal-run-link-${p.id}`}
                                        href={`${tenantHref(`/agents/runs/${p.runId}`)}${
                                            p.stepSeq === null ? '' : `#step-${p.stepSeq}`
                                        }`}
                                    >
                                        {p.stepSeq === null
                                            ? t('proposals.fromRun')
                                            : t('proposals.fromRunStep', { seq: p.stepSeq + 1 })}
                                    </a>
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
                                    p.windowClosed ? (
                                        <span
                                            data-testid={`proposal-window-closed-action-${p.id}`}
                                            className="text-xs text-content-subtle"
                                        >
                                            {t('proposals.window.closed')}
                                        </span>
                                    ) : p.signedByViewer ? (
                                        // This viewer's signature is in. Their
                                        // second click could only be refused.
                                        <span
                                            data-testid={`proposal-signed-by-you-${p.id}`}
                                            className="text-xs text-content-subtle"
                                        >
                                            {t('proposals.signedByYou')}
                                        </span>
                                    ) : (
                                        <PermissionGated allowed={canOperate} reason={t('runs.needsWrite')}>
                                            <Button
                                                variant="secondary"
                                                size="sm"
                                                data-testid={`proposal-approve-${p.id}`}
                                                disabled={!canOperate || busy === p.id}
                                                onClick={() => onApproveClick(p)}
                                            >
                                                {t('proposals.approve')}
                                            </Button>
                                        </PermissionGated>
                                    )
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
