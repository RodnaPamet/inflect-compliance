/**
 * A faux Anthropic Messages API, for the spike's `--faux` mode and its tests.
 *
 * It answers `POST /v1/messages` (streaming or not) with SCRIPTED assistant
 * turns: turn k calls the tools the script names for k, and the turn after the
 * last scripted one answers in text. A request is placed in the script by the
 * number of assistant turns already in its `messages`, so a retried request
 * gets the same answer. Requests that do not carry the profile's tools (the
 * CLI's own side calls, if any) get a one-line text answer and are recorded
 * apart.
 *
 * Every request is recorded (path, time, model, tool names, and the full
 * system + messages text) so a test can assert what the subprocess SENT, not
 * only what it reported in `system/init`.
 *
 * Faux-mode timings measure the SDK and its subprocess, never model latency:
 * this server answers in well under a millisecond.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** The key every faux run sends. The faux API checks nothing; the value only has to be present. */
export const FAUX_KEY = 'faux';

export interface FauxRequest {
    at: number;
    method: string;
    path: string;
    /** True when the request advertised at least one of the profile's tools. */
    main: boolean;
    model?: string;
    stream?: boolean;
    toolNames: string[];
    /** system + every message, stringified: what a leak check greps. */
    text: string;
    assistantTurnsSoFar: number;
}

export interface FauxScript {
    /**
     * turns[k] = the tool names the assistant calls in turn k (0-based). A name
     * is prefixed with `toolPrefix`, unless it starts with `=`, which sends the
     * rest verbatim (`=Skill`, or a tool outside the resolved set).
     */
    turns: string[][];
    /** The prefix the CLI puts on an SDK MCP server's tools, e.g. `mcp__inflect__`. */
    toolPrefix: string;
    finalText: string;
    /** Optional: input for a named tool (default `{}`). */
    inputFor?: (tool: string, turn: number) => Record<string, unknown>;
    /** Optional: the input_tokens to report for a main request (default 100), to drive compaction. */
    inputTokens?: (assistantTurnsSoFar: number) => number;
}

export interface FauxServer {
    url: string;
    requests: FauxRequest[];
    close(): Promise<void>;
}

const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });

type Block =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

let seq = 0;
const nextId = (p: string) => `${p}_faux${String(++seq).padStart(6, '0')}`;

function sse(res: ServerResponse, model: string, blocks: Block[], stopReason: string, inputTokens: number) {
    res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'request-id': nextId('req'),
    });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('message_start', {
        type: 'message_start',
        message: {
            id: nextId('msg'),
            type: 'message',
            role: 'assistant',
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: inputTokens, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
    });
    blocks.forEach((b, index) => {
        if (b.type === 'text') {
            send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
            send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } });
        } else {
            send('content_block_start', {
                type: 'content_block_start',
                index,
                content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} },
            });
            send('content_block_delta', {
                type: 'content_block_delta',
                index,
                delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) },
            });
        }
        send('content_block_stop', { type: 'content_block_stop', index });
    });
    send('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 20 } });
    send('message_stop', { type: 'message_stop' });
    res.end();
}

function json(res: ServerResponse, model: string, blocks: Block[], stopReason: string, inputTokens: number) {
    res.writeHead(200, { 'content-type': 'application/json', 'request-id': nextId('req') });
    res.end(
        JSON.stringify({
            id: nextId('msg'),
            type: 'message',
            role: 'assistant',
            model,
            content: blocks,
            stop_reason: stopReason,
            stop_sequence: null,
            usage: { input_tokens: inputTokens, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        }),
    );
}

export async function startFauxServer(script: FauxScript): Promise<FauxServer> {
    const requests: FauxRequest[] = [];
    const server = createServer(async (req, res) => {
        const at = Date.now();
        const raw = await readBody(req);
        const path = (req.url ?? '').split('?')[0];
        let body: Record<string, unknown> = {};
        try {
            body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        } catch {
            /* recorded as-is below */
        }
        const tools = Array.isArray(body.tools) ? (body.tools as Array<{ name?: string }>) : [];
        const toolNames = tools.map((t) => String(t.name ?? ''));
        const messages = Array.isArray(body.messages) ? (body.messages as Array<{ role: string }>) : [];
        const assistantTurnsSoFar = messages.filter((m) => m.role === 'assistant').length;
        const main = toolNames.some((n) => n.startsWith(script.toolPrefix));
        const record: FauxRequest = {
            at,
            method: req.method ?? '',
            path,
            main,
            model: typeof body.model === 'string' ? body.model : undefined,
            stream: body.stream === true,
            toolNames,
            text: JSON.stringify({ system: body.system ?? null, messages }),
            assistantTurnsSoFar,
        };
        requests.push(record);

        if (req.method !== 'POST' || !path.endsWith('/v1/messages')) {
            if (path.endsWith('/count_tokens')) {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ input_tokens: 100 }));
                return;
            }
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `faux: ${path}` } }));
            return;
        }
        const model = record.model ?? 'faux-model';
        let blocks: Block[];
        let stop: string;
        if (!main) {
            blocks = [{ type: 'text', text: 'faux side answer' }];
            stop = 'end_turn';
        } else if (assistantTurnsSoFar < script.turns.length) {
            const k = assistantTurnsSoFar;
            blocks = [
                { type: 'text', text: `Turn ${k + 1}: calling ${script.turns[k].length} tool(s).` },
                ...script.turns[k].map((t) => ({
                    type: 'tool_use' as const,
                    id: nextId('toolu'),
                    name: t.startsWith('=') ? t.slice(1) : `${script.toolPrefix}${t}`,
                    input: script.inputFor?.(t.replace(/^=/, ''), k) ?? {},
                })),
            ];
            stop = 'tool_use';
        } else {
            blocks = [{ type: 'text', text: script.finalText }];
            stop = 'end_turn';
        }
        const inputTokens = main ? (script.inputTokens?.(assistantTurnsSoFar) ?? 100) : 100;
        if (record.stream) sse(res, model, blocks, stop, inputTokens);
        else json(res, model, blocks, stop, inputTokens);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}
