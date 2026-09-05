/**
 * Unit tests — agent-action-receipt usecase (ingest + verify + link + list).
 *
 * Behavioural coverage of the ingest path with the module seams mocked. The
 * structural ratchet (indexes, license, scrub bounds) lives in
 * tests/guards/agent-action-receipt.test.ts.
 */
import { generateKeyPairSync, sign as cryptoSign } from 'crypto';

import { receiptSignedMessage, type PipelockReceipt } from '@/lib/mcp/receipt-verification';

function makeKeypair() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    return { pubHex, privateKey };
}

function signReceipt(actionRecord: Record<string, unknown>, key: ReturnType<typeof makeKeypair>): PipelockReceipt {
    const sig = cryptoSign(null, receiptSignedMessage(actionRecord), key.privateKey);
    return { action_record: actionRecord, signature: `ed25519:${sig.toString('hex')}`, signer_key: key.pubHex };
}

interface CapturedCreate {
    data: Record<string, unknown>;
}
const mockCaptured: CapturedCreate[] = [];
const mockEnv: { PIPELOCK_PUBLIC_KEY?: string } = {};
const mockAppend = jest.fn(() => Promise.resolve({ id: 'audit-1', entryHash: 'h', previousHash: null }));
let mockFindManyResult: unknown[] = [];

jest.mock('@/env', () => ({ env: mockEnv }));
jest.mock('@/lib/observability', () => ({ log: jest.fn() }));
jest.mock('@/lib/audit', () => ({ appendAuditEntry: (...args: unknown[]) => mockAppend(...(args as [])) }));
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (_ctx: unknown, cb: (db: unknown) => unknown) =>
        cb({
            agentActionReceipt: {
                create: (args: CapturedCreate) => {
                    mockCaptured.push(args);
                    return Promise.resolve({ id: 'receipt-1' });
                },
                findMany: () => Promise.resolve(mockFindManyResult),
                findFirst: () => Promise.resolve(null),
            },
            // The tool-manifest pin the ingest path stamps onto every receipt.
            // `null` here — nothing pinned — is the case that keeps this suite
            // about signature verification and the audit link; the provenance
            // stamp has its own suite in
            // tests/integration/agent-receipt-tool-provenance.test.ts.
            mcpToolManifestPin: { findUnique: () => Promise.resolve(null) },
        }),
}));

import { ingestReceipt, listReceipts } from '@/app-layer/usecases/agent-action-receipt';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    mockCaptured.length = 0;
    mockAppend.mockClear();
    mockFindManyResult = [];
});

describe('ingestReceipt', () => {
    it('links a verified receipt to a hash-chained audit entry', async () => {
        const key = makeKeypair();
        mockEnv.PIPELOCK_PUBLIC_KEY = key.pubHex;
        const receipt = signReceipt(
            { tool: 'list_risks', verdict: 'allow', policy: 'balanced-v1', timestamp: '2026-07-03T10:00:00.000Z' },
            key,
        );

        const res = await ingestReceipt(makeRequestContext('ADMIN'), receipt);

        expect(res.verified).toBe(true);
        expect(res.auditLogId).toBe('audit-1');
        expect(mockAppend).toHaveBeenCalledTimes(1);
        expect(mockCaptured[0].data.toolName).toBe('list_risks');
        expect(mockCaptured[0].data.verified).toBe(true);
    });

    it('flags an unverified receipt without any audit link', async () => {
        const key = makeKeypair();
        const other = makeKeypair();
        mockEnv.PIPELOCK_PUBLIC_KEY = other.pubHex; // configured key does not match the signer
        const receipt = signReceipt({ tool: 'x', verdict: 'allow' }, key);

        const res = await ingestReceipt(makeRequestContext('ADMIN'), receipt);

        expect(res.verified).toBe(false);
        expect(res.auditLogId).toBeNull();
        expect(mockAppend).not.toHaveBeenCalled();
        expect(mockCaptured[0].data.verified).toBe(false);
    });

    it('rejects a write attempt without write permission', async () => {
        const key = makeKeypair();
        mockEnv.PIPELOCK_PUBLIC_KEY = key.pubHex;
        const receipt = signReceipt({ tool: 'x', verdict: 'allow' }, key);
        await expect(ingestReceipt(makeRequestContext('READER'), receipt)).rejects.toThrow();
    });
});

describe('listReceipts', () => {
    it('returns tenant receipts', async () => {
        mockFindManyResult = [{ id: 'r1', toolName: 'list_risks', verified: true }];
        const rows = await listReceipts(makeRequestContext('ADMIN'), { limit: 10 });
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe('r1');
    });
});
