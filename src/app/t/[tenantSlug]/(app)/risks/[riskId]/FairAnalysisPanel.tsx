'use client';

/**
 * RQ-1 / RQ3-2 — FAIR Analysis panel on the risk detail page.
 *
 * Range-first estimation (RQ3-2): every loss/frequency factor is a
 * calibrated min/likely/max interval — "give the range you're 90%
 * sure contains the true value" — replacing the false-precision
 * point-float ritual. The derived point estimate (Beta-PERT mean) is
 * SHOWN per factor, never asked. Legacy point values load as
 * degenerate triples (min = likely = max), so the round-trip is
 * backward compatible; saving writes the five PERT triples to
 * `fairInputsJson` (the simulator's preferred input) and the server
 * derives the point columns + LEF/ALE from the PERT means.
 *
 * Calibration aids (RQ2-7, extended to ranges): live reflections
 * mirror the likely value and call out wide spreads; warnings
 * (`validateFairTriples` + `validatePertTriple`) stay warn-only —
 * they NEVER disable the save button.
 *
 * SCOPE — BIA fields stay out of this panel (decision, 2026-07-18).
 * The Risk model does carry BIA-style attributes (`rtoHours`,
 * `rpoHours`, `revenueAtRisk`, consumed by the report assembler), but
 * Business Impact Analysis is a distinct discipline with its own
 * canonical workflow under `audits/business-continuity` (the BIA
 * usecase, recovery-priority service, and BIA UI). FAIR quantifies
 * expected loss distribution; BIA quantifies recovery objectives.
 * Surfacing RTO/RPO here would duplicate that module and blur the two
 * analyses — so we defer to the dedicated BIA module and do not add
 * BIA inputs to this panel.
 */
import { useState, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { useTenantApiUrl, useMoneyFormatter, useTenantContext } from '@/lib/tenant-context-provider';
import {
    computeTEF,
    computeVulnerability,
    computeLEF,
    computePLM,
    computeFairALE,
    pertMean,
} from '@/lib/fair-math';
import {
    reflectTriple,
    validateFairTriples,
    getCategoryPrior,
    FAIR_FACTOR_KEYS,
    FAIR_FACTOR_LABELS,
    type FairFactorKey,
    type TripleDraft,
} from '@/lib/fair-calibration';

type Conf = 'LOW' | 'MEDIUM' | 'HIGH';

export interface FairInitial {
    threatEventFrequency: number | null;
    contactFrequency: number | null;
    probabilityOfAction: number | null;
    vulnerabilityProbability: number | null;
    threatCapability: number | null;
    controlStrength: number | null;
    primaryLossMagnitude: number | null;
    productivityLoss: number | null;
    responseCost: number | null;
    replacementCost: number | null;
    secondaryLossEventFrequency: number | null;
    secondaryLossMagnitude: number | null;
    // PR-L — secondary-loss monetary decomposition, now editable in-panel.
    regulatoryFineEstimate: number | null;
    reputationDamageEstimate: number | null;
    competitiveAdvantageLoss: number | null;
    fairConfidence: Conf | null;
    /** RQ3-2 — stored PERT triples; preferred over the point columns. */
    fairInputsJson?: Record<string, unknown> | null;
}

type Bound = 'min' | 'mode' | 'max';
type Triples = Record<FairFactorKey, TripleDraft>;

const EMPTY: TripleDraft = { min: null, mode: null, max: null };
const N = (v: string): number | null => (v.trim() === '' ? null : Number(v));
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const complete = (t: TripleDraft): t is { min: number; mode: number; max: number } =>
    t.min != null && t.mode != null && t.max != null;

/** Parse one stored triple from fairInputsJson, if well-formed. */
function parseStoredTriple(json: Record<string, unknown> | null | undefined, key: FairFactorKey): TripleDraft | null {
    const raw = json?.[key];
    if (!raw || typeof raw !== 'object') return null;
    const t = raw as Record<string, unknown>;
    if (typeof t.min !== 'number' || typeof t.mode !== 'number' || typeof t.max !== 'number') return null;
    return { min: t.min, mode: t.mode, max: t.max };
}

/**
 * RQ3-2 — backward-compatible seeding: stored triples win; otherwise
 * legacy point values (including the sub-factor derivations the
 * point-era panel offered: CF×P(action) → TEF, capability vs control
 * → vulnerability, cost components → PLM) migrate as DEGENERATE
 * triples (min = likely = max) the user then widens.
 */
export function seedTriples(initial: FairInitial): Triples {
    const json = initial.fairInputsJson ?? null;
    const degenerate = (v: number | null): TripleDraft =>
        v == null ? { ...EMPTY } : { min: v, mode: v, max: v };

    const tefPoint =
        initial.threatEventFrequency ??
        (initial.contactFrequency != null && initial.probabilityOfAction != null
            ? computeTEF(initial.contactFrequency, initial.probabilityOfAction)
            : null);
    const vulnPoint =
        initial.vulnerabilityProbability ??
        (initial.threatCapability != null && initial.controlStrength != null
            ? computeVulnerability(initial.threatCapability, initial.controlStrength)
            : null);
    const hasPlm =
        initial.primaryLossMagnitude != null ||
        initial.productivityLoss != null ||
        initial.responseCost != null ||
        initial.replacementCost != null;
    const plmPoint = hasPlm
        ? computePLM({
              productivityLoss: initial.productivityLoss,
              responseCost: initial.responseCost,
              replacementCost: initial.replacementCost,
              flatEstimate: initial.primaryLossMagnitude,
          })
        : null;

    return {
        tef: parseStoredTriple(json, 'tef') ?? degenerate(tefPoint),
        vulnerability: parseStoredTriple(json, 'vulnerability') ?? degenerate(vulnPoint),
        plm: parseStoredTriple(json, 'plm') ?? degenerate(plmPoint),
        slef: parseStoredTriple(json, 'slef') ?? degenerate(initial.secondaryLossEventFrequency),
        slm: parseStoredTriple(json, 'slm') ?? degenerate(initial.secondaryLossMagnitude),
    };
}

export function FairAnalysisPanel({
    riskId,
    initial,
    category = null,
}: {
    riskId: string;
    initial: FairInitial;
    /** RQ2-7 — drives the per-category calibration prior hints. */
    category?: string | null;
}) {
    const t = useTranslations('risks');
    const apiUrl = useTenantApiUrl();
    const money = useMoneyFormatter();
    /**
     * `updateRiskFair` asserts canWrite. The panel mounts on the
     * quantification tab for every reader, so Save was a guaranteed 403.
     *
     * The inputs stay interactive deliberately: exploring what a different
     * TEF or loss magnitude would do to the distribution is a legitimate
     * read-only activity, and disabling twenty controls to prevent it would
     * cost more than it protects. What changes is that we no longer offer a
     * Save that cannot work — the notice says the exploration is local.
     */
    const { permissions } = useTenantContext();
    const canWrite = permissions.canWrite;
    const [triples, setTriples] = useState<Triples>(() => seedTriples(initial));
    const [conf, setConf] = useState<Conf | null>(initial.fairConfidence);
    // PR-L — secondary-loss monetary estimates (regulatory fine, reputation,
    // competitive-advantage). Kept as strings for the inputs; '' → null on save.
    const [secondary, setSecondary] = useState({
        regulatoryFineEstimate: initial.regulatoryFineEstimate?.toString() ?? '',
        reputationDamageEstimate: initial.reputationDamageEstimate?.toString() ?? '',
        competitiveAdvantageLoss: initial.competitiveAdvantageLoss?.toString() ?? '',
    });
    const [saving, setSaving] = useState(false);
    const [msg, setMsg] = useState<string | null>(null);
    const [msgOk, setMsgOk] = useState(false);

    const set = (k: FairFactorKey, b: Bound) => (e: React.ChangeEvent<HTMLInputElement>) =>
        setTriples((cur) => ({ ...cur, [k]: { ...cur[k], [b]: N(e.target.value) } }));

    // Live derived values — PERT means feed the same pure formulas the
    // server recomputes on save. "Shown, not asked."
    const derived = useMemo(() => {
        const mean = (t: TripleDraft) => (complete(t) ? pertMean(t) : null);
        const tef = mean(triples.tef);
        const vuln = mean(triples.vulnerability);
        const plm = mean(triples.plm);
        const slef = mean(triples.slef);
        const slm = mean(triples.slm);
        const lef = tef != null && vuln != null ? computeLEF(tef, clamp01(vuln)) : null;
        const ale =
            tef != null && vuln != null && plm != null
                ? computeFairALE({ tef, vulnerability: clamp01(vuln), plm, slef: clamp01(slef ?? 0), slm: slm ?? 0 })
                : null;
        return { means: { tef, vulnerability: vuln, plm, slef, slm }, lef, ale };
    }, [triples]);

    const save = useCallback(async () => {
        setSaving(true);
        setMsg(null);
        try {
            const distributions = Object.fromEntries(
                FAIR_FACTOR_KEYS.map((k) => [k, complete(triples[k]) ? triples[k] : null]),
            );
            const res = await fetch(apiUrl(`/risks/${riskId}/fair`), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    distributions,
                    fairConfidence: conf,
                    regulatoryFineEstimate: N(secondary.regulatoryFineEstimate),
                    reputationDamageEstimate: N(secondary.reputationDamageEstimate),
                    competitiveAdvantageLoss: N(secondary.competitiveAdvantageLoss),
                }),
            });
            setMsg(res.ok ? t('fair.saved') : t('fair.saveFailed'));
            setMsgOk(res.ok);
        } catch {
            setMsg(t('fair.saveFailedNetwork'));
            setMsgOk(false);
        } finally {
            setSaving(false);
        }
    }, [apiUrl, riskId, triples, conf, secondary, t]);

    // RQ2-7 → RQ3-2 — warn-only range checks + category anchors.
    const warnings = useMemo(() => validateFairTriples(triples), [triples]);
    const prior = getCategoryPrior(category);

    const FACTOR_META: Record<FairFactorKey, { unit: string; isMoney: boolean; ghost?: string | null }> = {
        tef: { unit: '/yr', isMoney: false, ghost: prior?.tefHint },
        vulnerability: { unit: '0–1', isMoney: false },
        plm: { unit: 'per event', isMoney: true, ghost: prior?.lossHint },
        slef: { unit: '0–1', isMoney: false },
        slm: { unit: 'per event', isMoney: true },
    };

    const bound = (k: FairFactorKey, b: Bound, label: string) => (
        <label className="block flex-1 min-w-0">
            <span className="text-[10px] uppercase tracking-wide text-content-subtle">{label}</span>
            <Input
                type="text"
                inputMode="decimal"
                value={triples[k][b] ?? ''}
                onChange={set(k, b)}
                data-testid={`fair-triple-${k}-${b}`}
            />
        </label>
    );

    const factorGroup = (k: FairFactorKey) => {
        const meta = FACTOR_META[k];
        const reflection = reflectTriple(k, triples[k]);
        const mean = derived.means[k];
        return (
            <div key={k} className="space-y-tight rounded-md border border-border-subtle p-3">
                <div className="flex items-baseline justify-between gap-default">
                    <p className="text-xs font-medium text-content-emphasis">
                        {FAIR_FACTOR_LABELS[k]} <span className="font-normal text-content-subtle">({meta.unit})</span>
                    </p>
                    {/* RQ3-2 — the point estimate is derived (PERT
                        mean), shown, never asked. */}
                    {mean != null && (
                        <span className="text-[10px] tabular-nums text-content-subtle" data-testid={`fair-derived-${k}`}>
                            {t('fair.derivedApprox')} {meta.isMoney ? money(mean) : Math.round(mean * 1000) / 1000}
                        </span>
                    )}
                </div>
                {meta.ghost && (
                    <p className="text-[10px] italic text-content-subtle" data-testid="fair-prior-hint">
                        {meta.ghost}
                    </p>
                )}
                <div className="flex gap-tight">
                    {bound(k, 'min', t('fair.min'))}
                    {bound(k, 'mode', t('fair.likely'))}
                    {bound(k, 'max', t('fair.max'))}
                </div>
                {reflection && (
                    <span className="block text-[10px] text-content-subtle" data-testid={`fair-reflection-${k}`}>
                        {reflection}
                    </span>
                )}
            </div>
        );
    };

    return (
        <Card className="space-y-default p-6">
            <Heading level={3}>{t('fair.title')}</Heading>
            <p className="text-sm text-content-muted">
                {t('fair.intro')}
            </p>

            <div className="grid grid-cols-1 gap-default md:grid-cols-2">
                {FAIR_FACTOR_KEYS.map((k) => factorGroup(k))}
            </div>

            <div className="flex flex-wrap items-center gap-default">
                <span className="text-xs text-content-muted">{t('fair.confidence')}</span>
                {(['LOW', 'MEDIUM', 'HIGH'] as Conf[]).map((c) => (
                    <Button key={c} size="sm" variant={conf === c ? 'secondary' : 'ghost'} onClick={() => setConf(c)}>
                        {t(c.toLowerCase())}
                    </Button>
                ))}
            </div>

            <div className="flex flex-wrap items-center gap-default rounded-md border border-border-default bg-bg-subtle p-3 text-sm">
                <span>{t('fair.lef')} <span className="font-semibold tabular-nums">{derived.lef != null ? `${derived.lef.toFixed(2)}${t('perYear')}` : '—'}</span></span>
                <span className="ml-auto">{t('fair.fairAle')} <span className="font-semibold tabular-nums text-content-emphasis">{derived.ale != null ? `${money(derived.ale)}${t('perYear')}` : '—'}</span></span>
            </div>

            {/* PR-L — secondary-loss monetary decomposition. Previously stored
                but never editable in-panel; these feed the FAIR secondary-loss
                magnitude and the auditor deliverable. */}
            <details className="rounded-md border border-border-subtle bg-bg-subtle" data-testid="fair-secondary-loss">
                <summary className="cursor-pointer px-3 py-2 text-sm text-content-default">{t('fair.secondaryLossTitle')}</summary>
                <div className="grid grid-cols-1 gap-default px-3 pb-3 sm:grid-cols-3">
                    {([
                        ['regulatoryFineEstimate', 'fair.regulatoryFine'],
                        ['reputationDamageEstimate', 'fair.reputationDamage'],
                        ['competitiveAdvantageLoss', 'fair.competitiveLoss'],
                    ] as const).map(([field, labelKey]) => (
                        <label key={field} className="block">
                            <span className="text-xs text-content-muted">{t(labelKey)}</span>
                            <Input
                                id={`fair-${field}`}
                                type="text"
                                inputMode="decimal"
                                value={secondary[field]}
                                onChange={(e) => setSecondary((cur) => ({ ...cur, [field]: e.target.value }))}
                                placeholder={t('fair.secondaryLossPlaceholder')}
                            />
                        </label>
                    ))}
                </div>
            </details>

            {/* RQ2-7 — reasonableness warnings. Advisory by contract:
                they never disable the save button. */}
            {warnings.length > 0 && (
                <InlineNotice variant="warning" data-testid="fair-calibration-warnings">
                    <ul className="list-disc pl-4">
                        {warnings.map((w) => (
                            <li key={`${w.field}-${w.message}`}>{w.message}</li>
                        ))}
                    </ul>
                </InlineNotice>
            )}

            {msg && <InlineNotice variant={msgOk ? 'success' : 'error'}>{msg}</InlineNotice>}
            <div className="flex items-center justify-end gap-default">
                {canWrite ? (
                    <Button variant="primary" onClick={save} disabled={saving}>{saving ? t('saving') : t('fair.save')}</Button>
                ) : (
                    <span className="text-xs text-content-muted">{t('fair.readOnlyNotice')}</span>
                )}
            </div>
        </Card>
    );
}
