/**
 * R14 at the send (#5317): a journal row whose run was started by an INBOUND
 * principal never leaves — a peer's run and a host consumer's run alike. The
 * tool refuses both through `ctx.a2aInbound`; the send-time backstop asked only
 * about `inboundPeerId`, so a host-consumer-started run's row passed it.
 */
const settleWrite = jest.fn(async () => undefined);
const runRow: { current: { inboundPeerId: string | null; inboundHostConsumerId: string | null } | null } = {
    current: null,
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({ workflowRun: { findFirst: jest.fn(async () => runRow.current) } }),
    ),
}));
jest.mock('@/lib/agentic/kill-switch', () => ({ resolveKillState: jest.fn(async () => null) }));
jest.mock('@/app-layer/usecases/external-write-journal', () => ({
    ...jest.requireActual('@/app-layer/usecases/external-write-journal'),
    settleWrite: (...args: unknown[]) => settleWrite(...(args as [])),
}));

import { sendA2aJournalRow } from '@/app-layer/usecases/a2a-outbound';
import { makeRequestContext } from '../helpers/make-context';

const row = {
    id: 'journal-1',
    toolName: 'a2a_send__conn-1',
    mode: 'AUTOMATIC',
    argumentsJson: '{}',
    priorStateJson: '{}',
    parameterSetLabel: null,
    agentId: 'agent-1',
    runId: 'run-1',
};
const connection = { id: 'conn-1', configJson: { peerId: 'peer-1' }, secretEncrypted: null };

describe('the send-time R14 backstop', () => {
    beforeEach(() => settleWrite.mockClear());

    it('refuses a row whose run a HOST CONSUMER started', async () => {
        runRow.current = { inboundPeerId: null, inboundHostConsumerId: 'hc-1' };
        const outcome = await sendA2aJournalRow(makeRequestContext('ADMIN'), row, connection);
        expect(outcome).toBe('FAILED');
        expect(settleWrite).toHaveBeenCalledWith(
            expect.anything(),
            'journal-1',
            'FAILED',
            expect.stringMatching(/may not send to a peer/),
        );
    });

    it('still refuses a row whose run a PEER started', async () => {
        runRow.current = { inboundPeerId: 'peer-9', inboundHostConsumerId: null };
        const outcome = await sendA2aJournalRow(makeRequestContext('ADMIN'), row, connection);
        expect(outcome).toBe('FAILED');
        expect(settleWrite).toHaveBeenCalledWith(
            expect.anything(),
            'journal-1',
            'FAILED',
            expect.stringMatching(/may not send to a peer/),
        );
    });
});
