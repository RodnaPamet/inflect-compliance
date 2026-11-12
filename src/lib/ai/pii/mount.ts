/**
 * WHETHER THIS DEPLOYMENT HAS A PII DETECTOR — the mount gate (Phase 1.4).
 *
 * Three answers, and the difference between the first two is load-bearing:
 *
 *   ABSENT     `AI_PII_BASE_URL` is unset. Nothing is constructed (G9), and
 *              redaction is OFF for every tenant — the deployment key of the
 *              two (Phase 2.1 adds the tenant's).
 *   UNMOUNTED  the operator configured a detector and it may not be used: no
 *              config hash, a base URL that is not an in-deployment address,
 *              no committed record for the deployed configuration, a record
 *              made by a different detector, a record that does not answer the
 *              committed fixture corpus, or one whose RECOMPUTED rates or
 *              support fall short. The egress use BLOCKS for a tenant with
 *              redaction on (`./egress.ts`): the operator asked for a
 *              detector, and the one they have cannot vouch for itself.
 *   MOUNTED    a Presidio provider, asking for the threshold records are
 *              measured at (`PII_SCORE_THRESHOLD`).
 *
 * This is the ONLY module that constructs the Presidio provider, the ONLY
 * reader of `AI_PII_BASE_URL` (G6 as amended 2026-11-12: an in-deployment
 * service's URL is operator config read by exactly one module —
 * `tests/guards/ssrf-egress-coverage.test.ts`), and the only call of
 * `resolvePiiDetector` under `src/` passes no options
 * (`tests/guards/pii-detector-single-seam.test.ts`), so "mounted only with a
 * passing record" is not a convention a second caller could skip, nor one a
 * caller could re-point at another directory.
 *
 * The base URL's STRUCTURE is judged here (`checkPerimeterUrl`: http or https,
 * no credentials, no metadata host, no literal outside the deployment); what
 * the host RESOLVES to is judged at every call by the shared in-deployment
 * dial, which refuses a public address before sending anything.
 *
 * Records are read from `evals/pii/records/*.json` and the ground truth from
 * the committed corpus `tests/fixtures/pii/corpus.json` (Phase 0's, the one
 * ground truth), both relative to the process's working directory. One record
 * exists today, for Phase 0's configuration, and it does not mount: the corpus
 * is below `PII_MIN_SUPPORT` and EN PERSON precision is below the floor — the
 * designed state, not a gap.
 *
 * ── WHICH RECORD DECIDES ────────────────────────────────────────────────────
 *
 * The NEWEST record for the configuration, by the instant its `ranAt` names
 * (`Date.parse`, never string order: "…00:00:00.500Z" sorts before
 * "…00:00:00Z"), passing or not — an older pass never stands in for a newer
 * failure. Every record that names this configuration, or names none, is
 * schema-checked first: a malformed one cannot be placed in time, so it cannot
 * be ruled out as the newest and refuses the mount rather than being skipped.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { env } from '@/env';
import { checkPerimeterUrl } from '@/lib/ai/in-deployment-service';

import {
    checkPiiEvaluationRecord,
    PII_SCORE_THRESHOLD,
    PiiEvaluationRecordSchema,
    type PiiMountCheckRefusal,
} from './evaluation-record';
import { createPresidioDetector, PRESIDIO_DETECTOR_ID } from './presidio-provider';
import type { PiiDetector } from './types';

export const PII_RECORDS_DIR = path.join('evals', 'pii', 'records');
export const PII_CORPUS_FILE = path.join('tests', 'fixtures', 'pii', 'corpus.json');

export type PiiMountRefusal =
    | 'NO_CONFIG_HASH'
    | 'BASE_URL_OUTSIDE_DEPLOYMENT'
    | 'RECORDS_UNREADABLE'
    | 'NO_RECORD'
    | 'DETECTOR_MISMATCH'
    | 'NO_CORPUS'
    | PiiMountCheckRefusal;

export type PiiDetectorResolution =
    | { readonly state: 'ABSENT' }
    | { readonly state: 'UNMOUNTED'; readonly reason: PiiMountRefusal; readonly detail: string }
    | {
        readonly state: 'MOUNTED';
        readonly detector: PiiDetector;
        readonly record: { readonly detector: string; readonly configHash: string; readonly ranAt: string };
    };

/**
 * Test seams, all three. Production passes nothing and reads the env and the
 * working directory; no caller under `src/` may pass any (the single-seam
 * guard). There is no fetch seam: the provider reaches its service only
 * through the in-deployment dial.
 */
export interface ResolvePiiDetectorOptions {
    readonly baseUrl?: string;
    readonly configHash?: string;
    /** The directory `evals/pii/records/` and `tests/fixtures/pii/` are read under. */
    readonly root?: string;
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

/** The configuration a raw record names, if it names one as a string. */
function namedConfig(raw: unknown): unknown {
    const detector = (raw as { detector?: unknown } | null)?.detector;
    return (detector as { configHash?: unknown } | null | undefined)?.configHash;
}

export function resolvePiiDetector(opts: ResolvePiiDetectorOptions = {}): PiiDetectorResolution {
    const baseUrl = 'baseUrl' in opts ? opts.baseUrl : env.AI_PII_BASE_URL;
    const configHash = 'configHash' in opts ? opts.configHash : env.AI_PII_CONFIG_HASH;
    if (!baseUrl) return { state: 'ABSENT' };
    if (!configHash) {
        return unmounted('NO_CONFIG_HASH', 'AI_PII_BASE_URL is set but AI_PII_CONFIG_HASH does not name the deployed configuration');
    }
    const where = checkPerimeterUrl(baseUrl);
    if (!where.ok) {
        return unmounted('BASE_URL_OUTSIDE_DEPLOYMENT', `the detector is an in-deployment service, and its base URL is refused: ${where.reason}`);
    }

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
        const named = namedConfig(r.raw);
        if (typeof named === 'string' && named !== configHash) continue;
        const parsed = PiiEvaluationRecordSchema.safeParse(r.raw);
        if (!parsed.success) {
            return unmounted('MALFORMED_RECORD', `${r.file}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
        }
        forConfig.push({ file: r.file, raw: r.raw, detectorName: parsed.data.detector.name, at: Date.parse(parsed.data.ranAt) });
    }
    forConfig.sort((a, b) => (a.at === b.at ? a.file.localeCompare(b.file) : a.at - b.at));
    const newest = forConfig[forConfig.length - 1];
    if (!newest) return unmounted('NO_RECORD', `no record under ${PII_RECORDS_DIR} answers ${configHash}`);

    // The record must have measured THIS provider. A record from the fixture
    // stub answers perfectly by construction and measures nothing.
    if (newest.detectorName !== PRESIDIO_DETECTOR_ID) {
        return unmounted('DETECTOR_MISMATCH', `${newest.file} measured '${newest.detectorName}', not '${PRESIDIO_DETECTOR_ID}'`);
    }

    let corpusText: string;
    try {
        corpusText = fs.readFileSync(path.join(root, PII_CORPUS_FILE), 'utf-8');
    } catch (e) {
        return unmounted('NO_CORPUS', `${PII_CORPUS_FILE}: ${e instanceof Error ? e.message : String(e)}`);
    }

    const check = checkPiiEvaluationRecord(newest.raw, corpusText);
    if (!check.ok) return unmounted(check.reason, `${newest.file}: ${check.detail}`);

    return {
        state: 'MOUNTED',
        detector: createPresidioDetector({ baseUrl, scoreThreshold: PII_SCORE_THRESHOLD }),
        record: {
            detector: `${check.record.detector.name}@${check.record.detector.version}`,
            configHash: check.record.detector.configHash,
            ranAt: check.record.ranAt,
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
