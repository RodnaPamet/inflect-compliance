'use client';

/**
 * EditAuditModal — the write-back half of audit metadata.
 *
 * `CreateAuditSchema` accepted `schedule`, `departments`, `frameworkKey` and
 * `auditCycleId`; `UpdateAuditSchema` did not, and `.strip()` dropped them
 * with no error. So a mis-typed audit date, a wrong framework, or an audit
 * attached to the wrong cycle was permanent — the only remedy was deleting
 * the audit and re-creating it, which takes its checklist and findings with
 * it. The API side now accepts all four; this is the surface that sends them.
 *
 * Deliberately a plain controlled form rather than `useNewAuditForm`: that
 * hook seeds from a fixed INITIAL constant and POSTs to `/audits`. An edit
 * seeds from the audit being edited and PUTs to `/audits/{id}` — sharing the
 * hook would mean parameterising both ends of it for no gain.
 */
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { DatePicker } from '@/components/ui/date-picker';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Textarea } from '@/components/ui/textarea';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { useToast } from '@/components/ui/hooks';

export interface EditableAudit {
    id: string;
    title: string;
    auditScope: string | null;
    criteria?: string | null;
    schedule?: string | null;
    departments?: string | null;
    frameworkKey?: string | null;
    auditCycleId?: string | null;
}

export interface EditAuditModalProps {
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    audit: EditableAudit;
    /** Called after a successful PUT so the caller can refresh its panes. */
    onSaved: () => void;
}

/** `YYYY-MM-DD` — the wire format the API's date fields accept. */
function toYMD(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function EditAuditModal({ open, setOpen, audit, onSaved }: EditAuditModalProps) {
    const tx = useTranslations('audits');
    const apiUrl = useTenantApiUrl();
    const toast = useToast();

    const [title, setTitle] = useState(audit.title);
    const [scope, setScope] = useState(audit.auditScope ?? '');
    const [criteria, setCriteria] = useState(audit.criteria ?? '');
    const [departments, setDepartments] = useState(audit.departments ?? '');
    const [schedule, setSchedule] = useState<Date | null>(
        audit.schedule ? new Date(audit.schedule) : null,
    );
    const [frameworkKey, setFrameworkKey] = useState(audit.frameworkKey ?? '');
    const [auditCycleId, setAuditCycleId] = useState(audit.auditCycleId ?? '');
    const [saving, setSaving] = useState(false);

    // Reseed when a different audit is opened — the modal instance is reused.
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setTitle(audit.title);
        setScope(audit.auditScope ?? '');
        setCriteria(audit.criteria ?? '');
        setDepartments(audit.departments ?? '');
        setSchedule(audit.schedule ? new Date(audit.schedule) : null);
        setFrameworkKey(audit.frameworkKey ?? '');
        setAuditCycleId(audit.auditCycleId ?? '');
    }, [audit]);

    const noFramework = useMemo<ComboboxOption>(
        () => ({ value: '', label: tx('newModal.noFramework') }),
        [tx],
    );
    const noCycle = useMemo<ComboboxOption>(
        () => ({ value: '', label: tx('newModal.noCycle') }),
        [tx],
    );
    const [frameworks, setFrameworks] = useState<ComboboxOption[]>([noFramework]);
    const [cycles, setCycles] = useState<ComboboxOption[]>([noCycle]);

    // Both pickers fail soft: a failed catalogue GET leaves the current value
    // selectable rather than blocking the whole edit.
    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        void (async () => {
            try {
                const res = await fetch(apiUrl('/frameworks'));
                if (!res.ok || cancelled) return;
                const rows = (await res.json()) as Array<{ key: string; name: string }>;
                if (cancelled) return;
                // eslint-disable-next-line react-hooks/set-state-in-effect
                setFrameworks([noFramework, ...rows.map((f) => ({ value: f.key, label: f.name }))]);
            } catch { /* fail-soft */ }
        })();
        return () => { cancelled = true; };
    }, [open, apiUrl, noFramework]);

    useEffect(() => {
        if (!open) return;
        let cancelled = false;
        void (async () => {
            try {
                const res = await fetch(apiUrl('/audits/cycles'));
                if (!res.ok || cancelled) return;
                const rows = (await res.json()) as Array<{ id: string; name: string; frameworkKey: string }>;
                if (cancelled) return;
                // eslint-disable-next-line react-hooks/set-state-in-effect
                setCycles([noCycle, ...rows.map((c) => ({ value: c.id, label: `${c.name} · ${c.frameworkKey}` }))]);
            } catch { /* fail-soft */ }
        })();
        return () => { cancelled = true; };
    }, [open, apiUrl, noCycle]);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (saving || !title.trim()) return;
        setSaving(true);
        try {
            const res = await fetch(apiUrl(`/audits/${audit.id}`), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: title.trim(),
                    scope,
                    criteria: criteria.trim() || null,
                    departments: departments.trim() || null,
                    // `null` clears the column; a date sends the `YYYY-MM-DD`
                    // wire format the schema accepts.
                    schedule: schedule ? toYMD(schedule) : null,
                    frameworkKey: frameworkKey.trim() || null,
                    auditCycleId: auditCycleId.trim() || null,
                }),
            });
            if (!res.ok) {
                toast.error(tx('editModal.saveFailed'));
                return;
            }
            toast.success(tx('editModal.saved'));
            setOpen(false);
            onSaved();
        } catch {
            toast.error(tx('editModal.saveFailed'));
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal
            showModal={open}
            setShowModal={setOpen}
            size="lg"
            title={tx('editModal.title')}
            description={tx('editModal.description')}
            preventDefaultClose={saving}
        >
            <Modal.Header title={tx('editModal.title')} description={tx('editModal.description')} />
            <Modal.Form id="edit-audit-form" onSubmit={submit}>
                <Modal.Body>
                    <fieldset disabled={saving} className="m-0 p-0 border-0 space-y-default">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-default">
                            <FormField label={tx('editModal.labelTitle')} required>
                                <Input
                                    id="edit-audit-title"
                                    value={title}
                                    onChange={(e) => setTitle(e.target.value)}
                                    required
                                />
                            </FormField>
                            <FormField label={tx('newModal.framework')}>
                                <Combobox
                                    id="edit-audit-framework"
                                    options={frameworks}
                                    selected={frameworks.find((o) => o.value === frameworkKey) ?? noFramework}
                                    setSelected={(opt) => setFrameworkKey(opt?.value ?? '')}
                                    placeholder={tx('newModal.noFramework')}
                                    matchTriggerWidth
                                />
                            </FormField>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-default">
                            <FormField label={tx('editModal.labelSchedule')}>
                                <DatePicker
                                    id="edit-audit-schedule"
                                    value={schedule}
                                    onChange={(d) => setSchedule(d ?? null)}
                                    clearable
                                    placeholder={tx('editModal.schedulePlaceholder')}
                                />
                            </FormField>
                            <FormField label={tx('newModal.cycle')}>
                                <Combobox
                                    id="edit-audit-cycle"
                                    options={cycles}
                                    selected={cycles.find((o) => o.value === auditCycleId) ?? noCycle}
                                    setSelected={(opt) => setAuditCycleId(opt?.value ?? '')}
                                    placeholder={tx('newModal.noCycle')}
                                    matchTriggerWidth
                                />
                            </FormField>
                        </div>

                        <FormField label={tx('editModal.labelDepartments')}>
                            <Input
                                id="edit-audit-departments"
                                value={departments}
                                onChange={(e) => setDepartments(e.target.value)}
                                placeholder={tx('editModal.departmentsPlaceholder')}
                            />
                        </FormField>

                        <FormField label={tx('editModal.labelScope')}>
                            <Textarea
                                id="edit-audit-scope"
                                className="h-24"
                                value={scope}
                                onChange={(e) => setScope(e.target.value)}
                            />
                        </FormField>

                        <FormField label={tx('editModal.labelCriteria')}>
                            <Textarea
                                id="edit-audit-criteria"
                                className="h-20"
                                value={criteria}
                                onChange={(e) => setCriteria(e.target.value)}
                            />
                        </FormField>
                    </fieldset>
                </Modal.Body>
                <Modal.Actions>
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setOpen(false)}
                        disabled={saving}
                        id="edit-audit-cancel"
                    >
                        {tx('editModal.cancel')}
                    </Button>
                    <Button
                        type="submit"
                        variant="primary"
                        size="sm"
                        disabled={saving || !title.trim()}
                        id="edit-audit-save"
                    >
                        {saving ? tx('editModal.saving') : tx('editModal.save')}
                    </Button>
                </Modal.Actions>
            </Modal.Form>
        </Modal>
    );
}
