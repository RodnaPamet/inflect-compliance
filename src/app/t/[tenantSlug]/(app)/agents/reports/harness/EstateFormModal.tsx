'use client';

/**
 * Declare or edit one scanner estate (#3807, the form for step 4a's API) —
 * `POST /admin/agents/harness-estates` or `PATCH …/harness-estates/:id`.
 *
 * It sends exactly what the console command did and adds no authority: the
 * route, its `admin.agent_registry` gate and every refusal are the usecase's.
 * What it adds is choosing the scanner from the register and each owner from
 * the members list, rather than pasting ids.
 *
 * THE SCANNER IS CHOSEN ONCE. An estate is the estate of the scanner that
 * signs its reports, so a declared estate's scanner cannot change; editing
 * shows it and offers no picker. Moving a scanner is a new estate.
 *
 * EVERY SOURCE HAS AN OWNER. The form sends nothing until each declared source
 * names one, and offers each kind once. The server still checks that every
 * owner is an active member, and its refusal is shown inline as it worded it.
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Plus } from '@inflect/ui/components/ui/icons/nucleo';

import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { useToast } from '@/components/ui/hooks';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { NumberStepper } from '@/components/ui/number-stepper';
import { UserCombobox } from '@/components/ui/user-combobox';
import { apiErrorMessage } from '@/lib/api-error';
import { useTenantApiUrl, useTenantContext } from '@/lib/tenant-context-provider';
import { SOURCE_KINDS } from '@/lib/agentic/harness-contract-rules';
import type { EstateHealthRow } from '@/lib/agentic/harness-estate-health';

/** The schema's own bounds. */
const NAME_MAX_CHARS = 120;
const CADENCE_MIN_HOURS = 1;
const CADENCE_MAX_HOURS = 720;
const DEFAULT_CADENCE_HOURS = 24;

export interface EstateScannerOption {
    readonly id: string;
    readonly name: string;
}

interface SourceDraft {
    readonly key: number;
    readonly kind: string | null;
    readonly ownerUserId: string | null;
}

export function EstateFormModal({
    estate,
    scanners,
    onClose,
}: {
    /** The estate being edited, or `null` to declare a new one. */
    estate: EstateHealthRow | null;
    /** Live register rows that cover no estate yet. Used only when declaring. */
    scanners: readonly EstateScannerOption[];
    onClose: () => void;
}) {
    const t = useTranslations('agents');
    const tCommon = useTranslations('common');
    const apiUrl = useTenantApiUrl();
    const { tenantSlug } = useTenantContext();
    const router = useRouter();
    const toast = useToast();
    const editing = estate !== null;

    const [name, setName] = useState(estate?.name ?? '');
    const [scanner, setScanner] = useState<ComboboxOption | null>(null);
    const [cadence, setCadence] = useState(estate?.cadenceHours ?? DEFAULT_CADENCE_HOURS);
    const [nextKey, setNextKey] = useState(estate ? estate.sources.length : 1);
    const [sources, setSources] = useState<SourceDraft[]>(
        estate
            ? estate.sources.map((s, i) => ({ key: i, kind: s.kind, ownerUserId: s.owner.userId }))
            : [{ key: 0, kind: null, ownerUserId: null }],
    );
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const scannerOptions: ComboboxOption[] = scanners.map((s) => ({ value: s.id, label: s.name }));
    const chosenKinds = useMemo(() => new Set(sources.map((s) => s.kind).filter((k): k is string => k !== null)), [sources]);
    const kindOptionsFor = (current: string | null): ComboboxOption[] =>
        SOURCE_KINDS.filter((k) => k === current || !chosenKinds.has(k)).map((k) => ({
            value: k,
            label: t(`harness.estates.form.kind.${k}`),
        }));

    const trimmedName = name.trim();
    const sourcesComplete = sources.length > 0 && sources.every((s) => s.kind !== null && s.ownerUserId !== null);
    const canSubmit =
        !busy &&
        trimmedName.length > 0 &&
        trimmedName.length <= NAME_MAX_CHARS &&
        (editing || scanner !== null) &&
        cadence >= CADENCE_MIN_HOURS &&
        cadence <= CADENCE_MAX_HOURS &&
        sourcesComplete;

    const updateSource = (key: number, patch: Partial<Omit<SourceDraft, 'key'>>) =>
        setSources((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));

    const submit = async () => {
        if (!canSubmit) return;
        setBusy(true);
        setError(null);
        const body = {
            name: trimmedName,
            cadenceHours: cadence,
            sources: sources.map((s) => ({ kind: s.kind, ownerUserId: s.ownerUserId })),
            ...(editing ? {} : { scannerAgentId: scanner?.value }),
        };
        try {
            const res = await fetch(
                apiUrl(editing ? `/admin/agents/harness-estates/${estate.id}` : '/admin/agents/harness-estates'),
                {
                    method: editing ? 'PATCH' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                },
            );
            if (!res.ok) {
                const payload = await res.json().catch(() => null);
                const message = apiErrorMessage(payload, t('harness.estates.form.failed'));
                setError(message);
                toast.error(message);
                return;
            }
            toast.success(editing ? t('harness.estates.form.updated') : t('harness.estates.form.declared'));
            onClose();
            router.refresh();
        } catch {
            const message = t('harness.estates.form.failed');
            setError(message);
            toast.error(message);
        } finally {
            setBusy(false);
        }
    };

    const title = editing ? t('harness.estates.form.editTitle') : t('harness.estates.form.declareTitle');

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
            <Modal.Header title={title} description={t('harness.estates.form.description')} />
            <Modal.Form
                onSubmit={(e) => {
                    e.preventDefault();
                    void submit();
                }}
            >
                <Modal.Body>
                    <div className="space-y-default" data-testid="harness-estate-form">
                        {error && (
                            <InlineNotice variant="error" data-testid="harness-estate-form-error">
                                {error}
                            </InlineNotice>
                        )}
                        <FormField label={t('harness.estates.form.nameLabel')} required>
                            <Input
                                id="harness-estate-name"
                                maxLength={NAME_MAX_CHARS}
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                disabled={busy}
                            />
                        </FormField>

                        {editing ? (
                            <FormField
                                label={t('harness.estates.form.scannerLabel')}
                                description={t('harness.estates.form.scannerFixed')}
                            >
                                <p className="text-sm text-content-emphasis" data-testid="harness-estate-scanner-fixed">
                                    {estate.scannerName ?? estate.scannerAgentId}
                                </p>
                            </FormField>
                        ) : scannerOptions.length === 0 ? (
                            <InlineNotice
                                variant="warning"
                                title={t('harness.estates.form.noScanners')}
                                data-testid="harness-estate-no-scanners"
                            >
                                {t('harness.estates.form.noScannersHint')}
                            </InlineNotice>
                        ) : (
                            <FormField
                                label={t('harness.estates.form.scannerLabel')}
                                description={t('harness.estates.form.scannerHint')}
                                required
                            >
                                <Combobox
                                    id="harness-estate-scanner"
                                    options={scannerOptions}
                                    selected={scanner}
                                    setSelected={setScanner}
                                    placeholder={t('harness.estates.form.scannerPlaceholder')}
                                    searchPlaceholder={t('harness.estates.form.scannerSearch')}
                                    matchTriggerWidth
                                    forceDropdown
                                    buttonProps={{ className: 'w-full' }}
                                    caret
                                />
                            </FormField>
                        )}

                        <FormField
                            label={t('harness.estates.form.cadenceLabel')}
                            description={t('harness.estates.form.cadenceHint', {
                                stale: Math.round(cadence * 1.5),
                            })}
                            required
                        >
                            <NumberStepper
                                id="harness-estate-cadence"
                                value={cadence}
                                onChange={setCadence}
                                min={CADENCE_MIN_HOURS}
                                max={CADENCE_MAX_HOURS}
                                disabled={busy}
                                ariaLabel={t('harness.estates.form.cadenceLabel')}
                            />
                        </FormField>

                        <div className="space-y-compact">
                            <p className="text-sm font-medium text-content-emphasis">
                                {t('harness.estates.form.sourcesLabel')}
                            </p>
                            <p className="text-xs text-content-muted">{t('harness.estates.form.sourcesHint')}</p>
                            <ul className="space-y-compact">
                                {sources.map((s, i) => (
                                    <li
                                        key={s.key}
                                        className="grid grid-cols-1 gap-compact sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end"
                                        data-testid={`harness-estate-source-row-${i}`}
                                    >
                                        <FormField label={t('harness.estates.form.kindLabel')} required>
                                            <Combobox
                                                id={`harness-estate-source-kind-${i}`}
                                                options={kindOptionsFor(s.kind)}
                                                selected={
                                                    s.kind === null
                                                        ? null
                                                        : { value: s.kind, label: t(`harness.estates.form.kind.${s.kind}`) }
                                                }
                                                setSelected={(o) => updateSource(s.key, { kind: o?.value ?? null })}
                                                placeholder={t('harness.estates.form.kindPlaceholder')}
                                                matchTriggerWidth
                                                forceDropdown
                                                buttonProps={{ className: 'w-full' }}
                                                caret
                                            />
                                        </FormField>
                                        <FormField label={t('harness.estates.form.ownerLabel')} required>
                                            <UserCombobox
                                                id={`harness-estate-source-owner-${i}`}
                                                tenantSlug={tenantSlug}
                                                selectedId={s.ownerUserId}
                                                onChange={(userId) => updateSource(s.key, { ownerUserId: userId })}
                                                placeholder={t('harness.estates.form.ownerPlaceholder')}
                                                disabled={busy}
                                            />
                                        </FormField>
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => setSources((rows) => rows.filter((r) => r.key !== s.key))}
                                            disabled={busy || sources.length === 1}
                                            data-testid={`harness-estate-source-remove-${i}`}
                                        >
                                            {t('harness.estates.form.removeSource')}
                                        </Button>
                                    </li>
                                ))}
                            </ul>
                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                icon={<Plus />}
                                onClick={() => {
                                    setSources((rows) => [...rows, { key: nextKey, kind: null, ownerUserId: null }]);
                                    setNextKey((k) => k + 1);
                                }}
                                disabled={busy || sources.length >= SOURCE_KINDS.length}
                                data-testid="harness-estate-source-add"
                            >
                                {t('harness.estates.form.addSource')}
                            </Button>
                        </div>
                    </div>
                </Modal.Body>
                <Modal.Footer>
                    <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
                        {tCommon('cancel')}
                    </Button>
                    <Button type="submit" variant="primary" disabled={!canSubmit} data-testid="harness-estate-form-submit">
                        {busy
                            ? t('harness.estates.form.saving')
                            : editing
                              ? t('harness.estates.form.saveEdit')
                              : t('harness.estates.form.submitDeclare')}
                    </Button>
                </Modal.Footer>
            </Modal.Form>
        </Modal>
    );
}
