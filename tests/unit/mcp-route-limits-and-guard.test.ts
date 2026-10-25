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
jest.mock('@/lib/mcp/auth', () => ({
    authenticateMcpCredential: jest.fn(),
    buildInvocationForCredential: jest.fn(),
}));
jest.mock('@/lib/mcp/tools/registry', () => ({
    listReadToolDescriptors: jest.fn(() => []),
    // EMULATES THE REAL ORDER, which is the whole point of #4205: resolve the
    // name, run the gate, THEN `afterAuthorize`, then execute. A mock that
    // ignored the hook would make every guard assertion below vacuous — the
    // route would wire a scan nothing ever called, and the suite would be green.
    //
    // `toolExecution.ran` stands in for step 3. It is read LAZILY from inside
    // this factory, which Jest hoists above every declaration, so a ref object
    // keeps it out of the temporal dead zone.
    runReadTool: jest.fn(
        async (
            _inv: unknown,
            _name: string,
            _args: unknown,
            options?: { afterAuthorize?: () => Promise<void> },
        ) => {
            await options?.afterAuthorize?.();
            toolExecution.ran += 1;
            return { content: [{ type: 'text', text: '{"ok":true}' }] };
        },
    ),
    McpToolNotFoundError: class McpToolNotFoundError extends Error {},
}));
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
import { authenticateMcpCredential, buildInvocationForCredential } from '@/lib/mcp/auth';
import { runReadTool } from '@/lib/mcp/tools/registry';
import { runProposeTool } from '@/lib/mcp/tools/propose-tools';
import {
    clearAllRateLimits,
    MCP_IP_CEILING_LIMIT,
    MCP_PER_KEY_LIMIT,
} from '@/lib/security/rate-limit-middleware';

/** Step 3 of the funnel — incremented only when a call actually executes. */
const toolExecution = { ran: 0 };

const mockCredential = authenticateMcpCredential as jest.Mock;
const mockInvocation = buildInvocationForCredential as jest.Mock;
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
    // The two halves of authentication, which #4205 put either side of the
    // per-key charge. `mockInvocation` is the EXPENSIVE one — in production it
    // sends a live `tools/list` to every external connection the agent holds a
    // grant on — so "was it called?" is how the tests below assert that a
    // refused request reached nobody's server.
    mockCredential.mockResolvedValue({
        ctx,
        verdict: { reason: null },
        surface: { method: 'POST', path: '/api/mcp' },
        audience: null,
        tokenExpiresAt: null,
        now: () => new Date(),
    });
    mockInvocation.mockResolvedValue({ ctx });
}

function toolCall(id: number, name = 'list_risks', args: Record<string, unknown> = {}) {
    return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

function post(body: unknown, ip = HOSTED_EGRESS_IP): NextRequest {
    return new NextRequest('http://localhost/api/mcp', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-forwarded-for': ip,
            authorization: 'Bearer iflk_test',
        },
        body: JSON.stringify(body),
    });
}

/** Spend `n` messages of `apiKeyId`'s budget, one request each, asserting each passes. */
function badJson(ip = HOSTED_EGRESS_IP): NextRequest {
    return new NextRequest('http://localhost/api/mcp', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-forwarded-for': ip,
            authorization: 'Bearer iflk_test',
        },
        body: '{ this is not json',
    });
}

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
    toolExecution.ran = 0;
    mockGuardMode = 'BALANCED';
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

describe('/api/mcp — nothing a caller can vary reaches an external server unpaid (#4205)', () => {
    /**
     * `mockInvocation` stands in for `buildInvocationForCredential`, which in
     * production sends one live `tools/list` to EVERY external connection the
     * agent holds a grant on — outbound traffic to a customer's own server. So
     * "was it called?" is the measurement these tests are built on: before
     * #4205 the answer was yes for every refusal below, and none of it was
     * charged to the key.
     */
    it('builds no authority for a request that is over its budget', async () => {
        await spend('key-over', MCP_PER_KEY_LIMIT.maxAttempts);
        mockInvocation.mockClear();

        const res = await POST(post(toolCall(1)), {});
        expect(res.status).toBe(429);
        expect(mockInvocation).not.toHaveBeenCalled();
    });

    it('builds no authority for invalid JSON', async () => {
        authenticateAs('key-badjson');
        mockInvocation.mockClear();

        const res = await POST(badJson(), {});
        expect(res.status).toBe(400);
        expect(mockInvocation).not.toHaveBeenCalled();
    });

    it('builds no authority for a batch larger than the whole budget', async () => {
        authenticateAs('key-huge');
        mockInvocation.mockClear();

        const huge = Array.from({ length: MCP_PER_KEY_LIMIT.maxAttempts + 1 }, (_, i) => toolCall(i));
        const res = await POST(post(huge), {});
        expect(res.status).toBe(400);
        expect(mockInvocation).not.toHaveBeenCalled();
    });

    it('charges the key for invalid JSON, so a malformed body is not free', async () => {
        authenticateAs('key-notfree');
        expect((await POST(badJson(), {})).status).toBe(400);

        // One unit is gone, so only `maxAttempts - 1` messages remain. Before
        // #4205 the malformed body cost nothing and the whole budget was still
        // there — which is the state this asserts against.
        for (let i = 0; i < MCP_PER_KEY_LIMIT.maxAttempts - 1; i += 1) {
            expect((await POST(post(toolCall(i)), {})).status).toBe(200);
        }
        expect((await POST(post(toolCall(999)), {})).status).toBe(429);
    });

    it('answers an empty batch with a single Invalid Request, not an accepted 202', async () => {
        authenticateAs('key-empty');
        mockInvocation.mockClear();

        const res = await POST(post([]), {});
        // 202-with-no-body told the caller its malformed request had been
        // accepted: zero messages produce zero responses, which the
        // notification branch cannot tell from a batch of notifications.
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.error.message).toMatch(/^Invalid Request/);
        expect(mockInvocation).not.toHaveBeenCalled();
    });

    it('tells a refused batch how many units it actually has left', async () => {
        const remaining = 5;
        await spend('key-header', MCP_PER_KEY_LIMIT.maxAttempts - remaining);

        const tooMany = Array.from({ length: remaining + 1 }, (_, i) => toolCall(i));
        const res = await POST(post(tooMany), {});
        expect(res.status).toBe(429);
        // NOT '0'. Five units are still spendable, and a hardcoded zero sends
        // the caller away for a whole window it does not need to wait.
        expect(res.headers.get('X-RateLimit-Remaining')).toBe(String(remaining));
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

    it('lets clean arguments through to the funnel and writes no guard row', async () => {
        const body = await callRead({ status: 'OPEN' });
        expect(body.result).toBeDefined();
        expect(mockRead).toHaveBeenCalledTimes(1);
        expect(mockAudit).not.toHaveBeenCalled();
    });

    it('refuses a secret in the arguments before the call executes, and audits rule ids only', async () => {
        const body = await callRead({ query: `find ${AWS_DOC_PLACEHOLDER}` });

        // THE REFUSAL NAMES NO RULE (#4205). A direct caller has no latch
        // stopping it from calling again, so echoing the rule that fired let it
        // vary one argument at a time until something passed.
        expect(body.error.message).toBe('ai_guard_blocked');
        expect(body.error.message).not.toContain('egr.api_key.aws_access_key');

        // The funnel is ENTERED — the scan lives inside it now — but step 3
        // never runs. That is the property, and it is the one the old
        // `not.toHaveBeenCalled()` was standing in for.
        expect(mockRead).toHaveBeenCalledTimes(1);
        expect(toolExecution.ran).toBe(0);

        // The ids are not lost; they are where an operator reads them.
        expect(mockAudit).toHaveBeenCalledTimes(1);
        const entry = mockAudit.mock.calls[0][0];
        expect(entry.action).toBe('AI_GUARD_EGRESS_BLOCKED');
        expect(entry.entityId).toBe('mcp-tool-args:list_risks');
        expect(entry.actorType).toBe('API_KEY');
        expect(JSON.stringify(entry)).toContain('egr.api_key.aws_access_key');
        expect(JSON.stringify(entry)).not.toContain(AWS_DOC_PLACEHOLDER);
    });

    it('refuses a flagged argument too, under the default balanced mode', async () => {
        const body = await callRead({ query: SUSPICIOUS_ASSIGNMENT });

        expect(body.error.message).toBe('ai_guard_review_required');
        expect(toolExecution.ran).toBe(0);
        expect(mockAudit.mock.calls[0][0].action).toBe('AI_GUARD_EGRESS_FLAGGED');
    });

    it('records but does not refuse when the tenant runs the guard in audit mode', async () => {
        mockGuardMode = 'AUDIT';
        const body = await callRead({ query: SUSPICIOUS_ASSIGNMENT });

        expect(body.result).toBeDefined();
        expect(toolExecution.ran).toBe(1);
        expect(mockAudit).toHaveBeenCalledTimes(1);
    });

    it('scans through the funnel, not ahead of it, so an unresolved name never writes a row', async () => {
        // The route hands `runReadTool` a hook rather than scanning first. That
        // is what keeps a made-up tool name and a call the gate refuses out of
        // the egress trail: the real `runReadTool` throws
        // `McpToolNotFoundError` at step 0 and audits `AUTHZ_DENIED` at step 1,
        // and neither reaches `afterAuthorize`.
        //
        // Asserted structurally here because this suite mocks the funnel: the
        // route must PASS the hook, and the hook must be what scans. The
        // ordering inside the funnel is proved against the real one in
        // `tests/unit/mcp-tool-deny-by-default.test.ts`.
        await callRead({ status: 'OPEN' });
        const [, , , options] = mockRead.mock.calls[0];
        expect(typeof options?.afterAuthorize).toBe('function');

        // And the hook really is the scan — invoking it with a secret refuses.
        mockAudit.mockClear();
        const [, , , dirty] = (await (async () => {
            await callRead({ query: `find ${AWS_DOC_PLACEHOLDER}` });
            return mockRead.mock.calls[mockRead.mock.calls.length - 1];
        })()) as [unknown, string, unknown, { afterAuthorize?: () => Promise<void> }];
        await expect(dirty.afterAuthorize!()).rejects.toThrow('ai_guard_blocked');
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
