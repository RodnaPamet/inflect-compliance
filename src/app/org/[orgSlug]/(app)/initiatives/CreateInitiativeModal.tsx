'use client';

/**
 * Create a security initiative (#4851): title, description, owner and target
 * date. Loaded lazily by the Initiatives list, which opens closed.
 */
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { DatePicker } from '@/components/ui/date-picker/date-picker';
import { parseYMD, toYMD } from '@/components/ui/date-picker/date-utils';
import { apiErrorMessage } from '@/lib/api-error';

/** A person the owner can be: a member of the organization. */
export type MemberOption = { id: string; label: string };

export function CreateInitiativeModal({
    orgSlug,
    members,
    onClose,
    onCreated,
}: {
    orgSlug: string;
    members: MemberOption[];
    onClose: () => void;
    onCreated: (id: string) => void;
}) {
    const t = useTranslations('org');
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [ownerUserId, setOwnerUserId] = useState<string>('');
    const [targetDate, setTargetDate] = useState<string>('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const ownerOptions = useMemo<ComboboxOption[]>(
        () => members.map((m) => ({ value: m.id, label: m.label })),
        [members],
    );

    const save = async () => {
        if (!title.trim()) {
            setError(t('initiatives.titleRequired'));
            return;
        }
        setSaving(true);
        setError(null);
        try {
            const res = await fetch(`/api/org/${orgSlug}/initiatives`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title,
                    description: description || null,
                    ownerUserId: ownerUserId || null,
                    targetDate: targetDate || null,
                }),
            });
            if (!res.ok) {
                // The server's reason when it gives one (#4851), not a fixed
                // sentence that hides why.
                const body = await res.json().catch(() => ({}));
                setError(apiErrorMessage(body, t('initiatives.failedCreate')));
                return;
            }
            const data = await res.json();
            onCreated(data.initiative.id);
        } catch {
            setError(t('initiatives.failedCreate'));
        } finally {
            setSaving(false);
        }
    };

    return (
        <Modal showModal setShowModal={(o) => (o ? null : onClose())}>
            <Modal.Header title={t('initiatives.createModalTitle')} />
            <Modal.Body>
                <div className="space-y-default" data-testid="org-initiative-create-form">
                    <FormField label={t('initiatives.titleLabel')} required>
                        <Input
                            id="org-initiative-title"
                            maxLength={200}
                            value={title}
                            placeholder={t('initiatives.titlePlaceholder')}
                            onChange={(e) => setTitle(e.target.value)}
                        />
                    </FormField>
                    <FormField label={t('initiatives.descriptionLabel')}>
                        <Textarea
                            id="org-initiative-description"
                            rows={3}
                            maxLength={8000}
                            value={description}
                            onChange={(e) => setDescription(e.target.value)}
                        />
                    </FormField>
                    <FormField label={t('initiatives.ownerLabel')} description={t('initiatives.ownerHint')}>
                        <Combobox
                            id="org-initiative-owner"
                            options={ownerOptions}
                            selected={ownerOptions.find((o) => o.value === ownerUserId) ?? null}
                            setSelected={(opt) => setOwnerUserId(opt?.value ?? '')}
                            placeholder={t('initiatives.noOwner')}
                            matchTriggerWidth
                            buttonProps={{ className: 'w-full' }}
                        />
                    </FormField>
                    <FormField label={t('initiatives.targetLabel')} description={t('initiatives.targetHint')}>
                        <DatePicker
                            id="org-initiative-target"
                            className="w-full"
                            clearable
                            align="start"
                            value={parseYMD(targetDate)}
                            onChange={(next) => setTargetDate(toYMD(next) ?? '')}
                            aria-label={t('initiatives.targetLabel')}
                        />
                    </FormField>
                    {error && (
                        <p className="text-sm text-content-error" role="alert" data-testid="org-initiative-create-error">
                            {error}
                        </p>
                    )}
                </div>
            </Modal.Body>
            <Modal.Footer>
                <Modal.Actions>
                    <Button variant="ghost" onClick={onClose} disabled={saving}>
                        {t('common.cancel')}
                    </Button>
                    <Button variant="primary" onClick={save} disabled={saving} loading={saving} id="org-initiative-create-submit">
                        {t('initiatives.createInitiative')}
                    </Button>
                </Modal.Actions>
            </Modal.Footer>
        </Modal>
    );
}
