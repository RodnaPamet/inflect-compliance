/**
 * Prose and operator copy that NAMES a write-mode clamp, against the clamp's
 * actual value. One value, or a maintainer is reading a barrier that is not
 * there.
 *
 * ═══ THE FAILURE THIS EXISTS TO CATCH (#5566) ═══
 *
 * `JOINER_MAX_MODE` was raised to `AUTOMATIC` by #2954. EIGHT paragraphs went
 * on saying it was `DRY_RUN`, across seven files, for as long as nobody
 * happened to read two of them side by side. Three were materially worse than
 * stale:
 *
 *   • `active-directory/write-direction.ts` described the undeclared
 *     `joinerWritesEnabled` field as a "FAIL-CLOSED BACKSTOP" behind the clamp.
 *     With the clamp lifted that field is the ONLY barrier to an AD account
 *     creation, so the comment told whoever declared it that they were covered.
 *   • `identity-joiner-passes/run/route.ts` recorded the reason for its
 *     OWNER-only key as "the directory-write argument does NOT hold here",
 *     which is what a later reader would re-derive the key from.
 *   • The AD joiner refusal — operator-facing — sent an administrator away to
 *     wait for a clamp lift that had already shipped.
 *
 * None of those is a type error, none is reachable by a behavioural test, and
 * the one guard in this area (`identity-write-ceiling-matches-the-pass`)
 * deliberately checks the ROUTE's published value rather than prose. So the
 * claims had nothing holding them to the constants, and the three facts they
 * depend on are each one reviewed diff from moving again.
 *
 * ═══ WHY COMMENTS AND STRINGS, AND NOT CODE ═══
 *
 * A code expression that names a clamp is already checked: it is typed, it is
 * imported from one place, and `identity-write-ceiling-matches-the-pass` pins
 * the route that publishes it. What nothing checks is a sentence. So the
 * population here is exactly the two things a compiler never reads — comment
 * text and string literals — and a mutation below proves a claim in bare code
 * is ignored ON PURPOSE rather than missed.
 *
 * ═══ WHAT THIS DOES NOT COVER — read before trusting it ═══
 *
 * The detector is DIRECTIONAL: it matches a clamp name FOLLOWED by a mode,
 * within a short same-sentence gap. It does not match a mode followed by a
 * clamp name, and that is a deliberate blind spot rather than an oversight.
 * Every one of the eight real sites was written the forward way, and the
 * reverse pattern cannot tell "a tenant at DRY_RUN, held under
 * JOINER_MAX_MODE" — which is correct prose — from a claim about the constant.
 * A guard that reddens on correct sentences is one people route around, so the
 * recall is traded for that. Say so if you widen it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { repoRelativeFiles, REPO_ROOT } from '../helpers/repo-files';

/**
 * The clamps, and the SOURCE OF TRUTH for each value.
 *
 * Read off the declaration rather than imported, for one reason: importing
 * `identity-joiner-pass` pulls the usecase's whole graph (Prisma, audit,
 * context) into a guard that needs one string, and a guard that needs a DB mock
 * to read a constant is a guard somebody deletes. The shape is asserted exactly
 * below, so a declaration that stops being a plain literal fails loudly instead
 * of being guessed at.
 */
const CLAMP_SOURCES: Readonly<Record<string, string>> = {
    LEAVER_MAX_MODE: 'src/app-layer/usecases/identity-leaver-pass.ts',
    JOINER_MAX_MODE: 'src/app-layer/usecases/identity-joiner-pass.ts',
    ORPHAN_PASS_MAX_MODE: 'src/lib/agentic/owner-orphan.ts',
};

const MODES = ['DISABLED', 'DRY_RUN', 'AUTOMATIC'] as const;
type Mode = (typeof MODES)[number];

const ALLOW_MARKER = 'clamp-claim-allow:';

function readClampValue(name: string): Mode {
    const src = fs.readFileSync(path.join(REPO_ROOT, CLAMP_SOURCES[name]), 'utf8');
    // Both spellings in the tree today: `= 'X' as const;` and `: T = 'X';`.
    const re = new RegExp(
        `export const ${name}(?:\\s*:\\s*[A-Za-z]+)?\\s*=\\s*'(${MODES.join('|')})'`,
    );
    const m = src.match(re);
    if (!m) {
        throw new Error(
            `${name} is no longer a plain mode literal in ${CLAMP_SOURCES[name]}. ` +
                'This guard reads the declaration; teach it the new shape rather than ' +
                'letting it guess, because a wrong value here silently approves every claim.',
        );
    }
    return m[1] as Mode;
}

const CLAMP_VALUES: Readonly<Record<string, Mode>> = Object.fromEntries(
    Object.keys(CLAMP_SOURCES).map((n) => [n, readClampValue(n)]),
);

export interface ClampClaim {
    readonly clamp: string;
    readonly claimed: Mode;
    readonly line: number;
    /** First line of the comment block or code line this claim sits in. */
    readonly block: number;
    readonly text: string;
    readonly allowed: boolean;
}

/** A contiguous run of comment lines, or one line's string literals. */
interface Chunk {
    readonly startLine: number;
    readonly lines: readonly { readonly n: number; readonly text: string }[];
}

const CLAMP_NAMES = Object.keys(CLAMP_SOURCES).join('|');
const CLAIM_RE = new RegExp(`\\b(${CLAMP_NAMES})\\b([^\\n]{0,48}?)\\b(${MODES.join('|')})\\b`, 'g');

/**
 * Comment blocks and string literals, with line numbers.
 *
 * Line-based rather than AST: the subject is text, including text inside
 * template and concatenated strings that no single AST node holds whole.
 */
function chunksOf(src: string): Chunk[] {
    const lines = src.split('\n');
    const chunks: Chunk[] = [];
    let block: { n: number; text: string }[] = [];
    const flush = () => {
        if (block.length) chunks.push({ startLine: block[0].n, lines: block });
        block = [];
    };
    // A run of concatenated string lines, accumulated as ONE text.
    let concat: { n: number; text: string }[] = [];
    const flushConcat = () => {
        if (!concat.length) {
            return;
        }
        // Joined WITHOUT a separator, because that is what `+` does. A claim
        // split over two literals — `'… JOINER_MAX_MODE is ' + 'DRY_RUN …'` —
        // is one sentence to the operator who reads it, and reading the lines
        // separately is how the FIRST version of this guard missed the note in
        // `route-permissions.ts`. Per-line matching found seven of the eight
        // #5566 sites and would have kept missing the eighth for the same
        // reason the claim lasted: nobody reads a concatenation as text.
        chunks.push({
            startLine: concat[0].n,
            lines: [{ n: concat[0].n, text: concat.map((c) => c.text).join('') }],
        });
        concat = [];
    };

    lines.forEach((raw, i) => {
        const n = i + 1;
        const trimmed = raw.trim();
        const isComment =
            trimmed.startsWith('//') ||
            trimmed.startsWith('/*') ||
            trimmed.startsWith('*') ||
            trimmed.startsWith('*/');
        if (isComment) {
            flushConcat();
            block.push({ n, text: raw });
            return;
        }
        flush();
        const strings = raw.match(/'[^']*'|"[^"]*"|`[^`]*`/g);
        if (!strings) {
            flushConcat();
            return;
        }
        const text = strings.map((q) => q.slice(1, -1)).join(' ');
        concat.push({ n, text });
        // A line that does not end in `+` ends the concatenation it was part of.
        if (!trimmed.endsWith('+')) flushConcat();
    });
    flush();
    flushConcat();
    return chunks;
}

/**
 * Every clamp claim in one file's prose and strings.
 *
 * A chunk carrying the allow marker marks its claims `allowed` — that is how a
 * paragraph QUOTES the superseded wording to record it, which several of the
 * #5566 corrections do deliberately.
 */
export function clampClaimsIn(src: string): ClampClaim[] {
    const out: ClampClaim[] = [];
    for (const chunk of chunksOf(src)) {
        const whole = chunk.lines.map((l) => l.text).join('\n');
        // SAME CHUNK ONLY. An earlier draft let the marker carry from the
        // preceding chunk, so that a comment could exempt the string below it —
        // and the laundering test in this file caught that a marker block
        // followed by an unrelated line then exempted whatever came next.
        //
        // Scoping it to the chunk has a consequence worth stating: a claim in
        // an OPERATOR STRING can never be exempted, because the only place the
        // marker could go is inside text shown to a customer. That is the right
        // policy rather than a limitation — customer-facing copy has no reason
        // to quote a superseded constant, and quoting one is how the #5566
        // refusal spent two months telling administrators to wait for a clamp
        // lift that had shipped.
        const allowed = whole.includes(ALLOW_MARKER);
        for (const { n, text } of chunk.lines) {
            for (const m of text.matchAll(CLAIM_RE)) {
                const gap = m[2];
                // Same-sentence only. A gap that crosses a full stop joins two
                // unrelated clauses, which is the interior-span defect the
                // Class C ratchet exists for — in a detector it would invent
                // failures rather than hide them, and both are worth avoiding.
                if (/\.\s/.test(gap) || /;/.test(gap)) continue;
                out.push({
                    clamp: m[1],
                    claimed: m[3] as Mode,
                    line: n,
                    block: chunk.startLine,
                    text: text.trim(),
                    allowed,
                });
            }
        }
    }
    return out;
}

const SRC_FILES = repoRelativeFiles().filter(
    (f) => f.startsWith('src/') && (f.endsWith('.ts') || f.endsWith('.tsx')),
);

interface Finding extends ClampClaim {
    readonly file: string;
}

function scanTree(): { all: Finding[]; disagreeing: Finding[] } {
    const all: Finding[] = [];
    for (const file of SRC_FILES) {
        const src = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
        if (!new RegExp(`\\b(${CLAMP_NAMES})\\b`).test(src)) continue;
        for (const c of clampClaimsIn(src)) all.push({ ...c, file });
    }
    return {
        all,
        disagreeing: all.filter((c) => !c.allowed && c.claimed !== CLAMP_VALUES[c.clamp]),
    };
}

describe('no sentence in src/ contradicts a clamp constant', () => {
    it('every unmarked claim names the value the constant actually holds', () => {
        const { disagreeing } = scanTree();
        const report = disagreeing
            .map(
                (c) =>
                    `${c.file}:${c.line} says ${c.clamp} is ${c.claimed}, ` +
                    `but it is ${CLAMP_VALUES[c.clamp]}\n      ${c.text.slice(0, 150)}`,
            )
            .join('\n  ');
        expect(report).toBe('');
        expect(disagreeing).toHaveLength(0);
    });

    it('FINDS claims at all — the control that says the extractor works', () => {
        // Without this, a broken comment/string extractor returns nothing, the
        // assertion above passes over an empty set, and the guard reports a
        // clean tree it never read. An empty window passes a negated
        // assertion, so the denominator is asserted beside the verdict.
        const { all } = scanTree();
        expect(all.length).toBeGreaterThanOrEqual(6);

        // And it reaches the two KINDS of subject, not just the easy one.
        const files = new Set(all.map((c) => c.file));
        expect(files.has('src/lib/identity/write-ladder.ts')).toBe(true);
        expect(
            files.has('src/app-layer/integrations/providers/active-directory/write-direction.ts'),
        ).toBe(true);
    });

    it('reads a real value for every clamp, and they are modes', () => {
        for (const name of Object.keys(CLAMP_SOURCES)) {
            expect(MODES).toContain(CLAMP_VALUES[name]);
        }
        // The population is non-empty for the reason above: a `repoRelativeFiles`
        // that returned nothing would make every scan vacuous.
        expect(SRC_FILES.length).toBeGreaterThan(500);
    });
});

describe('the detector discriminates — mutation proofs', () => {
    const wrongMode = (clamp: string): Mode =>
        MODES.filter((m) => m !== CLAMP_VALUES[clamp])[0];

    it('catches a wrong claim in a line comment', () => {
        const bad = wrongMode('JOINER_MAX_MODE');
        const found = clampClaimsIn(`// the pass is held because JOINER_MAX_MODE is ${bad}\n`);
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ clamp: 'JOINER_MAX_MODE', claimed: bad, allowed: false });
    });

    it('catches a wrong claim in a docblock line', () => {
        const bad = wrongMode('LEAVER_MAX_MODE');
        const found = clampClaimsIn(` * What holds it is \`LEAVER_MAX_MODE = '${bad}'\`, a constant.\n`);
        expect(found.map((c) => c.claimed)).toEqual([bad]);
    });

    it('catches a wrong claim in an operator string', () => {
        const bad = wrongMode('JOINER_MAX_MODE');
        const found = clampClaimsIn(
            `const copy = 'undeclared while JOINER_MAX_MODE is ${bad}, because a box';\n`,
        );
        expect(found.map((c) => c.claimed)).toEqual([bad]);
    });

    it('catches the parenthetical form, which is how the eighth site read', () => {
        const bad = wrongMode('JOINER_MAX_MODE');
        const found = clampClaimsIn(`    // the clamp EXISTS — \`JOINER_MAX_MODE\` (${bad}) in\n`);
        expect(found.map((c) => c.claimed)).toEqual([bad]);
    });

    it('does NOT fault a claim that agrees with the constant', () => {
        const right = CLAMP_VALUES.JOINER_MAX_MODE;
        const found = clampClaimsIn(`// \`JOINER_MAX_MODE\` sits at ${right} since #2954\n`);
        expect(found).toHaveLength(1);
        expect(found[0].claimed).toBe(right);
        expect(found.filter((c) => c.claimed !== CLAMP_VALUES[c.clamp])).toHaveLength(0);
    });

    it('allows a marked block to quote superseded wording', () => {
        const bad = wrongMode('JOINER_MAX_MODE');
        const found = clampClaimsIn(
            [
                `    // It used to read "JOINER_MAX_MODE is ${bad}", which #2954 made false.`,
                `    //    ${ALLOW_MARKER} records the superseded wording`,
                '',
            ].join('\n'),
        );
        expect(found).toHaveLength(1);
        expect(found[0].allowed).toBe(true);
    });

    it('does not let a marker on a DIFFERENT block launder a claim', () => {
        const bad = wrongMode('JOINER_MAX_MODE');
        const found = clampClaimsIn(
            [
                `    //    ${ALLOW_MARKER} this block is the marked one`,
                '',
                'const x = 1;',
                '',
                `    // and over here, unmarked: JOINER_MAX_MODE is ${bad}`,
                '',
            ].join('\n'),
        );
        expect(found.filter((c) => !c.allowed).map((c) => c.claimed)).toEqual([bad]);
    });

    it('cannot exempt an operator string, by construction', () => {
        // The marker would have to live in the copy itself. Asserted so the
        // property is on the record rather than an accident of the scoping.
        const bad = wrongMode('JOINER_MAX_MODE');
        const found = clampClaimsIn(
            [
                `    //    ${ALLOW_MARKER} an attempt to exempt the string below`,
                `    const copy = 'held while JOINER_MAX_MODE is ${bad}';`,
                '',
            ].join('\n'),
        );
        expect(found.map((c) => c.allowed)).toEqual([false]);
    });

    it('ignores a claim in bare code, deliberately', () => {
        // Not a miss. `isAboveClamp(rung, JOINER_MAX_MODE) /* DRY_RUN */` style
        // code is type-checked and single-sourced; prose is the unguarded
        // surface. Stated as a test so the scope is a decision on the record.
        const bad = wrongMode('JOINER_MAX_MODE');
        expect(clampClaimsIn(`const x = pick(JOINER_MAX_MODE, ${bad});\n`)).toHaveLength(0);
    });

    it('catches a claim SPLIT across a string concatenation — the eighth site', () => {
        // The shape that escaped the first version of this guard: one sentence,
        // two literals, the clamp name at the end of one line and the mode at
        // the start of the next.
        const bad = wrongMode('JOINER_MAX_MODE');
        const found = clampClaimsIn(
            [
                "            'the note used to say JOINER_MAX_MODE is ' +",
                `            '${bad} and the pass writes none',`,
                '',
            ].join('\n'),
        );
        expect(found.map((c) => c.claimed)).toEqual([bad]);
    });

    it('does not run two UNRELATED strings together', () => {
        // The concatenation join is only for lines that continue with `+`. Two
        // separate statements must not be fused, or the guard invents claims.
        const bad = wrongMode('JOINER_MAX_MODE');
        const found = clampClaimsIn(
            [`const a = 'JOINER_MAX_MODE';`, `const b = '${bad}';`, ''].join('\n'),
        );
        expect(found).toHaveLength(0);
    });

    it('does not join two sentences across a full stop', () => {
        const bad = wrongMode('JOINER_MAX_MODE');
        expect(
            clampClaimsIn(`// JOINER_MAX_MODE is the brake. A tenant at ${bad} is below it.\n`),
        ).toHaveLength(0);
    });
});

describe('the allow marker stays rare and reasoned', () => {
    it('every marker carries a reason', () => {
        const bare: string[] = [];
        for (const file of SRC_FILES) {
            const src = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
            if (!src.includes(ALLOW_MARKER)) continue;
            src.split('\n').forEach((l, i) => {
                const at = l.indexOf(ALLOW_MARKER);
                if (at === -1) return;
                if (l.slice(at + ALLOW_MARKER.length).trim().length < 10) {
                    bare.push(`${file}:${i + 1}`);
                }
            });
        }
        expect(bare).toEqual([]);
    });

    it('exempts exactly the four paragraphs that quote the old wording', () => {
        const { all } = scanTree();
        const marked = all.filter((c) => c.allowed);

        // Named rather than counted, because a bare number says nothing about
        // WHICH paragraphs stopped being checked — and FILES rather than lines,
        // because a line number in an expectation reddens on the next unrelated
        // edit to the same file and teaches people to re-paste it.
        const blocks = [...new Set(marked.map((c) => `${c.file}:${c.block}`))];
        expect([...new Set(marked.map((c) => c.file))].sort()).toEqual([
            'src/app-layer/integrations/providers/active-directory/write-direction.ts',
            'src/app-layer/usecases/identity-write-policy.ts',
            'src/app/api/t/[tenantSlug]/admin/identity-joiner-passes/run/route.ts',
            'src/lib/identity/write-ladder.ts',
        ]);

        // One block each: a second exempt paragraph in the same file is a
        // reviewed diff, not a line that slides in. Shrink this; do not grow it.
        expect(blocks).toHaveLength(4);
    });
});
