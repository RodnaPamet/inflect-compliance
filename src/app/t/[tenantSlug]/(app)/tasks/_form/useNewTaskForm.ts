'use client';

/**
 * Task-create form hook — B6 useZodForm adoption.
 *
 * Pre-B6 this was a hand-rolled `useState` shape. B6 ports the
 * core form-state onto `useZodForm` (driven by
 * `NewTaskFormSchema`). The TASK-specific extras stay outside the
 * Zod schema:
 *
 *   - `pendingLinks` — staging buffer for secondary POSTs after
 *     the task is minted. Not part of the canonical task body so
 *     it stays in local state.
 *   - `findingSource` / `controlGapType` — type-conditional
 *     metadata that lands in `metadataJson` only when set.
 *   - `validationMessage` — derived semantic gate
 *     (AUDIT_FINDING / CONTROL_GAP require a control link;
 *     INCIDENT requires an asset / control link). Zod alone can't
 *     express this because the link list is sibling state, not a
 *     field of the form. The hook ANDs the validation message into
 *     canSubmit so the legacy contract holds.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { useToast } from '@/components/ui/hooks';
import { useFormTelemetry } from '@/lib/telemetry/form-telemetry';
import { useZodForm } from '@/lib/hooks/use-zod-form';
import {
    NewTaskFormSchema,
    type NewTaskFormValues,
} from '@/lib/schemas/task-form';

export type TaskType = NewTaskFormValues['type'];

export interface PendingLink {
    entityType: string;
    entityId: string;
}

// Extra type-conditional fields kept outside Zod (see file
// header). Combined with NewTaskFormValues for the field surface.
export interface NewTaskFormExtras {
    findingSource: string;
    controlGapType: string;
}

export type NewTaskFormFields = NewTaskFormValues & NewTaskFormExtras;

export interface NewTaskFormReturn {
    fields: NewTaskFormFields;
    setField: <K extends keyof NewTaskFormFields>(
        key: K,
        value: NewTaskFormFields[K],
    ) => void;
    touchField: <K extends keyof NewTaskFormFields>(key: K) => void;
    fieldError: <K extends keyof NewTaskFormFields>(key: K) => string | undefined;
    pendingLinks: PendingLink[];
    linkEntityType: string;
    setLinkEntityType: (entityType: string) => void;
    linkEntityId: string;
    setLinkEntityId: (entityId: string) => void;
    addPendingLink: () => void;
    removePendingLink: (index: number) => void;
    submitting: boolean;
    error: string | null;
    canSubmit: boolean;
    validationMessage: string;
    submit: () => Promise<void>;
    isDirty: boolean;
}

export interface UseNewTaskFormOptions {
    onSuccess: (task: { id: string }) => void;
    /**
     * PR-C — optional pre-fill for the `dueAt` field. The calendar
     * page double-click flow seeds this with the day cell's YMD so
     * the create modal opens with the right due date already
     * selected.
     */
    initialDueAt?: string;
    /**
     * Preset entity links staged on open. The control / asset / risk
     * detail pages seed this with their own entity so a task created
     * from those surfaces is linked back (and lands in the global
     * Tasks list) without the user having to add the link by hand.
     */
    initialPendingLinks?: PendingLink[];
}

const INITIAL: NewTaskFormValues = {
    title: '',
    description: '',
    type: 'TASK',
    severity: 'MEDIUM',
    priority: 'P2',
    dueAt: '',
    assigneeUserId: '',
    reviewerUserId: '',
    controlId: '',
};

export function useNewTaskForm({
    onSuccess,
    initialDueAt,
    initialPendingLinks,
}: UseNewTaskFormOptions): NewTaskFormReturn {
    const apiUrl = useTenantApiUrl();
    const t = useTranslations('tasks');
    const toast = useToast();
    const telemetry = useFormTelemetry('NewTaskPage');

    // Extras kept outside Zod — see file header.
    const [findingSource, setFindingSource] = useState('');
    const [controlGapType, setControlGapType] = useState('');
    const [pendingLinks, setPendingLinks] = useState<PendingLink[]>(
        initialPendingLinks ?? [],
    );
    const [linkEntityType, setLinkEntityType] = useState('CONTROL');
    const [linkEntityId, setLinkEntityId] = useState('');
    const [extrasDirty, setExtrasDirty] = useState(false);

    const zod = useZodForm({
        schema: NewTaskFormSchema,
        // PR-C — merge any caller-supplied seed (currently just the
        // calendar's double-click date) over the canonical INITIAL.
        initial: initialDueAt
            ? { ...INITIAL, dueAt: initialDueAt }
            : INITIAL,
        onSubmit: async (payload) => {
            telemetry.trackSubmit({
                type: payload.type,
                severity: payload.severity,
                priority: payload.priority,
                pendingLinkCount: pendingLinks.length,
                hasAssignee: Boolean(payload.assigneeUserId),
            });

            try {
                const metadataJson: Record<string, string> = {};
                if (findingSource) metadataJson.findingSource = findingSource;
                if (controlGapType) metadataJson.controlGapType = controlGapType;

                const body: { title: string; type: string; severity: string; priority: string; description?: string; dueAt?: string; assigneeUserId?: string; reviewerUserId?: string; controlId?: string; metadataJson?: Record<string, string> } = {
                    title: payload.title,
                    type: payload.type,
                    severity: payload.severity,
                    priority: payload.priority,
                    description: payload.description || undefined,
                    dueAt: payload.dueAt || undefined,
                    assigneeUserId: payload.assigneeUserId || undefined,
                    // TP-2 — reviewer is settable at create so a reviewed task
                    // starts its lifecycle with the sign-off gate already armed.
                    reviewerUserId: payload.reviewerUserId || undefined,
                    controlId: payload.controlId || undefined,
                    metadataJson:
                        Object.keys(metadataJson).length > 0
                            ? metadataJson
                            : undefined,
                };
                const res = await fetch(apiUrl('/tasks'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({}));
                    const msg =
                        typeof data.error === 'string'
                            ? data.error
                            : data.message || t('new.createFailed');
                    throw new Error(msg);
                }
                const task = await res.json();

                // TP-6 — secondary POSTs for the staged links. These are
                // NOT best-effort: a swallowed failure here left the task
                // link-less (and, for AUDIT_FINDING / CONTROL_GAP /
                // INCIDENT types, later UN-CLOSABLE because the type
                // relevance check requires a control/asset link) while
                // the form reported success. Collect any failure and
                // surface it instead of pretending the create fully
                // succeeded.
                const failedLinks: PendingLink[] = [];
                for (const link of pendingLinks) {
                    try {
                        const linkRes = await fetch(apiUrl(`/tasks/${task.id}/links`), {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                entityType: link.entityType,
                                entityId: link.entityId,
                                relation: 'RELATES_TO',
                            }),
                        });
                        if (!linkRes.ok) failedLinks.push(link);
                    } catch {
                        failedLinks.push(link);
                    }
                }

                if (failedLinks.length > 0) {
                    const detail = failedLinks
                        .map((l) => `${l.entityType} ${l.entityId}`)
                        .join(', ');
                    // PARTIAL SUCCESS — the task row exists; only some of
                    // the staged links failed to attach.
                    //
                    // This used to `throw`, on the reasoning that the
                    // caller must not treat a partial result as a clean
                    // success. The visibility instinct was right but the
                    // mechanism was wrong: throwing left the modal open
                    // over an ALREADY-CREATED task, with a submittable
                    // form and no route to the new task — so the natural
                    // recovery (press the button again) minted a
                    // DUPLICATE, and the only alternative was to close the
                    // modal and hope the task was really there.
                    //
                    // The create succeeded, so the flow completes: this
                    // resolves through `onSuccess`, which closes the modal
                    // and navigates to the new task — the page where the
                    // missing links can actually be added. The failure
                    // stays loud via a warning toast naming exactly which
                    // links did not attach.
                    toast.warning(
                        t('new.linksFailedDetail', {
                            count: failedLinks.length,
                            detail,
                        }),
                    );
                    telemetry.trackSuccess({ taskId: task.id, partial: true });
                    onSuccess(task);
                    return;
                }

                telemetry.trackSuccess({ taskId: task.id });
                onSuccess(task);
            } catch (e) {
                // Re-throw so useZodForm marks the hook's `error`
                // state; telemetry sink gets the same instance.
                telemetry.trackError(e);
                throw e;
            }
        },
    });

    // Mixed field setter — Zod schema-managed for the core fields,
    // local state for the extras. Keeps the consumer's
    // `form.setField('findingSource', '…')` ergonomics intact.
    const setField: NewTaskFormReturn['setField'] = (key, value) => {
        if (key === 'findingSource') {
            setFindingSource(value as string);
            setExtrasDirty(true);
            return;
        }
        if (key === 'controlGapType') {
            setControlGapType(value as string);
            setExtrasDirty(true);
            return;
        }
        // The mixed-keyset means we have to widen the value type
        // at the hook boundary. The unknown-cast bridge satisfies
        // the generic without weakening the call-site type.
        type FormKey = keyof NewTaskFormValues;
        type FormValue = NewTaskFormValues[FormKey];
        zod.setField(key as FormKey, value as unknown as FormValue);
    };

    const touchField: NewTaskFormReturn['touchField'] = (key) => {
        if (key === 'findingSource' || key === 'controlGapType') return;
        zod.touchField(key as keyof NewTaskFormValues);
    };

    const fieldError: NewTaskFormReturn['fieldError'] = (key) => {
        if (key === 'findingSource' || key === 'controlGapType') return undefined;
        return zod.fieldError(key as keyof NewTaskFormValues);
    };

    const fields: NewTaskFormFields = {
        ...zod.values,
        findingSource,
        controlGapType,
    };

    const addPendingLink = () => {
        if (!linkEntityId.trim()) return;
        setPendingLinks((prev) => [
            ...prev,
            { entityType: linkEntityType, entityId: linkEntityId.trim() },
        ]);
        setLinkEntityId('');
        setExtrasDirty(true);
    };
    const removePendingLink = (idx: number) => {
        setPendingLinks((prev) => prev.filter((_, i) => i !== idx));
    };

    // Validation: certain types require a control or link.
    const needsControlOrLink = ['AUDIT_FINDING', 'CONTROL_GAP'].includes(
        fields.type,
    );
    const needsAssetOrControl = fields.type === 'INCIDENT';
    const hasControlOrLink =
        !!fields.controlId ||
        pendingLinks.some((l) =>
            ['CONTROL', 'FRAMEWORK_REQUIREMENT'].includes(l.entityType),
        );
    const hasAssetOrControl =
        !!fields.controlId ||
        pendingLinks.some((l) => ['CONTROL', 'ASSET'].includes(l.entityType));

    const validationMessage = (() => {
        if (needsControlOrLink && !hasControlOrLink) {
            return t('new.requiresControlOrLink');
        }
        if (needsAssetOrControl && !hasAssetOrControl) {
            return t('new.requiresAssetOrControl');
        }
        return '';
    })();

    return {
        fields,
        setField,
        touchField,
        fieldError,
        pendingLinks,
        linkEntityType,
        setLinkEntityType,
        linkEntityId,
        setLinkEntityId,
        addPendingLink,
        removePendingLink,
        submitting: zod.submitting,
        error: zod.error,
        canSubmit: zod.canSubmit && !validationMessage,
        validationMessage,
        submit: async () => {
            if (validationMessage) {
                // Surface the semantic-gate message so the consumer
                // doesn't need a separate guard before calling submit.
                throw new Error(validationMessage);
            }
            await zod.submit();
        },
        isDirty: zod.isDirty || extrasDirty,
    };
}
