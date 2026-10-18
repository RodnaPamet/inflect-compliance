/**
 * The weekly integration-passport sweep (#3672), against a real database.
 *
 * `docs/integration-passport.md` is the contract. The pure builder and the
 * drift planner have their own unit suites; this file proves what only the
 * database can: that the sweep reads the rows the specification names, writes a
 * week's passport and its findings together, recovers last week's passport from
 * the evidence it emitted — and refuses to compare against one somebody edited
 * — and that a re-run inside one ISO week changes nothing.
 *
 * ## The fixture's weeks
 *
 *   W40 = 2026-W40, [2026-09-28, 2026-10-05)   asOf Sunday 2026-10-04 05:45Z
 *   W41 = 2026-W41, [2026-10-05, 2026-10-12)   asOf Sunday 2026-10-11 05:45Z
 *   W42 = 2026-W42, [2026-10-12, 2026-10-19)   asOf Sunday 2026-10-18 05:45Z
 *   W43 = 2026-W43, [2026-10-19, 2026-10-26)   asOf Sunday 2026-10-25 05:45Z
 *
 * Every test builds its own history from an empty one (`beforeEach`), so no
 * test reads a week another test wrote.
 *
 * ## The catalogue is ISO 27001 only, in BOTH spellings, on purpose
 *
 * Tenant A's control hangs off the seeded representation (`ISO27001`, no urn,
 * Annex A numbered `5.19`); tenant B's off the library one (urn, `A.5.19`). An
 * exact-code lookup reaches one of them and reports the other as having no
 * target control. And no ASI or EU AI Act framework exists, so the withdrawal
 * test can show that a receipts artefact is not judged by a catalogue that
 * installs only a passport target.
 */
import { MembershipStatus, PrismaClient, Role } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { makeRequestContext } from '../helpers/make-context';
import { encryptField, hashForLookup } from '@/lib/security/encryption';
import { buildDelegatedJobContext } from '@/app-layer/context-system';
import {
    PASSPORT_CONNECTION_CAP,
    getIntegrationPassportView,
    runIntegrationPassportSweep,
    setIntegrationConnectionOwner,
} from '@/app-layer/usecases/integration-passport';
import { withdrawStaleAgenticEvidence } from '@/app-layer/usecases/agentic-evidence-emission';
import { setExternalWriteMode } from '@/app-layer/usecases/external-write-policy';
import { removeIntegrationConnection } from '@/app-layer/usecases/integrations';
import { getFinding, listFindings } from '@/app-layer/usecases/finding';
import {
    runIntegrationPassportSweepForTenants,
    runIntegrationPassportSweepJob,
} from '@/app-layer/jobs/integration-passport-sweep';
import { SCHEDULED_JOBS } from '@/app-layer/jobs/schedules';
import { JOB_DEFAULTS } from '@/app-layer/jobs/types';
import { ISO27001_FAMILY_URN } from '@/app-layer/domain/framework-representation';
import { ARTEFACT_KIND_PASSPORTS, ARTEFACT_KIND_RECEIPTS } from '@/lib/agentic/evidence-artefact';
import { EXTERNAL_MAX_MODE } from '@/lib/integrations/external-write-ladder';
import { extractPassportBundle } from '@/lib/agentic/integration-passport';
import { OWNER_ROLE_FALLBACK } from '@/lib/agentic/integration-passport-drift';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(180_000);

const W40 = new Date('2026-10-04T05:45:00.000Z');
const W41 = new Date('2026-10-11T05:45:00.000Z');
const W42 = new Date('2026-10-18T05:45:00.000Z');
const W43 = new Date('2026-10-25T05:45:00.000Z');

const A = 'passport-tenant-a';
const B = 'passport-tenant-b';
const GONE = 'passport-tenant-vanish';
const BARE = 'passport-tenant-bare';
const TENANTS = [A, B, GONE, BARE];

const CONN_A = 'cmpassportconnaaaaaaaaaa';
const CONN_B = 'cmpassportconnbbbbbbbbbb';
const CONN_GONE = 'cmpassportconngggggggggg';
const CONN_BARE = 'cmpassportconnzzzzzzzzzz';
const TOOL_A = `mcp__${CONN_A}__list_tickets`;

/** Delegated, with an explicit scope so a move to app-only keeps scope and audience. */
const SCOPE = 'api://passport-test/.default offline_access';
const SECRET_CANARY = 'refresh-token-canary-9f3c';

const users: Record<string, string> = {};
/** Control per tenant, and the requirement it is linked to. */
const controls: Record<string, { controlId: string; requirementId: string }> = {};

const actorCtx = (tenantId: string) =>
    buildDelegatedJobContext({ tenantId, job: 'integration-passport-sweep', onBehalfOf: users[tenantId], requestId: `test-${tenantId}` });
const ownerCtx = (tenantId: string) =>
    makeRequestContext('OWNER', { tenantId, tenantSlug: tenantId, userId: users[tenantId] });

const sweep = (tenantId: string, asOf: Date) =>
    runIntegrationPassportSweep(actorCtx(tenantId), { asOf, actorUserId: users[tenantId] });

async function installCatalogue(): Promise<{ seed: Record<string, string>; library: Record<string, string> }> {
    // The seeded representation: no urn, found by its legacy key, bare codes.
    const seeded = await prisma.framework.create({
        data: { key: 'ISO27001', name: 'ISO/IEC 27001:2022', version: '2022' },
    });
    // The library representation: urn, `A.`-prefixed codes.
    const library = await prisma.framework.create({
        data: { key: 'TEST-ISO27001-LIBRARY', name: 'ISO/IEC 27001:2022', version: '2022-lib', sourceUrn: ISO27001_FAMILY_URN },
    });
    const seed: Record<string, string> = {};
    const lib: Record<string, string> = {};
    for (const code of ['5.19', '5.15']) {
        seed[code] = (await prisma.frameworkRequirement.create({ data: { frameworkId: seeded.id, code, title: `Annex A ${code}` } })).id;
        lib[`A.${code}`] = (
            await prisma.frameworkRequirement.create({ data: { frameworkId: library.id, code: `A.${code}`, title: `Annex A ${code}` } })
        ).id;
    }
    return { seed, library: lib };
}

/** Everything this file creates, so a previous run's leftovers cannot collide. */
async function clearEverything(): Promise<void> {
    await clearTenantRows();
    await prisma.control.deleteMany({ where: { tenantId: { in: TENANTS } } });
    await deleteAuditRowsForTenants(prisma, TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, TENANTS);
    });
    const emails = [...TENANTS.map((t) => `owner@${t}.test`), `named-owner@${A}.test`];
    await prisma.user.deleteMany({ where: { emailHash: { in: emails.map((e) => hashForLookup(e)) } } });
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearEverything();

    for (const t of TENANTS) {
        await prisma.tenant.create({ data: { id: t, name: t, slug: t } });
        const email = `owner@${t}.test`;
        const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        users[t] = user.id;
        await prisma.tenantMembership.create({
            data: { tenantId: t, userId: user.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
        });
    }
    const named = await prisma.user.create({
        data: { email: `named-owner@${A}.test`, emailHash: hashForLookup(`named-owner@${A}.test`) },
    });
    users.namedOwner = named.id;
    await prisma.tenantMembership.create({
        data: { tenantId: A, userId: named.id, role: Role.EDITOR, status: MembershipStatus.ACTIVE },
    });

    const { seed, library } = await installCatalogue();
    const link: Record<string, string> = { [A]: seed['5.19'], [B]: library['A.5.19'], [GONE]: seed['5.15'] };
    for (const [tenantId, requirementId] of Object.entries(link)) {
        const control = await prisma.control.create({
            data: { tenantId, code: `CTL-${tenantId}`, name: `Supplier control ${tenantId}`, status: 'IMPLEMENTED' },
        });
        controls[tenantId] = { controlId: control.id, requirementId };
    }
    // BARE's control exists but discharges nothing until a test links it.
    const bare = await prisma.control.create({
        data: { tenantId: BARE, code: 'CTL-bare', name: 'Unmapped control', status: 'IMPLEMENTED' },
    });
    controls[BARE] = { controlId: bare.id, requirementId: seed['5.19'] };
});

afterAll(async () => {
    await clearEverything();
    await prisma.$disconnect();
});

async function clearTenantRows(): Promise<void> {
    const where = { tenantId: { in: TENANTS } };
    await prisma.findingEvidence.deleteMany({ where });
    await prisma.finding.deleteMany({ where });
    await prisma.agenticEvidenceArtefact.deleteMany({ where });
    await prisma.evidenceControlLink.deleteMany({ where });
    await prisma.evidence.deleteMany({ where });
    await prisma.mcpToolManifestPin.deleteMany({ where });
    await prisma.externalToolPriorStateRead.deleteMany({ where });
    await prisma.integrationConnection.deleteMany({ where });
    await prisma.controlRequirementLink.deleteMany({ where });
}

const delegatedSecrets = () => ({ clientSecret: 'client-secret-value', refreshToken: SECRET_CANARY }); // pragma: allowlist secret
const pinHashes = { descriptionHash: 'd'.repeat(64), schemaHash: 's'.repeat(64), manifestHash: 'm'.repeat(64), annotationsHash: 'a'.repeat(64) };

async function connection(tenantId: string, id: string, name: string, overrides: Record<string, unknown> = {}) {
    await prisma.integrationConnection.create({
        data: {
            id,
            tenantId,
            provider: 'mcp-server',
            name,
            isEnabled: true,
            configJson: { url: `https://${name}.example.com/mcp`, tenantId: 'entra-tenant', clientId: 'entra-client', scope: SCOPE },
            secretEncrypted: encryptField(JSON.stringify(delegatedSecrets())),
            lastTestedAt: new Date('2026-10-01T09:00:00.000Z'),
            lastTestStatus: 'ok',
            ...overrides,
        },
    });
}

beforeEach(async () => {
    await clearTenantRows();
    await deleteAuditRowsForTenants(prisma, TENANTS);
    for (const t of [A, B, GONE]) {
        await prisma.controlRequirementLink.create({
            data: { tenantId: t, controlId: controls[t].controlId, requirementId: controls[t].requirementId },
        });
    }
    await connection(A, CONN_A, 'tickets');
    await prisma.mcpToolManifestPin.create({
        data: { tenantId: A, toolName: TOOL_A, ...pinHashes, approvalSource: 'APPROVED', approvedByUserId: users[A], revision: 1, declaresWrite: false },
    });
    // B is a static-header connection, and holds a pin whose qualified name
    // names A's connection id. It is B's row; it must never reach A's passport.
    await connection(B, CONN_B, 'grafana', {
        configJson: { url: 'https://grafana.example.com/mcp' },
        secretEncrypted: encryptField(JSON.stringify({ authorization: 'Bearer static-header-canary' })),
    });
    await prisma.mcpToolManifestPin.create({
        data: { tenantId: B, toolName: `mcp__${CONN_A}__planted`, ...pinHashes, approvalSource: 'APPROVED', approvedByUserId: users[B], revision: 1 },
    });
    await connection(GONE, CONN_GONE, 'legacy');
    await connection(BARE, CONN_BARE, 'bare');
});

/** Every passport finding of a tenant, by sourceRef. Raw: status/severity/assignee are not encrypted. */
async function findingsOf(tenantId: string) {
    const rows = await prisma.finding.findMany({
        where: { tenantId, sourceKind: 'INTEGRATION_PASSPORT' },
        select: { id: true, sourceRef: true, severity: true, type: true, status: true, assigneeUserId: true },
        orderBy: { sourceRef: 'asc' },
    });
    return new Map(rows.map((r) => [r.sourceRef as string, r]));
}

const eventRefs = (m: Map<string, unknown>, week: string) => [...m.keys()].filter((k) => k.endsWith(`@${week}`));

async function passportArtefacts(tenantId: string) {
    return prisma.agenticEvidenceArtefact.findMany({
        where: { tenantId, kind: ARTEFACT_KIND_PASSPORTS },
        orderBy: { periodStart: 'asc' },
        select: { id: true, controlId: true, periodStart: true, evidenceId: true, sourceDigest: true, status: true, recordCount: true, withdrawnReason: true },
    });
}

/** The verified bundle a tenant's artefact for one week holds. */
async function bundleOf(tenantId: string, periodStartIso: string) {
    const artefact = (await passportArtefacts(tenantId)).find((a) => a.periodStart.toISOString() === periodStartIso);
    if (!artefact) throw new Error(`no passport artefact for ${periodStartIso}`);
    const content = (await prisma.evidence.findUniqueOrThrow({ where: { id: artefact.evidenceId } })).content ?? '';
    const extracted = extractPassportBundle(content, artefact.sourceDigest, artefact.periodStart);
    if (!extracted.ok) throw new Error(extracted.reason);
    return extracted.bundle;
}

/** A decrypted description, read through the usecase (Finding.description is encrypted at rest). */
async function descriptionOf(tenantId: string, id: string): Promise<string> {
    const f = (await getFinding(ownerCtx(tenantId), id)) as { description: string };
    return f.description;
}

// ── A first passport ────────────────────────────────────────────────────────

describe('a connection\'s first passport', () => {
    it('is its baseline: the absence findings, nothing "added", emitted on the supplier control', async () => {
        await prisma.integrationConnection.update({ where: { id: CONN_A }, data: { lastTestedAt: null, lastTestStatus: null } });

        const r = await sweep(A, W41);

        expect(r.outcome).toBe('BASELINE');
        expect(r.periodLabel).toBe('2026-W41');
        const artefacts = await passportArtefacts(A);
        expect(artefacts).toHaveLength(1);
        expect(artefacts[0]).toMatchObject({ controlId: controls[A].controlId, status: 'CURRENT', recordCount: 1 });
        expect(artefacts[0].periodStart.toISOString()).toBe('2026-10-05T00:00:00.000Z');

        const findings = await findingsOf(A);
        expect([...findings.keys()]).toEqual([`${CONN_A}:P11:OWNER_MISSING`, `${CONN_A}:P12:NEVER_TESTED`]);
        expect(eventRefs(findings, '2026-W41')).toEqual([]);
        // Rule 1 + rule 3: no owner is HIGH, raised rather than skipped, owned by
        // the OWNER role — so NO assignee, and the role named in the text.
        const missing = findings.get(`${CONN_A}:P11:OWNER_MISSING`)!;
        expect(missing).toMatchObject({ severity: 'HIGH', type: 'NONCONFORMITY', status: 'OPEN', assigneeUserId: null });
        expect(await descriptionOf(A, missing.id)).toContain("the tenant's OWNER role");
        const untested = findings.get(`${CONN_A}:P12:NEVER_TESTED`)!;
        expect(untested).toMatchObject({ severity: 'LOW', assigneeUserId: null });
        expect(await descriptionOf(A, untested.id)).toContain('see CONNECTION_OWNER_MISSING');

        // Each finding is linked to the passport Evidence it was found against.
        const links = await prisma.findingEvidence.findMany({ where: { tenantId: A }, select: { evidenceId: true } });
        expect(links.map((l) => l.evidenceId)).toEqual([artefacts[0].evidenceId, artefacts[0].evidenceId]);
    });

    it('carries the grant KIND and never the secret behind it', async () => {
        await sweep(A, W41);
        const [artefact] = await passportArtefacts(A);
        const evidence = await prisma.evidence.findUniqueOrThrow({ where: { id: artefact.evidenceId }, select: { content: true } });

        expect(evidence.content).toContain('grant delegated');
        expect(evidence.content).not.toContain(SECRET_CANARY);
        expect(evidence.content).not.toContain('client-secret-value'); // pragma: allowlist secret
        const extracted = extractPassportBundle(evidence.content ?? '', artefact.sourceDigest, artefact.periodStart);
        expect(extracted.ok).toBe(true);
    });
});

// ── Idempotency ─────────────────────────────────────────────────────────────

describe('the sweep is idempotent per ISO week', () => {
    it('a re-run of the same week writes nothing new, and the next unchanged week raises nothing', async () => {
        const first = await sweep(A, W41);
        const before = await findingsOf(A);

        const again = await sweep(A, W41);
        expect(again.findingsOpened + again.findingsReopened + again.findingsResolved).toBe(0);
        expect(again.artefacts.map((a) => a.outcome)).toEqual(['unchanged']);
        expect(await findingsOf(A)).toEqual(before);
        expect(await passportArtefacts(A)).toHaveLength(first.artefacts.length);

        const next = await sweep(A, W42);
        expect(next.outcome).toBe('COMPARED');
        expect(next.findingsOpened).toBe(0);
        expect(eventRefs(await findingsOf(A), '2026-W42')).toEqual([]);
        expect(await passportArtefacts(A)).toHaveLength(2);

        const nextAgain = await sweep(A, W42);
        expect(nextAgain.artefacts.map((a) => a.outcome)).toEqual(['unchanged']);
        expect(nextAgain.findingsOpened).toBe(0);
    });

    it('a same-week re-run compares against LAST week, never against the week it is re-running', async () => {
        await sweep(A, W41);
        await setExternalWriteMode(ownerCtx(A), CONN_A, 'DRY_RUN', EXTERNAL_MAX_MODE);
        const first = await sweep(A, W42);
        expect(eventRefs(await findingsOf(A), '2026-W42')).toEqual([`${CONN_A}:P8:WRITE_RUNG_WIDENED@2026-W42`]);
        expect(first.findingsOpened).toBe(1);

        // Narrowed back inside the same week. Against W41 (DISABLED) the week's
        // net change is nothing; against W42's own passport it would be a
        // narrowing. The re-run must reach the former.
        await setExternalWriteMode(ownerCtx(A), CONN_A, 'DISABLED', EXTERNAL_MAX_MODE);
        const rerun = await sweep(A, W42);
        expect(rerun.findingsOpened).toBe(0);
        expect(eventRefs(await findingsOf(A), '2026-W42')).toEqual([`${CONN_A}:P8:WRITE_RUNG_WIDENED@2026-W42`]);
    });

    it('a person closing an EVENT finding is final; a STATE finding whose condition persists reopens', async () => {
        await sweep(A, W41);
        await setExternalWriteMode(ownerCtx(A), CONN_A, 'DRY_RUN', EXTERNAL_MAX_MODE);
        await sweep(A, W42);
        const widened = `${CONN_A}:P8:WRITE_RUNG_WIDENED@2026-W42`;
        const missing = `${CONN_A}:P11:OWNER_MISSING`;
        await prisma.finding.updateMany({ where: { tenantId: A, sourceRef: { in: [widened, missing] } }, data: { status: 'CLOSED' } });

        const rerun = await sweep(A, W42);

        const after = await findingsOf(A);
        expect(after.get(widened)!.status).toBe('CLOSED');
        expect(after.get(missing)!.status).toBe('OPEN');
        expect(rerun).toMatchObject({ findingsOpened: 0, findingsReopened: 1 });
        expect(await prisma.finding.count({ where: { tenantId: A, sourceRef: widened } })).toBe(1);
    });

    it('a second change in a later week is a second finding, not folded into the first', async () => {
        await sweep(A, W41);
        await setExternalWriteMode(ownerCtx(A), CONN_A, 'DRY_RUN', EXTERNAL_MAX_MODE);
        await sweep(A, W42);
        // Past the dwell, outside the product's ladder: a second widening.
        await prisma.integrationConnection.update({ where: { id: CONN_A }, data: { externalWriteMode: 'PROPOSE_ONLY' } });
        await sweep(A, W43);

        const widenings = [...(await findingsOf(A)).keys()].filter((k) => k.startsWith(`${CONN_A}:P8:WRITE_RUNG_WIDENED`));
        expect(widenings).toEqual([
            `${CONN_A}:P8:WRITE_RUNG_WIDENED@2026-W42`,
            `${CONN_A}:P8:WRITE_RUNG_WIDENED@2026-W43`,
        ]);
    });
});

// ── The issue's three drift cases ───────────────────────────────────────────

describe('drift between two weeks', () => {
    it('a changed grant kind, a changed pin and a changed rung are exactly three findings', async () => {
        await sweep(A, W41);

        // Grant kind: delegated → app-only. Same stored scope, so neither the
        // effective scope nor the audience moves — the grant kind alone does.
        await prisma.integrationConnection.update({
            where: { id: CONN_A },
            data: { secretEncrypted: encryptField(JSON.stringify({ clientSecret: 'client-secret-value' })) }, // pragma: allowlist secret
        });
        // Pin: a re-approval that moved the description.
        await prisma.mcpToolManifestPin.update({
            where: { tenantId_toolName: { tenantId: A, toolName: TOOL_A } },
            data: { revision: 2, descriptionHash: 'e'.repeat(64), manifestHash: 'n'.repeat(64), previousManifestHash: 'm'.repeat(64) },
        });
        // Rung: through the product, so the move is audited and citable.
        await setExternalWriteMode(ownerCtx(A), CONN_A, 'DRY_RUN', EXTERNAL_MAX_MODE);
        const rungAudit = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: A, action: 'EXTERNAL_WRITE_MODE_CHANGED', entityId: CONN_A },
            select: { id: true },
        });

        const r = await sweep(A, W42);

        expect(r.outcome).toBe('COMPARED');
        const findings = await findingsOf(A);
        expect(eventRefs(findings, '2026-W42')).toEqual([
            `${CONN_A}:P3:GRANT_KIND_CHANGED@2026-W42`,
            `${CONN_A}:P6:PIN_CHANGED:list_tickets@2026-W42`,
            `${CONN_A}:P8:WRITE_RUNG_WIDENED@2026-W42`,
        ]);
        for (const ref of eventRefs(findings, '2026-W42')) {
            // Leaving `delegated` is HIGH; a moved description is HIGH; a widening is HIGH.
            expect(findings.get(ref)).toMatchObject({ severity: 'HIGH', status: 'OPEN', assigneeUserId: null });
        }
        const rung = findings.get(`${CONN_A}:P8:WRITE_RUNG_WIDENED@2026-W42`)!;
        expect(await descriptionOf(A, rung.id)).toContain(`${rungAudit.id} EXTERNAL_WRITE_MODE_CHANGED`);
        const pin = findings.get(`${CONN_A}:P6:PIN_CHANGED:list_tickets@2026-W42`)!;
        expect(await descriptionOf(A, pin.id)).toContain(`previousManifestHash ${'m'.repeat(64)}`);

        const w42 = (await passportArtefacts(A)).find((a) => a.periodStart.toISOString() === '2026-10-12T00:00:00.000Z')!;
        const linked = await prisma.findingEvidence.findMany({ where: { tenantId: A, evidenceId: w42.evidenceId }, select: { findingId: true } });
        expect(linked.map((l) => l.findingId).sort()).toEqual(eventRefs(findings, '2026-W42').map((ref) => findings.get(ref)!.id).sort());
    });

    it('no finding when nothing changed', async () => {
        await sweep(A, W41);
        const before = await findingsOf(A);
        const r = await sweep(A, W42);
        expect(r.findingsOpened).toBe(0);
        expect(await findingsOf(A)).toEqual(before);
    });
});

// ── P11 ─────────────────────────────────────────────────────────────────────

describe('the accountable owner', () => {
    it('naming one resolves CONNECTION_OWNER_MISSING and assigns the change to the new owner', async () => {
        await sweep(A, W41);
        await setIntegrationConnectionOwner(ownerCtx(A), CONN_A, users.namedOwner);
        const ownerAudit = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: A, action: 'INTEGRATION_CONNECTION_OWNER_SET' },
            select: { id: true },
        });

        const r = await sweep(A, W42);

        const findings = await findingsOf(A);
        expect(findings.get(`${CONN_A}:P11:OWNER_MISSING`)!.status).toBe('CLOSED');
        expect(r.findingsResolved).toBe(1);
        const changed = findings.get(`${CONN_A}:P11:OWNER_CHANGED@2026-W42`)!;
        expect(changed).toMatchObject({ severity: 'MEDIUM', assigneeUserId: users.namedOwner });
        expect(await descriptionOf(A, changed.id)).toContain(ownerAudit.id);
    });

    it('an owner whose membership is no longer ACTIVE is no owner', async () => {
        await setIntegrationConnectionOwner(ownerCtx(A), CONN_A, users.namedOwner);
        await prisma.tenantMembership.updateMany({ where: { tenantId: A, userId: users.namedOwner }, data: { status: 'DEACTIVATED' } });
        try {
            await sweep(A, W41);
            expect((await findingsOf(A)).get(`${CONN_A}:P11:OWNER_MISSING`)).toMatchObject({ status: 'OPEN', assigneeUserId: null });
        } finally {
            await prisma.tenantMembership.updateMany({ where: { tenantId: A, userId: users.namedOwner }, data: { status: 'ACTIVE' } });
        }
    });
});

// ── Which connections have a passport ───────────────────────────────────────

describe('the passport population', () => {
    const CONN_SLACK = 'cmpassportconnslackxxxxx';

    it('is mcp-server connections only: another provider gets no passport, no finding and a 404 view', async () => {
        await prisma.integrationConnection.create({
            data: { id: CONN_SLACK, tenantId: A, provider: 'slack', name: 'chat', isEnabled: true, configJson: {} },
        });

        await sweep(A, W41);

        expect((await bundleOf(A, '2026-10-05T00:00:00.000Z')).connections.map((p) => p.connectionId)).toEqual([CONN_A]);
        expect([...(await findingsOf(A)).keys()].filter((k) => k.startsWith(CONN_SLACK))).toEqual([]);
        await expect(getIntegrationPassportView(ownerCtx(A), CONN_SLACK)).rejects.toMatchObject({ status: 404 });
    });

    it('includes a disabled connection: disabling is CONNECTION_DISABLED, never VANISHED', async () => {
        await sweep(A, W41);
        await removeIntegrationConnection(ownerCtx(A), CONN_A);

        await sweep(A, W42);

        const findings = await findingsOf(A);
        expect(findings.get(`${CONN_A}:P2:CONNECTION_DISABLED@2026-W42`)).toMatchObject({ severity: 'LOW', status: 'OPEN' });
        expect(findings.has(`${CONN_A}:VANISHED`)).toBe(false);
        const w42 = await bundleOf(A, '2026-10-12T00:00:00.000Z');
        expect(w42.connections.map((p) => [p.connectionId, p.enabled])).toEqual([[CONN_A, false]]);
        expect((await getIntegrationPassportView(ownerCtx(A), CONN_A)).current.enabled).toBe(false);
    });
});

// ── P1 never carries the URL ────────────────────────────────────────────────

describe('the endpoint', () => {
    it('is an origin and a keyed digest: a credential in the path or query reaches no evidence and no finding, and its change is raised', async () => {
        const at = async (key: string) =>
            prisma.integrationConnection.update({
                where: { id: CONN_A },
                data: {
                    configJson: {
                        url: `https://tickets.example.com/api/mcp/s/${key}/mcp?api_key=${key}-query`,
                        tenantId: 'entra-tenant',
                        clientId: 'entra-client',
                        scope: SCOPE,
                    },
                },
            });
        await at('sk_live_w41_canary');
        await sweep(A, W41);
        await at('sk_live_w42_canary');

        await sweep(A, W42);

        const findings = await findingsOf(A);
        const changed = findings.get(`${CONN_A}:P1:ENDPOINT_CHANGED@2026-W42`)!;
        expect(changed).toMatchObject({ severity: 'HIGH', status: 'OPEN' });
        const texts = [
            ...(await prisma.evidence.findMany({ where: { tenantId: A }, select: { content: true } })).map((e) => e.content ?? ''),
            ...(await Promise.all([...findings.values()].map((f) => descriptionOf(A, f.id)))),
        ];
        expect(texts.length).toBeGreaterThan(2);
        const everything = texts.join('\n');
        expect(everything).not.toContain('sk_live_w41_canary');
        expect(everything).not.toContain('sk_live_w42_canary');
        expect(await descriptionOf(A, changed.id)).toContain('within origin https://tickets.example.com');
        expect((await bundleOf(A, '2026-10-12T00:00:00.000Z')).connections[0].endpoint.origin).toBe('https://tickets.example.com');
    });
});

// ── A truncated read ────────────────────────────────────────────────────────

describe('a read at its cap', () => {
    it('compares, emits and closes nothing, and still raises the absence findings of the connections it read', async () => {
        await sweep(A, W41);
        // An owner named after W41: a complete pass would close OWNER_MISSING
        // and raise OWNER_CHANGED. A truncated one must do neither.
        await setIntegrationConnectionOwner(ownerCtx(A), CONN_A, users.namedOwner);
        // CONN_A plus this many is one over the cap. Every extra sorts after
        // CONN_A, so CONN_A is read and the LAST extra is the one past the cap.
        const extras = Array.from({ length: PASSPORT_CONNECTION_CAP }, (_, i) => `cmpassportextra${String(i).padStart(9, '0')}`);
        await prisma.integrationConnection.createMany({
            data: extras.map((id) => ({
                id,
                tenantId: A,
                provider: 'mcp-server',
                name: `extra ${id.slice(-3)}`,
                isEnabled: true,
                configJson: { url: 'https://extra.example.com/mcp' },
                lastTestedAt: new Date('2026-10-01T09:00:00.000Z'),
                lastTestStatus: 'ok',
            })),
        });

        const r = await sweep(A, W42);

        expect(r.outcome).toBe('TRUNCATED');
        expect(r.artefacts).toEqual([]);
        expect((await passportArtefacts(A)).map((a) => a.periodStart.toISOString())).toEqual(['2026-10-05T00:00:00.000Z']);
        const findings = await findingsOf(A);
        expect(findings.get('tenant:NOT_EVIDENCED:POPULATION_TRUNCATED')).toMatchObject({ status: 'OPEN', assigneeUserId: null });
        // Raised for a connection that was read, never baselined before the cap was crossed.
        expect(findings.get(`${extras[0]}:P11:OWNER_MISSING`)).toMatchObject({ severity: 'HIGH', status: 'OPEN', assigneeUserId: null });
        expect(findings.has(`${extras[extras.length - 1]}:P11:OWNER_MISSING`)).toBe(false);
        // Closes nothing, raises no event.
        expect(findings.get(`${CONN_A}:P11:OWNER_MISSING`)!.status).toBe('OPEN');
        expect(eventRefs(findings, '2026-W42')).toEqual([]);
        expect(r.findingsResolved).toBe(0);
        expect(r.findingsOpened).toBe(1 + PASSPORT_CONNECTION_CAP - 1);
    });
});

// ── asOf names a week; the rows are read now ────────────────────────────────

describe('a pass for a week that is not the newest', () => {
    it('is refused when a later week is already emitted, and changes nothing', async () => {
        await sweep(A, W40);
        await sweep(A, W41);
        await setExternalWriteMode(ownerCtx(A), CONN_A, 'DRY_RUN', EXTERNAL_MAX_MODE);
        await sweep(A, W42);
        const artefactsBefore = await passportArtefacts(A);
        const w41Before = await bundleOf(A, '2026-10-05T00:00:00.000Z');
        const findingsBefore = await findingsOf(A);

        // Re-run W41 after W42: it would rebuild W41 from today's DRY_RUN rows
        // and raise the widening again, against W40, as …WIDENED@2026-W41.
        await expect(sweep(A, W41)).rejects.toMatchObject({ status: 409 });

        expect(await passportArtefacts(A)).toEqual(artefactsBefore);
        expect(await bundleOf(A, '2026-10-05T00:00:00.000Z')).toEqual(w41Before);
        expect(await findingsOf(A)).toEqual(findingsBefore);
        expect(findingsBefore.has(`${CONN_A}:P8:WRITE_RUNG_WIDENED@2026-W41`)).toBe(false);
    });

    it('is refused by the job when the week has not begun', async () => {
        await expect(
            runIntegrationPassportSweepForTenants({ tenantId: A, asOf: '2099-01-04T05:45:00.000Z' }, 'run-future'),
        ).rejects.toThrow('has not begun');
        expect(await passportArtefacts(A)).toEqual([]);
    });
});

// ── Rule 3, held while a finding is open ────────────────────────────────────

describe('an open finding follows the connection\'s accountable owner', () => {
    it('moves to the owner once one is named, and back to the OWNER role when they leave', async () => {
        await prisma.integrationConnection.update({ where: { id: CONN_A }, data: { lastTestedAt: null, lastTestStatus: null } });
        await prisma.mcpToolManifestPin.update({
            where: { tenantId_toolName: { tenantId: A, toolName: TOOL_A } },
            data: { annotationsHash: null },
        });
        await sweep(A, W40);
        // An EVENT raised while nobody owns the connection.
        await setExternalWriteMode(ownerCtx(A), CONN_A, 'DRY_RUN', EXTERNAL_MAX_MODE);
        await sweep(A, W41);
        const moving = [
            `${CONN_A}:P12:NEVER_TESTED`,
            `${CONN_A}:P6:ANNOTATIONS_UNATTESTED:list_tickets`,
            `${CONN_A}:P8:WRITE_RUNG_WIDENED@2026-W41`,
        ];
        const missing = `${CONN_A}:P11:OWNER_MISSING`;
        const fallback = ` ${OWNER_ROLE_FALLBACK}`;
        let findings = await findingsOf(A);
        for (const ref of moving) {
            expect(findings.get(ref)).toMatchObject({ status: 'OPEN', assigneeUserId: null });
            expect((await descriptionOf(A, findings.get(ref)!.id)).endsWith(fallback)).toBe(true);
        }

        await setIntegrationConnectionOwner(ownerCtx(A), CONN_A, users.namedOwner);
        const named = await sweep(A, W42);

        findings = await findingsOf(A);
        expect(findings.get(missing)!.status).toBe('CLOSED');
        expect(named.findingsReassigned).toBe(moving.length);
        for (const ref of moving) {
            expect(findings.get(ref)).toMatchObject({ status: 'OPEN', assigneeUserId: users.namedOwner });
            expect(await descriptionOf(A, findings.get(ref)!.id)).not.toContain('has no accountable owner');
        }
        const reassignments = await prisma.auditLog.findMany({
            where: { tenantId: A, entity: 'Finding', action: 'UPDATE', details: { contains: 'reassigned' } },
            select: { entityId: true },
        });
        expect(reassignments.map((a) => a.entityId).sort()).toEqual(moving.map((ref) => findings.get(ref)!.id).sort());

        // The owner leaves: nobody is accountable, so the OWNER role holds them again.
        await prisma.tenantMembership.updateMany({ where: { tenantId: A, userId: users.namedOwner }, data: { status: 'DEACTIVATED' } });
        try {
            await sweep(A, W43);
            findings = await findingsOf(A);
            expect(findings.get(missing)).toMatchObject({ status: 'OPEN', assigneeUserId: null });
            for (const ref of [...moving, `${CONN_A}:P11:OWNER_CHANGED@2026-W42`]) {
                expect(findings.get(ref)).toMatchObject({ status: 'OPEN', assigneeUserId: null });
                expect((await descriptionOf(A, findings.get(ref)!.id)).endsWith(fallback)).toBe(true);
            }
        } finally {
            await prisma.tenantMembership.updateMany({ where: { tenantId: A, userId: users.namedOwner }, data: { status: 'ACTIVE' } });
        }
    });
});

// ── Tenants ─────────────────────────────────────────────────────────────────

describe('two tenants', () => {
    it("each sweep reads and writes its own tenant only, and both ISO spellings are reached", async () => {
        const a = await sweep(A, W41);
        const b = await sweep(B, W41);

        // B's control hangs off the LIBRARY spelling (A.5.19), A's off the seed
        // spelling (5.19): both are emitted to.
        expect(a.artefacts.map((x) => x.controlId)).toEqual([controls[A].controlId]);
        expect(b.artefacts.map((x) => x.controlId)).toEqual([controls[B].controlId]);

        // B's pin named for A's connection id never reaches A's passport.
        const [artefact] = await passportArtefacts(A);
        const content = (await prisma.evidence.findUniqueOrThrow({ where: { id: artefact.evidenceId } })).content ?? '';
        const extracted = extractPassportBundle(content, artefact.sourceDigest, artefact.periodStart);
        if (!extracted.ok) throw new Error(extracted.reason);
        expect(extracted.bundle.connections.map((p) => p.connectionId)).toEqual([CONN_A]);
        expect(extracted.bundle.connections[0].pinnedTools.map((p) => p.toolName)).toEqual([TOOL_A]);

        // Every row each pass wrote is its own tenant's.
        const aFindingIds = [...(await findingsOf(A)).values()].map((f) => f.id);
        const bFindingIds = [...(await findingsOf(B)).values()].map((f) => f.id);
        expect(aFindingIds.length).toBeGreaterThan(0);
        expect(bFindingIds.length).toBeGreaterThan(0);

        // And through the product's own read path: B cannot see A's findings; A can.
        const readByB = ((await listFindings(ownerCtx(B))) as Array<{ id: string }>).map((f) => f.id);
        const readByA = ((await listFindings(ownerCtx(A))) as Array<{ id: string }>).map((f) => f.id);
        expect(readByB.filter((id) => aFindingIds.includes(id))).toEqual([]);
        expect(readByA).toEqual(expect.arrayContaining(aFindingIds));
    });

    it("a tenant's view cannot open another tenant's connection", async () => {
        await expect(getIntegrationPassportView(ownerCtx(A), CONN_B)).rejects.toMatchObject({ status: 404 });
    });
});

// ── Fail closed ─────────────────────────────────────────────────────────────

describe('a prior that cannot be trusted', () => {
    it('an edited passport is a HIGH finding and NOT a comparison — and reported once', async () => {
        await sweep(A, W41);
        const [w41] = await passportArtefacts(A);
        const evidence = await prisma.evidence.findUniqueOrThrow({ where: { id: w41.evidenceId }, select: { content: true } });
        await prisma.evidence.update({
            where: { id: w41.evidenceId },
            data: { content: (evidence.content ?? '').replace('"enabled":true', '"enabled":false') },
        });
        await setExternalWriteMode(ownerCtx(A), CONN_A, 'DRY_RUN', EXTERNAL_MAX_MODE);

        const r = await sweep(A, W42);

        expect(r.outcome).toBe('PRIOR_UNVERIFIABLE');
        const findings = await findingsOf(A);
        expect(findings.get('tenant:PRIOR_UNVERIFIABLE:2026-W41')).toMatchObject({ severity: 'HIGH', type: 'NONCONFORMITY', assigneeUserId: null });
        // Never compared against: the rung move is not raised as drift.
        expect(eventRefs(findings, '2026-W42')).toEqual([]);

        const rerun = await sweep(A, W42);
        expect(rerun.findingsOpened).toBe(0);
    });

    it('a tenant with no target control is told its drift is not being compared — until it has one', async () => {
        const first = await sweep(BARE, W41);
        expect(first.outcome).toBe('NOT_EVIDENCED');
        expect(await passportArtefacts(BARE)).toEqual([]);
        expect((await findingsOf(BARE)).get('tenant:NOT_EVIDENCED:NO_TARGET_CONTROL')).toMatchObject({
            severity: 'MEDIUM',
            status: 'OPEN',
            assigneeUserId: null,
        });

        await prisma.controlRequirementLink.create({
            data: { tenantId: BARE, controlId: controls[BARE].controlId, requirementId: controls[BARE].requirementId },
        });
        const second = await sweep(BARE, W42);

        expect(second.outcome).toBe('BASELINE');
        expect(await passportArtefacts(BARE)).toHaveLength(1);
        expect((await findingsOf(BARE)).get('tenant:NOT_EVIDENCED:NO_TARGET_CONTROL')!.status).toBe('CLOSED');
    });
});

// ── Evidence lifecycle ──────────────────────────────────────────────────────

describe('the daily withdrawal sweep and the weekly passport', () => {
    it('leaves a mapped passport CURRENT, withdraws an unmapped one by its WEEK, and judges each kind on its own', async () => {
        await sweep(A, W42);
        // A receipts artefact on the same control. No ASI framework is installed,
        // so nothing can say whether receipts are still mapped — it must be left.
        const receiptEvidence = await prisma.evidence.create({
            data: { tenantId: A, type: 'TEXT', title: 'receipts', content: 'counts', category: 'integration', status: 'APPROVED' },
        });
        const receipts = await prisma.agenticEvidenceArtefact.create({
            data: {
                tenantId: A,
                controlId: controls[A].controlId,
                kind: ARTEFACT_KIND_RECEIPTS,
                periodStart: new Date('2026-10-01T00:00:00.000Z'),
                periodEnd: new Date('2026-11-01T00:00:00.000Z'),
                evidenceId: receiptEvidence.id,
                sourceDigest: 'r'.repeat(64),
            },
        });

        expect(await withdrawStaleAgenticEvidence(actorCtx(A))).toEqual([]);

        await prisma.controlRequirementLink.deleteMany({ where: { tenantId: A } });
        const withdrawn = await withdrawStaleAgenticEvidence(actorCtx(A));

        const [passport] = await passportArtefacts(A);
        expect(withdrawn).toEqual([{ artefactId: passport.id, evidenceId: passport.evidenceId, reason: 'OBLIGATION_UNMAPPED' }]);
        expect(passport.status).toBe('WITHDRAWN');
        const notice = (await prisma.evidence.findUniqueOrThrow({ where: { id: passport.evidenceId } })).content ?? '';
        expect(notice).toContain('Period: 2026-W42');
        expect((await prisma.agenticEvidenceArtefact.findUniqueOrThrow({ where: { id: receipts.id } })).status).toBe('CURRENT');

        // And the next week cannot compare against a withdrawn body.
        await prisma.controlRequirementLink.create({
            data: { tenantId: A, controlId: controls[A].controlId, requirementId: controls[A].requirementId },
        });
        const next = await sweep(A, W43);
        expect(next.outcome).toBe('PRIOR_UNVERIFIABLE');
        const unverifiable = (await findingsOf(A)).get('tenant:PRIOR_UNVERIFIABLE:2026-W42')!;
        expect(await descriptionOf(A, unverifiable.id)).toContain('WITHDRAWN');
    });
});

// ── The job ─────────────────────────────────────────────────────────────────

describe('the job', () => {
    it('is scheduled weekly on Sunday 05:45 UTC with one attempt', () => {
        const entry = SCHEDULED_JOBS.find((j) => j.name === 'integration-passport-sweep');
        expect(entry).toMatchObject({ pattern: '45 5 * * 0' });
        expect(entry?.tz).toBeUndefined();
        expect(JOB_DEFAULTS['integration-passport-sweep'].attempts).toBe(1);
    });

    it('finds a tenant whose LAST connection vanished through its last passport, and says so', async () => {
        const first = await runIntegrationPassportSweepForTenants({ asOf: W41.toISOString() }, 'run-w41');
        expect(first.tenants).toBe(TENANTS.length);
        expect(await passportArtefacts(GONE)).toHaveLength(1);

        // Removed outside the product's own paths: the product never deletes one.
        await prisma.integrationConnection.delete({ where: { id: CONN_GONE } });
        const second = await runIntegrationPassportSweepForTenants({ asOf: W42.toISOString() }, 'run-w42');

        expect(second.tenants).toBe(TENANTS.length);
        expect((await findingsOf(GONE)).get(`${CONN_GONE}:VANISHED`)).toMatchObject({
            severity: 'HIGH',
            type: 'NONCONFORMITY',
            assigneeUserId: null,
        });
        const artefacts = await passportArtefacts(GONE);
        expect(artefacts.map((a) => a.recordCount)).toEqual([1, 0]);
    });

    it('a targeted run sweeps that tenant only, and reports counts', async () => {
        const r = await runIntegrationPassportSweepJob({ tenantId: A, asOf: W41.toISOString() });
        expect(r).toMatchObject({ jobName: 'integration-passport-sweep', success: true, itemsScanned: 1, itemsActioned: 1 });
        expect(r.details).toMatchObject({ period: '2026-W41', outcomes: { BASELINE: 1 }, artefactsCreated: 1 });
        expect(await passportArtefacts(B)).toEqual([]);
    });
});

// ── The view ────────────────────────────────────────────────────────────────

describe('the passport view', () => {
    it('shows the live passport, whether it matches the last emission, and what the next sweep would raise', async () => {
        await sweep(A, W41);
        const quiet = await getIntegrationPassportView(ownerCtx(A), CONN_A);
        expect(quiet.current.connectionId).toBe(CONN_A);
        expect(quiet.lastEmitted).toMatchObject({ periodLabel: '2026-W41', verified: true, unchangedSince: true });
        expect(quiet.changes).toEqual([]);
        expect(quiet.openFindings.map((f) => f.sourceRef)).toEqual([`${CONN_A}:P11:OWNER_MISSING`]);
        expect(quiet.writeDeclarations).toEqual({ declaredWrite: [], declarationNotRecorded: [] });

        await setExternalWriteMode(ownerCtx(A), CONN_A, 'DRY_RUN', EXTERNAL_MAX_MODE);
        const moved = await getIntegrationPassportView(ownerCtx(A), CONN_A);
        expect(moved.lastEmitted?.unchangedSince).toBe(false);
        expect(moved.changes.map((c) => c.code)).toEqual(['WRITE_RUNG_WIDENED']);
        // A preview: nothing was written.
        expect(eventRefs(await findingsOf(A), '2026-W42')).toEqual([]);
    });
});
