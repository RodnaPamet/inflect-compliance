/**
 * PAYMENT CLIENT CALLS, READ OUT OF ONE FILE'S FACTS (Agent Pay Phase 2.1).
 *
 * `docs/ai-architecture/mastercard-agent-pay.md` Phase 2: the `code` source
 * reports that an agent's code CAN initiate a payment. The fact is a call to a
 * recognised payment CLIENT entry point, resolved through the file's own
 * imports exactly as `recognize.ts` resolves a LangChain factory: a local
 * function that happens to be called `wrapFetchWithPayment` is not x402's.
 *
 * What counts, by library (the contract's closed `PAYMENT_CLIENT_LIBRARIES`;
 * entry points read from each package's published exports on 2026-11-12):
 *
 *   x402-fetch   `wrapFetchWithPayment`
 *   x402-axios   `withPaymentInterceptor`
 *   @x402/fetch  `wrapFetchWithPayment`, `wrapFetchWithPaymentFromConfig`
 *   @x402/axios  `wrapAxiosWithPayment`, `wrapAxiosWithPaymentFromConfig`
 *   x402 (PyPI)  `x402Client`, `x402ClientSync` and the HTTP client wrappers of
 *                `x402.http.clients` (`x402HttpxClient`, `x402_requests`, …),
 *                also under the 1.x module path `x402.clients`
 *
 * Each is the PAYER side. The seller-side middleware (`x402-express`,
 * `x402-hono`, `x402-next`, `x402ResourceServer`) accepts payments, initiates
 * none, and is not a capability to spend.
 *
 * Three readings, and the third is the one that matters:
 *
 *   • CALLED, bound to a name (`const pay = wrapFetchWithPayment`), or USED AS
 *     A VALUE anywhere a call or a binding reads it (`compose(wrapFetch…)`,
 *     `{ pay: wrapFetch… }`, `getattr(x402, "x402Client")`, `mod["…"]`) → a
 *     capability at that line. A value use counts because an alias or a
 *     callback is the commonest way a call stops looking like one.
 *   • IMPORTED AND NEVER CALLED OR BOUND → nothing. An import is not a payment
 *     path, and a capability on every file that lists the package in an import
 *     would be a capability on none.
 *   • REACHED THROUGH A DYNAMIC IMPORT (`import(x)`, `require(x)` with anything
 *     but a literal, `__import__`, `import_module` however it was imported) in
 *     a file that names a payment library at all OR defines an agent →
 *     UNPARSEABLE at that line. So is `getattr(mod, name)` or `mod[name]` with
 *     a non-literal name on a payment module. Which member the code then calls
 *     is out of a static reader's sight, so the read stops vouching for the
 *     file rather than reporting it clean. A dynamic import of a LITERAL
 *     non-payment module is ordinary code and is left alone.
 *
 * NOT MET ONLY. The fact shows a capability; what limits the payment — a
 * wallet's allowance, a spend control, an issuer's token policy — is out of
 * the code's sight, so nothing here is evidence that a control works.
 *
 * ATTRIBUTION is to every agent the SAME file defines (`langchain.ts`). A
 * helper module that wraps the client for an agent defined elsewhere is not
 * followed across files, and a file with a payment call and no agent reports
 * nothing: both are stated limits of this reader, not "no capability". That is
 * why `[]` on the wire means "no payment client seen in the agent's file" and
 * why the planner never closes SPENDING_AGENT_UNDECLARED on it.
 *
 * Pure: reads the IR, never the code's behaviour.
 */
import type { PaymentClientLibrary, PaymentProtocol } from '@rodnapamet/scanent-contract/harness-contract';

import type { CallExpr, CodeLocation, Expr, FileFacts } from './ir';

/** The text that marks a file as naming a payment library at all; gates the dynamic-import rule. */
export const PAYMENT_MARKERS: readonly string[] = ['x402'];

export interface DetectedPaymentCall {
    readonly protocol: PaymentProtocol;
    readonly library: PaymentClientLibrary;
    /** The exported name the code reaches. */
    readonly entryPoint: string;
    readonly at: CodeLocation;
}

export interface PaymentDetection {
    readonly calls: readonly DetectedPaymentCall[];
    /** Dynamic imports in a payment-naming file: the source is UNPARSEABLE at each. */
    readonly unresolved: readonly CodeLocation[];
}

interface EntryPoints {
    readonly library: PaymentClientLibrary;
    readonly protocol: PaymentProtocol;
    readonly language: FileFacts['language'];
    /** The module (a JS package specifier, or a dotted Python module) a name is exported from. */
    readonly modules: ReadonlySet<string>;
    readonly names: ReadonlySet<string>;
}

const PY_HTTP_CLIENTS = [
    'x402HttpxClient',
    'wrapHttpxWithPayment',
    'wrapHttpxWithPaymentFromConfig',
    'x402_httpx_transport',
    'x402AsyncTransport',
    'x402_httpx_hooks',
    'x402_requests',
    'wrapRequestsWithPayment',
    'wrapRequestsWithPaymentFromConfig',
    'x402HTTPAdapter',
    'x402_http_adapter',
] as const;

/** Every recognised entry point. A Set per row, so a prototype key never matches. */
export const PAYMENT_ENTRY_POINTS: readonly EntryPoints[] = [
    { library: 'x402-fetch', protocol: 'x402', language: 'javascript', modules: new Set(['x402-fetch']), names: new Set(['wrapFetchWithPayment']) },
    { library: 'x402-axios', protocol: 'x402', language: 'javascript', modules: new Set(['x402-axios']), names: new Set(['withPaymentInterceptor']) },
    {
        library: '@x402/fetch',
        protocol: 'x402',
        language: 'javascript',
        modules: new Set(['@x402/fetch']),
        names: new Set(['wrapFetchWithPayment', 'wrapFetchWithPaymentFromConfig']),
    },
    {
        library: '@x402/axios',
        protocol: 'x402',
        language: 'javascript',
        modules: new Set(['@x402/axios']),
        names: new Set(['wrapAxiosWithPayment', 'wrapAxiosWithPaymentFromConfig']),
    },
    { library: 'x402', protocol: 'x402', language: 'python', modules: new Set(['x402']), names: new Set(['x402Client', 'x402ClientSync']) },
    {
        library: 'x402',
        protocol: 'x402',
        language: 'python',
        modules: new Set([
            'x402.http.clients',
            'x402.http.clients.httpx',
            'x402.http.clients.requests',
            'x402.clients',
            'x402.clients.httpx',
            'x402.clients.requests',
        ]),
        names: new Set(PY_HTTP_CLIENTS),
    },
];

/** Is this module one a recognised payment library exports from? */
function isPaymentModule(module: string, language: FileFacts['language']): boolean {
    if (language === 'python') return module === 'x402' || module.startsWith('x402.');
    return PAYMENT_ENTRY_POINTS.some((e) => e.language === 'javascript' && e.modules.has(module));
}

/** A literal, non-template string, or null. */
function literalOf(e: Expr | undefined): string | null {
    return e !== undefined && e.k === 'str' && !e.template ? e.value : null;
}

/** `getattr(obj, name)` with the builtin, not a name the file imported. */
function isGetattr(call: CallExpr, facts: FileFacts): boolean {
    return facts.language === 'python' && call.fn.k === 'ref' && call.fn.name === 'getattr' && !facts.imports.has('getattr');
}

/**
 * What a name or attribute chain resolves to through the file's imports: the
 * module and the member path below it, or null. Python's dotted modules are
 * normalised so `from x402.http import clients` + `clients.httpx.x402HttpxClient`
 * and `from x402.http.clients.httpx import x402HttpxClient` meet. A literal
 * subscript (`mod["name"]`) and `getattr(mod, "name")` are member access too.
 */
function resolve(e: Expr, facts: FileFacts, depth = 0): { module: string; members: string[] } | null {
    if (depth > 16) return null;
    const member = (obj: Expr, name: string) => {
        const head = resolve(obj, facts, depth + 1);
        return head ? { module: head.module, members: [...head.members, name] } : null;
    };
    if (e.k === 'ref') {
        const q = facts.imports.get(e.name);
        return q ? { module: q.module, members: [...q.path] } : null;
    }
    if (e.k === 'attr') return member(e.obj, e.name);
    if (e.k === 'sub') {
        const key = literalOf(e.key);
        return key === null ? null : member(e.obj, key);
    }
    if (e.k === 'call' && isGetattr(e, facts) && e.args.length >= 2) {
        const name = literalOf(e.args[1]);
        return name === null ? null : member(e.args[0], name);
    }
    return null;
}

/** Does this expression resolve into a payment library's module at all? */
function isPaymentReach(e: Expr, facts: FileFacts): boolean {
    const r = resolve(e, facts);
    if (r === null) return false;
    if (facts.language === 'python') return isPaymentModule([r.module, ...r.members].join('.'), 'python');
    return isPaymentModule(r.module, 'javascript');
}

function entryPointOf(e: Expr, facts: FileFacts): { entry: EntryPoints; name: string } | null {
    const r = resolve(e, facts);
    if (r === null || r.members.length === 0) return null;
    if (facts.language === 'python') {
        const dotted = [r.module, ...r.members];
        const name = dotted[dotted.length - 1];
        const owner = dotted.slice(0, -1).join('.');
        const entry = PAYMENT_ENTRY_POINTS.find((p) => p.language === 'python' && p.modules.has(owner) && p.names.has(name));
        return entry ? { entry, name } : null;
    }
    if (r.members.length !== 1) return null;
    const name = r.members[0];
    const entry = PAYMENT_ENTRY_POINTS.find((p) => p.language === 'javascript' && p.modules.has(r.module) && p.names.has(name));
    return entry ? { entry, name } : null;
}

/** Is this call's callee `importlib.import_module`, however the file reached it? */
function isImportModule(fn: Expr, facts: FileFacts): boolean {
    if (fn.k === 'attr') return fn.name === 'import_module';
    if (fn.k !== 'ref') return false;
    const q = facts.imports.get(fn.name);
    if (q !== undefined) return q.module === 'importlib' && q.path.length === 1 && q.path[0] === 'import_module';
    return fn.name === 'import_module';
}

/** A dynamic import, and the module it names when that is a literal. */
function dynamicImportOf(call: CallExpr, facts: FileFacts): { literal: string | null } | null {
    const fn = call.fn;
    const isDynamic =
        (fn.k === 'ref' && !facts.imports.has(fn.name) && (fn.name === 'import' || fn.name === 'require' || fn.name === '__import__'))
        || isImportModule(fn, facts);
    if (!isDynamic) return null;
    return { literal: literalOf(call.args[0]) };
}

/** Every node of an expression, outermost first. Bounded like `callsWithin`. */
function nodesWithin(e: Expr, out: Expr[] = [], depth = 0): Expr[] {
    if (depth > 64) return out;
    out.push(e);
    switch (e.k) {
        case 'call':
            nodesWithin(e.fn, out, depth + 1);
            for (const a of e.args) nodesWithin(a, out, depth + 1);
            for (const v of e.kwargs.values()) nodesWithin(v, out, depth + 1);
            return out;
        case 'attr':
            return nodesWithin(e.obj, out, depth + 1);
        case 'sub':
            nodesWithin(e.obj, out, depth + 1);
            return nodesWithin(e.key, out, depth + 1);
        case 'list':
            for (const i of e.items) nodesWithin(i, out, depth + 1);
            return out;
        case 'dict':
            for (const [, v] of e.entries) nodesWithin(v, out, depth + 1);
            return out;
        case 'concat':
            for (const p of e.parts) nodesWithin(p, out, depth + 1);
            return out;
        default:
            return out;
    }
}

/** Read the payment client calls, and the dynamic imports that hide one, out of one file's facts. */
export function recognizePaymentCalls(
    facts: FileFacts,
    file: { readonly label: string; readonly path: string; readonly text: string },
    opts: { readonly definesAgent?: boolean } = {},
): PaymentDetection {
    const at = (line: number): CodeLocation => ({ label: file.label, path: file.path, line });
    const calls: DetectedPaymentCall[] = [];
    const seen = new Set<string>();
    const add = (entry: EntryPoints, name: string, line: number) => {
        const key = `${entry.library}\u0000${line}`;
        if (seen.has(key)) return;
        seen.add(key);
        calls.push({ protocol: entry.protocol, library: entry.library, entryPoint: name, at: at(line) });
    };
    const unresolvedLines = new Set<number>();

    // Every expression a call or a binding reads: the callee, every argument,
    // every option and every value inside them. An entry point anywhere in
    // that is a capability at its line; a non-literal member read of a payment
    // module (`getattr(m, name)`, `m[name]`) is out of sight.
    const roots: Expr[] = [...facts.calls.map((c) => c.call)];
    for (const bindings of facts.bindings.values()) for (const b of bindings) roots.push(b.expr);
    for (const root of roots) {
        for (const node of nodesWithin(root)) {
            const hit = entryPointOf(node, facts);
            if (hit !== null) {
                add(hit.entry, hit.name, node.line);
                continue;
            }
            if (node.k === 'sub' && literalOf(node.key) === null && isPaymentReach(node.obj, facts)) unresolvedLines.add(node.line);
            if (node.k === 'call' && isGetattr(node, facts) && node.args.length >= 2 && literalOf(node.args[1]) === null
                && isPaymentReach(node.args[0], facts)) {
                unresolvedLines.add(node.line);
            }
        }
    }

    if (opts.definesAgent === true || PAYMENT_MARKERS.some((m) => file.text.includes(m))) {
        // A `const { x } = require('lit')` the reader resolved into an import is
        // read like any import; the same call used inline is not, and is held.
        const imported = new Set([...facts.imports.values()].map((q) => q.module));
        for (const { call } of facts.calls) {
            const dyn = dynamicImportOf(call, facts);
            if (dyn === null) continue;
            if (dyn.literal !== null && !isPaymentModule(dyn.literal, facts.language)) continue;
            if (dyn.literal !== null && call.fn.k === 'ref' && call.fn.name === 'require' && imported.has(dyn.literal)) continue;
            unresolvedLines.add(call.line);
        }
    }

    calls.sort((a, b) => a.at.line - b.at.line || (a.library < b.library ? -1 : a.library > b.library ? 1 : 0));
    const unresolved = [...unresolvedLines].sort((a, b) => a - b).map(at);
    return { calls, unresolved };
}
