/**
 * RQ2-7 / RQ3-2 — FairAnalysisPanel calibration aids, range-first.
 *
 * Locks: live reflections beside the calibrated ranges (including
 * the wide-spread call-out), warn-only sanity notices (save stays
 * enabled), the per-category prior ghost text, the derived-PERT-mean
 * chip ("shown, not asked"), and the degenerate-triple migration of
 * legacy point values.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import * as React from 'react';

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => `/api/t/acme${p}`,
    // RQ3-OB-A — delegate to the real canonical formatter so the
    // assertions track the one compact-currency voice.
    useMoneyFormatter: () => (v: number | null | undefined) =>
        jest.requireActual('@/lib/risk-coherence').formatCompactCurrency(v),
    // The panel gates its Save on `permissions.canWrite` (updateRiskFair
    // asserts canWrite). These tests are about calibration aids, and several
    // assert the save button stays ENABLED through a warning — so they need a
    // writer. The gate itself is covered in risk-write-permission-gates.
    useTenantContext: () => ({
        tenantSlug: 'acme',
        permissions: { canRead: true, canWrite: true, canAdmin: false, canAudit: false, canExport: true },
    }),
}));

// next-intl is ESM (jest can't parse its export); mock it to resolve real
// en.json values so text assertions track the original English.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    return {
        useTranslations: (ns: string) => (key: string, params?: Record<string, unknown>) => {
            let v = key
                .split('.')
                .reduce((o: unknown, k) =>
                    o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined, en[ns]);
            if (typeof v !== 'string') return key;
            if (params) for (const [p, val] of Object.entries(params)) v = (v as string).replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
            return v;
        },
        useLocale: () => 'en',
    };
});

import { FairAnalysisPanel, seedTriples, type FairInitial } from '@/app/t/[tenantSlug]/(app)/risks/[riskId]/FairAnalysisPanel';

const BLANK: FairInitial = {
    threatEventFrequency: null,
    contactFrequency: null,
    probabilityOfAction: null,
    vulnerabilityProbability: null,
    threatCapability: null,
    controlStrength: null,
    primaryLossMagnitude: null,
    productivityLoss: null,
    responseCost: null,
    replacementCost: null,
    secondaryLossEventFrequency: null,
    secondaryLossMagnitude: null,
    regulatoryFineEstimate: null,
    reputationDamageEstimate: null,
    competitiveAdvantageLoss: null,
    fairConfidence: null,
    fairInputsJson: null,
};

const setBound = (factor: string, bound: string, value: string) =>
    fireEvent.change(screen.getByTestId(`fair-triple-${factor}-${bound}`), {
        target: { value },
    });

describe('FairAnalysisPanel — range-first calibration aids', () => {
    it('blank inputs render no reflections, no warnings, no prior, no derived chip (zero-cost default)', () => {
        render(<FairAnalysisPanel riskId="r-1" initial={BLANK} />);
        expect(screen.queryAllByTestId(/fair-reflection-/)).toHaveLength(0);
        expect(screen.queryByTestId('fair-calibration-warnings')).toBeNull();
        expect(screen.queryByTestId('fair-prior-hint')).toBeNull();
        expect(screen.queryAllByTestId(/fair-derived-/)).toHaveLength(0);
    });

    it('a populated likely value renders its plain-language reflection live', () => {
        render(<FairAnalysisPanel riskId="r-1" initial={BLANK} />);
        setBound('tef', 'mode', '0.1');
        expect(screen.getByTestId('fair-reflection-tef').textContent).toMatch(
            /every 10 years/,
        );
    });

    it('a complete wide range appends the spread call-out', () => {
        render(<FairAnalysisPanel riskId="r-1" initial={BLANK} />);
        setBound('plm', 'min', '10000');
        setBound('plm', 'mode', '80000');
        setBound('plm', 'max', '400000');
        expect(screen.getByTestId('fair-reflection-plm').textContent).toMatch(
            /~40× spread; anchor it with a reference event/,
        );
    });

    it('an out-of-range probability warns but the save button stays enabled', () => {
        render(<FairAnalysisPanel riskId="r-1" initial={BLANK} />);
        setBound('vulnerability', 'mode', '1.4');
        expect(screen.getByTestId('fair-calibration-warnings').textContent).toMatch(
            /probability/i,
        );
        expect(screen.getByRole('button', { name: /Save FAIR ranges/ })).toBeEnabled();
    });

    it('an inverted range warns (validatePertTriple live) without blocking', () => {
        render(<FairAnalysisPanel riskId="r-1" initial={BLANK} />);
        setBound('tef', 'min', '5');
        setBound('tef', 'mode', '2');
        setBound('tef', 'max', '1');
        expect(screen.getByTestId('fair-calibration-warnings').textContent).toMatch(
            /inverted/,
        );
        expect(screen.getByRole('button', { name: /Save FAIR ranges/ })).toBeEnabled();
    });

    it('a complete range shows the derived PERT mean — shown, not asked', () => {
        render(<FairAnalysisPanel riskId="r-1" initial={BLANK} />);
        setBound('tef', 'min', '0.1');
        setBound('tef', 'mode', '0.2');
        setBound('tef', 'max', '0.6');
        // (0.1 + 4·0.2 + 0.6) / 6 = 0.25
        expect(screen.getByTestId('fair-derived-tef').textContent).toMatch(/0\.25/);
    });

    it('a known category renders both prior anchors as ghost text', () => {
        render(<FairAnalysisPanel riskId="r-1" initial={BLANK} category="Technical" />);
        const hints = screen.getAllByTestId('fair-prior-hint');
        expect(hints).toHaveLength(2);
        expect(hints[0].textContent).toMatch(/TEF 0\.05–0\.5\/yr/);
        expect(hints[1].textContent).toMatch(/€50K–€500K/);
    });

    it('an unknown category renders no prior (anchors, not noise)', () => {
        render(<FairAnalysisPanel riskId="r-1" initial={BLANK} category="Esoteric" />);
        expect(screen.queryByTestId('fair-prior-hint')).toBeNull();
    });
});

describe('seedTriples — backward-compatible migration', () => {
    it('legacy point values become degenerate triples (min = likely = max)', () => {
        const t = seedTriples({ ...BLANK, threatEventFrequency: 0.3, secondaryLossMagnitude: 50_000 });
        expect(t.tef).toEqual({ min: 0.3, mode: 0.3, max: 0.3 });
        expect(t.slm).toEqual({ min: 50_000, mode: 50_000, max: 50_000 });
        expect(t.plm).toEqual({ min: null, mode: null, max: null });
    });

    it('sub-factor decompositions fold into the seeds', () => {
        const t = seedTriples({
            ...BLANK,
            contactFrequency: 2,
            probabilityOfAction: 0.25,
            threatCapability: 5,
            controlStrength: 5,
            productivityLoss: 10_000,
            responseCost: 20_000,
        });
        expect(t.tef.mode).toBeCloseTo(0.5); // 2 × 0.25
        expect(t.vulnerability.mode).toBeCloseTo(0.5); // parity
        expect(t.plm.mode).toBe(30_000); // component sum
    });

    it('stored triples win over the point columns (round-trip)', () => {
        const t = seedTriples({
            ...BLANK,
            threatEventFrequency: 9,
            fairInputsJson: { tef: { min: 0.1, mode: 0.2, max: 0.5 } },
        });
        expect(t.tef).toEqual({ min: 0.1, mode: 0.2, max: 0.5 });
    });
});
