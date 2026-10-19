/**
 * THE GCP SERVICE-ACCOUNT SOURCE — `gcp-sa` (#3785, owner decision 2026-10-19).
 *
 * A Google Cloud service account is a non-human principal that acts as itself:
 * a workload attached to it, or anyone holding one of its keys, calls Google's
 * APIs with its authority and no person in the loop. Every enabled account in
 * each configured project is a principal, with its USER-MANAGED keys — the
 * credentials that live outside Google and can be copied — by reference.
 *
 *   • THE ACCOUNTS. `GET /v1/projects/{project}/serviceAccounts`, paged. The
 *     listing holds the project's own accounts and its default ones (Compute
 *     Engine's, App Engine's). Google-managed service agents are not in it.
 *     A disabled account is a row, not a principal: nothing can act as it. Its
 *     display name and description are not read — either can name a person —
 *     and its e-mail address is not reported: a principal is its `uniqueId`.
 *   • THE KEYS. `GET /v1/projects/{project}/serviceAccounts/{uniqueId}/keys`
 *     with `keyTypes=USER_MANAGED`, per account. Google returns key METADATA:
 *     there is no read of a private key after it was created. A disabled key
 *     authenticates nothing and is not reported. An account with no
 *     user-managed key reports none; its tokens are minted by Google for the
 *     workload it is attached to, short-lived, and never leave Google.
 *
 * THE SCANNER'S OWN ACCOUNT is identified POSITIVELY, by the `client_email` of
 * the key it signs its token request with — the account Google authenticated
 * it as — and is not reported: it is the scanner, which the register already
 * holds as the agent that signs this report. Okta's source does the same for
 * its own token (owner decision, 2026-10-19).
 *
 * AUTHENTICATION is the OAuth 2.0 JWT-bearer grant (RFC 7523): the source
 * signs a short-lived assertion with the key named by the configuration's
 * environment variable and exchanges it at `oauth2.googleapis.com`. The token
 * endpoint is this module's constant, never the key file's `token_uri`: a key
 * file is the one place in the configuration's reach that names a host, and it
 * is not trusted to. The scope is `cloud-platform`, because the IAM API takes
 * no read-only scope; what keeps the read read-only is the account's role
 * (`roles/iam.serviceAccountViewer`, which lists accounts and key metadata and
 * changes nothing) and the GET-only wire.
 *
 * NOT READ here, and named so its absence is not mistaken for coverage: role
 * bindings (`getIamPolicy` is a POST, and the wire has no verb for it), an
 * owner (an account carries no owner field and no labels, so the ingest reads
 * each as unowned), and any project the configuration does not list.
 */
import { createSign } from 'crypto';

import { MAX_AGENTS, MAX_CREDENTIALS_PER_AGENT } from '@/lib/agentic/harness-contract';

import {
    ageInDays,
    readPages,
    sourceResult,
    SourceReadError,
    type HarnessSource,
    type Observation,
    type ObservedCredential,
    type SourceContext,
    type SourceRead,
} from '../source';

/** The one host this source reads from. */
export const GCP_IAM_ORIGIN = 'https://iam.googleapis.com';
/** The one host it exchanges its assertion at. */
export const GOOGLE_OAUTH_ORIGIN = 'https://oauth2.googleapis.com';
export const GOOGLE_TOKEN_PATH = '/token';
/** The IAM API takes no read-only scope; the role and the wire keep the read read-only. */
export const GCP_IAM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** The endpoints this source may call, as templates: `{name}` is one path segment. */
export const GCP_READ_PATHS = [
    '/v1/projects/{project}/serviceAccounts',
    '/v1/projects/{project}/serviceAccounts/{account}/keys',
] as const;

/** A project id as Google allows it: 6–30 characters, lower-case letter first, no trailing hyphen. */
export const GCP_PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** The assertion's lifetime. Google refuses one longer than an hour. */
const ASSERTION_SECONDS = 600;
const PAGE_SIZE = 100;
/** The `validBeforeTime` Google gives a key that never expires. */
const NEVER_EXPIRES_YEAR = 9999;

export interface GcpServiceAccountSourceOptions {
    /** Project ids, each matching `GCP_PROJECT_ID`. */
    readonly projects: readonly string[];
    /** The service-account key file's JSON, resolved from the environment by the caller. */
    readonly keyJson: string;
}

/** The members of a Google service-account key file this source reads, and nothing else. */
interface ServiceAccountKey {
    readonly clientEmail: string;
    readonly privateKeyId: string;
    readonly privateKey: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The key file, or AUTH_FAILED: a credential the source cannot use. The reason
 * names nothing of the file, which holds the private key.
 */
export function parseServiceAccountKey(json: string): ServiceAccountKey {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        throw new SourceReadError('AUTH_FAILED', 'the service-account key is not JSON');
    }
    if (
        !isRecord(parsed) ||
        parsed.type !== 'service_account' ||
        typeof parsed.client_email !== 'string' ||
        !/^[^@\s]+@[^@\s]+$/.test(parsed.client_email) ||
        typeof parsed.private_key_id !== 'string' ||
        typeof parsed.private_key !== 'string'
    ) {
        throw new SourceReadError('AUTH_FAILED', 'the service-account key is not a service_account key file');
    }
    return { clientEmail: parsed.client_email.toLowerCase(), privateKeyId: parsed.private_key_id, privateKey: parsed.private_key };
}

const base64url = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

/** An RS256 assertion for the JWT-bearer grant, signed with the key; AUTH_FAILED if the key cannot sign. */
export function signedAssertion(key: ServiceAccountKey, nowMs: number): string {
    const iat = Math.floor(nowMs / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: key.privateKeyId }));
    const claims = base64url(
        JSON.stringify({
            iss: key.clientEmail,
            scope: GCP_IAM_SCOPE,
            aud: `${GOOGLE_OAUTH_ORIGIN}${GOOGLE_TOKEN_PATH}`,
            iat,
            exp: iat + ASSERTION_SECONDS,
        }),
    );
    try {
        const signer = createSign('RSA-SHA256');
        signer.update(`${header}.${claims}`);
        return `${header}.${claims}.${signer.sign(key.privateKey).toString('base64url')}`;
    } catch {
        throw new SourceReadError('AUTH_FAILED', 'the service-account key could not sign');
    }
}

interface GcpAccount {
    uniqueId?: unknown;
    email?: unknown;
    disabled?: unknown;
}

interface GcpKey {
    name?: unknown;
    validAfterTime?: unknown;
    validBeforeTime?: unknown;
    disabled?: unknown;
}

function dateOrNull(v: unknown): Date | null {
    if (typeof v !== 'string') return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}

/** A Google numeric id: what a principal and its references are keyed on. */
const UNIQUE_ID = /^[0-9]{1,32}$/;
/** A key id: the last segment of the key's resource name. */
const KEY_ID = /^[0-9a-f]{8,64}$/;

/**
 * A page of a Google list API: the collection under `member`, absent when it is
 * empty (Google omits an empty repeated field), and `nextPageToken`.
 */
function googlePage(member: string, firstUrl: string) {
    return (body: unknown): { items: readonly unknown[]; next: string | null } | null => {
        if (!isRecord(body)) return null;
        const items = body[member] === undefined ? [] : body[member];
        if (!Array.isArray(items)) return null;
        const token = body.nextPageToken;
        if (token !== undefined && token !== '' && typeof token !== 'string') return null;
        if (typeof token !== 'string' || token === '') return { items, next: null };
        const next = new URL(firstUrl);
        next.searchParams.set('pageToken', token);
        return { items, next: next.toString() };
    };
}

/** The credential one user-managed key is, or null for a disabled key. */
function keyCredential(project: string, uniqueId: string, raw: unknown, asOf: Date): ObservedCredential | null {
    const key = raw as GcpKey | null;
    const name = typeof key?.name === 'string' ? key.name : '';
    const keyId = name.split('/').at(-1) ?? '';
    if (!KEY_ID.test(keyId)) throw new SourceReadError('PAGINATION_TORN', 'a key had no usable id');
    if (key?.disabled === true) return null;
    const before = dateOrNull(key?.validBeforeTime);
    return {
        ref: `gcp-sa-key://${project}/${uniqueId}/${keyId}`,
        ageDays: ageInDays(dateOrNull(key?.validAfterTime), asOf),
        expires: before === null ? null : before.getUTCFullYear() < NEVER_EXPIRES_YEAR,
        // A key belongs to one account and acts only as it.
        boundToAgent: true,
        grant: 'app-only',
    };
}

export function gcpServiceAccountSource(opts: GcpServiceAccountSourceOptions): HarnessSource {
    return {
        kind: 'gcp-sa',
        product: 'gcp-iam',
        async read(ctx: SourceContext): Promise<SourceRead> {
            const observations: Observation[] = [];
            let rows = 0;
            try {
                const key = parseServiceAccountKey(opts.keyJson);
                const token = await ctx.tokens.jwtBearer({
                    tokenUrl: `${GOOGLE_OAUTH_ORIGIN}${GOOGLE_TOKEN_PATH}`,
                    origin: GOOGLE_OAUTH_ORIGIN,
                    assertion: signedAssertion(key, ctx.now()),
                });
                const headers = { Authorization: `Bearer ${token}` };

                for (const project of opts.projects) {
                    if (!GCP_PROJECT_ID.test(project)) throw new SourceReadError('UNPARSEABLE', 'a project that is not a project id');
                    const accountsUrl = `${GCP_IAM_ORIGIN}/v1/projects/${project}/serviceAccounts?pageSize=${PAGE_SIZE}`;
                    const accounts: string[] = [];
                    const seen = new Set<string>();
                    for await (const page of readPages(ctx.http, accountsUrl, {
                        origin: GCP_IAM_ORIGIN,
                        headers,
                        parse: googlePage('accounts', accountsUrl),
                    })) {
                        for (const item of page as GcpAccount[]) {
                            rows += 1;
                            const uniqueId = typeof item?.uniqueId === 'string' && UNIQUE_ID.test(item.uniqueId) ? item.uniqueId : null;
                            const email = typeof item?.email === 'string' ? item.email.toLowerCase() : null;
                            if (uniqueId === null || email === null || seen.has(uniqueId)) {
                                throw new SourceReadError('PAGINATION_TORN', 'an account had no usable id, or was listed twice');
                            }
                            seen.add(uniqueId);
                            if (item.disabled === true) continue;
                            // The scanner itself: read, counted, and not a principal it reports.
                            if (email === key.clientEmail) continue;
                            accounts.push(uniqueId);
                        }
                    }

                    for (const uniqueId of accounts) {
                        const keysUrl = `${GCP_IAM_ORIGIN}/v1/projects/${project}/serviceAccounts/${uniqueId}/keys?keyTypes=USER_MANAGED`;
                        const { body } = await ctx.http.getJson(keysUrl, { origin: GCP_IAM_ORIGIN, headers });
                        const listing = googlePage('keys', keysUrl)(body);
                        // The keys listing is not paged: a next token is a shape this source does not know.
                        if (listing === null || listing.next !== null) {
                            throw new SourceReadError('PAGINATION_TORN', 'a key listing was not the shape Google answers');
                        }
                        const credentials = listing.items
                            .map((k) => keyCredential(project, uniqueId, k, ctx.asOf))
                            .filter((c): c is ObservedCredential => c !== null);
                        if (credentials.length > MAX_CREDENTIALS_PER_AGENT) {
                            throw new SourceReadError('BYTE_CAP', 'an account held more keys than one agent may carry');
                        }
                        if (observations.length >= MAX_AGENTS) {
                            throw new SourceReadError('BYTE_CAP', 'more principals than one report may carry');
                        }
                        const at = `gcp-sa:projects/${project}/serviceAccounts/${uniqueId}`;
                        observations.push({
                            discoveredId: `gcp:sa:${uniqueId}`,
                            owner: null,
                            credentials,
                            // A service account acts as itself: every credential it
                            // holds is bound to it, and no person bounds what it reaches.
                            verdicts: [
                                { criterion: 'H2.credential_bound', met: true, evidence: `${at}/keys#keyTypes=USER_MANAGED` },
                                { criterion: 'H2.grant_kind_declared', met: true, evidence: `${at}#serviceAccount` },
                            ],
                        });
                    }
                }
                return sourceResult('gcp-sa', rows, observations, null);
            } catch (err) {
                return sourceResult('gcp-sa', rows, observations, err);
            }
        },
    };
}
