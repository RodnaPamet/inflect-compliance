/**
 * ONE SCAN OF ONE ESTATE: read every configured source, build the report,
 * sign it, and (unless asked not to) post it.
 *
 * A source whose credential is missing from the environment is NOT dropped and
 * does not stop the scan: it is reported INCOMPLETE `AUTH_FAILED`, because the
 * estate has that source whether or not this run could read it, and a report
 * that left it out would describe a smaller estate than the one configured.
 * The signing key and the ingest key are different — without either there is
 * no report to send, so their absence stops the run.
 *
 * Sources are read in parallel, each in its own time box and byte budget, so
 * one slow inventory cannot starve another of its deadline.
 */
import { createPrivateKey, createPublicKey, randomBytes, type KeyObject } from 'crypto';

import type { HarnessReportBody } from '@/lib/agentic/harness-contract';

import type { ScannerConfig } from './config';
import { createSourceWire, type FetchLike } from './http';
import type { ScannerLog } from './log';
import { postReport, type PostResult } from './post';
import { buildReportBody, signReport } from './report';
import { sourceResult, SourceReadError, type HarnessSource, type SourceRead } from './source';
import { azureKeyVaultSource } from './sources/azure-key-vault';
import { oktaSource } from './sources/okta';

export type Env = Readonly<Record<string, string | undefined>>;

export interface ScanDeps {
    readonly config: ScannerConfig;
    readonly env: Env;
    readonly log: ScannerLog;
    /** The wire. A TEST SEAM: the CLI never passes one, so production uses the global fetch. */
    readonly fetchImpl?: FetchLike;
    readonly now?: () => number;
}

/** The Ed25519 signing key, from PKCS#8 PEM. Anything else is refused. */
export function loadSigningKey(pem: string): { privateKey: KeyObject; publicKey: KeyObject } {
    const privateKey = createPrivateKey(pem);
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('the signing key must be Ed25519');
    return { privateKey, publicKey: createPublicKey(privateKey) };
}

function requiredEnv(env: Env, name: string, what: string): string {
    const v = env[name];
    if (typeof v !== 'string' || v.trim() === '') throw new Error(`${what} is not set (environment variable ${name})`);
    return v;
}

/** The configured sources, constructed — or, where a credential is missing, already reported unreadable. */
export function buildSources(config: ScannerConfig, env: Env): { sources: HarnessSource[]; unreadable: SourceRead[] } {
    const sources: HarnessSource[] = [];
    const unreadable: SourceRead[] = [];
    for (const s of config.sources) {
        const secretName = s.kind === 'okta-app' ? s.apiTokenEnv : s.clientSecretEnv;
        const secret = env[secretName];
        if (typeof secret !== 'string' || secret.trim() === '') {
            unreadable.push(sourceResult(s.kind, 0, [], new SourceReadError('AUTH_FAILED', 'credential not set')));
            continue;
        }
        if (s.kind === 'okta-app') {
            sources.push(oktaSource({ orgUrl: s.orgUrl, apiToken: secret.trim(), ownerProfileKey: s.ownerProfileKey }));
        } else {
            sources.push(
                azureKeyVaultSource({
                    vaultUrls: s.vaultUrls,
                    directoryTenantId: s.directoryTenantId,
                    clientId: s.clientId,
                    clientSecret: secret.trim(),
                    principalTag: s.principalTag,
                    ownerTag: s.ownerTag,
                }),
            );
        }
    }
    return { sources, unreadable };
}

function scanIdFor(estate: string, asOf: Date): string {
    const stamp = asOf.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    return `${estate}-${stamp}-${randomBytes(4).toString('hex')}`;
}

/** Read, build and sign. Returns the serialised report and the body it carries. */
export async function runScan(deps: ScanDeps): Promise<{ raw: string; body: HarnessReportBody }> {
    const { config, env, log } = deps;
    const now = deps.now ?? Date.now;
    const fetchImpl: FetchLike = deps.fetchImpl ?? ((url, init) => fetch(url, init));
    const keys = loadSigningKey(requiredEnv(env, config.scanner.signingKeyEnv, 'the signing key'));

    const asOf = new Date(now());
    const deadline = asOf.getTime() + config.timeBoxSeconds * 1000;
    const { sources, unreadable } = buildSources(config, env);

    const reads = await Promise.all(
        sources.map(async (source) => {
            const { http, tokens } = createSourceWire({ fetchImpl, deadline, now });
            try {
                return await source.read({ asOf, http, tokens });
            } catch (err) {
                return sourceResult(source.kind, 0, [], err);
            }
        }),
    );

    for (const r of [...reads, ...unreadable]) {
        const fields = { source: r.kind, status: r.status, rows: r.rows, principals: r.observations.length };
        if (r.status === 'COMPLETE') log.info('source read', fields);
        else log.warn('source incomplete', { ...fields, reason: r.reason ?? null });
    }

    const body = buildReportBody(
        { scanId: scanIdFor(config.estate, asOf), asOf, scannerAgentId: config.scanner.agentId },
        [...reads, ...unreadable],
    );
    const raw = signReport(body, keys);
    log.info('report signed', { scan: body.scan.id, agents: body.agents.length, sources: body.population.sources.length });
    return { raw, body };
}

/** One scheduled run: scan, then post to the tenant's ingest. */
export async function scanAndPost(deps: ScanDeps): Promise<PostResult> {
    const apiKey = requiredEnv(deps.env, deps.config.inflect.apiKeyEnv, 'the ingest API key');
    const { raw, body } = await runScan(deps);
    const result = await postReport({
        baseUrl: deps.config.inflect.baseUrl,
        tenantSlug: deps.config.inflect.tenantSlug,
        apiKey,
        raw,
        fetchImpl: deps.fetchImpl ?? ((url, init) => fetch(url, init)),
    });
    if (result.ok) {
        deps.log.info('report ingested', { scan: body.scan.id, complete: result.complete, agents: result.agentCount });
    } else {
        deps.log.error('report refused', { scan: body.scan.id, status: result.status, refusal: result.refusal });
    }
    return result;
}
