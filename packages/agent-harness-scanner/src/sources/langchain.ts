/**
 * THE `code` SOURCE: LANGCHAIN AND LANGGRAPH AGENTS IN AN ESTATE'S CODE (#3737).
 *
 * Owner decision, 2026-10-19: LangChain-built agents are governed as things the
 * product DISCOVERS. LangChain is not a dependency of the platform or of this
 * scanner; the scanner reads the text of the code and configuration it is
 * pointed at and reports each agent definition through the signed contract
 * (`inflect-agent-harness/2`, whose `code` kind and `UNPARSEABLE` reason are
 * #3754's).
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
 *   discoveredId  `code:<root label>/<path>#<name the definition is bound to>`
 *   tools         one per tool it binds: an MCP server's URL, or the `code://`
 *                 locator of the tool's definition, with no pin and an
 *                 undeclared read-only hint (so: a write, as the contract says)
 *   credentials   by REFERENCE: `env://NAME`, or `code://…#L<line>` where a
 *                 value is written into the code — never the value
 *   owner         null; code names no accountable person
 *   verdicts      none; the code holds no evidence for a harness criterion
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
 * reader cannot resolve, is INCOMPLETE `UNPARSEABLE`. Neither is left out, and
 * what was read is still reported. A tree with no agent in it is a COMPLETE
 * read of nothing, which the ingest raises as EMPTY_SCAN when no other source
 * found one either.
 */
import { lstat, readdir, readFile } from 'fs/promises';

import { sourceResult, type HarnessSource, type IncompleteReason, type Observation, type SourceRead } from '../source';
import type { CodeFs, CodeRoot, FileProblem } from './code/files';
import { readCodeFiles } from './code/files';
import { JavaScriptReadError, readJavaScript } from './code/javascript';
import { PythonReadError, readPython } from './code/python';
import { codeLocator, recognizeAgents, type DetectedAgent } from './code/recognize';

export interface LangChainCodeSourceOptions {
    readonly roots: readonly CodeRoot[];
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

export interface CodeScan {
    readonly rows: number;
    readonly agents: readonly DetectedAgent[];
    readonly problems: readonly FileProblem[];
}

/** Read the roots and recognise every agent definition in them. Pure apart from the file reads. */
export async function scanLangChainCode(
    roots: readonly CodeRoot[],
    fs: CodeFs,
    opts: { readonly deadline: number; readonly now: () => number },
): Promise<CodeScan> {
    const agents: DetectedAgent[] = [];
    const parseProblems: FileProblem[] = [];
    const { rows, problems } = await readCodeFiles(roots, fs, opts, (file) => {
        try {
            const facts = /\.py$/i.test(file.path) ? readPython(file.text) : readJavaScript(file.path, file.text);
            const found = recognizeAgents(facts, file);
            agents.push(...found.agents);
            for (const at of found.unresolved) parseProblems.push({ reason: 'UNPARSEABLE', at });
        } catch (err) {
            if (!(err instanceof PythonReadError) && !(err instanceof JavaScriptReadError)) throw err;
            parseProblems.push({ reason: 'UNPARSEABLE', at: { label: file.label, path: file.path, line: err.line } });
        }
    });
    return { rows, agents, problems: [...problems, ...parseProblems] };
}

/** One detected agent as the report's observation of it. */
export function observationOf(agent: DetectedAgent): Observation {
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
        verdicts: [],
    };
}

export function langchainCodeSource(options: LangChainCodeSourceOptions): HarnessSource {
    const fs = options.fs ?? NODE_FS;
    return {
        kind: 'code',
        product: 'langchain',
        async read(ctx): Promise<SourceRead> {
            const scan = await scanLangChainCode(options.roots, fs, { deadline: ctx.deadline, now: ctx.now });
            const observations = scan.agents.map(observationOf);
            const reason = REASON_ORDER.find((r) => scan.problems.some((p) => p.reason === r));
            if (reason === undefined) return sourceResult('code', scan.rows, observations, null);
            return { kind: 'code', status: 'INCOMPLETE', reason, rows: scan.rows, observations };
        },
    };
}

