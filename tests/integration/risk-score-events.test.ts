/**
 * RQ2-1 — score-provenance ledger, DB-backed.
 *
 * Coverage
 * --------
 *   1. createRisk lands exactly one INHERENT/USER event,
 *      transactionally with the row.
 *   2. updateRisk L/I edit appends a second INHERENT event;
 *      non-score edits append none.
 *   3. Residual pair: row carries decomposed dims + DERIVED rollup;
 *      RESIDUAL/USER event recorded; incomplete pair rejected with
 *      no partial write.
 *   4. listScoreEvents — newest-first with actor attach.
 *   5. Tenant isolation — foreign tenant reads zero events.
 */

import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { createRisk, updateRisk } from '@/app-layer/usecases/risk';
import { listScoreEvents } from '@/app-layer/usecases/risk-score-events';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE_TAG = `rq21-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE_TAG}`;
const FOREIGN_TENANT_ID = `t-${SUITE_TAG}-other`;

let editor: { userId: string };
let foreignReader: { userId: string };

async function makeUser(label: string): Promise<{ userId: string }> {
    const email = `${SUITE_TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email) },
    });
    return { userId: u.id };
}

async function seed() {
    await globalPrisma.tenant.upsert({
        where: { id: TENANT_ID },
        update: {},
        create: { id: TENANT_ID, name: `t ${SUITE_TAG}`, slug: SUITE_TAG },
    });
    await globalPrisma.tenant.upsert({
        where: { id: FOREIGN_TENANT_ID },
        update: {},
        create: { id: FOREIGN_TENANT_ID, name: `t ${SUITE_TAG} other`, slug: `${SUITE_TAG}-other` },
    });
    editor = await makeUser('editor');
    foreignReader = await makeUser('foreign');
    await globalPrisma.tenantMembership.createMany({
        data: [
            { tenantId: TENANT_ID, userId: editor.userId, role: Role.EDITOR, status: MembershipStatus.ACTIVE },
            { tenantId: FOREIGN_TENANT_ID, userId: foreignReader.userId, role: Role.READER, status: MembershipStatus.ACTIVE },
        ],
    });
}

async function teardown() {
    const tenantIds = [TENANT_ID, FOREIGN_TENANT_ID];
    await globalPrisma.riskScoreEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await globalPrisma.risk.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await globalPrisma.tenantMembership.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await deleteAuditRowsForTenants(globalPrisma, tenantIds);
    const userIds = [editor, foreignReader].filter(Boolean).map((u) => u.userId);
    if (userIds.length > 0) {
        await globalPrisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await globalPrisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
}

function ctxAs(role: Role, userId: string, tenantId = TENANT_ID) {
    return makeRequestContext(role, { userId, tenantId, tenantSlug: SUITE_TAG });
}

describeFn('RQ2-1 — score provenance (DB)', () => {
    beforeAll(seed);
    afterAll(async () => {
        await teardown();
        await globalPrisma.$disconnect();
    });

    let riskId = '';

    it('createRisk lands exactly one INHERENT/USER event', async () => {
        const risk = await createRisk(ctxAs(Role.EDITOR, editor.userId), {
            title: 'Provenance subject',
            likelihood: 4,
            impact: 5,
        });
        riskId = risk.id;

        const events = await globalPrisma.riskScoreEvent.findMany({
            where: { tenantId: TENANT_ID, riskId },
        });
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            kind: 'INHERENT',
            likelihood: 4,
            impact: 5,
            score: 20,
            source: 'USER',
            createdByUserId: editor.userId,
        });
    });

    it('L/I edit appends a second INHERENT event; non-score edit appends none', async () => {
        await updateRisk(ctxAs(Role.EDITOR, editor.userId), riskId, { likelihood: 2, impact: 2 });
        await updateRisk(ctxAs(Role.EDITOR, editor.userId), riskId, { title: 'renamed, no score change' });

        const events = await globalPrisma.riskScoreEvent.findMany({
            where: { tenantId: TENANT_ID, riskId, kind: 'INHERENT' },
            orderBy: { createdAt: 'asc' },
        });
        expect(events).toHaveLength(2);
        expect(events[1].score).toBe(4);
    });

    it('residual pair: decomposed dims + derived rollup on the row, RESIDUAL event in the ledger', async () => {
        await updateRisk(ctxAs(Role.EDITOR, editor.userId), riskId, {
            residualLikelihood: 2,
            residualImpact: 3,
            scoreJustification: 'controls in place',
        });

        const row = await globalPrisma.risk.findUniqueOrThrow({ where: { id: riskId } });
        expect(row.residualLikelihood).toBe(2);
        expect(row.residualImpact).toBe(3);
        expect(row.residualScore).toBe(6); // derived, never raw
        expect(row.residualScoreSetAt).not.toBeNull();

        const residualEvents = await globalPrisma.riskScoreEvent.findMany({
            where: { tenantId: TENANT_ID, riskId, kind: 'RESIDUAL' },
        });
        expect(residualEvents).toHaveLength(1);
        expect(residualEvents[0]).toMatchObject({
            score: 6,
            source: 'USER',
        });
        // Epic B — `justification` is in the encrypted-fields
        // manifest: the RAW row holds ciphertext…
        expect(residualEvents[0].justification).toMatch(/^v[12]:/);
        // …and the usecase read path decrypts transparently.
        const viaUsecase = await listScoreEvents(ctxAs('EDITOR', editor.userId), riskId);
        const decrypted = viaUsecase.find((e) => e.kind === 'RESIDUAL');
        expect(decrypted?.justification).toBe('controls in place');
    });

    it('incomplete residual pair is rejected with no partial write', async () => {
        const before = await globalPrisma.riskScoreEvent.count({ where: { riskId } });
        await expect(
            updateRisk(ctxAs(Role.EDITOR, editor.userId), riskId, { residualLikelihood: 1 }),
        ).rejects.toThrow(/must be supplied together/);
        const after = await globalPrisma.riskScoreEvent.count({ where: { riskId } });
        expect(after).toBe(before);
    });

    it('listScoreEvents returns newest-first with actor names attached', async () => {
        const rows = (await listScoreEvents(
            ctxAs(Role.EDITOR, editor.userId),
            riskId,
        )) as Array<{ kind: string; actor: { name: string | null } | null; createdAt: Date }>;

        expect(rows.length).toBeGreaterThanOrEqual(3);
        for (let i = 1; i < rows.length; i++) {
            expect(rows[i - 1].createdAt.getTime()).toBeGreaterThanOrEqual(rows[i].createdAt.getTime());
        }
        expect(rows[0].actor).not.toBeNull();
    });

    it('tenant isolation — a foreign tenant reads zero events for this risk', async () => {
        const rows = await listScoreEvents(
            ctxAs(Role.READER, foreignReader.userId, FOREIGN_TENANT_ID),
            riskId,
        );
        expect(rows).toHaveLength(0);
    });
});
