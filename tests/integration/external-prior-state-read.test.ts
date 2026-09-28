/**
 * Nominating the READ that runs before a WRITE (#2861).
 *
 * Four validations, none of them expressible as a database constraint, which is
 * why they live in the usecase and why they are tested here rather than inferred
 * from the schema. Two are hygiene; two would do real harm if they were missing:
 *
 *   · a read on a DIFFERENT connection describes a different system, and the
 *     journal would present that as the authoritative prior state;
 *   · a WRITE nominated as the prior-state read sends two changes per dispatch,
 *     the first of them unjournalled and unasked-for.
 */
import { PrismaClient } from '@prisma/client';

const listExternalMcpToolsMock = jest.fn();
jest.mock('@/app-layer/usecases/external-mcp-tools', () => ({
    listExternalMcpTools: (...a: unknown[]) => listExternalMcpToolsMock(...a),
}));

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import {
    setPriorStateRead,
    getPriorStateRead,
    clearPriorStateRead,
    listPriorStateReads,
} from '@/app-layer/usecases/external-prior-state-read';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(60_000);

const T = 'epsr-tenant';
const CONN = 'cmconnaaaaaaaaaaaaaaaaaa';
const OTHER_CONN = 'cmconnbbbbbbbbbbbbbbbbbb';
const WRITE = `mcp__${CONN}__set_employee_email`;
const READ = `mcp__${CONN}__get_employee_contact`;

let ctx: ReturnType<typeof makeRequestContext>;

/** The catalogue the setter validates against. */
const catalogue = (over: Partial<Record<string, boolean>> = {}) => ({
    connectionId: CONN,
    advertised: 2,
    truncated: false,
    tools: [
        {
            toolName: WRITE,
            advertisedName: 'set_employee_email',
            connectionId: CONN,
            declaresWrite: over[WRITE] ?? true,
        },
        {
            toolName: READ,
            advertisedName: 'get_employee_contact',
            connectionId: CONN,
            declaresWrite: over[READ] ?? false,
        },
    ],
});

beforeAll(async () => {
    await resetDatabase(prisma);
    await prisma.externalToolPriorStateRead.deleteMany({ where: { tenantId: T } });
    await deleteAuditRowsForTenants(prisma, [T]);
    await prisma.tenant.deleteMany({ where: { id: T } });

    await prisma.tenant.create({ data: { id: T, name: T, slug: T } });
    const email = `owner@${T}.test`;
    const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    ctx = makeRequestContext('OWNER', { tenantId: T, userId: user.id });
});

afterAll(async () => {
    await prisma.externalToolPriorStateRead.deleteMany({ where: { tenantId: T } });
    await deleteAuditRowsForTenants(prisma, [T]);
    await prisma.tenant.deleteMany({ where: { id: T } });
    await prisma.$disconnect();
});

beforeEach(async () => {
    await prisma.externalToolPriorStateRead.deleteMany({ where: { tenantId: T } });
    // The audit chain is append-only and accumulates across tests, so "exactly
    // one row" below is a claim about THIS test rather than about the suite.
    await deleteAuditRowsForTenants(prisma, [T]);
    listExternalMcpToolsMock.mockReset();
    listExternalMcpToolsMock.mockResolvedValue(catalogue());
});

describe('a valid pairing', () => {
    it('is stored and readable by the dispatch', async () => {
        await setPriorStateRead(ctx, { writeToolName: WRITE, readToolName: READ });
        await expect(getPriorStateRead(ctx, WRITE)).resolves.toEqual({
            writeToolName: WRITE,
            readToolName: READ,
        });
    });

    it('is one per write — re-nominating REPLACES rather than adding', async () => {
        const second = `mcp__${CONN}__get_employee_job`;
        await setPriorStateRead(ctx, { writeToolName: WRITE, readToolName: READ });
        listExternalMcpToolsMock.mockResolvedValue({
            ...catalogue(),
            tools: [
                ...catalogue().tools,
                { toolName: second, advertisedName: 'get_employee_job', connectionId: CONN, declaresWrite: false },
            ],
        });
        await setPriorStateRead(ctx, { writeToolName: WRITE, readToolName: second });

        const all = await listPriorStateReads(ctx, CONN);
        expect(all).toHaveLength(1);
        expect(all[0].readToolName).toBe(second);
    });

    it('is audited as an ACCESS event', async () => {
        await setPriorStateRead(ctx, { writeToolName: WRITE, readToolName: READ });
        const rows = await prisma.auditLog.findMany({
            where: { tenantId: T, action: 'EXTERNAL_PRIOR_STATE_READ_SET' },
            select: { detailsJson: true },
        });
        expect(rows).toHaveLength(1);
        // `access`, not `configuration`: this decides what is called against a
        // customer's system immediately before it is changed.
        expect((rows[0].detailsJson as Record<string, unknown>).category).toBe('access');
    });
});

describe('what the setter refuses', () => {
    it('a read on a DIFFERENT connection', async () => {
        // The harm: prior state captured from another system entirely, presented
        // by the journal as authoritative.
        await expect(
            setPriorStateRead(ctx, {
                writeToolName: WRITE,
                readToolName: `mcp__${OTHER_CONN}__get_employee_contact`,
            }),
        ).rejects.toThrow(/same connection/);
        expect(listExternalMcpToolsMock).not.toHaveBeenCalled();
    });

    it('a WRITE nominated as the prior-state read', async () => {
        // The one that matters most: this would send TWO changes per dispatch,
        // the first unjournalled and unasked-for.
        listExternalMcpToolsMock.mockResolvedValue(catalogue({ [READ]: true }));
        await expect(
            setPriorStateRead(ctx, { writeToolName: WRITE, readToolName: READ }),
        ).rejects.toThrow(/two changes per call/);
    });

    it('a write tool that is actually declared read-only', async () => {
        listExternalMcpToolsMock.mockResolvedValue(catalogue({ [WRITE]: false }));
        await expect(
            setPriorStateRead(ctx, { writeToolName: WRITE, readToolName: READ }),
        ).rejects.toThrow(/declared read-only, so it has no prior state/);
    });

    it('a built-in tool on either side', async () => {
        await expect(
            setPriorStateRead(ctx, { writeToolName: 'list_risks', readToolName: READ }),
        ).rejects.toThrow(/must be external MCP tools/);
    });

    it('a tool the server does not advertise', async () => {
        await expect(
            setPriorStateRead(ctx, { writeToolName: WRITE, readToolName: `mcp__${CONN}__ghost` }),
        ).rejects.toThrow(/does not advertise both/);
    });

    it('and NOTHING is stored by any of those', async () => {
        // Performed HERE rather than relying on the tests above. `beforeEach`
        // clears the table, so a bare read at this point starts empty and would
        // pass however those refusals behaved — an assertion satisfied by its own
        // setup rather than by the code under test.
        const attempts = [
            { writeToolName: WRITE, readToolName: `mcp__${OTHER_CONN}__get_employee_contact` },
            { writeToolName: 'list_risks', readToolName: READ },
            { writeToolName: WRITE, readToolName: `mcp__${CONN}__ghost` },
        ];
        for (const a of attempts) {
            await expect(setPriorStateRead(ctx, a)).rejects.toThrow();
        }
        listExternalMcpToolsMock.mockResolvedValue(catalogue({ [READ]: true }));
        await expect(
            setPriorStateRead(ctx, { writeToolName: WRITE, readToolName: READ }),
        ).rejects.toThrow();

        // Four refusals, and the table is still empty. A refusal that wrote the
        // row anyway would pass every `rejects.toThrow` above and only fail here.
        expect(await listPriorStateReads(ctx, CONN)).toEqual([]);
    });
});

describe('clearing a pairing', () => {
    it('makes the write undispatchable again', async () => {
        await setPriorStateRead(ctx, { writeToolName: WRITE, readToolName: READ });
        await clearPriorStateRead(ctx, WRITE);
        await expect(getPriorStateRead(ctx, WRITE)).resolves.toBeNull();
    });

    it('is never gated — a narrowing does not have to prove anything', async () => {
        // Clearing removes an authority, so it takes no catalogue call and no
        // validation. An operator withdrawing something must not be told to wait.
        await clearPriorStateRead(ctx, WRITE);
        expect(listExternalMcpToolsMock).not.toHaveBeenCalled();
    });
});
