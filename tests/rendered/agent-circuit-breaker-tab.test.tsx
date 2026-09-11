/**
 * Render test for the agent CIRCUIT BREAKER tab (`CircuitBreakerTab`).
 *
 * The claim the whole file exists to defend: **a breaker that has never been
 * observed and a breaker that is healthy are different facts, and this panel
 * has to say which one it is holding.** `breaker: null` means no row was ever
 * written — nothing has watched this agent. Painting that as CLOSED / Watching
 * tells an operator a containment control is live behind an agent when no
 * observation exists behind it at all, and that is the reassurance-shaped
 * failure the whole subsystem is arranged against. So the null case is pinned
 * from both sides: the "never observed" copy is present, and every string that
 * would report it as judged-and-clear is absent.
 *
 * The reviewer of this tab asked for the second, quieter case by name, because
 * it is the branch THIS PANEL'S OWN close button creates and a regression there
 * is silent. `closeAgentCircuitBreaker` clears the streak and deliberately does
 * not rewrite the verdict fields, so a just-closed breaker is
 * `CLOSED + lastVerdict: 'TRIP' + anomalousStreak: 0`. Read as state alone that
 * is indistinguishable from healthy — the badge would go green one second after
 * the click while the fact row underneath still read "Last verdict: Tripped".
 * `posture()` resolves it to `closedAfterTrip` instead, and the two tests below
 * pin the copy on each side of that split so a collapse back to `watching`
 * cannot pass.
 *
 * The remaining blocks pin the other four sentences the surface could get
 * wrong, each of which would be wrong in the operator's favour:
 *
 *   • an OPEN breaker has to show WHAT tripped it and how far the streak ran
 *     against the configured threshold — the trip is not re-derivable from
 *     anywhere else on the page;
 *   • the two close reasons are not two spellings of "OK".
 *     `ACCEPTED_NEW_BASELINE` discards the agent's history, `RESOLVED` keeps
 *     it, and the difference has to be legible BEFORE the radio is picked —
 *     an operator choosing the more comfortable-sounding of two enum labels is
 *     exactly how an unrecoverable history wipe gets clicked;
 *   • the baseline block reports the DETECTOR'S look-back. It used to count
 *     the 48-row page the route returned while the detector read back over
 *     168, so the panel hedged it as a floor; the figures are now counted over
 *     the detector's own population, and the three things that make that true
 *     are pinned below — the sentence names the look-back rather than the page,
 *     the hour still filling is not presented as counted, and neither is the
 *     window awaiting a verdict, which is the row the detector JUDGES and is
 *     never part of the baseline it is judged against;
 *   • nothing here recovers on its own. There is no half-open probe, no
 *     timeout and no auto-close in the implementation, so a rogue agent could
 *     simply wait one out — every mention of automatic recovery on this
 *     surface has to be a denial of it.
 *
 * Every negative assertion below is paired with a positive one from the same
 * render, so a component that rendered nothing at all cannot satisfy it.
 */
import * as React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';

// next-intl is ESM (jest cannot parse it); mock it resolving real en.json
// values. `make` is MEMOISED per namespace — a fresh `t` identity on every
// render invalidates any `useMemo([t])` downstream, which turns a render into
// a loop rather than a failure.
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

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
    usePathname: () => '/t/acme/agents/agent-1',
    useSearchParams: () => new URLSearchParams(),
}));

const mockSWR = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (...args: unknown[]) => mockSWR(...args),
}));

import { CircuitBreakerTab } from '@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/CircuitBreakerTab';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { getPermissionsForRole } from '@/lib/permissions';
// The same formatter the row uses, so the row lookup below cannot drift from
// the rendering on a locale or format change.
import { formatDateTime } from '@/lib/format-date';

// ─── the real en.json copy, which is what the operator actually reads ───

const BREAKER = (
    require('../../messages/en.json') as {
        admin: { agentDetail: { breaker: Record<string, unknown> } };
    }
).admin.agentDetail.breaker;

/**
 * A leaf string from the breaker catalogue.
 *
 * Throws by name rather than returning `undefined`. A missing key handed to a
 * matcher produces "Unable to find an element with the text: undefined", which
 * says nothing about which key is absent — and next-intl renders a missing key
 * as its own dotted path, so a `toHaveTextContent('agentDetail.…')` assertion
 * would go GREEN on exactly the failure it is supposed to catch.
 */
const S = (key: string): string => {
    const value = BREAKER[key];
    if (typeof value !== 'string') {
        throw new Error(`messages/en.json has no admin.agentDetail.breaker.${key}`);
    }
    return value;
};
const BADGE = BREAKER.badge as Record<string, string>;
const TITLE = BREAKER.postureTitle as Record<string, string>;
const BODY = BREAKER.postureBody as Record<string, string>;

/** The same `{param}` substitution the component's `t(key, params)` performs. */
function fill(msg: string, params: Record<string, string | number>): string {
    let out = msg;
    for (const [p, v] of Object.entries(params)) {
        out = out.replace(new RegExp('\\{' + p + '\\}', 'g'), String(v));
    }
    return out;
}

// ─── fixtures ───

interface BreakerRow {
    state: string;
    lastVerdict: string | null;
    lastVerdictAt: string | null;
    lastEvaluatedWindow: string | null;
    anomalousStreak: number;
    streakSignals: string[];
    trippedAt: string | null;
    trippedWindow: string | null;
    trippedSignals: string[];
    baselineEpoch: string;
    closedAt: string | null;
    closedByUserId: string | null;
    closeReason: string | null;
}

interface WindowRow {
    windowStart: string;
    readCalls: number;
    proposeCalls: number;
    orchestrateCalls: number;
    toolNames: string[];
    anomalous: boolean;
    verdict: string | null;
}

interface BaselineBlock {
    windows: number;
    observations: number;
    requiredWindows: number;
    requiredObservations: number;
    lookbackWindows: number;
}

interface BreakerPayload {
    agentId: string;
    agentName: string;
    riskTier: string | null;
    breaker: BreakerRow | null;
    windows: WindowRow[];
    /** The hour still filling, from the server's clock. */
    currentWindowStart: string;
    /** The complete window awaiting a verdict, or `null` when none is. */
    pendingVerdictWindowStart: string | null;
    baseline: BaselineBlock;
    windowsToTrip: number;
    closeReasons: string[];
}

const REQUIRED_WINDOWS = 12;
const REQUIRED_OBSERVATIONS = 200;
/** `BASELINE_WINDOW_LIMIT` as the route reports it. */
const LOOKBACK_WINDOWS = 168;

/** Short of both thresholds, which is the ordinary state of a young agent. */
const SHORT_BASELINE: BaselineBlock = {
    windows: 4,
    observations: 37,
    requiredWindows: REQUIRED_WINDOWS,
    requiredObservations: REQUIRED_OBSERVATIONS,
    lookbackWindows: LOOKBACK_WINDOWS,
};

/**
 * Newest first, and internally consistent with `makeBreaker()` below: the 09:00
 * row is the hour STILL FILLING, so it carries no verdict — nothing has judged
 * it — and the breaker's `lastEvaluatedWindow` is that hour, meaning the 08:00
 * row is the one it judged and 'STEADY' is the verdict it got. A fixture with a
 * verdict on the filling hour renders a Steady badge beside "not counted yet",
 * a state the detector cannot produce.
 */
const WINDOWS: WindowRow[] = [
    {
        windowStart: '2026-09-01T09:00:00.000Z',
        readCalls: 9,
        proposeCalls: 2,
        orchestrateCalls: 0,
        toolNames: ['risk.read', 'evidence.read'],
        anomalous: false,
        verdict: null,
    },
    {
        windowStart: '2026-09-01T08:00:00.000Z',
        readCalls: 4,
        proposeCalls: 0,
        orchestrateCalls: 0,
        toolNames: ['risk.read'],
        anomalous: false,
        verdict: 'STEADY',
    },
    {
        windowStart: '2026-09-01T07:00:00.000Z',
        readCalls: 2,
        proposeCalls: 0,
        orchestrateCalls: 0,
        toolNames: [],
        anomalous: false,
        verdict: null,
    },
];

function makeBreaker(over: Partial<BreakerRow> = {}): BreakerRow {
    return {
        state: 'CLOSED',
        lastVerdict: 'STEADY',
        lastVerdictAt: '2026-09-01T09:00:00.000Z',
        lastEvaluatedWindow: '2026-09-01T09',
        anomalousStreak: 0,
        streakSignals: [],
        trippedAt: null,
        trippedWindow: null,
        trippedSignals: [],
        baselineEpoch: '2026-08-01T00:00:00.000Z',
        closedAt: null,
        closedByUserId: null,
        closeReason: null,
        ...over,
    };
}

function makePayload(over: Partial<BreakerPayload> = {}): BreakerPayload {
    return {
        agentId: 'agent-1',
        agentName: 'Reconciler',
        riskTier: 'HIGH',
        breaker: makeBreaker(),
        windows: WINDOWS,
        // The newest ledger row IS the hour still filling — the ordinary state
        // of a live agent, and the case the counted labels have to distinguish.
        currentWindowStart: WINDOWS[0].windowStart,
        // Nothing awaiting a verdict, which is what `lastEvaluatedWindow`
        // pointing at the current hour means: this hour's judgement has landed,
        // so the row it judged has joined the baseline and both complete rows
        // are Counted. The awaiting-verdict state is exercised through
        // `AWAITING_VERDICT` below.
        pendingVerdictWindowStart: null,
        baseline: SHORT_BASELINE,
        windowsToTrip: 3,
        closeReasons: ['ACCEPTED_NEW_BASELINE', 'RESOLVED'],
        ...over,
    };
}

/**
 * The state where the newest COMPLETE window has not been judged yet — which is
 * every moment between an agent's window closing and its next authorized call.
 * Internally consistent: the 08:00 row carries no verdict because none has been
 * reached for it, and the latch still points at the hour before.
 */
const AWAITING_VERDICT: Partial<BreakerPayload> = {
    windows: [WINDOWS[0], { ...WINDOWS[1], verdict: null }, WINDOWS[2]],
    pendingVerdictWindowStart: WINDOWS[1].windowStart,
    breaker: makeBreaker({
        lastEvaluatedWindow: '2026-09-01T07',
        lastVerdictAt: '2026-09-01T08:00:00.000Z',
    }),
};

/**
 * The ledger rows, newest first, with the row count pinned.
 *
 * The count is asserted HERE because every caller indexes into the result: a
 * panel that dropped or reordered a row would otherwise change what `rows[1]`
 * means and take the assertions with it.
 */
function ledgerRows(expected: number = WINDOWS.length): HTMLElement[] {
    const rows = within(screen.getByTestId('agent-breaker-windows-table')).getAllByRole(
        'listitem',
    );
    expect(rows).toHaveLength(expected);
    return rows;
}

const TENANT_CTX = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    tenantSlug: 'acme',
    tenantName: 'Acme',
    role: 'OWNER' as const,
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    appPermissions: getPermissionsForRole('OWNER'),
};

const mutate = jest.fn();

function renderTab(data: BreakerPayload, canCloseBreaker = false) {
    mockSWR.mockReturnValue({ data, error: undefined, isLoading: false, mutate });
    return render(
        <TenantProvider value={TENANT_CTX}>
            <CircuitBreakerTab
                tenantSlug="acme"
                agentId="agent-1"
                canCloseBreaker={canCloseBreaker}
            />
        </TenantProvider>,
    );
}

/** Everything on screen, portalled dialog included. */
const pageText = () => document.body.textContent ?? '';

/**
 * The row carrying the posture badge — the heading and the badge beside it.
 *
 * Scoped rather than queried page-wide because several badge labels are also
 * verdict labels (`Armed` is both a posture and a verdict), and the claim under
 * test is about the badge specifically.
 */
function badgeRow(): HTMLElement {
    return screen.getByRole('heading', { name: S('stateHeading') })
        .parentElement as HTMLElement;
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('a breaker that has never been observed is not a healthy breaker', () => {
    it('says nothing has watched this agent, and says none of the watching copy', () => {
        renderTab(makePayload({ breaker: null }));

        // Positive first, so every absence below is an absence from a page
        // that demonstrably rendered.
        expect(within(badgeRow()).getByText(BADGE.unobserved)).toBeInTheDocument();
        expect(screen.getByText(TITLE.unobserved)).toBeInTheDocument();
        expect(
            screen.getByText(
                fill(BODY.unobserved, {
                    windows: REQUIRED_WINDOWS,
                    observations: REQUIRED_OBSERVATIONS,
                    required: 3,
                }),
            ),
        ).toBeInTheDocument();

        // The false statement, in all three places it could be made. "Watching"
        // here would mean a containment control is live behind an agent that
        // has never been looked at once.
        expect(screen.queryByText(BADGE.watching)).not.toBeInTheDocument();
        expect(screen.queryByText(TITLE.watching)).not.toBeInTheDocument();
        expect(screen.queryByText(BODY.watching)).not.toBeInTheDocument();
        expect(screen.queryByText('Closed')).not.toBeInTheDocument();
    });

    it('renders no verdict facts at all, because there is no record to read them from', () => {
        renderTab(makePayload({ breaker: null }));

        // The rest of the panel is present — the Observability card and the
        // window strip both rendered — so the missing fact rows below are a
        // decision rather than a blank page.
        expect(screen.getByText(S('baselineHeading'))).toBeInTheDocument();
        expect(screen.getByText(S('windowsHeading'))).toBeInTheDocument();

        // Scoped to the state card, because the window strip legitimately
        // renders "Not judged yet" per unjudged window. A fact row saying it
        // would be a different claim: that a breaker record exists and has
        // simply not spoken yet.
        const stateCard = within(
            document.getElementById('agent-circuit-breaker')!
                .firstElementChild as HTMLElement,
        );
        expect(stateCard.getByText(TITLE.unobserved)).toBeInTheDocument();
        expect(stateCard.queryByText(S('factLastVerdict'))).not.toBeInTheDocument();
        expect(stateCard.queryByText(S('verdictPending'))).not.toBeInTheDocument();
        expect(stateCard.queryByText(S('factStreak'))).not.toBeInTheDocument();
        expect(stateCard.queryByText(S('factBaselineEpoch'))).not.toBeInTheDocument();
    });
});

describe('CLOSED after a hand close is not CLOSED and clear', () => {
    // The branch this panel's own close button creates:
    // `closeAgentCircuitBreaker` clears the streak and leaves the verdict
    // fields alone, so the row is CLOSED + TRIP + streak 0.
    const CLOSED_AFTER_TRIP = makeBreaker({
        state: 'CLOSED',
        lastVerdict: 'TRIP',
        anomalousStreak: 0,
        trippedAt: '2026-09-01T06:00:00.000Z',
        trippedWindow: '2026-09-01T06',
        trippedSignals: ['TOOL_MIX'],
        closedAt: '2026-09-01T07:30:00.000Z',
        closedByUserId: 'user-42',
        closeReason: 'RESOLVED',
    });

    it('renders the closed-after-trip copy and none of the watching copy', () => {
        renderTab(makePayload({ breaker: CLOSED_AFTER_TRIP }));

        expect(within(badgeRow()).getByText(BADGE.closedAfterTrip)).toBeInTheDocument();
        expect(screen.getByText(TITLE.closedAfterTrip)).toBeInTheDocument();
        expect(screen.getByText(BODY.closedAfterTrip)).toBeInTheDocument();

        // The absences. "No signal is firing and no streak is running" is true
        // of this row and still the wrong thing to say: nothing has judged the
        // agent since the trip, so there is no signal to fire.
        expect(screen.queryByText(BADGE.watching)).not.toBeInTheDocument();
        expect(screen.queryByText(TITLE.watching)).not.toBeInTheDocument();
        expect(screen.queryByText(BODY.watching)).not.toBeInTheDocument();
    });

    it('keeps the badge and the fact row telling the same story', () => {
        renderTab(makePayload({ breaker: CLOSED_AFTER_TRIP }));

        // The pairing is the point. A green badge over a "Last verdict:
        // Tripped" row is the panel contradicting itself one second after the
        // operator's own click.
        expect(within(badgeRow()).getByText(BADGE.closedAfterTrip)).toBeInTheDocument();
        expect(screen.getByText(S('factLastVerdict'))).toBeInTheDocument();
        expect(screen.getByText(S('verdictTrip'))).toBeInTheDocument();

        // And the close itself is on the record, by reason and by hand.
        expect(screen.getByText(S('factCloseReason'))).toBeInTheDocument();
        expect(screen.getByText(S('reasonResolvedShort'))).toBeInTheDocument();
        expect(screen.getByText('user-42')).toBeInTheDocument();
    });

    it('the watching copy is renderable — a genuinely steady breaker gets it', () => {
        // The positive control for the two absences above. Without this the
        // pair could pass because the watching strings are unreachable from
        // anywhere, rather than because this row is not watching.
        renderTab(makePayload({ breaker: makeBreaker({ lastVerdict: 'STEADY' }) }));

        expect(within(badgeRow()).getByText(BADGE.watching)).toBeInTheDocument();
        expect(screen.getByText(TITLE.watching)).toBeInTheDocument();
        expect(screen.getByText(BODY.watching)).toBeInTheDocument();
        expect(screen.queryByText(BADGE.closedAfterTrip)).not.toBeInTheDocument();
    });
});

describe('an open breaker shows what tripped it', () => {
    const OPEN = makeBreaker({
        state: 'OPEN',
        lastVerdict: 'TRIP',
        anomalousStreak: 3,
        streakSignals: ['PROPOSAL_RATE'],
        trippedAt: '2026-09-01T09:00:00.000Z',
        trippedWindow: '2026-09-01T09',
        trippedSignals: ['TOOL_MIX', 'REJECTION_RATE'],
    });

    it('names the signals that fired, in the block about the trip', () => {
        renderTab(makePayload({ breaker: OPEN, windowsToTrip: 3 }));

        const heading = screen.getByRole('heading', { name: S('trippedHeading') });
        const block = heading.closest('div') as HTMLElement;
        expect(block).not.toBeNull();

        // The trip is not re-derivable from anywhere else on the page: the
        // window strip carries verdicts, not the signal codes behind them.
        expect(within(block).getByText(S('signalToolMix'))).toBeInTheDocument();
        expect(within(block).getByText(S('signalRejectionRate'))).toBeInTheDocument();
        expect(within(block).getByText(S('factTrippedWindow'))).toBeInTheDocument();
        expect(within(block).getByText('2026-09-01T09')).toBeInTheDocument();

        // The unrecorded-signals fallback belongs to a different row and must
        // not be showing while real codes are on screen.
        expect(screen.queryByText(S('trippedSignalsUnrecorded'))).not.toBeInTheDocument();
    });

    it('reports the streak against the configured threshold, not on its own', () => {
        renderTab(makePayload({ breaker: OPEN, windowsToTrip: 3 }));

        expect(screen.getByText(S('factStreak'))).toBeInTheDocument();
        expect(
            screen.getByText(fill(S('streakCount'), { streak: 3, required: 3 })),
        ).toBeInTheDocument();
        expect(
            screen.getByText(fill(S('streakExplain'), { required: 3 })),
        ).toBeInTheDocument();
    });

    it('keeps streak and threshold in the right order when they differ', () => {
        // 3-of-3 above cannot tell a swapped pair apart. An ARMED breaker —
        // CLOSED, part-way to a trip — can, and it is the same `streakCount`
        // string doing the work.
        renderTab(
            makePayload({
                breaker: makeBreaker({ lastVerdict: 'ARMED', anomalousStreak: 2 }),
                windowsToTrip: 5,
            }),
        );

        expect(within(badgeRow()).getByText(BADGE.armed)).toBeInTheDocument();
        expect(screen.getByText('2 of 5 windows')).toBeInTheDocument();
        expect(screen.queryByText('5 of 2 windows')).not.toBeInTheDocument();
    });

    it('says the trip signals were not recorded rather than showing an empty strip', () => {
        renderTab(makePayload({ breaker: makeBreaker({ ...OPEN, trippedSignals: [] }) }));

        expect(screen.getByRole('heading', { name: S('trippedHeading') })).toBeInTheDocument();
        expect(screen.getByText(S('trippedSignalsUnrecorded'))).toBeInTheDocument();
        expect(screen.queryByText(S('signalToolMix'))).not.toBeInTheDocument();
    });
});

describe('the two close reasons are not two spellings of OK', () => {
    const OPEN_PAYLOAD = makePayload({
        breaker: makeBreaker({
            state: 'OPEN',
            lastVerdict: 'TRIP',
            anomalousStreak: 3,
            streakSignals: ['PROPOSAL_RATE'],
            trippedAt: '2026-09-01T09:00:00.000Z',
            trippedWindow: '2026-09-01T09',
            trippedSignals: ['TOOL_MIX'],
        }),
    });

    function openCloseDialog() {
        renderTab(OPEN_PAYLOAD, true);
        fireEvent.click(document.getElementById('agent-breaker-close-btn') as HTMLElement);
        expect(screen.getByText(S('closeTitle'))).toBeInTheDocument();
    }

    const pick = (code: string) =>
        fireEvent.click(document.getElementById(`agent-breaker-reason-${code}`) as HTMLElement);

    it('spells out what each reason does to the history, before either is picked', () => {
        openCloseDialog();

        expect(screen.getByText(S('reasonAcceptedTitle'))).toBeInTheDocument();
        expect(screen.getByText(S('reasonResolvedTitle'))).toBeInTheDocument();

        // The consequence, not the enum label. One discards the agent's
        // recorded history; the other keeps it. Both sentences are on screen
        // with nothing selected, which is what makes the choice informed.
        const accepted = screen.getByText(
            fill(S('reasonAcceptedBody'), {
                windows: REQUIRED_WINDOWS,
                observations: REQUIRED_OBSERVATIONS,
            }),
        );
        const resolved = screen.getByText(S('reasonResolvedBody'));
        expect(accepted).toBeInTheDocument();
        expect(resolved).toBeInTheDocument();
        expect(accepted.textContent).toMatch(/discards the recorded history/i);
        expect(resolved.textContent).toMatch(/keeps the history/i);
        expect(accepted.textContent).not.toEqual(resolved.textContent);
    });

    it('pre-selects neither, so the destructive one is never one click away', () => {
        openCloseDialog();

        const confirm = document.getElementById('agent-breaker-close-confirm') as HTMLButtonElement;
        expect(confirm).not.toBeNull();
        expect(confirm).toBeDisabled();
        // The first entry in the server's vocabulary is the discarding one, so
        // a defaulted radio would put the unrecoverable choice under the
        // confirm button on open.
        expect(screen.queryByText(S('rebaselineWarningTitle'))).not.toBeInTheDocument();
    });

    it('warns with the count it is about to drop once the discarding reason is picked', () => {
        openCloseDialog();
        pick('ACCEPTED_NEW_BASELINE');

        expect(screen.getByText(S('rebaselineWarningTitle'))).toBeInTheDocument();
        expect(
            screen.getByText(
                fill(S('rebaselineWarning'), {
                    count: SHORT_BASELINE.windows,
                    windows: REQUIRED_WINDOWS,
                    observations: REQUIRED_OBSERVATIONS,
                }),
            ),
        ).toBeInTheDocument();

        // And the button stops saying "Close breaker" — the label follows the
        // consequence, so the last thing read before committing names it.
        const confirm = document.getElementById('agent-breaker-close-confirm') as HTMLButtonElement;
        expect(confirm).toBeEnabled();
        expect(confirm.textContent).toContain(S('confirmAccepted'));
        expect(confirm.textContent).toMatch(/discard history/i);
    });

    it('does not carry the discard warning over to the reason that keeps history', () => {
        openCloseDialog();
        pick('ACCEPTED_NEW_BASELINE');
        expect(screen.getByText(S('rebaselineWarningTitle'))).toBeInTheDocument();

        pick('RESOLVED');
        // Positive companion: the dialog is still open and still offering both
        // reasons, so the warning's absence is a real retraction.
        expect(screen.getByText(S('reasonAcceptedTitle'))).toBeInTheDocument();
        expect(screen.queryByText(S('rebaselineWarningTitle'))).not.toBeInTheDocument();

        const confirm = document.getElementById('agent-breaker-close-confirm') as HTMLButtonElement;
        expect(confirm).toBeEnabled();
        expect(confirm.textContent).toContain(S('confirmResolved'));
        expect(confirm.textContent).not.toMatch(/discard history/i);
    });
});

describe('the baseline block reports the detector look-back, not the page', () => {
    it('scopes the sentence to the look-back the payload advertises', () => {
        renderTab(makePayload());

        // The count in the sentence is the look-back the `baseline` block
        // declares — the same number the detector reads back over.
        const explain = screen.getByText(
            fill(S('baselineExplainCounted'), { count: LOOKBACK_WINDOWS }),
        );
        expect(explain).toBeInTheDocument();
        // And NOT the ledger page beneath it, which is what the figure used to
        // be counted over. Asserted through the same catalogue string with the
        // other number substituted, so this cannot pass on a wording change.
        expect(pageText()).not.toContain(
            fill(S('baselineExplainCounted'), { count: WINDOWS.length }),
        );

        // The Fact tile beside it states the same number, from the same field.
        // Two renderings of 168 on one card have to come from one source: a
        // tile reading the page while the sentence reads the look-back is the
        // original defect with a smaller blast radius. Only the POSITIVE here —
        // `baselineLookbackValue` is "{count} windows", so the page-scoped
        // negative would match `streakCount`'s "0 of 3 windows" and assert
        // nothing about this tile at all.
        expect(
            screen.getByText(fill(S('baselineLookbackValue'), { count: LOOKBACK_WINDOWS })),
        ).toBeInTheDocument();
    });

    it('reports a short count without scoping it to a page', () => {
        renderTab(makePayload());

        // Rendered with NO count parameter: the sentence is about the
        // detector's figures now, and a page size has nothing to qualify.
        expect(screen.getByText(S('baselineCountedShort'))).toBeInTheDocument();
        expect(screen.queryByText(S('baselineCountedEnough'))).not.toBeInTheDocument();
        // NOT `not.toContain(fill(S('baselineCountedShort'), { count: 3 }))`.
        // `fill` is a substitution, so on a value with no `{count}` it is the
        // IDENTITY — that negative asserted the absence of the very sentence
        // the line above requires to be present, and passed only while the
        // catalogue still carried the placeholder. The page-scoping claim is
        // pinned where it can actually be pinned: no number the panel could
        // have taken off the ledger page appears in the sentence at all. That
        // the CATALOGUE has dropped the placeholder is a separate assertion,
        // in 'renders this lane's merged catalogue values' below, so this test
        // stays a statement about the rendering.
        const short = screen.getByText(S('baselineCountedShort'));
        expect(short.textContent).not.toMatch(new RegExp(`\\b${WINDOWS.length}\\b`));

        // The retired copy, by its own words. It read "none is judged", which
        // the panel cannot know from arithmetic: judgement is lazy, so a
        // sufficient count is what the NEXT verdict will find, not a verdict.
        expect(pageText()).not.toMatch(/none is judged/i);
    });

    it('stops presenting the pair as progress once the threshold is met', () => {
        renderTab(
            makePayload({
                baseline: { ...SHORT_BASELINE, windows: 30, observations: 900 },
            }),
        );

        expect(screen.getByText(S('baselineCountedEnough'))).toBeInTheDocument();
        expect(screen.queryByText(S('baselineCountedShort'))).not.toBeInTheDocument();

        // "30 of 12" read as a progress bar long after it had stopped being one.
        expect(
            screen.getByText(fill(S('baselineMet'), { have: 30, required: REQUIRED_WINDOWS })),
        ).toBeInTheDocument();
        expect(
            screen.queryByText(fill(S('baselineProgress'), { have: 30, required: REQUIRED_WINDOWS })),
        ).not.toBeInTheDocument();
    });

    it('does not present the hour still filling as counted', () => {
        renderTab(makePayload());

        const rows = ledgerRows();

        // The complete windows still say Counted — without this the assertion
        // below would pass on a panel that had simply stopped labelling rows.
        expect(within(rows[1]).getByText(S('countedYes'))).toBeInTheDocument();
        expect(within(rows[2]).getByText(S('countedYes'))).toBeInTheDocument();
        // The filling hour does not, because the baseline figures above do not
        // count it: labelling it Counted would leave an operator adding up one
        // more counted row than the panel reports.
        expect(within(rows[0]).queryByText(S('countedYes'))).not.toBeInTheDocument();
        // It is still IN the ledger — the row exists and carries its activity.
        expect(within(rows[0]).getByText(formatDateTime(WINDOWS[0].windowStart))).toBeInTheDocument();
    });

    it('does not present the window awaiting a verdict as counted', () => {
        renderTab(makePayload(AWAITING_VERDICT));

        const rows = ledgerRows();

        // The oldest row is Counted, and it is the positive companion: without
        // it the negative below would pass on a panel that had simply stopped
        // labelling rows at all.
        expect(within(rows[2]).getByText(S('countedYes'))).toBeInTheDocument();
        // The newest COMPLETE row is not, because it is the row the detector
        // judges next and no window is part of the baseline it is judged
        // against. Counting it is what let the panel report "12 of 12" at
        // exactly `MIN_BASELINE_WINDOWS` while the detector's next verdict was
        // NO_BASELINE.
        expect(within(rows[1]).queryByText(S('countedYes'))).not.toBeInTheDocument();
        // Still in the ledger, and still carrying the badge for a window
        // nothing has judged — the two halves of the row agree.
        expect(
            within(rows[1]).getByText(formatDateTime(WINDOWS[1].windowStart)),
        ).toBeInTheDocument();
        expect(within(rows[1]).getByText(S('verdictPending'))).toBeInTheDocument();
    });

    it('labels the whole ledger from the catalogue, not from a raw key path', () => {
        // RED until this lane's `messages/en.json` values are merged, and that
        // is the point of it. `countedPending` and `countedAwaitingVerdict` are
        // new keys reached through an exhaustive switch of literal `t('…')`
        // calls, so `tests/guards/i18n-keys-resolve.test.ts` names them too —
        // but a guard over `src` cannot see whether the ROW an operator reads
        // ends up as a sentence or as `admin.agentDetail.breaker.countedPending`.
        // This is that check, at the rendering.
        renderTab(makePayload(AWAITING_VERDICT));

        const rawKeyPaths = within(screen.getByTestId('agent-breaker-windows-table'))
            .queryAllByText(/agentDetail\.breaker\./)
            .map((el) => el.textContent);

        expect(rawKeyPaths).toEqual([]);
    });

    it('renders this lane\'s merged catalogue values, not the stale ones', () => {
        // RED until the same merge, for the two VALUE changes the component
        // now depends on. Collected rather than asserted one by one, so a
        // single run names everything the catalogue is still missing instead of
        // stopping at the first line.
        const stale: string[] = [];
        if (/\{count\}/.test(S('baselineCountedShort'))) {
            stale.push(
                'baselineCountedShort still carries {count} — the component passes no ' +
                    'count, so next-intl leaves the placeholder on screen for the operator',
            );
        }
        if (/floor rather than its exact population/i.test(S('baselineExplainCounted'))) {
            stale.push(
                'baselineExplainCounted still hedges the figures as a floor — they are ' +
                    "the detector's own population now, and the hedge was the fix's premise",
            );
        }

        expect(stale).toEqual([]);
    });
});

describe('nothing on this surface recovers on its own', () => {
    /** Sentences of the rendered page that mention `re`. */
    const sentencesMentioning = (re: RegExp): string[] =>
        pageText()
            .split(/(?<=[.?!])/)
            .map((s) => s.trim())
            .filter((s) => re.test(s));

    const NEGATED = /\b(no|not|nothing|never|neither|none)\b/i;

    it('states the denial explicitly on an open breaker', () => {
        renderTab(
            makePayload({
                breaker: makeBreaker({
                    state: 'OPEN',
                    lastVerdict: 'TRIP',
                    anomalousStreak: 3,
                    trippedAt: '2026-09-01T09:00:00.000Z',
                    trippedWindow: '2026-09-01T09',
                    trippedSignals: ['TOOL_MIX'],
                }),
            }),
            true,
        );

        const open = screen.getByText(
            fill(BODY.open, {
                windows: REQUIRED_WINDOWS,
                observations: REQUIRED_OBSERVATIONS,
                required: 3,
            }),
        );
        expect(open).toBeInTheDocument();
        // An agent that has gone rogue could wait out anything that expires,
        // so all three mechanisms are denied by name.
        expect(open.textContent).toMatch(/no timeout/i);
        expect(open.textContent).toMatch(/no trial call/i);
        expect(open.textContent).toMatch(/no automatic recovery/i);
        expect(open.textContent).toMatch(/until an administrator closes it/i);
    });

    it('never mentions automatic recovery except to deny it', () => {
        renderTab(
            makePayload({
                breaker: makeBreaker({
                    state: 'OPEN',
                    lastVerdict: 'TRIP',
                    anomalousStreak: 3,
                    trippedAt: '2026-09-01T09:00:00.000Z',
                    trippedWindow: '2026-09-01T09',
                    trippedSignals: ['TOOL_MIX'],
                }),
            }),
            true,
        );
        // Open the close dialog too: `closePrompt` is the other place on this
        // surface that has to make the promise, and it is the last thing read
        // before the agent is let go.
        fireEvent.click(document.getElementById('agent-breaker-close-btn') as HTMLElement);
        expect(screen.getByText(S('closePrompt'))).toBeInTheDocument();

        // The positive companion for the scan: the words ARE on screen, so an
        // empty page cannot pass this by mentioning nothing.
        const mentions = sentencesMentioning(/automatic|timeout|recover/i);
        expect(mentions.length).toBeGreaterThan(0);
        for (const sentence of mentions) {
            expect(sentence).toMatch(NEGATED);
        }

        // The vocabulary of a breaker that DOES come back on its own. None of
        // it can appear here, because none of it exists in the implementation.
        const text = pageText();
        expect(text).not.toMatch(/half[-\s]?open/i);
        expect(text).not.toMatch(/\bre-?opens?\b/i);
        expect(text).not.toMatch(/\bcool[-\s]?(down|off)\b/i);
        expect(text).not.toMatch(/\btemporarily\b/i);
        expect(text).not.toMatch(/\bretr(y|ies|ying)\b/i);
        expect(text).not.toMatch(/\bwill (close|clear|reset|recover|reopen)\b/i);
        expect(text).not.toMatch(/\bclos(e|es|ing) (itself|automatically|on its own)\b/i);
    });

    it('tells a principal who cannot close one that the control exists and is not theirs', () => {
        renderTab(
            makePayload({
                breaker: makeBreaker({
                    state: 'OPEN',
                    lastVerdict: 'TRIP',
                    anomalousStreak: 3,
                    trippedAt: '2026-09-01T09:00:00.000Z',
                    trippedWindow: '2026-09-01T09',
                    trippedSignals: ['TOOL_MIX'],
                }),
            }),
            false,
        );

        // Stated rather than hidden — a missing button on the only surface
        // that can let the agent act again reads as "nothing can be done".
        expect(screen.getByText(S('closeRestricted'))).toBeInTheDocument();
        expect(document.getElementById('agent-breaker-close-btn')).toBeNull();
    });
});
