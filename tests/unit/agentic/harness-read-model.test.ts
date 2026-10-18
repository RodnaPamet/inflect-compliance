/**
 * The harness matrix's pure rules (#3687): what "complete" means, what drift
 * is, which evidence pointers may render as links, and the matrix order.
 */
import {
    compareMatrixRows,
    computeHarnessDrift,
    evidenceHrefOf,
    redactPointerCredentials,
    harnessScanCompleteness,
    type DriftScanInput,
    type StoredSource,
} from '@/lib/agentic/harness-read-model';
import type { HarnessLevel } from '@/lib/agentic/harness-ladder';

describe('harnessScanCompleteness — zero is never complete', () => {
    it('an all-complete scan that found no agents is EMPTY, not COMPLETE', () => {
        expect(harnessScanCompleteness({ complete: true, agentCount: 0, sourcesReadable: true })).toBe('EMPTY');
    });

    it('EMPTY wins over INCOMPLETE too: an empty population is the finding', () => {
        expect(harnessScanCompleteness({ complete: false, agentCount: 0, sourcesReadable: false })).toBe('EMPTY');
    });

    it('COMPLETE needs every source read in full, readable stored sources and a population', () => {
        expect(harnessScanCompleteness({ complete: true, agentCount: 3, sourcesReadable: true })).toBe('COMPLETE');
        expect(harnessScanCompleteness({ complete: false, agentCount: 3, sourcesReadable: true })).toBe('INCOMPLETE');
        expect(harnessScanCompleteness({ complete: true, agentCount: 3, sourcesReadable: false })).toBe('INCOMPLETE');
    });
});

const src = (kind: string, status: 'COMPLETE' | 'INCOMPLETE', reason: string | null = null): StoredSource => ({
    kind,
    status,
    rows: 10,
    reason,
});
const item = (id: string, level: HarnessLevel) => ({ discoveredAgentId: `da_${id}`, discoveredId: `entra:sp:${id}`, level });
const scan = (over: Partial<DriftScanInput> = {}): DriftScanInput => ({
    id: 'scan_latest',
    scanRef: 'ref-latest',
    asOf: '2026-10-17T03:00:00.000Z',
    completeness: 'COMPLETE',
    sources: [src('entra-sp', 'COMPLETE'), src('mcp', 'COMPLETE')],
    items: [],
    ...over,
});

describe('computeHarnessDrift — from stored rows only', () => {
    it('reports a level drop, names both levels, and does not report a rise', () => {
        const drift = computeHarnessDrift(
            scan({ items: [item('a', 'H1'), item('b', 'H4')] }),
            scan({ id: 'scan_prev', scanRef: 'ref-prev', items: [item('a', 'H3'), item('b', 'H2')] }),
        );
        expect(drift.levelDrops).toEqual([
            { discoveredAgentId: 'da_a', discoveredId: 'entra:sp:a', from: 'H3', to: 'H1' },
        ]);
        expect(drift.newlySeen).toEqual([]);
        expect(drift.baselineScanId).toBe('scan_prev');
        expect(drift.baselineScanRef).toBe('ref-prev');
    });

    it('orders drops by size, largest first, then by discovered id', () => {
        const drift = computeHarnessDrift(
            scan({ items: [item('c', 'H2'), item('a', 'H0'), item('b', 'H2')] }),
            scan({ id: 'p', items: [item('c', 'H3'), item('a', 'H4'), item('b', 'H3')] }),
        );
        expect(drift.levelDrops.map((d) => d.discoveredId)).toEqual(['entra:sp:a', 'entra:sp:b', 'entra:sp:c']);
    });

    it('reports an agent in the latest scan and not the baseline as newly seen — and an absent one as NOTHING', () => {
        const drift = computeHarnessDrift(
            scan({ items: [item('a', 'H1'), item('z', 'H0')] }),
            scan({ id: 'p', items: [item('a', 'H1'), item('gone', 'H2')] }),
        );
        expect(drift.newlySeen).toEqual([{ discoveredAgentId: 'da_z', discoveredId: 'entra:sp:z' }]);
        // One scanner not seeing an agent is not evidence it is gone.
        expect(JSON.stringify(drift)).not.toContain('gone');
    });

    it('reports a source read in full before and incomplete now, with its reason', () => {
        const drift = computeHarnessDrift(
            scan({ sources: [src('entra-sp', 'COMPLETE'), src('mcp', 'INCOMPLETE', 'TIME_BOX')] }),
            scan({ id: 'p' }),
        );
        expect(drift.sourcesGoneIncomplete).toEqual([{ kind: 'mcp', reason: 'TIME_BOX' }]);
        expect(drift.sourcesDropped).toEqual([]);
        expect(drift.sourceDriftUnknown).toBe(false);
    });

    it('does not report a source that was already incomplete as having gone incomplete', () => {
        const drift = computeHarnessDrift(
            scan({ sources: [src('mcp', 'INCOMPLETE', 'TIME_BOX')] }),
            scan({ id: 'p', sources: [src('mcp', 'INCOMPLETE', 'BYTE_CAP')] }),
        );
        expect(drift.sourcesGoneIncomplete).toEqual([]);
    });

    it('reports a source the baseline read and the latest scan no longer reports as dropped', () => {
        const drift = computeHarnessDrift(
            scan({ sources: [src('entra-sp', 'COMPLETE')] }),
            scan({ id: 'p', sources: [src('entra-sp', 'COMPLETE'), src('vault', 'COMPLETE')] }),
        );
        expect(drift.sourcesDropped).toEqual(['vault']);
    });

    it('states source drift as UNKNOWN when either side\'s stored sources were unreadable', () => {
        const a = computeHarnessDrift(scan({ sources: null }), scan({ id: 'p' }));
        const b = computeHarnessDrift(scan(), scan({ id: 'p', sources: null }));
        for (const d of [a, b]) {
            expect(d.sourceDriftUnknown).toBe(true);
            expect(d.sourcesGoneIncomplete).toEqual([]);
            expect(d.sourcesDropped).toEqual([]);
        }
    });

    it('two identical scans drift by nothing, and say so with empty lists', () => {
        const same = { items: [item('a', 'H2')] };
        const drift = computeHarnessDrift(scan(same), scan({ ...same, id: 'p' }));
        expect(drift).toMatchObject({
            levelDrops: [],
            newlySeen: [],
            sourcesGoneIncomplete: [],
            sourcesDropped: [],
            sourceDriftUnknown: false,
        });
    });

    it('carries the baseline\'s completeness, so the panel can state it', () => {
        const drift = computeHarnessDrift(scan(), scan({ id: 'p', completeness: 'INCOMPLETE' }));
        expect(drift.baselineCompleteness).toBe('INCOMPLETE');
    });
});

describe('evidenceHrefOf — a pointer is a link only when it is an absolute http(s) URL', () => {
    it.each([
        ['https://graph.example.com/sp/1', 'https://graph.example.com/sp/1'],
        ['http://intranet.example/agents/a', 'http://intranet.example/agents/a'],
        ['  https://graph.example.com/sp/1  ', 'https://graph.example.com/sp/1'],
    ])('%s → a link', (pointer, href) => {
        expect(evidenceHrefOf(pointer)).toBe(href);
    });

    it.each([
        ['a relative path', '/admin/agents'],
        ['a protocol-relative URL', '//evil.example/x'],
        ['a vault reference', 'kv://prod/agents/x'],
        ['a register reference', 'inflect-register:RegisteredAgent/agt_1'],
        ['javascript:', 'javascript:alert(1)'],
        ['data:', 'data:text/html,<script>alert(1)</script>'],
        ['a file path', '/etc/passwd'],
        ['a query', '?q=1'],
        ['embedded credentials', 'https://user:pass@example.com/x'],
        ['whitespace', '   '],
        ['empty', ''],
        ['null', null],
    ])('%s → text, never a link', (_label, pointer) => {
        expect(evidenceHrefOf(pointer)).toBeNull();
    });
});

describe('compareMatrixRows — the worst rung first', () => {
    it('orders by rung, then below-bar first, then discovered id', () => {
        const rows = [
            { level: 'H3' as const, belowBar: false, discoveredId: 'a' },
            { level: 'H2' as const, belowBar: false, discoveredId: 'b' },
            { level: 'H2' as const, belowBar: true, discoveredId: 'z' },
            { level: 'H0' as const, belowBar: true, discoveredId: 'y' },
            { level: 'H2' as const, belowBar: true, discoveredId: 'c' },
        ];
        expect([...rows].sort(compareMatrixRows).map((r) => r.discoveredId)).toEqual(['y', 'c', 'z', 'b', 'a']);
    });
});

describe('redactPointerCredentials — userinfo never reaches the screen or the clipboard', () => {
    const pw = ['p', 'w', '-', 'z'.repeat(10)].join('');

    it.each([
        [`https://user:${pw}@host.example/a?b=1`, 'https://***@host.example/a?b=1'],
        [`ldaps://svc:${pw}@dc1.corp:636/dc=corp`, 'ldaps://***@dc1.corp:636/dc=corp'],
        [`see https://a:${pw}@x.example and https://b:${pw}@y.example/p`, 'see https://***@x.example and https://***@y.example/p'],
        ['ssh://git@host.example/repo', 'ssh://***@host.example/repo'],
    ])('redacts %s', (input, expected) => {
        expect(redactPointerCredentials(input)).toEqual({ text: expected, redacted: true });
        expect(redactPointerCredentials(input).text).not.toContain(pw);
    });

    it.each(['https://graph.example.com/servicePrincipals/1', 'kv://prod/agents/reporting', 'kv://prod/agents:reporting@v2', '/etc/agents/axes'])(
        'leaves %s alone',
        (input) => {
            expect(redactPointerCredentials(input)).toEqual({ text: input, redacted: false });
        },
    );
});
