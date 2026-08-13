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
 */

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
 * Quoted text is skipped so a `;` or brace inside a string or template
 * literal cannot terminate the scan early.
 *
 * Throws (rather than returning '') when the declaration is missing or
 * unbalanced — a guard whose target was renamed away should fail loudly,
 * not assert against an empty string.
 */
export function declarationOf(src: string, name: string): string {
    const start = src.search(new RegExp(`\\bconst ${name}\\b`));
    if (start < 0) throw new Error(`declaration not found: const ${name}`);

    let depth = 0;
    let quote: string | null = null;
    for (let i = start; i < src.length; i++) {
        const ch = src[i];
        if (quote) {
            if (ch === '\\') i++;
            else if (ch === quote) quote = null;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
        if (ch === '(' || ch === '[' || ch === '{') depth++;
        else if (ch === ')' || ch === ']' || ch === '}') depth--;
        else if (ch === ';' && depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(`unterminated declaration: const ${name}`);
}

/**
 * Return `export async function <name>(…) { … }`, bounded by the brace
 * that closes its body at depth zero.
 *
 * Sibling of `declarationOf()` above, which bounds a `const` declaration;
 * this one bounds a `function` declaration, but it only matches `const <name> = …;`. The same rule
 * applies here and for the same reason: a slice with no end bound (the
 * shape this file used to carry — `src.slice(src.indexOf('export async
 * function bulkSetStatus'))`, running to EOF) stays green when the
 * target function is gutted, provided any LATER function in the file
 * still mentions the identifiers being matched.
 *
 * Quoted text and comments are skipped so a brace or apostrophe inside
 * either cannot terminate the scan early.
 */
export function functionBodyOf(src: string, name: string): string {
    const start = src.search(
        new RegExp(`\\b(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\b`),
    );
    if (start < 0) throw new Error(`function not found: ${name}`);

    let parens = 0;
    let braces = 0;
    let seenBody = false;
    let quote: string | null = null;

    for (let i = start; i < src.length; i++) {
        const ch = src[i];
        const next = src[i + 1];

        if (quote) {
            if (ch === '\\') i++;
            else if (ch === quote) quote = null;
            continue;
        }
        if (ch === '/' && next === '/') {
            i = src.indexOf('\n', i);
            if (i < 0) break;
            continue;
        }
        if (ch === '/' && next === '*') {
            const end = src.indexOf('*/', i + 2);
            if (end < 0) break;
            i = end + 1;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
            quote = ch;
            continue;
        }
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
    throw new Error(`unterminated function body: ${name}`);
}
