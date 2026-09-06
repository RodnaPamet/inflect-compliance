/**
 * The agent-proposal review queue shows the reviewer WHAT they are approving.
 *
 * ═══ WHAT THIS FILE IS ABOUT ═══
 *
 * The product's safety story for agentic writes is "an agent never mutates a
 * record; every write routes through a proposal a human approves". Until this
 * change the queue rendered `JSON.stringify(payloadJson)` into a `<pre>` and put
 * an Approve button beside it. That is an honest rendering of a CREATE and a lie
 * about an UPDATE - the meaning of an update is the DIFFERENCE between the
 * payload and the record it targets, and a payload alone cannot express a
 * difference.
 *
 * Approving an opaque payload is not oversight. It is the mechanism by which
 * automation bias operates (OWASP ASI09): under volume a reviewer defaults to
 * trusting the proposer, and the queue then manufactures an auditable record of
 * consent nobody actually gave.
 *
 * The load-bearing assertion is the fourth describe block: THE APPROVE CONTROL
 * IS NOT REACHABLE BESIDE AN UNRENDERED DIFF. Everything else here is a
 * correctness check on the rendering; that one is the control itself.
 *
 * ═══ THE POPULATION ═══
 *
 * Five proposals, one per diff status, rendered in ONE list - because the
 * failure being guarded against is a per-card mix-up, and a test that renders
 * one card at a time cannot see a button attached to the wrong card's diff.
 */
import * as React from 'react';
import { render, screen, within, cleanup, act } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        refresh: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/agent-proposals',
    useSearchParams: () => new URLSearchParams(),
}));

// A MEMOISING next-intl mock. The naive form returns a fresh `t` on every
// render, which makes any component memoising on `t` re-render forever and the
// suite time out rather than fail.
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

import {
    AgentProposalsClient,
    type ProposalRow,
} from '@/app/t/[tenantSlug]/(app)/agent-proposals/AgentProposalsClient';
import { computeProposalDiff } from '@/lib/agentic/proposal-diff';

/** A CREATE proposal: no prior state, so the full content IS the diff. */
const CREATE_ROW: ProposalRow = {
    id: 'p-create',
    kind: 'RISK',
    operation: 'CREATE',
    status: 'PENDING',
    targetEntityId: null,
    rationale: 'Observed three failed backups in the last quarter.',
    proposedViaKeyId: 'key-abcdef12',
    createdAt: '2026-09-01T10:00:00.000Z',
    diff: computeProposalDiff({
        operation: 'CREATE',
        payloadJson: JSON.stringify({ title: 'Backup failure risk', impact: 8 }),
    }),
};

/** An UPDATE whose base was read and differs - the field-level before/after. */
const UPDATE_ROW: ProposalRow = {
    id: 'p-update',
    kind: 'RISK',
    operation: 'UPDATE',
    status: 'PENDING',
    targetEntityId: 'risk-77',
    rationale: 'Two new incidents raise the likelihood.',
    proposedViaKeyId: 'key-abcdef12',
    createdAt: '2026-09-01T11:00:00.000Z',
    diff: computeProposalDiff({
        operation: 'UPDATE',
        payloadJson: JSON.stringify({ title: 'Backup failure risk', likelihood: 9 }),
        target: { title: 'Backup failure risk', likelihood: 4 },
    }),
};

/** An UPDATE whose proposed values already match the record. */
const NO_CHANGES_ROW: ProposalRow = {
    id: 'p-nochanges',
    kind: 'CONTROL',
    operation: 'UPDATE',
    status: 'PENDING',
    targetEntityId: 'control-9',
    rationale: null,
    proposedViaKeyId: null,
    createdAt: '2026-09-01T12:00:00.000Z',
    diff: computeProposalDiff({
        operation: 'UPDATE',
        payloadJson: JSON.stringify({ name: 'Quarterly access review' }),
        target: { name: 'Quarterly access review' },
    }),
};

/** An UPDATE whose target has been deleted since the proposal was made. */
const TARGET_MISSING_ROW: ProposalRow = {
    id: 'p-orphan',
    kind: 'FINDING',
    operation: 'UPDATE',
    status: 'PENDING',
    targetEntityId: 'finding-gone',
    rationale: null,
    proposedViaKeyId: null,
    createdAt: '2026-09-01T13:00:00.000Z',
    diff: computeProposalDiff({
        operation: 'UPDATE',
        payloadJson: JSON.stringify({ severity: 'HIGH' }),
        target: null,
    }),
};

/** A proposal whose stored payload is not an object at all. */
const UNREADABLE_ROW: ProposalRow = {
    id: 'p-unreadable',
    kind: 'RISK',
    operation: 'CREATE',
    status: 'PENDING',
    targetEntityId: null,
    rationale: null,
    proposedViaKeyId: null,
    createdAt: '2026-09-01T14:00:00.000Z',
    diff: computeProposalDiff({ operation: 'CREATE', payloadJson: 'not json at all' }),
};

const ALL_ROWS = [CREATE_ROW, UPDATE_ROW, NO_CHANGES_ROW, TARGET_MISSING_ROW, UNREADABLE_ROW];

/** The three statuses whose diff is a computed answer, so approval stands. */
const REVIEWABLE_ROWS = [CREATE_ROW, UPDATE_ROW, NO_CHANGES_ROW];
/** The two whose diff could not be computed, so approval is withdrawn. */
const UNREVIEWABLE_ROWS = [TARGET_MISSING_ROW, UNREADABLE_ROW];

function renderQueue(rows: ProposalRow[] = ALL_ROWS) {
    return render(<AgentProposalsClient tenantSlug="acme" initialProposals={rows} />);
}

afterEach(cleanup);

describe('an UPDATE proposal renders field-level before/after', () => {
    it('shows the record current value beside the proposed one, per field', () => {
        renderQueue();

        const panel = screen.getByTestId(`proposal-diff-${UPDATE_ROW.id}`);
        expect(panel).toHaveAttribute('data-diff-status', 'UPDATE');

        // The changed field carries BOTH sides. Asserting only the proposed
        // value would pass against the old `<pre>` rendering, which is the
        // thing this file exists to refuse.
        const likelihood = within(panel).getByTestId(
            `proposal-diff-field-${UPDATE_ROW.id}-likelihood`,
        );
        expect(likelihood).toHaveAttribute('data-changed', 'true');
        expect(
            within(likelihood).getByTestId(`proposal-diff-before-${UPDATE_ROW.id}-likelihood`),
        ).toHaveTextContent('4');
        expect(
            within(likelihood).getByTestId(`proposal-diff-after-${UPDATE_ROW.id}-likelihood`),
        ).toHaveTextContent('9');

        // The unchanged field is present and MARKED unchanged rather than
        // hidden: a reviewer needs to see the whole proposed set, and a field
        // silently dropped is a field nobody agreed to leave alone.
        const title = within(panel).getByTestId(`proposal-diff-field-${UPDATE_ROW.id}-title`);
        expect(title).toHaveAttribute('data-changed', 'false');
        expect(
            within(title).getByTestId(`proposal-diff-before-${UPDATE_ROW.id}-title`),
        ).toHaveTextContent('Backup failure risk');
    });
});

describe('a CREATE proposal renders the full proposed content', () => {
    it('lists every field of the payload, with no before column', () => {
        renderQueue();

        const panel = screen.getByTestId(`proposal-diff-${CREATE_ROW.id}`);
        expect(panel).toHaveAttribute('data-diff-status', 'CREATE');

        const body = within(panel).getByTestId(`proposal-diff-content-${CREATE_ROW.id}`);
        expect(body).toHaveAttribute('data-variant', 'create');

        expect(
            within(body).getByTestId(`proposal-diff-after-${CREATE_ROW.id}-title`),
        ).toHaveTextContent('Backup failure risk');
        expect(
            within(body).getByTestId(`proposal-diff-after-${CREATE_ROW.id}-impact`),
        ).toHaveTextContent('8');

        // No before column for a create - there is no prior state, and an empty
        // one would read as "this field is currently blank".
        expect(
            within(panel).queryByTestId(`proposal-diff-before-${CREATE_ROW.id}-title`),
        ).toBeNull();
    });
});

describe("the agent's rationale renders beside the diff", () => {
    it('shows the rationale text for the proposal that carries one', () => {
        renderQueue();

        expect(screen.getByTestId(`proposal-rationale-${CREATE_ROW.id}`)).toHaveTextContent(
            'Observed three failed backups in the last quarter.',
        );
        expect(screen.getByTestId(`proposal-rationale-${UPDATE_ROW.id}`)).toHaveTextContent(
            'Two new incidents raise the likelihood.',
        );
        // A proposal with no rationale renders no rationale element, rather
        // than an empty one a reviewer might read as "the agent gave none" when
        // it is really "the field failed to render".
        expect(screen.queryByTestId(`proposal-rationale-${NO_CHANGES_ROW.id}`)).toBeNull();
    });
});

describe('the reviewer cannot reach APPROVE without a rendered diff', () => {
    /**
     * The load-bearing assertion of this file.
     *
     * It is written structurally - "every approve control is a DESCENDANT of a
     * panel that has rendered a diff body" - rather than as a per-card
     * presence check, because the failure it guards against is positional. An
     * approve button in the card header passes every "is Approve present"
     * assertion ever written and is exactly the problem restated.
     */
    it('every approve control sits inside a panel that rendered a diff body', () => {
        const { container } = renderQueue();

        const approves = Array.from(
            container.querySelectorAll('[data-testid^="proposal-approve-"]'),
        );
        // A positive companion: without this the whole check passes vacuously
        // on a queue that renders no approve control at all.
        expect(approves).toHaveLength(REVIEWABLE_ROWS.length);

        for (const control of approves) {
            const panel = control.closest('[data-diff-status]');
            expect(panel).not.toBeNull();
            // Inside a panel is not enough: the panel must have rendered actual
            // diff CONTENT. A panel that rendered only a status attribute and a
            // heading is still an opaque approval.
            const body = panel!.querySelector(
                '[data-testid^="proposal-diff-fields-"], [data-testid^="proposal-diff-content-"]',
            );
            expect(body).not.toBeNull();
            expect(body!.children.length).toBeGreaterThan(0);
        }
    });

    it('withdraws approval entirely when the diff could not be computed', () => {
        renderQueue();

        for (const row of UNREVIEWABLE_ROWS) {
            expect(screen.queryByTestId(`proposal-approve-${row.id}`)).toBeNull();
            expect(screen.getByTestId(`proposal-blocked-${row.id}`)).toBeInTheDocument();
            // Reject stays available. Refusing something you cannot read is
            // always safe, and it is the only way to clear such a row.
            expect(screen.getByTestId(`proposal-reject-${row.id}`)).toBeInTheDocument();
        }

        for (const row of REVIEWABLE_ROWS) {
            expect(screen.getByTestId(`proposal-approve-${row.id}`)).toBeInTheDocument();
            expect(screen.queryByTestId(`proposal-blocked-${row.id}`)).toBeNull();
        }
    });
});

describe('"nothing would change" is not shown as "we could not work it out"', () => {
    it('gives a computed no-change answer its own notice, and keeps it approvable', () => {
        renderQueue();

        const panel = screen.getByTestId(`proposal-diff-${NO_CHANGES_ROW.id}`);
        expect(panel).toHaveAttribute('data-diff-status', 'NO_CHANGES');

        // Its own element, not the refusal notice - a reviewer must be able to
        // tell "the answer is nothing" from "there is no answer".
        expect(
            within(panel).getByTestId(`proposal-diff-nochanges-${NO_CHANGES_ROW.id}`),
        ).toBeInTheDocument();
        expect(
            within(panel).queryByTestId(`proposal-diff-uncomputable-${NO_CHANGES_ROW.id}`),
        ).toBeNull();
    });

    it('names WHICH failure made the diff uncomputable, per proposal', () => {
        renderQueue();

        expect(
            screen.getByTestId(`proposal-diff-uncomputable-${TARGET_MISSING_ROW.id}`),
        ).toHaveAttribute('data-reason', 'TARGET_MISSING');
        expect(
            screen.getByTestId(`proposal-diff-uncomputable-${UNREADABLE_ROW.id}`),
        ).toHaveAttribute('data-reason', 'PAYLOAD_UNREADABLE');

        // And neither of them borrows the no-change notice, which would tell a
        // reviewer the opposite of the truth.
        for (const row of UNREVIEWABLE_ROWS) {
            expect(screen.queryByTestId(`proposal-diff-nochanges-${row.id}`)).toBeNull();
        }
    });
});

// ─── The other half of the automation-bias failure: the SUCCESS shape ───

describe('a first signature does not look like an approval', () => {
    afterEach(() => {
        cleanup();
        (global as { fetch?: unknown }).fetch = undefined;
    });

    it('keeps the row and says a second reviewer is required', async () => {
        // A tiered proposal's FIRST approval is a 200 whose body says
        // AWAITING_APPROVAL and applies nothing. The client used to check only
        // `res.ok` and drop the row — so the reviewer was told, by the queue
        // emptying, that the thing was approved. That is this epic's own failure
        // committed by its own UI, and it is invisible: no error, no counter,
        // nothing to notice.
        (global as { fetch?: unknown }).fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                status: 'AWAITING_APPROVAL',
                approvalsRecorded: 1,
                approvalsRequired: 2,
                createdEntityId: null,
            }),
        });

        render(<AgentProposalsClient tenantSlug="acme" initialProposals={[CREATE_ROW]} />);

        const approve = screen.getByTestId(`proposal-approve-${CREATE_ROW.id}`);
        await act(async () => {
            approve.click();
        });

        // The row SURVIVES…
        expect(screen.getByTestId(`proposal-approve-${CREATE_ROW.id}`)).toBeInTheDocument();
        // …and the reviewer is told what is still missing, with both numbers.
        const notice = screen.getByTestId('proposal-awaiting-second');
        expect(notice.textContent).toContain('1');
        expect(notice.textContent).toContain('2');
        // Not an error — nothing went wrong; the signature was recorded.
        expect(screen.queryByTestId('proposal-action-error')).toBeNull();
    });

    it('and a real approval DOES clear the row', async () => {
        // The companion. Without it the test above passes on a client that never
        // removes anything, which is a different broken queue.
        (global as { fetch?: unknown }).fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                status: 'ACCEPTED',
                createdEntityId: 'risk-1',
            }),
        });

        render(<AgentProposalsClient tenantSlug="acme" initialProposals={[CREATE_ROW]} />);

        await act(async () => {
            screen.getByTestId(`proposal-approve-${CREATE_ROW.id}`).click();
        });

        expect(screen.queryByTestId(`proposal-approve-${CREATE_ROW.id}`)).toBeNull();
        expect(screen.queryByTestId('proposal-awaiting-second')).toBeNull();
    });
});
