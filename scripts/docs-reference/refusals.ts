/**
 * The refusals the API can answer with — read from where they are thrown.
 *
 * Three layers, each from its own source:
 *   - the base codes: every `AppError` subclass in src/lib/errors/types.ts and
 *     the code and HTTP status its constructor passes to `super`;
 *   - the domain codes: the `DomainErrorCode` union, with the doc comment each
 *     member carries;
 *   - the named reasons: every throw of one of those errors, anywhere in
 *     `src/`, whose details carry `reason: '<CODE>'`. The reason is what lets
 *     a page say something more useful than "forbidden", and it is the part a
 *     page guide's "Empty and error states" section explains.
 */
import ts from 'typescript';
import { resolveImport } from './page-actions';
import { lineOf, literalText, walk } from './source';

export const ERRORS_FILE = 'src/lib/errors/types.ts';

export interface ErrorClass {
    code: string;
    status: number;
}

export interface Refusal {
    reason: string;
    /** `CONFLICT 409` — more than one when a helper picks the error by the reason. */
    answers: string[];
    /** The message the API returns with it, `…` standing for a run-time value; null when built elsewhere. */
    messages: string[];
    sites: { file: string; line: number }[];
}

export interface DomainCode {
    code: string;
    description: string;
}

function superArgs(cls: ts.ClassDeclaration): readonly ts.Expression[] | null {
    const ctor = cls.members.find(ts.isConstructorDeclaration);
    let args: readonly ts.Expression[] | null = null;
    if (ctor?.body) {
        walk(ctor.body, (n) => {
            if (!args && ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.SuperKeyword) args = n.arguments;
        });
    }
    return args;
}

/** `ForbiddenError` → `{ code: 'FORBIDDEN', status: 403 }`, for every class that extends AppError. */
export function errorClasses(sf: ts.SourceFile): Map<string, ErrorClass> {
    const out = new Map<string, ErrorClass>();
    for (const st of sf.statements) {
        if (!ts.isClassDeclaration(st) || !st.name) continue;
        const ext = st.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
        if (!ext || ext.expression.getText(sf) !== 'AppError') continue;
        const args = superArgs(st);
        const code = literalText(args?.[1]);
        const status = args?.[2] && ts.isNumericLiteral(args[2]) ? Number(args[2].text) : null;
        // DomainError passes its code and status through from the throw site.
        out.set(st.name.text, { code: code ?? '', status: status ?? 400 });
    }
    return out;
}

/** `forbidden` → `ForbiddenError`, for the shortcut factories exported beside the classes. */
export function errorFactories(sf: ts.SourceFile): Map<string, ts.NewExpression> {
    const out = new Map<string, ts.NewExpression>();
    for (const st of sf.statements) {
        if (!ts.isVariableStatement(st)) continue;
        for (const d of st.declarationList.declarations) {
            const init = d.initializer;
            if (ts.isIdentifier(d.name) && init && ts.isArrowFunction(init) && ts.isNewExpression(init.body)) {
                out.set(d.name.text, init.body);
            }
        }
    }
    return out;
}

/** The `DomainErrorCode` union's members and their doc comments. */
export function domainCodes(sf: ts.SourceFile): DomainCode[] {
    const alias = sf.statements.find((s): s is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(s) && s.name.text === 'DomainErrorCode');
    if (!alias || !ts.isUnionTypeNode(alias.type)) return [];
    const text = sf.getFullText();
    let prevEnd = alias.type.pos;
    return alias.type.types.flatMap((t) => {
        // A member's doc comment sits before its `|`, so it is in the text
        // between the previous member and this one, not in this one's trivia.
        const between = text.slice(prevEnd, t.getStart(sf));
        prevEnd = t.end;
        if (!ts.isLiteralTypeNode(t) || !ts.isStringLiteral(t.literal)) return [];
        const doc = /\/\*\*([\s\S]*?)\*\//g;
        let last: string | null = null;
        for (let m = doc.exec(between); m; m = doc.exec(between)) last = m[1];
        const description = (last ?? '')
            .split('\n')
            .map((l) => l.replace(/^\s*\*\s?/, '').trim())
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
        return [{ code: t.literal.text, description }];
    });
}

/** Message text, `…` standing for each run-time value; null when it is not written at the throw. */
function messageText(e: ts.Expression | undefined, sf: ts.SourceFile): string | null {
    if (!e) return null;
    const lit = literalText(e);
    if (lit !== null) return lit;
    if (ts.isTemplateExpression(e)) return e.head.text + e.templateSpans.map((s) => `…${s.literal.text}`).join('');
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        const l = messageText(e.left, sf);
        const r = messageText(e.right, sf);
        return l !== null || r !== null ? `${l ?? '…'}${r ?? '…'}` : null;
    }
    return null;
}

type Lookup = { exists: (f: string) => boolean; parsed: (f: string) => ts.SourceFile };

/** A top-level declaration named `name` in a file, following one named import into the file that declares it. */
function topLevel(
    name: string,
    sf: ts.SourceFile,
    io: Lookup,
    depth = 0,
): { sf: ts.SourceFile; node: ts.VariableDeclaration | ts.TypeAliasDeclaration } | null {
    if (depth > 3) return null;
    for (const st of sf.statements) {
        if (ts.isVariableStatement(st)) {
            const d = st.declarationList.declarations.find((x) => ts.isIdentifier(x.name) && x.name.text === name);
            if (d) return { sf, node: d };
        }
        if (ts.isTypeAliasDeclaration(st) && st.name.text === name) return { sf, node: st };
        if (ts.isImportDeclaration(st) && st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings)) {
            const el = st.importClause.namedBindings.elements.find((x) => x.name.text === name);
            if (!el) continue;
            const spec = literalText(st.moduleSpecifier);
            const target = spec ? resolveImport(sf.fileName, spec, io.exists) : null;
            return target ? topLevel((el.propertyName ?? el.name).text, io.parsed(target), io, depth + 1) : null;
        }
    }
    return null;
}

function unwrap(e: ts.Expression): ts.Expression {
    return ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e) ? unwrap(e.expression) : e;
}

/** Every string a type can hold, when it is a finite set of string literals. */
function typeStrings(t: ts.TypeNode, sf: ts.SourceFile, io: Lookup, depth = 0): string[] | null {
    if (depth > 6) return null;
    if (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)) return [t.literal.text];
    if (ts.isParenthesizedTypeNode(t)) return typeStrings(t.type, sf, io, depth + 1);
    if (ts.isUnionTypeNode(t)) {
        const parts = t.types.map((x) => typeStrings(x, sf, io, depth + 1));
        return parts.every(Boolean) ? (parts.flat() as string[]) : null;
    }
    if (ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName)) {
        const found = topLevel(t.typeName.text, sf, io);
        return found && ts.isTypeAliasDeclaration(found.node) ? typeStrings(found.node.type, found.sf, io, depth + 1) : null;
    }
    // `(typeof REFUSALS)[number]` over an `as const` array.
    if (ts.isIndexedAccessTypeNode(t) && ts.isTypeQueryNode(unwrapType(t.objectType)) ) {
        const q = unwrapType(t.objectType) as ts.TypeQueryNode;
        const found = ts.isIdentifier(q.exprName) ? topLevel(q.exprName.text, sf, io) : null;
        const init = found && ts.isVariableDeclaration(found.node) && found.node.initializer ? unwrap(found.node.initializer) : null;
        if (init && ts.isArrayLiteralExpression(init)) {
            const vals = init.elements.map((e) => literalText(e));
            return vals.every((v) => v !== null) ? (vals as string[]) : null;
        }
        return null;
    }
    // `keyof typeof REFUSAL_STATUS` over an object of codes.
    if (ts.isTypeOperatorNode(t) && t.operator === ts.SyntaxKind.KeyOfKeyword && ts.isTypeQueryNode(t.type) && ts.isIdentifier(t.type.exprName)) {
        const found = topLevel(t.type.exprName.text, sf, io);
        const init = found && ts.isVariableDeclaration(found.node) && found.node.initializer ? unwrap(found.node.initializer) : null;
        if (init && ts.isObjectLiteralExpression(init)) {
            return init.properties.flatMap((p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? [p.name.text] : []));
        }
    }
    return null;
}

function unwrapType(t: ts.TypeNode): ts.TypeNode {
    return ts.isParenthesizedTypeNode(t) ? unwrapType(t.type) : t;
}

/** The parameter `name` of the function enclosing `at`, if it has one. */
function enclosingParam(name: string, at: ts.Node): ts.ParameterDeclaration | null {
    for (let n: ts.Node | undefined = at.parent; n; n = n.parent) {
        if (ts.isFunctionLike(n)) {
            const p = n.parameters.find((x) => ts.isIdentifier(x.name) && x.name.text === name);
            if (p) return p;
        }
    }
    return null;
}

/** A `const` named `name` declared in a scope enclosing `at`, nearest first. */
function enclosingConst(name: string, at: ts.Node): ts.Expression | null {
    for (let n: ts.Node | undefined = at.parent; n; n = n.parent) {
        if (ts.isBlock(n) || ts.isSourceFile(n)) {
            for (const st of n.statements) {
                if (!ts.isVariableStatement(st) || st.pos > at.pos) continue;
                const d = st.declarationList.declarations.find((x) => ts.isIdentifier(x.name) && x.name.text === name);
                if (d?.initializer) return d.initializer;
            }
        }
    }
    return null;
}

/** Every value an expression naming a reason can take. */
function reasonValues(e: ts.Expression, sf: ts.SourceFile, io: Lookup, at: ts.Node): string[] {
    const lit = literalText(e);
    if (lit !== null) return [lit];
    if (!ts.isIdentifier(e)) return [];
    const param = enclosingParam(e.text, at);
    if (param?.type) return typeStrings(param.type, sf, io) ?? [];
    const local = enclosingConst(e.text, at);
    if (local) return reasonValues(unwrap(local), sf, io, local);
    const top = topLevel(e.text, sf, io);
    if (top && ts.isVariableDeclaration(top.node) && top.node.initializer) {
        const v = literalText(unwrap(top.node.initializer));
        return v !== null ? [v] : [];
    }
    return [];
}

/** The reasons an error's details carry: `{ reason: … }` written inline, or a local `details` object. */
function reasonsOf(args: readonly ts.Expression[], sf: ts.SourceFile, io: Lookup, at: ts.Node): string[] {
    for (const raw of args) {
        let a = unwrap(raw);
        if (ts.isIdentifier(a)) {
            const local = enclosingConst(a.text, at);
            if (!local) continue;
            a = unwrap(local);
        }
        if (!ts.isObjectLiteralExpression(a)) continue;
        for (const p of a.properties) {
            if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'reason') return reasonValues(unwrap(p.initializer), sf, io, at);
            if (ts.isShorthandPropertyAssignment(p) && p.name.text === 'reason') return reasonValues(p.name, sf, io, at);
        }
    }
    return [];
}

export function refusals(
    files: readonly string[],
    errorsSf: ts.SourceFile,
    exists: (f: string) => boolean,
    parsed: (f: string) => ts.SourceFile,
): Refusal[] {
    const io: Lookup = { exists, parsed };
    const helpers: { sf: ts.SourceFile; name: string; reasonIndex: number; messageIndex: number }[] = [];
    const classes = errorClasses(errorsSf);
    const factories = errorFactories(errorsSf);
    const byReason = new Map<string, Refusal>();
    for (const file of files) {
        if (!/^src\/.+\.tsx?$/.test(file) || file === ERRORS_FILE) continue;
        const sf = parsed(file);
        walk(sf, (n) => {
            let cls: string | null = null;
            let args: readonly ts.Expression[] = [];
            if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && classes.has(n.expression.text)) {
                cls = n.expression.text;
                args = n.arguments ?? [];
            } else if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && factories.has(n.expression.text)) {
                const made = factories.get(n.expression.text)!;
                cls = ts.isIdentifier(made.expression) ? made.expression.text : null;
                args = n.arguments;
            }
            if (!cls) return;
            const found = reasonsOf(args, sf, io, n);
            if (found.length === 0) return;
            const base = classes.get(cls)!;
            let { code, status } = base;
            if (cls === 'DomainError') {
                code = literalText(args[1]) ?? 'DOMAIN_ERROR';
                status = args[2] && ts.isNumericLiteral(args[2]) ? Number(args[2].text) : 400;
            }
            const helper = found.length > 1 ? helperOf(n) : null;
            const statuses = helper ? statusTable(helper.fn, sf, io) : null;
            // A message written at the throw belongs to the one reason it names;
            // a helper that throws for a whole union takes its message from the
            // caller, and is read at its call sites below.
            const msg = found.length === 1 ? messageText(args[0], sf) : null;
            for (const reason of found) {
                // A helper that picks the error by a `REASON → status` table
                // answers each reason with ONE status: the table's.
                const fixed = statuses?.get(reason);
                if (fixed !== undefined && fixed !== status) continue;
                const hit = byReason.get(reason) ?? { reason, answers: [], messages: [], sites: [] };
                const answer = `${code} ${status}`;
                if (!hit.answers.includes(answer)) hit.answers.push(answer);
                if (msg && !hit.messages.includes(msg)) hit.messages.push(msg);
                if (!helper) hit.sites.push({ file, line: lineOf(sf, n) });
                byReason.set(reason, hit);
            }
            if (helper) helpers.push({ sf, ...helper });
        });
    }
    // The call sites of each helper: `refuse('OWNER_NOT_CONFIRMED', 'The owner …')`.
    for (const h of helpers) {
        walk(h.sf, (n) => {
            if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression) || n.expression.text !== h.name) return;
            const reason = literalText(n.arguments[h.reasonIndex]);
            const hit = reason ? byReason.get(reason) : undefined;
            if (!hit) return;
            const msg = h.messageIndex >= 0 ? messageText(n.arguments[h.messageIndex], h.sf) : null;
            if (msg && !hit.messages.includes(msg)) hit.messages.push(msg);
            const site = { file: h.sf.fileName, line: lineOf(h.sf, n) };
            if (!hit.sites.some((x) => x.file === site.file && x.line === site.line)) hit.sites.push(site);
        });
    }
    return [...byReason.values()].sort((a, b) => a.reason.localeCompare(b.reason));
}

/**
 * The named function a throw sits in, when it takes the reason as a
 * parameter: `function refuse(reason: Refusal, message: string)`.
 */
function helperOf(at: ts.Node): { name: string; fn: ts.FunctionLikeDeclaration; reasonIndex: number; messageIndex: number } | null {
    for (let n: ts.Node | undefined = at.parent; n; n = n.parent) {
        if (!ts.isFunctionLike(n)) continue;
        const fn = n as ts.FunctionLikeDeclaration;
        let name: string | null = null;
        if (ts.isFunctionDeclaration(fn) && fn.name) name = fn.name.text;
        else if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) {
            name = fn.parent.name.text;
        }
        if (!name) return null;
        const params = fn.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : ''));
        const reasonIndex = params.indexOf('reason');
        if (reasonIndex < 0) return null;
        return { name, fn, reasonIndex, messageIndex: params.indexOf('message') };
    }
    return null;
}

/** A `REASON → HTTP status` object a helper indexes by its reason, if it has one. */
function statusTable(fn: ts.FunctionLikeDeclaration, sf: ts.SourceFile, io: Lookup): Map<string, number> | null {
    let table: Map<string, number> | null = null;
    if (!fn.body) return null;
    walk(fn.body, (n) => {
        if (table || !ts.isElementAccessExpression(n) || !ts.isIdentifier(n.expression)) return;
        if (!ts.isIdentifier(n.argumentExpression) || n.argumentExpression.text !== 'reason') return;
        const found = topLevel(n.expression.text, sf, io);
        const init = found && ts.isVariableDeclaration(found.node) && found.node.initializer ? unwrap(found.node.initializer) : null;
        if (!init || !ts.isObjectLiteralExpression(init)) return;
        const m = new Map<string, number>();
        for (const p of init.properties) {
            if (ts.isPropertyAssignment(p) && p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && ts.isNumericLiteral(p.initializer)) {
                m.set(p.name.text, Number(p.initializer.text));
            }
        }
        if (m.size) table = m;
    });
    return table;
}
