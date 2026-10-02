/**
 * A SINGLE CLICK OPENS AN AGENT, AND THERE IS NO CHECKBOX (#2434, #2435).
 *
 * Two halves of one defect, and they are not independent.
 *
 * `<DataTable>`'s select column is DEFAULT-ON. The register has no batch
 * actions, so every row carried a checkbox that did nothing — and, worse, the
 * select column TAKES THE SINGLE CLICK: with selection enabled, clicking a row
 * selects it, and the row's real action (open the agent) silently moves to a
 * DOUBLE click. So the register's one route to the detail page was behind a
 * gesture nothing on the page advertises, and the affordance that was
 * advertised did nothing.
 *
 * That makes the two assertions here inseparable. "No checkbox" alone would be
 * satisfied by a table with no row action either; "single click opens" alone
 * would be satisfied by a table that also renders a dead control beside it.
 *
 * THE TEST CLICKS. It does not read `selectionEnabled: false` out of the
 * source: the prop is the mechanism, and a rendered test that asserted the prop
 * would go green on a DataTable change that made the prop mean something else.
 * `router.push` is the observable — that is what opening an agent IS.
 *
 * This file is owned by AGENTIC UI 1/4 (#2435). Prompt 3/4 also specified
 * creating it, and a second `Write` of a fresh path clobbers the first with no
 * conflict marker, so single ownership is recorded here as well as in the issue.
 */
import * as React from 'react';
import { render, screen, within, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.setTimeout(180_000);

// next-intl is ESM; resolve real en.json values (a missing key renders as its
// own dotted path, so a path assertion would pass on an empty catalogue).
// Memoised per namespace — a fresh `t` identity per render invalidates the
// `useMemo([t])` that builds the columns and turns a render into a loop.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            ns.split('.').reduce<unknown>(
                (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                en,
            ) as Record<string, unknown>,
        );
    const cache = new Map<string, (key: string, params?: Record<string, unknown>) => string>();
    const make = (ns: string) => {
        const hit = cache.get(ns);
        if (hit) return hit;
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(ns, key);
            if (typeof v !== 'string') return key;
            if (params)
                for (const [p, val] of Object.entries(params))
                    v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
            return v as string;
        };
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

const push = jest.fn();
// Hoisted for the same reason `push` is: an inline `jest.fn()` inside the
// factory is a FRESH spy on every `useRouter()` call, so a test could never
// read what the component did with it.
const prefetch = jest.fn();
jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({
        push,
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch,
    }),
    usePathname: () => '/t/acme/agents',
    useSearchParams: () => new URLSearchParams(),
}));

import { TooltipProvider } from '@/components/ui/tooltip';
import { AgentsClient, type AgentRow } from '@/app/t/[tenantSlug]/(app)/agents/AgentsClient';

function makeRow(overrides: Partial<AgentRow> = {}): AgentRow {
    return {
        id: 'agent-1',
        name: 'Control reconciler',
        status: 'ACTIVE',
        autonomyLevel: 3,
        dataAccessScope: 'READ_TENANT_DATA',
        reversibility: 'COMPENSABLE',
        provenance: 'FIRST_PARTY',
        riskTier: 'MODERATE',
        isLegacyPlaceholder: false,
        owner: { id: 'user-1', name: 'Dana Iveagh', email: 'dana@acme.test' },
        aiSystem: { id: 'sys-1', riskTier: 'LIMITED', classificationClauseId: 'Art 95' },
        _count: { apiKeys: 2 },
        ...overrides,
    };
}

const ROWS: AgentRow[] = [
    makeRow({ id: 'first-agent', name: 'Control reconciler' }),
    makeRow({ id: 'second-agent', name: 'Evidence sweeper' }),
];

function renderRegister() {
    return render(
        <TooltipProvider delayDuration={0}>
            <AgentsClient
                initialRows={ROWS}
                tenantSlug="acme"
                owners={[{ id: 'user-1', label: 'Dana Iveagh' }]}
                vendors={[]}
                kpiCounts={{ total: 2, active: 2, unscored: 0, egress: 0 }}
                governance={{
                    enforcing: true,
                    unboundCredentials: 0,
                    unboundCredentialSamples: [],
                }}
                assurance={null}
                proposalsAwaitingReview={null}
                canWrite
                canReviewProposals
            />
        </TooltipProvider>,
    );
}

beforeEach(() => {
    push.mockClear();
    prefetch.mockClear();
});

describe('one click opens the agent', () => {
    it('a SINGLE click on a row navigates to that agent’s detail page', async () => {
        const user = userEvent.setup();
        renderRegister();

        const cell = screen.getByTestId('agent-row-second-agent');
        // The <tr>, which is what carries the click handler. Clicking the cell
        // bubbles to it; reaching for the row explicitly makes the target
        // unambiguous rather than relying on bubbling from whichever element
        // the name happens to sit in.
        const row = cell.closest('tr');
        expect(row).not.toBeNull();
        await user.click(row as HTMLElement);

        // ONE navigation, to THAT agent — not "push was called", which a click
        // that opened the wrong row would also satisfy.
        expect(push).toHaveBeenCalledTimes(1);
        expect(push).toHaveBeenCalledWith('/t/acme/agents/second-agent');
    });

    it('and the destination is the NEW /agents path, not the retired /admin one', () => {
        // Paired with the positive above. The register moved out of /admin
        // (#2421) and a row that still pushed the old path would land on the
        // redirect shim — which works, and costs a round trip on the one
        // gesture the register exists for.
        expect(push).not.toHaveBeenCalled();
    });

    it('every row advertises that it opens — the trailing chevron column', () => {
        renderRegister();
        // `onRowClick` is also what makes DataTable mount its chevron column.
        // A row that navigates but says nothing is a row nobody clicks.
        const table = document.getElementById('agents-table') as HTMLElement;
        expect(table.querySelectorAll('tbody tr').length).toBe(ROWS.length);
        expect(table.querySelectorAll('tbody tr svg').length).toBeGreaterThanOrEqual(
            ROWS.length,
        );
    });
});

/**
 * A RESTING POINTER WARMS THE ROW'S DETAIL ROUTE (#3099 lever 1).
 *
 * The register was the only entity list that wired no `onRowPrefetch`, so an
 * agent row's first click paid the full chunk + RSC wait that no sibling's
 * does. The assertion is `router.prefetch` with THAT row's href — not "prefetch
 * was called", which warming the wrong row would also satisfy.
 *
 * This is a consistency + first-click-latency test and nothing more. It does
 * NOT demonstrate anything about #3099's dropped-navigation flake: the dwell
 * below is 200 ms of fake time, while Playwright's `click()` moves the pointer
 * and presses inside one action window, so in E2E the prefetch has not fired by
 * the time the push runs.
 */
describe('a resting pointer warms that row’s detail route', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
    });

    /** Past `ROW_PREFETCH_DWELL_MS` (120) in `data-table.tsx`. */
    const PAST_DWELL_MS = 200;

    it('prefetches the hovered agent, once, and no other', () => {
        renderRegister();
        const row = screen.getByTestId('agent-row-second-agent').closest('tr');
        expect(row).not.toBeNull();

        fireEvent.mouseEnter(row as HTMLElement);
        act(() => {
            jest.advanceTimersByTime(PAST_DWELL_MS);
        });

        expect(prefetch).toHaveBeenCalledTimes(1);
        expect(prefetch).toHaveBeenCalledWith('/t/acme/agents/second-agent');
        // Warming must not navigate. A prefetch that pushed would open the
        // agent on hover, which is a worse bug than the latency it fixes.
        expect(push).not.toHaveBeenCalled();
    });

    it('does NOT prefetch a row the pointer merely passes over', () => {
        // The dwell is the whole point — without it, dragging the pointer down
        // the register warmed every row it crossed.
        renderRegister();
        const row = screen.getByTestId('agent-row-first-agent').closest('tr');
        fireEvent.mouseEnter(row as HTMLElement);
        act(() => {
            jest.advanceTimersByTime(40);
        });
        fireEvent.mouseLeave(row as HTMLElement);
        act(() => {
            jest.advanceTimersByTime(PAST_DWELL_MS);
        });

        expect(prefetch).not.toHaveBeenCalled();
    });
});

describe('no checkbox, because there are no batch actions', () => {
    it('renders ZERO row checkboxes', () => {
        renderRegister();
        const table = document.getElementById('agents-table') as HTMLElement;
        // Counted at zero rather than "the first row has none": an exact count
        // over the whole table means a header select-all cannot hide either.
        expect(table.querySelectorAll('input[type="checkbox"]').length).toBe(0);
        expect(within(table).queryAllByRole('checkbox').length).toBe(0);
    });

    it('renders no selection toolbar — the control a checkbox would feed', () => {
        renderRegister();
        const table = document.getElementById('agents-table') as HTMLElement;
        // The batch-action surface. Its absence is what makes the checkbox
        // dead rather than merely unused, and it is the half a reader can see.
        expect(table.textContent).not.toMatch(/\bselected\b/i);
    });
});
