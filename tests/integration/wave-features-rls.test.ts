/**
 * GAP-1 — two-tenant behavioural isolation for the 10-PR-wave features.
 *
 * The unit tests for these usecases mock `runInTenantContext`
 * (e.g. tests/unit/questionnaire.test.ts), so they never exercise the actual
 * RLS + tenantId scoping. These drive the REAL usecases against a live Postgres
 * under two tenant contexts and assert a tenant-B caller sees only B's rows and
 * cannot reach A's. Cloned from the resetDatabase + createTenant +
 * buildRequestContext pattern (tests/integration/task-key-sequence.test.ts).
 */
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient, resetDatabase } from '../helpers/db';
import { createTenant, createUser, buildRequestContext } from '../helpers/factories';
import { getPermissionsForRole } from '@/lib/permissions';

import { uploadQuestionnaire, listQuestionnaires, autofillQuestionnaire } from '@/app-layer/usecases/questionnaire';
import { reportDevice, listDevices } from '@/app-layer/usecases/device';
import { createEmployee, listEmployees } from '@/app-layer/usecases/personnel';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('Two-tenant isolation — 10-PR-wave features (GAP-1)', () => {
    const prisma = prismaTestClient() as PrismaClient;
    afterAll(async () => { await prisma.$disconnect(); });
    beforeEach(async () => { await resetDatabase(prisma); });

    async function twoTenants() {
        const tA = await createTenant(prisma, { id: randomUUID(), slug: `a-${randomUUID().slice(0, 8)}` });
        const tB = await createTenant(prisma, { id: randomUUID(), slug: `b-${randomUUID().slice(0, 8)}` });
        const uA = await createUser(prisma, { id: randomUUID(), email: `${randomUUID()}@t.local` });
        const uB = await createUser(prisma, { id: randomUUID(), email: `${randomUUID()}@t.local` });
        // `appPermissions` as a real ADMIN context carries it: the roster and
        // device reads assert `personnel.view` themselves.
        const appPermissions = getPermissionsForRole('ADMIN');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ctxA = buildRequestContext({ tenantId: tA.id, userId: uA.id, appPermissions }) as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ctxB = buildRequestContext({ tenantId: tB.id, userId: uB.id, appPermissions }) as any;
        return { tA, tB, ctxA, ctxB };
    }

    it('questionnaire: tenant B lists only its own', async () => {
        const { ctxA, ctxB } = await twoTenants();
        await uploadQuestionnaire(ctxA, { name: 'A-questionnaire', questions: ['a?'] });
        await uploadQuestionnaire(ctxB, { name: 'B-questionnaire', questions: ['b?'] });
        const listB = await listQuestionnaires(ctxB);
        expect(listB.map((q) => q.name)).toEqual(['B-questionnaire']);
    });

    it('questionnaire: a tenant-B caller cannot autofill tenant-A\'s questionnaire', async () => {
        const { ctxA, ctxB } = await twoTenants();
        const a = await uploadQuestionnaire(ctxA, { name: 'A-only', questions: ['a?'] });
        // B references A's questionnaire id — the tenant-scoped lookup misses it.
        await expect(autofillQuestionnaire(ctxB, a.questionnaireId)).rejects.toThrow(/not found/i);
    });

    it('devices: tenant B lists only its own', async () => {
        const { tA, tB, ctxB } = await twoTenants();
        await reportDevice(tA.id, { serialNumber: 'A-SN', platform: 'MACOS' });
        await reportDevice(tB.id, { serialNumber: 'B-SN', platform: 'MACOS' });
        const listB = await listDevices(ctxB);
        expect(listB.map((d) => d.serialNumber)).toEqual(['B-SN']);
    });

    it('personnel: tenant B lists only its own', async () => {
        const { ctxA, ctxB } = await twoTenants();
        await createEmployee(ctxA, { fullName: 'A Emp', workEmail: 'a@emp.local', status: 'ACTIVE' });
        await createEmployee(ctxB, { fullName: 'B Emp', workEmail: 'b@emp.local', status: 'ACTIVE' });
        const listB = await listEmployees(ctxB);
        expect(listB.map((e) => e.workEmail)).toEqual(['b@emp.local']);
    });
});
