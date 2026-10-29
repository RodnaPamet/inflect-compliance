/**
 * LANGCHAIN, LANGGRAPH AND CLAUDE AGENT SDK AGENT DEFINITIONS, READ OUT OF ONE
 * FILE'S FACTS (#3737, #4156).
 *
 * One recogniser for both languages: `python.ts` and `javascript.ts` lower a
 * file to the same IR, and this module reads agents out of it by what each
 * call RESOLVES to — a name imported from a `langchain`/`langgraph` module,
 * followed through the file's own bindings — never by spelling alone. A local
 * function that happens to be called `create_react_agent` is not LangGraph's.
 *
 * What counts as an agent:
 *
 *   • a factory call — LangGraph's `create_react_agent`/`createReactAgent`, or
 *     LangChain's `create_*_agent`/`create*Agent` and `initialize_agent`;
 *   • an executor — `AgentExecutor(...)`, `AgentExecutor.from_agent_and_tools`
 *     — which ABSORBS the factory it wraps, so one agent is reported once;
 *   • a compiled `StateGraph` that binds tools or a model: its `ToolNode`s'
 *     tools, and the models whose `bind_tools` the file calls;
 *   • a Claude Agent SDK call — `query` from `@anthropic-ai/claude-agent-sdk`,
 *     or `query`, `ClaudeSDKClient` from `claude_agent_sdk` — and, in Python, a
 *     `ClaudeAgentOptions` no such call in the file consumes. Its options are
 *     read as well (`sdkAgent`, below), and the planner maps them onto the
 *     harness ladder (`agentSdkOptionVerdicts`).
 *
 * For each, the tools it binds, the model endpoints it calls and the
 * credentials those reference. A credential is reported by REFERENCE only: the
 * environment variable it is read from (`env://NAME`), or, for a value written
 * into the code, the place it is written (`code://…#L<line>`). The literal is
 * held in memory as a token and never copied into anything this module returns.
 *
 * FAIL CLOSED, NEVER SILENTLY. Anything a definition is built from that does
 * not resolve — a tool list computed by a function, a model passed in as a
 * parameter, `**kwargs`, a credential read from a settings object — is
 * recorded in `unresolved` at its line, and the source reports itself
 * INCOMPLETE `UNPARSEABLE`. The agent is still reported with what did resolve.
 */
import { createHash } from 'crypto';

import { looksLikeSecret } from '@/lib/agentic/harness-contract';
import type { AgentSdkOptionFacts } from '@/lib/agentic/harness-findings';

import {
    isClaudeAgentSdkModule,
    isLangChainModule,
    type CallExpr,
    type CodeLocation,
    type Expr,
    type FileFacts,
    type Qualified,
} from './ir';

export interface DetectedModel {
    readonly provider: string;
    /** The model id, when the code names it with a literal. */
    readonly model: string | null;
    /** An https URL, an `env://` reference, or null when not knowable. */
    readonly endpoint: string | null;
    readonly endpointBasis: 'explicit' | 'environment' | 'provider-default' | 'unknown';
    readonly at: CodeLocation;
}

export interface DetectedTool {
    readonly name: string;
    readonly kind: 'function' | 'class' | 'toolkit' | 'mcp' | 'builtin';
    /** An MCP server's URL, else the `code://` locator of the tool's definition or construction. */
    readonly server: string;
    readonly at: CodeLocation;
}

export interface DetectedCredential {
    /** `env://NAME` or `code://<label>/<path>#L<line>`. Never a value. */
    readonly ref: string;
    readonly basis: 'environment' | 'literal' | 'provider-default';
    readonly at: CodeLocation;
}

export interface DetectedAgent {
    readonly framework: 'langchain' | 'langgraph' | 'claude-agent-sdk';
    readonly language: 'python' | 'javascript';
    /** The name the definition is bound to, or `L<line>`. */
    readonly name: string;
    readonly discoveredId: string;
    readonly at: CodeLocation;
    readonly tools: readonly DetectedTool[];
    readonly models: readonly DetectedModel[];
    readonly credentials: readonly DetectedCredential[];
    /** An Agent SDK agent's options, as read. Null for the other frameworks. */
    readonly sdkOptions: AgentSdkOptionFacts | null;
    /** How many subagents an Agent SDK agent's options define; null when unread, or another framework. */
    readonly subagents: number | null;
}

export interface FileDetection {
    readonly agents: readonly DetectedAgent[];
    /** Where a definition, or part of one, could not be resolved. */
    readonly unresolved: readonly CodeLocation[];
}

// ─── Locators ───────────────────────────────────────────────────────────────

const MAX_LOCATOR = 400;
const MAX_DISCOVERED_ID = 256;

function shortHash(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 24);
}

function encodedPath(path: string): string {
    return path.split('/').map(encodeURIComponent).join('/');
}

/** `code://<label>/<path>#L<line>`: a URL with no whitespace, short enough for any member that holds one. */
export function codeLocator(at: CodeLocation): string {
    const full = `code://${at.label}/${encodedPath(at.path)}#L${at.line}`;
    const value = full.length <= MAX_LOCATOR ? full : `code://${at.label}/sha256-${shortHash(at.path)}#L${at.line}`;
    return looksLikeSecret(value) ? `code://${at.label}/sha256-${shortHash(at.path)}#L${at.line}` : value;
}

function discoveredIdOf(label: string, path: string, name: string): string {
    const full = `code:${label}/${encodedPath(path)}#${name}`;
    if (full.length <= MAX_DISCOVERED_ID && !looksLikeSecret(full)) return full;
    return `code:${label}/sha256-${shortHash(`${path}#${name}`)}`;
}

/** A name from the code that is safe to report: short, printable, not secret-shaped. */
function reportableName(value: string): string | null {
    return /^[\w.:\-/ ]{1,128}$/.test(value) && !looksLikeSecret(value) ? value : null;
}

// ─── What each known name is ────────────────────────────────────────────────

interface Provider {
    readonly endpoint: string | null;
    readonly keyEnv: string | null;
    /** An endpoint read from the environment by default, when there is no fixed one. */
    readonly endpointEnv?: string;
}

const PROVIDERS: Readonly<Record<string, Provider>> = {
    openai: { endpoint: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY' },
    'azure-openai': { endpoint: null, keyEnv: 'AZURE_OPENAI_API_KEY', endpointEnv: 'AZURE_OPENAI_ENDPOINT' },
    anthropic: { endpoint: 'https://api.anthropic.com', keyEnv: 'ANTHROPIC_API_KEY' },
    'google-genai': { endpoint: 'https://generativelanguage.googleapis.com', keyEnv: 'GOOGLE_API_KEY' },
    'google-vertexai': { endpoint: 'https://aiplatform.googleapis.com', keyEnv: null },
    bedrock: { endpoint: 'https://bedrock-runtime.amazonaws.com', keyEnv: null },
    mistralai: { endpoint: 'https://api.mistral.ai', keyEnv: 'MISTRAL_API_KEY' },
    groq: { endpoint: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY' },
    cohere: { endpoint: 'https://api.cohere.com', keyEnv: 'COHERE_API_KEY' },
    deepseek: { endpoint: 'https://api.deepseek.com', keyEnv: 'DEEPSEEK_API_KEY' },
    xai: { endpoint: 'https://api.x.ai/v1', keyEnv: 'XAI_API_KEY' },
    fireworks: { endpoint: 'https://api.fireworks.ai/inference/v1', keyEnv: 'FIREWORKS_API_KEY' },
    together: { endpoint: 'https://api.together.xyz/v1', keyEnv: 'TOGETHER_API_KEY' },
    ollama: { endpoint: 'http://localhost:11434', keyEnv: null },
};

/** Chat model classes, in either language, by the provider they call. */
const CHAT_MODELS: Readonly<Record<string, string>> = {
    ChatOpenAI: 'openai',
    AzureChatOpenAI: 'azure-openai',
    ChatAnthropic: 'anthropic',
    ChatGoogleGenerativeAI: 'google-genai',
    ChatVertexAI: 'google-vertexai',
    ChatBedrock: 'bedrock',
    ChatBedrockConverse: 'bedrock',
    ChatMistralAI: 'mistralai',
    ChatGroq: 'groq',
    ChatCohere: 'cohere',
    ChatDeepSeek: 'deepseek',
    ChatXAI: 'xai',
    ChatFireworks: 'fireworks',
    ChatTogether: 'together',
    ChatTogetherAI: 'together',
    ChatOllama: 'ollama',
};

/** `provider:model` strings, as `init_chat_model` and LangGraph's prebuilt agent take them. */
const PROVIDER_PREFIXES: Readonly<Record<string, string>> = {
    openai: 'openai',
    azure_openai: 'azure-openai',
    anthropic: 'anthropic',
    google_genai: 'google-genai',
    google_vertexai: 'google-vertexai',
    bedrock: 'bedrock',
    bedrock_converse: 'bedrock',
    mistralai: 'mistralai',
    groq: 'groq',
    cohere: 'cohere',
    deepseek: 'deepseek',
    xai: 'xai',
    fireworks: 'fireworks',
    together: 'together',
    ollama: 'ollama',
};

/** The default environment variable a known prebuilt tool reads its key from. */
const TOOL_KEY_ENV: Readonly<Record<string, string>> = {
    TavilySearchResults: 'TAVILY_API_KEY',
    TavilySearch: 'TAVILY_API_KEY',
    TavilySearchAPIWrapper: 'TAVILY_API_KEY',
    SerpAPIWrapper: 'SERPAPI_API_KEY',
    SerpAPI: 'SERPAPI_API_KEY',
    GoogleSerperAPIWrapper: 'SERPER_API_KEY',
    BraveSearch: 'BRAVE_SEARCH_API_KEY',
};

interface Factory {
    readonly model: readonly (string | number)[];
    readonly tools: readonly (string | number)[];
}

/** Agent factories by name, with where each takes its model and its tools. */
const PY_FACTORIES: Readonly<Record<string, Factory>> = {
    create_react_agent: { model: ['model', 'llm', 0], tools: ['tools', 1] },
    create_tool_calling_agent: { model: ['llm', 0], tools: ['tools', 1] },
    create_openai_functions_agent: { model: ['llm', 0], tools: ['tools', 1] },
    create_openai_tools_agent: { model: ['llm', 0], tools: ['tools', 1] },
    create_structured_chat_agent: { model: ['llm', 0], tools: ['tools', 1] },
    create_json_chat_agent: { model: ['llm', 0], tools: ['tools', 1] },
    create_xml_agent: { model: ['llm', 0], tools: ['tools', 1] },
    create_self_ask_with_search_agent: { model: ['llm', 0], tools: ['tools', 1] },
    initialize_agent: { model: ['llm', 1], tools: ['tools', 0] },
};
const JS_FACTORIES: Readonly<Record<string, Factory>> = {
    createReactAgent: { model: ['llm', 'model'], tools: ['tools'] },
    createToolCallingAgent: { model: ['llm'], tools: ['tools'] },
    createOpenAIFunctionsAgent: { model: ['llm'], tools: ['tools'] },
    createOpenAIToolsAgent: { model: ['llm'], tools: ['tools'] },
    createStructuredChatAgent: { model: ['llm'], tools: ['tools'] },
    createXmlAgent: { model: ['llm'], tools: ['tools'] },
    initializeAgentExecutorWithOptions: { model: [1], tools: [0] },
};
const EXECUTOR_METHODS: ReadonlySet<string> = new Set(['from_agent_and_tools', 'fromAgentAndTools']);
const TOOL_FACTORIES: ReadonlySet<string> = new Set(['Tool', 'StructuredTool', 'DynamicTool', 'DynamicStructuredTool', 'tool']);
const TOOL_FACTORY_METHODS: ReadonlySet<string> = new Set(['from_function', 'fromFunction']);
const PASSTHROUGH_METHODS: ReadonlySet<string> = new Set([
    'with_structured_output', 'withStructuredOutput', 'with_config', 'withConfig', 'with_retry', 'withRetry', 'bind',
    'configurable_fields', 'configurable_alternatives', 'with_types', 'withTypes',
]);
const ADD_NODE: ReadonlySet<string> = new Set(['add_node', 'addNode']);
const GRAPH_CHAIN: ReadonlySet<string> = new Set([
    'add_node', 'addNode', 'add_edge', 'addEdge', 'add_conditional_edges', 'addConditionalEdges', 'set_entry_point',
    'setEntryPoint', 'set_finish_point', 'setFinishPoint', 'add_sequence', 'addSequence',
]);

const MODEL_NAME_KEYS = ['model', 'model_name', 'modelName', 'deployment_name', 'azure_deployment', 'azureOpenAIApiDeploymentName', 'model_id', 'modelId'];
const ENDPOINT_KEYS = ['base_url', 'openai_api_base', 'api_base', 'azure_endpoint', 'endpoint', 'endpoint_url', 'baseURL', 'baseUrl', 'azureOpenAIEndpoint', 'azureOpenAIBasePath', 'anthropicApiUrl', 'apiUrl'];

/** Whether an option's NAME says its value is a credential (`api_key`, `openAIApiKey`, `Authorization`…). */
export function isCredentialKey(key: string): boolean {
    const snake = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    return (
        snake === 'token'
        || /(?:api_?key|apikey|access_?key|secret_?key|secret|_token|access_?token|password|passwd|credentials?|authorization)$/.test(snake)
    );
}

// ─── The Claude Agent SDK's options (#4156) ──────────────────────────────────

/** Each option's name in TypeScript's `Options`. */
const SDK_OPTIONS_JS = {
    tools: 'tools',
    allowedTools: 'allowedTools',
    disallowedTools: 'disallowedTools',
    mcpServers: 'mcpServers',
    model: 'model',
    permissionMode: 'permissionMode',
    settingSources: 'settingSources',
    agents: 'agents',
    hooks: 'hooks',
    env: 'env',
} as const;

/** The same options, as Python's `ClaudeAgentOptions` spells them. */
const SDK_OPTIONS_PY: Readonly<Record<keyof typeof SDK_OPTIONS_JS, string>> = {
    tools: 'tools',
    allowedTools: 'allowed_tools',
    disallowedTools: 'disallowed_tools',
    mcpServers: 'mcp_servers',
    model: 'model',
    permissionMode: 'permission_mode',
    settingSources: 'setting_sources',
    agents: 'agents',
    hooks: 'hooks',
    env: 'env',
};

/**
 * The built-in tools the SDK turns on when the code leaves `tools` out, as
 * `docs/claude-agent-sdk-design.md` records them (documented 2026-10-24).
 */
const SDK_DEFAULT_BUILTINS: readonly string[] = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Agent', 'Skill'];

/** The built-ins that reach any command or any host. */
const SDK_SHELL_OR_FETCH: readonly string[] = ['Bash', 'WebFetch'];

// ─── The recogniser ─────────────────────────────────────────────────────────

interface Resolved {
    readonly tools: DetectedTool[];
    readonly models: DetectedModel[];
    readonly credentials: DetectedCredential[];
}

type Value =
    | ({ readonly v: 'model' } & Resolved)
    | ({ readonly v: 'tools' } & Resolved)
    | { readonly v: 'factory'; readonly call: CallExpr; readonly name: string; readonly module: string }
    | { readonly v: 'executor'; readonly call: CallExpr }
    | ({ readonly v: 'toolkit' } & Resolved)
    | ({ readonly v: 'mcp' } & Resolved)
    | { readonly v: 'graph'; readonly call: CallExpr }
    | { readonly v: 'unknown' };

const UNKNOWN: Value = { v: 'unknown' };

/** A list of string literals, and whether the reader saw all of it. */
interface StringList {
    readonly items: { readonly value: string; readonly line: number }[];
    complete: boolean;
}

/** One Agent SDK agent, as read. */
interface SdkAgentRead {
    readonly r: Resolved;
    readonly facts: AgentSdkOptionFacts;
    readonly subagents: number | null;
}
const empty = (): Resolved => ({ tools: [], models: [], credentials: [] });

function merge(into: Resolved, from: Resolved): void {
    into.tools.push(...from.tools);
    into.models.push(...from.models);
    into.credentials.push(...from.credentials);
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

class Recognizer {
    readonly unresolved: CodeLocation[] = [];
    private readonly resolving = new Set<Expr>();

    constructor(
        private readonly facts: FileFacts,
        private readonly label: string,
        private readonly path: string,
    ) {}

    at(line: number): CodeLocation {
        return { label: this.label, path: this.path, line };
    }

    private fail(line: number): void {
        this.unresolved.push(this.at(line));
    }

    /** The binding a name had at `line`: the latest before it, else the first after (a function body using a later global). */
    private binding(key: string, line: number): Expr | null {
        const list = this.facts.bindings.get(key);
        if (!list || list.length === 0) return null;
        let best: Expr | null = null;
        for (const b of list) if (b.line < line) best = b.expr;
        return best ?? list.find((b) => b.line >= line)?.expr ?? null;
    }

    /** `x`, `self.llm`, `this.llm` as a binding key. */
    private dotted(e: Expr): string | null {
        if (e.k === 'ref') return e.name;
        if (e.k === 'attr') {
            const head = this.dotted(e.obj);
            return head === null ? null : `${head}.${e.name}`;
        }
        return null;
    }

    /** What a name or attribute chain was imported as, following plain aliases (`C = ChatOpenAI`). */
    qualify(e: Expr, depth = 0): Qualified | null {
        if (depth > 16) return null;
        if (e.k === 'ref') {
            const q = this.facts.imports.get(e.name);
            if (q) return q;
            const bound = this.binding(e.name, e.line);
            return bound && (bound.k === 'ref' || bound.k === 'attr') ? this.qualify(bound, depth + 1) : null;
        }
        if (e.k === 'attr') {
            const q = this.qualify(e.obj, depth + 1);
            return q ? { module: q.module, path: [...q.path, e.name] } : null;
        }
        return null;
    }

    private known(e: Expr): { module: string; name: string; path: readonly string[] } | null {
        const q = this.qualify(e);
        if (q === null || q.path.length === 0 || !isLangChainModule(q.module)) return null;
        return { module: q.module, name: q.path[q.path.length - 1], path: q.path };
    }

    /** An option by keyword (Python) or by key of an options object (JavaScript), or by position. */
    private option(call: CallExpr, where: readonly (string | number)[]): Expr | undefined {
        for (const w of where) {
            if (typeof w === 'number') {
                if (call.args[w] !== undefined) return call.args[w];
                continue;
            }
            const kw = call.kwargs.get(w);
            if (kw) return kw;
            for (const a of call.args) {
                if (a.k !== 'dict') continue;
                const hit = a.entries.find(([k]) => k === w);
                if (hit) return hit[1];
            }
        }
        return undefined;
    }

    /** Every option of a call, keyword or object entry, with nested option objects flattened in. */
    private options(call: CallExpr): (readonly [string, Expr])[] {
        const out: (readonly [string, Expr])[] = [...call.kwargs.entries()];
        const walk = (e: Expr, depth: number) => {
            if (e.k !== 'dict' || depth > 3) return;
            for (const [k, v] of e.entries) {
                if (k === null) continue;
                out.push([k, v]);
                walk(v, depth + 1);
            }
        };
        for (const a of call.args) walk(a, 0);
        for (const v of call.kwargs.values()) walk(v, 1);
        return out;
    }

    // ── values ─────────────────────────────────────────────────────────────

    value(e: Expr, depth = 0): Value {
        if (depth > 32 || this.resolving.has(e)) return UNKNOWN;
        this.resolving.add(e);
        try {
            return this.valueOf(e, depth);
        } finally {
            this.resolving.delete(e);
        }
    }

    private valueOf(e: Expr, depth: number): Value {
        switch (e.k) {
            case 'ref':
            case 'attr': {
                const key = this.dotted(e);
                if (key !== null && e.k === 'ref') {
                    const decl = this.facts.toolDeclarations.get(key);
                    if (decl) return { v: 'tools', ...this.declaredTool(key) };
                }
                const bound = key === null ? null : this.binding(key, e.line);
                return bound ? this.value(bound, depth + 1) : UNKNOWN;
            }
            case 'list': {
                const r = empty();
                for (const item of e.items) merge(r, this.toolsOf(item, depth + 1));
                return { v: 'tools', ...r };
            }
            case 'concat': {
                const r = empty();
                for (const part of e.parts) merge(r, this.toolsOf(part, depth + 1));
                return { v: 'tools', ...r };
            }
            case 'call':
                return this.callValue(e, depth);
            default:
                return UNKNOWN;
        }
    }

    private declaredTool(local: string): Resolved {
        const decl = this.facts.toolDeclarations.get(local)!;
        const at = this.at(decl.line);
        const name = reportableName(decl.toolName) ?? reportableName(local) ?? `L${decl.line}`;
        return { tools: [{ name, kind: 'function', server: codeLocator(at), at }], models: [], credentials: [] };
    }

    private callValue(call: CallExpr, depth: number): Value {
        const fn = call.fn;
        // Methods on a value: `llm.bind_tools(tools)`, `toolkit.get_tools()`, a graph builder's chain.
        if (fn.k === 'attr' && this.known(fn) === null) {
            const receiver = this.value(fn.obj, depth + 1);
            if (fn.name === 'bind_tools' || fn.name === 'bindTools') {
                if (receiver.v !== 'model') return UNKNOWN;
                const bound = this.option(call, ['tools', 0]);
                const r: Resolved = { tools: [...receiver.tools], models: [...receiver.models], credentials: [...receiver.credentials] };
                if (bound) merge(r, this.toolsOf(bound, depth + 1));
                return { v: 'model', ...r };
            }
            if (PASSTHROUGH_METHODS.has(fn.name)) return receiver.v === 'model' ? receiver : UNKNOWN;
            if (fn.name === 'with_fallbacks' || fn.name === 'withFallbacks') {
                if (receiver.v !== 'model') return UNKNOWN;
                const r: Resolved = { tools: [...receiver.tools], models: [...receiver.models], credentials: [...receiver.credentials] };
                const fallbacks = call.args[0] ?? call.kwargs.get('fallbacks');
                if (fallbacks?.k === 'list') for (const f of fallbacks.items) merge(r, this.modelOf(f, depth + 1));
                return { v: 'model', ...r };
            }
            if (fn.name === 'get_tools' || fn.name === 'getTools') {
                return receiver.v === 'toolkit' || receiver.v === 'mcp' ? { ...receiver, v: 'tools' } : UNKNOWN;
            }
            if (GRAPH_CHAIN.has(fn.name) && receiver.v === 'graph') return receiver;
            return UNKNOWN;
        }

        // A tool class the file declares, instantiated.
        if (fn.k === 'ref' && this.facts.toolDeclarations.has(fn.name)) {
            const r = this.declaredTool(fn.name);
            merge(r, this.credentialOptions(call));
            return { v: 'tools', ...r };
        }

        const known = this.known(fn);
        if (known === null) return UNKNOWN;
        const { name, module, path } = known;
        const at = this.at(call.line);

        if (CHAT_MODELS[name] !== undefined) return { v: 'model', ...this.chatModel(call, CHAT_MODELS[name]) };
        if (name === 'init_chat_model' || name === 'initChatModel') return { v: 'model', ...this.initChatModel(call) };

        const factories = this.facts.language === 'python' ? PY_FACTORIES : JS_FACTORIES;
        if (Object.prototype.hasOwnProperty.call(factories, name)) return { v: 'factory', call, name, module };
        if (name === 'AgentExecutor' || (EXECUTOR_METHODS.has(name) && path[path.length - 2] === 'AgentExecutor')) {
            return { v: 'executor', call };
        }
        if (name === 'StateGraph' || name === 'MessageGraph') return { v: 'graph', call };
        if (name === 'ToolNode') {
            const tools = this.option(call, ['tools', 0]);
            return tools ? { v: 'tools', ...this.toolsOf(tools, depth + 1) } : (this.fail(call.line), UNKNOWN);
        }
        if (TOOL_FACTORIES.has(name) || (TOOL_FACTORY_METHODS.has(name) && TOOL_FACTORIES.has(path[path.length - 2] ?? ''))) {
            return { v: 'tools', ...this.toolFactory(call, name) };
        }
        if (name === 'load_tools') {
            const list = this.option(call, ['tool_names', 0]);
            if (list?.k !== 'list') {
                this.fail(call.line);
                return UNKNOWN;
            }
            const r = empty();
            for (const item of list.items) {
                const toolName = item.k === 'str' && !item.template ? reportableName(item.value) : null;
                if (toolName === null) this.fail(item.line);
                else r.tools.push({ name: toolName, kind: 'builtin', server: codeLocator(at), at });
            }
            return { v: 'tools', ...r };
        }
        if (name === 'MultiServerMCPClient') return { v: 'mcp', ...this.mcpClient(call) };
        if (/^[A-Z]/.test(name)) {
            const r = this.credentialOptions(call);
            const tool: DetectedTool = {
                name,
                kind: /Toolkit$/.test(name) ? 'toolkit' : 'builtin',
                server: codeLocator(at),
                at,
            };
            r.tools.push(tool);
            const keyEnv = TOOL_KEY_ENV[name];
            if (keyEnv && r.credentials.length === 0) r.credentials.push({ ref: `env://${keyEnv}`, basis: 'provider-default', at });
            return /Toolkit$/.test(name) ? { v: 'toolkit', ...r } : { v: 'tools', ...r };
        }
        return UNKNOWN;
    }

    // ── tools ──────────────────────────────────────────────────────────────

    toolsOf(e: Expr, depth = 0): Resolved {
        const value = this.value(e, depth);
        if (value.v === 'tools' || value.v === 'toolkit') return { tools: [...value.tools], models: [], credentials: [...value.credentials] };
        this.fail(e.line);
        return empty();
    }

    private toolFactory(call: CallExpr, factory: string): Resolved {
        const at = this.at(call.line);
        const r = this.credentialOptions(call);
        // `tool(fn, { name })` in JS; `Tool(name=…)`, `StructuredTool.from_function(func, name=…)` in Python.
        const declared = this.option(call, ['name']);
        let name: string | null = declared?.k === 'str' && !declared.template ? reportableName(declared.value) : null;
        if (name === null) {
            const fn = this.option(call, ['func', 'coroutine', 0]);
            if (fn?.k === 'ref') name = reportableName(this.facts.toolDeclarations.get(fn.name)?.toolName ?? fn.name);
        }
        if (name === null) {
            this.fail(call.line);
            name = `${factory}@L${call.line}`;
        }
        r.tools.push({ name, kind: 'function', server: codeLocator(at), at });
        return r;
    }

    private mcpClient(call: CallExpr): Resolved {
        const r = empty();
        const at = this.at(call.line);
        let config = this.option(call, ['connections', 'mcpServers', 0]);
        if (config?.k === 'ref') config = this.binding(config.name, config.line) ?? undefined;
        if (config?.k === 'dict' && config.entries.some(([k]) => k === 'mcpServers')) {
            config = config.entries.find(([k]) => k === 'mcpServers')![1];
        }
        if (config?.k !== 'dict' || config.spread) {
            this.fail(call.line);
            return r;
        }
        for (const [serverName, server] of config.entries) {
            const label = serverName !== null ? reportableName(serverName) : null;
            if (label === null || server.k !== 'dict') {
                this.fail(server.line);
                continue;
            }
            const urlExpr = server.entries.find(([k]) => k === 'url')?.[1];
            let endpoint: string | null = null;
            if (urlExpr !== undefined) {
                endpoint = this.endpointOf(urlExpr);
                if (endpoint === null) {
                    this.fail(urlExpr.line);
                    continue;
                }
            }
            // A stdio server has no URL: it is the command the code starts, named where it is configured.
            r.tools.push({ name: `${label}:*`, kind: 'mcp', server: endpoint ?? codeLocator(this.at(server.line)), at });
            for (const [k, v] of server.entries) {
                if (k === null) continue;
                if (isCredentialKey(k)) r.credentials.push(...this.credentialOf(v));
                if ((k === 'headers' || k === 'env') && v.k === 'dict') {
                    for (const [hk, hv] of v.entries) if (hk !== null && isCredentialKey(hk)) r.credentials.push(...this.credentialOf(hv));
                }
            }
        }
        return r;
    }

    // ── models ─────────────────────────────────────────────────────────────

    modelOf(e: Expr, depth = 0): Resolved {
        if (e.k === 'str' && !e.template) return this.modelFromString(e.value, e.line);
        const value = this.value(e, depth);
        if (value.v === 'model') return { tools: [...value.tools], models: [...value.models], credentials: [...value.credentials] };
        this.fail(e.line);
        return empty();
    }

    private modelFromString(id: string, line: number, providerHint: string | null = null): Resolved {
        const at = this.at(line);
        const colon = id.indexOf(':');
        let provider = providerHint;
        let model: string | null = id;
        if (provider === null && colon > 0 && PROVIDER_PREFIXES[id.slice(0, colon)] !== undefined) {
            provider = PROVIDER_PREFIXES[id.slice(0, colon)];
            model = id.slice(colon + 1);
        }
        if (provider === null) {
            if (/^(?:gpt-|o[134](?:-|$)|chatgpt)/.test(id)) provider = 'openai';
            else if (/^claude/.test(id)) provider = 'anthropic';
            else if (/^gemini/.test(id)) provider = 'google-genai';
            else if (/^(?:mistral|codestral)/.test(id)) provider = 'mistralai';
        }
        const r = empty();
        const known = provider !== null ? PROVIDERS[provider] : undefined;
        r.models.push({
            provider: provider ?? 'unknown',
            model: model !== null ? reportableName(model) : null,
            endpoint: known?.endpoint ?? (known?.endpointEnv ? `env://${known.endpointEnv}` : null),
            endpointBasis: known?.endpoint ? 'provider-default' : known?.endpointEnv ? 'environment' : 'unknown',
            at,
        });
        if (known?.keyEnv) r.credentials.push({ ref: `env://${known.keyEnv}`, basis: 'provider-default', at });
        return r;
    }

    private initChatModel(call: CallExpr): Resolved {
        const id = this.option(call, ['model', 0]);
        const hint = this.option(call, ['model_provider', 'modelProvider']);
        if (id?.k !== 'str' || id.template) {
            this.fail(call.line);
            return empty();
        }
        const provider = hint?.k === 'str' && !hint.template ? (PROVIDER_PREFIXES[hint.value] ?? hint.value) : null;
        const r = this.modelFromString(id.value, call.line, provider);
        // A key passed in replaces the provider's default variable.
        const explicit = this.credentialOptions(call).credentials;
        if (explicit.length > 0 || this.options(call).some(([k]) => isCredentialKey(k))) {
            r.credentials.splice(0, r.credentials.length, ...explicit);
        }
        return r;
    }

    private chatModel(call: CallExpr, provider: string): Resolved {
        const at = this.at(call.line);
        if (call.spread) this.fail(call.line);
        const known = PROVIDERS[provider];
        const nameExpr = this.option(call, MODEL_NAME_KEYS);
        const model = nameExpr?.k === 'str' && !nameExpr.template ? reportableName(nameExpr.value) : null;

        let endpoint: string | null = null;
        let endpointBasis: DetectedModel['endpointBasis'] = 'unknown';
        // JS clients take the endpoint inside `configuration` (or `clientOptions`).
        const nested = this.option(call, ['configuration', 'clientOptions']);
        const endpointExpr = this.option(call, ENDPOINT_KEYS)
            ?? (nested?.k === 'dict' ? nested.entries.find(([k]) => k !== null && ENDPOINT_KEYS.includes(k))?.[1] : undefined);
        if (endpointExpr !== undefined) {
            endpoint = this.endpointOf(endpointExpr);
            if (endpoint === null) this.fail(endpointExpr.line);
            else endpointBasis = endpoint.startsWith('env://') ? 'environment' : 'explicit';
        } else if (known?.endpoint) {
            endpoint = known.endpoint;
            endpointBasis = 'provider-default';
        } else if (known?.endpointEnv) {
            endpoint = `env://${known.endpointEnv}`;
            endpointBasis = 'environment';
        }

        const r = this.credentialOptions(call);
        if (r.credentials.length === 0 && known?.keyEnv && !this.options(call).some(([k]) => isCredentialKey(k))) {
            r.credentials.push({ ref: `env://${known.keyEnv}`, basis: 'provider-default', at });
        }
        r.models.push({ provider, model, endpoint, endpointBasis, at });
        return r;
    }

    // ── credentials and endpoints ─────────────────────────────────────────

    /** Every option whose name says it is a credential, by reference. */
    private credentialOptions(call: CallExpr): Resolved {
        const r = empty();
        for (const [k, v] of this.options(call)) if (isCredentialKey(k)) r.credentials.push(...this.credentialOf(v));
        return r;
    }

    /** `os.environ["X"]`, `os.getenv("X")`, `process.env.X`… → the variable's name; else null. */
    private envName(e: Expr): string | null {
        const q = (x: Expr) => {
            const qq = this.qualify(x);
            return qq ? [qq.module, ...qq.path].join('.') : null;
        };
        // process.env.X / process.env["X"]
        const isProcessEnv = (x: Expr) => x.k === 'attr' && x.name === 'env' && x.obj.k === 'ref' && x.obj.name === 'process';
        if (e.k === 'attr' && isProcessEnv(e.obj)) return e.name;
        if (e.k === 'sub' && isProcessEnv(e.obj) && e.key.k === 'str' && !e.key.template) return e.key.value;
        // os.environ["X"]
        if (e.k === 'sub' && q(e.obj) === 'os.environ' && e.key.k === 'str' && !e.key.template) return e.key.value;
        // os.getenv("X"), os.environ.get("X")
        if (e.k === 'call' && (q(e.fn) === 'os.getenv' || q(e.fn) === 'os.environ.get')) {
            const arg = e.args[0];
            return arg?.k === 'str' && !arg.template ? arg.value : null;
        }
        return null;
    }

    credentialOf(e: Expr, depth = 0): DetectedCredential[] {
        const at = this.at(e.line);
        if (depth > 16) {
            this.fail(e.line);
            return [];
        }
        const env = this.envName(e);
        if (env !== null) {
            if (!ENV_NAME.test(env)) {
                this.fail(e.line);
                return [];
            }
            const out: DetectedCredential[] = [{ ref: `env://${env}`, basis: 'environment', at }];
            // `os.getenv("X", "fallback")`: a written-in fallback is a literal credential too.
            const fallback = e.k === 'call' ? e.args[1] : undefined;
            if (fallback?.k === 'str' && fallback.value !== '') out.push({ ref: codeLocator(this.at(fallback.line)), basis: 'literal', at: this.at(fallback.line) });
            return out;
        }
        switch (e.k) {
            case 'str':
                // The value is written into the code. Report WHERE, never WHAT.
                return e.value === '' ? [] : [{ ref: codeLocator(at), basis: 'literal', at }];
            case 'ref':
            case 'attr': {
                const key = this.dotted(e);
                const bound = key === null ? null : this.binding(key, e.line);
                if (bound === null) {
                    this.fail(e.line);
                    return [];
                }
                return this.credentialOf(bound, depth + 1);
            }
            case 'call': {
                const k = this.known(e.fn);
                if (k !== null && (k.name === 'SecretStr' || k.name === 'convert_to_secret_str') && e.args[0]) return this.credentialOf(e.args[0], depth + 1);
                const fnName = e.fn.k === 'ref' ? e.fn.name : null;
                if ((fnName === 'SecretStr' || fnName === 'convert_to_secret_str') && e.args[0]) return this.credentialOf(e.args[0], depth + 1);
                this.fail(e.line);
                return [];
            }
            case 'concat': {
                const fromEnv = e.parts.flatMap((p) => (this.envName(p) !== null || p.k === 'ref' ? this.credentialOf(p, depth + 1) : []));
                if (fromEnv.length > 0) return fromEnv;
                if (e.parts.every((p) => p.k === 'str')) return [{ ref: codeLocator(at), basis: 'literal', at }];
                this.fail(e.line);
                return [];
            }
            default:
                this.fail(e.line);
                return [];
        }
    }

    /** An endpoint: an http(s) URL with no credentials in it, or an `env://` reference. Null when neither. */
    endpointOf(e: Expr, depth = 0): string | null {
        if (depth > 16) return null;
        const env = this.envName(e);
        if (env !== null) return ENV_NAME.test(env) ? `env://${env}` : null;
        if (e.k === 'ref' || e.k === 'attr') {
            const key = this.dotted(e);
            const bound = key === null ? null : this.binding(key, e.line);
            return bound === null ? null : this.endpointOf(bound, depth + 1);
        }
        if (e.k !== 'str' || e.template) return null;
        let url: URL;
        try {
            url = new URL(e.value);
        } catch {
            return null;
        }
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
        const clean = `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`;
        return clean.length <= 400 && !looksLikeSecret(clean) ? clean : null;
    }

    // ── the Claude Agent SDK (#4156) ──────────────────────────────────────

    /** The name an SDK member was imported as, or null for anything not the SDK's. */
    private sdkKnown(e: Expr): string | null {
        const q = this.qualify(e);
        return q !== null && q.path.length > 0 && isClaudeAgentSdkModule(q.module) ? q.path[q.path.length - 1] : null;
    }

    /** Follow a name or attribute to the expression it was bound to; null when it is bound to nothing here. */
    private deref(e: Expr, depth = 0): Expr | null {
        if (depth > 16) return null;
        if (e.k !== 'ref' && e.k !== 'attr') return e;
        const key = this.dotted(e);
        const bound = key === null ? null : this.binding(key, e.line);
        return bound === null ? null : this.deref(bound, depth + 1);
    }

    /** Python's `None` and JavaScript's `undefined`/`null`: an option written as absent. */
    private isNothing(e: Expr): boolean {
        return e.k === 'ref' && (e.name === 'None' || e.name === 'undefined' || e.name === 'null');
    }

    /** A list of string literals. `complete` is false when an item, or the list, did not resolve. */
    private stringList(e: Expr): StringList {
        const v = this.deref(e);
        if (v !== null && v.k === 'concat') {
            const out: StringList = { items: [], complete: true };
            for (const part of v.parts) {
                const sub = this.stringList(part);
                out.items.push(...sub.items);
                out.complete &&= sub.complete;
            }
            return out;
        }
        if (v === null || v.k !== 'list') {
            this.fail(e.line);
            return { items: [], complete: false };
        }
        const out: StringList = { items: [], complete: !v.spread };
        for (const item of v.items) {
            const s = this.deref(item);
            if (s !== null && s.k === 'str' && !s.template) out.items.push({ value: s.value, line: item.line });
            else {
                this.fail(item.line);
                out.complete = false;
            }
        }
        return out;
    }

    /**
     * The options an SDK call is given. `open` is true when an option the
     * reader did not see could still be set — a spread, `**kwargs`, options
     * passed in from elsewhere — and then an option the reader did not see is
     * UNKNOWN, never the SDK's default.
     */
    private sdkOptions(e: Expr | undefined, callLine: number): { entries: ReadonlyMap<string, Expr>; open: boolean; line: number } {
        if (e === undefined || this.isNothing(e)) return { entries: new Map(), open: false, line: callLine };
        const v = this.deref(e);
        if (v !== null && v.k === 'dict') {
            const open = v.spread || v.entries.some(([k]) => k === null);
            if (open) this.fail(v.line);
            return { entries: new Map(v.entries.filter((en): en is readonly [string, Expr] => en[0] !== null)), open, line: v.line };
        }
        if (v !== null && v.k === 'call' && this.sdkKnown(v.fn) === 'ClaudeAgentOptions') {
            const open = v.spread || v.args.length > 0;
            if (open) this.fail(v.line);
            return { entries: v.kwargs, open, line: v.line };
        }
        this.fail(e.line);
        return { entries: new Map(), open: true, line: e.line };
    }

    /** Each MCP server the options configure, as a `<name>:*` tool at its URL or where the code defines it. */
    private sdkMcpServers(e: Expr | undefined, open: boolean, r: Resolved): { servers: Map<string, string>; complete: boolean } {
        const servers = new Map<string, string>();
        if (e === undefined || this.isNothing(e)) return { servers, complete: !open };
        const config = this.deref(e);
        // A Python path to a JSON file is configuration the reader cannot see.
        if (config === null || config.k !== 'dict') {
            this.fail(e.line);
            return { servers, complete: false };
        }
        let complete = !config.spread;
        if (config.spread) this.fail(config.line);
        for (const [serverName, entry] of config.entries) {
            const label = serverName !== null ? reportableName(serverName) : null;
            const server = this.deref(entry);
            if (label === null || server === null) {
                this.fail(entry.line);
                complete = false;
                continue;
            }
            const at = this.at(entry.line);
            let where: string | null = null;
            if (server.k === 'call') {
                // `createSdkMcpServer` / `create_sdk_mcp_server`: tools the code itself defines, in process.
                const k = this.sdkKnown(server.fn);
                if (k === 'createSdkMcpServer' || k === 'create_sdk_mcp_server') where = codeLocator(at);
            } else if (server.k === 'dict') {
                const urlExpr = server.entries.find(([k]) => k === 'url')?.[1];
                if (urlExpr !== undefined) {
                    where = this.endpointOf(urlExpr);
                    if (where === null) this.fail(urlExpr.line);
                } else {
                    // A stdio command, or an in-process `sdk` server: code the agent starts.
                    where = codeLocator(at);
                }
                for (const [k, v] of server.entries) {
                    if (k === null) continue;
                    if (isCredentialKey(k)) r.credentials.push(...this.credentialOf(v));
                    if (k !== 'headers' && k !== 'env') continue;
                    const nested = this.deref(v);
                    if (nested?.k === 'dict') {
                        for (const [hk, hv] of nested.entries) if (hk !== null && isCredentialKey(hk)) r.credentials.push(...this.credentialOf(hv));
                    } else {
                        this.fail(v.line);
                    }
                }
            }
            if (where === null) {
                this.fail(entry.line);
                complete = false;
                continue;
            }
            servers.set(label, where);
            r.tools.push({ name: `${label}:*`, kind: 'mcp', server: where, at });
        }
        return { servers, complete };
    }

    /**
     * One SDK agent: its tools, its model, its credentials, and the options
     * the planner maps onto the ladder. Nothing is guessed: an option that
     * does not resolve is recorded where it is written, and concludes nothing.
     */
    private sdkAgent(callLine: number, options: { entries: ReadonlyMap<string, Expr>; open: boolean }): SdkAgentRead {
        const names = this.facts.language === 'python' ? SDK_OPTIONS_PY : SDK_OPTIONS_JS;
        const get = (key: keyof typeof SDK_OPTIONS_JS): Expr | undefined => {
            const e = options.entries.get(names[key]);
            return e === undefined || this.isNothing(e) ? undefined : e;
        };
        const agentAt = this.at(callLine);
        const callLocator = codeLocator(agentAt);
        const locatorOf = (e: Expr | undefined) => (e === undefined ? callLocator : codeLocator(this.at(e.line)));
        const r = empty();

        // MCP servers first: `allowedTools` attributes `mcp__<server>__<tool>` to them.
        const mcp = this.sdkMcpServers(get('mcpServers'), options.open, r);

        // Built-in tools: what `tools` turns on (every built-in when it is left out), less `disallowedTools`.
        const toolsExpr = get('tools');
        let builtins: { names: string[]; complete: boolean };
        if (toolsExpr === undefined) {
            builtins = { names: options.open ? [] : [...SDK_DEFAULT_BUILTINS], complete: !options.open };
        } else {
            const preset = this.deref(toolsExpr);
            if (preset?.k === 'dict' && preset.entries.some(([k, v]) => k === 'preset' && v.k === 'str' && v.value === 'claude_code')) {
                builtins = { names: [...SDK_DEFAULT_BUILTINS], complete: true };
            } else {
                const list = this.stringList(toolsExpr);
                builtins = { names: list.items.map((i) => i.value), complete: list.complete };
            }
        }
        const disallowedExpr = get('disallowedTools');
        const disallowed: StringList = disallowedExpr === undefined ? { items: [], complete: !options.open } : this.stringList(disallowedExpr);
        // A scoped rule (`Bash(rm:*)`) narrows a tool; only a bare name removes it.
        const removed = new Set(disallowed.items.map((i) => i.value).filter((v) => !v.includes('(')));
        const effective = builtins.names.filter((n) => !removed.has(n));
        const effectiveComplete = builtins.complete && disallowed.complete;
        for (const name of effective) {
            const tool = reportableName(name);
            if (tool !== null) r.tools.push({ name: tool, kind: 'builtin', server: locatorOf(toolsExpr), at: agentAt });
        }

        // `allowedTools` auto-approves; it does not restrict. Its MCP names are tools of their server.
        const allowedExpr = get('allowedTools');
        const allowed: StringList = allowedExpr === undefined ? { items: [], complete: !options.open } : this.stringList(allowedExpr);
        let wildcard = false;
        for (const { value, line } of allowed.items) {
            const mcpTool = /^mcp__(.+?)__(.+)$/.exec(value);
            if (value.includes('*') || (mcpTool === null && /^mcp__[^_]/.test(value))) {
                wildcard = true;
                continue;
            }
            if (mcpTool !== null) {
                const where = mcp.servers.get(mcpTool[1]);
                const tool = reportableName(mcpTool[2]);
                // A server the options do not configure comes from somewhere the reader cannot see.
                if (where === undefined || tool === null) this.fail(line);
                else r.tools.push({ name: tool, kind: 'mcp', server: where, at: this.at(line) });
                continue;
            }
            // A built-in the agent cannot call is approved for nothing; one it can is already listed.
            const builtin = value.split('(')[0].trim();
            if (!effectiveComplete && !effective.includes(builtin)) {
                const tool = reportableName(builtin);
                if (tool !== null) r.tools.push({ name: tool, kind: 'builtin', server: locatorOf(allowedExpr), at: this.at(line) });
            }
        }

        // The model, and the endpoint and key the SDK's process reads from the environment it is given.
        const modelExpr = get('model');
        let model: string | null = null;
        if (modelExpr !== undefined) {
            const v = this.deref(modelExpr);
            if (v !== null && v.k === 'str' && !v.template) model = reportableName(v.value);
            else this.fail(modelExpr.line);
        }
        const anthropic = PROVIDERS.anthropic;
        // Options the reader cannot see whole could point the SDK elsewhere through `env`.
        let endpoint: string | null = options.open ? null : anthropic.endpoint;
        let endpointBasis: DetectedModel['endpointBasis'] = options.open ? 'unknown' : 'provider-default';
        let keyKnown = !options.open;
        let keyGiven = false;
        const envExpr = get('env');
        if (envExpr !== undefined) {
            const env = this.deref(envExpr);
            if (env === null || env.k !== 'dict') {
                this.fail(envExpr.line);
                keyKnown = false;
            } else {
                if (env.spread) {
                    this.fail(env.line);
                    keyKnown = false;
                }
                for (const [k, v] of env.entries) {
                    if (k === 'ANTHROPIC_BASE_URL') {
                        endpoint = this.endpointOf(v);
                        if (endpoint === null) this.fail(v.line);
                        endpointBasis = endpoint === null ? 'unknown' : endpoint.startsWith('env://') ? 'environment' : 'explicit';
                    } else if (k !== null && isCredentialKey(k)) {
                        r.credentials.push(...this.credentialOf(v));
                        keyGiven = true;
                    }
                }
            }
        }
        if (keyKnown && !keyGiven && anthropic.keyEnv) r.credentials.push({ ref: `env://${anthropic.keyEnv}`, basis: 'provider-default', at: agentAt });
        r.models.push({ provider: 'anthropic', model, endpoint, endpointBasis, at: agentAt });

        // The options the planner maps onto the ladder.
        const unknownWhenOpen = <T>(value: T): T | null => (options.open ? null : value);
        const modeExpr = get('permissionMode');
        let permissionMode: AgentSdkOptionFacts['permissionMode'] = unknownWhenOpen({ mode: null, at: callLocator });
        if (modeExpr !== undefined) {
            const v = this.deref(modeExpr);
            if (v !== null && v.k === 'str' && !v.template) permissionMode = { mode: v.value, at: locatorOf(modeExpr) };
            else {
                this.fail(modeExpr.line);
                permissionMode = null;
            }
        }
        const sourcesExpr = get('settingSources');
        let settingSources: AgentSdkOptionFacts['settingSources'] = unknownWhenOpen({ state: 'DEFAULT' as const, at: callLocator });
        if (sourcesExpr !== undefined) {
            const list = this.deref(sourcesExpr);
            this.stringList(sourcesExpr); // records an item it cannot read
            if (list === null || list.k !== 'list') settingSources = null;
            // One source the reader cannot name is still a source.
            else if (list.items.length > 0) settingSources = { state: 'NAMED', at: locatorOf(sourcesExpr) };
            // `[]` is the one value that loads nothing; a spread could hold anything.
            else settingSources = list.spread ? null : { state: 'EMPTY', at: locatorOf(sourcesExpr) };
        }
        const hooksExpr = get('hooks');
        let hooks: AgentSdkOptionFacts['hooks'] = unknownWhenOpen({ present: false, at: callLocator });
        if (hooksExpr !== undefined) {
            const v = this.deref(hooksExpr);
            if (v !== null && v.k === 'dict') hooks = { present: v.spread || v.entries.length > 0, at: locatorOf(hooksExpr) };
            else {
                this.fail(hooksExpr.line);
                hooks = null;
            }
        }
        const agentsExpr = get('agents');
        let subagents: number | null = options.open ? null : 0;
        if (agentsExpr !== undefined) {
            const v = this.deref(agentsExpr);
            if (v !== null && v.k === 'dict' && !v.spread) subagents = v.entries.length;
            else {
                this.fail(agentsExpr.line);
                subagents = null;
            }
        }

        const facts: AgentSdkOptionFacts = {
            permissionMode,
            settingSources,
            allowedToolsWildcard: wildcard
                ? { present: true, at: locatorOf(allowedExpr) }
                : allowed.complete ? { present: false, at: locatorOf(allowedExpr) } : null,
            shellOrFetch: (() => {
                const names = SDK_SHELL_OR_FETCH.filter((n) => effective.includes(n));
                // A name seen is callable unless a removal went unread; none seen
                // means none only when every list was read whole.
                if (names.length > 0 && disallowed.complete) return { names, at: locatorOf(toolsExpr) };
                return effectiveComplete ? { names: [], at: locatorOf(toolsExpr) } : null;
            })(),
            hooks,
        };
        return { r, facts, subagents };
    }

    /** Every Agent SDK agent in the file. */
    private sdkAgents(): { call: CallExpr; boundTo: string | null; sdk: SdkAgentRead }[] {
        const out: { call: CallExpr; boundTo: string | null; sdk: SdkAgentRead }[] = [];
        const consumedOptions = new Set<Expr>();
        const python = this.facts.language === 'python';
        for (const { call, boundTo } of this.facts.calls) {
            const k = this.sdkKnown(call.fn);
            let optionsExpr: Expr | undefined;
            if (k === 'query' && !python) {
                const arg = call.args[0] === undefined ? null : this.deref(call.args[0]);
                if (call.spread || arg === null || arg.k !== 'dict') {
                    this.fail(call.line);
                    out.push({ call, boundTo, sdk: this.sdkAgent(call.line, { entries: new Map(), open: true }) });
                    continue;
                }
                optionsExpr = arg.entries.find(([key]) => key === 'options')?.[1];
                if (optionsExpr === undefined && (arg.spread || arg.entries.some(([key]) => key === null))) {
                    this.fail(arg.line);
                    out.push({ call, boundTo, sdk: this.sdkAgent(call.line, { entries: new Map(), open: true }) });
                    continue;
                }
            } else if ((k === 'query' || k === 'ClaudeSDKClient') && python) {
                optionsExpr = call.kwargs.get('options') ?? (k === 'ClaudeSDKClient' ? call.args[0] : undefined);
                if (optionsExpr === undefined && call.spread) {
                    this.fail(call.line);
                    out.push({ call, boundTo, sdk: this.sdkAgent(call.line, { entries: new Map(), open: true }) });
                    continue;
                }
            } else {
                continue;
            }
            const resolved = optionsExpr === undefined ? null : this.deref(optionsExpr);
            if (resolved !== null) consumedOptions.add(resolved);
            const options = this.sdkOptions(optionsExpr, call.line);
            // An agent the code does not name takes the name of the options it is given.
            const named = boundTo ?? (optionsExpr?.k === 'ref' ? optionsExpr.name : null);
            out.push({ call, boundTo: named, sdk: this.sdkAgent(call.line, options) });
        }
        // Python: `ClaudeAgentOptions` no call here consumes defines an agent run elsewhere.
        if (python) {
            for (const { call, boundTo } of this.facts.calls) {
                if (consumedOptions.has(call) || this.sdkKnown(call.fn) !== 'ClaudeAgentOptions') continue;
                const options = this.sdkOptions(call, call.line);
                out.push({ call, boundTo, sdk: this.sdkAgent(call.line, options) });
            }
        }
        return out;
    }

    // ── agents ─────────────────────────────────────────────────────────────

    agents(): DetectedAgent[] {
        const consumed = new Set<CallExpr>();
        const found: {
            call: CallExpr;
            boundTo: string | null;
            framework: DetectedAgent['framework'];
            r: Resolved;
            sdk?: { facts: AgentSdkOptionFacts; subagents: number | null };
        }[] = [];

        // Executors first: each absorbs the factory it wraps.
        for (const { call, boundTo } of this.facts.calls) {
            const v = this.value(call);
            if (v.v !== 'executor') continue;
            const r = empty();
            let framework: DetectedAgent['framework'] = 'langchain';
            if (call.spread) this.fail(call.line);
            const agentExpr = this.option(call, ['agent']);
            if (agentExpr !== undefined) {
                const inner = this.value(agentExpr);
                if (inner.v === 'factory') {
                    consumed.add(inner.call);
                    merge(r, this.factory(inner.call, inner.name));
                    if (inner.module.includes('langgraph')) framework = 'langgraph';
                } else {
                    this.fail(agentExpr.line);
                }
            } else {
                // `initializeAgentExecutorWithOptions` and the like carry their own model and tools.
                this.fail(call.line);
            }
            const tools = this.option(call, ['tools']);
            if (tools !== undefined) merge(r, this.toolsOf(tools));
            found.push({ call, boundTo, framework, r });
        }
        for (const { call, boundTo } of this.facts.calls) {
            if (consumed.has(call)) continue;
            const v = this.value(call);
            if (v.v !== 'factory') continue;
            found.push({
                call,
                boundTo,
                framework: v.module.includes('langgraph') ? 'langgraph' : 'langchain',
                r: this.factory(call, v.name),
            });
        }
        // Compiled graphs.
        for (const { call, boundTo } of this.facts.calls) {
            if (call.fn.k !== 'attr' || call.fn.name !== 'compile') continue;
            const r = this.graph(call.fn.obj);
            if (r === null || (r.tools.length === 0 && r.models.length === 0)) continue;
            found.push({ call, boundTo, framework: 'langgraph', r });
        }
        // Claude Agent SDK agents.
        for (const { call, boundTo, sdk } of this.sdkAgents()) {
            found.push({ call, boundTo, framework: 'claude-agent-sdk', r: sdk.r, sdk: { facts: sdk.facts, subagents: sdk.subagents } });
        }

        const names = new Map<string, number>();
        for (const f of found) {
            const base = f.boundTo !== null ? reportableName(f.boundTo) : null;
            const name = base ?? `L${f.call.line}`;
            names.set(name, (names.get(name) ?? 0) + 1);
        }
        return found.map((f) => {
            const base = f.boundTo !== null ? reportableName(f.boundTo) : null;
            let name = base ?? `L${f.call.line}`;
            if ((names.get(name) ?? 0) > 1) name = `${name}@L${f.call.line}`;
            return {
                framework: f.framework,
                language: this.facts.language,
                name,
                discoveredId: discoveredIdOf(this.label, this.path, name),
                at: this.at(f.call.line),
                tools: dedupe(f.r.tools, (t) => `${t.server}\u0000${t.name}`),
                models: dedupe(f.r.models, (m) => `${m.provider}\u0000${m.model}\u0000${m.endpoint}\u0000${m.at.line}`),
                credentials: dedupe(f.r.credentials, (c) => c.ref),
                sdkOptions: f.sdk?.facts ?? null,
                subagents: f.sdk?.subagents ?? null,
            };
        });
    }

    private factory(call: CallExpr, name: string): Resolved {
        const table = this.facts.language === 'python' ? PY_FACTORIES : JS_FACTORIES;
        const spec = table[name];
        const r = empty();
        if (call.spread) this.fail(call.line);
        const model = this.option(call, spec.model);
        if (model === undefined) this.fail(call.line);
        else merge(r, this.modelOf(model));
        const tools = this.option(call, spec.tools);
        if (tools !== undefined) merge(r, this.toolsOf(tools));
        return r;
    }

    /** The tools and models of the graph a `.compile()` is called on, or null when it is not a `StateGraph`. */
    private graph(receiver: Expr): Resolved | null {
        const r = empty();
        const nodes: CallExpr[] = [];
        let builder: Expr = receiver;
        // A chained builder: `new StateGraph(…).addNode(…).addNode(…)`.
        for (let guard = 0; guard < 256 && builder.k === 'call' && builder.fn.k === 'attr' && GRAPH_CHAIN.has(builder.fn.name); guard++) {
            if (ADD_NODE.has(builder.fn.name)) nodes.push(builder);
            builder = builder.fn.obj;
        }
        const builderValue = this.value(builder);
        if (builderValue.v !== 'graph') return null;
        // A named builder: every `builder.add_node(…)` in the file.
        const key = this.dotted(builder);
        if (key !== null) {
            for (const { call } of this.facts.calls) {
                if (call.fn.k === 'attr' && ADD_NODE.has(call.fn.name) && this.dotted(call.fn.obj) === key) nodes.push(call);
            }
        }
        for (const node of nodes) {
            const target = node.args.length >= 2 ? node.args[1] : node.args[0];
            if (target === undefined) continue;
            const v = this.value(target);
            if (v.v === 'tools') merge(r, v);
            else if (v.v === 'factory') merge(r, this.factory(v.call, v.name));
            else if (v.v === 'model') merge(r, v);
            // A node that is a plain function is code this reader does not follow, and claims nothing.
        }
        // The models the file binds tools to are the graph's.
        for (const { call } of this.facts.calls) {
            if (call.fn.k !== 'attr' || (call.fn.name !== 'bind_tools' && call.fn.name !== 'bindTools')) continue;
            const v = this.value(call);
            if (v.v === 'model') merge(r, v);
        }
        return r;
    }
}

function dedupe<T>(items: readonly T[], key: (t: T) => string): T[] {
    const seen = new Set<string>();
    return items.filter((t) => {
        const k = key(t);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

/** Read the LangChain and LangGraph agents out of one file's facts. */
export function recognizeAgents(facts: FileFacts, file: { readonly label: string; readonly path: string }): FileDetection {
    const recognizer = new Recognizer(facts, file.label, file.path);
    const agents = recognizer.agents();
    return { agents, unresolved: dedupe(recognizer.unresolved, (u) => `${u.line}`) };
}
