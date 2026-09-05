/**
 * Every action receipt carries the tool DESCRIPTION that was in force when the
 * action happened (OWASP ASI04).
 *
 * ## The question this exists to answer
 *
 * A poisoned tool description is found — usually long after it was planted,
 * because nothing in an ordinary session renders one. The next question is
 * always the same: WHICH actions did it produce? By then the description has
 * been fixed and the registry no longer holds the text that caused the harm, so
 * a receipt naming only `toolName` cannot answer it and neither can the source
 * tree. The receipt has to have been stamped at the time.
 *
 * ## Why a real database, and why "stamped" is the load-bearing word
 *
 * The property is not "the columns exist" — a `select` proves that and proves
 * nothing else. It is that the value is CAPTURED AT INGEST and never recomputed
 * later. The two are indistinguishable while nothing has changed, so the middle
 * test here moves the tenant's pin between two ingests and asserts the FIRST
 * receipt still reports the old digest. An implementation that resolved the hash
 * at read time, or joined to the pin table on `toolName`, passes every other
 * assertion in this file and fails that one.
 *
 * The real database is what makes that meaningful: the columns, the CHECK
 * constraint on the provenance vocabulary, and the round trip through
 * `runInTenantContext` all participate.
 */
import { PrismaClient, MembershipStatus, Role } from '@prisma/client';
import { generateKeyPairSync, sign as cryptoSign } from 'crypto';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';

/**
 * The trusted pipelock key, injected into `@/env` — which snapshots
 * `process.env` at module load, so setting the variable from a test body is too
 * late. A Proxy over the real env keeps every OTHER variable authentic; a whole
 * mocked env object would silently blank the database URL this suite needs.
 *
 * The keypair is GENERATED per run and never checked in: a committed Ed25519
 * private key is a real secret by shape, and the secret-detection guardrail is
 * right to refuse one even in a fixture.
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
import { hashToolManifest } from '@/lib/mcp/tool-manifest';
import { toolDefinitionByName } from '@/lib/mcp/tool-definitions';
import { verifyToolManifestForTenant } from '@/lib/agentic/tool-manifest-store';
import { getReceiptForExport, ingestReceipt } from '@/app-layer/usecases/agent-action-receipt';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(60_000);

const TENANT = 'receipt-provenance-tenant';
const TOOL = 'list_risks';

/** The definition this build carries for the tool under test. */
const liveDef = toolDefinitionByName(TOOL)!;
const liveHashes = hashToolManifest(liveDef);

let ownerUserId = '';
let privateKey: ReturnType<typeof generateKeyPairSync<'ed25519'>>['privateKey'];

const ctx = () =>
    makeRequestContext('OWNER', { tenantId: TENANT, tenantSlug: TENANT, userId: ownerUserId });

/** A pipelock CORE receipt, signed with the key this run trusts. */
function signedReceipt(toolName: string, at: string) {
    const actionRecord = {
        tool: toolName,
        verdict: 'allow',
        policy: 'default',
        agent_id: 'agent-under-test',
        timestamp: at,
    };
    const sig = cryptoSign(null, receiptSignedMessage(actionRecord), privateKey);
    return {
        action_record: actionRecord,
        signature: `ed25519:${sig.toString('hex')}`,
        signer_key: mockKey.value as string,
    };
}

async function clearOwnRows(): Promise<void> {
    await prisma.agentActionReceipt.deleteMany({ where: { tenantId: TENANT } });
    await prisma.mcpToolManifestPin.deleteMany({ where: { tenantId: TENANT } });
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

    await prisma.tenant.create({ data: { id: TENANT, name: 'Receipt Provenance', slug: TENANT } });
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
    await prisma.mcpToolManifestPin.deleteMany({ where: { tenantId: TENANT } });
});

describe('a receipt for a pinned tool carries that tool definition', () => {
    it('stamps the provenance, the description digest and the manifest digest of the pin in force', async () => {
        // The pin is established through the BOUNDARY's own path — the same call
        // the MCP funnel makes — so this asserts the registry, the hasher and the
        // receipt agree, not that the test can copy a hash into two places.
        const verdict = await verifyToolManifestForTenant(TENANT, liveDef);
        expect(verdict.status).toBe('UNPINNED');

        const ingested = await ingestReceipt(ctx(), signedReceipt(TOOL, '2026-09-05T10:00:00.000Z'));
        expect(ingested.verified).toBe(true);

        const row = await prisma.agentActionReceipt.findUniqueOrThrow({
            where: { id: ingested.id },
            select: {
                toolName: true,
                toolProvenance: true,
                toolDescriptionHash: true,
                toolManifestHash: true,
                toolManifestRevision: true,
            },
        });

        expect(row.toolName).toBe(TOOL);
        expect(row.toolProvenance).toBe('inflect:builtin');
        expect(row.toolDescriptionHash).toBe(liveHashes.descriptionHash);
        expect(row.toolManifestHash).toBe(liveHashes.manifestHash);
        expect(row.toolManifestRevision).toBe(1);
    });

    it('exposes it on the auditor export, which is the surface the question is asked from', async () => {
        await verifyToolManifestForTenant(TENANT, liveDef);
        const ingested = await ingestReceipt(ctx(), signedReceipt(TOOL, '2026-09-05T10:05:00.000Z'));

        const exported = await getReceiptForExport(ctx(), ingested.id);
        expect(exported.toolProvenance).toBe('inflect:builtin');
        expect(exported.toolDescriptionHash).toBe(liveHashes.descriptionHash);
        expect(exported.toolManifestHash).toBe(liveHashes.manifestHash);
    });
});

describe('the stamp is captured at ingest, not resolved at read time', () => {
    it('an earlier receipt keeps its digest after the tenant re-pins the tool', async () => {
        await verifyToolManifestForTenant(TENANT, liveDef);
        const first = await ingestReceipt(ctx(), signedReceipt(TOOL, '2026-09-05T11:00:00.000Z'));

        // The definition moves and the tenant accepts the new one. Whatever the
        // pin says now, the action above ran under the OLD description and must
        // go on saying so.
        const movedDescriptionHash = 'a'.repeat(64);
        const movedManifestHash = 'b'.repeat(64);
        await prisma.mcpToolManifestPin.update({
            where: { tenantId_toolName: { tenantId: TENANT, toolName: TOOL } },
            data: {
                descriptionHash: movedDescriptionHash,
                manifestHash: movedManifestHash,
                approvalSource: 'APPROVED',
                approvedByUserId: ownerUserId,
                revision: 2,
                previousManifestHash: liveHashes.manifestHash,
            },
        });

        const second = await ingestReceipt(ctx(), signedReceipt(TOOL, '2026-09-05T12:00:00.000Z'));

        const before = await prisma.agentActionReceipt.findUniqueOrThrow({
            where: { id: first.id },
            select: { toolDescriptionHash: true, toolManifestRevision: true },
        });
        const after = await prisma.agentActionReceipt.findUniqueOrThrow({
            where: { id: second.id },
            select: { toolDescriptionHash: true, toolManifestRevision: true },
        });

        expect(before.toolDescriptionHash).toBe(liveHashes.descriptionHash);
        expect(before.toolManifestRevision).toBe(1);
        expect(after.toolDescriptionHash).toBe(movedDescriptionHash);
        expect(after.toolManifestRevision).toBe(2);
    });
});

describe('a receipt never invents provenance it does not have', () => {
    it('records a tool this build does not define as unattested, with no digests', async () => {
        // An external mediator sees calls to third-party MCP servers too. Hashing
        // OUR registry for a name we do not serve would manufacture provenance,
        // which is worse than recording none.
        const ingested = await ingestReceipt(
            ctx(),
            signedReceipt('third_party_delete_everything', '2026-09-05T13:00:00.000Z'),
        );

        const row = await prisma.agentActionReceipt.findUniqueOrThrow({
            where: { id: ingested.id },
            select: {
                toolProvenance: true,
                toolDescriptionHash: true,
                toolManifestHash: true,
                toolManifestRevision: true,
            },
        });

        expect(row.toolProvenance).toBe('unattested');
        expect(row.toolDescriptionHash).toBeNull();
        expect(row.toolManifestHash).toBeNull();
        expect(row.toolManifestRevision).toBeNull();
    });

    it('records one of OUR tools that has no pin yet as builtin with no digests', async () => {
        // We know whose tool it is and we do not know which definition was in
        // front of it — a receipt can arrive about a call that never reached our
        // own boundary. Saying exactly that is the honest record.
        const ingested = await ingestReceipt(ctx(), signedReceipt(TOOL, '2026-09-05T14:00:00.000Z'));

        const row = await prisma.agentActionReceipt.findUniqueOrThrow({
            where: { id: ingested.id },
            select: { toolProvenance: true, toolDescriptionHash: true, toolManifestRevision: true },
        });

        expect(row.toolProvenance).toBe('inflect:builtin');
        expect(row.toolDescriptionHash).toBeNull();
        expect(row.toolManifestRevision).toBeNull();
    });

    it('refuses a provenance value outside the vocabulary, at the database', async () => {
        // The CHECK constraint is the backstop for the paths the usecase does not
        // own — a script, a migration, a hand-edited row. Without it a typo makes
        // a third silent class that reads as neither ours nor theirs.
        await expect(
            prisma.$executeRawUnsafe(
                `INSERT INTO "AgentActionReceipt"
                    ("id","tenantId","toolName","decisionVerdict","scannedSummary","signature","signingKeyId","occurredAt","verified","toolProvenance")
                 VALUES ('bad-provenance-row',$1,'list_risks','allow','{}'::jsonb,'sig','key',NOW(),false,'made-up')`,
                TENANT,
            ),
        ).rejects.toThrow();
    });
});
