/**
 * THE ASSURANCE PANEL (#2451) — is any of this being CHECKED?
 *
 * The governance banner says whether the boundary is switched on. This says
 * whether anybody verifies that it works, which is the question an assessor asks
 * and the one the register could not previously answer at all. All three signals
 * existed, were computed, and had no surface.
 *
 * ── THE LOAD-BEARING CLAIM ──────────────────────────────────────────
 *
 * A check that has NEVER RUN must render as "never run", never as absent and
 * never as a pass. "No result" and "passed" are the two things an assurance
 * surface must not conflate — and omission reads as the latter, which is the
 * failure mode that makes a governance page worse than no page.
 */
import { render, screen } from '@testing-library/react';

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en[ns],
        );
    const make = (ns: string) => (key: string, params?: Record<string, unknown>) => {
        let v = resolve(ns, key);
        if (typeof v !== 'string') return key;
        if (params) {
            for (const [p, val] of Object.entries(params)) {
                v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
            }
        }
        return v;
    };
    return { useTranslations: (ns: string) => make(ns) };
});

import { AssurancePanel } from '@/app/t/[tenantSlug]/(app)/agents/AgentsClient';

const base = {
    riskCoverage: { scored: 3, total: 5 },
    sampleAudit: { answered: 10, dissented: 2, disagreementRate: 0.2 },
    controlTests: [
        { checkId: 'AGENTIC_REVIEW_QUALITY', title: 'Review quality', result: 'PASS', lastRunAt: '2026-09-10T00:00:00Z' },
        { checkId: 'AGENTIC_KILL_SWITCH_DRILL', title: 'Kill switch drill', result: null, lastRunAt: null },
    ],
};

describe('a check that never ran says so', () => {
    it('renders "never run" rather than omitting the row', () => {
        render(<AssurancePanel assurance={base} />);
        const checks = screen.getByTestId('agents-assurance-checks');
        // BOTH rows present — the never-run one is not dropped.
        expect(checks.querySelectorAll('li')).toHaveLength(2);
        expect(checks.textContent).toMatch(/Kill switch drill/);
        expect(checks.textContent).toMatch(/never run/i);
    });

    it('does not render it as a pass', () => {
        render(<AssurancePanel assurance={base} />);
        const rows = screen.getByTestId('agents-assurance-checks').querySelectorAll('li');
        const drill = Array.from(rows).find((li) => li.textContent?.includes('Kill switch drill'))!;
        expect(drill.textContent).not.toMatch(/PASS/);
    });
});

describe('coverage names the consequence, not just the fraction', () => {
    it('says what an unscored agent means', () => {
        render(<AssurancePanel assurance={base} />);
        const text = screen.getByTestId('agents-assurance-coverage').textContent ?? '';
        expect(text).toMatch(/3 of 5/);
        // The number alone is a completeness metric. The sentence has to say
        // that an unscored agent is REFUSED, which is what makes it a risk
        // statement rather than a progress bar.
        expect(text).toMatch(/refused at the tool boundary/i);
    });

    it('an empty register says there is nothing to assess, not 0 of 0', () => {
        render(<AssurancePanel assurance={{ ...base, riskCoverage: { scored: 0, total: 0 } }} />);
        expect(screen.getByTestId('agents-assurance-coverage').textContent).toMatch(/nothing to assess/i);
    });
});

describe('an unaudited approval queue is stated, not left blank', () => {
    it('says nothing is re-checking approvals when no sample has been answered', () => {
        render(
            <AssurancePanel
                assurance={{ ...base, sampleAudit: { answered: 0, dissented: 0, disagreementRate: null } }}
            />,
        );
        expect(screen.getByTestId('agents-assurance-sample').textContent).toMatch(
            /nothing is re-checking/i,
        );
    });

    it('reports the rate as a percentage with its numerator and denominator', () => {
        render(<AssurancePanel assurance={base} />);
        const text = screen.getByTestId('agents-assurance-sample').textContent ?? '';
        expect(text).toMatch(/20%/);
        expect(text).toMatch(/2 of 10/);
    });
});
