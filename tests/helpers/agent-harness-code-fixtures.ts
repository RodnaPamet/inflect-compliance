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
