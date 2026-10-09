/**
 * SENDING AN APPROVED EXTERNAL WRITE — and the four ways it is refused (#2861).
 *
 * Every assertion here is about what does NOT leave. The rung was checked at
 * approval and the human already said yes, so this pass adds no authority; what
 * it adds is the last chance to notice that the world moved.
 *
 * The drift test has a twin that matters as much: a refusal firing on KEY ORDER
 * would make the rung unusable while looking like a safety feature, so the
 * comparison is over canonical JSON and there is a test that proves reordering
 * is not drift. A detector that cannot tell "changed" from "serialised
 * differently" is worse than none, because it is believed.
 */
const callToolMock = jest.fn();
jest.mock('@/app-layer/integrations/mcp/client', () => ({
    callTool: (...a: unknown[]) => callToolMock(...a),
}));
jest.mock('@/app-layer/integrations/mcp/token', () => ({
    authorizationFor: jest.fn(async () => 'Bearer abc'),
}));
const settleWriteMock = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock('@/app-layer/usecases/external-write-journal', () => ({
    settleWrite: (...a: unknown[]) => settleWriteMock(...a),
}));
const getPriorStateReadMock = jest.fn();
jest.mock('@/app-layer/usecases/external-prior-state-read', () => ({
    getPriorStateRead: (...a: unknown[]) => getPriorStateReadMock(...a),
}));
jest.mock('@/lib/security/encryption', () => ({
    ...jest.requireActual('@/lib/security/encryption'),
    decryptField: (s: string) => s,
}));

const mockTx = {
    externalWriteJournal: { findMany: jest.fn() },
    integrationConnection: { findMany: jest.fn() },
};
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_c: unknown, fn: (db: unknown) => unknown) => fn(mockTx)),
}));

import {
    ASYNC_DELIVERY_TOOLS,
    runExternalWriteDispatch,
} from '@/app-layer/usecases/external-write-dispatch';
import { repoRelativeFiles } from '../helpers/repo-files';

const T = 'tenant-x';
const CONN = 'cmconnaaaaaaaaaaaaaaaaaa';
const WRITE = `mcp__${CONN}__set_alert_owner`;
const READ = `mcp__${CONN}__get_alert`;

const journalRow = (over: Record<string, unknown> = {}) => ({
    id: 'jrn_1',
    tenantId: T,
    connectionId: CONN,
    toolName: WRITE,
    advertisedToolName: 'set_alert_owner',
    argumentsJson: JSON.stringify({ id: 'a-1', owner: 'bob' }),
    priorStateJson: JSON.stringify({ owner: 'alice', tier: 2 }),
    ...over,
});

const connectionRow = (mode: string | null = 'PROPOSE_ONLY') => ({
    id: CONN,
    isEnabled: true,
    configJson: { url: 'https://mcp.example.test/endpoint' },
    secretEncrypted: JSON.stringify({ authorization: 'Bearer abc' }),
    externalWriteMode: mode,
});

/** The outcome settleWrite was called with, and its reason. */
const settled = () => {
    const c = settleWriteMock.mock.calls[0] as unknown[] | undefined;
    return c ? { outcome: c[2] as string, detail: (c[3] ?? null) as string | null } : null;
};
/** Did the WRITE tool leave? The read is allowed; the write is the question. */
const writeWasSent = () =>
    callToolMock.mock.calls.some((c) => c[1] === 'set_alert_owner');

beforeEach(() => {
    jest.clearAllMocks();
    mockTx.externalWriteJournal.findMany.mockResolvedValue([journalRow()]);
    mockTx.integrationConnection.findMany.mockResolvedValue([connectionRow()]);
    getPriorStateReadMock.mockResolvedValue({ writeToolName: WRITE, readToolName: READ });
    callToolMock.mockResolvedValue({ owner: 'alice', tier: 2 });
});

describe('the happy path', () => {
    it('re-reads, matches, sends, and settles APPLIED', async () => {
        const r = await runExternalWriteDispatch({ tenantId: T });
        expect(writeWasSent()).toBe(true);
        expect(settled()).toEqual({ outcome: 'APPLIED', detail: null });
        expect(r.applied).toBe(1);
    });

    it('sends the READ first, carrying the write\'s own arguments', async () => {
        await runExternalWriteDispatch({ tenantId: T });
        expect(callToolMock.mock.calls[0][1]).toBe('get_alert');
        expect(callToolMock.mock.calls[0][2]).toEqual({ id: 'a-1', owner: 'bob' });
    });
});

describe('drift', () => {
    it('REFUSES when the record changed, and sends nothing', async () => {
        callToolMock.mockResolvedValue({ owner: 'carol', tier: 2 });
        const r = await runExternalWriteDispatch({ tenantId: T });
        expect(writeWasSent()).toBe(false);
        expect(settled()!.outcome).toBe('FAILED');
        expect(settled()!.detail).toMatch(/no longer what would happen/);
        expect(r.refused).toBe(1);
    });

    it('does NOT fire on key order alone — the false positive that would kill the rung', async () => {
        // Same content, different serialisation. A refusal here would make every
        // approved write fail on a difference that is not one, and it would look
        // like the safety feature working.
        callToolMock.mockResolvedValue({ tier: 2, owner: 'alice' });
        const r = await runExternalWriteDispatch({ tenantId: T });
        expect(writeWasSent()).toBe(true);
        expect(r.applied).toBe(1);
    });

    it('DOES fire on a nested change, so the comparison is not shallow', async () => {
        mockTx.externalWriteJournal.findMany.mockResolvedValue([
            journalRow({ priorStateJson: JSON.stringify({ owner: 'alice', meta: { sla: 'gold' } }) }),
        ]);
        callToolMock.mockResolvedValue({ owner: 'alice', meta: { sla: 'bronze' } });
        const r = await runExternalWriteDispatch({ tenantId: T });
        expect(writeWasSent()).toBe(false);
        expect(r.refused).toBe(1);
    });
});

describe('what else refuses before sending', () => {
    it('a rung narrowed after approval', async () => {
        mockTx.integrationConnection.findMany.mockResolvedValue([connectionRow('DRY_RUN')]);
        await runExternalWriteDispatch({ tenantId: T });
        expect(writeWasSent()).toBe(false);
        expect(settled()!.detail).toMatch(/now at DRY_RUN/);
    });

    it('a pairing withdrawn after approval', async () => {
        getPriorStateReadMock.mockResolvedValue(null);
        await runExternalWriteDispatch({ tenantId: T });
        expect(writeWasSent()).toBe(false);
        expect(settled()!.detail).toMatch(/pairing was removed/);
    });

    it('a prior-state read that will not run', async () => {
        callToolMock.mockRejectedValue(new Error('boom'));
        await runExternalWriteDispatch({ tenantId: T });
        expect(writeWasSent()).toBe(false);
        expect(settled()!.outcome).toBe('FAILED');
    });

    it('a deleted connection', async () => {
        mockTx.integrationConnection.findMany.mockResolvedValue([]);
        await runExternalWriteDispatch({ tenantId: T });
        expect(writeWasSent()).toBe(false);
        expect(settled()!.detail).toMatch(/gone or disabled/);
    });
});

describe('a send that throws', () => {
    it('settles INDETERMINATE, never FAILED', async () => {
        // FAILED is a positive claim that the far end changed NOTHING. A lost
        // answer cannot support it: the request may have arrived and been
        // applied. An operator filtering on FAILED to find what needs no action
        // would skip exactly the row that does.
        callToolMock.mockImplementation(async (_t: unknown, name: string) => {
            if (name === 'get_alert') return { owner: 'alice', tier: 2 };
            throw new Error('socket hang up');
        });
        const r = await runExternalWriteDispatch({ tenantId: T });
        expect(settled()!.outcome).toBe('INDETERMINATE');
        expect(r.indeterminate).toBe(1);
        expect(r.refused).toBe(0);
    });
});

// ═════════════════════════════════════════════════════════════════════
// ACCEPTED IS NOT APPLIED — #3324
// ═════════════════════════════════════════════════════════════════════

/**
 * WHAT IS BEING PROTECTED
 * ───────────────────────
 * `callTool` returns when the far end TAKES the request. For entitlement
 * management that is acceptance, not delivery — measured at 3m09s apart against
 * a live licensed tenant, and a request can still fail after acceptance.
 *
 * So `APPLIED` there is a positive claim that the far end changed, which is the
 * exact mirror of the claim the catch arm is careful NOT to make:
 *
 *     INDETERMINATE, not FAILED. … FAILED is a positive claim that the far end
 *     changed nothing — which nobody here can make.
 *
 * Nobody at the POST site can make the inverse claim either. The asymmetry was
 * the bug: the failure path reasoned about what is knowable and the success
 * path assumed.
 */
describe('a tool whose far end delivers asynchronously settles ACCEPTED', () => {
    const GRANT = 'grant_time_bounded_access';

    beforeEach(() => {
        // Same harness, one field different: the tool this row names.
        mockTx.externalWriteJournal.findMany.mockResolvedValue([
            journalRow({ advertisedToolName: GRANT, toolName: `mcp__${CONN}__${GRANT}` }),
        ]);
        getPriorStateReadMock.mockResolvedValue({
            writeToolName: `mcp__${CONN}__${GRANT}`,
            readToolName: READ,
        });
    });

    it('settles ACCEPTED, not APPLIED', async () => {
        const r = await runExternalWriteDispatch({ tenantId: T });
        expect(settled()?.outcome).toBe('ACCEPTED');
        expect(r.accepted).toBe(1);
        // The load-bearing half: it must not ALSO be counted as applied, or an
        // operator reading "1 applied" believes a change happened.
        expect(r.applied).toBe(0);
    });

    it('carries a detail saying what is NOT yet known', async () => {
        // The row is terminal until something promotes it, and the operator
        // reading it has no other source for that distinction — so a null
        // detail here would be the whole defect with a different enum value.
        await runExternalWriteDispatch({ tenantId: T });
        const detail = settled()?.detail ?? '';
        expect(detail).toContain('accepted');
        expect(detail).toContain('not yet known');
        expect(detail.length).toBeGreaterThan(40);
    });

    it('the write WAS sent — this is not a refusal wearing a new name', async () => {
        await runExternalWriteDispatch({ tenantId: T });
        expect(callToolMock.mock.calls.some((c) => c[1] === GRANT)).toBe(true);
    });
});

describe('ASYNC_DELIVERY_TOOLS tracks what the endpoint actually advertises', () => {
    /**
     * A literal string in the dispatch goes stale the moment the endpoint
     * renames its tool, and the failure is SILENT: the grant would settle
     * `APPLIED` again with nothing reddening. This is the check that catches a
     * rename — the same shape as pinning a property rather than a token.
     *
     * Found by GLOB, not by path, because the route has already moved once
     * (#3323 relocated it off `/api/t/**`) and a pinned path would have broken
     * on that move while the thing it protects was still correct.
     */
    const routeFiles = repoRelativeFiles().filter(
        (f) => /^src\/app\/api\/.*entra-grant\/route\.ts$/.test(f),
    );

    it('found the grant endpoint at all — otherwise the check below is vacuous', () => {
        // The positive control. Without it, a glob that matches nothing makes
        // every assertion over it pass by having no subject.
        expect(routeFiles.length).toBeGreaterThanOrEqual(1);
    });

    it('declares every tool name the endpoint advertises as its WRITE verb', () => {
        const { readFileSync } = require('node:fs') as typeof import('node:fs');
        const { join } = require('node:path') as typeof import('node:path');
        const { REPO_ROOT } = require('../helpers/repo-files') as { REPO_ROOT: string };
        for (const rel of routeFiles) {
            const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
            // The grant verb specifically. The READ tool is read-only and never
            // reaches a journal row, so it is deliberately not required here.
            const m = /export const GRANT_TOOL = '([^']+)'/.exec(src);
            expect(m).not.toBeNull();
            expect(ASYNC_DELIVERY_TOOLS.has(m![1])).toBe(true);
        }
    });
});
