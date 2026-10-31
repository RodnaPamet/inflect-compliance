'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useTenantApiUrl, useTenantHref, useTenantContext } from '@/lib/tenant-context-provider';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { RequirePermission } from '@/components/require-permission';
import { Combobox, ComboboxOption } from '@/components/ui/combobox';
import { StatusBadge } from '@/components/ui/status-badge';
import { useRiskMatrixConfig } from '@/lib/hooks/use-risk-matrix-config';
import { resolveBandForScore, resolveBandTone } from '@/lib/risk-matrix/scoring';
import { riskSeverityToBadgeVariant } from '@/app-layer/domain/entity-status-mapping';
import { Heading } from '@/components/ui/typography';
import { Card, cardVariants } from '@/components/ui/card';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@inflect/ui/lib/cn';
import { riskCanCreate } from '../_shared/bulk-permissions';

// #4776 — the likelihood and impact pickers follow the workspace's matrix,
// not a fixed 1–5: `applySession` refuses a value above the tenant's scale.
const scaleOptions = (levels: number): ComboboxOption[] =>
    Array.from({ length: Math.max(1, levels) }, (_, n) => ({ value: String(n + 1), label: String(n + 1) }));

/** The frameworks a suggestion set can be steered towards, with their names. */
const FRAMEWORK_CHOICES: ReadonlyArray<{ key: string; label: string }> = [
    { key: 'ISO27001', label: 'ISO 27001' },
    { key: 'NIS2', label: 'NIS2' },
    { key: 'SOC2', label: 'SOC 2' },
];

const ASSET_TYPES = new Set([
    'INFORMATION', 'SYSTEM', 'SERVICE', 'DATA_STORE', 'VENDOR', 'PEOPLE_PROCESS',
    'APPLICATION', 'INFRASTRUCTURE', 'PROCESS', 'OTHER',
]);
const CRITICALITIES = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

/** A suggestion's controls, or none when the stored value is not a string array. */
function parseControls(json: string | null): string[] {
    if (!json) return [];
    try {
        const parsed: unknown = JSON.parse(json);
        return Array.isArray(parsed) ? parsed.filter((c): c is string => typeof c === 'string') : [];
    } catch {
        return [];
    }
}

// ─── Types ───

interface StructuredRationale {
    whyThisRisk: string;
    affectedAssetCharacteristics: string[];
    suggestedControlThemes: string[];
}

interface SuggestionItem {
    id: string;
    title: string;
    description: string | null;
    category: string | null;
    threat: string | null;
    vulnerability: string | null;
    likelihoodSuggested: number | null;
    impactSuggested: number | null;
    rationale: string | null;
    suggestedControlsJson: string | null;
    status: string;
    assetId: string | null;
    createdRiskId: string | null;
    confidence: 'high' | 'medium' | 'low' | null;
    structuredRationaleJson: string | null;
    isFallback: boolean | null;
}

interface Session {
    id: string;
    status: string;
    provider: string;
    modelName: string | null;
    createdAt: string;
    items: SuggestionItem[];
    isFallback?: boolean;
}

interface AssetOption {
    id: string;
    name: string;
    type: string;
    criticality: string | null;
}
// Inline edit buffer for a suggestion row.
interface SuggestionEditForm {
    title?: string;
    description?: string;
    likelihoodSuggested?: number;
    impactSuggested?: number;
}

type ItemDecision = 'accept' | 'reject' | 'pending';
type Phase = 'form' | 'generating' | 'review' | 'applying' | 'done';

// ─── Main Page ───

export default function AIRiskAssessmentPage() {
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const tenant = useTenantContext();
    const { permissions } = tenant;
    // Applying suggestions creates risks, so the generate and apply routes
    // take `risks.create` and the usecases the write tier (#4327) — the same
    // two gates as the Risk button and the import.
    const canCreate = riskCanCreate(tenant);
    const tx = useTranslations('risks');
    const ta = useTranslations('assets');
    const { config: matrixConfig } = useRiskMatrixConfig();

    // Phase state
    const [phase, setPhase] = useState<Phase>('form');

    // Form state
    const [assets, setAssets] = useState<AssetOption[]>([]);
    const [assetsLoaded, setAssetsLoaded] = useState(false);
    const [selectedAssetIds, setSelectedAssetIds] = useState<string[]>([]);
    const [frameworks, setFrameworks] = useState<string[]>([]);
    const [context, setContext] = useState('');
    const [error, setError] = useState('');

    // Session state
    const [session, setSession] = useState<Session | null>(null);
    const [decisions, setDecisions] = useState<Record<string, ItemDecision>>({});
    const [editingItem, setEditingItem] = useState<string | null>(null);
    const [editForm, setEditForm] = useState<SuggestionEditForm>({});
    // #4776 — saved corrections, keyed by item; sent with the apply.
    const [edits, setEdits] = useState<Record<string, SuggestionEditForm>>({});
    const [appliedSummary, setAppliedSummary] = useState<{ created: number; linkedExisting: number }>({ created: 0, linkedExisting: 0 });
    const [assetsFailed, setAssetsFailed] = useState(false);

    // ─── Load Assets ───
    const loadAssets = async () => {
        if (assetsLoaded) return;
        setAssetsFailed(false);
        try {
            const res = await fetch(apiUrl('/assets'));
            if (!res.ok) throw new Error(String(res.status));
            const data = await res.json();
            const list = Array.isArray(data) ? data : data.data ?? [];
            setAssets(list.map((a: AssetOption) => ({ id: a.id, name: a.name, type: a.type, criticality: a.criticality })));
            setAssetsLoaded(true);
        } catch {
            // #4776 — a failed load used to leave the button saying "Load
            // assets" with nothing to say why nothing appeared.
            setAssetsFailed(true);
        }
    };

    // ─── Generate ───
    const handleGenerate = async () => {
        setError('');
        setPhase('generating');
        try {
            const res = await fetch(apiUrl('/ai/risk-suggestions/generate'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    assetIds: selectedAssetIds,
                    frameworks,
                    context: context || undefined,
                }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: { message: tx('ai.generationFailed') } }));
                throw new Error(err.error?.message ?? tx('ai.generationFailed'));
            }
            const data = await res.json();
            const sess: Session = data.session
                ? { ...data.session, items: data.items ?? [] }
                : data;
            setSession(sess);
            setEdits({});

            // Initialize decisions: all pending
            const decs: Record<string, ItemDecision> = {};
            for (const item of sess.items) {
                decs[item.id] = 'pending';
            }
            setDecisions(decs);
            setPhase('review');
        } catch (e) {
            setError(e instanceof Error ? e.message : tx('ai.generationFailed'));
            setPhase('form');
        }
    };

    // ─── Apply ───
    const handleApply = async () => {
        if (!session) return;
        const accepted = Object.entries(decisions).filter(([, d]) => d === 'accept').map(([id]) => id);
        if (accepted.length === 0) { setError(tx('ai.selectOne')); return; }

        setError('');
        setPhase('applying');
        try {
            const res = await fetch(apiUrl(`/ai/risk-suggestions/${session.id}/apply`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    acceptedItemIds: accepted,
                    // #4776 — the reviewer's corrections travel with the apply;
                    // they used to stay in the browser.
                    edits: accepted
                        .filter((id) => edits[id])
                        .map((id) => ({
                            itemId: id,
                            title: edits[id].title,
                            description: edits[id].description,
                            likelihood: edits[id].likelihoodSuggested,
                            impact: edits[id].impactSuggested,
                        })),
                }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: { message: tx('ai.applyFailed') } }));
                throw new Error(err.error?.message ?? tx('ai.applyFailed'));
            }
            const updated = await res.json();
            setSession(updated);
            setAppliedSummary({
                created: updated?.summary?.created ?? accepted.length,
                linkedExisting: updated?.summary?.linkedExisting ?? 0,
            });
            setPhase('done');
        } catch (e) {
            setError(e instanceof Error ? e.message : tx('ai.applyFailed'));
            setPhase('review');
        }
    };

    // ─── Dismiss ───
    const handleDismiss = async () => {
        if (!session) return;
        // B2-1 — this was `catch { /* ignore */ }` with no res.ok check, and
        // it reset the session and phase REGARDLESS. A failed dismiss
        // therefore threw away a generated suggestion set the user would
        // have to pay to regenerate, while telling them nothing.
        setError('');
        try {
            const res = await fetch(apiUrl(`/ai/risk-suggestions/${session.id}/dismiss`), { method: 'POST' });
            if (!res.ok) throw new Error(tx('ai.dismissFailed'));
            // Only discard the session once the server agreed.
            setSession(null);
            setPhase('form');
        } catch (e) {
            setError(e instanceof Error ? e.message : tx('ai.dismissFailed'));
        }
    };

    // ─── Toggle framework ───
    const toggleFramework = (fw: string) => {
        setFrameworks(prev => prev.includes(fw) ? prev.filter(f => f !== fw) : [...prev, fw]);
    };

    // ─── Toggle asset selection ───
    const toggleAsset = (id: string) => {
        setSelectedAssetIds(prev => prev.includes(id) ? prev.filter(a => a !== id) : [...prev, id]);
    };

    // ─── Decision helpers ───
    const setDecision = (id: string, d: ItemDecision) => {
        setDecisions(prev => ({ ...prev, [id]: d }));
    };
    const acceptAll = () => {
        const decs: Record<string, ItemDecision> = {};
        for (const id of Object.keys(decisions)) decs[id] = 'accept';
        setDecisions(decs);
    };
    const rejectAll = () => {
        const decs: Record<string, ItemDecision> = {};
        for (const id of Object.keys(decisions)) decs[id] = 'reject';
        setDecisions(decs);
    };

    // ─── Edit helpers ───
    const startEdit = (item: SuggestionItem) => {
        const shown = withEdit(item);
        setEditingItem(item.id);
        setEditForm({
            title: shown.title,
            description: shown.description ?? '',
            likelihoodSuggested: shown.likelihoodSuggested ?? 3,
            impactSuggested: shown.impactSuggested ?? 3,
        });
    };
    const cancelEdit = () => { setEditingItem(null); setEditForm({}); };
    // #4776 — "Save & accept" keeps the correction; it used to discard it.
    const saveEdit = (id: string) => {
        setEdits((prev) => ({ ...prev, [id]: editForm }));
        cancelEdit();
        setDecision(id, 'accept');
    };
    /** A suggestion as the reviewer left it: their saved correction over the model's text. */
    const withEdit = (item: SuggestionItem): SuggestionItem => {
        const e = edits[item.id];
        if (!e) return item;
        return {
            ...item,
            title: e.title ?? item.title,
            description: e.description ?? item.description,
            likelihoodSuggested: e.likelihoodSuggested ?? item.likelihoodSuggested,
            impactSuggested: e.impactSuggested ?? item.impactSuggested,
        };
    };
    const likelihoodOptions = scaleOptions(matrixConfig.likelihoodLevels);
    const impactOptions = scaleOptions(matrixConfig.impactLevels);
    const assetTypeLabel = (type: string) => (ASSET_TYPES.has(type) ? ta(`filterEnums.type.${type}`) : type);
    const criticalityLabel = (c: string) => (CRITICALITIES.has(c) ? ta(`filterEnums.criticality.${c}`) : c);

    // ─── Risk Level Badge ───
    // Config-driven (PR-J): band name + tone come from the tenant matrix,
    // so an AI-drafted score reads the same band as the register.
    const riskBadge = (l: number, i: number) => {
        const score = l * i;
        const band = resolveBandForScore(score, matrixConfig.bands);
        const tone = resolveBandTone(score, matrixConfig.bands).tone;
        return <StatusBadge variant={riskSeverityToBadgeVariant(tone)}>{band.name}</StatusBadge>;
    };

    // Roadmap-2 PR-7 — confidence indicators are tone-mapped pills
    // identical in shape to every other status across the product.
    // Previously hand-rolled with `px-2 py-0.5 rounded ring-1` —
    // now consumed via the canonical `<StatusBadge>` so a theme flip
    // re-tones the indicator and the visual vocabulary stays
    // singular.
    const confidenceBadge = (c: string | null) => {
        switch (c) {
            case 'high': return <StatusBadge variant="success">{tx('ai.confidenceHigh')}</StatusBadge>;
            case 'medium': return <StatusBadge variant="warning">{tx('ai.confidenceMedium')}</StatusBadge>;
            case 'low': return <StatusBadge variant="neutral">{tx('ai.confidenceLow')}</StatusBadge>;
            default: return null;
        }
    };

    const parseStructuredRationale = (json: string | null): StructuredRationale | null => {
        if (!json) return null;
        try { return JSON.parse(json) as StructuredRationale; } catch { return null; }
    };

    const acceptedCount = Object.values(decisions).filter(d => d === 'accept').length;
    const rejectedCount = Object.values(decisions).filter(d => d === 'reject').length;
    const pendingCount = Object.values(decisions).filter(d => d === 'pending').length;

    if (!canCreate) {
        return (
            <div className="space-y-section animate-fadeIn max-w-5xl">
                <BackAffordance />
                <Card className="text-center" id="ai-no-permission">
                    <p className="text-content-muted">{tx('ai.permissionRequired')}</p>
                    <Link href={tenantHref('/risks')} className={buttonVariants({ variant: 'secondary', className: 'mt-4' })}>
                        {tx('ai.viewRegister')}
                    </Link>
                </Card>
            </div>
        );
    }

    return (
        <div className="space-y-section animate-fadeIn max-w-5xl">
            <BackAffordance />
            {/* #4776 — one way back (the affordance above) and a breadcrumb,
                like the other Risks sub-pages; a bare "←" link sat beside
                the title as a second back control. */}
            <PageBreadcrumbs
                items={[{ label: tx('breadcrumbRoot'), href: tenantHref('/risks') }, { label: tx('aiAssist') }]}
            />
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <Heading level={1} id="ai-risk-title">{tx('ai.title')}</Heading>
                    <p className="text-content-muted text-sm">{tx('ai.subtitle')}</p>
                </div>
                <div className="flex items-center gap-tight">
                    <StatusBadge variant="info">{tx('ai.poweredBadge')}</StatusBadge>
                </div>
            </div>

            {error && (
                <InlineNotice variant="error" id="ai-error">
                    <div className="flex items-start justify-between gap-default">
                        <span>{error}</span>
                        <Button variant="ghost" size="xs" onClick={() => setError('')} id="ai-error-dismiss">
                            {tx('ai.dismissError')}
                        </Button>
                    </div>
                </InlineNotice>
            )}

            {/* ═══ PHASE: FORM ═══ */}
            {phase === 'form' && (
                <div className={cn(cardVariants(), 'space-y-section')} id="ai-generate-form">
                    <Heading level={2}>{tx('ai.configureHeading')}</Heading>

                    {/* Framework Selection */}
                    <div>
                        <label className="input-label">{tx('ai.frameworksLabel')}</label>
                        <div className="flex flex-wrap gap-tight mt-2" id="ai-framework-pills">
                            {FRAMEWORK_CHOICES.map(({ key: fw, label }) => (
                                <button
                                    key={fw}
                                    type="button"
                                    id={`fw-${fw.toLowerCase()}`}
                                    aria-pressed={frameworks.includes(fw)}
                                    onClick={() => toggleFramework(fw)}
                                    className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                                        frameworks.includes(fw)
                                            ? 'bg-bg-info-emphasis text-content-emphasis ring-2 ring-[var(--border-info)]'
                                            : 'bg-bg-elevated/50 text-content-default hover:bg-bg-muted/50'
                                    }`}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Asset Selection */}
                    <div>
                        <label className="input-label">{tx('ai.assetsLabel')}</label>
                        <Button
                            variant="secondary"
                            size="xs"
                            className="ml-2"
                            onClick={loadAssets}
                            id="load-assets-btn"
                        >
                            {assetsLoaded ? tx('ai.assetsLoaded', { count: assets.length }) : tx('ai.loadAssets')}
                        </Button>
                        {assetsFailed && (
                            <p className="mt-2 text-sm text-content-error" role="alert" id="ai-assets-failed">
                                {tx('ai.assetsLoadFailed')}
                            </p>
                        )}
                        {assetsLoaded && (
                            <div className="mt-2 max-h-48 overflow-y-auto space-y-1" id="ai-asset-list">
                                {assets.length === 0 && <p className="text-sm text-content-subtle">{tx('ai.assetsNone')}</p>}
                                {assets.map(a => (
                                    <label key={a.id} className="flex items-center gap-tight px-3 py-2 rounded-lg hover:bg-bg-muted/50 cursor-pointer text-sm">
                                        <input
                                            type="checkbox"
                                            checked={selectedAssetIds.includes(a.id)}
                                            onChange={() => toggleAsset(a.id)}
                                            className="rounded"
                                        />
                                        <span className="text-content-emphasis">{a.name}</span>
                                        <span className="text-xs text-content-muted">{assetTypeLabel(a.type)}</span>
                                        {a.criticality && <StatusBadge variant={a.criticality === 'HIGH' || a.criticality === 'CRITICAL' ? 'error' : a.criticality === 'MEDIUM' ? 'warning' : 'success'}>{criticalityLabel(a.criticality)}</StatusBadge>}
                                    </label>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Context */}
                    <div>
                        <label className="input-label" htmlFor="ai-context-input">{tx('ai.contextLabel')}</label>
                        <Textarea
                            id="ai-context-input"
                            className="w-full h-24 resize-none"
                            placeholder={tx('ai.contextPlaceholder')}
                            value={context}
                            onChange={e => setContext(e.target.value)}
                            maxLength={2000}
                        />
                        <p className="text-xs text-content-subtle mt-1">{tx('ai.charCount', { count: context.length })}</p>
                    </div>

                    {/* Generate Button */}
                    <RequirePermission resource="risks" action="create">
                        <Button
                            variant="primary"
                            className="w-full text-center py-3"
                            onClick={handleGenerate}
                            id="ai-generate-btn"
                        >
                            {tx('ai.generateBtn')}
                        </Button>
                    </RequirePermission>
                </div>
            )}

            {/* ═══ PHASE: GENERATING ═══ */}
            {phase === 'generating' && (
                <div className={cn(cardVariants({ density: 'spacious' }), 'text-center')} id="ai-generating">
                    <Heading level={2}>{tx('ai.analyzing')}</Heading>
                    <p className="text-content-muted text-sm mt-2">{tx('ai.analyzingDesc')}</p>
                    <p className="text-content-subtle text-xs mt-4">{tx('ai.analyzingHint')}</p>
                </div>
            )}

            {/* ═══ PHASE: REVIEW ═══ */}
            {phase === 'review' && session && (
                <div className="space-y-default" id="ai-review-section">
                    {/* Summary bar */}
                    <div className={cn(cardVariants({ density: 'compact' }), 'flex items-center justify-between')}>
                        <div className="flex items-center gap-default">
                            {/* #4776 — the provider's stored id ("stub", a model
                                vendor's key) meant nothing here; whether the set
                                came from the AI or the baseline is what matters,
                                and the notice beside this says so. */}
                            <span className="text-sm text-content-muted">
                                {tx('ai.suggestionCount', { count: session.items.length })}
                            </span>
                            {session.isFallback ? (
                                <span className="text-xs px-2 py-1 rounded bg-bg-warning text-content-warning ring-1 ring-[var(--border-warning)]" id="fallback-notice">
                                    {tx('ai.fallbackNotice')}
                                </span>
                            ) : (
                                <span className="text-xs text-content-subtle">
                                    {tx('ai.aiGeneratedNote')}
                                </span>
                            )}
                        </div>
                        <div className="flex gap-tight">
                            <Button variant="secondary" size="xs" onClick={acceptAll} id="accept-all-btn">{tx('ai.acceptAll')}</Button>
                            <Button variant="secondary" size="xs" onClick={rejectAll} id="reject-all-btn">{tx('ai.rejectAll')}</Button>
                        </div>
                    </div>

                    {/* Decision summary */}
                    <div className="flex gap-compact text-sm">
                        <span className="text-content-success" id="accepted-count">{tx('ai.accepted', { count: acceptedCount })}</span>
                        <span className="text-content-error" id="rejected-count">{tx('ai.rejected', { count: rejectedCount })}</span>
                        <span className="text-content-muted" id="pending-count">{tx('ai.pending', { count: pendingCount })}</span>
                    </div>

                    {/* Suggestion cards */}
                    {session.items.map((original, idx) => {
                        // #4776 — shown as the reviewer left it.
                        const item = withEdit(original);
                        const edited = Boolean(edits[original.id]);
                        const dec = decisions[item.id] ?? 'pending';
                        const isEditing = editingItem === item.id;
                        // #4776 — a malformed stored value used to throw here
                        // and take the whole page down.
                        const controls = parseControls(item.suggestedControlsJson);
                        const sr = parseStructuredRationale(item.structuredRationaleJson);

                        return (
                            <div
                                key={item.id}
                                id={`suggestion-${idx}`}
                                className={cn(cardVariants(), 'transition-all', dec === 'accept' ? 'ring-1 ring-[var(--border-success)] bg-bg-success' :
                                    dec === 'reject' ? 'ring-1 ring-[var(--border-error)] opacity-60' : '')}
                            >
                                <div className="flex items-start justify-between gap-default">
                                    <div className="flex-1 space-y-compact">
                                        {/* Header */}
                                        <div className="flex items-center gap-tight flex-wrap">
                                            <span className="text-xs text-content-subtle font-mono">#{idx + 1}</span>
                                            {isEditing ? (
                                                <Input
                                                    className="flex-1 text-sm font-semibold"
                                                    value={editForm.title}
                                                    onChange={e => setEditForm(p => ({ ...p, title: e.target.value }))}
                                                    id={`edit-title-${idx}`}
                                                    aria-label={tx('ai.editTitleLabel')}
                                                />
                                            ) : (
                                                <Heading level={3}>{item.title}</Heading>
                                            )}
                                            {item.category && <StatusBadge variant="info">{item.category}</StatusBadge>}
                                            {confidenceBadge(item.confidence)}
                                            <StatusBadge variant="neutral">{item.isFallback ? tx('ai.baseline') : tx('ai.aiSuggested')}</StatusBadge>
                                            {edited && !isEditing && (
                                                <span className="text-xs text-content-muted" data-testid={`suggestion-edited-${idx}`}>{tx('ai.edited')}</span>
                                            )}
                                        </div>

                                        {/* Description */}
                                        {isEditing ? (
                                            <Textarea
                                                className="w-full h-20 resize-none text-sm"
                                                value={editForm.description}
                                                onChange={e => setEditForm(p => ({ ...p, description: e.target.value }))}
                                                id={`edit-desc-${idx}`}
                                                aria-label={tx('ai.editDescriptionLabel')}
                                            />
                                        ) : (
                                            <p className="text-sm text-content-default">{item.description}</p>
                                        )}

                                        {/* Threat / Vulnerability */}
                                        {(item.threat || item.vulnerability) && !isEditing && (
                                            <div className="grid grid-cols-2 gap-default text-xs">
                                                {item.threat && <div><span className="text-content-subtle uppercase font-semibold">{tx('threat')}</span><p className="text-content-muted mt-0.5">{item.threat}</p></div>}
                                                {item.vulnerability && <div><span className="text-content-subtle uppercase font-semibold">{tx('vulnerability')}</span><p className="text-content-muted mt-0.5">{item.vulnerability}</p></div>}
                                            </div>
                                        )}

                                        {/* Ratings */}
                                        <div className="flex items-center gap-default text-sm">
                                            {isEditing ? (
                                                <div className="flex items-center gap-default">
                                                    <label className="text-xs text-content-muted">
                                                        {tx('ai.likelihoodShort')}: <Combobox
                                                            hideSearch
                                                            id={`edit-likelihood-${idx}`}
                                                            selected={likelihoodOptions.find(o => o.value === String(editForm.likelihoodSuggested)) ?? null}
                                                            setSelected={(opt) => setEditForm(p => ({ ...p, likelihoodSuggested: +(opt?.value ?? p.likelihoodSuggested ?? 0) }))}
                                                            options={likelihoodOptions}
                                                            matchTriggerWidth
                                                            buttonProps={{ className: 'text-xs w-16 inline-block ml-1' }}
                                                        />
                                                    </label>
                                                    <label className="text-xs text-content-muted">
                                                        {tx('ai.impactShort')}: <Combobox
                                                            hideSearch
                                                            id={`edit-impact-${idx}`}
                                                            selected={impactOptions.find(o => o.value === String(editForm.impactSuggested)) ?? null}
                                                            setSelected={(opt) => setEditForm(p => ({ ...p, impactSuggested: +(opt?.value ?? p.impactSuggested ?? 0) }))}
                                                            options={impactOptions}
                                                            matchTriggerWidth
                                                            buttonProps={{ className: 'text-xs w-16 inline-block ml-1' }}
                                                        />
                                                    </label>
                                                </div>
                                            ) : (
                                                <>
                                                    <span className="text-content-muted">{tx('ai.likelihoodShort')}: <strong className="text-content-emphasis">{item.likelihoodSuggested ?? '—'}</strong></span>
                                                    <span className="text-content-muted">{tx('ai.impactShort')}: <strong className="text-content-emphasis">{item.impactSuggested ?? '—'}</strong></span>
                                                    {item.likelihoodSuggested && item.impactSuggested && riskBadge(item.likelihoodSuggested, item.impactSuggested)}
                                                </>
                                            )}
                                        </div>

                                        {/* Rationale & Explainability */}
                                        {!isEditing && (item.rationale || sr) && (
                                            <div className="bg-bg-default/50 rounded-lg p-3 text-xs text-content-muted space-y-tight">
                                                {item.rationale && (
                                                    <div>
                                                        <span className="text-content-subtle uppercase font-semibold block mb-1">{tx('ai.rationale')}</span>
                                                        {item.rationale}
                                                    </div>
                                                )}
                                                {sr && sr.whyThisRisk && (
                                                    <div>
                                                        <span className="text-content-subtle uppercase font-semibold block mb-1">{tx('ai.whyThisRisk')}</span>
                                                        <p className="text-content-default">{sr.whyThisRisk}</p>
                                                    </div>
                                                )}
                                                {sr && sr.affectedAssetCharacteristics.length > 0 && (
                                                    <div>
                                                        <span className="text-content-subtle uppercase font-semibold block mb-1">{tx('ai.affectedChars')}</span>
                                                        <div className="flex flex-wrap gap-1">
                                                            {sr.affectedAssetCharacteristics.map((c, ci) => (
                                                                <span key={ci} className="px-2 py-0.5 rounded bg-bg-elevated/60 text-content-default">{c}</span>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}
                                                {sr && sr.suggestedControlThemes.length > 0 && (
                                                    <div>
                                                        <span className="text-content-subtle uppercase font-semibold block mb-1">{tx('ai.controlThemes')}</span>
                                                        <div className="flex flex-wrap gap-1">
                                                            {sr.suggestedControlThemes.map((t, ti) => (
                                                                <span key={ti} className="px-2 py-0.5 rounded bg-bg-info text-content-info">{t}</span>
                                                            ))}
                                                        </div>
                                                    </div>
                                                )}
                                            </div>
                                        )}

                                        {/* Suggested Controls */}
                                        {controls.length > 0 && !isEditing && (
                                            <div className="flex flex-wrap gap-1.5">
                                                <span className="text-xs text-content-subtle mr-1">{tx('ai.suggestedControls')}</span>
                                                {controls.map((c, ci) => (
                                                    <span key={ci} className="text-xs bg-bg-info text-content-info px-2 py-0.5 rounded">{c}</span>
                                                ))}
                                            </div>
                                        )}
                                    </div>

                                    {/* Decision buttons */}
                                    <div className="flex flex-col gap-tight shrink-0">
                                        {isEditing ? (
                                            <>
                                                <Button
                                                    variant="primary"
                                                    size="xs"
                                                    onClick={() => saveEdit(item.id)}
                                                    id={`save-edit-${idx}`}
                                                >
                                                    {tx('ai.saveAccept')}
                                                </Button>
                                                <Button variant="secondary" size="xs" onClick={cancelEdit}>{tx('edit.cancel')}</Button>
                                            </>
                                        ) : (
                                            <>
                                                {/* A row's decision toggle is secondary in both states
                                                    (the R7-PR1 row-action rule); the success fill and
                                                    the label carry the accepted state. */}
                                                <Button
                                                    variant="secondary"
                                                    size="xs"
                                                    className={dec === 'accept' ? 'bg-bg-success-emphasis text-content-emphasis' : ''}
                                                    onClick={() => setDecision(item.id, 'accept')}
                                                    id={`accept-${idx}`}
                                                >
                                                    {tx('ai.accept')}
                                                </Button>
                                                <Button
                                                    variant={dec === 'reject' ? 'destructive' : 'secondary'}
                                                    size="xs"
                                                    className={dec === 'reject' ? 'bg-bg-error-emphasis text-content-emphasis' : ''}
                                                    onClick={() => setDecision(item.id, 'reject')}
                                                    id={`reject-${idx}`}
                                                >
                                                    {tx('ai.reject')}
                                                </Button>
                                                {permissions.canWrite && (
                                                    <Button
                                                        variant="secondary"
                                                        size="xs"
                                                        onClick={() => startEdit(original)}
                                                        id={`edit-${idx}`}
                                                    >
                                                        {tx('ai.edit')}
                                                    </Button>
                                                )}
                                            </>
                                        )}
                                    </div>
                                </div>
                            </div>
                        );
                    })}

                    {/* Action bar */}
                    <div className={cn(cardVariants({ density: 'compact' }), 'flex items-center justify-between')} id="ai-action-bar">
                        {/* `dismissSession` asserts ctx.permissions.canWrite,
                            and the dismiss route takes no granular key — but
                            this button was the one left ungated. Gate on the
                            coarse flag the usecase actually reads. (The page
                            as a whole needs `canCreate`, so the sibling
                            RequirePermission gates always pass here.) */}
                        {permissions.canWrite && (
                            <Button variant="secondary" onClick={handleDismiss} id="dismiss-btn">{tx('ai.dismissAll')}</Button>
                        )}
                        <RequirePermission resource="risks" action="create">
                            <Button
                                variant="primary"
                                onClick={handleApply}
                                disabled={acceptedCount === 0}
                                id="apply-btn"
                            >
                                {tx('ai.applyBtn', { count: acceptedCount })}
                            </Button>
                        </RequirePermission>
                    </div>
                </div>
            )}

            {/* ═══ PHASE: APPLYING ═══ */}
            {phase === 'applying' && (
                <div className={cn(cardVariants({ density: 'spacious' }), 'text-center')}>
                    <Heading level={2}>{tx('ai.creatingRecords')}</Heading>
                    <p className="text-content-muted text-sm mt-2">{tx('ai.creatingDesc')}</p>
                </div>
            )}

            {/* ═══ PHASE: DONE ═══ */}
            {phase === 'done' && (
                <Card className="text-center space-y-default" id="ai-done">
                    <Heading level={2}>
                        {tx('ai.doneHeading', { count: appliedSummary.created })}
                    </Heading>
                    {/* #4776 — an accepted suggestion whose title matches a
                        risk the register already has is linked to it, not
                        added again; the heading used to count it as added. */}
                    {appliedSummary.linkedExisting > 0 && (
                        <p className="text-sm text-content-muted" id="ai-done-linked">
                            {tx('ai.doneLinkedExisting', { count: appliedSummary.linkedExisting })}
                        </p>
                    )}
                    <p className="text-sm text-content-muted">
                        {tx('ai.doneDesc')}
                    </p>
                    <div className="flex gap-compact justify-center pt-2">
                        <Link href={tenantHref('/risks')} className={buttonVariants({ variant: 'primary' })} id="view-risks-btn">
                            {tx('ai.viewRegister')}
                        </Link>
                        <Button variant="secondary" onClick={() => { setPhase('form'); setSession(null); }} id="new-assessment-btn">
                            {tx('ai.newAssessment')}
                        </Button>
                    </div>
                </Card>
            )}
        </div>
    );
}
