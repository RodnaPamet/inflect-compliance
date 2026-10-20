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
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
// jsdom provides NEITHER `ReadableStream` NOR `fetch` — probed, not assumed:
// `typeof ReadableStream` is "undefined" in this project's environment while
// `TextEncoder`/`TextDecoder` are present. So the stream comes from Node's own
// web-streams implementation, which is what `res.body.getReader()` consumes in
// the Node runtime this route actually runs on.
import { ReadableStream } from 'node:stream/web';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useSearchParams: () => new URLSearchParams(),
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
});

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
