'use client';

/* RQ-6 — Key Risk Indicators: RAG cards + sparkline + record reading.
 * PR-L — full create form (unit/frequency/target/owner/description) +
 * edit / deactivate / delete lifecycle. */
import { useState } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { Modal } from '@/components/ui/modal';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { FormField } from '@/components/ui/form-field';
import { UserCombobox } from '@/components/ui/user-combobox';
import { InfoTooltip } from '@/components/ui/tooltip';
import { StatusBadge } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { useTenantApiUrl, useTenantHref, useTenantContext } from '@/lib/tenant-context-provider';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useToast } from '@/components/ui/hooks';
import { useTranslations } from 'next-intl';
import { RiskPicker } from '../_shared/RiskPicker';
import { AnalyticsState } from '../_shared/AnalyticsState';
import { sparkline } from '@/lib/ascii-sparkline';
import { useTenantMutation } from '@/lib/hooks/use-tenant-mutation';

type Direction = 'HIGHER_IS_WORSE' | 'LOWER_IS_WORSE';
type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY';

interface Kri {
    id: string; name: string; description?: string | null; unit: string | null; direction: string;
    greenMax: number | null; amberMax: number | null;
    frequency: string; targetValue: number | null; ownerUserId?: string | null; isActive: boolean;
    riskId: string | null;
    latestReading: { value: number; ragStatus: string | null } | null; sparkline: number[];
}

// The editable KRI field bag, shared by the create form + the edit modal.
interface KriDraft {
    name: string; unit: string; greenMax: string; amberMax: string; targetValue: string;
    direction: Direction; frequency: Frequency; ownerUserId: string | null; riskId: string | null;
    description: string;
}
const EMPTY_DRAFT: KriDraft = {
    name: '', unit: '', greenMax: '', amberMax: '', targetValue: '',
    direction: 'HIGHER_IS_WORSE', frequency: 'MONTHLY', ownerUserId: null, riskId: null, description: '',
};
function draftFromKri(k: Kri): KriDraft {
    return {
        name: k.name, unit: k.unit ?? '', greenMax: k.greenMax?.toString() ?? '', amberMax: k.amberMax?.toString() ?? '',
        targetValue: k.targetValue?.toString() ?? '', direction: (k.direction as Direction) ?? 'HIGHER_IS_WORSE',
        frequency: (k.frequency as Frequency) ?? 'MONTHLY', ownerUserId: k.ownerUserId ?? null, riskId: k.riskId,
        description: k.description ?? '',
    };
}
// Project a draft into the API payload (empty strings → null numbers).
function draftPayload(d: KriDraft) {
    const num = (s: string) => (s.trim() ? Number(s) : null);
    return {
        name: d.name.trim(), unit: d.unit.trim() || null, greenMax: num(d.greenMax), amberMax: num(d.amberMax),
        targetValue: num(d.targetValue), direction: d.direction, frequency: d.frequency,
        ownerUserId: d.ownerUserId, riskId: d.riskId, description: d.description.trim() || null,
    };
}

const ragVariant = (r: string | null | undefined) => (r === 'RED' ? 'error' : r === 'AMBER' ? 'warning' : 'success');

export default function KriPage() {
    const t = useTranslations('risks');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const { tenantSlug } = useTenantContext();
    const toast = useToast();
    const kriQuery = useTenantSWR<{ kris: Kri[] }>('/risks/kri');
    const kris = kriQuery.data?.kris ?? [];

    const [draft, setDraft] = useState<KriDraft>(EMPTY_DRAFT);
    const [busy, setBusy] = useState(false);
    const [editing, setEditing] = useState<Kri | null>(null);
    const [deleting, setDeleting] = useState<Kri | null>(null);

    /**
     * B2-1 — all five KRI writes go through one mutation on the KRI key.
     *
     * Every one of them swallowed failures, and four destroyed state on the
     * way past. `record` was the subtlest: it read `res.json()` WITHOUT
     * checking `res.ok`, so a 4xx parsed an error body, found no
     * `remediationTaskId`, skipped the toast and revalidated — a rejected
     * reading looked exactly like a reading that simply did not breach.
     * On a page whose entire job is recording sensor values that drive
     * remediation, a silently-dropped reading is the worst outcome
     * available.
     */
    const writeMutation = useTenantMutation<unknown, { path: string; method: string; body?: unknown }, unknown>({
        key: '/risks/kri',
        mutationFn: async ({ path, method, body }) => {
            const res = await fetch(apiUrl(path), {
                method,
                ...(body === undefined
                    ? {}
                    : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
            });
            if (!res.ok) throw new Error(t('kri.saveError'));
            return res.json().catch(() => ({}));
        },
    });

    const create = async () => {
        if (!draft.name.trim()) return;
        setBusy(true);
        try {
            await writeMutation.trigger({ path: '/risks/kri', method: 'POST', body: draftPayload(draft) });
            // Only after it landed — a failed create used to wipe the draft.
            setDraft(EMPTY_DRAFT);
        } catch {
            /* visible via writeMutation.error; the draft stays */
        } finally { setBusy(false); }
    };

    const record = async (kriId: string, raw: string) => {
        const value = Number(raw);
        if (!isFinite(value)) return;
        try {
            const data = (await writeMutation.trigger({
                path: `/risks/kri/${kriId}/readings`,
                method: 'POST',
                body: { value },
            })) as { remediationTaskId?: string } | null;
            // PR-L — surface the RED→remediation-task spawn so the user sees
            // the sensor drove real work, not just a chip flip.
            if (data?.remediationTaskId) toast.success(t('kri.remediationSpawned'));
        } catch {
            /* visible via writeMutation.error */
        }
    };

    const patchKri = (kriId: string, body: Record<string, unknown>) =>
        writeMutation.trigger({ path: `/risks/kri/${kriId}`, method: 'PATCH', body });

    const saveEdit = async () => {
        if (!editing) return;
        setBusy(true);
        try {
            await patchKri(editing.id, draftPayload(draft));
            // Closing the editor is the confirmation — do it only on success.
            setEditing(null);
        } catch {
            /* visible via writeMutation.error; the edit stays open */
        } finally { setBusy(false); }
    };

    const doDelete = async () => {
        if (!deleting) return;
        try {
            await writeMutation.trigger({ path: `/risks/kri/${deleting.id}`, method: 'DELETE' });
            setDeleting(null);
        } catch {
            /* visible via writeMutation.error; the dialog stays open */
        }
    };

    return (
        <div className="space-y-section">
            <BackAffordance />
            <PageBreadcrumbs items={[{ label: t('breadcrumbRoot'), href: tenantHref('/risks') }, { label: t('kri.breadcrumb') }]} />
            <div className="flex items-center gap-tight">
                <Heading level={1}>{t('kri.title')}</Heading>
                <InfoTooltip title={t('kri.conceptTitle')} content={t('kri.conceptHelp')} side="right" />
            </div>

            <Card className="space-y-default p-6">
                <Heading level={2}>{t('kri.newKri')}</Heading>
                <KriFields draft={draft} setDraft={setDraft} tenantSlug={tenantSlug} t={t} idPrefix="kri" />
                <div className="flex items-center justify-end gap-default">
                    {/* Every write on this page shares one mutation, so one
                        alert covers create / record / edit / delete. It sits
                        beside the primary action rather than in a toast
                        because a dropped SENSOR READING must not scroll away
                        unnoticed — that reading drives remediation. */}
                    {writeMutation.error && (
                        <span className="text-xs text-content-error" role="alert" data-testid="kri-save-error">
                            {t('kri.saveError')}
                        </span>
                    )}
                    <Button variant="primary" onClick={create} disabled={busy || !draft.name.trim()} id="kri-create-btn">{t('kri.create')}</Button>
                </div>
            </Card>

            <AnalyticsState
                isLoading={kriQuery.isLoading}
                error={kriQuery.error}
                isEmpty={kris.length === 0}
                emptyText={t('kri.empty')}
                errorText={t('kri.loadError')}
            >
                <div className="grid grid-cols-1 gap-default md:grid-cols-2">
                    {kris.map((k) => (
                        <Card key={k.id} className="space-y-tight p-6" data-testid="kri-card">
                            <div className="flex items-center justify-between gap-default">
                                <div className="flex items-center gap-tight">
                                    <Heading level={3}>{k.name}</Heading>
                                    {!k.isActive && <StatusBadge variant="neutral">{t('kri.inactive')}</StatusBadge>}
                                </div>
                                <StatusBadge variant={ragVariant(k.latestReading?.ragStatus)}>
                                    {k.latestReading?.ragStatus ?? t('kri.noData')}{k.latestReading != null ? ` · ${k.latestReading.value}${k.unit ?? ''}` : ''}
                                </StatusBadge>
                            </div>
                            <div className="font-mono text-lg leading-none text-content-emphasis" aria-label={t('kri.trendAria')}>{sparkline(k.sparkline)}</div>
                            <p className="text-xs text-content-muted">
                                {k.targetValue != null ? t('kri.targetPrefix', { value: `${k.targetValue}${k.unit ?? ''}` }) : ''}{k.frequency.toLowerCase()} · {t('kri.thresholds', { green: k.greenMax ?? '—', amber: k.amberMax ?? '—' })}
                            </p>
                            {k.riskId && k.latestReading?.ragStatus === 'RED' && (
                                <Link
                                    href={tenantHref(`/risks/${k.riskId}?tab=assessment`)}
                                    className="inline-flex items-center gap-1 text-xs font-medium text-content-error underline underline-offset-2"
                                    data-testid={`kri-reassess-link-${k.id}`}
                                >
                                    {t('kri.reassess')}
                                </Link>
                            )}
                            <RecordInline onRecord={(v) => record(k.id, v)} />
                            {/* PR-L — KRI lifecycle actions. */}
                            <div className="flex items-center gap-tight border-t border-border-subtle pt-tight">
                                <Button size="sm" variant="ghost" onClick={() => { setDraft(draftFromKri(k)); setEditing(k); }} data-testid={`kri-edit-${k.id}`}>{t('kri.edit')}</Button>
                                <Button size="sm" variant="ghost" onClick={() => patchKri(k.id, { isActive: !k.isActive })} data-testid={`kri-toggle-${k.id}`}>
                                    {k.isActive ? t('kri.deactivate') : t('kri.activate')}
                                </Button>
                                <Button size="sm" variant="ghost" className="ml-auto text-content-error" onClick={() => setDeleting(k)} data-testid={`kri-delete-${k.id}`}>{t('kri.delete')}</Button>
                            </div>
                        </Card>
                    ))}
                </div>
            </AnalyticsState>

            {/* Edit modal — reuses the shared field bag. */}
            <Modal showModal={editing !== null} setShowModal={(v) => { if (!v) setEditing(null); }} title={t('kri.editTitle')} size="lg">
                <Modal.Header title={t('kri.editTitle')} />
                <Modal.Body>
                    <KriFields draft={draft} setDraft={setDraft} tenantSlug={tenantSlug} t={t} idPrefix="kri-edit" />
                </Modal.Body>
                <Modal.Actions>
                    <Button variant="secondary" size="sm" onClick={() => setEditing(null)}>{t('edit.cancel')}</Button>
                    <Button variant="primary" size="sm" onClick={saveEdit} disabled={busy || !draft.name.trim()} id="kri-edit-save">{t('edit.save')}</Button>
                </Modal.Actions>
            </Modal>

            <ConfirmDialog
                showModal={deleting !== null}
                setShowModal={(v) => { if (!v) setDeleting(null); }}
                tone="danger"
                title={t('kri.deleteTitle')}
                description={t('kri.deleteConfirm', { name: deleting?.name ?? '' })}
                confirmLabel={t('kri.delete')}
                onConfirm={doDelete}
                onCancel={() => setDeleting(null)}
            />
        </div>
    );
}

// Shared editable field set for create + edit.
function KriFields({
    draft, setDraft, tenantSlug, t, idPrefix,
}: {
    draft: KriDraft;
    setDraft: (d: KriDraft) => void;
    tenantSlug: string;
    t: (k: string, v?: Record<string, string | number | Date>) => string;
    idPrefix: string;
}) {
    const set = <K extends keyof KriDraft>(k: K, v: KriDraft[K]) => setDraft({ ...draft, [k]: v });
    const DIRECTION_OPTIONS: ComboboxOption[] = [
        { value: 'HIGHER_IS_WORSE', label: t('kri.dirHigherWorse') },
        { value: 'LOWER_IS_WORSE', label: t('kri.dirLowerWorse') },
    ];
    const FREQUENCY_OPTIONS: ComboboxOption[] = [
        { value: 'DAILY', label: t('kri.freqDaily') },
        { value: 'WEEKLY', label: t('kri.freqWeekly') },
        { value: 'MONTHLY', label: t('kri.freqMonthly') },
        { value: 'QUARTERLY', label: t('kri.freqQuarterly') },
    ];
    return (
        <div className="space-y-default">
            <div className="flex flex-wrap items-end gap-default">
                <label className="block flex-1 min-w-[12rem]"><span className="text-xs text-content-muted">{t('kri.name')}</span><Input id={`${idPrefix}-name`} value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder={t('kri.namePlaceholder')} /></label>
                <label className="block w-20 sm:w-24"><span className="text-xs text-content-muted">{t('kri.unit')}</span><Input id={`${idPrefix}-unit`} value={draft.unit} onChange={(e) => set('unit', e.target.value)} placeholder={t('kri.unitPlaceholder')} /></label>
                <label className="block w-24 sm:w-28"><span className="text-xs text-content-muted">{t('kri.greenMax')}</span><Input type="text" inputMode="decimal" value={draft.greenMax} onChange={(e) => set('greenMax', e.target.value)} /></label>
                <label className="block w-24 sm:w-28"><span className="text-xs text-content-muted">{t('kri.amberMax')}</span><Input type="text" inputMode="decimal" value={draft.amberMax} onChange={(e) => set('amberMax', e.target.value)} /></label>
                <label className="block w-24 sm:w-28"><span className="text-xs text-content-muted">{t('kri.target')}</span><Input type="text" inputMode="decimal" value={draft.targetValue} onChange={(e) => set('targetValue', e.target.value)} /></label>
            </div>
            <div className="flex flex-wrap items-end gap-default">
                <label className="block flex-1 min-w-[12rem]"><span className="text-xs text-content-muted">{t('kri.riskLabel')}</span>
                    <RiskPicker id={`${idPrefix}-risk-picker`} value={draft.riskId} onChange={(v) => set('riskId', v)} allowNone noneLabel={t('kri.riskNone')} placeholder={t('kri.riskPlaceholder')} />
                </label>
                <label className="block w-full sm:w-48"><span className="text-xs text-content-muted">{t('kri.directionLabel')}</span>
                    <Combobox id={`${idPrefix}-direction`} options={DIRECTION_OPTIONS} selected={DIRECTION_OPTIONS.find((o) => o.value === draft.direction) ?? null} setSelected={(opt) => { if (opt) set('direction', opt.value as Direction); }} />
                </label>
                <label className="block w-full sm:w-40"><span className="text-xs text-content-muted">{t('kri.frequencyLabel')}</span>
                    <Combobox id={`${idPrefix}-frequency`} options={FREQUENCY_OPTIONS} selected={FREQUENCY_OPTIONS.find((o) => o.value === draft.frequency) ?? null} setSelected={(opt) => { if (opt) set('frequency', opt.value as Frequency); }} />
                </label>
            </div>
            <FormField label={t('kri.ownerLabel')}>
                <UserCombobox id={`${idPrefix}-owner`} tenantSlug={tenantSlug} selectedId={draft.ownerUserId} onChange={(uid) => set('ownerUserId', uid)} placeholder={t('kri.ownerPlaceholder')} forceDropdown matchTriggerWidth />
            </FormField>
            <FormField label={t('kri.descriptionLabel')}>
                <Textarea id={`${idPrefix}-description`} rows={2} value={draft.description} onChange={(e) => set('description', e.target.value)} placeholder={t('kri.descriptionPlaceholder')} />
            </FormField>
        </div>
    );
}

function RecordInline({ onRecord }: { onRecord: (v: string) => void }) {
    const t = useTranslations('risks');
    const [v, setV] = useState('');
    return (
        <div className="flex items-end gap-tight">
            <label className="block flex-1"><span className="text-xs text-content-muted">{t('kri.recordReading')}</span>
                <Input type="text" inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} placeholder={t('kri.valuePlaceholder')} />
            </label>
            <Button size="sm" variant="secondary" onClick={() => { onRecord(v); setV(''); }} disabled={!v.trim()}>{t('kri.add')}</Button>
        </div>
    );
}
