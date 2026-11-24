/**
 * The mobile audit's fixture setup (`scripts/mobile-audit/fixtures.ts`) and
 * how the resolver reads it (`resolve.ts`).
 *
 * The invariants: a detail route the setup can serve is measured, not left
 * "not captured"; a public token route is opened with a token the setup
 * minted, because only a hash is stored; a fixture that fails names its
 * reason on every route that needed it ("setup failed: <why>") and never
 * stops the fixtures after it; and a second run creates no second record.
 */
import { FIXTURES, setUpAuditFixtures, tokenFromUrl, type FixtureApi, type SetupOutcome } from '../../scripts/mobile-audit/fixtures';
import { RESOLVERS, resolveRoute, type ResolveContext } from '../../scripts/mobile-audit/resolve';
import { paramsOf, audienceOf, type AppRoute } from '../../scripts/mobile-audit/routes';

/** Routes the seed alone cannot fill, which the setup must. */
const SETUP_ROUTES = [
    '/t/[tenantSlug]/agents/[agentId]',
    '/t/[tenantSlug]/admin/agents/[agentId]',
    '/t/[tenantSlug]/processes/agents/[agentId]',
    '/t/[tenantSlug]/processes/agents/[agentId]/flow',
    '/t/[tenantSlug]/agents/runs/[runId]',
    '/t/[tenantSlug]/admin/integrations/[connectionId]',
    '/t/[tenantSlug]/admin/integrations/[connectionId]/reconciliation',
    '/t/[tenantSlug]/admin/external-write-policy/[connectionId]',
    '/t/[tenantSlug]/admin/vendor-assessment-reviews/[assessmentId]',
    '/vendor-assessment/[assessmentId]',
    '/t/[tenantSlug]/agents/peers/[peerId]',
    '/trust/[slug]',
    '/t/[tenantSlug]/audits/nis2-gap/respond/[assignmentId]',
    '/audit/shared/[token]',
    '/invite/[token]',
    '/invite/org/[token]',
];

const route = (pattern: string): AppRoute => ({ pattern, file: '', audience: audienceOf(pattern), params: paramsOf(pattern) });

/**
 * A database whose every `findFirst` answers from `rows[model]` (null when
 * absent), recording the models queried. Enough for the resolvers and the
 * fixtures, which only ever ask "is there one, and which".
 */
function fakeDb(rows: Record<string, unknown> = {}) {
    return new Proxy({}, {
        get: (_t, model: string) => ({
            findFirst: async () => rows[model] ?? null,
            findUnique: async () => rows[model] ?? null,
        }),
    }) as unknown as ResolveContext['db'];
}

function ctx(rows: Record<string, unknown> = {}, setup?: SetupOutcome): ResolveContext {
    return { db: fakeDb(rows), tenantId: 't1', tenantSlug: 'acme-corp', orgId: 'o1', orgSlug: 'acme-org', setup };
}

/** An API that answers each call from `answers` by the first matching path fragment, and records every call. */
function fakeApi(answers: Array<[RegExp, unknown]>, calls: string[]): FixtureApi {
    const answer = async (method: string, path: string) => {
        calls.push(`${method} ${path}`);
        if (path === '/api/auth/session') return { user: { id: 'owner-1' } };
        const hit = answers.find(([re]) => re.test(path));
        if (!hit) throw new Error(`${method} ${path} → 500 unexpected`);
        if (hit[1] instanceof Error) throw hit[1];
        return hit[1];
    };
    return {
        get: async <T>(path: string) => (await answer('GET', path)) as T,
        post: async <T>(path: string) => (await answer('POST', path)) as T,
        put: async <T>(path: string) => (await answer('PUT', path)) as T,
    };
}

const TOKEN_ANSWERS: Array<[RegExp, unknown]> = [
    [/action=share$/, { token: 'share-raw' }],
    [/\/admin\/invites$/, { url: '/invite/tenant-raw' }],
    [/\/org\/acme-org\/invites$/, { url: '/invite/org/org-raw' }],
    [/\/assessments\/send$/, { assessmentId: 'va-1', externalAccessToken: 'va-raw' }],
    [/\/resend$/, { externalAccessToken: 'va-rotated' }],
];

/** Every model the record fixtures look for, present. */
const EVERYTHING = {
    vendor: { id: 'v1' }, incident: { id: 'i1' }, businessImpactAnalysis: { id: 'b1' }, aiSystem: { id: 'a1' },
    evidence: { id: 'e1' }, controlTestRun: { id: 'r1' }, accessReview: { id: 'ar1' }, registeredAgent: { id: 'ag1' },
    workflowRun: { id: 'wr1' }, peerAgent: { id: 'p1' }, integrationConnection: { id: 'c1' }, trustCenter: { id: 'tc1', slug: 'acme-corp' },
    nis2GapAssignment: { id: 'n1' }, orgSecurityInitiative: { id: 'oi1' }, auditPack: { id: 'pk1' },
    vendorAssessmentTemplate: { id: 'tpl1' },
};

describe('fixture setup', () => {
    it('creates nothing a second time, and still mints every token (only hashes are stored)', async () => {
        const calls: string[] = [];
        const api = fakeApi(TOKEN_ANSWERS, calls);
        const out = await setUpAuditFixtures(api, api, ctx(EVERYTHING));
        expect(out.created).toEqual([]);
        expect(out.failed.size).toBe(0);
        expect(out.minted.sort()).toEqual(['audit share link', 'org invite', 'tenant invite', 'vendor assessment']);
        expect(out.tokens).toEqual({
            auditShare: 'share-raw',
            tenantInvite: 'tenant-raw',
            orgInvite: 'org-raw',
            vendorAssessment: { assessmentId: 'va-1', token: 'va-raw' },
        });
        // No record-creating call went out.
        expect(calls.filter((c) => /\/(admin\/agents|agent-runs|trust-center|integrations|rerun|vendors)$/.test(c))).toEqual([]);
    });

    it('resends an assessment already out to the audit respondent rather than sending a second', async () => {
        const calls: string[] = [];
        const api = fakeApi(TOKEN_ANSWERS, calls);
        const out = await setUpAuditFixtures(api, api, ctx({ ...EVERYTHING, vendorAssessment: { id: 'va-open' } }));
        expect(out.tokens.vendorAssessment).toEqual({ assessmentId: 'va-open', token: 'va-rotated' });
        expect(calls.some((c) => c.endsWith('/assessments/send'))).toBe(false);
    });

    it('creates each missing record through the API, as the signed-in owner', async () => {
        const calls: string[] = [];
        const api = fakeApi([
            ...TOKEN_ANSWERS,
            [/\/admin\/agents$/, { id: 'ag' }],
            [/\/agent-runs$/, { id: 'wr' }],
            [/\/rerun$/, { id: 'nis2-run' }],
            [/\/assignments$/, {}],
            [/\/trust-center(\/enable)?$/, {}],
        ], calls);
        const missing = { ...EVERYTHING, registeredAgent: null, workflowRun: null, trustCenter: null, nis2GapAssignment: null };
        const out = await setUpAuditFixtures(api, api, ctx(missing));
        expect(out.failed).toEqual(new Map());
        expect(out.created).toEqual(['registered agent', 'workflow run', 'trust center', 'NIS2 gap assignment']);
        expect(calls).toEqual(expect.arrayContaining([
            'GET /api/auth/session',
            'POST /api/t/acme-corp/admin/agents',
            'POST /api/t/acme-corp/agent-runs',
            'PUT /api/t/acme-corp/admin/trust-center',
            'POST /api/t/acme-corp/admin/trust-center/enable',
            'POST /api/t/acme-corp/gap-assessments/nis2-run/assignments',
        ]));
    });

    it('records a failure with its reason, never throws, and runs the fixtures after it', async () => {
        const calls: string[] = [];
        const api = fakeApi([...TOKEN_ANSWERS, [/\/admin\/agents\/peers$/, new Error('POST peers → 400 bad key')]], calls);
        const out = await setUpAuditFixtures(api, api, ctx({ ...EVERYTHING, peerAgent: null, integrationConnection: null }));
        expect(out.failed.get('A2A peer')).toBe('POST peers → 400 bad key');
        // The connection needs the peer, and says so.
        expect(out.failed.get('integration connection')).toBe('needs an A2A peer, and the database holds none');
        // Later fixtures still ran.
        expect(out.tokens.orgInvite).toBe('org-raw');
    });

    it('reads the raw token off the URL an invite returns, and refuses another URL', () => {
        expect(tokenFromUrl('/invite/abc_DEF-1', '/invite/')).toBe('abc_DEF-1');
        expect(tokenFromUrl('/invite/org/xyz', '/invite/org/')).toBe('xyz');
        expect(() => tokenFromUrl('/elsewhere/xyz', '/invite/')).toThrow();
        expect(() => tokenFromUrl(undefined, '/invite/')).toThrow();
    });
});

describe('resolving the routes the setup serves', () => {
    const fixtureNames = new Set(FIXTURES.map((f) => f.what));

    it('every one has a resolver that names a fixture the setup runs', async () => {
        for (const pattern of SETUP_ROUTES) {
            expect(RESOLVERS[pattern]).toBeDefined();
            const r = await RESOLVERS[pattern](ctx({}, { created: [], minted: [], failed: new Map(), tokens: {} }));
            expect({ pattern, fixture: 'fixture' in r ? r.fixture : undefined }).toEqual({ pattern, fixture: expect.any(String) });
            expect(fixtureNames.has((r as { fixture: string }).fixture)).toBe(true);
        }
    });

    it('reports "setup failed: <why>" on every route whose fixture failed', async () => {
        const failed = new Map(FIXTURES.map((f) => [f.what, `${f.what} broke`]));
        const c = ctx({}, { created: [], minted: [], failed, tokens: {} });
        for (const pattern of SETUP_ROUTES) {
            const r = await resolveRoute(route(pattern), c);
            expect('uncaptured' in r && r.uncaptured).toMatch(/^setup failed: .+ broke$/);
        }
    });

    it('fills every one once the setup made its record and minted its token', async () => {
        const setup: SetupOutcome = {
            created: [], minted: [], failed: new Map(),
            tokens: { auditShare: 's', tenantInvite: 'ti', orgInvite: 'oi', vendorAssessment: { assessmentId: 'va-1', token: 'tok/+=' } },
        };
        const c = ctx({ ...EVERYTHING, integrationConnection: { id: 'c1' } }, setup);
        const urls = await Promise.all(SETUP_ROUTES.map(async (p) => resolveRoute(route(p), c)));
        expect(urls.filter((r) => 'uncaptured' in r)).toEqual([]);
        const url = (p: string) => (urls[SETUP_ROUTES.indexOf(p)] as { url: string }).url;
        expect(url('/audit/shared/[token]')).toBe('/audit/shared/s');
        expect(url('/invite/[token]')).toBe('/invite/ti');
        expect(url('/invite/org/[token]')).toBe('/invite/org/oi');
        // The respondent's page takes its token from `?t=`, encoded.
        expect(url('/vendor-assessment/[assessmentId]')).toBe('/vendor-assessment/va-1?t=tok%2F%2B%3D');
        // The review page shows the same assessment the link was minted for.
        expect(url('/t/[tenantSlug]/admin/vendor-assessment-reviews/[assessmentId]')).toBe('/t/acme-corp/admin/vendor-assessment-reviews/va-1');
        expect(url('/t/[tenantSlug]/agents/[agentId]')).toBe('/t/acme-corp/agents/ag1');
    });

    it('without the setup, a token route says only the setup can mint one', async () => {
        const r = await resolveRoute(route('/invite/[token]'), ctx());
        expect('uncaptured' in r && r.uncaptured).toMatch(/--create-records/);
    });
});
