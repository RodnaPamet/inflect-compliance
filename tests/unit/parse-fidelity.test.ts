/**
 * The parse-fidelity set and its scoring (docs/ai-architecture/ragflow.md,
 * Phase 0.1 and 0.4).
 *
 * The workflow that runs the set against a real parsing service is
 * dispatch-only and never runs in CI, so what decides what its record MEANS is
 * held here: every committed file is the one the manifest names, every
 * expected file is re-derived from the spec that also rendered the document,
 * and every figure is recomputed from raw counts, with a stored rate refused.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as yaml from 'js-yaml';

import { DOCLING_MIME_EXTENSIONS } from '@/lib/ai/parsing/docling-provider';

import {
    FIXTURES,
    RENDER_FILE,
    expectedFor,
    fixtureFileName,
    htmlFor,
    type FixtureExpectation,
} from '../../scripts/parse-fidelity/fixtures';
import {
    PARSE_FIDELITY_FLOORS,
    PARSE_RECORD_FORMAT,
    floorVerdicts,
    measurementFaults,
    normalise,
    parseMemUsage,
    renderSummary,
    scoreDocument,
    summarizeRecord,
    type CaseRecord,
    type ParseFidelityRecord,
} from '../../scripts/parse-fidelity/score';

const ROOT = path.resolve(__dirname, '../..');
const FIXTURE_DIR = path.join(ROOT, 'tests/fixtures/parse');

function sha256(file: string): string {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

describe('the fixture set', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'manifest.json'), 'utf8')) as {
        files: { id: string; file: string; sha256: string }[];
    };

    it('is ten documents, one per spec, in order', () => {
        expect(FIXTURES).toHaveLength(10);
        expect(manifest.files.map((f) => f.id)).toEqual(FIXTURES.map((s) => s.id));
        expect(manifest.files.map((f) => f.file)).toEqual(FIXTURES.map(fixtureFileName));
        expect(new Set(FIXTURES.map((s) => s.id)).size).toBe(FIXTURES.length);
    });

    it('commits exactly the bytes the manifest names', () => {
        for (const f of manifest.files) {
            expect({ file: f.file, sha256: sha256(path.join(FIXTURE_DIR, f.file)) }).toEqual({ file: f.file, sha256: f.sha256 });
        }
    });

    it('holds no file the manifest does not name', () => {
        const onDisk = fs
            .readdirSync(FIXTURE_DIR)
            .filter((n) => !['manifest.json', 'expected', 'README.md'].includes(n))
            .sort();
        expect(onDisk).toEqual(manifest.files.map((f) => f.file).sort());
    });

    it('commits each expected file exactly as its spec derives it', () => {
        for (const spec of FIXTURES) {
            const committed = JSON.parse(
                fs.readFileSync(path.join(FIXTURE_DIR, 'expected', `${spec.id}.json`), 'utf8'),
            ) as FixtureExpectation;
            expect(committed).toEqual(expectedFor(spec));
        }
        expect(fs.readdirSync(path.join(FIXTURE_DIR, 'expected')).sort()).toEqual(
            FIXTURES.map((s) => `${s.id}.json`).sort(),
        );
    });

    it('covers the kinds Phase 0.1 names', () => {
        const kinds = FIXTURES.map((s) => s.kind).join(' | ');
        for (const needle of ['policy PDF', 'Statement of Applicability', 'SOC 2', 'ISO 27001', 'scanned', 'questionnaire', 'Word']) {
            expect(kinds).toContain(needle);
        }
        expect(FIXTURES.filter((s) => s.render === 'scan-png' || s.render === 'scan-pdf')).toHaveLength(2);
        expect(FIXTURES.filter((s) => s.lang === 'bg')).toHaveLength(1);
    });

    it('gives every table a header and rows of the header’s width, and every document something to find', () => {
        for (const spec of FIXTURES) {
            const exp = expectedFor(spec);
            expect(exp.headings.length + exp.tables.length).toBeGreaterThan(0);
            for (const t of exp.tables) {
                expect(t.rows.length).toBeGreaterThan(1);
                for (const r of t.rows) expect(r).toHaveLength(t.rows[0].length);
                for (const c of t.rows.flat()) expect(c.trim()).not.toBe('');
            }
        }
    });

    it('a spreadsheet expects no headings, and its HTML is its table alone', () => {
        for (const spec of FIXTURES.filter((s) => s.render === 'xlsx')) {
            expect(expectedFor(spec).headings).toEqual([]);
            expect(htmlFor(spec)).not.toMatch(/<h[1-6]>/);
        }
    });

    it('names a media type the Docling client sends for every rendering', () => {
        for (const { mime } of Object.values(RENDER_FILE)) expect(Object.keys(DOCLING_MIME_EXTENSIONS)).toContain(mime);
    });
});

describe('the workflow', () => {
    const wf = yaml.load(fs.readFileSync(path.join(ROOT, '.github/workflows/parse-fidelity.yml'), 'utf8')) as {
        on: Record<string, unknown>;
        permissions: Record<string, string>;
        env: Record<string, string>;
    };

    it('is dispatched by hand, reads the code and nothing else', () => {
        expect(Object.keys(wf.on)).toEqual(['workflow_dispatch']);
        expect(wf.permissions).toEqual({ contents: 'read' });
    });

    it('runs the service from a digest-pinned image', () => {
        expect(wf.env.DOCLING_IMAGE).toMatch(/^ghcr\.io\/docling-project\/docling-serve-cpu:v[\d.]+@sha256:[0-9a-f]{64}$/);
    });
});

// ── Scoring ──────────────────────────────────────────────────────────────────

const EXPECTED: FixtureExpectation = {
    id: 't',
    file: 't.pdf',
    mime: 'application/pdf',
    kind: 'policy PDF (born digital)',
    lang: 'en',
    ocr: false,
    headings: [
        { text: 'Title', level: 0 },
        { text: '1 Purpose', level: 1 },
    ],
    tables: [
        {
            rows: [
                ['Role', 'Owner'],
                ['A', 'x'],
                ['B', 'y'],
            ],
        },
    ],
};

describe('scoreDocument', () => {
    it('finds everything in a faithful parse, compared on normalised text', () => {
        const c = scoreDocument(EXPECTED, {
            headings: ['TITLE', '1  Purpose'],
            tables: [{ rows: [['role', 'owner'], ['A', 'x'], ['B', 'y']] }],
        });
        expect(c).toMatchObject({ headingsFound: 2, cellsFound: 6, rowsFound: 3, tablesReported: 1, missedHeadings: [] });
    });

    it('counts a refused document as found nothing, never as left out', () => {
        const c = scoreDocument(EXPECTED, null);
        expect(c).toMatchObject({ headingsExpected: 2, headingsFound: 0, cellsExpected: 6, cellsFound: 0, rowsFound: 0 });
        expect(c.missedHeadings).toEqual(['title', '1 purpose']);
    });

    it('scores a table split across a page break in full, and a repeated header once', () => {
        const c = scoreDocument(EXPECTED, {
            headings: [],
            tables: [{ rows: [['Role', 'Owner'], ['A', 'x']] }, { rows: [['Role', 'Owner'], ['B', 'y']] }],
        });
        expect(c).toMatchObject({ cellsFound: 6, rowsFound: 3, tablesReported: 2 });
    });

    it('finds cells scattered over rows, and no row', () => {
        const c = scoreDocument(EXPECTED, { headings: [], tables: [{ rows: [['Role', 'A', 'B'], ['Owner', 'x', 'y']] }] });
        expect(c).toMatchObject({ cellsFound: 6, rowsFound: 0 });
    });

    it('treats an OCR error as a miss, not a near hit', () => {
        const c = scoreDocument(EXPECTED, { headings: ['Tit1e', '1 Purpose'], tables: [] });
        expect(c).toMatchObject({ headingsFound: 1, missedHeadings: ['title'] });
    });

    it('does not count a heading reported as body text', () => {
        expect(scoreDocument(EXPECTED, { headings: [], tables: [] }).headingsFound).toBe(0);
    });

    it('normalises width, case, soft hyphens and curly quotes, and nothing more', () => {
        expect(normalise('  Leaver­s’  ACCESS\n')).toBe("leavers' access");
        expect(normalise('Ｒｏｌｅ')).toBe('role');
        expect(normalise('Rol')).not.toBe(normalise('Role'));
    });
});

function record(cases: CaseRecord[]): ParseFidelityRecord {
    return {
        format: PARSE_RECORD_FORMAT,
        backend: 'docling',
        image: 'ghcr.io/x@sha256:' + '0'.repeat(64),
        setSha256: 'a'.repeat(64),
        runner: { cpu: 'test', cores: 4, memMiB: 16000 },
        footprint: {
            containers: 1,
            imageBytes: 4 * 1024 ** 3,
            startupMs: 12_000,
            idle: { memMiB: 300, cpuPct: 0.5 },
            peak: { memMiB: 2500, cpuPct: 390 },
            samples: 40,
        },
        cases,
    };
}

function kase(id: string, over: Partial<CaseRecord> = {}): CaseRecord {
    return {
        id,
        kind: 'policy PDF (born digital)',
        lang: 'en',
        ocr: false,
        outcome: 'ok',
        parseMs: 1000,
        counts: scoreDocument(EXPECTED, { headings: ['Title'], tables: [{ rows: [['Role', 'Owner'], ['A', 'x']] }] }),
        ...over,
    };
}

describe('summarizeRecord', () => {
    it('recomputes every figure from the counts', () => {
        const s = summarizeRecord(
            record([kase('a'), kase('b', { outcome: 'TIMEOUT', counts: scoreDocument(EXPECTED, null) })]),
        );
        expect(s.headings).toEqual({ found: 1, expected: 4, rate: 0.25 });
        expect(s.cells).toEqual({ found: 4, expected: 12, rate: 4 / 12 });
        expect(s.rows).toEqual({ found: 2, expected: 6, rate: 2 / 6 });
        expect(s.refused).toBe(1);
        expect(s.bySlice.ocr.headings.rate).toBeNull();
    });

    it('refuses a record that stores a rate', () => {
        const r = record([kase('a')]) as unknown as Record<string, unknown>;
        expect(() => summarizeRecord({ ...r, passRate: 1 } as unknown as ParseFidelityRecord)).toThrow(/never a rate/);
    });

    it('refuses an empty record: zero is never complete', () => {
        expect(() => summarizeRecord(record([]))).toThrow(/evidences nothing/);
    });

    it('refuses counts that contradict themselves', () => {
        const bad = kase('a');
        expect(() =>
            summarizeRecord(record([{ ...bad, counts: { ...bad.counts, cellsFound: bad.counts.cellsExpected + 1 } }])),
        ).toThrow(/found exceeds expected/);
    });

    it('renders the summary from the recomputed figures', () => {
        const md = renderSummary(record([kase('a')]));
        expect(md).toContain('| All 1 documents | 50.0% (1/2) | 66.7% (4/6) | 66.7% (2/3) |');
        expect(md).toContain('| Peak memory while parsing | 2500 MiB |');
        expect(md).toContain('- a: "1 purpose"');
    });
});

describe('the D-L4-12 floors', () => {
    it('are the owner\'s 95 / 90 / 80', () => {
        expect(PARSE_FIDELITY_FLOORS).toEqual({ headings: 0.95, cells: 0.9, rows: 0.8 });
    });

    it('judge the recomputed figures, and never pass a figure with nothing expected', () => {
        const s = summarizeRecord(record([kase('a')]));
        expect(floorVerdicts(s)).toEqual([
            { figure: 'headings', floor: 0.95, rate: 0.5, met: false },
            { figure: 'cells', floor: 0.9, rate: 4 / 6, met: false },
            { figure: 'rows', floor: 0.8, rate: 2 / 3, met: false },
        ]);
        const perfect = kase('p', {
            counts: scoreDocument(EXPECTED, { headings: ['Title', '1 Purpose'], tables: [{ rows: [['Role', 'Owner'], ['A', 'x'], ['B', 'y']] }] }),
        });
        expect(floorVerdicts(summarizeRecord(record([perfect]))).every((v) => v.met)).toBe(true);
        const noHeadings = { ...s, headings: { found: 0, expected: 0, rate: null } };
        expect(floorVerdicts(noHeadings)[0].met).toBe(false);
    });

    it('are shown in the summary, as reported and not enforced', () => {
        const md = renderSummary(record([kase('a')]));
        expect(md).toContain('| Row recall | 66.7% | 80% | missed |');
        expect(md).toContain('fails the job from Phase 3');
    });
});

describe('measurementFaults', () => {
    const refused = (id: string, outcome: string) => kase(id, { outcome, counts: scoreDocument(EXPECTED, null) });

    it('passes a run where the service answered, even when a document failed to convert', () => {
        expect(measurementFaults(record([kase('a'), refused('b', 'PARSE_FAILED'), refused('c', 'TIMEOUT')]))).toEqual([]);
    });

    it('fails the run the first dispatch produced: every request refused 422', () => {
        expect(measurementFaults(record([refused('a', 'UPSTREAM_REFUSED'), refused('b', 'UPSTREAM_REFUSED')]))).toEqual([
            'a: UPSTREAM_REFUSED',
            'b: UPSTREAM_REFUSED',
            'every document was refused (2 of 2)',
        ]);
    });

    it('fails on one refusal about the request, and on a run with nothing converted', () => {
        expect(measurementFaults(record([kase('a'), refused('b', 'CONTRACT_VIOLATION')]))).toEqual(['b: CONTRACT_VIOLATION']);
        expect(measurementFaults(record([refused('a', 'PARSE_FAILED')]))).toEqual(['every document was refused (1 of 1)']);
    });
});

describe('parseMemUsage', () => {
    it.each([
        ['1.5GiB / 15.6GiB', 1536],
        ['512MiB / 15.6GiB', 512],
        ['2048KiB / 1GiB', 2],
        ['0B / 0B', 0],
    ])('%s is %d MiB', (s, mib) => {
        expect(parseMemUsage(s)).toBeCloseTo(mib, 5);
    });

    it('refuses a figure it cannot read', () => {
        expect(() => parseMemUsage('--')).toThrow(/unreadable/);
    });
});
