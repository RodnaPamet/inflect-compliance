'use client';

/**
 * Controlled field markup for the task-create form. Reads its state
 * from a `useNewTaskForm()` instance — owns no state of its own.
 *
 * Both the legacy `/tasks/new` page and the future `<NewTaskModal>`
 * (P2) compose this component unchanged.
 */
import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { FormError } from '@/components/ui/form-error';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip } from '@/components/ui/tooltip';
import { DatePicker } from '@/components/ui/date-picker/date-picker';
import {
    parseYMD,
    startOfUtcDay,
    toYMD,
} from '@/components/ui/date-picker/date-utils';
import { UserCombobox } from '@/components/ui/user-combobox';
import {
    EntityPicker,
    fetchEntityLabel,
    type EntityPickerKind,
} from '@/components/ui/entity-picker';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import {
    LINK_ENTITY_TYPES,
    type NewTaskFormFields,
    type NewTaskFormReturn,
} from './useNewTaskForm';

type Tr = (key: string) => string;
const optsFrom = (t: Tr, prefix: string, values: readonly string[]): ComboboxOption[] =>
    values.map((v) => ({ value: v, label: t(`${prefix}.${v}`) }));

const buildTypeOptions = (t: Tr): ComboboxOption[] =>
    optsFrom(t, 'typeLabels', ['TASK', 'AUDIT_FINDING', 'CONTROL_GAP', 'INCIDENT', 'IMPROVEMENT']);
const buildSeverityOptions = (t: Tr): ComboboxOption[] =>
    optsFrom(t, 'severityLabels', ['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const buildPriorityOptions = (t: Tr): ComboboxOption[] =>
    optsFrom(t, 'priorityLabels', ['P0', 'P1', 'P2', 'P3']);
const buildLinkEntityOptions = (t: Tr): ComboboxOption[] =>
    optsFrom(t, 'linkEntity', LINK_ENTITY_TYPES);
const buildFindingOptions = (t: Tr): ComboboxOption[] =>
    optsFrom(t, 'findingSourceLabels', ['INTERNAL', 'EXTERNAL_AUDITOR', 'PEN_TEST', 'INCIDENT']);
const buildGapTypeOptions = (t: Tr): ComboboxOption[] =>
    optsFrom(t, 'gapTypeLabels', ['DESIGN', 'OPERATING_EFFECTIVENESS', 'DOCUMENTATION']);

export function NewTaskFields({
    form,
    tenantSlug,
}: {
    form: NewTaskFormReturn;
    tenantSlug: string;
}) {
    const t = useTranslations('tasks');
    const tCommon = useTranslations('common');
    const untitled = tCommon('ui.untitled');
    // A preset link (staged by the control / risk / asset page the form
    // was opened from) carries only a type and an id. Look its name up
    // once so the staged list can show it; keyed on the unlabelled links
    // so a resolved one is never fetched again.
    const { labelPendingLink } = form;
    const unlabelled = form.pendingLinks
        .flatMap((l) => (l.label ? [] : [`${l.entityType}:${l.entityId}`]))
        .join('|');
    useEffect(() => {
        if (!unlabelled) return;
        let active = true;
        for (const ref of unlabelled.split('|')) {
            const sep = ref.indexOf(':');
            const entityType = ref.slice(0, sep);
            const entityId = ref.slice(sep + 1);
            void fetchEntityLabel(
                tenantSlug,
                entityType as EntityPickerKind,
                entityId,
                untitled,
            ).then((label) => {
                if (active && label) labelPendingLink(entityType, entityId, label);
            });
        }
        return () => {
            active = false;
        };
    }, [unlabelled, tenantSlug, untitled, labelPendingLink]);
    const TYPE_OPTIONS = buildTypeOptions(t);
    const SEVERITY_OPTIONS = buildSeverityOptions(t);
    const PRIORITY_OPTIONS = buildPriorityOptions(t);
    const LINK_ENTITY_OPTIONS = buildLinkEntityOptions(t);
    const FINDING_OPTIONS = buildFindingOptions(t);
    const GAP_TYPE_OPTIONS = buildGapTypeOptions(t);
    return (
        <>
            <FormField label={t('new.title')} required>
                <Input
                    id="task-title-input"
                    type="text"
                    placeholder={t('new.titlePlaceholder')}
                    value={form.fields.title}
                    onChange={(e) => form.setField('title', e.target.value)}
                    required
                />
            </FormField>
            <FormField label={t('new.description')}>
                <Textarea
                    id="task-description-input"
                    rows={3}
                    placeholder={t('new.descriptionPlaceholder')}
                    value={form.fields.description}
                    onChange={(e) => form.setField('description', e.target.value)}
                />
            </FormField>
            <div className="grid grid-cols-3 gap-default">
                <FormField label={t('new.type')} required>
                    <Combobox
                        id="task-type-select"
                        name="type"
                        options={TYPE_OPTIONS}
                        selected={
                            TYPE_OPTIONS.find(
                                (o) => o.value === form.fields.type,
                            ) ?? null
                        }
                        setSelected={(o) =>
                            form.setField(
                                'type',
                                (o?.value ?? 'TASK') as typeof form.fields.type,
                            )
                        }
                        placeholder={t('new.typePlaceholder')}
                        hideSearch
                        matchTriggerWidth
                        buttonProps={{ className: 'w-full' }}
                        caret
                    />
                </FormField>
                <FormField label={t('new.severity')}>
                    <Combobox
                        id="task-severity-select"
                        name="severity"
                        options={SEVERITY_OPTIONS}
                        selected={
                            SEVERITY_OPTIONS.find(
                                (o) => o.value === form.fields.severity,
                            ) ?? null
                        }
                        setSelected={(o) =>
                            form.setField(
                                'severity',
                                (o?.value ?? 'MEDIUM') as NewTaskFormFields['severity'],
                            )
                        }
                        placeholder={t('new.severityPlaceholder')}
                        hideSearch
                        matchTriggerWidth
                        buttonProps={{ className: 'w-full' }}
                        caret
                    />
                </FormField>
                <FormField label={t('new.priority')}>
                    <Combobox
                        id="task-priority-select"
                        name="priority"
                        options={PRIORITY_OPTIONS}
                        selected={
                            PRIORITY_OPTIONS.find(
                                (o) => o.value === form.fields.priority,
                            ) ?? null
                        }
                        setSelected={(o) =>
                            form.setField(
                                'priority',
                                (o?.value ?? 'P2') as NewTaskFormFields['priority'],
                            )
                        }
                        placeholder={t('new.priorityPlaceholder')}
                        hideSearch
                        matchTriggerWidth
                        buttonProps={{ className: 'w-full' }}
                        caret
                    />
                </FormField>
            </div>
            <div className="grid grid-cols-2 gap-default">
                <FormField label={t('new.dueDate')}>
                    <DatePicker
                        id="task-due-input"
                        className="w-full"
                        placeholder={t('new.duePlaceholder')}
                        clearable
                        align="start"
                        value={parseYMD(form.fields.dueAt)}
                        onChange={(next) =>
                            form.setField('dueAt', toYMD(next) ?? '')
                        }
                        disabledDays={{
                            before: startOfUtcDay(new Date()),
                        }}
                        aria-label={t('new.dueAria')}
                    />
                </FormField>
                <FormField label={t('new.assignee')}>
                    <UserCombobox
                        id="task-assignee-input"
                        name="assigneeUserId"
                        tenantSlug={tenantSlug}
                        selectedId={form.fields.assigneeUserId || null}
                        onChange={(userId) =>
                            form.setField('assigneeUserId', userId ?? '')
                        }
                        placeholder={t('new.assigneePlaceholder')}
                        forceDropdown={false}
                    />
                </FormField>
                <FormField label={t('new.reviewer')} hint={t('new.reviewerHint')}>
                    <UserCombobox
                        id="task-reviewer-input"
                        name="reviewerUserId"
                        tenantSlug={tenantSlug}
                        selectedId={form.fields.reviewerUserId || null}
                        onChange={(userId) =>
                            form.setField('reviewerUserId', userId ?? '')
                        }
                        placeholder={t('new.reviewerPlaceholder')}
                        forceDropdown={false}
                    />
                </FormField>
            </div>

            <FormField label={t('new.control')}>
                <EntityPicker
                    id="task-control-input"
                    tenantSlug={tenantSlug}
                    entityType="CONTROL"
                    value={form.fields.controlId ?? ''}
                    onChange={(id) => form.setField('controlId', id)}
                    placeholder={t('new.controlPlaceholder')}
                    testId="task-control-picker"
                />
            </FormField>

            {(form.fields.type === 'AUDIT_FINDING' ||
                form.fields.type === 'CONTROL_GAP') && (
                <div className="border-t border-border-default pt-4 space-y-default">
                    <Heading level={3}>{t('new.auditDetails')}</Heading>
                    <div className="grid grid-cols-2 gap-default">
                        <FormField label={t('new.findingSource')}>
                            <Combobox
                                id="finding-source-select"
                                name="findingSource"
                                options={FINDING_OPTIONS}
                                selected={
                                    FINDING_OPTIONS.find(
                                        (o) =>
                                            o.value === form.fields.findingSource,
                                    ) ?? null
                                }
                                setSelected={(o) =>
                                    form.setField('findingSource', o?.value ?? '')
                                }
                                placeholder={t('new.findingSourcePlaceholder')}
                                hideSearch
                                matchTriggerWidth
                                buttonProps={{ className: 'w-full' }}
                                caret
                            />
                        </FormField>
                        {form.fields.type === 'CONTROL_GAP' && (
                            <FormField label={t('new.controlGapType')}>
                                <Combobox
                                    id="gap-type-select"
                                    name="controlGapType"
                                    options={GAP_TYPE_OPTIONS}
                                    selected={
                                        GAP_TYPE_OPTIONS.find(
                                            (o) =>
                                                o.value ===
                                                form.fields.controlGapType,
                                        ) ?? null
                                    }
                                    setSelected={(o) =>
                                        form.setField(
                                            'controlGapType',
                                            o?.value ?? '',
                                        )
                                    }
                                    placeholder={t('new.controlGapTypePlaceholder')}
                                    hideSearch
                                    matchTriggerWidth
                                    buttonProps={{ className: 'w-full' }}
                                    caret
                                />
                            </FormField>
                        )}
                    </div>
                </div>
            )}

            {/* Links section */}
            <div className="border-t border-border-default pt-4 space-y-compact">
                <Heading level={3}>{t('new.links')}</Heading>
                {form.validationMessage && (
                    <FormError
                        id="link-validation-hint"
                        className="bg-bg-warning/10 border border-border-warning/40 text-content-warning rounded px-3 py-2 mt-0"
                    >
                        {form.validationMessage}
                    </FormError>
                )}
                <div className="flex gap-tight items-end">
                    <FormField label={t('new.entityType')} className="flex-1">
                        <Combobox
                            id="link-entity-type"
                            name="linkEntityType"
                            options={LINK_ENTITY_OPTIONS}
                            selected={
                                LINK_ENTITY_OPTIONS.find(
                                    (o) => o.value === form.linkEntityType,
                                ) ?? null
                            }
                            setSelected={(o) =>
                                form.setLinkEntityType(o?.value ?? 'CONTROL')
                            }
                            placeholder={t('new.entityTypePlaceholder')}
                            hideSearch
                            matchTriggerWidth
                            buttonProps={{ className: 'w-full' }}
                            caret
                        />
                    </FormField>
                    <FormField label={t('new.entity')} className="flex-1">
                        {/* PR-D — entity picker replaces the legacy
                            "Paste ID" Input. Driven by the sibling
                            entity-type Combobox above; the picker
                            writes the cuid into `form.linkEntityId`
                            so the addPendingLink handler stays
                            unchanged. */}
                        <EntityPicker
                            tenantSlug={tenantSlug}
                            entityType={form.linkEntityType as EntityPickerKind}
                            value={form.linkEntityId}
                            onChange={form.setLinkEntityId}
                            id="link-entity-id"
                            testId="new-task-link-entity-picker"
                            placeholder={t('new.entityPlaceholder')}
                        />
                    </FormField>
                    <Button
                        type="button"
                        variant="secondary"
                        onClick={form.addPendingLink}
                        id="add-link-btn"
                    >
                        {t('new.add')}
                    </Button>
                </div>
                {form.pendingLinks.length > 0 && (
                    <div className="space-y-1" id="pending-links-list">
                        {form.pendingLinks.map((l, i) => (
                            <div
                                key={i}
                                className="flex items-center gap-tight text-sm text-content-default bg-bg-default/50 rounded px-3 py-1.5"
                            >
                                <StatusBadge variant="info">
                                    {form.linkTypeLabel(l.entityType)}
                                </StatusBadge>
                                <span className="text-xs flex-1">
                                    {l.label ?? t('new.linkedRecord')}
                                </span>
                                <Tooltip content={t('new.removeTooltip')}>
                                    <button
                                        type="button"
                                        className="text-content-error text-xs hover:text-content-error"
                                        onClick={() => form.removePendingLink(i)}
                                        aria-label={t('new.removeAria')}
                                    >
                                        ×
                                    </button>
                                </Tooltip>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </>
    );
}
