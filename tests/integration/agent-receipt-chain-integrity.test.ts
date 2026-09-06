/**
 * `verified` is trustworthy, or none of the evidence chain means anything.
 *
 * ## Why this file is the keystone
 *
 * Everything downstream — the artefacts emitted onto the agentic controls, the
 * counts an assessor reads, the claim that an action was independently attested
 * — rests on ONE boolean and ONE nullable foreign key. `AgentActionReceipt.verified`
 * says the mediator's Ed25519 signature checked out, and `auditLogId` says the
 * receipt has been bound to our hash-chained ledger. If either can be set
 * without the other having been earned, the evidence subsystem does not become
 * wrong loudly; it goes on producing artefacts that look exactly the same and
 * launders an unsigned assertion into a compliance record.
 *
 * So the assertions here are about the SEAM, not about the crypto library:
 *
 *   1. An UNVERIFIED receipt never receives an `auditLogId` — and no audit entry
 *      is written for it at all, because a link is not the only way a bad
 *      receipt could contaminate the ledger.
 *   2. A TAMPERED receipt — one whose `action_record` was edited after signing,
 *      which is the actual attack rather than a random-bytes signature — fails
 *      verification and is not linked.
 *   3. A VALID receipt links, and the `AuditLog` entry it links to leaves the
 *      hash chain verifying AFTERWARDS. That last clause is the one a reviewer
 *      skips: joining a chain must not break the chain you joined, and an audit
 *      row written outside the canonical writer would satisfy every other
 *      assertion in this file while leaving every later entry unverifiable.
 *
 * ## Why a real database
 *
 * The property is a relationship between two tables and a chain computed across
 * rows in `createdAt` order. A mocked Prisma can be made to report anything
 * about that; only a real ledger can be re-hashed and disagreed with.
 */
import { PrismaClient, MembershipStatus, Role } from '@prisma/client';
import { type KeyObject, generateKeyPairSync, sign as cryptoSign } from 'crypto';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';

/**
 * The trusted pipelock key, injected into `@/env` — which snapshots
 * `process.env` at module load, so setting the variable from a test body is too
 * late. A Proxy over the real env keeps every OTHER variable authentic; a whole
 * mocked env object would silently blank the database URL this suite needs.
 *
 * Generated per run, never checked in: a committed Ed25519 private key is a real
 * secret by shape and the secret-detection guardrail is right to refuse one even
 * in a fixture.
 */
const mockKey: { value?: string } = {};
jest.mock('@/env', () => {
    const actual = jest.requireActual('@/env');
    return {
        ...actual,
        env: new Proxy(actual.env as Record<string, unknown>, {
            get: (target, prop) =>
                prop === 'PIPELOCK_PUBLIC_KEY' ? mockKey.value : Reflect.get(target, prop),
        }),
    };
});

import { receiptSignedMessage } from '@/lib/mcp/receipt-verification';
import { ingestReceipt } from '@/app-layer/usecases/agent-action-receipt';
import { appendAuditEntry, verifyAuditChain } from '@/lib/audit';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(60_000);

const TENANT = 'receipt-chain-integrity-tenant';

let ownerUserId = '';
let privateKey: KeyObject;

const ctx = () =>
    makeRequestContext('OWNER', { tenantId: TENANT, tenantSlug: TENANT, userId: ownerUserId });

interface ActionRecord {
    tool: string;
    verdict: string;
    policy: string;
    agent_id: string;
    timestamp: string;
    [k: string]: unknown;
}

const actionRecord = (overrides: Partial<ActionRecord> = {}): ActionRecord => ({
    tool: 'list_risks',
    verdict: 'allow',
    policy: 'default',
    agent_id: 'agent-under-test',
    timestamp: new Date().toISOString(),
    ...overrides,
});

/** A receipt signed over exactly the record it carries. */
function signedReceipt(record: ActionRecord) {
    const sig = cryptoSign(null, receiptSignedMessage(record), privateKey);
    return {
        action_record: record,
        signature: `ed25519:${sig.toString('hex')}`,
        signer_key: mockKey.value as string,
    };
}

/**
 * A receipt signed over one record and DELIVERED carrying another — the actual
 * tampering shape. A random-bytes signature would also fail verification, and it
 * would fail for a reason (malformed) that says nothing about whether the
 * signature is bound to the content.
 */
function tamperedReceipt(signedOver: ActionRecord, delivered: ActionRecord) {
    const receipt = signedReceipt(signedOver);
    return { ...receipt, action_record: delivered };
}

async function clearOwnRows(): Promise<void> {
    await prisma.agentActionReceipt.deleteMany({ where: { tenantId: TENANT } });
    // The immutable-audit trigger and the last-OWNER guard both fire on an
    // ordinary DELETE and would take the teardown — and therefore the whole
    // suite — down with them.
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT);
    });
    await prisma.user.deleteMany({ where: { emailHash: hashForLookup(`owner@${TENANT}.test`) } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
}

beforeAll(async () => {
    const pair = generateKeyPairSync('ed25519');
    privateKey = pair.privateKey;
    mockKey.value = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');

    await resetDatabase(prisma);
    await clearOwnRows();

    await prisma.tenant.create({ data: { id: TENANT, name: 'Receipt Chain Integrity', slug: TENANT } });
    const email = `owner@${TENANT}.test`;
    const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    ownerUserId = user.id;
    await prisma.tenantMembership.create({
        data: { tenantId: TENANT, userId: user.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

beforeEach(async () => {
    await prisma.agentActionReceipt.deleteMany({ where: { tenantId: TENANT } });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT);
    });
});

describe('an unverified receipt is never linked to the audit chain', () => {
    it('a receipt signed by a key we do not trust is stored flagged, with no auditLogId', async () => {
        const stranger = generateKeyPairSync('ed25519');
        const record = actionRecord();
        const sig = cryptoSign(null, receiptSignedMessage(record), stranger.privateKey);
        const foreign = {
            action_record: record,
            signature: `ed25519:${sig.toString('hex')}`,
            signer_key: stranger.publicKey
                .export({ type: 'spki', format: 'der' })
                .subarray(-32)
                .toString('hex'),
        };

        const result = await ingestReceipt(ctx(), foreign);

        expect(result.verified).toBe(false);
        expect(result.auditLogId).toBeNull();

        const row = await prisma.agentActionReceipt.findUniqueOrThrow({
            where: { id: result.id },
            select: { verified: true, auditLogId: true },
        });
        expect(row.verified).toBe(false);
        expect(row.auditLogId).toBeNull();
    });

    it('writes no VERIFIED audit entry for it — the link is not the only way in', async () => {
        // A receipt that appended an entry and then declined to store the id
        // would leave an `AGENT_ACTION_RECEIPT_VERIFIED` row in a tenant's
        // immutable ledger asserting a verification that never happened. The
        // absence of a link would hide it from every join and from the previous
        // test.
        //
        // Scoped to that ACTION rather than counting the tenant's whole ledger:
        // the Prisma audit middleware writes a generic `CREATE AgentActionReceipt`
        // entry for every row, verified or not, and it is right to — it records
        // that a row was written, which is true, and asserts nothing about the
        // signature. The entry that must not appear is the one that makes a
        // claim.
        await ingestReceipt(ctx(), signedReceipt(actionRecord({ verdict: 'block' })));
        const before = await prisma.auditLog.count({
            where: { tenantId: TENANT, action: 'AGENT_ACTION_RECEIPT_VERIFIED' },
        });

        const stranger = generateKeyPairSync('ed25519');
        const record = actionRecord();
        const sig = cryptoSign(null, receiptSignedMessage(record), stranger.privateKey);
        await ingestReceipt(ctx(), {
            action_record: record,
            signature: `ed25519:${sig.toString('hex')}`,
            signer_key: stranger.publicKey
                .export({ type: 'spki', format: 'der' })
                .subarray(-32)
                .toString('hex'),
        });

        expect(
            await prisma.auditLog.count({
                where: { tenantId: TENANT, action: 'AGENT_ACTION_RECEIPT_VERIFIED' },
            }),
        ).toBe(before);
    });

    it('no stored receipt anywhere holds an auditLogId without verified', async () => {
        // The invariant stated over the POPULATION rather than over one row. The
        // emitter counts "verified AND linked" as attested actions; this is the
        // assertion that the two conditions cannot come apart.
        const stranger = generateKeyPairSync('ed25519');
        const strangerKey = stranger.publicKey
            .export({ type: 'spki', format: 'der' })
            .subarray(-32)
            .toString('hex');

        for (const verdict of ['allow', 'block', 'warn']) {
            await ingestReceipt(ctx(), signedReceipt(actionRecord({ verdict })));
            const bad = actionRecord({ verdict });
            const sig = cryptoSign(null, receiptSignedMessage(bad), stranger.privateKey);
            await ingestReceipt(ctx(), {
                action_record: bad,
                signature: `ed25519:${sig.toString('hex')}`,
                signer_key: strangerKey,
            });
        }

        const rows = await prisma.agentActionReceipt.findMany({
            where: { tenantId: TENANT },
            select: { verified: true, auditLogId: true },
        });
        expect(rows).toHaveLength(6);
        const linkedButUnverified = rows.filter((r) => !r.verified && r.auditLogId !== null);
        const verifiedButUnlinked = rows.filter((r) => r.verified && r.auditLogId === null);
        expect(linkedButUnverified).toEqual([]);
        expect(verifiedButUnlinked).toEqual([]);

        // And the ledger agrees on the size of the attested population: three
        // verifications claimed, three verifications recorded. A count that
        // exceeded the verified receipts would mean an entry was written for one
        // that failed.
        expect(rows.filter((r) => r.verified)).toHaveLength(3);
        expect(
            await prisma.auditLog.count({
                where: { tenantId: TENANT, action: 'AGENT_ACTION_RECEIPT_VERIFIED' },
            }),
        ).toBe(3);
    });
});

describe('a tampered receipt fails verification and is not linked', () => {
    it('editing one field of action_record after signing breaks the binding', async () => {
        // The signature is over SHA-256(canonical-json(action_record)), so a
        // verdict flipped from block to allow in transit is exactly what it must
        // catch. Everything else about the receipt is authentic: the signature is
        // a real signature, made by the trusted key, over a real record.
        const signedOver = actionRecord({ verdict: 'block' });
        const delivered = actionRecord({ ...signedOver, verdict: 'allow' });

        const result = await ingestReceipt(ctx(), tamperedReceipt(signedOver, delivered));

        expect(result.verified).toBe(false);
        expect(result.reason).toBe('signature_invalid');
        expect(result.auditLogId).toBeNull();

        const row = await prisma.agentActionReceipt.findUniqueOrThrow({
            where: { id: result.id },
            select: { verified: true, auditLogId: true, decisionVerdict: true },
        });
        expect(row.verified).toBe(false);
        expect(row.auditLogId).toBeNull();
        // Stored as DELIVERED, not as signed. The row is a record of what
        // arrived; the flag is the record of what could be believed about it.
        expect(row.decisionVerdict).toBe('allow');
        expect(
            await prisma.auditLog.count({
                where: { tenantId: TENANT, action: 'AGENT_ACTION_RECEIPT_VERIFIED' },
            }),
        ).toBe(0);
    });

    it('adding a field the signer never saw breaks it too', async () => {
        const signedOver = actionRecord();
        const delivered = actionRecord({ ...signedOver, injected: 'not-in-the-signed-message' });

        const result = await ingestReceipt(ctx(), tamperedReceipt(signedOver, delivered));

        expect(result.verified).toBe(false);
        expect(result.auditLogId).toBeNull();
    });
});

describe('a valid receipt links, and the chain it joins still verifies', () => {
    it('links to a real AuditLog row', async () => {
        const result = await ingestReceipt(ctx(), signedReceipt(actionRecord()));

        expect(result.verified).toBe(true);
        expect(result.auditLogId).not.toBeNull();

        const row = await prisma.agentActionReceipt.findUniqueOrThrow({
            where: { id: result.id },
            select: { verified: true, auditLogId: true },
        });
        expect(row.verified).toBe(true);
        expect(row.auditLogId).toBe(result.auditLogId);

        const entry = await prisma.auditLog.findUniqueOrThrow({
            where: { id: row.auditLogId as string },
            select: { action: true, entity: true, entryHash: true, tenantId: true },
        });
        expect(entry.action).toBe('AGENT_ACTION_RECEIPT_VERIFIED');
        expect(entry.entity).toBe('AgentActionReceipt');
        expect(entry.tenantId).toBe(TENANT);
        // A row with no entryHash is outside the chain, and an unhashed entry is
        // exactly what a hand-rolled insert would produce.
        expect(entry.entryHash).not.toBeNull();
    });

    it('leaves the hash chain verifying AFTERWARDS, with the linked entry inside it', async () => {
        // A chain whose LAST entry is the one under test verifies trivially — a
        // break shows up in the successor's `previousHash`, and there is no
        // successor. So the receipt's entry is put in the MIDDLE: an entry
        // before it, an entry after it.
        await appendAuditEntry({
            tenantId: TENANT,
            userId: ownerUserId,
            entity: 'Tenant',
            entityId: TENANT,
            action: 'BEFORE_THE_RECEIPT',
        });

        const result = await ingestReceipt(ctx(), signedReceipt(actionRecord()));
        expect(result.auditLogId).not.toBeNull();

        await appendAuditEntry({
            tenantId: TENANT,
            userId: ownerUserId,
            entity: 'Tenant',
            entityId: TENANT,
            action: 'AFTER_THE_RECEIPT',
        });

        const verification = await verifyAuditChain(TENANT, prisma);
        expect(verification.valid).toBe(true);
        expect(verification.firstBreakAt).toBeUndefined();
        // EVERY entry hashed. The verifier SKIPS unhashed rows, so a chain in
        // which the receipt's own entry carried no `entryHash` would be reported
        // `valid` while sitting entirely outside the thing that was verified —
        // "nothing was found" and "nothing was looked at" again.
        expect(verification.unhashedEntries).toBe(0);
        expect(verification.hashedEntries).toBe(verification.totalEntries);

        const ordered = await prisma.auditLog.findMany({
            where: { tenantId: TENANT },
            orderBy: { createdAt: 'asc' },
            select: { id: true, action: true, previousHash: true, entryHash: true },
        });

        // The chain re-walked here rather than only through `verifyAuditChain`:
        // the assertion the link must not break is about ADJACENCY, and it is
        // checked over the real neighbours the receipt's entry ended up with —
        // which include the generic `CREATE AgentActionReceipt` row the Prisma
        // audit middleware writes, not only the two entries this test appended.
        expect(ordered[0].previousHash).toBeNull();
        for (let i = 1; i < ordered.length; i += 1) {
            expect(ordered[i].previousHash).toBe(ordered[i - 1].entryHash);
        }

        const at = ordered.findIndex((e) => e.id === result.auditLogId);
        expect(at).toBeGreaterThan(0);
        expect(at).toBeLessThan(ordered.length - 1);
        expect(ordered[at].action).toBe('AGENT_ACTION_RECEIPT_VERIFIED');
        expect(ordered[at].entryHash).not.toBeNull();
        // Something the receipt's entry hangs off, and something that hangs off
        // it. Both directions, because a link that broke the chain would break
        // exactly one of them.
        expect(ordered[at].previousHash).toBe(ordered[at - 1].entryHash);
        expect(ordered[at + 1].previousHash).toBe(ordered[at].entryHash);
        expect(ordered.map((e) => e.action)).toContain('BEFORE_THE_RECEIPT');
        expect(ordered.map((e) => e.action)).toContain('AFTER_THE_RECEIPT');
    });

    it('a run of receipts leaves the whole chain verifying', async () => {
        for (const tool of ['list_risks', 'list_controls', 'list_evidence']) {
            const r = await ingestReceipt(ctx(), signedReceipt(actionRecord({ tool })));
            expect(r.verified).toBe(true);
        }

        const verification = await verifyAuditChain(TENANT, prisma);
        expect(verification.valid).toBe(true);
        expect(verification.unhashedEntries).toBe(0);
        expect(verification.hashedEntries).toBe(verification.totalEntries);
        expect(
            await prisma.auditLog.count({
                where: { tenantId: TENANT, action: 'AGENT_ACTION_RECEIPT_VERIFIED' },
            }),
        ).toBe(3);

        const linked = await prisma.agentActionReceipt.findMany({
            where: { tenantId: TENANT },
            select: { auditLogId: true },
        });
        const ids = linked.map((r) => r.auditLogId);
        // Three receipts, three DISTINCT entries. One entry reused across
        // receipts would verify as a chain and be worthless as attribution.
        expect(new Set(ids).size).toBe(3);
        expect(ids.every((id) => id !== null)).toBe(true);
    });
});
