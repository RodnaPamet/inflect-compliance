/**
 * Call one tool the agent is NOT granted, with the wizard's key, the way a
 * misbehaving agent would: straight at `/api/mcp`, outside the SDK's
 * `allowedTools`. Inflect must refuse it and write an `AUTHZ_DENIED` row.
 *
 *   npm run ungranted -- https://<your Inflect origin> list_controls
 *
 * Prints the HTTP status and the JSON-RPC error, never the key and never a
 * tool result.
 */
import { argv } from 'node:process';

import { readHidden } from './read-hidden.ts';

const [origin, tool] = argv.slice(2);
if (!origin || !tool) throw new Error('Usage: npm run ungranted -- https://<your Inflect origin> <ungranted tool name>');
const endpoint = new URL('/api/mcp', origin);
if (endpoint.protocol !== 'https:') throw new Error('The origin must be https.');

const key = await readHidden('Inflect API key, from the connect wizard: ');
const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: {} } }),
});
const json = (await res.json().catch(() => null)) as { error?: { code?: number; message?: string }; result?: unknown } | null;
console.log(JSON.stringify({ status: res.status, error: json?.error ?? null, answered: json?.result !== undefined }, null, 2));
