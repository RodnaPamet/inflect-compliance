/**
 * A BOUNDED LEXICAL READER FOR PYTHON (#3737) — text in, `FileFacts` out.
 *
 * Why not a real Python parser: the scanner is TypeScript, and the options were
 * a WebAssembly grammar (a new dependency and its supply chain), a Python
 * subprocess (which would put an interpreter, and the scanned repository's own
 * `sitecustomize`/`.pth` hooks, one flag away from running client code), or
 * this. A LangChain agent definition is a handful of imports, assignments and
 * calls with keyword arguments; reading those needs a tokenizer that gets
 * strings, comments and brackets exactly right, and a small expression parser
 * over the tokens. Everything it does not understand becomes `opaque`, which
 * the recogniser reports as UNPARSEABLE where it matters — never as nothing.
 *
 * It never evaluates anything: no `eval`, no import, no subprocess. Every loop
 * consumes at least one token or stops, and expression nesting is capped, so a
 * hostile file costs time proportional to its (capped) size and no more.
 */
import {
    callsWithin,
    type Binding,
    type CallExpr,
    type Expr,
    type FileFacts,
    type Qualified,
    type ToolDeclaration,
} from './ir';

type Tok =
    | { readonly t: 'name'; readonly v: string; readonly line: number }
    | { readonly t: 'str'; readonly v: string; readonly template: boolean; readonly line: number }
    | { readonly t: 'num'; readonly line: number }
    | { readonly t: 'op'; readonly v: string; readonly line: number }
    | { readonly t: 'nl'; readonly line: number };

/** The file is not Python this reader can tokenize: an unterminated string, unbalanced brackets, a stray character. */
export class PythonReadError extends Error {
    constructor(readonly line: number, message: string) {
        super(`line ${line}: ${message}`);
        this.name = 'PythonReadError';
    }
}

const MAX_DEPTH = 64;

const KEYWORDS: ReadonlySet<string> = new Set([
    'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
    'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass',
    'raise', 'return', 'try', 'while', 'with', 'yield', 'True', 'False', 'None', 'match', 'case',
]);
/** Soft keywords that are also ordinary names. */
const SOFT_KEYWORDS: ReadonlySet<string> = new Set(['match', 'case']);

const OPS3 = ['**=', '//=', '>>=', '<<=', '...'];
const OPS2 = ['**', '//', '>>', '<<', '<=', '>=', '==', '!=', '->', ':=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '@='];
const OPS1 = '+-*/%@&|^~<>()[]{}.,:;=!';
const CLOSERS: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };
const STRING_PREFIX = /^(?:r|u|f|b|br|rb|fr|rf)$/i;

function isNameStart(ch: string): boolean {
    return /[A-Za-z_]/.test(ch) || ch.charCodeAt(0) > 0x7f;
}
function isNameChar(ch: string): boolean {
    return /[A-Za-z0-9_]/.test(ch) || ch.charCodeAt(0) > 0x7f;
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '0': '\0' };

export function tokenizePython(src: string): Tok[] {
    const toks: Tok[] = [];
    const brackets: string[] = [];
    let i = 0;
    let line = 1;
    const n = src.length;
    const newline = () => {
        if (brackets.length === 0 && toks.length > 0 && toks[toks.length - 1].t !== 'nl') toks.push({ t: 'nl', line });
    };

    while (i < n) {
        const c = src[i];
        if (c === '\n') {
            newline();
            line += 1;
            i += 1;
            continue;
        }
        if (c === '\r' || c === ' ' || c === '\t' || c === '\f' || c === '\v') {
            i += 1;
            continue;
        }
        if (c === '#') {
            while (i < n && src[i] !== '\n') i += 1;
            continue;
        }
        if (c === '\\') {
            // An explicit line continuation joins two physical lines.
            const next = src[i + 1] === '\r' ? src[i + 2] : src[i + 1];
            if (next !== '\n') throw new PythonReadError(line, 'a backslash outside a string must end the line');
            i += src[i + 1] === '\r' ? 3 : 2;
            line += 1;
            continue;
        }

        let prefix = '';
        let j = i;
        if (isNameStart(c)) {
            while (j < n && isNameChar(src[j])) j += 1;
            const word = src.slice(i, j);
            if (!(STRING_PREFIX.test(word) && (src[j] === '"' || src[j] === "'"))) {
                toks.push({ t: 'name', v: word, line });
                i = j;
                continue;
            }
            prefix = word;
        }
        if (src[j] === '"' || src[j] === "'") {
            const quote = src[j];
            const triple = src.startsWith(quote.repeat(3), j);
            const raw = /r/i.test(prefix);
            const startLine = line;
            let k = j + (triple ? 3 : 1);
            let value = '';
            for (;;) {
                if (k >= n) throw new PythonReadError(startLine, 'unterminated string');
                const ch = src[k];
                if (ch === '\\') {
                    if (k + 1 >= n) throw new PythonReadError(startLine, 'unterminated string');
                    const esc = src[k + 1];
                    if (esc === '\n') line += 1;
                    value += raw ? ch + esc : (SIMPLE_ESCAPES[esc] ?? ch + esc);
                    k += 2;
                    continue;
                }
                if (triple) {
                    if (src.startsWith(quote.repeat(3), k)) {
                        k += 3;
                        break;
                    }
                } else if (ch === quote) {
                    k += 1;
                    break;
                } else if (ch === '\n') {
                    throw new PythonReadError(startLine, 'unterminated string');
                }
                if (ch === '\n') line += 1;
                value += ch;
                k += 1;
            }
            toks.push({ t: 'str', v: value, template: /f/i.test(prefix), line: startLine });
            i = k;
            continue;
        }
        if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
            j = i + 1;
            while (j < n && (/[0-9A-Za-z_.]/.test(src[j]) || (/[eE]/.test(src[j - 1]) && /[+-]/.test(src[j])))) j += 1;
            toks.push({ t: 'num', line });
            i = j;
            continue;
        }
        const op = OPS3.find((o) => src.startsWith(o, i)) ?? OPS2.find((o) => src.startsWith(o, i)) ?? (OPS1.includes(c) ? c : null);
        if (op === null) throw new PythonReadError(line, 'a character Python does not allow here');
        if (op === '(' || op === '[' || op === '{') brackets.push(op);
        if (op in CLOSERS) {
            if (brackets.pop() !== CLOSERS[op]) throw new PythonReadError(line, 'unbalanced brackets');
        }
        toks.push({ t: 'op', v: op, line });
        i += op.length;
    }
    if (brackets.length > 0) throw new PythonReadError(line, 'unbalanced brackets');
    newline();
    return toks;
}

// ─── The expression parser, over one logical line's tokens ───────────────────

const STOP_OPS: ReadonlySet<string> = new Set([',', ')', ']', '}', ':', '=', ';', '->', ':=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '@=', '**=', '//=', '>>=', '<<=']);
const BINARY_OPS: ReadonlySet<string> = new Set(['+', '-', '*', '/', '//', '%', '@', '|', '&', '^', '<<', '>>', '**', '<', '>', '==', '!=', '<=', '>=']);
const BINARY_WORDS: ReadonlySet<string> = new Set(['and', 'or', 'in', 'is', 'not']);

class LineParser {
    private i = 0;
    constructor(private readonly toks: readonly Tok[]) {}

    get done(): boolean {
        return this.i >= this.toks.length;
    }
    peek(offset = 0): Tok | undefined {
        return this.toks[this.i + offset];
    }
    next(): Tok | undefined {
        const t = this.toks[this.i];
        this.i += 1;
        return t;
    }
    isOp(v: string, offset = 0): boolean {
        const t = this.peek(offset);
        return t !== undefined && t.t === 'op' && t.v === v;
    }
    isName(v: string, offset = 0): boolean {
        const t = this.peek(offset);
        return t !== undefined && t.t === 'name' && t.v === v;
    }
    get line(): number {
        return this.peek()?.line ?? this.toks[this.toks.length - 1]?.line ?? 0;
    }

    /** Skip one bracketed group, or one token. Brackets are balanced: the tokenizer refused otherwise. */
    skipOne(): void {
        const t = this.next();
        if (t?.t === 'op' && (t.v === '(' || t.v === '[' || t.v === '{')) {
            let depth = 1;
            while (!this.done && depth > 0) {
                const u = this.next();
                if (u?.t !== 'op') continue;
                if (u.v === '(' || u.v === '[' || u.v === '{') depth += 1;
                else if (u.v === ')' || u.v === ']' || u.v === '}') depth -= 1;
            }
        }
    }

    /** Skip to a stop at this level: one of `stops`, or a closing bracket. */
    skipTo(stops: ReadonlySet<string>): void {
        while (!this.done) {
            const t = this.peek()!;
            if (t.t === 'op' && (stops.has(t.v) || t.v === ')' || t.v === ']' || t.v === '}')) return;
            this.skipOne();
        }
    }

    private atStop(): boolean {
        const t = this.peek();
        if (t === undefined) return true;
        if (t.t === 'op') return STOP_OPS.has(t.v);
        return t.t === 'name' && (t.v === 'for' || t.v === 'if' || t.v === 'else' || t.v === 'as' || t.v === 'from' || t.v === 'async');
    }

    expr(depth = 0): Expr {
        const line = this.line;
        if (depth > MAX_DEPTH) {
            this.skipTo(new Set([',']));
            return { k: 'opaque', line };
        }
        let left = this.unary(depth);
        let opaque = false;
        const parts: Expr[] = [left];
        for (;;) {
            const t = this.peek();
            if (t === undefined) break;
            if (t.t === 'op' && BINARY_OPS.has(t.v)) {
                this.next();
                const right = this.unary(depth + 1);
                if (t.v === '+') parts.push(right);
                else opaque = true;
                continue;
            }
            if (t.t === 'name' && BINARY_WORDS.has(t.v)) {
                this.next();
                if (t.v === 'not' && this.isName('in')) this.next();
                if (t.v === 'is' && this.isName('not')) this.next();
                this.unary(depth + 1);
                opaque = true;
                continue;
            }
            if (t.t === 'name' && t.v === 'if' && depth >= 0) {
                // `a if cond else b`: which branch runs is not knowable here.
                const save = this.i;
                this.next();
                this.expr(depth + 1);
                if (this.isName('else')) {
                    this.next();
                    this.expr(depth + 1);
                    opaque = true;
                    continue;
                }
                this.i = save;
            }
            break;
        }
        if (opaque) return { k: 'opaque', line };
        if (parts.length > 1) left = { k: 'concat', parts, line };
        return left;
    }

    private unary(depth: number): Expr {
        const line = this.line;
        const t = this.peek();
        if (t === undefined) return { k: 'opaque', line };
        if (t.t === 'op' && (t.v === '-' || t.v === '+' || t.v === '~')) {
            this.next();
            this.unary(depth + 1);
            return { k: 'opaque', line };
        }
        if (t.t === 'name' && t.v === 'not') {
            this.next();
            this.unary(depth + 1);
            return { k: 'opaque', line };
        }
        if (t.t === 'name' && t.v === 'await') {
            this.next();
            return this.unary(depth + 1);
        }
        if (t.t === 'name' && t.v === 'lambda') {
            this.next();
            this.skipTo(new Set([':']));
            if (this.isOp(':')) this.next();
            this.expr(depth + 1);
            return { k: 'func', line };
        }
        return this.postfix(this.primary(depth), depth);
    }

    private primary(depth: number): Expr {
        const line = this.line;
        const t = this.peek();
        if (t === undefined || this.atStop()) return { k: 'opaque', line };
        if (t.t === 'name') {
            if (KEYWORDS.has(t.v) && !SOFT_KEYWORDS.has(t.v)) {
                this.next();
                return { k: 'opaque', line };
            }
            this.next();
            return { k: 'ref', name: t.v, line };
        }
        if (t.t === 'str') {
            let value = '';
            let template = false;
            while (this.peek()?.t === 'str') {
                const s = this.next() as Extract<Tok, { t: 'str' }>;
                value += s.v;
                template = template || s.template;
            }
            return { k: 'str', value, template, line };
        }
        if (t.t === 'num') {
            this.next();
            return { k: 'opaque', line };
        }
        if (t.t === 'op') {
            if (t.v === '(') return this.group(depth);
            if (t.v === '[') return this.list(depth);
            if (t.v === '{') return this.dict(depth);
            this.next();
        }
        return { k: 'opaque', line };
    }

    /** `( … )`: a parenthesised expression, a tuple (read as a list), or a generator (opaque). */
    private group(depth: number): Expr {
        const line = this.line;
        this.next();
        if (this.isOp(')')) {
            this.next();
            return { k: 'opaque', line };
        }
        const first = this.starred(depth);
        if (this.isName('for') || this.isName('async')) {
            this.skipTo(new Set());
            this.next();
            return { k: 'opaque', line };
        }
        if (this.isOp(')')) {
            this.next();
            return first;
        }
        const items = [first];
        while (this.isOp(',')) {
            this.next();
            if (this.isOp(')')) break;
            items.push(this.starred(depth));
        }
        this.skipTo(new Set());
        this.next();
        return { k: 'list', items, spread: false, line };
    }

    /** An element that may be `*x`, read as `x`: the recogniser flattens a list inside a list. */
    private starred(depth: number): Expr {
        if (this.isOp('*')) this.next();
        return this.expr(depth + 1);
    }

    private list(depth: number): Expr {
        const line = this.line;
        this.next();
        const items: Expr[] = [];
        while (!this.isOp(']') && !this.done) {
            items.push(this.starred(depth));
            if (this.isName('for') || this.isName('async')) {
                // A comprehension builds its list at run time.
                this.skipTo(new Set());
                this.next();
                return { k: 'opaque', line };
            }
            if (this.isOp(',')) {
                this.next();
                continue;
            }
            if (!this.isOp(']')) this.skipTo(new Set([',']));
            if (this.isOp(',')) this.next();
        }
        this.next();
        return { k: 'list', items, spread: false, line };
    }

    private dict(depth: number): Expr {
        const line = this.line;
        this.next();
        const entries: (readonly [string | null, Expr])[] = [];
        let spread = false;
        let isSet = false;
        while (!this.isOp('}') && !this.done) {
            if (this.isOp('**')) {
                this.next();
                this.expr(depth + 1);
                spread = true;
            } else {
                const key = this.expr(depth + 1);
                if (this.isName('for') || this.isName('async')) {
                    this.skipTo(new Set());
                    this.next();
                    return { k: 'opaque', line };
                }
                if (this.isOp(':')) {
                    this.next();
                    const value = this.expr(depth + 1);
                    if (this.isName('for') || this.isName('async')) {
                        this.skipTo(new Set());
                        this.next();
                        return { k: 'opaque', line };
                    }
                    entries.push([key.k === 'str' && !key.template ? key.value : null, value]);
                } else {
                    isSet = true;
                }
            }
            if (this.isOp(',')) {
                this.next();
                continue;
            }
            if (!this.isOp('}')) this.skipTo(new Set([',']));
            if (this.isOp(',')) this.next();
        }
        this.next();
        return isSet ? { k: 'opaque', line } : { k: 'dict', entries, spread, line };
    }

    private postfix(base: Expr, depth: number): Expr {
        let e = base;
        for (let guard = 0; guard < 256; guard++) {
            const line = this.line;
            if (this.isOp('.')) {
                this.next();
                const t = this.peek();
                if (t?.t !== 'name') return { k: 'opaque', line };
                this.next();
                e = { k: 'attr', obj: e, name: t.v, line };
                continue;
            }
            if (this.isOp('(')) {
                e = this.call(e, depth);
                continue;
            }
            if (this.isOp('[')) {
                this.next();
                const key = this.expr(depth + 1);
                const sliced = !this.isOp(']');
                this.skipTo(new Set());
                this.next();
                e = sliced ? { k: 'opaque', line } : { k: 'sub', obj: e, key, line };
                continue;
            }
            break;
        }
        return e;
    }

    private call(fn: Expr, depth: number): CallExpr {
        const line = this.line;
        this.next();
        const args: Expr[] = [];
        const kwargs = new Map<string, Expr>();
        let spread = false;
        while (!this.isOp(')') && !this.done) {
            if (this.isOp('**') || this.isOp('*')) {
                this.next();
                this.expr(depth + 1);
                spread = true;
            } else {
                const t = this.peek();
                if (t?.t === 'name' && this.isOp('=', 1)) {
                    this.next();
                    this.next();
                    kwargs.set(t.v, this.expr(depth + 1));
                } else {
                    const value = this.expr(depth + 1);
                    if (this.isName('for') || this.isName('async')) {
                        this.skipTo(new Set());
                        args.push({ k: 'opaque', line: value.line });
                        continue;
                    }
                    args.push(value);
                }
            }
            if (this.isOp(',')) {
                this.next();
                continue;
            }
            if (!this.isOp(')')) this.skipTo(new Set([',']));
            if (this.isOp(',')) this.next();
        }
        this.next();
        return { k: 'call', fn, args, kwargs, spread, line };
    }
}

// ─── Statements ─────────────────────────────────────────────────────────────

function logicalLines(toks: readonly Tok[]): Tok[][] {
    const lines: Tok[][] = [];
    let current: Tok[] = [];
    for (const t of toks) {
        if (t.t === 'nl' || (t.t === 'op' && t.v === ';')) {
            if (current.length > 0) lines.push(current);
            current = [];
            continue;
        }
        current.push(t);
    }
    if (current.length > 0) lines.push(current);
    return lines;
}

/** `a.b.c` from a run of name and `.` tokens, starting at `i`. */
function dotted(toks: readonly Tok[], i: number): { name: string; end: number } | null {
    const parts: string[] = [];
    let j = i;
    while (j < toks.length) {
        const t = toks[j];
        if (t.t !== 'name') break;
        parts.push(t.v);
        j += 1;
        const dot = toks[j];
        if (!(dot?.t === 'op' && dot.v === '.')) break;
        j += 1;
    }
    return parts.length === 0 ? null : { name: parts.join('.'), end: j };
}

/** The dotted key a binding target names (`x`, `self.llm`), or null for anything else. */
function targetKey(toks: readonly Tok[]): string | null {
    // `x: Annotation = …` binds `x`.
    const colon = toks.findIndex((t) => t.t === 'op' && t.v === ':');
    const target = colon > 0 ? toks.slice(0, colon) : toks;
    const d = dotted(target, 0);
    if (d === null || d.end !== target.length) return null;
    return d.name;
}

/** Read one file's imports, bindings, tool declarations and calls. Throws `PythonReadError`. */
export function readPython(src: string): FileFacts {
    const toks = tokenizePython(src);
    const imports = new Map<string, Qualified>();
    const bindings = new Map<string, Binding[]>();
    const toolDeclarations = new Map<string, ToolDeclaration>();
    const calls: { call: CallExpr; boundTo: string | null }[] = [];
    const starModules: string[] = [];
    let decorators: { expr: Expr; line: number }[] = [];

    const bind = (key: string, expr: Expr, line: number) => {
        const list = bindings.get(key) ?? [];
        list.push({ line, expr });
        bindings.set(key, list);
    };
    const collect = (expr: Expr, boundTo: string | null) => {
        const found = callsWithin(expr);
        found.forEach((c, i) => calls.push({ call: c, boundTo: i === 0 && expr.k === 'call' ? boundTo : null }));
    };
    /** Every expression on a line this reader has no statement rule for, read for its calls. */
    const scan = (lineToks: readonly Tok[]) => {
        const p = new LineParser(lineToks);
        while (!p.done) {
            const t = p.peek()!;
            if ((t.t === 'name' && (!KEYWORDS.has(t.v) || SOFT_KEYWORDS.has(t.v) || t.v === 'await')) || t.t === 'str'
                || (t.t === 'op' && (t.v === '(' || t.v === '[' || t.v === '{'))) {
                const before = p.peek();
                collect(p.expr(), null);
                if (p.peek() === before) p.next();
            } else {
                p.next();
            }
        }
    };
    const qualifyDecorator = (e: Expr): string | null => {
        const fn = e.k === 'call' ? e.fn : e;
        if (fn.k === 'ref') {
            const q = imports.get(fn.name);
            return q ? [q.module, ...q.path].join('.') : null;
        }
        if (fn.k === 'attr' && fn.obj.k === 'ref') {
            const q = imports.get(fn.obj.name);
            return q ? [q.module, ...q.path, fn.name].join('.') : null;
        }
        return null;
    };
    const isToolDecorator = (e: Expr) => {
        const q = qualifyDecorator(e);
        return q !== null && /^langchain[\w.]*\.tool$/.test(q);
    };

    for (const lineToks of logicalLines(toks)) {
        const first = lineToks[0];
        const line = first.line;

        if (first.t === 'op' && first.v === '@') {
            decorators.push({ expr: new LineParser(lineToks.slice(1)).expr(), line });
            continue;
        }
        const pending = decorators;
        decorators = [];

        if (first.t === 'name' && first.v === 'from') {
            const d = dotted(lineToks, 1);
            if (d === null || !(lineToks[d.end]?.t === 'name' && (lineToks[d.end] as { v: string }).v === 'import')) continue;
            const moduleName = d.name;
            let j = d.end + 1;
            while (j < lineToks.length) {
                const t = lineToks[j];
                if (t.t === 'op' && t.v === '*') {
                    starModules.push(moduleName);
                    j += 1;
                    continue;
                }
                if (t.t !== 'name') {
                    j += 1;
                    continue;
                }
                const imported = t.v;
                let local = imported;
                if (lineToks[j + 1]?.t === 'name' && (lineToks[j + 1] as { v: string }).v === 'as' && lineToks[j + 2]?.t === 'name') {
                    local = (lineToks[j + 2] as { v: string }).v;
                    j += 3;
                } else {
                    j += 1;
                }
                imports.set(local, { module: moduleName, path: [imported] });
            }
            continue;
        }
        if (first.t === 'name' && first.v === 'import') {
            let j = 1;
            while (j < lineToks.length) {
                const d = dotted(lineToks, j);
                if (d === null) {
                    j += 1;
                    continue;
                }
                const as = lineToks[d.end];
                if (as?.t === 'name' && as.v === 'as' && lineToks[d.end + 1]?.t === 'name') {
                    imports.set((lineToks[d.end + 1] as { v: string }).v, { module: d.name, path: [] });
                    j = d.end + 2;
                } else {
                    const head = d.name.split('.')[0];
                    if (!imports.has(head)) imports.set(head, { module: head, path: [] });
                    j = d.end;
                }
            }
            continue;
        }

        const isAsync = first.t === 'name' && first.v === 'async';
        const head = isAsync ? lineToks[1] : first;
        if (head?.t === 'name' && head.v === 'def') {
            const nameTok = lineToks[isAsync ? 2 : 1];
            if (nameTok?.t === 'name') {
                const tool = pending.find((d) => isToolDecorator(d.expr));
                if (tool !== undefined) {
                    const declared = tool.expr.k === 'call' ? tool.expr.args[0] : undefined;
                    const toolName = declared?.k === 'str' && !declared.template ? declared.value : nameTok.v;
                    toolDeclarations.set(nameTok.v, { line: nameTok.line, toolName });
                }
                // Defaults in the signature can hold calls (`llm=ChatOpenAI()`).
                scan(lineToks.slice(isAsync ? 3 : 2));
            }
            continue;
        }
        if (first.t === 'name' && first.v === 'class') {
            const nameTok = lineToks[1];
            if (nameTok?.t === 'name' && lineToks[2]?.t === 'op' && (lineToks[2] as { v: string }).v === '(') {
                const bases = new LineParser(lineToks.slice(2));
                const baseList = bases.expr();
                const items = baseList.k === 'list' ? baseList.items : [baseList];
                const isTool = items.some((b) => {
                    const q = qualifyDecorator(b);
                    return q !== null && /^langchain[\w.]*\.(BaseTool|StructuredTool|Tool)$/.test(q);
                });
                if (isTool) toolDeclarations.set(nameTok.v, { line: nameTok.line, toolName: nameTok.v });
            }
            continue;
        }
        if ((first.t === 'name' && first.v === 'for') || (isAsync && head?.t === 'name' && head.v === 'for')) {
            // `for target in iterable:` runs the iterable, which is often a call:
            // `async for message in query(...)` is how the Agent SDK is driven
            // (#4156). The expression reader treats `in` as an operator whose
            // operands it does not keep, so the iterable is read on its own.
            let depth = 0;
            let inAt = -1;
            let colonAt = -1;
            for (let j = isAsync ? 2 : 1; j < lineToks.length; j++) {
                const t = lineToks[j];
                if (t.t === 'op' && (t.v === '(' || t.v === '[' || t.v === '{')) depth += 1;
                else if (t.t === 'op' && (t.v === ')' || t.v === ']' || t.v === '}')) depth -= 1;
                else if (depth === 0 && inAt < 0 && t.t === 'name' && t.v === 'in') inAt = j;
                else if (depth === 0 && inAt >= 0 && t.t === 'op' && t.v === ':') {
                    colonAt = j;
                    break;
                }
            }
            if (inAt >= 0) {
                const end = colonAt >= 0 ? colonAt : lineToks.length;
                collect(new LineParser(lineToks.slice(inAt + 1, end)).expr(), null);
                // A body written on the same line.
                if (colonAt >= 0 && colonAt + 1 < lineToks.length) scan(lineToks.slice(colonAt + 1));
                continue;
            }
        }
        if ((first.t === 'name' && first.v === 'with') || (isAsync && head?.t === 'name' && head.v === 'with')) {
            // `with Client(...) as client:` binds `client` to the context manager.
            const p = new LineParser(lineToks.slice(isAsync ? 2 : 1));
            while (!p.done) {
                const value = p.expr();
                collect(value, null);
                if (p.isName('as') && p.peek(1)?.t === 'name') {
                    p.next();
                    const name = (p.next() as { v: string }).v;
                    bind(name, value, line);
                }
                if (p.isOp(',')) {
                    p.next();
                    continue;
                }
                break;
            }
            continue;
        }

        // An assignment: the LAST top-level `=` splits targets from the value.
        let depth = 0;
        const splits: number[] = [];
        let augmented: { at: number; op: string } | null = null;
        lineToks.forEach((t, idx) => {
            if (t.t !== 'op') return;
            if (t.v === '(' || t.v === '[' || t.v === '{') depth += 1;
            else if (t.v === ')' || t.v === ']' || t.v === '}') depth -= 1;
            else if (depth === 0 && t.v === '=') splits.push(idx);
            else if (depth === 0 && t.v === '+=' && augmented === null) augmented = { at: idx, op: t.v };
        });
        if (first.t === 'name' && !KEYWORDS.has(first.v) && splits.length > 0) {
            const last = splits[splits.length - 1];
            const value = new LineParser(lineToks.slice(last + 1)).expr();
            let start = 0;
            let boundTo: string | null = null;
            for (const s of splits) {
                const key = targetKey(lineToks.slice(start, s));
                if (key !== null) {
                    bind(key, value, line);
                    boundTo = boundTo ?? key;
                }
                start = s + 1;
            }
            collect(value, boundTo);
            continue;
        }
        const aug = augmented as { at: number; op: string } | null;
        if (first.t === 'name' && aug !== null) {
            const key = targetKey(lineToks.slice(0, aug.at));
            const value = new LineParser(lineToks.slice(aug.at + 1)).expr();
            if (key !== null) bind(key, { k: 'concat', parts: [{ k: 'ref', name: key, line }, value], line }, line);
            collect(value, null);
            continue;
        }
        scan(lineToks);
    }

    // A name `from langchain_x import *` could have bound is qualified against
    // the first such module: membership is by family and name, so which of
    // several star modules it came from does not change what it is.
    if (starModules.length > 0) {
        for (const c of calls) {
            const fn = c.call.fn;
            if (fn.k === 'ref' && !imports.has(fn.name) && !bindings.has(fn.name) && !toolDeclarations.has(fn.name)) {
                imports.set(fn.name, { module: starModules[0], path: [fn.name] });
            }
        }
    }

    return { language: 'python', imports, bindings, toolDeclarations, calls };
}
