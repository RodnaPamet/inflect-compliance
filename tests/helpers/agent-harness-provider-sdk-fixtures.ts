/**
 * A client estate's CODE, for agents built directly on a model provider's SDK:
 * Anthropic, OpenAI and Azure OpenAI, Google Gemini and AWS Bedrock, each in
 * Python and in TypeScript.
 *
 * Held as strings and written to a temporary directory by `writeCodeEstate`,
 * for the reasons `agent-harness-code-fixtures.ts` gives: a committed fixture
 * would be linted as this repository's own code, and a literal credential in
 * one would trip the secret scanners. Nothing here is imported or run.
 *
 * Every provider's file holds the same cases, one function each, so one table
 * of expectations reads all eight:
 *
 *   an agent        a model call with its tools written out
 *   `summarise`     a model call with no tools            → not an agent
 *   `no tools yet`  a model call with an empty tool list  → not an agent
 *   `chosen elsewhere`   tools from a parameter           → an agent, `@unresolved-tools`
 *   `passed through`     options the reader cannot see    → no agent, `@unread-options`
 *
 * A line an expectation names carries a marker in a trailing comment
 * (`@unresolved-tools`), and `lineOf` finds it: no line number is written
 * into a test.
 */
import { fakeAnthropicKey, fakeOpenAiKey, PLAIN_LITERAL_KEY } from './agent-harness-code-fixtures';

/** The 1-based line of the first line of `text` that contains `needle`. */
export function lineOf(text: string, needle: string): number {
    const at = text.split('\n').findIndex((line) => line.includes(needle));
    if (at < 0) throw new Error(`the fixture does not contain ${JSON.stringify(needle)}`);
    return at + 1;
}

export const ANTHROPIC_PY = `import os

import anthropic
from anthropic import beta_tool

client = anthropic.Anthropic(api_key=os.environ["SUPPORT_ANTHROPIC_KEY"], base_url="https://llm-gateway.acme.example/v1/route")

ORDER_TOOLS = [
    {"name": "lookup_order", "description": "Look an order up.", "input_schema": {"type": "object"}},
    {"name": "refund_order", "description": "Refund an order.", "input_schema": {"type": "object"}},
]


@beta_tool
def get_weather(city: str) -> str:
    """The weather in a city."""
    return city


def support_agent(messages):
    return client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=1024,
        tools=ORDER_TOOLS + [{"type": "web_search_20250305", "name": "web_search"}],
        messages=messages,
    )


def crm_agent(messages):
    return client.beta.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=1024,
        mcp_servers=[{"type": "url", "url": "https://mcp.acme.example/crm/sse?tenant=7", "name": "crm", "authorization_token": os.environ["CRM_MCP_TOKEN"]}],
        tools=[{"type": "mcp_toolset", "mcp_server_name": "crm"}],
        messages=messages,
    )


def weather_loop(messages):
    runner = client.beta.messages.tool_runner(model="claude-sonnet-4-5", max_tokens=1024, tools=[get_weather], messages=messages)
    return runner.until_done()


def summarise(text):
    return client.messages.create(model="claude-haiku-4-5", max_tokens=256, messages=[{"role": "user", "content": text}])


def no_tools_yet(messages):
    return client.messages.create(model="claude-haiku-4-5", max_tokens=256, tools=[], messages=messages)


def chosen_elsewhere(messages, tools):
    return client.messages.create(model="claude-sonnet-4-5", max_tokens=1024, tools=tools, messages=messages)  # @unresolved-tools


def passed_through(**kwargs):
    return client.messages.create(**kwargs)  # @unread-options


def loop_passed_through(**kwargs):
    return client.beta.messages.tool_runner(**kwargs)  # @unread-loop
`;

export const ANTHROPIC_TS = `import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

const client = new Anthropic({ apiKey: process.env.RESEARCH_ANTHROPIC_KEY });

const searchPapers = betaZodTool({
  name: "search_papers",
  description: "Search the paper index.",
  inputSchema: z.object({ query: z.string() }),
  run: async ({ query }) => query,
});

export async function researchAgent(messages: Anthropic.MessageParam[]) {
  return client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    tools: [
      { name: "save_note", description: "Save a note.", input_schema: { type: "object" } },
      { type: "bash_20250124", name: "bash" },
    ],
    messages,
  });
}

export const paperLoop = async (messages: Anthropic.Beta.BetaMessageParam[]) => {
  const runner = client.beta.messages.toolRunner({ model: "claude-sonnet-4-5", max_tokens: 1024, tools: [searchPapers], messages });
  return runner.done();
};

export class Desk {
  async crmAgent(messages: Anthropic.Beta.BetaMessageParam[]) {
    return client.beta.messages.stream({
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      mcp_servers: [{ type: "url", url: "https://mcp.acme.example/crm/sse?tenant=7", name: "crm", authorization_token: process.env.CRM_MCP_TOKEN }],
      tools: [{ type: "mcp_toolset", mcp_server_name: "crm" }],
      messages,
    });
  }

  async summarise(text: string) {
    return client.messages.create({ model: "claude-haiku-4-5", max_tokens: 256, messages: [{ role: "user", content: text }] });
  }

  async noToolsYet(messages: Anthropic.MessageParam[]) {
    return client.messages.stream({ model: "claude-haiku-4-5", max_tokens: 256, tools: [], messages });
  }

  async chosenElsewhere(messages: Anthropic.MessageParam[], tools: Anthropic.Tool[]) {
    return client.messages.create({ model: "claude-sonnet-4-5", max_tokens: 1024, tools, messages }); // @unresolved-tools
  }
}
`;

/** A client that is a PARAMETER, in a file that imports the package for its types alone. */
export const ANTHROPIC_HANDED_TS = `import type Anthropic from "@anthropic-ai/sdk";

export async function runLocked(client: Anthropic, params: Anthropic.Beta.MessageCreateParams, signal: AbortSignal) {
  const runner = client.beta.messages.toolRunner(params, { signal }); // @unread-loop
  return runner;
}

export async function triage(client: Anthropic, messages: Anthropic.MessageParam[]) {
  return client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 512,
    tools: [{ name: "open_ticket", description: "Open a ticket.", input_schema: { type: "object" } }],
    messages,
  });
}

export async function forward(client: Anthropic, body: Anthropic.MessageCreateParams) {
  return client.messages.create(body); // @unread-options
}
`;

export const ANTHROPIC_HANDED_PY = `import anthropic


def triage(client: anthropic.Anthropic, messages):
    return client.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=512,
        tools=[{"name": "open_ticket", "description": "Open a ticket.", "input_schema": {"type": "object"}}],
        messages=messages,
    )
`;

export const OPENAI_PY = `import os

from openai import AzureOpenAI, OpenAI

client = OpenAI(api_key=os.environ["SALES_OPENAI_KEY"])
azure = AzureOpenAI(azure_endpoint="https://acme-sales.openai.azure.com/", api_key=os.getenv("AZURE_SALES_KEY"), api_version="2024-10-21")


def quote_agent(messages):
    return client.chat.completions.create(
        model="gpt-4o",
        messages=messages,
        tools=[{"type": "function", "function": {"name": "price_quote", "parameters": {"type": "object"}}}],
    )


def research_agent(question):
    return client.responses.create(
        model="gpt-4.1",
        input=question,
        tools=[
            {"type": "web_search"},
            {"type": "function", "name": "open_ticket", "parameters": {"type": "object"}},
            {"type": "mcp", "server_label": "crm", "server_url": "https://mcp.acme.example/crm/sse?tenant=7", "authorization": os.environ["CRM_MCP_TOKEN"]},
        ],
    )


def legacy_agent(messages):
    return client.chat.completions.create(model="gpt-4o-mini", messages=messages, functions=[{"name": "legacy_lookup", "parameters": {"type": "object"}}])


def azure_agent(messages):
    return azure.chat.completions.create(model="sales-gpt-4o", messages=messages, tools=[{"type": "function", "function": {"name": "book_meeting", "parameters": {}}}])


assistant = client.beta.assistants.create(model="gpt-4o", name="Sales desk", tools=[{"type": "code_interpreter"}, {"type": "file_search"}])


def summarise(text):
    return client.chat.completions.create(model="gpt-4o-mini", messages=[{"role": "user", "content": text}])


def no_tools_yet(messages):
    return client.chat.completions.create(model="gpt-4o-mini", messages=messages, tools=[])


def chosen_elsewhere(question):
    return client.responses.create(model="gpt-4.1", input=question, tools=load_tools())  # @unresolved-tools


def passed_through(**kwargs):
    return client.chat.completions.create(**kwargs)  # @unread-options
`;

export const OPENAI_TS = `import OpenAI, { AzureOpenAI } from "openai";
import { zodFunction } from "openai/helpers/zod";
import { z } from "zod";

const openai = new OpenAI({ apiKey: process.env.DESK_OPENAI_KEY, baseURL: "https://llm-gateway.acme.example/v1/route" });
const azure = new AzureOpenAI({ endpoint: process.env.DESK_AZURE_ENDPOINT, apiVersion: "2024-10-21", azureADTokenProvider: tokenProvider });

const tools = [
  { type: "function" as const, function: { name: "lookup_order", parameters: { type: "object" } } },
  zodFunction({ name: "refund_order", parameters: z.object({ id: z.string() }) }),
];

async function getWeather(args: { city: string }) {
  return args.city;
}

export async function deskAgent(messages: OpenAI.ChatCompletionMessageParam[]) {
  return openai.chat.completions.create({ model: "gpt-4o", messages, tools });
}

export const weatherLoop = async (messages: OpenAI.ChatCompletionMessageParam[]) => {
  const runner = openai.chat.completions.runTools({
    model: "gpt-4o",
    messages,
    tools: [{ type: "function", function: { function: getWeather, parameters: { type: "object" } } }],
  });
  return runner.finalContent();
};

export async function researchAgent(input: string) {
  return azure.responses.create({
    model: "desk-gpt-4.1",
    input,
    tools: [{ type: "web_search_preview" }, { type: "function", name: "open_ticket", parameters: {} }],
  });
}

export async function summarise(text: string) {
  return openai.chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "user", content: text }] });
}

export async function noToolsYet(input: string) {
  return openai.responses.create({ model: "gpt-4.1", input, tools: [] });
}

export async function chosenElsewhere(messages: OpenAI.ChatCompletionMessageParam[], extra: OpenAI.ChatCompletionTool[]) {
  return openai.chat.completions.create({ model: "gpt-4o", messages, tools: [...tools, ...extra] }); // @unresolved-tools
}

export async function passedThrough(body: OpenAI.ChatCompletionCreateParamsNonStreaming) {
  return openai.chat.completions.create(body); // @unread-options
}

export async function loopPassedThrough(body: never) {
  return openai.chat.completions.runTools(body); // @unread-loop
}
`;

export const OPENAI_HANDED_TS = `import type OpenAI from "openai";

export async function triage(client: OpenAI, messages: OpenAI.ChatCompletionMessageParam[]) {
  return client.chat.completions.create({
    model: "gpt-4o",
    messages,
    tools: [{ type: "function", function: { name: "open_ticket", parameters: { type: "object" } } }],
  });
}
`;

export const OPENAI_HANDED_PY = `import openai


def triage(client: openai.OpenAI, messages):
    return client.chat.completions.create(
        model="gpt-4o",
        messages=messages,
        tools=[{"type": "function", "function": {"name": "open_ticket", "parameters": {"type": "object"}}}],
    )
`;

export const GEMINI_PY = `import os

from google import genai
from google.genai import types

client = genai.Client(api_key=os.environ["TRAVEL_GEMINI_KEY"])


def get_exchange_rate(currency: str) -> float:
    """The rate against the euro."""
    return 1.0


def travel_agent(question):
    return client.models.generate_content(
        model="gemini-2.5-flash",
        contents=question,
        config=types.GenerateContentConfig(
            tools=[
                get_exchange_rate,
                types.Tool(function_declarations=[types.FunctionDeclaration(name="book_flight", description="Book a flight.")]),
                types.Tool(google_search=types.GoogleSearch()),
                types.Tool(code_execution=types.ToolCodeExecution()),
            ],
        ),
    )


async def chat_agent():
    return client.aio.chats.create(model="gemini-2.5-pro", config={"tools": [{"function_declarations": [{"name": "find_hotel"}]}]})


def summarise(text):
    return client.models.generate_content(model="gemini-2.5-flash", contents=text)


def tuned(text):
    return client.models.generate_content(model="gemini-2.5-flash", contents=text, config=types.GenerateContentConfig(temperature=0))


def no_tools_yet(text):
    return client.models.generate_content(model="gemini-2.5-flash", contents=text, config=types.GenerateContentConfig(tools=[]))


def chosen_elsewhere(text, tools):
    return client.models.generate_content(model="gemini-2.5-flash", contents=text, config=types.GenerateContentConfig(tools=tools))  # @unresolved-tools


def passed_through(text, config):
    return client.models.generate_content(model="gemini-2.5-flash", contents=text, config=config)  # @unread-options
`;

export const GEMINI_TS = `import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.TRAVEL_GEMINI_KEY });

export async function travelAgent(question: string) {
  return ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: question,
    config: {
      tools: [
        { functionDeclarations: [{ name: "book_flight", parameters: { type: Type.OBJECT } }, { name: "find_hotel" }] },
        { googleSearch: {} },
        { mcpServers: [{ name: "crm", streamableHttpTransport: { url: "https://mcp.acme.example/crm/mcp?tenant=7", headers: { Authorization: process.env.CRM_MCP_TOKEN } } }] },
      ],
    },
  });
}

export const chatAgent = () => ai.chats.create({ model: "gemini-2.5-pro", config: { tools: [{ codeExecution: {} }] } });

export async function summarise(text: string) {
  return ai.models.generateContent({ model: "gemini-2.5-flash", contents: text });
}

export async function tuned(text: string) {
  return ai.models.generateContentStream({ model: "gemini-2.5-flash", contents: text, config: { temperature: 0 } });
}

export async function noToolsYet(text: string) {
  return ai.models.generateContent({ model: "gemini-2.5-flash", contents: text, config: { tools: [] } });
}

export async function chosenElsewhere(text: string, tools: never[]) {
  return ai.models.generateContent({ model: "gemini-2.5-flash", contents: text, config: { tools } }); // @unresolved-tools
}

export async function passedThrough(text: string, config: never) {
  return ai.models.generateContent({ model: "gemini-2.5-flash", contents: text, config }); // @unread-options
}
`;

export const GEMINI_HANDED_TS = `import type { GoogleGenAI } from "@google/genai";

export async function triage(client: GoogleGenAI, question: string) {
  return client.models.generateContent({ model: "gemini-2.5-flash", contents: question, config: { tools: [{ urlContext: {} }] } });
}
`;

export const GEMINI_HANDED_PY = `from google import genai


def triage(client: genai.Client, question):
    return client.models.generate_content(model="gemini-2.5-flash", contents=question, config={"tools": [{"url_context": {}}]})
`;

/** The older Gemini packages: tools where the model is built, or on one call. */
export const GEMINI_LEGACY_PY = `import os

import google.generativeai as genai

genai.configure(api_key=os.environ["LEGACY_GEMINI_KEY"])


def find_theaters(location: str):
    """Theaters near a place."""
    return []


model = genai.GenerativeModel("gemini-1.5-pro", tools=[find_theaters])
plain = genai.GenerativeModel("gemini-1.5-flash")


def coder(prompt):
    return plain.generate_content(prompt, tools="code_execution")


def ask(prompt):
    return model.generate_content(prompt)
`;

export const GEMINI_LEGACY_TS = `import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.LEGACY_GEMINI_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro", tools: [{ functionDeclarations: [{ name: "find_theaters" }] }] });
const plain = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

export async function ask(prompt: string) {
  return model.generateContent(prompt);
}

export async function coder(prompt: string) {
  return plain.generateContent({ contents: [{ role: "user", parts: [{ text: prompt }] }], tools: [{ codeExecution: {} }] });
}
`;

export const BEDROCK_PY = `import boto3

bedrock = boto3.client("bedrock-runtime", region_name="eu-west-1")

TOOL_CONFIG = {
    "tools": [
        {"toolSpec": {"name": "top_song", "description": "The top song on a station.", "inputSchema": {"json": {"type": "object"}}}},
        {"cachePoint": {"type": "default"}},
    ]
}


def radio_agent(messages):
    return bedrock.converse(modelId="anthropic.claude-3-5-sonnet-20240620-v1:0", messages=messages, toolConfig=TOOL_CONFIG)


def stream_agent(messages):
    return bedrock.converse_stream(
        modelId="amazon.nova-pro-v1:0",
        messages=messages,
        toolConfig={"tools": [{"toolSpec": {"name": "get_time", "inputSchema": {"json": {}}}}]},
    )


def summarise(text):
    return bedrock.converse(modelId="amazon.nova-lite-v1:0", messages=[{"role": "user", "content": [{"text": text}]}])


def no_tools_yet(messages):
    return bedrock.converse(modelId="amazon.nova-lite-v1:0", messages=messages, toolConfig={"tools": []})


def chosen_elsewhere(messages, tool_config):
    return bedrock.converse(modelId="amazon.nova-pro-v1:0", messages=messages, toolConfig=tool_config)  # @unresolved-tools


def passed_through(**kwargs):
    return bedrock.converse(**kwargs)  # @unread-options
`;

export const BEDROCK_TS = `import { BedrockRuntimeClient, ConverseCommand, ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";

const bedrock = new BedrockRuntimeClient({
  region: "us-east-1",
  credentials: { accessKeyId: process.env.RADIO_AWS_KEY_ID, secretAccessKey: process.env.RADIO_AWS_SECRET },
});

export async function radioAgent(messages: never[]) {
  const command = new ConverseCommand({
    modelId: "anthropic.claude-3-5-sonnet-20240620-v1:0",
    messages,
    toolConfig: { tools: [{ toolSpec: { name: "top_song", inputSchema: { json: {} } } }, { cachePoint: { type: "default" } }] },
  });
  return bedrock.send(command);
}

export const streamAgent = async (messages: never[]) =>
  bedrock.send(
    new ConverseStreamCommand({
      modelId: "amazon.nova-pro-v1:0",
      messages,
      toolConfig: { tools: [{ toolSpec: { name: "get_time", inputSchema: { json: {} } } }, { systemTool: { name: "nova_grounding" } }] },
    }),
  );

export async function summarise(messages: never[]) {
  return bedrock.send(new ConverseCommand({ modelId: "amazon.nova-lite-v1:0", messages }));
}

export async function noToolsYet(messages: never[]) {
  return bedrock.send(new ConverseCommand({ modelId: "amazon.nova-lite-v1:0", messages, toolConfig: { tools: [] } }));
}

export async function chosenElsewhere(messages: never[], toolConfig: never) {
  return bedrock.send(new ConverseCommand({ modelId: "amazon.nova-pro-v1:0", messages, toolConfig })); // @unresolved-tools
}

export async function passedThrough(input: never) {
  return bedrock.send(new ConverseCommand(input)); // @unread-options
}
`;

export const BEDROCK_HANDED_TS = `import type { BedrockRuntime } from "@aws-sdk/client-bedrock-runtime";

export async function triage(client: BedrockRuntime, messages: never[]) {
  return client.converse({
    modelId: "amazon.nova-pro-v1:0",
    messages,
    toolConfig: { tools: [{ toolSpec: { name: "open_ticket", inputSchema: { json: {} } } }] },
  });
}
`;

export const BEDROCK_HANDED_PY = `import boto3


def triage(client, messages):
    return client.converse(
        modelId="amazon.nova-pro-v1:0",
        messages=messages,
        toolConfig={"tools": [{"toolSpec": {"name": "open_ticket", "inputSchema": {"json": {}}}}]},
    )
`;

/** Every provider's estate: one directory per provider, a file per language, and a handed-in client beside each. */
export const PROVIDER_SDKS: Readonly<Record<string, string>> = {
    'anthropic/agents.py': ANTHROPIC_PY,
    'anthropic/agents.ts': ANTHROPIC_TS,
    'anthropic/handed.py': ANTHROPIC_HANDED_PY,
    'anthropic/handed.ts': ANTHROPIC_HANDED_TS,
    'openai/agents.py': OPENAI_PY,
    'openai/agents.ts': OPENAI_TS,
    'openai/handed.py': OPENAI_HANDED_PY,
    'openai/handed.ts': OPENAI_HANDED_TS,
    'gemini/agents.py': GEMINI_PY,
    'gemini/agents.ts': GEMINI_TS,
    'gemini/handed.py': GEMINI_HANDED_PY,
    'gemini/handed.ts': GEMINI_HANDED_TS,
    'gemini/legacy.py': GEMINI_LEGACY_PY,
    'gemini/legacy.ts': GEMINI_LEGACY_TS,
    'bedrock/agents.py': BEDROCK_PY,
    'bedrock/agents.ts': BEDROCK_TS,
    'bedrock/handed.py': BEDROCK_HANDED_PY,
    'bedrock/handed.ts': BEDROCK_HANDED_TS,
};

/**
 * The same method shapes in files that do NOT import the provider's package.
 * Each names the packages in a comment, so it is a file the source parses:
 * what keeps it out of the report is the import, not the file gate.
 */
export const NOT_PROVIDER_SDK: Readonly<Record<string, string>> = {
    'gateway/calls.py': `# Model calls go through our own gateway client, which fronts anthropic, openai, genai and bedrock. boto3 is not used here.
from gateway import client, tools


def claude(messages, **kwargs):
    client.messages.create(model="m", max_tokens=1, tools=[{"name": "x"}], messages=messages)
    client.beta.messages.tool_runner(**kwargs)
    return client.messages.create(**kwargs)


def gpt(messages, body):
    client.chat.completions.create(model="m", messages=messages, tools=tools)
    return client.responses.create(**body)


def gemini(question, config):
    return client.models.generate_content(model="m", contents=question, config=config)


def nova(messages, tool_config):
    return client.converse(modelId="m", messages=messages, toolConfig=tool_config)
`,
    'gateway/calls.ts': `// Model calls go through our own gateway client, which fronts anthropic, openai, genai and bedrock.
import { client, tools } from "./gateway";

export async function claude(messages: unknown[], params: never) {
  await client.messages.create({ model: "m", max_tokens: 1, tools: [{ name: "x" }], messages });
  client.beta.messages.toolRunner(params);
  return client.messages.create(params);
}

export async function gpt(messages: unknown[], body: never) {
  await client.chat.completions.create({ model: "m", messages, tools });
  client.chat.completions.runTools(body);
  return client.responses.create(body);
}

export async function gemini(question: string, config: never) {
  return client.models.generateContent({ model: "m", contents: question, config });
}

export async function nova(messages: unknown[], toolConfig: never) {
  return client.converse({ modelId: "m", messages, toolConfig });
}
`,
    // One provider's package, another provider's method shape: the import is per provider.
    'gateway/mixed.py': `import openai


def claude_shaped(client, messages, **kwargs):
    client.messages.create(model="m", max_tokens=1, tools=[{"name": "x"}], messages=messages)
    return client.messages.create(**kwargs)
`,
    // The Agent SDK is Anthropic's package and not its model SDK; a LangChain model package names a provider and is not its SDK.
    'gateway/not-the-sdk.ts': `import { ChatOpenAI } from "@langchain/openai";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

export async function shaped(client: { messages: { create(body: unknown): unknown } }, body: Options) {
  void ChatOpenAI;
  return client.messages.create(body);
}
`,
};

/** Ordinary code, of the kinds a file with an agent in it also holds. Appended to a fixture, it must change nothing. */
export const ORDINARY_PY = `

RULES = [{"a": 1}, {"b": 2}]
names = sorted([*RULES])
rows = sorted(RULES, key=lambda r: r["a"])


def housekeeping(db, thread, fields, *args):
    db.messages.create(body="hi", thread_id=thread.id)
    db.responses.create(status=200)
    db.things.create(**fields)
    log.info("created %s", db.models.list())
    return [route(p) for p in args]
`;

export const ORDINARY_TS = `

const RULES = [{ path: "/a" }, { path: "/b" }].filter((r) => r.path);
export const names = [...new Set(RULES.map((r) => r.path))].sort();

export async function housekeeping(store: any, data: any, more: any[]) {
  await store.message.create({ data });
  await store.messages.create({ body: "hi", threadId: data.id });
  await store.responses.create({ status: 200 });
  await store.things.create(data);
  RULES.push(...more);
  return new RegExp("x").compile();
}
`;

/** An AWS access key id's shape, built at run time. Never a real one. */
export function fakeAwsAccessKeyId(): string {
    return ['AK', 'IA', 'Q'.repeat(16)].join('');
}

/**
 * Literal credentials written into provider SDK code, in every place one can
 * sit: a client's key, an MCP server's token, header and URL, the place a
 * model's name goes, and a tool's name.
 *
 * A key in a URL's PATH is the secret-shaped one only: this scanner reports a
 * URL with its path, and refuses one that looks like a secret. A key in a
 * URL's query is either kind, because the query is never reported.
 */
export function providerSdkLiteralCredentials(): Record<string, string> {
    return {
        'hardcoded-provider/agents.py': `import anthropic
from openai import OpenAI

claude = anthropic.Anthropic(api_key="${fakeAnthropicKey()}")  # pragma: allowlist secret — a fragment-built fake, written to a temp dir
gpt = OpenAI(api_key="${PLAIN_LITERAL_KEY}")  # pragma: allowlist secret — a fake, written to a temp dir


def hardcoded_claude(messages):
    return claude.beta.messages.create(
        model="${fakeOpenAiKey()}",  # pragma: allowlist secret — a fragment-built fake where a model's name goes
        max_tokens=64,
        mcp_servers=[{"type": "url", "url": "https://mcp.acme.example/crm/sse?key=${PLAIN_LITERAL_KEY}", "name": "crm", "authorization_token": "${PLAIN_LITERAL_KEY}"}],  # pragma: allowlist secret
        tools=[{"type": "mcp_toolset", "mcp_server_name": "crm"}, {"name": "${fakeOpenAiKey()}", "input_schema": {}}],  # pragma: allowlist secret
        messages=messages,
    )


def hardcoded_gpt(question):
    return gpt.responses.create(
        model="gpt-4.1",
        input=question,
        tools=[{"type": "mcp", "server_label": "crm", "server_url": "https://mcp.acme.example/crm/mcp?key=${fakeOpenAiKey()}", "authorization": "${fakeOpenAiKey()}", "headers": {"X-Api-Key": "${PLAIN_LITERAL_KEY}"}}],  # pragma: allowlist secret
    )
`,
        'hardcoded-provider/agents.ts': `import { GoogleGenerativeAI } from "@google/generative-ai";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import OpenAI from "openai";

const genAI = new GoogleGenerativeAI("${fakeOpenAiKey()}"); // pragma: allowlist secret — a fragment-built fake, written to a temp dir
export const hardcodedGemini = genAI.getGenerativeModel({ model: "gemini-1.5-pro", tools: [{ codeExecution: {} }] });

const bedrock = new BedrockRuntimeClient({
  region: "us-east-1",
  credentials: { accessKeyId: "${fakeAwsAccessKeyId()}", secretAccessKey: "${PLAIN_LITERAL_KEY}" }, // pragma: allowlist secret — fakes, written to a temp dir
});
export const hardcodedNova = () =>
  bedrock.send(new ConverseCommand({ modelId: "amazon.nova-pro-v1:0", messages: [], toolConfig: { tools: [{ toolSpec: { name: "get_time", inputSchema: { json: {} } } }] } }));

const openai = new OpenAI({ apiKey: "${fakeOpenAiKey()}", baseURL: "https://llm-gateway.acme.example/v1/${fakeOpenAiKey()}" }); // pragma: allowlist secret
export const hardcodedGpt = () =>
  openai.chat.completions.create({ model: "gpt-4o", messages: [], tools: [{ type: "function", function: { name: "lookup_order", parameters: {} } }] });
`,
    };
}

/** Every literal `providerSdkLiteralCredentials` plants. */
export function plantedLiterals(): string[] {
    return [fakeAnthropicKey(), fakeOpenAiKey(), PLAIN_LITERAL_KEY, fakeAwsAccessKeyId()];
}
