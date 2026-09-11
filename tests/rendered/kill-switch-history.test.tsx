/**
 * THE KILL-SWITCH TIMELINE RENDERS THE EVIDENCE (#2450).
 *
 * The API has returned `history` since the kill switch shipped and the client
 * TYPED it; no screen read it. The product could say "is anything stopped right
 * now" and had no answer to "was anything ever stopped, by whom, and why" —
 * which is the question an incident review asks, and the one 4/4's incident
 * report is built on.
 *
 * ── THE DRILL FILTER IS THE LOAD-BEARING ASSERTION ──────────────────
 *
 * A scheduled drill engages and lifts a real kill against a sentinel agent id
 * every night. Unfiltered, the timeline is one lifted row per tenant per day and
 * real incidents fall out of a bounded window within months. A timeline that is
 * technically complete and practically unreadable fails at the only job it has,
 * so the drill row is planted in the fixture BELOW a real one — if the filter is
 * removed, the count assertion catches it.
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

let answer: unknown = { inForce: [], history: [] };
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (key: unknown) =>
        key == null
            ? { data: undefined, isLoading: false, error: null, mutate: jest.fn() }
            : { data: answer, isLoading: false, error: null, mutate: jest.fn() },
}));

import { KillSwitchTimeline } from '@/app/t/[tenantSlug]/(app)/agents/[agentId]/tabs/KillSwitchTimeline';

const AGENT = 'agent-1';
const DRILL = '__kill-switch-drill-canary__';

function row(over: Record<string, unknown> = {}) {
    return {
        id: 'ks-1',
        scope: 'AGENT',
        agentId: AGENT,
        reason: 'runaway tool loop',
        engagedByUserId: 'u-1',
        engagedAt: '2026-09-10T08:00:00.000Z',
        liftedAt: null,
        liftedByUserId: null,
        liftReason: null,
        engagedBy: { id: 'u-1', name: 'Dana Okafor', email: 'dana@example.test' },
        liftedBy: null,
        ...over,
    };
}

afterEach(() => {
    answer = { inForce: [], history: [] };
});

describe('an engage/lift pair renders with actor, reason and timestamp', () => {
    it('names who stopped it, why, and who lifted it', () => {
        answer = {
            inForce: [],
            history: [
                row({
                    liftedAt: '2026-09-10T09:30:00.000Z',
                    liftedByUserId: 'u-2',
                    liftReason: 'loop fixed, redeployed',
                    liftedBy: { id: 'u-2', name: 'Sam Ruiz', email: 'sam@example.test' },
                }),
            ],
        };
        render(<KillSwitchTimeline agentId={AGENT} canRead />);

        expect(screen.getByText(/Dana Okafor/)).toBeInTheDocument();
        expect(screen.getByText(/runaway tool loop/)).toBeInTheDocument();
        expect(screen.getByText(/Sam Ruiz/)).toBeInTheDocument();
        expect(screen.getByText(/loop fixed, redeployed/)).toBeInTheDocument();
    });

    it('falls back to the id when the actor no longer exists', () => {
        // A deleted user must not blank the row. The stop still happened, and
        // losing the record because somebody left is the failure an audit trail
        // exists to prevent.
        answer = { inForce: [], history: [row({ engagedBy: null })] };
        render(<KillSwitchTimeline agentId={AGENT} canRead />);
        expect(screen.getByText(/u-1/)).toBeInTheDocument();
    });
});

describe('the nightly drill is filtered out', () => {
    it('shows the real kill and not the drill', () => {
        answer = {
            inForce: [],
            history: [
                row({ id: 'real', reason: 'real incident' }),
                row({ id: 'drill', agentId: DRILL, reason: 'scheduled drill' }),
            ],
        };
        render(<KillSwitchTimeline agentId={AGENT} canRead />);

        expect(screen.getAllByTestId('kill-switch-timeline-row')).toHaveLength(1);
        expect(screen.getByText(/real incident/)).toBeInTheDocument();
        expect(screen.queryByText(/scheduled drill/)).not.toBeInTheDocument();
    });
});

describe('a TENANT-scoped kill appears on this agent’s timeline', () => {
    it('includes a whole-workspace stop, which stopped this agent too', () => {
        // Filtering to `agentId === agentId` would hide the WIDEST stop the
        // product has from the page of every agent it affected.
        answer = {
            inForce: [],
            history: [row({ id: 'tenant-wide', scope: 'TENANT', agentId: null, reason: 'all agents halted' })],
        };
        render(<KillSwitchTimeline agentId={AGENT} canRead />);
        expect(screen.getByText(/all agents halted/)).toBeInTheDocument();
    });
});

describe('the empty and refused states are distinguishable', () => {
    it('says never-stopped rather than rendering a blank panel', () => {
        answer = { inForce: [], history: [] };
        render(<KillSwitchTimeline agentId={AGENT} canRead />);
        expect(screen.getByTestId('kill-switch-timeline-empty')).toBeInTheDocument();
    });

    it('renders NOTHING without the permission, rather than an empty timeline', () => {
        // The endpoint refuses the GET as well as the writes. A component that
        // fetched only to be refused writes a denial row on every mount, and an
        // empty timeline would claim this agent was never stopped on the
        // strength of a question that was never answered.
        const { container } = render(<KillSwitchTimeline agentId={AGENT} canRead={false} />);
        expect(container).toBeEmptyDOMElement();
    });
});
