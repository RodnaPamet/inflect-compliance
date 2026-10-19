/**
 * The per-estate schedule health rules (#3678), each one failing towards STALE.
 */
import {
    computeEstateHealth,
    effectiveMoment,
    sourceStateIn,
    staleAfterHours,
    type EstateDeclaration,
    type EstateScanInput,
} from '@/lib/agentic/harness-estate-health';
import type { StoredSource } from '@/lib/agentic/harness-read-model';

const NOW = new Date('2026-10-19T12:00:00.000Z');
const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();

const ok = (kind: string, rows = 3): StoredSource => ({ kind, status: 'COMPLETE', rows, reason: null });

function scan(id: string, hoursAgo: number, sources: readonly StoredSource[] | null, over: Partial<EstateScanInput> = {}): EstateScanInput {
    return {
        id,
        scanRef: `ref-${id}`,
        asOf: at(hoursAgo),
        ingestedAt: at(hoursAgo),
        complete: sources !== null && sources.every((s) => s.status === 'COMPLETE'),
        agentCount: 2,
        sources,
        ...over,
    };
}

const estate = (kinds: string[], cadenceHours = 24): EstateDeclaration => ({
    id: 'est',
    name: 'Estate',
    scannerAgentId: 'agt',
    scannerName: 'Scanner',
    scannerLive: true,
    cadenceHours,
    sources: kinds.map((kind) => ({ kind, owner: { userId: 'u', name: 'Owner', active: true } })),
});

describe('freshness', () => {
    it('is stale after one and a half cadences, and fresh up to the boundary', () => {
        expect(staleAfterHours(24)).toBe(36);
        expect(staleAfterHours(1)).toBe(2);
        expect(computeEstateHealth(estate(['vault']), [scan('s', 36, [ok('vault')])], NOW).status).toBe('FRESH');
        expect(computeEstateHealth(estate(['vault']), [scan('s', 36.01, [ok('vault')])], NOW).status).toBe('STALE');
    });

    it('a scan cannot describe a moment after it arrived: a future asOf counts from arrival', () => {
        const future = scan('s', 40, [ok('vault')], { asOf: '2027-01-01T00:00:00.000Z' });
        expect(effectiveMoment(future)).toBe(Date.parse(at(40)));
        expect(computeEstateHealth(estate(['vault']), [future], NOW).status).toBe('STALE');
    });

    it('no scan at all is STALE, with nothing latest', () => {
        expect(computeEstateHealth(estate(['vault']), [], NOW)).toMatchObject({ status: 'STALE', lastComplete: null, latest: null });
    });
});

describe('what counts as complete for an estate', () => {
    it('an empty scan is never complete, whatever its sources say', () => {
        const row = computeEstateHealth(estate(['vault']), [scan('s', 1, [ok('vault')], { agentCount: 0 })], NOW);
        expect(row).toMatchObject({ status: 'STALE', lastComplete: null, latest: { completeness: 'EMPTY' } });
        // The source itself was read in full, so it is fresh on its own line.
        expect(row.sources[0]).toMatchObject({ status: 'FRESH', latest: { state: 'COMPLETE' } });
    });

    it('a source read in full that found nothing is EMPTY, not complete', () => {
        const row = computeEstateHealth(estate(['vault']), [scan('s', 1, [ok('vault', 0)])], NOW);
        expect(row.sources[0]).toMatchObject({ status: 'STALE', latest: { state: 'EMPTY' } });
        expect(row.status).toBe('STALE');
    });

    it('a declared source the scan did not report keeps the estate stale', () => {
        const row = computeEstateHealth(estate(['okta-app', 'vault']), [scan('s', 1, [ok('vault')])], NOW);
        expect(row.status).toBe('STALE');
        expect(row.sources.map((s) => [s.kind, s.status, s.latest?.state])).toEqual([
            ['okta-app', 'STALE', 'NOT_REPORTED'],
            ['vault', 'FRESH', 'COMPLETE'],
        ]);
    });

    it('unreadable stored sources are not complete', () => {
        const unreadable = scan('s', 1, null);
        expect(sourceStateIn(unreadable, 'vault')).toEqual({ state: 'UNREADABLE', reason: null });
        expect(computeEstateHealth(estate(['vault']), [unreadable], NOW).status).toBe('STALE');
    });

    it('an estate that declares nothing is never complete', () => {
        expect(computeEstateHealth(estate([]), [scan('s', 1, [ok('vault')])], NOW)).toMatchObject({ status: 'STALE', lastComplete: null });
    });

    it('the last complete scan is found behind an incomplete latest one, per estate and per source', () => {
        const row = computeEstateHealth(
            estate(['okta-app', 'vault']),
            [
                scan('old', 20, [ok('okta-app'), ok('vault')]),
                scan('new', 1, [ok('okta-app'), { kind: 'vault', status: 'INCOMPLETE', rows: 2, reason: 'TIME_BOX' }]),
            ],
            NOW,
        );
        expect(row.lastComplete).toEqual({ scanId: 'old', scanRef: 'ref-old', at: at(20) });
        expect(row.latest).toMatchObject({ scanId: 'new', completeness: 'INCOMPLETE' });
        expect(row.sources[0].lastComplete?.scanId).toBe('new');
        expect(row.sources[1]).toMatchObject({ lastComplete: { scanId: 'old' }, latest: { state: 'INCOMPLETE', reason: 'TIME_BOX' } });
        expect(row.status).toBe('FRESH');
    });

    it('names the kinds the latest scan read that the estate does not declare', () => {
        const row = computeEstateHealth(estate(['vault']), [scan('s', 1, [ok('vault'), ok('mcp'), ok('cicd')])], NOW);
        expect(row.undeclaredSources).toEqual(['cicd', 'mcp']);
    });
});
