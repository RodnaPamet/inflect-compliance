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
 *   • CALLED, or bound to a name (`const pay = wrapFetchWithPayment`) → a
 *     capability at that line. Binding counts because an alias is the commonest
 *     way a call stops looking like one.
 *   • IMPORTED AND NEVER CALLED OR BOUND → nothing. An import is not a payment
 *     path, and a capability on every file that lists the package in an import
 *     would be a capability on none.
 *   • REACHED THROUGH A DYNAMIC IMPORT (`import(x)`, `require(x)` with anything
 *     but a literal, `__import__`, `importlib.import_module`) in a file that
 *     names a payment library at all → UNPARSEABLE at that line. Which member
 *     the code then calls is out of a static reader's sight, so the read stops
 *     vouching for the file rather than reporting it clean. A dynamic import of
 *     a LITERAL non-payment module is ordinary code and is left alone.
 *
 * NOT MET ONLY. The fact shows a capability; what limits the payment — a
 * wallet's allowance, a spend control, an issuer's token policy — is out of
 * the code's sight, so nothing here is evidence that a control works.
 *
 * ATTRIBUTION is to every agent the SAME file defines (`langchain.ts`). A
 * helper module that wraps the client for an agent defined elsewhere is not
 * followed across files, and a file with a payment call and no agent reports
 * nothing: both are stated limits of this reader, not "no capability".
 *
 * Pure: reads the IR, never the code's behaviour.
 */
import type { PaymentClientLibrary, PaymentProtocol } from '@/lib/agentic/harness-contract';

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

/**
 * What a name or attribute chain resolves to through the file's imports: the
 * module and the member path below it, or null. Python's dotted modules are
 * normalised so `from x402.http import clients` + `clients.httpx.x402HttpxClient`
 * and `from x402.http.clients.httpx import x402HttpxClient` meet.
 */
function resolve(e: Expr, facts: FileFacts, depth = 0): { module: string; members: string[] } | null {
    if (depth > 16) return null;
    if (e.k === 'ref') {
        const q = facts.imports.get(e.name);
        return q ? { module: q.module, members: [...q.path] } : null;
    }
    if (e.k === 'attr') {
        const head = resolve(e.obj, facts, depth + 1);
        return head ? { module: head.module, members: [...head.members, e.name] } : null;
    }
    return null;
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

/** A dynamic import, and the module it names when that is a literal. */
function dynamicImportOf(call: CallExpr): { literal: string | null } | null {
    const fn = call.fn;
    const isDynamic =
        (fn.k === 'ref' && (fn.name === 'import' || fn.name === 'require' || fn.name === '__import__'))
        || (fn.k === 'attr' && fn.name === 'import_module');
    if (!isDynamic) return null;
    const arg = call.args[0];
    if (arg !== undefined && arg.k === 'str' && !arg.template) return { literal: arg.value };
    return { literal: null };
}

/** Read the payment client calls, and the dynamic imports that hide one, out of one file's facts. */
export function recognizePaymentCalls(
    facts: FileFacts,
    file: { readonly label: string; readonly path: string; readonly text: string },
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

    for (const { call } of facts.calls) {
        const hit = entryPointOf(call.fn, facts);
        if (hit !== null) add(hit.entry, hit.name, call.line);
    }
    // An alias is a capability where it is made: `pay = wrapFetchWithPayment`.
    for (const bindings of facts.bindings.values()) {
        for (const b of bindings) {
            if (b.expr.k !== 'ref' && b.expr.k !== 'attr') continue;
            const hit = entryPointOf(b.expr, facts);
            if (hit !== null) add(hit.entry, hit.name, b.line);
        }
    }

    const unresolved: CodeLocation[] = [];
    if (PAYMENT_MARKERS.some((m) => file.text.includes(m))) {
        // A `const { x } = require('lit')` the reader resolved into an import is
        // read like any import; the same call used inline is not, and is held.
        const imported = new Set([...facts.imports.values()].map((q) => q.module));
        for (const { call } of facts.calls) {
            const dyn = dynamicImportOf(call);
            if (dyn === null) continue;
            if (dyn.literal !== null && !isPaymentModule(dyn.literal, facts.language)) continue;
            if (dyn.literal !== null && call.fn.k === 'ref' && call.fn.name === 'require' && imported.has(dyn.literal)) continue;
            unresolved.push(at(call.line));
        }
    }

    calls.sort((a, b) => a.at.line - b.at.line || (a.library < b.library ? -1 : a.library > b.library ? 1 : 0));
    return { calls, unresolved };
}
