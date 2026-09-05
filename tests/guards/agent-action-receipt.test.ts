/**
 * Ratchet — agent-action receipts (pipelock CORE, Apache-2.0).
 *
 * Locks the load-bearing invariants:
 *   1. SIGNATURE GATE — a correctly-signed receipt verifies and links to a
 *      hash-chained AuditLog entry; a TAMPERED or absent-signature receipt is
 *      rejected/flagged and does NOT link to an AuditLog entry.
 *   2. scannedSummary is size-capped and contains no credential/PII (a planted
 *      secret is redacted; an oversize blob is dropped to a marker).
 *   3. AgentActionReceipt carries the two tenantId-leading indexes; the verify
 *      path writes through the usecase / runInTenantContext (no global-`prisma`
 *      write).
 *   4. LICENSE — no phantom pipelock/fleet npm dependency; NOTICE credits the
 *      Apache-2.0 CORE; the verifier documents the Apache-core boundary.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
    generateKeyPairSync,
    sign as cryptoSign,
    createHash,
} from 'crypto';

import {
    canonicalizeActionRecord,
    receiptSignedMessage,
    verifyReceiptSignature,
    boundAndScrubSummary,
    SCANNED_SUMMARY_MAX_BYTES,
    PipelockReceiptSchema,
    type PipelockReceipt,
} from '@/lib/mcp/receipt-verification';

const REPO_ROOT = join(__dirname, '..', '..');

// ── In-test Ed25519 keypair + signer (mirrors pipelock's signer) ────────────

function makeKeypair() {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    // Raw 32-byte public key = last 32 bytes of the SPKI DER encoding.
    const pubHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    return { pubHex, privateKey };
}

function signReceipt(
    actionRecord: Record<string, unknown>,
    key: ReturnType<typeof makeKeypair>,
): PipelockReceipt {
    const message = receiptSignedMessage(actionRecord);
    const sig = cryptoSign(null, message, key.privateKey);
    return {
        action_record: actionRecord,
        signature: `ed25519:${sig.toString('hex')}`,
        signer_key: key.pubHex,
    };
}

const SAMPLE_RECORD = {
    tool: 'list_controls',
    verdict: 'allow',
    policy: 'balanced-v1',
    timestamp: '2026-07-03T10:00:00.000Z',
    agent_id: 'agent-42',
    scanned: { target: 'api.anthropic.com', bytes: 1024 },
};

// ── Mocked module boundaries for the ingestReceipt integration ───────────────

interface CapturedCreate {
    data: Record<string, unknown>;
}
const mockCaptured: CapturedCreate[] = [];
const mockEnv: { PIPELOCK_PUBLIC_KEY?: string; PIPELOCK_STRICT_MODE?: string } = {};
const mockAppend = jest.fn(() => Promise.resolve({ id: 'audit-1', entryHash: 'h', previousHash: null }));

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
                findMany: () => Promise.resolve([]),
                findFirst: () => Promise.resolve(null),
            },
            // The tool-manifest pin the ingest path stamps onto every receipt.
            // `null` — nothing pinned — keeps this suite about the signature
            // gate; the provenance stamp is proved in
            // tests/integration/agent-receipt-tool-provenance.test.ts.
            mcpToolManifestPin: { findUnique: () => Promise.resolve(null) },
        }),
}));

// Imported AFTER the mocks are registered.
import { ingestReceipt } from '@/app-layer/usecases/agent-action-receipt';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => {
    mockCaptured.length = 0;
    mockAppend.mockClear();
});

// ── 1. Signature gate (pure verify) ─────────────────────────────────────────

describe('signature verification', () => {
    it('accepts a correctly-signed receipt', () => {
        const key = makeKeypair();
        const receipt = signReceipt({ ...SAMPLE_RECORD }, key);
        const res = verifyReceiptSignature(receipt, key.pubHex);
        expect(res.valid).toBe(true);
        expect(res.signingKeyId).toBe(key.pubHex);
    });

    it('rejects a receipt whose action_record was tampered after signing', () => {
        const key = makeKeypair();
        const receipt = signReceipt({ ...SAMPLE_RECORD }, key);
        // Mutate a signed field — the signature no longer matches.
        const tampered: PipelockReceipt = {
            ...receipt,
            action_record: { ...receipt.action_record, verdict: 'block' },
        };
        const res = verifyReceiptSignature(tampered, key.pubHex);
        expect(res.valid).toBe(false);
        expect(res.reason).toBe('signature_invalid');
    });

    it('rejects when no public key is configured (fail closed)', () => {
        const key = makeKeypair();
        const receipt = signReceipt({ ...SAMPLE_RECORD }, key);
        expect(verifyReceiptSignature(receipt, undefined).valid).toBe(false);
        expect(verifyReceiptSignature(receipt, '').reason).toBe('no_configured_key');
    });

    it('rejects a receipt signed by a different key (signer mismatch / wrong key)', () => {
        const key = makeKeypair();
        const other = makeKeypair();
        const receipt = signReceipt({ ...SAMPLE_RECORD }, key);
        // Configured key belongs to a different keypair.
        const res = verifyReceiptSignature(receipt, other.pubHex);
        expect(res.valid).toBe(false);
    });

    it('canonicalization is deterministic + key-order independent', () => {
        const a = canonicalizeActionRecord({ b: 1, a: 2, nested: { y: 1, x: 2 } });
        const b = canonicalizeActionRecord({ nested: { x: 2, y: 1 }, a: 2, b: 1 });
        expect(a).toBe(b);
        // The signed message is the SHA-256 of that canonical form.
        expect(receiptSignedMessage({ a: 1 })).toEqual(
            createHash('sha256').update(canonicalizeActionRecord({ a: 1 })).digest(),
        );
    });
});

// ── 1b. Signature gate through ingestReceipt (audit-link behaviour) ──────────

describe('ingestReceipt audit linkage', () => {
    it('verified receipt → writes an AuditLog entry and links it', async () => {
        const key = makeKeypair();
        mockEnv.PIPELOCK_PUBLIC_KEY = key.pubHex;
        const receipt = signReceipt({ ...SAMPLE_RECORD }, key);

        const result = await ingestReceipt(makeRequestContext('ADMIN'), receipt);

        expect(result.verified).toBe(true);
        expect(result.auditLogId).toBe('audit-1');
        expect(mockAppend).toHaveBeenCalledTimes(1);
        expect(mockCaptured).toHaveLength(1);
        expect(mockCaptured[0].data.verified).toBe(true);
        expect(mockCaptured[0].data.auditLogId).toBe('audit-1');
    });

    it('tampered receipt → NO AuditLog entry, persisted flagged + unlinked', async () => {
        const key = makeKeypair();
        mockEnv.PIPELOCK_PUBLIC_KEY = key.pubHex;
        const receipt = signReceipt({ ...SAMPLE_RECORD }, key);
        const tampered: PipelockReceipt = {
            ...receipt,
            action_record: { ...receipt.action_record, verdict: 'block' },
        };

        const result = await ingestReceipt(makeRequestContext('ADMIN'), tampered);

        expect(result.verified).toBe(false);
        expect(result.auditLogId).toBeNull();
        expect(mockAppend).not.toHaveBeenCalled();
        expect(mockCaptured[0].data.verified).toBe(false);
        expect(mockCaptured[0].data.auditLogId).toBeNull();
    });

    it('absent signature → rejected at parse (never linked)', async () => {
        mockEnv.PIPELOCK_PUBLIC_KEY = makeKeypair().pubHex;
        const noSig = { action_record: { ...SAMPLE_RECORD }, signer_key: 'abcd' };
        await expect(ingestReceipt(makeRequestContext('ADMIN'), noSig)).rejects.toThrow();
        expect(mockAppend).not.toHaveBeenCalled();
        expect(PipelockReceiptSchema.safeParse(noSig).success).toBe(false);
    });
});

// ── 2. scannedSummary bounding + scrubbing ──────────────────────────────────

describe('scannedSummary scrubbing', () => {
    it('redacts planted credential/PII field names', () => {
        const out = boundAndScrubSummary({
            tool: 'run',
            apiKey: 'iflk_supersecretvalue',  // pragma: allowlist secret -- synthetic test input, not a real secret
            password: 'hunter2',
            authorization: 'Bearer xyz',
            safe: 'ok',
        });
        const serialized = JSON.stringify(out);
        expect(serialized).not.toContain('iflk_supersecretvalue');  // pragma: allowlist secret -- synthetic test input, not a real secret
        expect(serialized).not.toContain('hunter2');
        expect(serialized).not.toContain('Bearer xyz');
        expect(out.safe).toBe('ok');
    });

    it('summarizes a large blob string so no raw payload leaks', () => {
        const big = { blob: 'A'.repeat(SCANNED_SUMMARY_MAX_BYTES + 1000) };
        const out = boundAndScrubSummary(big);
        expect(JSON.stringify(out)).not.toContain('AAAAAAAAAA');
    });

    it('caps a summary that stays oversize after scrubbing (drops to a marker)', () => {
        // Many small fields that survive redaction but sum past the byte cap.
        const many: Record<string, string> = {};
        for (let i = 0; i < 500; i++) many[`field_${i}`] = `value-${i}-padding-xxxxxxxxxxxxxxxx`;
        const out = boundAndScrubSummary(many);
        expect(out._capped).toBe(true);
        expect(JSON.stringify(out)).not.toContain('value-0-padding');
    });

    it('planted secret is scrubbed on the ingest write path', async () => {
        const key = makeKeypair();
        mockEnv.PIPELOCK_PUBLIC_KEY = key.pubHex;
        const receipt = signReceipt(
            { tool: 'run', verdict: 'allow', secret: 'iflk_LEAK', timestamp: '2026-07-03T10:00:00.000Z' },  // pragma: allowlist secret -- synthetic test input, not a real secret
            key,
        );
        await ingestReceipt(makeRequestContext('ADMIN'), receipt);
        expect(JSON.stringify(mockCaptured[0].data.scannedSummary)).not.toContain('iflk_LEAK');  // pragma: allowlist secret -- synthetic test input, not a real secret
    });
});

// ── 3. Structural — indexes + no direct prisma in verify path ───────────────

describe('structural guarantees', () => {
    const automation = readFileSync(join(REPO_ROOT, 'prisma/schema/automation.prisma'), 'utf8');
    const usecase = readFileSync(join(REPO_ROOT, 'src/app-layer/usecases/agent-action-receipt.ts'), 'utf8');

    it('AgentActionReceipt carries the two tenantId-leading indexes', () => {
        const model = automation.slice(automation.indexOf('model AgentActionReceipt'));
        expect(model).toMatch(/@@index\(\[tenantId, occurredAt\]\)/);
        expect(model).toMatch(/@@index\(\[tenantId, mcpKeyId\]\)/);
    });

    it('verify path writes via runInTenantContext, never global prisma', () => {
        expect(usecase).toMatch(/runInTenantContext/);
        // No global-`prisma` client write in the usecase (must go through the tx db).
        expect(usecase).not.toMatch(/\bprisma\.agentActionReceipt/);
    });
});

// ── 4. License boundary ─────────────────────────────────────────────────────

describe('pipelock license boundary', () => {
    it('no phantom pipelock/fleet npm dependency', () => {
        const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };
        const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
        for (const name of Object.keys(all)) {
            expect(name).not.toMatch(/pipelock|fleet-receipt/i);
        }
    });

    it('NOTICE credits pipelock Apache-2.0 core', () => {
        const notice = readFileSync(join(REPO_ROOT, 'NOTICE'), 'utf8');
        expect(notice).toMatch(/pipelock/i);
        expect(notice).toMatch(/Apache-2\.0|Apache License/i);
    });

    it('verifier documents the Apache-core boundary', () => {
        const mod = readFileSync(join(REPO_ROOT, 'src/lib/mcp/receipt-verification.ts'), 'utf8');
        expect(mod).toMatch(/Apache-2\.0/);
        expect(mod).toMatch(/CORE/);
    });
});
