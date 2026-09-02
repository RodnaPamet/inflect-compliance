/**
 * How far does an assertion actually reach?
 *
 * WHY THIS EXISTS
 * ───────────────
 * Issue #2246 records a family of defects with one sentence in common:
 * **an assertion whose reach is not the thing it names.** Two members of
 * that family are mechanically detectable from the test source alone, and
 * this module is the analyser both detectors stand on.
 *
 *   **Class C — a regex span that crosses out of the block it is about.**
 *   `[\s\S]*` (greedy) or `[\s\S]*?` (lazy) between two identifiers inside a
 *   `toMatch`. The span re-forms across a SIBLING block, so deleting the
 *   thing under test leaves the assertion satisfied by a neighbour. Proved
 *   twice, on files a fix commit had just edited:
 *     · `audit-s1-residual-and-mitigated.test.ts:115` — deleting
 *       `ownerUserId:` / `reason:` from the transfer's own `after:` block
 *       left it 12/12 GREEN; the greedy span re-formed across seven other
 *       `after: {` blocks in the same file.
 *     · `risk-quantitative-analytics.test.ts:94` — removing the legacy
 *       SLE×ARO fallback the test is entirely named for left it 16/16
 *       GREEN; the lazy span reached an object literal six lines below.
 *
 *   **Class D — a needle that occurs more than once in what is read.**
 *   An assertion reads a whole file (often the concatenated Prisma schema)
 *   and matches a string that appears in several places, so the named thing
 *   can be deleted and a survivor satisfies the guard. Worst inside a
 *   `describe.each`, where one survivor satisfies N per-entity assertions.
 *   Proved three times, incl. `.toContain('model VendorEvidenceBundle')`
 *   satisfied by `model VendorEvidenceBundleItem {` eighteen lines below —
 *   a `.toContain`, one matcher away from where the first detector looked.
 *
 * ── AST, NOT GREP, AND THAT IS THE POINT ────────────────────────────────
 *
 * The issue's own numbers came from a line-scoped grep, and a line-scoped
 * grep is exactly the enumeration failure it complains about: it counts
 * `toMatch` and `[\s\S]*` only when prettier happened to leave them on one
 * line. Measured on the same tree and over the same two directories, that
 * grep says 86 and this analyser says 126 — the 40 it cannot see are
 * assertions whose regex sits on a continuation line, hides behind a
 * `const PATTERN = /…/`, or is built with `new RegExp`. Every population here
 * is therefore taken from `ts.createSourceFile`.
 *
 * ── THE DENOMINATOR IS PART OF THE RESULT ───────────────────────────────
 *
 * A detector that silently drops what it cannot parse has its own
 * parseability as its denominator, and then reports full coverage of the
 * subset it happens to understand. That is the same defect one level up.
 * So every function here returns SKIPS ALONGSIDE FINDINGS, each skip
 * carrying a machine-readable reason, and both consumers ratchet the skip
 * count as well as the finding count.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as ts from 'typescript';

import { REPO_ROOT, repoFiles, repoRelative } from './repo-files';

// ───────────────────────────── parsing ──────────────────────────────────

/**
 * Parse one file. Syntax only — no program, no type checker.
 *
 * DELIBERATELY UNCACHED, and the results below deliberately hold no
 * `ts.Node`. `setParentNodes` is required (scope resolution walks `.parent`),
 * which makes each AST several times the size of its source, and retaining
 * 2,195 of them measured at ~780 MB over the baseline — inside a runner
 * configured to recycle a worker at 512 MB. Parsing one file at a time and
 * keeping only plain data out of it puts the peak back in line with the other
 * source-scanning guardrails.
 */
export function parseTestFile(abs: string): ts.SourceFile {
    return ts.createSourceFile(
        abs,
        fs.readFileSync(abs, 'utf8'),
        ts.ScriptTarget.Latest,
        /* setParentNodes */ true,
        abs.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
}

/**
 * Every test file git knows about under `dirs`, as absolute paths.
 *
 * Population comes from git (`repoFiles`), never a directory walk — see
 * `tests/helpers/repo-files.ts`. A walk from the repo root reads
 * `.claude/worktrees/<id>/`'s full copy of the repo and reports it, which is
 * green on CI and red only for whoever uses worktrees.
 */
export function testFilesUnder(dirs: readonly string[]): string[] {
    const out: string[] = [];
    for (const dir of dirs) {
        out.push(...repoFiles({ under: dir, extensions: ['.ts', '.tsx'] }));
    }
    return out.sort();
}

// ─────────────────────────── assertion sites ────────────────────────────

export type Matcher = 'toMatch' | 'toContain';

/**
 * The plain-data identity of an assertion site.
 *
 * What every RESULT below carries, in place of the `ExpectSite` it came from.
 * An `ExpectSite` holds `ts.Node`s, and a node keeps its whole SourceFile
 * alive — so storing one per finding would retain the ASTs of every file that
 * has a finding, which is most of the reason the parse cache had to go.
 */
export interface SiteRef {
    readonly file: string;
    readonly line: number;
    readonly matcher: Matcher;
    readonly negated: boolean;
}

export interface ExpectSite {
    /** Repo-relative path of the test file. */
    readonly file: string;
    /** 1-based line of the `expect(...)` call. */
    readonly line: number;
    readonly matcher: Matcher;
    /** True when the chain carries `.not` (`expect(x).not.toMatch(...)`). */
    readonly negated: boolean;
    /** The expression inside `expect(...)`. */
    readonly subject: ts.Expression;
    readonly subjectText: string;
    /** First argument of the matcher, if any. */
    readonly arg: ts.Expression | undefined;
    readonly argText: string;
    readonly sourceFile: ts.SourceFile;
}

/**
 * Every `expect(<subject>)[.not[.resolves…]].toMatch|toContain(<arg>)` in one
 * file.
 *
 * Anchored on the `expect(` call at the root of the property chain rather
 * than on the matcher name alone, so an unrelated `foo.toContain(...)`
 * helper is not counted.
 */
export function collectExpectSites(sf: ts.SourceFile): ExpectSite[] {
    const rel = repoRelative(sf.fileName);
    const sites: ExpectSite[] = [];

    const visit = (node: ts.Node): void => {
        if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            (node.expression.name.text === 'toMatch' ||
                node.expression.name.text === 'toContain')
        ) {
            const matcher = node.expression.name.text as Matcher;
            let cursor: ts.Expression = node.expression.expression;
            const chain: string[] = [];
            while (ts.isPropertyAccessExpression(cursor)) {
                chain.push(cursor.name.text);
                cursor = cursor.expression;
            }
            if (
                ts.isCallExpression(cursor) &&
                ts.isIdentifier(cursor.expression) &&
                cursor.expression.text === 'expect' &&
                cursor.arguments.length > 0
            ) {
                const subject = cursor.arguments[0];
                const arg = node.arguments.length > 0 ? node.arguments[0] : undefined;
                sites.push({
                    file: rel,
                    line:
                        sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
                    matcher,
                    negated: chain.includes('not'),
                    subject,
                    subjectText: subject.getText(sf),
                    arg,
                    argText: arg === undefined ? '' : arg.getText(sf),
                    sourceFile: sf,
                });
            }
        }
        ts.forEachChild(node, visit);
    };

    visit(sf);
    return sites;
}

/** Strip an `ExpectSite` down to the data a result may retain. */
export function siteRef(site: ExpectSite): SiteRef {
    return {
        file: site.file,
        line: site.line,
        matcher: site.matcher,
        negated: site.negated,
    };
}

// ──────────────────────── regex pattern recovery ────────────────────────

export interface RecoveredPattern {
    /** The regex body, with any `${…}` interpolation replaced by ``. */
    readonly pattern: string;
    /** Regex flags, `''` when unknown. */
    readonly flags: string;
    /**
     * True when the pattern text is exact — a bare regex literal. False when
     * interpolation was substituted out, i.e. span POSITIONS are right but
     * the surrounding text is approximate.
     */
    readonly exact: boolean;
}

/**
 * Placeholder standing in for a `${…}` chunk of a `new RegExp(`…`)`.
 * U+0001 is not a regex metacharacter and cannot occur in real source text,
 * so substituting it neither creates a span nor hides one.
 */
const INTERPOLATION = '\u0001';

/** Why a `toMatch` argument could not be turned into a pattern. */
export type PatternSkipReason =
    | 'no-argument'
    | 'string-literal-argument'
    | 'identifier-unresolved'
    | 'computed-regexp-argument'
    | 'expression-argument';

export type PatternResult =
    | { readonly kind: 'pattern'; readonly value: RecoveredPattern }
    | { readonly kind: 'skipped'; readonly reason: PatternSkipReason };

function splitRegexLiteral(text: string): RecoveredPattern {
    const lastSlash = text.lastIndexOf('/');
    return {
        pattern: text.slice(1, lastSlash),
        flags: text.slice(lastSlash + 1),
        exact: true,
    };
}

/** Literal chunks of a template/string, `${…}` collapsed to a placeholder. */
function templateText(node: ts.Node): string | null {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        return node.text;
    }
    if (ts.isTemplateExpression(node)) {
        let out = node.head.text;
        for (const span of node.templateSpans) {
            out += INTERPOLATION + span.literal.text;
        }
        return out;
    }
    return null;
}

/**
 * Resolve `name` to the initializer of the NEAREST ENCLOSING `const`, walking
 * outward from `from`.
 *
 * Lexical scope, not a flat file index, and the difference is not academic.
 * The dominant idiom in this suite is a per-test binding:
 *
 *     it('…is tenant-scoped', () => {
 *         const schema = read('prisma/schema/auth.prisma');
 *         expect(schema).toMatch(/@@index\(\[tenantId\]\)/);
 *     });
 *
 * with `const schema = read(…)` written again in the next `it`. A flat index
 * sees the name twice, calls it ambiguous, and drops the site — and the site
 * it drops is `entra-ei2-group-mapping.test.ts:18`, one of the three
 * instances #2246 proved by hand. A detector that cannot see its own worked
 * example is measuring its parser, not the tree.
 *
 * Returns `undefined` for "no such binding", `null` for "bound but not
 * usable" (declared twice in ONE scope, shadowed by a parameter, or a loop
 * variable), and the initializer otherwise. The two are deliberately
 * distinct: `undefined` is the ordinary case and the caller reports it as
 * "this subject is not a file read", while `null` means the analyser gave up
 * on something it might have read and is reported as a SKIP. Conflating them
 * would bury blind spots inside the ordinary case, which is the shape of
 * defect this whole module exists to detect.
 */
function resolveBinding(
    name: string,
    from: ts.Node,
): ts.Expression | null | undefined {
    let node: ts.Node | undefined = from;
    while (node !== undefined) {
        if (ts.isFunctionLike(node)) {
            for (const param of node.parameters) {
                if (bindsName(param.name, name)) return null;
            }
        }
        if (
            ts.isForOfStatement(node) ||
            ts.isForInStatement(node) ||
            ts.isForStatement(node)
        ) {
            const init = node.initializer;
            if (init !== undefined && ts.isVariableDeclarationList(init)) {
                for (const d of init.declarations) {
                    if (ts.isIdentifier(d.name) && d.name.text === name) return null;
                }
            }
        }

        const statements = statementsOf(node);
        if (statements !== undefined) {
            const found: ts.VariableDeclaration[] = [];
            for (const st of statements) {
                if (!ts.isVariableStatement(st)) continue;
                for (const d of st.declarationList.declarations) {
                    if (ts.isIdentifier(d.name) && d.name.text === name) found.push(d);
                }
            }
            if (found.length > 1) return null;
            if (found.length === 1) return found[0].initializer ?? null;
        }

        node = node.parent;
    }
    return undefined;
}

/** Does a (possibly destructured) binding name introduce `name`? */
function bindsName(binding: ts.BindingName, name: string): boolean {
    if (ts.isIdentifier(binding)) return binding.text === name;
    for (const el of binding.elements) {
        if (ts.isOmittedExpression(el)) continue;
        if (bindsName(el.name, name)) return true;
    }
    return false;
}

function statementsOf(node: ts.Node): ts.NodeArray<ts.Statement> | undefined {
    if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)) {
        return node.statements;
    }
    if (ts.isCaseClause(node) || ts.isDefaultClause(node)) return node.statements;
    return undefined;
}

/**
 * Recover the regex a `toMatch` argument will actually run.
 *
 * Four shapes are understood, and everything else is reported as a skip:
 *   1. `/literal/flags`
 *   2. `IDENT` resolving to a unique `const IDENT = /literal/` in the file
 *   3. `new RegExp('…')` / `new RegExp(\`…\`)` — literal source
 *   4. `new RegExp(\`…${x}…\`)` — literal chunks kept, `${x}` collapsed to a
 *      placeholder, so a span written INSIDE the template is still seen
 *      (`exact: false`).
 */
export function recoverPattern(site: ExpectSite): PatternResult {
    const arg = site.arg;
    if (arg === undefined) return { kind: 'skipped', reason: 'no-argument' };

    if (arg.kind === ts.SyntaxKind.RegularExpressionLiteral) {
        return { kind: 'pattern', value: splitRegexLiteral(arg.getText(site.sourceFile)) };
    }

    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
        // `toMatch('literal')` is a SUBSTRING assertion, not a regex — it
        // cannot carry a span, so it is out of Class C's population rather
        // than an analysis failure. Class D still reads it.
        return { kind: 'skipped', reason: 'string-literal-argument' };
    }

    if (ts.isIdentifier(arg)) {
        const init = resolveBinding(arg.text, arg);
        if (init != null && init.kind === ts.SyntaxKind.RegularExpressionLiteral) {
            return {
                kind: 'pattern',
                value: splitRegexLiteral(init.getText(site.sourceFile)),
            };
        }
        return { kind: 'skipped', reason: 'identifier-unresolved' };
    }

    if (
        ts.isNewExpression(arg) &&
        ts.isIdentifier(arg.expression) &&
        arg.expression.text === 'RegExp' &&
        arg.arguments !== undefined &&
        arg.arguments.length > 0
    ) {
        const body = templateText(arg.arguments[0]);
        if (body !== null) {
            const flagsNode = arg.arguments[1];
            const flags =
                flagsNode !== undefined && ts.isStringLiteral(flagsNode)
                    ? flagsNode.text
                    : '';
            return {
                kind: 'pattern',
                value: { pattern: body, flags, exact: !body.includes(INTERPOLATION) },
            };
        }
        return { kind: 'skipped', reason: 'computed-regexp-argument' };
    }

    return { kind: 'skipped', reason: 'expression-argument' };
}

// ───────────────────────── Class C — span analysis ──────────────────────

/**
 * An "any character" class. All three spellings appear in this repo's
 * guards; `[^]` is the same construct without the double negation.
 */
const ANY_CHAR_CLASS = /\[\\s\\S\]|\[\\S\\s\]|\[\^\]/g;

/** Quantifiers with no upper bound. Everything else is a bounded span. */
const UNBOUNDED_QUANTIFIER = /^(?:\*\?|\+\?|\*|\+|\{\d+,\}\??)$/;

export interface Span {
    /** Offset of the character class within the pattern. */
    readonly start: number;
    /** Offset just past the quantifier. */
    readonly end: number;
    /** `''`, `'*'`, `'*?'`, `'{0,200}'`, … */
    readonly quantifier: string;
    readonly unbounded: boolean;
    /** Pattern text exists both before and after the span. */
    readonly interior: boolean;
}

/**
 * Locate every any-char span in a regex body and say, for each, whether it is
 * unbounded and whether it sits BETWEEN two pieces of pattern.
 *
 * Interiority is what makes a span Class C. A span at the very END of a
 * pattern reaches past nothing — such an assertion says only "foo appears".
 * An INTERIOR span, with pattern text on both sides, claims a relationship
 * between the two sides that it does not enforce: any left-hand match and
 * any later right-hand match, in any two blocks, satisfy it. `^` and `$` are
 * stripped before the emptiness test, so an anchored pattern still reads as
 * interior.
 */
export function analyseSpans(pattern: string): Span[] {
    const spans: Span[] = [];
    const re = new RegExp(ANY_CHAR_CLASS.source, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(pattern)) !== null) {
        const afterClass = m.index + m[0].length;
        const quantMatch = pattern
            .slice(afterClass)
            .match(/^(?:\*\?|\+\?|\*|\+|\?|\{\d+(?:,\d*)?\}\??)/);
        const quantifier = quantMatch === null ? '' : quantMatch[0];
        const end = afterClass + quantifier.length;
        const before = pattern.slice(0, m.index).replace(/[\^]/g, '').trim();
        const after = pattern.slice(end).replace(/\$/g, '').trim();
        spans.push({
            start: m.index,
            end,
            quantifier,
            unbounded: UNBOUNDED_QUANTIFIER.test(quantifier),
            interior: before.length > 0 && after.length > 0,
        });
    }
    return spans;
}

export interface ClassCSite {
    readonly site: SiteRef;
    readonly pattern: RecoveredPattern;
    readonly spans: readonly Span[];
    /** At least one span is unbounded AND interior — the Class C shape. */
    readonly unboundedInterior: boolean;
    /** At least one interior span of any kind (bounded counts). */
    readonly anyInterior: boolean;
}

export interface ClassCReport {
    /** Files examined. */
    readonly filesExamined: number;
    /** Every `expect(x).toMatch(…)` site seen. */
    readonly toMatchSites: number;
    /** …of which the pattern was recovered. */
    readonly analysed: number;
    /** …of which it was not, by reason. */
    readonly skipped: Readonly<Record<PatternSkipReason, number>>;
    readonly skippedTotal: number;
    /** Analysed sites carrying an interior span of any kind. */
    readonly interiorSpanSites: readonly ClassCSite[];
    /** The subset whose interior span is unbounded — the class proper. */
    readonly unboundedSpanSites: readonly ClassCSite[];
}

const EMPTY_SKIPS: Record<PatternSkipReason, number> = {
    'no-argument': 0,
    'string-literal-argument': 0,
    'identifier-unresolved': 0,
    'computed-regexp-argument': 0,
    'expression-argument': 0,
};

/** Run the Class C analysis over a set of absolute test-file paths. */
export function analyseClassC(absFiles: readonly string[]): ClassCReport {
    const skipped: Record<PatternSkipReason, number> = { ...EMPTY_SKIPS };
    const interior: ClassCSite[] = [];
    const unbounded: ClassCSite[] = [];
    let toMatchSites = 0;
    let analysed = 0;

    for (const abs of absFiles) {
        const sf = parseTestFile(abs);
        for (const site of collectExpectSites(sf)) {
            if (site.matcher !== 'toMatch') continue;
            toMatchSites++;
            const recovered = recoverPattern(site);
            if (recovered.kind === 'skipped') {
                skipped[recovered.reason]++;
                continue;
            }
            analysed++;
            const spans = analyseSpans(recovered.value.pattern);
            const anyInterior = spans.some((s) => s.interior);
            if (!anyInterior) continue;
            const unboundedInterior = spans.some((s) => s.interior && s.unbounded);
            const entry: ClassCSite = {
                site: siteRef(site),
                pattern: recovered.value,
                spans,
                unboundedInterior,
                anyInterior,
            };
            interior.push(entry);
            if (unboundedInterior) unbounded.push(entry);
        }
    }

    const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0);
    return {
        filesExamined: absFiles.length,
        toMatchSites,
        analysed,
        skipped,
        skippedTotal,
        interiorSpanSites: interior,
        unboundedSpanSites: unbounded,
    };
}

// ──────────────── Class D — what does the subject read? ─────────────────

/** Constant-fold an expression to a string, given known string constants. */
function foldString(
    node: ts.Expression,
    scope: ReadonlyMap<string, string>,
    dirOfFile: string,
): string | null {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        return node.text;
    }
    if (ts.isIdentifier(node)) {
        if (node.text === '__dirname') return dirOfFile;
        return scope.get(node.text) ?? null;
    }
    if (ts.isParenthesizedExpression(node)) {
        return foldString(node.expression, scope, dirOfFile);
    }
    if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'path'
    ) {
        const fn = node.expression.name.text;
        if (fn !== 'join' && fn !== 'resolve') return null;
        const parts: string[] = [];
        for (const a of node.arguments) {
            const folded = foldString(a, scope, dirOfFile);
            if (folded === null) return null;
            parts.push(folded);
        }
        return fn === 'join' ? path.join(...parts) : path.resolve(...parts);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const l = foldString(node.left, scope, dirOfFile);
        const r = foldString(node.right, scope, dirOfFile);
        return l === null || r === null ? null : l + r;
    }
    return null;
}

/** A local `const read = (p) => fs.readFileSync(<pathExpr>, …)` shape. */
interface ReaderFn {
    readonly paramName: string | null;
    readonly pathExpr: ts.Expression;
}

function unwrapReadFileSync(expr: ts.Expression): ts.Expression | null {
    let cur: ts.Expression = expr;
    // Peel `.toString()` / `.trim()` — neither changes which file is read.
    while (
        ts.isCallExpression(cur) &&
        ts.isPropertyAccessExpression(cur.expression) &&
        (cur.expression.name.text === 'toString' || cur.expression.name.text === 'trim')
    ) {
        cur = cur.expression.expression;
    }
    if (!ts.isCallExpression(cur)) return null;
    const callee = cur.expression;
    const isReadFileSync =
        (ts.isIdentifier(callee) && callee.text === 'readFileSync') ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === 'readFileSync');
    if (!isReadFileSync || cur.arguments.length === 0) return null;
    return cur.arguments[0];
}

/** Index the file-reading helper arrows/functions declared in a test file. */
function indexReaderFns(sf: ts.SourceFile): Map<string, ReaderFn | null> {
    const out = new Map<string, ReaderFn | null>();
    const record = (name: string, fn: ReaderFn | null): void => {
        out.set(name, out.has(name) ? null : fn);
    };
    const bodyExpr = (
        node: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
    ): ts.Expression | null => {
        if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) return node.body;
        const block = node.body;
        if (block === undefined || !ts.isBlock(block)) return null;
        const ret = block.statements.find(ts.isReturnStatement);
        return ret?.expression ?? null;
    };
    const consider = (
        name: string,
        node: ts.ArrowFunction | ts.FunctionDeclaration | ts.FunctionExpression,
    ): void => {
        const body = bodyExpr(node);
        if (body === null) return;
        const pathExpr = unwrapReadFileSync(body);
        if (pathExpr === null) return;
        const param = node.parameters[0];
        record(
            name,
            {
                paramName:
                    param !== undefined && ts.isIdentifier(param.name)
                        ? param.name.text
                        : null,
                pathExpr,
            },
        );
    };
    const visit = (node: ts.Node): void => {
        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.initializer !== undefined &&
            (ts.isArrowFunction(node.initializer) ||
                ts.isFunctionExpression(node.initializer))
        ) {
            consider(node.name.text, node.initializer);
        }
        if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
            consider(node.name.text, node);
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
}

/** Why an assertion's subject could not be resolved to file content. */
export type SubjectSkipReason =
    | 'not-a-file-read'
    | 'binding-not-resolvable'
    | 'path-not-constant'
    | 'file-not-found'
    | 'content-transformed';

export type SubjectResult =
    | { readonly kind: 'content'; readonly label: string; readonly text: string }
    | { readonly kind: 'skipped'; readonly reason: SubjectSkipReason };

/** Concatenated `prisma/schema/*.prisma`, exactly as `readPrismaSchema()`. */
let cachedPrismaSchema: string | null = null;
function prismaSchemaText(): string {
    if (cachedPrismaSchema !== null) return cachedPrismaSchema;
    const dir = path.join(REPO_ROOT, 'prisma/schema');
    cachedPrismaSchema = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.prisma'))
        .sort()
        .map((f) => fs.readFileSync(path.join(dir, f), 'utf-8'))
        .join('\n');
    return cachedPrismaSchema;
}

const fileTextCache = new Map<string, string | null>();
function readIfPresent(abs: string): string | null {
    const hit = fileTextCache.get(abs);
    if (hit !== undefined) return hit;
    let text: string | null = null;
    try {
        if (fs.statSync(abs).isFile()) text = fs.readFileSync(abs, 'utf8');
    } catch {
        text = null;
    }
    fileTextCache.set(abs, text);
    return text;
}

interface FileScope {
    readonly constants: ReadonlyMap<string, string>;
    readonly readers: ReadonlyMap<string, ReaderFn | null>;
    readonly dir: string;
}

const scopeCache = new WeakMap<ts.SourceFile, FileScope>();

/**
 * Every `const <name> = <string-valued expression>` in the file, folded.
 *
 * Flat rather than lexical, unlike `resolveBinding` above, and deliberately:
 * these are the path anchors (`ROOT`, `SCHEMA_DIR`, `MIGRATIONS`) that this
 * suite declares once at module scope. A name that folds to two different
 * strings would be a hazard, so the FIRST fold wins and a later redeclaration
 * cannot silently move a path.
 */
function foldFileConstants(sf: ts.SourceFile, dir: string): Map<string, string> {
    const declarations: Array<[string, ts.Expression]> = [];
    const visit = (node: ts.Node): void => {
        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.initializer !== undefined
        ) {
            declarations.push([node.name.text, node.initializer]);
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);

    const constants = new Map<string, string>();
    // Two passes so `const SCHEMA_DIR = path.join(ROOT, 'prisma/schema')`
    // resolves even when it is written above `ROOT`.
    for (let pass = 0; pass < 2; pass++) {
        for (const [name, init] of declarations) {
            if (constants.has(name)) continue;
            const folded = foldString(init, constants, dir);
            if (folded !== null) constants.set(name, folded);
        }
    }
    return constants;
}

function scopeOf(sf: ts.SourceFile): FileScope {
    const hit = scopeCache.get(sf);
    if (hit !== undefined) return hit;
    const dir = path.dirname(sf.fileName);
    const scope: FileScope = {
        constants: foldFileConstants(sf, dir),
        readers: indexReaderFns(sf),
        dir,
    };
    scopeCache.set(sf, scope);
    return scope;
}

/**
 * Resolve `expect(<subject>)`'s subject to the text of a whole file.
 *
 * Understood shapes, all of them the idioms actually used in this repo:
 *   · `readPrismaSchema()` — the concatenated schema folder
 *   · `fs.readFileSync(path.join(ROOT, 'x'), 'utf8')`, inline or via a
 *     `const src = …` binding
 *   · `read('x')` where `read` is a local arrow wrapping `readFileSync`
 *   · `codeOf(<any of the above>)` — comments blanked, offsets preserved,
 *     which is what the assertion actually runs against
 *
 * A subject that is not a file read at all is skipped as `not-a-file-read`
 * and is NOT a coverage failure — most `expect(...).toContain(...)` in the
 * suite asserts on a runtime value. The skips that matter are
 * `path-not-constant` (a computed path) and `content-transformed`.
 */
export function resolveSubject(
    subject: ts.Expression,
    sf: ts.SourceFile,
    depth = 0,
): SubjectResult {
    if (depth > 4) return { kind: 'skipped', reason: 'not-a-file-read' };
    const scope = scopeOf(sf);

    if (ts.isParenthesizedExpression(subject)) {
        return resolveSubject(subject.expression, sf, depth + 1);
    }

    if (ts.isIdentifier(subject)) {
        const init = resolveBinding(subject.text, subject);
        if (init === undefined) return { kind: 'skipped', reason: 'not-a-file-read' };
        if (init === null) return { kind: 'skipped', reason: 'binding-not-resolvable' };
        return resolveSubject(init, sf, depth + 1);
    }

    if (ts.isCallExpression(subject)) {
        const callee = subject.expression;

        // `readPrismaSchema()`
        if (ts.isIdentifier(callee) && callee.text === 'readPrismaSchema') {
            return {
                kind: 'content',
                label: 'prisma/schema/*.prisma (concatenated)',
                text: prismaSchemaText(),
            };
        }

        // `codeOf(x)` / `stripComments(x)` — a transform that preserves
        // offsets, so it is still "the whole file" for occurrence counting.
        if (ts.isIdentifier(callee) && callee.text === 'codeOf') {
            if (subject.arguments.length === 0) {
                return { kind: 'skipped', reason: 'not-a-file-read' };
            }
            const inner = resolveSubject(subject.arguments[0], sf, depth + 1);
            if (inner.kind !== 'content') return inner;
            return { kind: 'content', label: inner.label, text: maskComments(inner.text) };
        }

        // A direct `fs.readFileSync(...)`.
        const direct = unwrapReadFileSync(subject);
        if (direct !== null) {
            const p = foldString(direct, scope.constants, scope.dir);
            if (p === null) return { kind: 'skipped', reason: 'path-not-constant' };
            return contentAt(p);
        }

        // A local reader helper: `read('prisma/schema/auth.prisma')`.
        if (ts.isIdentifier(callee)) {
            const reader = scope.readers.get(callee.text);
            if (reader === null) return { kind: 'skipped', reason: 'path-not-constant' };
            if (reader !== undefined) {
                const inner = new Map(scope.constants);
                if (reader.paramName !== null) {
                    if (subject.arguments.length === 0) {
                        return { kind: 'skipped', reason: 'path-not-constant' };
                    }
                    const argVal = foldString(
                        subject.arguments[0],
                        scope.constants,
                        scope.dir,
                    );
                    if (argVal === null) {
                        return { kind: 'skipped', reason: 'path-not-constant' };
                    }
                    inner.set(reader.paramName, argVal);
                }
                const p = foldString(reader.pathExpr, inner, scope.dir);
                if (p === null) return { kind: 'skipped', reason: 'path-not-constant' };
                return contentAt(p);
            }
        }

        return { kind: 'skipped', reason: 'not-a-file-read' };
    }

    // `read('x').replace(...)` and friends change the text, so an occurrence
    // count taken from disk would be answering about different content.
    if (ts.isPropertyAccessExpression(subject) || ts.isElementAccessExpression(subject)) {
        return { kind: 'skipped', reason: 'not-a-file-read' };
    }

    return { kind: 'skipped', reason: 'not-a-file-read' };
}

function contentAt(p: string): SubjectResult {
    const abs = path.isAbsolute(p) ? p : path.join(REPO_ROOT, p);
    const text = readIfPresent(abs);
    if (text === null) return { kind: 'skipped', reason: 'file-not-found' };
    return { kind: 'content', label: repoRelative(abs), text };
}

/** Blank `//` and block comments, preserving offsets — mirrors `codeOf`. */
function maskComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

// ─────────────────── Class D — needle occurrence count ──────────────────

export type NeedleSkipReason =
    | 'no-argument'
    | 'needle-interpolated'
    | 'needle-not-literal'
    | 'needle-carries-span'
    | 'needle-empty';

export type NeedleResult =
    | {
          readonly kind: 'needle';
          readonly display: string;
          readonly count: (text: string) => number;
      }
    | { readonly kind: 'skipped'; readonly reason: NeedleSkipReason };

function countSubstring(text: string, needle: string): number {
    let n = 0;
    let i = text.indexOf(needle);
    while (i !== -1) {
        n++;
        i = text.indexOf(needle, i + needle.length);
    }
    return n;
}

/**
 * Turn a matcher argument into "how many places in this text satisfy it".
 *
 * A regex needle is counted by running the regex globally — which is the
 * right generalisation, not a restriction to metacharacter-free strings:
 * `/@@index\(\[tenantId\]\)/` has metacharacters and still has fifteen
 * distinct satisfying sites in `auth.prisma`, which is precisely the finding.
 *
 * Regexes carrying an unbounded any-char span are NOT counted here. A greedy
 * span collapses every candidate into one match, so the number would be
 * meaningless — and those sites are already Class C's population.
 */
export function recoverNeedle(site: ExpectSite): NeedleResult {
    const arg = site.arg;
    if (arg === undefined) return { kind: 'skipped', reason: 'no-argument' };

    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
        if (arg.text.length === 0) return { kind: 'skipped', reason: 'needle-empty' };
        const needle = arg.text;
        return {
            kind: 'needle',
            display: JSON.stringify(needle),
            count: (text) => countSubstring(text, needle),
        };
    }

    if (ts.isTemplateExpression(arg)) {
        return { kind: 'skipped', reason: 'needle-interpolated' };
    }

    if (site.matcher === 'toMatch' && arg.kind === ts.SyntaxKind.RegularExpressionLiteral) {
        const { pattern, flags } = splitRegexLiteral(arg.getText(site.sourceFile));
        if (pattern.length === 0) return { kind: 'skipped', reason: 'needle-empty' };
        if (analyseSpans(pattern).some((s) => s.unbounded)) {
            return { kind: 'skipped', reason: 'needle-carries-span' };
        }
        let re: RegExp;
        try {
            re = new RegExp(pattern, flags.replace(/[gy]/g, '') + 'g');
        } catch {
            return { kind: 'skipped', reason: 'needle-not-literal' };
        }
        return {
            kind: 'needle',
            display: `/${pattern}/`,
            count: (text) => {
                let n = 0;
                re.lastIndex = 0;
                let m: RegExpExecArray | null;
                while ((m = re.exec(text)) !== null) {
                    n++;
                    if (m[0].length === 0) re.lastIndex++;
                    if (n > 5000) break;
                }
                return n;
            },
        };
    }

    return { kind: 'skipped', reason: 'needle-not-literal' };
}

export interface ClassDSite {
    readonly site: SiteRef;
    readonly readLabel: string;
    readonly needle: string;
    readonly occurrences: number;
}

export interface ClassDReport {
    readonly filesExamined: number;
    /** Every `expect(x).toMatch|toContain(…)` site seen. */
    readonly sites: number;
    /** …whose subject resolved to the text of a whole file. */
    readonly wholeFileReads: number;
    /** …of those, sites whose needle was recoverable. */
    readonly analysed: number;
    /** Subjects that ARE file reads but could not be resolved. */
    readonly subjectSkips: Readonly<Record<SubjectSkipReason, number>>;
    /** Whole-file reads whose needle was not recoverable. */
    readonly needleSkips: Readonly<Record<NeedleSkipReason, number>>;
    readonly skippedTotal: number;
    /** Analysed sites whose needle matches more than once. */
    readonly ambiguous: readonly ClassDSite[];
}

const EMPTY_SUBJECT_SKIPS: Record<SubjectSkipReason, number> = {
    'not-a-file-read': 0,
    'binding-not-resolvable': 0,
    'path-not-constant': 0,
    'file-not-found': 0,
    'content-transformed': 0,
};

const EMPTY_NEEDLE_SKIPS: Record<NeedleSkipReason, number> = {
    'no-argument': 0,
    'needle-interpolated': 0,
    'needle-not-literal': 0,
    'needle-carries-span': 0,
    'needle-empty': 0,
};

/** Run the Class D analysis over a set of absolute test-file paths. */
export function analyseClassD(absFiles: readonly string[]): ClassDReport {
    const subjectSkips: Record<SubjectSkipReason, number> = { ...EMPTY_SUBJECT_SKIPS };
    const needleSkips: Record<NeedleSkipReason, number> = { ...EMPTY_NEEDLE_SKIPS };
    const ambiguous: ClassDSite[] = [];
    let sites = 0;
    let wholeFileReads = 0;
    let analysed = 0;

    for (const abs of absFiles) {
        const sf = parseTestFile(abs);
        for (const site of collectExpectSites(sf)) {
            sites++;
            const subject = resolveSubject(site.subject, sf);
            if (subject.kind === 'skipped') {
                subjectSkips[subject.reason]++;
                continue;
            }
            wholeFileReads++;
            const needle = recoverNeedle(site);
            if (needle.kind === 'skipped') {
                needleSkips[needle.reason]++;
                continue;
            }
            analysed++;
            const occurrences = needle.count(subject.text);
            if (occurrences > 1) {
                ambiguous.push({
                    site: siteRef(site),
                    readLabel: subject.label,
                    needle: needle.display,
                    occurrences,
                });
            }
        }
    }

    // `not-a-file-read` is the ordinary case (asserting on a runtime value),
    // not an analysis failure — it is excluded from the skipped total the
    // ratchet tracks, and reported separately.
    const skippedTotal =
        subjectSkips['binding-not-resolvable'] +
        subjectSkips['path-not-constant'] +
        subjectSkips['file-not-found'] +
        subjectSkips['content-transformed'] +
        Object.values(needleSkips).reduce((a, b) => a + b, 0);

    return {
        filesExamined: absFiles.length,
        sites,
        wholeFileReads,
        analysed,
        subjectSkips,
        needleSkips,
        skippedTotal,
        ambiguous,
    };
}
