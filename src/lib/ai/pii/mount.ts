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
 *              for the deployed configuration, a record made by a different
 *              detector, a record that does not answer the committed fixture
 *              set, or a record whose RECOMPUTED rates fall short. The egress
 *              use BLOCKS for a tenant with redaction on (`./egress.ts`): the
 *              operator asked for a detector, and the one they have cannot
 *              vouch for itself.
 *   MOUNTED    a Presidio provider, built with the threshold its record was
 *              measured at.
 *
 * This is the ONLY module that constructs the Presidio provider, and the only
 * call of `resolvePiiDetector` under `src/` passes no options
 * (`tests/guards/pii-detector-single-seam.test.ts`), so "mounted only with a
 * passing record" is not a convention a second caller could skip, nor one a
 * caller could re-point at another directory or another transport.
 *
 * Records are read from `evals/pii/records/*.json` and the ground truth from
 * `tests/fixtures/pii/fixture-set.json`, both relative to the process's working
 * directory. Neither exists today, so every configured deployment answers
 * UNMOUNTED(NO_RECORD) — the designed state, not a gap.
 *
 * ── WHICH RECORD DECIDES ────────────────────────────────────────────────────
 *
 * The NEWEST record for the configuration, by the instant its `producedAt`
 * names (`Date.parse`, never string order: "…00:00:00.500Z" sorts before
 * "…00:00:00Z"), passing or not — an older pass never stands in for a newer
 * failure. Every record that names this configuration, or names none, is
 * schema-checked first: a malformed one cannot be placed in time, so it cannot
 * be ruled out as the newest and refuses the mount rather than being skipped.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { env } from '@/env';

import { checkPiiEvaluationRecord, PiiEvaluationRecordSchema, type PiiRecordRefusal } from './evaluation-record';
import { createPresidioDetector, PRESIDIO_DETECTOR_ID, type PresidioProviderOptions } from './presidio-provider';
import type { PiiDetector } from './types';

export const PII_RECORDS_DIR = path.join('evals', 'pii', 'records');
export const PII_FIXTURE_SET_FILE = path.join('tests', 'fixtures', 'pii', 'fixture-set.json');

export type PiiMountRefusal =
    | 'NO_CONFIG_HASH'
    | 'BASE_URL_NOT_HTTPS'
    | 'RECORDS_UNREADABLE'
    | 'NO_RECORD'
    | 'DETECTOR_MISMATCH'
    | 'NO_FIXTURE_SET'
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
    /**
     * Test seam: the directory `evals/pii/records/` and `tests/fixtures/pii/`
     * are read under. Production reads the working directory. No caller under
     * `src/` may pass it (the single-seam guard).
     */
    readonly root?: string;
    /** Test seam, handed to the provider. No caller under `src/` may pass it. */
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

    const root = opts.root ?? process.cwd();
    let records: { file: string; raw: unknown }[];
    try {
        records = readRecords(path.join(root, PII_RECORDS_DIR));
    } catch (e) {
        // A record file that cannot be read cannot be ruled out as the one that
        // refuses; the mount fails rather than shopping past it.
        return unmounted('RECORDS_UNREADABLE', e instanceof Error ? e.message : String(e));
    }

    // Every record that names this configuration — or names none, so cannot
    // be ruled out — must parse before any is ordered.
    const forConfig: { file: string; raw: unknown; detectorName: string; at: number }[] = [];
    for (const r of records) {
        const named = (r.raw as { configHash?: unknown } | null)?.configHash;
        if (typeof named === 'string' && named !== configHash) continue;
        const parsed = PiiEvaluationRecordSchema.safeParse(r.raw);
        if (!parsed.success) {
            return unmounted('MALFORMED', `${r.file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
        }
        forConfig.push({ file: r.file, raw: r.raw, detectorName: parsed.data.detector.name, at: Date.parse(parsed.data.producedAt) });
    }
    forConfig.sort((a, b) => (a.at === b.at ? a.file.localeCompare(b.file) : a.at - b.at));
    const newest = forConfig[forConfig.length - 1];
    if (!newest) return unmounted('NO_RECORD', `no record under ${PII_RECORDS_DIR} answers ${configHash}`);

    // The record must have measured THIS provider. A record from the fixture
    // stub answers perfectly by construction and measures nothing.
    if (newest.detectorName !== PRESIDIO_DETECTOR_ID) {
        return unmounted('DETECTOR_MISMATCH', `${newest.file} measured '${newest.detectorName}', not '${PRESIDIO_DETECTOR_ID}'`);
    }

    let fixtureSet: unknown;
    try {
        fixtureSet = JSON.parse(fs.readFileSync(path.join(root, PII_FIXTURE_SET_FILE), 'utf-8')) as unknown;
    } catch (e) {
        return unmounted('NO_FIXTURE_SET', `${PII_FIXTURE_SET_FILE}: ${e instanceof Error ? e.message : String(e)}`);
    }

    const check = checkPiiEvaluationRecord(newest.raw, fixtureSet);
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
