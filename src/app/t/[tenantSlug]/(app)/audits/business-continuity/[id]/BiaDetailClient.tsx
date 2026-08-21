'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/cn';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { useEntityListIds } from '@/lib/hooks/use-entity-list-ids';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { MetaStrip, type MetaItem } from '@/components/ui/meta-strip';
import { cardVariants } from '@/components/ui/card';
import { Heading } from '@/components/ui/typography';
import { KPIStat } from '@/components/ui/metric';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Combobox } from '@/components/ui/combobox';
import { UserCombobox } from '@/components/ui/user-combobox';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { formatDate } from '@/lib/format-date';
import { useToastWithUndo, useToast } from '@/components/ui/hooks';
import { DependencyPickerRow, useDepTypeLabel } from '../BiaDependencyControls';
import { buildBiaCriticalityLabels } from '../filter-defs';
import { BiaLinkControlModal } from './BiaLinkControlModal';

interface ImpactPoint {
    atHours: number;
    financial?: number;
    operational?: number;
    reputational?: number;
    legal?: number;
}

interface ResolvedDependency {
    id: string;
    dependsOnType: string;
    dependsOnId: string;
    targetName: string | null;
    targetPath: string | null;
}

interface LinkedControl {
    id: string;
    name: string;
    code: string | null;
    requirements: { code: string; title: string; frameworkKey: string; frameworkName: string }[];
}

export interface BiaDetail {
    id: string;
    name: string;
    criticality: string;
    rtoHours: number | null;
    rpoHours: number | null;
    mtpdHours: number | null;
    impactProfile: ImpactPoint[] | null;
    notes: string | null;
    reviewedAt: string | null;
    processNode: { id: string; label: string; processMapId: string } | null;
    ownerUser: { id: string; name: string | null; email: string } | null;
    dependencies: ResolvedDependency[];
    linkedControls: LinkedControl[];
    evidenceLinks: { id: string; controlId: string }[];
    recovery: { rank: number; rationale: string } | null;
}

const CRITICALITY_VARIANT: Record<string, StatusBadgeVariant> = {
    CRITICAL: 'error',
    HIGH: 'error',
    MEDIUM: 'warning',
    LOW: 'info',
};

const hrs = (v: number | null) => (v != null ? `${v}h` : '—');

function Section({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div className={cn(cardVariants({ density: 'none' }), 'space-y-default')}>
            <Heading level={2}>{title}</Heading>
            {children}
        </div>
    );
}

const CRITICALITY_VALUES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;

export function BiaDetailClient({ bia, tenantSlug }: { bia: BiaDetail; tenantSlug: string }) {
    const tx = useTranslations('audits');
    const router = useRouter();
    const toast = useToast();
    const depTypeLabel = useDepTypeLabel();
    const triggerUndoToast = useToastWithUndo();
    const [showLinkControl, setShowLinkControl] = useState(false);
    const [depError, setDepError] = useState<string | null>(null);

    // #107 READ side. The register is server-rendered and filtered in the
    // browser, so its rows never reach an SWR cache entry a fallback could
    // read — hence the null `listKey`: published order or nothing. A BIA
    // opened by deep link, or from the process-canvas "create BIA" flow,
    // simply gets no arrows, which is the honest answer.
    //
    // `labelSingular` names an entity the `ui.recordStepper` catalog does not
    // carry yet, so both tooltips read the generic "Previous / Next item"
    // today. Naming it anyway means landing `bia` in en + bg is a
    // messages-only change with no follow-up here.
    const biaIds = useEntityListIds(null, {
        orderKey: CACHE_KEYS.audits.businessContinuity(),
    });

    // BIA-lifecycle — edit / review / impact-profile / delete surfaces.
    const [busy, setBusy] = useState(false);
    const [editing, setEditing] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const biaBase = `/api/t/${tenantSlug}/business-continuity/${bia.id}`;

    // PUT a partial patch; the API validates via UpdateBiaSchema.
    const putBia = async (patch: Record<string, unknown>): Promise<boolean> => {
        const res = await fetch(biaBase, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
        });
        return res.ok;
    };

    const markReviewed = async () => {
        setBusy(true);
        try {
            if (await putBia({ reviewedAt: new Date().toISOString() })) {
                toast.success(tx('biaDetail.reviewedToast'));
                router.refresh();
            } else {
                toast.error(tx('biaDetail.saveFailed'));
            }
        } finally { setBusy(false); }
    };

    const doDelete = async () => {
        const res = await fetch(biaBase, { method: 'DELETE' });
        if (res.ok) {
            router.push(`/t/${tenantSlug}/audits/business-continuity`);
        } else {
            toast.error(tx('biaDetail.deleteFailed'));
        }
    };

    const addDependency = async (draft: { dependsOnType: string; dependsOnId: string }) => {
        setDepError(null);
        try {
            const res = await fetch(`/api/t/${tenantSlug}/business-continuity/${bia.id}/dependencies`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(draft),
            });
            if (!res.ok) throw new Error(tx('biaDetail.addDependencyFailed'));
            router.refresh();
        } catch (e) {
            setDepError(e instanceof Error ? e.message : tx('biaDetail.addDependencyFailed'));
        }
    };

    const removeDependency = (dep: ResolvedDependency) => {
        triggerUndoToast({
            message: tx('biaDetail.dependencyRemoved'),
            undoMessage: tx('biaDetail.undo'),
            action: async () => {
                const res = await fetch(
                    `/api/t/${tenantSlug}/business-continuity/${bia.id}/dependencies/${dep.id}`,
                    { method: 'DELETE' },
                );
                if (!res.ok) throw new Error('remove');
                router.refresh();
            },
            onError: () => router.refresh(),
        });
    };

    const metaItems: MetaItem[] = [
        { kind: 'status', label: tx('biaDetail.metaCriticality'), value: bia.criticality, variant: CRITICALITY_VARIANT[bia.criticality] ?? 'neutral' },
    ];
    if (bia.recovery) metaItems.push({ kind: 'status', label: tx('biaDetail.metaRecovery'), value: `#${bia.recovery.rank}`, variant: 'info' });
    if (bia.ownerUser) metaItems.push({ kind: 'text', label: tx('biaDetail.metaOwner'), value: bia.ownerUser.name ?? bia.ownerUser.email });
    // BIA-lifecycle — surface the review state so "overdue" reflects reality
    // (reviewedAt was never set, so every BIA read as permanently overdue).
    metaItems.push(
        bia.reviewedAt
            ? { kind: 'text', label: tx('biaDetail.metaReviewed'), value: formatDate(bia.reviewedAt) }
            : { kind: 'status', label: tx('biaDetail.metaReviewed'), value: tx('biaDetail.neverReviewed'), variant: 'warning' },
    );

    return (
        <EntityDetailLayout
            back={{ smart: true }}
            prevNext={{
                ids: biaIds,
                currentId: bia.id,
                hrefFor: (id) => `/t/${tenantSlug}/audits/business-continuity/${id}`,
                labelSingular: 'bia',
            }}
            breadcrumbs={[
                { label: tx('crumb.dashboard'), href: `/t/${tenantSlug}/dashboard` },
                { label: tx('crumb.internalAudit'), href: `/t/${tenantSlug}/audits` },
                { label: tx('crumb.businessContinuity'), href: `/t/${tenantSlug}/audits/business-continuity` },
                { label: bia.name },
            ]}
            title={bia.name}
            meta={<MetaStrip items={metaItems} />}
            actions={
                <>
                    <Button variant="secondary" size="sm" onClick={markReviewed} disabled={busy} id="bia-mark-reviewed-btn">
                        {tx('biaDetail.markReviewed')}
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => setEditing(true)} id="bia-edit-btn">
                        {tx('biaDetail.edit')}
                    </Button>
                    <Button variant="ghost" size="sm" className="text-content-error" onClick={() => setDeleting(true)} id="bia-delete-btn">
                        {tx('biaDetail.delete')}
                    </Button>
                </>
            }
        >
            <div className="space-y-section">
                <Section title={tx('biaDetail.secRecoveryObjectives')}>
                    <div className="grid grid-cols-1 gap-default sm:grid-cols-3">
                        <div className="p-3 rounded-lg bg-bg-default/50">
                            <KPIStat id="bia-rto" value={hrs(bia.rtoHours)} label={tx('biaDetail.kpiRto')} />
                        </div>
                        <div className="p-3 rounded-lg bg-bg-default/50">
                            <KPIStat value={hrs(bia.rpoHours)} label={tx('biaDetail.kpiRpo')} />
                        </div>
                        <div className="p-3 rounded-lg bg-bg-default/50">
                            <KPIStat value={hrs(bia.mtpdHours)} label={tx('biaDetail.kpiMtpd')} tone="attention" />
                        </div>
                    </div>
                </Section>

                {bia.recovery && (
                    <Section title={tx('biaDetail.secRecoveryPriority')}>
                        <p className="text-sm text-content-default">
                            {tx.rich('biaDetail.recoversSeq', { rank: bia.recovery.rank, b: (c) => <span className="font-semibold">{c}</span> })}
                        </p>
                        <p className="text-sm text-content-muted">{bia.recovery.rationale}</p>
                    </Section>
                )}

                <Section title={tx('biaDetail.secImpact')}>
                    <ImpactProfileEditor
                        tx={tx}
                        initial={bia.impactProfile ?? []}
                        onSave={async (profile) => {
                            const ok = await putBia({ impactProfile: profile });
                            if (ok) { toast.success(tx('biaDetail.saveToast')); router.refresh(); }
                            else toast.error(tx('biaDetail.saveFailed'));
                            return ok;
                        }}
                    />
                </Section>

                <Section title={tx('biaDetail.secDependencies')}>
                    {bia.dependencies.length === 0 ? (
                        <p className="text-sm text-content-subtle">{tx('biaDetail.dependenciesEmpty')}</p>
                    ) : (
                        <ul className="space-y-tight">
                            {bia.dependencies.map((d) => (
                                <li
                                    key={d.id}
                                    className="flex items-center justify-between rounded-lg border border-border-subtle px-3 py-1.5 text-sm"
                                >
                                    <span className="text-content-default">
                                        <span className="text-content-subtle">{depTypeLabel(d.dependsOnType)}</span>{' '}
                                        ·{' '}
                                        {d.targetPath ? (
                                            <Link href={`/t/${tenantSlug}${d.targetPath}`} className="text-content-link hover:underline">
                                                {d.targetName}
                                            </Link>
                                        ) : (
                                            <span className="text-content-muted">{d.targetName ?? tx('biaDetail.depMissing')}</span>
                                        )}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => removeDependency(d)}
                                        className="text-content-muted hover:text-content-error"
                                        aria-label={tx('biaDetail.depRemove')}
                                    >
                                        {tx('biaDetail.depRemove')}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    <div className="space-y-tight">
                        <DependencyPickerRow
                            tenantSlug={tenantSlug}
                            excludeIds={bia.dependencies.map((d) => d.dependsOnId)}
                            onAdd={addDependency}
                        />
                        {depError && <p className="text-sm text-content-error">{depError}</p>}
                    </div>
                </Section>

                <Section title={tx('biaDetail.secLinked')}>
                    {bia.processNode ? (
                        <p className="text-sm text-content-default">
                            {tx('biaDetail.processNodePrefix')}{' '}
                            <Link
                                href={`/t/${tenantSlug}/processes/${bia.processNode.processMapId}`}
                                className="text-content-link hover:underline"
                            >
                                {bia.processNode.label}
                            </Link>
                        </p>
                    ) : (
                        <p className="text-sm text-content-subtle">{tx('biaDetail.notAttached')}</p>
                    )}
                </Section>

                <Section title={tx('biaDetail.secFramework')}>
                    <p className="text-sm text-content-muted">{tx('biaDetail.secFrameworkDesc')}</p>
                    {bia.linkedControls.length === 0 ? (
                        <EmptyState
                            size="sm"
                            variant="missing-prereqs"
                            title={tx('biaDetail.noControlsTitle')}
                            description={tx('biaDetail.linkControlPrompt')}
                            primaryAction={{ label: tx('biaDetail.linkControlAction'), onClick: () => setShowLinkControl(true) }}
                        />
                    ) : (
                        <div className="space-y-default">
                            {bia.linkedControls.map((c) => (
                                <div key={c.id} className="rounded-lg border border-border-subtle p-3 space-y-tight">
                                    <Link
                                        href={`/t/${tenantSlug}/controls/${c.id}`}
                                        className="text-sm font-medium text-content-link hover:underline"
                                    >
                                        {c.code ? `${c.code} · ${c.name}` : c.name}
                                    </Link>
                                    {c.requirements.length === 0 ? (
                                        <p className="text-sm text-content-subtle">{tx('biaDetail.controlNoMappings')}</p>
                                    ) : (
                                        <div className="flex flex-wrap gap-tight">
                                            {c.requirements.map((r, i) => (
                                                <StatusBadge key={`${r.frameworkKey}:${r.code}:${i}`} variant="info">
                                                    {r.frameworkName} · {r.code}
                                                </StatusBadge>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            ))}
                            <Button variant="secondary" onClick={() => setShowLinkControl(true)}>
                                {tx('biaDetail.linkControlAction')}
                            </Button>
                        </div>
                    )}
                </Section>

                {bia.notes && (
                    <Section title={tx('biaDetail.secNotes')}>
                        <p className="whitespace-pre-wrap text-sm text-content-default">{bia.notes}</p>
                    </Section>
                )}
            </div>

            {showLinkControl && (
                <BiaLinkControlModal
                    tenantSlug={tenantSlug}
                    biaId={bia.id}
                    linkedControlIds={bia.linkedControls.map((c) => c.id)}
                    onClose={() => setShowLinkControl(false)}
                    onLinked={() => {
                        setShowLinkControl(false);
                        router.refresh();
                    }}
                />
            )}

            {editing && (
                <BiaEditModal
                    tx={tx}
                    tenantSlug={tenantSlug}
                    bia={bia}
                    onClose={() => setEditing(false)}
                    onSave={async (patch) => {
                        setBusy(true);
                        try {
                            const ok = await putBia(patch);
                            if (ok) { toast.success(tx('biaDetail.saveToast')); setEditing(false); router.refresh(); }
                            else toast.error(tx('biaDetail.saveFailed'));
                        } finally { setBusy(false); }
                    }}
                    saving={busy}
                />
            )}

            <ConfirmDialog
                showModal={deleting}
                setShowModal={setDeleting}
                tone="danger"
                title={tx('biaDetail.deleteTitle')}
                description={tx('biaDetail.deleteConfirm', { name: bia.name })}
                confirmLabel={tx('biaDetail.delete')}
                onConfirm={doDelete}
                onCancel={() => setDeleting(false)}
            />
        </EntityDetailLayout>
    );
}

// ── Impact-profile editor — the core BIA output (financial / operational /
// reputational / legal impact ramping over time), previously render-only. ──
function ImpactProfileEditor({
    tx, initial, onSave,
}: {
    tx: ReturnType<typeof useTranslations>;
    initial: ImpactPoint[];
    onSave: (profile: ImpactPoint[]) => Promise<boolean>;
}) {
    const [rows, setRows] = useState<ImpactPoint[]>(initial);
    const [saving, setSaving] = useState(false);
    const dirty = JSON.stringify(rows) !== JSON.stringify(initial);

    const num = (v: string): number | undefined => (v.trim() === '' ? undefined : Number(v));
    const setCell = (i: number, key: keyof ImpactPoint, value: string) =>
        setRows((cur) => cur.map((r, idx) => (idx === i ? { ...r, [key]: key === 'atHours' ? (num(value) ?? 0) : num(value) } : r)));
    const addRow = () => setRows((cur) => [...cur, { atHours: 0 }]);
    const removeRow = (i: number) => setRows((cur) => cur.filter((_, idx) => idx !== i));

    const DIMS: Array<[keyof ImpactPoint, string]> = [
        ['financial', tx('biaDetail.impactFinancial')],
        ['operational', tx('biaDetail.impactOperational')],
        ['reputational', tx('biaDetail.impactReputational')],
        ['legal', tx('biaDetail.impactLegal')],
    ];

    return (
        <div className="space-y-default">
            {rows.length === 0 ? (
                <p className="text-sm text-content-subtle" data-testid="bia-impact-empty">{tx('biaDetail.impactEmpty')}</p>
            ) : (
                <div className="grid grid-cols-6 gap-x-3 gap-y-1 text-sm" data-testid="bia-impact-editor">
                    <div className="font-medium text-content-subtle">{tx('biaDetail.impactAt')}</div>
                    {DIMS.map(([k, label]) => <div key={k} className="font-medium text-content-subtle">{label}</div>)}
                    <div />
                    {rows.map((p, i) => (
                        <div key={i} className="contents">
                            <Input className="h-8 py-0" type="text" inputMode="numeric" value={String(p.atHours ?? '')} onChange={(e) => setCell(i, 'atHours', e.target.value)} aria-label={tx('biaDetail.impactAt')} />
                            {DIMS.map(([k]) => (
                                <Input key={k} className="h-8 py-0" type="text" inputMode="numeric" value={p[k] != null ? String(p[k]) : ''} onChange={(e) => setCell(i, k, e.target.value)} />
                            ))}
                            <button type="button" onClick={() => removeRow(i)} className="text-content-muted hover:text-content-error text-xs" aria-label={tx('biaDetail.depRemove')}>{tx('biaDetail.depRemove')}</button>
                        </div>
                    ))}
                </div>
            )}
            <div className="flex gap-tight">
                <Button variant="ghost" size="sm" onClick={addRow} id="bia-impact-add-row">{tx('biaDetail.impactAddPoint')}</Button>
                {dirty && (
                    <Button variant="secondary" size="sm" disabled={saving} id="bia-impact-save" onClick={async () => { setSaving(true); try { await onSave(rows); } finally { setSaving(false); } }}>
                        {saving ? tx('biaDetail.saving') : tx('biaDetail.saveImpact')}
                    </Button>
                )}
            </div>
        </div>
    );
}

// ── BIA edit modal — name / criticality / RTO-RPO-MTPD / owner / notes. ──
function BiaEditModal({
    tx, tenantSlug, bia, onClose, onSave, saving,
}: {
    tx: ReturnType<typeof useTranslations>;
    tenantSlug: string;
    bia: BiaDetail;
    onClose: () => void;
    onSave: (patch: Record<string, unknown>) => Promise<void>;
    saving: boolean;
}) {
    const [name, setName] = useState(bia.name);
    const [criticality, setCriticality] = useState(bia.criticality);
    const [rto, setRto] = useState(bia.rtoHours?.toString() ?? '');
    const [rpo, setRpo] = useState(bia.rpoHours?.toString() ?? '');
    const [mtpd, setMtpd] = useState(bia.mtpdHours?.toString() ?? '');
    const [ownerUserId, setOwnerUserId] = useState<string | null>(bia.ownerUser?.id ?? null);
    const [notes, setNotes] = useState(bia.notes ?? '');
    const critLabels = buildBiaCriticalityLabels((k, v) => tx(k as Parameters<typeof tx>[0], v as Parameters<typeof tx>[1]));
    const critOptions = CRITICALITY_VALUES.map((v) => ({ value: v, label: critLabels[v] ?? v }));
    const num = (s: string) => (s.trim() === '' ? null : Number(s));

    return (
        <Modal showModal setShowModal={(v) => { if (!v) onClose(); }} size="lg" title={tx('biaDetail.editTitle')}>
            <Modal.Header title={tx('biaDetail.editTitle')} />
            <Modal.Body>
                <div className="space-y-default">
                    <FormField label={tx('bia.fieldProcess')} required>
                        <Input id="bia-edit-name" value={name} onChange={(e) => setName(e.target.value)} />
                    </FormField>
                    <FormField label={tx('bia.fieldCriticality')} required>
                        <Combobox id="bia-edit-criticality" hideSearch options={critOptions} selected={critOptions.find((o) => o.value === criticality) ?? null} setSelected={(o) => { if (o) setCriticality(o.value); }} matchTriggerWidth buttonProps={{ className: 'w-full' }} />
                    </FormField>
                    <div className="grid grid-cols-1 gap-default sm:grid-cols-3">
                        <FormField label={tx('bia.fieldRto')}><Input id="bia-edit-rto" type="text" inputMode="numeric" value={rto} onChange={(e) => setRto(e.target.value)} /></FormField>
                        <FormField label={tx('bia.fieldRpo')}><Input id="bia-edit-rpo" type="text" inputMode="numeric" value={rpo} onChange={(e) => setRpo(e.target.value)} /></FormField>
                        <FormField label={tx('bia.fieldMtpd')}><Input id="bia-edit-mtpd" type="text" inputMode="numeric" value={mtpd} onChange={(e) => setMtpd(e.target.value)} /></FormField>
                    </div>
                    <FormField label={tx('bia.fieldOwner')}>
                        <UserCombobox id="bia-edit-owner" tenantSlug={tenantSlug} selectedId={ownerUserId} onChange={(uid) => setOwnerUserId(uid)} placeholder={tx('bia.phOwner')} forceDropdown matchTriggerWidth />
                    </FormField>
                    <FormField label={tx('bia.fieldNotes')}>
                        <Textarea id="bia-edit-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
                    </FormField>
                </div>
            </Modal.Body>
            <Modal.Actions>
                <Button variant="secondary" size="sm" onClick={onClose}>{tx('bia.cancel')}</Button>
                <Button variant="primary" size="sm" disabled={saving || !name.trim()} id="bia-edit-save" onClick={() => onSave({ name: name.trim(), criticality, rtoHours: num(rto), rpoHours: num(rpo), mtpdHours: num(mtpd), ownerUserId, notes: notes.trim() || null })}>
                    {saving ? tx('biaDetail.saving') : tx('biaDetail.save')}
                </Button>
            </Modal.Actions>
        </Modal>
    );
}
