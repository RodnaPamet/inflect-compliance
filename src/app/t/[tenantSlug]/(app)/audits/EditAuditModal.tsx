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
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { DatePicker } from '@/components/ui/date-picker';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Textarea } from '@/components/ui/textarea';
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
    /**
     * Performs the write. The modal owns the FORM — seeding, validation, the
     * toasts, closing — but not the request: `PUT /audits/{id}` is already
     * modelled by the caller as its `auditWrite` mutation, keyed on the audits
     * list so a save revalidates the row that changed. A second hand-rolled
     * copy of the same request here is how two call sites to one endpoint
     * drift apart on error handling and cache invalidation.
     *
     * Must REJECT on failure — the modal renders its error toast from the
     * rejection and deliberately stays open with the form intact.
     */
    save: (body: Record<string, unknown>) => Promise<unknown>;
    /** Called after a successful save so the caller can refresh its panes. */
    onSaved: () => void;
}

/** `YYYY-MM-DD` — the wire format the API's date fields accept. */
function toYMD(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function EditAuditModal({ open, setOpen, audit, save, onSaved }: EditAuditModalProps) {
    const tx = useTranslations('audits');
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
    // Both catalogues are shared cache entries, not private fetches: the audits
    // hub already reads `/audits/cycles` and the cycles page already reads
    // `/frameworks`, both through these same registry keys — so opening this
    // modal costs no request at all when either is already warm.
    //
    // The null key preserves the old `if (!open) return`: SWR skips a null key
    // entirely, so a closed modal fetches nothing.
    //
    // Both pickers still fail soft. A failed catalogue GET leaves `data`
    // undefined and the options fall back to the lone placeholder, which keeps
    // the current value selectable rather than blocking the whole edit —
    // exactly what the old empty `catch` did.
    const frameworksQuery = useTenantSWR<Array<{ key: string; name: string }>>(
        open ? CACHE_KEYS.frameworks.list() : null,
    );
    const frameworkRows = frameworksQuery.data;
    const frameworks = useMemo<ComboboxOption[]>(() => {
        if (!Array.isArray(frameworkRows)) return [noFramework];
        return [noFramework, ...frameworkRows.map((f) => ({ value: f.key, label: f.name }))];
    }, [frameworkRows, noFramework]);

    const cyclesQuery = useTenantSWR<Array<{ id: string; name: string; frameworkKey: string }>>(
        open ? CACHE_KEYS.audits.cycles() : null,
    );
    const cycleRows = cyclesQuery.data;
    const cycles = useMemo<ComboboxOption[]>(() => {
        if (!Array.isArray(cycleRows)) return [noCycle];
        return [
            noCycle,
            ...cycleRows.map((c) => ({ value: c.id, label: `${c.name} · ${c.frameworkKey}` })),
        ];
    }, [cycleRows, noCycle]);

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (saving || !title.trim()) return;
        setSaving(true);
        try {
            await save({
                title: title.trim(),
                scope,
                criteria: criteria.trim() || null,
                departments: departments.trim() || null,
                // `null` clears the column; a date sends the `YYYY-MM-DD`
                // wire format the schema accepts.
                schedule: schedule ? toYMD(schedule) : null,
                frameworkKey: frameworkKey.trim() || null,
                auditCycleId: auditCycleId.trim() || null,
            });
            toast.success(tx('editModal.saved'));
            setOpen(false);
            onSaved();
        } catch {
            // One catch for both failure shapes now. `save` rejects on a non-2xx
            // AND on a request that never landed, where the old code had a
            // `return` for the former and this `catch` for the latter — two
            // paths to the same toast. The modal stays open with the form
            // intact either way, so the user can retry without retyping.
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
