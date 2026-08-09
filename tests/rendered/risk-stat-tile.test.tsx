/**
 * The stat tile renders EXACTLY what the 20 hand-written copies rendered.
 *
 * B2-7 — this markup existed as 20 literal `<div className="…">` copies
 * across four files. The point of extracting it is that the change is
 * invisible in the rendered output: if the tile started rendering a border,
 * a heading slot or different padding, every risk dashboard, the
 * loss-events page, the Monte Carlo panel and the history sparklines would
 * shift at once — which is exactly why the richer `MetricCard` / `KpiCard`
 * primitives were NOT used here.
 *
 * So these assertions are deliberately about class strings, which is
 * normally a smell. Here the class string IS the contract: it is what the
 * 20 call sites were, and the guarantee being made is "nothing moved".
 */
import { render, screen } from '@testing-library/react';
import { StatTile } from '@/app/t/[tenantSlug]/(app)/risks/_shared/StatTile';

describe('StatTile', () => {
    it('renders the default tint the 18 dashboard/loss-events/Monte-Carlo tiles used', () => {
        render(<StatTile testId="tile">42</StatTile>);
        const tile = screen.getByTestId('tile');
        expect(tile.className).toBe('rounded-md bg-bg-muted/30 px-default py-default');
        expect(tile).toHaveTextContent('42');
    });

    it('renders the subtle tint the two history sparkline tiles used', () => {
        // /20, not /30. Almost certainly drift rather than intent — but
        // restyling two tiles inside a deduplication commit would be a
        // silent visual change, so both are preserved and the discrepancy
        // is now visible at the call site instead of buried in a class.
        render(<StatTile tone="subtle" testId="tile">42</StatTile>);
        expect(screen.getByTestId('tile').className).toBe(
            'rounded-md bg-bg-muted/20 px-default py-default',
        );
    });

    it('omits the test id attribute entirely when none is given', () => {
        // 6 of the 20 call sites had no testid. Emitting
        // `data-testid="undefined"` would make them selectable by accident.
        const { container } = render(<StatTile>x</StatTile>);
        expect(container.querySelector('[data-testid]')).toBeNull();
    });

    it('renders arbitrary children, not just a KPIStat', () => {
        // 18 tiles wrap <KPIStat>; the two history ones wrap a bespoke
        // three-line sparkline block. The tile is a container, not a
        // stat-specific component — narrowing it to a value/label pair
        // would have forced the history panel back to a raw div.
        render(
            <StatTile testId="tile">
                <div>line one</div>
                <div>line two</div>
            </StatTile>,
        );
        expect(screen.getByTestId('tile').children).toHaveLength(2);
    });
});
