/**
 * The pure half of a Managed Agents reconnect (#5854, owner decision
 * 2026-11-25): the session checkpoint's seal and envelope, the plan read off a
 * session's history, and the Tool Runner's rule for each open call. The
 * engine's use of them is held over a real database in
 * `tests/integration/managed-agents-reconnect.test.ts`.
 */
import {
    SESSION_CHECKPOINT_FORMAT,
    answerOpenCalls,
    keptResultOf,
    openSessionCheckpoint,
    planReconnect,
    sealKeptResults,
    sealSessionCheckpoint,
    type HistoryEvent,
} from '@/lib/agentic/managed-agents/reconnect';
import {
    TOOL_CALL_NOT_RUN,
    TOOL_CALL_NOT_RUN_MESSAGE,
    TOOL_CALL_OUTCOME_UNKNOWN,
    TOOL_CALL_OUTCOME_UNKNOWN_MESSAGE,
} from '@/lib/agentic/tool-runner/transcript';

const stored = (over: { results?: unknown[]; inFlight?: string | null; sessionId?: string } = {}) => {
    const pointer = sealSessionCheckpoint({ sessionId: over.sessionId ?? 'sesn_a', spanEventId: 'sevt_span' });
    const results = sealKeptResults((over.results ?? []) as never);
    return {
        transcriptJson: pointer.json,
        transcriptHash: pointer.hash,
        resultsJson: results.json,
        resultsHash: results.hash,
        inFlightToolUseId: over.inFlight ?? null,
    };
};

describe('the session checkpoint', () => {
    it('opens what it sealed: the kept results and the call in flight', () => {
        const opened = openSessionCheckpoint(stored({ results: [{ id: 'c1', text: 'ok', isError: false }], inFlight: 'c2' }), 'sesn_a');
        expect(opened).toEqual({ ok: true, checkpoint: { kept: new Map([['c1', { id: 'c1', text: 'ok', isError: false }]]), inFlightCallId: 'c2' } });
        expect(JSON.parse(stored().transcriptJson)).toEqual({ format: SESSION_CHECKPOINT_FORMAT, sessionId: 'sesn_a', spanEventId: 'sevt_span' });
    });

    it('a checkpoint pointing at ANOTHER session holds nothing for this one', () => {
        const opened = openSessionCheckpoint(stored({ results: [{ id: 'c1', text: 'ok', isError: false }], inFlight: 'c2', sessionId: 'sesn_old' }), 'sesn_a');
        expect(opened).toEqual({ ok: true, checkpoint: { kept: new Map(), inFlightCallId: null } });
    });

    it('no checkpoint holds nothing', () => {
        expect(openSessionCheckpoint(null, 'sesn_a')).toEqual({ ok: true, checkpoint: { kept: new Map(), inFlightCallId: null } });
    });

    it('refuses a broken seal, a foreign envelope (the Tool Runner\'s) and a duplicated result', () => {
        const s = stored({ results: [{ id: 'c1', text: 'ok', isError: false }] });
        expect(openSessionCheckpoint({ ...s, resultsJson: s.resultsJson.replace('ok', 'no') }, 'sesn_a')).toEqual({ ok: false, reason: 'UNSEALED' });
        expect(openSessionCheckpoint({ ...s, transcriptHash: '0'.repeat(64) }, 'sesn_a')).toEqual({ ok: false, reason: 'UNSEALED' });
        const foreign = JSON.stringify({ format: 'inflect-tool-runner-checkpoint/1', model: 'm', tools: [], messages: [] });
        const { createHash } = jest.requireActual('crypto') as typeof import('crypto');
        expect(
            openSessionCheckpoint({ ...s, transcriptJson: foreign, transcriptHash: createHash('sha256').update(foreign).digest('hex') }, 'sesn_a'),
        ).toEqual({ ok: false, reason: 'UNREADABLE' });
        const twice = stored({ results: [{ id: 'c1', text: 'a', isError: false }, { id: 'c1', text: 'b', isError: false }] });
        expect(openSessionCheckpoint(twice, 'sesn_a')).toEqual({ ok: false, reason: 'UNREADABLE' });
    });

    it('a kept result is the engine\'s own answer: a string as it is, anything else as JSON, a throw as its message', () => {
        expect(keptResultOf('c', { returned: 'text' })).toEqual({ id: 'c', text: 'text', isError: false });
        expect(keptResultOf('c', { returned: { a: 1 } })).toEqual({ id: 'c', text: '{"a":1}', isError: false });
        expect(keptResultOf('c', { threw: new Error('refused') })).toEqual({ id: 'c', text: 'refused', isError: true });
        expect(keptResultOf('c', { threw: 'odd' })).toEqual({ id: 'c', text: 'The tool call failed.', isError: true });
    });
});

const ev = (id: string, type: string, extra: Record<string, unknown> = {}): HistoryEvent => ({ id, type, ...extra });

describe('the plan read off a session\'s history', () => {
    const history: HistoryEvent[] = [
        ev('e1', 'user.message'),
        ev('e2', 'span.model_request_start'),
        ev('c1', 'agent.custom_tool_use', { name: 'list_risks' }),
        ev('c2', 'agent.custom_tool_use', { name: 'list_controls' }),
        ev('s1', 'span.model_request_end'),
        ev('e3', 'session.status_idle'),
        ev('r1', 'user.custom_tool_result', { custom_tool_use_id: 'c1' }),
        ev('e4', 'span.model_request_start'),
        ev('c3', 'agent.custom_tool_use', { name: 'list_risks' }),
        ev('s2', 'span.model_request_end'),
    ];

    it('accounts through the last span the ledger recorded, and lists the calls with no result, in order', () => {
        const plan = planReconnect(history, new Set(['s1']));
        expect(plan).toMatchObject({
            stoppedEarlier: false,
            openingSent: true,
            accountedThrough: 4,
            lastEventId: 's2',
            openCalls: [{ id: 'c2', name: 'list_controls' }, { id: 'c3', name: 'list_risks' }],
        });
        expect([...plan.answered]).toEqual(['c1']);
        expect(planReconnect(history, new Set(['s1', 's2'])).accountedThrough).toBe(9);
        expect(planReconnect(history, new Set()).accountedThrough).toBe(-1);
    });

    it('an interrupt anywhere means an earlier attempt stopped the session', () => {
        expect(planReconnect([...history, ev('i', 'user.interrupt')], new Set()).stoppedEarlier).toBe(true);
    });

    it('a session that never got the opening says so', () => {
        expect(planReconnect([ev('x', 'session.status_idle')], new Set())).toMatchObject({ openingSent: false, openCalls: [], lastEventId: 'x' });
        expect(planReconnect([], new Set())).toMatchObject({ openingSent: false, lastEventId: null, accountedThrough: -1 });
    });
});

describe('each open call is answered by the Tool Runner\'s rule, and none is run', () => {
    it('kept as kept; the one in flight unknown; any other not run', () => {
        const answers = answerOpenCalls(
            [{ id: 'a', name: 't' }, { id: 'b', name: 't' }, { id: 'c', name: 't' }],
            { kept: new Map([['a', { id: 'a', text: 'kept', isError: false }]]), inFlightCallId: 'b' },
        );
        expect(answers).toEqual([
            { id: 'a', name: 't', answer: 'KEPT', text: 'kept', isError: false },
            { id: 'b', name: 't', answer: TOOL_CALL_OUTCOME_UNKNOWN, text: TOOL_CALL_OUTCOME_UNKNOWN_MESSAGE, isError: true },
            { id: 'c', name: 't', answer: TOOL_CALL_NOT_RUN, text: TOOL_CALL_NOT_RUN_MESSAGE, isError: true },
        ]);
    });

    it('a kept result outranks an in-flight marker naming the same call', () => {
        const [only] = answerOpenCalls([{ id: 'a', name: 't' }], { kept: new Map([['a', { id: 'a', text: 'x', isError: true }]]), inFlightCallId: 'a' });
        expect(only).toMatchObject({ answer: 'KEPT', isError: true });
    });
});
