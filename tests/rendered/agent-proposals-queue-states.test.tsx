/**
 * THE PROPOSALS QUEUE SAYS WHERE EACH DECISION STANDS, IN WORDS (#4473).
 *
 * Each block is one of the issue's findings, asserted on the rendered page:
 *
 *   · a four-eyes or closed-window refusal shows the server's sentence, never
 *     a code;
 *   · a card says when its window closes, and a card whose window has closed
 *     says so and offers neither Approve nor Reject;
 *   · a proposal holding one of two approvals says so from the DATA, on first
 *     render — not only after the click that recorded it — and the approver
 *     who signed is not offered a second click;
 *   · the queue says when it is showing only the first page of the backlog;
 *   · kinds and field names are labels, not stored codes;
 *   · the key a proposal came through is named by the prefix the API Keys page
 *     shows, never by a slice of its internal id;
 *   · a bulk reject's report names the cause of each skip it hit.
 *
 * Text is read from `messages/en.json` through `en()` rather than written out
 * here, so a copy edit does not break the test and a missing key does.
 */
import * as React from 'react';
import { render, screen, within, act, cleanup, fireEvent } from '@testing-library/react';

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, Record<string, unknown>>;
    const resolve = (ns: string, key: string): unknown =>
        key
            .split('.')
            .reduce<unknown>(
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
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/agents/proposals',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
    useTenantHref: () => (path: string) => `/t/acme${path}`,
}));

// Toasts are asserted by what they were asked to say; the undo toast runs its
// action at once, because the 5-second window is the hook's own concern.
const toastInfo = jest.fn();
jest.mock('@/components/ui/hooks', () => {
    const actual = jest.requireActual('@/components/ui/hooks');
    return {
        ...actual,
        useMediaQuery: () => ({ device: 'desktop', width: 1280, height: 800, isMobile: false, isDesktop: true }),
        useToast: () => ({ error: jest.fn(), success: jest.fn(), warning: jest.fn(), info: toastInfo }),
        useToastWithUndo: () => (input: { action: () => Promise<unknown>; onError?: (e: unknown) => void }) => {
            void Promise.resolve()
                .then(() => input.action())
                .catch((e) => input.onError?.(e));
            return 'undo-toast';
        },
    };
});

import {
    AgentProposalsClient,
    type ProposalRow,
} from '@/app/t/[tenantSlug]/(app)/agents/proposals/AgentProposalsClient';
import { computeProposalDiff } from '@/lib/agentic/proposal-diff';
import { formatDateTime } from '@inflect/ui/lib/format-date';

function en(dotted: string): string {
    const messages = require('../../messages/en.json') as Record<string, unknown>;
    const value = `agents.${dotted}`
        .split('.')
        .reduce<unknown>(
            (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
            messages,
        );
    if (typeof value !== 'string') throw new Error(`messages/en.json has no string at agents.${dotted}`);
    return value;
}

const EXPIRES = '2026-11-05T10:00:00.000Z';

function row(overrides: Partial<ProposalRow> = {}): ProposalRow {
    return {
        id: 'p1',
        kind: 'RISK',
        operation: 'CREATE',
        status: 'PENDING',
        targetEntityId: null,
        rationale: null,
        proposedViaKeyId: null,
        proposedViaKeyPrefix: null,
        createdAt: '2026-10-29T10:00:00.000Z',
        expiresAt: EXPIRES,
        windowClosed: false,
        approvalsRecorded: 0,
        signedByViewer: false,
        runId: null,
        stepSeq: null,
        guardVerdict: 'CLEAN',
        guardRuleIds: [],
        guardInputDigest: 'sha256:0123456789abcdef',
        diff: computeProposalDiff({
            operation: 'CREATE',
            payloadJson: JSON.stringify({ title: 'Backup failure risk', treatmentNotes: 'Add a second site.' }),
        }),
        ...overrides,
    };
}

function renderQueue(rows: ProposalRow[], props: { canOperate?: boolean; truncated?: boolean } = {}) {
    return render(
        <AgentProposalsClient
            tenantSlug="acme"
            initialProposals={rows}
            canOperate={props.canOperate ?? true}
            truncated={props.truncated}
        />,
    );
}

function mockFetch(response: { ok: boolean; status?: number; body: unknown }) {
    const fetchMock = jest.fn().mockResolvedValue({
        ok: response.ok,
        status: response.status ?? (response.ok ? 200 : 403),
        json: async () => response.body,
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
}

afterEach(() => {
    cleanup();
    jest.clearAllMocks();
});

// ─── refusals ───────────────────────────────────────────────────────────────

describe('a refusal shows the server’s sentence', () => {
    const FOUR_EYES =
        'You have already approved this proposal. A second approval has to come from a different person.';

    it('a four-eyes refusal reads as the sentence, not the code', async () => {
        mockFetch({
            ok: false,
            body: { error: { code: 'FORBIDDEN', message: FOUR_EYES, details: { reason: 'agent_proposal_four_eyes' } } },
        });
        renderQueue([row()]);
        await act(async () => {
            screen.getByTestId('proposal-approve-p1').click();
        });
        const error = screen.getByTestId('proposal-action-error');
        expect(error).toHaveTextContent(FOUR_EYES);
        expect(error.textContent).not.toContain('agent_proposal');
    });

    it('a refusal with no message falls back to the page’s own failure text', async () => {
        mockFetch({ ok: false, status: 500, body: { error: { code: 'INTERNAL' } } });
        renderQueue([row()]);
        await act(async () => {
            screen.getByTestId('proposal-reject-p1').click();
        });
        expect(screen.getByTestId('proposal-action-error')).toHaveTextContent(en('proposals.rejectFailed'));
    });
});

// ─── the review window ──────────────────────────────────────────────────────

describe('the review window', () => {
    it('an open card says when its window closes', () => {
        renderQueue([row()]);
        expect(screen.getByTestId('proposal-meta-p1')).toHaveTextContent(
            en('proposals.decideBy').replace('{date}', formatDateTime(EXPIRES)).trim(),
        );
        expect(screen.queryByTestId('proposal-window-closed-p1')).toBeNull();
    });

    it('a closed window is said, and nothing offers a decision', () => {
        renderQueue([row({ windowClosed: true })]);
        expect(screen.getByTestId('proposal-window-closed-p1')).toHaveTextContent(
            en('proposals.window.closedNotice').replace('{date}', formatDateTime(EXPIRES)),
        );
        expect(screen.getByTestId('proposal-window-closed-badge-p1')).toHaveTextContent(en('proposals.window.closed'));
        // Neither decision is offered: the server would refuse both.
        expect(screen.queryByTestId('proposal-approve-p1')).toBeNull();
        expect(screen.queryByTestId('proposal-reject-p1')).toBeNull();
        expect(screen.getByTestId('proposal-window-closed-action-p1')).toBeInTheDocument();
        // And it cannot be ticked into a bulk reject that would only skip it.
        expect(screen.getByTestId('proposal-select-p1')).toBeDisabled();
        // The deadline is not repeated as a "decide by" in the meta line.
        expect(screen.getByTestId('proposal-meta-p1').textContent).not.toContain('decide by');
    });

    it('a row with no recorded deadline shows none and stays decidable', () => {
        renderQueue([row({ expiresAt: null })]);
        expect(screen.getByTestId('proposal-meta-p1').textContent).not.toContain('decide by');
        expect(screen.getByTestId('proposal-approve-p1')).toBeEnabled();
        expect(screen.getByTestId('proposal-reject-p1')).toBeEnabled();
    });
});

// ─── the second approver ────────────────────────────────────────────────────

describe('a proposal holding one of its two approvals', () => {
    it('says so on first render, from the data', () => {
        renderQueue([row({ approvalsRecorded: 1 })]);
        expect(screen.getByTestId('proposal-awaiting-second-badge-p1')).toHaveTextContent(en('proposals.awaitingSecond'));
        // Somebody else signed: this viewer is still offered the second approval.
        expect(screen.getByTestId('proposal-approve-p1')).toBeEnabled();
    });

    it('the approver who signed is told so and not offered a second click', () => {
        renderQueue([row({ approvalsRecorded: 1, signedByViewer: true })]);
        expect(screen.getByTestId('proposal-signed-by-you-p1')).toHaveTextContent(en('proposals.signedByYou'));
        expect(screen.queryByTestId('proposal-approve-p1')).toBeNull();
        // Rejecting is still theirs to do.
        expect(screen.getByTestId('proposal-reject-p1')).toBeEnabled();
    });

    it('a proposal with no approvals carries no such badge', () => {
        renderQueue([row()]);
        expect(screen.queryByTestId('proposal-awaiting-second-badge-p1')).toBeNull();
    });
});

// ─── the capped queue ───────────────────────────────────────────────────────

describe('the capped queue', () => {
    it('says it is showing only the first page when the page read more than it lists', () => {
        renderQueue([row(), row({ id: 'p2' })], { truncated: true });
        expect(screen.getByTestId('proposal-queue-truncated')).toHaveTextContent(
            en('proposals.truncated').replace('{shown}', '2'),
        );
    });

    it('says nothing when the whole queue is listed', () => {
        renderQueue([row()], { truncated: false });
        expect(screen.queryByTestId('proposal-queue-truncated')).toBeNull();
    });
});

// ─── labels ─────────────────────────────────────────────────────────────────

describe('kinds and fields are labels', () => {
    it.each([
        ['RISK', 'proposals.kind.RISK'],
        ['EXTERNAL_WRITE', 'proposals.kind.EXTERNAL_WRITE'],
    ])('the %s kind', (kind, key) => {
        renderQueue([row({ kind })]);
        expect(screen.getByTestId('proposal-kind-p1')).toHaveTextContent(en(key));
        expect(screen.getByTestId('proposal-kind-p1').textContent).not.toBe(kind);
    });

    it('a diff names its fields as a reviewer reads them', () => {
        renderQueue([row()]);
        const field = screen.getByTestId('proposal-diff-field-p1-treatmentNotes');
        expect(field).toHaveTextContent(en('proposals.field.treatmentNotes'));
        expect(field.textContent).not.toContain('treatmentNotes');
    });

    it('a field not on the list is shown as stored, never as a message path', () => {
        renderQueue([
            row({
                diff: computeProposalDiff({ operation: 'CREATE', payloadJson: JSON.stringify({ legacyColumn: 'x' }) }),
            }),
        ]);
        const field = screen.getByTestId('proposal-diff-field-p1-legacyColumn');
        expect(field).toHaveTextContent('legacyColumn');
        expect(field.textContent).not.toContain('proposals.field');
    });
});

// ─── the key ────────────────────────────────────────────────────────────────

describe('the key a proposal came through', () => {
    it('is named by its prefix, as on the API Keys page', () => {
        renderQueue([row({ proposedViaKeyId: 'cmkey0internal1234', proposedViaKeyPrefix: 'iflk_ab1' })]);
        const meta = screen.getByTestId('proposal-meta-p1');
        expect(meta).toHaveTextContent('iflk_ab1…');
        expect(meta.textContent).not.toContain('cmkey0in');
    });

    it('a key whose prefix cannot be read is said to be a key, without an identifier', () => {
        renderQueue([row({ proposedViaKeyId: 'cmkey0internal1234', proposedViaKeyPrefix: null })]);
        const meta = screen.getByTestId('proposal-meta-p1');
        expect(meta).toHaveTextContent(en('proposals.keySuffixUnresolved').trim());
        expect(meta.textContent).not.toContain('cmkey0in');
    });

    it('a proposal made without a key names none', () => {
        renderQueue([row()]);
        expect(screen.getByTestId('proposal-meta-p1').textContent).not.toContain('key');
    });
});

// ─── bulk reject ────────────────────────────────────────────────────────────

describe('a bulk reject names the cause of each skip', () => {
    async function bulkReject(skipped: Array<{ id: string; reason: string }>, rejected: string[]) {
        mockFetch({ ok: true, body: { rejected, skipped } });
        renderQueue([row(), row({ id: 'p2' }), row({ id: 'p3' })]);
        for (const id of ['p1', 'p2', 'p3']) fireEvent.click(screen.getByTestId(`proposal-select-${id}`));
        await act(async () => {
            within(screen.getByTestId('proposal-bulk-bar')).getByTestId('proposal-bulk-reject').click();
        });
        await act(async () => {
            await Promise.resolve();
        });
        expect(toastInfo).toHaveBeenCalledTimes(1);
        return toastInfo.mock.calls[0][0] as string;
    }

    it('the reviewer’s own dissent is named, not blamed on somebody else or the clock', async () => {
        const message = await bulkReject([{ id: 'p2', reason: 'DISSENT_AUTHOR_MAY_NOT_DECIDE' }], ['p1', 'p3']);
        expect(message).toContain(en('proposals.bulk.skipped.ownDissent'));
        expect(message).not.toContain(en('proposals.bulk.skipped.decided'));
        expect(message).not.toContain(en('proposals.bulk.skipped.expired'));
        expect(message).toContain(
            en('proposals.bulk.rejectedReconciled').replace('{rejected}', '2').replace('{skipped}', '1'),
        );
    });

    it('each distinct cause is named once, and only those the batch hit', async () => {
        const message = await bulkReject(
            [
                { id: 'p1', reason: 'QUARANTINED' },
                { id: 'p2', reason: 'EXPIRED' },
                { id: 'p3', reason: 'EXPIRED' },
            ],
            [],
        );
        expect(message).toContain(en('proposals.bulk.skipped.quarantined'));
        expect(message.split(en('proposals.bulk.skipped.expired'))).toHaveLength(2);
        expect(message).not.toContain(en('proposals.bulk.skipped.decided'));
        expect(message).not.toContain(en('proposals.bulk.skipped.ownDissent'));
    });
});
