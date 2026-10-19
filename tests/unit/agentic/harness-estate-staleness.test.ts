/**
 * A stale estate raises a finding (#3741) — the pure half.
 *
 * What a health row means for its estate's finding: opened once, kept while the
 * estate stays stale, reopened rather than duplicated, closed only when a
 * complete scan ARRIVED after the declaration last changed, and held — never
 * closed — when the estate was edited fresh or removed. The database half is
 * `tests/integration/agent-harness-estate-staleness.test.ts`.
 */
import {
    computeEstateHealth,
    freshnessWindowStart,
    staleAfterHours,
    type EstateDeclaration,
    type EstateHealthRow,
    type EstateScanInput,
} from '@/lib/agentic/harness-estate-health';
import {
    declarationChangedAt,
    estateIdOfStaleRef,
    planEstateStaleness,
    STALE_ESTATE_CODE,
    STALE_ESTATE_FINDING_SOURCE_KIND,
    staleEstateFinding,
    staleEstateRefOf,
    staleReasonOf,
    type EstateUnderEvaluation,
    type KnownStaleFinding,
} from '@/lib/agentic/harness-estate-staleness';
import { HARNESS_FINDING_CODES, HARNESS_FINDING_SOURCE_KIND, planHarnessScan } from '@/lib/agentic/harness-findings';
import type { StoredSource } from '@/lib/agentic/harness-read-model';
import { recordHarnessEstateStaleness } from '@/lib/observability/integration-metrics';
import { validReportBody } from '../../helpers/agent-harness-fake-scanner';

const add = jest.fn();
jest.mock('@opentelemetry/api', () => {
    const actual = jest.requireActual('@opentelemetry/api');
    return {
        ...actual,
        metrics: {
            getMeter: () => ({
                createCounter: (name: string) => ({ add: (v: number, labels?: unknown) => add(name, v, labels) }),
                createHistogram: () => ({ record: () => undefined }),
                createObservableGauge: () => ({ addCallback: () => undefined }),
            }),
        },
    };
});

const NOW = new Date('2026-10-19T12:00:00.000Z');
const HOUR = 3_600_000;
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * HOUR).toISOString();
const ok = (kind: string, rows = 3): StoredSource => ({ kind, status: 'COMPLETE', rows, reason: null });

function scan(id: string, hoursAgo: number, sources: readonly StoredSource[], over: Partial<EstateScanInput> = {}): EstateScanInput {
    return {
        id,
        scanRef: `ref-${id}`,
        asOf: at(hoursAgo),
        ingestedAt: at(hoursAgo),
        complete: sources.every((s) => s.status === 'COMPLETE'),
        agentCount: 2,
        sources,
        ...over,
    };
}

function estate(over: Partial<EstateDeclaration> & { kinds?: string[] } = {}): EstateDeclaration {
    const { kinds = ['vault', 'mcp'], ...rest } = over;
    return {
        id: 'est-1',
        name: 'Acme production',
        scannerAgentId: 'agt-scanner',
        scannerName: 'Acme scanner',
        scannerLive: true,
        cadenceHours: 24,
        sources: kinds.map((kind) => ({ kind, owner: { userId: 'u', name: null, active: true } })),
        ...rest,
    };
}

const row = (scans: EstateScanInput[], over: Parameters<typeof estate>[0] = {}): EstateHealthRow =>
    computeEstateHealth(estate(over), scans, NOW);

const freshRow = () => row([scan('fresh', 2, [ok('vault'), ok('mcp')])]);
const staleRow = () => row([scan('old', 40, [ok('vault'), ok('mcp')])]);

/** One estate as the pass hands it to the planner. */
const evaluated = (health: EstateHealthRow, declaredHoursAgo: number, arrivedHoursAgo: number | null): EstateUnderEvaluation => ({
    health,
    declaredAt: at(declaredHoursAgo),
    lastCompleteArrivedAt: arrivedHoursAgo === null ? null : at(arrivedHoursAgo),
});

const finding = (status: string, id = 'f-1', estateId = 'est-1'): KnownStaleFinding => ({
    id,
    sourceRef: staleEstateRefOf(estateId),
    status,
});

describe('the one rule is the health module\'s', () => {
    it('the read bound is the freshness boundary itself: a scan at the bound is FRESH, a millisecond earlier is STALE', () => {
        const start = freshnessWindowStart(24, NOW);
        expect(NOW.getTime() - start.getTime()).toBe(staleAfterHours(24) * HOUR);
        const atBound = { asOf: start.toISOString(), ingestedAt: start.toISOString() };
        const before = { asOf: new Date(start.getTime() - 1).toISOString(), ingestedAt: start.toISOString() };
        expect(row([scan('s', 0, [ok('vault'), ok('mcp')], atBound)]).status).toBe('FRESH');
        // The asOf alone falls outside: min(asOf, ingestedAt) is before the bound.
        expect(row([scan('s', 0, [ok('vault'), ok('mcp')], before)]).status).toBe('STALE');
    });

    it('a stale reason is read off the row, never a second judgement: a FRESH row has none', () => {
        expect(staleReasonOf(freshRow(), NOW)).toBeNull();
        expect(staleReasonOf(row([]), NOW)).toBe('NO_SCAN_IN_WINDOW');
        expect(staleReasonOf(row([scan('s', 1, [ok('vault'), { kind: 'mcp', status: 'INCOMPLETE', rows: 0, reason: 'AUTH_FAILED' }])]), NOW)).toBe(
            'NO_COMPLETE_SCAN',
        );
        // A complete scan older than the window is no scan IN the window,
        // whether or not the caller passed it.
        expect(staleReasonOf(staleRow(), NOW)).toBe('NO_SCAN_IN_WINDOW');
        expect(staleReasonOf(row([], { scannerLive: false }), NOW)).toBe('SCANNER_NOT_LIVE');
    });
});

describe('one finding per stale estate', () => {
    it('opens a finding for a stale estate with none', () => {
        const plan = planEstateStaleness({ now: NOW, estates: [evaluated(staleRow(), 100, 40)], findings: [] });
        expect(plan).toMatchObject({ evaluated: 1, stale: [{ estateId: 'est-1', reason: 'NO_SCAN_IN_WINDOW' }] });
        expect(plan.actions).toEqual([
            {
                kind: 'OPEN',
                finding: expect.objectContaining({
                    code: STALE_ESTATE_CODE,
                    sourceRef: 'STALE_ESTATE:est-1',
                    severity: 'HIGH',
                    type: 'OBSERVATION',
                }),
            },
        ]);
    });

    it('a second run, with that finding open, opens nothing', () => {
        for (const status of ['OPEN', 'IN_PROGRESS', 'READY_FOR_VERIFICATION']) {
            const plan = planEstateStaleness({ now: NOW, estates: [evaluated(staleRow(), 100, 40)], findings: [finding(status)] });
            expect(plan.actions).toEqual([{ kind: 'STILL_OPEN', findingId: 'f-1', estateId: 'est-1', reason: 'NO_SCAN_IN_WINDOW' }]);
        }
    });

    it('a stale estate whose finding was closed reopens THAT finding, never a second', () => {
        const plan = planEstateStaleness({ now: NOW, estates: [evaluated(staleRow(), 100, 40)], findings: [finding('CLOSED')] });
        expect(plan.actions).toEqual([expect.objectContaining({ kind: 'REOPEN', findingId: 'f-1' })]);
    });

    it('of a closed and an open row on one ref, the open one speaks', () => {
        const plan = planEstateStaleness({
            now: NOW,
            estates: [evaluated(staleRow(), 100, 40)],
            findings: [finding('CLOSED', 'f-old'), finding('OPEN', 'f-new')],
        });
        expect(plan.actions).toEqual([expect.objectContaining({ kind: 'STILL_OPEN', findingId: 'f-new' })]);
    });

    it('ignores every other harness finding in the key space', () => {
        const plan = planEstateStaleness({
            now: NOW,
            estates: [evaluated(staleRow(), 100, 40)],
            findings: [{ id: 'x', sourceRef: 'SHADOW_AGENT:est-1', status: 'OPEN' }],
        });
        expect(plan.actions.map((a) => a.kind)).toEqual(['OPEN']);
    });

    it('evaluates each estate on its own row: one stale, one fresh, one finding', () => {
        const other = computeEstateHealth({ ...estate(), id: 'est-2', name: 'Beta' }, [scan('b', 1, [ok('vault'), ok('mcp')])], NOW);
        const plan = planEstateStaleness({ now: NOW, estates: [evaluated(staleRow(), 100, 40), evaluated(other, 100, 1)], findings: [] });
        expect(plan.evaluated).toBe(2);
        expect(plan.actions).toEqual([expect.objectContaining({ kind: 'OPEN', finding: expect.objectContaining({ estateId: 'est-1' }) })]);
    });
});

describe('it closes only when a complete scan arrives', () => {
    it('closes an open finding when the scan that made the estate fresh arrived after the last edit', () => {
        const plan = planEstateStaleness({ now: NOW, estates: [evaluated(freshRow(), 100, 2)], findings: [finding('OPEN')] });
        expect(plan.actions).toEqual([
            {
                kind: 'CLOSE',
                findingId: 'f-1',
                priorStatus: 'OPEN',
                estateId: 'est-1',
                sourceRef: 'STALE_ESTATE:est-1',
                scanRef: 'ref-fresh',
                arrivedAt: at(2),
            },
        ]);
    });

    it('closes from a person\'s IN_PROGRESS too, and says so', () => {
        const plan = planEstateStaleness({ now: NOW, estates: [evaluated(freshRow(), 100, 2)], findings: [finding('IN_PROGRESS')] });
        expect(plan.actions).toEqual([expect.objectContaining({ kind: 'CLOSE', priorStatus: 'IN_PROGRESS' })]);
    });

    it('an estate made fresh by an EDIT holds its finding open — the cadence widened around an old scan', () => {
        // The 40-hour-old scan is fresh against a 48-hour cadence (stale after 72),
        // but it arrived 40 hours ago and the declaration changed an hour ago.
        const widened = row([scan('old', 40, [ok('vault'), ok('mcp')])], { cadenceHours: 48 });
        expect(widened.status).toBe('FRESH');
        const plan = planEstateStaleness({ now: NOW, estates: [evaluated(widened, 1, 40)], findings: [finding('OPEN')] });
        expect(plan.actions).toEqual([
            { kind: 'HOLD', findingId: 'f-1', estateId: 'est-1', sourceRef: 'STALE_ESTATE:est-1', reason: 'FRESH_ONLY_BY_DECLARATION_CHANGE' },
        ]);
    });

    it('an estate made fresh by dropping a source holds its finding open too', () => {
        // The mcp source was read in full and found nothing: EMPTY, so the
        // estate that declares it is stale. Declare it away, and the same scan
        // — two hours old, from before the edit — is complete for what is left.
        const scans = [scan('s', 2, [ok('vault'), ok('mcp', 0)])];
        expect(row(scans).status).toBe('STALE');
        const narrowed = row(scans, { kinds: ['vault'] });
        expect(narrowed.status).toBe('FRESH');
        const plan = planEstateStaleness({ now: NOW, estates: [evaluated(narrowed, 1, 2)], findings: [finding('OPEN')] });
        expect(plan.actions.map((a) => [a.kind, 'reason' in a ? a.reason : null])).toEqual([['HOLD', 'FRESH_ONLY_BY_DECLARATION_CHANGE']]);
    });

    it('a fresh estate with no open finding does nothing, and a closed one stays closed', () => {
        expect(planEstateStaleness({ now: NOW, estates: [evaluated(freshRow(), 100, 2)], findings: [] }).actions).toEqual([]);
        expect(planEstateStaleness({ now: NOW, estates: [evaluated(freshRow(), 1, 40)], findings: [finding('CLOSED')] }).actions).toEqual([]);
    });

    it('a REMOVED estate holds its open finding — removal is not evidence', () => {
        const plan = planEstateStaleness({ now: NOW, estates: [], findings: [finding('OPEN', 'f-gone', 'est-gone'), finding('CLOSED', 'f-old', 'est-old')] });
        expect(plan).toEqual({
            evaluated: 0,
            stale: [],
            actions: [{ kind: 'HOLD', findingId: 'f-gone', estateId: 'est-gone', sourceRef: 'STALE_ESTATE:est-gone', reason: 'ESTATE_NOT_DECLARED' }],
        });
    });

    it('the declaration changed at the latest of the estate row and every source row', () => {
        const d = (h: number) => new Date(NOW.getTime() - h * HOUR);
        expect(
            declarationChangedAt({
                createdAt: d(100),
                updatedAt: d(50),
                sources: [
                    { createdAt: d(3), updatedAt: d(3) },
                    { createdAt: d(90), updatedAt: d(90) },
                ],
            }).toISOString(),
        ).toBe(at(3));
    });
});

describe('zero is nothing measured', () => {
    it('no estate is evaluated 0 with no action, never a clean bill', () => {
        expect(planEstateStaleness({ now: NOW, estates: [], findings: [] })).toEqual({ evaluated: 0, stale: [], actions: [] });
    });
});

describe('the finding names the estate, its scanner and the sources missing or incomplete', () => {
    it('names each source not read in full, with its state in the latest scan', () => {
        const health = row(
            [
                scan('s', 2, [ok('vault', 0), { kind: 'mcp', status: 'INCOMPLETE', rows: 1, reason: 'AUTH_FAILED' }]),
            ],
            { kinds: ['vault', 'mcp', 'okta-app'] },
        );
        const f = staleEstateFinding(health, 'NO_COMPLETE_SCAN');
        expect(f.title).toBe('Harness estate Acme production has no complete scan within 36 hours');
        for (const part of [
            'Estate Acme production (est-1)',
            'Acme scanner (agent agt-scanner)',
            'every 24 hours',
            'mcp (INCOMPLETE: AUTH_FAILED in the latest scan)',
            'okta-app (NOT_REPORTED in the latest scan)',
            'vault (EMPTY in the latest scan)',
            'Editing or removing the estate does not close it.',
        ]) {
            expect(f.description.split(part)).toHaveLength(2);
        }
    });

    it('a silent scanner names every declared source as missing, and a removed scanner says it is gone', () => {
        const f = staleEstateFinding(row([], { scannerName: null, scannerLive: false }), 'SCANNER_NOT_LIVE');
        expect(f.description.split('vault (no scan in the window); mcp (no scan in the window)')).toHaveLength(2);
        expect(f.description.split('agent agt-scanner, which is no longer in the register')).toHaveLength(2);
        expect(f.description.split('the ingest refuses its reports')).toHaveLength(2);
    });
});

describe('the key space it shares with the ingest', () => {
    it('is the harness\'s, under a code the ingest never emits', () => {
        expect(STALE_ESTATE_FINDING_SOURCE_KIND).toBe(HARNESS_FINDING_SOURCE_KIND);
        expect((HARNESS_FINDING_CODES as readonly string[]).filter((c) => c === STALE_ESTATE_CODE)).toEqual([]);
        const body = validReportBody();
        body.agents = [];
        const plan = planHarnessScan(validReportBody(), {
            previousLevels: new Map(),
            registeredAgentIds: new Set(),
            acceptedShortfalls: new Set(),
            intakeClaims: new Map(),
            openOrphanCredentials: new Set(),
        });
        const empty = planHarnessScan(body, {
            previousLevels: new Map(),
            registeredAgentIds: new Set(),
            acceptedShortfalls: new Set(),
            intakeClaims: new Map(),
            openOrphanCredentials: new Set(),
        });
        const refs = [...plan.assert, ...empty.assert].map((f) => f.sourceRef).concat(plan.resolve, empty.resolve);
        expect(refs.length).toBeGreaterThan(0);
        expect(refs.filter((r) => estateIdOfStaleRef(r) !== null)).toEqual([]);
    });

    it('round-trips an estate id through its ref', () => {
        expect(estateIdOfStaleRef(staleEstateRefOf('cl0abc'))).toBe('cl0abc');
        expect(estateIdOfStaleRef('STALE_ESTATE:')).toBeNull();
        expect(estateIdOfStaleRef(null)).toBeNull();
    });
});

describe('the metric', () => {
    beforeEach(() => add.mockClear());

    it('counts the pass, the estates evaluated — zero included — and the stale ones by reason, with no tenant label', () => {
        recordHarnessEstateStaleness({ outcome: 'evaluated', evaluated: 3, staleByReason: { NO_SCAN_IN_WINDOW: 1, NO_COMPLETE_SCAN: 1 } });
        recordHarnessEstateStaleness({ outcome: 'no_estates', evaluated: 0, staleByReason: {} });
        expect(add.mock.calls).toEqual([
            ['agentic.harness_estate.pass', 1, { outcome: 'evaluated' }],
            ['agentic.harness_estate.evaluated', 3, undefined],
            ['agentic.harness_estate.stale', 1, { reason: 'no_scan_in_window' }],
            ['agentic.harness_estate.stale', 1, { reason: 'no_complete_scan' }],
            ['agentic.harness_estate.pass', 1, { outcome: 'no_estates' }],
            // Zero evaluated is RECORDED: the denominator exists, and it is nothing.
            ['agentic.harness_estate.evaluated', 0, undefined],
        ]);
    });

    it('an error or an empty sweep counts a pass outcome and evaluates nothing', () => {
        recordHarnessEstateStaleness({ outcome: 'error', evaluated: 0, staleByReason: {} });
        recordHarnessEstateStaleness({ outcome: 'swept_nobody', evaluated: 0, staleByReason: {} });
        expect(add.mock.calls).toEqual([
            ['agentic.harness_estate.pass', 1, { outcome: 'error' }],
            ['agentic.harness_estate.pass', 1, { outcome: 'swept_nobody' }],
        ]);
    });
});
