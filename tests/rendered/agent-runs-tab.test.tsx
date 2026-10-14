/**
 * #3472 — the register reaches the work it authorised.
 *
 * The claim this panel makes is narrower than "an agent's runs", and the
 * narrowness is the point: `WorkflowRun.agentId` is NULL for a human-started
 * run, so the list cannot show one. A panel on an agent's page that mixed
 * those in would be answering a different question, and on a governance
 * surface attributing a person's run to an agent is the error that matters.
 *
 * ── WHAT THIS TEST CAN AND CANNOT SEE ───────────────────────────────────────
 *
 * The `next-intl` mock below is this repo's standard one for rendered tests —
 * next-intl is ESM and jest cannot parse it — and it does simple `{param}`
 * substitution only. It does NOT implement ICU plurals, so a
 * `{count, plural, …}` message reaches the DOM as its own pattern. The product
 * formats them correctly; 79 messages in `en.json` use that syntax.
 *
 * So the assertions here are about PRESENCE and ABSENCE of a segment, not
 * about a formatted number. That is the honest ceiling of this harness, and it
 * still covers the three places a row can mislead:
 *
 *   - the LINK, which is the whole reason the panel exists — a row that does
 *     not reach the step ledger is a status chip and nothing more;
 *   - the PENDING-PROPOSAL badge, because `AWAITING_APPROVAL` does NOT mean
 *     there is something to approve (a human checkpoint pauses a run whether
 *     or not it queued anything);
 *   - the TOKEN segment, which must stay absent at zero, because a run that
 *     spent nothing and a run whose usage went unreported both store 0.
 */
import { render, screen, cleanup } from '@testing-library/react';

// next-intl is ESM (jest cannot parse it); mock it resolving real en.json
// values, the same shape the other agent-tab tests use.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en[ns],
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

const swr = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (key: string) => swr(key),
}));
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantHref: () => (path: string) => `/t/acme${path}`,
}));

import { RunsTab } from '@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/RunsTab';

/**
 * The catalogue strings this file asserts on, read the way the component reads
 * them — so a reworded message fails HERE rather than silently matching
 * nothing. A literal copy would go stale the first time somebody edits the
 * copy, and the test would keep passing against text nobody renders.
 */
const EN = jest.requireActual('../../messages/en.json') as {
    admin: { agentDetail: { runs: Record<string, string> } };
};
const copy = (key: string): string => {
    const v = EN.admin.agentDetail.runs[key];
    if (typeof v !== 'string') {
        throw new Error(`messages/en.json has no admin.agentDetail.runs.${key}`);
    }
    return v;
};

afterEach(cleanup);
beforeEach(() => jest.clearAllMocks());

function run(over: Record<string, unknown> = {}) {
    return {
        id: 'run-1',
        workflowKey: 'audit-prep',
        status: 'COMPLETED',
        driver: 'FLUE',
        stepCount: 4,
        costTokens: 0,
        startedAt: '2026-10-14T00:00:00.000Z',
        completedAt: '2026-10-14T00:05:00.000Z',
        summary: null,
        errorMessage: null,
        ...over,
    };
}

function renderTab(state: Record<string, unknown>) {
    swr.mockReturnValue({ mutate: jest.fn(), ...state });
    return render(<RunsTab tenantSlug="acme" agentId="agent-1" />);
}

describe('the agent Runs tab', () => {
    it('asks for THIS agent’s runs — the key carries the id', () => {
        // A bare `/agent-runs` key would let two agents' tabs share one cache
        // entry, and the symptom is the previous agent's runs rendering for a
        // moment after a navigation.
        renderTab({ data: [], isLoading: false, error: null });
        expect(swr).toHaveBeenCalledWith('/agent-runs?agentId=agent-1');
    });

    it('links every row to that run’s step ledger', () => {
        renderTab({ data: [run()], isLoading: false, error: null });
        const link = screen.getByTestId('agent-run-link-run-1');
        expect(link).toHaveAttribute('href', '/t/acme/agents/runs/run-1');
        expect(link).toHaveTextContent('audit-prep');
    });

    it('shows the pending-proposal badge only when there IS one', () => {
        // The distinction the run list grew this count for: a run can be
        // AWAITING_APPROVAL with nothing queued.
        const badge = copy('pendingProposals');
        renderTab({
            data: [run({ status: 'AWAITING_APPROVAL', _count: { proposals: 2 } })],
            isLoading: false,
            error: null,
        });
        expect(screen.getByTestId('agent-runs-list')).toHaveTextContent(badge);

        cleanup();
        renderTab({
            data: [run({ status: 'AWAITING_APPROVAL', _count: { proposals: 0 } })],
            isLoading: false,
            error: null,
        });
        const list = screen.getByTestId('agent-runs-list');
        expect(list).toHaveTextContent('AWAITING_APPROVAL');
        expect(list).not.toHaveTextContent(badge);
    });

    it('omits the token segment at zero, and shows it above zero', () => {
        const tokens = copy('tokens');
        renderTab({ data: [run({ costTokens: 0 })], isLoading: false, error: null });
        expect(screen.getByTestId('agent-runs-list')).not.toHaveTextContent(tokens);

        cleanup();
        renderTab({ data: [run({ costTokens: 1200 })], isLoading: false, error: null });
        expect(screen.getByTestId('agent-runs-list')).toHaveTextContent(tokens);
    });

    it('an agent with no runs says WHICH question came back empty', () => {
        // Not a generic "nothing here": the empty state has to explain that a
        // human-started run would not appear, or a reader concludes the agent
        // did nothing when a person ran the same workflow by hand.
        renderTab({ data: [], isLoading: false, error: null });
        expect(screen.getByText(copy('emptyTitle'))).toBeInTheDocument();
        expect(screen.getByText(copy('emptyDescription'))).toBeInTheDocument();
        expect(copy('emptyDescription')).toMatch(/person started/i);
    });

    it('a failed read offers a retry rather than an empty list', () => {
        // The repo has been bitten by a swallowed error leaving a skeleton
        // forever; an empty list would claim the agent has no runs.
        renderTab({ data: undefined, isLoading: false, error: new Error('boom') });
        expect(screen.getByText(copy('loadFailed'))).toBeInTheDocument();
        expect(screen.queryByTestId('agent-runs-list')).toBeNull();
    });

    it('distinguishes FAILED from ABORTED rather than colouring them alike', () => {
        // One is a fault and the other is something stopping the run on
        // purpose; a reviewer acts differently on each.
        renderTab({
            data: [run({ id: 'r-f', status: 'FAILED' }), run({ id: 'r-a', status: 'ABORTED' })],
            isLoading: false,
            error: null,
        });
        const list = screen.getByTestId('agent-runs-list');
        expect(list).toHaveTextContent('FAILED');
        expect(list).toHaveTextContent('ABORTED');
    });
});
