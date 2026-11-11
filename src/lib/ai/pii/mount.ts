/**
 * WHETHER THIS DEPLOYMENT HAS A PII DETECTOR — the mount gate (Phase 1.4).
 *
 * Three answers, and the difference between the first two is load-bearing:
 *
 *   ABSENT     `AI_PII_BASE_URL` is unset. Nothing is constructed (G9), and
 *              redaction is OFF for every tenant — the deployment key of the
 *              two (Phase 2.1 adds the tenant's).
 *   UNMOUNTED  the operator configured a detector and it may not be used: no
 *              config hash, a base URL that is not https, no committed record
 *              for the deployed configuration, or a record whose RECOMPUTED
 *              rates fall short. The egress use BLOCKS for a tenant with
 *              redaction on (`./egress.ts`): the operator asked for a
 *              detector, and the one they have cannot vouch for itself.
 *   MOUNTED    a Presidio provider, built with the threshold its record was
 *              measured at.
 *
 * This is the ONLY module that constructs the Presidio provider
 * (`tests/guards/pii-detector-single-seam.test.ts`), so "mounted only with a
 * passing record" is not a convention a second caller could skip.
 *
 * Records are read from `evals/pii/records/*.json`, relative to the process's
 * working directory. The directory is empty today, so every configured
 * deployment answers UNMOUNTED(NO_RECORD) — the designed state, not a gap.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { env } from '@/env';

import { checkPiiEvaluationRecord, type PiiRecordRefusal } from './evaluation-record';
import { createPresidioDetector, type PresidioProviderOptions } from './presidio-provider';
import type { PiiDetector } from './types';

export const PII_RECORDS_DIR = path.join('evals', 'pii', 'records');

export type PiiMountRefusal =
    | 'NO_CONFIG_HASH'
    | 'BASE_URL_NOT_HTTPS'
    | 'RECORDS_UNREADABLE'
    | 'NO_RECORD'
    | PiiRecordRefusal;

export type PiiDetectorResolution =
    | { readonly state: 'ABSENT' }
    | { readonly state: 'UNMOUNTED'; readonly reason: PiiMountRefusal; readonly detail: string }
    | {
        readonly state: 'MOUNTED';
        readonly detector: PiiDetector;
        readonly record: { readonly detector: string; readonly configHash: string; readonly producedAt: string };
    };

export interface ResolvePiiDetectorOptions {
    readonly baseUrl?: string;
    readonly configHash?: string;
    /** Test seam; production reads `evals/pii/records/` under the working directory. */
    readonly recordsDir?: string;
    /** Test seam, handed to the provider. */
    readonly fetchImpl?: PresidioProviderOptions['fetchImpl'];
}

function unmounted(reason: PiiMountRefusal, detail: string): PiiDetectorResolution {
    return { state: 'UNMOUNTED', reason, detail };
}

/** Read every committed record. Throws on an unreadable file: one is never skipped. */
function readRecords(dir: string): { file: string; raw: unknown }[] {
    if (!fs.existsSync(dir)) return [];
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((file) => ({ file, raw: JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as unknown }));
}

export function resolvePiiDetector(opts: ResolvePiiDetectorOptions = {}): PiiDetectorResolution {
    const baseUrl = 'baseUrl' in opts ? opts.baseUrl : env.AI_PII_BASE_URL;
    const configHash = 'configHash' in opts ? opts.configHash : env.AI_PII_CONFIG_HASH;
    if (!baseUrl) return { state: 'ABSENT' };
    if (!configHash) {
        return unmounted('NO_CONFIG_HASH', 'AI_PII_BASE_URL is set but AI_PII_CONFIG_HASH does not name the deployed configuration');
    }
    let protocol: string | null;
    try {
        protocol = new URL(baseUrl).protocol;
    } catch {
        protocol = null;
    }
    if (protocol !== 'https:') return unmounted('BASE_URL_NOT_HTTPS', 'the detector is reached through safeFetch, which is https-only');

    let records: { file: string; raw: unknown }[];
    try {
        records = readRecords(opts.recordsDir ?? path.join(process.cwd(), PII_RECORDS_DIR));
    } catch (e) {
        // A record file that cannot be read cannot be ruled out as the one that
        // refuses; the mount fails rather than shopping past it.
        return unmounted('RECORDS_UNREADABLE', e instanceof Error ? e.message : String(e));
    }

    // The NEWEST record for this configuration decides, passing or not: an
    // older passing record never stands in for a newer failing one.
    const forConfig = records
        .filter((r) => (r.raw as { configHash?: unknown } | null)?.configHash === configHash)
        .sort((a, b) => {
            const pa = String((a.raw as { producedAt?: unknown }).producedAt ?? '');
            const pb = String((b.raw as { producedAt?: unknown }).producedAt ?? '');
            return pa === pb ? a.file.localeCompare(b.file) : pa < pb ? -1 : 1;
        });
    const newest = forConfig[forConfig.length - 1];
    if (!newest) return unmounted('NO_RECORD', `no record under ${PII_RECORDS_DIR} answers ${configHash}`);

    const check = checkPiiEvaluationRecord(newest.raw);
    if (!check.ok) return unmounted(check.reason, `${newest.file}: ${check.detail}`);

    return {
        state: 'MOUNTED',
        detector: createPresidioDetector({ baseUrl, scoreThreshold: check.record.scoreThreshold, fetchImpl: opts.fetchImpl }),
        record: {
            detector: `${check.record.detector.name}@${check.record.detector.revision}`,
            configHash: check.record.configHash,
            producedAt: check.record.producedAt,
        },
    };
}

let cached: PiiDetectorResolution | null = null;

/**
 * The process's resolution. Configuration is env and the records ship in the
 * image, so neither changes while the process runs; resolved once.
 */
export function getPiiDetectorResolution(): PiiDetectorResolution {
    if (cached === null) cached = resolvePiiDetector();
    return cached;
}
