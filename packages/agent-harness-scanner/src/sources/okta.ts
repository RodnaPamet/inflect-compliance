/**
 * THE OKTA SOURCE — `okta-app` (#3678, owner decision 2026-10-18 (c)).
 *
 * Two kinds of non-human principal live in an Okta org, and this reads both,
 * with their owners:
 *
 *   • SERVICE APPS. OAuth 2.0 clients with `application_type: service` — the
 *     client-credentials grant, acting as themselves with no person in the
 *     loop. `GET /api/v1/apps?filter=name eq "oidc_client"`, paged, and the
 *     service type selected here. Okta has no first-class app owner, so the
 *     owner is read from one property of the app's own `profile` (configured,
 *     `owner` by default); an app without one reports `owner: null`, which the
 *     ingest reads as unowned rather than guessing.
 *   • API TOKENS. SSWS tokens act AS the admin who created them, so each is a
 *     principal whose authority is a person's. `GET /api/v1/api-tokens`, paged.
 *     The owner is the token's `userId`, which Okta records itself.
 *
 * READ-ONLY. Two list endpoints and nothing else, by GET (`ReadOnlyHttp` has no
 * other verb). In particular this never reads an app's
 * `/credentials/secrets`: Okta returns client secrets there, and a reader that
 * can see a secret is a reader that can leak one. A service app's credential is
 * therefore reported by REFERENCE with its age unknown (`ageDays: null`).
 *
 * An app's `profile` can say which register agent it is. That is not read: a
 * label in the estate being scanned is something the estate's own
 * administrator can write, and a scanner that believed it could be told to hide
 * a shadow agent. Linking to the register is the register's source.
 *
 * The credential is an SSWS API token for a read-only administrator, named by
 * an environment variable and resolved once. An SSWS token cannot list API
 * tokens without the rights to do so; the read then stops with AUTH_FAILED
 * and the source is INCOMPLETE, which is the contract working.
 */
import { MAX_AGENTS } from '@/lib/agentic/harness-contract';

import { nextLinkFrom } from '../http';
import {
    ageInDays,
    isPlainId,
    readPages,
    sourceResult,
    SourceReadError,
    type HarnessSource,
    type Observation,
    type SourceContext,
    type SourceRead,
} from '../source';

/** Okta org hosts the token may be sent to — the product's own list (`OKTA_HOSTS`). */
export const OKTA_HOST_SUFFIXES = ['.okta.com', '.oktapreview.com'] as const;

export interface OktaSourceOptions {
    /** The org's https origin, e.g. `https://acme.okta.com`. */
    readonly orgUrl: string;
    /** The SSWS token's value, resolved from the environment by the caller. */
    readonly apiToken: string;
    /** The app `profile` property naming a service app's owner. */
    readonly ownerProfileKey: string;
}

/** The two endpoints this source may call. `scanner-surface.ts` declares them for the manifest hash. */
export const OKTA_READ_PATHS = ['/api/v1/apps', '/api/v1/api-tokens'] as const;

const PAGE_LIMIT = '200';

interface OktaApp {
    id?: unknown;
    signOnMode?: unknown;
    settings?: { oauthClient?: { application_type?: unknown } };
    profile?: Record<string, unknown> | null;
}

interface OktaApiToken {
    id?: unknown;
    userId?: unknown;
    created?: unknown;
    expiresAt?: unknown;
}

function dateOrNull(v: unknown): Date | null {
    if (typeof v !== 'string') return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
}

function ownerFromProfile(profile: OktaApp['profile'], key: string): Observation['owner'] {
    const raw = profile?.[key];
    if (typeof raw !== 'string') return null;
    const id = raw.trim();
    if (id === '' || id.length > 256 || /\s/.test(id)) return null;
    return { kind: 'user', id, source: 'okta-app-profile' };
}

/** A page of Okta's list API: a JSON array, and the next link from the `Link` header. */
function oktaPage(body: unknown, headers: Headers): { items: readonly unknown[]; next: string | null } | null {
    if (!Array.isArray(body)) return null;
    return { items: body, next: nextLinkFrom(headers.get('link')) };
}

export function oktaSource(opts: OktaSourceOptions): HarnessSource {
    const origin = new URL(opts.orgUrl).origin;
    const host = new URL(opts.orgUrl).host;
    const headers = { Authorization: `SSWS ${opts.apiToken}` };

    return {
        kind: 'okta-app',
        product: 'okta',
        async read(ctx: SourceContext): Promise<SourceRead> {
            const observations: Observation[] = [];
            let rows = 0;
            const add = (o: Observation) => {
                if (observations.length >= MAX_AGENTS) {
                    throw new SourceReadError('BYTE_CAP', 'more principals than one report may carry');
                }
                observations.push(o);
            };

            try {
                // `%20`, not the `+` URLSearchParams would write: Okta's filter
                // grammar is read from the decoded query, and `+` is a space only
                // under form encoding.
                const apps = `${origin}${OKTA_READ_PATHS[0]}?limit=${PAGE_LIMIT}&filter=${encodeURIComponent('name eq "oidc_client"')}`;
                for await (const page of readPages(ctx.http, apps, { origin, headers, parse: oktaPage })) {
                    for (const item of page as OktaApp[]) {
                        rows += 1;
                        if (!isPlainId(item?.id)) throw new SourceReadError('PAGINATION_TORN', 'an app had no usable id');
                        if (item.signOnMode !== 'OPENID_CONNECT') continue;
                        if (item.settings?.oauthClient?.application_type !== 'service') continue;
                        add({
                            discoveredId: `okta:app:${item.id}`,
                            owner: ownerFromProfile(item.profile, opts.ownerProfileKey),
                            credentials: [
                                {
                                    ref: `okta://${host}/apps/${item.id}/oauth-client`,
                                    ageDays: null,
                                    expires: null,
                                    boundToAgent: true,
                                    grant: 'app-only',
                                },
                            ],
                            verdicts: [
                                {
                                    criterion: 'H2.grant_kind_declared',
                                    met: true,
                                    evidence: `okta-app:apps/${item.id}#settings.oauthClient.application_type`,
                                },
                            ],
                        });
                    }
                }

                const tokens = `${origin}${OKTA_READ_PATHS[1]}?limit=${PAGE_LIMIT}`;
                for await (const page of readPages(ctx.http, tokens, { origin, headers, parse: oktaPage })) {
                    for (const item of page as OktaApiToken[]) {
                        rows += 1;
                        if (!isPlainId(item?.id)) throw new SourceReadError('PAGINATION_TORN', 'an API token had no usable id');
                        add({
                            discoveredId: `okta:api-token:${item.id}`,
                            owner: isPlainId(item.userId) ? { kind: 'user', id: item.userId, source: 'okta-api-token' } : null,
                            credentials: [
                                {
                                    ref: `okta://${host}/api-tokens/${item.id}`,
                                    ageDays: ageInDays(dateOrNull(item.created), ctx.asOf),
                                    expires: dateOrNull(item.expiresAt) !== null,
                                    // An SSWS token acts as the person who created it, with
                                    // that person's admin rights: delegated, and not bound
                                    // to any agent identity of its own.
                                    boundToAgent: false,
                                    grant: 'delegated',
                                },
                            ],
                            verdicts: [
                                {
                                    criterion: 'H2.credential_bound',
                                    met: false,
                                    evidence: `okta-app:api-tokens/${item.id}#userId`,
                                },
                            ],
                        });
                    }
                }
                return sourceResult('okta-app', rows, observations, null);
            } catch (err) {
                return sourceResult('okta-app', rows, observations, err);
            }
        },
    };
}
