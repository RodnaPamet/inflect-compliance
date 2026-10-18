'use client';

/**
 * Epic G-4 — Access Review detail / reviewer page.
 *
 * The reviewer's working surface — every snapshot subject is one
 * row in a table with:
 *   • Subject identity (name + email)
 *   • Snapshot role at campaign creation (frozen evidence)
 *   • Live role today (changes if anyone updated the membership
 *     after snapshot)
 *   • Last activity date (max UserSession.lastActiveAt for the user)
 *   • Decision dropdown — CONFIRM / REVOKE / MODIFY
 *   • Decision-aware modal for MODIFY's `modifiedToRole` + notes
 *
 * Permission gating in this component:
 *   - Only the assigned reviewer (ctx.userId === review.reviewerUserId)
 *     OR an admin can submit decisions.
 *   - Only an admin can press "Close campaign".
 *   - Anyone with read can browse + download the evidence PDF when
 *     the campaign is CLOSED.
 */
import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useSWRConfig } from 'swr';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { useEntityListIds } from '@/lib/hooks/use-entity-list-ids';
import { StatusBadge } from '@/components/ui/status-badge';
import { MetaStrip } from '@/components/ui/meta-strip';
import { Button } from '@/components/ui/button';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { DataTable, createColumns } from '@/components/ui/table';
import { formatDate, formatDateTime } from '@inflect/ui/lib/format-date';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { TENANT_ROLES, type AssignableTenantRole } from '@/lib/roles';
import { apiErrorMessage } from '@/lib/api-error';
import { Heading } from '@/components/ui/typography';
import {
    AGENT_CAMPAIGNS_IMPLEMENTED,
    readAgentSubjectSnapshot,
    scopeLabelKey,
    subjectTableOf,
    type StoredAccessReviewScope,
} from '@/lib/access-review/scope';

/**
 * The roles a MODIFY decision may target — a writer's list, because closing the
 * campaign writes the target to the membership. AI_ADMIN (#3699) is absent:
 * a campaign never promotes anybody to it (`ASSIGNABLE_TENANT_ROLES`, which
 * the API enforces).
 */
const MODIFY_TARGET_ROLES = [
    'OWNER',
    'ADMIN',
    'EDITOR',
    'READER',
    'AUDITOR',
] as const satisfies readonly AssignableTenantRole[];
type ModifyTargetRole = (typeof MODIFY_TARGET_ROLES)[number];
/** A role a row can CARRY — a reader's type, so AI_ADMIN included. */
type Role = (typeof TENANT_ROLES)[number];
type DecisionType = 'CONFIRM' | 'REVOKE' | 'MODIFY';
type Status = 'OPEN' | 'IN_REVIEW' | 'CLOSED';

interface DecisionRow {
    id: string;
    subjectUserId: string;
    subjectUser: { id: string; email: string; name: string | null };
    snapshotRole: Role;
    snapshotMembershipStatus: string;
    decision: DecisionType | null;
    decidedAt: string | Date | null;
    decidedBy: { id: string; email: string; name: string | null } | null;
    notes: string | null;
    modifiedToRole: Role | null;
    executedAt: string | Date | null;
    membership: {
        id: string;
        role: Role;
        status: string;
    } | null;
}

/**
 * Step 5a — a CONNECTED_APP subject.
 *
 * These rows were already in the database and already decidable through
 * `/connected-decisions`, and this page rendered none of them: it reads
 * `review.decisions`, which holds MEMBER rows only. So a connected campaign
 * showed an empty subject table — and, because the Close button's gate was
 * `decided !== decisionsTotal`, an empty table meant `0 !== 0`, which is
 * false, which ENABLED Close. A connected campaign could be closed with every
 * one of its subjects undecided, from a page that showed no subjects.
 */
interface ConnectedSnapshot {
    provider?: string;
    email?: string;
    displayName?: string | null;
    isAdmin?: boolean;
    mfaEnrolled?: boolean;
    /**
     * A LEGACY_APP subject's snapshot (`access-review-legacy.ts`) carries the
     * application's own privilege flag instead of `isAdmin`, and no MFA state:
     * a legacy access table does not report one.
     */
    isPrivileged?: boolean | null;
    groups?: unknown;
    connectionId?: string;
    externalUserId?: string;
    /** Read-only HR context, or null when the account is linked to no worker. */
    hr?: {
        employeeId: string;
        fullName: string;
        workEmail: string;
        employmentStatus: string;
        department: string | null;
        jobTitle: string | null;
        managerName: string | null;
        managerEmail: string | null;
        matchMethod: string;
        contradicted: boolean;
    } | null;
}

interface ConnectedDecisionRow {
    id: string;
    subjectRef: string;
    decision: DecisionType | null;
    decidedAt: string | Date | null;
    decidedBy: { id: string; email: string; name: string | null } | null;
    notes: string | null;
    executedAt: string | Date | null;
    /**
     * Prisma types this `JsonValue`, which genuinely admits a string, a number
     * and an array — the column has no schema. Declaring the narrow object
     * shape here and asserting it at the boundary would be a lie the compiler
     * believes; `readSnapshot` narrows instead.
     */
    snapshotJson: unknown;
}

/**
 * Narrow a `snapshotJson` to the shape the table reads, degrading to `{}`.
 *
 * A snapshot that is not a JSON object cannot describe an account, and the
 * columns already have a fallback for every field — the account cell falls back
 * to `subjectRef`, HR renders "no linked worker". So degrading renders a row
 * that is honest about knowing nothing, rather than throwing and taking the
 * whole campaign page down over one malformed row.
 */
function readSnapshot(value: unknown): ConnectedSnapshot {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as ConnectedSnapshot;
    }
    return {};
}

// ─── #3674 — an AGENT campaign's packs, narrowings and sample ──────────

type NarrowingOutcome = 'PENDING' | 'ACCEPTED' | 'REJECTED';
type SampleOutcome = 'PENDING' | 'CONCURRED' | 'DISSENTED' | 'INDETERMINATE';

interface AgentPackRow {
    id: string;
    decisionId: string;
    agentId: string;
    preparedByRunId: string;
    /** The registered agent whose run prepared it — never `agentId` itself — or null when a person did. */
    preparedByAgentId: string | null;
    /** `AGENT_RUN`, or `PERSON_STATIC_SELF_PACK` for the preparer's own pack prepared by a person. */
    preparationBasis: string;
    windowStart: string;
    windowEnd: string;
    sectionsJson: unknown;
    contentHash: string;
    preparedAt: string;
}

interface AgentNarrowingRow {
    id: string;
    decisionId: string;
    packId: string;
    grantId: string;
    toolName: string;
    grantedByUserId: string;
    grantedAt: string;
    basis: string;
    outcome: NarrowingOutcome;
    decidedAt: string | null;
    decidedByUserId: string | null;
    executedAt: string | null;
    executionResult: string | null;
}

interface AgentSampleRow {
    id: string;
    decisionId: string;
    samplingEpoch: string;
    sampledAt: string;
    outcome: SampleOutcome;
    dissentCodes: string[];
    reviewedByUserId: string | null;
    reviewedAt: string | null;
}

interface AgentPacksResponse {
    packs: AgentPackRow[];
    narrowings: AgentNarrowingRow[];
    samples: AgentSampleRow[];
    evidence: {
        fileRecordId: string;
        storedSha256: string | null;
        recomputedSha256: string;
        matches: boolean;
    } | null;
}

/** Mirrors `RECERT_SAMPLE_DISSENT_CODES`; the server refuses any other. */
const RECERT_DISSENT_CODES = [
    'ACCESS_SHOULD_HAVE_BEEN_REVOKED',
    'NARROWING_SHOULD_HAVE_BEEN_ACCEPTED',
    'NARROWING_SHOULD_HAVE_BEEN_REJECTED',
    'DECISION_NOT_SUPPORTED_BY_PACK',
    'OWNERSHIP_OR_REMIT_NOT_QUESTIONED',
] as const;

interface PackSummary {
    grants: number;
    unusedGrants: number;
    harnessLevel: string | null;
    harnessDrift: string | null;
    guardFlags: number;
    breakerTripped: boolean;
    kills: number;
}

/**
 * The few figures the subject table shows from a pack's sections. Degrades to
 * zeros field by field, as `readAgentSubjectSnapshot` does, so one malformed
 * pack cannot take the page down; the hash beside it is what vouches for the
 * stored sections, not this summary.
 */
function readPackSummary(value: unknown): PackSummary {
    const v = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    const grants = Array.isArray(v.grants) ? (v.grants as Array<Record<string, unknown>>) : [];
    const harness = v.harness && typeof v.harness === 'object' ? (v.harness as Record<string, unknown>) : {};
    const flags = v.guardFlags && typeof v.guardFlags === 'object' ? Object.values(v.guardFlags as Record<string, unknown>) : [];
    const breaker = v.breaker && typeof v.breaker === 'object' ? (v.breaker as Record<string, unknown>) : null;
    return {
        grants: grants.length,
        unusedGrants: grants.filter((g) => g.lastCalledAt === null && g.heldForWholeWindow === true).length,
        harnessLevel: typeof harness.level === 'string' ? harness.level : null,
        harnessDrift: typeof harness.drift === 'string' ? harness.drift : null,
        guardFlags: flags.reduce<number>((n, x) => n + (typeof x === 'number' ? x : 0), 0),
        breakerTripped: breaker?.trippedInWindow === true,
        kills: Array.isArray(v.killEngagements) ? v.killEngagements.length : 0,
    };
}

async function postJson(url: string, body?: unknown): Promise<void> {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
        throw new Error(apiErrorMessage(await res.json().catch(() => null), `HTTP ${res.status}`));
    }
}

interface ReviewDetail {
    id: string;
    name: string;
    description: string | null;
    /** Every stored scope, AGENT included (#3674). */
    scope: StoredAccessReviewScope;
    status: Status;
    periodStartAt: string | Date | null;
    periodEndAt: string | Date | null;
    dueAt: string | Date | null;
    closedAt: string | Date | null;
    createdAt: string | Date;
    reviewerUserId: string;
    evidenceFileRecordId: string | null;
    reviewer: { id: string; email: string; name: string | null };
    createdBy: { id: string; email: string; name: string | null };
    closedBy: { id: string; email: string; name: string | null } | null;
    decisions: DecisionRow[];
    connectedDecisions: ConnectedDecisionRow[];
    /** The subject snapshot was cut off at the cap; the campaign covers a prefix. */
    snapshotTruncated: boolean;
    /**
     * #3674 — an AGENT campaign's subjects were withheld from this viewer: they
     * are register data, readable by the campaign's reviewer and by holders of
     * `admin.agent_registry`. Optional because only an AGENT campaign sets it.
     */
    subjectsRestricted?: boolean;
    lastActivityByUser: Record<string, string | Date>;
}

interface Props {
    tenantSlug: string;
    initialReview: ReviewDetail;
    currentUserId: string;
    isAdmin: boolean;
}

const STATUS_VARIANT: Record<Status, 'warning' | 'info' | 'success'> = {
    OPEN: 'warning',
    IN_REVIEW: 'info',
    CLOSED: 'success',
};

const DECISION_VARIANT: Record<DecisionType, 'success' | 'error' | 'warning'> = {
    CONFIRM: 'success',
    REVOKE: 'error',
    MODIFY: 'warning',
};

export function AccessReviewDetailClient({
    tenantSlug,
    initialReview,
    currentUserId,
    isAdmin,
}: Props) {
    const t = useTranslations('accessReviews');
    const { mutate: swrMutate } = useSWRConfig();
    const router = useRouter();
    const apiBase = `/api/t/${tenantSlug}/access-reviews/${initialReview.id}`;

    const reviewQuery = useTenantSWR<ReviewDetail>(
        CACHE_KEYS.accessReviews.detail(initialReview.id),
        { fallbackData: initialReview },
    );
    const review = reviewQuery.data!;

    const isReviewer = currentUserId === review.reviewerUserId;
    // #3674 — an AGENT campaign is decided and closed by the agent flow, under
    // rules the page mirrors below (the owner may not decide their own agent; a
    // subject waits for its pack and its narrowings). While the brake
    // (`AGENT_CAMPAIGNS_IMPLEMENTED`) is on the page is read-only, matching the
    // server, which refuses every act by name — showing a control that always
    // fails is worse than showing none.
    const isAgent = review.scope === 'AGENT';
    const agentActionsAvailable = !isAgent || AGENT_CAMPAIGNS_IMPLEMENTED;
    const canDecide = (isReviewer || isAdmin) && review.status !== 'CLOSED' && agentActionsAvailable;
    const canClose = isAdmin && review.status !== 'CLOSED' && agentActionsAvailable;

    // #107 READ side. The register publishes what it rendered; the fallback
    // to the list cache is left ENABLED here (a real `listKey`, not the
    // null-key shape) because this list endpoint is a genuine SWR resource in
    // the `CappedList` shape the hook already unwraps — so a campaign opened
    // by deep link or from a notification still gets server order, which for
    // an unfiltered, unsorted register is the same order the page shows.
    //
    // `accessReview` IS in the `ui.recordStepper` catalog (en + bg), so the
    // tooltips read the real phrase rather than the generic record one.
    const reviewIds = useEntityListIds(CACHE_KEYS.accessReviews.list());

    const [undoTarget, setUndoTarget] = useState<DecisionRow | null>(null);
    const [activeDecision, setActiveDecision] = useState<{
        row: DecisionRow;
        type: DecisionType;
    } | null>(null);
    const [closing, setClosing] = useState(false);
    const [connectedError, setConnectedError] = useState<string | null>(null);

    // ─── Progress over the subjects this campaign ACTUALLY has ──────────
    //
    // A campaign is one scope or the other, so exactly one of these two lists
    // is populated. Counting over both means the progress figure, the progress
    // bar and the Close gate all describe the same population, whichever scope
    // the campaign is — rather than describing member rows and silently
    // reporting 0/0 for a connected one.
    //
    // Which table holds the subjects is `SUBJECT_TABLE`'s answer, not a
    // comparison against one scope. It was `scope === 'CONNECTED_APP'`, so a
    // LEGACY_APP campaign — whose subjects are connected-decision rows keyed
    // `connectionId:accountKey` — fell through to the member roster, which is
    // always empty for it, and its detail page showed no subjects (#3716). An
    // AGENT campaign is CONNECTED too and is branched on first, below.
    const isConnected = subjectTableOf(review.scope) === 'CONNECTED';
    const isLegacy = review.scope === 'LEGACY_APP';
    const connectedRows = useMemo(() => review.connectedDecisions ?? [], [review.connectedDecisions]);
    const subjectCount = review.decisions.length + connectedRows.length;
    const decided =
        review.decisions.filter((d) => d.decision !== null).length +
        connectedRows.filter((d) => d.decision !== null).length;
    const decisionsTotal = subjectCount;
    const pct = subjectCount === 0 ? 0 : Math.round((decided / subjectCount) * 100);
    // ZERO IS NOT COMPLETE. `decided !== subjectCount` is false when both are
    // zero, so the old gate enabled Close on a campaign with no subjects at
    // all. A review over zero subjects evidences nothing, and the usecase now
    // refuses it too — this is the same rule stated where the operator sees it,
    // so the button is disabled rather than failing on press.
    const everySubjectDecided = subjectCount > 0 && decided === subjectCount;

    // ─── #3674 — the AGENT campaign's packs, narrowings and sample ──────
    //
    // Read only by somebody the server will answer: the packs are register
    // data, narrowed to the reviewer or a holder of `admin.agent_registry`,
    // and a withheld campaign (`subjectsRestricted`) would only fetch a 403.
    const packsQuery = useTenantSWR<AgentPacksResponse>(
        isAgent && !review.subjectsRestricted ? `/access-reviews/${review.id}/agent-packs` : null,
    );
    const packs = useMemo(() => packsQuery.data?.packs ?? [], [packsQuery.data]);
    const narrowings = useMemo(() => packsQuery.data?.narrowings ?? [], [packsQuery.data]);
    const samples = useMemo(() => packsQuery.data?.samples ?? [], [packsQuery.data]);
    const packByDecision = useMemo(() => new Map(packs.map((p) => [p.decisionId, p])), [packs]);
    const pendingByDecision = useMemo(() => {
        const m = new Map<string, number>();
        for (const n of narrowings) if (n.outcome === 'PENDING') m.set(n.decisionId, (m.get(n.decisionId) ?? 0) + 1);
        return m;
    }, [narrowings]);
    const pendingNarrowings = narrowings.filter((n) => n.outcome === 'PENDING').length;
    const agentRowById = useMemo(() => new Map(connectedRows.map((r) => [r.id, r])), [connectedRows]);
    // Every preparing agent is ACTIVE, so it is a subject too: its name is in a snapshot.
    const agentNameByAgentId = useMemo(() => {
        const m = new Map<string, string>();
        for (const r of connectedRows) {
            const snap = readAgentSubjectSnapshot(r.snapshotJson);
            if (snap) m.set(snap.agentId, snap.agentName ?? snap.agentId);
        }
        return m;
    }, [connectedRows]);
    /** The agent's frozen owner, from the subject's snapshot. */
    const ownerOf = useCallback(
        (decisionId: string): string | null =>
            readAgentSubjectSnapshot(agentRowById.get(decisionId)?.snapshotJson)?.ownerUserId ?? null,
        [agentRowById],
    );
    // An AGENT campaign closes only with every pack prepared and every
    // narrowing decided as well — the server's rule, stated where it is pressed.
    const agentCloseReady = !isAgent || (packs.length === subjectCount && pendingNarrowings === 0);
    const [agentBusy, setAgentBusy] = useState(false);

    const mutateReview = reviewQuery.mutate;
    const mutatePacks = packsQuery.mutate;
    const agentAct = useCallback(async (url: string, body?: unknown) => {
        setAgentBusy(true);
        setConnectedError(null);
        try {
            await postJson(url, body);
            await Promise.all([mutateReview(), mutatePacks()]);
            void swrMutate(CACHE_KEYS.accessReviews.list());
        } catch (err) {
            setConnectedError(err instanceof Error ? err.message : t('unknownError'));
        } finally {
            setAgentBusy(false);
        }
    }, [mutateReview, mutatePacks, swrMutate, t]);

    const decisionColumns = useMemo(
        () => createColumns<DecisionRow>([
            {
                id: 'subject',
                header: t('colSubject'),
                cell: ({ row }) => (
                    <div data-testid={`decision-row-${row.original.id}`}>
                        <div className="font-medium text-content-default">
                            {row.original.subjectUser.name || '—'}
                        </div>
                        <div className="text-xs text-content-muted">
                            {row.original.subjectUser.email}
                        </div>
                    </div>
                ),
            },
            {
                id: 'snapshotRole',
                header: t('colSnapshotRole'),
                cell: ({ row }) => (
                    <span className="text-sm">{row.original.snapshotRole}</span>
                ),
            },
            {
                id: 'liveRole',
                header: t('colLiveRole'),
                cell: ({ row }) =>
                    row.original.membership ? (
                        <span className="text-sm">{row.original.membership.role}</span>
                    ) : (
                        <span className="text-sm text-content-muted italic">{t('deleted')}</span>
                    ),
            },
            {
                id: 'lastActive',
                header: t('colLastActive'),
                cell: ({ row }) => {
                    const lastActiveAt =
                        review.lastActivityByUser[row.original.subjectUserId] ?? null;
                    return (
                        <span className="text-sm text-content-muted">
                            {lastActiveAt ? formatDate(lastActiveAt) : t('never')}
                        </span>
                    );
                },
            },
            {
                id: 'decision',
                header: t('colDecision'),
                cell: ({ row }) => {
                    const d = row.original;
                    if (d.decision) {
                        return (
                            <div className="flex items-center gap-tight">
                                <StatusBadge variant={DECISION_VARIANT[d.decision]}>
                                    {d.decision}
                                    {d.decision === 'MODIFY' && d.modifiedToRole
                                        ? ` → ${d.modifiedToRole}`
                                        : ''}
                                </StatusBadge>
                                {/*
                                  UNDO, NOT "REVOKE" (#3269). `REVOKE` is one of the
                                  three VERDICTS and it is rendered in the badge
                                  immediately to the left of this control — it means
                                  "take this person's access away". The usecase behind
                                  this button is `revokeDecision`, which means "unwind
                                  the verdict I recorded". A control labelled Revoke
                                  sitting beside a REVOKE badge would invite exactly
                                  the wrong click on exactly the row where it is
                                  hardest to undo.

                                  Hidden once executed, matching the usecase's own gate:
                                  a closeout-executed row is an evidentiary fact and
                                  `revokeDecision` refuses it. Showing a control that
                                  always fails is worse than showing none.
                                */}
                                {canDecide && !d.executedAt ? (
                                    <button
                                        type="button"
                                        className="text-xs text-content-muted underline hover:text-content"
                                        data-testid={`undo-decision-${d.id}`}
                                        onClick={() => setUndoTarget(d)}
                                    >
                                        {t('undoVerdict')}
                                    </button>
                                ) : null}
                            </div>
                        );
                    }
                    if (canDecide) {
                        return (
                            <select
                                className="input"
                                defaultValue=""
                                data-testid={`decision-select-${d.id}`}
                                onChange={(e) => {
                                    const v = e.target.value as DecisionType | '';
                                    if (v) setActiveDecision({ row: d, type: v });
                                    e.target.value = '';
                                }}
                            >
                                <option value="" disabled>{t('decidePrompt')}</option>
                                <option value="CONFIRM">{t('confirmAccess')}</option>
                                <option value="REVOKE">{t('revokeAccess')}</option>
                                <option value="MODIFY">{t('modifyRole')}</option>
                            </select>
                        );
                    }
                    return (
                        <span className="text-xs text-content-muted">{t('pending')}</span>
                    );
                },
            },
        ]),
        [canDecide, review.lastActivityByUser, t],
    );


    /**
     * Record a verdict on a connected subject.
     *
     * Posted straight from the row rather than through a modal: unlike the
     * member MODIFY path there is no target role to collect — a directory
     * account has no tenant role, and MODIFY here means "adjust this account
     * in the identity provider", which `closeConnectedAccessReview` turns into
     * a remediation task. Nothing to ask, so nothing to ask it with.
     */
    const submitConnected = async (decisionId: string, decision: DecisionType) => {
        setConnectedError(null);
        try {
            const res = await fetch(`${apiBase}/connected-decisions/${decisionId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ decision }),
            });
            if (!res.ok) {
                throw new Error((await res.text()) || t('submitFailed'));
            }
            await reviewQuery.mutate();
            void swrMutate(CACHE_KEYS.accessReviews.list());
        } catch (err) {
            setConnectedError(err instanceof Error ? err.message : t('unknownError'));
        }
    };

    // ─── Step 5a — the CONNECTED_APP subject table ──────────────────────
    //
    // Deliberately a SEPARATE column set rather than a widened `DecisionRow`:
    // a directory account and a tenant membership share almost no columns. The
    // member table shows snapshot role vs LIVE role and last activity in the
    // product; a directory account has no membership to compare against and no
    // product activity. What a reviewer needs instead is who the account
    // belongs to according to HR, whether MFA is on, and whether the HR link
    // is still believed.
    const connectedColumns = useMemo(
        () => createColumns<ConnectedDecisionRow>([
            {
                id: 'account',
                header: t('colAccount'),
                cell: ({ row }) => {
                    const snap = readSnapshot(row.original.snapshotJson);
                    return (
                        <div data-testid={`connected-row-${row.original.id}`}>
                            <div className="font-medium text-content-default">
                                {snap.displayName || snap.email || row.original.subjectRef}
                            </div>
                            <div className="text-xs text-content-muted">
                                {snap.email ?? row.original.subjectRef}
                                {snap.provider ? ` · ${snap.provider}` : ''}
                            </div>
                        </div>
                    );
                },
            },
            {
                id: 'directoryPosture',
                header: t('colSnapshotRole'),
                cell: ({ row }) => {
                    const snap = readSnapshot(row.original.snapshotJson);
                    // A legacy subject is an APPLICATION account: it has a
                    // privilege flag and no directory role, and its source
                    // reports no MFA. Rendering it through the directory
                    // branch would print "MFA not enrolled" on every row — a
                    // finding the snapshot never made. A privilege flag the
                    // application did not report renders as unknown, not as
                    // "standard": absence is not evidence of either.
                    if (isLegacy) {
                        return (
                            <div className="text-sm">
                                {snap.isPrivileged === true
                                    ? t('appPrivileged')
                                    : snap.isPrivileged === false
                                      ? t('appStandard')
                                      : <span className="text-content-muted">—</span>}
                            </div>
                        );
                    }
                    return (
                        <div className="text-sm">
                            <div>{snap.isAdmin ? t('directoryAdmin') : t('directoryUser')}</div>
                            {typeof snap.mfaEnrolled === 'boolean' ? (
                                <div className="text-xs text-content-muted">
                                    {snap.mfaEnrolled ? t('mfaEnrolled') : t('mfaMissing')}
                                </div>
                            ) : null}
                        </div>
                    );
                },
            },
            {
                id: 'hr',
                header: t('colHrContext'),
                cell: ({ row }) => {
                    const hr = readSnapshot(row.original.snapshotJson).hr ?? null;
                    if (!hr) {
                        // An unlinked account is a REVIEWABLE fact, not missing
                        // data: it is a service account, a contractor the HR
                        // feed does not carry, or an unreconciled one. Saying
                        // "—" would read as "we did not look".
                        return (
                            <span className="text-xs text-content-muted italic">
                                {t('hrUnlinked')}
                            </span>
                        );
                    }
                    return (
                        <div className="text-sm">
                            <div>{hr.fullName}</div>
                            <div className="text-xs text-content-muted">
                                {hr.employmentStatus}
                                {hr.department ? ` · ${hr.department}` : ''}
                            </div>
                            {hr.managerName ? (
                                <div className="text-xs text-content-muted">
                                    {t('hrManager', { name: hr.managerName })}
                                </div>
                            ) : null}
                            {hr.contradicted ? (
                                <div className="text-xs font-medium text-content-warning">
                                    {t('hrContradicted')}
                                </div>
                            ) : null}
                        </div>
                    );
                },
            },
            {
                id: 'decision',
                header: t('colDecision'),
                cell: ({ row }) => {
                    const d = row.original;
                    if (d.decision) {
                        return (
                            <StatusBadge variant={DECISION_VARIANT[d.decision]}>
                                {d.decision}
                            </StatusBadge>
                        );
                    }
                    if (canDecide) {
                        return (
                            <select
                                className="input"
                                defaultValue=""
                                data-testid={`connected-decision-select-${d.id}`}
                                onChange={(e) => {
                                    const v = e.target.value as DecisionType | '';
                                    if (v) void submitConnected(d.id, v);
                                    e.target.value = '';
                                }}
                            >
                                <option value="" disabled>{t('decidePrompt')}</option>
                                <option value="CONFIRM">{t('confirmAccess')}</option>
                                <option value="REVOKE">{t('revokeAccess')}</option>
                                <option value="MODIFY">{t('modifyRole')}</option>
                            </select>
                        );
                    }
                    return (
                        <span className="text-xs text-content-muted">{t('pending')}</span>
                    );
                },
            },
        ]),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [canDecide, isLegacy, t],
    );

    // ─── #3674 — the AGENT subject table ──────────────────────────────
    //
    // A SEPARATE column set, for the reason the connected table is separate:
    // an agent shares no columns with a membership or a directory account.
    // What a reviewer recertifies is who owns the agent and what it is
    // granted. A row whose subject was withheld (`subjectsRestricted`) renders
    // as restricted rather than as an agent with no name.
    const agentColumns = useMemo(
        () => createColumns<ConnectedDecisionRow>([
            {
                id: 'agent',
                header: t('colAgent'),
                cell: ({ row }) => {
                    const snap = readAgentSubjectSnapshot(row.original.snapshotJson);
                    return (
                        <div data-testid={`agent-row-${row.original.id}`}>
                            <div className="font-medium text-content-default">
                                {snap ? (snap.agentName ?? snap.agentId) : t('agentRestricted')}
                            </div>
                            {snap?.agentStatus ? (
                                <div className="text-xs text-content-muted">{snap.agentStatus}</div>
                            ) : null}
                        </div>
                    );
                },
            },
            {
                id: 'owner',
                header: t('colAgentOwner'),
                cell: ({ row }) => {
                    const snap = readAgentSubjectSnapshot(row.original.snapshotJson);
                    return (
                        <span className="text-sm">
                            {snap?.ownerEmail ?? '—'}
                        </span>
                    );
                },
            },
            {
                id: 'grants',
                header: t('colAgentGrants'),
                cell: ({ row }) => {
                    const snap = readAgentSubjectSnapshot(row.original.snapshotJson);
                    return (
                        <span className="text-sm">
                            {snap?.grantCount ?? '—'}
                        </span>
                    );
                },
            },
            {
                id: 'pack',
                header: t('colAgentPack'),
                cell: ({ row }) => {
                    const pack = packByDecision.get(row.original.id);
                    if (!pack) {
                        return <span className="text-xs text-content-muted">{t('agentPackMissing')}</span>;
                    }
                    const sum = readPackSummary(pack.sectionsJson);
                    return (
                        <div className="text-xs" data-testid={`agent-pack-${row.original.id}`}>
                            <div>{t('agentPackUnused', { unused: sum.unusedGrants, total: sum.grants })}</div>
                            <div className="text-content-muted">
                                {t('agentPackHarness', { level: sum.harnessLevel ?? '—', drift: sum.harnessDrift ?? '—' })}
                                {sum.guardFlags > 0 ? ` · ${t('agentPackGuardFlags', { count: sum.guardFlags })}` : ''}
                                {sum.breakerTripped ? ` · ${t('agentPackBreakerTripped')}` : ''}
                                {sum.kills > 0 ? ` · ${t('agentPackKills', { count: sum.kills })}` : ''}
                            </div>
                            <div className="text-content-muted" data-testid={`agent-pack-prepared-by-${row.original.id}`}>
                                {pack.preparedByAgentId
                                    ? t('agentPackPreparedBy', { agent: agentNameByAgentId.get(pack.preparedByAgentId) ?? pack.preparedByAgentId })
                                    : t('agentPackPreparedByPerson')}
                            </div>
                            <div className="font-mono text-content-muted">
                                {pack.contentHash.slice(0, 19)}…
                            </div>
                        </div>
                    );
                },
            },
            {
                id: 'decision',
                header: t('colDecision'),
                cell: ({ row }) => {
                    const d = row.original;
                    if (d.decision) {
                        return (
                            <StatusBadge variant={DECISION_VARIANT[d.decision]}>
                                {d.decision}
                            </StatusBadge>
                        );
                    }
                    if (!canDecide) {
                        return <span className="text-xs text-content-muted">{t('pending')}</span>;
                    }
                    // The server refuses each of these; saying so here means the
                    // reviewer is not offered a control that always fails.
                    if (ownerOf(d.id) === currentUserId) {
                        return (
                            <span className="text-xs text-content-muted" data-testid={`agent-owner-cannot-decide-${d.id}`}>
                                {t('agentOwnerCannotDecide')}
                            </span>
                        );
                    }
                    if (!packByDecision.has(d.id)) {
                        return <span className="text-xs text-content-muted">{t('agentPackMissing')}</span>;
                    }
                    const pending = pendingByDecision.get(d.id) ?? 0;
                    if (pending > 0) {
                        return (
                            <span className="text-xs text-content-muted" data-testid={`agent-narrowings-first-${d.id}`}>
                                {t('agentNarrowingsFirst', { count: pending })}
                            </span>
                        );
                    }
                    return (
                        <select
                            className="input"
                            defaultValue=""
                            disabled={agentBusy}
                            data-testid={`agent-decision-select-${d.id}`}
                            onChange={(e) => {
                                const v = e.target.value as DecisionType | '';
                                e.target.value = '';
                                if (v) void agentAct(`${apiBase}/connected-decisions/${d.id}`, { decision: v });
                            }}
                        >
                            <option value="" disabled>{t('decidePrompt')}</option>
                            <option value="CONFIRM">{t('agentConfirm')}</option>
                            <option value="REVOKE">{t('agentRevoke')}</option>
                            <option value="MODIFY">{t('agentModify')}</option>
                        </select>
                    );
                },
            },
        ]),
        [t, packByDecision, pendingByDecision, canDecide, currentUserId, agentBusy, ownerOf, agentAct, apiBase, agentNameByAgentId],
    );

    const agentNameOf = useCallback((decisionId: string): string => {
        const snap = readAgentSubjectSnapshot(agentRowById.get(decisionId)?.snapshotJson);
        return snap ? (snap.agentName ?? snap.agentId) : t('agentRestricted');
    }, [agentRowById, t]);

    const narrowingColumns = useMemo(
        () => createColumns<AgentNarrowingRow>([
            {
                id: 'agent',
                header: t('colAgent'),
                cell: ({ row }) => <span className="text-sm">{agentNameOf(row.original.decisionId)}</span>,
            },
            {
                id: 'tool',
                header: t('colNarrowingTool'),
                cell: ({ row }) => (
                    <div data-testid={`agent-narrowing-${row.original.id}`}>
                        <div className="font-mono text-sm">{row.original.toolName}</div>
                        <div className="text-xs text-content-muted">
                            {t('narrowingGranted', { date: formatDate(row.original.grantedAt) })}
                        </div>
                    </div>
                ),
            },
            {
                id: 'basis',
                header: t('colNarrowingBasis'),
                cell: () => <span className="text-xs text-content-muted">{t('narrowingBasisUnused')}</span>,
            },
            {
                id: 'outcome',
                header: t('colDecision'),
                cell: ({ row }) => {
                    const n = row.original;
                    if (n.outcome !== 'PENDING') {
                        // Plain text, not a badge: the subject's verdict is the
                        // row's one loud status.
                        return (
                            <span className="text-sm font-medium">
                                {n.outcome === 'ACCEPTED' ? t('narrowingAccepted') : t('narrowingRejected')}
                            </span>
                        );
                    }
                    if (!canDecide || ownerOf(n.decisionId) === currentUserId) {
                        return <span className="text-xs text-content-muted">{t('pending')}</span>;
                    }
                    return (
                        <div className="flex gap-tight">
                            <Button
                                size="sm"
                                variant="secondary"
                                disabled={agentBusy}
                                data-testid={`agent-narrowing-accept-${n.id}`}
                                onClick={() => void agentAct(`${apiBase}/agent-narrowings/${n.id}`, { outcome: 'ACCEPT' })}
                            >{t('narrowingAccept')}</Button>
                            <Button
                                size="sm"
                                variant="secondary"
                                disabled={agentBusy}
                                data-testid={`agent-narrowing-reject-${n.id}`}
                                onClick={() => void agentAct(`${apiBase}/agent-narrowings/${n.id}`, { outcome: 'REJECT' })}
                            >{t('narrowingReject')}</Button>
                        </div>
                    );
                },
            },
        ]),
        [t, canDecide, currentUserId, agentBusy, agentNameOf, ownerOf, agentAct, apiBase],
    );

    const sampleColumns = useMemo(
        () => createColumns<AgentSampleRow>([
            {
                id: 'agent',
                header: t('colAgent'),
                cell: ({ row }) => (
                    <span className="text-sm" data-testid={`agent-sample-${row.original.id}`}>
                        {agentNameOf(row.original.decisionId)}
                    </span>
                ),
            },
            {
                id: 'decision',
                header: t('colSampleDecision'),
                cell: ({ row }) => {
                    const decision = agentRowById.get(row.original.decisionId)?.decision ?? null;
                    return <span className="text-sm">{decision ?? '—'}</span>;
                },
            },
            {
                id: 'outcome',
                header: t('colSampleOutcome'),
                cell: ({ row }) => {
                    const sample = row.original;
                    if (sample.outcome !== 'PENDING') {
                        return (
                            <span className="text-sm">
                                {t(`sampleOutcome.${sample.outcome}`)}
                                {sample.dissentCodes.length ? ` — ${sample.dissentCodes.map((c) => t(`dissentCodes.${c}`)).join(', ')}` : ''}
                            </span>
                        );
                    }
                    const first = agentRowById.get(sample.decisionId)?.decidedBy?.id ?? null;
                    // The second human is neither the first nor the agent's owner.
                    if (first === currentUserId || ownerOf(sample.decisionId) === currentUserId) {
                        return <span className="text-xs text-content-muted">{t('sampleNotYours')}</span>;
                    }
                    if (!(isReviewer || isAdmin)) {
                        return <span className="text-xs text-content-muted">{t('pending')}</span>;
                    }
                    const url = `${apiBase}/agent-samples/${sample.id}`;
                    return (
                        <div className="flex flex-wrap gap-tight">
                            <Button
                                size="sm"
                                variant="secondary"
                                disabled={agentBusy}
                                data-testid={`agent-sample-concur-${sample.id}`}
                                onClick={() => void agentAct(url, { outcome: 'CONCURRED' })}
                            >{t('sampleConcur')}</Button>
                            <Button
                                size="sm"
                                variant="secondary"
                                disabled={agentBusy}
                                onClick={() => void agentAct(url, { outcome: 'INDETERMINATE' })}
                            >{t('sampleIndeterminate')}</Button>
                            <select
                                className="input"
                                defaultValue=""
                                disabled={agentBusy}
                                aria-label={t('sampleDissent')}
                                data-testid={`agent-sample-dissent-${sample.id}`}
                                onChange={(e) => {
                                    const code = e.target.value;
                                    e.target.value = '';
                                    if (code) void agentAct(url, { outcome: 'DISSENTED', dissentCodes: [code] });
                                }}
                            >
                                <option value="" disabled>{t('sampleDissent')}</option>
                                {RECERT_DISSENT_CODES.map((c) => (
                                    <option key={c} value={c}>{t(`dissentCodes.${c}`)}</option>
                                ))}
                            </select>
                        </div>
                    );
                },
            },
        ]),
        [t, currentUserId, isReviewer, isAdmin, agentBusy, agentRowById, agentNameOf, ownerOf, agentAct, apiBase],
    );

    return (
        <EntityDetailLayout
            id="access-review-detail-page"
            back={{ smart: true }}
            prevNext={{
                ids: reviewIds,
                currentId: review.id,
                hrefFor: (id) => `/t/${tenantSlug}/access-reviews/${id}`,
                labelSingular: 'accessReview',
            }}
            breadcrumbs={[
                { label: t('crumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                { label: t('crumbList'), href: `/t/${tenantSlug}/access-reviews` },
                { label: review.name },
            ]}
            title={<span data-testid="access-review-detail-title">{review.name}</span>}
            meta={
                <MetaStrip
                    items={[
                        {
                            kind: 'status',
                            label: t('metaStatus'),
                            value: review.status,
                            variant:
                                STATUS_VARIANT[review.status] ?? 'neutral',
                        },
                    ]}
                />
            }
            actions={
                <div className="flex flex-col items-end gap-tight">
                    <div className="flex items-center gap-tight">
                        <ProgressBar
                            value={pct}
                            variant={pct >= 100 ? 'success' : pct >= 50 ? 'info' : 'brand'}
                            aria-label={t('decisionsAria', { decided, total: decisionsTotal })}
                            className="w-full sm:w-48"
                        />
                        <span className="text-xs text-content-muted whitespace-nowrap">
                            {decided}/{decisionsTotal}
                        </span>
                    </div>
                    <div className="flex gap-tight">
                        {review.evidenceFileRecordId ? (
                            <Button
                                variant="secondary"
                                onClick={() =>
                                    window.open(`${apiBase}/evidence`, '_blank')
                                }
                                data-testid="access-review-download-evidence"
                            >{t('downloadEvidence')}</Button>
                        ) : null}
                        {canClose ? (
                            <Button
                                onClick={() => setClosing(true)}
                                disabled={!everySubjectDecided || !agentCloseReady}
                                data-testid="access-review-close-button"
                            >{t('closeCampaign')}</Button>
                        ) : null}
                    </div>
                </div>
            }
        >
            {/* Description + meta data list — preserved as the first body
                element since EntityDetailLayout's `meta` prop is sized
                for inline badges, not multi-row metadata. */}
            <div className="space-y-tight">
                {review.description ? (
                    <p className="text-sm text-content-muted max-w-prose">
                        {review.description}
                    </p>
                ) : null}
                <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-content-muted">
                    <div>
                        <dt className="font-semibold uppercase">{t('dlReviewer')}</dt>
                        <dd>{review.reviewer.email}</dd>
                    </div>
                    <div>
                        <dt className="font-semibold uppercase">{t('dlScope')}</dt>
                        <dd data-testid="access-review-scope">{t(`scopeLabels.${scopeLabelKey(review.scope)}`)}</dd>
                    </div>
                    <div>
                        <dt className="font-semibold uppercase">{t('dlDue')}</dt>
                        <dd>{review.dueAt ? formatDate(review.dueAt) : '—'}</dd>
                    </div>
                    {review.closedAt ? (
                        <div>
                            <dt className="font-semibold uppercase">{t('dlClosed')}</dt>
                            <dd>{formatDateTime(review.closedAt)}</dd>
                        </div>
                    ) : null}
                </dl>
            </div>

            {/* Step 5a — a campaign that covers a PREFIX of the directory must
                say so on the page an operator closes it from, not only in the
                audit log they read afterwards. */}
            {review.snapshotTruncated ? (
                <div
                    role="alert"
                    data-testid="access-review-snapshot-truncated"
                    className="rounded-md border border-border-warning bg-bg-warning p-3 text-sm text-content-warning"
                >
                    <strong className="font-semibold">{t('truncatedTitle')}</strong>{' '}
                    {t('truncatedBody', { count: subjectCount })}
                </div>
            ) : null}

            {/* Roster — DataTable. Connected campaigns render their OWN
                subjects: `review.decisions` is empty for them, and showing an
                empty roster beside a live Close button was the whole defect. */}
            {connectedError ? (
                <div
                    role="alert"
                    data-testid="connected-decision-error"
                    className="rounded-md border border-border-error bg-bg-error p-3 text-sm text-content-error"
                >
                    {connectedError}
                </div>
            ) : null}

            {isAgent && !AGENT_CAMPAIGNS_IMPLEMENTED ? (
                <div
                    role="status"
                    data-testid="access-review-agent-read-only"
                    className="rounded-md border border-border-subtle bg-bg-muted p-3 text-sm text-content-muted"
                >
                    {t('agentReadOnlyNotice')}
                </div>
            ) : null}
            {isAgent && review.subjectsRestricted ? (
                <div
                    role="status"
                    data-testid="access-review-agent-subjects-restricted"
                    className="rounded-md border border-border-subtle bg-bg-muted p-3 text-sm text-content-muted"
                >
                    {t('agentSubjectsRestricted')}
                </div>
            ) : null}

            {isAgent && isAdmin && review.status === 'OPEN' && !review.subjectsRestricted
                && packsQuery.data && packs.length === 0 ? (
                <div
                    role="status"
                    data-testid="access-review-agent-packs-missing"
                    className="flex items-center justify-between gap-default rounded-md border border-border-subtle bg-bg-muted p-3 text-sm"
                >
                    <span className="text-content-muted">{t('agentPacksMissingNotice')}</span>
                    <Button
                        variant="secondary"
                        disabled={agentBusy}
                        onClick={() => void agentAct(`${apiBase}/agent-packs`)}
                        data-testid="access-review-agent-prepare-packs"
                    >{agentBusy ? t('agentPreparing') : t('agentPreparePacks')}</Button>
                </div>
            ) : null}

            {isAgent && packsQuery.data?.evidence ? (
                <div
                    role="status"
                    data-testid="access-review-agent-evidence-hash"
                    data-matches={packsQuery.data.evidence.matches ? 'true' : 'false'}
                    className={packsQuery.data.evidence.matches
                        ? 'rounded-md border border-border-subtle bg-bg-muted p-3 text-xs text-content-muted'
                        : 'rounded-md border border-border-error bg-bg-error p-3 text-xs text-content-error'}
                >
                    {packsQuery.data.evidence.matches ? t('agentEvidenceMatches') : t('agentEvidenceMismatch')}{' '}
                    <span className="font-mono">{packsQuery.data.evidence.recomputedSha256}</span>
                </div>
            ) : null}

            {isAgent ? (
                <DataTable
                    data={connectedRows}
                    columns={agentColumns}
                    getRowId={(d) => d.id}
                    emptyState={t('rosterEmpty')}
                    resourceName={(p) => (p ? 'agents' : 'agent')}
                    data-testid="access-review-agent-table"
                />
            ) : isConnected ? (
                <DataTable
                    data={connectedRows}
                    columns={connectedColumns}
                    getRowId={(d) => d.id}
                    emptyState={t('rosterEmpty')}
                    resourceName={(p) => (p ? 'accounts' : 'account')}
                    data-testid="access-review-connected-table"
                />
            ) : (
                <DataTable
                    data={review.decisions}
                    columns={decisionColumns}
                    getRowId={(d) => d.id}
                    emptyState={t('rosterEmpty')}
                    resourceName={(p) => (p ? 'subjects' : 'subject')}
                    data-testid="access-review-roster-table"
                />
            )}

            {/* #3674 — what each pack proposes to remove, and the person's
                answer. Accepting deletes the grant; nothing here can add one. */}
            {isAgent && narrowings.length > 0 ? (
                <section className="space-y-tight" aria-labelledby="access-review-agent-narrowings-heading">
                    <Heading level={3} id="access-review-agent-narrowings-heading">
                        {t('agentNarrowingsTitle')}
                    </Heading>
                    <p className="text-xs text-content-muted max-w-prose">{t('agentNarrowingsHint')}</p>
                    <DataTable
                        data={narrowings}
                        columns={narrowingColumns}
                        getRowId={(n) => n.id}
                        emptyState={t('rosterEmpty')}
                        resourceName={(p) => (p ? 'narrowings' : 'narrowing')}
                        data-testid="access-review-agent-narrowings-table"
                    />
                </section>
            ) : null}

            {/* #3674 — the decisions drawn at close for a second human. */}
            {isAgent && samples.length > 0 ? (
                <section className="space-y-tight" aria-labelledby="access-review-agent-sample-heading">
                    <Heading level={3} id="access-review-agent-sample-heading">
                        {t('agentSampleTitle')}
                    </Heading>
                    <p className="text-xs text-content-muted max-w-prose">{t('agentSampleHint')}</p>
                    <DataTable
                        data={samples}
                        columns={sampleColumns}
                        getRowId={(x) => x.id}
                        emptyState={t('rosterEmpty')}
                        resourceName={(p) => (p ? 'samples' : 'sample')}
                        data-testid="access-review-agent-sample-table"
                    />
                </section>
            ) : null}

            {activeDecision ? (
                <DecisionDialog
                    apiBase={apiBase}
                    decision={activeDecision}
                    onClose={() => setActiveDecision(null)}
                    onSuccess={() => {
                        setActiveDecision(null);
                        reviewQuery.mutate();
                    }}
                />
            ) : null}

            {undoTarget ? (
                <UndoVerdictDialog
                    apiBase={apiBase}
                    row={undoTarget}
                    onClose={() => setUndoTarget(null)}
                    onSuccess={() => {
                        setUndoTarget(null);
                        reviewQuery.mutate();
                    }}
                />
            ) : null}

            {closing ? (
                <CloseDialog
                    apiBase={apiBase}
                    onClose={() => setClosing(false)}
                    onSuccess={() => {
                        setClosing(false);
                        reviewQuery.mutate();
                        // List page sees the new CLOSED state too.
                        swrMutate(
                            `/api/t/${tenantSlug}${CACHE_KEYS.accessReviews.list()}`,
                        );
                        router.refresh();
                    }}
                />
            ) : null}
        </EntityDetailLayout>
    );
}

// ─── Decision dialog ─────────────────────────────────────────────────

/**
 * Unwind a recorded verdict (#3269).
 *
 * `reason` is REQUIRED — 3..2000 characters, enforced by `RevokeDecisionSchema`
 * at the route. That is not form ceremony: the reason is the whole content of
 * the `ACCESS_REVIEW_DECISION_REVOKED` audit row, which exists so an auditor
 * reviewing a campaign can see which verdicts were unwound and why. A revoke
 * with no reason would leave the trail saying only that something changed.
 *
 * So the submit button is disabled below the minimum rather than letting the
 * route reject it: the reviewer finds out while they are still typing instead of
 * after a round trip.
 *
 * `variant="destructive"`, and that is a claim about the action rather than a
 * way around the primary-button ceiling. `revokeDecision` nulls `decision`,
 * `notes`, `decidedAt`, `decidedByUserId` and `modifiedToRole`: a reviewer's
 * recorded work is erased and the audit row is its only remaining trace. There
 * is no un-discard — the verdict has to be recorded again from scratch.
 *
 * It also has to be primary or destructive and cannot be secondary:
 * `modal-action-order` requires the LAST button in a footer to be one of those,
 * so the hand learns one direction across every dialog. Destructive is the
 * accurate half of that pair here.
 *
 * "DISCARD", not "undo" and emphatically not "revoke". `REVOKE` is one of the
 * three VERDICTS and means "take this person's access away"; it renders in the
 * badge this control sits beside. Discard is in the canonical destructive verb
 * list (`destructive-vocabulary`) and describes what happens: the verdict is
 * abandoned and the row returns to undecided.
 */
function UndoVerdictDialog({
    apiBase,
    row,
    onClose,
    onSuccess,
}: {
    apiBase: string;
    row: DecisionRow;
    onClose: () => void;
    onSuccess: () => void;
}) {
    const t = useTranslations('accessReviews');
    const [reason, setReason] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);

    const handleSubmit = async () => {
        setSubmitting(true);
        setError(null);
        try {
            const res = await fetch(`${apiBase}/decisions/${row.id}/revoke`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason }),
            });
            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || t('submitFailed'));
            }
            onSuccess();
        } catch (err) {
            setError(err instanceof Error ? err.message : t('unknownError'));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal showModal={true} setShowModal={(v) => !v && onClose()}>
            <Modal.Header
                title={t('undoDialogTitle', { email: row.subjectUser.email })}
            />
            <Modal.Body>
                <div className="space-y-default">
                    <p className="text-sm text-content-muted">
                        {t('undoExplainer', { verdict: row.decision ?? '' })}
                    </p>
                    <FormField label={t('undoReasonLabel')} required>
                        <textarea
                            className="input"
                            rows={3}
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            placeholder={t('undoReasonPlaceholder')}
                            data-testid="undo-modal-reason"
                        />
                    </FormField>
                    {error ? (
                        <p
                            className="text-sm text-content-error"
                            data-testid="undo-modal-error"
                        >
                            {error}
                        </p>
                    ) : null}
                </div>
            </Modal.Body>
            <Modal.Footer>
                <Button variant="secondary" onClick={onClose}>{t('cancel')}</Button>
                <Button
                    variant="destructive"
                    onClick={() => void handleSubmit()}
                    disabled={submitting || reason.trim().length < 3}
                    data-testid="undo-modal-submit"
                >
                    {t('undoConfirm')}
                </Button>
            </Modal.Footer>
        </Modal>
    );
}

function DecisionDialog({
    apiBase,
    decision,
    onClose,
    onSuccess,
}: {
    apiBase: string;
    decision: { row: DecisionRow; type: DecisionType };
    onClose: () => void;
    onSuccess: () => void;
}) {
    const t = useTranslations('accessReviews');
    const [notes, setNotes] = useState('');
    const [modifiedToRole, setModifiedToRole] = useState<ModifyTargetRole>('READER');
    const [error, setError] = useState<string | null>(null);

    const targetRoles = useMemo(
        () => MODIFY_TARGET_ROLES.filter((r) => r !== decision.row.snapshotRole),
        [decision.row.snapshotRole],
    );

    const [submitting, setSubmitting] = useState(false);
    const handleSubmit = async () => {
        setSubmitting(true);
        setError(null);
        try {
            const body =
                decision.type === 'MODIFY'
                    ? { decision: 'MODIFY', modifiedToRole, notes: notes || undefined }
                    : { decision: decision.type, notes: notes || undefined };
            const res = await fetch(
                `${apiBase}/decisions/${decision.row.id}`,
                {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                },
            );
            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || t('submitFailed'));
            }
            onSuccess();
        } catch (err) {
            setError(err instanceof Error ? err.message : t('unknownError'));
        } finally {
            setSubmitting(false);
        }
    };

    const titleByType: Record<DecisionType, string> = {
        CONFIRM: t('confirmAccess'),
        REVOKE: t('revokeAccess'),
        MODIFY: t('modifyRole'),
    };

    return (
        <Modal showModal={true} setShowModal={(v) => !v && onClose()}>
            <Modal.Header
                title={t('dialogTitle', {
                    type: titleByType[decision.type],
                    email: decision.row.subjectUser.email,
                })}
            />
            <Modal.Body>
                <div className="space-y-default">
                    <p className="text-sm text-content-muted">
                        {t('snapshotRoleLabel')}{' '}
                        <strong>{decision.row.snapshotRole}</strong>
                        {decision.row.membership &&
                        decision.row.membership.role !== decision.row.snapshotRole ? (
                            <>
                                {' '}
                                ({t('liveNow')} <strong>{decision.row.membership.role}</strong>)
                            </>
                        ) : null}
                    </p>
                    {decision.type === 'MODIFY' ? (
                        <FormField label={t('targetRole')} required>
                            <select
                                className="input"
                                value={modifiedToRole}
                                onChange={(e) => setModifiedToRole(e.target.value as ModifyTargetRole)}
                                data-testid="decision-modal-modified-to-role"
                            >
                                {targetRoles.map((r) => (
                                    <option key={r} value={r}>
                                        {r}
                                    </option>
                                ))}
                            </select>
                        </FormField>
                    ) : null}
                    <FormField
                        label={
                            decision.type === 'CONFIRM'
                                ? t('justOptional')
                                : t('justRecommended')
                        }
                    >
                        <textarea
                            className="input"
                            rows={3}
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            placeholder={t('whyDecision')}
                            data-testid="decision-modal-notes"
                        />
                    </FormField>
                    {error ? (
                        <p
                            className="text-sm text-content-error"
                            data-testid="decision-modal-error"
                        >
                            {error}
                        </p>
                    ) : null}
                </div>
            </Modal.Body>
            <Modal.Footer>
                <Button variant="secondary" onClick={onClose}>{t('cancel')}</Button>
                <Button
                    onClick={() => void handleSubmit()}
                    disabled={submitting}
                    data-testid="decision-modal-submit"
                >
                    {submitting ? t('submitting') : t('submitDecision')}
                </Button>
            </Modal.Footer>
        </Modal>
    );
}

// ─── Close-campaign dialog ───────────────────────────────────────────

function CloseDialog({
    apiBase,
    onClose,
    onSuccess,
}: {
    apiBase: string;
    onClose: () => void;
    onSuccess: () => void;
}) {
    const t = useTranslations('accessReviews');
    const [error, setError] = useState<string | null>(null);

    const [submitting, setSubmitting] = useState(false);
    const handleCloseCampaign = async () => {
        setSubmitting(true);
        setError(null);
        try {
            const res = await fetch(`${apiBase}/close`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });
            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || t('closeFailed'));
            }
            onSuccess();
        } catch (err) {
            setError(err instanceof Error ? err.message : t('unknownError'));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal showModal={true} setShowModal={(v) => !v && onClose()}>
            <Modal.Header title={t('closeTitle')} />
            <Modal.Body>
                <p className="text-sm text-content-muted">
                    {t.rich('closeBody', { b: (c) => <strong>{c}</strong> })}
                </p>
                {error ? (
                    <p
                        className="mt-3 text-sm text-content-error"
                        data-testid="close-modal-error"
                    >
                        {error}
                    </p>
                ) : null}
            </Modal.Body>
            <Modal.Footer>
                <Button variant="secondary" onClick={onClose}>{t('cancel')}</Button>
                <Button
                    onClick={() => void handleCloseCampaign()}
                    disabled={submitting}
                    data-testid="close-modal-submit"
                >
                    {submitting ? t('closing') : t('closeGenerate')}
                </Button>
            </Modal.Footer>
        </Modal>
    );
}
