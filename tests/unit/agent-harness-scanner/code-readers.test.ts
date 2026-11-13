/**
 * The two readers under the `code` source (#3737): what they read as code, and
 * what they refuse to read at all.
 *
 * The Python reader is a hand-written tokenizer, so the cases that break a
 * naive one are pinned here: text inside strings and comments is never code,
 * a logical line spans brackets and backslashes, and a file it cannot tokenize
 * is refused whole rather than half-read.
 *
 * Both readers also say which function each call is written in, which modules
 * the file imports, and (Python) which functions it defines: what
 * `code/provider-sdk.ts` reads an agent built on a provider's SDK from. The
 * JavaScript reader reads the statements of a function that is itself a value.
 */
import { JavaScriptReadError, readJavaScript } from '../../../packages/agent-harness-scanner/src/sources/code/javascript';
import { PythonReadError, readPython, tokenizePython } from '../../../packages/agent-harness-scanner/src/sources/code/python';
import { recognizeAgents } from '../../../packages/agent-harness-scanner/src/sources/code/recognize';
import type { FileFacts } from '../../../packages/agent-harness-scanner/src/sources/code/ir';

const callNames = (facts: FileFacts) =>
    facts.calls.map(({ call }) => (call.fn.k === 'ref' ? call.fn.name : call.fn.k === 'attr' ? `.${call.fn.name}` : '?'));
const agents = (facts: FileFacts) => recognizeAgents(facts, { label: 'acme', path: 'x' }).agents.map((a) => a.name);

describe('Python: text in strings and comments is never code', () => {
    it('a docstring, a comment and a string that spell a call are not calls', () => {
        const facts = readPython(`from langgraph.prebuilt import create_react_agent
'''create_react_agent(model, tools)  # a docstring'''
# create_react_agent(model, tools)
note = "create_react_agent(model, tools) # not a comment either"
real = create_react_agent("openai:gpt-4o", [])
`);
        expect(callNames(facts)).toEqual(['create_react_agent']);
        expect(agents(facts)).toEqual(['real']);
    });

    it('quotes and escapes inside every string form do not end it early', () => {
        const toks = tokenizePython(String.raw`a = 'it\'s'
b = "say \"hi\""
c = """three "quoted" ''' lines
still the string"""
d = r'\d+\'x'
e = f"{a!r} and {b}"
`);
        const strings = toks.filter((t) => t.t === 'str').map((t) => (t as { v: string }).v);
        expect(strings).toEqual(["it's", 'say "hi"', `three "quoted" ''' lines\nstill the string`, String.raw`\d+\'x`, '{a!r} and {b}']);
    });
});

describe('Python: a logical line spans brackets and backslashes', () => {
    it('reads a call whose arguments run over several lines, and a continued assignment', () => {
        const facts = readPython(`from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent
llm = \\
    ChatOpenAI(
        model="gpt-4o",   # a trailing comment
        temperature=0,
    )
agent = create_react_agent(
    llm,
    [],
)
`);
        expect(facts.bindings.get('llm')?.[0].line).toBe(3);
        const found = recognizeAgents(facts, { label: 'acme', path: 'x' }).agents;
        expect(found.map((a) => [a.name, a.models.map((m) => m.model)])).toEqual([['agent', ['gpt-4o']]]);
    });

    it('binds every target of a chained assignment, and an annotated one', () => {
        const facts = readPython(`from langchain_openai import ChatOpenAI
a = b = ChatOpenAI(model="gpt-4o")
c: ChatOpenAI = ChatOpenAI(model="gpt-4o-mini")
`);
        expect([...facts.bindings.keys()].sort()).toEqual(['a', 'b', 'c']);
    });

    it('reads a parenthesised, aliased import list', () => {
        const facts = readPython(`from langgraph.prebuilt import (
    create_react_agent as make_agent,
    ToolNode,
)
`);
        expect(facts.imports.get('make_agent')).toEqual({ module: 'langgraph.prebuilt', path: ['create_react_agent'] });
        expect(facts.imports.get('ToolNode')).toEqual({ module: 'langgraph.prebuilt', path: ['ToolNode'] });
    });
});

describe('Python: a `for` statement runs its iterable (#4156)', () => {
    it('reads the calls in the iterable, sync and async, and a colon inside its brackets does not end it', () => {
        const facts = readPython(`from claude_agent_sdk import query

async def main():
    async for message in query(prompt="hi", options=None):
        print(message)
    for key, value in load(cfg={"retries": 3}).items():
        use(key, value)
for x in first(): second(x)
`);
        expect(callNames(facts)).toEqual(['query', 'print', '.items', 'load', 'use', 'first', 'second']);
    });

    it('a call that is only an operand of `in` elsewhere is still not read (the case the loop rule exists for)', () => {
        const facts = readPython(`if name in allowed():
    pass
`);
        expect(callNames(facts)).toEqual([]);
    });
});

describe('Python: the function a call is written in, the functions a file defines, the modules it imports', () => {
    const within = (facts: FileFacts) => facts.calls.map(({ call, within: fn }) => [call.fn.k === 'ref' ? call.fn.name : '?', fn]);

    it('a call is in the innermost `def` whose block it is indented under; a method is `Class.method`', () => {
        const facts = readPython(`top()

def main():
    first()
    if ready():
        second()

    def helper():
        third()
    fourth()

class Desk:
    client = make()

    def run(self):
        return fifth()

    async def stop(self):
        async with sixth() as s:
            for x in seventh():
                eighth(x)

def one_line(): ninth()
last()
`);
        expect(within(facts)).toEqual([
            ['top', null],
            ['first', 'main'],
            ['ready', 'main'],
            ['second', 'main'],
            ['third', 'helper'],
            ['fourth', 'main'],
            ['make', null],
            ['fifth', 'Desk.run'],
            ['sixth', 'Desk.stop'],
            ['seventh', 'Desk.stop'],
            ['eighth', 'Desk.stop'],
            ['ninth', 'one_line'],
            ['last', null],
        ]);
    });

    it('indentation inside a string or a bracket is not a block\'s, and a tab reaches the next multiple of eight', () => {
        const facts = readPython(`def main():
    text = '''
not indented, and not a statement
'''
    value = build(
a, b)
\tafter()
done()
`);
        expect(within(facts)).toEqual([['build', 'main'], ['after', 'main'], ['done', null]]);
    });

    it('keeps each function by name, with the decorators written above it', () => {
        const facts = readPython(`from anthropic import beta_tool

@beta_tool
def get_weather(city): return city

@cache
@beta_tool(name="rain")
async def get_rain(city):
    return city

def plain(): pass
`);
        expect([...facts.functions.keys()]).toEqual(['get_weather', 'get_rain', 'plain']);
        expect(facts.functions.get('get_weather')).toMatchObject({ line: 4, decorators: [{ k: 'ref', name: 'beta_tool' }] });
        expect(facts.functions.get('get_rain')!.decorators.map((d) => d.k)).toEqual(['ref', 'call']);
        expect(facts.functions.get('plain')!.decorators).toEqual([]);
        // An Anthropic tool is not a LangChain one.
        expect(facts.toolDeclarations.size).toBe(0);
    });

    it('names every module the file imports, whole: one imported under its package\'s name, and one imported from it', () => {
        const facts = readPython(`import google.generativeai
import os, boto3 as aws
from google import genai
from anthropic.types import ToolParam
`);
        expect([...facts.modules].sort()).toEqual([
            'anthropic.types', 'anthropic.types.ToolParam', 'boto3', 'google', 'google.genai', 'google.generativeai', 'os',
        ]);
        // What a name is bound to is what it was: \`google\` alone says nothing of which package.
        expect(facts.imports.get('google')).toEqual({ module: 'google', path: [] });
    });

    it('`None` is a value written to say there is none, and still not one the reader follows', () => {
        const facts = readPython('agent = build(tools=None, model=other)\n');
        const call = facts.calls[0].call;
        expect(call.kwargs.get('tools')).toEqual({ k: 'opaque', line: 1, absent: true });
        expect(call.kwargs.get('model')).toEqual({ k: 'ref', name: 'other', line: 1 });
    });
});

describe('Python: a file the tokenizer cannot read is refused whole', () => {
    it.each([
        ['an unterminated string', 'x = "never closed\n'],
        ['an unterminated triple-quoted string', 'x = """never closed\n'],
        ['unbalanced brackets', 'x = f(a, [b)\n'],
        ['a stray character', 'x = a $ b\n'],
    ])('%s', (_label, src) => {
        expect(() => readPython(src)).toThrow(PythonReadError);
    });
});

describe('JavaScript and TypeScript', () => {
    it('a file that does not parse is refused whole', () => {
        expect(() => readJavaScript('agent.ts', 'const agent = createReactAgent({ llm,, \n')).toThrow(JavaScriptReadError);
    });

    it('text in strings and comments is never code, and a namespace import resolves', () => {
        const facts = readJavaScript(
            'agent.mjs',
            `import * as prebuilt from "@langchain/langgraph/prebuilt";
// prebuilt.createReactAgent({ llm: "openai:gpt-4o", tools: [] })
const note = "prebuilt.createReactAgent({ llm, tools })";
export const real = prebuilt.createReactAgent({ llm: "openai:gpt-4o", tools: [] });
`,
        );
        expect(agents(facts)).toEqual(['real']);
    });

    it('reads the statements of a function that IS a value: an arrow bound to a name, a property, an object\'s method, a class expression', () => {
        const facts = readJavaScript(
            'x.ts',
            `const main = async () => {
    const agent = build();
    return agent;
};
handlers.start = function () { boot(); };
export const api = {
    run: async () => { step(); },
    async stop() { halt(); },
    get state() { return read(); },
};
const Service = class { go() { return move(); } };
const direct = () => answer();
`,
        );
        expect(facts.calls.map(({ call, boundTo }) => [call.fn.k === 'ref' ? call.fn.name : '?', boundTo])).toEqual([
            ['build', 'agent'],
            ['boot', null],
            ['step', null],
            ['halt', null],
            ['read', null],
            ['move', null],
            ['answer', null],
        ]);
        expect(facts.bindings.get('agent')).toHaveLength(1);
    });

    it('an agent defined inside such a function is found, where it was passed over', () => {
        const facts = readJavaScript(
            'agent.ts',
            `import { createReactAgent } from "@langchain/langgraph/prebuilt";
export const build = async () => {
    const inner = createReactAgent({ llm: "openai:gpt-4o", tools: [] });
    return inner;
};
export class Desk {
    start = async () => {
        this.agent = createReactAgent({ llm: "openai:gpt-4o", tools: [] });
    };
}
`,
        );
        expect(agents(facts)).toEqual(['inner', 'this.agent']);
    });

    it('says which function each call is written in: the innermost one that has a name', () => {
        const facts = readJavaScript(
            'x.ts',
            `top();
export async function main() {
    first();
    const inner = async () => { second(); };
    items.forEach((item) => { third(item); });
}
export class Desk {
    client = make();
    constructor() { fourth(); }
    async run() { return fifth(); }
    stop = async () => { sixth(); };
    get state() { return seventh(); }
}
export const api = { handle: async () => { eighth(); }, async close() { ninth(); } };
export default async () => { tenth(); };
function outer() { function nested() { eleventh(); } }
`,
        );
        expect(facts.calls.map(({ call, within }) => [call.fn.k === 'ref' ? call.fn.name : `.${call.fn.k === 'attr' ? call.fn.name : '?'}`, within])).toEqual([
            ['top', null],
            ['first', 'main'],
            ['second', 'inner'],
            ['.forEach', 'main'],
            // A function with no name of its own is part of the one around it.
            ['third', 'main'],
            ['make', null],
            ['fourth', 'Desk.constructor'],
            ['fifth', 'Desk.run'],
            ['sixth', 'Desk.stop'],
            ['seventh', 'Desk.state'],
            ['eighth', 'handle'],
            ['ninth', 'close'],
            ['tenth', null],
            ['eleventh', 'nested'],
        ]);
    });

    it('names every module the file imports, whether or not the import binds a name, and marks `null`', () => {
        const facts = readJavaScript(
            'x.ts',
            `import type Anthropic from "@anthropic-ai/sdk";
import "openai/shims/node";
import { type Tool } from "@google/genai";
export { z } from "zod";
const aws = require("@aws-sdk/client-bedrock-runtime");
const text = "from 'not-a-module'";
const agent = build({ tools: null });
`,
        );
        expect([...facts.modules].sort()).toEqual(['@anthropic-ai/sdk', '@aws-sdk/client-bedrock-runtime', '@google/genai', 'openai/shims/node', 'zod']);
        // A module imported for its types alone still binds the name a client is typed by.
        expect(facts.imports.get('Anthropic')).toEqual({ module: '@anthropic-ai/sdk', path: ['default'] });
        expect(facts.functions.size).toBe(0);
        const built = facts.calls.find(({ boundTo }) => boundTo === 'agent')!.call.args[0];
        expect(built.k === 'dict' ? built.entries : null).toEqual([['tools', { k: 'opaque', line: 7, absent: true }]]);
    });
});
