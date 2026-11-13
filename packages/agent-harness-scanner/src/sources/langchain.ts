/**
 * THE `code` SOURCE: LANGCHAIN, LANGGRAPH AND CLAUDE AGENT SDK AGENTS IN AN
 * ESTATE'S CODE (#3737, #4156).
 *
 * Owner decision, 2026-10-19: LangChain-built agents are governed as things the
 * product DISCOVERS. Agents a customer builds on the Claude Agent SDK and runs
 * themselves are discovered the same way (Route B of
 * `docs/claude-agent-sdk-design.md`). LangChain is not a dependency of the platform or of this
 * scanner; the scanner reads the text of the code and configuration it is
 * pointed at and reports each agent definition through the signed contract
 * (`inflect-agent-harness/2`, whose `code` kind and `UNPARSEABLE` reason are
 * #3754's).
 *
 * Owner decision, 2026-11-13: an agent built directly on a model provider's
 * SDK (Anthropic, OpenAI and Azure OpenAI, Google Gemini, AWS Bedrock) is
 * discovered the same way. It is a model call that is given tools
 * (`code/provider-sdk.ts`), and it is read unless the configuration says
 * `providerSdks: false`.
 *
 * ── STATIC ONLY ─────────────────────────────────────────────────────────────
 *
 * Python is read by a bounded tokenizer and expression reader (`code/python.ts`),
 * JavaScript and TypeScript by TypeScript's syntax-only parser
 * (`code/javascript.ts`). Neither imports, requires, evaluates or spawns
 * anything: a scanned repository cannot run code in the scanner.
 * `eslint.config.mjs` refuses `child_process`, `vm`, `worker_threads`, `module`,
 * a dynamic `import()`, `require()` and `eval` in `sources/code/` and here, and
 * a test plants a definition whose import would have a side effect.
 *
 * ── WHAT EACH AGENT BECOMES ─────────────────────────────────────────────────
 *
 *   discoveredId  `code:<root label>/<path>#<name the definition is bound to>`;
 *                 for a model call on a provider's SDK, the function it is
 *                 written in, since `response = …` names nothing
 *   tools         one per tool it binds: an MCP server's URL, or the `code://`
 *                 locator of the tool's definition, with no pin and an
 *                 undeclared read-only hint (so: a write, as the contract says)
 *   credentials   by REFERENCE: `env://NAME`, or `code://…#L<line>` where a
 *                 value is written into the code — never the value
 *   owner         null; code names no accountable person
 *   verdicts      none for LangChain, LangGraph and a provider's SDK, whose
 *                 code holds no evidence for a harness criterion. For an
 *                 Agent SDK agent,
 *                 the NOT MET verdicts its options support, as the owner
 *                 mapped them (`agentSdkOptionVerdicts`, #4156): code can
 *                 show a control is missing, never that one works
 *
 *   paymentCapabilities
 *                 `/4`'s member: each place the agent's FILE calls a
 *                 recognised payment client (`code/payment.ts`, Agent Pay
 *                 Phase 2.1), by protocol, library and `code://` locator —
 *                 `[]` when the file shows none. `[]` is what this reader saw,
 *                 not that the agent cannot pay (a helper module is not
 *                 followed), so the planner never closes
 *                 SPENDING_AGENT_UNDECLARED on it. Never an amount, a wallet or
 *                 a key
 *
 *   models        the model endpoints it calls (`/2`'s optional `models[]`):
 *                 an https URL, an `env://` reference to where the URL is
 *                 configured, or the `code://` locator of the model's
 *                 construction when neither is knowable — with the model id
 *                 when the code names it
 *
 * ── COMPLETENESS ────────────────────────────────────────────────────────────
 *
 * A location that cannot be read is INCOMPLETE with the reason from
 * `code/files.ts`; a file that does not parse, or a definition with a part the
 * reader cannot resolve, is INCOMPLETE `UNPARSEABLE` — as is a file on which
 * a reader or a recogniser threw anything else: that one file was not read,
 * and the read goes on. Neither is left out, and what was read is still
 * reported. The places are named in the scanner's log (`notReadOf`), never in
 * the report. A tree with no agent in it is a COMPLETE
 * read of nothing, which the ingest raises as EMPTY_SCAN when no other source
 * found one either.
 */
import { lstat, readdir, readFile } from 'fs/promises';

import { MAX_NOT_READ_LOCATIONS, sourceResult, type HarnessSource, type IncompleteReason, type Observation, type SourceRead } from '../source';
import type { CodeFs, CodeRoot, FileProblem } from './code/files';
import { markersFor, readCodeFiles } from './code/files';
import { JavaScriptReadError, readJavaScript } from './code/javascript';
import { recognizePaymentCalls, type DetectedPaymentCall } from './code/payment';
import { PythonReadError, readPython } from './code/python';
import { agentSdkOptionVerdicts } from '@/lib/agentic/harness-findings';

import { codeLocator, recognizeAgents, type DetectedAgent } from './code/recognize';

export interface LangChainCodeSourceOptions {
    readonly roots: readonly CodeRoot[];
    /**
     * Agents built directly on a model provider's SDK. On unless it is
     * `false`; off, neither their files are parsed nor their calls read, and
     * the source reads exactly what it read before it knew them.
     */
    readonly providerSdks?: boolean;
    /** A TEST SEAM. The scanner never passes one, so production reads the real filesystem. */
    readonly fs?: CodeFs;
}

/** The order a source's reason is chosen in when several apply: what was not read at all comes first. */
const REASON_ORDER: readonly IncompleteReason[] = ['AUTH_FAILED', 'UNREACHABLE', 'TIME_BOX', 'BYTE_CAP', 'UNPARSEABLE'];

const NODE_FS: CodeFs = {
    lstat: (p) => lstat(p),
    readdir: (p) => readdir(p),
    readFile: (p) => readFile(p),
};

/** A detected agent, and the payment client calls its file makes. */
export interface CodeAgent extends DetectedAgent {
    readonly paymentCalls: readonly DetectedPaymentCall[];
}

export interface CodeScan {
    readonly rows: number;
    readonly agents: readonly CodeAgent[];
    readonly problems: readonly FileProblem[];
}

/** Read the roots and recognise every agent definition in them. Pure apart from the file reads. */
export async function scanLangChainCode(
    roots: readonly CodeRoot[],
    fs: CodeFs,
    opts: { readonly deadline: number; readonly now: () => number; readonly providerSdks?: boolean },
): Promise<CodeScan> {
    const agents: CodeAgent[] = [];
    const parseProblems: FileProblem[] = [];
    const providerSdks = opts.providerSdks !== false;
    const { rows, problems } = await readCodeFiles(roots, fs, { deadline: opts.deadline, now: opts.now, markers: markersFor(providerSdks) }, (file) => {
        try {
            const facts = /\.py$/i.test(file.path) ? readPython(file.text) : readJavaScript(file.path, file.text);
            const found = recognizeAgents(facts, file, { providerSdks });
            const payments = recognizePaymentCalls(facts, file, { definesAgent: found.agents.length > 0 });
            agents.push(...found.agents.map((a) => ({ ...a, paymentCalls: payments.calls })));
            for (const at of [...found.unresolved, ...payments.unresolved]) parseProblems.push({ reason: 'UNPARSEABLE', at });
        } catch (err) {
            // A reader's own refusal names the line. Anything else is a fault in
            // a reader or a recogniser on THIS file: the file was not read, and
            // it must not take the other files' agents with it.
            const line = err instanceof PythonReadError || err instanceof JavaScriptReadError ? err.line : 0;
            parseProblems.push({ reason: 'UNPARSEABLE', at: { label: file.label, path: file.path, line } });
        }
    });
    return { rows, agents, problems: [...problems, ...parseProblems] };
}

/** One detected agent as the report's observation of it. */
export function observationOf(agent: CodeAgent): Observation {
    return {
        discoveredId: agent.discoveredId,
        owner: null,
        credentials: agent.credentials.map((c) => ({
            ref: c.ref,
            ageDays: null,
            expires: null,
            boundToAgent: false,
            grant: 'unknown' as const,
        })),
        // A definition binds tools; it counts no calls, so none is given.
        tools: agent.tools.map((t) => ({ tool: { server: t.server, name: t.name, manifestHash: null, pinned: false, readOnlyHint: null } })),
        models: agent.models.map((m) => ({ endpoint: m.endpoint ?? codeLocator(m.at), model: m.model })),
        // Always stated, `[]` included: a code read is the one source that can say "none".
        paymentCapabilities: agent.paymentCalls.map((p) => ({ protocol: p.protocol, library: p.library, at: codeLocator(p.at) })),
        // An Agent SDK agent's options, mapped by the planner; the other frameworks', and a provider SDK's, code evidences nothing.
        verdicts: agent.sdkOptions === null ? [] : agentSdkOptionVerdicts(agent.sdkOptions),
    };
}

/**
 * The places this read did not cover, for the operator's log: the source's
 * reason first, then the others, each as the locator an agent in that file
 * would carry (`codeLocator`, which gives a hash in place of a path that is
 * too long or has a secret's shape). A problem with no place (the time box) is
 * counted and not listed. None of it reaches the signed report.
 */
export function notReadOf(problems: readonly FileProblem[], reason: IncompleteReason): Pick<SourceRead, 'notRead' | 'notReadTotal'> {
    const placed = problems.filter((p): p is FileProblem & { at: NonNullable<FileProblem['at']> } => p.at !== null);
    const ordered = [...placed.filter((p) => p.reason === reason), ...placed.filter((p) => p.reason !== reason)];
    return {
        notRead: ordered.slice(0, MAX_NOT_READ_LOCATIONS).map((p) => ({ where: codeLocator(p.at), reason: p.reason })),
        notReadTotal: problems.length,
    };
}

export function langchainCodeSource(options: LangChainCodeSourceOptions): HarnessSource {
    const fs = options.fs ?? NODE_FS;
    return {
        kind: 'code',
        product: 'langchain',
        async read(ctx): Promise<SourceRead> {
            const scan = await scanLangChainCode(options.roots, fs, { deadline: ctx.deadline, now: ctx.now, providerSdks: options.providerSdks });
            const observations = scan.agents.map(observationOf);
            const reason = REASON_ORDER.find((r) => scan.problems.some((p) => p.reason === r));
            if (reason === undefined) return sourceResult('code', scan.rows, observations, null);
            return { kind: 'code', status: 'INCOMPLETE', reason, rows: scan.rows, observations, ...notReadOf(scan.problems, reason) };
        },
    };
}

