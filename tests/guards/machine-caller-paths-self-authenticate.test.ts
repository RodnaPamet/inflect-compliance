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
 *
 * And an entry is a PATH, while a route file exports METHODS. `isPublicPath`
 * cannot say "the POST only", so an entry added for a credential-less method
 * opens every other method on the same path. `/api/security/csp-report` is
 * where that bit: its POST is the browser report sink and must stay open,
 * while its GET returns the process-wide CSP violation buffer and was public
 * for as long as the entry existed (#2103). Hence the split below —
 * credential-LESS is a property of a method, not of a path, and the methods
 * that are not credential-less are asserted one by one.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MACHINE_CALLER_PREFIXES, isPublicPath } from '@/lib/auth/guard';
import { declarationOf, functionBodyOf } from '../helpers/source-blocks';

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
    {
        prefix: '/api/admin',
        handler: 'api/admin/diagnostics/route.ts',
        gate: /verifyPlatformApiKey\s*\(/,
        why: 'PLATFORM_ADMIN_API_KEY, compared in constant time (#3132)',
    },
];

describe('machine-caller paths authenticate themselves', () => {
    it.each(CONTRACTS)('$prefix is gated by $why', ({ handler, gate }) => {
        const src = codeOnly(fs.readFileSync(path.join(APP, handler), 'utf8'));
        expect(src).toMatch(gate);
    });

    it('the operator GET on the csp-report path gates itself', () => {
        // The one place in this list where "credential-less" is true of a
        // METHOD and not of the path. The POST below is the browser sink and
        // stays open; the GET returns `getViolationSummary(50)` — whole
        // CspViolation records, including `documentUri` values carrying other
        // tenants' slugs — and so must carry its own gate, because the edge
        // allowlist three files away cannot express "POST only".
        //
        // Bounded to the GET's own body rather than the file: the POST and
        // the header docblock both mention the gate by name, so a file-wide
        // match would stay green with the call deleted from the handler.
        const src = fs.readFileSync(
            path.join(APP, 'api/security/csp-report/route.ts'),
            'utf8',
        );
        const get = codeOnly(functionBodyOf(src, 'GET'));
        expect(get).toMatch(/verifyPlatformApiKey\s*\(/);
        // The extraction found a real body — an over-eager strip would make
        // a `not.toMatch` sibling vacuous, and makes this one a false alarm.
        expect(get).toMatch(/getViolationSummary\s*\(/);

        // The POST on the same file stays credential-less. A "consistency"
        // pass that moved the gate up to module scope would take every CSP
        // report down with it, silently.
        expect(codeOnly(functionBodyOf(src, 'POST'))).not.toMatch(
            /verifyPlatformApiKey/,
        );
    });

    it('every credential-bearing prefix has a contract here', () => {
        // The report/beacon endpoints are credential-LESS by spec (a browser
        // will not attach cookies to any of them), so their SINK has no gate
        // to assert — they are protected by a rate limiter and a body cap
        // instead. The non-sink method on the csp-report path is covered by
        // the test directly above. Everything else in the list must be
        // accounted for in CONTRACTS, so a new entry cannot be added without
        // stating what gates it.
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
        /*
            The failure mode a prefix list invites: '/api/' or '/api' would
            make every one of these pass while exposing everything.

            `/api/admin/tenants` WAS on this list and is deliberately off it as
            of #3132. That line is worth explaining rather than quietly
            deleting, because it named a genuinely sensitive route and the
            deletion looks exactly like weakening the test.

            What changed is which layer refuses the request, not whether it is
            refused. Every method under `/api/admin` verifies
            PLATFORM_ADMIN_API_KEY in constant time; before #3132 the edge
            returned 401 first, so those gates were unreachable code and the
            platform key could not be presented AT ALL — including to the
            agent kill switch, whose only remote control it is. The test
            immediately below now asserts the in-handler gate for every method
            of every route under that prefix, which is a stronger claim than
            this line made.

            `/api/t/acme/admin/members` stays, and is the one that matters for
            THIS test: it is the tenant API, it merely contains the word
            `admin`, and no entry here may open it.
        */
        for (const p of [
            '/api/t/acme/risks',
            '/api/t/acme/controls',
            '/api/t/acme/admin/members',
            '/api/evidence',
            '/api/audit-log',
        ]) {
            expect(isPublicPath(p)).toBe(false);
        }
    });

    it('and `/api/admin` does not open a sibling that merely shares the stem', () => {
        // Same rule as `/api/mcp` vs `/api/mcp-admin`, asserted for the new
        // entry rather than assumed from the matcher.
        expect(isPublicPath('/api/administrators')).toBe(false);
        expect(isPublicPath('/api/admin-tools')).toBe(false);
        expect(isPublicPath('/api/adminx')).toBe(false);
        // …while the real sub-paths are open, which is the point of the entry.
        expect(isPublicPath('/api/admin')).toBe(true);
        expect(isPublicPath('/api/admin/diagnostics')).toBe(true);
        expect(isPublicPath('/api/admin/agent-kill-switch')).toBe(true);
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

/**
 * `/api/admin` — EVERY method of EVERY route, derived from the directory (#3132).
 *
 * The contract table above samples ONE handler per prefix, which is enough when
 * a prefix has one route file. `/api/admin` has four, and matching here is
 * path-scoped: the entry opens all of them, and any added later.
 *
 * So this walks the directory instead of naming files. A route added tomorrow
 * without a gate fails this on the day it is added, rather than on the day
 * somebody remembers to extend a list — which is the difference between a guard
 * and a snapshot.
 *
 * Per METHOD, not per file. `agent-kill-switch` exports GET, POST and PATCH and
 * mentions the gate once, in a shared `guard()` helper; a file-wide match would
 * stay green if one handler stopped calling it. That is the mistake that put the
 * cross-tenant CSP buffer on the internet (#2103), and this file's own header
 * states it: an entry added for one method opens the others too.
 */
describe('/api/admin: every exported method gates itself on the platform key', () => {
    const ADMIN_DIR = path.join(APP, 'api/admin');

    /** Every `route.ts` under `/api/admin`, at any depth. */
    const adminRoutes = (dir: string): string[] =>
        fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) return adminRoutes(full);
            return e.name === 'route.ts' ? [full] : [];
        });

    const FILES = adminRoutes(ADMIN_DIR);
    const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

    /** `[file, method]` for every handler actually exported. */
    const HANDLERS: Array<[string, string]> = FILES.flatMap((f) => {
        const src = fs.readFileSync(f, 'utf8');
        return METHODS.filter((m) =>
            new RegExp(`export const ${m}\\s*=`).test(src),
        ).map((m) => [path.relative(APP, f), m] as [string, string]);
    });

    it('the population is non-empty — an empty sweep proves nothing', () => {
        // Both counts, because zero FILES and zero METHODS fail differently and
        // a `.each` over an empty array passes silently.
        expect(FILES.length).toBeGreaterThanOrEqual(4);
        expect(HANDLERS.length).toBeGreaterThanOrEqual(6);
    });

    it.each(HANDLERS)('%s %s verifies the platform key', (file, method) => {
        const src = fs.readFileSync(path.join(APP, file), 'utf8');
        /*
            `declarationOf`, not `functionBodyOf`. These routes are
            `export const GET = withApiErrorHandling(async (req) => { … });` —
            a const declaration bounded by its top-level semicolon — whereas
            `functionBodyOf` matches only a `function NAME` declaration and
            throws here. The csp-report test above uses the other helper
            because that file is written the other way.

            Both are END-BOUNDED, which is the property that matters: a slice
            running to EOF stays green when the target handler is gutted,
            provided any later handler in the file still mentions the gate.
        */
        const body = codeOnly(declarationOf(src, method));

        // The extraction found a real body. Without this, an over-eager strip
        // makes the assertion below vacuous rather than failing.
        expect(body.length).toBeGreaterThan(20);

        // Either the direct call or the file's own early-returning wrapper.
        // `guard(` is accepted because `agent-kill-switch` routes all three
        // methods through one, and inlining it three times would be worse code
        // for the sake of a simpler regex.
        expect(body).toMatch(/verifyPlatformApiKey\s*\(|guard\s*\(\s*req\s*\)/);
    });

    it('and the prefix is actually open at the edge, or none of the above matters', () => {
        // The pairing that makes this suite mean something: the gates are
        // reachable AND they exist. Either half alone is a 401 or a hole.
        expect(isPublicPath('/api/admin/diagnostics')).toBe(true);
        expect(MACHINE_CALLER_PREFIXES).toContain('/api/admin');
    });
});
