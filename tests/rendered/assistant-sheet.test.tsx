/**
 * The conversation window (#3852).
 *
 * ═══ WHY THIS DRIVES A REAL SSE BODY RATHER THAN MOCKING THE HOOK ═══
 *
 * `useAssistantStream` is this feature's client. Replacing it with a jest mock
 * would leave the reducer, the frame splitting and the render path untested
 * while the assertions still passed — the mock's own shape would be the thing
 * under test. So `fetch` is stubbed to return an actual `ReadableStream` of
 * SSE frames and the real hook consumes it.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
// jsdom provides NEITHER `ReadableStream` NOR `fetch` — probed, not assumed:
// `typeof ReadableStream` is "undefined" in this project's environment while
// `TextEncoder`/`TextDecoder` are present. So the stream comes from Node's own
// web-streams implementation, which is what `res.body.getReader()` consumes in
// the Node runtime this route actually runs on.
import { ReadableStream } from 'node:stream/web';

// Settable per test: the page context reads filter state from the URL, so the
// query string is an INPUT to the behaviour under test rather than scenery.
let searchParamsValue = new URLSearchParams();

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useSearchParams: () => searchParamsValue,
    useSelectedLayoutSegment: () => null,
    useSelectedLayoutSegments: () => [],
    usePathname: () => '/t/acme/controls',
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
}));

// The key is returned VERBATIM, with any interpolated values appended.
//
// Returning the bare key was the first attempt and it hid a real assertion:
// `t('toolTruncated', { tool: 'list_controls' })` rendered as "toolTruncated",
// so a test checking that the tool is NAMED passed on a string containing no
// name. Appending the values keeps assertions pinned to catalogue keys (immune
// to copy changes) while still proving the value reached the message.
jest.mock('next-intl', () => ({
    useTranslations:
        () =>
        (key: string, values?: Record<string, unknown>) =>
            values === undefined ? key : `${key}:${Object.values(values).join(',')}`,
}));

import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';
import { AssistantOpenProvider } from '@/components/assistant/assistant-open-context';
import { AssistantLauncher } from '@/components/assistant/AssistantLauncher';
import { TenantProvider, type TenantContextValue } from '@/lib/tenant-context-provider';
import { getPermissionsForRole } from '@/lib/permissions';
import type { AssistantStreamEvent } from '@/app-layer/ai/assistant/stream-events';

const TENANT: TenantContextValue = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    tenantSlug: 'acme',
    tenantName: 'Acme',
    role: 'OWNER' as TenantContextValue['role'],
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    appPermissions: getPermissionsForRole('OWNER'),
    modules: { processCanvas: true },
};

/**
 * The real providers this feature needs, and nothing else.
 *
 * The first version mounted the whole `<Providers>` tree. It worked and it was
 * unusable: the launcher suite took **302 seconds** and the sheet suite
 * crashed with "Jest worker ran out of memory", because `<Providers>` also
 * mounts SWR, the command palette and its entity search, the theme and
 * tooltip providers, a telemetry sink, a session poller and the toast host —
 * ten times over, once per `render`.
 *
 * These are still the REAL providers, not stubs: `KeyboardShortcutProvider` is
 * the shared registry the shortcut must register on, `AssistantOpenProvider`
 * is the state the palette and launcher share, and `TenantProvider` is what
 * `useTenantHref`/`useTenantApiUrl` read. What is gone is everything this
 * feature does not touch.
 */
function Harness({ children }: { children: React.ReactNode }) {
    return (
        <KeyboardShortcutProvider>
            <AssistantOpenProvider>
                <TenantProvider value={TENANT}>{children}</TenantProvider>
            </AssistantOpenProvider>
        </KeyboardShortcutProvider>
    );
}

/** An SSE body carrying these events, one per frame. */
function sseBody(events: AssistantStreamEvent[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(': connected\n\n'));
            for (const e of events) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
            }
            controller.close();
        },
    });
}

function stubStream(events: AssistantStreamEvent[]) {
    global.fetch = jest.fn(async () =>
        Promise.resolve({ ok: true, status: 200, body: sseBody(events) } as unknown as Response),
    ) as unknown as typeof fetch;
}

function mount() {
    return render(
        <Harness>
            <div data-testid="underlying-page">the list behind the sheet</div>
            <AssistantLauncher />
        </Harness>,
    );
}

async function ask(question = 'which controls are missing evidence?') {
    fireEvent.click(screen.getByTestId('assistant-launcher'));
    fireEvent.change(screen.getByTestId('assistant-input'), { target: { value: question } });
    fireEvent.submit(screen.getByTestId('assistant-input').closest('form') as HTMLFormElement);
}

afterEach(() => {
    jest.restoreAllMocks();
    searchParamsValue = new URLSearchParams();
});

/** The JSON body of the single `fetch` the turn made. */
function sentBody(): { question: string; pageContext?: Record<string, unknown> } {
    const mock = global.fetch as unknown as jest.Mock;
    expect(mock).toHaveBeenCalledTimes(1);
    const init = mock.mock.calls[0][1] as { body: string };
    return JSON.parse(init.body);
}

describe('opening and closing', () => {
    it('opens from the launcher and shows the first-run EmptyState', () => {
        stubStream([]);
        mount();
        expect(screen.queryByTestId('assistant-empty')).toBeNull();

        fireEvent.click(screen.getByTestId('assistant-launcher'));

        // The first-run view has to say what the assistant can DO. An empty
        // panel with a prompt box teaches nothing.
        expect(screen.getByTestId('assistant-empty')).toBeInTheDocument();
        expect(screen.getByText('emptyTitle')).toBeInTheDocument();
        expect(screen.getByText('emptyDescription')).toBeInTheDocument();
    });

    it('does not lose the page behind it', () => {
        stubStream([]);
        mount();
        fireEvent.click(screen.getByTestId('assistant-launcher'));
        // The whole point of a Sheet over a Modal: the list the user is asking
        // ABOUT is still mounted and unchanged.
        expect(screen.getByTestId('underlying-page')).toBeInTheDocument();
    });

    it('returns focus to the launcher on close', () => {
        stubStream([]);
        mount();
        const btn = screen.getByTestId('assistant-launcher');
        fireEvent.click(btn);
        fireEvent.click(screen.getByTestId('assistant-launcher'));
        // Without this a keyboard user lands at the top of the document and
        // has to traverse the page to get back to where they were.
        expect(document.activeElement).toBe(screen.getByTestId('assistant-launcher'));
    });

    it('opens from the keyboard shortcut, through the shared registry', () => {
        stubStream([]);
        mount();
        expect(screen.queryByTestId('assistant-empty')).toBeNull();

        fireEvent.keyDown(document, { key: 'a', ctrlKey: true, shiftKey: true });
        fireEvent.keyDown(document, { key: 'A', metaKey: true, shiftKey: true });

        expect(screen.getByTestId('assistant-launcher')).toHaveAttribute('aria-expanded', 'true');
    });
});

describe('what the turn shows honestly', () => {
    it('names the tool being called, and labels a truncated result', async () => {
        stubStream([
            { type: 'thinking' },
            { type: 'tool_call', name: 'list_controls' },
            { type: 'tool_result', name: 'list_controls', ok: true, truncated: true },
            { type: 'answer', text: 'Three controls are missing evidence.' },
            { type: 'done', truncatedAny: true },
        ]);
        mount();
        await ask();

        await waitFor(() => expect(screen.getByTestId('assistant-answer')).toBeInTheDocument());
        // The tool is NAMED in the call list, not reduced to a spinner.
        expect(screen.getByTestId('assistant-calls').textContent).toContain('list_controls');
        // And the truncation is labelled beside the ANSWER, because the person
        // reading the sentence is the one who needs to know the totals are
        // from a partial set.
        expect(screen.getByTestId('assistant-truncated')).toBeInTheDocument();
    });

    it('shows a refusal WITH its reason, not as a blank answer', async () => {
        stubStream([
            { type: 'thinking' },
            { type: 'refusal', reason: 'The content guard withheld that request.' },
            { type: 'done', truncatedAny: false },
        ]);
        mount();
        await ask();

        await waitFor(() => expect(screen.getByTestId('assistant-refusal')).toBeInTheDocument());
        expect(screen.getByTestId('assistant-refusal').textContent).toContain(
            'The content guard withheld that request.',
        );
        // A refusal is not an error. Collapsing them would make "try again"
        // the advice for a governance decision.
        expect(screen.queryByTestId('assistant-error')).toBeNull();
    });

    it('renders a deep link only for a route the nav actually has', async () => {
        stubStream([
            { type: 'answer', text: 'Three controls are missing evidence — see /controls.' },
            { type: 'done', truncatedAny: false },
        ]);
        mount();
        await ask();

        await waitFor(() => expect(screen.getByTestId('assistant-links')).toBeInTheDocument());
        const link = screen.getByTestId('assistant-links').querySelector('a');
        // Built through `tenantHref`, so the slug is never hand-assembled.
        expect(link).toHaveAttribute('href', '/t/acme/controls');
    });
});

describe('a quarantined proposal is never described as queued', () => {
    it('renders the QUEUED state with a link to the review queue', async () => {
        stubStream([
            {
                type: 'answer',
                text: "I've queued a finding as a proposal for review.",
                proposal: { id: 'p1', kind: 'finding', status: 'PENDING' },
            },
            { type: 'done', truncatedAny: false },
        ]);
        mount();
        await ask('raise a finding about MFA');

        await waitFor(() =>
            expect(screen.getByTestId('assistant-proposal-queued')).toBeInTheDocument(),
        );
        const link = screen
            .getByTestId('assistant-proposal-queued')
            .querySelector('a') as HTMLAnchorElement;
        // `/agents/proposals` is the real queue; `/agent-proposals` is a
        // redirect shim, so linking the shim would bounce the user.
        expect(link).toHaveAttribute('href', '/t/acme/agents/proposals');
    });

    it('renders QUARANTINED with no queue link and no "queued" label', async () => {
        stubStream([
            {
                type: 'answer',
                text: 'I could not queue the finding: its text was withheld by the content guard. Nothing was created.',
                proposal: { id: 'p2', kind: 'finding', status: 'QUARANTINED' },
            },
            { type: 'done', truncatedAny: false },
        ]);
        mount();
        await ask('raise a finding about MFA');

        await waitFor(() =>
            expect(screen.getByTestId('assistant-proposal-quarantined')).toBeInTheDocument(),
        );
        // The queued block must be ABSENT, not merely styled differently.
        expect(screen.queryByTestId('assistant-proposal-queued')).toBeNull();
        // And no link to a queue it never reached — offering one would imply
        // it is there.
        expect(
            screen.getByTestId('assistant-proposal-quarantined').querySelector('a'),
        ).toBeNull();
        expect(screen.getByText('proposalQuarantined')).toBeInTheDocument();
    });

    it('an UNKNOWN status is not treated as queued', async () => {
        // The discriminating case. Keying the queued branch on the pending
        // status BY NAME means a status this UI has never heard of falls to
        // the cautious side. Had the check been `status !== 'QUARANTINED'`, a
        // new status — EXPIRED, REJECTED — would have been announced to the
        // user as queued for review.
        stubStream([
            {
                type: 'answer',
                text: 'Something happened to the proposal.',
                proposal: { id: 'p3', kind: 'finding', status: 'EXPIRED' },
            },
            { type: 'done', truncatedAny: false },
        ]);
        mount();
        await ask('raise a finding about MFA');

        await waitFor(() =>
            expect(screen.getByTestId('assistant-proposal-quarantined')).toBeInTheDocument(),
        );
        expect(screen.queryByTestId('assistant-proposal-queued')).toBeNull();
    });
});

describe('the page context the turn carries', () => {
    it('sends the route with no per-page wiring', async () => {
        stubStream([{ type: 'answer', text: 'ok' }, { type: 'done', truncatedAny: false }]);
        mount();
        await ask('how many controls?');
        await waitFor(() => expect(screen.getByTestId('assistant-answer')).toBeInTheDocument());

        const body = sentBody();
        expect(body.pageContext).toMatchObject({ route: '/t/acme/controls' });
    });

    it('reads visible filter state and the selection out of the URL', async () => {
        // This product serialises filters into the query string
        // (`filterStateToUrlParams`), with the selection in an `ids` param. So
        // the context is correct on every list page without a page reporting
        // anything — the same move as reading the route from `usePathname`.
        searchParamsValue = new URLSearchParams(
            'evidence=missing&severity=high&ids=ctl_1,ctl_2&page=3',
        );
        stubStream([{ type: 'answer', text: 'ok' }, { type: 'done', truncatedAny: false }]);
        mount();
        await ask('which of these has no evidence?');
        await waitFor(() => expect(screen.getByTestId('assistant-answer')).toBeInTheDocument());

        const body = sentBody();
        expect(body.pageContext).toMatchObject({
            route: '/t/acme/controls',
            filters: { evidence: 'missing', severity: 'high' },
            selectedIds: ['ctl_1', 'ctl_2'],
        });
        // `page` is view mechanics, not filter state. Reporting a page number
        // as a filter invites the model to reason about it as one.
        expect((body.pageContext as { filters: Record<string, string> }).filters).not.toHaveProperty(
            'page',
        );
    });

    it('DROPS a param the server would reject rather than losing the turn', async () => {
        // The server rejects the whole body on a schema violation, so one
        // unacceptable value would cost the user their entire question. Losing
        // that one filter from the context is much the smaller failure, and
        // the acceptable ones beside it must still arrive.
        searchParamsValue = new URLSearchParams('evidence=missing&q=a,b;c&bad%20key=x');
        stubStream([{ type: 'answer', text: 'ok' }, { type: 'done', truncatedAny: false }]);
        mount();
        await ask('anything');
        await waitFor(() => expect(screen.getByTestId('assistant-answer')).toBeInTheDocument());

        const filters = (sentBody().pageContext as { filters: Record<string, string> }).filters;
        expect(filters).toEqual({ evidence: 'missing' });
    });

    it('omits the context entirely when there is nothing but the route', async () => {
        // Empty collections are omitted rather than sent as `{}` / `[]`: the
        // server distinguishes "no filters" from "filters, none of them set",
        // and an empty object reaching the prompt would read as the latter.
        stubStream([{ type: 'answer', text: 'ok' }, { type: 'done', truncatedAny: false }]);
        mount();
        await ask('anything');
        await waitFor(() => expect(screen.getByTestId('assistant-answer')).toBeInTheDocument());

        const pc = sentBody().pageContext as Record<string, unknown>;
        expect(pc).not.toHaveProperty('filters');
        expect(pc).not.toHaveProperty('selectedIds');
        expect(pc).toHaveProperty('route');
    });
});

// ─── #5054: a multi-line input, a stated limit, and a conversation ──────────

/** One SSE turn per call, in order. */
function stubStreams(...turns: AssistantStreamEvent[][]) {
    const mock = jest.fn();
    for (const events of turns) {
        mock.mockImplementationOnce(async () =>
            Promise.resolve({ ok: true, status: 200, body: sseBody(events) } as unknown as Response),
        );
    }
    global.fetch = mock as unknown as typeof fetch;
}

/** A turn that says it is thinking and never finishes, until it is aborted. */
function stubHangingStream() {
    global.fetch = jest.fn(async (_url: string, init?: { signal?: AbortSignal }) => {
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'thinking' })}\n\n`));
                init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
            },
        });
        return { ok: true, status: 200, body } as unknown as Response;
    }) as unknown as typeof fetch;
}

/** Every request body the conversation sent, in order. */
function sentBodies(): Array<{ question: string; history?: Array<{ question: string; answer: string }> }> {
    const mock = global.fetch as unknown as jest.Mock;
    return mock.mock.calls.map((c) => JSON.parse((c[1] as { body: string }).body));
}

const input = () => screen.getByTestId('assistant-input') as HTMLTextAreaElement;

function send(text: string) {
    fireEvent.change(input(), { target: { value: text } });
    fireEvent.submit(input().closest('form') as HTMLFormElement);
}

/** Wait until the last turn has finished and the input is usable again. */
async function settled() {
    await waitFor(() => expect(input()).not.toBeDisabled());
}

const ANSWER = (text: string): AssistantStreamEvent[] => [
    { type: 'answer', text },
    { type: 'done', truncatedAny: false },
];

describe('the input is multi-line, and keeps what was pasted (#5054)', () => {
    it('sends a pasted multi-line question exactly, and shows it with its line breaks', async () => {
        stubStreams(ANSWER('A map, then.'));
        mount();
        fireEvent.click(screen.getByTestId('assistant-launcher'));
        const pasted = 'Step 1: HR raises the request\nStep 2: IT creates the account\n\nStep 3: the manager confirms';
        expect(input().tagName).toBe('TEXTAREA');

        send(pasted);
        await settled();

        expect(sentBodies()[0].question).toBe(pasted);
        const shown = screen.getByTestId('assistant-question').querySelector('p.whitespace-pre-wrap');
        expect(shown?.textContent).toBe(pasted);
    });

    it('renders markup in a question as text, never as markup', async () => {
        stubStreams(ANSWER('ok'));
        mount();
        fireEvent.click(screen.getByTestId('assistant-launcher'));
        send('<b>bold</b> <img src=x onerror=alert(1)>');
        await settled();

        const question = screen.getByTestId('assistant-question');
        expect(question.querySelector('b')).toBeNull();
        expect(question.querySelector('img')).toBeNull();
        expect(question.textContent).toContain('<b>bold</b>');
    });

    it('sends on Enter', async () => {
        stubStreams(ANSWER('ok'));
        mount();
        fireEvent.click(screen.getByTestId('assistant-launcher'));
        fireEvent.change(input(), { target: { value: 'how many risks?' } });

        fireEvent.keyDown(input(), { key: 'Enter' });

        await settled();
        expect(sentBodies()).toEqual([expect.objectContaining({ question: 'how many risks?' })]);
    });

    it('leaves Shift+Enter to the browser, which starts a new line, and sends nothing', () => {
        stubStreams(ANSWER('ok'));
        mount();
        fireEvent.click(screen.getByTestId('assistant-launcher'));
        fireEvent.change(input(), { target: { value: 'line one' } });

        // `true` means the default was NOT prevented, so the newline goes in.
        expect(fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true })).toBe(true);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('sends nothing on an Enter that closes an IME composition', () => {
        stubStreams(ANSWER('ok'));
        mount();
        fireEvent.click(screen.getByTestId('assistant-launcher'));
        fireEvent.change(input(), { target: { value: '日本' } });

        fireEvent.keyDown(input(), { key: 'Enter', isComposing: true });
        fireEvent.keyDown(input(), { key: 'Enter', keyCode: 229 });

        expect(global.fetch).not.toHaveBeenCalled();
    });
});

describe('the stated limit, refused with a sentence and never cut (#5054)', () => {
    it('over the limit, says so, refuses to send, and keeps every character', () => {
        stubStreams(ANSWER('ok'));
        mount();
        fireEvent.click(screen.getByTestId('assistant-launcher'));
        const long = 'x'.repeat(8_001);
        fireEvent.change(input(), { target: { value: long } });

        expect(screen.getByRole('alert').textContent).toBe('questionTooLong:8000');
        // The running count is shown, outside the live region.
        expect(screen.getByTestId('assistant-input-hint').textContent).toBe('questionCounter:8001,8000');
        expect(screen.getByRole('button', { name: 'send' })).toBeDisabled();

        fireEvent.keyDown(input(), { key: 'Enter' });
        fireEvent.submit(input().closest('form') as HTMLFormElement);

        expect(global.fetch).not.toHaveBeenCalled();
        expect(input().value).toHaveLength(8_001);
        expect(input()).not.toHaveAttribute('maxlength');
    });

    it('shows the counter near the limit, and the hint before it', () => {
        stubStreams(ANSWER('ok'));
        mount();
        fireEvent.click(screen.getByTestId('assistant-launcher'));

        fireEvent.change(input(), { target: { value: 'short question' } });
        expect(screen.getByText('questionHint')).toBeInTheDocument();
        expect(input()).toHaveAttribute('aria-describedby', screen.getByTestId('assistant-input-hint').id);
        expect(screen.queryByText(/^questionCounter/)).toBeNull();

        fireEvent.change(input(), { target: { value: 'x'.repeat(7_000) } });
        expect(screen.getByText('questionCounter:7000,8000')).toBeInTheDocument();
        expect(screen.queryByText('questionHint')).toBeNull();
        // Near is not over: it still sends.
        expect(screen.getByRole('button', { name: 'send' })).not.toBeDisabled();
    });
});

describe('a conversation: earlier turns go with the next question (#5054)', () => {
    it('sends no history first, then the finished turn with the follow-up', async () => {
        stubStreams(ANSWER('Two steps, owned by HR and IT.'), ANSWER('Here is the map.'));
        mount();
        fireEvent.click(screen.getByTestId('assistant-launcher'));

        send('Step 1\nStep 2');
        await settled();
        send('now make it a map');
        await settled();

        const [first, second] = sentBodies();
        expect(first).not.toHaveProperty('history');
        expect(second.history).toEqual([{ question: 'Step 1\nStep 2', answer: 'Two steps, owned by HR and IT.' }]);
        // Both turns stay on screen, in order.
        const turns = screen.getAllByTestId('assistant-turn');
        expect(turns).toHaveLength(2);
        expect(turns[1].textContent).toContain('Here is the map.');
    });

    it('never sends a refused turn as history', async () => {
        stubStreams(
            [{ type: 'refusal', reason: 'withheld' }, { type: 'done', truncatedAny: false }],
            ANSWER('ok'),
        );
        mount();
        fireEvent.click(screen.getByTestId('assistant-launcher'));
        send('first');
        await settled();
        send('second');
        await settled();

        expect(sentBodies()[1]).not.toHaveProperty('history');
    });

    it('sends only the sentence of a proposal turn, never its id', async () => {
        stubStreams(
            [
                {
                    type: 'answer',
                    text: "I've queued a finding as a proposal for review.",
                    proposal: { id: 'prop-secret-1', kind: 'finding', status: 'PENDING' },
                },
                { type: 'done', truncatedAny: false },
            ],
            ANSWER('ok'),
        );
        mount();
        fireEvent.click(screen.getByTestId('assistant-launcher'));
        send('raise a finding about MFA');
        await settled();
        send('thanks');
        await settled();

        const raw = (global.fetch as unknown as jest.Mock).mock.calls[1][1].body as string;
        expect(raw).not.toContain('prop-secret-1');
        expect(sentBodies()[1].history).toEqual([
            { question: 'raise a finding about MFA', answer: "I've queued a finding as a proposal for review." },
        ]);
        // The earlier turn keeps its queued label as the conversation goes on.
        expect(within(screen.getAllByTestId('assistant-turn')[0]).getByTestId('assistant-proposal-queued')).toBeInTheDocument();
    });

    it('starts a new conversation that carries nothing over', async () => {
        stubStreams(ANSWER('first answer'), ANSWER('ok'));
        mount();
        fireEvent.click(screen.getByTestId('assistant-launcher'));
        send('first');
        await settled();

        fireEvent.click(screen.getByRole('button', { name: 'newConversation' }));
        expect(screen.queryAllByTestId('assistant-turn')).toHaveLength(0);
        expect(screen.getByTestId('assistant-empty')).toBeInTheDocument();

        send('second');
        await settled();
        expect(sentBodies()[1]).not.toHaveProperty('history');
    });
});

describe('Stop ends the turn (#5054)', () => {
    it('marks the turn stopped, gives the input back, and sends it as no history', async () => {
        stubHangingStream();
        mount();
        fireEvent.click(screen.getByTestId('assistant-launcher'));
        send('a slow question');
        await waitFor(() => expect(screen.getByRole('button', { name: 'cancel' })).toBeInTheDocument());
        expect(input()).toBeDisabled();

        fireEvent.click(screen.getByRole('button', { name: 'cancel' }));

        await settled();
        expect(screen.getByTestId('assistant-stopped')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'cancel' })).toBeNull();
        expect(screen.getByRole('button', { name: 'send' })).toBeInTheDocument();
        expect(screen.queryByTestId('assistant-phase')).toBeNull();

        stubStreams(ANSWER('ok'));
        send('again');
        await settled();
        expect(sentBodies()[0]).not.toHaveProperty('history');
    });
});

// ─── #5054 review: accessibility and touch ──────────────────────────────────

describe('the over-limit alert is announced once, not on every keystroke', () => {
    it('keeps the alert text constant while the question stays over the limit', () => {
        stubStreams(ANSWER('ok'));
        mount();
        fireEvent.click(screen.getByTestId('assistant-launcher'));

        fireEvent.change(input(), { target: { value: 'x'.repeat(8_100) } });
        const alert = screen.getByRole('alert');
        const first = alert.textContent;
        expect(alert).toHaveAttribute('aria-live', 'polite');

        // One more character, then one fewer: still over, so nothing new to say.
        fireEvent.change(input(), { target: { value: 'x'.repeat(8_101) } });
        expect(screen.getByRole('alert').textContent).toBe(first);
        fireEvent.change(input(), { target: { value: 'x'.repeat(8_050) } });
        expect(screen.getByRole('alert').textContent).toBe(first);

        // The count that does change is in the hint, which is not live.
        const hint = screen.getByTestId('assistant-input-hint');
        expect(hint.textContent).toBe('questionCounter:8050,8000');
        expect(hint).not.toHaveAttribute('aria-live');
        expect(hint).not.toHaveAttribute('role');
    });

    it('describes the box only by elements that exist', () => {
        stubStreams(ANSWER('ok'));
        mount();
        fireEvent.click(screen.getByTestId('assistant-launcher'));
        fireEvent.change(input(), { target: { value: 'x'.repeat(8_100) } });

        const ids = (input().getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
        expect(ids.length).toBeGreaterThan(0);
        for (const id of ids) expect(document.getElementById(id)).not.toBeNull();
    });
});

describe('focus', () => {
    it('"New conversation" puts focus in the input, not on the page body', async () => {
        stubStreams(ANSWER('first answer'));
        mount();
        fireEvent.click(screen.getByTestId('assistant-launcher'));
        send('first');
        await settled();

        const button = screen.getByRole('button', { name: 'newConversation' });
        button.focus();
        fireEvent.click(button);

        expect(screen.queryByRole('button', { name: 'newConversation' })).toBeNull();
        expect(document.activeElement).toBe(input());
    });

    it('when a turn ends, returns focus to the input only if focus was lost', async () => {
        stubHangingStream();
        mount();
        fireEvent.click(screen.getByTestId('assistant-launcher'));
        send('a slow question');
        await waitFor(() => expect(screen.getByRole('button', { name: 'cancel' })).toBeInTheDocument());

        // Somebody moves to something else in the sheet while it runs.
        const elsewhere = document.createElement('a');
        elsewhere.href = '#elsewhere';
        elsewhere.textContent = 'a link in an earlier answer';
        screen.getByTestId('assistant-turn').appendChild(elsewhere);
        elsewhere.focus();
        expect(document.activeElement).toBe(elsewhere);

        fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
        await settled();
        expect(document.activeElement).toBe(elsewhere);
    });

    it('when a turn ends with focus lost, puts it back in the input', async () => {
        stubStreams(ANSWER('ok'));
        mount();
        fireEvent.click(screen.getByTestId('assistant-launcher'));
        send('a question');
        (document.activeElement as HTMLElement | null)?.blur();
        await settled();
        await waitFor(() => expect(document.activeElement).toBe(input()));
    });
});

describe('the box fits its text when the sheet reopens', () => {
    it('measures a fresh textarea holding a long draft', () => {
        const scroll = jest.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockReturnValue(120);
        stubStreams(ANSWER('ok'));
        mount();
        fireEvent.click(screen.getByTestId('assistant-launcher'));
        fireEvent.change(input(), { target: { value: 'line\n'.repeat(6) } });
        const before = input();
        expect(before.style.height).toBe('120px');

        // Close and reopen: the drawer unmounts its content, so this is a NEW
        // textarea holding the same draft, and nothing has been typed into it.
        fireEvent.click(screen.getByTestId('assistant-launcher'));
        fireEvent.click(screen.getByTestId('assistant-launcher'));
        expect(input()).not.toBe(before);
        expect(input().value).toBe('line\n'.repeat(6));
        expect(input().style.height).toBe('120px');
        scroll.mockRestore();
    });
});

describe('on a touch keyboard, Enter starts a line and Ask sends', () => {
    const realMatchMedia = window.matchMedia;
    const pointer = (coarse: boolean) => {
        window.matchMedia = ((query: string) => ({
            matches: coarse && query === '(pointer: coarse)',
            media: query,
            onchange: null,
            addListener: jest.fn(),
            removeListener: jest.fn(),
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
            dispatchEvent: jest.fn(),
        })) as unknown as typeof window.matchMedia;
    };
    afterEach(() => {
        window.matchMedia = realMatchMedia;
    });

    it('does not send on Enter, says to tap Ask, and offers no Send key', () => {
        pointer(true);
        stubStreams(ANSWER('ok'));
        mount();
        fireEvent.click(screen.getByTestId('assistant-launcher'));
        fireEvent.change(input(), { target: { value: 'line one' } });

        expect(fireEvent.keyDown(input(), { key: 'Enter' })).toBe(true);
        expect(global.fetch).not.toHaveBeenCalled();
        expect(screen.getByTestId('assistant-input-hint').textContent).toBe('questionHintTouch');
        expect(input()).toHaveAttribute('enterkeyhint', 'enter');
    });

    it('with a fine pointer, Enter sends and the soft key reads Send', async () => {
        pointer(false);
        stubStreams(ANSWER('ok'));
        mount();
        fireEvent.click(screen.getByTestId('assistant-launcher'));
        expect(input()).toHaveAttribute('enterkeyhint', 'send');
        expect(screen.getByTestId('assistant-input-hint').textContent).toBe('questionHint');
        fireEvent.change(input(), { target: { value: 'how many?' } });
        fireEvent.keyDown(input(), { key: 'Enter' });
        await settled();
        expect(sentBodies()).toHaveLength(1);
    });
});

describe('a dropped connection is said in the person\'s language', () => {
    it('renders the catalogue sentence, not an English literal', async () => {
        stubStreams([]);
        mount();
        fireEvent.click(screen.getByTestId('assistant-launcher'));
        send('anything');
        await settled();
        expect(screen.getByTestId('assistant-error').textContent).toContain('connectionClosed');
        expect(screen.getByTestId('assistant-error').textContent).not.toContain('The connection closed');
    });
});

describe('earlier answers go back with the seal the server gave them', () => {
    it('sends the seal with its answer, and never shows it', async () => {
        const seal = 'a'.repeat(64);
        stubStreams(
            [{ type: 'answer', text: 'Two steps.', seal }, { type: 'done', truncatedAny: false }],
            ANSWER('ok'),
        );
        mount();
        fireEvent.click(screen.getByTestId('assistant-launcher'));
        send('first');
        await settled();
        expect(screen.getByRole('dialog').textContent).not.toContain(seal);
        send('second');
        await settled();
        expect(sentBodies()[1].history).toEqual([{ question: 'first', answer: 'Two steps.', answerSeal: seal }]);
    });
});
