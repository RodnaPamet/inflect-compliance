'use client';

/**
 * Automation inspector panel (Visual Rule Editor VR-4).
 *
 * What a selected step on an automation canvas configures, edited in place.
 * The panel edits the RULE (logic lives on `AutomationRule`, per the VR-3
 * invariant); it never writes logic back onto the step.
 *
 * ═══ WHICH RULE ═══
 *
 * An Action or Agent step OWNS a rule (`dataJson.ruleId`, written by the
 * canvas sync when the map is saved). A Trigger, Condition or SLA step owns
 * none: it configures the rule of each Action or Agent step it leads to, and
 * the caller resolves those with `canvas-rule-wiring.ts`. So a Trigger's event
 * picker sets `triggerEvent` on every rule it feeds, and an SLA step's window
 * sets `slaWindowMinutes`.
 *
 * Before this, the panel took ONE `ruleId`, which only owning steps have, so a
 * Trigger or Condition step could only say it was not synced: the steps that
 * describe a rule could not describe it.
 *
 * ═══ WHAT IS EDITED HERE, AND WHAT OPENS THE RULE BUILDER ═══
 *
 * The rule's event, name, enabled state and SLA window are single fields and
 * are edited here. An action's settings and a condition's filter are forms with
 * required fields and their own validation, which the rule builder already
 * has; the panel opens it for that rule rather than keeping a second copy.
 *
 * Enabling an incomplete rule is refused by the server, which also says what
 * is missing (`readiness`); the panel lists it, so the reason is on the step.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useSWRConfig } from 'swr';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { InlineNotice } from '@/components/ui/inline-notice';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { eventOptionsByDomain } from '@/lib/automation/event-labels';
import { useToast } from '@/components/ui/hooks';
import { apiErrorMessage } from '@/lib/api-error';
import { RuleBuilderModal, type RuleBuilderModalProps } from './RuleBuilderModal';

/**
 * A rules-list row, as the builder takes it. Named through the builder's props
 * rather than imported from the Rules tab: a component must not import from a
 * route directory.
 */
type AutomationRuleRow = NonNullable<RuleBuilderModalProps['editRule']>;

export type AutomationKind = 'trigger' | 'condition' | 'action' | 'slaGate' | 'agent';

/** The kinds that own a rule; the rest configure the rule they lead to. */
const OWNING: ReadonlySet<AutomationKind> = new Set(['action', 'agent']);

type ReadinessProblem = 'TRIGGER_NOT_SET' | 'SCHEDULE_NOT_SET' | 'ACTION_INCOMPLETE';

interface Rule {
    id: string;
    name: string;
    description: string | null;
    triggerEvent: string;
    triggerFilterJson: unknown;
    actionType: string;
    actionConfigJson: unknown;
    status: string;
    slaWindowMinutes: number | null;
    /** What the rule still lacks before it can run; from the server. */
    readiness?: ReadinessProblem[];
}

/** Surface-namespace resolver (`useTranslations('automation.autoInspector')`). */
type AutoTranslate = ReturnType<typeof useTranslations>;

/**
 * Every `AutomationActionType`, so a sub-flow rule renders its name rather than
 * an empty control. Keep in lockstep with the Prisma enum.
 */
function buildActionLabels(t: AutoTranslate): Record<string, string> {
    return {
        NOTIFY_USER: t('actionNotify'),
        CREATE_TASK: t('actionCreateTask'),
        UPDATE_STATUS: t('actionUpdateStatus'),
        WEBHOOK: t('actionWebhook'),
        INVOKE_SUBFLOW: t('actionInvokeSubflow'),
        INVOKE_AGENT: t('actionInvokeAgent'),
    };
}

const TRIGGER_OPTIONS: ComboboxOption[] = eventOptionsByDomain().flatMap((g) =>
    g.events.map((ev) => ({ value: ev.name, label: ev.label })),
);

export interface AutomationInspectorPanelProps {
    kind: AutomationKind;
    /**
     * The rules this step configures: its own for an Action or Agent step, or
     * the rules of the steps it leads to for a Trigger, Condition or SLA step.
     */
    ruleIds: string[];
    /**
     * Action or Agent steps this step leads to that have no rule yet, because
     * the map has not been saved since they were added.
     */
    unsavedOwners?: number;
    tenantSlug: string;
    /**
     * May the viewer change these rules? Every write here is the rules API,
     * which takes `admin.manage` and the Admin tier (#5283). Without it the
     * panel shows the rule and offers nothing to change. Defaults to FALSE.
     */
    canManageRules?: boolean;
}

export function AutomationInspectorPanel({
    kind,
    ruleIds,
    unsavedOwners = 0,
    tenantSlug,
    canManageRules = false,
}: AutomationInspectorPanelProps) {
    const t = useTranslations('automation.autoInspector');
    const toast = useToast();
    const actionLabels = useMemo(() => buildActionLabels(t), [t]);
    const apiUrl = useTenantApiUrl();
    const { mutate: globalMutate } = useSWRConfig();
    const owning = OWNING.has(kind);
    const primaryId = ruleIds[0] ?? null;

    const { data: rule, mutate } = useTenantSWR<Rule>(
        primaryId ? CACHE_KEYS.automation.rules.detail(primaryId) : null,
    );
    // The names of every rule a feeding step configures, and the row the
    // builder opens with.
    const { data: rulesList } = useTenantSWR<AutomationRuleRow[]>(
        ruleIds.length > 0 ? CACHE_KEYS.automation.rules.list() : null,
    );
    const rowsById = useMemo(
        () => new Map((rulesList ?? []).map((r) => [r.id, r])),
        [rulesList],
    );

    const [name, setName] = useState('');
    const [sla, setSla] = useState('');
    const [builderRule, setBuilderRule] = useState<AutomationRuleRow | null>(null);
    useEffect(() => {
        setName(rule?.name ?? '');
        setSla(rule?.slaWindowMinutes != null ? String(rule.slaWindowMinutes) : '');
    }, [rule?.id, rule?.name, rule?.slaWindowMinutes]);

    /** Refresh what shows these rules: this panel, the list, the steps' status. */
    async function refresh(ids: string[]) {
        await Promise.all([
            mutate(),
            globalMutate(apiUrl(CACHE_KEYS.automation.rules.list())),
            ...ids.map((id) => globalMutate(apiUrl(CACHE_KEYS.automation.rules.detail(id)))),
        ]);
    }

    /**
     * Apply one change to the given rules. A refusal shows the server's own
     * sentence: enabling an incomplete rule says what is missing, and a generic
     * "not saved" hid that.
     */
    async function patchRules(ids: string[], patch: Record<string, unknown>) {
        if (!canManageRules) return;
        for (const id of ids) {
            const res = await fetch(apiUrl(CACHE_KEYS.automation.rules.detail(id)), {
                // The status toggle goes through PATCH, whose usecase refuses an
                // ARCHIVED rule (#5284). Every other field is the PUT edit.
                method: 'status' in patch ? 'PATCH' : 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(patch),
            });
            if (!res.ok) {
                const refusal: unknown = await res.json().catch(() => null);
                toast.error(apiErrorMessage(refusal, t('saveFailed')));
                break;
            }
        }
        await refresh(ids);
    }

    const triggerSelected = useMemo(
        () => TRIGGER_OPTIONS.find((o) => o.value === rule?.triggerEvent) ?? null,
        [rule?.triggerEvent],
    );
    const actionLabel = rule?.actionType
        ? (actionLabels[rule.actionType] ?? rule.actionType)
        : null;

    if (ruleIds.length === 0) {
        const hint = owning
            ? t('unsyncedHint')
            : unsavedOwners > 0
              ? t('saveToConnect')
              : t('connectHint');
        return (
            <p className="text-sm text-content-muted" data-testid="automation-inspector-unsynced">
                {hint}
            </p>
        );
    }

    const openBuilder = (id: string) => {
        const row = rowsById.get(id);
        if (row) setBuilderRule(row);
    };
    const readiness = rule?.readiness ?? [];

    return (
        <div className="space-y-default" data-testid="automation-inspector">
            <div className="flex items-center justify-between gap-default">
                <span className="text-[11px] uppercase tracking-wide text-content-subtle">
                    {t(`kindRule.${kind}`)}
                </span>
                {owning && (
                    <label className="flex items-center gap-tight text-xs text-content-muted">
                        {rule?.status === 'ENABLED' ? t('enabled') : t('disabled')}
                        <Switch
                            checked={rule?.status === 'ENABLED'}
                            disabled={!canManageRules || rule?.status === 'ARCHIVED'}
                            onCheckedChange={(c) =>
                                patchRules(ruleIds, { status: c ? 'ENABLED' : 'DISABLED' })
                            }
                            aria-label={t('toggleEnabledAria')}
                        />
                    </label>
                )}
            </div>

            {/* A feeding step says which rules it sets, by name. */}
            {!owning && (
                <div className="space-y-tight" data-testid="automation-inspector-fed-rules">
                    <p className="text-xs text-content-muted">
                        {t('configures')}
                    </p>
                    <ul className="space-y-tight">
                        {ruleIds.map((id) => (
                            <li key={id} className="truncate text-sm text-content-emphasis">
                                {rowsById.get(id)?.name ?? id}
                            </li>
                        ))}
                    </ul>
                    {unsavedOwners > 0 && (
                        <p className="text-xs text-content-subtle">{t('saveToConnect')}</p>
                    )}
                </div>
            )}

            {owning && (
                <FormField label={t('ruleName')}>
                    <Input
                        value={name}
                        readOnly={!canManageRules}
                        onChange={(e) => setName(e.target.value)}
                        onBlur={() =>
                            name.trim() &&
                            name !== rule?.name &&
                            patchRules(ruleIds, { name: name.trim() })
                        }
                    />
                </FormField>
            )}

            {kind === 'trigger' && (
                <FormField label={t('triggerEvent')}>
                    <Combobox
                        options={TRIGGER_OPTIONS}
                        selected={triggerSelected}
                        setSelected={(o) => o && patchRules(ruleIds, { triggerEvent: o.value })}
                        disabled={!canManageRules}
                        placeholder={t('selectEvent')}
                        forceDropdown
                        matchTriggerWidth
                    />
                </FormField>
            )}

            {owning && (
                <FormField label={t('actionType')}>
                    <div className="flex items-center justify-between gap-default">
                        <p
                            className="text-sm text-content-emphasis"
                            data-testid="automation-inspector-action-type"
                        >
                            {actionLabel ?? t('actionUnknown')}
                        </p>
                        <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            onClick={() => openBuilder(ruleIds[0]!)}
                            disabled={!canManageRules || !rowsById.has(ruleIds[0]!)}
                            data-testid="automation-inspector-edit-action"
                        >
                            {t('editAction')}
                        </Button>
                    </div>
                </FormField>
            )}

            {kind === 'condition' && (
                <div className="space-y-tight">
                    <p className="text-xs text-content-subtle">
                        {t('conditionFilter', {
                            state: rule?.triggerFilterJson ? t('configured') : t('matchesAll'),
                        })}
                    </p>
                    {ruleIds.map((id) => (
                        <Button
                            key={id}
                            type="button"
                            size="sm"
                            variant="secondary"
                            onClick={() => openBuilder(id)}
                            disabled={!canManageRules || !rowsById.has(id)}
                            data-testid="automation-inspector-edit-conditions"
                        >
                            {ruleIds.length > 1
                                ? t('editConditionsOf', { name: rowsById.get(id)?.name ?? id })
                                : t('editConditions')}
                        </Button>
                    ))}
                </div>
            )}

            {kind === 'slaGate' && (
                <FormField label={t('slaLabel')}>
                    <Input
                        type="number"
                        min={1}
                        readOnly={!canManageRules}
                        value={sla}
                        onChange={(e) => setSla(e.target.value)}
                        onBlur={() =>
                            patchRules(ruleIds, { slaWindowMinutes: sla ? Number(sla) : null })
                        }
                        placeholder={t('slaPlaceholder')}
                    />
                </FormField>
            )}

            {/* What the rule still needs before it can be enabled. The server
                refuses to enable it until this list is empty. */}
            {owning && readiness.length > 0 && (
                <div data-testid="automation-inspector-readiness">
                    <InlineNotice variant="warning" title={t('notReadyTitle')}>
                        <ul className="list-disc pl-4 text-sm">
                            {readiness.map((p) => (
                                <li key={p}>{t(`readiness.${p}`)}</li>
                            ))}
                        </ul>
                    </InlineNotice>
                </div>
            )}

            {builderRule && (
                <RuleBuilderModal
                    tenantSlug={tenantSlug}
                    // Rendered only while a rule is picked, so it is open.
                    open
                    setOpen={(next) => {
                        const open = typeof next === 'function' ? next(true) : next;
                        if (!open) {
                            setBuilderRule(null);
                            void refresh(ruleIds);
                        }
                    }}
                    editRule={builderRule}
                />
            )}
        </div>
    );
}
