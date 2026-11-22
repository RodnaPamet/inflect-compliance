/**
 * The deferral transcript (Step 2f, "3. The transcript", #5530): sealed,
 * byte-faithful, and the deferred call's result written from the proposal row.
 */
import {
    TRANSCRIPT_FORMAT,
    decisionResult,
    openTranscript,
    resumedMessages,
    sealTranscript,
    type DeferralTranscript,
} from '@/lib/agentic/tool-runner/transcript';

const T = {
    format: TRANSCRIPT_FORMAT,
    model: 'm',
    system: [{ type: 'text', text: 's' }],
    tools: [{ name: 'propose_risks', input_schema: { type: 'object' } }],
    messages: [
        { role: 'user', content: 'go' },
        {
            role: 'assistant',
            content: [
                { type: 'thinking', thinking: 'why   not', signature: 'sig==' },
                { type: 'tool_use', id: 'tu_1', name: 'read', input: {} },
                { type: 'tool_use', id: 'tu_2', name: 'propose_risks', input: { items: [{}] } },
            ],
        },
    ],
    pendingResults: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'the read' },
        { type: 'tool_result', tool_use_id: 'tu_2', content: '' },
    ],
    toolUseId: 'tu_2',
} as unknown as DeferralTranscript;

describe('the deferral transcript', () => {
    it('opens what it sealed, objects untouched', () => {
        const { json, hash } = sealTranscript(T);
        const opened = openTranscript(json, hash);
        expect(opened.ok && JSON.stringify(opened.transcript)).toBe(json);
    });

    it('a transcript that no longer hashes to its seal is UNSEALED, and nothing is repaired', () => {
        const { json, hash } = sealTranscript(T);
        expect(openTranscript(json.replace('sig==', 'sig=X'), hash)).toEqual({ ok: false, reason: 'UNSEALED' });
    });

    it('a sealed envelope this build would not have written is UNREADABLE', () => {
        const bad = sealTranscript({ ...T, format: 'other' } as unknown as DeferralTranscript);
        expect(openTranscript(bad.json, bad.hash)).toEqual({ ok: false, reason: 'UNREADABLE' });
        const noSlot = sealTranscript({ ...T, toolUseId: 'tu_9' });
        expect(openTranscript(noSlot.json, noSlot.hash)).toEqual({ ok: false, reason: 'UNREADABLE' });
    });

    it('fills the open slot from the proposal row, and leaves every other block as it was', () => {
        const approved = decisionResult({ kind: 'RISK', operation: 'CREATE', status: 'ACCEPTED', createdEntityId: 'r1' });
        expect(approved).toEqual({ content: 'A person approved this proposal. It was created as RISK r1.', isError: false });
        expect(decisionResult({ kind: 'RISK', operation: 'CREATE', status: 'EDITED', createdEntityId: 'r1' }).content).toContain(
            'with changes',
        );
        const rejected = decisionResult({ kind: 'RISK', operation: 'CREATE', status: 'REJECTED', createdEntityId: null });
        expect(rejected).toEqual({ content: 'A person rejected this proposal. Nothing was created.', isError: true });
        const msgs = resumedMessages(T, rejected);
        expect(JSON.stringify(msgs.slice(0, 2))).toBe(JSON.stringify(T.messages));
        expect(msgs[2]).toEqual({
            role: 'user',
            content: [
                { type: 'tool_result', tool_use_id: 'tu_1', content: 'the read' },
                { type: 'tool_result', tool_use_id: 'tu_2', content: rejected.content, is_error: true },
            ],
        });
    });
});
