'use client';

/**
 * Rule detail sheet (Automation Epic 2).
 *
 * Inline inspect-and-edit panel for a single automation rule — the
 * slide-out detail Archer's workflow manager opens from its rule list.
 * Enable/disable toggle + priority stepper mutate optimistically against
 * the list cache; trigger + action summary cards read the rule's config.
 *
 * The execution mini-log is a placeholder until Epic 6 (execution history)
 * lands; the Edit button opens the builder modal from Epic 3.
 */
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { Sheet } from '@/components/ui/sheet';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { NumberStepper } from '@/components/ui/number-stepper';
import { StatusBadge } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { useTenantMutation } from '@/lib/hooks/use-tenant-mutation';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { ExecutionsPanel } from '@/components/processes/ExecutionsPanel';
import type { AutomationRuleRow } from '@/app/t/[tenantSlug]/(app)/processes/RulesTab';
import type { RuleDetail } from '@/components/processes/RuleBuilderModal';
import { buildRuleActionLabels } from '@/app/t/[tenantSlug]/(app)/processes/automation-filter-defs';
import { useTranslations } from 'next-intl';

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
}

export function RuleDetailSheet({ rule, open, onOpenChange, onEdit }: RuleDetailSheetProps) {
    const t = useTranslations('processes');
    const RULE_ACTION_LABELS = buildRuleActionLabels((k) => t(k as Parameters<typeof t>[0]));
    const apiUrl = useTenantApiUrl();

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
                const err = await res.json().catch(() => ({ error: 'Update failed' }));
                throw new Error(err.error ?? 'Update failed');
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

    const isArchived = rule?.status === 'ARCHIVED';
    const isEnabled = rule?.status === 'ENABLED';

    const triggerSummary = useMemo(
        () => (rule ? humanizeEvent(rule.triggerEvent) : ''),
        [rule],
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

    return (
        <Sheet
            open={open}
            onOpenChange={onOpenChange}
            title={rule?.name ?? 'Rule'}
            description="Automation rule detail"
        >
            {rule && (
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
                                        {rule.status}
                                    </StatusBadge>
                                </div>
                                <label className="flex items-center gap-compact text-sm text-content-muted">
                                    {isEnabled ? 'Enabled' : 'Disabled'}
                                    <Switch
                                        checked={isEnabled}
                                        disabled={isArchived || patchMutation.isMutating}
                                        onCheckedChange={(checked) =>
                                            patchMutation.trigger({
                                                id: rule.id,
                                                status: checked ? 'ENABLED' : 'DISABLED',
                                            })
                                        }
                                        aria-label="Toggle rule enabled"
                                    />
                                </label>
                            </div>

                            {/* Trigger summary */}
                            <Card>
                                <div className="space-y-tight">
                                    <p className="text-[11px] uppercase tracking-wide text-content-subtle">
                                        Trigger
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
                                        Action
                                    </p>
                                    <p className="text-sm text-content-emphasis">
                                        {RULE_ACTION_LABELS[rule.actionType] ?? rule.actionType}
                                    </p>
                                </div>
                            </Card>

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
                                                    {asStr(actionConfig.secretRef) && (
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
                                                        value={asStr(actionConfig.targetGroupId)}
                                                    />
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
                                <span className="text-sm text-content-muted">Priority</span>
                                <NumberStepper
                                    value={rule.priority}
                                    min={0}
                                    max={1000}
                                    disabled={isArchived || patchMutation.isMutating}
                                    onChange={(value) =>
                                        patchMutation.trigger({ id: rule.id, priority: value })
                                    }
                                    aria-label="Rule priority"
                                />
                            </div>

                            {/* Execution history (Epic 6) — list + re-trigger. */}
                            <Card>
                                <ExecutionsPanel ruleId={rule.id} ruleEnabled={isEnabled} />
                            </Card>
                        </div>
                    </Sheet.Body>
                    <Sheet.Actions align="between">
                        <Sheet.Close asChild>
                            <Button variant="ghost">Close</Button>
                        </Sheet.Close>
                        {onEdit && !isArchived && (
                            <Button variant="secondary" onClick={() => onEdit(rule)}>
                                Edit
                            </Button>
                        )}
                    </Sheet.Actions>
                </>
            )}
        </Sheet>
    );
}
