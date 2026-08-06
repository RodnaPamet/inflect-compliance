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
