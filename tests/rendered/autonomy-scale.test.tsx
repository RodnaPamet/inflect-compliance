/**
 * THE AUTONOMY LADDER RENDERS ITS MEANING (#2457).
 *
 * `autonomyLevel` is a term in `min(key.maxAutonomyLevel, agent.autonomyLevel,
 * tierCap)`, evaluated at the tool boundary on every call — the central
 * authority dial — and it rendered as a bare integer. Nobody reading "4" could
 * tell what it permitted without opening the source.
 *
 * ── THE TWO ASSERTIONS THAT ARE NOT DECORATION ──────────────────────
 *
 * RUNGS 4-6 GRANT NOTHING EXTRA. No capability class requires a rung above 3,
 * so registering an agent at 5 buys it nothing 3 did not. That is invisible
 * from the integer and cuts both ways: an operator choosing 5 believes they are
 * granting more, and an auditor reading 5 believes more was granted.
 *
 * THE CURRENT RUNG IS MARKED IN TEXT, not only by font weight. A bold row is
 * invisible to a screen reader and to anyone reading a printed assessment pack,
 * which is precisely the audience for this screen.
 */
import { render, screen } from '@testing-library/react';

jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json');
    const lookup = (ns: string, key: string) =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const make = (ns: string) => (key: string) => {
        const v = lookup(ns, key);
        return typeof v === 'string' ? v : key;
    };
    return { useTranslations: (ns: string) => make(ns) };
});

import { AutonomyScale } from '@/app/t/[tenantSlug]/(app)/agents/[agentId]/AutonomyScale';
import { AUTONOMY_MAX, AUTONOMY_MIN } from '@/lib/agentic/autonomy-ceiling';

describe('every rung on the ladder is rendered with its meaning', () => {
    it('renders one row per rung, 0 through the maximum', () => {
        render(<AutonomyScale level={2} />);
        for (let rung = AUTONOMY_MIN; rung <= AUTONOMY_MAX; rung += 1) {
            expect(screen.getByTestId(`autonomy-rung-${rung}`)).toBeInTheDocument();
        }
    });

    it('rung 0 says the agent can call NOTHING', () => {
        // "Suggests only" means it — no MCP tool sits at rung 0, so this is the
        // register meaning what it says rather than a rounding error.
        render(<AutonomyScale level={0} />);
        expect(screen.getByTestId('autonomy-rung-0').textContent).toMatch(/can call nothing/i);
    });

    it('rung 2 says PROPOSE does not commit', () => {
        render(<AutonomyScale level={2} />);
        expect(screen.getByTestId('autonomy-rung-2').textContent).toMatch(/does not commit/i);
    });

    it('rungs above orchestrate say they grant nothing extra', () => {
        render(<AutonomyScale level={5} />);
        for (const rung of [4, 5, 6]) {
            expect(screen.getByTestId(`autonomy-rung-${rung}`).textContent).toMatch(
                /grants nothing beyond orchestrate/i,
            );
        }
    });
});

describe('the registered rung is marked', () => {
    it('marks exactly the registered one, and marks it in TEXT', () => {
        render(<AutonomyScale level={3} />);
        // By HANDLE, not by text: rung 0's own copy contains the words
        // "registered here" ("an agent registered here can call nothing"), so a
        // text matcher counts prose as a marker. Same class of error as
        // grepping a file that mixes comments and data.
        expect(screen.getAllByTestId('autonomy-current-marker')).toHaveLength(1);
        expect(screen.getByTestId('autonomy-rung-3')).toHaveAttribute('data-current', 'true');
        // Paired negative: a component that marked every row would satisfy the
        // positive above and say nothing.
        expect(screen.getByTestId('autonomy-rung-2')).not.toHaveAttribute('data-current');
    });
});

describe('the effective ceiling is stated, because this rung is not the whole answer', () => {
    it('says the lowest of three terms wins, and that unassessed means refused', () => {
        render(<AutonomyScale level={6} />);
        const text = screen.getByTestId('autonomy-scale').textContent ?? '';
        expect(text).toMatch(/lowest/i);
        // The trap the ceiling module calls out: NULL tier is UNSCORED and
        // resolves to DENY, so a 6 on this scale can still reach nothing.
        expect(text).toMatch(/unassessed agent is refused/i);
    });
});
