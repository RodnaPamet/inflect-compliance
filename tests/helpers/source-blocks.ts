/**
 * Helpers for the source-reading guards in `tests/guards` / `tests/guardrails`.
 *
 * WHY THIS EXISTS: several guards needed to assert something about ONE
 * function inside a large file, and each hand-rolled the extraction as a
 * `slice()` — either between two declaration names, or across a magic byte
 * offset:
 *
 *     panel.slice(panel.indexOf('const acceptSuggestion'),
 *                 panel.indexOf('const saveResidualOverride'))
 *     client.slice(start, start + 1200)
 *     dashboard.slice(dashboard.indexOf('risk-stale-row-') - 800, … + 400)
 *
 * Both forms fail on edits that are not regressions — reordering two
 * functions, renaming the neighbour, or letting a function grow past the
 * magic length. Worse, they fail SILENTLY in the direction that matters: a
 * backwards or truncated slice yields a short string, and every
 * `expect(block).not.toMatch(…)` in it then passes vacuously. The guard goes
 * green while checking nothing.
 *
 * Bounding by the code's own braces removes the coupling. This is still
 * source-text matching — see CLAUDE.md → "Epic-ratchet lifecycle" for when
 * to reach for an ESLint rule or a behavioural test instead — but it is at
 * least anchored to the construct being asserted.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE CONTRACT, AND WHY IT IS A DEFAULT RATHER THAN AN OPTION
 *
 * Every function here — the four extractors and `codeOf()` — returns text
 * whose COMMENTS HAVE BEEN BLANKED. There is no raw-text mode and no
 * `{ raw: true }` escape hatch, because the whole defect class this file
 * exists to close is "an assertion meant to be about code was satisfied by
 * prose", and a helper that returns raw text while relying on each call site
 * to remember `codeOf(...)` has exactly the shape of that bug: correct only
 * while nobody forgets. Measured twice, on this very file's own callers:
 *
 *   1. The anchor SEARCH ran on raw text, so a comment mentioning
 *      `setInterval(` ahead of the real call anchored the extraction inside
 *      the comment and the guard asserted against prose.
 *   2. Fixed (1) by masking the search — but the RETURN was still
 *      `src.slice(…)`, so a stale comment left inside the extracted callback
 *      satisfied the positive assertion. `tests/guards/p-polish-d.test.ts`
 *      stayed 20/20 green with the poll flag inverted and this comment in
 *      the callback:
 *
 *          // Poll revalidation — equivalent to runFetch(true): keeps
 *          // the last-good options on a transient blip.
 *          void runFetch(POLL_REVALIDATES);
 *
 * Both are the same defect one step apart, which is what a default is for.
 *
 * STRING LITERALS ARE KEPT. Two masks exist and the difference is
 * load-bearing:
 *
 *   • `maskNonCode()` (private) blanks comments AND literals. Only the
 *     anchor search and the brace/paren scan use it, because a `{`, `;` or
 *     apostrophe inside a literal must not move a boundary.
 *   • `maskComments()` (public as `codeOf`) blanks comments ONLY. That is
 *     what callers receive, because a string literal IS code to a guard:
 *     `tests/guardrails/soc2-starter-pack-coverage.test.ts` harvests
 *     `code: 'CC1.1'` out of a block, and `tests/guardrails/api-read-rate-
 *     limit.test.ts` asserts `'/api/health'` is still in an exclusion array.
 *     Masking literals by default would have quietly emptied both. It also
 *     matches the ~30 hand-rolled `stripComments()` / `codeOnly()` helpers
 *     already in `tests/`, every one of which strips comments and keeps
 *     strings.
 *
 * OFFSETS ARE PRESERVED. Both masks replace each blanked byte with a space
 * (newlines survive), so line numbers, `indexOf` results and `.replace()`
 * of one returned block out of `codeOf(src)` all still line up. An
 * extractor's result is a substring of `codeOf(src)`, NOT of `src` — a
 * caller that needs to subtract one block from the whole file must do it
 * against `codeOf(src)`.
 *
 * THE ANCHOR IS THE FIRST MATCH, AND THAT IS A BOUND ON WHAT THESE PROVE.
 * Every extractor here locates its target with a single `.search(...)`, so a
 * file holding TWO constructs that match the anchor binds to the EARLIER one
 * and the guard then asserts about the wrong construct. Ordinarily that is
 * loud — an unrelated second construct in front of the intended one does not
 * satisfy the guard's positive assertion, so the guard goes red. It is silent
 * only when the decoy ITSELF carries the token being asserted, which needs a
 * diff that adds the whole second construct AND writes the passing token into
 * it. Both halves are measured in `tests/unit/source-blocks-helpers.test.ts`
 * against the real `tests/guards/p-polish-d.test.ts`.
 *
 * Where the target is brace-bounded, the answer is a NARROWER anchor:
 * `braceBlockAfter(src, 'function second')` instead of relying on there being
 * only one match. For a CALL expression there is no such route today —
 * `callExpressionOf` takes a bare callee identifier with no pattern to narrow
 * with, and `braceBlockAfter` cannot substitute, because its paren guard
 * ignores any `{` at paren depth > 0 and so never sees a callback brace
 * inside the call's own parentheses (it throws `unterminated`, measured). A
 * guard needing the second call of a callee must keep one such call per file
 * or grow this helper a narrowing anchor. See #2238.
 */

type SpanKind = 'comment' | 'literal';

interface Span {
    start: number;
    /** Exclusive. */
    end: number;
    kind: SpanKind;
}

/**
 * Single lexical pass classifying every comment and string/template literal
 * in `src`. Both masks are built from this one scan so they can never
 * disagree about where a span begins — a disagreement would put the search
 * view and the returned view out of alignment by exactly the bytes that
 * matter.
 *
 * Known limits, both inherited from the hand-rolled scanners this replaced
 * and both harmless for the guards that call it: a regex literal (`/…\(/`)
 * is not recognised as a literal, and `${…}` interpolations inside a
 * template literal are treated as part of the literal rather than as code.
 * An unterminated comment or literal runs to EOF, which makes the caller
 * throw `unterminated …` rather than return a wrong block.
 */
function scanSpans(src: string): Span[] {
    const spans: Span[] = [];
    let i = 0;

    while (i < src.length) {
        const ch = src[i];
        const next = src[i + 1];

        if (ch === '/' && next === '/') {
            const nl = src.indexOf('\n', i);
            const end = nl < 0 ? src.length : nl;
            spans.push({ start: i, end, kind: 'comment' });
            i = end;
            continue;
        }
        if (ch === '/' && next === '*') {
            const close = src.indexOf('*/', i + 2);
            const end = close < 0 ? src.length : close + 2;
            spans.push({ start: i, end, kind: 'comment' });
            i = end;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
            let j = i + 1;
            while (j < src.length) {
                if (src[j] === '\\') {
                    j += 2;
                    continue;
                }
                if (src[j] === ch) {
                    j++;
                    break;
                }
                j++;
            }
            spans.push({ start: i, end: j, kind: 'literal' });
            i = j;
            continue;
        }
        i++;
    }

    return spans;
}

/**
 * Blank the requested span kinds, PRESERVING OFFSETS and newlines — so an
 * index found in the returned string indexes the same character in `src`.
 * Delimiters are blanked along with the contents: a masked literal
 * contributes no `(`, `{`, `;` or quote character to a scan, which is what
 * lets the callers drop their own quote state machines.
 */
function maskSpans(src: string, kinds: readonly SpanKind[]): string {
    const out = src.split('');
    for (const span of scanSpans(src)) {
        if (!kinds.includes(span.kind)) continue;
        for (let k = span.start; k < span.end && k < src.length; k++) {
            if (src[k] !== '\n') out[k] = ' ';
        }
    }
    return out.join('');
}

/** Comments AND literals blanked. Anchor search + brace/paren scan only. */
function maskNonCode(src: string): string {
    return maskSpans(src, ['comment', 'literal']);
}

/** Comments blanked, string literals kept. What every caller receives. */
function maskComments(src: string): string {
    return maskSpans(src, ['comment']);
}

/**
 * Return `src` with its comments blanked and its string literals intact,
 * offsets and line numbers unchanged.
 *
 * Use this on any source text a guard is about to match against that did
 * NOT come from one of the extractors below — a whole file read straight
 * off disk, or a block derived by hand. The extractors already apply it, so
 * wrapping their result is redundant (harmless, but say what you mean).
 *
 * Prefer it over a local regex comment-stripper: a regex does not know that
 * `//` inside a string is not a comment, and stripping (rather than
 * blanking) shifts every offset so a second extraction on the result no
 * longer lines up with the file.
 */
export function codeOf(src: string): string {
    return maskComments(src);
}

/**
 * Return the whole `const <name> = …;` declaration, from the keyword to the
 * semicolon that closes it at nesting depth zero.
 *
 * Statement-level rather than brace-level on purpose. An earlier version
 * took "the first `{` after the declaration and its matching `}`", which is
 * wrong for the common React shape
 *
 *     const matrixMovements = useMemo(() => rows.filter(…).map((r) => ({ … })), [rows]);
 *
 * where the first brace belongs to the mapped OBJECT LITERAL, not the
 * declaration — so the extract silently excluded the `.filter(…)` predicate
 * that the assertion was about. Tracking `()`, `[]` and `{}` together, and
 * stopping at the top-level `;`, handles arrow bodies, memo callbacks and
 * plain object/array literals alike.
 *
 * Anchor, scan and RESULT are all comment-free — see the file header. So
 * neither a `const <name>` written in a comment can mis-anchor it, nor a
 * `;` inside a string truncate it, nor a comment inside the declaration
 * satisfy an assertion about the declaration.
 *
 * Throws (rather than returning '') when the declaration is missing or
 * unbalanced — a guard whose target was renamed away should fail loudly,
 * not assert against an empty string.
 */
export function declarationOf(src: string, name: string): string {
    const code = maskNonCode(src);
    const text = maskComments(src);
    const start = code.search(new RegExp(`\\bconst ${name}\\b`));
    if (start < 0) throw new Error(`declaration not found: const ${name}`);

    let depth = 0;
    for (let i = start; i < code.length; i++) {
        const ch = code[i];
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
        else if (ch === ';' && depth === 0) return text.slice(start, i + 1);
    }
    throw new Error(`unterminated declaration: const ${name}`);
}

/**
 * Return `[export] [async] function <name>(…) { … }`, bounded by the brace
 * that closes its body at depth zero.
 *
 * Sibling of `declarationOf()` above, which bounds a `const <name> = …;`
 * declaration by its top-level semicolon; this one bounds a `function`
 * declaration by its body braces. (The sentence here used to read "but it
 * only matches `const <name> = …;`", describing the sibling rather than this
 * function — corrected in the same pass that made the anchors code-only,
 * because a docstring nobody can trust is the same liability as a guard that
 * cannot fail.) The same rule applies here and for the same reason: a slice
 * with no end bound (the shape this file used to carry —
 * `src.slice(src.indexOf('export async function bulkSetStatus'))`, running
 * to EOF) stays green when the target function is gutted, provided any LATER
 * function in the file still mentions the identifiers being matched.
 *
 * Anchor, scan and RESULT are all comment-free — see the file header.
 */
export function functionBodyOf(src: string, name: string): string {
    const code = maskNonCode(src);
    const start = code.search(
        new RegExp(`\\b(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`),
    );
    if (start < 0) throw new Error(`function not found: ${name}`);
    return braceBoundedFrom(src, code, start, `function body: ${name}`);
}

/**
 * Shared tail of `functionBodyOf()` and `interfaceBodyOf()`: from `start`,
 * return through the `}` that closes the first `{` seen at paren depth zero.
 *
 * The paren guard is what makes a parameter default (`function f(o = { a: 1 })`)
 * or a method signature inside an interface body not be mistaken for the
 * block's own opening brace. `code` is the fully masked view (offsets
 * identical to `src`); the slice is taken from the comment-masked view so
 * the caller gets real code back — string literals included, prose not.
 */
function braceBoundedFrom(
    src: string,
    code: string,
    start: number,
    label: string,
): string {
    const text = maskComments(src);
    let parens = 0;
    let braces = 0;
    let seenBody = false;

    for (let i = start; i < code.length; i++) {
        const ch = code[i];

        if (ch === '(') parens++;
        else if (ch === ')') parens--;
        else if (ch === '{' && parens === 0) {
            braces++;
            seenBody = true;
        } else if (ch === '}' && parens === 0) {
            braces--;
            if (seenBody && braces === 0) return text.slice(start, i + 1);
        }
    }
    throw new Error(`unterminated ${label}`);
}

/**
 * Return `interface <name> { … }`, bounded by the brace that closes the
 * body. `namePattern` is a regex fragment, not a literal, because the guards
 * that need this assert over a FAMILY of sibling types
 * (`Tenant\w+Option` — TenantControlOption / TenantRiskOption /
 * TenantAssetOption).
 *
 * Written for a defect of exactly the shape this file exists to close:
 * `tests/guards/p-polish-d.test.ts` asserted the option types carry a status
 * field with
 *
 *     /export interface Tenant\w+Option\s*\{[\s\S]*?status:\s*string \| null/
 *
 * — a LAZY span from the interface's opening brace to the first
 * `status: string | null` ANYWHERE later in the file. It was correct only
 * because no second occurrence existed; delete the field from the interface,
 * add one to any later type, and the guard stays green while the invariant it
 * names is gone. And because the body of an option type is mostly docblock,
 * the comment-free RESULT matters as much as the bound: a field promised in
 * prose must not read as a field.
 */
export function interfaceBodyOf(src: string, namePattern: string): string {
    const code = maskNonCode(src);
    const start = code.search(
        new RegExp(`\\b(?:export\\s+)?interface\\s+(?:${namePattern})\\b`),
    );
    if (start < 0) throw new Error(`interface not found: ${namePattern}`);
    return braceBoundedFrom(src, code, start, `interface body: ${namePattern}`);
}

/**
 * Return the `{ … }` block that opens after the first CODE occurrence of
 * `anchorPattern` (a regex fragment), inclusive of the anchor itself.
 *
 * The general form of `functionBodyOf()` / `interfaceBodyOf()`, for the
 * blocks that carry no declaration keyword to anchor on — an `if`, a `try`,
 * a `for`. It exists because the alternative in the wild is a lazy span:
 *
 *     src.match(/if \(isApiReadRateLimited[\s\S]+?checkApiReadRateLimit/)
 *
 * which asserts only that the two identifiers appear IN THAT ORDER somewhere
 * in the file. Move the guarded call out of the `if` and leave the `if`
 * behind, or add any later mention of the callee, and the span re-forms
 * across the gap — it never bound the call to the block it names. Bounding
 * on the block's own braces is what makes it bind.
 *
 * Anchor, scan and RESULT are all comment-free — see the file header.
 */
export function braceBlockAfter(src: string, anchorPattern: string): string {
    const code = maskNonCode(src);
    const start = code.search(new RegExp(anchorPattern));
    if (start < 0) throw new Error(`block anchor not found: ${anchorPattern}`);
    return braceBoundedFrom(src, code, start, `block: ${anchorPattern}`);
}

/**
 * Return the whole `<callee>(…)` call expression, from the callee name to
 * the parenthesis that closes its argument list at nesting depth zero.
 *
 * Third sibling of `declarationOf()` and `functionBodyOf()` above, and it
 * exists for the call sites neither of those can reach. A callback passed
 * to a call — `setInterval(() => { … }, pollMs)` — belongs to no `const`
 * and to no named `function`, so a guard asserting something about the
 * callback BODY had no way to bound its read and fell back to grepping the
 * whole file.
 *
 * That is not a cosmetic difference. Three unanchored regexes over one file
 * cannot bind a call to its call site: `/runFetch\(true\)/` is satisfied by
 * ANY occurrence anywhere, so an interval flipped to `runFetch(false)` with
 * a stray `runFetch(true)` left elsewhere passed every check while the
 * behaviour was inverted (measured at 20/20 green — see #2238). Bounding
 * the read to the call's own parentheses is what makes the assertion bind.
 *
 * Anchor, scan and RESULT are all comment-free, and this helper is where
 * each of those bit in turn. The ANCHOR half matters most here: `setInterval`
 * is a builtin, far likelier to appear in prose than the project-specific
 * identifiers the two siblings target, so a comment mentioning
 * `setInterval(` above the real call used to return THE COMMENT. The RESULT
 * half bit next: with the anchor fixed the extraction was still
 * `src.slice(…)`, so a stale `// equivalent to runFetch(true)` inside the
 * callback satisfied the positive assertion with the flag inverted. The
 * search is for the callee followed by `(`, so a bare mention in a type
 * position (`ReturnType<typeof setInterval>`) is still not mistaken for the
 * call.
 *
 * Throws (rather than returning '') when the call is missing or unbalanced
 * — a guard whose target was renamed away must fail loudly, not assert
 * against an empty string.
 */
export function callExpressionOf(src: string, callee: string): string {
    const code = maskNonCode(src);
    const text = maskComments(src);
    const start = code.search(new RegExp(`\\b${callee}\\s*\\(`));
    if (start < 0) throw new Error(`call expression not found: ${callee}(`);

    let depth = 0;
    let seenOpen = false;

    for (let i = start; i < code.length; i++) {
        const ch = code[i];

        if (ch === '(') {
            depth++;
            seenOpen = true;
        } else if (ch === ')') {
            depth--;
            if (seenOpen && depth === 0) return text.slice(start, i + 1);
        }
    }
    throw new Error(`unterminated call expression: ${callee}(`);
}
