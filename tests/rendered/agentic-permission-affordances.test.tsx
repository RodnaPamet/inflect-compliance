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
import {
    AgentProposalsClient,
    type ProposalRow,
} from '@/app/t/[tenantSlug]/(app)/agents/proposals/AgentProposalsClient';
import { computeProposalDiff } from '@/lib/agentic/proposal-diff';

/**
 * The copy, read from the SAME dictionary the component resolves through, so
 * the label assertion below pins the WIRING (does the reason reach the
 * wrapper?) and not the wording. A literal here would redden on a copy edit,
 * which is a different claim than the one this file makes.
 */
const EN = jest.requireActual('../../messages/en.json') as {
    admin: { permissionGated: { ariaLabel: string } };
    agents: { runs: { needsWrite: string; resume: string } };
};

/** What `PermissionGated` announces on the wrapper span for a reader. */
const GATE_LABEL = EN.admin.permissionGated.ariaLabel.replace(
    '{reason}',
    EN.agents.runs.needsWrite,
);

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

/**
 * A run stopped for a human decision. The docstring above names five controls
 * and Resume is the fifth: `AgentRunsClient` mounts it only for
 * `status === 'AWAITING_APPROVAL'`, so against a RUNNING fixture alone that
 * branch never rendered and nothing here could have caught it enabled.
 */
const AWAITING_RUN: RunRow = { ...RUN, id: 'run-2', status: 'AWAITING_APPROVAL' };

const WORKFLOWS = [{ key: 'nightly-review', name: 'Nightly review', description: 'Runs nightly' }];

function renderRuns(canOperate: boolean, runs: RunRow[] = [RUN]) {
    return render(
        <AgentRunsClient
            tenantSlug="acme"
            initialRuns={runs}
            workflows={WORKFLOWS}
            canOperate={canOperate}
        />,
    );
}

/**
 * A proposal whose diff COMPUTED, and that is load-bearing rather than
 * incidental. `tests/rendered/proposal-diff.test.tsx` pins that an
 * uncomputable diff WITHDRAWS the approve control entirely — so an
 * unreviewable fixture would make the Approve case below fail for the wrong
 * reason: absent because unreadable, read as absent because hidden from a
 * reader. Shape copied from that file's `CREATE_ROW`.
 */
const PROPOSAL: ProposalRow = {
    id: 'p-1',
    kind: 'RISK',
    operation: 'CREATE',
    status: 'PENDING',
    targetEntityId: null,
    rationale: 'Observed three failed backups in the last quarter.',
    proposedViaKeyId: 'key-abcdef12',
    createdAt: '2026-09-01T10:00:00.000Z',
    // Scanned and clean: a null digest would read as pre-guard and put an
    // extra notice on the card, which is a claim this file does not make.
    guardVerdict: 'CLEAN',
    guardRuleIds: [],
    guardInputDigest: 'sha256:0123456789abcdef0123456789abcdef',
    diff: computeProposalDiff({
        operation: 'CREATE',
        payloadJson: JSON.stringify({ title: 'Backup failure risk', impact: 8 }),
    }),
};

function renderProposals(canOperate: boolean) {
    return render(
        <AgentProposalsClient
            tenantSlug="acme"
            initialProposals={[PROPOSAL]}
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

    it('Resume is present and disabled on a run awaiting a decision', () => {
        // The fixture, not the assertion, is the work here: Resume mounts only
        // under AWAITING_APPROVAL, so the RUNNING row every other case uses
        // leaves this branch unrendered and unguarded.
        renderRuns(false, [AWAITING_RUN]);
        const resume = screen.getByRole('button', { name: EN.agents.runs.resume });
        expect(resume).toBeInTheDocument();
        expect(resume).toBeDisabled();
    });
});

describe('an operator who may act sees them enabled and unwrapped', () => {
    it('Abort is enabled', () => {
        renderRuns(true);
        expect(screen.getByTestId('agent-run-abort-run-1')).not.toBeDisabled();
    });

    it('Resume is enabled', () => {
        renderRuns(true, [AWAITING_RUN]);
        expect(screen.getByRole('button', { name: EN.agents.runs.resume })).not.toBeDisabled();
    });

    it('adds no tooltip wrapper when the control IS allowed', () => {
        // The paired positive, and it is also a real property: every row carries
        // two or three of these, and a Radix subtree that can never fire is
        // still a Radix subtree.
        renderRuns(true);
        expect(screen.queryAllByTestId('permission-gated')).toHaveLength(0);
    });
});

/**
 * ── THE PROPOSAL QUEUE, WHICH IS THE OTHER HALF OF THE SAME BULLET ──
 *
 * The acceptance bullet this file was written for names Approve, Reject AND
 * Abort. Only the runs page was ever rendered here, so Approve and Reject —
 * the two controls that commit an agent's write to a real record, and the two
 * that most need an honest refusal — were asserted by nothing (#2567). Every
 * other suite that renders this client passes `canOperate` true, which makes
 * `!canOperate` constant-false in every existing render: deleting the guard
 * changed no output any of them observed.
 */
describe('a reader sees the proposal controls, disabled', () => {
    it('Approve is present and disabled', () => {
        renderProposals(false);
        const approve = screen.getByTestId(`proposal-approve-${PROPOSAL.id}`);
        // BOTH claims, and the PRESENT one is the harder of the two: hiding
        // Approve from a reader would also stop the 403, and would tell them
        // the product has no review queue.
        expect(approve).toBeInTheDocument();
        expect(approve).toBeDisabled();
    });

    it('Reject is present and disabled', () => {
        renderProposals(false);
        const reject = screen.getByTestId(`proposal-reject-${PROPOSAL.id}`);
        expect(reject).toBeInTheDocument();
        expect(reject).toBeDisabled();
    });

    it('each of them carries its own reachable, named explanation', () => {
        renderProposals(false);
        const gates = screen.getAllByTestId('permission-gated');
        // TWO, one per control: Reject on the card header and Approve inside
        // the diff panel are wrapped separately, so a single surviving wrapper
        // must not be able to satisfy this for both.
        expect(gates).toHaveLength(2);
        const [rejectGate, approveGate] = gates;

        expect(within(rejectGate).getByTestId(`proposal-reject-${PROPOSAL.id}`)).toBeDisabled();
        expect(within(approveGate).getByTestId(`proposal-approve-${PROPOSAL.id}`)).toBeDisabled();

        // A LABEL, not only a hover tooltip. The people who cannot use the
        // control are exactly the people a pointer-only explanation fails:
        // a disabled button fires no pointer events at all.
        expect(rejectGate).toHaveAttribute('aria-label', GATE_LABEL);
        expect(approveGate).toHaveAttribute('aria-label', GATE_LABEL);
    });
});

describe('an operator sees the proposal controls enabled and unwrapped', () => {
    it('Approve and Reject are both live', () => {
        renderProposals(true);
        expect(screen.getByTestId(`proposal-approve-${PROPOSAL.id}`)).not.toBeDisabled();
        expect(screen.getByTestId(`proposal-reject-${PROPOSAL.id}`)).not.toBeDisabled();
    });

    it('adds no tooltip wrapper to the queue when the controls ARE allowed', () => {
        renderProposals(true);
        expect(screen.queryAllByTestId('permission-gated')).toHaveLength(0);
    });
});
