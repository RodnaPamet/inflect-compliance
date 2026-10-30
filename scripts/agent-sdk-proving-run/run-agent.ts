/**
 * Run the connect wizard's TypeScript snippet, unchanged, as the proving agent.
 *
 * `agent.ts` is the snippet pasted from the agent's page (Connect an agent you
 * run → Agent SDK → TypeScript). It reads `INFLECT_API_KEY` from the
 * environment and the SDK reads `ANTHROPIC_API_KEY`; both are set here from
 * hidden prompts, for this process only, and printed nowhere.
 */
import { existsSync } from 'node:fs';
import { env } from 'node:process';

import { readHidden } from './read-hidden.ts';

if (!existsSync(new URL('./agent.ts', import.meta.url))) {
    throw new Error('Paste the wizard\'s TypeScript snippet into agent.ts in this folder first.');
}

env.INFLECT_API_KEY = await readHidden('Inflect API key, from the connect wizard: ');
env.ANTHROPIC_API_KEY = await readHidden('Anthropic API key: ');

// The snippet prints the SDK's result message: its turns, cost and answer.
await import('./agent.ts');
