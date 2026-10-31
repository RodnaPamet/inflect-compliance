/**
 * SSRF egress coverage ratchet.
 *
 * The webhook-safety guard (private/loopback/link-local + cloud-metadata block,
 * https-only, DNS-rebinding re-check, IP-pin) must sit in front of EVERY
 * tenant-controlled outbound fetch. Historically it guarded only the automation
 * webhook action; the tenant-controlled audit-stream URL fetched directly — a
 * cloud-metadata SSRF hole. This ratchet:
 *
 *   1. exercises `assertPublicAddress` against literal-private, metadata, and a
 *      DNS-rebinding (public name → private IP) case (mocked resolver);
 *   2. structurally asserts each curated tenant-controlled outbound sink routes
 *      through `safeFetch` and carries no bare `fetch(<tenant url>)`.
 *
 * A new outbound sink on a tenant-derived URL must use `safeFetch` (and be added
 * to SINKS) or this fails CI.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Mock the resolver so the rebinding case is deterministic ───────
const mockLookup = jest.fn<Promise<{ address: string; family: number }[]>, [string, unknown]>();
jest.mock('node:dns', () => ({
    promises: { lookup: (host: string, opts: unknown) => mockLookup(host, opts) },
}));

import { assertPublicAddress, isPrivateAddress, SsrfBlockedError } from '@/app-layer/automation/webhook-safety';
import { functionBodyOf, codeOf as blankComments } from '../helpers/source-blocks';
import { repoRelativeFiles } from '../helpers/repo-files';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('SSRF — isPrivateAddress', () => {
    it('flags cloud-metadata, RFC-1918, CGNAT, loopback, and v6 loopback', () => {
        for (const ip of ['169.254.169.254', '10.0.0.1', '172.16.0.1', '192.168.1.1', '127.0.0.1', '100.64.0.1', '::1', '0.0.0.0']) {
            expect(isPrivateAddress(ip)).toBe(true);
        }
    });
    it('allows genuine public addresses', () => {
        for (const ip of ['93.184.216.34', '8.8.8.8', '1.1.1.1']) {
            expect(isPrivateAddress(ip)).toBe(false);
        }
    });
});

describe('SSRF — assertPublicAddress', () => {
    beforeEach(() => mockLookup.mockReset());

    it('rejects non-https', async () => {
        await expect(assertPublicAddress('http://example.com/')).rejects.toBeInstanceOf(SsrfBlockedError);
    });

    it('rejects literal cloud-metadata + RFC-1918 + v6 loopback + localhost (before DNS)', async () => {
        for (const url of ['https://169.254.169.254/latest/meta-data', 'https://10.0.0.1/', 'https://[::1]/', 'https://localhost/']) {
            await expect(assertPublicAddress(url)).rejects.toBeInstanceOf(SsrfBlockedError);
        }
        expect(mockLookup).not.toHaveBeenCalled(); // literal cases short-circuit
    });

    it('rejects a public hostname that RESOLVES to private space (DNS rebinding)', async () => {
        mockLookup.mockResolvedValue([{ address: '10.0.0.1', family: 4 }]);
        await expect(assertPublicAddress('https://rebind.example.com/')).rejects.toThrow(/private address 10\.0\.0\.1/);
    });

    it('rejects when ANY resolved address is private (multi-record)', async () => {
        mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }]);
        await expect(assertPublicAddress('https://mixed.example.com/')).rejects.toBeInstanceOf(SsrfBlockedError);
    });

    it('accepts a public hostname resolving to public space', async () => {
        mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
        const r = await assertPublicAddress('https://good.example.com/');
        expect(r.host).toBe('good.example.com');
        expect(r.addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
    });
});

// ─── Curated tenant-controlled outbound sinks ──────────────────────
// Each MUST import + use safeFetch and carry no bare tenant-URL fetch.
const SINKS: { file: string; reason: string; noBareFetchOf: string }[] = [
    {
        file: 'src/app-layer/events/audit-stream.ts',
        reason: 'Tenant-controlled auditStreamUrl (was the metadata-SSRF hole).',
        noBareFetchOf: 'fetch(url',
    },
    {
        file: 'src/app-layer/automation/action-executor.ts',
        reason: 'Tenant-authored automation webhook URL.',
        noBareFetchOf: 'fetch(cfg.url',
    },
    {
        file: 'src/lib/mcp/wire-transport.ts',
        reason:
            'Operator-supplied MCP server URL — BOTH outbound dialects now reach ' +
            'the network here and nowhere else (#3303). Somebody types a hostname ' +
            'for a server we do not run, which is textbook SSRF input.',
        // The transport writes an explicit `opts.fetchImpl ? … : safeFetch(…)`
        // branch rather than resolving an alias, so the shape to forbid is a
        // bare call on the caller's URL.
        noBareFetchOf: 'fetch(opts.url',
    },
    {
        file: 'src/lib/agentic/peer-agent-card-fetch.ts',
        reason:
            "An A2A peer's agent card URL (#3673): an operator types a host in " +
            'another organisation, read again on every review and admission.',
        noBareFetchOf: 'fetch(cardUrl',
    },
    {
        file: 'src/app-layer/services/vendor-monitoring/tls-provider.ts',
        reason:
            "The vendor monitor's TLS grade requests a vendor domain anybody who " +
            'can edit a vendor types, from inside the deployment, every night. It ' +
            'fetched it through fetchWithRetry, the plain global fetch, until the ' +
            'Web Bot Auth roadmap found it (Phase 0.5).',
        // The pre-fix call. Its replacement follows redirects one hop at a
        // time, and each hop is a fresh safeFetch.
        noBareFetchOf: 'fetchWithRetry(',
    },
    {
        file: 'src/lib/security/oidc-client.ts',
        reason:
            'SSO sign-in: a workspace administrator types the OIDC issuer, and the ' +
            "issuer's discovery document names the token endpoint and the key set.",
        noBareFetchOf: 'fetch(discoveryUrl',
    },
];

/**
 * The two outbound MCP clients, which must reach the network ONLY through the
 * shared transport above.
 *
 * This replaces a per-file `safeFetch(` literal check on each client, and is
 * strictly stronger than what it replaces. That check asked "does this file
 * mention safeFetch somewhere?", which a file could satisfy while also
 * fetching directly elsewhere. These assert the clients contain NO fetch call
 * of any kind — so the only way either reaches the network is the one branch
 * the registry above covers.
 *
 * Why this list is two entries and not one: the tools client was never in
 * SINKS at all (#3400), so until now, replacing its `safeFetch` with a bare
 * `fetch` would not have failed CI. The omission was invisible precisely
 * because the OTHER MCP client was listed, and a reader checking "is the MCP
 * client covered?" finds yes for one of two and is unlikely to ask which.
 */
const MCP_CLIENTS: readonly string[] = [
    'src/app-layer/integrations/mcp/client.ts',
    'src/lib/mcp/client/index.ts',
    // The THIRD client on the one wire (#3679; a2a-threat-model O4 E): A2A to a
    // peer agent, with its own closed method set. Held to the same rule — no
    // fetch call of its own, the shared transport imported — because a task to
    // another organisation's agent is exactly the request that must not find a
    // second way out.
    'src/lib/agentic/a2a/client.ts',
];

describe('SSRF — every tenant-controlled sink routes through safeFetch', () => {
    for (const sink of SINKS) {
        it(`${sink.file} uses safeFetch, not a bare fetch (${sink.reason})`, () => {
            const src = read(sink.file);
            expect(src).toMatch(/safeFetch\(/);
            expect(src).toMatch(/from '(\.\/|@\/app-layer\/automation\/)webhook-safety'/);
            // the pre-fix bare fetch on the tenant URL must be gone
            expect(src).not.toContain(`await ${sink.noBareFetchOf}`);
        });
    }
});

/**
 * The findings are COMPUTED here and asserted as values below, rather than
 * written as `expect(read(file)).not.toMatch(…)` per client.
 *
 * That is not a style preference. `Class D` of the needle-uniqueness ratchet
 * counts whole-file assertions it cannot statically follow, and a read whose
 * path comes from a loop variable (`path-not-constant`) or whose content is
 * transformed before matching (`content-transformed`) is one of them — a blind
 * spot where an ambiguous needle could hide. Comment-stripping is required for
 * correctness here, so the read cannot be made analysable; removing the
 * file-read SHAPE is the remedy the ratchet leaves open, and it also gives a
 * failure that names the offending file instead of just reporting a regex miss.
 */
function codeOf(rel: string): string {
    // Comments stripped: prose naming a forbidden pattern is not a call, and a
    // check that cannot tell the difference reports the explanation of a rule
    // as a breach of it.
    return blankComments(read(rel));
}

/**
 * ANY identifier ending in `fetch`, not a list of the two we thought of.
 *
 * The previous form was `/\bfetch\(/ || /\bsafeFetch\b/`, and `\b` before
 * `fetch` means neither matches `resilientFetch(` — the leading `\b` requires a
 * non-word character before `f`, and `t` is a word character. So a client
 * calling `resilientFetch(url)` passed this guard (#3480).
 *
 * That was not hypothetical cover for a harmless alias. `resilientFetch` is
 * `createResilientFetch()`, whose inner is `boundedFetch` — which bounds size
 * and time and redacts query strings for logging, and does NO address
 * filtering: no private, loopback, link-local or metadata checks anywhere in
 * `bounded-fetch.ts`. Reaching the network through it is reaching it without
 * SSRF protection, on an operator-supplied hostname.
 *
 * The rule was also already WRITTEN DOWN in two places that this guard did not
 * enforce — Phase 1's hardening criterion says the rule must fail on `fetch`
 * **or `resilientFetch`**, and the client's own docblock says the same. Two
 * statements of a rule and one half-implementation of it.
 *
 * So the pattern is name-agnostic now. `boundedFetch`, `resilientFetch`, a
 * future `retryingFetch` and a bare `fetch` all match, because what makes any
 * of them unsafe here is reaching the network at all from a file whose only
 * sanctioned path is the shared transport.
 */
const ANY_FETCH_CALL = /\w*fetch\s*\(/i;

const clientsWithTheirOwnFetch = () => MCP_CLIENTS.filter((f) => ANY_FETCH_CALL.test(codeOf(f)));

const clientsNotUsingTheTransport = () =>
    MCP_CLIENTS.filter((f) => !/from '@\/lib\/mcp\/wire-transport'/.test(read(f)));

describe('SSRF — the MCP clients reach the network only through the shared transport', () => {
    it('neither client contains a fetch call of its own', () => {
        expect(clientsWithTheirOwnFetch()).toEqual([]);
    });

    it('both clients import the shared transport', () => {
        // The other half: "no fetch" alone is also satisfied by a client that
        // reaches the network some third way, or has stopped working entirely.
        expect(clientsNotUsingTheTransport()).toEqual([]);
    });

    it('the pattern catches every fetch alias, not the two we thought of', () => {
        // #3480's finding, pinned. The old pattern was `\bfetch\(` plus a
        // `safeFetch` literal; `resilientFetch(` matched neither, and
        // `resilientFetch` does no address filtering. Asserted on synthetic
        // source so a clean run over the real clients means something.
        for (const call of [
            'await fetch(opts.url)',
            'await safeFetch(opts.url)',
            'await resilientFetch(opts.url)',
            'await boundedFetch(opts.url)',
            'const r = retryingFetch(u)',
        ]) {
            expect({ call, caught: ANY_FETCH_CALL.test(call) }).toEqual({ call, caught: true });
        }
        // And the negative control: the guard must not fire on source that
        // merely IMPORTS the transport, which is what the clients do.
        for (const ok of [
            "import { mcpRequest } from '@/lib/mcp/wire-transport';",
            'const res = await mcpRequest(opts);',
        ]) {
            expect({ ok, caught: ANY_FETCH_CALL.test(ok) }).toEqual({ ok, caught: false });
        }
    });

    it('the list covers every dialect, so none is silently unlisted', () => {
        // #3400 was invisible because the OTHER MCP client was registered: a
        // reader checking "is the MCP client covered?" finds yes for one of two
        // and is unlikely to ask which. Pinning the denominator makes a future
        // omission loud.
        expect(MCP_CLIENTS).toHaveLength(3);
    });
});

/**
 * The OIDC client fetches THREE URLs, and the SINKS entry above names one
 * bare-fetch shape. The other two are the ones a reader misses: the token
 * endpoint and the key set come from the identity provider's discovery
 * document, not from anything typed into this product, and the key set is
 * fetched by `jose`, whose default is the global `fetch`. So: no fetch call in
 * the file but `safeFetch`, and jose handed `safeFetch` as its fetch.
 */
const OIDC_CLIENT = 'src/lib/security/oidc-client.ts';

const oidcFetchCallsOtherThanSafeFetch = () =>
    (codeOf(OIDC_CLIENT).match(/\w*fetch\s*\(/gi) ?? []).filter((call) => !/^safeFetch\s*\($/.test(call));

const oidcKeySetFetchesThroughTheGuard = () =>
    /createRemoteJWKSet\([^;]*\[customFetch\]\s*:\s*\([^)]*\)\s*=>\s*safeFetch\(/.test(codeOf(OIDC_CLIENT));

describe('SSRF — the OIDC client reaches the identity provider only through safeFetch', () => {
    it('makes no fetch call other than safeFetch', () => {
        expect(oidcFetchCallsOtherThanSafeFetch()).toEqual([]);
    });

    it("hands jose's key-set fetch to safeFetch, not jose's default global fetch", () => {
        expect(oidcKeySetFetchesThroughTheGuard()).toBe(true);
    });
});

/**
 * ══════════════════════════════════════════════════════════════════════════
 *  THE LOCAL AI GATEWAY — the sink that must NOT route through safeFetch
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `TenantSecuritySettings.aiLocalBaseUrl` is a URL any `admin.manage` holder
 * writes through `PUT /api/t/:slug/admin/security-settings`, validated as
 * `z.string().url()` and nothing more. Two things used to ride on it from
 * `ai/risk-assessment`: a bare `fetch`, and `AI_LOCAL_API_KEY` as a bearer —
 * so a workspace admin could aim the server at `169.254.169.254` and collect
 * the deployment's own gateway credential (#4545).
 *
 * IT IS NOT IN `SINKS` ABOVE, AND MUST NOT BE ADDED THERE. `assertPublicAddress`
 * refuses private, loopback and link-local addresses, and a local inference
 * gateway is *supposed* to be on one — `http://localhost:11434` for Ollama, an
 * internal host for vLLM. Putting this behind the public-address check would
 * delete the feature rather than harden it.
 *
 * So the defence is upstream of the dial, and this section asserts the shape of
 * it: the tenant value is resolved by ONE function, `resolveLocalGateway`, which
 * honours it only when it names the gateway this deployment already serves.
 * With that in place there is no tenant-controlled URL left to guard.
 *
 * WHY THE POPULATION IS DERIVED RATHER THAN LISTED. The failure this catches is
 * a THIRD reader of `env.AI_LOCAL_BASE_URL` appearing beside a tenant value and
 * comparing it by hand — which is exactly how the two subsystems came to
 * disagree in the first place: Flue had the rule, the risk factory did not, and
 * nothing anywhere could tell you that. A curated list cannot catch its own
 * omission, so the set of readers is read off the tree and asserted by exact
 * equality against a classified set.
 */
const AI_LOCAL_BASE_URL_READERS: Record<string, string> = {
    'src/env.ts': 'The declaration itself.',
    'src/lib/ai/local-gateway.ts':
        'THE one resolver. Every tenant value is decided here and nowhere else.',
    'src/lib/agentic/flue/runtime-start.ts':
        'Boot-time provider registration from the DEPLOYMENT value alone — no tenant ' +
        'value is in scope, which is precisely why `resolveFlueModel` must refuse a ' +
        'tenant gateway this registration cannot serve.',
    'src/lib/agentic/flue/providers.ts':
        'A string LITERAL naming the variable in a credential-source label, not a read.',
    'src/app-layer/usecases/tenant-security-settings.ts':
        'PRESENCE ONLY — `Boolean(env.AI_LOCAL_BASE_URL)` at two sites, reported to the ' +
        'residency control as `deploymentHasLocalGateway` so the page can say what ' +
        'LOCAL_ONLY will mean on this deployment. The address itself is never returned, ' +
        'nothing is dialled, and no tenant value is compared against it — so the rule in ' +
        '`local-gateway.ts` does not apply. Classified 2026-10-30: this guard caught the ' +
        'reader when #4551 added it, which is what it is for.',
};

/** Both callers that resolve a TENANT-supplied gateway, and must share the rule. */
const LOCAL_GATEWAY_CONSUMERS: { file: string; fn: string }[] = [
    { file: 'src/app-layer/ai/risk-assessment/index.ts', fn: 'buildLocalProvider' },
    { file: 'src/lib/agentic/flue/model-selection.ts', fn: 'resolveFlueModel' },
];

describe('SSRF — the local AI gateway is resolved in one place', () => {
    it('exactly the classified files read env.AI_LOCAL_BASE_URL', () => {
        // `repoRelativeFiles()` is git-backed, so the denominator is the tree
        // rather than a hand-maintained skip list — the
        // `source-scan-population` rule, and the reason a `.claude/worktrees`
        // checkout once got scanned as if it were the repo.
        const found = repoRelativeFiles()
            .filter((f) => f.startsWith('src/') && /\.tsx?$/.test(f))
            // The local `codeOf` reads the file AND strips comments: prose
            // naming the variable is not a read of it.
            .filter((f) => codeOf(f).includes('AI_LOCAL_BASE_URL'));

        // Exact equality in BOTH directions. A new reader fails until somebody
        // classifies it; a stale entry fails so the list cannot rot into
        // describing files that no longer read it.
        expect(found.sort()).toEqual(Object.keys(AI_LOCAL_BASE_URL_READERS).sort());
    });

    for (const { file, fn } of LOCAL_GATEWAY_CONSUMERS) {
        describe(`${fn} in ${file}`, () => {
            // Bound to the FUNCTION body, not the file. A whole-file needle here
            // would be satisfied by the import line alone — the
            // called-versus-imported hole `ai-guard-coverage`'s enforcement
            // check turned out to have.
            const body = () => functionBodyOf(codeOf(file), fn);

            it('resolves the tenant gateway through the shared rule', () => {
                expect(body()).toContain('resolveLocalGateway(');
            });

            it('never compares the tenant URL against the env var by hand', () => {
                // A re-inlined comparison is how the two copies of this rule
                // would drift apart again, and a drifted copy disagrees in the
                // direction that grants access.
                expect(body()).not.toContain('env.AI_LOCAL_BASE_URL');
            });
        });
    }

    it('the risk factory dials the RESOLVED url, never the tenant string', () => {
        // The sharpest assertion in this section. Calling the resolver and then
        // constructing the provider from `sel.localBaseUrl` anyway would satisfy
        // every check above and leave the hole exactly as it was.
        const body = functionBodyOf(
            codeOf('src/app-layer/ai/risk-assessment/index.ts'),
            'buildLocalProvider',
        );
        expect(body).toContain('new LocalRiskSuggestionProvider(\n        gateway.baseUrl,');
        expect(body).not.toContain('new LocalRiskSuggestionProvider(\n        sel');
    });

    it('the resolver returns the deployment url, so no tenant string flows through', () => {
        // `resolveLocalGateway` hands back `deployment`, not the tenant value,
        // even in the equal case — so no caller can come to depend on the tenant
        // string flowing through, and narrowing the rule later cannot silently
        // change what is dialled.
        const body = functionBodyOf(codeOf('src/lib/ai/local-gateway.ts'), 'resolveLocalGateway');
        expect(body).toContain('return { served: true, baseUrl: deployment };');
        expect(body).not.toContain('baseUrl: tenantBaseUrl');
    });
});
