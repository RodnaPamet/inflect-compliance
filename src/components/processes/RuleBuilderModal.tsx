'use client';

/**
 * Visual rule builder (Automation Epic 3).
 *
 * A three-step Modal that lets an admin configure an automation rule without
 * writing JSON — the primary gap vs Archer's GUI workflow designer.
 *
 *   Step 1 — Trigger:    name + event picker (grouped by domain)
 *   Step 2 — Conditions: field = value rows (equality at Epic 3; Epic 4 adds
 *                        operators + AND/OR groups)
 *   Step 3 — Action:     action type + typed sub-form per type
 *
 * Save POSTs (create) or PUTs (edit) to the rules API and revalidates the
 * list cache. Server-side Zod (automation.schemas.ts) is the authoritative
 * validation; the modal does light client-side gating to drive Next/Save.
 */
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import { useSWRConfig } from 'swr';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { UserCombobox } from '@/components/ui/user-combobox';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { CACHE_KEYS } from '@/lib/swr-keys';
import {
    EVENT_LABELS,
    eventOptionsByDomain,
    filterFieldsForEvent,
} from '@/lib/automation/event-labels';
import {
    UPDATE_STATUS_TARGETS,
    UPDATE_STATUS_ENTITY_TYPES,
} from '@/lib/automation/status-allowlist';
import type { AutomationRuleRow } from '@/app/t/[tenantSlug]/(app)/processes/RulesTab';

type ActionType = 'NOTIFY_USER' | 'CREATE_TASK' | 'UPDATE_STATUS' | 'WEBHOOK' | 'INVOKE_SUBFLOW';

type Operator = 'eq' | 'neq' | 'in' | 'not_in' | 'gt' | 'lt' | 'contains';

interface Condition {
    field: string;
    operator: Operator;
    value: string;
}

// Raw stored filter shapes — mirror `app-layer/automation/types.ts`. The flat
// builder edits a SINGLE-level condition list; the evaluator (`filters.ts`)
// additionally accepts nested `FilterGroup`s and the legacy flat equality map.
// Both are handled at hydration so editing a rule never wipes a filter the
// tabular UI can't fully draw.
interface RawCondition {
    field: string;
    operator: Operator;
    value: string | number | boolean | string[];
}
interface RawGroup {
    logic: 'AND' | 'OR';
    conditions: Array<RawCondition | RawGroup>;
}
type RawLegacyFilter = Record<string, string | number | boolean>;
type RawFilter = RawGroup | RawLegacyFilter;

function isRawGroup(f: unknown): f is RawGroup {
    return (
        !!f &&
        typeof f === 'object' &&
        'logic' in f &&
        'conditions' in f &&
        Array.isArray((f as RawGroup).conditions)
    );
}

/** Filter value → the string the flat builder edits (arrays join to CSV). */
function filterValueToStr(v: unknown): string {
    if (Array.isArray(v)) return v.join(',');
    return typeof v === 'string' ? v : v == null ? '' : String(v);
}

/**
 * Hydrate the stored filter into the flat builder's `logic` + `conditions`.
 *
 *   - `null`                    → no filter.
 *   - flat `FilterGroup`        → one editable row per leaf condition.
 *   - legacy flat map           → one `eq` row per key (builder round-trips it
 *                                 into an evaluator-equivalent FilterGroup).
 *   - `FilterGroup` w/ a nested sub-group → NOT representable by the flat UI, so
 *     the whole filter is stashed in `preservedFilter` and passed through
 *     verbatim on save; the condition editor is replaced by a read-only notice.
 *     This is what stops an edit from flattening or nulling an advanced filter.
 */
function hydrateFilter(raw: RawFilter | null | undefined): {
    logic: 'AND' | 'OR';
    conditions: Condition[];
    preservedFilter: RawFilter | null;
} {
    if (!raw) return { logic: 'AND', conditions: [], preservedFilter: null };
    if (isRawGroup(raw)) {
        const hasNested = raw.conditions.some((c) => isRawGroup(c));
        if (hasNested) {
            return { logic: raw.logic ?? 'AND', conditions: [], preservedFilter: raw };
        }
        return {
            logic: raw.logic ?? 'AND',
            conditions: (raw.conditions as RawCondition[]).map((c) => ({
                field: c.field,
                operator: c.operator,
                value: filterValueToStr(c.value),
            })),
            preservedFilter: null,
        };
    }
    // Legacy flat equality map { field: value } → flat `eq` rows.
    return {
        logic: 'AND',
        conditions: Object.entries(raw).map(([field, value]) => ({
            field,
            operator: 'eq' as Operator,
            value: filterValueToStr(value),
        })),
        preservedFilter: null,
    };
}

/** Surface-namespace resolver (`useTranslations('automation.ruleBuilder')`). */
type RuleTranslate = ReturnType<typeof useTranslations>;

function buildOperatorOptions(
    t: RuleTranslate,
): ReadonlyArray<{ value: Operator; label: string }> {
    return [
        { value: 'eq', label: t('opEquals') },
        { value: 'neq', label: t('opNotEquals') },
        { value: 'in', label: t('opAnyOf') },
        { value: 'not_in', label: t('opNoneOf') },
        { value: 'gt', label: t('opGreaterThan') },
        { value: 'lt', label: t('opLessThan') },
        { value: 'contains', label: t('opContains') },
    ];
}

interface BuilderState {
    name: string;
    triggerEvent: string;
    logic: 'AND' | 'OR';
    conditions: Condition[];
    /** Set when the stored filter uses a shape the flat editor can't draw
     *  (a nested sub-group). Passed through verbatim on save so editing the
     *  rest of the rule never wipes or flattens it; null for editable filters. */
    preservedFilter: RawFilter | null;
    actionType: ActionType;
    notify: { userIds: string[]; message: string; linkUrl: string };
    task: {
        title: string;
        severity: string;
        priority: string;
        assigneeUserId: string;
        // PR2 — link the spawned task back to its source entity (executor
        // reads the id from the trigger payload at `linkEntityIdField`).
        linkEntityType: string;
        linkEntityIdField: string;
    };
    status: { entityType: string; field: string; toStatus: string };
    // PR2 — headers (one `Name: value` per line) + HMAC secretRef; both
    // honored by the executor's webhook action.
    webhook: { url: string; method: string; headersText: string; secretRef: string };
    /** PR2 — INVOKE_SUBFLOW target group (a ProcessNode.nodeKey). */
    subflow: { targetGroupId: string };
    /** Optional SLA window in minutes (Epic 5); empty = no SLA. */
    slaWindowMinutes: string;
    /** PR-E — breach action for the execution watchdog. Only NOTIFY_USER is
     *  implemented server-side, so that's the only non-empty option offered. */
    slaBreach: { actionType: '' | 'NOTIFY_USER'; userIds: string[]; message: string };
    /** SCHEDULE trigger config (PR-E) — only used when triggerEvent === 'SCHEDULE'. */
    schedule: { target: ScheduleTarget; offsetDays: string };
    /** Optional chain target (Epic 7); empty = terminal rule. */
    nextRuleId: string;
    nextRuleDelay: string;
    /** PR-E — else-branch: rule to run when conditions FAIL (canvas parity). */
    elseRuleId: string;
}

type ScheduleTarget = 'Evidence' | 'ControlException' | 'ControlTestPlan';

const EMPTY: BuilderState = {
    name: '',
    triggerEvent: '',
    logic: 'AND',
    conditions: [],
    preservedFilter: null,
    actionType: 'NOTIFY_USER',
    notify: { userIds: [], message: '', linkUrl: '' },
    task: { title: '', severity: '', priority: '', assigneeUserId: '', linkEntityType: '', linkEntityIdField: '' },
    status: { entityType: 'Risk', field: 'status', toStatus: '' },
    webhook: { url: '', method: 'POST', headersText: '', secretRef: '' },
    subflow: { targetGroupId: '' },
    slaWindowMinutes: '',
    slaBreach: { actionType: '', userIds: [], message: '' },
    schedule: { target: 'Evidence', offsetDays: '0' },
    nextRuleId: '',
    nextRuleDelay: '',
    elseRuleId: '',
};

/**
 * Full rule detail as returned by GET /automation/rules/{id} — the raw
 * AutomationRule row (JSON columns keep their `*Json` names). The list row
 * (`AutomationRuleRow`) is a thin projection, so edit mode fetches this to
 * repopulate the builder; without it, Save would PUT the blank `EMPTY`
 * defaults over the stored config.
 */
export interface RuleDetail {
    name: string;
    triggerEvent: string;
    actionType: ActionType;
    // The stored filter is a `FilterGroup` (possibly with nested sub-groups) OR
    // the legacy flat equality map OR null — NOT flat-only. Typing it flat is
    // exactly what let nested/legacy filters silently hydrate to nothing.
    triggerFilterJson: RawFilter | null;
    actionConfigJson: Record<string, unknown> | null;
    slaWindowMinutes: number | null;
    slaBreachActionType: 'NOTIFY_USER' | null;
    slaBreachConfigJson: { userIds?: string[]; message?: string } | null;
    scheduleConfigJson: { kind?: string; target?: ScheduleTarget; offsetDays?: number } | null;
    nextRuleId: string | null;
    nextRuleDelay: number | null;
    elseRuleId: string | null;
}

/** Reverse of `buildRulePayload` — repopulates BuilderState so editing then
 *  saving with no changes is a no-op (config preserved). */
export function detailToBuilderState(d: RuleDetail): BuilderState {
    const ac = (d.actionConfigJson ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
    const arr = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : []);
    // Hydrate the filter across all three authoring shapes (flat group / nested
    // group / legacy map). A nested filter round-trips via `preservedFilter`.
    const filter = hydrateFilter(d.triggerFilterJson);
    return {
        name: d.name ?? '',
        triggerEvent: d.triggerEvent ?? '',
        logic: filter.logic,
        conditions: filter.conditions,
        preservedFilter: filter.preservedFilter,
        actionType: d.actionType,
        notify:
            d.actionType === 'NOTIFY_USER'
                ? { userIds: arr(ac.userIds), message: str(ac.message), linkUrl: str(ac.linkUrl) }
                : { ...EMPTY.notify },
        task:
            d.actionType === 'CREATE_TASK'
                ? {
                      title: str(ac.title),
                      severity: str(ac.severity),
                      priority: str(ac.priority),
                      assigneeUserId: str(ac.assigneeUserId),
                      linkEntityType: str(ac.linkEntityType),
                      linkEntityIdField: str(ac.linkEntityIdField),
                  }
                : { ...EMPTY.task },
        status:
            d.actionType === 'UPDATE_STATUS'
                ? {
                      entityType: str(ac.entityType) || 'Risk',
                      field: str(ac.field) || 'status',
                      toStatus: str(ac.toStatus),
                  }
                : { ...EMPTY.status },
        webhook:
            d.actionType === 'WEBHOOK'
                ? {
                      url: str(ac.url),
                      method: str(ac.method) || 'POST',
                      headersText: stringifyHeaders(
                          ac.headers as Record<string, string> | undefined,
                      ),
                      secretRef: str(ac.secretRef),
                  }
                : { ...EMPTY.webhook },
        subflow:
            d.actionType === 'INVOKE_SUBFLOW'
                ? { targetGroupId: str(ac.targetGroupId) }
                : { ...EMPTY.subflow },
        slaWindowMinutes: d.slaWindowMinutes != null ? String(d.slaWindowMinutes) : '',
        slaBreach: {
            actionType: d.slaBreachActionType === 'NOTIFY_USER' ? 'NOTIFY_USER' : '',
            userIds: d.slaBreachConfigJson?.userIds ?? [],
            message: d.slaBreachConfigJson?.message ?? '',
        },
        schedule: {
            target: d.scheduleConfigJson?.target ?? 'Evidence',
            offsetDays:
                d.scheduleConfigJson?.offsetDays != null
                    ? String(d.scheduleConfigJson.offsetDays)
                    : '0',
        },
        nextRuleId: d.nextRuleId ?? '',
        nextRuleDelay: d.nextRuleDelay != null ? String(d.nextRuleDelay) : '',
        elseRuleId: d.elseRuleId ?? '',
    };
}

/** Parse a `Name: value` per-line textarea into a header record (skips blanks
 *  + lines without a colon). Inverse of `stringifyHeaders`. */
function parseHeaders(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split('\n')) {
        const i = line.indexOf(':');
        if (i <= 0) continue;
        const k = line.slice(0, i).trim();
        const v = line.slice(i + 1).trim();
        if (k) out[k] = v;
    }
    return out;
}

function stringifyHeaders(rec: Record<string, string> | undefined): string {
    return Object.entries(rec ?? {})
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');
}

function buildActionConfig(form: BuilderState): Record<string, unknown> {
    switch (form.actionType) {
        case 'NOTIFY_USER':
            return {
                userIds: form.notify.userIds,
                message: form.notify.message.trim(),
                ...(form.notify.linkUrl.trim() ? { linkUrl: form.notify.linkUrl.trim() } : {}),
            };
        case 'CREATE_TASK':
            return {
                title: form.task.title.trim(),
                ...(form.task.severity ? { severity: form.task.severity } : {}),
                ...(form.task.priority ? { priority: form.task.priority } : {}),
                ...(form.task.assigneeUserId ? { assigneeUserId: form.task.assigneeUserId } : {}),
                ...(form.task.linkEntityType.trim() ? { linkEntityType: form.task.linkEntityType.trim() } : {}),
                ...(form.task.linkEntityIdField.trim()
                    ? { linkEntityIdField: form.task.linkEntityIdField.trim() }
                    : {}),
            };
        case 'UPDATE_STATUS':
            return {
                entityType: form.status.entityType,
                field: form.status.field,
                toStatus: form.status.toStatus.trim(),
            };
        case 'WEBHOOK': {
            const headers = parseHeaders(form.webhook.headersText);
            return {
                url: form.webhook.url.trim(),
                method: form.webhook.method,
                ...(Object.keys(headers).length ? { headers } : {}),
                ...(form.webhook.secretRef.trim() ? { secretRef: form.webhook.secretRef.trim() } : {}),
            };
        }
        case 'INVOKE_SUBFLOW':
            return { targetGroupId: form.subflow.targetGroupId.trim() };
    }
}

function buildTriggerFilter(form: BuilderState): RawFilter | null {
    // A filter the flat builder couldn't represent (nested group) is carried
    // through verbatim — NEVER rebuilt from the (empty) flat conditions. This is
    // the load-bearing guard: a builder that failed to draw a non-empty filter
    // must never let its empty state null or flatten the stored filter.
    if (form.preservedFilter) return form.preservedFilter;
    const valid = form.conditions.filter((c) => c.field && c.value !== '');
    if (valid.length === 0) return null;
    return {
        logic: form.logic,
        conditions: valid.map((c) => ({
            field: c.field,
            operator: c.operator,
            // in/not_in take a value set — split the comma-separated input.
            value:
                c.operator === 'in' || c.operator === 'not_in'
                    ? c.value.split(',').map((s) => s.trim()).filter(Boolean)
                    : c.value,
        })),
    };
}

/**
 * Build the create/update payload from builder state. Pure + exported so the
 * edit round-trip is unit-testable: `buildRulePayload(detailToBuilderState(d))`
 * must reproduce `d`'s config (editing + saving with no changes is a no-op).
 */
export function buildRulePayload(form: BuilderState) {
    return {
        name: form.name.trim(),
        triggerEvent: form.triggerEvent,
        triggerFilter: buildTriggerFilter(form),
        actionType: form.actionType,
        actionConfig: buildActionConfig(form),
        slaWindowMinutes: form.slaWindowMinutes ? Number(form.slaWindowMinutes) : null,
        // Breach action is only meaningful with a watchdog window set; only
        // NOTIFY_USER is wired server-side.
        slaBreachActionType:
            form.slaWindowMinutes && form.slaBreach.actionType ? form.slaBreach.actionType : null,
        slaBreachConfig:
            form.slaWindowMinutes && form.slaBreach.actionType === 'NOTIFY_USER'
                ? { userIds: form.slaBreach.userIds, message: form.slaBreach.message.trim() }
                : null,
        // A SCHEDULE rule needs a scheduleConfig or the sweep can never fire it.
        scheduleConfig:
            form.triggerEvent === 'SCHEDULE'
                ? {
                      kind: 'DATE_RELATIVE' as const,
                      target: form.schedule.target,
                      offsetDays: Number(form.schedule.offsetDays) || 0,
                  }
                : null,
        nextRuleId: form.nextRuleId || null,
        nextRuleDelay: form.nextRuleDelay ? Number(form.nextRuleDelay) : null,
        elseRuleId: form.elseRuleId || null,
    };
}

function buildActionOptions(
    t: RuleTranslate,
): ReadonlyArray<{ value: ActionType; label: string; hint: string }> {
    return [
        { value: 'NOTIFY_USER', label: t('actionNotify'), hint: t('actionNotifyHint') },
        { value: 'CREATE_TASK', label: t('actionCreateTask'), hint: t('actionCreateTaskHint') },
        { value: 'UPDATE_STATUS', label: t('actionUpdateStatus'), hint: t('actionUpdateStatusHint') },
        { value: 'WEBHOOK', label: t('actionWebhook'), hint: t('actionWebhookHint') },
        { value: 'INVOKE_SUBFLOW', label: t('actionInvokeSubflow'), hint: t('actionInvokeSubflowHint') },
    ];
}

const triggerOptions: ComboboxOption[] = eventOptionsByDomain().flatMap((g) =>
    g.events.map((ev) => ({ value: ev.name, label: ev.label })),
);

// PR-E — UPDATE_STATUS entity + status dropdowns (the executor enforces the
// same allowlist server-side; offering free text let users type a status that
// would silently fail at runtime).
const entityTypeOptions: ComboboxOption[] = UPDATE_STATUS_ENTITY_TYPES.map(
    (e) => ({ value: e, label: e }),
);

// PR-E — enum values are identifiers (not UI copy), so raw-value labels are
// fine + ratchet-safe (label is a variable). Aligned with the Zod enums in
// automation.schemas.ts (CreateTaskConfig / WebhookConfig).
const TASK_SEVERITY_OPTIONS: ComboboxOption[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].map(
    (v) => ({ value: v, label: v }),
);
const TASK_PRIORITY_OPTIONS: ComboboxOption[] = ['P0', 'P1', 'P2', 'P3'].map(
    (v) => ({ value: v, label: v }),
);
// The CREATE_TASK executor (action-executor.ts::createTask) only resolves a
// linked entity when linkEntityType === 'Control'; any other value silently
// produces an UNLINKED task. Offer only what the executor actually links, so
// no selectable value no-ops. Extend this list only in lockstep with the
// executor learning to resolve more entity types.
const TASK_LINK_ENTITY_OPTIONS: ComboboxOption[] = ['Control'].map(
    (v) => ({ value: v, label: v }),
);
const WEBHOOK_METHOD_OPTIONS: ComboboxOption[] = ['POST', 'PUT', 'PATCH'].map(
    (v) => ({ value: v, label: v }),
);

// PR-E — SCHEDULE target date fields (must match SCHEDULE_TARGETS in
// schedule-trigger-sweep.ts + the ScheduleConfig Zod enum).
function buildScheduleTargetOptions(t: RuleTranslate): ComboboxOption[] {
    return [
        { value: 'Evidence', label: t('scheduleTargetEvidence') },
        { value: 'ControlException', label: t('scheduleTargetException') },
        { value: 'ControlTestPlan', label: t('scheduleTargetTestPlan') },
    ];
}

// PR-E — watchdog breach actions. Only NOTIFY_USER is implemented server-side
// (sla-monitor.ts), so those are the only two options — no reassign/status-
// change that would silently no-op.
function buildSlaBreachActionOptions(t: RuleTranslate): ComboboxOption[] {
    return [
        { value: '', label: t('slaBreachNone') },
        { value: 'NOTIFY_USER', label: t('slaBreachNotify') },
    ];
}

export interface RuleBuilderModalProps {
    tenantSlug: string;
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    /** When set, the modal edits this rule (PUT); otherwise it creates (POST). */
    editRule?: AutomationRuleRow | null;
}

export function RuleBuilderModal({ tenantSlug, open, setOpen, editRule }: RuleBuilderModalProps) {
    const t = useTranslations('automation.ruleBuilder');
    const operatorOptions = useMemo(() => buildOperatorOptions(t), [t]);
    const actionOptions = useMemo(() => buildActionOptions(t), [t]);
    const scheduleTargetOptions = useMemo(() => buildScheduleTargetOptions(t), [t]);
    const slaBreachActionOptions = useMemo(() => buildSlaBreachActionOptions(t), [t]);
    const apiUrl = useTenantApiUrl();
    const { mutate } = useSWRConfig();
    // Epic 7 — chain targets (other rules). Excludes the rule being edited.
    const { data: allRules } = useTenantSWR<AutomationRuleRow[]>(
        CACHE_KEYS.automation.rules.list(),
    );
    const chainOptions: ComboboxOption[] = (allRules ?? [])
        .filter((r) => r.id !== editRule?.id)
        .map((r) => ({ value: r.id, label: r.name }));
    const [step, setStep] = useState<1 | 2 | 3>(1);
    const [form, setForm] = useState<BuilderState>(EMPTY);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Edit mode repopulates the builder from the FULL rule detail — the list
    // row (`editRule`) is a thin projection with no config. Fetch it only while
    // editing; hydrate ONCE per open (keyed on rule id) so SWR revalidation
    // never clobbers in-progress edits, and reset to EMPTY on a create open.
    // Without this, Save PUTs the blank EMPTY defaults over the stored rule.
    const editId = open && editRule ? editRule.id : null;
    const { data: editDetail } = useTenantSWR<RuleDetail>(
        editId ? CACHE_KEYS.automation.rules.detail(editId) : null,
    );
    const hydratedForRef = useRef<string | null>(null);
    useEffect(() => {
        if (!open) {
            hydratedForRef.current = null;
            return;
        }
        if (!editRule) {
            if (hydratedForRef.current !== '__create__') {
                setForm(EMPTY);
                setStep(1);
                hydratedForRef.current = '__create__';
            }
            return;
        }
        if (editDetail && hydratedForRef.current !== editRule.id) {
            setForm(detailToBuilderState(editDetail));
            setStep(1);
            hydratedForRef.current = editRule.id;
        }
    }, [open, editRule, editDetail]);

    const patch = (p: Partial<BuilderState>) => setForm((f) => ({ ...f, ...p }));

    // PR-E — status options for the currently-selected UPDATE_STATUS entity.
    // Plain derivation (React Compiler memoizes); labels are the raw enum
    // values (identifiers, not UI copy).
    const statusValueOptions: ComboboxOption[] = (
        UPDATE_STATUS_TARGETS[form.status.entityType]?.values ?? []
    ).map((v) => ({ value: v, label: v }));

    const availableFields = useMemo(
        () => filterFieldsForEvent(form.triggerEvent),
        [form.triggerEvent],
    );

    // PR-E — a SCHEDULE rule must carry a valid offset (0..365) so the sweep
    // can actually fire it; other triggers have no extra step-1 requirement.
    const scheduleValid =
        form.triggerEvent !== 'SCHEDULE' ||
        (() => {
            const n = Number(form.schedule.offsetDays);
            return Number.isInteger(n) && n >= 0 && n <= 365;
        })();
    const step1Valid =
        form.name.trim().length > 0 &&
        form.triggerEvent.length > 0 &&
        scheduleValid;
    const step3Valid = (() => {
        switch (form.actionType) {
            case 'NOTIFY_USER':
                return form.notify.userIds.length > 0 && form.notify.message.trim().length > 0;
            case 'CREATE_TASK':
                return form.task.title.trim().length > 0;
            case 'UPDATE_STATUS':
                return form.status.toStatus.trim().length > 0;
            case 'WEBHOOK':
                return /^https?:\/\//.test(form.webhook.url.trim());
            case 'INVOKE_SUBFLOW':
                return form.subflow.targetGroupId.trim().length > 0;
        }
    })();

    async function handleSave() {
        setSubmitting(true);
        setError(null);
        try {
            const payload = buildRulePayload(form);
            const url = editRule
                ? apiUrl(CACHE_KEYS.automation.rules.detail(editRule.id))
                : apiUrl(CACHE_KEYS.automation.rules.list());
            const res = await fetch(url, {
                method: editRule ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                const e = await res.json().catch(() => ({ error: t('saveFailed') }));
                throw new Error(e.error ?? t('saveFailed'));
            }
            await mutate(apiUrl(CACHE_KEYS.automation.rules.list()));
            setOpen(false);
            setForm(EMPTY);
            setStep(1);
        } catch (e) {
            setError(e instanceof Error ? e.message : t('saveFailed'));
        } finally {
            setSubmitting(false);
        }
    }

    const triggerSelected = form.triggerEvent
        ? triggerOptions.find((o) => o.value === form.triggerEvent) ?? null
        : null;

    return (
        <Modal showModal={open} setShowModal={setOpen} title={editRule ? t('editTitle') : t('newTitle')} size="lg">
            <Modal.Header title={editRule ? t('editHeader') : t('newHeader')} />
            <Modal.Body>
                <p className="mb-default text-xs uppercase tracking-wide text-content-subtle">
                    {t('stepIndicator', {
                        step,
                        phase:
                            step === 1
                                ? t('phaseTrigger')
                                : step === 2
                                  ? t('phaseConditions')
                                  : t('phaseAction'),
                    })}
                </p>

                {step === 1 && (
                    <div className="space-y-default">
                        <FormField label={t('ruleName')} required>
                            <Input
                                value={form.name}
                                onChange={(e) => patch({ name: e.target.value })}
                                placeholder={t('ruleNamePlaceholder')}
                            />
                        </FormField>
                        <FormField label={t('triggerEvent')} required>
                            <Combobox
                                options={triggerOptions}
                                selected={triggerSelected}
                                setSelected={(o) => patch({ triggerEvent: o?.value ?? '', conditions: [] })}
                                placeholder={t('selectEvent')}
                                forceDropdown
                                matchTriggerWidth
                                optionDescription={(o) =>
                                    EVENT_LABELS[o.value as keyof typeof EVENT_LABELS]?.description ?? ''
                                }
                            />
                        </FormField>
                        {/* PR-E — SCHEDULE trigger config. Without this a
                            SCHEDULE rule saves but the sweep can never fire it
                            (no target date / offset). */}
                        {form.triggerEvent === 'SCHEDULE' && (
                            <div className="space-y-default rounded-[8px] border border-border-subtle p-default">
                                <FormField
                                    label={t('scheduleTargetLabel')}
                                    description={t('scheduleTargetHint')}
                                    required
                                >
                                    <Combobox
                                        options={scheduleTargetOptions}
                                        selected={
                                            scheduleTargetOptions.find(
                                                (o) => o.value === form.schedule.target,
                                            ) ?? null
                                        }
                                        setSelected={(o) =>
                                            patch({
                                                schedule: {
                                                    ...form.schedule,
                                                    target: (o?.value as ScheduleTarget) ?? 'Evidence',
                                                },
                                            })
                                        }
                                        forceDropdown
                                        matchTriggerWidth
                                    />
                                </FormField>
                                <FormField
                                    label={t('scheduleOffsetLabel')}
                                    description={t('scheduleOffsetHint')}
                                    required
                                >
                                    <Input
                                        type="number"
                                        min={0}
                                        max={365}
                                        value={form.schedule.offsetDays}
                                        onChange={(e) =>
                                            patch({
                                                schedule: {
                                                    ...form.schedule,
                                                    offsetDays: e.target.value,
                                                },
                                            })
                                        }
                                        placeholder="0"
                                    />
                                </FormField>
                            </div>
                        )}
                    </div>
                )}

                {step === 2 && (
                    <div className="space-y-default">
                        {form.preservedFilter ? (
                            // This rule's filter uses nested AND/OR grouping the
                            // flat editor can't draw. Show it read-only and leave
                            // it untouched — `buildTriggerFilter` passes it through
                            // verbatim, so saving here never wipes or flattens it.
                            <div className="rounded-[8px] border border-border-subtle bg-bg-subtle p-default space-y-tight">
                                <p className="text-sm font-medium text-content-emphasis">
                                    {t('advancedFilterTitle')}
                                </p>
                                <p className="text-sm text-content-muted">
                                    {t('advancedFilterBody')}
                                </p>
                            </div>
                        ) : availableFields.length === 0 ? (
                            <p className="text-sm text-content-muted">
                                {t('filterableFieldsHint')}
                            </p>
                        ) : (
                            <>
                                {/* AND/OR group logic — shown once ≥2 conditions exist. */}
                                {form.conditions.length > 1 && (
                                    <div className="flex items-center gap-compact text-sm">
                                        <span className="text-content-muted">{t('match')}</span>
                                        <RadioGroup
                                            value={form.logic}
                                            onValueChange={(v) => patch({ logic: v as 'AND' | 'OR' })}
                                            className="flex gap-default"
                                        >
                                            <label className="flex items-center gap-tight">
                                                <RadioGroupItem value="AND" /> {t('allAnd')}
                                            </label>
                                            <label className="flex items-center gap-tight">
                                                <RadioGroupItem value="OR" /> {t('anyOr')}
                                            </label>
                                        </RadioGroup>
                                    </div>
                                )}
                                {form.conditions.map((cond, i) => {
                                    const fieldDef = availableFields.find((f) => f.field === cond.field);
                                    const isSet = cond.operator === 'in' || cond.operator === 'not_in';
                                    return (
                                        <div key={i} className="flex items-end gap-compact">
                                            <FormField label={i === 0 ? t('field') : undefined} className="flex-1">
                                                <Combobox
                                                    options={availableFields.map((f) => ({
                                                        value: f.field,
                                                        label: f.label,
                                                    }))}
                                                    selected={
                                                        cond.field
                                                            ? { value: cond.field, label: fieldDef?.label ?? cond.field }
                                                            : null
                                                    }
                                                    setSelected={(o) => {
                                                        const next = [...form.conditions];
                                                        next[i] = { ...next[i], field: o?.value ?? '', value: '' };
                                                        patch({ conditions: next });
                                                    }}
                                                    placeholder={t('fieldPlaceholder')}
                                                    forceDropdown
                                                    matchTriggerWidth
                                                />
                                            </FormField>
                                            <FormField label={i === 0 ? t('operator') : undefined}>
                                                <Combobox
                                                    options={operatorOptions.map((op) => ({
                                                        value: op.value,
                                                        label: op.label,
                                                    }))}
                                                    selected={{
                                                        value: cond.operator,
                                                        label:
                                                            operatorOptions.find((op) => op.value === cond.operator)
                                                                ?.label ?? cond.operator,
                                                    }}
                                                    setSelected={(o) => {
                                                        const next = [...form.conditions];
                                                        next[i] = {
                                                            ...next[i],
                                                            operator: (o?.value as Operator) ?? 'eq',
                                                        };
                                                        patch({ conditions: next });
                                                    }}
                                                    forceDropdown
                                                    matchTriggerWidth
                                                />
                                            </FormField>
                                            <FormField label={i === 0 ? t('value') : undefined} className="flex-1">
                                                {fieldDef?.type === 'enum' && !isSet ? (
                                                    <Combobox
                                                        options={(fieldDef.options ?? []).map((opt) => ({
                                                            value: opt.value,
                                                            label: opt.label,
                                                        }))}
                                                        selected={
                                                            cond.value
                                                                ? { value: cond.value, label: cond.value }
                                                                : null
                                                        }
                                                        setSelected={(o) => {
                                                            const next = [...form.conditions];
                                                            next[i] = { ...next[i], value: o?.value ?? '' };
                                                            patch({ conditions: next });
                                                        }}
                                                        placeholder={t('valuePlaceholder')}
                                                        forceDropdown
                                                        matchTriggerWidth
                                                    />
                                                ) : (
                                                    <Input
                                                        type={
                                                            fieldDef?.type === 'number' && !isSet
                                                                ? 'number'
                                                                : 'text'
                                                        }
                                                        value={cond.value}
                                                        onChange={(e) => {
                                                            const next = [...form.conditions];
                                                            next[i] = { ...next[i], value: e.target.value };
                                                            patch({ conditions: next });
                                                        }}
                                                        placeholder={isSet ? t('commaSeparated') : t('valuePlain')}
                                                    />
                                                )}
                                            </FormField>
                                            <Button
                                                variant="ghost"
                                                onClick={() =>
                                                    patch({
                                                        conditions: form.conditions.filter((_, j) => j !== i),
                                                    })
                                                }
                                                aria-label={t('removeCondition')}
                                            >
                                                {t('remove')}
                                            </Button>
                                        </div>
                                    );
                                })}
                                <Button
                                    variant="secondary"
                                    onClick={() =>
                                        patch({
                                            conditions: [
                                                ...form.conditions,
                                                {
                                                    field: availableFields[0]?.field ?? '',
                                                    operator: 'eq',
                                                    value: '',
                                                },
                                            ],
                                        })
                                    }
                                >
                                    {t('addCondition')}
                                </Button>
                                <p className="text-xs text-content-subtle">
                                    {t('conditionsHint')}
                                </p>
                            </>
                        )}
                    </div>
                )}

                {step === 3 && (
                    <div className="space-y-default">
                        <RadioGroup
                            value={form.actionType}
                            onValueChange={(v) => patch({ actionType: v as ActionType })}
                            className="space-y-tight"
                        >
                            {actionOptions.map((a) => (
                                <label key={a.value} className="flex items-center gap-compact text-sm">
                                    <RadioGroupItem value={a.value} />
                                    <span className="text-content-emphasis">{a.label}</span>
                                    <span className="text-content-subtle">— {a.hint}</span>
                                </label>
                            ))}
                        </RadioGroup>

                        <div className="border-t border-border-subtle pt-default space-y-default">
                            {form.actionType === 'NOTIFY_USER' && (
                                <>
                                    <FormField label={t('recipients')} required>
                                        <UserCombobox
                                            tenantSlug={tenantSlug}
                                            multiple
                                            selectedIds={form.notify.userIds}
                                            onChange={(ids) =>
                                                patch({ notify: { ...form.notify, userIds: ids } })
                                            }
                                            forceDropdown
                                            matchTriggerWidth
                                        />
                                    </FormField>
                                    <FormField label={t('message')} required>
                                        <Textarea
                                            value={form.notify.message}
                                            onChange={(e) =>
                                                patch({ notify: { ...form.notify, message: e.target.value } })
                                            }
                                            placeholder={t('messagePlaceholder')}
                                        />
                                    </FormField>
                                    {/* PR-E — optional deep link on the notification. */}
                                    <FormField label={t('notifyLinkUrl')}>
                                        <Input
                                            value={form.notify.linkUrl}
                                            onChange={(e) =>
                                                patch({ notify: { ...form.notify, linkUrl: e.target.value } })
                                            }
                                            placeholder={t('notifyLinkUrlPlaceholder')}
                                        />
                                    </FormField>
                                </>
                            )}
                            {form.actionType === 'CREATE_TASK' && (
                                <>
                                    <FormField label={t('taskTitle')} required>
                                        <Input
                                            value={form.task.title}
                                            onChange={(e) =>
                                                patch({ task: { ...form.task, title: e.target.value } })
                                            }
                                            placeholder={t('taskTitlePlaceholder')}
                                        />
                                    </FormField>
                                    {/* PR-E — task severity / priority / assignee
                                        (schema-supported, previously unexposed). */}
                                    <FormField label={t('taskSeverity')}>
                                        <Combobox
                                            options={TASK_SEVERITY_OPTIONS}
                                            selected={
                                                TASK_SEVERITY_OPTIONS.find(
                                                    (o) => o.value === form.task.severity,
                                                ) ?? null
                                            }
                                            setSelected={(o) =>
                                                patch({ task: { ...form.task, severity: o?.value ?? '' } })
                                            }
                                            placeholder={t('taskSeverityPlaceholder')}
                                            forceDropdown
                                            matchTriggerWidth
                                        />
                                    </FormField>
                                    <FormField label={t('taskPriority')}>
                                        <Combobox
                                            options={TASK_PRIORITY_OPTIONS}
                                            selected={
                                                TASK_PRIORITY_OPTIONS.find(
                                                    (o) => o.value === form.task.priority,
                                                ) ?? null
                                            }
                                            setSelected={(o) =>
                                                patch({ task: { ...form.task, priority: o?.value ?? '' } })
                                            }
                                            placeholder={t('taskPriorityPlaceholder')}
                                            forceDropdown
                                            matchTriggerWidth
                                        />
                                    </FormField>
                                    <FormField label={t('taskAssignee')}>
                                        <UserCombobox
                                            tenantSlug={tenantSlug}
                                            selectedId={form.task.assigneeUserId || null}
                                            onChange={(id) =>
                                                patch({
                                                    task: {
                                                        ...form.task,
                                                        assigneeUserId: id ?? '',
                                                    },
                                                })
                                            }
                                            forceDropdown
                                            matchTriggerWidth
                                        />
                                    </FormField>
                                    {/* PR2 — link the spawned task back to its source entity.
                                        The executor reads the entity id from the trigger
                                        payload at `linkEntityIdField`. */}
                                    <FormField label={t('taskLinkEntityType')} description={t('taskLinkEntityHint')}>
                                        <Combobox
                                            options={TASK_LINK_ENTITY_OPTIONS}
                                            selected={
                                                TASK_LINK_ENTITY_OPTIONS.find(
                                                    (o) => o.value === form.task.linkEntityType,
                                                ) ?? null
                                            }
                                            setSelected={(o) =>
                                                patch({ task: { ...form.task, linkEntityType: o?.value ?? '' } })
                                            }
                                            placeholder={t('taskLinkEntityTypePlaceholder')}
                                            forceDropdown
                                            matchTriggerWidth
                                        />
                                    </FormField>
                                    <FormField label={t('taskLinkEntityIdField')}>
                                        <Input
                                            value={form.task.linkEntityIdField}
                                            onChange={(e) =>
                                                patch({ task: { ...form.task, linkEntityIdField: e.target.value } })
                                            }
                                            placeholder={t('taskLinkEntityIdFieldPlaceholder')}
                                        />
                                    </FormField>
                                </>
                            )}
                            {form.actionType === 'UPDATE_STATUS' && (
                                <>
                                    <FormField label={t('statusEntityLabel')} required>
                                        <Combobox
                                            options={entityTypeOptions}
                                            selected={
                                                entityTypeOptions.find(
                                                    (o) => o.value === form.status.entityType,
                                                ) ?? null
                                            }
                                            setSelected={(o) => {
                                                const entityType = o?.value ?? 'Risk';
                                                patch({
                                                    status: {
                                                        entityType,
                                                        field:
                                                            UPDATE_STATUS_TARGETS[entityType]?.field ??
                                                            'status',
                                                        // reset — valid statuses differ per entity
                                                        toStatus: '',
                                                    },
                                                });
                                            }}
                                            forceDropdown
                                            matchTriggerWidth
                                        />
                                    </FormField>
                                    <FormField label={t('newStatus')} required>
                                        <Combobox
                                            options={statusValueOptions}
                                            selected={
                                                statusValueOptions.find(
                                                    (o) => o.value === form.status.toStatus,
                                                ) ?? null
                                            }
                                            setSelected={(o) =>
                                                patch({
                                                    status: {
                                                        ...form.status,
                                                        toStatus: o?.value ?? '',
                                                    },
                                                })
                                            }
                                            placeholder={t('newStatusPlaceholder')}
                                            forceDropdown
                                            matchTriggerWidth
                                        />
                                    </FormField>
                                </>
                            )}
                            {form.actionType === 'WEBHOOK' && (
                                <>
                                    <FormField label={t('webhookUrl')} required>
                                        <Input
                                            value={form.webhook.url}
                                            onChange={(e) =>
                                                patch({ webhook: { ...form.webhook, url: e.target.value } })
                                            }
                                            placeholder={t('webhookUrlPlaceholder')}
                                        />
                                    </FormField>
                                    {/* PR-E — HTTP method (schema-supported, was hardcoded POST). */}
                                    <FormField label={t('webhookMethod')}>
                                        <Combobox
                                            options={WEBHOOK_METHOD_OPTIONS}
                                            selected={
                                                WEBHOOK_METHOD_OPTIONS.find(
                                                    (o) => o.value === form.webhook.method,
                                                ) ?? WEBHOOK_METHOD_OPTIONS[0]
                                            }
                                            setSelected={(o) =>
                                                patch({ webhook: { ...form.webhook, method: o?.value ?? 'POST' } })
                                            }
                                            forceDropdown
                                            matchTriggerWidth
                                        />
                                    </FormField>
                                    {/* PR2 — custom headers (one `Name: value` per line)
                                        + HMAC secret ref, both honored by the executor. */}
                                    <FormField label={t('webhookHeaders')} description={t('webhookHeadersHint')}>
                                        <Textarea
                                            rows={3}
                                            value={form.webhook.headersText}
                                            onChange={(e) =>
                                                patch({ webhook: { ...form.webhook, headersText: e.target.value } })
                                            }
                                            placeholder={t('webhookHeadersPlaceholder')}
                                        />
                                    </FormField>
                                    <FormField label={t('webhookSecretRef')} description={t('webhookSecretRefHint')}>
                                        <Input
                                            value={form.webhook.secretRef}
                                            onChange={(e) =>
                                                patch({ webhook: { ...form.webhook, secretRef: e.target.value } })
                                            }
                                            placeholder={t('webhookSecretRefPlaceholder')}
                                        />
                                    </FormField>
                                </>
                            )}
                            {form.actionType === 'INVOKE_SUBFLOW' && (
                                <FormField label={t('subflowTargetLabel')} description={t('subflowTargetHint')} required>
                                    <Input
                                        value={form.subflow.targetGroupId}
                                        onChange={(e) =>
                                            patch({ subflow: { ...form.subflow, targetGroupId: e.target.value } })
                                        }
                                        placeholder={t('subflowTargetPlaceholder')}
                                    />
                                </FormField>
                            )}
                        </div>

                        {/* Execution watchdog (Epic 5, formerly "SLA window").
                            Flags a STUCK execution (one that runs past this many
                            minutes) — a safeguard for hung actions, not a
                            business-entity deadline. See sla-monitor.ts. */}
                        <div className="border-t border-border-subtle pt-default">
                            <FormField
                                label={t('slaLabel')}
                                description={t('slaDescription')}
                            >
                                <Input
                                    type="number"
                                    min={1}
                                    value={form.slaWindowMinutes}
                                    onChange={(e) => patch({ slaWindowMinutes: e.target.value })}
                                    placeholder={t('slaPlaceholder')}
                                />
                            </FormField>
                            {/* PR-E — breach action. Only shown once a window is
                                set. Only NOTIFY_USER is implemented server-side
                                (sla-monitor.ts), so it's the only real option —
                                we don't offer reassign/status-change that would
                                silently no-op. */}
                            {form.slaWindowMinutes && (
                                <div className="mt-default space-y-default">
                                    <FormField label={t('slaBreachActionLabel')}>
                                        <Combobox
                                            options={slaBreachActionOptions}
                                            selected={
                                                slaBreachActionOptions.find(
                                                    (o) => o.value === form.slaBreach.actionType,
                                                ) ?? slaBreachActionOptions[0]
                                            }
                                            setSelected={(o) =>
                                                patch({
                                                    slaBreach: {
                                                        ...form.slaBreach,
                                                        actionType:
                                                            (o?.value as '' | 'NOTIFY_USER') ?? '',
                                                    },
                                                })
                                            }
                                            forceDropdown
                                            matchTriggerWidth
                                        />
                                    </FormField>
                                    {form.slaBreach.actionType === 'NOTIFY_USER' && (
                                        <>
                                            <FormField label={t('slaBreachRecipients')} required>
                                                <UserCombobox
                                                    tenantSlug={tenantSlug}
                                                    multiple
                                                    selectedIds={form.slaBreach.userIds}
                                                    onChange={(ids) =>
                                                        patch({
                                                            slaBreach: {
                                                                ...form.slaBreach,
                                                                userIds: ids,
                                                            },
                                                        })
                                                    }
                                                    forceDropdown
                                                    matchTriggerWidth
                                                />
                                            </FormField>
                                            <FormField label={t('slaBreachMessage')}>
                                                <Textarea
                                                    value={form.slaBreach.message}
                                                    onChange={(e) =>
                                                        patch({
                                                            slaBreach: {
                                                                ...form.slaBreach,
                                                                message: e.target.value,
                                                            },
                                                        })
                                                    }
                                                    placeholder={t('slaBreachMessagePlaceholder')}
                                                />
                                            </FormField>
                                        </>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Chain to next rule (Epic 7) — sequential workflow. */}
                        <div className="border-t border-border-subtle pt-default space-y-default">
                            <FormField
                                label={t('chainLabel')}
                                description={t('chainDescription')}
                            >
                                <Combobox
                                    options={chainOptions}
                                    selected={
                                        form.nextRuleId
                                            ? chainOptions.find((o) => o.value === form.nextRuleId) ?? null
                                            : null
                                    }
                                    setSelected={(o) => patch({ nextRuleId: o?.value ?? '' })}
                                    placeholder={t('noChainedRule')}
                                    forceDropdown
                                    matchTriggerWidth
                                />
                            </FormField>
                            {form.nextRuleId && (
                                <FormField label={t('chainDelayLabel')}>
                                    <Input
                                        type="number"
                                        min={0}
                                        value={form.nextRuleDelay}
                                        onChange={(e) => patch({ nextRuleDelay: e.target.value })}
                                        placeholder={t('chainDelayPlaceholder')}
                                    />
                                </FormField>
                            )}
                            {/* PR-E — else-branch: canvas parity. The canvas
                                already forks a `condition-fail` edge to an
                                elseRuleId; the tabular builder now offers the
                                same "when conditions fail, run this instead"
                                target. (INVOKE_SUBFLOW stays canvas-authored:
                                sub-flow groups are canvas topology — a group
                                node wrapping rules — with no meaningful tabular
                                target, so we don't offer a raw-id picker here.) */}
                            <FormField
                                label={t('elseLabel')}
                                description={t('elseDescription')}
                            >
                                <Combobox
                                    options={chainOptions}
                                    selected={
                                        form.elseRuleId
                                            ? chainOptions.find((o) => o.value === form.elseRuleId) ?? null
                                            : null
                                    }
                                    setSelected={(o) => patch({ elseRuleId: o?.value ?? '' })}
                                    placeholder={t('noElseRule')}
                                    forceDropdown
                                    matchTriggerWidth
                                />
                            </FormField>
                        </div>
                    </div>
                )}

                {error && <p className="mt-default text-sm text-content-error">{error}</p>}
            </Modal.Body>
            <Modal.Actions align="between">
                <Button
                    variant="ghost"
                    onClick={() => (step === 1 ? setOpen(false) : setStep((s) => (s - 1) as 1 | 2))}
                >
                    {step === 1 ? t('cancel') : t('back')}
                </Button>
                {step < 3 ? (
                    <Button
                        variant="primary"
                        disabled={step === 1 && !step1Valid}
                        onClick={() => setStep((s) => (s + 1) as 2 | 3)}
                    >
                        {t('next')}
                    </Button>
                ) : (
                    <Button
                        variant="primary"
                        loading={submitting}
                        disabled={!step3Valid || submitting}
                        onClick={handleSave}
                    >
                        {editRule ? t('saveRule') : t('createRule')}
                    </Button>
                )}
            </Modal.Actions>
        </Modal>
    );
}
