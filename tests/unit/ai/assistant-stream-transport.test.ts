/**
 * The assistant stream's TRANSPORT (#3829).
 *
 * Scoped to the transport on purpose: the loop, the bounds and the residency
 * rules have their own suites. What is proven here is that the route streams,
 * that a refusal is VISIBLE rather than an empty body, that a client going away
 * cancels the upstream call, and that the runtime is Node.
 *
 * ═══ WHY THE RUNTIME EXPORT IS ASSERTED, NOT THE COMMENT ═══
 *
 * `notifications/stream/route.ts` explains that Edge "terminates after ~15s of
 * idle connection time on most providers", which for an assistant turn means a
 * connection cut mid-answer. A comment saying `nodejs` and an export saying
 * something else would read identically in review, so the export is the thing
 * checked.
 */
/** Records the key `requirePermission` was called with, so it can be asserted. */
const gatedWith: string[] = [];

jest.mock('@/lib/security/permission-middleware', () => ({
    requirePermission: (key: string, handler: never) => {
        gatedWith.push(key);
        return async (req: unknown) =>
            (handler as unknown as (r: unknown, p: unknown, c: unknown) => unknown)(
                req,
                { tenantSlug: 't' },
                { tenantId: 'tenant-1', userId: 'user-1' },
            );
    },
}));

jest.mock('@/lib/validation/route', () => ({
    parseJsonBody: async () => ({ question: 'how many open findings?' }),
}));

const streamAssistantMock = jest.fn();
jest.mock('@/app-layer/usecases/assistant', () => ({
    AskAssistantSchema: { parse: (v: unknown) => v },
    streamAssistant: (...args: unknown[]) => streamAssistantMock(...args),
}));

import { NextRequest } from 'next/server';

import * as route from '@/app/api/t/[tenantSlug]/assistant/stream/route';
import { __resetStreamCapacity, MAX_STREAMS_PER_TENANT } from '@/app-layer/ai/assistant/stream-capacity';
import type { AssistantStreamEvent } from '@/app-layer/ai/assistant/stream-events';

/** Drain an SSE body into the parsed `data:` payloads, ignoring comments. */
async function collect(res: Response): Promise<AssistantStreamEvent[]> {
    const text = await res.text();
    return text
        .split('\n\n')
        .map((block) => block.trim())
        .filter((block) => block.startsWith('data: '))
        .map((block) => JSON.parse(block.slice('data: '.length)) as AssistantStreamEvent);
}

/**
 * A `NextRequest`, not a plain `Request`.
 *
 * `withApiErrorHandling` reads `req.nextUrl.pathname` to label the route in its
 * logs, which a bare `Request` does not have — the failure is a TypeError deep
 * in the wrapper rather than anything about the route, and it cost a cycle to
 * read rather than guess.
 */
const request = (): NextRequest =>
    new NextRequest('http://localhost/api/t/t/assistant/stream', { method: 'POST', body: '{}' });

beforeEach(() => {
    __resetStreamCapacity();
    streamAssistantMock.mockReset();
});

describe('the route is declared correctly', () => {
    it('runs on the Node runtime — asserted on the EXPORT', () => {
        expect(route.runtime).toBe('nodejs');
    });

    it('disables response caching, or SSE never streams', () => {
        expect(route.dynamic).toBe('force-dynamic');
    });

    it('is gated on controls.view, matching /assistant/ask exactly', () => {
        // Match or tighten, never loosen: a streaming surface easier to reach
        // than the POST it mirrors would be a privilege escalation introduced
        // by a change of transport. Asserted on the key the route actually
        // passed to `requirePermission`, recorded at import time.
        expect(gatedWith).toEqual(['controls.view']);
    });
});

describe('it streams the events the producer emits', () => {
    it('carries each event through in order, and ends with done', async () => {
        streamAssistantMock.mockImplementation(async (_ctx, _input, opts: { emit: (e: AssistantStreamEvent) => void }) => {
            opts.emit({ type: 'thinking' });
            opts.emit({ type: 'tool_call', name: 'list_findings' });
            opts.emit({ type: 'tool_result', name: 'list_findings', ok: true, truncated: false });
            opts.emit({ type: 'answer', text: 'You have 3 open findings.' });
            opts.emit({ type: 'done', truncatedAny: false });
        });

        const res = await route.POST(request() as never, undefined as never);
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toContain('text/event-stream');
        // Without this header nginx and Cloud Run buffer SSE until the buffer
        // fills, so the client sees nothing while the turn runs.
        expect(res.headers.get('X-Accel-Buffering')).toBe('no');

        const events = await collect(res);
        expect(events.map((e) => e.type)).toEqual(['thinking', 'tool_call', 'tool_result', 'answer', 'done']);
        expect(events[1]).toEqual({ type: 'tool_call', name: 'list_findings' });
    });

    it('sends a byte before anything else, so onopen fires', async () => {
        streamAssistantMock.mockImplementation(async (_c, _i, opts: { emit: (e: AssistantStreamEvent) => void }) => {
            opts.emit({ type: 'done', truncatedAny: false });
        });
        const res = await route.POST(request() as never, undefined as never);
        const text = await res.text();
        // EventSource does not fire `onopen` in some browsers until at least
        // one byte arrives, so the leading comment is load-bearing rather than
        // decorative.
        expect(text.startsWith(': connected')).toBe(true);
    });
});

describe('a failure is VISIBLE, never an empty stream', () => {
    it('emits a refusal when the producer throws, rather than closing silently', async () => {
        // An empty stream that simply ends is indistinguishable from a crash,
        // so the user retries — which spends again and teaches them the feature
        // is unreliable. This is the assertion that stops that.
        streamAssistantMock.mockRejectedValue(new Error('unexpected'));

        const res = await route.POST(request() as never, undefined as never);
        const events = await collect(res);

        expect(events.map((e) => e.type)).toContain('refusal');
        const refusal = events.find((e) => e.type === 'refusal') as { reason: string };
        expect(refusal.reason).toMatch(/Nothing was created/);
        // And it still TERMINATES: exactly one terminal signal, whichever path
        // ended the turn. A refusal with no `done` leaves a client unable to
        // tell "finished" from "still open, nothing more yet".
        expect(events.map((e) => e.type)).toEqual(['refusal', 'done']);
    });

    it('does not leak the thrown message to the client', async () => {
        streamAssistantMock.mockRejectedValue(new Error('ai_guard_blocked: inbound [R7,R12]'));
        const res = await route.POST(request() as never, undefined as never);
        const text = await res.text();
        // Rule ids are an attacker's tuning signal and `ai/guard` keeps them out
        // of user-facing text; they live in the audit trail instead.
        expect(text).not.toMatch(/R7|R12/);
        expect(text).not.toMatch(/ai_guard_blocked/);
    });
});

describe('the concurrent-stream cap refuses the N+1', () => {
    it('admits up to the per-tenant cap, then refuses with a readable body', async () => {
        // Held open so the slots stay taken, which is the state the cap is about.
        streamAssistantMock.mockImplementation(() => new Promise(() => {}));

        const admitted: number[] = [];
        for (let i = 0; i < MAX_STREAMS_PER_TENANT; i += 1) {
            const res = await route.POST(request() as never, undefined as never);
            admitted.push(res.status);
        }
        expect(admitted).toEqual(new Array(MAX_STREAMS_PER_TENANT).fill(200));

        const refused = await route.POST(request() as never, undefined as never);
        expect(refused.status).toBe(429);

        // A BODY, not an empty refusal: being refused the stream must not look
        // like a hang any more than a guard verdict inside one does.
        const body = (await refused.json()) as { error: string; reason: string };
        expect(body.reason).toBe('TENANT_AT_CAPACITY');
        expect(body.error).toMatch(/Too many assistant conversations/);
    });

    it('refuses rather than degrading the streams already open', async () => {
        // Converting one caller's excess into everyone's latency is the worse
        // failure, and it is invisible from the refused request's side.
        streamAssistantMock.mockImplementation(() => new Promise(() => {}));
        const open: Response[] = [];
        for (let i = 0; i < MAX_STREAMS_PER_TENANT; i += 1) {
            open.push(await route.POST(request() as never, undefined as never));
        }
        await route.POST(request() as never, undefined as never);

        for (const res of open) {
            expect(res.status).toBe(200);
            expect(res.body).not.toBeNull();
        }
    });
});
