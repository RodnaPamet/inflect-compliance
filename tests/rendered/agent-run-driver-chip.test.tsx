/**
 * WHICH ENGINE WALKED THIS RUN, on the surface an operator actually reads.
 *
 * Point 1 of the integration plan asks for "a driver chip on run rows at
 * /agents/runs". `WorkflowRun.driver` records the engine `selectRunDriver`
 * chose at the run's start; until this chip existed the column was written and
 * read by nothing, which is the shape of a fact nobody can act on.
 *
 * ── THE ASSERTION THAT MATTERS IS THE STATIC ONE ────────────────────────────
 *
 * A chip rendered only for FLUE would be cheaper and would look correct for as
 * long as one engine exists. It would also make "this run used the static
 * engine" and "this row predates the column" indistinguishable — and that is
 * the single distinction the chip is for. So the STATIC case is asserted
 * first, and it is the one that would fail a render-only-when-interesting
 * implementation.
 *
 * Both labels are read out of `messages/en.json` rather than written here, so
 * this file pins the WIRING and not the wording; a copy edit must not redden a
 * test about whether the engine is shown.
 */
import { render, screen, within } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), refresh: jest.fn(), back: jest.fn() }),
    useParams: () => ({ tenantSlug: 'acme' }),
    usePathname: () => '/t/acme/agents/runs',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json');
    const lookup = (ns: string, key: string) =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const make = (ns: string) => (key: string, params?: Record<string, unknown>) => {
        let v = lookup(ns, key);
        if (typeof v !== 'string') return key;
        if (params) for (const [p, val] of Object.entries(params)) {
            v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
        }
        return v;
    };
    return { useTranslations: (ns: string) => make(ns) };
});

jest.mock('@/lib/tenant-context-provider', () => ({
    ...jest.requireActual('@/lib/tenant-context-provider'),
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
    useTenantHref: () => (path: string) => `/t/acme${path}`,
}));

import { AgentRunsClient, type RunRow } from '@/app/t/[tenantSlug]/(app)/agents/runs/AgentRunsClient';

const EN = jest.requireActual('../../messages/en.json') as {
    agents: { runs: { driver: { STATIC: string; FLUE: string } } };
};
const LABEL = EN.agents.runs.driver;

const RUN: RunRow = {
    id: 'run-1',
    workflowKey: 'nightly-review',
    status: 'COMPLETED',
    stepCount: 3,
    costTokens: 1200,
    driver: 'STATIC',
    startedAt: '2026-09-01T10:00:00.000Z',
    completedAt: '2026-09-01T10:04:00.000Z',
    summary: null,
    pendingProposals: 0,
};

function renderRuns(runs: RunRow[]) {
    return render(
        <AgentRunsClient tenantSlug="acme" initialRuns={runs} workflows={[]} canOperate={false} />,
    );
}

describe('the run list says which engine walked each run', () => {
    it('renders the chip for a STATIC run — the case a lazier chip would omit', () => {
        renderRuns([RUN]);
        const row = document.getElementById('run-run-1');
        expect(row).not.toBeNull();
        expect(within(row as HTMLElement).getByText(LABEL.STATIC)).toBeInTheDocument();
    });

    it('renders a different label for a FLUE run', () => {
        renderRuns([{ ...RUN, id: 'run-2', driver: 'FLUE' }]);
        const row = document.getElementById('run-run-2');
        expect(within(row as HTMLElement).getByText(LABEL.FLUE)).toBeInTheDocument();
    });

    it('labels each row with ITS OWN engine, not the first one', () => {
        // The assertion with teeth. A chip hoisted out of the row — rendered
        // once from `runs[0]`, or keyed off anything but the row — passes both
        // cases above and is wrong the moment a list holds two engines, which
        // is the only list this chip exists for.
        renderRuns([RUN, { ...RUN, id: 'run-2', driver: 'FLUE' }]);

        const first = document.getElementById('run-run-1') as HTMLElement;
        const second = document.getElementById('run-run-2') as HTMLElement;

        expect(within(first).getByText(LABEL.STATIC)).toBeInTheDocument();
        expect(within(first).queryByText(LABEL.FLUE)).toBeNull();
        expect(within(second).getByText(LABEL.FLUE)).toBeInTheDocument();
        expect(within(second).queryByText(LABEL.STATIC)).toBeNull();
    });

    it('shows the engine on EVERY row — a denominator, not a sample', () => {
        // Without this, a chip that rendered for some rows and not others
        // satisfies every case above.
        const runs: RunRow[] = [
            RUN,
            { ...RUN, id: 'run-2', driver: 'FLUE' },
            { ...RUN, id: 'run-3', driver: 'STATIC' },
        ];
        renderRuns(runs);

        const labelled = runs.filter((r) => {
            const row = document.getElementById(`run-${r.id}`);
            return row !== null && within(row).queryByText(LABEL[r.driver]) !== null;
        });
        expect({ labelled: labelled.length, total: runs.length }).toEqual({
            labelled: 3,
            total: 3,
        });
    });

    it('an unknown driver value still renders, rather than blanking the row', () => {
        // The column is an enum today, but a list that threw or rendered
        // nothing on an unrecognised value would take the whole page down for
        // a future enum member. The status chip beside it already degrades to
        // `neutral`; this does the same.
        renderRuns([{ ...RUN, id: 'run-9', driver: 'GRAPH' as RunRow['driver'] }]);
        const row = document.getElementById('run-run-9');
        expect(row).not.toBeNull();
        expect(screen.getByText('nightly-review')).toBeInTheDocument();
    });
});
