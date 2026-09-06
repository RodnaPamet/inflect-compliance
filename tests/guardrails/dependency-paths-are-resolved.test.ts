/**
 * A dependency's location is RESOLVED, never spelled.
 *
 * ═══ THE DEFECT ═══
 *
 * A test wanted to know whether a package was installed, and asked like this:
 *
 *     const cmdkPkg = path.resolve(__dirname, '../../node_modules/cmdk/package.json');
 *     expect(fs.existsSync(cmdkPkg)).toBe(true);
 *
 * `path.resolve` is a literal string join. It does no upward walk. So that
 * expression does not mean "where cmdk is" — it means "where cmdk would be if
 * this checkout owned its install", and those are different places.
 *
 * This repo is routinely checked out into `.claude/worktrees/<id>/`, which has
 * NO `node_modules` of its own; Node resolves upward to the primary clone at
 * require time. CI has a single checkout, so the assumption holds there and
 * only there. That is the worst place for a failure to live — green on CI, red
 * only for whoever uses a worktree, which is nobody who can see it.
 *
 * ═══ WHY A RATCHET AND NOT THREE FIXES ═══
 *
 * Three instances were found in one sweep, and they failed in three different
 * ways — which is the argument for catching the shape rather than the symptom:
 *
 *   • `tests/unit/filter-foundation.test.ts` — a plain red assertion.
 *   • `tests/integration/framework-import-cli.test.ts` — spawned
 *     `<root>/node_modules/.bin/tsx`, got ENOENT, and reported it as
 *     `exit code: expected 3, received null` across all 8 tests. The symptom
 *     named the CLI's exit codes and never mentioned a missing binary.
 *   • `tests/guardrails/prisma-major-pin.test.ts` — worst of the three,
 *     because it went GREEN. An `if (!fs.existsSync(p)) return;` meant to skip
 *     a fresh clone turned the wrong path into a silent skip, so the only
 *     assertion in that file reading the INSTALLED tree stopped running while
 *     reporting a pass. Measured: with the pin mutated to a wrong major, the
 *     original file was 5/5 green from a worktree.
 *
 * A fourth was already fixed once at
 * `tests/guardrails/next-image-optimizer-disabled.test.ts`, and its sibling
 * `tests/guardrails/vendored-swagger-ui-matches-dependency.test.ts` had to
 * write the rationale down a second time. Two independent rediscoveries is the
 * tell that prose was not going to hold this.
 *
 * ═══ THE RULE ═══
 *
 * Do not BUILD a filesystem path into an installed package. Ask Node:
 *
 *     require.resolve('cmdk')                             // is it installed?
 *     path.dirname(require.resolve('pkg/package.json'))   // where is it?
 *
 * Resolving is also a better test of the property people are usually after.
 * "Installed" means Node can resolve the specifier the app imports — which is
 * what the app does at runtime — not that a directory sits at a guessed path.
 * It survives a hoisted install, a worktree, and a pnpm layout, and it
 * additionally catches an upgrade that narrows a package's `exports` map.
 *
 * Resolve the ENTRY POINT, not `<pkg>/package.json`, unless you have checked:
 * that subpath is itself gated by `exports`, and e.g. cmdk's map declares only
 * `"."`, so `require.resolve('cmdk/package.json')` throws on a healthy install.
 *
 * ═══ THE ONE THING THAT IS NOT A DEPENDENCY PATH ═══
 *
 * `node_modules/.cache/**` is a per-checkout scratch directory this repo
 * CREATES (`mkdirSync(..., { recursive: true })`) and writes: the test-DB
 * per-worker marker, the E2E TLS cert. The writer owns that path, resolution
 * does not, and it MUST stay per-checkout — two worktrees sharing one marker
 * would point both at one another's databases. So a `.cache` subpath is
 * allowed, and that is a statement about what the path means, not an
 * allowlist entry. There is no allowlist here.
 *
 * ═══ THE SECOND SHAPE: `<rootDir>/node_modules/…` ═══
 *
 * A Jest `moduleNameMapper` target is the same mistake in a different
 * notation. `<rootDir>` is the CHECKOUT, so
 *
 *     '^react-grid-layout/legacy$':
 *         '<rootDir>/node_modules/react-grid-layout/dist/legacy.js',
 *
 * pointed at nothing in a worktree, and every rendered suite reaching
 * `DashboardGrid` died with "Test suite failed to run — Configuration error:
 * Could not locate module". Not one assertion ran, and CI was green.
 *
 * The fix is the same verb: `require.resolve('react-grid-layout/legacy')`.
 * `jest.config.js` is a CommonJS module Node loads, so `require.resolve` there
 * is NODE's resolver — which walks up the directory chain AND honours the
 * `exports` map that the mapping existed to work around in the first place.
 * (The literal `react-grid-layout/dist/legacy.js` subpath is not exported;
 * only `./legacy` is. So the spelled path was also the more fragile one.)
 *
 * ═══ WHY A TYPESCRIPT AST, AND NOT THE HAND-ROLLED LEXER THIS FILE HAD ═══
 *
 * The first version masked comments, strings, templates and regexes with its
 * own character loop and then bracket-matched the argument list. Review broke
 * it three ways, and all three were SILENT — no hit, no skip, and a
 * denominator that shrank without complaining:
 *
 *   (a) `return /^https?:\/\//.test(u) && path.join(ROOT, 'node_modules', …)`
 *       — the regex-start heuristic looked back only at punctuation, so a
 *       regex in KEYWORD-operand position was not recognised as a regex, the
 *       `//` inside it was read as a line comment, and the rest of the line —
 *       the whole real call — was blanked. That is exactly the `codeOf`
 *       defect the hand-rolled lexer existed to avoid, reintroduced one
 *       heuristic later.
 *   (b) the same miss with quotes instead of slashes
 *       (`return /^['"]use client['"]$/m.test(s)`) desynchronised the
 *       string-masking state for the REST OF THE FILE, not just that line.
 *   (c) `const SEG = 'node_modules'; path.join(ROOT, SEG, 'prisma')` — the
 *       call parsed and was counted in the denominator, contributed no string
 *       literal, and so read as an ordinary non-dependency path.
 *
 * A lexer that has to guess whether `/` opens a regex will keep having this
 * bug; TypeScript's parser does not guess, because it knows the grammar
 * position. So the population, the call sites and the argument lists all now
 * come from `ts.createSourceFile` — syntax only, no program, no type checker,
 * following the precedent in `tests/helpers/assertion-reach.ts`. All three
 * shapes are pinned as assertions in the mutation proof below.
 *
 * The AST also makes an earlier claim of this header true for the first time.
 * It used to say that hiding a call behind syntax the matcher could not
 * follow turned the guard red rather than shrinking its population; that was
 * false, and (a)–(c) are three counter-examples. With a parser the category
 * mostly stops existing — a `CallExpression` is seen whatever regex or
 * template sits beside it — and what remains is narrower and different: a
 * path VALUE that is not in the call. That class is enumerated below rather
 * than implied away.
 *
 * ═══ SCOPE, STATED HONESTLY ═══
 *
 * COVERED. Path-bearing calls found in the AST — `path.join` / `path.resolve`
 * (and the bare-imported `join` / `resolve`), the `fs` readers, and the
 * `child_process` spawners — whose arguments reduce to path pieces naming a
 * `node_modules` segment. Reduction follows string literals, template
 * literals, array elements, `+` concatenation — including a `node_modules`
 * segment SPLIT ACROSS the `+`, since concatenation has no separator and the
 * touching pieces of the two operands are one piece — both arms of a
 * conditional, and an identifier bound in the same file to a string-literal
 * `const`. Plus `<rootDir>/node_modules/…` inside a string or template
 * literal, which is the Jest-config notation for the same mistake.
 *
 * The lexer version's header declared concatenation out of scope. Measured,
 * that was half right and in the flattering direction: it DID flag
 * `ROOT + '/node_modules/x'`, by accident, because it harvested every literal
 * out of the argument text — and it missed the split spelling, which is the
 * one a reducer has to be built for.
 *
 * NOT COVERED. Each of these was run against this implementation, not
 * assumed:
 *
 *   • A path piece whose value is not in the file — imported from another
 *     module, returned by a function, read from `process.env`, or assembled
 *     by `.map` / `.reduce`. The reducer marks it opaque and moves on. This
 *     is the residual the AST leaves: the call is always SEEN and always
 *     counted, but its value cannot always be known.
 *   • An identifier with more than one string-literal binding in the file,
 *     none of them naming `node_modules` — genuinely ambiguous, so opaque.
 *   • A path handed to a call this file does not list. The spawners are
 *     listed because `spawnSync('node_modules/.bin/tsx', …)` is one keystroke
 *     from the real instance in `framework-import-cli.test.ts`; a shape like
 *     `new Worker('node_modules/x/worker.js')` is not listed and is not
 *     caught. The callee is matched by NAME, so a listed function reached
 *     through an alias — `const j = path.join; j(ROOT, 'node_modules', …)` —
 *     is not seen either, and unlike the bullet above it is not even counted
 *     (`total: 0`). Measured, not assumed.
 *   • A dependency path in a non-code file — a shell script, a `Dockerfile`,
 *     a `package.json` script, a YAML workflow step. The population here is
 *     TypeScript and JavaScript.
 *   • `public/` — vendored third-party bundles (the swagger-ui dist), not
 *     first-party source. Nothing in there is ours to fix.
 *
 * It deliberately does NOT flag every string containing `node_modules`,
 * because most of them are not paths at all: lockfile keys
 * (`lock.packages['node_modules/next']`), directory-walk skip lists
 * (`entry.name === 'node_modules'`), Jest ignore patterns (`'/node_modules/'`)
 * and assertions about the text of a shell script
 * (`toContain('node_modules/.bin/prisma')`). Those are excluded by the shape
 * of the check — none of them is an argument to a path-bearing call — rather
 * than by exemption, which is why this file needs no exemption list.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as ts from 'typescript';

import { repoRelativeFiles, REPO_ROOT } from '../helpers/repo-files';

/**
 * The only `node_modules` child that is a path this repo owns rather than a
 * dependency Node's resolver owns. See the header.
 */
const REPO_OWNED_CHILD = '.cache';

/**
 * Stands in for an argument the reducer could not turn into text.
 *
 * A real, non-empty segment, so it can never be mistaken for `node_modules`
 * and it never lets two known pieces on either side of an unknown one fuse
 * into a single segment.
 */
const OPAQUE = ' ';

/**
 * The calls whose arguments compose, or carry, one filesystem path.
 *
 * Each entry pairs a label (for the failure message) with the receivers that
 * qualify, because the families need different rules. `join` and `resolve`
 * must NOT match on an arbitrary receiver — `['a','b'].join('/')` and
 * `Promise.resolve(x)` are not path builders — so only a bare call or a
 * `path.` receiver counts. The `fs` readers and the spawners are nearly
 * always written with their module as the receiver, so theirs are named.
 *
 * The spawners are here because one of the four original instances WAS a
 * spawn: `framework-import-cli.test.ts` handed `<root>/node_modules/.bin/tsx`
 * to `spawnSync` and reported the resulting ENOENT as eight wrong exit codes.
 */
interface CallKind {
    readonly label: string;
    readonly names: readonly string[];
    readonly receivers: readonly string[];
}

const CALL_KINDS: readonly CallKind[] = [
    { label: 'path.join/resolve', names: ['join', 'resolve'], receivers: ['path'] },
    {
        label: 'fs read',
        names: [
            'readFileSync',
            'existsSync',
            'statSync',
            'lstatSync',
            'readdirSync',
            'createReadStream',
            'realpathSync',
            // …and the promise API. The receivers below already name it, and
            // a sync-only `names` list beside them would read as coverage it
            // did not have: `fsp.readFile('node_modules/x')` was invisible.
            'readFile',
            'readdir',
            'stat',
            'lstat',
            'realpath',
            'access',
        ],
        receivers: ['fs', 'fsp', 'promises'],
    },
    {
        label: 'child process',
        names: ['spawnSync', 'spawn', 'execFileSync', 'execFile', 'execSync', 'exec'],
        receivers: ['child_process', 'childProcess', 'cp'],
    },
];

/** TS for `.ts`, TSX for `.tsx`, JSX for plain JavaScript (a superset of JS). */
function scriptKindFor(rel: string): ts.ScriptKind {
    if (rel.endsWith('.tsx')) return ts.ScriptKind.TSX;
    if (rel.endsWith('.ts')) return ts.ScriptKind.TS;
    return ts.ScriptKind.JSX;
}

/**
 * `parseDiagnostics` is not on the public `SourceFile` type, but it is the
 * only honest answer to "did this file parse?". `createSourceFile` recovers
 * from syntax errors rather than throwing, so without reading them a broken
 * file scans as a file with no calls in it — indistinguishable from a clean
 * one, which is the silent-shrink failure this guard has to be immune to.
 */
interface ParsedSourceFile {
    readonly parseDiagnostics?: readonly ts.Diagnostic[];
}

function parse(rel: string, src: string): ts.SourceFile {
    return ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, false, scriptKindFor(rel));
}

/** The callee's name and its immediate receiver, or null if it is neither. */
function calleeOf(expr: ts.Expression): { name: string; receiver: string | null } | null {
    if (ts.isIdentifier(expr)) return { name: expr.text, receiver: null };
    if (ts.isPropertyAccessExpression(expr)) {
        const recv = expr.expression;
        // `fs.promises.readFile` — take the rightmost name of the receiver.
        if (ts.isIdentifier(recv)) return { name: expr.name.text, receiver: recv.text };
        if (ts.isPropertyAccessExpression(recv)) {
            return { name: expr.name.text, receiver: recv.name.text };
        }
        return { name: expr.name.text, receiver: '' };
    }
    return null;
}

function kindOf(expr: ts.Expression): CallKind | null {
    const callee = calleeOf(expr);
    if (callee === null) return null;
    for (const kind of CALL_KINDS) {
        if (!kind.names.includes(callee.name)) continue;
        if (callee.receiver === null || kind.receivers.includes(callee.receiver)) return kind;
    }
    return null;
}

/** Unwrap the annotations that never change a value. */
function unwrap(node: ts.Node): ts.Node {
    let cur = node;
    for (;;) {
        if (
            ts.isParenthesizedExpression(cur) ||
            ts.isAsExpression(cur) ||
            ts.isNonNullExpression(cur) ||
            ts.isTypeAssertionExpression(cur) ||
            ts.isSatisfiesExpression(cur)
        ) {
            cur = cur.expression;
            continue;
        }
        return cur;
    }
}

/**
 * The constant string value of `node`, or null if it has none.
 *
 * `consts` is optional so one function can both BUILD the constant table
 * (where identifiers must not resolve, or one binding could define another
 * and the order of the walk would decide the answer) and then READ it.
 */
function literalValue(
    node: ts.Node,
    consts?: ReadonlyMap<string, readonly string[]>,
): string | null {
    const cur = unwrap(node);
    if (ts.isStringLiteral(cur) || ts.isNoSubstitutionTemplateLiteral(cur)) return cur.text;
    if (ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const left = literalValue(cur.left, consts);
        const right = literalValue(cur.right, consts);
        return left === null || right === null ? null : left + right;
    }
    if (consts !== undefined && ts.isIdentifier(cur)) {
        const bound = consts.get(cur.text);
        if (bound === undefined || bound.length === 0) return null;
        // One binding is unambiguous. Several are not — unless one of them is
        // the thing being looked for, in which case reporting is the safer
        // side of the ambiguity.
        if (bound.length === 1) return bound[0];
        return bound.find((v) => v.includes('node_modules')) ?? null;
    }
    return null;
}

/**
 * Every identifier in the file bound to a plain string constant, mapped to
 * its distinct values.
 *
 * Deliberately file-scoped and scope-blind: this exists to close the
 * `const SEG = 'node_modules'; path.join(ROOT, SEG, …)` miss, not to be a
 * resolver. A name bound twice keeps both values and `literalValue` treats it
 * as ambiguous.
 */
function stringConstants(sf: ts.SourceFile): Map<string, string[]> {
    const table = new Map<string, string[]>();
    const visit = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
            const value = literalValue(node.initializer);
            if (value !== null) {
                const seen = table.get(node.name.text) ?? [];
                if (!seen.includes(value)) seen.push(value);
                table.set(node.name.text, seen);
            }
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
    return table;
}

interface PieceStats {
    literal: number;
    opaque: number;
}

/**
 * Reduce one argument to the ordered path pieces it contributes.
 *
 * Anything the reducer cannot turn into text becomes `OPAQUE` — counted, so
 * the scan can report how much of its own input it understood, and inert, so
 * it can never fuse the pieces on either side of it.
 */
function pushPieces(
    node: ts.Node,
    consts: ReadonlyMap<string, readonly string[]>,
    out: string[],
    stats: PieceStats,
): void {
    const cur = unwrap(node);

    const direct = literalValue(cur, consts);
    if (direct !== null) {
        out.push(direct);
        stats.literal++;
        return;
    }
    if (ts.isTemplateExpression(cur)) {
        out.push(cur.head.text);
        for (const span of cur.templateSpans) {
            out.push(OPAQUE);
            out.push(span.literal.text);
        }
        stats.literal++;
        return;
    }
    if (ts.isArrayLiteralExpression(cur)) {
        for (const element of cur.elements) pushPieces(element, consts, out, stats);
        return;
    }
    if (ts.isSpreadElement(cur)) {
        pushPieces(cur.expression, consts, out, stats);
        return;
    }
    if (ts.isConditionalExpression(cur)) {
        pushPieces(cur.whenTrue, consts, out, stats);
        out.push(OPAQUE);
        pushPieces(cur.whenFalse, consts, out, stats);
        return;
    }
    if (ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        // `+` joins with NO separator, so the two sides' touching pieces are
        // one piece. Reducing each side into `out` and letting the caller put
        // a `/` between them would break `ROOT + '/node_' + 'modules/next'`
        // into `node_` and `modules` — a `node_modules` segment split across
        // an opaque operand, which is exactly the (c)-shaped miss one level
        // out. Fusing the boundary keeps it whole; the pieces that do not
        // touch are unaffected.
        const left: string[] = [];
        const right: string[] = [];
        pushPieces(cur.left, consts, left, stats);
        pushPieces(cur.right, consts, right, stats);
        if (left.length > 0 && right.length > 0) {
            out.push(
                ...left.slice(0, -1),
                left[left.length - 1] + right[0],
                ...right.slice(1),
            );
        } else {
            out.push(...left, ...right);
        }
        return;
    }
    out.push(OPAQUE);
    stats.opaque++;
}

/**
 * Given the ordered path pieces of one call, report the segment that follows
 * `node_modules`, or `null` if the call names no `node_modules` path.
 *
 * Pieces are joined with `/` first, so the segment- and embedded-argument
 * spellings collapse onto one code path:
 *
 *     path.join(ROOT, 'node_modules', 'prisma', 'package.json')
 *     path.resolve(__dirname, '../../node_modules/cmdk/package.json')
 */
function childAfterNodeModules(pieces: readonly string[]): string | null {
    const segments = pieces
        .join('/')
        .replace(/\\/g, '/')
        .split('/')
        .filter((s) => s.length > 0);
    const at = segments.indexOf('node_modules');
    if (at === -1) return null;
    const child = segments[at + 1];
    if (child === undefined || child === OPAQUE) return '';
    return child;
}

export interface PathCallScan {
    /** Sites that build, or carry, a path into an installed package. */
    hits: string[];
    /** Path-bearing calls seen, whether or not they named `node_modules`. */
    total: number;
    /** Arguments reduced to text. */
    literalArgs: number;
    /** Arguments whose value is not in the file. Reported, not asserted away. */
    opaqueArgs: number;
    /**
     * Files TypeScript could not parse cleanly.
     *
     * `createSourceFile` recovers from syntax errors instead of throwing, so
     * a broken file would otherwise scan as a file containing no calls —
     * indistinguishable from a clean one. Reported here and asserted empty by
     * the tree-wide scan, because a detector that silently drops what it
     * cannot read reports full coverage of the subset it understood.
     */
    unparsed: string[];
}

/**
 * Report every place `src` builds or carries a filesystem path into an
 * installed package, alongside the denominator that makes the report
 * readable.
 */
export function scanPathCalls(rel: string, src: string): PathCallScan {
    const sf = parse(rel, src);
    const diagnostics = (sf as unknown as ParsedSourceFile).parseDiagnostics ?? [];
    const unparsed =
        diagnostics.length > 0
            ? [
                  `${rel} — ${diagnostics.length} syntax error(s), first at offset ` +
                      `${diagnostics[0].start ?? 0}`,
              ]
            : [];

    const consts = stringConstants(sf);
    const hits: string[] = [];
    const stats: PieceStats = { literal: 0, opaque: 0 };
    let total = 0;

    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
            const kind = kindOf(node.expression);
            if (kind !== null) {
                total++;
                const pieces: string[] = [];
                for (const arg of node.arguments) pushPieces(arg, consts, pieces, stats);
                const child = childAfterNodeModules(pieces);
                if (child !== null && child !== REPO_OWNED_CHILD) {
                    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
                    hits.push(
                        `${rel}:${line} — ${kind.label} builds node_modules/${child || '<root>'}`,
                    );
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);

    return {
        hits: [...new Set(hits)],
        total,
        literalArgs: stats.literal,
        opaqueArgs: stats.opaque,
        unparsed,
    };
}

/**
 * Report every `<rootDir>/node_modules/<pkg>` string — the Jest-config
 * spelling of the same mistake. Kept separate from `scanPathCalls` because it
 * is a different notation, not a different call: there is no argument list to
 * reduce, only a literal to read.
 *
 * Reads string and template literals FROM THE AST, so a `<rootDir>` written
 * in a comment is prose and is not the population.
 *
 * Deliberately NOT folded into a general "any literal mentioning
 * node_modules" rule. `<rootDir>` makes this one unambiguous — it appears in
 * Jest configuration and nowhere else — which is what keeps the check free of
 * the lockfile keys and skip lists that such a rule would drag in.
 */
export function rootDirDependencyPaths(rel: string, src: string): string[] {
    const sf = parse(rel, src);
    const hits: string[] = [];
    const re = /<rootDir>\/node_modules\/([^'"`\s]+)/g;

    const read = (text: string, node: ts.Node): void => {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
            const child = m[1].split('/')[0];
            if (child === REPO_OWNED_CHILD) continue;
            const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
            hits.push(`${rel}:${line} — <rootDir>/node_modules/${child}`);
        }
    };

    const visit = (node: ts.Node): void => {
        if (
            ts.isStringLiteral(node) ||
            ts.isNoSubstitutionTemplateLiteral(node) ||
            ts.isTemplateHead(node) ||
            ts.isTemplateMiddle(node) ||
            ts.isTemplateTail(node)
        ) {
            read(node.text, node);
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
    return [...new Set(hits)];
}

/**
 * Report every place `src` builds a filesystem path into an installed package.
 * Exported so the mutation proof below can drive it on synthetic sources.
 */
export function hardCodedDependencyPaths(rel: string, src: string): string[] {
    return scanPathCalls(rel, src).hits;
}

/**
 * The code this repo LOADS FROM ITS OWN CHECKOUT.
 *
 * `tests` / `src` / `scripts`, plus the repo-root files — which is where
 * `jest.config.js` lives, and the `<rootDir>` mapping that broke every
 * rendered suite in a worktree was in it, so scoping to subtrees alone would
 * have left the costliest shape uncovered.
 *
 * `eslint-rules/` and `__mocks__/` are here because both are loaded from the
 * checkout too — the local ESLint plugin by `eslint.config.mjs`, the manual
 * mock by Jest's resolver — so a spelled `node_modules` path in either
 * reproduces the exact bug, in a directory nobody would think to look at.
 * `prisma/` (seed + catalogue scripts), `.zap/` (the DAST report readers) and
 * the tracked `scratch/` helpers are here for the same reason.
 *
 * `public/` is the one first-party-looking directory left out, and the header
 * says why: it holds a vendored, minified swagger-ui bundle that is not ours
 * to fix.
 */
const SCANNED_PREFIXES = [
    'tests/',
    'src/',
    'scripts/',
    'eslint-rules/',
    '__mocks__/',
    'prisma/',
    'scratch/',
    '.zap/',
] as const;

/**
 * Floors on the scan's own denominator, measured 2026-09-07 on this tree.
 *
 * Seated just under the real figures, NOT at a round placeholder. The first
 * version floored both at 1000 against ~5,000 files and ~5,400 calls, which
 * tolerated an 80% collapse — and duly failed to notice the calls its own
 * lexer was losing (measured against this parser on the same population:
 * 5,454 vs 5,388, a 66-call hole). A floor that cannot see the loss it was
 * written for is decoration.
 *
 * MEASURE ON THE COMMITTED TREE. The first attempt at these numbers was taken
 * with a throwaway measurement harness sitting in `tests/`, and `git ls-files
 * --others` counts an untracked file — so the figures recorded were the tree
 * PLUS the ruler, one file and two calls high. Small enough to change no
 * verdict and still a false measurement, which is worse than none. Delete the
 * harness, then read the numbers.
 *
 * They are floors and not equalities on purpose: deleting a test file is a
 * normal thing to do and must not turn this red. When a change legitimately
 * drops the population below one of them, re-measure and move it — the
 * numbers in the failure message are the measurement.
 */
const MEASURED = { files: 5032, calls: 5598, literalArgs: 3738 } as const;
const FLOOR = { files: 4900, calls: 5430, literalArgs: 3620 } as const;

describe('a dependency is located by resolution, not by a spelled path', () => {
    it('detects every shape of the bug, and none of the look-alikes (mutation proof)', () => {
        // Assembled rather than written verbatim so the samples cannot be
        // confused with the real population — the tree-wide scan below reads
        // this file too, with no self-skip.
        const NM = 'node_' + 'modules';

        const segmentForm = `
            const p = path.join(REPO_ROOT, '${NM}', 'prisma', 'package.json');
        `;
        const embeddedForm = `
            const p = path.resolve(__dirname, '../../${NM}/cmdk/package.json');
        `;
        const binForm = `
            const TSX_BIN = path.join(REPO_ROOT, '${NM}', '.bin', 'tsx');
        `;
        const bareImportForm = `
            import { resolve } from 'node:path';
            const dir = resolve(ROOT, '${NM}/some-pkg/dist');
        `;
        const directFsForm = `
            const raw = fs.readFileSync('${NM}/next/package.json', 'utf8');
        `;
        // The promise API, which the receivers list already anticipated while
        // the names list was sync-only — so `fsp.readFile('node_modules/x')`
        // was invisible, and invisible in the flattering direction.
        const asyncFsForm = `
            const raw = await fsp.readFile('${NM}/next/package.json', 'utf8');
            const st = await fs.promises.stat('${NM}/cmdk');
        `;
        // The repo-owned scratch dir. Written by this repo, mkdir'd by its
        // writer, and deliberately per-checkout — resolving it would be the
        // bug, not the fix.
        const repoOwnedCache = `
            const MARKER = path.resolve(__dirname, '../../${NM}/.cache/marker.json');
            const CERT = path.resolve(process.cwd(), '${NM}/.cache/e2e-tls/cert.pem');
        `;
        // Look-alikes: none of these is a filesystem path.
        const skipList = `
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                if (e.name === '${NM}' || e.name === '.next') continue;
                if (['${NM}', '.next', 'dist'].includes(e.name)) continue;
            }
        `;
        const lockfileKeys = `
            const PREFIX = '${NM}/npm/${NM}/';
            const nextEntry = lock.packages?.['${NM}/next'];
            const suffix = \`${NM}/\${name}\`;
        `;
        const jestPatterns = `
            const cfg = { coveragePathIgnorePatterns: ['/${NM}/', '/tests/'] };
            const SWC_RE = /^(@next\\/swc-|${NM}\\/@next\\/swc-)/;
        `;
        const shellScriptAssertion = `
            expect(line).toContain('${NM}/.bin/prisma');
        `;
        // Prose is not the population. A commented-out or illustrative call is
        // a call SHAPE, not a call — a comment is not a node, so this now
        // falls out of the parse rather than out of a masking pass.
        const commentedOut = `
            // const p = path.join(REPO_ROOT, '${NM}', 'prisma', 'package.json');
            /* const q = path.resolve(__dirname, '../../${NM}/cmdk/index.js'); */
        `;
        // A comment INSIDE an argument list donates no path piece.
        const commentInsideArgs = `
            const p = path.join(REPO_ROOT, /* '${NM}', 'prisma', */ 'src');
        `;
        // The Jest-config spelling of the same mistake, and its remedy.
        const rootDirForm = `
            const map = {
                '^react-grid-layout/legacy$':
                    '<rootDir>/${NM}/react-grid-layout/dist/legacy.js',
            };
        `;
        const rootDirCache = `
            const marker = '<rootDir>/${NM}/.cache/marker.json';
        `;
        const rootDirResolved = `
            const map = {
                '^react-grid-layout/legacy$': require.resolve('react-grid-layout/legacy'),
                '^@/(.*)$': '<rootDir>/src/$1',
            };
        `;
        // The remedy must not read as the disease.
        const resolved = `
            const pkg = require.resolve('tsx/package.json', { paths: [REPO_ROOT] });
            const dir = path.dirname(pkg);
            const entry = path.join(dir, 'dist', 'cli.mjs');
        `;

        expect(hardCodedDependencyPaths('a.ts', segmentForm)).toHaveLength(1);
        expect(hardCodedDependencyPaths('b.ts', embeddedForm)).toHaveLength(1);
        expect(hardCodedDependencyPaths('c.ts', binForm)).toHaveLength(1);
        expect(hardCodedDependencyPaths('d.ts', bareImportForm)).toHaveLength(1);
        expect(hardCodedDependencyPaths('e.ts', directFsForm)).toHaveLength(1);
        expect(hardCodedDependencyPaths('m.ts', asyncFsForm)).toHaveLength(2);

        expect(hardCodedDependencyPaths('f.ts', repoOwnedCache)).toEqual([]);
        expect(hardCodedDependencyPaths('g.ts', skipList)).toEqual([]);
        expect(hardCodedDependencyPaths('h.ts', lockfileKeys)).toEqual([]);
        expect(hardCodedDependencyPaths('i.ts', jestPatterns)).toEqual([]);
        expect(hardCodedDependencyPaths('j.ts', shellScriptAssertion)).toEqual([]);
        expect(hardCodedDependencyPaths('k.ts', resolved)).toEqual([]);
        expect(hardCodedDependencyPaths('l.ts', commentedOut)).toEqual([]);

        // Positive companion: the call is still SEEN and still reduced — the
        // comment is ignored, not the whole call. Without this, dropping the
        // entire call would satisfy the assertion above just as well.
        const argCommentScan = scanPathCalls('n.ts', commentInsideArgs);
        expect(argCommentScan.hits).toEqual([]);
        expect(argCommentScan.total).toBe(1);
        expect(argCommentScan.literalArgs).toBe(1);

        // ── second shape ──
        expect(rootDirDependencyPaths('o.ts', rootDirForm)).toHaveLength(1);
        expect(rootDirDependencyPaths('o.ts', rootDirForm)[0]).toContain('react-grid-layout');
        expect(rootDirDependencyPaths('p.ts', rootDirCache)).toEqual([]);
        expect(rootDirDependencyPaths('q.ts', rootDirResolved)).toEqual([]);
        // A `<rootDir>` path that is not into node_modules is ordinary and fine.
        expect(rootDirDependencyPaths('r.ts', "const x = '<rootDir>/src/foo';")).toEqual([]);
        // The two detectors do not double-report: a `<rootDir>` string is not a
        // path-building call, and a `path.join` is not a `<rootDir>` string.
        expect(hardCodedDependencyPaths('o.ts', rootDirForm)).toEqual([]);
        expect(rootDirDependencyPaths('a.ts', segmentForm)).toEqual([]);
    });

    it('sees through the three syntaxes that silently blinded the lexer version', () => {
        // These are regression pins, and each one is a measured miss of the
        // hand-rolled masker this file used to carry — not a hypothetical.
        // Every one of them returned `{ hits: [], unparsed: [] }`, i.e. it
        // shrank the population without saying so. The assertions are
        // POSITIVE on purpose: the failure mode is silent under-reporting, so
        // "nothing was flagged" would be proving the bug.
        const NM = 'node_' + 'modules';

        // (a) A regex in KEYWORD-operand position. The old regex-start
        //     heuristic looked back only at punctuation, saw `n` from
        //     `return`, decided this `/` was division — and then read the
        //     `//` that ends the regex as a line comment, blanking the real
        //     call that follows on the same line. Measured: hits 0, total 0.
        const regexAfterKeyword = [
            'function f(u: string) {',
            `    return /^https?:\\/\\//.test(u) && path.join(ROOT, '${NM}', 'prisma');`,
            '}',
        ].join('\n');
        const afterKeyword = scanPathCalls('a.ts', regexAfterKeyword);
        expect(afterKeyword.hits).toHaveLength(1);
        expect(afterKeyword.hits[0]).toContain('prisma');
        expect(afterKeyword.total).toBe(1);
        expect(afterKeyword.unparsed).toEqual([]);

        // (b) The same miss, but the regex carries quote characters instead of
        //     slashes — so the unrecognised `'` opened a "string literal" and
        //     desynchronised the masking for EVERYTHING AFTER IT, not just
        //     that line. The call below is on a later line and was still lost.
        //     Measured: hits 0, total 0.
        const regexWithQuotes = [
            'function g(s: string) {',
            `    return /^['"]use client['"]$/m.test(s);`,
            '}',
            `const p = path.join(ROOT, '${NM}', 'prisma');`,
        ].join('\n');
        const withQuotes = scanPathCalls('b.ts', regexWithQuotes);
        expect(withQuotes.hits).toHaveLength(1);
        expect(withQuotes.hits[0]).toContain('prisma');
        expect(withQuotes.total).toBe(1);
        expect(withQuotes.unparsed).toEqual([]);

        // (c) The `node_modules` segment held in a variable. This one PARSED
        //     and was counted — total was 1 — it simply contributed no string
        //     literal, so it read as an ordinary path. The denominator was
        //     intact and the finding was gone, which is the worst version.
        const variableSegment = [
            `const SEG = '${NM}';`,
            "const p = path.join(ROOT, SEG, 'prisma', 'package.json');",
        ].join('\n');
        const viaVariable = scanPathCalls('c.ts', variableSegment);
        expect(viaVariable.hits).toHaveLength(1);
        expect(viaVariable.hits[0]).toContain('prisma');
        expect(viaVariable.total).toBe(1);

        // …and the asymmetry that resolution is deliberately built with.
        //
        // The constant table is file-scoped and scope-blind, so a name
        // DECLARED twice keeps both values. Two non-dependency values is
        // genuine ambiguity and must not invent a finding; if one of them
        // names `node_modules`, reporting is the safer side of the same
        // ambiguity. Both halves are pinned, because only asserting the quiet
        // one would leave `return bound[0]` — which resolves nothing — passing.
        //
        // The bindings have to be two DECLARATIONS. An earlier version of this
        // fixture wrote `let SEG = 'src'; SEG = 'dist';`, which is two values
        // in JavaScript but one entry in the table (an assignment is not a
        // `VariableDeclaration`), so it resolved unambiguously to 'src' and
        // returned [] without ever reaching the code the comment described.
        const ambiguous = [
            "const SEG = 'src';",
            "function inner() { const SEG = 'dist'; return SEG; }",
            "const q = path.join(ROOT, SEG, 'prisma');",
        ].join('\n');
        expect(hardCodedDependencyPaths('d.ts', ambiguous)).toEqual([]);

        const ambiguousButOneNamesIt = [
            "const SEG = 'src';",
            `function inner() { const SEG = '${NM}'; return SEG; }`,
            "const q = path.join(ROOT, SEG, 'prisma');",
        ].join('\n');
        const reported = hardCodedDependencyPaths('e.ts', ambiguousButOneNamesIt);
        expect(reported).toHaveLength(1);
        expect(reported[0]).toContain('prisma');
    });

    it('covers concatenation and the spawners, split segments included', () => {
        const NM = 'node_' + 'modules';

        // Concatenation onto a root. The old header said this was not
        // covered, and that adding a partial check would advertise coverage
        // it lacked. Measured, the lexer caught THIS spelling anyway — it
        // harvested every literal out of the argument text — and missed the
        // split one below. Reduction covers the family, not the lucky case.
        const concatenated = `const p = fs.readFileSync(ROOT + '/${NM}/next/package.json');`;
        const concat = hardCodedDependencyPaths('a.ts', concatenated);
        expect(concat).toHaveLength(1);
        expect(concat[0]).toContain('next');

        // A bare literal handed to a spawner. `framework-import-cli.test.ts`
        // wrote this with `path.join`; one keystroke the other way and the
        // ENOENT-reported-as-eight-wrong-exit-codes failure comes back.
        const spawned = `const r = spawnSync('${NM}/.bin/tsx', [CLI], { encoding: 'utf8' });`;
        const spawn = hardCodedDependencyPaths('b.ts', spawned);
        expect(spawn).toHaveLength(1);
        expect(spawn[0]).toContain('.bin');

        // …and in the argv array rather than the command.
        const viaArgv = `execFileSync('node', ['${NM}/.bin/jest', '--ci']);`;
        expect(hardCodedDependencyPaths('c.ts', viaArgv)).toHaveLength(1);

        // A `node_modules` segment SPLIT ACROSS the `+`. `+` joins with no
        // separator, so the touching pieces of the two sides are one piece;
        // reducing each side independently and letting the caller put a `/`
        // between them would yield `node_` and `modules` and lose the finding
        // — the (c) miss one level out. Both an opaque left operand and a
        // template head that ends mid-word are pinned, because those are the
        // two ways the halves stop being foldable literals.
        const splitAcrossPlus = `fs.readFileSync(ROOT + '/node_' + \`modules/next/package.json\`);`;
        expect(hardCodedDependencyPaths('e.ts', splitAcrossPlus)).toHaveLength(1);
        const splitAfterTemplate = 'fs.readFileSync(`${ROOT}/node_` + ' + `'modules/next');`;
        expect(hardCodedDependencyPaths('f.ts', splitAfterTemplate)).toHaveLength(1);

        // Separate ARGUMENTS are not fused — `path.join(ROOT, 'node_',
        // 'modules')` really is `ROOT/node_/modules`, which is not a
        // dependency path, and fusing it would invent a finding.
        expect(
            hardCodedDependencyPaths('g.ts', `path.join(ROOT, '${'node_'}', 'modules', 'next');`),
        ).toEqual([]);

        // Spawning something that is not a dependency path stays quiet.
        expect(hardCodedDependencyPaths('d.ts', "execFileSync('git', ['ls-files']);")).toEqual([]);
    });

    it('reports a file it cannot parse instead of scanning it as empty', () => {
        // The denominator's last hole. `createSourceFile` recovers from syntax
        // errors rather than throwing, so a file it cannot read yields no
        // calls — which looks exactly like a clean file. The positive
        // companion below is the point: a valid file with the same call must
        // report no skips, or "unparsed is empty" would be satisfied by a
        // detector that never populates it.
        const NM = 'node_' + 'modules';
        const broken = `const p = path.join(ROOT, '${NM}',,,, 'prisma'`;
        expect(scanPathCalls('broken.ts', broken).unparsed.length).toBeGreaterThan(0);

        const valid = `const p = path.join(ROOT, '${NM}', 'prisma');`;
        const validScan = scanPathCalls('valid.ts', valid);
        expect(validScan.unparsed).toEqual([]);
        expect(validScan.hits).toHaveLength(1);
    });

    it('names the offending child and line, so the message says which package', () => {
        // Guards against a detector that finds the shape but reports nothing
        // actionable — the failure text is the whole product here.
        const NM = 'node_' + 'modules';
        const [hit] = hardCodedDependencyPaths(
            'x.ts',
            `\nconst p = path.join(ROOT, '${NM}', 'prisma', 'package.json');`,
        );
        expect(hit).toContain('prisma');
        expect(hit).toContain('x.ts:2');
    });

    it('no source file builds a filesystem path into an installed package', () => {
        // No allowlist, and no self-skip either. The `.cache` carve-out is a
        // statement about what that path MEANS (this repo writes it, per
        // checkout), not an exemption — and the fix everywhere else is
        // `require.resolve`, which needs no exemption. This file is scanned
        // like any other: its synthetic samples live inside template literals,
        // which are values and not calls.
        const hits: string[] = [];
        const scanned: string[] = [];
        const unparsed: string[] = [];
        let calls = 0;
        let literalArgs = 0;
        let opaqueArgs = 0;

        const population = repoRelativeFiles().filter(
            (rel) => SCANNED_PREFIXES.some((p) => rel.startsWith(p)) || !rel.includes('/'),
        );

        for (const rel of population) {
            if (!/\.(ts|tsx|js|mjs|cjs)$/.test(rel)) continue;
            scanned.push(rel);
            const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
            const scan = scanPathCalls(rel, src);
            hits.push(...scan.hits);
            calls += scan.total;
            literalArgs += scan.literalArgs;
            opaqueArgs += scan.opaqueArgs;
            unparsed.push(...scan.unparsed);
            hits.push(...rootDirDependencyPaths(rel, src));
        }

        // ── The denominator is part of the result ──
        //
        // Four ways this scan could report "no hard-coded dependency paths"
        // while checking nothing, each closed here:
        //
        //   1. the file population collapsed (a bad prefix list, a helper
        //      change);
        //   2. no path-bearing call was recognised at all (a broken callee
        //      match);
        //   3. calls were recognised but no argument was ever reduced to
        //      text, so nothing could ever name `node_modules`;
        //   4. files did not parse, and a file that does not parse yields no
        //      calls — indistinguishable from a clean one.
        //
        // (3) is the floor the lexer version did not have, and it is the one
        // that would have caught its own 57-call loss.
        //
        // A count cannot see WHICH directories are in, and the four smallest
        // members of the population are the ones a prefix-list edit would drop
        // without moving any total enough to matter — so they are named. Two
        // of them (`eslint-rules/`, `__mocks__/`) were missing from the first
        // version of this list while its file floor still passed comfortably.
        const reaches = (prefix: string): boolean => scanned.some((rel) => rel.startsWith(prefix));
        expect({
            repoRoot: scanned.includes('jest.config.js'),
            eslintRules: reaches('eslint-rules/'),
            manualMocks: reaches('__mocks__/'),
            prismaScripts: reaches('prisma/'),
        }).toEqual({ repoRoot: true, eslintRules: true, manualMocks: true, prismaScripts: true });

        expect({
            files: scanned.length >= FLOOR.files,
            calls: calls >= FLOOR.calls,
            literalArgs: literalArgs >= FLOOR.literalArgs,
        }).toEqual({ files: true, calls: true, literalArgs: true });
        expect(unparsed).toEqual([]);

        // Opaque arguments are NORMAL — most path pieces are variables — so
        // this is reported, never asserted down. It is here so a future reader
        // can see how much of the population the reducer actually reads.
        expect(opaqueArgs).toBeGreaterThan(0);

        if (hits.length > 0) {
            throw new Error(
                `${hits.length} site(s) build a filesystem path into an installed package ` +
                    `(scanned ${scanned.length} files, ${calls} path-bearing calls, ` +
                    `${literalArgs} literal / ${opaqueArgs} opaque arguments; ` +
                    `floors ${FLOOR.files}/${FLOOR.calls}/${FLOOR.literalArgs}, ` +
                    `measured ${MEASURED.files}/${MEASURED.calls}/${MEASURED.literalArgs} ` +
                    'on 2026-09-07):\n' +
                    hits.map((h) => `  - ${h}`).join('\n') +
                    '\n\n`path.join`/`path.resolve` are literal string joins and do no upward ' +
                    'walk, so such a path exists only in a checkout that owns its install. ' +
                    'A `.claude/worktrees/<id>/` checkout has no `node_modules` of its own ' +
                    '(it resolves upward to the primary clone), so these fail — or, worse, ' +
                    'skip themselves green behind an `existsSync` guard — for worktree users ' +
                    'while passing in CI.\n\n' +
                    'For a Jest `moduleNameMapper` target, the same fix applies and the ' +
                    'config is a CommonJS module Node loads, so `require.resolve(...)` ' +
                    "there is Node's resolver — it walks up AND honours the `exports` " +
                    'map.\n\n' +
                    "Ask Node instead: `require.resolve('pkg')` to check it is installed, " +
                    "`path.dirname(require.resolve('pkg/package.json'))` for its directory. " +
                    'Resolve the entry point rather than `<pkg>/package.json` unless you have ' +
                    "checked the package's `exports` map exposes that subpath.\n\n" +
                    'Writing to `node_modules/.cache/**` is fine and is not reported.',
            );
        }
    });
});
