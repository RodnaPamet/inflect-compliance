'use client';

/**
 * TOOLS — what this agent may reach, and whether the tools it reaches are the
 * ones anybody reviewed.
 *
 * Two resources, deliberately drawn apart on one panel:
 *
 *   • GRANTS (`/admin/agents/:id/tools`, key `admin.agent_tool_exposure`) —
 *     per-agent, deny-by-default. A tool absent from the list is unreachable
 *     however widely the credential is scoped.
 *   • MANIFEST PINS (`/admin/agents/tool-manifests`, key `admin.agent_registry`
 *     plus the role-tier admin check) — TENANT-WIDE, and rendered by
 *     `ToolManifestPins` under its own heading and scope badge. See that file
 *     for why a tenant-wide control inside a per-agent tab has to look like one.
 *
 * They share no id and no permission key, so they fail independently and are
 * gated independently: the grants half nulls its own read key and renders a
 * permission panel in its place, while the pins render on the register key —
 * the one this page already required to open at all.
 *
 * ## Why this tab is not disabled on `!canGrantTools`
 *
 * It was, briefly, and that was wrong. Disabling the tab on the NARROWER of
 * the two keys made a principal holding only the register key reach neither
 * half — including the definition pins, which are the only UI in this product
 * for the ASI04 tool-poisoning surface, and which that principal is entitled
 * to read. `EntityDetailLayout` makes a disabled tab click-inert, so there was
 * no way through and nothing on screen to say why.
 *
 * The tab therefore always opens, and the grants half renders the permission
 * panel below in place of its content. Two resources behind one tab must be
 * gated at the section, not at the tab — the tab is the wrong granularity the
 * moment its contents stop sharing a key.
 *
 * ## `canGrantTools` gates the READ
 *
 * The route rule carries no `methods` restriction, so the GET 403s as well.
 * The SWR key is nulled rather than the request being fired and swallowed —
 * a 403 the UI provoked on purpose is a hash-chained `AUTHZ_DENIED` row in
 * somebody's audit log for a page they only opened.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { ApiClientError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/api-error';
import { formatDateTime } from '@/lib/format-date';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
// Zero-import leaf module — the catalogue exists precisely so a surface can
// learn a tool's rung without dragging the whole tool graph into the bundle.
import { mcpToolCapabilityClass } from '@/lib/mcp/tool-catalogue';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { ErrorState } from '@/components/ui/error-state';
import { FormField } from '@/components/ui/form-field';
import { useToast } from '@/components/ui/hooks';
import { Plug2 } from '@/components/ui/icons/nucleo';
import { InlineEmptyState } from '@/components/ui/inline-empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { SkeletonCard } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';

import {
    ToolManifestPins,
    TOOL_MANIFEST_PATH,
    type ToolManifestState,
} from './ToolManifestPins';
import type { ToolsTabProps } from './types';

/** One row of the `granted` array. There is no soft-delete rail: a revoke deletes. */
interface AgentToolGrant {
    id: string;
    toolName: string;
    grantedByUserId: string | null;
    createdAt: string;
}

interface AgentToolsPayload {
    agentId: string;
    granted: AgentToolGrant[];
    /**
     * The LIVE catalogue, not the granted set — the picker's source, and the
     * only thing that tells an inert grant (a tool this build no longer
     * defines) apart from a working one.
     */
    available: string[];
}

/**
 * The six comparisons `evaluateAssessmentStaleness` makes. Restated here
 * because the union lives in `@/lib/agentic/agent-assessment-staleness`
 * alongside the scorer, and this surface needs the NAMES, not the module.
 *
 * An unrecognised seventh is rendered, not dropped — see `stalenessTriggerOther`.
 */
const STALENESS_TRIGGERS = [
    'AUTONOMY_RAISED',
    'TOOL_GRANTED',
    'DATA_SCOPE_WIDENED',
    'REVERSIBILITY_WORSENED',
    'PROVENANCE_WIDENED',
    'MODEL_CHANGED',
] as const;

type StalenessTrigger = (typeof STALENESS_TRIGGERS)[number];

function isKnownTrigger(value: string): value is StalenessTrigger {
    return (STALENESS_TRIGGERS as readonly string[]).includes(value);
}

/**
 * The verdict `reassessAgentAfterChangeInTx` commits with the grant.
 *
 * `stale` is `triggers.length > 0` over the STANDING assessment's frozen
 * basis — NOT over the delta this request caused. An agent whose data scope
 * was widened last week comes back stale on the next grant, so the tool cannot
 * be named as the cause unless `TOOL_GRANTED` is actually among the triggers.
 *
 * `rescored` is non-null when the SAME transaction recomputed the tier upward.
 * The grant is not what did that — the tool list is not a scorer input — but
 * the reconcile runs on any change, so a widened axis can narrow the ceiling
 * in the step the operator thinks of as "granting a tool".
 */
interface GrantStaleness {
    stale: boolean;
    triggers: string[];
    rescored: { from: string; to: string } | null;
}

interface GrantResult {
    toolName: string;
    staleness: GrantStaleness | null;
}

/** The staleness notice, with the tool that provoked the reconcile. */
interface StaleNotice {
    toolName: string;
    verdict: GrantStaleness;
}

export function ToolsTab({ agentId, refreshToken, onChanged, canGrantTools }: ToolsTabProps) {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const toast = useToast();

    const { data, error, isLoading, mutate } = useTenantSWR<AgentToolsPayload>(
        canGrantTools ? `/admin/agents/${agentId}/tools` : null,
    );

    /**
     * The SAME key `ToolManifestPins` reads, and therefore the same SWR cache
     * entry — the hook keys on the resolved URL, so this is not a second
     * request. Read here because "this agent can call these tools" and "the
     * boundary is currently refusing this tool for every agent" were otherwise
     * two facts on one panel that nothing joined, and the grants half then read
     * as live authority for a tool that cannot be called at all.
     *
     * Gated by `admin.agent_registry`, which every mount of this page holds, so
     * it is fired unconditionally rather than behind `canGrantTools`.
     */
    const { data: manifests, error: manifestError } =
        useTenantSWR<ToolManifestState[]>(TOOL_MANIFEST_PATH);

    useEffect(() => { void mutate(); }, [refreshToken, mutate]);

    const [selected, setSelected] = useState<ComboboxOption | null>(null);
    const [granting, setGranting] = useState(false);
    const [revoking, setRevoking] = useState<string | null>(null);
    const [writeError, setWriteError] = useState<string | null>(null);
    const [stale, setStale] = useState<StaleNotice | null>(null);

    const granted = useMemo(() => data?.granted ?? [], [data]);
    const available = useMemo(() => data?.available ?? [], [data]);

    const grantedNames = useMemo(() => new Set(granted.map((g) => g.toolName)), [granted]);
    const options = useMemo<ComboboxOption[]>(
        () =>
            available
                .filter((name) => !grantedNames.has(name))
                .map((name) => ({ value: name, label: name })),
        [available, grantedNames],
    );

    const blockedTools = useMemo(
        () => new Set((manifests ?? []).filter((m) => m.blocked).map((m) => m.toolName)),
        [manifests],
    );

    function capabilityLabel(toolName: string): string {
        return mcpToolCapabilityClass(toolName) === 'read'
            ? t('agentDetail.tools.capabilityRead')
            : t('agentDetail.tools.capabilityPropose');
    }

    async function grant(toolName: string) {
        if (granting) return;
        setGranting(true);
        setWriteError(null);
        setStale(null);
        try {
            const res = await fetch(apiUrl(`/admin/agents/${agentId}/tools`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ toolName }),
            });
            const body: unknown = await res.json().catch(() => null);

            if (!res.ok) {
                // A 403 body is deliberately uninformative and never names the
                // key; every other refusal here is an authored sentence that
                // says which rung or which axis blocked the grant, and those
                // are worth reading verbatim.
                setWriteError(
                    res.status === 403
                        ? t('agentDetail.tools.grantForbidden')
                        : apiErrorMessage(body, t('agentDetail.tools.grantFailed')),
                );
                return;
            }

            const result = body as GrantResult | null;
            setSelected(null);
            // The write LANDED. Everything past this point is bookkeeping, and
            // a revalidation that fails must not be reported as a failed grant
            // — so the re-read is awaited for ordering but its rejection is
            // swallowed here rather than falling into the catch below. SWR
            // still records the failure on `error`, and the panel says so.
            await mutate().catch(() => undefined);
            onChanged?.();
            if (result?.staleness?.stale) {
                setStale({ toolName, verdict: result.staleness });
            }
            toast.success(t('agentDetail.tools.grantSuccess', { toolName }));
        } catch {
            // A rejected fetch — offline, DNS, a navigation that aborted the
            // request — never reaches the `!res.ok` branch above. Without this
            // the spinner simply stops and the panel says nothing at all.
            setWriteError(t('agentDetail.tools.grantFailed'));
        } finally {
            setGranting(false);
        }
    }

    async function revoke(toolName: string) {
        if (revoking) return;
        setRevoking(toolName);
        setWriteError(null);
        // The standing staleness notice names a tool the agent could reach. It
        // stops being true the moment one is taken back, and a revoke does not
        // re-run the reconcile that would refresh it.
        setStale(null);
        try {
            // The tool rides in the QUERY STRING, not a body: revocation is the
            // emergency direction and has to work from anything that can form a
            // URL, so the route reads `?tool=` and 400s without it.
            const res = await fetch(
                apiUrl(`/admin/agents/${agentId}/tools?tool=${encodeURIComponent(toolName)}`),
                { method: 'DELETE' },
            );

            if (!res.ok) {
                const body: unknown = await res.json().catch(() => null);
                if (res.status === 404) {
                    // The revoke is NOT idempotent — a second one 404s. That is
                    // a stale list, not a failure: the row is gone, which is
                    // what was asked for. Re-read and say so quietly rather
                    // than showing a red banner for a state the operator wanted.
                    toast.info(t('agentDetail.tools.revokeAlreadyGone', { toolName }));
                    await mutate().catch(() => undefined);
                    return;
                }
                setWriteError(
                    res.status === 403
                        ? t('agentDetail.tools.revokeForbidden')
                        : apiErrorMessage(body, t('agentDetail.tools.revokeFailed')),
                );
                return;
            }

            await mutate().catch(() => undefined);
            onChanged?.();
            toast.success(t('agentDetail.tools.revokeSuccess', { toolName }));
        } catch {
            // The damaging silence of the two: without this the operator clicks
            // the emergency direction, the row stays exactly as it was, and
            // nothing distinguishes "the request never landed" from "already
            // revoked". Same idiom as `AgentKillSwitchAction`.
            setWriteError(t('agentDetail.tools.revokeFailed'));
        } finally {
            setRevoking(null);
        }
    }

    function grantsBody() {
        if (error) {
            const status = error instanceof ApiClientError ? error.status : 0;
            if (status === 403) {
                return (
                    <InlineNotice variant="info" title={t('agentDetail.tools.forbiddenTitle')}>
                        {t('agentDetail.tools.forbiddenBody')}
                    </InlineNotice>
                );
            }
            if (status === 400) {
                // The only 400 `listAgentTools` raises today is the retired-
                // agent refusal — `assertCanRead` throws 403 and a missing
                // agent throws 404 — and `ValidationError` carries the generic
                // BAD_REQUEST code, so there is nothing to discriminate on.
                // The server's own sentence is therefore the body: a second 400
                // added later says what it is instead of being relabelled as
                // retirement under an authored headline.
                const refusal = error instanceof ApiClientError ? error.message : '';
                return (
                    <InlineNotice variant="warning" title={t('agentDetail.tools.refusedTitle')}>
                        {refusal || t('agentDetail.tools.retiredBody')}
                    </InlineNotice>
                );
            }
            return (
                <ErrorState
                    title={t('agentDetail.tools.loadFailedTitle')}
                    description={t('agentDetail.tools.loadFailedBody')}
                    onRetry={() => void mutate()}
                    retryLabel={t('agentDetail.tools.retry')}
                />
            );
        }

        if (isLoading && !data) return <SkeletonCard lines={4} />;

        return (
            <div className="space-y-default">
                <div className="flex flex-wrap items-end gap-compact">
                    <FormField
                        label={t('agentDetail.tools.grantLabel')}
                        description={t('agentDetail.tools.grantHint')}
                        className="min-w-0 flex-1"
                    >
                        <Combobox
                            id="agent-tool-grant-input"
                            name="toolName"
                            options={options}
                            selected={selected}
                            setSelected={setSelected}
                            placeholder={t('agentDetail.tools.grantPlaceholder')}
                            searchPlaceholder={t('agentDetail.tools.grantSearchPlaceholder')}
                            emptyState={t('agentDetail.tools.allGranted')}
                            // The rung the tool needs, beside the tool. The tier
                            // cap refuses a grant the agent could never exercise,
                            // and this is where that is cheap to notice.
                            optionRight={(option) => (
                                <span className="text-xs text-content-subtle">
                                    {capabilityLabel(option.value)}
                                </span>
                            )}
                            matchTriggerWidth
                            forceDropdown
                            buttonProps={{ className: 'w-full' }}
                            caret
                        />
                    </FormField>
                    {/*
                        SECONDARY, not primary. Widening what an agent may reach
                        is an everyday administrative edit, not the page's
                        centre of gravity — the register's emphasis belongs to
                        the moves that stop an agent, and the product-wide
                        primary ceiling is spent on those.
                    */}
                    <Button
                        variant="secondary"
                        size="sm"
                        loading={granting}
                        disabled={!selected}
                        onClick={() => {
                            if (selected) void grant(selected.value);
                        }}
                        data-testid="agent-tool-grant-submit"
                    >
                        {t('agentDetail.tools.grantAction')}
                    </Button>
                </div>

                {granted.length === 0 ? (
                    <InlineEmptyState
                        icon={Plug2}
                        title={t('agentDetail.tools.noTools')}
                        description={t('agentDetail.tools.noToolsDescription')}
                    />
                ) : (
                    <ul className="divide-y divide-border-subtle">
                        {granted.map((row) => {
                            // A grant naming a tool this build no longer defines
                            // is inert rather than dangerous — nothing can call a
                            // tool that is gone — but it reads as authority in the
                            // register, so it says what it is.
                            const inert = !available.includes(row.toolName);
                            // A tool the MCP boundary is refusing outright: the
                            // grant is real, the authority is not exercisable
                            // until the definition below is pinned again.
                            const blocked = blockedTools.has(row.toolName);
                            return (
                                <li
                                    key={row.id}
                                    className="flex flex-wrap items-start justify-between gap-default py-compact"
                                    data-testid={`agent-tool-row-${row.toolName}`}
                                >
                                    <div className="space-y-tight">
                                        <div className="flex flex-wrap items-center gap-tight">
                                            <span className="font-mono text-sm text-content-emphasis">
                                                {row.toolName}
                                            </span>
                                            {inert ? (
                                                <StatusBadge variant="warning" size="sm">
                                                    {t('agentDetail.tools.inertBadge')}
                                                </StatusBadge>
                                            ) : (
                                                <StatusBadge variant="neutral" size="sm">
                                                    {capabilityLabel(row.toolName)}
                                                </StatusBadge>
                                            )}
                                            {blocked && (
                                                <StatusBadge
                                                    variant="error"
                                                    tone="solid"
                                                    size="sm"
                                                    data-testid={`agent-tool-blocked-${row.toolName}`}
                                                >
                                                    {t('agentDetail.tools.manifests.blockedBadge')}
                                                </StatusBadge>
                                            )}
                                        </div>
                                        <p className="text-xs text-content-muted">
                                            {t('agentDetail.tools.grantedAt', {
                                                when: formatDateTime(row.createdAt),
                                            })}{' '}
                                            {row.grantedByUserId
                                                ? t('agentDetail.tools.grantedBy', {
                                                      user: row.grantedByUserId,
                                                  })
                                                : t('agentDetail.tools.grantedByUnrecorded')}
                                        </p>
                                        {inert && (
                                            <p className="max-w-prose text-xs text-content-subtle">
                                                {t('agentDetail.tools.inertHint')}
                                            </p>
                                        )}
                                        {blocked && (
                                            <p className="max-w-prose text-xs text-content-subtle">
                                                {t('agentDetail.tools.blockedHint')}
                                            </p>
                                        )}
                                    </div>
                                    <Button
                                        variant="destructive"
                                        size="sm"
                                        loading={revoking === row.toolName}
                                        onClick={() => void revoke(row.toolName)}
                                        data-testid={`agent-tool-revoke-${row.toolName}`}
                                    >
                                        {t('agentDetail.tools.revokeAction')}
                                    </Button>
                                </li>
                            );
                        })}
                    </ul>
                )}

                {/*
                    An absent "refused at the boundary" badge otherwise reads as
                    "checked, and fine". When the pin states did not load it was
                    not checked, and the grants list must not be allowed to imply
                    the quieter of the two.
                */}
                {manifestError && granted.length > 0 && (
                    <p className="max-w-prose text-xs text-content-subtle">
                        {t('agentDetail.tools.blockedUnknown')}
                    </p>
                )}
            </div>
        );
    }

    return (
        <div className="space-y-section">
            <Card as="section" density="compact" className="space-y-default">
                <div className="space-y-tight">
                    <div className="flex flex-wrap items-center gap-tight">
                        <Plug2 className="w-4 h-4 text-content-subtle" aria-hidden="true" />
                        <Heading level={2}>{t('agentDetail.tools.heading')}</Heading>
                        {/*
                            `!error` as well as `data`: the hook keeps previous
                            data across a failed revalidation, so without it a
                            count from the last good read sits in the heading
                            beside a body saying the list did not load.
                        */}
                        {canGrantTools && !error && data && (
                            <StatusBadge variant="neutral" size="sm">
                                {t('agentDetail.tools.grantCount', {
                                    granted: granted.length,
                                    total: available.length,
                                })}
                            </StatusBadge>
                        )}
                    </div>
                    <p className="max-w-prose text-sm text-content-muted">
                        {t('agentDetail.tools.intro')}
                    </p>
                </div>

                {writeError && (
                    <InlineNotice variant="error" onDismiss={() => setWriteError(null)}>
                        {writeError}
                    </InlineNotice>
                )}

                {stale?.verdict.stale && (
                    <InlineNotice
                        variant="warning"
                        title={t('agentDetail.tools.stalenessTitle')}
                        onDismiss={() => setStale(null)}
                    >
                        <div className="space-y-tight">
                            <p>
                                {/*
                                    Only the tool-attributed sentence when the
                                    grant is actually among the triggers. The
                                    verdict is computed against the standing
                                    assessment's frozen basis, so an axis widened
                                    last week returns `stale` on today's grant —
                                    and naming this tool as the cause would be
                                    the panel asserting something the API never
                                    said.
                                */}
                                {stale.verdict.triggers.includes('TOOL_GRANTED')
                                    ? t('agentDetail.tools.stalenessCauseTool', {
                                          toolName: stale.toolName,
                                      })
                                    : t('agentDetail.tools.stalenessCauseOther')}
                            </p>
                            {stale.verdict.triggers.length > 0 && (
                                <ul className="list-disc pl-4">
                                    {stale.verdict.triggers.map((trigger) => (
                                        <li key={trigger}>
                                            {isKnownTrigger(trigger)
                                                ? t(`agentDetail.tools.stalenessTrigger.${trigger}`)
                                                : t('agentDetail.tools.stalenessTriggerOther', {
                                                      trigger,
                                                  })}
                                        </li>
                                    ))}
                                </ul>
                            )}
                            <p>
                                {/*
                                    The reconcile runs `rescoreAgainstStandingAnswers`
                                    in the same transaction and CAN raise the
                                    tier. Claiming the tier did not move without
                                    reading `rescored` is the one sentence here
                                    that could send an operator away from a
                                    narrowed ceiling.
                                */}
                                {stale.verdict.rescored
                                    ? t('agentDetail.tools.stalenessRescored', {
                                          from: stale.verdict.rescored.from,
                                          to: stale.verdict.rescored.to,
                                      })
                                    : t('agentDetail.tools.stalenessNoRescore')}
                            </p>
                        </div>
                    </InlineNotice>
                )}

                {canGrantTools ? (
                    grantsBody()
                ) : (
                    // Not an error and not an empty list: the read itself needs
                    // a key this principal does not hold. Saying which authority
                    // is missing is the whole content of this panel — the 403
                    // body never names it. Currently unreachable through the
                    // shell; see the header for why it stays.
                    <InlineNotice variant="info" title={t('agentDetail.tools.forbiddenTitle')}>
                        {t('agentDetail.tools.forbiddenBody')}
                    </InlineNotice>
                )}
            </Card>

            <ToolManifestPins refreshToken={refreshToken} />
        </div>
    );
}
