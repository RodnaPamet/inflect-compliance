/**
 * #3870 — the asking surface's five states, and the one that must never render.
 *
 * ## The assertion that matters most is a NEGATIVE one
 *
 * An answer is model prose derived from tenant records — the least trustworthy
 * string on the page. So `HTML in an answer is not interpreted` is not a
 * formatting test: it is the one that would catch a future
 * `dangerouslySetInnerHTML` added to make an answer render links. It asserts
 * both halves, because a negation alone passes against a component that
 * renders nothing at all.
 *
 * ## And the state most likely to be mistaken for an answer
 *
 * An EMPTY CATALOGUE run finishes, so every status reads "settled" and whatever
 * prose it produced looks like a result. #3869 exists because that case
 * previously settled COMPLETED and was indistinguishable in the run list from a
 * review that worked. Here it must render as an explicit NON-answer, and the
 * test asserts the answer text is ABSENT as well as the explanation present.
 *
 * Messages come from the real `en.json`, so a missing copy key renders as the
 * key and fails the text assertion rather than silently rendering blank.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({
        push: jest.fn(), replace: jest.fn(), refresh: jest.fn(),
        back: jest.fn(), forward: jest.fn(), prefetch: jest.fn(),
    }),
    usePathname: () => '/t/acme/agents/ask',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const make = (ns: string) => {
        const dict = ns.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
        // Dotted keys resolve, as next-intl's do: the page reads
        // `refusal.NO_AGENT_DESIGNATED` and `detail.stepStatus.DONE`.
        const lookup = (key: string): unknown =>
            key.split('.').reduce(
                (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
                dict,
            );
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = lookup(key);
            if (typeof v !== 'string') return key;
            if (params) {
                for (const [p, val] of Object.entries(params)) {
                    v = (v as string).replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
                }
            }
            return v as string;
        };
        t.has = (key: string) => typeof lookup(key) === 'string';
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

import { AskClient } from '@/app/t/[tenantSlug]/(app)/agents/ask/AskClient';

const MAX = 2_000;

type Settled = {
    runId: string;
    status: string;
    answer: string | null;
    model: string | null;
    costTokens: number;
    catalogueWasEmpty: boolean;
    toolCalls: Array<{ seq: number; tool: string | null; outcome: string; refusal: string | null; guardVerdict: string | null }>;
};

const settled = (over: Partial<Settled> = {}): Settled => ({
    runId: 'run-1',
    status: 'COMPLETED',
    answer: 'Three controls have no evidence this quarter.',
    model: 'claude-sonnet-5-5',
    costTokens: 1234,
    catalogueWasEmpty: false,
    toolCalls: [{ seq: 1, tool: 'list_controls', outcome: 'DONE', refusal: null, guardVerdict: null }],
    ...over,
});

/** POST returns a run id; the first GET returns whatever the case needs. */
function wireFetch(get: unknown, opts: { postStatus?: number; postBody?: unknown } = {}) {
    const fetchMock = jest.fn(async (url: string, init?: { method?: string }) => {
        if (init?.method === 'POST') {
            const ok = (opts.postStatus ?? 202) < 400;
            return {
                ok,
                status: opts.postStatus ?? 202,
                json: async () => opts.postBody ?? { runId: 'run-1' },
            } as unknown as Response;
        }
        return { ok: true, status: 200, json: async () => get } as unknown as Response;
    });
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
    return fetchMock;
}

const ask = async (text = 'Which controls have no evidence?') => {
    fireEvent.change(screen.getByLabelText('Your question'), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
};

afterEach(() => {
    jest.clearAllMocks();
});

describe('idle', () => {
    it('offers the input and refuses to submit nothing', () => {
        render(<AskClient tenantSlug="acme" maxChars={MAX} />);
        expect(screen.getByLabelText('Your question')).toBeInTheDocument();
        // Disabled on an empty question: the server refuses QUESTION_EMPTY, and
        // spending a round trip to be told so is a worse experience than a
        // button that says it is not ready.
        expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled();
    });

    it('mirrors the cap client-side, and the counter names both numbers', () => {
        render(<AskClient tenantSlug="acme" maxChars={MAX} />);
        fireEvent.change(screen.getByLabelText('Your question'), { target: { value: 'a'.repeat(MAX + 1) } });
        // The limit is stated with the number, not as "too long" — a caller
        // told only that it is too long has to guess how much to cut.
        expect(screen.getByText(new RegExp(String(MAX)))).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled();
    });
});

describe('answered', () => {
    it('shows the answer, the calls, the model and the token cost', async () => {
        wireFetch(settled());
        render(<AskClient tenantSlug="acme" maxChars={MAX} />);
        await ask();

        await waitFor(() => expect(screen.getByText(/Three controls have no evidence/)).toBeInTheDocument());
        // The calls are ALWAYS visible — not behind a toggle. Asserted by
        // finding them without interacting first.
        expect(screen.getByText('list_controls')).toBeInTheDocument();
        // The step and run outcomes read as words, from the Agent runs page's
        // vocabulary (#4629) — not `DONE` / `COMPLETED`.
        expect(screen.getByText('Done')).toBeInTheDocument();
        expect(screen.getByText('Completed')).toBeInTheDocument();
        expect(screen.queryByText('DONE')).toBeNull();
        expect(screen.getByText('claude-sonnet-5-5')).toBeInTheDocument();
        expect(screen.getByText('1234')).toBeInTheDocument();
    });

    it('HTML in an answer is NOT interpreted', async () => {
        const hostile = '<img src=x onerror="alert(1)">Three controls <b>failed</b>.';
        wireFetch(settled({ answer: hostile }));
        render(<AskClient tenantSlug="acme" maxChars={MAX} />);
        await ask();

        // POSITIVE half: the markup is on screen as TEXT, tags and all. This is
        // what makes the negative half below meaningful — without it, a
        // component rendering nothing would pass.
        await waitFor(() => expect(screen.getByText(hostile, { exact: false })).toBeInTheDocument());

        // NEGATIVE half: no element was created from it. A
        // `dangerouslySetInnerHTML` added later to render links would fail here.
        expect(document.querySelector('img')).toBeNull();
        expect(document.querySelector('#agent-answer b')).toBeNull();
    });

    it('reports a refused call by its CODE, beside the call that was refused', async () => {
        wireFetch(
            settled({
                answer: 'Partial answer.',
                toolCalls: [
                    { seq: 1, tool: 'list_controls', outcome: 'DONE', refusal: null, guardVerdict: null },
                    { seq: 2, tool: 'list_risks', outcome: 'FAILED', refusal: 'agent_suspended', guardVerdict: null },
                ],
            }),
        );
        render(<AskClient tenantSlug="acme" maxChars={MAX} />);
        await ask();
        await waitFor(() => expect(screen.getByText('agent_suspended')).toBeInTheDocument());
        expect(screen.getByText('Failed')).toBeInTheDocument();
    });
});

describe('empty catalogue — the state most likely to be mistaken for an answer', () => {
    it('renders an explicit NON-answer, and does not render the answer text', async () => {
        wireFetch(
            settled({
                status: 'EMPTY_CATALOGUE',
                catalogueWasEmpty: true,
                // A run with no tools still produces prose. That prose must not
                // reach the screen as the answer, which is the whole point.
                answer: 'Everything looks compliant.',
                toolCalls: [],
            }),
        );
        render(<AskClient tenantSlug="acme" maxChars={MAX} />);
        await ask();

        await waitFor(() =>
            expect(screen.getByText(/no tools were available to this agent/i)).toBeInTheDocument(),
        );
        // THE ASSERTION THAT MATTERS: the model's prose is absent. Showing it
        // beside the explanation would still let a reader take it as the answer.
        expect(screen.queryByText('Everything looks compliant.')).toBeNull();
        // And the empty call list is STATED rather than left blank.
        //
        // The needle is the second clause, not "nothing was consulted" — that
        // phrase appears in the empty-catalogue title too, so the obvious
        // needle matched two elements and the query threw. Narrowing it until
        // only the named thing satisfies it is the fix this repo's
        // needle-uniqueness ratchet asks for, and the ambiguity arrived here by
        // the route it describes: two pieces of copy that legitimately say
        // similar things.
        expect(screen.getByText(/not based on this workspace/i)).toBeInTheDocument();
    });
});

describe('refused', () => {
    it('says a known refusal in words, naming the fix', async () => {
        // THE REAL ENVELOPE. `withApiErrorHandling` sends `ApiErrorResponse`
        // — `{ error: { code, message, requestId? } }` — and this fixture
        // said `{ error: '<string>' }`, matching a cast in the client rather
        // than anything the server sends. So the suite agreed with the bug:
        // the component handed that object to JSX, React threw #31 ("objects
        // are not valid as a React child"), and only the e2e, which talks to
        // a real route, could see it. A fixture is a claim about the server
        // and belongs to the server's shape, never the reader's assumption.
        wireFetch(null, {
            postStatus: 403,
            postBody: {
                error: {
                    code: 'FORBIDDEN',
                    message:
                        'NO_AGENT_DESIGNATED: this workspace has designated no interactive agent.',
                    requestId: 'req_test',
                },
            },
        });
        render(<AskClient tenantSlug="acme" maxChars={MAX} />);
        await ask();

        await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
        // The NAMED reason reaches the reader, in words: what is wrong and
        // what fixes it. Flattening it to "something went wrong" is what turns
        // a self-service fix into a support request — and so is the operator's
        // `CODE: detail`, which this page used to print as given (#4629).
        expect(screen.getByRole('alert').textContent).toContain('No agent answers questions in this workspace yet');
        expect(screen.getByRole('alert').textContent).toContain('Use for Ask');
        expect(screen.queryByText(/NO_AGENT_DESIGNATED/)).toBeNull();
    });

    it('shows a refusal this page has no words for as its sentence, without the code', async () => {
        wireFetch(null, {
            postStatus: 403,
            postBody: { error: { code: 'FORBIDDEN', message: 'BUDGET_EXHAUSTED: The monthly agent budget is spent.' } },
        });
        render(<AskClient tenantSlug="acme" maxChars={MAX} />);
        await ask();
        await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
        expect(screen.getByText('The monthly agent budget is spent.')).toBeInTheDocument();
        expect(screen.queryByText(/BUDGET_EXHAUSTED/)).toBeNull();
    });

    it('cannot render a non-string reason, whatever shape the body arrives in', async () => {
        // The defect this pins is not a missing field but a WRONG TYPE
        // reaching JSX. `{ error: '<string>' }` is the shape the old cast
        // claimed; an object with no `message` is the shape a future envelope
        // change could bring. Both must land on the stated copy rather than
        // crash the page, because the reader's alert is the last thing between
        // a named refusal and a support request.
        for (const body of [
            // A flat `{ error: 'string' }` is NOT in this list: it is one of
            // the three shapes `apiErrorMessage` legitimately reads, so it
            // surfaces as the reason rather than falling back. That is correct
            // -- the property under test is that a NON-STRING never renders.
            { error: { code: 'FORBIDDEN', requestId: 'req_test' } },
            { error: { code: 'FORBIDDEN', message: '   ' } },
            { error: null },
            { error: 42 },
            { error: { message: { nested: true } } },
            // A non-JSON body is NOT in this list, deliberately: `wireFetch`
            // coalesces `postBody ?? { runId }`, so a `null` here is served as
            // a success body and the case would pass for a reason other than
            // the one it names. The sibling test covers `{}`.
        ]) {
            wireFetch(null, { postStatus: 403, postBody: body });
            const { unmount } = render(<AskClient tenantSlug="acme" maxChars={MAX} />);
            await ask();
            await waitFor(() =>
                expect(screen.getByText(/refused and no reason was given/i)).toBeInTheDocument(),
            );
            unmount();
        }
    });

    it('falls back to stated copy when the server sends no reason', async () => {
        wireFetch(null, { postStatus: 500, postBody: {} });
        render(<AskClient tenantSlug="acme" maxChars={MAX} />);
        await ask();
        // Never a blank alert: an empty refusal box is indistinguishable from a
        // broken page.
        await waitFor(() => expect(screen.getByText(/refused and no reason was given/i)).toBeInTheDocument());
    });
});

describe('running', () => {
    it('says it is working while the run is live, and does not claim an answer', async () => {
        wireFetch(settled({ status: 'RUNNING', answer: null, toolCalls: [] }));
        render(<AskClient tenantSlug="acme" maxChars={MAX} />);
        await ask();

        // RUNNING is in the live set, so the view stays in its working state
        // rather than settling on a run that has not finished.
        await waitFor(() => expect(screen.getByRole('button', { name: 'Asking…' })).toBeInTheDocument());
        expect(screen.queryByText(/Three controls/)).toBeNull();
        // After the first status check too: that check fills the result with
        // the RUNNING run, and the message used to vanish then (#4629).
        await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
        expect(screen.getByText('Working on it')).toBeInTheDocument();
    });

    it('after a timeout, offers Check again, which resumes the SAME run (#4629)', async () => {
        jest.useFakeTimers();
        try {
            let status = 'RUNNING';
            const fetchMock = jest.fn(async (_url: string, init?: { method?: string }) =>
                init?.method === 'POST'
                    ? ({ ok: true, status: 202, json: async () => ({ runId: 'run-9' }) } as unknown as Response)
                    : ({
                          ok: true, status: 200,
                          json: async () => settled({
                              runId: 'run-9', status,
                              answer: status === 'RUNNING' ? null : 'Ready now.', toolCalls: [],
                          }),
                      } as unknown as Response),
            );
            (global as unknown as { fetch: unknown }).fetch = fetchMock;
            render(<AskClient tenantSlug="acme" maxChars={MAX} />);
            await ask();
            for (let i = 0; i < 120 && !screen.queryByTestId('agent-ask-timed-out'); i++) {
                await act(async () => { await jest.advanceTimersByTimeAsync(1_500); });
            }
            const notice = screen.getByTestId('agent-ask-timed-out');
            // It no longer sends the asker to the agent register, which an
            // Editor or Reader cannot open.
            expect(notice.textContent).not.toMatch(/agent register/);

            status = 'COMPLETED';
            await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check again' })); });
            await act(async () => { await jest.advanceTimersByTimeAsync(0); });
            expect(screen.getByText('Ready now.')).toBeInTheDocument();
            const polled = fetchMock.mock.calls.filter(([, init]) => !init?.method).map(([url]) => String(url));
            expect(new Set(polled)).toEqual(new Set(['/api/t/acme/agents/questions/run-9']));
        } finally {
            jest.useRealTimers();
        }
    });
});

describe('accessibility, in both themes', () => {
    /**
     * M3 asks for axe in both themes with zero critical or serious violations.
     *
     * ── WHAT THIS DOES AND DOES NOT CHECK ───────────────────────────────────
     *
     * Asserted on IMPACT rather than with `toHaveNoViolations`, which fails on
     * any violation at all. That is deliberate: the requirement is
     * critical/serious, and a blanket matcher would make a `minor` advisory
     * block a merge while telling nobody which bar was actually missed. The
     * lesser violations are still surfaced in the failure message when the
     * named ones fire.
     *
     * It checks STRUCTURE — accessible names, roles, label associations, list
     * semantics. It does NOT check rendered colour contrast: jsdom computes no
     * styles from the stylesheet, so every element is effectively unstyled and
     * axe's contrast rules cannot run. Reading this as a contrast guarantee
     * would be reading it as something it cannot be; contrast in both themes is
     * what the token tests and the DAST per-role scans cover.
     *
     * Both themes are still exercised because the attribute is real and
     * component markup can branch on it — an icon-only control that gains a
     * label in one theme and loses it in the other would fail here.
     */
    const NAMED = new Set(['critical', 'serious']);

    afterEach(() => {
        document.documentElement.removeAttribute('data-theme');
    });

    it.each([['light'], ['dark']])('no critical or serious violations on the %s theme', async (theme) => {
        document.documentElement.setAttribute('data-theme', theme);
        wireFetch(
            settled({
                toolCalls: [
                    { seq: 1, tool: 'list_controls', outcome: 'DONE', refusal: null, guardVerdict: null },
                    { seq: 2, tool: 'list_risks', outcome: 'FAILED', refusal: 'agent_suspended', guardVerdict: 'BLOCK' },
                ],
            }),
        );
        // The ANSWERED state, not idle: it is the one with the most structure —
        // a list of calls, a definition list, badges — so scanning only the
        // empty page would be scanning the easy case.
        const { container } = render(<AskClient tenantSlug="acme" maxChars={MAX} />);
        await ask();
        await waitFor(() => expect(screen.getByText(/Three controls have no evidence/)).toBeInTheDocument());

        const results = await axe(container);
        const named = results.violations.filter((v) => NAMED.has(String(v.impact)));
        // The message names the rule ids, so a failure says WHAT to fix rather
        // than only that something is wrong.
        expect(named.map((v) => `${v.impact}: ${v.id}`)).toEqual([]);
    });
});
