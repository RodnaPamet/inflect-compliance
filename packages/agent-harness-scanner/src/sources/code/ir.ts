/**
 * THE SMALL EXPRESSION LANGUAGE BOTH PARSERS LOWER TO (#3737).
 *
 * The Python reader (`python.ts`) and the JavaScript/TypeScript reader
 * (`javascript.ts`) each turn one file into `FileFacts`: what it imports, what
 * each name is bound to, and every call in it. The recogniser
 * (`recognize.ts`) then reads LangChain and LangGraph agent definitions out of
 * those facts, once, for both languages.
 *
 * The IR is deliberately tiny. It names what a definition is built from —
 * calls, keyword or option arguments, lists, dictionaries, string literals,
 * attribute access and subscripts — and everything else is `opaque`, which the
 * recogniser treats as "could not be resolved", never as "nothing". Nothing in
 * this module, or anything that builds it, evaluates the code it describes:
 * the scanner reads text and never imports or runs what it reads.
 */

/** A position in one scanned file. */
export interface CodeLocation {
    /** The root's label from the configuration — never its absolute path. */
    readonly label: string;
    /** The file's path below that root, `/`-separated. */
    readonly path: string;
    readonly line: number;
}

export type Expr =
    | { readonly k: 'ref'; readonly name: string; readonly line: number }
    | { readonly k: 'attr'; readonly obj: Expr; readonly name: string; readonly line: number }
    | CallExpr
    | { readonly k: 'str'; readonly value: string; readonly template: boolean; readonly line: number }
    | { readonly k: 'list'; readonly items: readonly Expr[]; readonly spread: boolean; readonly line: number }
    | {
          readonly k: 'dict';
          /** A key that is not a plain string or identifier is `null`. */
          readonly entries: readonly (readonly [string | null, Expr])[];
          readonly spread: boolean;
          readonly line: number;
      }
    | { readonly k: 'sub'; readonly obj: Expr; readonly key: Expr; readonly line: number }
    /** `a + b`, the one operator a tool list or a credential is commonly built with. */
    | { readonly k: 'concat'; readonly parts: readonly Expr[]; readonly line: number }
    /** A function or lambda: known to be code, never followed. */
    | { readonly k: 'func'; readonly line: number }
    | { readonly k: 'opaque'; readonly line: number };

export interface CallExpr {
    readonly k: 'call';
    readonly fn: Expr;
    readonly args: readonly Expr[];
    /** Python keyword arguments. JavaScript passes options as a `dict` argument instead. */
    readonly kwargs: ReadonlyMap<string, Expr>;
    /** `*args`, `**kwargs` or `...spread`: an argument list the reader cannot see whole. */
    readonly spread: boolean;
    readonly line: number;
}

/** A local name's binding to a module member, or to a module itself (`path` empty). */
export interface Qualified {
    readonly module: string;
    readonly path: readonly string[];
}

export interface Binding {
    readonly line: number;
    readonly expr: Expr;
}

/** A function or class the file itself declares as a LangChain tool. */
export interface ToolDeclaration {
    readonly line: number;
    /** The name the tool is registered under: the decorator's, or the function's or class's own. */
    readonly toolName: string;
}

export interface FileFacts {
    readonly language: 'python' | 'javascript';
    /** Local name → what it was imported as. */
    readonly imports: ReadonlyMap<string, Qualified>;
    /** Every binding of a name, in source order. Scope is not modelled: one file, one namespace. */
    readonly bindings: ReadonlyMap<string, readonly Binding[]>;
    /** Local name → a tool the file declares (a `@tool` function, a tool subclass). */
    readonly toolDeclarations: ReadonlyMap<string, ToolDeclaration>;
    /** Every call in the file, outermost first, with the name it is the whole value of. */
    readonly calls: readonly { readonly call: CallExpr; readonly boundTo: string | null }[];
}

/** The modules whose members the recogniser knows. Nothing else is resolved. */
export function isLangChainModule(module: string): boolean {
    return (
        module === 'langchain'
        || module.startsWith('langchain_')
        || module.startsWith('langchain.')
        || module.startsWith('langchain/')
        || module === 'langgraph'
        || module.startsWith('langgraph.')
        || module.startsWith('langgraph_')
        || module.startsWith('@langchain/')
    );
}

/**
 * The Claude Agent SDK's modules: `@anthropic-ai/claude-agent-sdk` in
 * JavaScript and TypeScript, `claude_agent_sdk` in Python (#4156).
 */
export function isClaudeAgentSdkModule(module: string): boolean {
    return (
        module === '@anthropic-ai/claude-agent-sdk'
        || module.startsWith('@anthropic-ai/claude-agent-sdk/')
        || module === 'claude_agent_sdk'
        || module.startsWith('claude_agent_sdk.')
    );
}

/** The `line` every IR node carries. */
export function lineOf(e: Expr): number {
    return e.line;
}

/** A list of every call nested inside an expression, outermost first. */
export function callsWithin(e: Expr, out: CallExpr[] = [], depth = 0): CallExpr[] {
    if (depth > 64) return out;
    switch (e.k) {
        case 'call':
            out.push(e);
            callsWithin(e.fn, out, depth + 1);
            for (const a of e.args) callsWithin(a, out, depth + 1);
            for (const v of e.kwargs.values()) callsWithin(v, out, depth + 1);
            return out;
        case 'attr':
            return callsWithin(e.obj, out, depth + 1);
        case 'sub':
            callsWithin(e.obj, out, depth + 1);
            return callsWithin(e.key, out, depth + 1);
        case 'list':
            for (const i of e.items) callsWithin(i, out, depth + 1);
            return out;
        case 'dict':
            for (const [, v] of e.entries) callsWithin(v, out, depth + 1);
            return out;
        case 'concat':
            for (const p of e.parts) callsWithin(p, out, depth + 1);
            return out;
        default:
            return out;
    }
}
