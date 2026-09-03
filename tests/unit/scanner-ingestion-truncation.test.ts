/**
 * The materialisation cap on `ingestScannerRun`, and the fact that it REPORTS
 * ITSELF.
 *
 * `MAX_FINDINGS_PER_INGEST` bounds how many above-threshold findings become
 * real `Finding` rows in one ingest — an unbounded write loop over an
 * attacker-or-accident-supplied SARIF file is a different risk from an
 * unbounded read. The cap is not the interesting part. The interesting part is
 * that exceeding it sets `findingsTruncated`, emits a WARN and records a
 * metric, so a truncated ingest cannot be mistaken for a complete one.
 *
 * That is a stated principle in CLAUDE.md: "if a workflow bounds coverage
 * (top-N, no-retry, sampling), `log()` what was dropped — silent truncation
 * reads as 'covered everything' when it didn't." A regression to a silent
 * `.slice(0, N)` leaves every downstream reader — the run detail page, the
 * control's evidence, an auditor — believing the scan found exactly 100
 * problems.
 *
 * It was uncovered: this usecase's only tests are DB-backed integration tests,
 * and none of them uploads more than the cap.
 *
 * `parseSarif` is mocked so the fixture is a list of findings rather than 150
 * synthetic SARIF results — the branch under test is downstream of parsing and
 * indifferent to how the findings were produced.
 */

const mockDb: Record<string, Record<string, jest.Mock>> = {
    scannerRun: { create: jest.fn(), update: jest.fn() },
    scannerFinding: { findMany: jest.fn(), upsert: jest.fn(), updateMany: jest.fn() },
    finding: { findMany: jest.fn(), updateMany: jest.fn() },
    evidence: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    evidenceControlLink: { findFirst: jest.fn(), create: jest.fn() },
    controlEvidenceLink: { findFirst: jest.fn(), create: jest.fn() },
    control: { findFirst: jest.fn() },
    asset: { findFirst: jest.fn() },
    integrationConnection: { findFirst: jest.fn() },
};

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_c: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));

const mockParseSarif = jest.fn();
jest.mock('@/app-layer/services/sarif', () => ({
    parseSarif: (...a: unknown[]) => mockParseSarif(...a),
}));
jest.mock('@/app-layer/services/cwe-mapping', () => ({ mapCwes: jest.fn(() => []) }));
jest.mock('@/app-layer/usecases/finding', () => ({ createFinding: jest.fn().mockResolvedValue({ id: 'f-1' }) }));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/security/sanitize', () => ({ sanitizePlainText: (s: string) => s }));
jest.mock('@/app-layer/jobs/drain-pages', () => ({
    drainPages: jest.fn(async () => []),
    DRAIN_PAGE_SIZE: 500,
}));

const mockRecordTruncated = jest.fn();
jest.mock('@/lib/observability/integration-metrics', () => ({
    recordScannerFindingsTruncated: (...a: unknown[]) => mockRecordTruncated(...a),
}));

const mockWarn = jest.fn();
jest.mock('@/lib/observability', () => ({
    logger: { warn: (...a: unknown[]) => mockWarn(...a), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
    log: jest.fn(),
    traceUsecase: jest.fn(async (_n: string, fn: () => unknown) => fn()),
}));

import { ingestScannerRun } from '@/app-layer/usecases/scanner-ingestion';
import { createFinding } from '@/app-layer/usecases/finding';
import { makeRequestContext } from '../helpers/make-context';

const mockCreateFinding = createFinding as jest.MockedFunction<typeof createFinding>;

/** `n` distinct CRITICAL findings — every one above the default HIGH threshold. */
const findings = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
        fingerprint: `fp-${i}`,
        ruleId: `rule-${i}`,
        title: `Issue ${i}`,
        description: `Description ${i}`,
        severity: 'CRITICAL' as const,
        location: `src/file-${i}.ts`,
        cweIds: [] as string[],
    }));

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.scannerRun.create.mockResolvedValue({ id: 'run-1' });
    mockDb.scannerRun.update.mockResolvedValue({});
    mockDb.scannerFinding.findMany.mockResolvedValue([]);
    mockDb.scannerFinding.upsert.mockResolvedValue({});
    mockDb.scannerFinding.updateMany.mockResolvedValue({ count: 0 });
    mockDb.finding.findMany.mockResolvedValue([]);
    mockDb.finding.updateMany.mockResolvedValue({ count: 0 });
    mockDb.evidence.findFirst.mockResolvedValue(null);
    mockDb.evidence.create.mockResolvedValue({ id: 'ev-1' });
    mockDb.evidence.update.mockResolvedValue({ id: 'ev-1' });
    mockDb.evidenceControlLink.findFirst.mockResolvedValue(null);
    mockDb.evidenceControlLink.create.mockResolvedValue({});
    mockDb.controlEvidenceLink.findFirst.mockResolvedValue(null);
    mockDb.controlEvidenceLink.create.mockResolvedValue({});
    mockDb.control.findFirst.mockResolvedValue(null);
    mockDb.integrationConnection.findFirst.mockResolvedValue(null);
    mockCreateFinding.mockResolvedValue({ id: 'f-1' } as never);
});

const ingest = (n: number) => {
    mockParseSarif.mockReturnValue({ source: 'SEMGREP', scanType: 'SAST', findings: findings(n) });
    return ingestScannerRun(makeRequestContext('ADMIN'), { sarif: {} } as never);
};

describe('ingestScannerRun — the materialisation cap reports itself', () => {
    it('caps materialisation at 100 and says exactly how many it dropped', async () => {
        const out = await ingest(150);

        // The cap held...
        expect(mockCreateFinding).toHaveBeenCalledTimes(100);
        expect(out.findingsMaterialized).toBe(100);
        // ...and it is DECLARED, which is the whole point. 150 - 100.
        expect(out.findingsTruncated).toBe(50);
        // `findingsIngested` counts every parsed finding, so a reader can tell
        // "50 were dropped" from "50 were below threshold".
        expect(out.findingsIngested).toBe(150);
    });

    it('emits a WARN naming the drop, and records the metric', async () => {
        await ingest(150);

        const warned = mockWarn.mock.calls.find(([msg]) =>
            String(msg).includes('truncated'),
        );
        expect(warned).toBeDefined();
        expect(warned![1]).toMatchObject({
            source: 'SEMGREP',
            aboveThresholdTotal: 150,
            cap: 100,
            dropped: 50,
        });
        expect(mockRecordTruncated).toHaveBeenCalledWith({ source: 'SEMGREP', dropped: 50 });
    });

    // The negative half. Without it, "reports truncation" is satisfied by an
    // implementation that reports it every time — which would be worse than
    // silence, because a truncation warning on every ingest gets muted.
    it('reports NOTHING when the ingest is under the cap', async () => {
        const out = await ingest(40);

        expect(out.findingsTruncated).toBe(0);
        expect(mockCreateFinding).toHaveBeenCalledTimes(40);
        expect(mockRecordTruncated).not.toHaveBeenCalled();
        expect(mockWarn.mock.calls.filter(([m]) => String(m).includes('truncated'))).toHaveLength(0);
    });

    // Boundary: the comparison is `>` the cap, so exactly 100 is not truncated.
    // An off-by-one to `>=` would report a drop of 0 — a truncation warning
    // that names no dropped findings, which reads as a bug in the reporter
    // rather than in the cap.
    it('does not report truncation at exactly the cap', async () => {
        const out = await ingest(100);
        expect(out.findingsMaterialized).toBe(100);
        expect(out.findingsTruncated).toBe(0);
        expect(mockRecordTruncated).not.toHaveBeenCalled();
    });
});
