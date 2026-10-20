/**
 * The tool an agent sends an A2A task with (#3679; threat-model O0–O3).
 *
 * One tool per OUTBOUND CONNECTION, named `mcp__<connectionId>__a2a_send_task`
 * through the same `externalToolName` every external tool uses. That is what
 * puts it on the external path rather than beside it: the grant is per agent
 * and per connection (`RegisteredAgentTool`), `dataScopeForToolCall` answers
 * `EXTERNAL_EGRESS` for it, the autonomy rung and `admin.agent_external_tools`
 * are the external tool's, and the call goes through `authorizeToolCall` like
 * any other.
 *
 * ## The definition is Inflect's, and constant
 *
 * Nothing the peer wrote reaches the model through this tool: not its card's
 * description, not its skills' text, not even the operator's display name. A
 * card is instruction text another organisation controls (tool poisoning, O1 T),
 * and the pin exists so a person reviews it — but the model never needs it to
 * send a task, so it is never shown. The definition is a constant, so the
 * manifest pin `authorizeToolCall` takes over it describes text this build
 * wrote.
 *
 * ## Every send is a write
 *
 * No `annotations`: `declaresWrite` reads an undeclared tool as a write, and
 * the A2A path never consults a peer's declaration at all (O3 E). Asking
 * another organisation's agent to act is a write whatever it says about itself.
 */
import { z } from 'zod';

import { externalToolName, parseExternalToolName } from '@/lib/mcp/external-tool-name';

import { A2A_MAX_TEXT_CHARS } from './protocol';

export const A2A_SEND_TOOL = 'a2a_send_task';

export function a2aSendToolName(connectionId: string): string {
    return externalToolName(connectionId, A2A_SEND_TOOL);
}

/** The connection id a send tool's qualified name names, or `null` for any other name. */
export function a2aSendConnectionId(qualified: string): string | null {
    const ref = parseExternalToolName(qualified);
    return ref && ref.toolName === A2A_SEND_TOOL ? ref.connectionId : null;
}

export const A2A_SEND_TOOL_DEFINITION = {
    name: A2A_SEND_TOOL,
    description:
        'Send a task to this connection\'s A2A peer: an agent run by another organisation, '
        + 'registered and pinned by this workspace. The peer is fixed by the tool; you choose only '
        + 'the task text. Every send is an external write and follows this connection\'s rung: it '
        + 'is recorded without sending, queued for a person to approve, or queued for unattended '
        + 'dispatch. It is never sent from inside this call, and the peer\'s answer is not returned '
        + 'here. Put in the task only what the peer needs; never a secret.',
    inputSchema: {
        type: 'object',
        properties: {
            text: {
                type: 'string',
                maxLength: A2A_MAX_TEXT_CHARS,
                description: 'What you are asking the peer to do.',
            },
            contextId: { type: 'string', maxLength: 128, description: 'Continue an earlier conversation with this peer.' },
            taskId: { type: 'string', maxLength: 128, description: 'Reply within a task the peer asked for more input on.' },
            skillId: { type: 'string', maxLength: 128, description: 'Which of the peer\'s skills the task is for.' },
        },
        required: ['text'],
        additionalProperties: false,
    } as Record<string, unknown>,
} as const;

/** The arguments as dispatched, after any parameter set. Strict: nothing else leaves. */
export const A2aSendArgsSchema = z
    .object({
        text: z.string().min(1).max(A2A_MAX_TEXT_CHARS),
        contextId: z.string().min(1).max(128).optional(),
        taskId: z.string().min(1).max(128).optional(),
        skillId: z.string().min(1).max(128).optional(),
    })
    .strict();

export type A2aSendArgs = z.infer<typeof A2aSendArgsSchema>;

/**
 * What an outbound send's journal row records as the state it acts on (R9).
 *
 * An A2A send replaces no object at the far end; it asks another organisation
 * to act. So the "prior state" is the basis the send was authorised on: WHICH
 * card a person had pinned, at which revision, and which conversation it
 * continues. Deterministic — no clock — so the dispatch pass can recompute it
 * and refuse a row whose basis moved (a re-approved card) between the decision
 * and the send.
 */
export function a2aSendPriorState(input: {
    peerId: string;
    pin: { cardHash: string; endpointHash: string; revision: number };
    args: A2aSendArgs;
}): Record<string, unknown> {
    return {
        kind: 'a2a-send/v1',
        peerId: input.peerId,
        pinnedCardHash: input.pin.cardHash,
        pinnedEndpointHash: input.pin.endpointHash,
        pinRevision: input.pin.revision,
        contextId: input.args.contextId ?? null,
        taskId: input.args.taskId ?? null,
    };
}
