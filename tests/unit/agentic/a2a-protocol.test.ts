/**
 * The A2A wire shapes (#3679): the inbound parser refuses what would make
 * Inflect dial an address a peer chose or carry more than a task, and the
 * outbound builder can say `message/send` and nothing else.
 */
import {
    A2A_CLIENT_METHODS,
    A2A_MAX_TEXT_CHARS,
    buildA2aSendBody,
    parseA2aInboundRequest,
    parseA2aPeerReply,
    taskStateForRunStatus,
} from '@/lib/agentic/a2a/protocol';

const send = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
        jsonrpc: '2.0',
        id: 'r1',
        method: 'message/send',
        params: {
            message: { kind: 'message', role: 'user', messageId: 'm1', metadata: { workflowKey: 'diagnostic' }, ...message },
            ...extra,
        },
    });

describe('inbound parsing', () => {
    it('reads a text task naming a workflow', () => {
        const r = parseA2aInboundRequest(send({ parts: [{ kind: 'text', text: 'please' }] }));
        expect(r).toEqual({
            ok: true,
            request: { method: 'message/send', rpcId: 'r1', messageId: 'm1', contextId: null, workflowKey: 'diagnostic', text: 'please', data: {} },
        });
    });

    it('refuses a file part — a URI is an address the peer chose (R10)', () => {
        const r = parseA2aInboundRequest(send({ parts: [{ kind: 'file', file: { uri: 'https://169.254.169.254/' } }] }));
        expect(r).toMatchObject({ ok: false, reason: 'FILE_PART_REFUSED' });
    });

    it('refuses a push-notification URL — results go back over the one wire (O6 I)', () => {
        const r = parseA2aInboundRequest(
            send({ parts: [{ kind: 'text', text: 'x' }] }, { configuration: { pushNotificationConfig: { url: 'https://evil.example' } } }),
        );
        expect(r).toMatchObject({ ok: false, reason: 'PUSH_NOTIFICATION_REFUSED' });
    });

    it('refuses every method outside the closed set, streaming included', () => {
        for (const method of ['message/stream', 'tools/call', 'tasks/cancel', 'tasks/pushNotificationConfig/set']) {
            const r = parseA2aInboundRequest(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }));
            expect({ method, r }).toMatchObject({ method, r: { ok: false, reason: 'METHOD_REFUSED' } });
        }
    });

    it('refuses an oversized task and a data part that is not a flat map of short strings (R20)', () => {
        expect(parseA2aInboundRequest(send({ parts: [{ kind: 'text', text: 'x'.repeat(A2A_MAX_TEXT_CHARS + 1) }] }))).toMatchObject({
            ok: false,
            reason: 'TEXT_TOO_LARGE',
        });
        expect(parseA2aInboundRequest(send({ parts: [{ kind: 'data', data: { nested: { a: 1 } } }] }))).toMatchObject({
            ok: false,
            reason: 'DATA_REFUSED',
        });
    });

    it('refuses a task that names no workflow', () => {
        expect(parseA2aInboundRequest(send({ parts: [{ kind: 'text', text: 'x' }], metadata: {} }))).toMatchObject({
            ok: false,
            reason: 'WORKFLOW_NOT_NAMED',
        });
    });

    it('refuses what is not JSON-RPC 2.0', () => {
        expect(parseA2aInboundRequest('{')).toMatchObject({ ok: false, reason: 'NOT_JSON' });
        expect(parseA2aInboundRequest(JSON.stringify({ id: 1, method: 'message/send' }))).toMatchObject({ ok: false, reason: 'NOT_JSONRPC' });
    });
});

describe('outbound', () => {
    it('the client method set is message/send, and tasks/get to ask after an accepted task (#3743)', () => {
        expect([...A2A_CLIENT_METHODS]).toEqual(['message/send', 'tasks/get']);
        expect(JSON.parse(buildA2aSendBody({ rpcId: 'j1', messageId: 'm1', text: 'go' })).method).toBe('message/send');
    });

    it('reads a peer task reply, and treats a reply to another request as malformed', () => {
        const body = JSON.stringify({ jsonrpc: '2.0', id: 'j1', result: { kind: 'task', id: 't9', status: { state: 'working' } } });
        expect(parseA2aPeerReply(body, 'j1')).toEqual({ kind: 'task', taskId: 't9', contextId: null, state: 'working' });
        expect(parseA2aPeerReply(body, 'j2')).toEqual({ kind: 'malformed' });
    });
});

describe('a run is reported to a peer as a task state', () => {
    it('a run waiting on a person here is working, not input-required; an unknown status is not a success', () => {
        expect(taskStateForRunStatus('AWAITING_APPROVAL')).toBe('working');
        expect(taskStateForRunStatus('COMPLETED')).toBe('completed');
        expect(taskStateForRunStatus('SOMETHING_NEW')).toBe('failed');
    });
});
