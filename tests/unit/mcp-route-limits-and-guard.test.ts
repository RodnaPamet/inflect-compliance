/**
 * `/api/mcp` — the per-key budget, the pre-authentication ceiling, and the AI
 * Guard on a read tool's arguments.
 *
 * Both behaviours are exercised through the REAL route, the REAL
 * `withApiErrorHandling` wrapper, the REAL limiter and the REAL guard (scanner,
 * mode resolution, enforcement). Mocked: authentication (it returns a chosen
 * `apiKeyId`), the tool funnel (so a refusal is visible as "never called"), the
 * guard's one database read (the tenant's mode) and the audit writer (so the
 * row the guard writes can be inspected).
 *
 * The limiter is ON in this file (`RATE_LIMIT_ENABLED=1`); jest bypasses it
 * otherwise.
 */
const originalRateLimitEnabled = process.env.RATE_LIMIT_ENABLED;
beforeAll(() => {
    process.env.RATE_LIMIT_ENABLED = '1';
});
afterAll(() => {
    if (originalRateLimitEnabled === undefined) delete process.env.RATE_LIMIT_ENABLED;
    else process.env.RATE_LIMIT_ENABLED = originalRateLimitEnabled;
});

import { strictMock } from '../helpers/strict-mock';

let mockGuardMode: string | null = 'BALANCED';
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) =>
        fn({
            tenantSecuritySettings: {
                findUnique: async () => ({ aiGuardMode: mockGuardMode }),
            },
        }),
    ),
}));
// `strictMock`: `@/lib/audit` is a guarded barrel (see partial-mock-of-a-guarded-barrel),
// so an export this path reaches and the factory omits fails loudly here.
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntry: jest.fn(async () => undefined),
    }),
);
jest.mock('@/lib/mcp/auth', () => ({ verifyMcpCredential: jest.fn(), completeMcpAuthentication: jest.fn() }));
/** Set when a read tool's own work ran, as distinct from the funnel being entered. */
let mockToolRan = 0;
jest.mock('@/lib/mcp/tools/registry', () => {
    class McpToolNotFoundError extends Error {}
    return {
        listReadToolDescriptors: jest.fn(() => []),
        // The REAL funnel's order, at its seam: an unknown name is refused
        // first, then the gate (not modelled here), then the caller's
        // `beforeRun`, and only then does the tool run. The real order inside
        // `runReadTool` is proved in `mcp-read-tool-before-run.test.ts`.
        runReadTool: jest.fn(
            async (_inv: unknown, name: string, _args: unknown, opts?: { beforeRun?: () => Promise<void> }) => {
                if (name !== 'list_risks') throw new McpToolNotFoundError(`Unknown tool: ${name}`);
                await opts?.beforeRun?.();
                mockToolRan += 1;
                return { content: [{ type: 'text', text: '{"ok":true}' }] };
            },
        ),
        McpToolNotFoundError,
    };
});
jest.mock('@/lib/mcp/tools/propose-tools', () => ({
    listProposeToolDescriptors: jest.fn(() => []),
    runProposeTool: jest.fn(async () => ({ content: [{ type: 'text', text: '{"queued":1}' }] })),
    isProposeTool: jest.fn((name: string) => name.startsWith('propose_')),
    McpProposeToolNotFoundError: class McpProposeToolNotFoundError extends Error {},
}));
jest.mock('@/lib/agentic/tool-manifest-store', () => ({
    approvedToolDescriptors: jest.fn(async (_tenantId: string, descriptors: unknown) => descriptors),
}));
jest.mock('@/lib/mcp/resources', () => ({
    listMcpResources: jest.fn(async () => []),
    readMcpResource: jest.fn(),
}));

import { NextRequest, NextResponse } from 'next/server';

import { POST } from '@/app/api/mcp/route';
import { appendAuditEntry } from '@/lib/audit';
import { withApiErrorHandling } from '@/lib/errors/api';
import { completeMcpAuthentication, verifyMcpCredential } from '@/lib/mcp/auth';
import { runReadTool } from '@/lib/mcp/tools/registry';
import { runProposeTool } from '@/lib/mcp/tools/propose-tools';
import {
    clearAllRateLimits,
    MCP_IP_CEILING_LIMIT,
    MCP_PER_KEY_LIMIT,
} from '@/lib/security/rate-limit-middleware';

const mockVerify = verifyMcpCredential as jest.Mock;
const mockComplete = completeMcpAuthentication as jest.Mock;
const mockRead = runReadTool as jest.Mock;
const mockPropose = runProposeTool as jest.Mock;
const mockAudit = appendAuditEntry as jest.Mock;

const HOSTED_EGRESS_IP = '203.0.113.7';

function authenticateAs(apiKeyId: string | undefined): void {
    const ctx = {
        requestId: 'req-test',
        tenantId: 'tenant-1',
        userId: 'user-1',
        role: 'EDITOR',
        apiKeyId,
        permissions: {},
        appPermissions: {},
    };
    // Step one hands back the verified key; step two, the invocation. Only
    // step two does the expensive work, so a call to it is "work was done".
    mockVerify.mockResolvedValue({ keyCtx: ctx, audience: null, tokenExpiresAt: null, now: () => new Date(), surface: {} });
    mockComplete.mockResolvedValue({ ctx, invocation: { ctx } });
}

function toolCall(id: number, name = 'list_risks', args: Record<string, unknown> = {}) {
    return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

function post(body: unknown, ip = HOSTED_EGRESS_IP): NextRequest {
    return postRaw(JSON.stringify(body), ip);
}

function postRaw(text: string, ip = HOSTED_EGRESS_IP): NextRequest {
    return new NextRequest('http://localhost/api/mcp', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-forwarded-for': ip,
            authorization: 'Bearer iflk_test',
        },
        body: text,
    });
}

/** Spend `n` messages of `apiKeyId`'s budget, one request each, asserting each passes. */
async function spend(apiKeyId: string, n: number, ip = HOSTED_EGRESS_IP): Promise<void> {
    authenticateAs(apiKeyId);
    for (let i = 0; i < n; i += 1) {
        const res = await POST(post(toolCall(i)), {});
        expect(res.status).toBe(200);
    }
}

beforeEach(() => {
    clearAllRateLimits();
    jest.clearAllMocks();
    mockGuardMode = 'BALANCED';
    mockToolRan = 0;
});

describe('/api/mcp — the per-key budget', () => {
    it('gives a key its budget, then refuses the next message with a 429 that names no key', async () => {
        await spend('key-a', MCP_PER_KEY_LIMIT.maxAttempts);

        const res = await POST(post(toolCall(999)), {});
        expect(res.status).toBe(429);
        expect(res.headers.get('Retry-After')).toMatch(/^\d+$/);
        const body = await res.json();
        expect(body.error.code).toBe('RATE_LIMITED');
        expect(body.error.scope).toBe('mcp-api-key');
        expect(JSON.stringify(body)).not.toContain('key-a');
    });

    it('does not make two keys behind one address share a budget — the hosted-provider case', async () => {
        await spend('key-a', MCP_PER_KEY_LIMIT.maxAttempts);

        authenticateAs('key-b');
        const res = await POST(post(toolCall(1)), {});
        expect(res.status).toBe(200);
    });

    it('gives one key ONE budget however many addresses it calls from', async () => {
        authenticateAs('key-a');
        for (let i = 0; i < MCP_PER_KEY_LIMIT.maxAttempts; i += 1) {
            const res = await POST(post(toolCall(i), `198.51.100.${i % 200}`), {});
            expect(res.status).toBe(200);
        }
        const res = await POST(post(toolCall(999), '192.0.2.250'), {});
        expect(res.status).toBe(429);
    });

    it('charges a batch per message, all or nothing', async () => {
        const remaining = 5;
        await spend('key-a', MCP_PER_KEY_LIMIT.maxAttempts - remaining);
        mockRead.mockClear();

        // One more message than is left: refused whole, and nothing ran.
        const tooMany = Array.from({ length: remaining + 1 }, (_, i) => toolCall(i));
        const refused = await POST(post(tooMany), {});
        expect(refused.status).toBe(429);
        expect(refused.headers.get('X-RateLimit-Remaining')).toBe(String(remaining));
        expect(mockRead).not.toHaveBeenCalled();

        // The refusal spent nothing: exactly what was left still fits.
        const exact = Array.from({ length: remaining }, (_, i) => toolCall(i));
        const accepted = await POST(post(exact), {});
        expect(accepted.status).toBe(200);
        expect(mockRead).toHaveBeenCalledTimes(remaining);
    });

    it('refuses a batch larger than the whole budget as a malformed request', async () => {
        authenticateAs('key-a');
        const oversized = Array.from({ length: MCP_PER_KEY_LIMIT.maxAttempts + 1 }, (_, i) => toolCall(i));

        const res = await POST(post(oversized), {});
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error.message).toMatch(/per minute per API key/);
        expect(mockRead).not.toHaveBeenCalled();
    });

    // ── Charged before the work (#4205) ─────────────────────────────────
    //
    // Building the invocation is the expensive half of authentication: it
    // sends a live `tools/list` to every external connection the agent has
    // grants on. `mockComplete` stands for that work.

    it('refuses a key over its budget before the invocation is built', async () => {
        await spend('key-a', MCP_PER_KEY_LIMIT.maxAttempts);
        mockComplete.mockClear();

        const res = await POST(post(toolCall(999)), {});
        expect(res.status).toBe(429);
        expect(mockComplete).not.toHaveBeenCalled();
    });

    it('charges an invalid-JSON body one unit, and builds nothing for it', async () => {
        await spend('key-a', MCP_PER_KEY_LIMIT.maxAttempts - 1);
        mockComplete.mockClear();

        const malformed = await POST(postRaw('{'), {});
        expect(malformed.status).toBe(400);
        expect((await malformed.json()).error.code).toBe(-32700);
        expect(mockComplete).not.toHaveBeenCalled();

        // It took the last unit, so the next good request is refused.
        expect((await POST(post(toolCall(1)), {})).status).toBe(429);
    });

    it('charges an oversized batch one unit, and builds nothing for it', async () => {
        await spend('key-a', MCP_PER_KEY_LIMIT.maxAttempts - 1);
        mockComplete.mockClear();
        const oversized = Array.from({ length: MCP_PER_KEY_LIMIT.maxAttempts + 1 }, (_, i) => toolCall(i));

        expect((await POST(post(oversized), {})).status).toBe(400);
        expect(mockComplete).not.toHaveBeenCalled();
        expect((await POST(post(toolCall(1)), {})).status).toBe(429);
    });

    it('answers an empty batch with one Invalid Request error, charged one unit', async () => {
        await spend('key-a', MCP_PER_KEY_LIMIT.maxAttempts - 1);
        mockComplete.mockClear();

        const res = await POST(post([]), {});
        expect(res.status).toBe(400);
        const body = await res.json();
        // JSON-RPC 2.0: a single Response object, not an array.
        expect(Array.isArray(body)).toBe(false);
        expect(body.error.code).toBe(-32600);
        expect(mockComplete).not.toHaveBeenCalled();
        expect((await POST(post(toolCall(1)), {})).status).toBe(429);
    });

    it('fails closed when an authenticated invocation carries no key id', async () => {
        authenticateAs(undefined);
        const res = await POST(post(toolCall(1)), {});
        expect(res.status).toBe(401);
        expect(mockRead).not.toHaveBeenCalled();
    });

    it('is switched off with the rest of the limiter by RATE_LIMIT_ENABLED=0', async () => {
        process.env.RATE_LIMIT_ENABLED = '0';
        try {
            await spend('key-a', MCP_PER_KEY_LIMIT.maxAttempts + 1);
        } finally {
            process.env.RATE_LIMIT_ENABLED = '1';
        }
    });
});

describe('/api/mcp — the pre-authentication ceiling', () => {
    it('bounds one address across every key, in its own scope', async () => {
        // Distinct keys, so no per-key budget is ever reached: what refuses the
        // last request can only be the address ceiling.
        for (let i = 0; i < MCP_IP_CEILING_LIMIT.maxAttempts; i += 1) {
            authenticateAs(`key-${i}`);
            const res = await POST(post(toolCall(i)), {});
            expect(res.status).toBe(200);
        }
        authenticateAs('key-fresh');
        const res = await POST(post(toolCall(1)), {});
        expect(res.status).toBe(429);
        expect((await res.json()).error.scope).toBe('mcp-ip');
    });

    it('no longer draws on the mutation bucket every other route from that address shares', async () => {
        // Past the mutation tier's 60 from one address — which, before this
        // change, would have exhausted the shared `api-mutation` bucket.
        for (let i = 0; i < 70; i += 1) {
            authenticateAs(`key-${i}`);
            expect((await POST(post(toolCall(i)), {})).status).toBe(200);
        }

        const otherRoute = withApiErrorHandling(async () => NextResponse.json({ ok: true }));
        const res = await otherRoute(
            new NextRequest('http://localhost/api/other', {
                method: 'POST',
                headers: { 'x-forwarded-for': HOSTED_EGRESS_IP },
            }),
            {},
        );
        expect(res.status).toBe(200);
    });
});

describe('/api/mcp — the AI Guard on a read tool’s arguments', () => {
    // AWS's own published documentation placeholder — the egress scanner's
    // high-severity `egr.api_key.aws_access_key` rule matches its shape.
    const AWS_DOC_PLACEHOLDER = 'AKIAIOSFODNN7EXAMPLE'; // pragma: allowlist secret — AWS's own published documentation placeholder (docs.aws.amazon.com), not a credential. The point of this test is that the guard refuses it as a tool argument.
    // A medium-severity shape (`egr.api_key.generic_assignment`): suspicious,
    // not malicious, so the tenant's mode decides between refusing and recording.
    const SUSPICIOUS_ASSIGNMENT = 'api_key=Q7f2Lm9Xc4Tz8Rw1';

    async function callRead(args: Record<string, unknown>) {
        authenticateAs('key-a');
        const res = await POST(post(toolCall(1, 'list_risks', args)), {});
        expect(res.status).toBe(200); // tool errors are in-band JSON-RPC errors
        return res.json();
    }

    it('lets clean arguments through to the tool and writes no guard row', async () => {
        const body = await callRead({ status: 'OPEN' });
        expect(body.result).toBeDefined();
        expect(mockToolRan).toBe(1);
        expect(mockAudit).not.toHaveBeenCalled();
    });

    it('refuses a secret in the arguments before the tool runs, and audits rule ids only', async () => {
        const body = await callRead({ query: `find ${AWS_DOC_PLACEHOLDER}` });

        expect(body.error.message).toMatch(/^ai_guard_blocked: /);
        expect(mockToolRan).toBe(0);

        expect(mockAudit).toHaveBeenCalledTimes(1);
        const entry = mockAudit.mock.calls[0][0];
        expect(entry.action).toBe('AI_GUARD_EGRESS_BLOCKED');
        expect(entry.entityId).toBe('mcp-tool-args:list_risks');
        expect(entry.actorType).toBe('API_KEY');
        expect(JSON.stringify(entry)).toContain('egr.api_key.aws_access_key');
        expect(JSON.stringify(entry)).not.toContain(AWS_DOC_PLACEHOLDER);
    });

    it('does not tell the caller which rule fired (#4205)', async () => {
        // The audit row keeps the rule ids. The caller, who may be a
        // prompt-injected agent retrying to tune a payload, gets the verdict.
        const blocked = await callRead({ query: `find ${AWS_DOC_PLACEHOLDER}` });
        const flagged = await callRead({ query: SUSPICIOUS_ASSIGNMENT });
        for (const body of [blocked, flagged]) {
            expect(body.error.message).not.toMatch(/egr\.|\[/);
        }
    });

    it('refuses a flagged argument too, under the default balanced mode', async () => {
        const body = await callRead({ query: SUSPICIOUS_ASSIGNMENT });

        expect(body.error.message).toMatch(/^ai_guard_review_required: /);
        expect(mockToolRan).toBe(0);
        expect(mockAudit.mock.calls[0][0].action).toBe('AI_GUARD_EGRESS_FLAGGED');
    });

    it('records but does not refuse when the tenant runs the guard in audit mode', async () => {
        mockGuardMode = 'AUDIT';
        const body = await callRead({ query: SUSPICIOUS_ASSIGNMENT });

        expect(body.result).toBeDefined();
        expect(mockToolRan).toBe(1);
        expect(mockAudit).toHaveBeenCalledTimes(1);
    });

    it('answers an unknown tool with MethodNotFound before scanning anything (#4205)', async () => {
        // The guard used to run first, so a made-up name with secret-shaped
        // arguments wrote a guard row whose source was the caller's own text.
        authenticateAs('key-a');
        const madeUp = 'x'.repeat(10_000);
        const res = await POST(post(toolCall(1, madeUp, { query: AWS_DOC_PLACEHOLDER })), {});
        const body = await res.json();

        expect(body.error.code).toBe(-32601);
        expect(mockAudit).not.toHaveBeenCalled();
    });

    it('leaves a propose call to the proposal queue, which scans and quarantines it itself', async () => {
        authenticateAs('key-a');
        const res = await POST(
            post(toolCall(1, 'propose_risks', { items: [{ title: AWS_DOC_PLACEHOLDER }] })),
            {},
        );
        const body = await res.json();

        expect(body.result).toBeDefined();
        expect(mockPropose).toHaveBeenCalledTimes(1);
        expect(mockAudit).not.toHaveBeenCalled();
    });
});
