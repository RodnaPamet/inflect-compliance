/**
 * WHAT THIS SCANNER CAN REACH, declared once — and hashed into the report.
 *
 * The contract asks a scanner for the `sha256:` manifest hash of its own tool
 * surface (`scan.scanner.manifestHash`). This scanner calls no MCP tool; its
 * surface is the requests it can make. So the manifest is that list — each
 * source's GET endpoints, the one token exchange, and the one POST to the
 * ingest — plus the local files the `code` source reads, and the hash is
 * SHA-256 over its canonical JSON, the construction the report's own signature
 * uses.
 *
 * Two things follow. A change to what the scanner can call changes the hash
 * the tenant sees on every scan, so a widened surface cannot ship silently;
 * and the tests hold every request the fakes saw to this list
 * (`isDeclaredRequest`), so the declaration cannot drift from the code either.
 */
import { createHash } from 'crypto';

import { canonicalJson } from '@/lib/canonical-json';
import { HARNESS_CONTRACT_V2 } from '@/lib/agentic/harness-contract';

import { OKTA_READ_PATHS } from './sources/okta';
import { AZURE_KEY_VAULT_COLLECTIONS, AZURE_LOGIN_ORIGIN } from './sources/azure-key-vault';
import { ENTRA_READ_PATHS, GRAPH_ORIGIN } from './sources/entra';
import { GITHUB_API_ORIGIN, GITHUB_READ_PATHS } from './sources/github-actions';
import { HARNESS_REGISTER_TOOL, MCP_MESSAGES } from './http';
import { INFLECT_MCP_PATH } from './sources/inflect-register';
import { SKIPPED_DIRECTORIES, SOURCE_EXTENSIONS } from './sources/code/files';
import { LANGSMITH_READ_PATHS } from './sources/langsmith';

export const SCANNER_NAME = 'inflect-agent-harness-scanner';
/**
 * Raised with any change to what the scanner reads or reports. 0.2.0: the
 * LangSmith source (#3738). 0.3.0: reports under `inflect-agent-harness/2`
 * (#3754). 0.4.0: the `code` source, LangChain and LangGraph (#3737). 0.5.0:
 * the Entra source (#3686). 0.6.0: the MCP source (#3686). 0.7.0: the register
 * source (#3686). 0.8.0: the GitHub Actions source (#3784).
 */
export const SCANNER_VERSION = '0.8.0';

/** The ingest route, as `docs/agent-harness-contract.md` (Transport) names it. */
export const INGEST_PATH_TEMPLATE = '/api/t/{tenantSlug}/admin/agents/harness-scans';

export const SCANNER_SURFACE = {
    name: SCANNER_NAME,
    version: SCANNER_VERSION,
    contract: HARNESS_CONTRACT_V2,
    reads: [
        { source: 'entra-sp', product: 'entra', method: 'GET', origin: GRAPH_ORIGIN, paths: [...ENTRA_READ_PATHS] },
        { source: 'okta-app', product: 'okta', method: 'GET', paths: [...OKTA_READ_PATHS] },
        // Templates: `{owner}`, `{repo}` and `{file}` each stand for one path segment.
        { source: 'cicd', product: 'github-actions', method: 'GET', origin: GITHUB_API_ORIGIN, paths: [...GITHUB_READ_PATHS] },
        {
            source: 'vault',
            product: 'azure-key-vault',
            method: 'GET',
            paths: AZURE_KEY_VAULT_COLLECTIONS.map((c) => `/${c}`),
        },
        {
            source: 'runtime',
            product: 'langsmith',
            method: 'GET',
            paths: [
                ...new Set([
                    ...Object.values(LANGSMITH_READ_PATHS.cloud),
                    ...Object.values(LANGSMITH_READ_PATHS.selfHosted),
                ]),
            ],
        },
    ],
    authenticates: [
        { product: 'azure-key-vault', method: 'POST', origin: AZURE_LOGIN_ORIGIN, path: '/{directoryTenantId}/oauth2/v2.0/token' },
        { product: 'entra', method: 'POST', origin: AZURE_LOGIN_ORIGIN, path: '/{directoryId}/oauth2/v2.0/token' },
    ],
    // No request: the `code` source reads local files, and never runs them.
    // Declared all the same, so reading code shows in the manifest hash.
    readsFiles: [
        {
            source: 'code',
            product: 'langchain',
            operations: ['lstat', 'readdir', 'readFile'],
            extensions: [...SOURCE_EXTENSIONS],
            skips: [...SKIPPED_DIRECTORIES],
            followsSymlinks: false,
            executes: false,
        },
    ],
    // An MCP server is the estate's own host, named in its configuration. To
    // it the scanner POSTs these JSON-RPC messages and no other (DPIA
    // condition 1, owner decision 5 on #3686): never `tools/call`.
    lists: [{ source: 'mcp', method: 'POST', host: 'configured', jsonRpc: [...MCP_MESSAGES] }],
    // The scanner's own tenant's register: the handshake, then ONE tool call,
    // of ONE named read tool (DPIA condition 2, owner decision 7 on #3686).
    readsRegister: [
        {
            source: 'inflect-register',
            method: 'POST',
            path: INFLECT_MCP_PATH,
            jsonRpc: ['initialize', 'notifications/initialized', 'tools/call'],
            tool: HARNESS_REGISTER_TOOL,
        },
    ],
    sends: [{ method: 'POST', path: INGEST_PATH_TEMPLATE }],
} as const;

export function scannerManifestHash(): string {
    return `sha256:${createHash('sha256').update(canonicalJson(SCANNER_SURFACE), 'utf8').digest('hex')}`;
}

/**
 * Whether one request is on the declared surface: a GET to a declared read
 * path, the token exchange, or the POST to the ingest. The request log of every
 * test is held to this.
 */
/**
 * Whether one message to an MCP server is on the declared surface: a JSON-RPC
 * body whose method is one of `MCP_MESSAGES`. The request log of every MCP
 * test is held to this, beside `isDeclaredRequest` for every other request.
 */
export function isDeclaredMcpMessage(body: string): boolean {
    let message: unknown;
    try {
        message = JSON.parse(body);
    } catch {
        return false;
    }
    const method = (message as { method?: unknown } | null)?.method;
    return typeof method === 'string' && (MCP_MESSAGES as readonly string[]).includes(method);
}

/**
 * Whether one message to the scanner's own tenant's `/api/mcp` is on the
 * declared surface: the handshake, or a `tools/call` naming
 * `get_harness_register` and nothing else.
 */
export function isDeclaredRegisterMessage(body: string): boolean {
    let message: { method?: unknown; params?: { name?: unknown } } | null;
    try {
        message = JSON.parse(body) as typeof message;
    } catch {
        return false;
    }
    if (message?.method === 'initialize' || message?.method === 'notifications/initialized') return true;
    return message?.method === 'tools/call' && message.params?.name === HARNESS_REGISTER_TOOL;
}

/** Whether `pathname` is `declared`, where a `{name}` segment of `declared` stands for exactly one segment. */
function pathMatches(declared: string, pathname: string): boolean {
    const want = declared.split('/');
    const got = pathname.split('/');
    return want.length === got.length && want.every((seg, i) => (/^\{[a-z]+\}$/.test(seg) ? got[i] !== '' : seg === got[i]));
}

export function isDeclaredRequest(method: string, url: string): boolean {
    const { origin, pathname } = new URL(url);
    if (method === 'GET') {
        // A read that names its origin (one whose host is fixed by kind) is held to it.
        return SCANNER_SURFACE.reads.some(
            (r) => (r.paths as readonly string[]).some((p) => pathMatches(p, pathname)) && (!('origin' in r) || r.origin === origin),
        );
    }
    if (method !== 'POST') return false;
    if (origin === AZURE_LOGIN_ORIGIN) return /^\/[^/]+\/oauth2\/v2\.0\/token$/.test(pathname);
    // The register read posts to the tenant's `/api/mcp`; its messages are held
    // by `isDeclaredRegisterMessage`.
    if (pathname === INFLECT_MCP_PATH) return true;
    return /^\/api\/t\/[^/]+\/admin\/agents\/harness-scans$/.test(pathname);
}
