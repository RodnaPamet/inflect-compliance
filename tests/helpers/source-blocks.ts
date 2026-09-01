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
 * EVERY helper here reads CODE ONLY — see `maskNonCode()` below. That
 * applies to the anchor search as much as to the brace scan, and the
 * distinction is not academic: the first version masked only the scan, so a
 * comment mentioning the target ahead of the real one anchored the whole
 * extraction inside the comment and the guard asserted against prose
 * (measured: `tests/guards/p-polish-d.test.ts` stayed 20/20 green with the
 * poll interval inverted, because a three-line "historical note" above it
 * mentioned `setInterval(`). That is the same defect class this file exists
 * to close, so the masking is applied once, up front, and both the search
 * and the scan run on the masked view.
 */

/**
 * Return `src` with every byte that is not CODE replaced by a space,
 * PRESERVING OFFSETS and newlines — so an index found in the returned
 * string indexes the same character in `src`.
 *
 * Blanked: line comments, block comments, and string / template literals
 * INCLUDING their delimiters. Blanking the delimiters too is what lets the
 * callers drop their own quote state machines: a masked literal contributes
 * no `(`, `{`, `;` or quote character to the scan, so depth tracking is
 * unaffected by whatever was inside it.
 *
 * Known limits, both shared with the hand-rolled scanners this replaced and
 * both harmless for the guards that call it: a regex literal (`/…\(/`) is
 * not recognised as a literal, and `${…}` interpolations inside a template
 * literal are blanked along with the rest of the template rather than being
 * treated as code. An unterminated comment or literal blanks to EOF, which
 * makes the caller throw `unterminated …` rather than return a wrong block.
 */
function maskNonCode(src: string): string {
    const out = src.split('');
    const blank = (from: number, to: number) => {
        for (let k = from; k < to && k < src.length; k++) {
            if (src[k] !== '\n') out[k] = ' ';
        }
    };

    let i = 0;
    while (i < src.length) {
        const ch = src[i];
        const next = src[i + 1];

        if (ch === '/' && next === '/') {
            const nl = src.indexOf('\n', i);
            const end = nl < 0 ? src.length : nl;
            blank(i, end);
            i = end;
            continue;
        }
        if (ch === '/' && next === '*') {
            const close = src.indexOf('*/', i + 2);
            const end = close < 0 ? src.length : close + 2;
            blank(i, end);
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
            blank(i, j);
            i = j;
            continue;
        }
        i++;
    }

    return out.join('');
}

/**
 * Public face of `maskNonCode()`, for guards that match against an ALREADY
 * extracted block and must not let a docblock satisfy the assertion — the
 * same reason `tests/guards/machine-caller-paths-self-authenticate.test.ts`
 * carries a local `codeOnly()`. Prefer this: a regex comment-stripper does
 * not know that `//` inside a string is not a comment, and it shifts every
 * offset, so a second extraction on the result no longer lines up with the
 * file.
 */
export function codeOf(src: string): string {
    return maskNonCode(src);
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
 * Both the anchor search and the scan run on `maskNonCode(src)`, so neither
 * a `const <name>` written in a comment nor a `;` inside a string can
 * mis-anchor or truncate the extraction.
 *
 * Throws (rather than returning '') when the declaration is missing or
 * unbalanced — a guard whose target was renamed away should fail loudly,
 * not assert against an empty string.
 */
export function declarationOf(src: string, name: string): string {
    const code = maskNonCode(src);
    const start = code.search(new RegExp(`\\bconst ${name}\\b`));
    if (start < 0) throw new Error(`declaration not found: const ${name}`);

    let depth = 0;
    for (let i = start; i < code.length; i++) {
        const ch = code[i];
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
        else if (ch === ';' && depth === 0) return src.slice(start, i + 1);
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
 * Both the anchor search and the scan run on `maskNonCode(src)`, so a
 * `function <name>` written in a comment cannot anchor the extraction and a
 * brace or apostrophe inside a comment or string cannot terminate it early.
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
 * block's own opening brace. `code` is the masked view (offsets identical to
 * `src`); the slice is taken from `src` so the caller gets real text back.
 */
function braceBoundedFrom(
    src: string,
    code: string,
    start: number,
    label: string,
): string {
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
            if (seenBody && braces === 0) return src.slice(start, i + 1);
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
 * names is gone.
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
 * Both the anchor search and the scan run on `maskNonCode(src)`. The anchor
 * half matters MOST for this helper: `setInterval` is a builtin, far likelier
 * to appear in prose than the project-specific identifiers the two siblings
 * target, and the first version searched the raw source — so a comment
 * mentioning `setInterval(` above the real call returned THE COMMENT, and
 * `expect(interval).not.toMatch(/runFetch\(false\)/)` passed against prose
 * with the behaviour inverted. The search is for the callee followed by `(`,
 * so a bare mention in a type position (`ReturnType<typeof setInterval>`) is
 * still not mistaken for the call.
 *
 * Throws (rather than returning '') when the call is missing or unbalanced
 * — a guard whose target was renamed away must fail loudly, not assert
 * against an empty string.
 */
export function callExpressionOf(src: string, callee: string): string {
    const code = maskNonCode(src);
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
            if (seenOpen && depth === 0) return src.slice(start, i + 1);
        }
    }
    throw new Error(`unterminated call expression: ${callee}(`);
}
