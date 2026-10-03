/**
 * THE BUTTON VARIANT CENSUS — one counter, two guards.
 *
 * Extracted from `tests/guards/primary-secondary-ratio.test.ts` on 2026-10-04,
 * because there were TWO counters and they disagreed.
 *
 * `primary-secondary-ratio` enforces the product-wide ceiling and counted with
 * this TypeScript-parser census. `primary-action-budget` enforces the per-file
 * backstop and counted with
 *
 *     /<Button\b[\s\S]*?\bvariant=["']primary["']/g
 *
 * which is wrong in both directions and was the exact counter #2379 replaced
 * here. Worked example, `tasks/TasksClient.tsx`: four `Button` sites — one
 * `variant="secondary"`, one `variant="primary"`, two
 * `variant={cond ? 'primary' : 'secondary'}`. The census counts 3 primaries.
 * The lazy regex counts 1: its span runs from the FIRST `<Button` past the
 * secondary to the first literal `variant="primary"`, swallowing both into one
 * match, and a ternary is invisible to it. The budget was 2, so the guard
 * PASSED a file it undercounted by two.
 *
 * The guard's own map already admitted the mechanism in one entry's comment
 * ("The 3rd count is a scanner artifact: the error-state retry
 * `<Button variant="secondary">` ... anchors a lazy `<Button...variant="primary">`
 * bridge") — a workaround recorded instead of a fix.
 *
 * So the per-file budgets were never comparable to the product-wide ceiling,
 * and anyone reasoning about headroom from `PRIMARY_BUDGET` was reading a
 * different number. Both guards now import this module; they cannot drift
 * again without the drift being a change to this file.
 *
 * NOTE the two still differ in SCOPE on purpose: the ratio/ceiling scans
 * `src/app` only, the per-file budget scans `src/app` AND `src/components`.
 * That asymmetry is real and matters — demoting a primary inside
 * `src/components` frees nothing against the product-wide ceiling.
 */
import * as ts from "typescript";

const BUTTON_DEFAULT_VARIANT = "primary";

/**
 * What one `<Button>`'s `variant=` says, as source structure.
 *
 * `unreadable` carries the offending expression (when there is one) plus
 * the text to show a human, so the assertion below can name the site.
 */
type VariantSource =
    | { kind: "absent" }
    | { kind: "literal"; value: string }
    | { kind: "unreadable"; node: ts.Expression | null; display: string };

/**
 * `parseDiagnostics` is populated by `ts.createSourceFile` but is not in
 * the public typings, so it is declared here rather than cast away.
 */
type ParsedSourceFile = ts.SourceFile & {
    parseDiagnostics?: readonly ts.Diagnostic[];
};

/**
 * Why the TypeScript parser and not a regex or a hand-rolled walk.
 *
 * Three counters have now been tried on this guard, and the first two
 * were both wrong in ways that only a parser fixes:
 *
 *   1. `<Button\b[^>]*?\bvariant=["']primary["']` (pre-#2379) could only
 *      see a `variant` written before the first `>` after `<Button`. A
 *      `>` turns up early and often inside props — `onClick={() =>
 *      save()}` — so a Button that spells an arrow handler before its
 *      variant was invisible. Widening `[^>]` to `[\s\S]` is the worse
 *      bug rather than the fix: it runs past the tag into the children
 *      and picks up a NESTED element's variant.
 *   2. A hand-rolled brace/quote/comment-aware tag scanner (the first
 *      cut of #2379) got the inside of a tag right and the OUTSIDE of
 *      one wrong: its `<Button\b` opener still ran over raw file text,
 *      so `<Button>` written in a comment or a string counted as a
 *      site. That inflated the secondary side by one — see the round-2
 *      note in the bump log — and it is exactly the defect #2375 fixed
 *      in `metadatabar-detail-coverage.test.ts`: "a check that fires on
 *      prose about the thing, rather than on the thing, tells the next
 *      author to delete the explanation instead of the usage, which is
 *      exactly backwards."
 *
 * The house answer to (2) is `stripComments()` before the scan (24
 * guards under `tests/` do it). A parser is the exact version of that
 * same idea and strictly stronger: it also covers the string-literal
 * case that `stripComments` cannot see, it keeps `file:line` honest
 * without blanking text, and it does not have to guess whether a `'` is
 * a quote or the apostrophe in `<p>Don't</p>` — a guess a whole-file
 * inert-region walk has to make, and one that fails toward a LOWER
 * count, which is the wrong direction for a ceiling.
 *
 * Two shapes from real files that killed the earlier counters and are
 * non-events for the parser: `admin/identity-write-policy/
 * WriteLadderClient.tsx` puts a multi-line `//` comment BETWEEN props
 * inside an open tag, and that comment contains a BACKTICK (a naive
 * quote tracker reads it as a template-literal opener and swallows the
 * rest of the file); `login/page.tsx:210` documents its OAuth buttons in
 * a JSX comment that quotes `<Button variant="secondary">`.
 *
 * `ts.ScriptKind.TSX` is what makes `<Button …>` a `JsxOpeningElement`
 * rather than a type assertion, and the tag name is compared as an
 * identifier — so `<ButtonGroup>` and `</Button>` are not matches by
 * construction, not by a word-boundary trick.
 *
 * Precedent: `tests/helpers/assertion-reach.ts` and
 * `tests/helpers/route-authorization-graph.ts` already analyse this tree
 * with `ts.createSourceFile`, syntactically, with no type checker.
 */
function parseTsx(rel: string, content: string): ParsedSourceFile {
    return ts.createSourceFile(
        rel,
        content,
        ts.ScriptTarget.Latest,
        /* setParentNodes */ true,
        ts.ScriptKind.TSX,
    );
}

/** Every `<Button …>` / `<Button … />` JSX open tag in one file. */
function buttonOpenElements(sf: ts.SourceFile): ts.JsxOpeningLikeElement[] {
    const out: ts.JsxOpeningLikeElement[] = [];
    const visit = (node: ts.Node): void => {
        if (
            (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
            ts.isIdentifier(node.tagName) &&
            node.tagName.text === "Button"
        ) {
            out.push(node);
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
    return out;
}

/**
 * The static string an expression always evaluates to, or `null`.
 *
 * `ts.isStringLiteralLike` covers `'x'`, `"x"` and a no-substitution
 * template `` `x` `` — all three are constants. A template WITH a
 * substitution is a `TemplateExpression`, a different node kind, and
 * stays unreadable.
 */
function staticString(node: ts.Expression): string | null {
    return ts.isStringLiteralLike(node) ? node.text : null;
}

function readVariant(prop: ts.JsxAttribute, sf: ts.SourceFile): VariantSource {
    const init = prop.initializer;
    if (init === undefined) {
        // `<Button variant>` — JSX shorthand for `variant={true}`.
        return {
            kind: "unreadable",
            node: null,
            display: "variant (no value — JSX shorthand for `true`)",
        };
    }
    if (ts.isStringLiteral(init)) {
        return { kind: "literal", value: init.text };
    }
    if (!ts.isJsxExpression(init) || init.expression === undefined) {
        return {
            kind: "unreadable",
            node: null,
            display: `variant=${init.getText(sf)}`,
        };
    }
    const expr = init.expression;
    const literal = staticString(expr);
    if (literal !== null) return { kind: "literal", value: literal };
    return {
        kind: "unreadable",
        node: expr,
        display: `variant={${expr.getText(sf).replace(/\s+/g, " ")}}`,
    };
}

/**
 * Read the `variant` prop off one Button open tag.
 *
 * Spread awareness. `<Button {...props} />` has no `variant` attribute,
 * but `props` may well carry one — reading that as "absent", and so as
 * the primary default, would be a silent guess. A spread that comes
 * AFTER the `variant` attribute is worse still: at runtime it overrides
 * it, so the literal we can see is not what renders. Both shapes are
 * reported as unreadable (and counted primary, like every other
 * unreadable variant), so they can never buy ceiling headroom. There are
 * zero Button spreads in `src/app` today, so this costs nothing now and
 * refuses to guess later. A spread FOLLOWED by an explicit `variant`
 * loses to that variant and stays readable.
 */
function variantOf(
    el: ts.JsxOpeningLikeElement,
    sf: ts.SourceFile,
): VariantSource {
    let found: VariantSource | null = null;
    let spreadWins = false;
    for (const prop of el.attributes.properties) {
        if (ts.isJsxSpreadAttribute(prop)) {
            found = null;
            spreadWins = true;
            continue;
        }
        if (!ts.isJsxAttribute(prop)) continue;
        if (!ts.isIdentifier(prop.name) || prop.name.text !== "variant") {
            continue;
        }
        found = readVariant(prop, sf);
        spreadWins = false;
    }
    if (found !== null) return found;
    if (spreadWins) {
        return {
            kind: "unreadable",
            node: null,
            display: "{...spread} may carry `variant`; no literal follows it",
        };
    }
    return { kind: "absent" };
}

/**
 * The set of variants one `<Button>` site can render, or `null` when the
 * expression is not statically readable.
 *
 * A ternary contributes BOTH branches. The site really does render
 * primary in one state and secondary in the other, and a ceiling on
 * loudness has to see the loud state. Taking only the first branch would
 * make `variant={x ? 'secondary' : 'primary'}` a free primary — the
 * blind spot #2379 was filed about, reintroduced through argument order.
 * Counting both keeps the ratchet's important property intact: turning a
 * `variant="secondary"` into `variant={x ? 'primary' : 'secondary'}`
 * still costs +1 primary against the ceiling.
 *
 * The condition is not inspected, so `plan?.tier === "x" ? …` and any
 * other shape of test resolve the same way — the parser has already
 * separated the `?` and `:` that belong to THIS ternary from a `??`, a
 * `?.`, or a nested one, which is the arithmetic the previous
 * hand-rolled `splitTernary` existed to do. A nested ternary leaves a
 * `ConditionalExpression` in a branch instead of a string, so it fails
 * loudly rather than being half-read.
 */
export function possibleVariants(v: VariantSource): string[] | null {
    if (v.kind === "absent") return [BUTTON_DEFAULT_VARIANT];
    if (v.kind === "literal") return [v.value];
    const node = v.node;
    if (node !== null && ts.isConditionalExpression(node)) {
        const whenTrue = staticString(node.whenTrue);
        const whenFalse = staticString(node.whenFalse);
        if (whenTrue !== null && whenFalse !== null) {
            return [whenTrue, whenFalse];
        }
    }
    return null;
}

export interface Tally {
    primary: number;
    secondary: number;
    /** `file:line` of every Button whose variant could not be read. */
    unreadable: string[];
    /** `file:line` of every scanned file the TSX parser reported on. */
    unparsable: string[];
}

export function tallyFile(rel: string, content: string, into: Tally): void {
    const sf = parseTsx(rel, content);
    const diagnostics = sf.parseDiagnostics ?? [];
    if (diagnostics.length > 0) {
        const first = diagnostics[0];
        const line =
            sf.getLineAndCharacterOfPosition(first.start ?? 0).line + 1;
        into.unparsable.push(
            `${rel}:${line}  ${ts.flattenDiagnosticMessageText(first.messageText, " ")}`,
        );
    }
    for (const el of buttonOpenElements(sf)) {
        const line =
            sf.getLineAndCharacterOfPosition(el.getStart(sf)).line + 1;
        const where = `${rel}:${line}`;
        const variant = variantOf(el, sf);
        const variants = possibleVariants(variant);
        if (variants === null) {
            into.unreadable.push(
                `${where}  ${variant.kind === "unreadable" ? variant.display : "?"}`,
            );
            // An unreadable variant counts as PRIMARY, not as nothing.
            // Skipping it would mean a contributor could lower the
            // measured total — and buy ceiling headroom — by making a
            // variant harder to read, which inverts the ratchet. The
            // assertion below names the site so the fix is obvious.
            into.primary++;
            continue;
        }
        if (variants.includes("primary")) into.primary++;
        if (variants.includes("secondary")) into.secondary++;
    }
}
