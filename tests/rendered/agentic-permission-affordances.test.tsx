/**
 * A CONTROL YOU MAY NOT USE IS DISABLED AND EXPLAINED — never absent, never
 * enabled-then-403 (#2456).
 *
 * `/agents/proposals` and `/agents/runs` are gated on `admin.view`, while every
 * mutating usecase behind their buttons opens with `assertCanWrite(ctx)` — a
 * ROLE-TIER check, not a permissions-blob key. So a READER or AUDITOR holding
 * `admin.view` reached those pages and found Approve, Reject, Start, Resume and
 * Abort rendered enabled. They returned 403 on press, and an operator learned
 * which controls were theirs one refusal at a time.
 *
 * ── WHY "PRESENT" IS AN ASSERTION AND NOT AN OVERSIGHT ──────────────
 *
 * Hiding the buttons would also stop the 403s, and would be wrong. The detail
 * tabs settled this: "a greyed tab tells you the surface exists and is not
 * yours; a missing one would tell you the product does not have it." So every
 * case below asserts the control is IN THE DOCUMENT as well as disabled —
 * a suite that only checked `not.toBeEnabled()` would pass a page that had
 * quietly deleted them.
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
    const cache = new Map<string, unknown>();
    const make = (ns: string) => {
        const hit = cache.get(ns);
        if (hit) return hit;
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = lookup(ns, key);
            if (typeof v !== 'string') return key;
            if (params) for (const [p, val] of Object.entries(params)) {
                v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
            }
            return v;
        };
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns) };
});

jest.mock('@/lib/tenant-context-provider', () => ({
    ...jest.requireActual('@/lib/tenant-context-provider'),
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
    useTenantHref: () => (path: string) => `/t/acme${path}`,
}));

import { AgentRunsClient, type RunRow } from '@/app/t/[tenantSlug]/(app)/agents/runs/AgentRunsClient';

const RUN: RunRow = {
    id: 'run-1',
    workflowKey: 'nightly-review',
    status: 'RUNNING',
    stepCount: 3,
    costTokens: 1200,
    startedAt: '2026-09-01T10:00:00.000Z',
    completedAt: null,
    summary: null,
};

const WORKFLOWS = [{ key: 'nightly-review', name: 'Nightly review', description: 'Runs nightly' }];

function renderRuns(canOperate: boolean) {
    return render(
        <AgentRunsClient
            tenantSlug="acme"
            initialRuns={[RUN]}
            workflows={WORKFLOWS}
            canOperate={canOperate}
        />,
    );
}

describe('a reader sees the controls, disabled', () => {
    it('Abort is present and disabled', () => {
        renderRuns(false);
        const abort = screen.getByTestId('agent-run-abort-run-1');
        // BOTH claims. Present, because hiding it would say the product does
        // not have the feature; disabled, because pressing it would 403.
        expect(abort).toBeInTheDocument();
        expect(abort).toBeDisabled();
    });

    it('the reason is reachable, and names what is missing', () => {
        renderRuns(false);
        const gates = screen.getAllByTestId('permission-gated');
        expect(gates.length).toBeGreaterThan(0);
        // The wrapper span exists precisely because a DISABLED button fires no
        // pointer events — a tooltip bound straight to it would be unreachable
        // by exactly the people who need it.
        expect(within(gates[0]).getByRole('button')).toBeDisabled();
    });

    it('Start is present and disabled too', () => {
        renderRuns(false);
        const start = screen.getByRole('button', { name: /nightly review/i });
        expect(start).toBeInTheDocument();
        expect(start).toBeDisabled();
    });
});

describe('an operator who may act sees them enabled and unwrapped', () => {
    it('Abort is enabled', () => {
        renderRuns(true);
        expect(screen.getByTestId('agent-run-abort-run-1')).not.toBeDisabled();
    });

    it('adds no tooltip wrapper when the control IS allowed', () => {
        // The paired positive, and it is also a real property: every row carries
        // two or three of these, and a Radix subtree that can never fire is
        // still a Radix subtree.
        renderRuns(true);
        expect(screen.queryAllByTestId('permission-gated')).toHaveLength(0);
    });
});
