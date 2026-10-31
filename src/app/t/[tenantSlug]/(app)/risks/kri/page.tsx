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
import { apiErrorMessage } from '@/lib/api-error';

type Direction = 'HIGHER_IS_WORSE' | 'LOWER_IS_WORSE';
type Frequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'QUARTERLY';
type Rag = 'GREEN' | 'AMBER' | 'RED';

interface Kri {
    id: string; name: string; description?: string | null; unit: string | null; direction: string;
    greenMax: number | null; amberMax: number | null;
    frequency: string; targetValue: number | null; ownerUserId?: string | null; isActive: boolean;
    riskId: string | null;
    risk?: { id: string; title: string } | null;
    owner?: { id: string; name: string | null; email: string | null } | null;
    latestReading: { value: number; ragStatus: string | null } | null; sparkline: number[];
}

interface KriDraft {
    name: string; unit: string; greenMax: string; amberMax: string; targetValue: string;
    direction: Direction; frequency: Frequency; ownerUserId: string | null; riskId: string | null;
    description: string;
}
const EMPTY_DRAFT: KriDraft = {
    name: '', unit: '', greenMax: '', amberMax: '', targetValue: '',
    direction: 'HIGHER_IS_WORSE', frequency: 'MONTHLY', ownerUserId: null, riskId: null, description: '',
};
const FREQUENCIES: ReadonlyArray<Frequency> = ['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY'];
const FREQUENCY_KEY: Record<Frequency, string> = {
    DAILY: 'kri.freqDaily', WEEKLY: 'kri.freqWeekly', MONTHLY: 'kri.freqMonthly', QUARTERLY: 'kri.freqQuarterly',
};
const isFrequency = (v: string): v is Frequency => (FREQUENCIES as readonly string[]).includes(v);
const isRag = (v: string | null | undefined): v is Rag => v === 'GREEN' || v === 'AMBER' || v === 'RED';

function draftFromKri(k: Kri): KriDraft {
    return {
        name: k.name, unit: k.unit ?? '', greenMax: k.greenMax?.toString() ?? '', amberMax: k.amberMax?.toString() ?? '',
        targetValue: k.targetValue?.toString() ?? '', direction: (k.direction as Direction) ?? 'HIGHER_IS_WORSE',
        frequency: isFrequency(k.frequency) ? k.frequency : 'MONTHLY', ownerUserId: k.ownerUserId ?? null, riskId: k.riskId,
        description: k.description ?? '',
    };
}
function draftPayload(d: KriDraft) {
    const num = (s: string) => (s.trim() ? Number(s) : null);
    return {
        name: d.name.trim(), unit: d.unit.trim() || null, greenMax: num(d.greenMax), amberMax: num(d.amberMax),
        targetValue: num(d.targetValue), direction: d.direction, frequency: d.frequency,
        ownerUserId: d.ownerUserId, riskId: d.riskId, description: d.description.trim() || null,
    };
}

/**
 * #4769 — which stored threshold each colour boundary is.
 *
 * `computeRag` reads the two columns by direction. Higher-is-worse: GREEN while
 * value ≤ greenMax, AMBER while ≤ amberMax. Lower-is-worse: GREEN while
 * value ≥ amberMax, AMBER while ≥ greenMax. The form used to label the columns
 * "Green ≤ / Amber ≤" in both cases, so a lower-is-worse indicator entered the
 * natural way ("Green 95, Amber 90") had its bands inverted. The form and the
 * card now name the boundary the user means and store it in the column
 * `computeRag` reads for it.
 */
function boundaryFields(direction: Direction): { green: 'greenMax' | 'amberMax'; amber: 'greenMax' | 'amberMax' } {
    return direction === 'LOWER_IS_WORSE' ? { green: 'amberMax', amber: 'greenMax' } : { green: 'greenMax', amber: 'amberMax' };
}

const ragVariant = (r: string | null | undefined) => (r === 'RED' ? 'error' : r === 'AMBER' ? 'warning' : 'success');

export default function KriPage() {
    const t = useTranslations('risks');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const { tenantSlug, permissions, appPermissions } = useTenantContext();
    // Creating an indicator and recording a reading assert the write tier.
    const canWrite = permissions.canWrite;
    // #4769 — editing, switching off and deleting go through
    // `PATCH`/`DELETE /risks/kri/:id`, which take `risks.edit`; offering them
    // on the write tier alone showed a custom role buttons the server refused.
    const canEdit = canWrite && (appPermissions?.risks?.edit ?? false);
    const toast = useToast();
    const kriQuery = useTenantSWR<{ kris: Kri[] }>('/risks/kri');
    const kris = kriQuery.data?.kris ?? [];

    const [draft, setDraft] = useState<KriDraft>(EMPTY_DRAFT);
    const [busy, setBusy] = useState(false);
    const [editing, setEditing] = useState<Kri | null>(null);
    const [deleting, setDeleting] = useState<Kri | null>(null);
    // #4769 — each write reports where it happened. One shared error line
    // beside Create used to stand in for a failed reading, edit or delete.
    const [createError, setCreateError] = useState<string | null>(null);
    const [editError, setEditError] = useState<string | null>(null);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    /**
     * The refusal to show for a failed write: the role note for a 403, the
     * server's own reason for any other client error (invalid thresholds,
     * say), and the fixed try-again sentence for an outage.
     */
    const refusalText = (status: number, body: unknown): string => {
        if (status === 403) return t('kri.writeRestricted');
        if (status >= 500) return t('kri.saveError');
        return apiErrorMessage(body, t('kri.saveError'));
    };

    /**
     * B2-1 — all five KRI writes go through one mutation on the KRI key.
     *
     * Every one of them swallowed failures, and four destroyed state on the
     * way past. `record` was the subtlest: it read `res.json()` WITHOUT
     * checking `res.ok`, so a 4xx parsed an error body, found no
     * `remediationTaskId`, skipped the toast and revalidated — a rejected
     * reading looked exactly like a reading that simply did not breach.
     */
    const writeMutation = useTenantMutation<unknown, { path: string; method: string; body?: unknown }, unknown>({
        key: '/risks/kri',
        mutationFn: async ({ path, method, body }) => {
            let res: Response;
            try {
                res = await fetch(apiUrl(path), {
                    method,
                    ...(body === undefined
                        ? {}
                        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
                });
            } catch {
                throw new Error(t('kri.saveError'));
            }
            if (!res.ok) {
                const errBody: unknown = await res.json().catch(() => null);
                throw new Error(refusalText(res.status, errBody));
            }
            return res.json().catch(() => ({}));
        },
    });
    const messageOf = (e: unknown) => (e instanceof Error ? e.message : t('kri.saveError'));

    const create = async () => {
        if (!draft.name.trim()) return;
        setBusy(true);
        setCreateError(null);
        try {
            await writeMutation.trigger({ path: '/risks/kri', method: 'POST', body: draftPayload(draft) });
            // Only after it landed — a failed create used to wipe the draft.
            setDraft(EMPTY_DRAFT);
        } catch (e) {
            setCreateError(messageOf(e));
        } finally { setBusy(false); }
    };

    /** Record a reading; the error to show, or null once it landed. */
    const record = async (kriId: string, raw: string): Promise<string | null> => {
        const value = Number(raw.trim().replace(',', '.'));
        // #4769 — a value that is not a number used to be ignored silently.
        if (!raw.trim() || !Number.isFinite(value)) return t('kri.readingNotNumber');
        try {
            const data = (await writeMutation.trigger({
                path: `/risks/kri/${kriId}/readings`,
                method: 'POST',
                body: { value },
            })) as { remediationTaskId?: string } | null;
            if (data?.remediationTaskId) toast.success(t('kri.remediationSpawned'));
            return null;
        } catch (e) {
            return messageOf(e);
        }
    };

    const patchKri = (kriId: string, body: Record<string, unknown>) =>
        writeMutation.trigger({ path: `/risks/kri/${kriId}`, method: 'PATCH', body });

    const toggleActive = async (k: Kri) => {
        try {
            await patchKri(k.id, { isActive: !k.isActive });
        } catch (e) {
            toast.error(messageOf(e));
        }
    };

    const saveEdit = async () => {
        if (!editing) return;
        setBusy(true);
        setEditError(null);
        try {
            await patchKri(editing.id, draftPayload(draft));
            setEditing(null);
            setDraft(EMPTY_DRAFT);
        } catch (e) {
            // The edit stays open, with the reason inside it.
            setEditError(messageOf(e));
        } finally { setBusy(false); }
    };

    const doDelete = async () => {
        if (!deleting) return;
        setDeleteError(null);
        try {
            await writeMutation.trigger({ path: `/risks/kri/${deleting.id}`, method: 'DELETE' });
            setDeleting(null);
        } catch (e) {
            setDeleteError(messageOf(e));
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

            {canWrite && (
            <Card className="space-y-default p-6">
                <Heading level={2}>{t('kri.newKri')}</Heading>
                <KriFields draft={draft} setDraft={setDraft} tenantSlug={tenantSlug} t={t} idPrefix="kri" />
                <div className="flex items-center justify-end gap-default">
                    {createError && (
                        <span className="text-xs text-content-error" role="alert" data-testid="kri-save-error">
                            {createError}
                        </span>
                    )}
                    <Button variant="primary" onClick={create} disabled={busy || !draft.name.trim()} id="kri-create-btn">{t('kri.create')}</Button>
                </div>
            </Card>
            )}

            <AnalyticsState
                isLoading={kriQuery.isLoading}
                error={kriQuery.error}
                isEmpty={kris.length === 0}
                emptyText={t('kri.empty')}
                errorText={t('kri.loadError')}
            >
                <div className="grid grid-cols-1 gap-default md:grid-cols-2">
                    {kris.map((k) => {
                        const direction: Direction = k.direction === 'LOWER_IS_WORSE' ? 'LOWER_IS_WORSE' : 'HIGHER_IS_WORSE';
                        const fields = boundaryFields(direction);
                        const rag = k.latestReading?.ragStatus;
                        const unit = k.unit ?? '';
                        return (
                        <Card key={k.id} className="space-y-tight p-6" data-testid="kri-card">
                            <div className="flex items-center justify-between gap-default">
                                <div className="flex items-center gap-tight">
                                    <Heading level={3}>{k.name}</Heading>
                                    {!k.isActive && <StatusBadge variant="neutral">{t('kri.inactive')}</StatusBadge>}
                                </div>
                                <StatusBadge variant={ragVariant(rag)} data-testid={`kri-rag-${k.id}`}>
                                    {k.latestReading == null
                                        ? t('kri.noData')
                                        : t('kri.ragReading', {
                                              rag: isRag(rag) ? t(`kri.rag.${rag}`) : t('kri.noData'),
                                              value: `${k.latestReading.value}${unit}`,
                                          })}
                                </StatusBadge>
                            </div>
                            <div className="font-mono text-lg leading-none text-content-emphasis" aria-label={t('kri.trendAria')}>{sparkline(k.sparkline)}</div>
                            <p className="text-xs text-content-muted" data-testid={`kri-meta-${k.id}`}>
                                {[
                                    k.targetValue != null ? t('kri.targetLine', { value: `${k.targetValue}${unit}` }) : null,
                                    isFrequency(k.frequency) ? t(FREQUENCY_KEY[k.frequency]) : null,
                                    direction === 'LOWER_IS_WORSE' ? t('kri.dirLowerWorse') : t('kri.dirHigherWorse'),
                                    t(direction === 'LOWER_IS_WORSE' ? 'kri.thresholdsLower' : 'kri.thresholds', {
                                        green: k[fields.green] ?? '—',
                                        amber: k[fields.amber] ?? '—',
                                    }),
                                ].filter(Boolean).join(' · ')}
                            </p>
                            {(k.risk || k.owner) && (
                                <p className="text-xs text-content-muted" data-testid={`kri-links-${k.id}`}>
                                    {k.risk && (
                                        <>
                                            {t('kri.riskLabel')}:{' '}
                                            <Link href={tenantHref(`/risks/${k.risk.id}`)} className="text-content-default underline underline-offset-2">
                                                {k.risk.title}
                                            </Link>
                                        </>
                                    )}
                                    {k.risk && k.owner && ' · '}
                                    {k.owner && <>{t('kri.ownerLabel')}: {k.owner.name ?? k.owner.email}</>}
                                </p>
                            )}
                            {k.riskId && k.latestReading?.ragStatus === 'RED' && (
                                <Link
                                    href={tenantHref(`/risks/${k.riskId}?tab=assessment`)}
                                    className="inline-flex items-center gap-1 text-xs font-medium text-content-error underline underline-offset-2"
                                    data-testid={`kri-reassess-link-${k.id}`}
                                >
                                    {t('kri.reassess')}
                                </Link>
                            )}
                            {canWrite && <RecordInline kriId={k.id} onRecord={(v) => record(k.id, v)} />}
                            {/* PR-L — KRI lifecycle actions. */}
                            {canEdit && (
                            <div className="flex items-center gap-tight border-t border-border-subtle pt-tight">
                                <Button size="sm" variant="ghost" onClick={() => { setDraft(draftFromKri(k)); setEditError(null); setEditing(k); }} data-testid={`kri-edit-${k.id}`}>{t('kri.edit')}</Button>
                                <Button size="sm" variant="ghost" onClick={() => toggleActive(k)} data-testid={`kri-toggle-${k.id}`}>
                                    {k.isActive ? t('kri.deactivate') : t('kri.activate')}
                                </Button>
                                <Button size="sm" variant="ghost" className="ml-auto text-content-error" onClick={() => { setDeleteError(null); setDeleting(k); }} data-testid={`kri-delete-${k.id}`}>{t('kri.delete')}</Button>
                            </div>
                            )}
                        </Card>
                        );
                    })}
                </div>
            </AnalyticsState>

            {/* Edit modal — reuses the shared field bag. */}
            <Modal showModal={editing !== null} setShowModal={(v) => { if (!v) { setEditing(null); setDraft(EMPTY_DRAFT); } }} title={t('kri.editTitle')} size="lg">
                <Modal.Header title={t('kri.editTitle')} />
                <Modal.Body>
                    <KriFields draft={draft} setDraft={setDraft} tenantSlug={tenantSlug} t={t} idPrefix="kri-edit" />
                    {editError && (
                        <p className="mt-default text-sm text-content-error" role="alert" data-testid="kri-edit-error">{editError}</p>
                    )}
                </Modal.Body>
                <Modal.Actions>
                    <Button variant="secondary" size="sm" onClick={() => { setEditing(null); setDraft(EMPTY_DRAFT); }}>{t('edit.cancel')}</Button>
                    <Button variant="primary" size="sm" onClick={saveEdit} disabled={busy || !draft.name.trim()} id="kri-edit-save">{t('edit.save')}</Button>
                </Modal.Actions>
            </Modal>

            <ConfirmDialog
                showModal={deleting !== null}
                setShowModal={(v) => { if (!v) setDeleting(null); }}
                tone="danger"
                title={t('kri.deleteTitle')}
                description={deleteError ?? t('kri.deleteConfirm', { name: deleting?.name ?? '' })}
                confirmLabel={t('kri.delete')}
                onConfirm={doDelete}
                onCancel={() => setDeleting(null)}
            />
        </div>
    );
}

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
    // #4769 — switching direction keeps the two figures in the boxes the user
    // typed them in: the boxes trade the columns they write to.
    const setDirection = (direction: Direction) => {
        if (direction === draft.direction) return;
        setDraft({ ...draft, direction, greenMax: draft.amberMax, amberMax: draft.greenMax });
    };
    const fields = boundaryFields(draft.direction);
    const lower = draft.direction === 'LOWER_IS_WORSE';
    const DIRECTION_OPTIONS: ComboboxOption[] = [
        { value: 'HIGHER_IS_WORSE', label: t('kri.dirHigherWorse') },
        { value: 'LOWER_IS_WORSE', label: t('kri.dirLowerWorse') },
    ];
    const FREQUENCY_OPTIONS: ComboboxOption[] = FREQUENCIES.map((f) => ({ value: f, label: t(FREQUENCY_KEY[f]) }));
    return (
        <div className="space-y-default">
            <div className="flex flex-wrap items-end gap-default">
                <label className="block flex-1 min-w-[12rem]"><span className="text-xs text-content-muted">{t('kri.name')}</span><Input id={`${idPrefix}-name`} value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder={t('kri.namePlaceholder')} /></label>
                <label className="block w-20 sm:w-24"><span className="text-xs text-content-muted">{t('kri.unit')}</span><Input id={`${idPrefix}-unit`} value={draft.unit} onChange={(e) => set('unit', e.target.value)} placeholder={t('kri.unitPlaceholder')} /></label>
                <label className="block w-24 sm:w-28"><span className="text-xs text-content-muted">{lower ? t('kri.greenMin') : t('kri.greenMax')}</span><Input id={`${idPrefix}-green`} type="text" inputMode="decimal" value={draft[fields.green]} onChange={(e) => set(fields.green, e.target.value)} /></label>
                <label className="block w-24 sm:w-28"><span className="text-xs text-content-muted">{lower ? t('kri.amberMin') : t('kri.amberMax')}</span><Input id={`${idPrefix}-amber`} type="text" inputMode="decimal" value={draft[fields.amber]} onChange={(e) => set(fields.amber, e.target.value)} /></label>
                <label className="block w-24 sm:w-28"><span className="text-xs text-content-muted">{t('kri.target')}</span><Input type="text" inputMode="decimal" value={draft.targetValue} onChange={(e) => set('targetValue', e.target.value)} /></label>
            </div>
            <div className="flex flex-wrap items-end gap-default">
                <label className="block flex-1 min-w-[12rem]"><span className="text-xs text-content-muted">{t('kri.riskLabel')}</span>
                    <RiskPicker id={`${idPrefix}-risk-picker`} value={draft.riskId} onChange={(v) => set('riskId', v)} allowNone noneLabel={t('kri.riskNone')} placeholder={t('kri.riskPlaceholder')} />
                </label>
                <label className="block w-full sm:w-48"><span className="text-xs text-content-muted">{t('kri.directionLabel')}</span>
                    <Combobox id={`${idPrefix}-direction`} options={DIRECTION_OPTIONS} selected={DIRECTION_OPTIONS.find((o) => o.value === draft.direction) ?? null} setSelected={(opt) => { if (opt) setDirection(opt.value as Direction); }} />
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

/**
 * #4769 — the value stays in the box until the server took it. It used to be
 * cleared on click, so a rejected reading was simply gone.
 */
function RecordInline({ kriId, onRecord }: { kriId: string; onRecord: (v: string) => Promise<string | null> }) {
    const t = useTranslations('risks');
    const [v, setV] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const submit = async () => {
        setBusy(true);
        setError(null);
        const failure = await onRecord(v);
        setBusy(false);
        if (failure) setError(failure);
        else setV('');
    };
    return (
        <div className="space-y-tight">
            <div className="flex items-end gap-tight">
                <label className="block flex-1"><span className="text-xs text-content-muted">{t('kri.recordReading')}</span>
                    <Input type="text" inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} placeholder={t('kri.valuePlaceholder')} data-testid={`kri-reading-input-${kriId}`} />
                </label>
                <Button size="sm" variant="secondary" onClick={submit} disabled={busy || !v.trim()} data-testid={`kri-reading-add-${kriId}`}>{t('kri.add')}</Button>
            </div>
            {error && <p className="text-xs text-content-error" role="alert" data-testid={`kri-reading-error-${kriId}`}>{error}</p>}
        </div>
    );
}
