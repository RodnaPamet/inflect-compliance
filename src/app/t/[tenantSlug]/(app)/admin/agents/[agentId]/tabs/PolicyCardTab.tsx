'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ErrorState } from '@/components/ui/error-state';
import { FormField } from '@/components/ui/form-field';
import { useToast } from '@/components/ui/hooks';
import { Lock, ShieldKeyhole } from '@/components/ui/icons/nucleo';
import { InlineEmptyState } from '@/components/ui/inline-empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Modal } from '@/components/ui/modal';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { SkeletonCard } from '@/components/ui/skeleton';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { ApiClientError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/api-error';
import { formatDate, formatDateTime } from '@/lib/format-date';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import {
    ACTION_CAP_LADDER,
    APPROVAL_LADDER,
    AUTONOMY_LADDER,
    DATA_SCOPE_LADDER,
    POLICY_CARD_RULES,
    checkLadderStep,
    comparePolicyCards,
    isActionCap,
    narrowApprovalRung,
    narrowEscalationTriggers,
    type ActionCap,
    type AgentPolicyCardValue,
    type PolicyCardRule,
    type PolicyDataScope,
    type PolicyDelta,
    type PolicyDimension,
} from '@/lib/agentic/policy-card';
import {
    withholdingReasonForTool,
    type WithheldTool,
} from '@/lib/agentic/policy-card-evaluation';
import { MCP_TOOL_NAMES } from '@/lib/mcp/tool-catalogue';

import type { PolicyCardTabProps } from './types';

/**
 * The agent's POLICY CARD — the card in force, how it got there, and the one
 * edit the ladder allows.
 *
 * ## The GET returns two disjoint shapes, and this file models them as two
 *
 * `getAgentPolicyCard` answers `{ card: null, wouldSeed, wouldWithhold,
 * assessmentRequired }` or `{ card: {…, inForce}, versions, assessmentRequired:
 * false }`. Never both. One interface with every field optional would compile
 * and then let a render read `versions` on the no-card branch, where it is
 * absent rather than empty — which reads as "this card has no history" instead
 * of "there is no card". Discriminating on `card === null` makes the branch a
 * type error rather than a plausible zero.
 *
 * ## The permission key gates the READ
 *
 * `admin.agent_policy_card` carries no `methods` restriction, so the GET 403s
 * for a principal without it exactly as the writes do. This tab therefore does
 * not fetch at all without the flag: a component that reads only to be refused
 * writes a hash-chained `AUTHZ_DENIED` row on every mount, and a denial row per
 * curious page view is noise in the one log an investigation reads.
 *
 * ## The one-rung rule is enforced HERE as well as at the usecase
 *
 * Not a second opinion — the same functions. `comparePolicyCards` and
 * `checkLadderStep` come from `@/lib/agentic/policy-card`, which carries no
 * server imports precisely so a client can hold the ladder, and
 * `withholdingReasonForTool` is the same predicate `assertDeclarationsExercisable`
 * throws on. The editor offers at most one rung above the version in force on
 * each dimension, and closes every other widening once one is spent, because a
 * control that always 400s is worse than no control: the operator reads the
 * refusal as a bug in the product rather than as the rule it is.
 *
 * What the client CANNOT pre-empt is the tier's own autonomy cap and the
 * agent's registered data-access scope — neither is on this payload, and the
 * only honest source for both is the refusal. Those two arrive as 400s carrying
 * a sentence that names the numbers, and are rendered verbatim.
 *
 * Because they cannot be pre-empted, the editor SAYS SO before the operator
 * spends an edit on them (`ceilingsElsewhereHint`). A control that always
 * refuses is worse than no control, and a control that refuses without warning
 * is read as a bug in the product; a control the surface has already admitted
 * it cannot see the ceiling for is read as the rule it is. The autonomy one is
 * the sharper of the two: the boundary judges the resulting VALUE rather than
 * the step, so a card left above a cap that was lowered by a re-assessment
 * refuses every edit — including ones that raise nothing — until autonomy comes
 * back under it. Both would become pre-emptable if the GET carried `riskTier`
 * and `dataAccessScope`; the tab cannot add them from here.
 */

/** `Date` fields arrive as ISO strings over JSON. */
interface PolicyCardHead {
    id: string;
    agentId: string;
    currentVersion: number;
    /** `@db.Date` — the UTC day the counter below counts. NULL until the first call. */
    usageWindowDate: string | null;
    actionsInWindow: number;
    createdAt: string;
    updatedAt: string;
}

/** One immutable version row, as `VERSION_SELECT` selects it. */
interface PolicyCardVersionRow {
    id: string;
    version: number;
    permittedTools: string[];
    maxDataScope: PolicyDataScope;
    maxAutonomyLevel: number;
    maxActionsPerRun: number;
    maxActionsPerDay: number;
    escalationTriggers: string[];
    approvalRung: string;
    seeded: boolean;
    seededFromTier: string | null;
    createdByUserId: string | null;
    createdAt: string;
}

/** No card yet: what creating one would write, and what it would withhold. */
interface NoCardPayload {
    agentId: string;
    card: null;
    wouldSeed: AgentPolicyCardValue;
    wouldWithhold: WithheldTool[];
    assessmentRequired: boolean;
}

/**
 * A card exists. `inForce` is nullable and that is not paranoia: the head
 * carries a version NUMBER rather than an FK, so a head naming a row that is
 * not there is representable, and the usecase refuses an edit in that state.
 */
interface CardPayload {
    agentId: string;
    card: PolicyCardHead & { inForce: PolicyCardVersionRow | null };
    versions: PolicyCardVersionRow[];
    assessmentRequired: false;
}

type PolicyCardPayload = NoCardPayload | CardPayload;

/** What the PUT hands back on success. */
interface SavedVersion {
    version: number;
}

type SaveOutcome = { ok: true } | { ok: false; message: string };

/** The version history is taken 200 at a time; say so rather than imply totality. */
const VERSION_PAGE = 200;

/**
 * The stored row as a card VALUE, narrowed exactly as `fromRow` in the usecase
 * narrows it — same helpers, same defaults, including the budget that is not a
 * rung reading as zero. An editor and the boundary that enforces the edit must
 * not disagree about what a row means, or the ladder step this file measures is
 * not the one the server measures.
 */
function toCardValue(row: PolicyCardVersionRow): AgentPolicyCardValue {
    return {
        permittedTools: [...row.permittedTools],
        maxDataScope: row.maxDataScope,
        maxAutonomyLevel: row.maxAutonomyLevel,
        maxActionsPerRun: isActionCap(row.maxActionsPerRun) ? row.maxActionsPerRun : 0,
        maxActionsPerDay: isActionCap(row.maxActionsPerDay) ? row.maxActionsPerDay : 0,
        escalationTriggers: narrowEscalationTriggers(row.escalationTriggers),
        approvalRung: narrowApprovalRung(row.approvalRung),
    };
}

/** The i18n key each dimension is labelled by, so the trail and the form agree. */
const DIMENSION_LABEL_KEY: Record<PolicyDimension, string> = {
    permittedTools: 'agentDetail.policyCard.fieldTools',
    maxDataScope: 'agentDetail.policyCard.fieldDataScope',
    maxAutonomyLevel: 'agentDetail.policyCard.fieldAutonomy',
    maxActionsPerRun: 'agentDetail.policyCard.fieldPerRun',
    maxActionsPerDay: 'agentDetail.policyCard.fieldPerDay',
    escalationTriggers: 'agentDetail.policyCard.fieldTriggers',
    approvalRung: 'agentDetail.policyCard.fieldApproval',
};

export function PolicyCardTab({
    agentId,
    refreshToken,
    onChanged,
    canEditPolicyCard,
}: PolicyCardTabProps) {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const toast = useToast();

    const path = `/admin/agents/${agentId}/policy-card`;
    // A null key skips the request entirely. The flag is not a read-only hint:
    // without it the GET is refused too, so fetching would only mint a denial.
    const { data, error, isLoading, mutate } = useTenantSWR<PolicyCardPayload>(
        canEditPolicyCard ? path : null,
    );

    // The refreshToken -> SWR bridge.
    useEffect(() => {
        void mutate();
    }, [refreshToken, mutate]);

    const [failure, setFailure] = useState<string | null>(null);
    const [seeding, setSeeding] = useState(false);
    const [editing, setEditing] = useState(false);

    /**
     * Every outcome RESOLVES, and that is deliberate.
     *
     * `Modal.Confirm` swallows a rejection and keeps the dialog open — which
     * reads like the right way to hold a refusal on screen, and is the opposite.
     * Every notice this component renders sits in normal page flow, i.e. BEHIND
     * `Dialog.Overlay` (`fixed inset-0 z-40`, blurred). Rejecting therefore
     * leaves the operator with a dialog whose button has returned to idle and no
     * visible reason anywhere. Resolving closes the dialog and uncovers the
     * notice, which is the only place the refusal can actually be read.
     */
    const seed = useCallback(async () => {
        setFailure(null);
        let res: Response;
        try {
            res = await fetch(apiUrl(path), { method: 'POST' });
        } catch {
            setFailure(t('agentDetail.policyCard.seedError'));
            return;
        }
        if (!res.ok) {
            const body = await res.json().catch(() => null);
            if (res.status === 409) {
                // Somebody else created it. Not this operator's failure —
                // revalidating swaps the seed panel for the card itself, which
                // is the answer.
                await mutate().catch(() => undefined);
                setFailure(t('agentDetail.policyCard.seedExistsError'));
                return;
            }
            setFailure(
                res.status === 403
                    ? // Never the server's 403 text — it is deliberately the
                      // uninformative "Permission denied" and names no key.
                      t('agentDetail.policyCard.writeForbidden')
                    : // The 400 is the unscored-agent refusal, and it explains
                      // which axes come from the tier. Rendering it verbatim
                      // beats a generic failure.
                      apiErrorMessage(body, t('agentDetail.policyCard.seedError')),
            );
            return;
        }
        // The card EXISTS from here on, so nothing below may say otherwise.
        // SWR's bound `mutate()` REJECTS when its refetch throws, and that
        // rejection would reach `Modal.Confirm`'s `catch { return; }`: dialog
        // still open, no toast, no error — over a card that was created.
        await mutate().catch(() => undefined);
        onChanged?.();
        toast.success(t('agentDetail.policyCard.seededToast'));
    }, [apiUrl, path, mutate, onChanged, toast, t]);

    const save = useCallback(
        async (expectedVersion: number, card: AgentPolicyCardValue): Promise<SaveOutcome> => {
            let res: Response;
            // Only the request itself may produce a `saveError`. A try around
            // the WHOLE function is what let a blip after a 2xx be reported as
            // a failed write — see the tail below.
            try {
                res = await fetch(apiUrl(path), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ expectedVersion, card }),
                });
            } catch {
                return { ok: false, message: t('agentDetail.policyCard.saveError') };
            }

            if (!res.ok) {
                // The envelope's `error` is an OBJECT; putting it in state
                // and rendering it throws React #31 into the page error
                // boundary, on the one path nobody exercises.
                const body = await res.json().catch(() => null);
                if (res.status === 403) {
                    return { ok: false, message: t('agentDetail.policyCard.writeForbidden') };
                }
                if (res.status === 404) {
                    // A stale tab that PUTs before anybody POSTed gets 404,
                    // not 409: there is no card to be at the wrong version.
                    await mutate().catch(() => undefined);
                    return { ok: false, message: t('agentDetail.policyCard.missingCardError') };
                }
                if (res.status === 409) {
                    // Three causes, one remedy: the head moved under this
                    // edit, the append lost its race, or the version in
                    // force could not be read. All of them mean the base
                    // this draft was composed against is gone, and none of
                    // them is safe to re-base automatically — that is how
                    // two operators each widen by one rung and land two
                    // rungs from where either looked.
                    //
                    // A rejected revalidation costs the version NUMBER, not the
                    // verdict: `undefined` falls through to the unnumbered
                    // conflict sentence rather than out of this function.
                    const fresh = await mutate().catch(() => undefined);
                    const now = fresh && fresh.card !== null ? fresh.card.currentVersion : null;
                    return {
                        ok: false,
                        message:
                            now === null
                                ? t('agentDetail.policyCard.conflictError')
                                : t('agentDetail.policyCard.conflictErrorVersion', {
                                      version: now,
                                  }),
                    };
                }
                // 400 — the ladder step, an unexercisable declaration, or a
                // data rung above the agent's own. Each names the tool, the
                // dimension or the rungs, and two of the three depend on
                // state this component was never given.
                return {
                    ok: false,
                    message: apiErrorMessage(body, t('agentDetail.policyCard.saveError')),
                };
            }

            // Past this line the version is appended, the head has moved and the
            // audit row is written. Nothing below is allowed to report a
            // failure. Both of the next two lines can fail on their own — SWR's
            // bound `mutate()` rejects when its refetch throws, and a truncated
            // body makes `res.json()` throw — and both used to land in a catch
            // that told the operator "The policy card could not be saved" about
            // a write that had already happened. On a compliance surface a false
            // statement about a write is worse than a missing one.
            const saved = (await res.json().catch(() => null)) as SavedVersion | null;
            await mutate().catch(() => undefined);
            onChanged?.();
            toast.success(
                t('agentDetail.policyCard.savedToast', {
                    // `appendVersion` moves the head to `expectedFrom + 1` and
                    // writes exactly that row, so the number is knowable without
                    // the body — the toast never has to leave it out.
                    version: saved?.version ?? expectedVersion + 1,
                }),
            );
            return { ok: true };
        },
        [apiUrl, path, mutate, onChanged, toast, t],
    );

    if (!canEditPolicyCard) {
        return (
            <Card density="spacious">
                <InlineEmptyState
                    icon={Lock}
                    title={t('agentDetail.policyCard.forbiddenTitle')}
                    description={t('agentDetail.policyCard.forbiddenDescription')}
                />
            </Card>
        );
    }

    if (error) {
        const forbidden = error instanceof ApiClientError && error.status === 403;
        return (
            <ErrorState
                title={
                    forbidden
                        ? t('agentDetail.policyCard.forbiddenTitle')
                        : t('agentDetail.policyCard.loadErrorTitle')
                }
                description={
                    forbidden
                        ? t('agentDetail.policyCard.forbiddenDescription')
                        : t('agentDetail.policyCard.loadErrorDescription')
                }
                onRetry={forbidden ? undefined : () => void mutate()}
                retryLabel={t('agentDetail.policyCard.retry')}
            />
        );
    }
    if (isLoading && !data) return <SkeletonCard lines={8} />;
    // No error, not loading, no payload is not a state this route produces. The
    // skeleton is the honest render for it; an empty panel here would claim
    // this agent has no policy card, which is a claim about a control.
    if (!data) return <SkeletonCard lines={8} />;

    return (
        <div className="space-y-section">
            {failure && (
                <InlineNotice variant="error" onDismiss={() => setFailure(null)}>
                    {failure}
                </InlineNotice>
            )}

            {data.card === null ? (
                <SeedPanel
                    payload={data}
                    onSeed={() => {
                        setFailure(null);
                        setSeeding(true);
                    }}
                />
            ) : (
                <>
                    <InForcePanel
                        payload={data}
                        onEdit={() => {
                            setFailure(null);
                            setEditing(true);
                        }}
                    />
                    <VersionHistory versions={data.versions} head={data.card.currentVersion} />
                </>
            )}

            {/* Mounted only on the branch that can reach it: a card that
                already exists has nothing to seed, and the POST would 409. */}
            {data.card === null && (
                <ConfirmDialog
                    showModal={seeding}
                    setShowModal={setSeeding}
                    tone="warning"
                    title={t('agentDetail.policyCard.seedConfirmTitle')}
                    description={t('agentDetail.policyCard.seedConfirmBody')}
                    confirmLabel={t('agentDetail.policyCard.seedAction')}
                    cancelLabel={t('agentDetail.policyCard.cancel')}
                    onConfirm={seed}
                />
            )}

            {/* Both props are LIVE — they change under the editor whenever SWR
                revalidates. The editor pins its own base at open and treats a
                change as a conflict; see its docstring. The `inForce !== null`
                gate can unmount an open editor if the head's row disappears
                mid-edit, and that is the honest outcome: with no version in
                force the usecase refuses the PUT anyway, so the draft it drops
                is one nothing would have accepted. */}
            {editing && data.card !== null && data.card.inForce !== null && (
                <PolicyCardEditor
                    liveVersion={data.card.currentVersion}
                    liveCard={toCardValue(data.card.inForce)}
                    onSave={save}
                    onClose={() => setEditing(false)}
                />
            )}
        </div>
    );
}

/**
 * No card yet — what creating one would write, and what it would leave behind.
 *
 * The preview is the SAME seed the POST writes (the usecase derives both from
 * `seedPolicyCardValue`), which is the only reason showing it is safe: a second
 * preview computed here could disagree with the thing the button creates.
 */
function SeedPanel({ payload, onSeed }: { payload: NoCardPayload; onSeed: () => void }) {
    const t = useTranslations('admin');

    return (
        <Card density="compact" className="space-y-default">
            <Heading level={2}>{t('agentDetail.policyCard.seedHeading')}</Heading>
            <p className="max-w-3xl text-sm text-content-muted">
                {t('agentDetail.policyCard.seedIntro')}
            </p>

            {payload.assessmentRequired ? (
                // The preview is deliberately NOT rendered here. An unscored
                // agent seeds to a deny ceiling below rung 0 and a zero budget
                // on every axis — numbers that describe a card the usecase
                // refuses to write, and which read as a deliberate lockdown
                // rather than as an unassessed agent.
                <InlineNotice
                    variant="warning"
                    title={t('agentDetail.policyCard.assessmentTitle')}
                >
                    {t('agentDetail.policyCard.assessmentBody')}
                </InlineNotice>
            ) : (
                <>
                    <div className="space-y-compact">
                        <Heading level={3}>{t('agentDetail.policyCard.previewHeading')}</Heading>
                        <CardDeclarations value={payload.wouldSeed} />
                    </div>

                    {payload.wouldWithhold.length > 0 && (
                        <InlineNotice
                            variant="warning"
                            title={t('agentDetail.policyCard.withheldTitle', {
                                count: payload.wouldWithhold.length,
                            })}
                        >
                            <span className="block">
                                {t('agentDetail.policyCard.withheldIntro')}
                            </span>
                            <WithheldToolList withheld={payload.wouldWithhold} />
                        </InlineNotice>
                    )}

                    <div className="flex flex-wrap items-center gap-compact">
                        <Button
                            variant="secondary"
                            size="sm"
                            id="agent-policy-card-seed-btn"
                            onClick={onSeed}
                        >
                            {t('agentDetail.policyCard.seedAction')}
                        </Button>
                        <span className="text-xs text-content-subtle">
                            {t('agentDetail.policyCard.seedHint')}
                        </span>
                    </div>
                </>
            )}
        </Card>
    );
}

/**
 * Tools a card refuses, why, and what would actually permit each one.
 *
 * The remedy is per REASON, not one sentence over the list, because the reasons
 * do not share one. `NOT_IN_CATALOGUE` names a tool this build does not carry:
 * no ceiling raise ever permits it, and the copy that used to cover the whole
 * list ("permitting it is two ordinary edits once the agent reaches far enough
 * for it") sent the operator to widen an agent's reach over what is really a
 * grant left behind by a deploy. Only the two ceiling reasons have a ladder
 * answer; the catalogue reason has a revocation.
 *
 * Shared by the seed preview and the editor's refusal so the two cannot come to
 * describe the same predicate differently — both render
 * `withholdingReasonForTool`, which is the same function the boundary throws on.
 */
function WithheldToolList({ withheld }: { withheld: readonly WithheldTool[] }) {
    const t = useTranslations('admin');

    return (
        <ul className="mt-1 space-y-tight">
            {withheld.map((tool) => (
                <li key={tool.toolName} className="text-xs">
                    <span className="font-mono text-content-emphasis">{tool.toolName}</span>{' '}
                    <span className="text-content-muted">
                        {t(`agentDetail.policyCard.withheldReason.${tool.reason}`, {
                            requires: tool.requires,
                            permits: tool.permits,
                        })}
                        {'. '}
                        {t(`agentDetail.policyCard.withheldRemedy.${tool.reason}`, {
                            requires: tool.requires,
                        })}
                    </span>
                </li>
            ))}
        </ul>
    );
}

/** The card in force: the head's own facts, the declarations, and the edit. */
function InForcePanel({ payload, onEdit }: { payload: CardPayload; onEdit: () => void }) {
    const t = useTranslations('admin');
    const { card } = payload;

    return (
        <Card density="compact" className="space-y-default">
            <div className="flex flex-wrap items-center justify-between gap-compact">
                <div className="flex flex-wrap items-center gap-compact">
                    <Heading level={2}>{t('agentDetail.policyCard.heading')}</Heading>
                    <StatusBadge variant="info" size="sm">
                        {t('agentDetail.policyCard.versionBadge', {
                            version: card.currentVersion,
                        })}
                    </StatusBadge>
                </div>
                <Button
                    variant="secondary"
                    size="sm"
                    id="agent-policy-card-edit-btn"
                    // A card whose version in force cannot be read is a card the
                    // usecase refuses to edit — the ladder has nothing to measure
                    // a step against. Offering the button anyway would spend the
                    // operator's attention on a dialog that only ever 409s.
                    disabled={card.inForce === null}
                    onClick={onEdit}
                >
                    {t('agentDetail.policyCard.editAction')}
                </Button>
            </div>

            {card.inForce === null ? (
                <InlineNotice
                    variant="error"
                    title={t('agentDetail.policyCard.inForceMissingTitle')}
                >
                    {t('agentDetail.policyCard.inForceMissingBody', {
                        version: card.currentVersion,
                    })}
                </InlineNotice>
            ) : (
                <CardDeclarations value={toCardValue(card.inForce)} />
            )}

            <dl className="flex flex-wrap gap-default border-t border-border-subtle pt-3">
                <div className="space-y-tight">
                    <dt className="text-xs uppercase tracking-wide text-content-subtle">
                        {t('agentDetail.policyCard.fieldUsage')}
                    </dt>
                    <dd className="text-sm text-content-emphasis">
                        {card.usageWindowDate === null
                            ? t('agentDetail.policyCard.usageNotStarted')
                            : t('agentDetail.policyCard.usageCount', {
                                  count: card.actionsInWindow,
                                  date: formatDate(card.usageWindowDate),
                              })}
                    </dd>
                </div>
                <div className="space-y-tight">
                    <dt className="text-xs uppercase tracking-wide text-content-subtle">
                        {t('agentDetail.policyCard.fieldCreated')}
                    </dt>
                    <dd className="text-sm text-content-emphasis">
                        {formatDateTime(card.createdAt)}
                    </dd>
                </div>
                <div className="space-y-tight">
                    <dt className="text-xs uppercase tracking-wide text-content-subtle">
                        {t('agentDetail.policyCard.fieldUpdated')}
                    </dt>
                    <dd className="text-sm text-content-emphasis">
                        {formatDateTime(card.updatedAt)}
                    </dd>
                </div>
            </dl>
        </Card>
    );
}

/**
 * The seven declarations of one card value.
 *
 * A hand-rolled `<dl>` rather than `<MetadataBar>` / `<TabSection>`: both exist
 * with zero call sites repo-wide, and this tab is not the place to become their
 * only adopter. The shape is the one `EvidenceDetailSheet` and the risk tab
 * already use.
 */
function CardDeclarations({ value }: { value: AgentPolicyCardValue }) {
    const t = useTranslations('admin');

    return (
        <dl className="grid gap-default sm:grid-cols-2">
            <div className="space-y-tight sm:col-span-2">
                <dt className="text-xs uppercase tracking-wide text-content-subtle">
                    {t('agentDetail.policyCard.fieldTools')}
                </dt>
                {/* Mono text, not a badge each. A tool name is an identifier out
                    of the audit vocabulary, not a state — a row of pills that
                    never change colour spends the eye's one loud slot on a list,
                    and up to two of these lists are on screen at once (the card
                    in force, and the oldest listed version). The comma-joined
                    run is the treatment `changeToolsAdded` already gives the
                    same names one panel down. */}
                {value.permittedTools.length === 0 ? (
                    <dd className="text-sm text-content-muted">
                        {t('agentDetail.policyCard.noToolsPermitted')}
                    </dd>
                ) : (
                    <dd className="font-mono text-sm text-content-emphasis">
                        {value.permittedTools.join(', ')}
                    </dd>
                )}
            </div>

            <Declaration
                label={t('agentDetail.policyCard.fieldDataScope')}
                value={value.maxDataScope}
            />
            <Declaration
                label={t('agentDetail.policyCard.fieldAutonomy')}
                value={t('agentDetail.policyCard.autonomyValue', {
                    level: value.maxAutonomyLevel,
                })}
            />
            <Declaration
                label={t('agentDetail.policyCard.fieldPerRun')}
                value={String(value.maxActionsPerRun)}
            />
            <Declaration
                label={t('agentDetail.policyCard.fieldPerDay')}
                value={String(value.maxActionsPerDay)}
            />
            <Declaration
                label={t('agentDetail.policyCard.fieldApproval')}
                value={value.approvalRung}
            />

            <div className="space-y-tight sm:col-span-2">
                <dt className="text-xs uppercase tracking-wide text-content-subtle">
                    {t('agentDetail.policyCard.fieldTriggers')}
                </dt>
                {/* Mono text rather than a warning badge per rule, and the tone
                    was the bigger error: a DECLARED trigger is the safe state —
                    something wakes a human. Painting each one amber said the
                    opposite of the empty case below it, which is the widening
                    and the only thing here that warrants the colour. */}
                {value.escalationTriggers.length === 0 ? (
                    // A card that escalates on nothing is a legible state, and a
                    // widening — every refusal still audits, but nothing wakes
                    // anybody. Said plainly rather than shown as an empty row.
                    <dd className="text-sm text-content-warning">
                        {t('agentDetail.policyCard.noEscalationTriggers')}
                    </dd>
                ) : (
                    <dd className="font-mono text-sm text-content-emphasis">
                        {value.escalationTriggers.join(', ')}
                    </dd>
                )}
            </div>
        </dl>
    );
}

function Declaration({ label, value }: { label: string; value: string }) {
    return (
        <div className="space-y-tight">
            <dt className="text-xs uppercase tracking-wide text-content-subtle">{label}</dt>
            <dd className="font-mono text-sm text-content-emphasis">{value}</dd>
        </div>
    );
}

/**
 * Every version, newest first, and what each one moved.
 *
 * The deltas are `comparePolicyCards` between consecutive rows — the same
 * comparison the ladder is measured with, so the trail cannot describe a step
 * differently from the rule that allowed it.
 */
function VersionHistory({ versions, head }: { versions: PolicyCardVersionRow[]; head: number }) {
    const t = useTranslations('admin');

    if (versions.length === 0) {
        // Unreachable through the product: a card is created with its version 1
        // in one nested write. Rendered honestly anyway rather than as a card
        // with a silently empty trail.
        return (
            <Card density="compact">
                <InlineEmptyState
                    icon={ShieldKeyhole}
                    title={t('agentDetail.policyCard.noVersions')}
                    description={t('agentDetail.policyCard.noVersionsDescription')}
                />
            </Card>
        );
    }

    /** Newest first, so the trail's far end is the last row. */
    const oldest = versions[versions.length - 1];

    return (
        <Card density="compact" className="space-y-compact">
            <Heading level={2}>{t('agentDetail.policyCard.historyHeading')}</Heading>
            <p className="max-w-3xl text-sm text-content-muted">
                {t('agentDetail.policyCard.historyIntro')}
            </p>
            {/* `length >= VERSION_PAGE` is not the test. The rows come back
                newest-first and capped at 200, so a card with EXACTLY 200
                versions fills the page and is nonetheless complete — the count
                alone would tell that operator versions are missing when none
                are. The oldest listed row's own number settles it: reaching v1
                means the trail is whole, whatever the window is. */}
            {oldest.version !== 1 && (
                <p className="text-xs text-content-subtle">
                    {t('agentDetail.policyCard.historyCapped', { count: VERSION_PAGE })}
                </p>
            )}
            <ul className="space-y-compact">
                {versions.map((version, index) => (
                    <VersionRow
                        key={version.id}
                        version={version}
                        // Newest first, so the row BELOW is the one this
                        // version was appended after. The last row has nothing
                        // below it — either because it IS version 1 or because
                        // the window cut the trail — so it shows what it
                        // declares instead of a comparison it cannot make. The
                        // row itself tells the two apart from its own version
                        // number; see `windowEdge`.
                        previous={versions[index + 1]}
                        inForce={version.version === head}
                    />
                ))}
            </ul>
        </Card>
    );
}

function VersionRow({
    version,
    previous,
    inForce,
}: {
    version: PolicyCardVersionRow;
    previous: PolicyCardVersionRow | undefined;
    inForce: boolean;
}) {
    const t = useTranslations('admin');

    const deltas = useMemo(
        () => (previous ? comparePolicyCards(toCardValue(previous), toCardValue(version)) : []),
        [previous, version],
    );

    /**
     * The row below is missing for two different reasons, and the difference is
     * on the row itself rather than in the window size: version 1 IS the origin,
     * and anything else with nothing below it is the edge of a capped window —
     * v200 of 400, which would otherwise render exactly as a first version does.
     * The count of listed rows cannot tell them apart (a card with exactly 200
     * versions is not capped); the version NUMBER can, and always.
     */
    const windowEdge = previous === undefined && version.version !== 1;

    /**
     * Only ever computed against a version that IS below this one. A row with
     * nothing below it gets no direction badge: "no change" and "the row it
     * moved from is outside the listed window" are different facts, and the
     * badge can only honestly say the first.
     */
    const direction: { key: string; variant: StatusBadgeVariant } | null =
        previous === undefined
            ? null
            : deltas.some((delta) => delta.rungs > 0)
              ? { key: 'agentDetail.policyCard.widenedBadge', variant: 'warning' }
              : deltas.length > 0
                ? { key: 'agentDetail.policyCard.narrowedBadge', variant: 'success' }
                : { key: 'agentDetail.policyCard.unchangedBadge', variant: 'neutral' };

    return (
        <li className="rounded-lg border border-border-subtle p-3 space-y-tight">
            <div className="flex flex-wrap items-center gap-tight">
                <span className="font-mono text-sm text-content-emphasis">
                    {t('agentDetail.policyCard.versionLabel', { version: version.version })}
                </span>
                {inForce && (
                    <StatusBadge variant="info" size="sm">
                        {t('agentDetail.policyCard.inForceBadge')}
                    </StatusBadge>
                )}
                {version.seeded ? (
                    <StatusBadge variant="neutral" size="sm">
                        {version.seededFromTier
                            ? t('agentDetail.policyCard.seededFromBadge', {
                                  tier: version.seededFromTier,
                              })
                            : t('agentDetail.policyCard.seededBadge')}
                    </StatusBadge>
                ) : direction !== null ? (
                    <StatusBadge variant={direction.variant} size="sm">
                        {t(direction.key)}
                    </StatusBadge>
                ) : null}
                <span className="text-xs text-content-subtle">
                    {formatDateTime(version.createdAt)}
                </span>
            </div>

            {previous === undefined ? (
                <>
                    {windowEdge && (
                        <p className="text-xs text-content-subtle">
                            {t('agentDetail.policyCard.historyWindowEdge')}
                        </p>
                    )}
                    <CardDeclarations value={toCardValue(version)} />
                </>
            ) : deltas.length === 0 ? (
                <p className="text-xs text-content-muted">
                    {t('agentDetail.policyCard.unchangedBody')}
                </p>
            ) : (
                <ul className="space-y-tight">
                    {deltas.map((delta) => (
                        <DeltaLine
                            key={`${delta.dimension}:${delta.rungs}`}
                            delta={delta}
                            from={toCardValue(previous)}
                            to={toCardValue(version)}
                        />
                    ))}
                </ul>
            )}
        </li>
    );
}

/**
 * One dimension's movement, in the operator's words rather than the library's.
 *
 * `PolicyDelta.detail` is authored English; the values it interpolates are on
 * `from` and `to` anyway, so the sentence is rebuilt here where it can be
 * translated. The set dimensions are derived from the two values rather than
 * from the delta's SIGN, because the sign is inverted between them — a dropped
 * escalation trigger is a widening — and re-deriving that inversion in a second
 * place is how the two disagree.
 */
function DeltaLine({
    delta,
    from,
    to,
}: {
    delta: PolicyDelta;
    from: AgentPolicyCardValue;
    to: AgentPolicyCardValue;
}) {
    const t = useTranslations('admin');

    let detail: string;
    if (delta.dimension === 'permittedTools') {
        detail =
            delta.rungs > 0
                ? t('agentDetail.policyCard.changeToolsAdded', {
                      tools: to.permittedTools
                          .filter((tool) => !from.permittedTools.includes(tool))
                          .join(', '),
                  })
                : t('agentDetail.policyCard.changeToolsRemoved', {
                      tools: from.permittedTools
                          .filter((tool) => !to.permittedTools.includes(tool))
                          .join(', '),
                  });
    } else if (delta.dimension === 'escalationTriggers') {
        detail =
            delta.rungs > 0
                ? t('agentDetail.policyCard.changeTriggersDropped', {
                      triggers: from.escalationTriggers
                          .filter((rule) => !to.escalationTriggers.includes(rule))
                          .join(', '),
                  })
                : t('agentDetail.policyCard.changeTriggersAdded', {
                      triggers: to.escalationTriggers
                          .filter((rule) => !from.escalationTriggers.includes(rule))
                          .join(', '),
                  });
    } else {
        detail = t('agentDetail.policyCard.changeMoved', {
            from: String(from[delta.dimension]),
            to: String(to[delta.dimension]),
        });
    }

    return (
        <li className="text-xs text-content-muted">
            <span className="text-content-default">{t(DIMENSION_LABEL_KEY[delta.dimension])}</span>
            {' — '}
            <span className="font-mono">{detail}</span>
        </li>
    );
}

/**
 * The edit form. Narrowing is free; widening is one rung on one dimension.
 *
 * The rule is applied to the CONTROLS, not only to the submit button: each
 * ladder offers at most one rung above the version in force, and once a
 * widening exists anywhere the remaining ones are disabled. `checkLadderStep`
 * still runs on every keystroke as the final gate — if the controls and the
 * rule ever disagree, the rule wins here rather than at the 400.
 */
function PolicyCardEditor({
    liveCard,
    liveVersion,
    onSave,
    onClose,
}: {
    /** The card in force AS THE PAYLOAD HAS IT NOW — re-read on every render. */
    liveCard: AgentPolicyCardValue;
    /** The head AS THE PAYLOAD HAS IT NOW. Compared against the pin, never used as it. */
    liveVersion: number;
    onSave: (expectedVersion: number, card: AgentPolicyCardValue) => Promise<SaveOutcome>;
    onClose: () => void;
}) {
    const t = useTranslations('admin');

    /**
     * The base this draft is composed against, PINNED when the form opened.
     *
     * The props above cannot be used directly, and the reason is the whole point
     * of the field they feed. `useTenantSWR` revalidates on focus and on
     * reconnect, the `refreshToken` effect calls `mutate()`, and so do the 404
     * and 409 handlers — all of them while this form is open. Reading `base` and
     * `baseVersion` from the live payload therefore re-bases an open edit onto a
     * version the operator never saw: `comparePolicyCards` measures the step
     * from the NEW card, `checkLadderStep` passes because that step looks like
     * one rung, and the PUT carries the NEW `expectedVersion`, which the
     * server's `expectedVersion !== card.currentVersion` check then accepts.
     * Concretely: A widens data scope against v3 while B saves autonomy into v4;
     * A's tab refocuses, and A's save reverts B's widening with no conflict
     * anywhere. That is exactly the collision `expectedVersion` exists to refuse,
     * arriving through the client that was supposed to hold the base still.
     *
     * `key={liveVersion}` on the mount would also stop the re-base — by
     * remounting and destroying the draft. Pinning keeps the operator's work and
     * turns the movement into what it actually is: a conflict, reported before
     * the save rather than as a refusal after it.
     */
    const [pinned] = useState(() => ({ card: liveCard, version: liveVersion }));
    const base = pinned.card;
    const baseVersion = pinned.version;

    const [draft, setDraft] = useState<AgentPolicyCardValue>(base);
    const [saving, setSaving] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);

    /**
     * The card moved under this edit. Not while a save is in flight: this
     * component's OWN successful PUT moves the head, and `mutate()` lands before
     * the modal closes — reporting that frame as somebody else's conflict would
     * be a lie in a loud colour.
     */
    const moved = !saving && liveVersion !== baseVersion;

    const deltas = useMemo(() => comparePolicyCards(base, draft), [base, draft]);
    const widenings = useMemo(() => deltas.filter((delta) => delta.rungs > 0), [deltas]);
    const refusal = useMemo(() => checkLadderStep(base, draft), [base, draft]);

    /** The dimension this edit spends its one widening on, if it has spent it. */
    const widenedDimension: PolicyDimension | null = widenings[0]?.dimension ?? null;
    const widenLockedFor = (dimension: PolicyDimension) =>
        widenedDimension !== null && widenedDimension !== dimension;

    /**
     * Tools the DRAFT permits but its own ceilings refuse on every call — the
     * same predicate `assertDeclarationsExercisable` throws on. Reachable
     * without adding anything: narrowing the data rung while leaving a tool that
     * reads tenant data permitted writes a card that refuses what it declares.
     */
    const unexercisable = useMemo(
        () =>
            draft.permittedTools
                .map((tool) => withholdingReasonForTool(tool, draft))
                .filter((withheld): withheld is WithheldTool => withheld !== null),
        [draft],
    );

    const catalogue = useMemo(
        () => Array.from(new Set([...MCP_TOOL_NAMES, ...base.permittedTools])).sort(),
        [base.permittedTools],
    );

    const toolsAdded = draft.permittedTools.filter(
        (tool) => !base.permittedTools.includes(tool),
    ).length;
    const triggersDropped = base.escalationTriggers.filter(
        (rule) => !draft.escalationTriggers.includes(rule),
    ).length;

    // `moved` blocks too: the pinned base is gone, so this draft can no longer
    // be measured against anything the server would accept. Re-basing it here
    // is the one repair that is not ours to make.
    const blocked =
        moved || refusal !== null || unexercisable.length > 0 || deltas.length === 0;

    const submit = useCallback(async () => {
        setSaving(true);
        setFailure(null);
        const outcome = await onSave(baseVersion, draft);
        setSaving(false);
        if (outcome.ok) {
            onClose();
            return;
        }
        setFailure(outcome.message);
    }, [onSave, baseVersion, draft, onClose]);

    const toggleTool = (tool: string, next: boolean) => {
        setDraft((current) => ({
            ...current,
            permittedTools: next
                ? [...current.permittedTools, tool]
                : current.permittedTools.filter((name) => name !== tool),
        }));
    };

    const toggleTrigger = (rule: PolicyCardRule, next: boolean) => {
        setDraft((current) => ({
            ...current,
            escalationTriggers: next
                ? [...current.escalationTriggers, rule]
                : current.escalationTriggers.filter((name) => name !== rule),
        }));
    };

    return (
        <Modal
            showModal
            setShowModal={(open) => {
                if (!open && !saving) onClose();
            }}
            size="lg"
            preventDefaultClose={saving}
        >
            <Modal.Header
                title={t('agentDetail.policyCard.editTitle')}
                description={t('agentDetail.policyCard.editIntro')}
            />
            <Modal.Body>
                <div className="space-y-default">
                    {moved ? (
                        // Whatever else may have failed, this is the only thing
                        // the operator can act on: the base is gone, so the
                        // change has to be reapplied on top of what replaced it.
                        <InlineNotice variant="error">
                            {t('agentDetail.policyCard.conflictErrorVersion', {
                                version: liveVersion,
                            })}
                        </InlineNotice>
                    ) : failure ? (
                        <InlineNotice variant="error">{failure}</InlineNotice>
                    ) : null}

                    <div className="space-y-tight">
                        <p className="text-xs text-content-subtle">
                            {t('agentDetail.policyCard.basedOn', { version: baseVersion })}
                        </p>
                        {/* Said out loud because the controls cannot enforce it.
                            Two ceilings that bound this card are not on this
                            payload — the assessed tier's autonomy cap and the
                            agent's registered data scope — so `LadderField`
                            offers a rung the save then refuses, and for autonomy
                            it can refuse an edit that raises nothing (that check
                            judges the resulting VALUE, not the step, so a card
                            left above a lowered cap is stuck until it comes back
                            under). An operator who was not told reads that as a
                            broken control; one who was reads it as the rule it
                            is. Pre-empting it needs `riskTier` and
                            `dataAccessScope` on this payload — see the tab
                            docstring. */}
                        <p className="text-xs text-content-subtle">
                            {t('agentDetail.policyCard.ceilingsElsewhereHint')}
                        </p>
                    </div>

                    {widenedDimension !== null && (
                        <InlineNotice variant="info">
                            {t('agentDetail.policyCard.widenSpent', {
                                dimension: t(DIMENSION_LABEL_KEY[widenedDimension]),
                            })}
                        </InlineNotice>
                    )}

                    {refusal && (
                        <InlineNotice variant="error">
                            {t(`agentDetail.policyCard.ladderRefusal.${refusal.reason}`)}
                        </InlineNotice>
                    )}

                    {unexercisable.length > 0 && (
                        // Every offending tool, not just the first. Narrowing the
                        // data rung can strand several at once, and naming one
                        // makes the operator fix it only to meet the next — the
                        // list is what the save is actually refusing.
                        <InlineNotice
                            variant="error"
                            title={t('agentDetail.policyCard.unexercisableTitle')}
                        >
                            <span className="block">
                                {t('agentDetail.policyCard.unexercisableIntro')}
                            </span>
                            <WithheldToolList withheld={unexercisable} />
                        </InlineNotice>
                    )}

                    <LadderField
                        id="agent-policy-card-data-scope"
                        label={t('agentDetail.policyCard.fieldDataScope')}
                        ladder={DATA_SCOPE_LADDER}
                        base={base.maxDataScope}
                        value={draft.maxDataScope}
                        widenLocked={widenLockedFor('maxDataScope')}
                        onSelect={(raw) => {
                            const scope = DATA_SCOPE_LADDER.find((rung) => rung === raw);
                            if (scope) setDraft((current) => ({ ...current, maxDataScope: scope }));
                        }}
                    />

                    <LadderField
                        id="agent-policy-card-autonomy"
                        label={t('agentDetail.policyCard.fieldAutonomy')}
                        ladder={AUTONOMY_LADDER}
                        base={base.maxAutonomyLevel}
                        value={draft.maxAutonomyLevel}
                        widenLocked={widenLockedFor('maxAutonomyLevel')}
                        onSelect={(raw) => {
                            const level = AUTONOMY_LADDER.find((rung) => String(rung) === raw);
                            if (level !== undefined) {
                                setDraft((current) => ({ ...current, maxAutonomyLevel: level }));
                            }
                        }}
                    />

                    <LadderField
                        id="agent-policy-card-per-run"
                        label={t('agentDetail.policyCard.fieldPerRun')}
                        ladder={ACTION_CAP_LADDER}
                        base={base.maxActionsPerRun}
                        value={draft.maxActionsPerRun}
                        widenLocked={widenLockedFor('maxActionsPerRun')}
                        onSelect={(raw) => {
                            const cap = toActionCap(raw);
                            if (cap !== null) {
                                setDraft((current) => ({ ...current, maxActionsPerRun: cap }));
                            }
                        }}
                    />

                    <LadderField
                        id="agent-policy-card-per-day"
                        label={t('agentDetail.policyCard.fieldPerDay')}
                        ladder={ACTION_CAP_LADDER}
                        base={base.maxActionsPerDay}
                        value={draft.maxActionsPerDay}
                        widenLocked={widenLockedFor('maxActionsPerDay')}
                        onSelect={(raw) => {
                            const cap = toActionCap(raw);
                            if (cap !== null) {
                                setDraft((current) => ({ ...current, maxActionsPerDay: cap }));
                            }
                        }}
                    />

                    <LadderField
                        id="agent-policy-card-approval"
                        label={t('agentDetail.policyCard.fieldApproval')}
                        ladder={APPROVAL_LADDER}
                        base={base.approvalRung}
                        value={draft.approvalRung}
                        widenLocked={widenLockedFor('approvalRung')}
                        onSelect={(raw) =>
                            setDraft((current) => ({
                                ...current,
                                // Membership-narrowed, never cast: the same
                                // helper the boundary reads a stored rung with.
                                approvalRung: narrowApprovalRung(raw),
                            }))
                        }
                    />

                    <div className="space-y-tight">
                        <Heading level={3}>{t('agentDetail.policyCard.fieldTools')}</Heading>
                        <p className="text-xs text-content-muted">
                            {t('agentDetail.policyCard.toolsHint')}
                        </p>
                        {/* The label WRAPS the control rather than pointing at
                            it with `htmlFor`: doing both makes a click on the
                            box itself ambiguous, and the implicit association
                            is what the radio groups above already use. */}
                        <div className="grid gap-tight sm:grid-cols-2">
                            {catalogue.map((tool) => {
                                const checked = draft.permittedTools.includes(tool);
                                const unreachable =
                                    !checked && withholdingReasonForTool(tool, draft) !== null;
                                return (
                                    <label
                                        key={tool}
                                        className="flex cursor-pointer items-center gap-tight text-sm text-content-default"
                                    >
                                        <Checkbox
                                            id={`agent-policy-card-tool-${tool}`}
                                            size="sm"
                                            checked={checked}
                                            // Adding a tool is a rung, and a
                                            // second one is a second rung. A
                                            // tool the draft's own ceilings
                                            // refuse is offered to nobody: the
                                            // usecase would reject the whole
                                            // card by name.
                                            disabled={
                                                !checked &&
                                                (unreachable ||
                                                    toolsAdded >= 1 ||
                                                    widenLockedFor('permittedTools'))
                                            }
                                            onCheckedChange={(next) =>
                                                toggleTool(tool, next === true)
                                            }
                                        />
                                        <span className="font-mono text-xs">{tool}</span>
                                    </label>
                                );
                            })}
                        </div>
                    </div>

                    <div className="space-y-tight">
                        <Heading level={3}>{t('agentDetail.policyCard.fieldTriggers')}</Heading>
                        <p className="text-xs text-content-muted">
                            {t('agentDetail.policyCard.triggersHint')}
                        </p>
                        <div className="grid gap-tight sm:grid-cols-2">
                            {POLICY_CARD_RULES.map((rule) => {
                                const checked = draft.escalationTriggers.includes(rule);
                                const declared = base.escalationTriggers.includes(rule);
                                return (
                                    <label
                                        key={rule}
                                        className="flex cursor-pointer items-center gap-tight text-sm text-content-default"
                                    >
                                        <Checkbox
                                            id={`agent-policy-card-trigger-${rule}`}
                                            size="sm"
                                            checked={checked}
                                            // Dropping a declared trigger is the
                                            // widening here; adding one back is
                                            // free. Only the drop is rationed.
                                            disabled={
                                                checked &&
                                                declared &&
                                                (triggersDropped >= 1 ||
                                                    widenLockedFor('escalationTriggers'))
                                            }
                                            onCheckedChange={(next) =>
                                                toggleTrigger(rule, next === true)
                                            }
                                        />
                                        <span className="font-mono text-xs">{rule}</span>
                                    </label>
                                );
                            })}
                        </div>
                    </div>

                    {deltas.length === 0 && (
                        <p className="text-xs text-content-subtle">
                            {t('agentDetail.policyCard.unchangedHint')}
                        </p>
                    )}
                </div>
            </Modal.Body>
            <Modal.Footer>
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={saving}
                    onClick={onClose}
                >
                    {t('agentDetail.policyCard.cancel')}
                </Button>
                <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    loading={saving}
                    disabled={saving || blocked}
                    id="agent-policy-card-save-btn"
                    onClick={() => void submit()}
                >
                    {t('agentDetail.policyCard.saveAction', { version: baseVersion + 1 })}
                </Button>
            </Modal.Footer>
        </Modal>
    );
}

/** Membership-narrowed, so a radio value can only ever be a rung of the ladder. */
function toActionCap(raw: string): ActionCap | null {
    const parsed = Number(raw);
    return Number.isFinite(parsed) && isActionCap(parsed) ? parsed : null;
}

/**
 * One ordinal dimension, as the rungs it may hold.
 *
 * Every rung at or below the version in force is offered — narrowing is never
 * refused — plus exactly ONE above it, which is disabled while another
 * dimension is already the widening this edit spends.
 */
function LadderField<T extends string | number>({
    id,
    label,
    ladder,
    base,
    value,
    widenLocked,
    onSelect,
}: {
    id: string;
    label: string;
    ladder: readonly T[];
    base: T;
    value: T;
    widenLocked: boolean;
    onSelect: (raw: string) => void;
}) {
    // -1 is a stored value this build cannot rank, and `rungOf` reads it as the
    // lowest rung. So does this: nothing above the bottom is offered, which
    // leaves narrowing as the only move — the direction never refused.
    const baseRung = (ladder as readonly (string | number)[]).indexOf(base);
    const offered = ladder.slice(0, baseRung + 2);

    return (
        <FormField label={label}>
            <RadioGroup
                id={id}
                className="flex flex-wrap gap-default"
                value={String(value)}
                onValueChange={onSelect}
            >
                {offered.map((rung, index) => (
                    <label
                        key={String(rung)}
                        className="flex cursor-pointer items-center gap-tight text-sm text-content-default"
                    >
                        <RadioGroupItem
                            value={String(rung)}
                            size="sm"
                            disabled={index > baseRung && widenLocked}
                        />
                        <span className="font-mono text-xs">{String(rung)}</span>
                    </label>
                ))}
            </RadioGroup>
        </FormField>
    );
}
