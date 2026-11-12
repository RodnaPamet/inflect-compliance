'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { cn } from '@inflect/ui/lib/cn';
import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { useEntityListIds } from '@/lib/hooks/use-entity-list-ids';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { MetaStrip, type MetaItem } from '@/components/ui/meta-strip';
import { cardVariants } from '@/components/ui/card';
import { Heading } from '@/components/ui/typography';
import { KPIStat } from '@/components/ui/metric';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { InlineNotice } from '@/components/ui/inline-notice';
import { EmptyState } from '@/components/ui/empty-state';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Combobox } from '@/components/ui/combobox';
import { UserCombobox } from '@/components/ui/user-combobox';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { formatDate } from '@inflect/ui/lib/format-date';
import { useToastWithUndo, useToast } from '@/components/ui/hooks';
import { apiErrorMessage } from '@/lib/api-error';
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
    /** Who marked it reviewed (#4931); null before the reviewer was recorded. */
    reviewedByUser?: { id: string; name: string | null; email: string } | null;
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

/** The server's reason for a refusal, or `fallback` when it gave none. */
async function refusalMessage(res: Response, fallback: string): Promise<string> {
    const body: unknown = await res.json().catch(() => null);
    return apiErrorMessage(body, fallback);
}

/**
 * `canWrite` — may the viewer change this analysis? Every write behind the
 * page takes `continuity.edit` and the write tier; without it the page is
 * read-only rather than a set of buttons that each end in a refusal (#4632).
 */
export function BiaDetailClient({ bia, tenantSlug, canWrite }: { bia: BiaDetail; tenantSlug: string; canWrite: boolean }) {
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
    // `bia` IS in the `ui.recordStepper` catalog (en + bg, landed separately
    // from this file), so the tooltips read the real phrase — "Previous BIA",
    // and in Bulgarian "Предишен анализ", the register's own word for these
    // records. Naming the entity here and landing the phrase centrally is the
    // pattern: this file never needs to know the wording.
    const biaIds = useEntityListIds(null, {
        orderKey: CACHE_KEYS.audits.businessContinuity(),
    });

    // BIA-lifecycle — edit / review / impact-profile / delete surfaces.
    const [busy, setBusy] = useState(false);
    const [editing, setEditing] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const biaBase = `/api/t/${tenantSlug}/business-continuity/${bia.id}`;

    // PUT a partial patch; the API validates via UpdateBiaSchema. A refusal
    // is shown with the server's reason, so a validation error and a
    // permission refusal no longer read the same.
    const putBia = async (patch: Record<string, unknown>): Promise<boolean> => {
        const res = await fetch(biaBase, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
        });
        if (!res.ok) toast.error(await refusalMessage(res, tx('biaDetail.saveFailed')));
        return res.ok;
    };

    // The review is its own act (#4931): the server stamps its own time and
    // the caller as reviewer. The browser's clock is no longer the record.
    const markReviewed = async () => {
        setBusy(true);
        try {
            const res = await fetch(`${biaBase}/review`, { method: 'POST' });
            if (res.ok) {
                toast.success(tx('biaDetail.reviewedToast'));
                router.refresh();
            } else {
                toast.error(await refusalMessage(res, tx('biaDetail.saveFailed')));
            }
        } finally { setBusy(false); }
    };

    const doDelete = async () => {
        const res = await fetch(biaBase, { method: 'DELETE' });
        if (res.ok) {
            router.push(`/t/${tenantSlug}/audits/business-continuity`);
        } else {
            toast.error(await refusalMessage(res, tx('biaDetail.deleteFailed')));
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
            if (!res.ok) throw new Error(await refusalMessage(res, tx('biaDetail.addDependencyFailed')));
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

    const critLabels = buildBiaCriticalityLabels((k, v) => tx(k as Parameters<typeof tx>[0], v as Parameters<typeof tx>[1]));
    const metaItems: MetaItem[] = [
        { kind: 'status', label: tx('biaDetail.metaCriticality'), value: critLabels[bia.criticality] ?? bia.criticality, variant: CRITICALITY_VARIANT[bia.criticality] ?? 'neutral' },
    ];
    if (bia.recovery) metaItems.push({ kind: 'status', label: tx('biaDetail.metaRecovery'), value: tx('biaDetail.recoveryRank', { rank: bia.recovery.rank }), variant: 'info' });
    if (bia.ownerUser) metaItems.push({ kind: 'text', label: tx('biaDetail.metaOwner'), value: bia.ownerUser.name ?? bia.ownerUser.email });
    // BIA-lifecycle — surface the review state so "overdue" reflects reality
    // (reviewedAt was never set, so every BIA read as permanently overdue).
    metaItems.push(
        bia.reviewedAt
            ? {
                  kind: 'text',
                  label: tx('biaDetail.metaReviewed'),
                  value: bia.reviewedByUser
                      ? tx('biaDetail.reviewedBy', {
                            date: formatDate(bia.reviewedAt),
                            name: bia.reviewedByUser.name ?? bia.reviewedByUser.email,
                        })
                      : tx('biaDetail.reviewedNoReviewer', { date: formatDate(bia.reviewedAt) }),
              }
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
                canWrite ? (
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
                ) : undefined
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
                        readOnly={!canWrite}
                        onSave={async (profile) => {
                            const ok = await putBia({ impactProfile: profile });
                            if (ok) { toast.success(tx('biaDetail.saveToast')); router.refresh(); }
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
                                    {canWrite && (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => removeDependency(d)}
                                        aria-label={tx('biaDetail.depRemoveAria', { name: d.targetName ?? depTypeLabel(d.dependsOnType) })}
                                    >
                                        {tx('biaDetail.depRemove')}
                                    </Button>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                    {canWrite && (
                    <div className="space-y-tight">
                        <DependencyPickerRow
                            tenantSlug={tenantSlug}
                            excludeIds={bia.dependencies.map((d) => d.dependsOnId)}
                            onAdd={addDependency}
                        />
                        {depError && <InlineNotice variant="error">{depError}</InlineNotice>}
                    </div>
                    )}
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
                            description={canWrite ? tx('biaDetail.linkControlPrompt') : undefined}
                            primaryAction={canWrite ? { label: tx('biaDetail.linkControlAction'), onClick: () => setShowLinkControl(true) } : undefined}
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
                            {canWrite && (
                            <Button variant="secondary" onClick={() => setShowLinkControl(true)}>
                                {tx('biaDetail.linkControlAction')}
                            </Button>
                            )}
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
    tx, initial, onSave, readOnly,
}: {
    tx: ReturnType<typeof useTranslations>;
    initial: ImpactPoint[];
    onSave: (profile: ImpactPoint[]) => Promise<boolean>;
    /** Shows the profile without the means to change it. */
    readOnly: boolean;
}) {
    // The cells are edited as TEXT and parsed only on save (#4931): parsing on
    // every keystroke turned "abc" into NaN, which JSON stores as null, and a
    // bad hours cell into 0 — both saved without a word.
    type Draft = Record<keyof ImpactPoint, string>;
    const toDraft = (p: ImpactPoint): Draft => ({
        atHours: String(p.atHours ?? ''),
        financial: p.financial != null ? String(p.financial) : '',
        operational: p.operational != null ? String(p.operational) : '',
        reputational: p.reputational != null ? String(p.reputational) : '',
        legal: p.legal != null ? String(p.legal) : '',
    });
    const [rows, setRows] = useState<Draft[]>(() => initial.map(toDraft));
    const [saving, setSaving] = useState(false);
    const [invalid, setInvalid] = useState(false);
    const dirty = JSON.stringify(rows) !== JSON.stringify(initial.map(toDraft));

    /** A cell's number, or `undefined` when blank, or `null` when not a number. */
    const parse = (v: string): number | undefined | null => {
        if (v.trim() === '') return undefined;
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? n : null;
    };
    const setCell = (i: number, key: keyof ImpactPoint, value: string) => {
        setInvalid(false);
        setRows((cur) => cur.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)));
    };
    const addRow = () => setRows((cur) => [...cur, toDraft({ atHours: 0 })]);
    const removeRow = (i: number) => setRows((cur) => cur.filter((_, idx) => idx !== i));
    const cellInvalid = (v: string) => parse(v) === null;
    const save = async () => {
        const parsed: ImpactPoint[] = [];
        for (const r of rows) {
            const at = parse(r.atHours);
            const dims = (['financial', 'operational', 'reputational', 'legal'] as const).map((k) => [k, parse(r[k])] as const);
            if (at == null || dims.some(([, v]) => v === null)) {
                setInvalid(true);
                return;
            }
            const point: ImpactPoint = { atHours: at };
            for (const [k, v] of dims) if (v !== undefined && v !== null) point[k] = v;
            parsed.push(point);
        }
        setSaving(true);
        try { await onSave(parsed); } finally { setSaving(false); }
    };

    const DIMS: Array<[keyof ImpactPoint, string]> = [
        ['financial', tx('biaDetail.impactFinancial')],
        ['operational', tx('biaDetail.impactOperational')],
        ['reputational', tx('biaDetail.impactReputational')],
        ['legal', tx('biaDetail.impactLegal')],
    ];

    return (
        <div className="space-y-default">
            <p className="text-xs text-content-muted" data-testid="bia-impact-scale">{tx('biaDetail.impactScaleHint')}</p>
            {rows.length === 0 ? (
                <p className="text-sm text-content-subtle" data-testid="bia-impact-empty">{tx('biaDetail.impactEmpty')}</p>
            ) : (
                <div className="grid grid-cols-6 gap-x-3 gap-y-1 text-sm" data-testid="bia-impact-editor">
                    <div className="font-medium text-content-subtle">{tx('biaDetail.impactAtHours')}</div>
                    {DIMS.map(([k, label]) => <div key={k} className="font-medium text-content-subtle">{label}</div>)}
                    <div />
                    {rows.map((p, i) => (
                        <div key={i} className="contents">
                            <Input className="h-8 py-0" type="text" inputMode="decimal" readOnly={readOnly} value={p.atHours} invalid={cellInvalid(p.atHours) || (invalid && p.atHours.trim() === '')} onChange={(e) => setCell(i, 'atHours', e.target.value)} aria-label={tx('biaDetail.impactAtAria', { row: i + 1 })} />
                            {DIMS.map(([k, label]) => (
                                <Input key={k} className="h-8 py-0" type="text" inputMode="decimal" readOnly={readOnly} value={p[k]} invalid={cellInvalid(p[k])} onChange={(e) => setCell(i, k, e.target.value)} aria-label={tx('biaDetail.impactCellAria', { dimension: label, row: i + 1 })} />
                            ))}
                            {readOnly ? <div /> : (
                            <Button variant="ghost" size="sm" onClick={() => removeRow(i)} aria-label={tx('biaDetail.impactRemoveAria', { row: i + 1 })}>{tx('biaDetail.depRemove')}</Button>
                            )}
                        </div>
                    ))}
                </div>
            )}
            {invalid && (
                <InlineNotice variant="error" data-testid="bia-impact-invalid">{tx('biaDetail.impactInvalid')}</InlineNotice>
            )}
            {!readOnly && (
            <div className="flex gap-tight">
                <Button variant="ghost" size="sm" onClick={addRow} id="bia-impact-add-row">{tx('biaDetail.impactAddPoint')}</Button>
                {dirty && (
                    <Button variant="secondary" size="sm" disabled={saving} id="bia-impact-save" onClick={() => { void save(); }}>
                        {saving ? tx('biaDetail.saving') : tx('biaDetail.saveImpact')}
                    </Button>
                )}
            </div>
            )}
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
    // Blank clears the objective; anything else must be whole hours, zero or
    // more. `Number('24h')` is NaN, which JSON sends as null, so a typo used
    // to wipe the stored objective behind a success toast (#5162).
    const hours = (s: string): number | null | undefined => {
        if (s.trim() === '') return null;
        const n = Number(s);
        return Number.isInteger(n) && n >= 0 ? n : undefined;
    };
    const rtoValue = hours(rto);
    const rpoValue = hours(rpo);
    const mtpdValue = hours(mtpd);
    const hoursInvalid = rtoValue === undefined || rpoValue === undefined || mtpdValue === undefined;

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
                        <FormField label={tx('bia.fieldRto')} error={rtoValue === undefined ? tx('biaDetail.hoursInvalid') : undefined}><Input id="bia-edit-rto" type="text" inputMode="numeric" value={rto} invalid={rtoValue === undefined} onChange={(e) => setRto(e.target.value)} /></FormField>
                        <FormField label={tx('bia.fieldRpo')} error={rpoValue === undefined ? tx('biaDetail.hoursInvalid') : undefined}><Input id="bia-edit-rpo" type="text" inputMode="numeric" value={rpo} invalid={rpoValue === undefined} onChange={(e) => setRpo(e.target.value)} /></FormField>
                        <FormField label={tx('bia.fieldMtpd')} error={mtpdValue === undefined ? tx('biaDetail.hoursInvalid') : undefined}><Input id="bia-edit-mtpd" type="text" inputMode="numeric" value={mtpd} invalid={mtpdValue === undefined} onChange={(e) => setMtpd(e.target.value)} /></FormField>
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
                <Button variant="primary" size="sm" disabled={saving || !name.trim() || hoursInvalid} id="bia-edit-save" onClick={() => { if (hoursInvalid) return; void onSave({ name: name.trim(), criticality, rtoHours: rtoValue, rpoHours: rpoValue, mtpdHours: mtpdValue, ownerUserId, notes: notes.trim() || null }); }}>
                    {saving ? tx('biaDetail.saving') : tx('biaDetail.save')}
                </Button>
            </Modal.Actions>
        </Modal>
    );
}
