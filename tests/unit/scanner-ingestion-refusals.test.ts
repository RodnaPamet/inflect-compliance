/**
 * `scanner-ingestion.ts` — the refusal, error and edge paths.
 *
 * The two existing unit suites cover the automated-evidence arm and the
 * materialisation cap. Everything that says NO was uncovered: the write/read
 * permission gates, the malformed-SARIF 400, schema rejection, the
 * asset-resolution fallbacks, the "already tracked" skip, the stale-finding
 * reconcile, and the triage validator. Those are the paths an operator hits
 * when something is wrong, and they are exactly the ones where a silent
 * regression is invisible — an ingest that accepts garbage still returns 200.
 *
 * Fixture discipline: the parsed SARIF says SEMGREP/SAST, so every override
 * test passes a DIFFERENT value (TRIVY / DAST) — an implementation that
 * ignored the override and used the parsed value would otherwise be
 * indistinguishable. `sanitizePlainText` is mocked as a visible transform
 * (`SAN:`) rather than identity for the same reason, and `mapCwes` echoes its
 * input so a dropped enrichment cannot look like a correct one.
 */

const mockDb: Record<string, Record<string, jest.Mock>> = {
    scannerRun: { create: jest.fn(), update: jest.fn() },
    scannerFinding: { findMany: jest.fn(), upsert: jest.fn(), updateMany: jest.fn(), update: jest.fn(), findFirst: jest.fn() },
    finding: { findMany: jest.fn(), updateMany: jest.fn() },
    evidence: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    evidenceControlLink: { findFirst: jest.fn(), create: jest.fn() },
    controlEvidenceLink: { findFirst: jest.fn(), create: jest.fn() },
    control: { findFirst: jest.fn() },
    asset: { findFirst: jest.fn() },
    integrationConnection: { findFirst: jest.fn() },
};

const mockRunInTenantContext = jest.fn(
    async (_c: unknown, fn: (db: unknown) => unknown): Promise<unknown> => fn(mockDb),
);
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (...a: [unknown, (db: unknown) => unknown]) => mockRunInTenantContext(...a),
}));

const mockParseSarif = jest.fn();
jest.mock('@/app-layer/services/sarif', () => ({ parseSarif: (...a: unknown[]) => mockParseSarif(...a) }));

// Echoes its input so a row whose enrichment was dropped is distinguishable
// from one that was enriched — `[]` for both would not be.
jest.mock('@/app-layer/services/cwe-mapping', () => ({
    mapCwes: (ids: string[]) => (ids ?? []).map((i) => `MAP:${i}`),
}));

jest.mock('@/app-layer/usecases/finding', () => ({
    createFinding: jest.fn().mockResolvedValue({ id: 'f-created' }),
}));

const mockLogEvent = jest.fn().mockResolvedValue(undefined);
jest.mock('@/app-layer/events/audit', () => ({ logEvent: (...a: unknown[]) => mockLogEvent(...a) }));

// A VISIBLE transform. With identity, "sanitised" and "raw" are the same
// string at runtime and no assertion can tell them apart.
jest.mock('@/lib/security/sanitize', () => ({ sanitizePlainText: (s: string) => `SAN:${s}` }));

jest.mock('@/app-layer/jobs/drain-pages', () => ({
    drainPages: jest.fn(async (fetchPage: (c: string | undefined) => Promise<unknown[]>) => fetchPage(undefined)),
    DRAIN_PAGE_SIZE: 500,
}));

const mockRecordTruncated = jest.fn();
jest.mock('@/lib/observability/integration-metrics', () => ({
    recordScannerFindingsTruncated: (...a: unknown[]) => mockRecordTruncated(...a),
}));

const mockInfo = jest.fn();
const mockWarn = jest.fn();
jest.mock('@/lib/observability', () => ({
    logger: {
        info: (...a: unknown[]) => mockInfo(...a),
        warn: (...a: unknown[]) => mockWarn(...a),
        error: jest.fn(),
        debug: jest.fn(),
    },
    log: jest.fn(),
    traceUsecase: jest.fn(async (_n: string, fn: () => unknown) => fn()),
}));

import { ZodError } from 'zod';
import {
    ingestScannerRun,
    listScannerRuns,
    listScannerFindings,
    listAssetScannerFindings,
    updateScannerFindingStatus,
} from '@/app-layer/usecases/scanner-ingestion';
import { createFinding } from '@/app-layer/usecases/finding';
import { drainPages } from '@/app-layer/jobs/drain-pages';
import { ForbiddenError, ValidationError, NotFoundError } from '@/lib/errors/types';
import { makeRequestContext } from '../helpers/make-context';

const mockCreateFinding = createFinding as jest.MockedFunction<typeof createFinding>;

type Sev = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
const finding = (fp: string, severity: Sev, over: Record<string, unknown> = {}) => ({
    fingerprint: fp,
    ruleId: `rule-${fp}`,
    title: `Title ${fp}`,
    description: `Desc ${fp}`,
    severity,
    location: `src/${fp}.ts`,
    cweIds: [`CWE-${fp}`],
    ...over,
});

/** Parsed SARIF always claims SEMGREP/SAST — overrides in tests use others. */
const parsed = (findings: unknown[]) => ({ source: 'SEMGREP', scanType: 'SAST', findings });

const ADMIN = () => makeRequestContext('ADMIN');
const NO_READ = () =>
    makeRequestContext('READER', {
        permissions: { canRead: false, canWrite: false, canAdmin: false, canAudit: false, canExport: false },
    });

const ingest = (over: Record<string, unknown> = {}, ctx = ADMIN()) =>
    ingestScannerRun(ctx, { sarif: { $schema: 'sarif' }, ...over } as never);

beforeEach(() => {
    jest.clearAllMocks();
    mockRunInTenantContext.mockImplementation(async (_c, fn) => fn(mockDb));
    mockDb.scannerRun.create.mockResolvedValue({ id: 'run-1' });
    mockDb.scannerFinding.upsert.mockResolvedValue({});
    mockDb.scannerFinding.updateMany.mockResolvedValue({ count: 0 });
    mockDb.scannerFinding.findMany.mockResolvedValue([]);
    mockDb.scannerFinding.findFirst.mockResolvedValue(null);
    mockDb.scannerFinding.update.mockResolvedValue({});
    mockDb.finding.findMany.mockResolvedValue([]);
    mockDb.finding.updateMany.mockResolvedValue({ count: 0 });
    mockDb.evidence.findFirst.mockResolvedValue(null);
    mockDb.evidence.create.mockResolvedValue({ id: 'ev-new' });
    mockDb.evidence.update.mockResolvedValue({ id: 'ev-existing' });
    mockDb.evidenceControlLink.create.mockResolvedValue({});
    mockDb.controlEvidenceLink.create.mockResolvedValue({});
    mockDb.control.findFirst.mockResolvedValue({ id: 'ctl-1' });
    mockDb.asset.findFirst.mockResolvedValue(null);
    mockDb.integrationConnection.findFirst.mockResolvedValue(null);
    mockDb.scannerRun.findMany = jest.fn().mockResolvedValue([]);
    mockParseSarif.mockReturnValue(parsed([]));
    mockCreateFinding.mockResolvedValue({ id: 'f-created' } as never);
});

// ─────────────────────────────────────────────────────────────────────
// Permission gates. Every one of these must refuse BEFORE any work — a
// gate that runs after the transaction opens is a gate that already leaked.
// ─────────────────────────────────────────────────────────────────────
describe('permission gates', () => {
    it('ingestScannerRun refuses a READER, and parses nothing', async () => {
        await expect(ingest({}, makeRequestContext('READER'))).rejects.toBeInstanceOf(ForbiddenError);
        expect(mockParseSarif).not.toHaveBeenCalled();
        expect(mockRunInTenantContext).not.toHaveBeenCalled();
    });

    it('ingestScannerRun ADMITS an EDITOR (so the gate is canWrite, not canAdmin)', async () => {
        const out = await ingest({}, makeRequestContext('EDITOR'));
        expect(out.scannerRunId).toBe('run-1');
        expect(mockDb.scannerRun.create).toHaveBeenCalledTimes(1);
    });

    it('updateScannerFindingStatus refuses a READER before validating the status', async () => {
        await expect(
            updateScannerFindingStatus(makeRequestContext('READER'), 'sf-1', 'TRIAGED'),
        ).rejects.toBeInstanceOf(ForbiddenError);
        expect(mockRunInTenantContext).not.toHaveBeenCalled();
    });

    it.each([
        ['listScannerRuns', () => listScannerRuns(NO_READ())],
        ['listScannerFindings', () => listScannerFindings(NO_READ())],
        ['listAssetScannerFindings', () => listAssetScannerFindings(NO_READ(), 'asset-1')],
    ])('%s refuses a context without read permission', async (_n, call) => {
        await expect(call()).rejects.toBeInstanceOf(ForbiddenError);
        expect(mockRunInTenantContext).not.toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────────────────────────────
// Malformed input. A bad upload must 400 before a transaction opens.
// ─────────────────────────────────────────────────────────────────────
describe('malformed input', () => {
    it('turns a parser throw into INVALID_SARIF carrying the parser message, and opens no transaction', async () => {
        mockParseSarif.mockImplementation(() => {
            throw new Error('sarif: runs[] missing');
        });

        const err = await ingest().catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).message).toBe('INVALID_SARIF');
        // The parser's own message is preserved as details — that is the only
        // thing that tells an operator WHICH part of their upload was wrong.
        expect((err as ValidationError).details).toBe('sarif: runs[] missing');
        expect(mockRunInTenantContext).not.toHaveBeenCalled();
        expect(mockDb.scannerRun.create).not.toHaveBeenCalled();
    });

    it('falls back to a generic detail when the parser throws a non-Error', async () => {
        mockParseSarif.mockImplementation(() => {
            throw 'a bare string, not an Error';
        });

        const err = await ingest().catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).message).toBe('INVALID_SARIF');
        expect((err as ValidationError).details).toBe('Invalid SARIF document');
    });

    it('rejects an unknown source enum via the schema, after the write gate and before parsing', async () => {
        const err = await ingest({ source: 'NESSUS' }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ZodError);
        expect(mockParseSarif).not.toHaveBeenCalled();
        expect(mockDb.scannerRun.create).not.toHaveBeenCalled();
    });

    it('rejects a repoRef longer than 500 characters', async () => {
        const err = await ingest({ repoRef: 'r'.repeat(501) }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ZodError);
        expect(mockDb.scannerRun.create).not.toHaveBeenCalled();
    });

    it('applies the ingestedVia default rather than trusting the caller to supply one', async () => {
        await ingest();
        expect(mockDb.scannerRun.create.mock.calls[0][0].data.ingestedVia).toBe('API');

        jest.clearAllMocks();
        mockDb.scannerRun.create.mockResolvedValue({ id: 'run-1' });
        mockParseSarif.mockReturnValue(parsed([]));
        await ingest({ ingestedVia: 'UPLOAD' });
        expect(mockDb.scannerRun.create.mock.calls[0][0].data.ingestedVia).toBe('UPLOAD');
    });
});

// ─────────────────────────────────────────────────────────────────────
// Overrides. The parsed document says SEMGREP/SAST; each override names a
// different value so "used the override" and "used the parse" differ.
// ─────────────────────────────────────────────────────────────────────
describe('caller overrides of the parsed metadata', () => {
    it('uses the parsed source and scanType when nothing is overridden', async () => {
        const out = await ingest({ controlId: 'ctl-1' });
        expect(out.source).toBe('SEMGREP');
        expect(out.scanType).toBe('SAST');
        expect(mockDb.evidence.create.mock.calls[0][0].data.category).toBe('scanner:SEMGREP');
    });

    it('an explicit source overrides the parsed one everywhere it is used', async () => {
        const out = await ingest({ controlId: 'ctl-1', source: 'TRIVY' });

        expect(out.source).toBe('TRIVY');
        expect(mockDb.scannerRun.create.mock.calls[0][0].data.source).toBe('TRIVY');
        // The evidence category is source-scoped, so a regression here would
        // also silently split one rolling row into two.
        expect(mockDb.evidence.create.mock.calls[0][0].data.category).toBe('scanner:TRIVY');
    });

    it('an explicit scanType overrides the parsed one', async () => {
        const out = await ingest({ controlId: 'ctl-1', scanType: 'DAST' });
        expect(out.scanType).toBe('DAST');
        expect(mockDb.scannerRun.create.mock.calls[0][0].data.scanType).toBe('DAST');
        expect(mockDb.evidence.create.mock.calls[0][0].data.title).toBe('Automated evidence — SEMGREP DAST');
    });

    it('an explicit PASS overrides a derived FAIL — and evidence IS then written', async () => {
        mockParseSarif.mockReturnValue(parsed([finding('a', 'CRITICAL')]));

        const out = await ingest({ controlId: 'ctl-1', outcome: 'PASS' });

        expect(out.outcome).toBe('PASS');
        expect(out.evidenceId).toBe('ev-new');
        // Derived would have been FAIL for this same input — that is the
        // difference the override makes.
        expect(out.aboveThresholdTotal).toBe(1);
    });

    it('an explicit ERROR on a clean scan suppresses the evidence a derived PASS would have written', async () => {
        const out = await ingest({ controlId: 'ctl-1', outcome: 'ERROR' });

        expect(out.outcome).toBe('ERROR');
        expect(out.evidenceId).toBeNull();
        expect(mockDb.evidence.create).not.toHaveBeenCalled();
        expect(mockDb.scannerRun.create.mock.calls[0][0].data.outcome).toBe('ERROR');
    });
});

// ─────────────────────────────────────────────────────────────────────
// Threshold gating. Severity decides what becomes a Finding at all.
// ─────────────────────────────────────────────────────────────────────
describe('severity threshold gating', () => {
    const mixed = () =>
        mockParseSarif.mockReturnValue(
            parsed([finding('lo', 'LOW'), finding('me', 'MEDIUM'), finding('hi', 'HIGH'), finding('cr', 'CRITICAL')]),
        );

    it('defaults to HIGH — LOW and MEDIUM are ingested but never materialised', async () => {
        mixed();
        const out = await ingest();

        expect(out.findingsIngested).toBe(4);
        expect(out.aboveThresholdTotal).toBe(2);
        expect(out.outcome).toBe('FAIL');
        expect(mockCreateFinding.mock.calls.map((c) => c[1].sourceRef)).toStrictEqual(['hi', 'cr']);
    });

    it('a LOW threshold materialises every one of them', async () => {
        mixed();
        const out = await ingest({ findingThreshold: 'LOW' });

        expect(out.aboveThresholdTotal).toBe(4);
        expect(mockCreateFinding.mock.calls.map((c) => c[1].sourceRef)).toStrictEqual(['lo', 'me', 'hi', 'cr']);
    });

    it('a CRITICAL threshold materialises only the CRITICAL one', async () => {
        mixed();
        const out = await ingest({ findingThreshold: 'CRITICAL' });

        expect(out.aboveThresholdTotal).toBe(1);
        expect(mockCreateFinding.mock.calls.map((c) => c[1].sourceRef)).toStrictEqual(['cr']);
    });

    it('a scan whose findings are all below threshold derives PASS, not FAIL', async () => {
        mockParseSarif.mockReturnValue(parsed([finding('lo', 'LOW'), finding('me', 'MEDIUM')]));

        const out = await ingest({ controlId: 'ctl-1' });

        expect(out.outcome).toBe('PASS');
        expect(out.findingsIngested).toBe(2);
        expect(out.aboveThresholdTotal).toBe(0);
        // ...and it therefore produces evidence, unlike the mixed scan above.
        expect(out.evidenceId).toBe('ev-new');
    });
});

// ─────────────────────────────────────────────────────────────────────
// Asset resolution. externalRef beats name; no match is logged, never guessed.
// ─────────────────────────────────────────────────────────────────────
describe('scan-target → asset resolution', () => {
    /** Distinct ids per lookup kind so "which query answered" is observable. */
    const assetBy = (opts: { externalRef?: string | null; name?: string | null }) =>
        mockDb.asset.findFirst.mockImplementation(
            async (args: { where: Record<string, unknown> }): Promise<{ id: string } | null> => {
                if ('externalRef' in args.where) return opts.externalRef ? { id: opts.externalRef } : null;
                return opts.name ? { id: opts.name } : null;
            },
        );

    it('strips the @ref suffix and matches Asset.externalRef case-insensitively', async () => {
        assetBy({ externalRef: 'asset-by-externalref', name: 'asset-by-name' });
        mockParseSarif.mockReturnValue(parsed([finding('a', 'HIGH')]));

        await ingest({ repoRef: 'owner/repo@deadbeef' });

        expect(mockDb.asset.findFirst.mock.calls[0][0].where).toMatchObject({
            tenantId: 'tenant-1',
            externalRef: { equals: 'owner/repo', mode: 'insensitive' },
        });
        // externalRef wins: the name lookup is never even issued.
        expect(mockDb.asset.findFirst).toHaveBeenCalledTimes(1);
        expect(mockDb.scannerFinding.upsert.mock.calls[0][0].create.assetId).toBe('asset-by-externalref');
    });

    it('falls back to Asset.name only when externalRef misses', async () => {
        assetBy({ externalRef: null, name: 'asset-by-name' });
        mockParseSarif.mockReturnValue(parsed([finding('a', 'HIGH')]));

        await ingest({ repoRef: 'owner/repo' });

        expect(mockDb.asset.findFirst).toHaveBeenCalledTimes(2);
        expect(mockDb.asset.findFirst.mock.calls[1][0].where).toMatchObject({
            name: { equals: 'owner/repo', mode: 'insensitive' },
        });
        expect(mockDb.scannerFinding.upsert.mock.calls[0][0].create.assetId).toBe('asset-by-name');
    });

    it('leaves findings UNLINKED and logs the target when nothing matches — and does not null an existing link', async () => {
        assetBy({ externalRef: null, name: null });
        mockParseSarif.mockReturnValue(parsed([finding('a', 'HIGH')]));

        await ingest({ repoRef: 'ghost/repo@sha' });

        const upsert = mockDb.scannerFinding.upsert.mock.calls[0][0];
        expect(upsert.create.assetId).toBeNull();
        // The update arm must OMIT assetId entirely; writing `assetId: null`
        // there would erase a link an earlier, successful run had made.
        expect(Object.prototype.hasOwnProperty.call(upsert.update, 'assetId')).toBe(false);

        const logged = mockInfo.mock.calls.find(([m]) => String(m).includes('did not resolve to an asset'));
        expect(logged).toBeDefined();
        expect(logged![1]).toMatchObject({ component: 'scanner-ingestion', repoRef: 'ghost/repo' });
    });

    it('a resolved asset IS carried on the update arm', async () => {
        assetBy({ externalRef: 'asset-by-externalref' });
        mockParseSarif.mockReturnValue(parsed([finding('a', 'HIGH')]));

        await ingest({ repoRef: 'owner/repo' });

        expect(mockDb.scannerFinding.upsert.mock.calls[0][0].update.assetId).toBe('asset-by-externalref');
    });

    it('looks up no asset at all when no repoRef was supplied', async () => {
        mockParseSarif.mockReturnValue(parsed([finding('a', 'HIGH')]));

        await ingest();

        expect(mockDb.asset.findFirst).not.toHaveBeenCalled();
        expect(mockInfo.mock.calls.filter(([m]) => String(m).includes('did not resolve'))).toHaveLength(0);
        expect(mockDb.scannerRun.create.mock.calls[0][0].data.repoRef).toBeNull();
    });

    it('a repoRef that is only an @ref resolves to an empty target — no lookup, no "unresolved" log', async () => {
        mockParseSarif.mockReturnValue(parsed([finding('a', 'HIGH')]));

        await ingest({ repoRef: '@deadbeef' });

        expect(mockDb.asset.findFirst).not.toHaveBeenCalled();
        // Distinguishes this from the genuine no-match case above, which DOES log.
        expect(mockInfo.mock.calls.filter(([m]) => String(m).includes('did not resolve'))).toHaveLength(0);
    });

    it('persists the repoRef SANITISED while matching the asset on the raw value', async () => {
        assetBy({ externalRef: 'asset-by-externalref' });

        await ingest({ repoRef: 'owner/repo@sha' });

        expect(mockDb.scannerRun.create.mock.calls[0][0].data.repoRef).toBe('SAN:owner/repo@sha');
        expect(mockDb.asset.findFirst.mock.calls[0][0].where.externalRef.equals).toBe('owner/repo');
    });
});

// ─────────────────────────────────────────────────────────────────────
// Per-finding persistence.
// ─────────────────────────────────────────────────────────────────────
describe('scanner-finding upsert', () => {
    it('sanitises title and description on both arms, and keys the upsert on (tenant, fingerprint)', async () => {
        mockParseSarif.mockReturnValue(parsed([finding('a', 'HIGH')]));

        await ingest();

        const call = mockDb.scannerFinding.upsert.mock.calls[0][0];
        expect(call.where).toStrictEqual({ tenantId_fingerprint: { tenantId: 'tenant-1', fingerprint: 'a' } });
        expect(call.create.title).toBe('SAN:Title a');
        expect(call.create.description).toBe('SAN:Desc a');
        expect(call.update.title).toBe('SAN:Title a');
        expect(call.update.description).toBe('SAN:Desc a');
        // The create arm seeds OPEN; the update arm must NOT carry a status, or
        // a re-scan would reopen a FALSE_POSITIVE an analyst had triaged.
        expect(call.create.status).toBe('OPEN');
        expect(Object.prototype.hasOwnProperty.call(call.update, 'status')).toBe(false);
    });

    it('writes a null description rather than sanitising a missing one', async () => {
        mockParseSarif.mockReturnValue(parsed([finding('a', 'HIGH', { description: null })]));

        await ingest();

        const call = mockDb.scannerFinding.upsert.mock.calls[0][0];
        expect(call.create.description).toBeNull();
        expect(call.update.description).toBeNull();
        // ...and the Finding still gets a description: it falls back to the title.
        expect(mockCreateFinding.mock.calls[0][1].description).toBe('Title a');
    });

    it('titles the materialised Finding with the RAW scanner title, prefixed by source', async () => {
        mockParseSarif.mockReturnValue(parsed([finding('a', 'CRITICAL')]));

        await ingest({ source: 'TRIVY' });

        expect(mockCreateFinding.mock.calls[0][1]).toMatchObject({
            title: 'TRIVY: Title a',
            severity: 'CRITICAL',
            type: 'NONCONFORMITY',
            sourceKind: 'SCANNER',
            sourceRef: 'a',
        });
    });
});

// ─────────────────────────────────────────────────────────────────────
// Evidence-link edge: a duplicate bridge link must not fail the ingest.
// ─────────────────────────────────────────────────────────────────────
describe('control-evidence bridge link', () => {
    it('swallows a duplicate ControlEvidenceLink and still returns the evidence', async () => {
        mockDb.controlEvidenceLink.create.mockRejectedValue(new Error('unique constraint'));

        const out = await ingest({ controlId: 'ctl-1' });

        expect(out.evidenceId).toBe('ev-new');
        expect(mockDb.controlEvidenceLink.create).toHaveBeenCalledTimes(1);
    });

    it('records the acting user on the evidence link, and null when the context has none', async () => {
        await ingest({ controlId: 'ctl-1' });
        expect(mockDb.evidenceControlLink.create.mock.calls[0][0].data.createdByUserId).toBe('user-1');

        jest.clearAllMocks();
        mockDb.scannerRun.create.mockResolvedValue({ id: 'run-1' });
        mockDb.evidence.findFirst.mockResolvedValue(null);
        mockDb.evidence.create.mockResolvedValue({ id: 'ev-new' });
        mockDb.control.findFirst.mockResolvedValue({ id: 'ctl-1' });
        mockDb.evidenceControlLink.create.mockResolvedValue({});
        mockDb.controlEvidenceLink.create.mockResolvedValue({});
        mockParseSarif.mockReturnValue(parsed([]));

        await ingest({ controlId: 'ctl-1' }, makeRequestContext('ADMIN', { userId: undefined }));
        expect(mockDb.evidenceControlLink.create.mock.calls[0][0].data.createdByUserId).toBeNull();
    });

    it('names the scanned repo in the evidence summary, and omits the parenthetical when there is none', async () => {
        await ingest({ controlId: 'ctl-1', repoRef: 'owner/repo@sha' });
        const withRef = mockDb.evidence.create.mock.calls[0][0].data.content;
        expect(withRef).toContain('(SAN:owner/repo@sha)');

        jest.clearAllMocks();
        mockDb.scannerRun.create.mockResolvedValue({ id: 'run-1' });
        mockDb.control.findFirst.mockResolvedValue({ id: 'ctl-1' });
        mockDb.evidence.findFirst.mockResolvedValue(null);
        mockDb.evidence.create.mockResolvedValue({ id: 'ev-new' });
        mockDb.evidenceControlLink.create.mockResolvedValue({});
        mockDb.controlEvidenceLink.create.mockResolvedValue({});
        mockParseSarif.mockReturnValue(parsed([]));

        await ingest({ controlId: 'ctl-1' });
        const withoutRef = mockDb.evidence.create.mock.calls[0][0].data.content;
        // No trailing parenthetical at all — the summary stops at the
        // threshold clause. (`toContain('(')` would be satisfied by the
        // literal "finding(s)" earlier in the same string.)
        expect(withoutRef).toMatch(/0 at\/above HIGH\.$/);
        expect(withRef).toMatch(/0 at\/above HIGH\. \(SAN:owner\/repo@sha\)$/);
    });
});

// ─────────────────────────────────────────────────────────────────────
// Phase 2 — dedupe against existing Findings, and the stale reconcile.
// ─────────────────────────────────────────────────────────────────────
describe('finding materialisation and reconcile', () => {
    it('skips phase 2 entirely when materializeFindings is false', async () => {
        mockParseSarif.mockReturnValue(parsed([finding('a', 'CRITICAL')]));

        const out = await ingest({ materializeFindings: false });

        expect(mockDb.finding.findMany).not.toHaveBeenCalled();
        expect(mockCreateFinding).not.toHaveBeenCalled();
        expect(mockDb.finding.updateMany).not.toHaveBeenCalled();
        expect(out.findingsMaterialized).toBe(0);
        // The run itself is still recorded and still FAILS — the opt-out is
        // about Findings, not about the scan result.
        expect(out.outcome).toBe('FAIL');
        expect(out.aboveThresholdTotal).toBe(1);
    });

    it('does not re-create a Finding that is already tracked and open', async () => {
        mockDb.finding.findMany.mockResolvedValue([{ id: 'f-old', sourceRef: 'a', status: 'OPEN' }]);
        mockParseSarif.mockReturnValue(parsed([finding('a', 'CRITICAL')]));

        const out = await ingest();

        expect(mockCreateFinding).not.toHaveBeenCalled();
        expect(out.findingsMaterialized).toBe(0);
    });

    it('DOES re-create a Finding whose prior instance was closed (the issue came back)', async () => {
        mockDb.finding.findMany.mockResolvedValue([{ id: 'f-old', sourceRef: 'a', status: 'CLOSED' }]);
        mockParseSarif.mockReturnValue(parsed([finding('a', 'CRITICAL')]));

        const out = await ingest();

        expect(mockCreateFinding).toHaveBeenCalledTimes(1);
        expect(mockCreateFinding.mock.calls[0][1].sourceRef).toBe('a');
        expect(out.findingsMaterialized).toBe(1);
    });

    it('walks the drain cursor with skip:1 so a page boundary neither repeats nor loses a row', async () => {
        const drain = drainPages as jest.MockedFunction<typeof drainPages>;
        // Two pages: the second call carries the last id of the first.
        drain.mockImplementationOnce(async (fetchPage) => {
            const first = await fetchPage(undefined);
            const second = await fetchPage('f-page1-last');
            return [...first, ...second];
        });
        mockDb.finding.findMany
            .mockResolvedValueOnce([{ id: 'f-page1-last', sourceRef: 'a', status: 'OPEN' }])
            .mockResolvedValueOnce([]);
        mockParseSarif.mockReturnValue(parsed([finding('a', 'CRITICAL')]));

        const out = await ingest();

        const [firstArgs, secondArgs] = mockDb.finding.findMany.mock.calls.map((c) => c[0]);
        // Page 1 must NOT carry a cursor, or it would skip the first row.
        expect(Object.prototype.hasOwnProperty.call(firstArgs, 'cursor')).toBe(false);
        expect(secondArgs.cursor).toStrictEqual({ id: 'f-page1-last' });
        expect(secondArgs.skip).toBe(1);
        // And the row page 1 returned really did reach the dedupe map: 'a' is
        // already tracked and open, so nothing is materialised.
        expect(mockCreateFinding).not.toHaveBeenCalled();
        expect(out.findingsMaterialized).toBe(0);
    });

    it('drains scanner-sourced findings only, excluding soft-deleted ones', async () => {
        mockParseSarif.mockReturnValue(parsed([finding('a', 'CRITICAL')]));

        await ingest();

        expect(mockDb.finding.findMany.mock.calls[0][0].where).toStrictEqual({
            tenantId: 'tenant-1',
            sourceKind: 'SCANNER',
            deletedAt: null,
        });
    });

    it('ignores an existing Finding with no sourceRef instead of keying history on it', async () => {
        mockDb.finding.findMany.mockResolvedValue([{ id: 'f-null', sourceRef: null, status: 'OPEN' }]);
        mockParseSarif.mockReturnValue(parsed([finding('a', 'CRITICAL')]));

        const out = await ingest();

        // It is neither treated as already-tracked...
        expect(out.findingsMaterialized).toBe(1);
        // ...nor swept into the stale-close set (a null ref matches nothing).
        expect(mockDb.finding.updateMany).not.toHaveBeenCalled();
        expect(out.findingsReconciledClosed).toBe(0);
    });

    it('closes findings that dropped out of the scan, and marks their scanner rows FIXED', async () => {
        mockDb.finding.findMany.mockResolvedValue([
            { id: 'f-gone', sourceRef: 'gone', status: 'OPEN' },
            { id: 'f-still', sourceRef: 'a', status: 'OPEN' },
        ]);
        mockDb.finding.updateMany.mockResolvedValue({ count: 7 });
        mockParseSarif.mockReturnValue(parsed([finding('a', 'CRITICAL')]));

        const out = await ingest({ source: 'TRIVY' });

        const where = mockDb.finding.updateMany.mock.calls[0][0].where;
        // Only the absent one — 'a' is still reported, so it must survive.
        expect(where.sourceRef).toStrictEqual({ in: ['gone'] });
        expect(where).toMatchObject({ tenantId: 'tenant-1', sourceKind: 'SCANNER', status: { not: 'CLOSED' } });

        const data = mockDb.finding.updateMany.mock.calls[0][0].data;
        expect(data.status).toBe('CLOSED');
        expect(data.verificationNotes).toContain('no longer reported by TRIVY scan');
        expect(data.verifiedAt).toBeInstanceOf(Date);

        // The count comes from the DB, not from staleRefs.length — a
        // regression that returned the latter would report 1 here.
        expect(out.findingsReconciledClosed).toBe(7);

        expect(mockDb.scannerFinding.updateMany).toHaveBeenCalledWith({
            where: { tenantId: 'tenant-1', fingerprint: { in: ['gone'] }, status: { not: 'FALSE_POSITIVE' } },
            data: { status: 'FIXED' },
        });
    });

    it('does not re-close an already-CLOSED finding that is absent from the scan', async () => {
        mockDb.finding.findMany.mockResolvedValue([{ id: 'f-done', sourceRef: 'gone', status: 'CLOSED' }]);
        mockParseSarif.mockReturnValue(parsed([finding('a', 'CRITICAL')]));

        const out = await ingest();

        expect(mockDb.finding.updateMany).not.toHaveBeenCalled();
        expect(mockDb.scannerFinding.updateMany).not.toHaveBeenCalled();
        expect(out.findingsReconciledClosed).toBe(0);
    });

    it('reconciles against ABOVE-THRESHOLD findings only — a demoted-to-LOW issue is closed', async () => {
        mockDb.finding.findMany.mockResolvedValue([{ id: 'f-demoted', sourceRef: 'lo', status: 'OPEN' }]);
        mockDb.finding.updateMany.mockResolvedValue({ count: 1 });
        // 'lo' is still in the scan, but below the HIGH default, so it is not a
        // current ref and reconciles closed.
        mockParseSarif.mockReturnValue(parsed([finding('lo', 'LOW'), finding('a', 'CRITICAL')]));

        const out = await ingest();

        expect(mockDb.finding.updateMany.mock.calls[0][0].where.sourceRef).toStrictEqual({ in: ['lo'] });
        expect(out.findingsReconciledClosed).toBe(1);
    });
});

// ─────────────────────────────────────────────────────────────────────
// The audit event on ingest.
// ─────────────────────────────────────────────────────────────────────
describe('ingest audit event', () => {
    it('flags an unmapped run in the details so a silent no-evidence ingest is legible', async () => {
        const out = await ingest();

        expect(out.controlId).toBeNull();
        const payload = mockLogEvent.mock.calls[0][2];
        expect(payload.action).toBe('SCANNER_RUN_INGESTED');
        expect(payload.entityId).toBe('run-1');
        expect(payload.details).toContain('[unmapped: no automated evidence]');
        expect(payload.metadata).toMatchObject({ controlId: null, evidenceId: null });
    });

    it('omits the unmapped flag and names the evidence when a control resolved', async () => {
        const payload = await ingest({ controlId: 'ctl-1' }).then(() => mockLogEvent.mock.calls[0][2]);

        expect(payload.details).not.toContain('unmapped');
        expect(payload.metadata).toMatchObject({ controlId: 'ctl-1', evidenceId: 'ev-new' });
    });
});

// ─────────────────────────────────────────────────────────────────────
// Reads.
// ─────────────────────────────────────────────────────────────────────
describe('listScannerRuns', () => {
    it('defaults to 100 rows scoped to the tenant with no source filter', async () => {
        await listScannerRuns(ADMIN());
        const args = mockDb.scannerRun.findMany.mock.calls[0][0];
        expect(args.where).toStrictEqual({ tenantId: 'tenant-1' });
        expect(args.take).toBe(100);
        expect(args.orderBy).toStrictEqual({ ranAt: 'desc' });
    });

    it('filters by source when one is given', async () => {
        await listScannerRuns(ADMIN(), { source: 'TRIVY' });
        expect(mockDb.scannerRun.findMany.mock.calls[0][0].where).toStrictEqual({
            tenantId: 'tenant-1',
            source: 'TRIVY',
        });
    });

    it('clamps an oversized take to 200 but honours a smaller one', async () => {
        await listScannerRuns(ADMIN(), { take: 5000 });
        expect(mockDb.scannerRun.findMany.mock.calls[0][0].take).toBe(200);

        await listScannerRuns(ADMIN(), { take: 7 });
        expect(mockDb.scannerRun.findMany.mock.calls[1][0].take).toBe(7);
    });
});

describe('listScannerFindings', () => {
    beforeEach(() => {
        mockDb.scannerFinding.findMany.mockResolvedValue([
            { id: 'sf-1', cweIds: ['CWE-79'] },
            { id: 'sf-2', cweIds: [] },
        ]);
    });

    it('applies no status/severity keys when none are given, and defaults take to 200', async () => {
        await listScannerFindings(ADMIN());
        const args = mockDb.scannerFinding.findMany.mock.calls[0][0];
        expect(args.where).toStrictEqual({ tenantId: 'tenant-1' });
        expect(args.take).toBe(200);
    });

    it('applies both filters when both are given, and clamps take to 500', async () => {
        await listScannerFindings(ADMIN(), { status: 'TRIAGED', severity: 'HIGH', take: 9999 });
        const args = mockDb.scannerFinding.findMany.mock.calls[0][0];
        expect(args.where).toStrictEqual({ tenantId: 'tenant-1', status: 'TRIAGED', severity: 'HIGH' });
        expect(args.take).toBe(500);
    });

    it('enriches each row with the CWE cross-walk, per row', async () => {
        const rows = await listScannerFindings(ADMIN());
        expect(rows.map((r) => r.frameworks)).toStrictEqual([['MAP:CWE-79'], []]);
        expect(rows[0].id).toBe('sf-1');
    });
});

describe('listAssetScannerFindings', () => {
    it('scopes to the asset and enriches the rows', async () => {
        mockDb.scannerFinding.findMany.mockResolvedValue([{ id: 'sf-9', cweIds: ['CWE-22'] }]);

        const rows = await listAssetScannerFindings(ADMIN(), 'asset-42');

        const args = mockDb.scannerFinding.findMany.mock.calls[0][0];
        expect(args.where).toStrictEqual({ tenantId: 'tenant-1', assetId: 'asset-42' });
        expect(args.take).toBe(200);
        expect(rows).toStrictEqual([{ id: 'sf-9', cweIds: ['CWE-22'], frameworks: ['MAP:CWE-22'] }]);
    });
});

// ─────────────────────────────────────────────────────────────────────
// Triage.
// ─────────────────────────────────────────────────────────────────────
describe('updateScannerFindingStatus', () => {
    it('rejects a status outside the analyst set, naming the allowed values, before touching the DB', async () => {
        const err = await updateScannerFindingStatus(ADMIN(), 'sf-1', 'DELETED').catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).message).toBe('INVALID_STATUS');
        expect((err as ValidationError).details).toContain('FALSE_POSITIVE');
        expect(mockRunInTenantContext).not.toHaveBeenCalled();
    });

    it('404s a finding that is not in this tenant, and writes nothing', async () => {
        mockDb.scannerFinding.findFirst.mockResolvedValue(null);

        await expect(updateScannerFindingStatus(ADMIN(), 'sf-elsewhere', 'TRIAGED')).rejects.toBeInstanceOf(
            NotFoundError,
        );

        expect(mockDb.scannerFinding.findFirst.mock.calls[0][0].where).toStrictEqual({
            id: 'sf-elsewhere',
            tenantId: 'tenant-1',
        });
        expect(mockDb.scannerFinding.update).not.toHaveBeenCalled();
        expect(mockLogEvent).not.toHaveBeenCalled();
    });

    it('audits the from→to transition using the PRIOR status, not the new one', async () => {
        mockDb.scannerFinding.findFirst.mockResolvedValue({ id: 'sf-1', status: 'OPEN', title: 'T' });
        mockDb.scannerFinding.update.mockResolvedValue({ id: 'sf-1', status: 'FALSE_POSITIVE' });

        const out = await updateScannerFindingStatus(ADMIN(), 'sf-1', 'FALSE_POSITIVE');

        expect(mockDb.scannerFinding.update).toHaveBeenCalledWith({
            where: { id: 'sf-1' },
            data: { status: 'FALSE_POSITIVE' },
        });
        const payload = mockLogEvent.mock.calls[0][2];
        expect(payload.action).toBe('SCANNER_FINDING_TRIAGED');
        expect(payload.entityType).toBe('ScannerFinding');
        expect(payload.metadata).toStrictEqual({ from: 'OPEN', to: 'FALSE_POSITIVE' });
        expect(payload.details).toBe('Scanner finding status OPEN → FALSE_POSITIVE');
        expect(out).toStrictEqual({ id: 'sf-1', status: 'FALSE_POSITIVE' });
    });

    it.each(['OPEN', 'TRIAGED', 'FIXED', 'FALSE_POSITIVE', 'ACCEPTED'])(
        'accepts the analyst status %s',
        async (status) => {
            mockDb.scannerFinding.findFirst.mockResolvedValue({ id: 'sf-1', status: 'OPEN', title: 'T' });
            mockDb.scannerFinding.update.mockResolvedValue({ id: 'sf-1', status });

            await expect(updateScannerFindingStatus(ADMIN(), 'sf-1', status)).resolves.toStrictEqual({
                id: 'sf-1',
                status,
            });
        },
    );
});
