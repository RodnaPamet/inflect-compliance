/**
 * The score chip's three colour roles stay separated.
 *
 * B2-3 unified three near-copies — the score column and residual column in
 * `RisksClient`, and `BandChip` in `RiskAssessmentPanel`. They differed
 * only in padding, text size, whether the band name is spelled out, and
 * the test id, which is exactly the kind of duplication a reader cannot
 * see and a refactor silently diverges.
 *
 * WHAT THIS ACTUALLY GUARDS: an earlier version used `band.color` for BOTH
 * the tinted background and the TEXT, collapsing contrast to ~2:1 against
 * WCAG AA's 4.5:1 for small text. The fix separated the roles — tinted
 * background, solid dot, neutral `text-content-emphasis`. "Colour the text
 * by band" is the obvious-looking simplification that reintroduces the
 * violation, and it looks fine to a sighted developer on a light theme.
 * axe would catch it only if an a11y spec happened to render this chip.
 */
import { render, screen } from '@testing-library/react';
import { RiskBandChip } from '@/app/t/[tenantSlug]/(app)/risks/_shared/RiskBandChip';
import type { RiskMatrixBand } from '@/lib/risk-matrix/types';

const band: RiskMatrixBand = {
    name: 'Critical',
    minScore: 20,
    maxScore: 25,
    color: '#ef4444',
};

describe('RiskBandChip', () => {
    it('renders the score and tags the band for tooltips and tests', () => {
        render(<RiskBandChip value={21} band={band} testId="risk-score-r1" />);
        const chip = screen.getByTestId('risk-score-r1');
        expect(chip).toHaveTextContent('21');
        expect(chip).toHaveAttribute('data-band', 'Critical');
    });

    it('tints the background with the band colour but never the text', () => {
        render(<RiskBandChip value={21} band={band} testId="chip" />);
        const chip = screen.getByTestId('chip') as HTMLElement;
        // jsdom normalises `#ef444433` to rgba(), so read the computed
        // property rather than string-matching the hex we wrote.
        expect(chip.style.backgroundColor).toBe('rgba(239, 68, 68, 0.2)');
        // Text: the designed-for-contrast neutral, NOT the band colour.
        // An inline `color` of any kind here is the contrast regression.
        expect(chip.className).toContain('text-content-emphasis');
        expect(chip.style.color).toBe('');
    });

    it('carries a solid-colour dot as the second cue, hidden from screen readers', () => {
        render(<RiskBandChip value={21} band={band} testId="chip" />);
        const dot = screen
            .getByTestId('chip')
            .querySelector<HTMLElement>('[aria-hidden="true"]');
        expect(dot).not.toBeNull();
        // Solid, not the 20%-alpha tint — it must read when the tint is
        // subtle. Fully opaque rgb(), never rgba(… , 0.2).
        expect(dot!.style.backgroundColor).toBe('rgb(239, 68, 68)');
    });

    it('spells the band name out only when asked', () => {
        const { rerender } = render(<RiskBandChip value={21} band={band} testId="chip" />);
        expect(screen.getByTestId('chip')).not.toHaveTextContent('Critical');
        rerender(<RiskBandChip value={21} band={band} testId="chip" showBandName />);
        expect(screen.getByTestId('chip')).toHaveTextContent('21 · Critical');
    });

    it('omits the test id attribute entirely when none is given', () => {
        // The assessment panel renders one chip with no id; emitting
        // `data-testid="undefined"` would make it selectable by accident.
        const { container } = render(<RiskBandChip value={9} band={band} />);
        expect(container.querySelector('[data-testid]')).toBeNull();
    });

    it('renders a value of zero rather than swallowing it', () => {
        // `{value}` with a falsy number is a classic disappearing-cell bug.
        render(<RiskBandChip value={0} band={band} testId="chip" />);
        expect(screen.getByTestId('chip')).toHaveTextContent('0');
    });
});
