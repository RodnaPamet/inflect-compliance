'use client';

/**
 * Rule detail sheet (Automation Epic 2).
 *
 * Inline inspect-and-edit panel for a single automation rule — the
 * slide-out detail Archer's workflow manager opens from its rule list.
 * Enable/disable toggle + priority stepper mutate optimistically against
 * the list cache; trigger + action summary cards read the rule's config.
 *
 * The execution history comes from Epic 6; the Edit button opens the
 * builder modal from Epic 3.
 */
import { useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';
import { Sheet } from '@/components/ui/sheet';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { NumberStepper } from '@/components/ui/number-stepper';
import { StatusBadge } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { useToastWithUndo, useToast } from '@/components/ui/hooks';
import { useSWRConfig } from 'swr';
import { useTenantMutation } from '@/lib/hooks/use-tenant-mutation';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl, useTenantContext } from '@/lib/tenant-context-provider';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { ExecutionsPanel } from '@/components/processes/ExecutionsPanel';
import type { AutomationRuleRow } from '@/app/t/[tenantSlug]/(app)/processes/RulesTab';
import type { RuleDetail } from '@/components/processes/RuleBuilderModal';
import type { SubflowGroupItem } from '@/lib/processes/subflow-groups';
import {
    buildRuleActionLabels,
    buildRuleStatusLabels,
} from '@/app/t/[tenantSlug]/(app)/processes/automation-filter-defs';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { InlineNotice } from '@/components/ui/inline-notice';
import { apiErrorMessage } from '@/lib/api-error';
import { extractMutationError } from '@/lib/mutations';

/** `UNSET_TRIGGER_EVENT` in `rule-readiness.ts`: a canvas rule nobody has given a trigger. */
const UNSET_TRIGGER = 'UNSET';

function humanizeEvent(name: string): string {
    return name
        .toLowerCase()
        .split('_')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

const asStr = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const asArr = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);

/** One read-only label → value line in the Configuration card. Values that are
 *  identifiers (status enums, entity types, operators) render as raw data. */
function ConfigRow({ label, value }: { label: string; value: ReactNode }) {
    return (
        <div className="flex items-start justify-between gap-default">
            <span className="text-sm text-content-muted">{label}</span>
            <span className="text-sm text-content-emphasis text-right break-all">{value}</span>
        </div>
    );
}

export interface RuleDetailSheetProps {
    rule: AutomationRuleRow | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Opens the builder modal in edit mode (Epic 3). */
    onEdit?: (rule: AutomationRuleRow) => void;
    /**
     * May the viewer toggle, re-prioritise, edit or archive the rule? Each takes
     * the Admin tier on the server; without it the sheet is read-only (#4640).
     */
    canManage?: boolean;
}

export function RuleDetailSheet({ rule, open, onOpenChange, onEdit, canManage = false }: RuleDetailSheetProps) {
    const t = useTranslations('processes');
    const RULE_ACTION_LABELS = buildRuleActionLabels((k) => t(k as Parameters<typeof t>[0]));
    // The list row renders "Enabled" via these labels while this sheet printed
    // the raw `ENABLED` — one click apart, two vocabularies.
    const RULE_STATUS_LABELS = buildRuleStatusLabels((k) => t(k as Parameters<typeof t>[0]));
    const apiUrl = useTenantApiUrl();
    const { tenantSlug } = useTenantContext();
    const triggerUndoToast = useToastWithUndo();
    const toast = useToast();
    const { mutate: globalMutate } = useSWRConfig();

    const patchMutation = useTenantMutation<
        AutomationRuleRow[],
        { id: string; status?: 'ENABLED' | 'DISABLED'; priority?: number },
        unknown
    >({
        key: CACHE_KEYS.automation.rules.list(),
        mutationFn: async ({ id, status, priority }) => {
            const res = await fetch(apiUrl(CACHE_KEYS.automation.rules.detail(id)), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status, priority }),
            });
            if (!res.ok) {
                // The API's envelope is `{ error: { code, message } }`, so
                // `err.error` was an OBJECT and the thrown message read
                // "[object Object]". The server's sentence, or ours.
                const refusal: unknown = await res.json().catch(() => null);
                throw new Error(apiErrorMessage(refusal, t('rules.updateFailed')));
            }
            return res.json();
        },
        optimisticUpdate: (current, { id, status, priority }) =>
            (current ?? []).map((r) =>
                r.id === id
                    ? {
                          ...r,
                          ...(status !== undefined ? { status } : {}),
                          ...(priority !== undefined ? { priority } : {}),
                      }
                    : r,
            ),
    });

    // Full config detail — the list row is a thin projection, so the read-only
    // Configuration card fetches the raw AutomationRule columns. Gated on
    // `open && rule` so the sheet only hits the API while it is visible.
    const { data: detail } = useTenantSWR<RuleDetail>(
        open && rule ? CACHE_KEYS.automation.rules.detail(rule.id) : null,
    );
    // Rules list resolves chain rule ids → names (falls back to the id).
    const { data: rulesList } = useTenantSWR<AutomationRuleRow[]>(
        open ? CACHE_KEYS.automation.rules.list() : null,
    );
    const ruleName = (id: string): string =>
        rulesList?.find((r) => r.id === id)?.name ?? id;
    // #5477 — an INVOKE_SUBFLOW target reads as "map › group", not as the raw
    // node key. Fetched only for such a rule; an unknown key shows as stored.
    const { data: subflowGroupList } = useTenantSWR<{ groups: SubflowGroupItem[] }>(
        open && detail?.actionType === 'INVOKE_SUBFLOW' ? CACHE_KEYS.processes.subflowGroups() : null,
    );
    const subflowGroupName = (key: string): string => {
        const g = subflowGroupList?.groups.find((x) => x.nodeKey === key);
        if (!g) return key;
        return t('ruleDetail.subflowTargetOption', {
            map: g.mapName,
            group: g.label.trim() || t('ruleDetail.subflowTargetUnnamed'),
        });
    };

    /*
        The row AS THE LIST CACHE HAS IT NOW, not the snapshot the tab took on
        click. The toggle and the stepper write to that cache (optimistically,
        rolled back on failure), and read from the snapshot they never moved:
        the switch flipped back the moment it was pressed and the stepper
        stayed on its old number, as if neither had done anything.
    */
    const live = (rule && rulesList?.find((r) => r.id === rule.id)) ?? rule;

    /** A toggle or priority change; a refusal is SAID, not an unhandled rejection. */
    const patchRule = (input: { status?: 'ENABLED' | 'DISABLED'; priority?: number }) => {
        if (!rule) return;
        patchMutation.trigger({ id: rule.id, ...input }).catch((err: unknown) => {
            toast.error(extractMutationError(err, t('rules.updateFailed')));
        });
    };

    const isArchived = live?.status === 'ARCHIVED';

    /**
     * Archive the rule after a 5-second undo window (Epic 67).
     *
     * The sheet closes immediately and the row is optimistically restamped
     * ARCHIVED, so the outcome is visible at once; `undoAction` puts the list
     * back if the user takes it back. Because `useToastWithUndo` DEFERS the
     * commit rather than compensating for it, an undo means the DELETE never
     * happens at all — no un-archive endpoint is required.
     */
    const archiveRule = useCallback(() => {
        if (!rule) return;
        const listKey = apiUrl(CACHE_KEYS.automation.rules.list());
        const ruleId = rule.id;
        onOpenChange(false);
        void globalMutate(
            listKey,
            (current?: AutomationRuleRow[]) =>
                (current ?? []).map((r) =>
                    r.id === ruleId ? { ...r, status: 'ARCHIVED' as const } : r,
                ),
            { revalidate: false },
        );
        triggerUndoToast({
            message: t('rules.archived'),
            undoMessage: t('rules.undo'),
            action: async () => {
                const res = await fetch(apiUrl(CACHE_KEYS.automation.rules.detail(ruleId)), {
                    method: 'DELETE',
                });
                if (!res.ok) {
                    const refusal: unknown = await res.json().catch(() => null);
                    throw new Error(apiErrorMessage(refusal, t('rules.archiveFailed')));
                }
            },
            undoAction: () => {
                void globalMutate(listKey);
            },
            onCommit: () => {
                void globalMutate(listKey);
            },
            onError: (err) => {
                // The server's reason when it gave one (#4987).
                toast.error(extractMutationError(err, t('rules.archiveFailed')));
                void globalMutate(listKey);
            },
        });
    }, [rule, apiUrl, globalMutate, triggerUndoToast, t, toast, onOpenChange]);
    const isEnabled = live?.status === 'ENABLED';

    const triggerSummary = useMemo(
        () =>
            rule
                ? rule.triggerEvent === UNSET_TRIGGER
                    ? t('rules.triggerNotSet')
                    : humanizeEvent(rule.triggerEvent)
                : '',
        [rule, t],
    );

    const actionConfig = (detail?.actionConfigJson ?? {}) as Record<string, unknown>;
    // triggerFilterJson is a FilterGroup, a legacy flat map, or null. This
    // read-only sheet summarises the flat LEAF conditions of a group; a legacy
    // map or nested sub-groups don't render as a condition list here (the full
    // shape is preserved for editing on the builder/canvas).
    const triggerFilter = detail?.triggerFilterJson ?? null;
    const filterGroup =
        triggerFilter &&
        typeof triggerFilter === 'object' &&
        'conditions' in triggerFilter &&
        Array.isArray((triggerFilter as { conditions?: unknown }).conditions)
            ? (triggerFilter as {
                  logic?: 'AND' | 'OR';
                  conditions: Array<{ field?: string; operator?: string; value?: unknown }>;
              })
            : null;
    const filterConditions = (filterGroup?.conditions ?? []).filter(
        (c): c is { field: string; operator: string; value: unknown } =>
            !!c && typeof c === 'object' && typeof (c as { field?: unknown }).field === 'string',
    );
    const webhookHeaders = Object.keys(
        (actionConfig.headers as Record<string, string> | undefined) ?? {},
    );
    // #3471 — the KEYS and the FIELDS they read, both shown. Which input key an
    // agent is fed is the part an operator reviewing a rule has to be able to
    // see: it is the whole of what reaches prompt assembly.
    const agentInputMapping = Object.entries(
        (actionConfig.inputMapping as Record<string, string> | undefined) ?? {},
    ).map(([k, v]) => `${k} ← ${v}`);

    return (
        <Sheet
            open={open}
            onOpenChange={onOpenChange}
            title={rule?.name ?? t('rules.resSingular')}
            description={t('rules.sheetDescription')}
        >
            {rule && live && (
                <>
                    <Sheet.Header title={rule.name} />
                    <Sheet.Body>
                        <div className="space-y-default">
                            {/* Status + enable toggle */}
                            <div className="flex items-center justify-between gap-default">
                                <div className="flex items-center gap-compact">
                                    <StatusBadge
                                        variant={isEnabled ? 'success' : 'neutral'}
                                    >
                                        {RULE_STATUS_LABELS[live.status] ?? live.status}
                                    </StatusBadge>
                                </div>
                                <label className="flex items-center gap-compact text-sm text-content-muted">
                                    {isEnabled ? RULE_STATUS_LABELS.ENABLED : RULE_STATUS_LABELS.DISABLED}
                                    <Switch
                                        checked={isEnabled}
                                        disabled={!canManage || isArchived || patchMutation.isMutating}
                                        onCheckedChange={(checked) =>
                                            patchRule({ status: checked ? 'ENABLED' : 'DISABLED' })
                                        }
                                        aria-label={t('rules.toggleEnabledAria')}
                                    />
                                </label>
                            </div>

                            {/* Trigger summary */}
                            <Card>
                                <div className="space-y-tight">
                                    <p className="text-[11px] uppercase tracking-wide text-content-subtle">
                                        {t('rules.colTrigger')}
                                    </p>
                                    <p className="text-sm text-content-emphasis">
                                        {triggerSummary}
                                    </p>
                                </div>
                            </Card>

                            {/* Action summary */}
                            <Card>
                                <div className="space-y-tight">
                                    <p className="text-[11px] uppercase tracking-wide text-content-subtle">
                                        {t('rules.colAction')}
                                    </p>
                                    <p className="text-sm text-content-emphasis">
                                        {RULE_ACTION_LABELS[rule.actionType] ?? rule.actionType}
                                    </p>
                                </div>
                            </Card>

                            {/* The canvas step that owns this rule. */}
                            {detail?.canvas && (
                                <Card>
                                    <div
                                        className="flex items-center justify-between gap-default"
                                        data-testid="rule-detail-canvas"
                                    >
                                        <div className="min-w-0 space-y-tight">
                                            <p className="text-[11px] uppercase tracking-wide text-content-subtle">
                                                {t('ruleDetail.onCanvas')}
                                            </p>
                                            <p className="truncate text-sm text-content-emphasis">
                                                {detail.canvas.mapName} · {detail.canvas.stepLabel}
                                            </p>
                                        </div>
                                        <Link
                                            href={`/t/${tenantSlug}/processes?activeId=${encodeURIComponent(detail.canvas.mapId)}&step=${encodeURIComponent(detail.canvas.nodeKey)}`}
                                            onClick={() => onOpenChange(false)}
                                            className="shrink-0 text-sm font-medium text-content-info hover:underline"
                                            data-testid="rule-detail-open-on-canvas"
                                        >
                                            {t('ruleDetail.openOnCanvas')}
                                        </Link>
                                    </div>
                                </Card>
                            )}

                            {/* What it still needs; enabling is refused until it has it. */}
                            {(detail?.readiness?.length ?? 0) > 0 && live.status !== 'ENABLED' && (
                                <div data-testid="rule-detail-readiness">
                                    <InlineNotice variant="warning" title={t('ruleDetail.notReadyTitle')}>
                                        <ul className="list-disc pl-4 text-sm">
                                            {detail!.readiness!.map((p) => (
                                                <li key={p}>{t(`ruleDetail.readiness.${p}`)}</li>
                                            ))}
                                        </ul>
                                    </InlineNotice>
                                </div>
                            )}

                            {/* Full read-only configuration */}
                            {detail && (
                                <Card>
                                    <div className="space-y-default">
                                        <p className="text-[11px] uppercase tracking-wide text-content-subtle">
                                            {t('ruleDetail.configuration')}
                                        </p>

                                        {/* Trigger filter */}
                                        {filterConditions.length > 0 && (
                                            <div className="space-y-tight">
                                                <p className="text-xs font-medium text-content-muted">
                                                    {t('ruleDetail.triggerFilter')}
                                                </p>
                                                {filterGroup?.logic && (
                                                    <ConfigRow
                                                        label={t('ruleDetail.matchLogic')}
                                                        value={filterGroup.logic}
                                                    />
                                                )}
                                                <ul className="space-y-tight">
                                                    {filterConditions.map((c, i) => (
                                                        <li
                                                            key={i}
                                                            className="text-sm text-content-emphasis break-all"
                                                        >
                                                            {c.field} {c.operator}{' '}
                                                            {Array.isArray(c.value)
                                                                ? c.value.join(', ')
                                                                : asStr(c.value)}
                                                        </li>
                                                    ))}
                                                </ul>
                                            </div>
                                        )}

                                        {/* Action config */}
                                        <div className="space-y-tight">
                                            <p className="text-xs font-medium text-content-muted">
                                                {t('ruleDetail.actionConfig')}
                                            </p>
                                            {detail.actionType === 'NOTIFY_USER' && (
                                                <>
                                                    {asStr(actionConfig.message) && (
                                                        <ConfigRow
                                                            label={t('ruleDetail.message')}
                                                            value={asStr(actionConfig.message)}
                                                        />
                                                    )}
                                                    {asArr(actionConfig.userIds).length > 0 && (
                                                        <ConfigRow
                                                            label={t('ruleDetail.recipients')}
                                                            value={asArr(actionConfig.userIds).length}
                                                        />
                                                    )}
                                                    {asStr(actionConfig.linkUrl) && (
                                                        <ConfigRow
                                                            label={t('ruleDetail.linkUrl')}
                                                            value={asStr(actionConfig.linkUrl)}
                                                        />
                                                    )}
                                                </>
                                            )}
                                            {detail.actionType === 'CREATE_TASK' && (
                                                <>
                                                    {asStr(actionConfig.title) && (
                                                        <ConfigRow
                                                            label={t('ruleDetail.title')}
                                                            value={asStr(actionConfig.title)}
                                                        />
                                                    )}
                                                    {asStr(actionConfig.severity) && (
                                                        <ConfigRow
                                                            label={t('ruleDetail.severity')}
                                                            value={asStr(actionConfig.severity)}
                                                        />
                                                    )}
                                                    {asStr(actionConfig.priority) && (
                                                        <ConfigRow
                                                            label={t('ruleDetail.priority')}
                                                            value={asStr(actionConfig.priority)}
                                                        />
                                                    )}
                                                    {asStr(actionConfig.assigneeUserId) && (
                                                        <ConfigRow
                                                            label={t('ruleDetail.assignee')}
                                                            value={asStr(actionConfig.assigneeUserId)}
                                                        />
                                                    )}
                                                    {asStr(actionConfig.linkEntityType) && (
                                                        <ConfigRow
                                                            label={t('ruleDetail.linkEntity')}
                                                            value={asStr(actionConfig.linkEntityType)}
                                                        />
                                                    )}
                                                    {asStr(actionConfig.linkEntityIdField) && (
                                                        <ConfigRow
                                                            label={t('ruleDetail.linkEntityField')}
                                                            value={asStr(
                                                                actionConfig.linkEntityIdField,
                                                            )}
                                                        />
                                                    )}
                                                </>
                                            )}
                                            {detail.actionType === 'UPDATE_STATUS' && (
                                                <>
                                                    {(asStr(actionConfig.entityType) ||
                                                        asStr(actionConfig.field)) && (
                                                        <ConfigRow
                                                            label={t('ruleDetail.statusTarget')}
                                                            value={`${asStr(actionConfig.entityType)} · ${asStr(actionConfig.field)}`}
                                                        />
                                                    )}
                                                    {asStr(actionConfig.toStatus) && (
                                                        <ConfigRow
                                                            label={t('ruleDetail.newStatus')}
                                                            value={asStr(actionConfig.toStatus)}
                                                        />
                                                    )}
                                                </>
                                            )}
                                            {detail.actionType === 'WEBHOOK' && (
                                                <>
                                                    {asStr(actionConfig.method) && (
                                                        <ConfigRow
                                                            label={t('ruleDetail.method')}
                                                            value={asStr(actionConfig.method)}
                                                        />
                                                    )}
                                                    {asStr(actionConfig.url) && (
                                                        <ConfigRow
                                                            label={t('ruleDetail.url')}
                                                            value={asStr(actionConfig.url)}
                                                        />
                                                    )}
                                                    {webhookHeaders.length > 0 && (
                                                        <ConfigRow
                                                            label={t('ruleDetail.headers')}
                                                            value={webhookHeaders.join(', ')}
                                                        />
                                                    )}
                                                    {detail.webhookSecretSet === true && (
                                                        <ConfigRow
                                                            label={t('ruleDetail.signingSecret')}
                                                            value={t('ruleDetail.secretSet')}
                                                        />
                                                    )}
                                                </>
                                            )}
                                            {detail.actionType === 'INVOKE_SUBFLOW' &&
                                                asStr(actionConfig.targetGroupId) && (
                                                    <ConfigRow
                                                        label={t('ruleDetail.subflowTarget')}
                                                        value={subflowGroupName(asStr(actionConfig.targetGroupId))}
                                                    />
                                                )}
                                            {detail.actionType === 'INVOKE_AGENT' && (
                                                <>
                                                    {asStr(actionConfig.agentId) && (
                                                        <ConfigRow
                                                            label={t('ruleDetail.agentId')}
                                                            value={asStr(actionConfig.agentId)}
                                                        />
                                                    )}
                                                    {asStr(actionConfig.workflowKey) && (
                                                        <ConfigRow
                                                            label={t('ruleDetail.agentWorkflow')}
                                                            value={asStr(actionConfig.workflowKey)}
                                                        />
                                                    )}
                                                    {agentInputMapping.length > 0 && (
                                                        <ConfigRow
                                                            label={t('ruleDetail.agentInputMapping')}
                                                            value={agentInputMapping.join(', ')}
                                                        />
                                                    )}
                                                </>
                                            )}
                                        </div>

                                        {/* Schedule */}
                                        {detail.scheduleConfigJson && (
                                            <div className="space-y-tight">
                                                <p className="text-xs font-medium text-content-muted">
                                                    {t('ruleDetail.schedule')}
                                                </p>
                                                {detail.scheduleConfigJson.target && (
                                                    <ConfigRow
                                                        label={t('ruleDetail.scheduleTarget')}
                                                        value={detail.scheduleConfigJson.target}
                                                    />
                                                )}
                                                {detail.scheduleConfigJson.offsetDays != null && (
                                                    <ConfigRow
                                                        label={t('ruleDetail.offsetDays')}
                                                        value={String(
                                                            detail.scheduleConfigJson.offsetDays,
                                                        )}
                                                    />
                                                )}
                                            </div>
                                        )}

                                        {/* Stuck-execution timeout (reframed SLA) */}
                                        {detail.slaWindowMinutes != null && (
                                            <div className="space-y-tight">
                                                <p className="text-xs font-medium text-content-muted">
                                                    {t('ruleDetail.stuckTimeout')}
                                                </p>
                                                <ConfigRow
                                                    label={t('ruleDetail.timeoutWindow')}
                                                    value={String(detail.slaWindowMinutes)}
                                                />
                                                {detail.slaBreachActionType && (
                                                    <ConfigRow
                                                        label={t('ruleDetail.breachAction')}
                                                        value={detail.slaBreachActionType}
                                                    />
                                                )}
                                                {/* Breach action config — show WHO gets
                                                    notified and WHAT, not just the action
                                                    type, so the read view reflects the full
                                                    configured breach behavior. */}
                                                {(detail.slaBreachConfigJson?.userIds?.length ?? 0) > 0 && (
                                                    <ConfigRow
                                                        label={t('ruleDetail.breachRecipients')}
                                                        value={detail.slaBreachConfigJson!.userIds!.length}
                                                    />
                                                )}
                                                {detail.slaBreachConfigJson?.message && (
                                                    <ConfigRow
                                                        label={t('ruleDetail.breachMessage')}
                                                        value={detail.slaBreachConfigJson.message}
                                                    />
                                                )}
                                            </div>
                                        )}

                                        {/* Chain */}
                                        {(detail.nextRuleId || detail.elseRuleId) && (
                                            <div className="space-y-tight">
                                                <p className="text-xs font-medium text-content-muted">
                                                    {t('ruleDetail.chain')}
                                                </p>
                                                {detail.nextRuleId && (
                                                    <ConfigRow
                                                        label={t('ruleDetail.nextRule')}
                                                        value={ruleName(detail.nextRuleId)}
                                                    />
                                                )}
                                                {detail.nextRuleId &&
                                                    detail.nextRuleDelay != null && (
                                                        <ConfigRow
                                                            label={t('ruleDetail.delay')}
                                                            value={String(detail.nextRuleDelay)}
                                                        />
                                                    )}
                                                {detail.elseRuleId && (
                                                    <ConfigRow
                                                        label={t('ruleDetail.elseRule')}
                                                        value={ruleName(detail.elseRuleId)}
                                                    />
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </Card>
                            )}

                            {/* Priority */}
                            <div className="flex items-center justify-between gap-default">
                                <span className="text-sm text-content-muted">{t('rules.colPriority')}</span>
                                <NumberStepper
                                    value={live.priority}
                                    min={0}
                                    max={1000}
                                    disabled={!canManage || isArchived || patchMutation.isMutating}
                                    onChange={(value) => patchRule({ priority: value })}
                                    aria-label={t('rules.priorityAria')}
                                />
                            </div>

                            {/* Execution history (Epic 6). Running a rule by hand is
                                Monitor's "Test a rule", which says what happened. */}
                            <Card>
                                <ExecutionsPanel ruleId={rule.id} />
                            </Card>
                        </div>
                    </Sheet.Body>
                    <Sheet.Actions align="between">
                        <Sheet.Close asChild>
                            <Button variant="ghost">{t('rules.close')}</Button>
                        </Sheet.Close>
                        <div className="flex items-center gap-tight">
                            {/* `AutomationRuleStatus.ARCHIVED` and
                                `DELETE /automation/rules/[id]` →
                                `archiveAutomationRule` both shipped; NO UI ever
                                called the route, so a rule could be DRAFT,
                                ENABLED or DISABLED but never archived — the enum
                                member, the STATUS_VARIANT entry, the status
                                filter option and this sheet's own `isArchived`
                                branches were all unreachable.
                                Epic 67 wiring rather than a bare DELETE: an
                                archive is a soft delete with history preserved,
                                which is exactly the reversible-destructive case
                                the undo toast exists for — and the processes
                                surface had zero Epic 67 sites before this. */}
                            {canManage && !isArchived && (
                                <Button variant="ghost" onClick={archiveRule}>
                                    {t('rules.archive')}
                                </Button>
                            )}
                            {canManage && onEdit && !isArchived && (
                                <Button variant="secondary" onClick={() => onEdit(live)}>
                                    {t('rules.edit')}
                                </Button>
                            )}
                        </div>
                    </Sheet.Actions>
                </>
            )}
        </Sheet>
    );
}
