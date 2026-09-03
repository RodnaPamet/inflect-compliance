/**
 * Automated control evidence on `ingestScannerRun`, and the control-mapping
 * lookup that decides whether any is written at all.
 *
 * This is the path that turns a scanner run into a row an auditor reads as
 * proof a control is operating. Two properties make it safe, and only one of
 * them was covered:
 *
 *   1. Evidence is written ONLY for a PASSING run. Evidence generated from a
 *      failing scan would assert the opposite of what the scan found.
 *   2. It is a SINGLE ROLLING ROW per (control, source) — a daily scan
 *      refreshes one record rather than piling up 365 near-identical
 *      "Automated evidence" rows a year. The update arm (`:302-312`) had no
 *      coverage: only the create path was exercised, so a regression that
 *      stopped reusing the existing row would look correct on a first ingest
 *      and wrong on every one after.
 *
 * `parseSarif` is mocked so a fixture is a list of findings; the arms under
 * test are downstream of parsing.
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
jest.mock('@/app-layer/services/sarif', () => ({ parseSarif: (...a: unknown[]) => mockParseSarif(...a) }));
jest.mock('@/app-layer/services/cwe-mapping', () => ({ mapCwes: jest.fn(() => []) }));
jest.mock('@/app-layer/usecases/finding', () => ({ createFinding: jest.fn().mockResolvedValue({ id: 'f-1' }) }));
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('@/lib/security/sanitize', () => ({ sanitizePlainText: (s: string) => s }));
jest.mock('@/app-layer/jobs/drain-pages', () => ({ drainPages: jest.fn(async () => []), DRAIN_PAGE_SIZE: 500 }));
jest.mock('@/lib/observability/integration-metrics', () => ({ recordScannerFindingsTruncated: jest.fn() }));
jest.mock('@/lib/observability', () => ({
    logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
    log: jest.fn(),
    traceUsecase: jest.fn(async (_n: string, fn: () => unknown) => fn()),
}));

import { ingestScannerRun } from '@/app-layer/usecases/scanner-ingestion';
import { makeRequestContext } from '../helpers/make-context';

/** Clean scan: zero findings, so the derived outcome is PASS. */
const clean = { source: 'SEMGREP', scanType: 'SAST', findings: [] as unknown[] };
/** One CRITICAL finding — above the default HIGH threshold, so outcome FAIL. */
const dirty = {
    source: 'SEMGREP',
    scanType: 'SAST',
    findings: [{
        fingerprint: 'fp-1', ruleId: 'r1', title: 'Bad', description: 'd',
        severity: 'CRITICAL', location: 'a.ts', cweIds: [] as string[],
    }],
};

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
    mockDb.evidence.create.mockResolvedValue({ id: 'ev-new' });
    mockDb.evidence.update.mockResolvedValue({ id: 'ev-existing' });
    mockDb.evidenceControlLink.findFirst.mockResolvedValue(null);
    mockDb.evidenceControlLink.create.mockResolvedValue({});
    mockDb.controlEvidenceLink.findFirst.mockResolvedValue(null);
    mockDb.controlEvidenceLink.create.mockResolvedValue({});
    mockDb.control.findFirst.mockResolvedValue({ id: 'ctl-1' });
    mockDb.integrationConnection.findFirst.mockResolvedValue(null);
    mockParseSarif.mockReturnValue(clean);
});

const ingest = (over: Record<string, unknown> = {}) =>
    ingestScannerRun(makeRequestContext('ADMIN'), { sarif: {}, ...over } as never);

describe('ingestScannerRun — automated control evidence', () => {
    it('creates a rolling evidence row for a PASSING run', async () => {
        const out = await ingest({ controlId: 'ctl-1' });

        expect(out.outcome).toBe('PASS');
        expect(out.evidenceId).toBe('ev-new');
        const data = mockDb.evidence.create.mock.calls[0][0].data;
        expect(data).toMatchObject({
            type: 'TEXT',
            category: 'scanner:SEMGREP',
            status: 'APPROVED',
            reviewCycle: 'MONTHLY',
        });
        // `nextReviewDate` is what makes a scanner going quiet visible: the
        // existing stale-review sweep flags the row once it lapses. Without it
        // the evidence would assert "operating" forever on one old scan.
        expect(data.nextReviewDate.getTime()).toBeGreaterThan(data.dateCollected.getTime());
        expect(mockDb.evidenceControlLink.create).toHaveBeenCalled();
    });

    // THE UNCOVERED ARM. A daily scan must refresh ONE record, not append.
    it('UPDATES the existing row instead of creating a second one', async () => {
        mockDb.evidence.findFirst.mockResolvedValue({ id: 'ev-existing' });

        const out = await ingest({ controlId: 'ctl-1' });

        expect(mockDb.evidence.update).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'ev-existing' } }),
        );
        expect(mockDb.evidence.create).not.toHaveBeenCalled();
        // And no second link — the row is already attached to the control.
        expect(mockDb.evidenceControlLink.create).not.toHaveBeenCalled();
        expect(out.evidenceId).toBe('ev-existing');
    });

    it('looks the existing row up by control AND source-scoped category', async () => {
        await ingest({ controlId: 'ctl-1' });
        expect(mockDb.evidence.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
                where: expect.objectContaining({
                    category: 'scanner:SEMGREP',
                    type: 'TEXT',
                    isArchived: false,
                    deletedAt: null,
                    evidenceControlLinks: { some: { controlId: 'ctl-1' } },
                }),
            }),
        );
    });

    // The one that matters most. Evidence asserts a control is OPERATING;
    // producing it from a run that found a critical issue would be false
    // compliance evidence, generated automatically, and approved on arrival.
    it('writes NO evidence for a failing run', async () => {
        mockParseSarif.mockReturnValue(dirty);

        const out = await ingest({ controlId: 'ctl-1' });

        expect(out.outcome).toBe('FAIL');
        expect(out.evidenceId).toBeNull();
        expect(mockDb.evidence.create).not.toHaveBeenCalled();
        expect(mockDb.evidence.update).not.toHaveBeenCalled();
    });

    it('writes no evidence when no control resolves', async () => {
        mockDb.integrationConnection.findFirst.mockResolvedValue(null);
        const out = await ingest();
        expect(out.controlId).toBeNull();
        expect(out.evidenceId).toBeNull();
        expect(mockDb.evidence.create).not.toHaveBeenCalled();
    });
});

// ─── resolveControlForSource ────────────────────────────────────────
//
// Four ways to resolve nothing, and they must all be null rather than throwing
// — an unmapped scanner source is an ordinary state, not an error.

describe('ingestScannerRun — control resolution from the tenant mapping', () => {
    const withMappings = (m: unknown) =>
        mockDb.integrationConnection.findFirst.mockResolvedValue({ configJson: { controlMappings: m } });

    it('an explicit controlId bypasses the mapping, but is still tenant-checked', async () => {
        withMappings({ SEMGREP: 'mapped-ctl' });
        // Echo the queried id so the assertion is about which id was resolved.
        mockDb.control.findFirst.mockImplementation(async (args: { where: { id: string } }) => ({
            id: args.where.id,
        }));

        const out = await ingest({ controlId: 'explicit-ctl' });

        expect(out.controlId).toBe('explicit-ctl');
        // The tenant mapping is not consulted at all on this path...
        expect(mockDb.integrationConnection.findFirst).not.toHaveBeenCalled();
        // ...but the control itself still is, scoped to the tenant. The caller
        // supplies this id, so trusting it would be an unscoped write target.
        expect(mockDb.control.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'explicit-ctl', tenantId: 'tenant-1' } }),
        );
    });

    // Asymmetry worth having in a test: an unresolvable EXPLICIT control is an
    // error, while an unresolvable MAPPED one is silently null. That is right —
    // the caller named this id, so failing loudly tells them they got it wrong
    // (or that it belongs to another tenant), whereas a stale tenant mapping
    // should not break every ingest.
    it('REFUSES an explicit controlId that does not resolve in this tenant', async () => {
        mockDb.control.findFirst.mockResolvedValue(null);
        await expect(ingest({ controlId: 'other-tenants-control' }))
            .rejects.toThrow(/INVALID_CONTROL|Mapped control not found/);
    });

    it('resolves the control named by the tenant mapping for this source', async () => {
        withMappings({ SEMGREP: 'mapped-ctl' });
        mockDb.control.findFirst.mockResolvedValue({ id: 'mapped-ctl' });
        const out = await ingest();
        expect(out.controlId).toBe('mapped-ctl');
    });

    it.each([
        ['no scanner connection', () => mockDb.integrationConnection.findFirst.mockResolvedValue(null)],
        ['connection without controlMappings', () => mockDb.integrationConnection.findFirst.mockResolvedValue({ configJson: {} })],
        ['mapping has no entry for this source', () => withMappings({ TRIVY: 'other-ctl' })],
    ])('resolves null when %s', async (_label, arrange) => {
        arrange();
        const out = await ingest();
        expect(out.controlId).toBeNull();
    });

    // The mapping names a control that is gone, or belongs to another tenant —
    // the lookup is tenant-scoped, so both present identically and both must
    // yield null rather than attaching evidence to an id we cannot see.
    it('resolves null when the mapped control does not exist in this tenant', async () => {
        withMappings({ SEMGREP: 'ctl-from-another-tenant' });
        mockDb.control.findFirst.mockResolvedValue(null);
        const out = await ingest();
        expect(out.controlId).toBeNull();
        expect(mockDb.evidence.create).not.toHaveBeenCalled();
    });
});
