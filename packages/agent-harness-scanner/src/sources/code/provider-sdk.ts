/**
 * AGENTS BUILT DIRECTLY ON A MODEL PROVIDER'S SDK, READ OUT OF ONE FILE'S FACTS.
 *
 * Not every agent is built with a framework. Many are a loop around one call:
 * the model is given tools, answers with the tool it wants called, and the
 * code calls it. This module reads that call, for four providers, in Python,
 * JavaScript and TypeScript, through the recogniser in `recognize.ts` (so a
 * reference, an endpoint and a credential are read by one set of rules).
 *
 * ── WHAT COUNTS AS AN AGENT ─────────────────────────────────────────────────
 *
 * A MODEL CALL THAT IS GIVEN TOOLS. A model call with no tools is a completion,
 * and is not reported. One call, one agent: a loop that sends the request from
 * two places is two.
 *
 * ── WHICH CALLS ARE MODEL CALLS ─────────────────────────────────────────────
 *
 * Two things together, and neither alone:
 *
 *   1. the file IMPORTS the provider's package — for its types alone counts
 *      (`import type Anthropic from '@anthropic-ai/sdk'`), because the client
 *      is very often a parameter, built in another module; and
 *   2. the call has one of that package's METHOD SHAPES, listed below, each
 *      read from the package's own type definitions or source.
 *
 * The receiver need not resolve to a client built in the file. When it does,
 * the client's options give the endpoint and the credential; when it does
 * not, the endpoint is reported as not known and no credential is claimed:
 * a client built elsewhere may point anywhere.
 *
 *   Anthropic    `@anthropic-ai/sdk`, `@anthropic-ai/bedrock-sdk`,
 *                `@anthropic-ai/vertex-sdk`, `@anthropic-ai/foundry-sdk`;
 *                Python `anthropic`
 *                  <x>.messages.create | stream | parse
 *                  <x>.beta.messages.create | stream | parse
 *                  <x>.beta.messages.toolRunner (Python: tool_runner)   — the tool loop
 *                tools in `tools`, MCP servers in `mcp_servers`
 *
 *   OpenAI       `openai` (also Azure OpenAI, which is the same package)
 *                  <x>.chat.completions.create | stream | parse
 *                  <x>.chat.completions.runTools                        — the tool loop (JavaScript)
 *                  <x>.responses.create | stream | parse
 *                  <x>.beta.assistants.create | update
 *                tools in `tools`, and in the older `functions`
 *
 *   Google       `@google/genai`; Python `google.genai`
 *                  <x>.models.generateContent | generateContentStream
 *                  <x>.models.generate_content | generate_content_stream
 *                  <x>.chats.create, <x>.live.connect
 *                tools in `config.tools`
 *                the older `@google/generative-ai` and `google.generativeai`
 *                  <x>.getGenerativeModel, <x>.generateContent |
 *                  generateContentStream | startChat; `GenerativeModel(…)`,
 *                  <x>.generate_content | generate_content_async
 *                tools in `tools`
 *
 *   AWS Bedrock  `@aws-sdk/client-bedrock-runtime`; Python `boto3`
 *                  new ConverseCommand(…), new ConverseStreamCommand(…)
 *                  <x>.converse | converseStream | converse_stream
 *                tools in `toolConfig.tools`
 *
 * ── FAIL CLOSED, NEVER SILENTLY ─────────────────────────────────────────────
 *
 * Whether a call is given tools:
 *
 *   • tools written out, and not empty → an agent, with those tools;
 *   • tools given, but not something this reader can follow (a name from
 *     another module, a function's result) → an agent, its tools not known,
 *     and the place recorded;
 *   • tools written as an empty list → not an agent, and nothing recorded;
 *   • the options read in full, and no tools among them → not an agent, and
 *     nothing recorded;
 *   • the options not readable at all (a name bound nowhere here, `**kwargs`,
 *     a spread) → for a tool loop, which exists to run tools, an agent with
 *     its tools not known; for any other method, NOT an agent, because most
 *     model calls are completions. Either way the place is recorded, so a
 *     person can look.
 *
 * Nothing is recorded for a call that is not one of these shapes in a file
 * that imports the package: an ordinary `.create(` is ordinary code.
 *
 * ── WHAT IS REPORTED ────────────────────────────────────────────────────────
 *
 * A tool by its name. A provider's own tool (web search, code execution,
 * computer use) by its type. An MCP server by its URL as the recogniser
 * reports one everywhere else (`endpointOf`: no query, no user information).
 * A credential by reference, never by value. No ladder verdict: only the
 * Claude Agent SDK's options are mapped onto the ladder.
 */
import type { CallExpr, CodeLocation, Expr, FileFacts, Qualified } from './ir';
import type { DetectedCredential, DetectedModel, DetectedTool, Resolved } from './recognize';

export type ProviderSdkFramework = 'anthropic-sdk' | 'openai-sdk' | 'google-genai-sdk' | 'bedrock-sdk';

/**
 * What this module needs of the recogniser. `Recognizer` in `recognize.ts`
 * is one; nothing here reaches past these members.
 */
export interface RecognizerSeam {
    readonly facts: FileFacts;
    /** What may be repeated from the code into a report. */
    readonly reportable: {
        locator(at: CodeLocation): string;
        name(value: string): string | null;
        modelName(value: string): string | null;
        credentialKey(key: string): boolean;
    };
    at(line: number): CodeLocation;
    /** Record a place a definition, or part of one, could not be resolved. */
    fail(line: number): void;
    qualify(e: Expr): Qualified | null;
    dotted(e: Expr): string | null;
    deref(e: Expr): Expr | null;
    isNothing(e: Expr): boolean;
    option(call: CallExpr, where: readonly (string | number)[]): Expr | undefined;
    /** A client's endpoint and credential, read the way a LangChain chat model's are. */
    chatModel(call: CallExpr, provider: string): Resolved;
    credentialOf(e: Expr): DetectedCredential[];
    endpointOf(e: Expr): string | null;
}

export interface ProviderSdkAgent {
    readonly call: CallExpr;
    readonly boundTo: string | null;
    /** The function the call is written in. */
    readonly within: string | null;
    readonly framework: ProviderSdkFramework;
    readonly r: Resolved;
}

// ─── The packages ───────────────────────────────────────────────────────────

type Family = 'anthropic' | 'openai' | 'google' | 'google-legacy' | 'bedrock';

const FAMILIES: readonly Family[] = ['anthropic', 'openai', 'google', 'google-legacy', 'bedrock'];

const FRAMEWORK: Readonly<Record<Family, ProviderSdkFramework>> = {
    anthropic: 'anthropic-sdk',
    openai: 'openai-sdk',
    google: 'google-genai-sdk',
    'google-legacy': 'google-genai-sdk',
    bedrock: 'bedrock-sdk',
};

/** The provider a family's calls reach when its client is not one this file builds. */
const FAMILY_PROVIDER: Readonly<Record<Family, string>> = {
    anthropic: 'anthropic',
    openai: 'openai',
    google: 'google-genai',
    'google-legacy': 'google-genai',
    bedrock: 'bedrock',
};

/** `root` itself, or a module below it (`openai/helpers/zod`, `anthropic.types`). */
function under(module: string, root: string, separators: string): boolean {
    return module === root || (module.startsWith(root) && separators.includes(module.charAt(root.length)));
}

const ANTHROPIC_JS_PACKAGES = ['@anthropic-ai/sdk', '@anthropic-ai/bedrock-sdk', '@anthropic-ai/vertex-sdk', '@anthropic-ai/foundry-sdk'];
const AWS_PYTHON_PACKAGES = ['boto3', 'aioboto3', 'botocore', 'aiobotocore'];

/**
 * Each family's modules. Every name here contains one of
 * `PROVIDER_SDK_MARKERS` in `files.ts`: a file that names none of them is
 * never parsed, so a package added here without its marker there finds
 * nothing, silently. A test holds the two together.
 */
const IS_MODULE: Readonly<Record<Family, (module: string) => boolean>> = {
    // Not `@anthropic-ai/claude-agent-sdk`: that is the Agent SDK, which `recognize.ts` reads.
    anthropic: (m) => under(m, 'anthropic', '.') || ANTHROPIC_JS_PACKAGES.some((p) => under(m, p, '/')),
    // Not `@langchain/openai` or `langchain_openai`: those are LangChain's.
    openai: (m) => under(m, 'openai', './'),
    google: (m) => under(m, '@google/genai', '/') || under(m, 'google.genai', '.'),
    'google-legacy': (m) => under(m, '@google/generative-ai', '/') || under(m, 'google.generativeai', '.'),
    bedrock: (m) => under(m, '@aws-sdk/client-bedrock-runtime', '/') || AWS_PYTHON_PACKAGES.some((p) => under(m, p, '.')),
};

/** One module name of each kind `IS_MODULE` admits, for the test that holds the file markers to them. */
export const PROVIDER_SDK_MODULE_EXAMPLES: readonly string[] = [
    'anthropic', '@anthropic-ai/sdk', '@anthropic-ai/bedrock-sdk', '@anthropic-ai/vertex-sdk', '@anthropic-ai/foundry-sdk',
    'openai',
    '@google/genai', 'google.genai', '@google/generative-ai', 'google.generativeai',
    '@aws-sdk/client-bedrock-runtime', 'boto3', 'aioboto3', 'botocore', 'aiobotocore',
];

/** Whether a module is a provider SDK's, by this module's rule. */
export function isProviderSdkModule(module: string): boolean {
    return FAMILIES.some((f) => IS_MODULE[f](module));
}

/** What a package's default export is: `import Anthropic from '@anthropic-ai/sdk'`. */
const DEFAULT_EXPORT: Readonly<Record<string, string>> = {
    '@anthropic-ai/sdk': 'Anthropic',
    '@anthropic-ai/bedrock-sdk': 'AnthropicBedrock',
    '@anthropic-ai/vertex-sdk': 'AnthropicVertex',
    '@anthropic-ai/foundry-sdk': 'AnthropicFoundry',
    openai: 'OpenAI',
};

/**
 * Each family's client classes, by the provider their requests reach. A
 * provider `chatModel` has no default endpoint for (`azure-ai-foundry`,
 * `bedrock-mantle`) is reported with the endpoint the client is given, or as
 * not known.
 */
const CLIENTS: Readonly<Record<Family, Readonly<Record<string, string>>>> = {
    anthropic: {
        Anthropic: 'anthropic',
        AsyncAnthropic: 'anthropic',
        AnthropicBedrock: 'bedrock',
        AsyncAnthropicBedrock: 'bedrock',
        AnthropicBedrockMantle: 'bedrock-mantle',
        AsyncAnthropicBedrockMantle: 'bedrock-mantle',
        AnthropicVertex: 'google-vertexai',
        AsyncAnthropicVertex: 'google-vertexai',
        AnthropicFoundry: 'azure-ai-foundry',
        AsyncAnthropicFoundry: 'azure-ai-foundry',
    },
    openai: { OpenAI: 'openai', AsyncOpenAI: 'openai', AzureOpenAI: 'azure-openai', AsyncAzureOpenAI: 'azure-openai' },
    google: { GoogleGenAI: 'google-genai', Client: 'google-genai' },
    'google-legacy': { GoogleGenerativeAI: 'google-genai' },
    bedrock: { BedrockRuntimeClient: 'bedrock', BedrockRuntime: 'bedrock' },
};

// ─── The method shapes ──────────────────────────────────────────────────────

/** What a call is, which decides where its tools and its model are written. */
type Kind =
    | 'anthropic'
    | 'openai-chat'
    | 'openai-responses'
    | 'openai-assistant'
    | 'google'
    | 'google-legacy-model'
    | 'google-legacy-call'
    | 'bedrock';

interface Shape {
    readonly family: Family;
    readonly kind: Kind;
    /** A tool loop: a method that exists to run tools. */
    readonly loop: boolean;
    /** The client the method is called on; null for a constructor. */
    readonly receiver: Expr | null;
    /** JavaScript: which argument is the options object. */
    readonly optionsAt: number;
}

const ANTHROPIC_METHODS: ReadonlySet<string> = new Set(['create', 'stream', 'parse']);
const ANTHROPIC_LOOPS: ReadonlySet<string> = new Set(['toolRunner', 'tool_runner']);
const OPENAI_CHAT_METHODS: ReadonlySet<string> = new Set(['create', 'stream', 'parse']);
const OPENAI_CHAT_LOOPS: ReadonlySet<string> = new Set(['runTools']);
const OPENAI_RESPONSES_METHODS: ReadonlySet<string> = new Set(['create', 'stream', 'parse']);
const OPENAI_ASSISTANT_METHODS: ReadonlySet<string> = new Set(['create', 'update']);
const GOOGLE_MODEL_METHODS: ReadonlySet<string> = new Set(['generateContent', 'generateContentStream', 'generate_content', 'generate_content_stream']);
const GOOGLE_LEGACY_CALLS: ReadonlySet<string> = new Set([
    'generateContent', 'generateContentStream', 'startChat', 'generate_content', 'generate_content_async',
]);
const BEDROCK_METHODS: ReadonlySet<string> = new Set(['converse', 'converseStream', 'converse_stream']);
const BEDROCK_COMMANDS: ReadonlySet<string> = new Set(['ConverseCommand', 'ConverseStreamCommand']);

/** Python: `client.messages.with_raw_response.create(…)` is the same call, with another return type. */
const RESPONSE_WRAPPERS: ReadonlySet<string> = new Set(['with_raw_response', 'with_streaming_response']);

/** Methods that change a list in place: one called on a tool list means the binding is not all of it. */
const MUTATORS: ReadonlySet<string> = new Set(['append', 'extend', 'insert', 'push', 'unshift', 'splice']);

// ─── Tools ──────────────────────────────────────────────────────────────────

/** `betaZodTool({ name, … })` and its siblings: a tool the code defines, named in its options. */
const ANTHROPIC_TOOL_HELPERS: ReadonlySet<string> = new Set(['betaTool', 'betaZodTool', 'betaStandardSchemaTool']);
/** `@beta_tool`, over a Python function. */
const ANTHROPIC_TOOL_DECORATORS: ReadonlySet<string> = new Set(['beta_tool', 'beta_async_tool']);
const OPENAI_TOOL_HELPERS: ReadonlySet<string> = new Set(['zodFunction', 'zodResponsesFunction', 'standardFunction', 'standardResponsesFunction']);

/** The tools Gemini itself runs, as `Tool`'s members name them, in snake case. */
const GOOGLE_BUILTINS: ReadonlySet<string> = new Set([
    'google_search', 'google_search_retrieval', 'code_execution', 'url_context', 'google_maps', 'retrieval', 'computer_use',
    'file_search', 'enterprise_web_search', 'exa_ai_search', 'parallel_ai_search',
]);

interface McpKeys {
    readonly label: string;
    readonly url: readonly string[];
    /** Where the URL and headers sit, when they are one level down. */
    readonly transport?: readonly string[];
}
const ANTHROPIC_MCP: McpKeys = { label: 'name', url: ['url'] };
const OPENAI_MCP: McpKeys = { label: 'server_label', url: ['server_url'] };
const GOOGLE_MCP: McpKeys = { label: 'name', url: ['url'], transport: ['streamable_http_transport', 'streamableHttpTransport'] };

/** An AWS or Google Cloud region, as written: `us-east-1`, `europe-west4`, `global`. */
const REGION = /^[a-z][a-z0-9-]{1,31}$/;
const BEDROCK_REGION_KEYS = ['region', 'region_name', 'aws_region', 'awsRegion'];
const VERTEX_REGION_KEYS = ['region'];

/** Where Anthropic's Vertex client sends a region's requests, as its own source computes it. */
function vertexEndpoint(region: string): string {
    if (region === 'global') return 'https://aiplatform.googleapis.com';
    if (region === 'us' || region === 'eu') return `https://aiplatform.${region}.rep.googleapis.com`;
    return `https://${region}-aiplatform.googleapis.com`;
}

const snake = (key: string): string => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** A client the file builds: its constructor call, the provider it reaches, and the argument that is its key when it takes one by position. */
interface Client {
    readonly call: CallExpr;
    readonly provider: string;
    readonly keyAt: number | null;
}

/** A call's options, or an object's members. `open` is true when one the reader did not see could still be set. */
interface Members {
    readonly entries: ReadonlyMap<string, Expr>;
    readonly open: boolean;
    readonly line: number;
}

const NO_ENTRIES: ReadonlyMap<string, Expr> = new Map();
const empty = (): Resolved => ({ tools: [], models: [], credentials: [] });

class ProviderSdkReader {
    private readonly facts: FileFacts;
    private readonly python: boolean;
    /** The families whose package the file imports. */
    private readonly imported: ReadonlySet<Family>;
    // Read once, and only if an agent asks: a file is a great many calls, and each of these is a pass over them.
    private mutatedNames: ReadonlySet<string> | null = null;
    private senders: ReadonlyMap<Expr, Expr> | null = null;
    private configured: CallExpr | null | undefined = undefined;

    constructor(private readonly s: RecognizerSeam) {
        this.facts = s.facts;
        this.python = s.facts.language === 'python';
        const modules = [...s.facts.modules];
        this.imported = new Set(FAMILIES.filter((f) => modules.some((m) => IS_MODULE[f](m))));
    }

    agents(): ProviderSdkAgent[] {
        const out: ProviderSdkAgent[] = [];
        if (this.imported.size === 0) return out;
        for (const { call, boundTo, within } of this.facts.calls) {
            // Every call in the file is asked this, and it evaluates nothing: a shape, and an import.
            const shape = this.shapeOf(call);
            if (shape === null || this.anotherAwsService(shape)) continue;
            const options = this.optionsOf(call, shape);
            const r = empty();
            let given = this.toolsOf(shape, options, r);
            // Options the reader did not see whole could carry the tools, or replace an empty list.
            if ((given === 'none' || given === 'empty') && options.open) given = 'unread';
            if (given === 'none' || given === 'empty') continue;
            if (given === 'unread') {
                this.s.fail(call.line);
                // Most model calls are completions: one whose options cannot be read is named, not called an agent.
                if (!shape.loop) continue;
            } else if (options.open) {
                this.s.fail(options.line);
            }
            this.modelOf(shape, call, options, r);
            out.push({ call, boundTo, within, framework: FRAMEWORK[shape.family], r });
        }
        return out;
    }

    // ── which calls ─────────────────────────────────────────────────────────

    /** What a name resolves to in a provider's package, through the file's imports; null for anything else. */
    private member(e: Expr): { readonly family: Family; readonly name: string } | null {
        const q = this.s.qualify(e);
        if (q === null) return null;
        // `from google import genai` binds `genai` to the module `google.genai`: the module may run into the path.
        for (let k = 0; k <= q.path.length; k++) {
            const moduleName = [q.module, ...q.path.slice(0, k)].join('.');
            const family = FAMILIES.find((f) => IS_MODULE[f](moduleName));
            if (family === undefined) continue;
            const rest = q.path.slice(k);
            const last = rest[rest.length - 1];
            const name = last === undefined || last === 'default' ? (DEFAULT_EXPORT[moduleName] ?? 'default') : last;
            return { family, name };
        }
        return null;
    }

    private shapeOf(call: CallExpr): Shape | null {
        // What the call is by its own name: a constructor from the package.
        const made = this.member(call.fn);
        if (made !== null) {
            if (made.family === 'google-legacy' && made.name === 'GenerativeModel') {
                return { family: 'google-legacy', kind: 'google-legacy-model', loop: false, receiver: null, optionsAt: 0 };
            }
            if (made.family === 'bedrock' && BEDROCK_COMMANDS.has(made.name)) {
                return { family: 'bedrock', kind: 'bedrock', loop: false, receiver: null, optionsAt: 0 };
            }
        }

        // What it is by its method: the last few names of `<x>.a.b.method`.
        const names: string[] = [];
        const objects: Expr[] = [];
        let e = call.fn;
        for (let guard = 0; guard < 6 && e.k === 'attr'; guard++) {
            names.unshift(e.name);
            objects.unshift(e.obj);
            e = e.obj;
        }
        if (names.length >= 2 && RESPONSE_WRAPPERS.has(names[names.length - 2])) {
            names.splice(names.length - 2, 1);
            objects.splice(objects.length - 1, 1);
        }
        const n = names.length;
        if (n === 0) return null;
        const method = names[n - 1];
        /** The name `back` places before the method: `back(1)` is what the method is called on. */
        const back = (i: number): string | undefined => names[n - 1 - i];
        /** The expression the last `count` names are read from. */
        const receiver = (count: number): Expr => objects[n - count];
        const shape = (family: Family, kind: Kind, count: number, loop = false, optionsAt = 0): Shape => ({
            family, kind, loop, receiver: receiver(count), optionsAt,
        });

        if (this.imported.has('anthropic') && back(1) === 'messages' && (ANTHROPIC_METHODS.has(method) || ANTHROPIC_LOOPS.has(method))) {
            // OpenAI's `beta.threads.messages.create` posts a message to a thread. It is not a model call.
            if (back(2) === 'threads') return null;
            return shape('anthropic', 'anthropic', back(2) === 'beta' ? 3 : 2, ANTHROPIC_LOOPS.has(method));
        }
        if (this.imported.has('openai')) {
            if (back(2) === 'chat' && back(1) === 'completions' && (OPENAI_CHAT_METHODS.has(method) || OPENAI_CHAT_LOOPS.has(method))) {
                // Older releases of the package kept `parse`, `stream` and `runTools` under `beta`.
                return shape('openai', 'openai-chat', back(3) === 'beta' ? 4 : 3, OPENAI_CHAT_LOOPS.has(method));
            }
            if (back(1) === 'responses' && OPENAI_RESPONSES_METHODS.has(method)) return shape('openai', 'openai-responses', 2);
            if (back(2) === 'beta' && back(1) === 'assistants' && OPENAI_ASSISTANT_METHODS.has(method)) {
                // `update(assistantId, body)` in JavaScript: the options are the second argument.
                return shape('openai', 'openai-assistant', 3, false, method === 'update' ? 1 : 0);
            }
        }
        const sessions = (back(1) === 'chats' && method === 'create') || (back(1) === 'live' && method === 'connect');
        if (this.imported.has('google') && ((back(1) === 'models' && GOOGLE_MODEL_METHODS.has(method)) || sessions)) {
            // Python's asynchronous client is `client.aio`.
            return shape('google', 'google', back(2) === 'aio' ? 3 : 2);
        }
        if (this.imported.has('google-legacy')) {
            if (method === 'getGenerativeModel') return shape('google-legacy', 'google-legacy-model', 1);
            if (GOOGLE_LEGACY_CALLS.has(method) && back(1) !== 'models') return shape('google-legacy', 'google-legacy-call', 1);
        }
        if (this.imported.has('bedrock') && BEDROCK_METHODS.has(method)) return shape('bedrock', 'bedrock', 1);
        return null;
    }

    /** `boto3.client("s3").converse(…)`: a client the file builds for a service that is not Bedrock's runtime. */
    private anotherAwsService(shape: Shape): boolean {
        if (shape.family !== 'bedrock' || !this.python || shape.receiver === null) return false;
        const built = this.s.deref(shape.receiver);
        if (built === null || built.k !== 'call' || built.fn.k !== 'attr' || built.fn.name !== 'client') return false;
        const service = this.text(built.args[0] ?? built.kwargs.get('service_name'));
        return service !== null && service !== 'bedrock-runtime';
    }

    // ── options ─────────────────────────────────────────────────────────────

    private text(e: Expr | undefined): string | null {
        const v = e === undefined ? null : this.s.deref(e);
        return v !== null && v.k === 'str' && !v.template ? v.value : null;
    }

    private name(e: Expr | undefined): string | null {
        const value = this.text(e);
        return value === null ? null : this.s.reportable.name(value);
    }

    /** `None`, `null` or `undefined`: a value written to say there is none. */
    private nothing(e: Expr): boolean {
        return (e.k === 'opaque' && e.absent === true) || this.s.isNothing(e);
    }

    /** An option that is written, and not written as absent. */
    private present(members: Members, ...keys: string[]): Expr | undefined {
        for (const key of keys) {
            const e = members.entries.get(key);
            if (e === undefined || this.nothing(e)) continue;
            // The SDKs' own "not given" markers.
            if (e.k === 'ref' && (e.name === 'NOT_GIVEN' || e.name === 'not_given' || e.name === 'omit')) continue;
            return e;
        }
        return undefined;
    }

    /**
     * The members of an object: a dictionary, or in Python a keyword
     * constructor (`types.Tool(…)`, `GenerateContentConfig(…)`, `dict(…)`).
     * Null for anything else, and for a name bound to nothing here.
     */
    private members(e: Expr | undefined): Members | null {
        const v = e === undefined ? null : this.s.deref(e);
        if (v === null) return null;
        if (v.k === 'dict') {
            const entries = new Map<string, Expr>();
            for (const [key, value] of v.entries) if (key !== null) entries.set(key, value);
            return { entries, open: v.spread || v.entries.some(([key]) => key === null), line: v.line };
        }
        if (v.k === 'call' && this.python && ((v.fn.k === 'ref' && v.fn.name === 'dict') || this.member(v.fn) !== null)) {
            return { entries: v.kwargs, open: v.spread || v.args.length > 0, line: v.line };
        }
        return null;
    }

    /** The options a model call is given. */
    private optionsOf(call: CallExpr, shape: Shape): Members {
        // Python's SDKs take every option by keyword.
        if (this.python) return { entries: call.kwargs, open: call.spread, line: call.line };
        if (call.spread) return { entries: NO_ENTRIES, open: true, line: call.line };
        const arg = call.args[shape.optionsAt];
        if (arg === undefined || this.nothing(arg)) return { entries: NO_ENTRIES, open: false, line: call.line };
        const members = this.members(arg);
        if (members !== null) return members;
        // The older Gemini package's `generateContent` takes a request object, or the prompt itself as text
        // or parts, and a prompt is what a name there almost always is. Only an object written out is read
        // as options; a tool list is given where the model is built (`getGenerativeModel`), which is read.
        if (shape.kind === 'google-legacy-call' && !(call.fn.k === 'attr' && call.fn.name === 'startChat')) {
            return { entries: NO_ENTRIES, open: false, line: call.line };
        }
        return { entries: NO_ENTRIES, open: true, line: arg.line };
    }

    // ── tools ───────────────────────────────────────────────────────────────

    /** Whether a name's list is changed in place somewhere in the file, so its binding is not all of it. */
    private mutated(e: Expr): boolean {
        const key = this.s.dotted(e);
        if (key === null) return false;
        if (this.mutatedNames === null) {
            const names = new Set<string>();
            for (const { call } of this.facts.calls) {
                const target = call.fn.k === 'attr' && MUTATORS.has(call.fn.name) ? this.s.dotted(call.fn.obj) : null;
                if (target !== null) names.add(target);
            }
            this.mutatedNames = names;
        }
        return this.mutatedNames.has(key);
    }

    /** `client.send(command)`: the client a command is sent by, when the file sends it. */
    private senderOf(command: CallExpr): Expr | null {
        if (this.senders === null) {
            const senders = new Map<Expr, Expr>();
            for (const { call } of this.facts.calls) {
                if (call.fn.k !== 'attr' || call.fn.name !== 'send' || call.args[0] === undefined) continue;
                const sent = this.s.deref(call.args[0]);
                if (sent !== null && !senders.has(sent)) senders.set(sent, call.fn.obj);
            }
            this.senders = senders;
        }
        return this.senders.get(command) ?? null;
    }

    /** `genai.configure(api_key=…)`: the older Python Gemini package is configured once, for the module. */
    private configureCall(): CallExpr | null {
        if (this.configured === undefined) {
            this.configured = this.facts.calls.find(({ call }) => {
                const m = this.member(call.fn);
                return m !== null && m.family === 'google-legacy' && m.name === 'configure';
            })?.call ?? null;
        }
        return this.configured;
    }

    /** A tool list's items, with a list inside it (a spread, a name bound to one) flattened in. */
    private items(e: Expr, single: boolean, depth = 0): { readonly items: Expr[]; readonly resolved: boolean } {
        const v = depth > 8 ? null : this.s.deref(e);
        if (v === null) return { items: [], resolved: false };
        const named = (e.k === 'ref' || e.k === 'attr') && this.mutated(e);
        if (v.k === 'concat') {
            const out: Expr[] = [];
            let resolved = !named;
            for (const part of v.parts) {
                const sub = this.items(part, false, depth + 1);
                out.push(...sub.items);
                resolved &&= sub.resolved;
            }
            return { items: out, resolved };
        }
        if (v.k !== 'list') {
            // The older Gemini packages take one tool where a list is expected.
            return single && (v.k === 'str' || v.k === 'dict' || v.k === 'call') ? { items: [e], resolved: true } : { items: [], resolved: false };
        }
        const out: Expr[] = [];
        let resolved = !v.spread && !named;
        for (const item of v.items) {
            const inner = item.k === 'ref' || item.k === 'attr' ? this.s.deref(item) : null;
            if (inner !== null && (inner.k === 'list' || inner.k === 'concat')) {
                const sub = this.items(item, false, depth + 1);
                out.push(...sub.items);
                resolved &&= sub.resolved;
            } else {
                out.push(item);
            }
        }
        return { items: out, resolved };
    }

    /** Read a tool list through `one`. False when the list is written out and empty: no tools are given. */
    private each(e: Expr, one: (item: Expr) => void, single = false): boolean {
        const list = this.items(e, single);
        if (!list.resolved) this.s.fail(e.line);
        for (const item of list.items) one(item);
        return !(list.resolved && list.items.length === 0);
    }

    /** Where a tool is defined: the item itself, or what the name written there is bound to. */
    private defined(item: Expr): number {
        return this.s.deref(item)?.line ?? item.line;
    }

    private push(r: Resolved, name: string | null, kind: DetectedTool['kind'], line: number, where?: string): void {
        if (name === null) {
            this.s.fail(line);
            return;
        }
        const at = this.s.at(line);
        r.tools.push({ name, kind, server: where ?? this.s.reportable.locator(at), at });
    }

    /**
     * What the call is given as tools: `none` when no tools option is
     * written, `empty` when one is written out as an empty list, `unread`
     * when where the tools would be written cannot be read, else `given`.
     */
    private toolsOf(shape: Shape, options: Members, r: Resolved): 'none' | 'empty' | 'unread' | 'given' {
        const lists: boolean[] = [];
        switch (shape.kind) {
            case 'anthropic': {
                const servers = new Map<string, string>();
                const mcp = this.present(options, 'mcp_servers');
                if (mcp !== undefined) lists.push(this.each(mcp, (item) => this.mcpServer(item, r, ANTHROPIC_MCP, servers)));
                const tools = this.present(options, 'tools');
                if (tools !== undefined) lists.push(this.each(tools, (item) => this.anthropicTool(item, r, servers)));
                break;
            }
            case 'openai-chat': {
                const tools = this.present(options, 'tools');
                if (tools !== undefined) lists.push(this.each(tools, (item) => this.openaiTool(item, r, false)));
                // The older parameter: a list of functions, each named at its top level.
                const functions = this.present(options, 'functions');
                if (functions !== undefined) lists.push(this.each(functions, (item) => this.openaiTool(item, r, true)));
                break;
            }
            case 'openai-responses':
            case 'openai-assistant': {
                const tools = this.present(options, 'tools');
                if (tools !== undefined) lists.push(this.each(tools, (item) => this.openaiTool(item, r, false)));
                break;
            }
            case 'google': {
                const config = this.present(options, 'config');
                if (config === undefined) return 'none';
                const members = this.members(config);
                if (members === null) return 'unread';
                const tools = this.present(members, 'tools');
                if (tools === undefined) return members.open ? 'unread' : 'none';
                lists.push(this.each(tools, (item) => this.googleTool(item, r, false)));
                break;
            }
            case 'google-legacy-model':
            case 'google-legacy-call': {
                const tools = this.present(options, 'tools');
                if (tools !== undefined) lists.push(this.each(tools, (item) => this.googleTool(item, r, true), true));
                break;
            }
            case 'bedrock': {
                const config = this.present(options, 'toolConfig');
                if (config === undefined) return 'none';
                const members = this.members(config);
                const tools = members === null ? undefined : this.present(members, 'tools');
                if (tools === undefined) {
                    // Read in full, and it lists no tools: a tool choice alone gives none.
                    if (members !== null && !members.open) return 'none';
                    this.s.fail(config.line);
                    return 'given';
                }
                lists.push(this.each(tools, (item) => this.bedrockTool(item, r)));
                break;
            }
        }
        if (lists.length === 0) return 'none';
        return lists.some((given) => given) ? 'given' : 'empty';
    }

    /** `@beta_tool def get_weather(…)`: the tool is the function, named by the decorator or by itself. */
    private decoratedTool(item: Expr): { readonly name: string | null; readonly line: number } | null {
        if (!this.python || item.k !== 'ref') return null;
        const fn = this.facts.functions.get(item.name);
        if (fn === undefined) return null;
        for (const decorator of fn.decorators) {
            const m = this.member(decorator.k === 'call' ? decorator.fn : decorator);
            if (m === null || m.family !== 'anthropic' || !ANTHROPIC_TOOL_DECORATORS.has(m.name)) continue;
            const named = decorator.k === 'call' ? decorator.kwargs.get('name') : undefined;
            return { name: named === undefined ? this.s.reportable.name(item.name) : this.name(named), line: fn.line };
        }
        return null;
    }

    /** A Python function the file defines, given to Gemini as a tool: its own name is the tool's. */
    private definedFunction(item: Expr): { readonly name: string | null; readonly line: number } | null {
        if (!this.python || item.k !== 'ref' || this.s.deref(item) !== null) return null;
        const fn = this.facts.functions.get(item.name);
        return fn === undefined ? null : { name: this.s.reportable.name(item.name), line: fn.line };
    }

    private anthropicTool(item: Expr, r: Resolved, servers: ReadonlyMap<string, string>): void {
        const decorated = this.decoratedTool(item);
        if (decorated !== null) return this.push(r, decorated.name, 'function', decorated.line);
        const v = this.s.deref(item);
        if (v !== null && v.k === 'call') {
            const m = this.member(v.fn);
            if (m !== null && m.family === 'anthropic' && ANTHROPIC_TOOL_HELPERS.has(m.name)) {
                return this.push(r, this.name(this.s.option(v, ['name'])), 'function', this.defined(item));
            }
        }
        const members = this.members(item);
        if (members === null) return this.s.fail(item.line);
        const typed = this.present(members, 'type');
        const type = typed === undefined ? 'custom' : this.text(typed);
        if (type === null) return this.s.fail(item.line);
        if (type === 'custom') return this.push(r, this.name(members.entries.get('name')), 'function', this.defined(item));
        if (type === 'mcp_toolset') {
            // The tools of an MCP server the same call names: reported with the server, above.
            const server = this.text(members.entries.get('mcp_server_name'));
            if (server === null || !servers.has(server)) this.s.fail(item.line);
            return;
        }
        // One of the provider's own tools: `web_search_20250305`, `bash_20250124`, `computer_20250124`.
        this.push(r, this.s.reportable.name(type), 'builtin', this.defined(item));
    }

    private openaiTool(item: Expr, r: Resolved, namedAtTop: boolean): void {
        const v = this.s.deref(item);
        if (v !== null && v.k === 'call') {
            const m = this.member(v.fn);
            if (m !== null && m.family === 'openai' && OPENAI_TOOL_HELPERS.has(m.name)) {
                return this.push(r, this.name(this.s.option(v, ['name'])), 'function', this.defined(item));
            }
            if (m !== null && m.family === 'openai' && m.name === 'pydantic_function_tool') {
                // Named by `name=`, else by the model class it is given.
                const named = v.kwargs.get('name');
                const model = v.args[0];
                const name = named !== undefined ? this.name(named) : model !== undefined && model.k === 'ref' ? this.s.reportable.name(model.name) : null;
                return this.push(r, name, 'function', this.defined(item));
            }
        }
        const members = this.members(item);
        if (members === null) return this.s.fail(item.line);
        if (namedAtTop) return this.push(r, this.name(members.entries.get('name')), 'function', this.defined(item));
        const type = this.text(members.entries.get('type'));
        if (type === null) return this.s.fail(item.line);
        if (type === 'function' || type === 'custom') {
            // Chat Completions nests the definition: `{ type: "function", function: { name } }`.
            const inner = this.members(members.entries.get(type));
            if (inner !== null) {
                const named = inner.entries.get('name');
                if (named !== undefined) return this.push(r, this.name(named), 'function', this.defined(item));
                // `runTools`: a function given no name is called by its own.
                const fn = inner.entries.get('function');
                return this.push(r, fn !== undefined && fn.k === 'ref' ? this.s.reportable.name(fn.name) : null, 'function', this.defined(item));
            }
            // The Responses API names it at the top level.
            return this.push(r, this.name(members.entries.get('name')), 'function', this.defined(item));
        }
        if (type === 'mcp') return this.mcpServer(item, r, OPENAI_MCP);
        if (type === 'namespace') return this.push(r, this.name(members.entries.get('name')), 'toolkit', this.defined(item));
        // One of the provider's own tools: `web_search`, `file_search`, `code_interpreter`, `computer_use_preview`.
        this.push(r, this.s.reportable.name(type), 'builtin', this.defined(item));
    }

    private googleTool(item: Expr, r: Resolved, older: boolean): void {
        const defined = this.definedFunction(item);
        if (defined !== null) return this.push(r, defined.name, 'function', defined.line);
        const v = this.s.deref(item);
        // The older Python package takes a built-in tool by name: `tools="code_execution"`.
        if (older && v !== null && v.k === 'str') {
            const builtin = v.template ? null : snake(v.value);
            return this.push(r, builtin !== null && GOOGLE_BUILTINS.has(builtin) ? builtin : null, 'builtin', this.defined(item));
        }
        const members = this.members(item);
        if (members === null) return this.s.fail(item.line);
        let found = 0;
        for (const [key, value] of members.entries) {
            if (this.nothing(value)) continue;
            const member = snake(key);
            if (member === 'function_declarations') {
                found += 1;
                this.each(value, (declaration) => {
                    const fn = this.definedFunction(declaration);
                    if (fn !== null) return this.push(r, fn.name, 'function', fn.line);
                    this.push(r, this.name(this.members(declaration)?.entries.get('name')), 'function', this.defined(declaration));
                });
            } else if (member === 'mcp_servers') {
                found += 1;
                this.each(value, (server) => this.mcpServer(server, r, GOOGLE_MCP));
            } else if (GOOGLE_BUILTINS.has(member)) {
                found += 1;
                this.push(r, member, 'builtin', this.defined(item));
            }
        }
        if (found === 0 || members.open) this.s.fail(item.line);
    }

    private bedrockTool(item: Expr, r: Resolved): void {
        const members = this.members(item);
        if (members === null) return this.s.fail(item.line);
        const spec = this.members(members.entries.get('toolSpec'));
        if (spec !== null) return this.push(r, this.name(spec.entries.get('name')), 'function', this.defined(item));
        const system = this.members(members.entries.get('systemTool'));
        if (system !== null) return this.push(r, this.name(system.entries.get('name')), 'builtin', this.defined(item));
        // A cache point sits in the list and is not a tool.
        if (members.entries.has('cachePoint') && !members.open) return;
        this.s.fail(item.line);
    }

    /** An MCP server a call is given: `<label>:*`, at its URL, or where the code configures it. */
    private mcpServer(item: Expr, r: Resolved, keys: McpKeys, servers?: Map<string, string>): void {
        const members = this.members(item);
        if (members === null) return this.s.fail(item.line);
        let holder: Members = members;
        if (keys.transport !== undefined) {
            const transport = this.members(this.present(members, ...keys.transport));
            if (transport === null) return this.s.fail(item.line);
            holder = transport;
        }
        const label = this.name(members.entries.get(keys.label));
        if (label === null) return this.s.fail(item.line);
        const url = this.present(holder, ...keys.url);
        let where = this.s.reportable.locator(this.s.at(this.defined(item)));
        if (url !== undefined) {
            const endpoint = this.s.endpointOf(url);
            if (endpoint === null) return this.s.fail(url.line);
            where = endpoint;
        }
        // With no URL, a connector the provider hosts: named where the code configures it.
        this.push(r, `${label}:*`, 'mcp', this.defined(item), where);
        servers?.set(label, where);
        for (const group of holder === members ? [members] : [members, holder]) {
            for (const [key, value] of group.entries) {
                if (this.s.reportable.credentialKey(key)) r.credentials.push(...this.s.credentialOf(value));
                if (key !== 'headers') continue;
                const headers = this.members(value);
                if (headers === null) {
                    this.s.fail(value.line);
                    continue;
                }
                for (const [header, secret] of headers.entries) {
                    if (this.s.reportable.credentialKey(header)) r.credentials.push(...this.s.credentialOf(secret));
                }
            }
        }
    }

    // ── the model, its endpoint and its credential ──────────────────────────

    /** A model's name where the code writes it; null when it does not, or it is not a name the recogniser repeats. */
    private modelName(e: Expr | undefined): string | null {
        const value = this.text(e);
        return value === null ? null : this.s.reportable.modelName(value);
    }

    /** The client a receiver is, when the file builds it: the constructor call, and the provider it reaches. */
    private clientOf(family: Family, receiver: Expr | null): Client | null {
        if (receiver === null) return null;
        let e = receiver;
        if (e.k === 'attr' && e.name === 'aio') e = e.obj;
        const v = this.s.deref(e);
        if (v === null || v.k !== 'call') return null;
        const m = this.member(v.fn);
        const provider = m !== null && (m.family === family || FRAMEWORK[m.family] === FRAMEWORK[family]) ? CLIENTS[m.family][m.name] : undefined;
        if (provider !== undefined) return { call: v, provider, keyAt: m !== null && m.name === 'GoogleGenerativeAI' ? 0 : null };
        // `boto3.client("bedrock-runtime", …)`, or the same on a session.
        if (family === 'bedrock' && this.python && v.fn.k === 'attr' && v.fn.name === 'client'
            && this.text(v.args[0] ?? v.kwargs.get('service_name')) === 'bedrock-runtime') {
            return { call: v, provider: 'bedrock', keyAt: null };
        }
        return null;
    }

    /**
     * A client's constructor, with its options where `chatModel` reads them:
     * an options object given by name is the object, and static keys nested
     * one level down (`credentials: { accessKeyId, secretAccessKey }`, as the
     * AWS client takes them) are the client's own. `whole` is false when an
     * option could be set that the reader did not see, and that place is
     * recorded.
     */
    private clientOptions(client: Client): { readonly call: CallExpr; readonly whole: boolean } {
        const { call } = client;
        let whole = !call.spread;
        if (this.python) return { call, whole };
        const args = call.args.map((arg, i): Expr => {
            if (i === client.keyAt || this.nothing(arg)) return arg;
            const v = this.s.deref(arg);
            if (v === null || v.k !== 'dict') {
                this.s.fail(arg.line);
                whole = false;
                return arg;
            }
            if (v.spread) {
                this.s.fail(v.line);
                whole = false;
            }
            const entries = v.entries.flatMap((entry) => {
                const nested = entry[0] === 'credentials' ? this.s.deref(entry[1]) : null;
                return nested !== null && nested.k === 'dict' && !nested.spread ? nested.entries : [entry];
            });
            return { ...v, entries };
        });
        return { call: { ...call, args }, whole };
    }

    /** Where a client's requests go and what it authenticates with, into `r`. */
    private client(client: Client, model: string | null, r: Resolved): void {
        const { provider } = client;
        const { call, whole } = this.clientOptions(client);
        const read = this.s.chatModel(call, provider);
        const base = read.models[0];
        let endpoint = base.endpoint;
        let endpointBasis: DetectedModel['endpointBasis'] = base.endpointBasis;
        let credentials = read.credentials;
        const withoutDefault = () => credentials.filter((c) => c.basis !== 'provider-default');
        // Options the reader did not see could name another endpoint and another key: a default is not claimed.
        if (!whole) {
            credentials = withoutDefault();
            if (endpointBasis !== 'explicit') {
                endpoint = null;
                endpointBasis = 'unknown';
            }
        }

        // A regional service: its endpoint is its region's, known only where the region is written.
        if ((provider === 'bedrock' || provider === 'google-vertexai') && endpointBasis === 'provider-default') {
            const region = this.text(
                this.s.option(call, provider === 'bedrock' ? BEDROCK_REGION_KEYS : VERTEX_REGION_KEYS)
                // `boto3.client("bedrock-runtime", "eu-west-1")`: the region is the second argument.
                ?? (this.python && call.fn.k === 'attr' && call.fn.name === 'client' ? call.args[1] : undefined),
            );
            if (region !== null && REGION.test(region)) {
                endpoint = provider === 'bedrock' ? `https://bedrock-runtime.${region}.amazonaws.com` : vertexEndpoint(region);
            } else {
                endpoint = null;
                endpointBasis = 'unknown';
            }
        }
        if (provider === 'google-genai') {
            // The Gen AI client takes its base URL one level down.
            const http = this.s.option(call, ['http_options', 'httpOptions']);
            const baseUrl = http === undefined ? undefined : this.present(this.members(http) ?? { entries: NO_ENTRIES, open: false, line: http.line }, 'base_url', 'baseUrl');
            if (baseUrl !== undefined) {
                endpoint = this.s.endpointOf(baseUrl);
                if (endpoint === null) this.s.fail(baseUrl.line);
                endpointBasis = endpoint === null ? 'unknown' : endpoint.startsWith('env://') ? 'environment' : 'explicit';
            } else if (http !== undefined && this.members(http) === null) {
                this.s.fail(http.line);
                endpoint = null;
                endpointBasis = 'unknown';
            } else if (this.s.option(call, ['vertexai', 'enterprise']) !== undefined) {
                // It may be a Vertex AI client: another host, and no API key. Which, a boolean the reader does not follow.
                endpoint = null;
                endpointBasis = 'unknown';
                credentials = withoutDefault();
            }
        }
        // `new GoogleGenerativeAI(apiKey)`: the older package takes the key by position.
        const positional = client.keyAt === null ? undefined : call.args[client.keyAt];
        if (positional !== undefined) credentials = this.s.credentialOf(positional);
        // Azure's token provider is a function: there is no key, in the code or in the default variable.
        if (provider === 'azure-openai' && this.s.option(call, ['azure_ad_token_provider', 'azureADTokenProvider']) !== undefined) {
            credentials = withoutDefault();
        }
        r.models.push({ provider, model: model ?? base.model, endpoint, endpointBasis, at: base.at });
        r.credentials.push(...credentials);
    }

    private modelOf(shape: Shape, call: CallExpr, options: Members, r: Resolved): void {
        let model = this.modelName(options.entries.get(shape.kind === 'bedrock' ? 'modelId' : 'model'));
        let receiver = shape.receiver;
        // `genAI.getGenerativeModel({ model }, { baseUrl })`: the older JavaScript package takes a base URL per model.
        let perModel: Expr | undefined = shape.kind === 'google-legacy-model' && !this.python ? call.args[1] : undefined;

        if (shape.kind === 'google-legacy-model' && this.python) {
            model = this.modelName(call.args[0] ?? call.kwargs.get('model_name'));
        }
        if (shape.kind === 'google-legacy-call' && receiver !== null) {
            // The receiver is the model object: its own construction names the model and, in JavaScript, the client.
            const built = this.s.deref(receiver);
            receiver = null;
            if (built !== null && built.k === 'call') {
                if (this.python && this.member(built.fn)?.name === 'GenerativeModel') {
                    model = this.modelName(built.args[0] ?? built.kwargs.get('model_name'));
                } else if (!this.python && built.fn.k === 'attr' && built.fn.name === 'getGenerativeModel') {
                    model = this.modelName(this.members(built.args[0])?.entries.get('model'));
                    receiver = built.fn.obj;
                    perModel = built.args[1];
                }
            }
        }
        if (shape.kind === 'bedrock' && receiver === null) {
            // `client.send(new ConverseCommand(…))`: the client is whatever sends this command.
            receiver = this.senderOf(call);
        }

        let client = this.clientOf(shape.family, receiver);
        if (client === null && shape.family === 'google-legacy' && this.python) {
            const configured = this.configureCall();
            if (configured !== null) client = { call: configured, provider: 'google-genai', keyAt: null };
        }
        // A client built somewhere this file does not show may point anywhere, and hold any key.
        if (client === null) r.models.push({ provider: FAMILY_PROVIDER[shape.family], model, endpoint: null, endpointBasis: 'unknown', at: this.s.at(call.line) });
        else this.client(client, model, r);

        if (perModel !== undefined && !this.nothing(perModel)) {
            const requestOptions = this.members(perModel);
            const baseUrl = requestOptions === null ? undefined : this.present(requestOptions, 'baseUrl');
            const last = r.models.length - 1;
            if (baseUrl !== undefined) {
                const endpoint = this.s.endpointOf(baseUrl);
                if (endpoint === null) this.s.fail(baseUrl.line);
                const endpointBasis = endpoint === null ? 'unknown' : endpoint.startsWith('env://') ? 'environment' : 'explicit';
                r.models[last] = { ...r.models[last], endpoint, endpointBasis };
            } else if (requestOptions === null || requestOptions.open) {
                this.s.fail(perModel.line);
                r.models[last] = { ...r.models[last], endpoint: null, endpointBasis: 'unknown' };
            }
        }
    }
}

/** Every agent in the file built directly on a model provider's SDK. */
export function providerSdkAgents(recognizer: RecognizerSeam): ProviderSdkAgent[] {
    return new ProviderSdkReader(recognizer).agents();
}
