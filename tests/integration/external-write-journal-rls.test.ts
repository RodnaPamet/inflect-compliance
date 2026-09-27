/**
 * `ExternalWriteJournal` — RLS behaviour, the outlives-the-connection contract,
 * and that the encrypted columns are actually ciphertext at rest.
 *
 * The structural guardrail certifies the policies EXIST. This is conduct: it
 * drives the table under two tenant contexts and asserts what a tenant-B caller
 * can actually do.
 *
 * The stakes here are higher than the identity journal's, which is why this suite
 * asserts one thing that one does not. That table holds directory flags —
 * `accountEnabled`, group names. This one holds whatever an ARBITRARY third-party
 * system returned for the object being changed, and the first writable far end is
 * an HRIS, where the prior state of a contact-details record is a person's work
 * email, personal email and phone numbers. A cross-tenant read here is one
 * customer reading another customer's employees' contact details.
 */
import { PrismaClient } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(60_000);

const T1 = 'ewj-tenant-one';
const T2 = 'ewj-tenant-two';

async function asTenant<T>(tenantId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
        return fn(tx as unknown as PrismaClient);
    });
}

/**
 * `resetDatabase` truncates a fixed table list that includes none of these, so
 * this suite clears its own rows — otherwise it passes exactly once on a fresh
 * database and fails every re-run, and CI always starts clean, which is what
 * would hide it.
 */
async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: [T1, T2] } };
    await prisma.externalWriteJournal.deleteMany({ where: t });
    await prisma.integrationConnection.deleteMany({ where: t });
    await prisma.tenant.deleteMany({ where: { id: { in: [T1, T2] } } });
}

const seeded: Record<string, { connectionId: string; journalId: string }> = {};

/** The shape an HRIS contact-details read actually returns. */
const priorStateFor = (t: string) =>
    JSON.stringify({ workEmail: `worker@${t}.test`, personalEmail: `private@${t}.test`, mobile: '+359 88 000 0000' });

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();

    for (const id of [T1, T2]) {
        await prisma.tenant.create({ data: { id, name: id, slug: id } });
        const connection = await prisma.integrationConnection.create({
            data: {
                tenantId: id,
                provider: 'mcp-server',
                name: `hrm-${id}`,
                configJson: { url: 'https://hrm-mcp.example.test/mcp' },
                externalWriteMode: 'AUTOMATIC',
            },
        });
        const journal = await prisma.externalWriteJournal.create({
            data: {
                tenantId: id,
                connectionId: connection.id,
                connectionName: `hrm-${id}`,
                endpointUrl: 'https://hrm-mcp.example.test/mcp',
                toolName: `mcp__${connection.id}__orangehrm_set_employee_work_email`,
                advertisedToolName: 'orangehrm_set_employee_work_email',
                mode: 'AUTOMATIC',
                argumentsJson: JSON.stringify({ employeeNumber: '7', workEmail: `new@${id}.test` }),
                priorStateJson: priorStateFor(id),
                outcome: 'APPLIED',
            },
        });
        seeded[id] = { connectionId: connection.id, journalId: journal.id };
    }
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('a tenant sees only its own journal', () => {
    it('BOTH rows really exist — otherwise every assertion below is vacuous', async () => {
        const all = await prisma.externalWriteJournal.findMany({
            where: { tenantId: { in: [T1, T2] } },
            select: { tenantId: true },
        });
        expect(all.map((r) => r.tenantId).sort()).toEqual([T1, T2]);
    });

    it('each tenant reads exactly its own', async () => {
        for (const t of [T1, T2]) {
            const rows = await asTenant(t, (tx) => tx.externalWriteJournal.findMany({ select: { tenantId: true } }));
            expect(rows).toHaveLength(1);
            expect(rows[0].tenantId).toBe(t);
        }
    });

    it("naming the OTHER tenant's row by id returns nothing", async () => {
        const row = await asTenant(T1, (tx) =>
            tx.externalWriteJournal.findFirst({ where: { id: seeded[T2].journalId } }),
        );
        expect(row).toBeNull();
    });

    it('the captured prior state does not leak across the boundary', async () => {
        // The specific harm: this column holds another customer's employees'
        // contact details, not a directory flag.
        const rows = await asTenant(T1, (tx) =>
            tx.externalWriteJournal.findMany({ select: { priorStateJson: true } }),
        );
        const seen = rows.map((r) => r.priorStateJson).join(' ');
        expect(seen).toContain(`worker@${T1}.test`);
        expect(seen).not.toContain(`worker@${T2}.test`);
        expect(seen).not.toContain(`private@${T2}.test`);
    });

    it('INSERT with a foreign tenantId is refused', async () => {
        await expect(
            asTenant(T1, (tx) =>
                tx.externalWriteJournal.create({
                    data: {
                        tenantId: T2,
                        connectionName: 'smuggled',
                        endpointUrl: 'https://x.test',
                        toolName: 'mcp__x__y',
                        advertisedToolName: 'y',
                        mode: 'AUTOMATIC',
                        argumentsJson: '{}',
                        priorStateJson: '{}',
                    },
                }),
            ),
        ).rejects.toThrow();
    });

    it("UPDATE of the other tenant's row changes nothing", async () => {
        // An RLS-filtered UPDATE removes zero rows and SUCCEEDS, so the row is
        // what must be asserted — never `rejects.toThrow()`.
        const res = await asTenant(T1, (tx) =>
            tx.externalWriteJournal.updateMany({
                where: { id: seeded[T2].journalId },
                data: { outcome: 'FAILED' },
            }),
        );
        expect(res.count).toBe(0);
        const untouched = await prisma.externalWriteJournal.findUnique({
            where: { id: seeded[T2].journalId },
            select: { outcome: true },
        });
        expect(untouched?.outcome).toBe('APPLIED');
    });

    it('cannot reassign its OWN row to another tenant', async () => {
        await expect(
            asTenant(T1, (tx) =>
                tx.externalWriteJournal.update({
                    where: { id: seeded[T1].journalId },
                    data: { tenantId: T2 },
                }),
            ),
        ).rejects.toThrow();
    });
});

describe('the journal OUTLIVES the connection', () => {
    it('deleting the connection leaves the row, with connectionId nulled', async () => {
        // `ON DELETE SET NULL`, not CASCADE. Deleting an integration must not
        // erase the record that we changed somebody's system through it — that
        // record is usually the evidence being asked for, and the denormalised
        // name and endpoint are what keep it readable afterwards.
        const t = 'ewj-outlives';
        await prisma.tenant.create({ data: { id: t, name: t, slug: t } });
        const conn = await prisma.integrationConnection.create({
            data: { tenantId: t, provider: 'mcp-server', name: 'doomed', configJson: {} },
        });
        const row = await prisma.externalWriteJournal.create({
            data: {
                tenantId: t,
                connectionId: conn.id,
                connectionName: 'doomed',
                endpointUrl: 'https://gone.test/mcp',
                toolName: `mcp__${conn.id}__t`,
                advertisedToolName: 't',
                mode: 'DRY_RUN',
                argumentsJson: '{}',
                priorStateJson: '{"a":1}',
                outcome: 'RECORDED_ONLY',
            },
        });

        await prisma.integrationConnection.delete({ where: { id: conn.id } });

        const after = await prisma.externalWriteJournal.findUnique({ where: { id: row.id } });
        expect(after).not.toBeNull();
        expect(after?.connectionId).toBeNull();
        // …and it still says what it wrote to, which is the whole point of
        // denormalising these two.
        expect(after?.connectionName).toBe('doomed');
        expect(after?.endpointUrl).toBe('https://gone.test/mcp');

        await prisma.externalWriteJournal.deleteMany({ where: { tenantId: t } });
        await prisma.tenant.delete({ where: { id: t } });
    });
});

describe('the encrypted columns are ciphertext AT REST', () => {
    /**
     * The assertion the identity journal cannot make, because its prior state is
     * deliberately unencrypted.
     *
     * `ENCRYPTED_FIELDS` declaring a column proves nothing on its own — the
     * middleware has to be composed onto the client that wrote the row. So this
     * reads the raw bytes with `$queryRawUnsafe`, which bypasses the extension,
     * and asserts the plaintext is NOT there. A manifest entry that was never
     * wired would pass every test above and fail only this one.
     */
    it('the raw row does not contain the plaintext the encrypting client returns', async () => {
        // WRITTEN THROUGH AN ENCRYPTING CLIENT, not `prismaTestClient()`.
        //
        // The first version of this test wrote through the shared helper and
        // found plaintext at rest, which looked like the manifest entry being
        // declared and never wired. It was not: `prismaTestClient` composes
        // `withPiiEncryptionExtension` ONLY — the *Hash columns — and not
        // `withEncryptionExtension`, which is what `src/lib/prisma.ts` composes
        // for field encryption. So the assertion was about the test helper rather
        // than about production, and a test that cannot tell those apart is worth
        // less than no test.
        //
        // Composing the real extension here is what makes the claim production's:
        // manifest entry + extension = ciphertext at rest.
        const { PrismaPg } = require('@prisma/adapter-pg');
        const { PrismaClient: Raw } = require('@prisma/client');
        const { withEncryptionExtension } = require('../../src/lib/db/encryption-middleware');
        const { getTestDatabaseUrl } = require('../helpers/db');
        const enc = withEncryptionExtension(
            new Raw({ adapter: new PrismaPg({ connectionString: getTestDatabaseUrl() }) }),
        );

        const conn = await prisma.integrationConnection.findFirstOrThrow({ where: { tenantId: T1 } });
        const written = await enc.externalWriteJournal.create({
            data: {
                tenantId: T1,
                connectionId: conn.id,
                connectionName: 'enc-probe',
                endpointUrl: 'https://enc.test/mcp',
                toolName: `mcp__${conn.id}__probe`,
                advertisedToolName: 'probe',
                mode: 'AUTOMATIC',
                argumentsJson: JSON.stringify({ workEmail: `secret-args@${T1}.test` }),
                priorStateJson: JSON.stringify({ personalEmail: `secret-prior@${T1}.test` }),
                outcome: 'APPLIED',
            },
        });

        // Positive control: read back THROUGH the extension and the plaintext is
        // there, so the absence below is about storage rather than about a row
        // that never held it.
        const viaClient = await enc.externalWriteJournal.findUnique({
            where: { id: written.id },
            select: { priorStateJson: true, argumentsJson: true },
        });
        expect(viaClient?.priorStateJson).toContain(`secret-prior@${T1}.test`);
        expect(viaClient?.argumentsJson).toContain(`secret-args@${T1}.test`);

        // The bytes. `$queryRawUnsafe` bypasses the extension.
        const [raw] = await prisma.$queryRawUnsafe<Array<{ priorStateJson: string; argumentsJson: string }>>(
            `SELECT "priorStateJson", "argumentsJson" FROM "ExternalWriteJournal" WHERE id = $1`,
            written.id,
        );
        expect(raw.priorStateJson).not.toContain(`secret-prior@${T1}.test`);
        expect(raw.argumentsJson).not.toContain(`secret-args@${T1}.test`);
        // …and it is the envelope shape, not merely mangled.
        expect(raw.priorStateJson).toMatch(/^v[12]:/);

        await prisma.externalWriteJournal.delete({ where: { id: written.id } });
        await enc.$disconnect();
    });
});
