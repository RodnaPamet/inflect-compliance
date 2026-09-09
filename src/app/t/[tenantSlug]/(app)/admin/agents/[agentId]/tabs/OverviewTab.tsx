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
import { Modal } from '@/components/ui/modal';
import { SkeletonCard } from '@/components/ui/skeleton';
import { Heading } from '@/components/ui/typography';
import { useToast } from '@/components/ui/hooks';
import { ApiClientError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/api-error';
import { formatDate, formatDateTime } from '@/lib/format-date';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

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
    description: string | null;
    modelRef: string | null;
    provenance: 'FIRST_PARTY' | 'THIRD_PARTY';
    status: 'DRAFT' | 'ACTIVE' | 'SUSPENDED' | 'RETIRED';
    riskTier: 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL' | null;
    riskTierScoredAt: string | null;
    vendorId: string | null;
    /**
     * OPTIONAL because the detail select does not ask for it today, not
     * because the column is soft: `RegisteredAgent.vendor` is a real relation
     * and a CHECK constraint refuses `THIRD_PARTY` with no vendor. Typed here
     * so the supplier is named the moment the select carries it, rather than
     * this tab needing a second change to notice. Absent — today, always — the
     * render falls back to the generic link label.
     */
    vendor?: { name: string | null } | null;
    isLegacyPlaceholder: boolean;
    createdAt: string;
    owner: { name: string | null } | null;
    aiSystem: { id: string; riskTier: 'PROHIBITED' | 'HIGH' | 'LIMITED' | 'MINIMAL' | null } | null;
    _count: { apiKeys: number };
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
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);

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
                        {/* The fallback says the NAME is missing, not the owner.
                            `RegisteredAgent.ownerUserId` is NOT NULL behind a
                            real FK — the schema calls it "the accountable
                            human" and the two-person rule downstream compares
                            it — while `User.name` is nullable. So the only way
                            to reach this branch is an owner on record whose
                            display name is not set, and the register's own
                            surface saying "Unassigned" about them would deny
                            an accountability the database is holding. Reading
                            the name is all this payload can do: the select
                            carries `owner { id, name }` and no email. */}
                        {agent.owner?.name ?? (
                            <span className="text-content-muted">
                                {t('agentDetail.overview.ownerEmpty')}
                            </span>
                        )}
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
                            {/* The supplier BY NAME when the payload carries one,
                                by link either way. `RegisteredAgent` does have a
                                `vendor` relation, but the detail select does not
                                ask for it, so today this payload holds `vendorId`
                                alone — and the only honest things to do with a
                                bare UUID are print it or offer a way to go and
                                read the name. Naming the supplier in place needs
                                `vendor: { select: { id: true, name: true } }`
                                added to the repository's select, which is not
                                this lane's file; the fallback below means that
                                one-line change is all it takes, with no second
                                edit here. Until then the vendor record is where
                                third-party risk for this agent lives. */}
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
                        {/* `_count.apiKeys` is UNFILTERED — `listSelect` counts
                            the relation, and `TenantApiKey` keeps revoked rows
                            (`revokedAt` is set, never deleted) and expired ones
                            (`expiresAt` in the past). So the copy says what the
                            number counts rather than letting the reader take it
                            for live credentials. The fix that would let this
                            read plainly is a filtered `_count` in the route's
                            select, which is not this lane's file. Zero is the
                            one honest reading either way: no rows at all means
                            no live ones. */}
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

                {/* The state sentences name the CONDITION on enforcement rather
                    than asserting it. `evaluateAgentRegistration` refuses a
                    non-ACTIVE agent only when `isAgentRegistrationEnforced` is
                    true, and `TenantSecuritySettings.requireRegisteredAgent` is
                    a tenant switch — an absent row reads as on, so the claim is
                    right for most workspaces and false for one that opted out.
                    A panel that promised an emergency stop to that workspace
                    would be promising something the gate does not do. The tab
                    cannot read the flag itself: the settings route is gated on
                    `admin.manage`, which a registry-key holder need not have. */}
                <p className="text-sm text-content-muted">
                    {t(`agentDetail.overview.stateBody.${agent.status}`)}
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
                    </div>
                ) : (
                    <p className="text-sm text-content-subtle">
                        {t('agentDetail.overview.readOnly')}
                    </p>
                )}
            </Card>

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
                            {/* What suspension does and does not reach, in both
                                directions. Registration is evaluated once per
                                invocation, so this refuses the NEXT request and
                                leaves a run already in flight alone — an operator
                                who reads "suspended" as "halted mid-run" has been
                                told something untrue. And the refusal itself is
                                conditional on this workspace requiring registered
                                agents; with that switch off the register records
                                the suspension and the gate lets the credentials
                                through, so the sentence names the condition rather
                                than promising a stop. */}
                            {t('agentDetail.overview.suspendScope')}
                        </p>
                        <p className="mt-1 text-sm text-content-muted">
                            {/* The count is BOUND credentials, not live ones —
                                revoked and expired keys keep their `agentId` and
                                stay in the relation. This paragraph used to turn
                                that number into a claim ("# API keys ... stop
                                being accepted"), which for an agent holding two
                                revoked keys and nothing live told the operator
                                they were cutting off traffic that had already
                                stopped, while the zero branch that would have
                                said so never fired. It now reports what the
                                number is and what it is not.

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
