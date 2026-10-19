'use client';

/**
 * Author a workspace skill, or edit one into a new version (#3680, step 4c).
 *
 * Create posts the name and version 1's fields; edit posts a full set of fields
 * for version N+1. Either way the result is a DRAFT that mounts nothing until a
 * person other than its author approves it. The server decides everything —
 * sanitising, the loader's rules, the text scan — and a refusal arrives as its
 * sentence plus, for the scan, the rule ids that fired. Those are shown INLINE
 * and the dialog stays open over them, so the author can fix the text they
 * still have in front of them. The refused text is never echoed back by the
 * server; it is only ever what the author typed.
 */
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { useToast } from '@/components/ui/hooks';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Textarea } from '@/components/ui/textarea';
import { apiErrorMessage } from '@/lib/api-error';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { TENANT_SKILL_LIMITS } from '@/app-layer/schemas/tenant-skill.schemas';

/** The fields an edit starts from: the version being edited, as the server returned it. */
export interface TenantSkillDraftFields {
    description: string;
    instructions: string;
    license: string;
    sourceRef: string;
    workflowKeys: string[];
    requiredInput: string | null;
    controls: string | null;
    tools: string | null;
}

export interface TenantSkillEditorTarget {
    /** Absent for a new skill. */
    readonly skillId?: string;
    readonly name?: string;
    readonly from?: TenantSkillDraftFields;
}

interface WorkflowOption {
    value: string;
    label: string;
}

/** The scan's rule ids from a refusal body, when it carries them. */
function refusedRules(body: unknown): string[] {
    const details = (body as { error?: { details?: { rules?: unknown; guardRules?: unknown } } } | null)?.error?.details;
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    return [...list(details?.rules), ...list(details?.guardRules)];
}

export function TenantSkillEditorModal({
    target,
    workflows,
    onClose,
    onSaved,
}: {
    target: TenantSkillEditorTarget;
    workflows: readonly { key: string; name: string }[];
    onClose: () => void;
    onSaved: () => void;
}) {
    const t = useTranslations('agents.skills.editor');
    const tCommon = useTranslations('common');
    const apiUrl = useTenantApiUrl();
    const toast = useToast();
    const editing = target.skillId !== undefined;

    const [name, setName] = useState(target.name ?? '');
    const [description, setDescription] = useState(target.from?.description ?? '');
    const [instructions, setInstructions] = useState(target.from?.instructions ?? '');
    const [license, setLicense] = useState(target.from?.license ?? '');
    const [sourceRef, setSourceRef] = useState(target.from?.sourceRef ?? '');
    const [workflowKeys, setWorkflowKeys] = useState<string[]>(target.from?.workflowKeys ?? []);
    const [requiredInput, setRequiredInput] = useState(target.from?.requiredInput ?? '');
    const [controls, setControls] = useState(target.from?.controls ?? '');
    const [tools, setTools] = useState(target.from?.tools ?? '');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<{ message: string; rules: string[] } | null>(null);

    const options: WorkflowOption[] = useMemo(
        () => workflows.map((w) => ({ value: w.key, label: w.name })),
        [workflows],
    );

    const canSubmit =
        !busy
        && (editing || name.trim().length > 0)
        && description.trim().length > 0
        && instructions.trim().length > 0
        && license.trim().length > 0
        && sourceRef.trim().length > 0;

    const submit = async () => {
        if (!canSubmit) return;
        setBusy(true);
        setError(null);
        const fields = {
            description,
            instructions,
            license,
            sourceRef,
            workflowKeys,
            requiredInput: requiredInput.trim() || null,
            controls: controls.trim() || null,
            tools: tools.trim() || null,
        };
        try {
            const res = editing
                ? await fetch(apiUrl(`/admin/agents/skills/tenant/${target.skillId}/versions`), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(fields),
                })
                : await fetch(apiUrl('/admin/agents/skills/tenant'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: name.trim(), ...fields }),
                });
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                const message = apiErrorMessage(body, t('failed'));
                setError({ message, rules: refusedRules(body) });
                toast.error(message);
                return;
            }
            toast.success(t('saved'));
            onSaved();
        } catch {
            setError({ message: t('failed'), rules: [] });
            toast.error(t('failed'));
        } finally {
            setBusy(false);
        }
    };

    const title = editing ? t('editTitle', { name: target.name ?? '' }) : t('createTitle');

    return (
        <Modal
            showModal
            setShowModal={(v) => {
                if (!v && !busy) onClose();
            }}
            size="lg"
            title={title}
            preventDefaultClose={busy}
        >
            <Modal.Header title={title} description={editing ? t('editDescription') : t('createDescription')} />
            <Modal.Form
                onSubmit={(e) => {
                    e.preventDefault();
                    void submit();
                }}
            >
                <Modal.Body>
                    <div className="space-y-default" data-testid="tenant-skill-editor">
                        {error && (
                            <InlineNotice variant="error" data-testid="tenant-skill-editor-error">
                                {error.message}
                                {error.rules.length > 0 ? ` ${t('refusedRules', { rules: error.rules.join(', ') })}` : null}
                            </InlineNotice>
                        )}
                        {!editing && (
                            <FormField label={t('name')} description={t('nameHint')} required>
                                <Input
                                    id="tenant-skill-name"
                                    value={name}
                                    maxLength={TENANT_SKILL_LIMITS.nameChars}
                                    onChange={(e) => setName(e.target.value)}
                                    disabled={busy}
                                />
                            </FormField>
                        )}
                        <FormField label={t('description')} description={t('descriptionHint')} required>
                            <Textarea
                                id="tenant-skill-description"
                                rows={2}
                                maxLength={TENANT_SKILL_LIMITS.descriptionChars}
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                disabled={busy}
                            />
                        </FormField>
                        <FormField label={t('instructions')} description={t('instructionsHint')} required>
                            <Textarea
                                id="tenant-skill-instructions"
                                rows={12}
                                maxLength={TENANT_SKILL_LIMITS.instructionsBytes}
                                value={instructions}
                                onChange={(e) => setInstructions(e.target.value)}
                                disabled={busy}
                            />
                        </FormField>
                        <FormField label={t('licence')} description={t('licenceHint')} required>
                            <Input
                                id="tenant-skill-licence"
                                value={license}
                                maxLength={TENANT_SKILL_LIMITS.licenseChars}
                                onChange={(e) => setLicense(e.target.value)}
                                disabled={busy}
                            />
                        </FormField>
                        <FormField label={t('source')} description={t('sourceHint')} required>
                            <Input
                                id="tenant-skill-source"
                                value={sourceRef}
                                maxLength={TENANT_SKILL_LIMITS.sourceRefChars}
                                onChange={(e) => setSourceRef(e.target.value)}
                                disabled={busy}
                            />
                        </FormField>
                        <FormField label={t('workflows')} description={t('workflowsHint')}>
                            <Combobox<true, WorkflowOption>
                                multiple
                                id="tenant-skill-workflows"
                                options={options}
                                selected={options.filter((o) => workflowKeys.includes(o.value))}
                                setSelected={(opts) => setWorkflowKeys(opts.map((o) => o.value))}
                                placeholder={t('workflowsPlaceholder')}
                                matchTriggerWidth
                            />
                        </FormField>
                        <FormField label={t('requiredInput')} description={t('requiredInputHint')}>
                            <Input
                                id="tenant-skill-required-input"
                                value={requiredInput}
                                maxLength={TENANT_SKILL_LIMITS.metadataChars}
                                onChange={(e) => setRequiredInput(e.target.value)}
                                disabled={busy}
                            />
                        </FormField>
                        <FormField label={t('controls')} description={t('controlsHint')}>
                            <Input
                                id="tenant-skill-controls"
                                value={controls}
                                maxLength={TENANT_SKILL_LIMITS.metadataChars}
                                onChange={(e) => setControls(e.target.value)}
                                disabled={busy}
                            />
                        </FormField>
                        <FormField label={t('tools')} description={t('toolsHint')}>
                            <Input
                                id="tenant-skill-tools"
                                value={tools}
                                maxLength={TENANT_SKILL_LIMITS.metadataChars}
                                onChange={(e) => setTools(e.target.value)}
                                disabled={busy}
                            />
                        </FormField>
                    </div>
                </Modal.Body>
                <Modal.Footer>
                    <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
                        {tCommon('cancel')}
                    </Button>
                    <Button type="submit" variant="primary" disabled={!canSubmit} data-testid="tenant-skill-save">
                        {busy ? t('saving') : t('save')}
                    </Button>
                </Modal.Footer>
            </Modal.Form>
        </Modal>
    );
}
