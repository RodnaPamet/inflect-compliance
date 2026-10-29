/**
 * A client estate's CODE, for the LangChain and LangGraph detector (#3737).
 *
 * The fixtures are Python and JavaScript/TypeScript source held as strings and
 * written to a temporary directory by `writeCodeEstate`, rather than committed
 * as files: committed `.ts`/`.js` fixtures would be type-checked and linted as
 * this repository's own code, and a literal credential in one would trip the
 * secret scanners. Nothing here is ever imported or run — which is the point of
 * the detector, and the side-effect fixture proves it.
 *
 * Three estates, one per framework the issue names:
 *
 *   langchain-python  `support/agent.py` — `create_tool_calling_agent` wrapped
 *                     in an `AgentExecutor`, `@tool` functions, a `Tool(...)`
 *                     and a prebuilt Tavily tool, an OpenAI model behind a
 *                     gateway
 *   langchain-js      `research/agent.ts` — LangChain JS, `tool()` and a
 *                     `DynamicStructuredTool`, an Anthropic model; and
 *                     `research/triage.js`, LangGraph JS's prebuilt agent
 *   langgraph         `ops/graph.py` — a hand-built `StateGraph` with a
 *                     `ToolNode` and a model bound to tools, and a prebuilt
 *                     agent over an MCP server's tools
 *
 * Plus the ones that must not produce a clean read: an unresolvable definition,
 * a file that does not parse, and literal credentials (assembled at run time
 * from fragments, so no credential pattern sits in this file).
 *
 * And the Claude Agent SDK's (#4156): `AGENT_SDK_TS`, `AGENT_SDK_PY`, the
 * shapes the reader cannot resolve (`AGENT_SDK_UNRESOLVED`), and functions
 * called `query` that are not the SDK's (`NOT_AGENT_SDK`).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

export const LANGCHAIN_PYTHON: Readonly<Record<string, string>> = {
    'support/agent.py': `import os

from langchain.agents import AgentExecutor, create_tool_calling_agent
from langchain_community.tools.tavily_search import TavilySearchResults
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.tools import Tool, tool
from langchain_openai import ChatOpenAI


@tool
def lookup_order(order_id: str) -> str:
    """Look an order up by its id."""
    return f"order {order_id}"


@tool("refund_order")
def refund(order_id: str, amount: float) -> str:
    """Refund an order. 'Quotes' and # hashes in a docstring are text."""
    return "refunded"


def _escalate(ticket: str) -> str:
    return ticket


escalate = Tool(name="escalate_ticket", func=_escalate, description="Escalate a ticket to a person.")

llm = ChatOpenAI(
    model="gpt-4o-mini",
    api_key=os.environ["SUPPORT_OPENAI_KEY"],
    base_url="https://llm-gateway.acme.example/v1",
    temperature=0,
)

tools = [lookup_order, refund, escalate, TavilySearchResults(max_results=3)]

prompt = ChatPromptTemplate.from_messages(
    [("system", "You are a support agent."), ("human", "{input}"), ("placeholder", "{agent_scratchpad}")]
)

agent = create_tool_calling_agent(llm, tools, prompt)
support_executor = AgentExecutor(agent=agent, tools=tools, verbose=False)
`,
};

export const LANGCHAIN_JS: Readonly<Record<string, string>> = {
    'research/agent.ts': `import { ChatAnthropic } from "@langchain/anthropic";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { DynamicStructuredTool, tool } from "@langchain/core/tools";
import { AgentExecutor, createToolCallingAgent } from "langchain/agents";
import { z } from "zod";

const searchPapers = tool(async ({ query }: { query: string }) => \`results for \${query}\`, {
  name: "search_papers",
  description: "Search the paper index.",
  schema: z.object({ query: z.string() }),
});

const saveNote = new DynamicStructuredTool({
  name: "save_note",
  description: "Save a research note.",
  schema: z.object({ text: z.string() }),
  func: async ({ text }) => text,
});

const llm = new ChatAnthropic({
  model: "research-model-v1",
  apiKey: process.env.RESEARCH_ANTHROPIC_KEY,
});

const prompt = ChatPromptTemplate.fromMessages([
  ["system", "You research."],
  ["human", "{input}"],
  ["placeholder", "{agent_scratchpad}"],
]);

const tools = [searchPapers, saveNote];
const agent = await createToolCallingAgent({ llm, tools, prompt });
export const researchExecutor = new AgentExecutor({ agent, tools });
`,
    'research/triage.js': `const { ChatOpenAI } = require("@langchain/openai");
const { TavilySearchResults } = require("@langchain/community/tools/tavily_search");
const { createReactAgent } = require("@langchain/langgraph/prebuilt");

const model = new ChatOpenAI({ model: "gpt-4o", configuration: { baseURL: process.env.TRIAGE_LLM_URL } });
const triageAgent = createReactAgent({ llm: model, tools: [new TavilySearchResults({ maxResults: 2 })] });

module.exports = { triageAgent };
`,
};

export const LANGGRAPH: Readonly<Record<string, string>> = {
    'ops/graph.py': `import os

from langchain_anthropic import ChatAnthropic
from langchain_core.tools import tool
from langchain_mcp_adapters.client import MultiServerMCPClient
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode, create_react_agent, tools_condition


@tool
def restart_service(name: str) -> str:
    """Restart a service."""
    return name


@tool
def read_metrics(name: str) -> str:
    """Read a service's metrics."""
    return name


ops_tools = [restart_service, read_metrics]
model = ChatAnthropic(model="ops-model-v1", api_key=os.getenv("OPS_ANTHROPIC_KEY")).bind_tools(ops_tools)


def call_model(state: MessagesState):
    return {"messages": [model.invoke(state["messages"])]}


builder = StateGraph(MessagesState)
builder.add_node("agent", call_model)
builder.add_node("tools", ToolNode(ops_tools))
builder.add_edge(START, "agent")
builder.add_conditional_edges("agent", tools_condition)
builder.add_edge("tools", "agent")
ops_graph = builder.compile()

client = MultiServerMCPClient(
    {
        "tickets": {
            "url": "https://mcp.acme.example/tickets/mcp",
            "transport": "streamable_http",
            "headers": {"Authorization": "Bearer " + os.environ["TICKETS_MCP_TOKEN"]},
        },
    }
)


async def build_oncall_agent():
    mcp_tools = await client.get_tools()
    oncall_agent = create_react_agent("openai:gpt-4.1", mcp_tools + [read_metrics])
    return oncall_agent
`,
};

/** A definition built from what the reader cannot see, and a file that does not parse. */
export const UNPARSEABLE: Readonly<Record<string, string>> = {
    'dynamic/assistant.py': `from langgraph.prebuilt import create_react_agent

from acme.llm import build_model
from acme.tools import load_tools_for

assistant = create_react_agent(build_model(), load_tools_for("assistant"))
`,
    'broken/agent.py': `from langchain_openai import ChatOpenAI

llm = ChatOpenAI(model="gpt-4o"
`,
};

/** Nothing named for the framework is the framework's: a local `create_react_agent` is not LangGraph's. */
export const NOT_LANGCHAIN: Readonly<Record<string, string>> = {
    'lookalike/agent.py': `# langchain is mentioned, but nothing here is imported from it.
def create_react_agent(model, tools):
    return (model, tools)


lookalike = create_react_agent("openai:gpt-4o", [])
`,
};

// ─── The Claude Agent SDK (#4156) ──────────────────────────────────────────

/**
 * Agent SDK agents in TypeScript: one hardened the way the connect wizard's
 * snippet hardens it, which the scanner reports with no option verdict, and one
 * left at the SDK's permissive defaults.
 */
export const AGENT_SDK_TS: Readonly<Record<string, string>> = {
    'support-bot/agent.ts': `import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const notes = createSdkMcpServer({
  name: "notes",
  version: "1.0.0",
  tools: [tool("save_note", "Save a note.", { text: z.string() }, async ({ text }) => ({ content: [{ type: "text", text }] }))],
});

const options = {
  model: "claude-sonnet-5-5",
  tools: [],
  allowedTools: ["mcp__inflect__list_risks", "mcp__inflect__list_controls", "mcp__notes__save_note"],
  mcpServers: {
    inflect: {
      type: "http",
      url: "https://inflect.acme.example/api/mcp",
      headers: { Authorization: "Bearer " + process.env.INFLECT_API_KEY },
    },
    notes,
  },
  permissionMode: "dontAsk",
  settingSources: [],
  strictMcpConfig: true,
  hooks: { PreToolUse: [{ hooks: [async () => ({})] }] },
};

export async function run(prompt: string) {
  for await (const message of query({ prompt, options })) {
    if (message.type === "result") return message;
  }
}
`,
    'ops-bot/agent.ts': `import { query } from "@anthropic-ai/claude-agent-sdk";

export const opsRun = query({
  prompt: "Restart the failing service.",
  options: {
    allowedTools: ["Bash", "mcp__ops__*"],
    mcpServers: { ops: { command: "npx", args: ["ops-mcp"], env: { OPS_TOKEN: process.env.OPS_TOKEN } } },
    permissionMode: "bypassPermissions",
  },
});
`,
};

/**
 * Agent SDK agents in Python: a `ClaudeSDKClient` with settings off and no
 * hook, a `query` that names setting sources and approves everything, and a
 * `ClaudeAgentOptions` no call in its file consumes.
 */
export const AGENT_SDK_PY: Readonly<Record<string, string>> = {
    'triage/agent.py': `import os

from claude_agent_sdk import AgentDefinition, ClaudeAgentOptions, ClaudeSDKClient

options = ClaudeAgentOptions(
    model="claude-opus-5-5",
    tools=["Read", "Grep"],
    disallowed_tools=["WebFetch"],
    allowed_tools=["mcp__inflect__list_findings"],
    mcp_servers={
        "inflect": {
            "type": "http",
            "url": "https://inflect.acme.example/api/mcp",
            "headers": {"Authorization": "Bearer " + os.environ["INFLECT_API_KEY"]},
        }
    },
    permission_mode="dontAsk",
    setting_sources=[],
    agents={"reviewer": AgentDefinition(description="Reviews a finding.", prompt="Review it.", tools=["Read"])},
)


async def triage(prompt: str) -> None:
    async with ClaudeSDKClient(options=options) as client:
        await client.query(prompt)
`,
    'digest/agent.py': `from claude_agent_sdk import ClaudeAgentOptions, query


async def digest():
    async for message in query(
        prompt="Summarise the week.",
        options=ClaudeAgentOptions(allowed_tools=["*"], permission_mode="bypassPermissions", setting_sources=["project"]),
    ):
        print(message)
`,
    'shared/options.py': `from claude_agent_sdk import ClaudeAgentOptions

support_options = ClaudeAgentOptions(tools=[], setting_sources=[], hooks={"PreToolUse": []})
`,
};

/** Agent SDK definitions with a part the reader cannot see, one shape per file. */
export const AGENT_SDK_UNRESOLVED: Readonly<Record<string, string>> = {
    'passed-in/agent.ts': `import { query, type Options } from "@anthropic-ai/claude-agent-sdk";

export function start(options: Options) {
  return query({ prompt: "Go.", options });
}
`,
    'computed/agent.py': `from claude_agent_sdk import ClaudeAgentOptions

from acme.tools import pick_tools

computed_options = ClaudeAgentOptions(tools=pick_tools(), setting_sources=[])
`,
    'json-servers/agent.py': `from claude_agent_sdk import ClaudeAgentOptions

json_options = ClaudeAgentOptions(tools=[], mcp_servers="/etc/acme/mcp.json", allowed_tools=["mcp__crm__update_deal"])
`,
    'spread/agent.py': `from claude_agent_sdk import ClaudeAgentOptions

from acme.config import BASE

spread_options = ClaudeAgentOptions(**BASE, model="claude-sonnet-5-5")
`,
};

/**
 * Nothing called `query` is the SDK's unless it is imported from the SDK. Each
 * file imports something else from the SDK, so it is read rather than passed
 * over, and calls a `query` of its own.
 */
export const NOT_AGENT_SDK: Readonly<Record<string, string>> = {
    'lookalike/query.py': `from acme.db import query as db_query
from claude_agent_sdk import AgentDefinition


def query(prompt, options=None):
    return prompt


reviewer = AgentDefinition(description="Reviews a finding.", prompt="Review it.")
local_result = query(prompt="hi", options={"allowed_tools": ["*"]})
rows = db_query("select 1")
`,
    'lookalike/query.ts': `import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { query as dbQuery } from "./db";

function query(args: { prompt: string; options?: Options }) {
  return args.prompt;
}

export const notAnAgent = query({ prompt: "hi", options: { allowedTools: ["*"] } });
export const rows = dbQuery("select 1");
`,
};

/** An Anthropic-shaped key, built at run time. Never a real credential. */
export function fakeAnthropicKey(): string {
    return ['s', 'k-', 'ant-', 'api03-', 'Q'.repeat(48)].join('');
}

/** An Agent SDK agent with its key written into the code, in both languages. */
export function agentSdkLiteralCredentials(): Record<string, string> {
    return {
        'hardcoded-sdk/agent.ts': `import { query } from "@anthropic-ai/claude-agent-sdk";

export const hardcodedSdkTs = query({ prompt: "x", options: { tools: [], settingSources: [], env: { ANTHROPIC_API_KEY: "${fakeAnthropicKey()}" } } }); // pragma: allowlist secret — a fragment-built fake, written to a temp dir
`,
        'hardcoded-sdk/agent.py': `from claude_agent_sdk import ClaudeAgentOptions

hardcoded_sdk_py = ClaudeAgentOptions(tools=[], setting_sources=[], env={"ANTHROPIC_API_KEY": "${PLAIN_LITERAL_KEY}"})  # pragma: allowlist secret — a fake, written to a temp dir
`,
    };
}

/** The marker the side-effect fixtures would write if anything ever loaded them. */
export const SIDE_EFFECT_ENV = 'HARNESS_SIDE_EFFECT_MARKER';

/**
 * Definitions whose IMPORT would have a side effect: each writes the marker
 * file and sets a global the moment it is loaded, executed or imported.
 */
export const SIDE_EFFECT: Readonly<Record<string, string>> = {
    'side-effect/agent.js': `require("fs").writeFileSync(process.env.${SIDE_EFFECT_ENV}, "required");
globalThis.__harnessSideEffect = "required";
const { ChatOpenAI } = require("@langchain/openai");
const { createReactAgent } = require("@langchain/langgraph/prebuilt");

const loadedAgent = createReactAgent({ llm: new ChatOpenAI({ model: "gpt-4o-mini" }), tools: [] });
module.exports = { loadedAgent };
`,
    'side-effect/agent.mjs': `import { writeFileSync } from "node:fs";
import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

writeFileSync(process.env.${SIDE_EFFECT_ENV}, "imported");
globalThis.__harnessSideEffect = "imported";

export const importedAgent = createReactAgent({ llm: new ChatOpenAI({ model: "gpt-4o-mini" }), tools: [] });
`,
    'side-effect/agent.py': `import os

open(os.environ["${SIDE_EFFECT_ENV}"], "w").write("executed")

from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent

executed_agent = create_react_agent(ChatOpenAI(model="gpt-4o-mini"), [])
`,
};

/** A credential-shaped literal, built at run time. Never a real credential. */
export function fakeOpenAiKey(): string {
    return ['s', 'k-', 'proj', 'Q'.repeat(40)].join('');
}

/** A literal with no known credential shape: what only "by reference" keeps out of a report. */
export const PLAIN_LITERAL_KEY = ['plain', 'literal', 'not', 'a', 'known', 'shape', '7f3a'].join('-');

/** Literal credentials written into code, in both languages. */
export function literalCredentials(): Record<string, string> {
    return {
        'hardcoded/agent.py': `from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent

llm = ChatOpenAI(model="gpt-4o", api_key="${fakeOpenAiKey()}")  # pragma: allowlist secret — a fragment-built fake, written to a temp dir
hardcoded_py = create_react_agent(llm, [])
`,
        'hardcoded/agent.js': `const { ChatOpenAI } = require("@langchain/openai");
const { createReactAgent } = require("@langchain/langgraph/prebuilt");

const llm = new ChatOpenAI({ model: "gpt-4o", apiKey: "${PLAIN_LITERAL_KEY}" }); // pragma: allowlist secret — a fake, written to a temp dir
const hardcodedJs = createReactAgent({ llm, tools: [] });
module.exports = { hardcodedJs };
`,
    };
}

/** Write files below a fresh temporary directory, and return it. */
export function writeCodeEstate(...trees: Readonly<Record<string, string>>[]): string {
    const root = mkdtempSync(join(tmpdir(), 'harness-code-'));
    for (const tree of trees) {
        for (const [path, text] of Object.entries(tree)) {
            const abs = join(root, path);
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(abs, text);
        }
    }
    return root;
}
