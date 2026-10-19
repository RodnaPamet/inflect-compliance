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
 *     Entra client that holds `Key Vault Reader` — the `code` source takes
 *     none, and the only other credential is the Inflect API key that posts
 *     the report, which needs the `admin:harness_ingest` scope and nothing
 *     else (contract, Transport).
 *   • EVERY HOST IS FIXED BY KIND. Okta orgs on Okta's own domains, Key Vaults
 *     on the public cloud's, the ingest on https. A typo cannot send a token
 *     somewhere new, because there is no free-form host to type into. The
 *     `code` source has no host: it reads absolute local paths, each reported
 *     only by the label it is given.
 *
 * Strict objects throughout: an unknown key is an error, so a misspelt
 * `ownerTag` is a refused file rather than a default silently used.
 */
import { z } from 'zod';

import { looksLikeSecret, SOURCE_KINDS } from '@/lib/agentic/harness-contract';

import { httpsOrigin } from './http';
import { AZURE_KEY_VAULT_HOST_SUFFIX } from './sources/azure-key-vault';
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

export const SourceConfigSchema = z.discriminatedUnion('kind', [
    OktaSourceConfigSchema,
    AzureKeyVaultSourceConfigSchema,
    CodeSourceConfigSchema,
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

/** The environment variables a configuration names, every one of them. */
export function credentialEnvNames(config: ScannerConfig): string[] {
    const fromSources = config.sources.flatMap((s) =>
        s.kind === 'okta-app' ? [s.apiTokenEnv] : s.kind === 'vault' ? [s.clientSecretEnv] : [],
    );
    return [config.scanner.signingKeyEnv, config.inflect.apiKeyEnv, ...fromSources];
}
