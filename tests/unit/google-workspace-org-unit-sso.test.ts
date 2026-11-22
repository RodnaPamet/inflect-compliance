/**
 * Google Workspace `sso_enforced`, and the tenant it could never pass for
 * (#5571).
 *
 * ═══ WHAT WAS WRONG ═══
 *
 * A customer enforcing SAML for their whole Workspace does it through the ROOT
 * org unit, so the assignment carries a `targetOrgUnit` and the reader's only
 * customer-wide test —
 *
 *     if (!a.targetOrgUnit && !a.targetGroup) customerWide = true;
 *
 * — was false. Every account got `ssoEnrolled: null`, `known` was empty, and
 * the check summarised to NOT_APPLICABLE permanently. The outcome was inverted
 * with respect to effort: a tenant with NO SSO got a clean FAILED verdict, and
 * one that had enforced it tenant-wide got silence.
 *
 * ═══ WHY IT SURVIVED, WHICH IS THE PART WORTH KEEPING IN MIND ═══
 *
 * Every fixture in the tree supplied `{ ssoMode: 'SAML_SSO' }` with no target
 * at all — the one shape that sets `customerWide` — and one of those tests is
 * named "derives coverage from the live inboundSsoAssignments endpoint (real
 * fetchSsoCoverage)". So the customer-wide path was well covered against a
 * response shape a real directory need not ever produce. The double was more
 * permissive than the API, which is the same failure as #5564, where a
 * `doFetch` double RETURNED a 404 that the real transport THROWS.
 *
 * Those fixtures are left alone — an assignment with no target is still
 * customer-wide if Google emits one — and the cases below are the ones nothing
 * expressed.
 */
jest.mock('@/lib/observability/logger', () => ({
    logger: { trace: jest.fn(), debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), fatal: jest.fn() },
}));
import { logger } from '@/lib/observability/logger';
import {
    GoogleWorkspaceProvider,
    buildOrgUnitPaths,
    orgUnitCovers,
    googleSsoVerdict,
    getGoogleAccessToken,
    GWS_SYNC_SCOPE,
    GWS_ORG_UNIT_SCOPE,
} from '@/app-layer/integrations/providers/google-workspace';

function resp(body: unknown, opts: { ok?: boolean; status?: number } = {}) {
    const { ok = true, status = 200 } = opts;
    return {
        ok,
        status,
        json: async () => body,
        headers: { get: () => null },
    } as unknown as Response;
}

const cfg = { domain: 'acme.com', adminEmail: 'admin@acme.com' };

/** `/Engineering` and `/Sales` under a root whose id the API never returns. */
const UNITS = [
    { orgUnitId: 'id:eng', orgUnitPath: '/Engineering', parentOrgUnitId: 'id:root', parentOrgUnitPath: '/' },
    { orgUnitId: 'id:sales', orgUnitPath: '/Sales', parentOrgUnitId: 'id:root', parentOrgUnitPath: '/' },
    { orgUnitId: 'id:eng-plat', orgUnitPath: '/Engineering/Platform', parentOrgUnitId: 'id:eng', parentOrgUnitPath: '/Engineering' },
];

const USERS = [
    { id: 'g1', primaryEmail: 'eng@acme.com', orgUnitPath: '/Engineering' },
    { id: 'g2', primaryEmail: 'plat@acme.com', orgUnitPath: '/Engineering/Platform' },
    { id: 'g3', primaryEmail: 'sales@acme.com', orgUnitPath: '/Sales' },
];

interface ProviderOpts {
    assignments: Array<{ ssoMode?: string; targetOrgUnit?: string; targetGroup?: string }>;
    enrichOrgUnits?: boolean;
    units?: typeof UNITS;
    orgUnitsFail?: boolean;
}

/** The provider over the real `fetchSsoCoverage` and the real org-unit read. */
function gws(opts: ProviderOpts) {
    const fetchImpl = jest.fn(async (url: string | URL) => {
        const u = String(url);
        if (u.includes('/admin/directory/v1/users')) return resp({ users: USERS });
        if (u.includes('/inboundSsoAssignments')) return resp({ inboundSsoAssignments: opts.assignments });
        if (u.includes('/orgunits')) {
            if (opts.orgUnitsFail) return resp({}, { ok: false, status: 403 });
            return resp({ organizationUnits: opts.units ?? UNITS });
        }
        return resp({}, { ok: false, status: 404 });
    });
    const provider = new GoogleWorkspaceProvider({
        getAccessToken: async () => 'tok',
        fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const config = { ...cfg, ...(opts.enrichOrgUnits ? { enrichOrgUnits: 'true' } : {}) };
    return { provider, config, fetchImpl };
}

const byEmail = (accounts: Array<{ email: string; ssoEnrolled: boolean | null }>) =>
    Object.fromEntries(accounts.map((a) => [a.email, a.ssoEnrolled]));

// ── the root OU, which is the whole point ───────────────────────────────

describe('a SAML assignment on the ROOT org unit is tenant-wide coverage', () => {
    it('marks every account enrolled, where it used to mark every account unknown', async () => {
        const { provider, config } = gws({
            assignments: [{ ssoMode: 'SAML_SSO', targetOrgUnit: 'orgUnits/id:root' }],
            enrichOrgUnits: true,
        });

        const { accounts } = await provider.listAccounts(config);

        expect(byEmail(accounts)).toEqual({
            'eng@acme.com': true,
            'plat@acme.com': true,
            'sales@acme.com': true,
        });
    });

    it('and leaves them UNKNOWN when the enrichment is not opted into', async () => {
        // The pre-#5571 answer, kept deliberately: the org-unit read needs a
        // scope the customer authorises, so a connection that has not opted in
        // must behave exactly as it did before.
        const { provider, config, fetchImpl } = gws({
            assignments: [{ ssoMode: 'SAML_SSO', targetOrgUnit: 'orgUnits/id:root' }],
        });

        const { accounts } = await provider.listAccounts(config);

        expect(byEmail(accounts)).toEqual({
            'eng@acme.com': null,
            'plat@acme.com': null,
            'sales@acme.com': null,
        });
        // And it does not reach for a scope nobody granted.
        expect(fetchImpl.mock.calls.map((c) => String(c[0])).some((u) => u.includes('/orgunits'))).toBe(false);
    });
});

// ── a partial rollout, per account ──────────────────────────────────────

describe('a departmental rollout is reported per account', () => {
    it('covers the targeted unit and everything under it, and nothing beside it', async () => {
        const { provider, config } = gws({
            assignments: [{ ssoMode: 'SAML_SSO', targetOrgUnit: 'orgUnits/id:eng' }],
            enrichOrgUnits: true,
        });

        const { accounts } = await provider.listAccounts(config);

        expect(byEmail(accounts)).toEqual({
            'eng@acme.com': true,
            // DESCENDANT. A rollout on /Engineering covers /Engineering/Platform.
            'plat@acme.com': true,
            // And Sales is a positive NOT-enrolled: every assignment resolved
            // and none covers it, so `sso_enforced` can name this account.
            'sales@acme.com': false,
        });
    });

    it('a group-targeted assignment makes the uncovered accounts UNKNOWN, not failing', async () => {
        // The fail-closed reading. This sync does not read group memberships,
        // so an account outside every covered OU may still be federated via a
        // group — and `false` is a positive claim that would name a real person
        // in a FAILED control.
        const { provider, config } = gws({
            assignments: [
                { ssoMode: 'SAML_SSO', targetOrgUnit: 'orgUnits/id:eng' },
                { ssoMode: 'SAML_SSO', targetGroup: 'groups/contractors' },
            ],
            enrichOrgUnits: true,
        });

        const { accounts } = await provider.listAccounts(config);

        expect(byEmail(accounts)).toEqual({
            'eng@acme.com': true,
            'plat@acme.com': true,
            'sales@acme.com': null,
        });
    });

    it('an unresolvable OU target makes the uncovered accounts UNKNOWN too', async () => {
        const { provider, config } = gws({
            assignments: [{ ssoMode: 'SAML_SSO', targetOrgUnit: 'orgUnits/id:does-not-exist' }],
            enrichOrgUnits: true,
        });

        const { accounts } = await provider.listAccounts(config);

        expect(Object.values(byEmail(accounts))).toEqual([null, null, null]);
    });
});

// ── the enrichment only ever refines ────────────────────────────────────

describe('a failed org-unit read costs only the enrichment', () => {
    beforeEach(() => {
        for (const fn of Object.values(logger)) (fn as jest.Mock).mockClear();
    });

    it('says so in the log, which is the only surface that can explain the silence', async () => {
        // Without this the inner catch is indistinguishable from the outer one:
        // both leave the same verdicts, so no test could tell whether the
        // enrichment's own isolation existed. An administrator who ticked the
        // box without authorising the scope needs this line.
        const { provider, config } = gws({
            assignments: [{ ssoMode: 'SAML_SSO', targetOrgUnit: 'orgUnits/id:root' }],
            enrichOrgUnits: true,
            orgUnitsFail: true,
        });

        await provider.listAccounts(config);

        expect(logger.warn as jest.Mock).toHaveBeenCalledTimes(1);
        const [message, fields] = (logger.warn as jest.Mock).mock.calls[0] as [string, Record<string, unknown>];
        expect(message).toMatch(/org-unit SSO resolution failed/);
        expect(fields.component).toBe('google-workspace');
        // The reason, and nothing about a person or a unit.
        expect(String(fields.error)).toMatch(/403/);
        expect(JSON.stringify(fields)).not.toMatch(/acme\.com|orgUnits|tok/);
    });

    it('and logs NOTHING on a healthy read — the line means something', async () => {
        const { provider, config } = gws({
            assignments: [{ ssoMode: 'SAML_SSO', targetOrgUnit: 'orgUnits/id:root' }],
            enrichOrgUnits: true,
        });
        await provider.listAccounts(config);
        expect(logger.warn as jest.Mock).not.toHaveBeenCalled();
    });

    it('falls back to the coarse verdict rather than throwing or claiming coverage', async () => {
        // The scope not authorised is the expected case, and it must be no
        // worse than not having opted in.
        const { provider, config } = gws({
            assignments: [{ ssoMode: 'SAML_SSO', targetOrgUnit: 'orgUnits/id:root' }],
            enrichOrgUnits: true,
            orgUnitsFail: true,
        });

        const { accounts } = await provider.listAccounts(config);

        expect(accounts).toHaveLength(3);
        expect(Object.values(byEmail(accounts))).toEqual([null, null, null]);
    });

    it('an EMPTY org-unit list resolves nothing — it does not read as "root only"', async () => {
        // The tempting inference: no sub-units means the only unit is the root,
        // so any target must be it. Refused, because it fails in the direction
        // that matters — a response that lost its `organizationUnits` key for
        // any other reason would mark every account enrolled and turn this
        // control into a guaranteed pass.
        const { provider, config } = gws({
            assignments: [{ ssoMode: 'SAML_SSO', targetOrgUnit: 'orgUnits/id:root' }],
            enrichOrgUnits: true,
            units: [],
        });

        const { accounts } = await provider.listAccounts(config);

        expect(Object.values(byEmail(accounts))).toEqual([null, null, null]);
    });
});

// ── the scope isolation, which is what keeps the sync safe ──────────────

describe('the org-unit scope is never asked for alongside the sync scopes', () => {
    /** Decode the `scope` claim out of the assertion in the token request. */
    async function scopeInAssertion(scope?: string): Promise<string> {
        let body = '';
        const doFetch = (async (_url: string, init?: { body?: unknown }) => {
            body = String(init?.body ?? '');
            return resp({ access_token: 'tok' });
        }) as unknown as typeof fetch;
        const sa = {
            client_email: 'svc@acme.iam.gserviceaccount.com',
            // A throwaway key, generated for this test only.
            private_key: (await import('node:crypto'))
                .generateKeyPairSync('rsa', { modulusLength: 2048 })
                .privateKey.export({ type: 'pkcs8', format: 'pem' })
                .toString(),
        };
        const config = { adminEmail: 'admin@acme.com', serviceAccountJson: JSON.stringify(sa) };
        await (scope === undefined
            ? getGoogleAccessToken(config, doFetch)
            : getGoogleAccessToken(config, doFetch, scope));
        const assertion = new URLSearchParams(body).get('assertion') ?? '';
        const claim = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString()) as {
            scope: string;
        };
        return claim.scope;
    }

    it('the default exchange asks for the two sync scopes and nothing else', async () => {
        const scope = await scopeInAssertion();
        expect(scope).toBe(GWS_SYNC_SCOPE);
        // THE ASSERTION THAT MATTERS. Appending the org-unit scope here would
        // risk a token-endpoint refusal, which `fetchOAuthToken` turns into an
        // `IntegrationAuthError` — marking the connection credential-failed and
        // taking the directory sync, the freshness surface and the leaver pass
        // with it, for every customer who had not re-authorised.
        expect(scope).not.toContain('orgunit');
    });

    it('the org-unit exchange asks for ONLY the org-unit scope', async () => {
        const scope = await scopeInAssertion(GWS_ORG_UNIT_SCOPE);
        expect(scope).toBe(GWS_ORG_UNIT_SCOPE);
        expect(scope).not.toContain('admin.directory.user.readonly');
    });
});

// ── the pure rules ──────────────────────────────────────────────────────

describe('buildOrgUnitPaths derives the root the API never returns', () => {
    it('reads the root id off the parent of the top-level units', () => {
        const { pathById, rootId } = buildOrgUnitPaths(UNITS);
        expect(rootId).toBe('id:root');
        expect(pathById.get('id:root')).toBe('/');
        expect(pathById.get('id:eng-plat')).toBe('/Engineering/Platform');
    });

    it('refuses to guess when the units disagree about their parent', () => {
        const { rootId } = buildOrgUnitPaths([
            { orgUnitId: 'a', orgUnitPath: '/A', parentOrgUnitId: 'id:root', parentOrgUnitPath: '/' },
            { orgUnitId: 'b', orgUnitPath: '/B', parentOrgUnitId: 'id:other', parentOrgUnitPath: '/' },
        ]);
        expect(rootId).toBeNull();
    });

    it('resolves nothing from an empty list', () => {
        const { pathById, rootId } = buildOrgUnitPaths([]);
        expect(rootId).toBeNull();
        expect(pathById.size).toBe(0);
    });
});

describe('orgUnitCovers compares whole segments', () => {
    it('the root covers everything', () => {
        expect(orgUnitCovers(['/'], '/Engineering/Platform')).toBe(true);
        expect(orgUnitCovers(['/'], '/')).toBe(true);
    });

    it('a unit covers itself and its descendants', () => {
        expect(orgUnitCovers(['/Eng'], '/Eng')).toBe(true);
        expect(orgUnitCovers(['/Eng'], '/Eng/Platform')).toBe(true);
    });

    it('and NOT a unit that merely shares its name prefix', () => {
        // `/Eng`.startsWith on the raw string would report this as covered,
        // marking a whole unrelated unit SSO-enrolled on a spelling accident.
        expect(orgUnitCovers(['/Eng'], '/Engineering')).toBe(false);
        expect(orgUnitCovers(['/Sales'], '/SalesOps')).toBe(false);
    });
});

describe('googleSsoVerdict fails closed on what it cannot see', () => {
    const base = { coveredPaths: [] as string[], unresolvedOuTarget: false, accountOrgUnitPath: '/Sales' };

    it('customer-wide beats everything', () => {
        expect(googleSsoVerdict({ ...base, coverage: { customerWide: true, hasSaml: true } })).toBe(true);
    });

    it('no SAML at all is a positive NOT enrolled', () => {
        expect(googleSsoVerdict({ ...base, coverage: { customerWide: false, hasSaml: false } })).toBe(false);
    });

    it('an account with no reported path is unknown, never assumed to be in the root', () => {
        // Treating an absent field as `/` would turn a projection change into a
        // tenant-wide pass.
        expect(
            googleSsoVerdict({
                ...base,
                accountOrgUnitPath: undefined,
                coverage: { customerWide: false, hasSaml: true },
            }),
        ).toBeNull();
    });

    it('resolved and uncovered is false; unresolved or group-targeted is null', () => {
        const coverage = { customerWide: false, hasSaml: true };
        expect(googleSsoVerdict({ ...base, coverage })).toBe(false);
        expect(googleSsoVerdict({ ...base, coverage, unresolvedOuTarget: true })).toBeNull();
        expect(
            googleSsoVerdict({ ...base, coverage: { ...coverage, hasGroupTargetedSaml: true } }),
        ).toBeNull();
    });
});
