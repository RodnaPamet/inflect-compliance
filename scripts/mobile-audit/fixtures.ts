/**
 * The audit's fixture SETUP step (`--create-records`): before anything is
 * measured, create through the product's own API the records the seed lacks,
 * and mint the tokens the public pages are opened with, so every detail page
 * has something to show.
 *
 * It WRITES to the app's database, as the seeded tenant owner and org owner,
 * through the same routes a person would use — never raw SQL, so every record
 * passes the usecase's invariants (an agent has an accountable owner, a peer a
 * vendor and a signing key, a share link a frozen pack). It is opt-in and meant
 * for a throwaway audit database, never a shared one.
 *
 * IDEMPOTENT. A record is created only when the database holds none of its
 * kind (`exists`), so a second run adds no record. A TOKEN is different: the
 * product stores only its hash, so no run can read back a token an earlier run
 * minted, and each run mints one. Each mint is bounded: the invites are upserts
 * on a fixed address (the token rotates, no row is added), the vendor
 * assessment is resent rather than sent again, and the share link expires.
 *
 * FAIL CLOSED. A fixture that fails is recorded with its reason
 * (`SetupOutcome.failed`) and never thrown or skipped silently: `resolve.ts`
 * reports every route that needed it as "setup failed: <why>", and the summary
 * lists the failure. A route that renders nothing is never counted as clean.
 */
import { generateKeyPairSync } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import type { ResolveContext } from './resolve';

/** The tokens minted this run, raw. Only their hashes are stored. */
export interface MintedTokens {
    auditShare?: string;
    tenantInvite?: string;
    orgInvite?: string;
    vendorAssessment?: { assessmentId: string; token: string };
}

export interface SetupOutcome {
    /** Fixtures whose record this run created. */
    created: string[];
    /** Fixtures whose token this run minted. */
    minted: string[];
    /** Fixture → why it failed. */
    failed: Map<string, string>;
    tokens: MintedTokens;
}

/** The product's API, as the signed-in person. Each call throws on a non-2xx answer. */
export interface FixtureApi {
    get: <T = unknown>(path: string) => Promise<T>;
    post: <T = { id: string }>(path: string, data?: unknown) => Promise<T>;
    put: <T = unknown>(path: string, data: unknown) => Promise<T>;
}

interface FixtureEnv {
    api: FixtureApi;
    c: ResolveContext;
    tokens: MintedTokens;
    /** The signed-in tenant owner's user id, read from their session. */
    ownerUserId: () => Promise<string>;
}

export interface Fixture {
    /** The fixture's name. `resolve.ts` names the same string for the routes that need it. */
    what: string;
    audience: 'tenant' | 'org';
    /**
     * When present, the fixture runs only while this says the database holds
     * none. When absent, it runs every time: it mints a token.
     */
    exists?: (c: ResolveContext) => Promise<boolean>;
    run: (env: FixtureEnv) => Promise<void>;
}

/** The address every audit invite goes to. Fixed, so a re-run rotates one invite rather than adding another. */
export const AUDIT_INVITEE = 'mobile-audit-invitee@example.com';
export const AUDIT_ORG_INVITEE = 'mobile-audit-org-invitee@example.com';
export const AUDIT_VENDOR_RESPONDENT = 'mobile-audit-respondent@example.com';
/** `.invalid` never resolves (RFC 2606): the peer's card is unreadable, so its key is pasted. */
export const AUDIT_PEER_CARD_URL = 'https://mobile-audit-peer.example.invalid/.well-known/agent-card.json';

/** A share link outlives the run, and not much more. */
const SHARE_LIFETIME_MS = 2 * 24 * 60 * 60 * 1000;

/** The raw token at the end of an `/invite/…/<token>` URL the API returns. */
export function tokenFromUrl(url: unknown, prefix: string): string {
    if (typeof url !== 'string' || !url.startsWith(prefix)) throw new Error(`expected a URL under ${prefix}, got ${JSON.stringify(url)}`);
    const token = url.slice(prefix.length).split(/[/?#]/)[0];
    if (!token) throw new Error(`no token in ${url}`);
    return decodeURIComponent(token);
}

/** A fresh Ed25519 public key, raw 32 bytes as hex: what the peer register takes when the card cannot be read. */
function ed25519PublicKeyHex(): string {
    const { publicKey } = generateKeyPairSync('ed25519');
    return publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
}

async function firstVendorId({ db, tenantId }: ResolveContext): Promise<string> {
    const vendor = await db.vendor.findFirst({ where: { tenantId, deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    if (!vendor) throw new Error('needs a vendor, and the database holds none');
    return vendor.id;
}

/**
 * In order: a fixture may need one above it (a peer needs a vendor, its
 * connection needs the peer). When the one above failed, the one below fails
 * too, naming what it needed.
 */
export const FIXTURES: readonly Fixture[] = [
    {
        what: 'vendor',
        audience: 'tenant',
        exists: async ({ db, tenantId }) => !!(await db.vendor.findFirst({ where: { tenantId, deletedAt: null }, select: { id: true } })),
        run: async ({ api, c }) => {
            await api.post(`/api/t/${c.tenantSlug}/vendors`, { name: 'Northwind Cloud Hosting', criticality: 'HIGH', description: 'Primary infrastructure provider.' });
        },
    },
    {
        what: 'incident',
        audience: 'tenant',
        exists: async ({ db, tenantId }) => !!(await db.incident.findFirst({ where: { tenantId }, select: { id: true } })),
        run: async ({ api, c }) => {
            await api.post(`/api/t/${c.tenantSlug}/incidents`, { title: 'Phishing campaign against the finance team', severity: 'HIGH', incidentType: 'UNAUTHORIZED_ACCESS', description: 'Three users reported a credential-harvesting email.' });
        },
    },
    {
        what: 'business impact analysis',
        audience: 'tenant',
        exists: async ({ db, tenantId }) => !!(await db.businessImpactAnalysis.findFirst({ where: { tenantId }, select: { id: true } })),
        run: async ({ api, c }) => {
            await api.post(`/api/t/${c.tenantSlug}/business-continuity`, { name: 'Customer payments processing', criticality: 'HIGH', rtoHours: 4, rpoHours: 1, mtpdHours: 24 });
        },
    },
    {
        what: 'AI system',
        audience: 'tenant',
        exists: async ({ db, tenantId }) => !!(await db.aiSystem.findFirst({ where: { tenantId, deletedAt: null }, select: { id: true } })),
        run: async ({ api, c }) => {
            await api.post(`/api/t/${c.tenantSlug}/ai-systems`, { name: 'Support ticket triage assistant', purpose: 'Routes inbound support tickets.', provider: 'Internal' });
        },
    },
    {
        what: 'evidence',
        audience: 'tenant',
        exists: async ({ db, tenantId }) => !!(await db.evidence.findFirst({ where: { tenantId, deletedAt: null }, select: { id: true } })),
        run: async ({ api, c }) => {
            await api.post(`/api/t/${c.tenantSlug}/evidence`, { type: 'TEXT', title: 'Quarterly access review sign-off', content: 'Signed off by the CISO.' });
        },
    },
    {
        what: 'control test plan and run',
        audience: 'tenant',
        exists: async ({ db, tenantId }) => !!(await db.controlTestRun.findFirst({ where: { tenantId }, select: { id: true } })),
        run: async ({ api, c }) => {
            const control = await c.db.control.findFirst({ where: { tenantId: c.tenantId, deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true } });
            if (!control) throw new Error('needs a control to attach a test plan to, and the database holds none');
            const plan = await api.post(`/api/t/${c.tenantSlug}/controls/${control.id}/tests/plans`, {
                name: 'Quarterly review of privileged access to production',
                frequency: 'QUARTERLY',
                steps: [{ instruction: 'Export the list of privileged accounts', expectedOutput: 'A CSV of accounts' }],
            });
            await api.post(`/api/t/${c.tenantSlug}/tests/plans/${plan.id}/runs`, {});
        },
    },
    {
        what: 'access review',
        audience: 'tenant',
        exists: async ({ db, tenantId }) => !!(await db.accessReview.findFirst({ where: { tenantId, deletedAt: null }, select: { id: true } })),
        run: async ({ api, c, ownerUserId }) => {
            await api.post(`/api/t/${c.tenantSlug}/access-reviews`, { name: 'Q4 user access review', reviewerUserId: await ownerUserId() });
        },
    },
    {
        what: 'registered agent',
        audience: 'tenant',
        exists: async ({ db, tenantId }) => !!(await db.registeredAgent.findFirst({ where: { tenantId, deletedAt: null }, select: { id: true } })),
        run: async ({ api, c, ownerUserId }) => {
            // As `tests/e2e/agentic-surface-with-data.spec.ts` registers one.
            await api.post(`/api/t/${c.tenantSlug}/admin/agents`, {
                name: 'Supplier review assistant',
                description: 'Reads supplier evidence and drafts the review for a person to decide.',
                autonomyLevel: 2,
                dataAccessScope: 'READ_TENANT_DATA',
                reversibility: 'REVERSIBLE',
                provenance: 'FIRST_PARTY',
                ownerUserId: await ownerUserId(),
                classification: {},
            });
        },
    },
    {
        what: 'workflow run',
        audience: 'tenant',
        exists: async ({ db, tenantId }) => !!(await db.workflowRun.findFirst({ where: { tenantId }, select: { id: true } })),
        run: async ({ api, c }) => {
            // `diagnostic` is the registry's smallest definition, as the E2E suite starts it.
            await api.post(`/api/t/${c.tenantSlug}/agent-runs`, { workflowKey: 'diagnostic', input: {} });
        },
    },
    {
        what: 'A2A peer',
        audience: 'tenant',
        exists: async ({ db, tenantId }) => !!(await db.peerAgent.findFirst({ where: { tenantId }, select: { id: true } })),
        run: async ({ api, c, ownerUserId }) => {
            await api.post(`/api/t/${c.tenantSlug}/admin/agents/peers`, {
                name: 'Northwind procurement agent',
                cardUrl: AUDIT_PEER_CARD_URL,
                ownerUserId: await ownerUserId(),
                vendorId: await firstVendorId(c),
                signingPublicKey: ed25519PublicKeyHex(),
            });
        },
    },
    {
        // An A2A peer connection: the external-write ladder is a page of the
        // two connection kinds that write outside (MCP server and A2A peer),
        // and an A2A peer connection names a registered peer, not a server URL.
        what: 'integration connection',
        audience: 'tenant',
        exists: async ({ db, tenantId }) => !!(await db.integrationConnection.findFirst({ where: { tenantId, provider: { in: ['a2a-peer', 'mcp-server'] } }, select: { id: true } })),
        run: async ({ api, c }) => {
            const peer = await c.db.peerAgent.findFirst({ where: { tenantId: c.tenantId }, orderBy: { createdAt: 'asc' }, select: { id: true } });
            if (!peer) throw new Error('needs an A2A peer, and the database holds none');
            await api.post(`/api/t/${c.tenantSlug}/admin/integrations`, { provider: 'a2a-peer', name: 'Northwind procurement agent', configJson: { peerId: peer.id } });
        },
    },
    {
        what: 'trust center',
        audience: 'tenant',
        exists: async ({ db, tenantId }) => !!(await db.trustCenter.findFirst({ where: { tenantId, enabled: true }, select: { id: true } })),
        run: async ({ api, c }) => {
            await api.put(`/api/t/${c.tenantSlug}/admin/trust-center`, {
                displayName: 'Acme Corp Trust Center',
                tagline: 'How we protect your data.',
                securityContact: 'security@acme.example',
            });
            await api.post(`/api/t/${c.tenantSlug}/admin/trust-center/enable`, { enabled: true });
        },
    },
    {
        what: 'NIS2 gap assignment',
        audience: 'tenant',
        exists: async ({ db, tenantId }) => !!(await db.nis2GapAssignment.findFirst({ where: { tenantId }, select: { id: true } })),
        run: async ({ api, c, ownerUserId }) => {
            // A STANDALONE run is the one that can be delegated; the wizard baseline never is.
            const run = await api.post(`/api/t/${c.tenantSlug}/audits/nis2-gap/rerun`, {});
            await api.post(`/api/t/${c.tenantSlug}/gap-assessments/${run.id}/assignments`, { roleToUserId: { IT: await ownerUserId() } });
        },
    },
    {
        what: 'vendor assessment',
        audience: 'tenant',
        run: async ({ api, c, tokens }) => {
            // Resent when one is already out to the audit's respondent (which
            // rotates its token), sent otherwise: a second send for the same
            // vendor, template and respondent is refused.
            const open = await c.db.vendorAssessment.findFirst({
                where: { tenantId: c.tenantId, respondentEmail: AUDIT_VENDOR_RESPONDENT, status: { in: ['SENT', 'IN_PROGRESS'] } },
                select: { id: true },
            });
            if (open) {
                const r = await api.post<{ externalAccessToken: string }>(`/api/t/${c.tenantSlug}/vendor-assessment-reviews/${open.id}/resend`, {});
                tokens.vendorAssessment = { assessmentId: open.id, token: r.externalAccessToken };
                return;
            }
            const template = await c.db.vendorAssessmentTemplate.findFirst({
                where: { tenantId: c.tenantId, isPublished: true },
                orderBy: { createdAt: 'asc' },
                select: { id: true },
            });
            if (!template) throw new Error('needs a published vendor questionnaire, and the database holds none');
            const sent = await api.post<{ assessmentId: string; externalAccessToken: string }>(
                `/api/t/${c.tenantSlug}/vendors/${await firstVendorId(c)}/assessments/send`,
                { templateVersionId: template.id, respondentEmail: AUDIT_VENDOR_RESPONDENT },
            );
            tokens.vendorAssessment = { assessmentId: sent.assessmentId, token: sent.externalAccessToken };
        },
    },
    {
        what: 'audit share link',
        audience: 'tenant',
        run: async ({ api, c, tokens }) => {
            // A draft pack cannot be shared, so the pack is a frozen one: the
            // seed's, or one made here when the seed has none.
            let pack = await c.db.auditPack.findFirst({
                where: { tenantId: c.tenantId, deletedAt: null, status: { not: 'DRAFT' } },
                orderBy: { createdAt: 'asc' },
                select: { id: true },
            });
            if (!pack) {
                const cycle = await c.db.auditCycle.findFirst({ where: { tenantId: c.tenantId, deletedAt: null }, orderBy: { createdAt: 'asc' }, select: { id: true } });
                if (!cycle) throw new Error('needs an audit cycle to make a pack in, and the database holds none');
                const made = await api.post(`/api/t/${c.tenantSlug}/audits/packs`, { auditCycleId: cycle.id, name: 'Mobile audit shared pack' });
                await api.post(`/api/t/${c.tenantSlug}/audits/packs/${made.id}?action=freeze`, {});
                pack = { id: made.id };
            }
            const share = await api.post<{ token: string }>(`/api/t/${c.tenantSlug}/audits/packs/${pack.id}?action=share`, {
                expiresAt: new Date(Date.now() + SHARE_LIFETIME_MS).toISOString(),
            });
            if (!share.token) throw new Error('the share answered without a token');
            tokens.auditShare = share.token;
        },
    },
    {
        what: 'tenant invite',
        audience: 'tenant',
        run: async ({ api, c, tokens }) => {
            const r = await api.post<{ url: string }>(`/api/t/${c.tenantSlug}/admin/invites`, { email: AUDIT_INVITEE, role: 'READER' });
            tokens.tenantInvite = tokenFromUrl(r.url, '/invite/');
        },
    },
    {
        what: 'org security initiative',
        audience: 'org',
        exists: async ({ db, orgId }) => !orgId || !!(await db.orgSecurityInitiative.findFirst({ where: { organizationId: orgId }, select: { id: true } })),
        run: async ({ api, c }) => {
            await api.post(`/api/org/${c.orgSlug}/initiatives`, { title: 'Roll out phishing-resistant MFA' });
        },
    },
    {
        what: 'org invite',
        audience: 'org',
        run: async ({ api, c, tokens }) => {
            if (!c.orgId) throw new Error(`the database holds no organisation ${c.orgSlug}`);
            const r = await api.post<{ url: string }>(`/api/org/${c.orgSlug}/invites`, { email: AUDIT_ORG_INVITEE, role: 'ORG_READER' });
            tokens.orgInvite = tokenFromUrl(r.url, '/invite/org/');
        },
    },
];

export function apiFor(request: APIRequestContext): FixtureApi {
    const answer = async <T>(method: string, path: string, res: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> => {
        if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()} ${(await res.text()).slice(0, 200)}`);
        return (await res.json()) as T;
    };
    const json = { 'Content-Type': 'application/json' };
    return {
        get: async <T>(path: string) => answer<T>('GET', path, await request.get(path)),
        post: async <T>(path: string, data: unknown = {}) => answer<T>('POST', path, await request.post(path, { data, headers: json })),
        put: async <T>(path: string, data: unknown) => answer<T>('PUT', path, await request.put(path, { data, headers: json })),
    };
}

function messageOf(e: unknown): string {
    return (e instanceof Error ? e.message : String(e)).split('\n')[0];
}

/**
 * Run every fixture in order, as the tenant owner (`tenantApi`) or the org
 * owner (`orgApi`). Never throws: a fixture's failure is its entry in
 * `failed`, and the fixtures after it still run.
 */
export async function setUpAuditFixtures(
    tenantApi: FixtureApi,
    orgApi: FixtureApi,
    c: ResolveContext,
    fixtures: readonly Fixture[] = FIXTURES,
): Promise<SetupOutcome> {
    const outcome: SetupOutcome = { created: [], minted: [], failed: new Map(), tokens: {} };
    let owner: Promise<string> | null = null;
    const ownerUserId = () => {
        owner ??= tenantApi.get<{ user?: { id?: string } }>('/api/auth/session').then((s) => {
            if (!s?.user?.id) throw new Error('the tenant session names no user');
            return s.user.id;
        });
        return owner;
    };
    for (const f of fixtures) {
        try {
            if (f.exists && (await f.exists(c))) continue;
            await f.run({ api: f.audience === 'org' ? orgApi : tenantApi, c, tokens: outcome.tokens, ownerUserId });
            (f.exists ? outcome.created : outcome.minted).push(f.what);
        } catch (e) {
            outcome.failed.set(f.what, messageOf(e));
            console.warn(`[mobile-audit] setup: ${f.what} failed: ${messageOf(e)}`);
        }
    }
    return outcome;
}
