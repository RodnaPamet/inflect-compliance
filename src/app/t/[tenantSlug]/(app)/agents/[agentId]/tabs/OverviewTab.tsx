'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/error-state';
import { ArrowUpRight } from '@/components/ui/icons/nucleo';
import { InlineNotice } from '@/components/ui/inline-notice';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { SkeletonCard } from '@/components/ui/skeleton';
import { Heading } from '@/components/ui/typography';
import { useToast } from '@/components/ui/hooks';
import { ApiClientError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/api-error';
import { formatDate, formatDateTime } from '@/lib/format-date';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

import { AutonomyScale } from '../AutonomyScale';
import type { RegistryWritableTabProps } from './types';

/**
 * `GET /admin/agents/:agentId`, as it arrives over JSON — every `Date` column
 * is an ISO string by the time it reaches here.
 *
 * `riskTier` and `aiSystem.riskTier` are TWO DIFFERENT TAXONOMIES and the
 * types say so rather than both being `string | null`: the first is the
 * agent's operational authority (LOW…CRITICAL, the thing the autonomy ceiling
 * is computed from), the second is the Regulation's classification of the
 * system the agent belongs to (PROHIBITED…MINIMAL). A LOW agent inside a HIGH
 * AI system is an ordinary combination, and reading one where the other was
 * meant would put a sentence on a compliance page that is simply false.
 *
 * NOTE `riskTier: null` is UNSCORED, which every consumer reads as DENY — the
 * tool boundary refuses an unscored agent everything. It is never a low tier
 * and never a dash.
 *
 * Narrowed to the fields this tab reads; the route returns more (the autonomy
 * rung, the access scope, the reversibility) and the shell's header already
 * renders those.
 */
interface AgentDetail {
    /** Typed back by the operator to confirm retirement (#2448). */
    name: string;
    /** The registered rung, rendered as a labelled scale rather than an integer (#2457). */
    autonomyLevel: number;
    description: string | null;
    modelRef: string | null;
    provenance: 'FIRST_PARTY' | 'THIRD_PARTY';
    status: 'DRAFT' | 'ACTIVE' | 'SUSPENDED' | 'RETIRED';
    riskTier: 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL' | null;
    riskTierScoredAt: string | null;
    vendorId: string | null;
    /**
     * The supplier, now that the register's select carries
     * `vendor { id, name }`. Still OPTIONAL, and the fallback below is still
     * live: a FIRST_PARTY agent has no vendor at all, and `Vendor.name` is
     * free text somebody could have left blank. The one case that must never
     * happen — a THIRD_PARTY agent naming no supplier — is refused by a CHECK
     * constraint in the database rather than papered over here.
     */
    vendor?: { name: string | null } | null;
    isLegacyPlaceholder: boolean;
    createdAt: string;
    /**
     * The accountable human. `ownerUserId` is NOT NULL behind a real FK, so
     * the row is always there; `name` is the nullable half, and `email` is the
     * identifier that survives a display name nobody set.
     */
    owner: { name: string | null; email: string | null } | null;
    aiSystem: { id: string; riskTier: 'PROHIBITED' | 'HIGH' | 'LIMITED' | 'MINIMAL' | null } | null;
    /**
     * LIVE credentials. `getById` filters revoked and expired keys out of this
     * count — unlike the register list's Keys column, which still counts
     * everything bound. The copy below says "live" BECAUSE of that filter: if
     * the filtered `_count` ever leaves the repository, the copy is a lie.
     */
    _count: {
        apiKeys: number;
        /**
         * PENDING proposals — the RETIREMENT PRECONDITION (#2448).
         * `retireRegisteredAgent` refuses while this is non-zero, so the dialog
         * states it before the click instead of after the 409.
         */
        proposals: number;
    };
    /**
     * Whether `requireRegisteredAgent` is ON for this tenant — i.e. whether
     * the register is consulted at all when a credential registers.
     *
     * A tenant-wide fact carried on the agent payload because every sentence
     * this tab writes about a suspended agent depends on it, and the tab
     * cannot read it itself: `GET /admin/security-settings` is gated on
     * `admin.manage`, while this page only guarantees `admin.agent_registry`,
     * so a client fetch would 403 for exactly the operators who live here.
     */
    registrationEnforced: boolean;
}

/** The only two moves `POST ./status` accepts — RETIRED lives on DELETE. */
type LifecycleMove = 'ACTIVE' | 'SUSPENDED';

/**
 * One row of the governing profile. A hand-rolled `<dl>` rather than
 * `<MetadataBar>`: that primitive has no call site anywhere in the product,
 * and a tab is a poor place to become its first adopter.
 */
function Fact({
    label,
    children,
    wide = false,
}: {
    label: string;
    children: ReactNode;
    wide?: boolean;
}) {
    return (
        <div className={wide ? 'space-y-tight sm:col-span-2' : 'space-y-tight'}>
            <dt className="text-xs uppercase tracking-wide text-content-subtle">{label}</dt>
            <dd className="text-sm text-content-emphasis">{children}</dd>
        </div>
    );
}

export function OverviewTab({
    tenantSlug,
    agentId,
    refreshToken,
    onChanged,
    canManageRegistry,
}: RegistryWritableTabProps) {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const toast = useToast();
    const router = useRouter();

    const { data, error, isLoading, mutate } = useTenantSWR<AgentDetail>(
        `/admin/agents/${agentId}`,
    );

    // The refreshToken -> SWR bridge.
    useEffect(() => {
        void mutate();
    }, [refreshToken, mutate]);

    const [confirmSuspend, setConfirmSuspend] = useState(false);
    const [confirmRetire, setConfirmRetire] = useState(false);
    const [retireTyped, setRetireTyped] = useState('');
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);

    /**
     * RETIRE — the only permanent decommission, on DELETE rather than the
     * status route, because `AGENT_LIFECYCLE_MOVES` deliberately excludes
     * RETIRED: retirement carries a precondition that a value in a dropdown
     * cannot express.
     */
    const retire = useCallback(async () => {
        setBusy(true);
        setFailure(null);
        try {
            const res = await fetch(apiUrl(`/admin/agents/${agentId}`), { method: 'DELETE' });
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                // The server's 409 names the number still awaiting review. Kept
                // rather than replaced: this path is reachable even with the
                // pre-check, because a proposal can arrive between the read and
                // the click.
                setFailure(apiErrorMessage(body, t('agentDetail.overview.retireError')));
                return;
            }
            setConfirmRetire(false);
            await mutate();
            onChanged?.();
            router.refresh();
        } finally {
            setBusy(false);
        }
    }, [apiUrl, agentId, mutate, onChanged, router, t]);

    const move = useCallback(
        async (next: LifecycleMove) => {
            setBusy(true);
            setFailure(null);
            try {
                const res = await fetch(apiUrl(`/admin/agents/${agentId}/status`), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: next }),
                });
                if (!res.ok) {
                    // `apiErrorMessage` rather than `body.error`: the envelope's
                    // `error` is an OBJECT, and putting one in React state throws
                    // React #31 into the page error boundary — on the failure
                    // path, which is the one nobody exercises. The server's own
                    // wording is worth keeping here: the 409 on activation names
                    // the assessment as the fix.
                    const body = await res.json().catch(() => null);
                    setFailure(
                        apiErrorMessage(
                            body,
                            next === 'ACTIVE'
                                ? t('agentDetail.overview.activateError')
                                : t('agentDetail.overview.suspendError'),
                        ),
                    );
                    return;
                }
                await mutate();
                // TWO refreshes, because two renderers hold this agent's
                // status and only one of them is reachable from here.
                // `onChanged` bumps the shell's `refreshToken`, which re-runs
                // each tab's own SWR; the status badge in the page header is
                // SERVER-rendered from the RSC read in `page.tsx` and no
                // client mutate can touch it. Without `router.refresh()` a
                // successful Suspend leaves a green ACTIVE badge sitting
                // directly above the sentence saying the credentials are now
                // refused — the most prominent status indicator on the page,
                // wrong about a control the operator has just been told took
                // effect. Same pattern as `AgentsClient.tsx` after a create.
                onChanged?.();
                router.refresh();
                setConfirmSuspend(false);
                toast.success(
                    next === 'ACTIVE'
                        ? t('agentDetail.overview.activatedToast')
                        : t('agentDetail.overview.suspendedToast'),
                );
            } catch {
                setFailure(
                    next === 'ACTIVE'
                        ? t('agentDetail.overview.activateError')
                        : t('agentDetail.overview.suspendError'),
                );
            } finally {
                setBusy(false);
            }
        },
        [apiUrl, agentId, mutate, onChanged, router, toast, t],
    );

    // ERROR BEFORE EMPTY. A failed read leaves `data` undefined, and a panel
    // that fell through to the render would print this agent's owner, its
    // credential count and its assessment date as blanks — inventing an
    // unowned, uncredentialled, unassessed agent that nobody registered.
    //
    // `&& !data`, because this branch should only take the panel when there is
    // nothing to take it FROM. `keepPreviousData` is on, so a focus
    // revalidation that fails AFTER a good load leaves `error` set while `data`
    // is still the profile the register gave us. Replacing that wholesale would
    // discard facts this tab legitimately holds; the staleness notice in the
    // render below covers that case instead.
    if (error && !data) {
        const status = error instanceof ApiClientError ? error.status : 0;
        // Three kinds, not two. A 403 and a 404 are ANSWERS — telling the
        // operator "the register did not answer" about either is a false
        // statement on the panel whose entire job is to be honest about
        // failure. The defaults below are the third kind: no answer at all
        // (network throw, 5xx), which is the only one a retry can fix.
        let title = t('agentDetail.overview.loadErrorTitle');
        let body = t('agentDetail.overview.loadErrorBody');
        let onRetry: (() => void) | undefined = () => void mutate();
        if (status === 403) {
            title = t('agentDetail.overview.forbiddenTitle');
            // Never the server's own message on a 403: it is deliberately
            // the uninformative "Permission denied" and names no key.
            body = t('agentDetail.overview.forbiddenBody');
            onRetry = undefined;
        } else if (status === 404) {
            // The agent was retired-and-soft-deleted, or deleted outright,
            // between the RSC render and this fetch. No retry: the row is
            // gone and every attempt returns the same 404, so a button here
            // would invite the operator to read a deletion as a network blip.
            title = t('agentDetail.overview.notFoundTitle');
            body = t('agentDetail.overview.notFoundBody');
            onRetry = undefined;
        }
        return (
            <ErrorState
                title={title}
                description={body}
                onRetry={onRetry}
                retryLabel={t('agentDetail.overview.retry')}
                data-testid="agent-overview-error"
            />
        );
    }
    // `&& !data`, not `isLoading` alone: `keepPreviousData` is on, so a
    // background revalidation must keep the profile on screen rather than
    // flash it back to a skeleton.
    if (isLoading && !data) return <SkeletonCard lines={7} />;
    // The residual `undefined` — no data, no error, not loading. Nothing should
    // reach it, but the render below needs `data` narrowed, and a skeleton is
    // the only honest thing to show for a fact we do not have.
    if (!data) return <SkeletonCard lines={7} />;

    const agent = data;
    // There is no empty branch: this endpoint returns ONE agent or it 404s.
    // A "no agent yet" panel here would be a claim about a register row that
    // the route has already told us exists.
    const unscored = agent.riskTier === null;
    const canSuspend = canManageRegistry && agent.status === 'ACTIVE';
    const canActivate = canManageRegistry && agent.status !== 'ACTIVE';

    return (
        <div className="space-y-section">
            {/* Reached only as `error && data`: the branch above took every
                error that had no previous read behind it. The profile below is
                real but not necessarily current, and this is the only honest
                way to keep it on screen — dropping it would throw away facts
                the register did give us, and showing it silently would let a
                compliance panel state figures it cannot vouch for. Not
                dismissible on purpose: it clears itself the moment a
                revalidation succeeds, and a dismissed staleness warning is
                stale data with nothing left on the page to say so. */}
            {error && (
                <InlineNotice variant="warning" title={t('agentDetail.overview.staleTitle')}>
                    {t('agentDetail.overview.staleBody')}
                </InlineNotice>
            )}

            {agent.isLegacyPlaceholder && (
                <InlineNotice variant="info" title={t('agentDetail.overview.legacyTitle')}>
                    {t('agentDetail.overview.legacyBody')}
                </InlineNotice>
            )}

            <Card as="section" className="space-y-default">
                <Heading level={2}>{t('agentDetail.overview.profileHeading')}</Heading>

                <dl className="grid gap-default sm:grid-cols-2">
                    <Fact label={t('agentDetail.overview.ownerLabel')}>
                        {/* Name, then EMAIL, then the phrase — and the order is
                            the point. `RegisteredAgent.ownerUserId` is NOT NULL
                            behind a real FK (the schema calls it "the
                            accountable human", and the two-person rule
                            downstream compares it) while `User.name` is
                            nullable, so a missing name is a missing DISPLAY
                            NAME and never a missing owner. The email is in the
                            select now, which means the last resort on a page
                            whose question is "who answers for this agent" is an
                            address somebody can write to, rather than a
                            sentence about the absence of a label. The phrase
                            keeps the third rung: it is what is left when the
                            payload carries neither. */}
                        {agent.owner?.name ??
                            agent.owner?.email ?? (
                                <span className="text-content-muted">
                                    {t('agentDetail.overview.ownerEmpty')}
                                </span>
                            )}
                    </Fact>

                    {/* THE AUTHORITY DIAL, IN WORDS (#2457). It rendered as a
                        bare `L4` in the header strip, and nobody could tell what
                        4 permitted without reading the source. `wide` because a
                        seven-rung ladder in a half-width column wraps into
                        unreadability. */}
                    <Fact label={t('agentDetail.overview.autonomyLabel')} wide>
                        <AutonomyScale level={agent.autonomyLevel} />
                    </Fact>

                    <Fact label={t('agentDetail.overview.modelRefLabel')}>
                        {agent.modelRef ?? (
                            <span className="text-content-muted">
                                {t('agentDetail.overview.modelRefEmpty')}
                            </span>
                        )}
                    </Fact>

                    <Fact label={t('agentDetail.overview.provenanceLabel')}>
                        <span className="flex flex-wrap items-center gap-tight">
                            {t(`agentDetail.overview.provenanceValue.${agent.provenance}`)}
                            {/* The supplier BY NAME, by link either way. The
                                register's select carries `vendor { id, name }`
                                now, so a third-party agent names its supplier
                                in place instead of offering a bare UUID behind
                                a generic "open the record" label — naming the
                                third party is what a third-party
                                accountability surface owes its reader. The
                                generic label survives as the fallback, for a
                                vendor row whose free-text name was left blank;
                                the link is keyed on `vendorId` rather than on
                                the relation, so it renders either way. */}
                            {agent.vendorId && (
                                <Link
                                    href={`/t/${tenantSlug}/vendors/${agent.vendorId}`}
                                    className="inline-flex items-center gap-tight text-content-info hover:underline"
                                    data-testid="agent-overview-vendor-link"
                                >
                                    {agent.vendor?.name ?? t('agentDetail.overview.supplierLink')}
                                    <ArrowUpRight className="w-3.5 h-3.5" aria-hidden="true" />
                                </Link>
                            )}
                        </span>
                    </Fact>

                    <Fact label={t('agentDetail.overview.aiActLabel')}>
                        <span className="flex flex-wrap items-center gap-tight">
                            {agent.aiSystem?.riskTier ?? t('agentDetail.unclassified')}
                            {/* The rationale is not repeated here. The AI-system
                                detail page already renders the clause the
                                classifier landed on and why, and two surfaces
                                narrating one classification is two surfaces that
                                can disagree. */}
                            {agent.aiSystem && (
                                <Link
                                    href={`/t/${tenantSlug}/risks/ai-systems/${agent.aiSystem.id}`}
                                    className="inline-flex items-center gap-tight text-content-info hover:underline"
                                    data-testid="agent-overview-ai-system-link"
                                >
                                    {t('agentDetail.overview.aiActLink')}
                                    <ArrowUpRight className="w-3.5 h-3.5" aria-hidden="true" />
                                </Link>
                            )}
                        </span>
                    </Fact>

                    <Fact label={t('agentDetail.overview.createdLabel')}>
                        {formatDate(agent.createdAt)}
                    </Fact>

                    <Fact label={t('agentDetail.overview.scoredLabel')}>
                        {/* UNSCORED is a state, not a missing value. The two
                            columns move together under a CHECK constraint, so a
                            null tier means nobody has ever scored this agent —
                            printing a dash here would read as "no risk". */}
                        {unscored ? (
                            <span className="text-content-warning">
                                {t('agentDetail.overview.scoredNever')}
                            </span>
                        ) : (
                            formatDateTime(agent.riskTierScoredAt)
                        )}
                    </Fact>

                    <Fact label={t('agentDetail.overview.credentialsLabel')}>
                        {/* `_count.apiKeys` is the LIVE count: `getById`
                            filters out `revokedAt`-set rows and expired ones,
                            so the copy states "live API keys" plainly instead
                            of hedging about what the number includes. Zero now
                            means no key bound to this agent is still live — it
                            does NOT mean none was ever bound, which is why the
                            zero branch reads "None live" rather than "None
                            bound". Nor does a nonzero count mean calls WOULD be
                            accepted: the kill switch and the circuit breaker
                            refuse at the tool boundary without touching
                            `revokedAt` or `expiresAt`, so the copy says "live"
                            and stops there. */}
                        {agent._count.apiKeys === 0
                            ? t('agentDetail.overview.credentialsNone')
                            : t('agentDetail.overview.credentialsValue', {
                                  count: agent._count.apiKeys,
                              })}
                    </Fact>

                    <Fact label={t('agentDetail.overview.descriptionLabel')} wide>
                        {agent.description ? (
                            <span className="whitespace-pre-line break-words">
                                {agent.description}
                            </span>
                        ) : (
                            <span className="text-content-muted">
                                {t('agentDetail.overview.descriptionEmpty')}
                            </span>
                        )}
                    </Fact>
                </dl>
            </Card>

            <Card as="section" className="space-y-default">
                <Heading level={2}>{t('agentDetail.overview.availabilityHeading')}</Heading>

                {/* TWO sentence sets, chosen by the tenant's own enforcement
                    flag, because one status means different things under each.
                    `evaluateAgentRegistration` refuses a non-ACTIVE agent only
                    when `requireRegisteredAgent` is on; with it off the register
                    records the state and the gate lets the credentials through.
                    This copy used to open four sentences with "If this workspace
                    requires registered agents, …" precisely because it could not
                    tell which world it was in — and a conditional is the worst
                    thing to hand somebody mid-incident, because it makes the
                    reader do the lookup the page refused to do. Now
                    `registrationEnforced` comes down with the agent and each
                    reader gets the unconditional sentence that is true of their
                    workspace. */}
                <p className="text-sm text-content-muted">
                    {t(
                        agent.registrationEnforced
                            ? `agentDetail.overview.stateBody.${agent.status}`
                            : `agentDetail.overview.stateBodyUnenforced.${agent.status}`,
                    )}
                </p>

                {unscored && (
                    // The 409 an operator would otherwise meet by pressing the
                    // button, said in advance. A refusal the UI could have
                    // predicted is a refusal that should never have been a
                    // round trip.
                    <InlineNotice variant="warning" title={t('agentDetail.overview.unscoredTitle')}>
                        {t('agentDetail.overview.unscoredBody')}
                    </InlineNotice>
                )}

                {failure && !confirmSuspend && (
                    <InlineNotice variant="error" onDismiss={() => setFailure(null)}>
                        {failure}
                    </InlineNotice>
                )}

                {canManageRegistry ? (
                    <div className="flex flex-wrap items-center gap-tight">
                        {canActivate && (
                            // `secondary`, not `primary`. The product spends its
                            // primary tone on a page's one defining action, and a
                            // control inside a tab panel on a detail page is not
                            // that. Nothing is lost by the demotion: Activate and
                            // Suspend are mutually exclusive (`status !== ACTIVE`
                            // against `status === ACTIVE`), so this row never
                            // holds two same-looking buttons to choose between.
                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                loading={busy}
                                disabled={unscored || busy}
                                id="agent-status-activate-btn"
                                onClick={() => void move('ACTIVE')}
                            >
                                {t('agentDetail.overview.activateAction')}
                            </Button>
                        )}
                        {canSuspend && (
                            // Deliberately NOT the tinted ghost the header's stop
                            // control wears. Two controls that look alike are two
                            // controls an operator picks between under pressure,
                            // and these two do different things.
                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                disabled={busy}
                                id="agent-status-suspend-btn"
                                onClick={() => {
                                    setFailure(null);
                                    setConfirmSuspend(true);
                                }}
                            >
                                {t('agentDetail.overview.suspendAction')}
                            </Button>
                        )}
                        {/* RETIRE (#2448). Last in the row and destructive-toned
                            because it is the only move here that cannot be
                            undone — suspension stops an agent just as
                            completely and is reversible, which is why the
                            server's own refusal offers it as the alternative.
                            Hidden once retired: a permanent state has no
                            second application. */}
                        {agent.status !== 'RETIRED' && (
                            <Button
                                type="button"
                                variant="destructive"
                                size="sm"
                                disabled={busy}
                                id="agent-status-retire-btn"
                                data-testid="agent-retire-action"
                                onClick={() => {
                                    setFailure(null);
                                    setRetireTyped('');
                                    setConfirmRetire(true);
                                }}
                            >
                                {t('agentDetail.overview.retireAction')}
                            </Button>
                        )}
                    </div>
                ) : (
                    <p className="text-sm text-content-subtle">
                        {t('agentDetail.overview.readOnly')}
                    </p>
                )}
            </Card>

            {confirmRetire && (
                <Modal
                    showModal
                    setShowModal={(v) => {
                        if (!v && !busy) {
                            setConfirmRetire(false);
                            setFailure(null);
                        }
                    }}
                    size="md"
                    preventDefaultClose={busy}
                >
                    <Modal.Header
                        title={t('agentDetail.overview.retireTitle')}
                        description={t('agentDetail.overview.retirePrompt')}
                    />
                    <Modal.Body>
                        <div className="space-y-default" data-testid="agent-retire-modal">
                            {/* THE PRECONDITION, STATED BEFORE THE CLICK.
                                `retireRegisteredAgent` refuses while any
                                proposal is PENDING, and the 409 names the
                                count — but a precondition you only meet by
                                being rejected is one you discover by failing.
                                The queue is LINKED, because "approve or reject
                                them first" is an instruction the page can
                                actually help with. */}
                            {agent._count.proposals > 0 ? (
                                <InlineNotice
                                    variant="warning"
                                    data-testid="agent-retire-blocked"
                                >
                                    <div className="space-y-1">
                                        <p>
                                            {t('agentDetail.overview.retireBlocked', {
                                                count: agent._count.proposals,
                                            })}
                                        </p>
                                        <Link
                                            className="underline"
                                            href={`/t/${tenantSlug}/agents/proposals`}
                                        >
                                            {t('agentDetail.overview.retireBlockedLink')}
                                        </Link>
                                    </div>
                                </InlineNotice>
                            ) : (
                                <>
                                    <p className="text-sm text-content-muted">
                                        {t('agentDetail.overview.retireIrreversible')}
                                    </p>
                                    <FormField
                                        label={t('agentDetail.overview.retireTypeToConfirm', {
                                            name: agent.name,
                                        })}
                                        required
                                    >
                                        <Input
                                            value={retireTyped}
                                            onChange={(e) => setRetireTyped(e.target.value)}
                                            autoComplete="off"
                                            autoFocus
                                            placeholder={agent.name}
                                            data-testid="agent-retire-confirm-input"
                                        />
                                    </FormField>
                                </>
                            )}
                            {failure && <InlineNotice variant="error">{failure}</InlineNotice>}
                        </div>
                    </Modal.Body>
                    <Modal.Footer>
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() => setConfirmRetire(false)}
                        >
                            {t('agentDetail.kill.cancel')}
                        </Button>
                        <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            // Blocked by the precondition OR by the typed name.
                            // Both, not either: the precondition is the server's
                            // rule and the typing is this dialog's.
                            disabled={
                                busy
                                || agent._count.proposals > 0
                                || retireTyped !== agent.name
                            }
                            data-testid="agent-retire-commit"
                            onClick={() => void retire()}
                        >
                            {t('agentDetail.overview.retireAction')}
                        </Button>
                    </Modal.Footer>
                </Modal>
            )}

            {confirmSuspend && (
                <Modal
                    showModal
                    setShowModal={(v) => {
                        if (!v && !busy) {
                            setConfirmSuspend(false);
                            setFailure(null);
                        }
                    }}
                    size="md"
                    preventDefaultClose={busy}
                >
                    <Modal.Header
                        title={t('agentDetail.overview.suspendTitle')}
                        description={t('agentDetail.overview.suspendPrompt')}
                    />
                    <Modal.Body>
                        {failure && <InlineNotice variant="error">{failure}</InlineNotice>}
                        <p className="text-sm text-content-muted">
                            {/* What suspension does and does not reach. One half
                                is true either way and stays in both strings:
                                registration is evaluated once per invocation, so
                                this refuses the NEXT request and touches nothing
                                already running — an operator who reads
                                "suspended" as "halted mid-run" has been told
                                something untrue. The flag decides the other
                                half. An enforcing tenant is told the
                                credentials are refused. A tenant that has opted
                                out is told the harder thing: suspension does not
                                refuse them and it WIDENS them. A non-ACTIVE
                                agent makes `verdict.agentId` null
                                (`agent-registration-gate.ts`), and three
                                controls key off exactly that null and open up —
                                `grantedTools` goes null so `isToolExposed`
                                returns true for every tool, `riskTierCeilingFor`
                                is UNCLAMPED with no `agentAutonomy` term, and
                                `loadPolicyCardInForce` is skipped. "Stops
                                nothing" reads as "changes nothing" and this is
                                the dialog where somebody commits. */}
                            {agent.registrationEnforced
                                ? t('agentDetail.overview.suspendScope')
                                : t('agentDetail.overview.suspendScopeUnenforced')}
                        </p>
                        <p className="mt-1 text-sm text-content-muted">
                            {/* The count is LIVE credentials now that
                                `getById` filters revoked and expired keys out of
                                it, so this paragraph can state again what
                                suspension does to them. That claim was retired
                                once — as "# API keys ... stop being accepted"
                                over an UNFILTERED count, which for an agent
                                holding two revoked keys and nothing live told
                                the operator they were cutting off traffic that
                                had already stopped, while the zero branch that
                                would have said so never fired. What makes it
                                safe to state again is the FILTER, not the
                                rewording: move the `_count` override out of the
                                repository and this sentence lies again.

                                Zero is its own key, not an ICU `=0` branch.
                                The locale checker extracts placeholders with
                                /\{([a-zA-Z0-9_]+)/, which reads the English
                                sub-message `{No API keys...}` as a placeholder
                                named `No` while the Cyrillic branch matches
                                nothing — so any `=0 {English}` drifts against
                                its translation. All 67 other plurals in the
                                repo avoid the form for the same reason. */}
                            {agent._count.apiKeys === 0
                                ? t('agentDetail.overview.suspendCredentialsNone')
                                : t('agentDetail.overview.suspendCredentials', {
                                      count: agent._count.apiKeys,
                                  })}
                        </p>
                    </Modal.Body>
                    <Modal.Footer>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                                setConfirmSuspend(false);
                                setFailure(null);
                            }}
                            disabled={busy}
                        >
                            {t('agentDetail.overview.cancel')}
                        </Button>
                        <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            loading={busy}
                            disabled={busy}
                            id="agent-status-suspend-confirm"
                            onClick={() => void move('SUSPENDED')}
                        >
                            {t('agentDetail.overview.suspendConfirm')}
                        </Button>
                    </Modal.Footer>
                </Modal>
            )}
        </div>
    );
}
