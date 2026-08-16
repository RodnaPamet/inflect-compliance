/**
 * Every machine-caller path authenticates inside its own handler.
 *
 * `MACHINE_CALLER_PREFIXES` exists because the edge gate refuses any API
 * request without a NextAuth cookie, and the callers of these endpoints —
 * Stripe, Microsoft Graph, the AV scanner, a SCIM IdP, an MCP client, a
 * browser sending a credential-less CSP report — never have one. They were
 * all returning 401 before reaching code that would have authenticated them
 * correctly.
 *
 * That makes this list the one place where a typo opens the tenant API. An
 * entry whose handler does NOT authenticate is not a fix, it is a hole, and
 * the failure is silent in the direction that matters: the endpoint starts
 * working, which looks like success.
 *
 * So each entry is paired with the gate it is claimed to have, and the gate
 * is asserted to be present in the source. This is deliberately a
 * hard-coded expectation per path rather than a generic "contains the word
 * auth" scan — the point is that a human decided what gates each one, and
 * changing that decision has to be a visible edit here.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MACHINE_CALLER_PREFIXES, isPublicPath } from '@/lib/auth/guard';

const ROOT = path.resolve(__dirname, '../..');
const APP = path.join(ROOT, 'src/app');
const codeOnly = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/**
 * prefix → the gate its handler must contain, and a sample request path.
 *
 * `gate` is a regex over the handler source (comments stripped, so a
 * docblock promising a check cannot satisfy it).
 */
const CONTRACTS: ReadonlyArray<{
    prefix: string;
    handler: string;
    gate: RegExp;
    why: string;
}> = [
    {
        prefix: '/api/scim',
        handler: 'api/scim/v2/Users/route.ts',
        gate: /authenticateScimRequest\s*\(/,
        why: 'tenant-scoped SCIM bearer token',
    },
    {
        prefix: '/api/stripe/webhook',
        handler: 'api/stripe/webhook/route.ts',
        gate: /constructWebhookEvent\s*\(|stripe-signature/,
        why: 'stripe-signature verified against the raw body',
    },
    {
        prefix: '/api/storage/av-webhook',
        handler: 'api/storage/av-webhook/route.ts',
        gate: /timingSafeEqual/,
        why: 'HMAC compared in constant time',
    },
    {
        prefix: '/api/webhooks/sharepoint',
        handler: 'api/webhooks/sharepoint/route.ts',
        gate: /clientState/,
        why: 'Graph clientState anti-spoof against the stored subscription',
    },
    {
        prefix: '/api/integrations/webhooks',
        handler: 'api/integrations/webhooks/[provider]/route.ts',
        gate: /processIncomingWebhook\s*\(/,
        why: 'per-provider raw-body signature; tenant from the connection',
    },
    {
        prefix: '/api/mcp',
        handler: 'api/mcp/route.ts',
        gate: /authenticateMcpRequest\s*\(/,
        why: 'Bearer TenantApiKey with an mcp:read capability scope',
    },
];

describe('machine-caller paths authenticate themselves', () => {
    it.each(CONTRACTS)('$prefix is gated by $why', ({ handler, gate }) => {
        const src = codeOnly(fs.readFileSync(path.join(APP, handler), 'utf8'));
        expect(src).toMatch(gate);
    });

    it('every credential-bearing prefix has a contract here', () => {
        // The two report/beacon endpoints are credential-LESS by spec (a
        // browser will not attach cookies to either), so they have no gate to
        // assert — they are protected by a rate limiter and a body cap
        // instead. Everything else in the list must be accounted for above,
        // so a new entry cannot be added without stating what gates it.
        const credentialLess = [
            '/api/security/csp-report',
            '/api/csp-report',
            '/api/telemetry/vitals',
        ];
        const covered = new Set([...CONTRACTS.map((c) => c.prefix), ...credentialLess]);
        const uncovered = MACHINE_CALLER_PREFIXES.filter((p) => !covered.has(p));
        expect(uncovered).toEqual([]);
    });
});

describe('the allowlist opens what it means to open, and nothing else', () => {
    it.each(MACHINE_CALLER_PREFIXES.map((p) => [p]))('%s is public at the edge', (prefix) => {
        expect(isPublicPath(prefix)).toBe(true);
    });

    it('does NOT open the tenant API', () => {
        // The failure mode a prefix list invites: '/api/' or '/api' would
        // make every one of these pass while exposing everything.
        for (const p of [
            '/api/t/acme/risks',
            '/api/t/acme/controls',
            '/api/t/acme/admin/members',
            '/api/admin/tenants',
            '/api/evidence',
        ]) {
            expect(isPublicPath(p)).toBe(false);
        }
    });

    it('does not open sibling paths that merely share a stem', () => {
        // Matching is exact-or-subpath, not bare startsWith. A bare prefix
        // would make `/api/mcp` also open a future `/api/mcp-admin`, which
        // is how one intended hole becomes several without anyone editing
        // the list.
        expect(isPublicPath('/api/mcpanything')).toBe(false);
        expect(isPublicPath('/api/mcp-admin')).toBe(false);
        expect(isPublicPath('/api/scimitar')).toBe(false);
        expect(isPublicPath('/api/stripe/webhook-admin')).toBe(false);
        // …while the real sub-paths stay open.
        expect(isPublicPath('/api/scim/v2/Users')).toBe(true);
        expect(isPublicPath('/api/integrations/webhooks/github')).toBe(true);
    });
});
