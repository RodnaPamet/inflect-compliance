/**
 * INLINE APPROVE / REJECT ON THE CANVAS — the panel half (#3472).
 *
 * `tests/rendered/process-shape-render.test.tsx` owns the shape's half: that a
 * node parked on a HUMAN_CHECKPOINT offers a control at all, and that the
 * click carries the right run id. This file owns what happens next.
 *
 * ═══ WHAT IS ACTUALLY LOAD-BEARING HERE ═══
 *
 * Four claims, and the first two are controls rather than correctness checks.
 *
 *   1. THE APPROVE CONTROL IS INSIDE THE RENDERED DIFF. The canvas is a
 *      SECOND mount of `ProposalDiffPanel`, whose whole shape exists to make
 *      "a reviewer cannot reach the button without the evidence" structural
 *      rather than a comment. A second surface is exactly how an invariant
 *      like that gets lost, so it is asserted here by CONTAINMENT — the button
 *      is found inside the diff's subtree, not merely somewhere on screen.
 *
 *   2. THE DECISION GOES THROUGH THE PROPOSALS ROUTES. The plan's constraint
 *      is "no second approval path". Asserted on the fetch URL, because that
 *      is the only place the claim is checkable from the client: a panel that
 *      grew its own endpoint would still render identically.
 *
 *   3. `baseDigest` TRAVELS WITH THE APPROVAL, and it is the digest of the
 *      diff that was RENDERED. The server refuses an UPDATE approval carrying
 *      none, so omitting it would turn every update into a 400 — and sending a
 *      fresher one would forge the reviewer's claim to have looked.
 *
 *   4. EVERY FETCH STATE IS NAMED. The plan: "No stuck-loading states: every
 *      fetch has an explicit error state with retry. This repo has been bitten
 *      by `.catch(() => {})` leaving skeletons forever."
 *
 * ═══ AND THE ONE THAT IS NOT ABOUT PROPOSALS AT ALL ═══
 *
 * AWAITING_APPROVAL does not mean there are proposals to approve. A
 * HUMAN_CHECKPOINT pauses a run whether or not it queued anything, and a
 * content-guard flag pauses one that queued nothing. `listWorkflowRuns`
 * carries that note and a filtered count because of it. An empty panel on a
 * parked run must therefore say something true about the RUN rather than
 * render an empty queue.
 */
import * as React from 'react';
import { render, screen, within, cleanup, act, fireEvent } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({
        push: jest.fn(), replace: jest.fn(), refresh: jest.fn(),
        back: jest.fn(), forward: jest.fn(), prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/processes',
    useSearchParams: () => new URLSearchParams(),
}));

// A MEMOISING next-intl mock, reading the REAL catalogue. The naive form
// returns a fresh `t` per render, which makes a memoising component re-render
// forever and the suite time out rather than fail. Reading `messages/en.json`
// also means a key this panel asks for and the catalogue does not have shows
// up here as the key itself, not as plausible English.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const cache = new Map<string, unknown>();
    const make = (ns: string) => {
        if (cache.has(ns)) return cache.get(ns);
        const dict = en[ns] || {};
        const resolve = (key: string) =>
            key.split('.').reduce(
                (o: unknown, k) =>
                    o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined,
                dict,
            );
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(key);
            if (typeof v !== 'string') return key;
            if (params)
                for (const [p, val] of Object.entries(params))
                    v = (v as string).replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
            return v;
        };
        t.rich = (key: string) => {
            const v = resolve(key);
            return typeof v === 'string' ? v : key;
        };
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
    useTenantHref: () => (path: string) => `/t/acme${path}`,
}));

const swr = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (...args: unknown[]) => swr(...args),
}));

import { CheckpointReviewPanel } from '@/components/processes/CheckpointReviewPanel';
import {
    CheckpointReviewProvider,
    useCheckpointReview,
} from '@/lib/processes/canvas-checkpoint-review';
import { computeProposalDiff } from '@/lib/agentic/proposal-diff';
import { CACHE_KEYS } from '@/lib/swr-keys';

/**
 * The guard columns, constant across this file.
 *
 * `guardInputDigest` non-null on purpose: a null reads as a PRE-GUARD row,
 * which is a different claim (`resolveProposalGuardState` answers UNSCANNED)
 * and would put a second badge on every card here.
 */
const SCANNED_CLEAN = {
    guardVerdict: 'CLEAN',
    guardRuleIds: [] as string[],
    guardInputDigest: 'sha256:0123456789abcdef0123456789abcdef',
};

/** A real diff, computed by the real function — never a hand-written literal. */
const UPDATE_DIFF = computeProposalDiff({
    operation: 'UPDATE',
    payloadJson: JSON.stringify({ title: 'Tightened wording' }),
    target: { id: 'risk-1', title: 'Old wording' },
});
const CREATE_DIFF = computeProposalDiff({
    operation: 'CREATE',
    payloadJson: JSON.stringify({ title: 'A new risk' }),
});

const proposal = (over: Record<string, unknown> = {}) => ({
    id: 'prop-1',
    kind: 'RISK',
    operation: 'UPDATE',
    status: 'PENDING',
    targetEntityId: 'risk-1',
    rationale: 'The control text drifted from the policy.',
    stepSeq: 3,
    expiresAt: null,
    createdAt: '2026-10-14T09:00:00.000Z',
    diff: UPDATE_DIFF,
    ...SCANNED_CLEAN,
    ...over,
});

const review = (over: Record<string, unknown> = {}) => ({
    runId: 'run-1',
    workflowKey: 'audit-prep',
    status: 'AWAITING_APPROVAL',
    awaitingHuman: true,
    approvalExpiresAt: null,
    proposals: [proposal()],
    truncated: false,
    ...over,
});

const mutate = jest.fn();
function load(
    state: { data?: unknown; error?: unknown; isLoading?: boolean },
): void {
    swr.mockReturnValue({
        data: state.data,
        error: state.error,
        isLoading: state.isLoading ?? false,
        mutate,
    });
}

/** Opens the panel on mount, the way a node's affordance would. */
function OpenOnMount({ runId }: { runId: string }) {
    const { open } = useCheckpointReview();
    React.useEffect(() => {
        open(runId);
    }, [open, runId]);
    return null;
}

function mount(opts: { canReview?: boolean; canOperate?: boolean } = {}) {
    return render(
        <CheckpointReviewProvider
            canReview={opts.canReview ?? true}
            canOperate={opts.canOperate ?? true}
        >
            <OpenOnMount runId="run-1" />
            <CheckpointReviewPanel />
        </CheckpointReviewProvider>,
    );
}

const fetchMock = jest.fn();

beforeEach(() => {
    swr.mockReset();
    mutate.mockReset();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
        ok: true,
        json: async () => ({ status: 'ACCEPTED', createdEntityId: 'risk-1' }),
    });
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
    load({ data: review() });
});
afterEach(cleanup);

describe('the panel is closed until a node opens it', () => {
    it('renders nothing with no run open, and subscribes to no key', () => {
        // The SWR key is null in that state, which is what keeps a canvas from
        // reading a review queue nobody asked for.
        render(
            <CheckpointReviewProvider canReview canOperate>
                <CheckpointReviewPanel />
            </CheckpointReviewProvider>,
        );
        expect(screen.queryByTestId('checkpoint-review-panel')).toBeNull();
        expect(swr).toHaveBeenCalledWith(null, expect.anything());
    });

    it('subscribes to the OPENED run’s key once a node opens it', () => {
        mount();
        expect(screen.getByTestId('checkpoint-review-panel')).toHaveAttribute(
            'data-run-id',
            'run-1',
        );
        expect(swr).toHaveBeenCalledWith(
            CACHE_KEYS.agentRuns.checkpoint('run-1'),
            expect.anything(),
        );
    });

    it('does not revalidate under the reviewer, by any of the three routes', () => {
        // A diff is computed against the target's state at FETCH time, so a
        // background refresh would swap the rows mid-read — and swap the
        // `baseDigest` the next click sends with them.
        //
        // THREE, not two. `refreshInterval` left undefined inherits nothing
        // from `useTenantSWR`'s defaults today, but the workspace's own gating
        // test puts the claim plainly about its siblings — "either alone still
        // schedules work" — and an unstated option reads as nobody having
        // decided.
        mount();
        const opts = swr.mock.calls.at(-1)?.[1] as Record<string, unknown>;
        expect(opts.refreshInterval).toBe(0);
        expect(opts.revalidateOnFocus).toBe(false);
        expect(opts.revalidateOnReconnect).toBe(false);
    });

    it('closes on the close control', () => {
        mount();
        fireEvent.click(screen.getByTestId('checkpoint-close'));
        expect(screen.queryByTestId('checkpoint-review-panel')).toBeNull();
    });

    it('a viewer who may not review cannot open it at all', () => {
        // Gated in the SETTER, not only at the call site: `open` is handed to a
        // shape util that knows nothing about authority.
        load({ data: review() });
        render(
            <CheckpointReviewProvider canReview={false} canOperate>
                <OpenOnMount runId="run-1" />
                <CheckpointReviewPanel />
            </CheckpointReviewProvider>,
        );
        expect(screen.queryByTestId('checkpoint-review-panel')).toBeNull();
    });
});

describe('every fetch state is named', () => {
    it('says it is loading rather than rendering an empty panel', () => {
        load({ isLoading: true });
        mount();
        expect(screen.getByTestId('checkpoint-loading')).toBeInTheDocument();
        expect(screen.queryByTestId('checkpoint-none')).toBeNull();
    });

    it('a failed read gets an explicit error AND a retry that refetches', () => {
        load({ error: new Error('boom') });
        mount();
        expect(screen.getByTestId('checkpoint-load-failed')).toBeInTheDocument();
        fireEvent.click(screen.getByTestId('checkpoint-retry'));
        expect(mutate).toHaveBeenCalled();
    });

    it('a 403 is its own state, not the generic failure', () => {
        // "You may not review this" and "the read broke" prompt different
        // actions, and a retry button on the first is a loop.
        load({ error: Object.assign(new Error('forbidden'), { status: 403 }) });
        mount();
        expect(screen.getByTestId('checkpoint-forbidden')).toBeInTheDocument();
        expect(screen.queryByTestId('checkpoint-retry')).toBeNull();
    });
});

describe('a parked run that queued nothing', () => {
    it('says so about the RUN, and does not render an empty queue', () => {
        load({ data: review({ proposals: [] }) });
        mount();
        const none = screen.getByTestId('checkpoint-none');
        expect(none).toHaveTextContent('queued no proposals');
        // The action is on the run, so there is a way to reach it.
        expect(screen.getByTestId('checkpoint-open-run')).toHaveAttribute(
            'href',
            '/t/acme/agents/runs/run-1',
        );
    });

    it('a settled run names its status instead', () => {
        load({ data: review({ proposals: [], status: 'COMPLETED', awaitingHuman: false }) });
        mount();
        expect(screen.getByTestId('checkpoint-none')).toHaveTextContent('COMPLETED');
    });

    it('a truncated checkpoint says so rather than looking complete', () => {
        load({ data: review({ truncated: true }) });
        mount();
        expect(screen.getByTestId('checkpoint-truncated')).toBeInTheDocument();
    });
});

describe('the approve control is a CHILD of the rendered diff', () => {
    it('is found inside the diff’s own subtree', () => {
        mount();
        const diff = screen.getByTestId('proposal-diff-prop-1');
        expect(within(diff).getByTestId('checkpoint-approve-prop-1')).toBeInTheDocument();
    });

    it('is withheld entirely when the diff could not be computed', () => {
        // TARGET_MISSING is not an answer, so approval goes away rather than
        // being rendered beside a gap. Reject stays — refusing a proposal you
        // cannot read is always safe.
        const missing = computeProposalDiff({
            operation: 'UPDATE',
            payloadJson: JSON.stringify({ title: 'x' }),
            target: null,
        });
        load({ data: review({ proposals: [proposal({ diff: missing })] }) });
        mount();
        expect(screen.queryByTestId('checkpoint-approve-prop-1')).toBeNull();
        expect(screen.getByTestId('checkpoint-reject-prop-1')).toBeInTheDocument();
    });
});

describe('the decision goes through the proposals routes', () => {
    it('approves at the proposals endpoint, carrying the rendered baseDigest', async () => {
        mount();
        await act(async () => {
            fireEvent.click(screen.getByTestId('checkpoint-approve-prop-1'));
        });
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('/api/t/acme/agent-proposals/prop-1/approve');
        expect(init.method).toBe('POST');
        // The digest of the diff THAT WAS RENDERED — the same fetch that drew
        // the table, not a fresher read the reviewer never saw.
        expect(JSON.parse(String(init.body))).toEqual({
            baseDigest: UPDATE_DIFF.baseDigest,
        });
        expect(UPDATE_DIFF.baseDigest).toBeTruthy();
    });

    it('rejects at the proposals endpoint', async () => {
        mount();
        await act(async () => {
            fireEvent.click(screen.getByTestId('checkpoint-reject-prop-1'));
        });
        expect(fetchMock.mock.calls[0][0]).toBe('/api/t/acme/agent-proposals/prop-1/reject');
    });

    it('sends no digest for a CREATE, which has none to send', async () => {
        load({
            data: review({
                proposals: [proposal({ operation: 'CREATE', targetEntityId: null, diff: CREATE_DIFF })],
            }),
        });
        mount();
        await act(async () => {
            fireEvent.click(screen.getByTestId('checkpoint-approve-prop-1'));
        });
        expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({});
    });

    it('surfaces the server’s refusal rather than swallowing it', async () => {
        // Quarantine, expiry and a moved base all arrive this way, and each
        // message names what actually happened.
        fetchMock.mockResolvedValue({
            ok: false,
            json: async () => ({ error: { message: 'Proposal is already REJECTED' } }),
        });
        mount();
        await act(async () => {
            fireEvent.click(screen.getByTestId('checkpoint-approve-prop-1'));
        });
        expect(screen.getByText('Proposal is already REJECTED')).toBeInTheDocument();
        // The row STAYS — nothing was decided.
        expect(screen.getByTestId('checkpoint-proposal-prop-1')).toBeInTheDocument();
    });
});

describe('two success shapes, and they mean opposite things', () => {
    it('a first signature on a tiered proposal KEEPS the row and says what is missing', async () => {
        // A 200 whose body says AWAITING_APPROVAL records a signature and
        // applies nothing. Dropping the row would teach a reviewer that
        // clicking the button is what approval means.
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => ({
                status: 'AWAITING_APPROVAL',
                approvalsRecorded: 1,
                approvalsRequired: 2,
            }),
        });
        mount();
        await act(async () => {
            fireEvent.click(screen.getByTestId('checkpoint-approve-prop-1'));
        });
        expect(screen.getByTestId('checkpoint-proposal-prop-1')).toBeInTheDocument();
        expect(screen.getByText(/second reviewer must sign/)).toBeInTheDocument();
        // Nothing was settled, so nothing is refetched.
        expect(mutate).not.toHaveBeenCalled();
    });

    it('an ACCEPTED approval drops the row and refetches the run', async () => {
        // Approving the last proposal can settle the RUN, so the header is
        // stale the moment a decision lands — the server's answer, not this
        // component's arithmetic over it.
        mount();
        await act(async () => {
            fireEvent.click(screen.getByTestId('checkpoint-approve-prop-1'));
        });
        expect(screen.queryByTestId('checkpoint-proposal-prop-1')).toBeNull();
        expect(mutate).toHaveBeenCalled();
    });
});

describe('a FLAGGED proposal is not approvable from the map', () => {
    const FLAGGED = {
        guardVerdict: 'FLAGGED',
        guardRuleIds: ['injection.role_declaration'],
        guardInputDigest: 'sha256:aaaa',
    };

    it('withdraws approve and names the rules that fired', () => {
        // MORE friction than the queue, never less: there it is allowed behind
        // an explicit confirmation naming the rule ids, and a canvas must not
        // be the cheaper door to the decision the guard asked a human to look
        // hardest at.
        load({ data: review({ proposals: [proposal(FLAGGED)] }) });
        mount();
        expect(screen.queryByTestId('checkpoint-approve-prop-1')).toBeNull();
        expect(screen.getByTestId('checkpoint-flagged-prop-1')).toHaveTextContent(
            'injection.role_declaration',
        );
        expect(screen.getByTestId('checkpoint-proposal-prop-1')).toHaveAttribute(
            'data-guard-state',
            'FLAGGED',
        );
        // And the queue is reachable from here, because that is where it goes.
        expect(screen.getByTestId('checkpoint-open-queue')).toHaveAttribute(
            'href',
            '/t/acme/agents/proposals',
        );
    });

    it('still allows REJECT, which is always safe', () => {
        load({ data: review({ proposals: [proposal(FLAGGED)] }) });
        mount();
        expect(screen.getByTestId('checkpoint-reject-prop-1')).toBeInTheDocument();
    });

    it('a PRE-GUARD row is not treated as flagged', () => {
        // Verdict CLEAN with no digest means nobody scanned it — a different
        // fact from "scanned and clean", and not a reason to block approval.
        load({
            data: review({
                proposals: [proposal({ guardVerdict: 'CLEAN', guardInputDigest: null })],
            }),
        });
        mount();
        expect(screen.getByTestId('checkpoint-proposal-prop-1')).toHaveAttribute(
            'data-guard-state',
            'UNSCANNED',
        );
        expect(screen.getByTestId('checkpoint-approve-prop-1')).toBeInTheDocument();
    });
});

describe('a reader who may see the queue but not decide', () => {
    it('gets NO buttons, not disabled ones', () => {
        // Both usecases open with `assertCanWrite`. A disabled control still
        // says "there is something to do here" to everyone who cannot do it.
        load({ data: review() });
        mount({ canOperate: false });
        expect(screen.queryByTestId('checkpoint-approve-prop-1')).toBeNull();
        expect(screen.queryByTestId('checkpoint-reject-prop-1')).toBeNull();
        // And it says why, rather than leaving a gap.
        expect(screen.getByText(/not write access/)).toBeInTheDocument();
    });
});

describe('the run’s own window is shown, not discovered', () => {
    it('names when the approval window closes', () => {
        // A reviewer can approve every proposal here and still find the run
        // will not continue: `resumeWorkflowRun` refuses past this instant.
        load({ data: review({ approvalExpiresAt: '2026-10-15T12:00:00.000Z' }) });
        mount();
        expect(screen.getByTestId('checkpoint-window')).toHaveTextContent(
            '2026-10-15T12:00:00.000Z',
        );
    });
});
