/**
 * Asking a peer about a task it accepted (#3743), the pure half: the body
 * Inflect sends, the method set that lets it leave, and how often a row is
 * asked.
 */
import { a2aPollDue, A2A_POLL_MAX_INTERVAL_MS, A2A_POLL_MIN_INTERVAL_MS } from '@/app-layer/usecases/a2a-outbound';
import {
    A2A_CLIENT_METHODS,
    buildA2aTaskGetBody,
    parseA2aInboundRequest,
} from '@/lib/agentic/a2a/protocol';
import { sendA2aMessage } from '@/lib/agentic/a2a/client';

describe('the tasks/get Inflect sends', () => {
    it('is a request Inflect\'s own inbound endpoint reads as tasks/get for that task', () => {
        // The pilot's peer is a second Inflect tenant (#3752), so the body one
        // tenant sends is the body the other parses.
        const body = buildA2aTaskGetBody({ rpcId: 'rpc-1', taskId: 'run-42' });
        expect(parseA2aInboundRequest(body)).toEqual({
            ok: true,
            request: { method: 'tasks/get', rpcId: 'rpc-1', taskId: 'run-42' },
        });
    });

    it('asks for the task by id and nothing else', () => {
        expect(JSON.parse(buildA2aTaskGetBody({ rpcId: 'r', taskId: 't' }))).toEqual({
            jsonrpc: '2.0',
            id: 'r',
            method: 'tasks/get',
            params: { id: 't' },
        });
    });

    it('is one of exactly two methods the client may send', () => {
        expect([...A2A_CLIENT_METHODS].sort()).toEqual(['message/send', 'tasks/get']);
    });

    it('the client still refuses every other method before anything leaves', async () => {
        const fetchImpl = jest.fn();
        const res = await sendA2aMessage({
            url: 'https://peer.example/a2a',
            body: JSON.stringify({ jsonrpc: '2.0', id: 'x', method: 'tasks/cancel', params: { id: 't' } }),
            receiptHeader: 'r',
            fetchImpl,
        });
        expect(res).toEqual({ ok: false, reason: 'METHOD_REFUSED', mayHaveArrived: false });
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe('how often an accepted row is asked', () => {
    const at = (ms: number) => new Date(Date.UTC(2026, 9, 20) + ms);
    const MIN = 60 * 1000;
    const HOUR = 60 * MIN;

    it('a row never asked is due at once', () => {
        expect(a2aPollDue(at(0), null, at(0))).toBe(true);
    });

    it('is asked no more often than the pass itself runs', () => {
        // Accepted a minute ago, asked a minute ago: a quarter of the age is
        // 15 seconds, and the floor holds it at ten minutes.
        expect(a2aPollDue(at(0), at(MIN), at(2 * MIN))).toBe(false);
        expect(a2aPollDue(at(0), at(MIN), at(MIN + A2A_POLL_MIN_INTERVAL_MS))).toBe(true);
    });

    it('waits a quarter of the time the row has been accepted', () => {
        // Accepted four hours ago: due an hour after the last ask.
        const now = at(4 * HOUR);
        expect(a2aPollDue(at(0), at(4 * HOUR - 59 * MIN), now)).toBe(false);
        expect(a2aPollDue(at(0), at(4 * HOUR - 60 * MIN), now)).toBe(true);
    });

    it('is asked at least every six hours, however long it has run', () => {
        const now = at(30 * 24 * HOUR);
        expect(a2aPollDue(at(0), at(30 * 24 * HOUR - A2A_POLL_MAX_INTERVAL_MS + MIN), now)).toBe(false);
        expect(a2aPollDue(at(0), at(30 * 24 * HOUR - A2A_POLL_MAX_INTERVAL_MS), now)).toBe(true);
    });
});
