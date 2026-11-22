/**
 * The one fixed profile the spike runs: twenty faux read tools, a fixed
 * instruction block, and (in `--faux` mode) a ten-turn script that calls every
 * tool once: nine tool-calling turns, then a text answer.
 */
import { z } from 'zod';
import type { SpikeTool } from './locked-options.ts';

export const TOOL_COUNT = 20;

const DOMAINS = ['risks', 'controls', 'policies', 'evidence', 'vendors', 'assets', 'findings', 'incidents', 'tasks', 'audits'];

/** Each result is ~4 KB, so the conversation grows the way a real read-heavy run does. */
function fauxRows(tool: string): string {
    const rows = Array.from({ length: 24 }, (_, i) => ({
        id: `${tool}-${String(i).padStart(3, '0')}`,
        title: `Faux ${tool} row ${i}`,
        status: i % 3 === 0 ? 'OPEN' : 'CLOSED',
        owner: `owner-${i % 7}`,
        note: 'x'.repeat(80),
    }));
    return JSON.stringify({ tool, rows });
}

export function fauxTools(): SpikeTool[] {
    return Array.from({ length: TOOL_COUNT }, (_, i) => {
        const domain = DOMAINS[i % DOMAINS.length];
        const name = `${i < 10 ? 'list' : 'get'}_${domain}`;
        return {
            name,
            description: `Faux read tool ${i + 1}: ${name.replace('_', ' ')} for the spike. Returns rows as JSON.`,
            shape: { limit: z.number().int().min(1).max(100).optional(), status: z.enum(['OPEN', 'CLOSED']).optional() },
            handler: async () => fauxRows(name),
        };
    });
}

/** Nine tool turns (2,2,2,2,2,2,2,3,3 = 20 calls) and a final text turn: ten model turns. */
export function tenTurnScript(tools: SpikeTool[]): string[][] {
    const sizes = [2, 2, 2, 2, 2, 2, 2, 3, 3];
    const turns: string[][] = [];
    let at = 0;
    for (const n of sizes) {
        turns.push(tools.slice(at, at + n).map((t) => t.name));
        at += n;
    }
    if (at !== tools.length) throw new Error(`script covers ${at} of ${tools.length} tools`);
    return turns;
}

export const PROFILE_INSTRUCTIONS = [
    'You are an Inflect agent. Inflect is a compliance platform.',
    '<profile-instructions label="agent.profile">',
    'Review the tenant\'s open items across every domain you can read, one tool at a time, and summarise what needs attention.',
    '</profile-instructions>',
].join('\n');

export const PROMPT = 'Summarise what needs attention this week.';
