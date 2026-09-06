/**
 * Receipts and decision records become evidence, attached to the right control,
 * and re-running does not duplicate them.
 *
 * ## What is actually being asserted
 *
 * Three properties, and only the first is obvious:
 *
 *  1. ATTACHMENT. A verified receipt produces an `Evidence` row linked to the
 *     control that discharges the obligation the receipt is evidence FOR — not
 *     to whichever agentic control happened to be first. The controls here are
 *     deliberately several, on several requirements, so "attached to the right
 *     one" is a claim that can fail.
 *
 *  2. IDEMPOTENCY, and it is the reason the identity is `(tenant, control, kind,
 *     period)` rather than a receipt id or a content digest. Re-running with an
 *     unchanged population must not add a row; re-running with a CHANGED
 *     population must not add one either — it must rewrite the one that exists.
 *     The second half is the one a digest-keyed identity fails, and it fails
 *     silently: two artefacts for one month, both green, neither authoritative.
 *
 *  3. WHAT THE ARTEFACT DOES NOT SAY. `AiDecisionLog` holds a digest instead of
 *     the prompt and `AgentActionReceipt.scannedSummary` is bounded and scrubbed,
 *     both on purpose. `Evidence.content` is a wider surface than either — not
 *     field-encrypted, PDF-exported, reachable through an audit-pack share link.
 *     A canary planted in each source record must not appear in the artefact.
 *
 * ## Why a real database
 *
 * The identity is a UNIQUE INDEX. A mocked Prisma would let a second insert
 * succeed and the idempotency assertions would pass against an implementation
 * that has none.
 */
import { PrismaClient, MembershipStatus, Role } from '@prisma/client';
import { type KeyObject, generateKeyPairSync, sign as cryptoSign } from 'crypto';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';

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
import {
    emitAgenticEvidence,
    withdrawStaleAgenticEvidence,
} from '@/app-layer/usecases/agentic-evidence-emission';
import {
    ARTEFACT_KIND_DECISIONS,
    ARTEFACT_KIND_RECEIPTS,
    ASI_LIBRARY_URN,
    EU_AI_ACT_LIBRARY_URN,
} from '@/lib/agentic/evidence-artefact';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(90_000);

const TENANT = 'agentic-evidence-emission-tenant';
/** A fixed period, so the assertions do not depend on when the suite runs. */
const AS_OF = new Date('2026-08-14T09:00:00.000Z');
const PERIOD_LABEL = '2026-08';
/** Inside the period, but not the same instant — ordering must not matter. */
const INSIDE = (offsetHours: number) =>
    new Date(Date.UTC(2026, 7, 3 + offsetHours, 12, 0, 0)).toISOString();

let ownerUserId = '';
let privateKey: KeyObject;

/** Control ids, keyed by the requirement each discharges. */
const controls: Record<string, string> = {};

const ctx = () =>
    makeRequestContext('OWNER', { tenantId: TENANT, tenantSlug: TENANT, userId: ownerUserId });

function signedReceipt(record: Record<string, unknown>) {
    const sig = cryptoSign(null, receiptSignedMessage(record), privateKey);
    return {
        action_record: record,
        signature: `ed25519:${sig.toString('hex')}`,
        signer_key: mockKey.value as string,
    };
}

const receiptRecord = (overrides: Record<string, unknown> = {}) => ({
    tool: 'list_risks',
    verdict: 'allow',
    policy: 'default',
    agent_id: 'agent-under-test',
    timestamp: INSIDE(0),
    ...overrides,
});

/**
 * The frameworks are created with keys of their OWN, carrying the shipped
 * `sourceUrn`. That is not a shortcut around the seed — it is the case the
 * emitter has to survive: every framework here exists in up to two `Framework`
 * rows with different keys, and a tenant's controls hang off whichever its
 * database got. A key-matching implementation passes if the test uses the
 * seeded key and fails on half the real estate.
 */
async function installFrameworks(): Promise<void> {
    const asi = await prisma.framework.create({
        data: {
            key: 'TEST-ASI-LIBRARY-REPRESENTATION',
            name: 'OWASP Agentic AI Top 10',
            version: '1.0',
            kind: 'INDUSTRY_STANDARD',
            sourceUrn: ASI_LIBRARY_URN,
        },
    });
    const euAiAct = await prisma.framework.create({
        data: {
            key: 'TEST-EU-AI-ACT-LIBRARY-REPRESENTATION',
            name: 'EU AI Act',
            version: '2024',
            kind: 'REGULATION',
            sourceUrn: EU_AI_ACT_LIBRARY_URN,
        },
    });

    const wanted: Array<[string, string, string]> = [
        [asi.id, 'ASI02', 'Tool Misuse and Exploitation'],
        [asi.id, 'ASI04', 'Agentic Supply Chain Vulnerabilities'],
        [asi.id, 'ASI09', 'Human-Agent Trust Exploitation'],
        // Not a target of any artefact kind. Its control is the negative case:
        // an agentic control that must NOT collect an artefact.
        [asi.id, 'ASI06', 'Memory and Context Poisoning'],
        [euAiAct.id, 'Art.12', 'Record-keeping'],
    ];

    for (const [frameworkId, code, title] of wanted) {
        const requirement = await prisma.frameworkRequirement.create({
            data: { frameworkId, code, title },
        });
        const control = await prisma.control.create({
            data: {
                tenantId: TENANT,
                code: `CTL-${code}`,
                name: `Control for ${code}`,
                status: 'IMPLEMENTED',
            },
        });
        await prisma.controlRequirementLink.create({
            data: { tenantId: TENANT, controlId: control.id, requirementId: requirement.id },
        });
        controls[code] = control.id;
    }
}

async function clearOwnRows(): Promise<void> {
    await prisma.agentActionReceipt.deleteMany({ where: { tenantId: TENANT } });
    await prisma.aiDecisionLog.deleteMany({ where: { tenantId: TENANT } });
    await prisma.agenticEvidenceArtefact.deleteMany({ where: { tenantId: TENANT } });
    await prisma.evidenceControlLink.deleteMany({ where: { tenantId: TENANT } });
    await prisma.evidence.deleteMany({ where: { tenantId: TENANT } });
    await prisma.controlRequirementLink.deleteMany({ where: { tenantId: TENANT } });
    await prisma.control.deleteMany({ where: { tenantId: TENANT } });
    await prisma.frameworkRequirement.deleteMany({
        where: { framework: { key: { startsWith: 'TEST-' } } },
    });
    await prisma.framework.deleteMany({ where: { key: { startsWith: 'TEST-' } } });
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

    await prisma.tenant.create({ data: { id: TENANT, name: 'Agentic Evidence', slug: TENANT } });
    const email = `owner@${TENANT}.test`;
    const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    ownerUserId = user.id;
    await prisma.tenantMembership.create({
        data: { tenantId: TENANT, userId: user.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
    await installFrameworks();
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

beforeEach(async () => {
    // The artefacts cascade from their Evidence rows, so deleting the evidence
    // clears the ledger too — the composite FK doing its job.
    await prisma.agenticEvidenceArtefact.deleteMany({ where: { tenantId: TENANT } });
    await prisma.evidenceControlLink.deleteMany({ where: { tenantId: TENANT } });
    await prisma.evidence.deleteMany({ where: { tenantId: TENANT } });
    await prisma.agentActionReceipt.deleteMany({ where: { tenantId: TENANT } });
    await prisma.aiDecisionLog.deleteMany({ where: { tenantId: TENANT } });
    await prisma.control.updateMany({ where: { tenantId: TENANT }, data: { deletedAt: null } });
});

/** Every artefact the tenant holds, newest identity last. */
const artefacts = () =>
    prisma.agenticEvidenceArtefact.findMany({
        where: { tenantId: TENANT },
        orderBy: [{ kind: 'asc' }, { controlId: 'asc' }],
        select: {
            id: true,
            controlId: true,
            kind: true,
            periodStart: true,
            periodEnd: true,
            evidenceId: true,
            sourceDigest: true,
            recordCount: true,
            status: true,
            withdrawnReason: true,
        },
    });

describe('a verified receipt produces an artefact on the right control', () => {
    it('attaches to the receipt controls and to no other', async () => {
        const ingested = await ingestReceipt(ctx(), signedReceipt(receiptRecord()));
        expect(ingested.verified).toBe(true);

        const report = await emitAgenticEvidence(ctx(), { asOf: AS_OF });
        expect(report.anyTargetInstalled).toBe(true);
        expect(report.periodLabel).toBe(PERIOD_LABEL);

        const receiptArtefacts = (await artefacts()).filter(
            (a) => a.kind === ARTEFACT_KIND_RECEIPTS,
        );
        // ASI02 and ASI04 — the two obligations a receipt is evidence for. Not
        // ASI06, which is an agentic control this tenant holds and which no
        // receipt evidences.
        expect(new Set(receiptArtefacts.map((a) => a.controlId))).toEqual(
            new Set([controls.ASI02, controls.ASI04]),
        );
        expect(receiptArtefacts.map((a) => a.controlId)).not.toContain(controls.ASI06);
        expect(receiptArtefacts.every((a) => a.recordCount === 1)).toBe(true);

        // The artefact IS an Evidence row, linked to that control through the
        // ordinary join — so it appears on the control's evidence tab without
        // anything knowing about this subsystem.
        for (const artefact of receiptArtefacts) {
            const link = await prisma.evidenceControlLink.findFirst({
                where: {
                    tenantId: TENANT,
                    evidenceId: artefact.evidenceId,
                    controlId: artefact.controlId,
                },
            });
            expect(link).not.toBeNull();
            const evidence = await prisma.evidence.findUniqueOrThrow({
                where: { id: artefact.evidenceId },
                select: { title: true, content: true, type: true, isArchived: true },
            });
            expect(evidence.type).toBe('TEXT');
            expect(evidence.isArchived).toBe(false);
            expect(evidence.title).toContain(PERIOD_LABEL);
            expect(evidence.content).toContain('Mediated agent actions recorded: 1');
            expect(evidence.content).toContain(
                'verified and linked to the hash-chained audit trail: 1',
            );
        }
    });

    it('counts an unverified receipt separately rather than as an attested action', async () => {
        await ingestReceipt(ctx(), signedReceipt(receiptRecord()));
        const stranger = generateKeyPairSync('ed25519');
        const record = receiptRecord({ verdict: 'block' });
        const sig = cryptoSign(null, receiptSignedMessage(record), stranger.privateKey);
        const unverified = await ingestReceipt(ctx(), {
            action_record: record,
            signature: `ed25519:${sig.toString('hex')}`,
            signer_key: stranger.publicKey
                .export({ type: 'spki', format: 'der' })
                .subarray(-32)
                .toString('hex'),
        });
        expect(unverified.verified).toBe(false);

        await emitAgenticEvidence(ctx(), { asOf: AS_OF });

        const artefact = (await artefacts()).find(
            (a) => a.kind === ARTEFACT_KIND_RECEIPTS && a.controlId === controls.ASI02,
        );
        const evidence = await prisma.evidence.findUniqueOrThrow({
            where: { id: artefact!.evidenceId },
            select: { content: true },
        });
        // Both receipts are in the population — an artefact that silently
        // dropped the unverified one would hide the fact that a mediator's
        // signature failed, which is the fact an assessor most wants.
        expect(evidence.content).toContain('Mediated agent actions recorded: 2');
        expect(evidence.content).toContain(
            'verified and linked to the hash-chained audit trail: 1',
        );
        expect(evidence.content).toContain(
            'signature did not verify (recorded, flagged, never trusted): 1',
        );
    });

    it('ignores records outside the period', async () => {
        await ingestReceipt(
            ctx(),
            signedReceipt(receiptRecord({ timestamp: '2026-07-31T23:59:59.000Z' })),
        );
        await ingestReceipt(
            ctx(),
            signedReceipt(receiptRecord({ timestamp: '2026-09-01T00:00:00.000Z' })),
        );
        await ingestReceipt(ctx(), signedReceipt(receiptRecord({ timestamp: INSIDE(1) })));

        await emitAgenticEvidence(ctx(), { asOf: AS_OF });

        const artefact = (await artefacts()).find(
            (a) => a.kind === ARTEFACT_KIND_RECEIPTS && a.controlId === controls.ASI02,
        );
        expect(artefact!.recordCount).toBe(1);
        // Half-open: the first instant of September belongs to September.
        expect(artefact!.periodStart.toISOString()).toBe('2026-08-01T00:00:00.000Z');
        expect(artefact!.periodEnd.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    });
});

describe('re-running does not duplicate an artefact', () => {
    it('an unchanged population rewrites nothing and adds nothing', async () => {
        await ingestReceipt(ctx(), signedReceipt(receiptRecord()));

        const first = await emitAgenticEvidence(ctx(), { asOf: AS_OF });
        expect(first.artefacts.every((a) => a.outcome === 'created')).toBe(true);
        const afterFirst = await artefacts();

        const second = await emitAgenticEvidence(ctx(), { asOf: AS_OF });
        expect(second.artefacts.every((a) => a.outcome === 'unchanged')).toBe(true);
        const afterSecond = await artefacts();

        // Same rows, same ids, same evidence, same digest. Ids compared rather
        // than counts: a re-created row with the same content is still a broken
        // link for anything that referenced the old one.
        expect(afterSecond.map((a) => a.id)).toEqual(afterFirst.map((a) => a.id));
        expect(afterSecond.map((a) => a.evidenceId)).toEqual(afterFirst.map((a) => a.evidenceId));
        expect(afterSecond.map((a) => a.sourceDigest)).toEqual(
            afterFirst.map((a) => a.sourceDigest),
        );

        expect(
            await prisma.evidence.count({ where: { tenantId: TENANT, isArchived: false } }),
        ).toBe(afterFirst.length);
    });

    it('a CHANGED population rewrites the same row rather than adding a second', async () => {
        // This is the assertion a content-digest identity fails. The digest moves
        // the moment one more receipt lands inside an open month, so a
        // digest-keyed artefact would acquire a SECOND row for August — and both
        // would look correct.
        await ingestReceipt(ctx(), signedReceipt(receiptRecord()));
        await emitAgenticEvidence(ctx(), { asOf: AS_OF });
        const before = await artefacts();

        await ingestReceipt(ctx(), signedReceipt(receiptRecord({ tool: 'list_controls' })));
        const second = await emitAgenticEvidence(ctx(), { asOf: AS_OF });
        // Scoped to the RECEIPT artefacts: the decision-log population did not
        // move in this test, so its artefacts are correctly `unchanged`, and an
        // assertion over all of them would be asserting the wrong thing.
        const receiptOutcomes = second.artefacts
            .filter((a) => a.kind === ARTEFACT_KIND_RECEIPTS)
            .map((a) => a.outcome);
        expect(receiptOutcomes).toHaveLength(2);
        expect(receiptOutcomes.every((o) => o === 'updated')).toBe(true);
        expect(
            second.artefacts
                .filter((a) => a.kind === ARTEFACT_KIND_DECISIONS)
                .every((a) => a.outcome === 'unchanged'),
        ).toBe(true);

        const after = await artefacts();
        expect(after.map((a) => a.id)).toEqual(before.map((a) => a.id));
        expect(after.map((a) => a.evidenceId)).toEqual(before.map((a) => a.evidenceId));

        const receiptBefore = before.filter((a) => a.kind === ARTEFACT_KIND_RECEIPTS);
        const receiptAfter = after.filter((a) => a.kind === ARTEFACT_KIND_RECEIPTS);
        // The digest moved — that is what "the population changed" means, and it
        // is a FIELD precisely so it can move without multiplying rows.
        expect(receiptAfter[0].sourceDigest).not.toBe(receiptBefore[0].sourceDigest);
        expect(receiptAfter.every((a) => a.recordCount === 2)).toBe(true);

        const evidence = await prisma.evidence.findUniqueOrThrow({
            where: { id: receiptAfter[0].evidenceId },
            select: { content: true },
        });
        expect(evidence.content).toContain('Mediated agent actions recorded: 2');
        expect(evidence.content).toContain('list_controls: 1');
    });

    it('a different period is a different artefact', async () => {
        // The counterpart to the two tests above: idempotency must not become
        // "one artefact, forever, overwritten". September is a different question.
        await ingestReceipt(ctx(), signedReceipt(receiptRecord()));
        await emitAgenticEvidence(ctx(), { asOf: AS_OF });
        await ingestReceipt(
            ctx(),
            signedReceipt(receiptRecord({ timestamp: '2026-09-04T10:00:00.000Z' })),
        );
        await emitAgenticEvidence(ctx(), { asOf: new Date('2026-09-20T00:00:00.000Z') });

        const periods = new Set(
            (await artefacts())
                .filter((a) => a.kind === ARTEFACT_KIND_RECEIPTS && a.controlId === controls.ASI02)
                .map((a) => a.periodStart.toISOString()),
        );
        expect(periods).toEqual(
            new Set(['2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']),
        );
    });
});

describe('a decision-log record produces an Art 12 artefact', () => {
    const decisionRow = (overrides: Record<string, unknown> = {}) => ({
        tenantId: TENANT,
        feature: 'risk-suggestions',
        provider: 'anthropic',
        inputDigest: 'a'.repeat(64),
        createdAt: new Date(INSIDE(2)),
        ...overrides,
    });

    it('attaches to the EU AI Act Art 12 control', async () => {
        await prisma.aiDecisionLog.create({ data: decisionRow() });
        await prisma.aiDecisionLog.create({
            data: decisionRow({ humanOutcome: 'ACCEPTED', guardVerdict: 'redacted' }),
        });

        await emitAgenticEvidence(ctx(), { asOf: AS_OF });

        const decisionArtefacts = (await artefacts()).filter(
            (a) => a.kind === ARTEFACT_KIND_DECISIONS,
        );
        // Art.12 (record-keeping) AND ASI09 (human-agent trust): the decision log
        // is the record for both, and the emitter must not pick one.
        expect(new Set(decisionArtefacts.map((a) => a.controlId))).toEqual(
            new Set([controls['Art.12'], controls.ASI09]),
        );

        const art12 = decisionArtefacts.find((a) => a.controlId === controls['Art.12']);
        const evidence = await prisma.evidence.findUniqueOrThrow({
            where: { id: art12!.evidenceId },
            select: { title: true, content: true },
        });
        expect(evidence.title).toContain('EU AI Act Art 12');
        expect(evidence.content).toContain(
            'AI invocations recorded (EU AI Act Art 12 automatic record-keeping): 2',
        );
        // Art 14 human oversight is the half an Art 12 record is read alongside.
        expect(evidence.content).toContain('reached a human-oversight outcome (Art 14): 1');
        expect(evidence.content).toContain('still pending review: 1');
        expect(art12!.recordCount).toBe(2);
    });

    it('emits a zero-count artefact rather than nothing', async () => {
        // "This control produced no agentic activity in August" is a finding an
        // assessor wants. An absent row is ambiguous — no activity, or no
        // emitter — and the ambiguity is the failure mode that makes an empty
        // page unreadable.
        await emitAgenticEvidence(ctx(), { asOf: AS_OF });

        const art12 = (await artefacts()).find((a) => a.controlId === controls['Art.12']);
        expect(art12).toBeDefined();
        expect(art12!.recordCount).toBe(0);
        const evidence = await prisma.evidence.findUniqueOrThrow({
            where: { id: art12!.evidenceId },
            select: { content: true },
        });
        expect(evidence.content).toContain(
            'AI invocations recorded (EU AI Act Art 12 automatic record-keeping): 0',
        );
    });
});

describe('what an artefact must not contain', () => {
    const CANARY = 'canary-do-not-publish-9f2b1c';

    it('does not republish what the source records were careful to exclude', async () => {
        // The receipt's `action_record` lands in `scannedSummary` — bounded and
        // scrubbed, never raw. The decision log holds a digest and a bounded
        // summary in place of the prompt and the output. `Evidence.content` is
        // not field-encrypted, is PDF-exported and is reachable through an
        // audit-pack share link, so anything copied into it lands on the widest
        // surface in the product.
        await ingestReceipt(
            ctx(),
            signedReceipt(receiptRecord({ mediated_payload: `${CANARY}-receipt` })),
        );
        await prisma.aiDecisionLog.create({
            data: {
                tenantId: TENANT,
                feature: 'risk-suggestions',
                provider: 'anthropic',
                inputDigest: `${CANARY}-digest`,
                outputSummary: `${CANARY}-summary`,
                createdAt: new Date(INSIDE(2)),
            },
        });

        // The canary really is in the source rows — otherwise the assertion below
        // would pass against an artefact of nothing.
        const receipt = await prisma.agentActionReceipt.findFirstOrThrow({
            where: { tenantId: TENANT },
            select: { scannedSummary: true },
        });
        expect(JSON.stringify(receipt.scannedSummary)).toContain(CANARY);

        await emitAgenticEvidence(ctx(), { asOf: AS_OF });

        const emitted = await prisma.evidence.findMany({
            where: { tenantId: TENANT },
            select: { title: true, content: true },
        });
        expect(emitted.length).toBeGreaterThan(0);
        for (const evidence of emitted) {
            expect(evidence.content ?? '').not.toContain(CANARY);
            expect(evidence.title).not.toContain(CANARY);
        }

        // And it says so, at the point a reader notices the absence — otherwise
        // an honest redaction reads as an incomplete export.
        expect(emitted.some((e) => (e.content ?? '').includes('REDACTION CONTRACT'))).toBe(true);
    });
});

describe('when the basis stops holding', () => {
    it('withdraws rather than deletes when the control is removed', async () => {
        await ingestReceipt(ctx(), signedReceipt(receiptRecord()));
        await emitAgenticEvidence(ctx(), { asOf: AS_OF });
        const before = (await artefacts()).find((a) => a.controlId === controls.ASI02);
        expect(before!.status).toBe('CURRENT');

        // Uninstalling a control in this product is a SOFT delete.
        await prisma.control.update({
            where: { id: controls.ASI02 },
            data: { deletedAt: new Date() },
        });

        const withdrawn = await withdrawStaleAgenticEvidence(ctx());
        expect(withdrawn.map((w) => w.artefactId)).toContain(before!.id);

        const after = (await artefacts()).find((a) => a.id === before!.id);
        expect(after!.status).toBe('WITHDRAWN');
        expect(after!.withdrawnReason).toBe('CONTROL_REMOVED');

        // NOT DELETED. An audit pack may already cite it, and destroying
        // evidence because its control was removed is the shape of evidence
        // tampering. Archived, with the counts replaced by a dated notice.
        const evidence = await prisma.evidence.findUniqueOrThrow({
            where: { id: before!.evidenceId },
            select: { content: true, isArchived: true, deletedAt: true },
        });
        expect(evidence.deletedAt).toBeNull();
        expect(evidence.isArchived).toBe(true);
        expect(evidence.content).toContain('WITHDRAWN');
        expect(evidence.content).toContain('CONTROL_REMOVED');
        // NOT LEFT STALE either — the counts it used to assert are gone.
        expect(evidence.content).not.toContain('Mediated agent actions recorded');
    });

    it('stops emitting onto a removed control', async () => {
        await ingestReceipt(ctx(), signedReceipt(receiptRecord()));
        await prisma.control.update({
            where: { id: controls.ASI04 },
            data: { deletedAt: new Date() },
        });

        await emitAgenticEvidence(ctx(), { asOf: AS_OF });

        const emitted = await artefacts();
        expect(emitted.map((a) => a.controlId)).not.toContain(controls.ASI04);
        expect(emitted.map((a) => a.controlId)).toContain(controls.ASI02);
    });

    it('resumes on a control whose removal was undone', async () => {
        await ingestReceipt(ctx(), signedReceipt(receiptRecord()));
        await emitAgenticEvidence(ctx(), { asOf: AS_OF });
        const original = (await artefacts()).find((a) => a.controlId === controls.ASI02);

        await prisma.control.update({
            where: { id: controls.ASI02 },
            data: { deletedAt: new Date() },
        });
        await withdrawStaleAgenticEvidence(ctx());
        await prisma.control.update({
            where: { id: controls.ASI02 },
            data: { deletedAt: null },
        });

        await emitAgenticEvidence(ctx(), { asOf: AS_OF });

        // The SAME row, current again. A second artefact for August would mean
        // the withdrawal notice and the live counts both stood.
        const resumed = (await artefacts()).find((a) => a.controlId === controls.ASI02);
        expect(resumed!.id).toBe(original!.id);
        expect(resumed!.status).toBe('CURRENT');
        expect(resumed!.withdrawnReason).toBeNull();
        const evidence = await prisma.evidence.findUniqueOrThrow({
            where: { id: resumed!.evidenceId },
            select: { content: true, isArchived: true },
        });
        expect(evidence.isArchived).toBe(false);
        expect(evidence.content).toContain('Mediated agent actions recorded: 1');
        expect(evidence.content).not.toContain('WITHDRAWN');
    });
});

describe('a foreign string cannot ride into the artefact body', () => {
    it('strips markup and bounds the length of an attacker-chosen tool name', async () => {
        // `extractReceiptFields` lifts `tool` and `verdict` out of an ARBITRARY
        // `action_record` chosen by whoever signed the receipt — and this
        // artefact deliberately counts UNVERIFIED receipts, so the Ed25519
        // signature does not stand in front of these two fields. A tenant API
        // key with write, or a hostile mediator, picks the bytes.
        //
        // `Evidence.content` is the widest surface in the product: not in the
        // encryption manifest, PDF-exported, reachable through an audit-pack
        // share link, read verbatim by SDK consumers. CLAUDE.md C.5 requires the
        // sanitising to happen at the USECASE layer for that reason.
        const XSS = '<img src=x onerror="alert(document.domain)">';
        const LONG = 'A'.repeat(5_000);

        await ingestReceipt(
            ctx(),
            signedReceipt(
                receiptRecord({
                    tool: XSS + LONG,
                    verdict: '</p><script>steal()</script>',
                }),
            ),
        );

        const report = await emitAgenticEvidence(ctx(), { asOf: AS_OF });
        expect(report.artefacts.length).toBeGreaterThan(0);

        const bodies = await prisma.evidence.findMany({
            where: { tenantId: TENANT },
            select: { content: true },
        });
        const all = bodies.map((b) => b.content ?? '').join('\n');

        // No markup survives…
        expect(all).not.toContain('<img');
        expect(all).not.toContain('onerror');
        expect(all).not.toContain('<script>');
        expect(all).not.toContain('steal()');
        // …and one label cannot inflate the body without bound. 5 KB in, and the
        // whole artefact stays far under it.
        // eslint-disable-next-line no-console
        // The LABEL, not the whole body. `all` is every artefact for the tenant
        // joined together, so its total length says nothing about this defect —
        // the claim is that ONE foreign label cannot inflate a body without
        // bound. 5 KB went in; the longest run of it that survives is the cap.
        const longestRun = Math.max(0, ...(all.match(/A+/g) ?? []).map((r) => r.length));
        expect(longestRun).toBeLessThanOrEqual(120);
        expect(longestRun).toBeGreaterThan(0);
        // The artefact is still produced — sanitising is not silently dropping
        // the record, which would lose the count an assessor is reading.
        expect(all).toMatch(/Mediated agent actions recorded: 1/);
    });
});
