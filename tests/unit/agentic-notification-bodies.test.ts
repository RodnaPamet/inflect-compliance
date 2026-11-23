/**
 * The agentic bell bodies: the stored English is byte-for-byte what the
 * emitter has always written, and a stored body reads back into its slots.
 *
 * Rows written before the bodies moved into `agentic-bodies.ts` must still
 * render translated, and the only structure such a row carries is its text.
 * So the literals below are the sentences the emitter wrote BEFORE the move,
 * copied from it; a change to a shared sentence fails here rather than
 * silently leaving every stored row English.
 */
import {
    AGENTIC_SUBJECT,
    ORPHAN_DETAIL,
    agenticBodyText,
    agentIdSubject,
    parseAgenticBody,
    pinDetail,
    toolSubject,
} from '@/lib/notifications/agentic-bodies';
import type { AgenticNotificationKind } from '@/lib/notifications/agentic-titles';

const LEGACY: [AgenticNotificationKind, string, string | null, string][] = [
    [
        'AGENT_KILL_SWITCH_ENGAGED',
        'Every agent in this workspace',
        null,
        'Every agent in this workspace is stopped at the tool boundary, including runs already in flight. ' +
            'Its registered status is unchanged — lift the kill switch to let it act again.',
    ],
    [
        'AGENT_PROPOSAL_QUARANTINED',
        'an unattributed credential',
        null,
        'The output guard refused a write from an unattributed credential. Quarantine is terminal — ' +
            'the proposal cannot be approved. Read the attempted content before deciding ' +
            'whether the agent should keep running.',
    ],
    [
        'AGENT_CIRCUIT_BREAKER_TRIPPED',
        'Kestrel',
        'GUARD_BLOCK',
        'Kestrel was stopped automatically by its behavioural circuit breaker — firing signals: GUARD_BLOCK. ' +
            'It cannot act at the tool boundary until somebody closes the breaker with a reason.',
    ],
    [
        'AGENT_TOOL_MANIFEST_PIN_CHANGED',
        'The tool "read_risks"',
        'revision 2, replacing the definition previously on file',
        'The tool "read_risks" was accepted for every agent in this workspace, clearing the ' +
            "tool boundary's refusal (revision 2, replacing the definition previously on file). " +
            "A tool's description is instruction text the model reads, so an approval " +
            'nobody expected is a supply-chain event — check who approved it and why.',
    ],
    [
        'AGENT_RISK_ASSESSMENT_STALE',
        'Kestrel',
        'autonomyLevel 2 → 4',
        'Kestrel has been widened since its risk assessment was completed — autonomyLevel 2 → 4. ' +
            'Its tier has already been re-scored from the answers on file, so the ceiling ' +
            'is current; what may no longer hold are the answers themselves. Re-assess it.',
    ],
    [
        'AGENT_OWNER_DEPARTED',
        'Kestrel',
        null,
        'The accountable owner of Kestrel is no longer an active member of this ' +
            'workspace, or their HR record is terminated. ' +
            'Its ownership moves only by a two-step transfer: an OWNER proposes the new ' +
            'owner and the new owner accepts.',
    ],
];

describe('agentic bell bodies', () => {
    it.each(LEGACY)('%s is stored exactly as the emitter always wrote it', (kind, subject, detail, legacy) => {
        expect(agenticBodyText(kind, subject, detail)).toBe(legacy);
    });

    it.each(LEGACY)('%s reads back into its subject and detail', (kind, subject, detail, legacy) => {
        expect(parseAgenticBody(kind, legacy)).toStrictEqual({ subject, detail });
    });

    it('the phrases the callers pass are the ones they always passed', () => {
        expect(AGENTIC_SUBJECT.EVERY_AGENT).toBe('Every agent in this workspace');
        expect(AGENTIC_SUBJECT.UNATTRIBUTED_CREDENTIAL).toBe('an unattributed credential');
        expect(toolSubject('read_risks')).toBe('The tool "read_risks"');
        expect(agentIdSubject('a1')).toBe('Agent a1');
        expect(pinDetail(null)).toBe('first approval for this tool');
        expect(pinDetail(7)).toBe('revision 7, replacing the definition previously on file');
        expect(ORPHAN_DETAIL.WOULD_SUSPEND_AND_KILL).toBe(
            'the owner-orphan pass is in DRY_RUN, so it was NOT stopped. At AUTOMATIC it ' +
                'would be suspended and its kill switch engaged.',
        );
    });

    it('a body of another type, or not the type’s sentence, does not parse', () => {
        const kill = LEGACY[0][3];
        expect(parseAgenticBody('AGENT_PROPOSAL_QUARANTINED', kill)).toBeNull();
        expect(parseAgenticBody('AGENT_KILL_SWITCH_ENGAGED', `${kill} And something else.`)).toBeNull();
    });
});
