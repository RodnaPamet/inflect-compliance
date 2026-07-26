'use client';

/**
 * Control detail — Mappings tab (#102 item 1, tab-lazy refactor).
 *
 * Extracted from the 1,500-line control detail page. Fully
 * self-contained: it owns the framework-mapping list
 * (`useTenantSWR` — fetched only because this component mounts only
 * when the Mappings tab is active), plus the framework / requirement
 * pickers for the "map a requirement" form and the map / unmap
 * mutations.
 *
 * `onMutated` lets the parent revalidate its page-data header so the
 * Mappings tab-badge count stays in sync after a map / unmap.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useToastWithUndo } from '@/components/ui/hooks';
import { useToast } from '@/components/ui/hooks/use-toast';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { Button } from '@/components/ui/button';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { InlineEmptyState } from '@/components/ui/inline-empty-state';
import { CopyText } from '@/components/ui/copy-text';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { DataTable, createColumns } from '@/components/ui/table';
import { Modal } from '@/components/ui/modal';
import { FormField } from '@/components/ui/form-field';
import { Textarea } from '@/components/ui/textarea';
import type { FrameworkDTO, RequirementDTO, FrameworkMappingDTO } from '@/lib/dto';

// Per-framework applicability override, stored on the ControlRequirementLink.
// The mappings GET (`/controls/:id/requirements` →
// `ControlRepository.listControlRequirementLinks`) returns both fields on every
// row, so they're always PRESENT here — `null` means "inherit the control's
// global applicability", not "the API didn't send it".
type LinkApplicability = 'APPLICABLE' | 'NOT_APPLICABLE';
type MappingRow = FrameworkMappingDTO & {
    applicability: LinkApplicability | null;
    applicabilityJustification: string | null;
};
// Combobox uses 'INHERIT' as the sentinel for "no override" — it maps to
// a null applicability on the wire (revert to the control's global value).
const APPLICABILITY_CHOICES = ['INHERIT', 'APPLICABLE', 'NOT_APPLICABLE'] as const;
type ApplicabilityChoice = (typeof APPLICABILITY_CHOICES)[number];

interface ControlMappingsTabProps {
    controlId: string;
    canWrite: boolean;
    /** Revalidate the page-data header — keeps the tab-badge current. */
    onMutated: () => void;
}

export function ControlMappingsTab({
    controlId,
    canWrite,
    onMutated,
}: ControlMappingsTabProps) {
    const apiUrl = useTenantApiUrl();
    const t = useTranslations('controls');
    const triggerUndoToast = useToastWithUndo();
    const toast = useToast();

    const mappingsSWR = useTenantSWR<MappingRow[]>(
        CACHE_KEYS.controls.mappings(controlId),
    );

    // Per-row applicability override state. `savingReqId` disables the
    // row's combobox mid-flight; the justification modal captures the
    // required reason before persisting a NOT_APPLICABLE override.
    const [savingReqId, setSavingReqId] = useState<string | null>(null);
    const [justifyModal, setJustifyModal] = useState<
        { reqId: string; label: string } | null
    >(null);
    const [justifyText, setJustifyText] = useState('');

    const applicabilityOptions = useMemo<ComboboxOption[]>(
        () => [
            { value: 'INHERIT', label: t('mappingsTab.applicabilityInherit') },
            { value: 'APPLICABLE', label: t('mappingsTab.applicabilityApplicable') },
            { value: 'NOT_APPLICABLE', label: t('mappingsTab.applicabilityNotApplicable') },
        ],
        [t],
    );

    // POST the override for one requirement, then refetch this tab's SWR
    // (and the page-data header via onMutated). `applicability: null`
    // clears the override → inherit the control's global applicability.
    const persistApplicability = async (
        reqId: string,
        applicability: LinkApplicability | null,
        justification: string | null,
    ): Promise<boolean> => {
        setSavingReqId(reqId);
        try {
            const res = await fetch(
                apiUrl(`/controls/${controlId}/requirements/${reqId}/applicability`),
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ applicability, justification }),
                },
            );
            if (!res.ok) throw new Error(t('mappingsTab.applicabilityFailed'));
            await mappingsSWR.mutate();
            onMutated();
            return true;
        } catch {
            // Surface the failure; the caller keeps any captured
            // justification so the user can retry without re-typing.
            toast.error(t('mappingsTab.applicabilityFailed'));
            return false;
        } finally {
            setSavingReqId(null);
        }
    };

    const onApplicabilityChange = (
        reqId: string,
        label: string,
        choice: ApplicabilityChoice,
    ) => {
        if (choice === 'NOT_APPLICABLE') {
            // Not applicable requires a justification — open the modal.
            setJustifyText('');
            setJustifyModal({ reqId, label });
            return;
        }
        // Inherit → null override; Applicable → explicit APPLICABLE.
        void persistApplicability(
            reqId,
            choice === 'APPLICABLE' ? 'APPLICABLE' : null,
            null,
        );
    };

    const confirmNotApplicable = async () => {
        if (!justifyModal || !justifyText.trim()) return;
        const { reqId } = justifyModal;
        const ok = await persistApplicability(
            reqId,
            'NOT_APPLICABLE',
            justifyText.trim(),
        );
        // Only dismiss on success — a failure keeps the modal open so the
        // typed justification is preserved for a retry.
        if (ok) {
            setJustifyModal(null);
            setJustifyText('');
        }
    };

    const [showMapForm, setShowMapForm] = useState(false);
    const [frameworks, setFrameworks] = useState<FrameworkDTO[]>([]);
    const [selectedFramework, setSelectedFramework] = useState('');
    const [requirements, setRequirements] = useState<RequirementDTO[]>([]);
    const [selectedReq, setSelectedReq] = useState('');
    const [savingMap, setSavingMap] = useState(false);

    // Frameworks load once — the component mounts only when the
    // Mappings tab is active, so there's no tab gate to check.
    useEffect(() => {
        fetch(apiUrl('/controls/frameworks'))
            .then((r) => (r.ok ? r.json() : []))
            .then(setFrameworks)
            .catch(() => {});
    }, [apiUrl]);

    // Requirements reload whenever the selected framework changes.
    useEffect(() => {
        if (!selectedFramework) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setRequirements([]);
            return;
        }
        fetch(apiUrl(`/controls/frameworks/${selectedFramework}/requirements`))
            .then((r) => (r.ok ? r.json() : []))
            .then(setRequirements)
            .catch(() => {});
    }, [selectedFramework, apiUrl]);

    const mapRequirement = async () => {
        if (!selectedReq) return;
        setSavingMap(true);
        try {
            const res = await fetch(apiUrl(`/controls/${controlId}/requirements`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ requirementId: selectedReq }),
            });
            if (!res.ok) throw new Error(t('mappingsTab.mapFailed'));
            // Only clear the picker + close the form on success; a failure
            // leaves the selection intact so the user can retry.
            setSelectedReq('');
            setShowMapForm(false);
            await mappingsSWR.mutate();
            onMutated();
        } catch {
            toast.error(t('mappingsTab.mapFailed'));
        } finally {
            // Always re-enable the button — a throw must not strand it
            // disabled forever.
            setSavingMap(false);
        }
    };

    // Epic 67 — delayed-commit unmap against this tab's own SWR
    // cache. Optimistically drop the row; the DELETE fires after the
    // 5 s undo window.
    const unmapRequirement = (reqId: string) => {
        const previous = mappingsSWR.data;
        if (previous) {
            mappingsSWR.mutate(
                previous.filter(
                    (m) =>
                        m.fromRequirement?.id !== reqId &&
                        m.fromRequirementId !== reqId,
                ),
                { revalidate: false },
            );
        }
        triggerUndoToast({
            message: t('mappingsTab.unmapped'),
            undoMessage: t('mappingsTab.undo'),
            action: async () => {
                const res = await fetch(
                    apiUrl(`/controls/${controlId}/requirements`),
                    {
                        method: 'DELETE',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ requirementId: reqId }),
                    },
                );
                if (!res.ok) throw new Error(t('mappingsTab.unmapFailed'));
                await mappingsSWR.mutate();
                onMutated();
            },
            undoAction: () => {
                if (previous) {
                    mappingsSWR.mutate(previous, { revalidate: false });
                }
            },
            onError: () => {
                if (previous) {
                    mappingsSWR.mutate(previous, { revalidate: false });
                }
            },
        });
    };

    // R10-PR3 follow-up: framework-mapping rows now flow through
    // DataTable. The 2-column shape (Framework + Requirement) plus
    // optional Actions column matches the R11-PR8 task-links template;
    // CopyText-on-code, error tone, and the canWrite gate are all
    // preserved inside cell renderers.
    const columns = useMemo(
        () =>
            createColumns<MappingRow>([
                {
                    id: 'framework',
                    header: t('mappingsTab.colFramework'),
                    cell: ({ row }) => (
                        <span className="text-sm text-content-emphasis">
                            {row.original.fromRequirement?.framework?.name || '—'}
                        </span>
                    ),
                },
                {
                    id: 'requirement',
                    header: t('mappingsTab.colRequirement'),
                    cell: ({ row }) => {
                        const fromReq = row.original.fromRequirement;
                        return (
                            <span className="text-sm text-content-default">
                                {fromReq?.code && (
                                    <CopyText
                                        value={fromReq.code}
                                        label={t('mappingsTab.copyCode', { code: fromReq.code })}
                                        successMessage={t('mappingsTab.codeCopied')}
                                        className="mr-2 text-content-subtle"
                                    >
                                        {fromReq.code}
                                    </CopyText>
                                )}
                                {fromReq?.title || fromReq?.description || '—'}
                            </span>
                        );
                    },
                },
                {
                    id: 'applicability',
                    header: t('mappingsTab.colApplicability'),
                    cell: ({ row }: { row: { original: MappingRow } }) => {
                        const reqId =
                            row.original.fromRequirement?.id ||
                            row.original.fromRequirementId ||
                            '';
                        const req = row.original.fromRequirement;
                        const label = req?.code || req?.title || req?.description || '—';
                        const current: ApplicabilityChoice =
                            row.original.applicability === 'APPLICABLE'
                                ? 'APPLICABLE'
                                : row.original.applicability === 'NOT_APPLICABLE'
                                    ? 'NOT_APPLICABLE'
                                    : 'INHERIT';
                        if (!canWrite) {
                            return (
                                <span className="text-xs text-content-subtle">
                                    {applicabilityOptions.find((o) => o.value === current)?.label}
                                </span>
                            );
                        }
                        return (
                            <Combobox
                                hideSearch
                                forceDropdown
                                id={`applicability-${row.original.id}`}
                                options={applicabilityOptions}
                                selected={
                                    applicabilityOptions.find((o) => o.value === current) ?? null
                                }
                                setSelected={(opt) => {
                                    if (opt) {
                                        onApplicabilityChange(
                                            reqId,
                                            label,
                                            opt.value as ApplicabilityChoice,
                                        );
                                    }
                                }}
                                disabled={savingReqId === reqId}
                                buttonProps={{ variant: 'secondary', size: 'sm', className: 'text-xs' }}
                            />
                        );
                    },
                },
                ...(canWrite
                    ? [
                          {
                              id: 'actions',
                              header: t('mappingsTab.colActions'),
                              cell: ({ row }: { row: { original: MappingRow } }) => (
                                  <button
                                      className="text-content-error text-xs hover:text-content-error"
                                      onClick={() =>
                                          unmapRequirement(
                                              row.original.fromRequirement?.id ||
                                                  row.original.fromRequirementId ||
                                                  '',
                                          )
                                      }
                                      id={`unmap-${row.original.id}`}
                                  >
                                      {t('mappingsTab.remove')}
                                  </button>
                              ),
                          },
                      ]
                    : []),
            ]),
        // unmapRequirement closes over SWR state, so include the data
        // fingerprint as a dependency to avoid stale undo snapshots.
        // savingReqId + applicabilityOptions keep the per-row applicability
        // combobox current (disabled state + labels).
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [canWrite, mappingsSWR.data, savingReqId, applicabilityOptions],
    );

    return (
        <div className="space-y-default">
            {canWrite && (
                <div className="flex justify-end">
                    <Button variant="primary" onClick={() => setShowMapForm(!showMapForm)} id="map-requirement-btn">
                        {t('mappingsTab.linkRequirement')}
                    </Button>
                </div>
            )}
            {showMapForm && canWrite && (
                <div className={cn(cardVariants({ density: 'compact' }), 'space-y-compact')}>
                    <Combobox
                        id="framework-select"
                        selected={frameworks.map((f) => ({ value: f.key ?? f.id ?? '', label: f.name })).find((o) => o.value === selectedFramework) ?? null}
                        setSelected={(opt) => setSelectedFramework(opt?.value ?? '')}
                        options={frameworks.map((f) => ({ value: f.key ?? f.id ?? '', label: f.name }))}
                        placeholder={t('mappingsTab.selectFramework')}
                        matchTriggerWidth
                    />
                    {requirements.length > 0 && (
                        <>
                            <Combobox
                                id="requirement-select"
                                selected={requirements.map((r) => ({ value: r.id, label: `${r.code ? `${r.code} — ` : ''}${r.title || r.description}` })).find((o) => o.value === selectedReq) ?? null}
                                setSelected={(opt) => setSelectedReq(opt?.value ?? '')}
                                options={requirements.map((r) => ({ value: r.id, label: `${r.code ? `${r.code} — ` : ''}${r.title || r.description}` }))}
                                placeholder={t('mappingsTab.selectRequirement')}
                                matchTriggerWidth
                            />
                            <Button variant="primary" onClick={mapRequirement} disabled={!selectedReq || savingMap} id="submit-mapping-btn">
                                {savingMap ? t('mappingsTab.mapping') : t('mappingsTab.map')}
                            </Button>
                        </>
                    )}
                </div>
            )}
            {mappingsSWR.error && !mappingsSWR.isLoading ? (
                <InlineEmptyState
                    title={t('mappingsTab.errorTitle')}
                    description={t('mappingsTab.errorDesc')}
                />
            ) : (mappingsSWR.data?.length ?? 0) === 0 ? (
                // Pre-migration the empty branch rendered an
                // InlineEmptyState — no `#mappings-table` was in the
                // DOM. E2E specs that look up `#mappings-table` are
                // therefore waiting for data to arrive; preserve
                // that contract by gating the id on rows-present.
                // `selectionEnabled={false}` keeps the unmap-button
                // selector working (see EvidenceSubTable comment).
                <DataTable
                    data={[]}
                    columns={columns}
                    getRowId={(m) => m.id}
                    loading={mappingsSWR.isLoading && !mappingsSWR.data}
                    selectionEnabled={false}
                    emptyState={
                        <InlineEmptyState
                            title={t('mappingsTab.emptyTitle')}
                            description={t('mappingsTab.emptyDesc')}
                        />
                    }
                />
            ) : (
                <div id="mappings-table">
                    <DataTable
                        data={mappingsSWR.data ?? []}
                        columns={columns}
                        getRowId={(m) => m.id}
                        selectionEnabled={false}
                    />
                </div>
            )}

            {/* Justification modal — a NOT_APPLICABLE override must carry a
                reason (per-framework scoping of an N/A decision). */}
            <Modal
                showModal={justifyModal !== null}
                setShowModal={(next) => {
                    const open = typeof next === 'boolean' ? next : justifyModal !== null;
                    if (!open) {
                        setJustifyModal(null);
                        setJustifyText('');
                    }
                }}
                title={t('mappingsTab.applicabilityJustifyTitle')}
            >
                <Modal.Header title={t('mappingsTab.applicabilityJustifyTitle')} />
                <Modal.Body>
                    <FormField label={t('mappingsTab.applicabilityJustifyLabel', { requirement: justifyModal?.label ?? '' })} required>
                        <Textarea
                            id="applicability-justification-input"
                            rows={4}
                            value={justifyText}
                            onChange={(e) => setJustifyText(e.target.value)}
                            placeholder={t('mappingsTab.applicabilityJustifyPlaceholder')}
                        />
                    </FormField>
                </Modal.Body>
                <Modal.Footer>
                    <Modal.Actions>
                        <Button
                            variant="secondary"
                            onClick={() => {
                                setJustifyModal(null);
                                setJustifyText('');
                            }}
                            id="applicability-justify-cancel"
                        >
                            {t('mappingsTab.cancel')}
                        </Button>
                        <Button
                            variant="primary"
                            onClick={confirmNotApplicable}
                            disabled={!justifyText.trim() || savingReqId === justifyModal?.reqId}
                            id="applicability-justify-save"
                        >
                            {t('mappingsTab.applicabilityJustifySave')}
                        </Button>
                    </Modal.Actions>
                </Modal.Footer>
            </Modal>
        </div>
    );
}
