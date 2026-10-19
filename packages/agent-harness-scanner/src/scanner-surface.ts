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
import { SKIPPED_DIRECTORIES, SOURCE_EXTENSIONS } from './sources/code/files';

export const SCANNER_NAME = 'inflect-agent-harness-scanner';
/** Raised with any change to what the scanner reads or reports. */
export const SCANNER_VERSION = '0.3.0';

/** The ingest route, as `docs/agent-harness-contract.md` (Transport) names it. */
export const INGEST_PATH_TEMPLATE = '/api/t/{tenantSlug}/admin/agents/harness-scans';

export const SCANNER_SURFACE = {
    name: SCANNER_NAME,
    version: SCANNER_VERSION,
    contract: HARNESS_CONTRACT_V2,
    reads: [
        { source: 'okta-app', product: 'okta', method: 'GET', paths: [...OKTA_READ_PATHS] },
        {
            source: 'vault',
            product: 'azure-key-vault',
            method: 'GET',
            paths: AZURE_KEY_VAULT_COLLECTIONS.map((c) => `/${c}`),
        },
    ],
    authenticates: [
        { product: 'azure-key-vault', method: 'POST', origin: AZURE_LOGIN_ORIGIN, path: '/{directoryTenantId}/oauth2/v2.0/token' },
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
export function isDeclaredRequest(method: string, url: string): boolean {
    const { origin, pathname } = new URL(url);
    if (method === 'GET') {
        return SCANNER_SURFACE.reads.some((r) => (r.paths as readonly string[]).includes(pathname));
    }
    if (method !== 'POST') return false;
    if (origin === AZURE_LOGIN_ORIGIN) return /^\/[^/]+\/oauth2\/v2\.0\/token$/.test(pathname);
    return /^\/api\/t\/[^/]+\/admin\/agents\/harness-scans$/.test(pathname);
}
