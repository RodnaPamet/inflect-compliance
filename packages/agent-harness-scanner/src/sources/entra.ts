/**
 * THE ENTRA SOURCE — `entra-sp` (#3686, owner decisions 2026-10-19).
 *
 * The non-human principals of one Entra directory, read from Microsoft Graph:
 * its service principals, and the application registrations behind them.
 *
 * WHICH SERVICE PRINCIPALS ARE AGENTS (owner decision 1 on #3686):
 *
 *   • an `Application` service principal whose application is registered in
 *     THIS directory (`appOwnerOrganizationId` is the directory's own id);
 *   • every `ManagedIdentity`;
 *   • a third-party application's service principal only when the estate opts
 *     in (`includeThirdPartyApplications`). Microsoft's own first-party
 *     applications are never reported: they are the platform, not the estate.
 *
 * Everything else (`Legacy`, `SocialIdp`, a disabled principal) is read and
 * counted in `rows`, and reported as nothing. A disabled principal cannot
 * authenticate, which is the vault reader's rule for a disabled secret too.
 *
 * WHAT IS REPORTED FOR EACH:
 *
 *   • `discoveredId` `entra:sp:<objectId>`, the id the rest of the harness
 *     already uses (the 2c disable, the confirmed links);
 *   • its credentials BY REFERENCE: the password and certificate credentials on
 *     its application registration and on the service principal itself, with
 *     age and expiry. A certificate used only to sign tokens (`usage: Sign`, a
 *     SAML signing certificate) is not a credential the principal signs in
 *     with, and is left out. A managed identity's credential is held by Azure
 *     and never listed, so it reports none;
 *   • its owner: the first user (by object id) among the application's owners,
 *     else among the service principal's. A service principal that owns
 *     another is not a person, and is not an owner here;
 *   • `H2.credential_bound`, met, when it signs in with a credential of its own
 *     or is a managed identity. The grant kind is NOT reported: whether a
 *     credential acts for a person or as the application is decided by the
 *     permissions granted to it, which this source does not read, so each
 *     credential's `grant` is `unknown` and `H2.grant_kind_declared` stays
 *     unanswered.
 *
 * UNBOUND CREDENTIALS. A credential on an application registration that has
 * no service principal in this directory signs in as nothing here: it is the
 * `/2` report's `unboundCredentials[]`, from which the ingest derives
 * ORPHAN_CREDENTIAL. An application whose principal exists but is disabled or
 * not reported is neither: its credentials are that principal's.
 *
 * READ-ONLY. Two Graph listings by GET, `/v1.0/applications` and
 * `/v1.0/servicePrincipals`, after the one client-credentials exchange for a
 * Graph token. The identity it reads with needs `Application.Read.All` and
 * nothing more. Graph returns each password credential's `hint` (the first
 * characters of the secret) and free-text `displayName`s with the members
 * this source asks for; neither is read, and both are dropped with the page.
 * A test holds a marker in each out of the report and the log.
 */
import { MAX_AGENTS } from '@/lib/agentic/harness-contract';

import {
    ageInDays,
    isPlainId,
    readPages,
    sourceResult,
    SourceReadError,
    type HarnessSource,
    type Observation,
    type ObservedCredential,
    type SourceContext,
    type SourceRead,
} from '../source';
import { AZURE_LOGIN_ORIGIN } from './azure-key-vault';

/** Microsoft Graph, public cloud. A sovereign cloud is refused by the configuration rather than guessed at. */
export const GRAPH_ORIGIN = 'https://graph.microsoft.com';
/** The two listings this source reads. `scanner-surface.ts` declares them for the manifest hash. */
export const ENTRA_READ_PATHS = ['/v1.0/applications', '/v1.0/servicePrincipals'] as const;
export const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

/**
 * The directories Microsoft publishes its own first-party applications from.
 * A service principal of an application owned by one of these is the platform,
 * never an agent of the estate's, even when third-party applications are in.
 */
export const MICROSOFT_APP_OWNER_TENANTS: ReadonlySet<string> = new Set([
    'f8cdef31-a31e-4b4a-93e4-5f571e91255a',
    '72f988bf-86f1-41af-91ab-2d7cd011db47',
]);

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface EntraSourceOptions {
    /** The directory's id, a GUID: the one `appOwnerOrganizationId` is compared with. */
    readonly directoryId: string;
    readonly clientId: string;
    /** Resolved from the environment by the caller. */
    readonly clientSecret: string;
    readonly includeThirdPartyApplications: boolean;
}

/** Graph's page size when `$expand` is present. */
const PAGE_SIZE = '100';

interface GraphCredential {
    keyId?: unknown;
    startDateTime?: unknown;
    endDateTime?: unknown;
    usage?: unknown;
}

interface GraphDirectoryObject {
    id?: unknown;
    '@odata.type'?: unknown;
}

interface GraphApplication {
    id?: unknown;
    appId?: unknown;
    passwordCredentials?: unknown;
    keyCredentials?: unknown;
    owners?: unknown;
}

interface GraphServicePrincipal {
    id?: unknown;
    appId?: unknown;
    servicePrincipalType?: unknown;
    appOwnerOrganizationId?: unknown;
    accountEnabled?: unknown;
    passwordCredentials?: unknown;
    keyCredentials?: unknown;
    owners?: unknown;
}

const guid = (v: unknown): string | null => (typeof v === 'string' && GUID.test(v.toLowerCase()) ? v.toLowerCase() : null);

function dateOrNull(v: unknown): Date | null {
    if (typeof v !== 'string') return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** One Graph listing page: `{ value: [...], '@odata.nextLink'? }`. */
function graphPage(body: unknown): { items: readonly unknown[]; next: string | null } | null {
    if (body === null || typeof body !== 'object') return null;
    const { value } = body as { value?: unknown };
    const next = (body as Record<string, unknown>)['@odata.nextLink'];
    if (!Array.isArray(value)) return null;
    if (next !== undefined && next !== null && typeof next !== 'string') return null;
    return { items: value, next: typeof next === 'string' && next !== '' ? next : null };
}

/** An array member of a Graph object, or `[]` when absent. A member of any other shape tears the page. */
function arrayMember(v: unknown): readonly unknown[] {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new SourceReadError('PAGINATION_TORN', 'a listed object had a malformed collection');
    return v;
}

/** The credentials one Graph object holds, by reference under `base`. Sign-only certificates are not sign-in credentials. */
function credentialsOf(obj: GraphApplication | GraphServicePrincipal, base: string, asOf: Date): ObservedCredential[] {
    const out: ObservedCredential[] = [];
    const add = (raw: unknown, kind: 'password' | 'certificate') => {
        const c = raw as GraphCredential | null;
        const keyId = guid(c?.keyId);
        if (keyId === null) throw new SourceReadError('PAGINATION_TORN', 'a credential had no usable key id');
        if (kind === 'certificate' && c?.usage !== 'Verify') return;
        out.push({
            ref: `${base}/${kind}/${keyId}`,
            ageDays: ageInDays(dateOrNull(c?.startDateTime), asOf),
            expires: dateOrNull(c?.endDateTime) !== null,
            boundToAgent: true,
            grant: 'unknown',
        });
    };
    for (const c of arrayMember(obj.passwordCredentials)) add(c, 'password');
    for (const c of arrayMember(obj.keyCredentials)) add(c, 'certificate');
    return out;
}

/** The first user, by object id, among a Graph object's expanded owners; null when none is a user. */
function firstUserOwner(owners: unknown): string | null {
    const users = arrayMember(owners)
        .filter((o) => (o as GraphDirectoryObject | null)?.['@odata.type'] === '#microsoft.graph.user')
        .map((o) => guid((o as GraphDirectoryObject).id))
        .filter((id): id is string => id !== null)
        .sort();
    return users[0] ?? null;
}

export function entraSource(opts: EntraSourceOptions): HarnessSource {
    const directoryId = opts.directoryId.toLowerCase();

    return {
        kind: 'entra-sp',
        product: 'entra',
        async read(ctx: SourceContext): Promise<SourceRead> {
            const observations: Observation[] = [];
            let rows = 0;
            const unbound: string[] = [];
            try {
                const token = await ctx.tokens.clientCredentials({
                    tokenUrl: `${AZURE_LOGIN_ORIGIN}/${directoryId}/oauth2/v2.0/token`,
                    origin: AZURE_LOGIN_ORIGIN,
                    clientId: opts.clientId,
                    clientSecret: opts.clientSecret,
                    scope: GRAPH_SCOPE,
                });
                const headers = { Authorization: `Bearer ${token}` };
                const listing = (path: string, select: string) =>
                    `${GRAPH_ORIGIN}${path}?$select=${encodeURIComponent(select)}` +
                    `&$expand=${encodeURIComponent('owners($select=id)')}&$top=${PAGE_SIZE}`;

                // Application registrations first: their credentials and owners
                // belong to the service principal of the same appId.
                const apps = new Map<string, { credentials: ObservedCredential[]; owner: string | null }>();
                const appsUrl = listing(ENTRA_READ_PATHS[0], 'id,appId,passwordCredentials,keyCredentials');
                for await (const page of readPages(ctx.http, appsUrl, { origin: GRAPH_ORIGIN, headers, parse: graphPage })) {
                    for (const item of page as GraphApplication[]) {
                        rows += 1;
                        const appId = guid(item?.appId);
                        if (appId === null || guid(item.id) === null) {
                            throw new SourceReadError('PAGINATION_TORN', 'an application had no usable id');
                        }
                        apps.set(appId, {
                            credentials: credentialsOf(item, `entra://${directoryId}/applications/${appId}`, ctx.asOf),
                            owner: firstUserOwner(item.owners),
                        });
                    }
                }

                const appsWithPrincipal = new Set<string>();
                const spsUrl = listing(
                    ENTRA_READ_PATHS[1],
                    'id,appId,servicePrincipalType,appOwnerOrganizationId,accountEnabled,passwordCredentials,keyCredentials',
                );
                for await (const page of readPages(ctx.http, spsUrl, { origin: GRAPH_ORIGIN, headers, parse: graphPage })) {
                    for (const item of page as GraphServicePrincipal[]) {
                        rows += 1;
                        const id = guid(item?.id);
                        if (id === null || !isPlainId(id)) {
                            throw new SourceReadError('PAGINATION_TORN', 'a service principal had no usable id');
                        }
                        const appId = guid(item.appId);
                        if (appId !== null) appsWithPrincipal.add(appId);

                        const type = item.servicePrincipalType;
                        const ownerOrg = guid(item.appOwnerOrganizationId);
                        const managed = type === 'ManagedIdentity';
                        const ownApp = type === 'Application' && ownerOrg === directoryId;
                        const thirdParty =
                            type === 'Application' &&
                            ownerOrg !== directoryId &&
                            !(ownerOrg !== null && MICROSOFT_APP_OWNER_TENANTS.has(ownerOrg));
                        if (!(managed || ownApp || (thirdParty && opts.includeThirdPartyApplications))) continue;
                        if (item.accountEnabled === false) continue;

                        const app = appId !== null ? apps.get(appId) : undefined;
                        const credentials = [
                            ...(app?.credentials ?? []),
                            ...credentialsOf(item, `entra://${directoryId}/servicePrincipals/${id}`, ctx.asOf),
                        ];
                        const owner = app?.owner ?? firstUserOwner(item.owners);
                        if (observations.length >= MAX_AGENTS) {
                            throw new SourceReadError('BYTE_CAP', 'more principals than one report may carry');
                        }
                        observations.push({
                            discoveredId: `entra:sp:${id}`,
                            owner: owner === null ? null : { kind: 'user', id: owner, source: 'entra-owner' },
                            credentials,
                            verdicts:
                                managed || credentials.length > 0
                                    ? [
                                        {
                                            criterion: 'H2.credential_bound',
                                            met: true,
                                            evidence: managed
                                                ? `entra-sp:servicePrincipals/${id}#servicePrincipalType`
                                                : `entra-sp:servicePrincipals/${id}#credentials`,
                                        },
                                    ]
                                    : [],
                        });
                    }
                }

                // An application with no service principal in this directory signs
                // in as nothing here: its credentials are bound to no principal.
                for (const [appId, app] of [...apps].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
                    if (!appsWithPrincipal.has(appId)) unbound.push(...app.credentials.map((c) => c.ref));
                }
                return { ...sourceResult('entra-sp', rows, observations, null), unboundCredentials: unbound };
            } catch (err) {
                return { ...sourceResult('entra-sp', rows, observations, err), unboundCredentials: unbound };
            }
        },
    };
}
