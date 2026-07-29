'use client';

/**
 * Automation inspector panel (Visual Rule Editor VR-4).
 *
 * Inline rule configuration when an automation node is selected — the Rule
 * Builder's per-step forms, without leaving the canvas. Branches on node kind
 * (trigger / condition / action / slaGate); edits auto-save to the linked
 * AutomationRule (the node's `dataJson.ruleId`, written by the VR-3 sync).
 *
 * The panel edits the RULE (logic lives on AutomationRule, per the VR-3
 * invariant); it never writes logic back onto the node.
 */
import { useState, useEffect, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/ui/form-field';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { eventOptionsByDomain } from '@/lib/automation/event-labels';
import { useToast } from '@/components/ui/hooks';

type AutomationKind = 'trigger' | 'condition' | 'action' | 'slaGate';

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
    };
}

const TRIGGER_OPTIONS: ComboboxOption[] = eventOptionsByDomain().flatMap((g) =>
    g.events.map((ev) => ({ value: ev.name, label: ev.label })),
);

export function AutomationInspectorPanel({
    kind,
    ruleId,
}: {
    kind: AutomationKind;
    ruleId: string | null;
}) {
    const t = useTranslations('automation.autoInspector');
    const toast = useToast();
    const actionLabels = useMemo(() => buildActionLabels(t), [t]);
    const apiUrl = useTenantApiUrl();
    const { data: rule, mutate } = useTenantSWR<Rule>(
        ruleId ? CACHE_KEYS.automation.rules.detail(ruleId) : null,
    );
    const [name, setName] = useState('');
    const [sla, setSla] = useState('');

    useEffect(() => {
        setName(rule?.name ?? '');
        setSla(rule?.slaWindowMinutes != null ? String(rule.slaWindowMinutes) : '');
    }, [rule?.id, rule?.name, rule?.slaWindowMinutes]);

    // Auto-save via PUT (UpdateAutomationRuleSchema accepts each field
    // optionally; its action-config superRefine only fires when actionType
    // AND actionConfig are sent together, so single-field edits are valid).
    async function patchRule(patch: Record<string, unknown>) {
        if (!ruleId || !rule) return;
        const res = await fetch(apiUrl(CACHE_KEYS.automation.rules.detail(ruleId)), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
        });
        // Every edit on this panel went through here fire-and-forget. A 403 (no
        // automation.manage grant) or a 400 from the action-config validator
        // looked exactly like a save: the control moved, then `mutate()`
        // refetched and silently snapped it back to the stored value. The user
        // saw their own edit undo itself with no explanation.
        if (!res.ok) {
            toast.error(t('saveFailed'));
            await mutate();
            return;
        }
        await mutate();
    }

    const triggerSelected = useMemo(
        () => TRIGGER_OPTIONS.find((o) => o.value === rule?.triggerEvent) ?? null,
        [rule?.triggerEvent],
    );
    const actionLabel = rule?.actionType
        ? (actionLabels[rule.actionType] ?? rule.actionType)
        : null;

    if (!ruleId) {
        return (
            <p className="text-sm text-content-muted" data-testid="automation-inspector-unsynced">
                {t('unsyncedHint')}
            </p>
        );
    }

    return (
        <div className="space-y-default" data-testid="automation-inspector">
            <div className="flex items-center justify-between">
                <span className="text-[11px] uppercase tracking-wide text-content-subtle">
                    {t(`kindRule.${kind}`)}
                </span>
                <label className="flex items-center gap-tight text-xs text-content-muted">
                    {rule?.status === 'ENABLED' ? t('enabled') : t('disabled')}
                    <Switch
                        checked={rule?.status === 'ENABLED'}
                        onCheckedChange={(c) => patchRule({ status: c ? 'ENABLED' : 'DISABLED' })}
                        aria-label={t('toggleEnabledAria')}
                    />
                </label>
            </div>

            <FormField label={t('ruleName')}>
                <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onBlur={() => name.trim() && name !== rule?.name && patchRule({ name: name.trim() })}
                />
            </FormField>

            {kind === 'trigger' && (
                <FormField label={t('triggerEvent')}>
                    <Combobox
                        options={TRIGGER_OPTIONS}
                        selected={triggerSelected}
                        setSelected={(o) => o && patchRule({ triggerEvent: o.value })}
                        placeholder={t('selectEvent')}
                        forceDropdown
                        matchTriggerWidth
                    />
                </FormField>
            )}

            {/* Read-only by design, not by omission.
                Every action config carries at least one REQUIRED field
                (`title`, `url`, a non-empty `userIds`, `targetGroupId`), so
                there is no valid default this panel could substitute when the
                type changes — and the server validates the incoming type
                against the STORED config, so a bare type flip is rejected.
                Offering a picker that can only ever fail is worse than naming
                where the edit belongs, which is what the condition branch
                below already does for filters. */}
            {kind === 'action' && (
                <FormField label={t('actionType')} description={t('actionTypeHint')}>
                    <p
                        className="text-sm text-content-emphasis"
                        data-testid="automation-inspector-action-type"
                    >
                        {actionLabel ?? t('actionUnknown')}
                    </p>
                </FormField>
            )}

            {kind === 'condition' && (
                <p className="text-xs text-content-subtle">
                    {t('conditionFilter', {
                        state: rule?.triggerFilterJson ? t('configured') : t('matchesAll'),
                    })}
                </p>
            )}

            {kind === 'slaGate' && (
                <FormField label={t('slaLabel')}>
                    <Input
                        type="number"
                        min={1}
                        value={sla}
                        onChange={(e) => setSla(e.target.value)}
                        onBlur={() =>
                            patchRule({ slaWindowMinutes: sla ? Number(sla) : null })
                        }
                        placeholder={t('slaPlaceholder')}
                    />
                </FormField>
            )}
        </div>
    );
}
