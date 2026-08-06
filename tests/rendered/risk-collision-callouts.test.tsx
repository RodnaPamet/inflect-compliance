/**
 * RQ3-5 — the range-compression callouts drill into a CELL, not a score.
 *
 * REPLACES the region slice in `tests/guards/rq3-5-histograms.test.ts`, which
 * cut `client.indexOf('risk-collision-callouts')` to the literal
 * `view === 'heatmap'` and regexed inside — a JSX byte window that any markup
 * move silently redefined.
 *
 * WHY THE CELL/SCORE DISTINCTION IS THE WHOLE POINT: a score is a PRODUCT
 * shared by many cells — L1×I6 and L2×I3 are both 6. The callout says "these
 * two risks sit in the same box and are priced 40× apart", so drilling by
 * score would show the user rows from cells they never clicked on, in the one
 * view whose entire purpose is that they occupy the same box. Clicking is the
 * only way to observe which token is emitted.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { RiskCollisionCallouts } from '@/app/t/[tenantSlug]/(app)/risks/_shared/RiskCollisionCallouts';
import type { CellCollision } from '@/lib/risk-collisions';

const money = (v: number | null | undefined) => `€${Math.round((v ?? 0) / 1000)}K`;

const collision = (over: Partial<CellCollision> = {}): CellCollision =>
    ({
        likelihood: 2,
        impact: 3,
        ratio: 40,
        minRisk: { id: 'a', title: 'Small risk', ale: 25_000 },
        maxRisk: { id: 'b', title: 'Large risk', ale: 1_000_000 },
        ...over,
    }) as CellCollision;

function renderCallouts(
    collisions: CellCollision[],
    onDrillToCell: (t: string) => void = jest.fn(),
) {
    return {
        onDrillToCell,
        ...render(
            <RiskCollisionCallouts
                collisions={collisions}
                money={money}
                title="Range compression"
                description="Same cell, very different money."
                onDrillToCell={onDrillToCell}
            />,
        ),
    };
}

describe('RiskCollisionCallouts', () => {
    it('renders nothing when there are no collisions', () => {
        const { container } = renderCallouts([]);
        expect(container).toBeEmptyDOMElement();
        expect(screen.queryByTestId('risk-collision-callouts')).toBeNull();
    });

    it('names both risks and both prices so the compression is legible', () => {
        renderCallouts([collision()]);
        const row = screen.getByTestId('risk-collision-2-3');
        expect(row).toHaveTextContent('Small risk');
        expect(row).toHaveTextContent('Large risk');
        expect(row).toHaveTextContent('€25K');
        expect(row).toHaveTextContent('€1000K');
        // The ratio is what makes it a callout rather than a list.
        expect(row).toHaveTextContent('40');
    });

    it('drills by CELL token, never by score', () => {
        const onDrillToCell = jest.fn();
        renderCallouts([collision({ likelihood: 2, impact: 3 })], onDrillToCell);

        fireEvent.click(screen.getByTestId('risk-collision-2-3'));

        expect(onDrillToCell).toHaveBeenCalledWith('L2xI3');
        // 2×3 = 6. If the drill-down ever regressed to the score product it
        // would emit something containing '6' and pull in L1×I6 as well.
        expect(onDrillToCell).not.toHaveBeenCalledWith(expect.stringMatching(/^6$|score/i));
    });

    it('emits a distinct token per cell when several cells collide', () => {
        const onDrillToCell = jest.fn();
        renderCallouts(
            [
                collision({ likelihood: 1, impact: 6 }),
                collision({ likelihood: 2, impact: 3 }),
            ],
            onDrillToCell,
        );

        // Both cells share the score 6 — the case that motivates the rule.
        fireEvent.click(screen.getByTestId('risk-collision-1-6'));
        fireEvent.click(screen.getByTestId('risk-collision-2-3'));

        expect(onDrillToCell.mock.calls.map((c) => c[0])).toEqual(['L1xI6', 'L2xI3']);
    });

    it('gives each callout a keyboard-reachable button, not a bare div', () => {
        renderCallouts([collision()]);
        const row = screen.getByTestId('risk-collision-2-3');
        expect(row.tagName).toBe('BUTTON');
        expect(row).toHaveAttribute('type', 'button');
    });
});
