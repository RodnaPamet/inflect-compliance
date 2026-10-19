/**
 * THE AZURE KEY VAULT SOURCE — the `vault` kind (#3678, owner decision
 * 2026-10-18 (b): Azure Key Vault, and no other vault product for now).
 *
 * A vault holds the credentials agents run with. This lists them — secrets and
 * certificates, by name and metadata — and reports each one that is TAGGED
 * with the principal it belongs to as a credential of that principal:
 *
 *     tag `inflect-principal` = `entra:sp:<objectId>` | `okta:app:<id>` | …
 *     tag `owner`             = the accountable person, as the estate names them
 *
 * The tag value is the principal's `discoveredId` in the source that finds it,
 * so a vault credential lands on the same agent the identity source reported
 * and the agent is `discoveredVia` both. A tagged credential whose principal no
 * other source saw is still reported: a credential bound to an agent that
 * nothing else can see is what a shadow agent looks like from the vault.
 * Untagged items are counted in `rows` and reported as nothing — which of a
 * vault's secrets belong to agents is the estate's own statement, and the
 * scanner does not guess it from names.
 *
 * READ-ONLY, and METADATA-ONLY (DPIA condition 3). The two LIST endpoints,
 * `GET {vault}/secrets` and `GET {vault}/certificates`, return identifiers,
 * attributes and tags and never a value. `GET {vault}/secrets/{name}` returns
 * the value, so it is never called: `scanner-surface.ts` declares the two list
 * paths as this source's whole surface and the tests hold the request log to
 * it. The identity it reads with needs `Key Vault Reader` and nothing more —
 * that role reads metadata and cannot read a secret's contents.
 *
 * The token is the OAuth client-credentials grant against
 * `login.microsoftonline.com` for `https://vault.azure.net/.default`: the one
 * POST this source makes, to the identity provider and not to the vault. The
 * client secret is named by an environment variable and never leaves this
 * exchange. Public cloud only; a sovereign-cloud vault is refused by the
 * configuration rather than reached by a guess at its hosts.
 *
 * Several vaults may be configured. They are one `vault` source in the report,
 * because the contract lists each kind once; the source is COMPLETE only when
 * every vault was read to its end.
 */
import { MAX_AGENTS } from '@/lib/agentic/harness-contract';

import {
    ageInDays,
    readPages,
    sourceResult,
    SourceReadError,
    type HarnessSource,
    type Observation,
    type SourceContext,
    type SourceRead,
} from '../source';

/** Vault hosts the token may be sent to: the public cloud's. */
export const AZURE_KEY_VAULT_HOST_SUFFIX = '.vault.azure.net';
/** Where the token comes from. */
export const AZURE_LOGIN_ORIGIN = 'https://login.microsoftonline.com';
/** The two collections this source lists. `scanner-surface.ts` declares them for the manifest hash. */
export const AZURE_KEY_VAULT_COLLECTIONS = ['secrets', 'certificates'] as const;
export const AZURE_KEY_VAULT_API_VERSION = '7.4';

export interface AzureKeyVaultSourceOptions {
    /** Each vault's https origin, e.g. `https://acme-agents.vault.azure.net`. */
    readonly vaultUrls: readonly string[];
    /** The Entra tenant the reading identity belongs to (GUID or verified domain). */
    readonly directoryTenantId: string;
    readonly clientId: string;
    /** Resolved from the environment by the caller. */
    readonly clientSecret: string;
    readonly principalTag: string;
    readonly ownerTag: string;
}

/** A principal reference as a tag carries it: `<source>:<id…>`, no whitespace. */
const PRINCIPAL_REF = /^[a-z][a-z0-9-]{0,31}:\S{1,220}$/;
/** Key Vault object names: alphanumerics and hyphens. */
const VAULT_OBJECT_NAME = /^[0-9A-Za-z-]{1,127}$/;

interface VaultItem {
    id?: unknown;
    managed?: unknown;
    attributes?: { enabled?: unknown; created?: unknown; exp?: unknown };
    tags?: Record<string, unknown> | null;
}

function unixDate(v: unknown): Date | null {
    return typeof v === 'number' && Number.isFinite(v) ? new Date(v * 1000) : null;
}

function tagValue(tags: VaultItem['tags'], key: string): string | null {
    const raw = tags?.[key];
    if (typeof raw !== 'string') return null;
    const v = raw.trim();
    return v === '' || v.length > 256 || /\s/.test(v) ? null : v;
}

/** One Key Vault list page: `{ value: [...], nextLink }`. */
function vaultPage(body: unknown): { items: readonly unknown[]; next: string | null } | null {
    if (body === null || typeof body !== 'object') return null;
    const { value, nextLink } = body as { value?: unknown; nextLink?: unknown };
    if (!Array.isArray(value)) return null;
    if (nextLink !== undefined && nextLink !== null && typeof nextLink !== 'string') return null;
    return { items: value, next: typeof nextLink === 'string' && nextLink !== '' ? nextLink : null };
}

/** The object's name, when `id` is `{origin}/{collection}/{name}[/{version}]` on this vault; else null. */
function objectName(id: unknown, origin: string, collection: string): string | null {
    if (typeof id !== 'string') return null;
    let url: URL;
    try {
        url = new URL(id);
    } catch {
        return null;
    }
    if (url.origin !== origin) return null;
    const [, coll, name] = url.pathname.split('/');
    return coll === collection && VAULT_OBJECT_NAME.test(name ?? '') ? name : null;
}

export function azureKeyVaultSource(opts: AzureKeyVaultSourceOptions): HarnessSource {
    const vaults = opts.vaultUrls.map((u) => ({ origin: new URL(u).origin, host: new URL(u).host }));

    return {
        kind: 'vault',
        product: 'azure-key-vault',
        async read(ctx: SourceContext): Promise<SourceRead> {
            const observations: Observation[] = [];
            let rows = 0;
            try {
                const token = await ctx.tokens.clientCredentials({
                    tokenUrl: `${AZURE_LOGIN_ORIGIN}/${encodeURIComponent(opts.directoryTenantId)}/oauth2/v2.0/token`,
                    origin: AZURE_LOGIN_ORIGIN,
                    clientId: opts.clientId,
                    clientSecret: opts.clientSecret,
                    scope: 'https://vault.azure.net/.default',
                });
                const headers = { Authorization: `Bearer ${token}` };

                for (const vault of vaults) {
                    for (const collection of AZURE_KEY_VAULT_COLLECTIONS) {
                        const first = `${vault.origin}/${collection}?api-version=${AZURE_KEY_VAULT_API_VERSION}&maxresults=25`;
                        const pages = readPages(ctx.http, first, { origin: vault.origin, headers, parse: vaultPage });
                        for await (const page of pages) {
                            for (const item of page as VaultItem[]) {
                                rows += 1;
                                const name = objectName(item?.id, vault.origin, collection);
                                if (name === null) {
                                    throw new SourceReadError('PAGINATION_TORN', 'a vault item had no usable id');
                                }
                                // A certificate's backing secret repeats the certificate.
                                if (collection === 'secrets' && item.managed === true) continue;
                                // A disabled object cannot be read by anybody: not a live credential.
                                if (item.attributes?.enabled === false) continue;
                                const principal = tagValue(item.tags, opts.principalTag);
                                if (principal === null || !PRINCIPAL_REF.test(principal)) continue;
                                if (observations.length >= MAX_AGENTS) {
                                    throw new SourceReadError('BYTE_CAP', 'more tagged credentials than one report may carry');
                                }
                                const owner = tagValue(item.tags, opts.ownerTag);
                                observations.push({
                                    discoveredId: principal,
                                    owner: owner === null ? null : { kind: 'user', id: owner, source: 'azure-key-vault-tag' },
                                    credentials: [
                                        {
                                            ref: `azure-kv://${vault.host}/${collection}/${name}`,
                                            // The listed attributes are the CURRENT version's, so
                                            // `created` is when the credential was last rotated.
                                            ageDays: ageInDays(unixDate(item.attributes?.created), ctx.asOf),
                                            expires: unixDate(item.attributes?.exp) !== null,
                                            // The tag names the one principal it is for.
                                            boundToAgent: true,
                                            // The vault does not know how the credential is granted.
                                            grant: 'unknown',
                                        },
                                    ],
                                    verdicts: [],
                                });
                            }
                        }
                    }
                }
                return sourceResult('vault', rows, observations, null);
            } catch (err) {
                return sourceResult('vault', rows, observations, err);
            }
        },
    };
}
