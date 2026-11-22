/**
 * THE SCHEDULED ASI07 CHECK, THROUGH THE REAL CONTROL-TEST RUNNER, ACROSS TWO
 * TENANTS (#5305 item 25, owner decision 2026-11-14).
 *
 * `AGENTIC_A2A_INTEGRITY` replaced an exemption that said no A2A transport
 * shipped. It runs on the runner the other agentic checks run on, so what is
 * asserted here is the whole chain against a real database:
 *
 *     ControlTestPlan(INTEGRATION, { check: 'AGENTIC_A2A_INTEGRITY' })
 *       → the registered handler, inside the runner's tenant transaction
 *       → ControlTestRun(PASS | FAIL | INCONCLUSIVE) + Evidence + on FAIL a Finding
 *
 * Two tenants hold A2A state at once. One has drifted four ways (a live card
 * off its pin, a peer left unpinned, a signing key past its age, a stored
 * receipt whose body was changed below the application); the other has not.
 * Each tenant's run sees its own rows only: the healthy tenant PASSES with none
 * of the other's peers in its evidence, and the drifted one FAILS naming each.
 *
 * The live card is the one thing not real: `recentAgentCard` is replaced, so
 * the test decides what each peer serves without a network.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { generateKeyPairSync, randomUUID, type KeyObject } from 'crypto';

const served = new Map<string, unknown>();
jest.mock('@/lib/agentic/a2a/card-cache', () => ({
    ...jest.requireActual('@/lib/agentic/a2a/card-cache'),
    recentAgentCard: jest.fn(async (key: { peerId: string }) => {
        const v = served.get(key.peerId);
        if (v === undefined) return { ok: false, reason: 'TIMEOUT' };
        return { ok: true, card: {}, hashes: v, fetchedAt: new Date() };
    }),
}));

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { runControlTestRunner, runnerHandlerRegistry } from '@/app-layer/jobs/control-test-runner';
import {
    A2A_SIGNING_KEY_MAX_AGE_DAYS,
    A2A_UNPINNED_GRACE_DAYS,
    AGENTIC_CHECKS,
    registerAgenticControlTestHandler,
} from '@/app-layer/services/agent-control-tests';
import { a2aBodyDigest, canonicalStatement, rawEd25519PublicKeyHex, signA2aReceipt } from '@/lib/agentic/a2a/receipt';
import { harnessKeyFingerprint } from '@/lib/agentic/harness-contract';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
    transactionOptions: TENANT_TX_OPTIONS,
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(180_000);

const SUITE = `a2ai-${randomUUID().slice(0, 8)}`;
const DRIFTED = `td-${SUITE}`;
const HEALTHY = `th-${SUITE}`;
const EMPTY = `te-${SUITE}`;
const USER = `u-${SUITE}`;
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (d: number) => new Date(Date.now() - d * DAY);

const PIN = { cardHash: 'c'.repeat(64), textHash: 'a'.repeat(64), endpointHash: 'e'.repeat(64), otherHash: 'b'.repeat(64) };

interface Keypair {
    privateKey: KeyObject;
    publicHex: string;
    fingerprint: string;
}

function keypair(): Keypair {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    const publicHex = rawEd25519PublicKeyHex(Buffer.from(spki.subarray(spki.length - 32)).toString('hex'))!;
    const fingerprint = harnessKeyFingerprint(publicHex);
    if (!fingerprint) throw new Error('fixture key has no fingerprint');
    return { privateKey, publicHex, fingerprint };
}

async function seedTenant(id: string): Promise<string> {
    await prisma.tenant.upsert({ where: { id }, update: {}, create: { id, name: id, slug: id } });
    await prisma.tenantMembership.upsert({
        where: { tenantId_userId: { tenantId: id, userId: USER } },
        update: {},
        create: { tenantId: id, userId: USER, role: 'OWNER', status: 'ACTIVE' },
    });
    const vendor = await prisma.vendor.create({ data: { tenantId: id, name: `${id} partner` } });
    return vendor.id;
}

async function seedPeer(
    tenantId: string,
    vendorId: string,
    signer: Keypair,
    opts: { pinned: boolean; createdAt?: Date },
): Promise<string> {
    const row = await prisma.peerAgent.create({
        data: {
            tenantId,
            name: `peer ${randomUUID().slice(0, 6)}`,
            cardUrl: `https://partner.example/${randomUUID()}/agent-card.json`,
            ownerUserId: USER,
            vendorId,
            signingPublicKey: signer.publicHex,
            signingKeyFingerprint: signer.fingerprint,
            riskTier: 'LOW',
            riskTierScoredAt: new Date(),
            createdByUserId: USER,
            createdAt: opts.createdAt ?? daysAgo(30),
            ...(opts.pinned
                ? {
                      pinnedCardHash: PIN.cardHash,
                      pinnedTextHash: PIN.textHash,
                      pinnedEndpointHash: PIN.endpointHash,
                      pinnedOtherHash: PIN.otherHash,
                      pinRevision: 1,
                      pinnedByUserId: USER,
                      pinnedAt: new Date(),
                  }
                : {}),
        },
    });
    return row.id;
}

async function seedSigningKey(tenantId: string, key: Keypair, createdAt: Date): Promise<void> {
    await prisma.tenantA2aSigningKey.create({
        data: {
            tenantId,
            publicKey: key.publicHex,
            fingerprint: key.fingerprint,
            privateKeySeed: 'seed-not-read-by-the-check',
            createdByUserId: USER,
            createdAt,
        },
    });
}

let seq = 0;
/** A stored receipt, signed for real; `bodyOverride` stores bytes other than the signed ones. */
async function seedReceipt(
    tenantId: string,
    peerId: string,
    direction: 'INBOUND' | 'OUTBOUND',
    signer: Keypair,
    bodyOverride?: string,
): Promise<string> {
    seq += 1;
    const body = JSON.stringify({ jsonrpc: '2.0', id: seq, method: 'message/send' });
    const signed = signA2aReceipt(
        {
            v: 'inflect-a2a-receipt/1',
            kind: 'TASK',
            messageId: `${SUITE}-m-${seq}`,
            relatesTo: null,
            method: 'message/send',
            sender: 'https://a.example',
            recipient: 'https://b.example',
            issuedAt: new Date().toISOString(),
            bodyDigest: a2aBodyDigest(body),
        },
        signer.privateKey,
    );
    const row = await prisma.peerAgentMessage.create({
        data: {
            tenantId,
            peerId,
            direction,
            kind: 'TASK',
            method: 'message/send',
            messageId: `${SUITE}-m-${seq}`,
            receiptJson: canonicalStatement(signed.statement),
            signature: signed.signature,
            signerKeyFingerprint: signer.fingerprint,
            signerPublicKey: signer.publicHex,
            bodyDigest: a2aBodyDigest(body),
            body: bodyOverride ?? body,
        },
    });
    return row.id;
}

async function seedPlan(tenantId: string): Promise<{ controlId: string; planId: string }> {
    const control = await prisma.control.create({ data: { tenantId, name: 'A2A integrity', createdByUserId: USER } });
    const plan = await prisma.controlTestPlan.create({
        data: {
            tenantId,
            controlId: control.id,
            name: 'A2A integrity plan',
            createdByUserId: USER,
            automationType: 'INTEGRATION',
            status: 'ACTIVE',
            schedule: '40 6 * * *',
            automationConfig: { check: 'AGENTIC_A2A_INTEGRITY' },
        },
    });
    return { controlId: control.id, planId: plan.id };
}

async function runPlan(tenantId: string, planId: string) {
    return runControlTestRunner({
        tenantId,
        testPlanId: planId,
        scheduledForIso: new Date().toISOString(),
        schedulerJobRunId: `${SUITE}-${randomUUID().slice(0, 8)}`,
    });
}

async function evidenceBodyFor(evidenceId: string | undefined): Promise<string> {
    if (!evidenceId) return '';
    const row = await prisma.evidence.findUnique({ where: { id: evidenceId }, select: { content: true } });
    return row?.content ?? '';
}

describeFn('AGENTIC_A2A_INTEGRITY on the real runner, two tenants at once', () => {
    const drifted = { movedPeer: '', unpinnedPeer: '', tamperedReceipt: '', planId: '', controlId: '' };
    const healthy = { peer: '', planId: '', controlId: '' };
    const empty = { planId: '', controlId: '' };

    beforeAll(async () => {
        await prisma.$connect();
        runnerHandlerRegistry._reset();
        registerAgenticControlTestHandler();
        const email = `${USER}@example.test`;
        await prisma.user.upsert({
            where: { id: USER },
            update: {},
            create: { id: USER, email, emailHash: hashForLookup(email) },
        });

        // ── The drifted tenant ──
        const dVendor = await seedTenant(DRIFTED);
        const dSigner = keypair();
        drifted.movedPeer = await seedPeer(DRIFTED, dVendor, dSigner, { pinned: true });
        drifted.unpinnedPeer = await seedPeer(DRIFTED, dVendor, keypair(), {
            pinned: false,
            createdAt: daysAgo(A2A_UNPINNED_GRACE_DAYS + 5),
        });
        await seedSigningKey(DRIFTED, keypair(), daysAgo(A2A_SIGNING_KEY_MAX_AGE_DAYS + 30));
        drifted.tamperedReceipt = await seedReceipt(DRIFTED, drifted.movedPeer, 'INBOUND', dSigner, '{"changed":true}');
        served.set(drifted.movedPeer, { ...PIN, cardHash: 'd'.repeat(64), textHash: 'f'.repeat(64) });
        Object.assign(drifted, await seedPlan(DRIFTED));

        // ── The healthy tenant ──
        const hVendor = await seedTenant(HEALTHY);
        const hSigner = keypair();
        const hOwn = keypair();
        healthy.peer = await seedPeer(HEALTHY, hVendor, hSigner, { pinned: true });
        await seedSigningKey(HEALTHY, hOwn, daysAgo(10));
        await seedReceipt(HEALTHY, healthy.peer, 'INBOUND', hSigner);
        await seedReceipt(HEALTHY, healthy.peer, 'OUTBOUND', hOwn);
        served.set(healthy.peer, PIN);
        Object.assign(healthy, await seedPlan(HEALTHY));

        // ── A tenant with no A2A state at all ──
        await seedTenant(EMPTY);
        Object.assign(empty, await seedPlan(EMPTY));
    }, 180_000);

    afterAll(async () => {
        runnerHandlerRegistry._reset();
        await prisma.$disconnect();
    });

    it('PASSES the healthy tenant, attests its control, and reads none of the other tenant\'s rows', async () => {
        const result = await runPlan(HEALTHY, healthy.planId);
        expect(result.runStatus).toBe('COMPLETED');
        expect(result.runResult).toBe('PASS');
        expect(result.findingCreated).toBe(false);

        const body = await evidenceBodyFor(result.evidenceId);
        expect(body).toContain('Basis: A2A_STATE_AS_APPROVED');
        expect(body).toContain('activePeers=1');
        expect(body).toContain('receiptsSampled=2');
        for (const foreign of [drifted.movedPeer, drifted.unpinnedPeer, drifted.tamperedReceipt]) {
            expect(body).not.toContain(foreign);
        }
        const control = await prisma.control.findUnique({ where: { id: healthy.controlId }, select: { lastTested: true } });
        expect(control?.lastTested).not.toBeNull();
    });

    it('FAILS the drifted tenant on all four drifts and raises a Finding', async () => {
        const result = await runPlan(DRIFTED, drifted.planId);
        expect(result.runResult).toBe('FAIL');
        expect(result.findingCreated).toBe(true);

        const body = await evidenceBodyFor(result.evidenceId);
        expect(body).toContain('Basis: A2A_STATE_DRIFTED');
        expect(body).toContain(`peer=${drifted.movedPeer} code=CARD_MOVED_SINCE_PIN revision=1 moved=TEXT`);
        expect(body).toContain(`peer=${drifted.unpinnedPeer} code=PEER_LEFT_UNPINNED`);
        expect(body).toContain('code=SIGNING_KEY_PAST_ROTATION_AGE');
        expect(body).toContain(`receipt=${drifted.tamperedReceipt} peer=${drifted.movedPeer} direction=INBOUND code=RECEIPT_DOES_NOT_VERIFY`);
        expect(body).toContain('Breaches: 4');
        expect(body).not.toContain(healthy.peer);

        const finding = await prisma.finding.findUnique({ where: { id: result.findingId! }, select: { severity: true } });
        expect(finding?.severity).toBe(AGENTIC_CHECKS.AGENTIC_A2A_INTEGRITY.severity);
    });

    it('is INCONCLUSIVE, not PASS, when the healthy peer\'s card cannot be read', async () => {
        served.delete(healthy.peer);
        try {
            const result = await runPlan(HEALTHY, healthy.planId);
            expect(result.runResult).toBe('INCONCLUSIVE');
            expect(result.findingCreated).toBe(false);
            const body = await evidenceBodyFor(result.evidenceId);
            expect(body).toContain('Basis: A2A_STATE_UNVERIFIABLE');
            expect(body).toContain(`peer=${healthy.peer} code=PEER_CARD_UNREADABLE reason=TIMEOUT`);
        } finally {
            served.set(healthy.peer, PIN);
        }
    });

    it('a tenant with no peers and no receipts is vacuous and its control is not credited', async () => {
        const result = await runPlan(EMPTY, empty.planId);
        expect(result.runResult).toBe('INCONCLUSIVE');
        expect(result.findingCreated).toBe(false);
        const body = await evidenceBodyFor(result.evidenceId);
        expect(body).toContain('Basis: NO_A2A_PEERS');
        expect(body).toContain('Vacuous: yes');
        const control = await prisma.control.findUnique({ where: { id: empty.controlId }, select: { lastTested: true } });
        expect(control?.lastTested).toBeNull();
    });
});
