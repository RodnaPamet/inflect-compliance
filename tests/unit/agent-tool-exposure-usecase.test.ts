/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles mirroring a
 * Prisma transaction client. Per-line typing has poor cost/benefit in test
 * doubles; the file-level disable is this repo's standard for the shape. */
/**
 * Agent tool exposure — the refusals the USECASE owns.
 *
 * The route owns the permission gate and the migration owns the FK and RLS.
 * What is left here, and what neither can see:
 *
 *   1. AN UNKNOWN TOOL IS REFUSED. `toolName` is a plain String column, chosen
 *      over an enum so adding a tool is a deploy and not an `ALTER TYPE`
 *      mid-rolling-deploy. That choice moves the validation to this seam, so
 *      the seam has to actually do it — otherwise a typo produces a grant row
 *      that looks deliberate in the register and matches no tool at runtime.
 *
 *   2. THE AGENT IS RESOLVED INSIDE THE TENANT TRANSACTION, not left to the
 *      foreign key. Postgres runs FK checks as the table owner and therefore
 *      bypasses row security, so the composite FK would happily accept another
 *      tenant's agent id.
 *
 *   3. A RETIRED AGENT CANNOT BE GRANTED, BUT CAN BE REVOKED FROM. Taking
 *      authority away is never the move to refuse — the same reason the kill
 *      switch carries no precondition. A revoke path that refused on a
 *      closed-file agent would be a control that stops working exactly when
 *      somebody is trying to clean up.
 */

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(),
}));

jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn().mockResolvedValue(undefined),
}));

import {
    grantAgentTool,
    listAgentTools,
    revokeAgentTool,
} from '@/app-layer/usecases/agent-tool-exposure';
import { runInTenantContext } from '@/lib/db-context';
import { logEvent } from '@/app-layer/events/audit';
import { MCP_TOOL_NAMES } from '@/lib/mcp/tool-catalogue';
import { makeRequestContext } from '../helpers/make-context';

const mockRunInTx = runInTenantContext as jest.MockedFunction<any>;
const mockLogEvent = logEvent as jest.MockedFunction<any>;

const ctx = makeRequestContext('ADMIN', { tenantId: 'tenant-1', userId: 'user-1' });

interface DbOptions {
    /** The agent the tenant-scoped lookup resolves, or null for "not ours". */
    agent?: { id: string; status: string } | null;
    /** Rows the revoke deleteMany reports. */
    revoked?: number;
}

function makeDb(options: DbOptions = {}) {
    const upserts: any[] = [];
    const deletes: any[] = [];
    const db = {
        registeredAgent: {
            findFirst: jest.fn(async () =>
                options.agent === undefined ? { id: 'agent-1', status: 'ACTIVE' } : options.agent,
            ),
        },
        registeredAgentTool: {
            findMany: jest.fn(async () => [
                { id: 't1', toolName: 'list_risks', grantedByUserId: 'user-1', createdAt: new Date() },
            ]),
            upsert: jest.fn(async (args: any) => {
                upserts.push(args);
                return { id: 'g1', toolName: args.create.toolName, createdAt: new Date() };
            }),
            deleteMany: jest.fn(async (args: any) => {
                deletes.push(args);
                return { count: options.revoked ?? 1 };
            }),
        },
    };
    mockRunInTx.mockImplementation(async (_ctx: any, fn: any) => fn(db));
    return { db, upserts, deletes };
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('grantAgentTool', () => {
    it('refuses a tool name that is not in the catalogue', async () => {
        makeDb();
        await expect(
            grantAgentTool(ctx, 'agent-1', { toolName: 'list_everything' }),
        ).rejects.toThrow(/Unknown MCP tool/);
    });

    it('accepts every name the catalogue does list', async () => {
        // Paired positive, and over the WHOLE catalogue rather than one
        // example: a validator keyed on a stale copy of the list would refuse
        // a real tool, which is the same defect pointing the other way.
        for (const toolName of MCP_TOOL_NAMES) {
            const { upserts } = makeDb();
            await expect(grantAgentTool(ctx, 'agent-1', { toolName })).resolves.toMatchObject({
                toolName,
            });
            expect(upserts[0].create.toolName).toBe(toolName);
        }
    });

    it('refuses an agent that is not this tenant\'s', async () => {
        makeDb({ agent: null });
        await expect(
            grantAgentTool(ctx, 'someone-elses-agent', { toolName: 'list_risks' }),
        ).rejects.toThrow(/not found/i);
    });

    it('resolves the agent by (id, tenantId), not by id alone', async () => {
        // The FK cannot own this check — Postgres runs FK checks as the table
        // owner and so bypasses RLS. The `where` is the enforcement.
        const { db } = makeDb();
        await grantAgentTool(ctx, 'agent-1', { toolName: 'list_risks' });
        expect(db.registeredAgent.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({ id: 'agent-1', tenantId: 'tenant-1' }),
            }),
        );
    });

    it('refuses a RETIRED agent', async () => {
        makeDb({ agent: { id: 'agent-1', status: 'RETIRED' } });
        await expect(
            grantAgentTool(ctx, 'agent-1', { toolName: 'list_risks' }),
        ).rejects.toThrow(/retired/i);
    });

    it('allows a SUSPENDED agent — suspension is reversible, and its tool list is what you fix first', async () => {
        makeDb({ agent: { id: 'agent-1', status: 'SUSPENDED' } });
        await expect(
            grantAgentTool(ctx, 'agent-1', { toolName: 'list_risks' }),
        ).resolves.toMatchObject({ toolName: 'list_risks' });
    });

    it('writes the grant scoped to the tenant and audits it', async () => {
        const { upserts } = makeDb();
        await grantAgentTool(ctx, 'agent-1', { toolName: 'list_risks' });
        expect(upserts[0].create).toMatchObject({
            tenantId: 'tenant-1',
            agentId: 'agent-1',
            toolName: 'list_risks',
            grantedByUserId: 'user-1',
        });
        expect(mockLogEvent).toHaveBeenCalledWith(
            expect.anything(),
            ctx,
            expect.objectContaining({ action: 'AGENT_TOOL_GRANTED' }),
        );
    });
});

describe('revokeAgentTool', () => {
    it('deletes scoped to the tenant and audits it', async () => {
        const { deletes } = makeDb();
        await revokeAgentTool(ctx, 'agent-1', 'list_risks');
        expect(deletes[0].where).toMatchObject({
            tenantId: 'tenant-1',
            agentId: 'agent-1',
            toolName: 'list_risks',
        });
        expect(mockLogEvent).toHaveBeenCalledWith(
            expect.anything(),
            ctx,
            expect.objectContaining({ action: 'AGENT_TOOL_REVOKED' }),
        );
    });

    it('reports a no-op revoke rather than claiming success', async () => {
        makeDb({ revoked: 0 });
        await expect(revokeAgentTool(ctx, 'agent-1', 'list_risks')).rejects.toThrow(/not granted/i);
    });

    it('works on a RETIRED agent — taking authority away is never refused', async () => {
        const { db } = makeDb({ agent: { id: 'agent-1', status: 'RETIRED' } });
        await expect(revokeAgentTool(ctx, 'agent-1', 'list_risks')).resolves.toMatchObject({
            revoked: true,
        });
        // And it does not even look the agent up — the grantability check is
        // deliberately absent from this path.
        expect(db.registeredAgent.findFirst).not.toHaveBeenCalled();
    });
});

describe('listAgentTools', () => {
    it('returns the grants plus the catalogue a UI can offer', async () => {
        makeDb();
        const out = await listAgentTools(ctx, 'agent-1');
        expect(out.granted.map((g: any) => g.toolName)).toEqual(['list_risks']);
        expect(out.available).toEqual(MCP_TOOL_NAMES);
    });
});
