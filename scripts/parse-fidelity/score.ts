/**
 * PARSE-FIDELITY SCORING — pure, and the only place a figure is computed.
 *
 * Two figures, as `docs/ai-architecture/ragflow.md` Phase 0.4 names them, and
 * one more that says what the cell figure cannot:
 *
 *   - **heading recall**: of the headings the document has, how many the parser
 *     reported AS headings. Text alone: a PDF carries no reliable depth, and
 *     Docling reports most section headers at one level, so the level is
 *     recorded and never scored.
 *   - **table-cell recall**: of the cells the document's tables hold, how many
 *     appear in a table the parser reported. A multiset over the document's
 *     tables taken together, because a table across a page break legitimately
 *     comes back as two tables, and a repeated header row is the parser being
 *     faithful, not wrong.
 *   - **row recall**: of the expected rows, how many appear whole within one
 *     reported row. Cells found scattered over rows score on cell recall and
 *     fail here, which is the difference between a table and a word list.
 *
 * Comparison is on normalised text: Unicode NFKC, case folded, whitespace
 * collapsed, soft hyphens removed. Nothing fuzzier: an OCR error is a miss, and
 * counting it as a hit would hide exactly what the scans are there to measure.
 *
 * A record stores the raw counts per document and never a rate:
 * `summarizeRecords` recomputes every aggregate from the counts (G11), and a
 * document the parser refused counts as found nothing, never as left out.
 */
import type { FixtureExpectation, FixtureTable } from './fixtures';

export function normalise(s: string): string {
    return s
        .normalize('NFKC')
        .replace(/­/g, '')
        .replace(/[‘’]/g, "'")
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

/** What a parser reported, reduced to what scoring reads. */
export interface ParsedForScoring {
    readonly headings: readonly string[];
    readonly tables: readonly { readonly rows: readonly (readonly string[])[] }[];
}

export interface DocumentCounts {
    readonly headingsExpected: number;
    readonly headingsFound: number;
    readonly cellsExpected: number;
    readonly cellsFound: number;
    readonly rowsExpected: number;
    readonly rowsFound: number;
    readonly tablesExpected: number;
    readonly tablesReported: number;
    /** Expected headings not found, normalised. Our own fixture text, never a parser's. */
    readonly missedHeadings: readonly string[];
}

function multiset(values: readonly string[]): Map<string, number> {
    const m = new Map<string, number>();
    for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
    return m;
}

/** Take one occurrence of `v` from the multiset; true if there was one. */
function take(m: Map<string, number>, v: string): boolean {
    const n = m.get(v) ?? 0;
    if (n === 0) return false;
    m.set(v, n - 1);
    return true;
}

function cellsOf(tables: readonly FixtureTable[] | ParsedForScoring['tables']): string[] {
    return tables.flatMap((t) => t.rows.flatMap((r) => r.map(normalise))).filter((c) => c !== '');
}

export function scoreDocument(expected: FixtureExpectation, parsed: ParsedForScoring | null): DocumentCounts {
    const expHeadings = expected.headings.map((h) => normalise(h.text));
    const expCells = cellsOf(expected.tables);
    const expRows = expected.tables.flatMap((t) => t.rows.map((r) => r.map(normalise).filter((c) => c !== '')));

    if (parsed === null) {
        return {
            headingsExpected: expHeadings.length,
            headingsFound: 0,
            cellsExpected: expCells.length,
            cellsFound: 0,
            rowsExpected: expRows.length,
            rowsFound: 0,
            tablesExpected: expected.tables.length,
            tablesReported: 0,
            missedHeadings: expHeadings,
        };
    }

    const reportedHeadings = multiset(parsed.headings.map(normalise));
    const missedHeadings: string[] = [];
    let headingsFound = 0;
    for (const h of expHeadings) {
        if (take(reportedHeadings, h)) headingsFound += 1;
        else missedHeadings.push(h);
    }

    const reportedCells = multiset(cellsOf(parsed.tables));
    let cellsFound = 0;
    for (const c of expCells) if (take(reportedCells, c)) cellsFound += 1;

    // A row is found when one reported row holds all of its cells. Each
    // reported row matches at most one expected row, so a header repeated on
    // every page cannot be counted for more than the one header expected.
    const reportedRows = parsed.tables.flatMap((t) => t.rows.map((r) => multiset(r.map(normalise))));
    const used = new Set<number>();
    let rowsFound = 0;
    for (const row of expRows) {
        const idx = reportedRows.findIndex((cand, i) => {
            if (used.has(i)) return false;
            const copy = new Map(cand);
            return row.every((c) => take(copy, c));
        });
        if (idx >= 0) {
            used.add(idx);
            rowsFound += 1;
        }
    }

    return {
        headingsExpected: expHeadings.length,
        headingsFound,
        cellsExpected: expCells.length,
        cellsFound,
        rowsExpected: expRows.length,
        rowsFound,
        tablesExpected: expected.tables.length,
        tablesReported: parsed.tables.length,
        missedHeadings,
    };
}

// ── The record and its summary ───────────────────────────────────────────────

export const PARSE_RECORD_FORMAT = 'inflect-parse-fidelity/1';

export interface CaseRecord {
    readonly id: string;
    readonly kind: string;
    readonly lang: 'en' | 'bg';
    readonly ocr: boolean;
    /** The seam's verdict: 'ok', or the refusal reason. */
    readonly outcome: string;
    readonly parseMs: number;
    readonly counts: DocumentCounts;
}

export interface ResourceSample {
    /** Container memory in MiB, as `docker stats` reports it. */
    readonly memMiB: number;
    /** CPU in percent of one core, as `docker stats` reports it. */
    readonly cpuPct: number;
}

export interface ParseFidelityRecord {
    readonly format: typeof PARSE_RECORD_FORMAT;
    readonly backend: string;
    /** The image reference the service ran from, digest included. */
    readonly image: string;
    /** sha256 of manifest.json: the fixture set the counts are about. */
    readonly setSha256: string;
    readonly runner: { readonly cpu: string; readonly cores: number; readonly memMiB: number };
    readonly footprint: {
        readonly containers: number;
        readonly imageBytes: number;
        readonly startupMs: number;
        readonly idle: ResourceSample;
        /** The highest memory and CPU seen while the set was parsed. */
        readonly peak: ResourceSample;
        readonly samples: number;
    };
    readonly cases: readonly CaseRecord[];
}

export interface Ratio {
    readonly found: number;
    readonly expected: number;
    /** found / expected, or null when nothing was expected. Never stored. */
    readonly rate: number | null;
}

function ratio(found: number, expected: number): Ratio {
    return { found, expected, rate: expected > 0 ? found / expected : null };
}

export interface Summary {
    readonly cases: number;
    readonly refused: number;
    readonly headings: Ratio;
    readonly cells: Ratio;
    readonly rows: Ratio;
    readonly bySlice: Record<'born-digital' | 'ocr' | 'bulgarian' | 'spreadsheet' | 'word', { headings: Ratio; cells: Ratio; rows: Ratio }>;
}

const SLICES: Record<keyof Summary['bySlice'], (c: CaseRecord) => boolean> = {
    'born-digital': (c) => !c.ocr && c.kind.includes('PDF'),
    ocr: (c) => c.ocr,
    bulgarian: (c) => c.lang === 'bg',
    spreadsheet: (c) => c.kind.includes('spreadsheet'),
    word: (c) => c.kind.includes('Word'),
};

function totals(cases: readonly CaseRecord[]) {
    const sum = (k: keyof DocumentCounts) => cases.reduce((n, c) => n + (c.counts[k] as number), 0);
    return {
        headings: ratio(sum('headingsFound'), sum('headingsExpected')),
        cells: ratio(sum('cellsFound'), sum('cellsExpected')),
        rows: ratio(sum('rowsFound'), sum('rowsExpected')),
    };
}

/**
 * Every aggregate, recomputed from the counts. Refuses a record that carries a
 * stored rate anywhere, or whose counts contradict themselves, rather than
 * summarising it: a figure nobody can re-derive is not evidence.
 */
export function summarizeRecord(record: ParseFidelityRecord): Summary {
    if (record.format !== PARSE_RECORD_FORMAT) throw new Error(`unknown record format: ${String(record.format)}`);
    if (/"(rate|recall|passRate|score)"\s*:/.test(JSON.stringify(record))) {
        throw new Error('a record stores counts, never a rate: refusing a record that carries one');
    }
    if (record.cases.length === 0) throw new Error('a record with no cases evidences nothing');
    for (const c of record.cases) {
        const k = c.counts;
        if (k.headingsFound > k.headingsExpected || k.cellsFound > k.cellsExpected || k.rowsFound > k.rowsExpected) {
            throw new Error(`case ${c.id}: found exceeds expected`);
        }
    }
    const bySlice = Object.fromEntries(
        Object.entries(SLICES).map(([name, pick]) => [name, totals(record.cases.filter(pick))]),
    ) as Summary['bySlice'];
    return {
        cases: record.cases.length,
        refused: record.cases.filter((c) => c.outcome !== 'ok').length,
        ...totals(record.cases),
        bySlice,
    };
}

/** `docker stats`' memory column, `1.234GiB / 15.6GiB` → MiB. */
export function parseMemUsage(s: string): number {
    const m = /^\s*([\d.]+)\s*([KMG]i?B|B)/i.exec(s);
    if (!m) throw new Error(`unreadable memory figure: ${s}`);
    const n = Number(m[1]);
    const unit = m[2].toUpperCase();
    if (unit.startsWith('G')) return n * 1024;
    if (unit.startsWith('M')) return n;
    if (unit.startsWith('K')) return n / 1024;
    return n / 1024 / 1024;
}

function pct(r: Ratio): string {
    return r.rate === null ? 'n/a' : `${(r.rate * 100).toFixed(1)}% (${r.found}/${r.expected})`;
}

/** The summary as Markdown, for the step summary, the job log and the note. */
export function renderSummary(record: ParseFidelityRecord): string {
    const s = summarizeRecord(record);
    const f = record.footprint;
    const lines = [
        `## Parse fidelity: ${record.backend}`,
        '',
        `Image \`${record.image}\`, fixture set sha256 \`${record.setSha256.slice(0, 12)}\`.`,
        `Runner: ${record.runner.cpu}, ${record.runner.cores} cores, ${record.runner.memMiB} MiB.`,
        '',
        '| Footprint | Value |',
        '| --- | --- |',
        `| Containers | ${f.containers} |`,
        `| Image size | ${(f.imageBytes / 1024 ** 3).toFixed(2)} GiB |`,
        `| Start to healthy | ${(f.startupMs / 1000).toFixed(1)} s |`,
        `| Idle memory | ${f.idle.memMiB.toFixed(0)} MiB |`,
        `| Peak memory while parsing | ${f.peak.memMiB.toFixed(0)} MiB |`,
        `| Idle CPU | ${f.idle.cpuPct.toFixed(1)}% |`,
        `| Peak CPU while parsing | ${f.peak.cpuPct.toFixed(1)}% (of one core) |`,
        `| Samples | ${f.samples} |`,
        '',
        '| Slice | Heading recall | Table-cell recall | Row recall |',
        '| --- | --- | --- | --- |',
        `| All ${s.cases} documents | ${pct(s.headings)} | ${pct(s.cells)} | ${pct(s.rows)} |`,
        ...Object.entries(s.bySlice).map(([name, t]) => `| ${name} | ${pct(t.headings)} | ${pct(t.cells)} | ${pct(t.rows)} |`),
        '',
        '| Document | Outcome | Parse time | Headings | Cells | Rows | Tables (expected / reported) |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        ...record.cases.map((c) => {
            const k = c.counts;
            return `| ${c.id} | ${c.outcome} | ${(c.parseMs / 1000).toFixed(1)} s | ${k.headingsFound}/${k.headingsExpected} | ${k.cellsFound}/${k.cellsExpected} | ${k.rowsFound}/${k.rowsExpected} | ${k.tablesExpected} / ${k.tablesReported} |`;
        }),
    ];
    const missed = record.cases.filter((c) => c.counts.missedHeadings.length > 0);
    if (missed.length > 0) {
        lines.push('', 'Headings not reported as headings (the fixture\'s own text):', '');
        for (const c of missed) lines.push(`- ${c.id}: ${c.counts.missedHeadings.map((h) => `"${h}"`).join(', ')}`);
    }
    lines.push('', `Refused: ${s.refused} of ${s.cases}. A refused document counts as found nothing.`);
    return lines.join('\n');
}
