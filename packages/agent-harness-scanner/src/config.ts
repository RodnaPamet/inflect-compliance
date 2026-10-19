/**
 * THE SCANNER'S CONFIGURATION — one estate per file, strict, and credential-free.
 *
 * Three rules, each held by the schema rather than by the operator's care:
 *
 *   • NO CREDENTIAL IS EVER IN THE FILE. Every secret is named by the
 *     environment variable that holds it (`…Env`), and any string in the file
 *     with a secret's shape is refused outright. A configuration that is safe
 *     to commit, diff and attach to a ticket is one nobody has to remember to
 *     scrub.
 *   • NO WRITE CREDENTIAL HAS A FIELD. The network sources take one READ
 *     credential each — an Okta SSWS token for a read-only administrator, an
 *     Entra client that holds `Key Vault Reader`, an Entra client that holds
 *     `Application.Read.All`, a LangSmith workspace Viewer key, an MCP server's
 *     read token (`readTokenEnv`, one per server, optional) — the `code`
 *     source takes none, and the only other credential is the
 *     Inflect API key that posts the report, which needs the
 *     `admin:harness_ingest` scope and nothing else (contract, Transport).
 *   • EVERY HOST IS FIXED BY KIND. Okta orgs on Okta's own domains, Key Vaults
 *     on the public cloud's, Entra on Microsoft Graph's public-cloud host, LangSmith on its US or EU cloud host, the ingest on
 *     https. A typo cannot send a token somewhere new, because there is no
 *     free-form host to type into — with TWO exceptions, each the customer's
 *     own host and each checked as any customer-named host is
 *     (`customer-host.ts`) here and re-resolved before every request: a
 *     self-hosted LangSmith (`endpoint.selfHosted`), and an MCP server's URL. The `code` source has no host: it
 *     reads absolute local paths, each reported only by the label it is given.
 *
 * Strict objects throughout: an unknown key is an error, so a misspelt
 * `ownerTag` is a refused file rather than a default silently used.
 */
import { z } from 'zod';

import { looksLikeSecret, SOURCE_KINDS } from '@/lib/agentic/harness-contract';

import { customerOriginProblem, parsePrivateCidrAllowlist } from './customer-host';
import { httpsOrigin } from './http';
import { AZURE_KEY_VAULT_HOST_SUFFIX } from './sources/azure-key-vault';
import {
    LANGSMITH_CLOUD_ORIGINS,
    LANGSMITH_DEFAULT_WINDOW_DAYS,
    LANGSMITH_MAX_WINDOW_DAYS,
} from './sources/langsmith';
import { OKTA_HOST_SUFFIXES } from './sources/okta';

const envName = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, 'an environment variable NAME, never a value');
const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

function originOnHosts(suffixes: readonly string[], what: string) {
    return z.string().refine((v) => {
        const origin = httpsOrigin(v);
        if (origin === null) return false;
        const host = new URL(origin).hostname;
        return suffixes.some((s) => host.endsWith(s) && host.length > s.length);
    }, `${what} must be an https origin on ${suffixes.join(' or ')}`);
}

const OktaSourceConfigSchema = z
    .object({
        kind: z.literal('okta-app'),
        orgUrl: originOnHosts(OKTA_HOST_SUFFIXES, 'orgUrl'),
        apiTokenEnv: envName,
        ownerProfileKey: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/).default('owner'),
    })
    .strict();

const AzureKeyVaultSourceConfigSchema = z
    .object({
        kind: z.literal('vault'),
        /** The vault product. One adapter today (owner decision, 2026-10-18); the field keeps the kind generic. */
        product: z.literal('azure-key-vault'),
        vaultUrls: z.array(originOnHosts([AZURE_KEY_VAULT_HOST_SUFFIX], 'each vault URL')).min(1).max(20),
        directoryTenantId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/),
        clientId: z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/),
        clientSecretEnv: envName,
        principalTag: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).default('inflect-principal'),
        ownerTag: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).default('owner'),
    })
    .strict();

const guidString = z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/);

const EntraSourceConfigSchema = z
    .object({
        kind: z.literal('entra-sp'),
        /**
         * The directory's id, a GUID rather than a domain: an application is
         * the estate's own when its `appOwnerOrganizationId` is this id.
         */
        directoryId: guidString,
        /** An application holding `Application.Read.All`, and nothing that writes. */
        clientId: guidString,
        clientSecretEnv: envName,
        /**
         * Also report the service principals of third-party applications
         * consented into the directory (owner decision, 2026-10-19: off unless
         * the estate opts in). Microsoft's first-party applications are never
         * reported.
         */
        includeThirdPartyApplications: z.boolean().default(false),
    })
    .strict();

/** An absolute local path: no `..` segment, no control character. */
const absolutePath = z
    .string()
    .max(1024)
    .refine(
        (v) => v.startsWith('/') && !v.split('/').includes('..') && ![...v].some((ch) => ch.charCodeAt(0) < 0x20),
        'an absolute path with no .. segment',
    );

const CodeSourceConfigSchema = z
    .object({
        kind: z.literal('code'),
        /** The framework the detector recognises. One today (#3737); the field keeps the kind generic. */
        product: z.literal('langchain'),
        /**
         * The directories to read. Each is reported by its `label` alone, never
         * its path, which can name a person (`/home/<user>/…`).
         */
        roots: z
            .array(z.object({ label: slug, path: absolutePath }).strict())
            .min(1)
            .max(20)
            .superRefine((roots, ctx) => {
                const labels = roots.map((r) => r.label);
                if (new Set(labels).size !== labels.length) ctx.addIssue({ code: 'custom', message: 'each root label appears once' });
            }),
    })
    .strict();

const LangSmithSourceConfigSchema = z
    .object({
        kind: z.literal('runtime'),
        /** The runtime product. LangSmith is the one adapter (#3738); the field keeps the kind generic. */
        product: z.literal('langsmith'),
        /**
         * Exactly one of: a cloud data region, whose host is fixed here, or the
         * customer's own self-hosted LangSmith — the one host in this file a
         * person types, refused unless it is a bare https origin that is not a
         * private, loopback, link-local or internal address. A self-hosted
         * LangSmith on the estate's own network names the private ranges it
         * may resolve into (`egressPrivateCidrAllowlist`, after the
         * application's `EGRESS_PRIVATE_CIDR_ALLOWLIST`); metadata, loopback and
         * link-local stay refused inside them (`customer-host.ts`).
         */
        endpoint: z.union([
            z.object({ cloud: z.enum(Object.keys(LANGSMITH_CLOUD_ORIGINS) as [keyof typeof LANGSMITH_CLOUD_ORIGINS]) }).strict(),
            z
                .object({
                    selfHosted: z.string(),
                    egressPrivateCidrAllowlist: z
                        .array(z.string().max(64))
                        .max(32)
                        .refine((v) => parsePrivateCidrAllowlist(v) !== null, 'each entry must be a CIDR, e.g. 10.20.0.0/16 or fd00::/8')
                        .default([]),
                })
                .strict()
                .superRefine((e, ctx) => {
                    const allowlist = parsePrivateCidrAllowlist(e.egressPrivateCidrAllowlist);
                    if (allowlist !== null && customerOriginProblem(e.selfHosted, allowlist) !== null) {
                        ctx.addIssue({ code: 'custom', message: 'selfHosted must be an https origin the scanner may reach', path: ['selfHosted'] });
                    }
                }),
        ]),
        /** A read-scoped LangSmith API key (a workspace Viewer service key). */
        apiKeyEnv: envName,
        /** The workspace (`X-Tenant-Id`); leave out for a key scoped to one workspace. */
        workspaceId: z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/).optional(),
        /** The bounded window tool usage is summarised over. */
        windowDays: z.number().int().min(1).max(LANGSMITH_MAX_WINDOW_DAYS).default(LANGSMITH_DEFAULT_WINDOW_DAYS),
        /**
         * Whether to list deployments too. OFF unless the estate opts in (owner
         * decision 2026-10-19): the deployments listing carries each
         * deployment's secrets, and a scanner that does not need it should not
         * receive it. Projects are read either way.
         */
        readDeployments: z.boolean().default(false),
    })
    .strict();

/** A principal as another source names it: `<source>:<id…>`, no whitespace. The vault's tag takes the same shape. */
const discoveredIdRef = z.string().regex(/^[a-z][a-z0-9-]{0,31}:\S{1,220}$/, 'a discoveredId, e.g. entra:sp:<objectId>');

const egressPrivateCidrAllowlist = z
    .array(z.string().max(64))
    .max(32)
    .refine((v) => parsePrivateCidrAllowlist(v) !== null, 'each entry must be a CIDR, e.g. 10.20.0.0/16 or fd00::/8')
    .default([]);

/** An MCP server's endpoint: https, no credentials, no query or fragment. A path is allowed — the endpoint is one. */
function mcpEndpointProblem(value: string, allowlist: readonly string[]): string | null {
    let u: URL;
    try {
        u = new URL(value);
    } catch {
        return 'must be a URL';
    }
    if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.search !== '' || u.hash !== '') {
        return 'must be an https URL with no credentials, query or fragment';
    }
    const parsed = parsePrivateCidrAllowlist([...allowlist]);
    return parsed === null ? 'has an allowlist that does not parse' : customerOriginProblem(u.origin, parsed);
}

const McpServerConfigSchema = z
    .object({
        label: slug,
        url: z.string().max(512),
        /** The agents that use this server, by the id the source that finds them gives (owner decision 2 on #3686). */
        agents: z.array(discoveredIdRef).max(1_000).default([]),
        /** `sha256:` of the listing the estate pinned: `pinned` is true only while the live listing matches it. */
        pinnedManifestHash: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
        /**
         * A READ token for the server, by environment variable: sent as a bearer
         * token with `initialize`, the initialized notification and `tools/list`,
         * and nothing else (owner decision 6). For Inflect's own `/api/mcp`, a key
         * holding `mcp:read` and no other MCP scope.
         */
        readTokenEnv: envName.optional(),
        /** Private ranges the server's host may resolve into, as for a self-hosted LangSmith. */
        egressPrivateCidrAllowlist,
    })
    .strict()
    .superRefine((s, ctx) => {
        if (mcpEndpointProblem(s.url, s.egressPrivateCidrAllowlist) !== null) {
            ctx.addIssue({ code: 'custom', message: 'url must be an https MCP endpoint the scanner may reach', path: ['url'] });
        }
    });

const McpSourceConfigSchema = z
    .object({
        kind: z.literal('mcp'),
        servers: z
            .array(McpServerConfigSchema)
            .min(1)
            .max(50)
            .superRefine((servers, ctx) => {
                if (new Set(servers.map((s) => s.label)).size !== servers.length) {
                    ctx.addIssue({ code: 'custom', message: 'each server label appears once' });
                }
                if (new Set(servers.map((s) => s.url)).size !== servers.length) {
                    ctx.addIssue({ code: 'custom', message: 'each server URL appears once' });
                }
            }),
    })
    .strict();

export const SourceConfigSchema = z.discriminatedUnion('kind', [
    EntraSourceConfigSchema,
    OktaSourceConfigSchema,
    AzureKeyVaultSourceConfigSchema,
    CodeSourceConfigSchema,
    LangSmithSourceConfigSchema,
    McpSourceConfigSchema,
]);

export const ScannerConfigSchema = z
    .object({
        /** The estate this deployment scans: a label for the operator and the scan id, never reported. */
        estate: slug,
        scanner: z
            .object({
                /** The scanner's register id in the tenant; its public key is registered against it. */
                agentId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
                /** PKCS#8 PEM of the Ed25519 signing key. */
                signingKeyEnv: envName,
            })
            .strict(),
        inflect: z
            .object({
                baseUrl: z.string().refine((v) => httpsOrigin(v) !== null, 'baseUrl must be an https origin'),
                tenantSlug: slug,
                /** An API key with the `admin:harness_ingest` scope and no other. */
                apiKeyEnv: envName,
            })
            .strict(),
        schedule: z.object({ everyHours: z.number().int().min(1).max(720) }).strict(),
        /** Read in a fixed time box each. */
        timeBoxSeconds: z.number().int().min(10).max(3_600).default(600),
        sources: z.array(SourceConfigSchema).min(1).max(SOURCE_KINDS.length),
    })
    .strict()
    .superRefine((c, ctx) => {
        const kinds = c.sources.map((s) => s.kind);
        if (new Set(kinds).size !== kinds.length) {
            ctx.addIssue({ code: 'custom', message: 'each source kind appears once, as in the report', path: ['sources'] });
        }
    });

export type ScannerConfig = z.infer<typeof ScannerConfigSchema>;
export type SourceConfig = z.infer<typeof SourceConfigSchema>;

/** The path of the first secret-shaped string in an untrusted JSON tree, or null. */
function firstSecretShaped(node: unknown, path: string): string | null {
    if (typeof node === 'string') return looksLikeSecret(node) ? path || '(root)' : null;
    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
            const hit = firstSecretShaped(node[i], `${path}[${i}]`);
            if (hit) return hit;
        }
        return null;
    }
    if (node !== null && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
            const hit = firstSecretShaped(v, path ? `${path}.${k}` : k);
            if (hit) return hit;
        }
    }
    return null;
}

export class ConfigError extends Error {
    constructor(readonly issues: readonly string[]) {
        super(`invalid scanner configuration: ${issues.join('; ')}`);
        this.name = 'ConfigError';
    }
}

/**
 * Parse a configuration file's JSON. Refuses a secret-shaped string anywhere
 * BEFORE the schema runs, and reports issues by path and code — never by value,
 * since the value refused may be the credential somebody pasted in.
 */
export function parseScannerConfig(json: unknown): ScannerConfig {
    const secretAt = firstSecretShaped(json, '');
    if (secretAt !== null) {
        throw new ConfigError([`${secretAt}: a credential value in the configuration; name its environment variable instead`]);
    }
    const parsed = ScannerConfigSchema.safeParse(json);
    if (!parsed.success) {
        throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.code}`));
    }
    return parsed.data;
}

/**
 * The environment variable holding one source's read credential. The `code`
 * source holds none, and the `mcp` source one per server at most
 * (`mcpTokenEnvNames`).
 */
export function sourceCredentialEnv(source: Exclude<SourceConfig, { kind: 'code' | 'mcp' }>): string {
    switch (source.kind) {
        case 'entra-sp':
            return source.clientSecretEnv;
        case 'okta-app':
            return source.apiTokenEnv;
        case 'vault':
            return source.clientSecretEnv;
        case 'runtime':
            return source.apiKeyEnv;
    }
}

/** The read-token variables an `mcp` source names, one per server that takes a token. */
export function mcpTokenEnvNames(source: Extract<SourceConfig, { kind: 'mcp' }>): string[] {
    return source.servers.flatMap((s) => (s.readTokenEnv === undefined ? [] : [s.readTokenEnv]));
}

/** The environment variables a configuration names, every one of them. */
export function credentialEnvNames(config: ScannerConfig): string[] {
    const fromSources = config.sources.flatMap((s) =>
        s.kind === 'code' ? [] : s.kind === 'mcp' ? mcpTokenEnvNames(s) : [sourceCredentialEnv(s)],
    );
    return [config.scanner.signingKeyEnv, config.inflect.apiKeyEnv, ...fromSources];
}
