/**
 * The assistant's capacity refusal reaches the person (#5170).
 *
 * The stream route answered a 429 with `{ error: "<reason>" }` while the hook
 * reads `error.message`, so the turn ended "The assistant is unavailable
 * (429)" and the reason — try again shortly, or close a conversation — was
 * lost. Driven through the REAL route handler's body shape and the real hook.
 */
import { act, renderHook } from '@testing-library/react';

import { useAssistantStream } from '@/components/assistant/use-assistant-stream';

const REASON = 'Too many assistant conversations are open for your organisation right now. Close one and try again.';

afterEach(() => {
    jest.restoreAllMocks();
});

it('shows the server reason on a 429, not a generic status line', async () => {
    global.fetch = jest.fn(async () => ({
        ok: false,
        status: 429,
        body: null,
        json: async () => ({ error: { code: 'RATE_LIMITED', message: REASON }, reason: 'TENANT_AT_CAPACITY' }),
    })) as unknown as typeof fetch;

    const { result } = renderHook(() => useAssistantStream('/api/t/acme/assistant/stream'));
    await act(async () => {
        await result.current.ask({ question: 'what is overdue?' });
    });

    const turn = result.current.turns[result.current.turns.length - 1];
    expect(turn.state.error).toBe(REASON);
});
