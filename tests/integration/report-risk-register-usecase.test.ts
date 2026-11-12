/**
 * `getReports` — the Risk Register PDF's data — on real rows (#5376).
 *
 * The PDF renderer is unit-tested against hand-built rows; the projection that
 * produces those rows from the database had no behavioural test. This seeds
 * two tenants and pins what an auditor would read:
 *
 *   - POPULATION. A soft-deleted risk is not in the register (the reason is in
 *     `ReportRepository.getRiskRegisterData`), and another tenant's risks never
 *     are. Rows come highest inherent score first.
 *   - TREATMENT. The persisted `TreatmentDecision` is relabelled to the
 *     canonical strategy wording (TREAT → Mitigate, TOLERATE → Accept, …); no
 *     decision reads "Untreated".
 *   - OWNER. The free-text `treatmentOwner`; when none is named, the assigned
 *     user (`ownerUserId`) by name — or the e-mail's local part when the user
 *     has no name, as the risk list shows it; "Unassigned" only when neither
 *     exists (owner decision, 2026-11-12, #5376).
 *   - CONTROLS. Each linked control code first — its `annexId`, else its
 *     `code` — then its name (`A.5.1 Policies for information security`), the
 *     name alone when it has no code, joined with ", " (owner decision,
 *     2026-11-12). No linked control is the empty string, which the PDF renders
 *     as "—". A control in the trash is not listed: it mitigates nothing.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import { getReports } from '@/app-layer/usecases/report';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `rpt-${randomUUID().slice(0, 8)}`;
const A = `a-${SUITE}`;
const B = `b-${SUITE}`;
const OWNER_USER = `u-${SUITE}`;
const NAMELESS_USER = `n-${SUITE}`;

const ctxA = makeRequestContext('READER', { tenantId: A, tenantSlug: A });
const ctxB = makeRequestContext('READER', { tenantId: B, tenantSlug: B });

const ids: Record<string, string> = {};

async function risk(tenantId: string, key: string, data: Record<string, unknown>) {
    const row = await prisma.risk.create({
        data: { tenantId, title: `${SUITE}-${key}`, category: 'Cybersecurity', ...data },
    });
    ids[key] = row.id;
    return row.id;
}

const byTitle = <R extends { title: string }>(rows: R[], key: string) => rows.find((r) => r.title === `${SUITE}-${key}`);

describeFn('getReports — the Risk Register projection (real DB)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        for (const t of [A, B]) await prisma.tenant.create({ data: { id: t, name: t, slug: t } });
        const email = `${SUITE}@example.test`;
        await prisma.user.create({ data: { id: OWNER_USER, email, emailHash: hashForLookup(email), name: 'Dana Petrova' } });
        const namelessEmail = `nameless.${SUITE}@example.test`;
        await prisma.user.create({ data: { id: NAMELESS_USER, email: namelessEmail, emailHash: hashForLookup(namelessEmail) } });
        await prisma.tenantMembership.create({ data: { tenantId: A, userId: OWNER_USER, role: 'EDITOR', status: 'ACTIVE' } });

        const annexControl = await prisma.control.create({
            data: { tenantId: A, name: 'Policies for information security', code: 'CUST-1', annexId: 'A.5.1' },
        });
        const codedControl = await prisma.control.create({
            data: { tenantId: A, name: 'Quarterly access recertification', code: 'CUST-2' },
        });
        const uncodedControl = await prisma.control.create({
            data: { tenantId: A, name: 'Clean desk' },
        });

        const treated = await risk(A, 'treated', {
            inherentScore: 20, score: 20, treatment: 'TREAT', treatmentOwner: 'Head of IT',
            likelihood: 4, impact: 5,
        });
        await risk(A, 'tolerated', { inherentScore: 15, score: 15, treatment: 'TOLERATE', treatmentOwner: 'CFO' });
        await risk(A, 'transferred', { inherentScore: 12, score: 12, treatment: 'TRANSFER' });
        await risk(A, 'avoided', { inherentScore: 10, score: 10, treatment: 'AVOID' });
        await risk(A, 'untreated', { inherentScore: 6, score: 6 });
        await risk(A, 'userOwned', { inherentScore: 4, score: 4, ownerUserId: OWNER_USER });
        await risk(A, 'namedAndUser', { inherentScore: 3, score: 3, ownerUserId: OWNER_USER, treatmentOwner: 'Risk committee' });
        await risk(A, 'namelessUser', { inherentScore: 2, score: 2, ownerUserId: NAMELESS_USER });
        await risk(A, 'deleted', { inherentScore: 25, score: 25, deletedAt: new Date() });
        await risk(B, 'foreign', { inherentScore: 25, score: 25, treatment: 'TREAT', treatmentOwner: 'B owner' });

        await prisma.riskControl.create({ data: { tenantId: A, riskId: treated, controlId: annexControl.id } });
        await prisma.riskControl.create({ data: { tenantId: A, riskId: treated, controlId: codedControl.id } });
        await prisma.riskControl.create({ data: { tenantId: A, riskId: treated, controlId: uncodedControl.id } });
        // A control in the trash, still linked: soft delete keeps the join row.
        const trashed = await prisma.control.create({
            data: { tenantId: A, name: 'Retired network control', annexId: 'A.8.20', deletedAt: new Date() },
        });
        await prisma.riskControl.create({ data: { tenantId: A, riskId: treated, controlId: trashed.id } });
    });

    afterAll(async () => {
        // Audit rows first: `AuditLog` holds a foreign key to the tenant.
        await deleteAuditRowsForTenants(prisma, [A, B]);
        for (const t of [A, B]) {
            await prisma.riskControl.deleteMany({ where: { tenantId: t } });
            await prisma.risk.deleteMany({ where: { tenantId: t } });
            await prisma.control.deleteMany({ where: { tenantId: t } });
        }
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, [A, B]);
        });
        await prisma.user.deleteMany({ where: { id: { in: [OWNER_USER, NAMELESS_USER] } } });
        await prisma.tenant.deleteMany({ where: { id: { in: [A, B] } } });
        await prisma.$disconnect();
    });

    it('holds exactly this tenant\'s live risks, highest inherent score first', async () => {
        const { riskRegister } = await getReports(ctxA);
        expect(riskRegister.map((r) => r.title)).toEqual(
            ['treated', 'tolerated', 'transferred', 'avoided', 'untreated', 'userOwned', 'namedAndUser', 'namelessUser']
                .map((k) => `${SUITE}-${k}`),
        );
        expect(riskRegister.map((r) => r.score)).toEqual([20, 15, 12, 10, 6, 4, 3, 2]);
    });

    it('a soft-deleted risk is not in the register, though the row is still there', async () => {
        const { riskRegister } = await getReports(ctxA);
        expect(byTitle(riskRegister, 'deleted')).toBeUndefined();
        expect(riskRegister.some((r) => r.id === ids.deleted)).toBe(false);
        const row = await prisma.risk.findUnique({ where: { id: ids.deleted }, select: { deletedAt: true } });
        expect(row?.deletedAt).not.toBeNull();
    });

    it('another tenant\'s risks never appear, and that tenant sees only its own', async () => {
        const a = await getReports(ctxA);
        expect(a.riskRegister.some((r) => r.id === ids.foreign)).toBe(false);
        const b = await getReports(ctxB);
        expect(b.riskRegister.map((r) => r.id)).toEqual([ids.foreign]);
    });

    it('the treatment decision is relabelled to the canonical strategy; no decision reads "Untreated"', async () => {
        const { riskRegister } = await getReports(ctxA);
        expect(Object.fromEntries(riskRegister.map((r) => [r.title.slice(SUITE.length + 1), r.treatment]))).toEqual({
            treated: 'Mitigate',
            tolerated: 'Accept',
            transferred: 'Transfer',
            avoided: 'Avoid',
            untreated: 'Untreated',
            userOwned: 'Untreated',
            namedAndUser: 'Untreated',
            namelessUser: 'Untreated',
        });
    });

    it('the owner is the treatment-owner text, else the assigned user, else "Unassigned"', async () => {
        const { riskRegister } = await getReports(ctxA);
        expect(byTitle(riskRegister, 'treated')?.owner).toBe('Head of IT');
        expect(byTitle(riskRegister, 'tolerated')?.owner).toBe('CFO');
        // Neither a named owner nor an assigned user.
        expect(byTitle(riskRegister, 'untreated')?.owner).toBe('Unassigned');
        // No named owner: the assigned user's name.
        expect(byTitle(riskRegister, 'userOwned')?.owner).toBe('Dana Petrova');
        // A named owner wins over the assigned user.
        expect(byTitle(riskRegister, 'namedAndUser')?.owner).toBe('Risk committee');
        // An assigned user with no name reads as the e-mail's local part, never the full address.
        expect(byTitle(riskRegister, 'namelessUser')?.owner).toBe(`nameless.${SUITE}`);
    });

    it('linked controls read code first, then name; the name alone when there is no code', async () => {
        const { riskRegister } = await getReports(ctxA);
        const treated = byTitle(riskRegister, 'treated');
        // The join order is not specified by the query, so compare the set.
        expect(treated?.controls.split(', ').sort()).toEqual(
            [
                // annexId wins over `code` where a control carries both.
                'A.5.1 Policies for information security',
                'CUST-2 Quarterly access recertification',
                'Clean desk',
            ].sort(),
        );
        expect(treated?.controls).not.toMatch(/CUST-1/);
        expect(byTitle(riskRegister, 'untreated')?.controls).toBe('');
    });

    it('a soft-deleted control is not listed as mitigating a risk', async () => {
        // The register already drops a soft-deleted RISK for the reason the
        // repository states: a soft delete says the row is no longer part of
        // the register. The same holds one join down — a control in the trash
        // does not mitigate anything, and the PDF must not tell an auditor it
        // does. The join row survives a soft delete, so only the read can hold it.
        const { riskRegister } = await getReports(ctxA);
        expect(byTitle(riskRegister, 'treated')?.controls).not.toContain('A.8.20');
        expect(byTitle(riskRegister, 'treated')?.controls).not.toContain('Retired network control');
    });

    it('carries the remaining columns through unchanged', async () => {
        const { riskRegister } = await getReports(ctxA);
        expect(byTitle(riskRegister, 'treated')).toMatchObject({
            id: ids.treated, likelihood: 4, impact: 5, score: 20, targetDate: null,
        });
    });
});
