/**
 * Faux mode only: N ten-turn runs at once in one host process, as a worker
 * with engine concurrency N would hold them. Reports the combined peak RSS of
 * every subprocess plus the host, and whether every run completed. Run it in
 * a container shaped like the worker (see the implementation note) to see
 * where the memory limit bites.
 *
 *   npx tsx concurrency-probe.ts 1 3 5
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

import { FAUX_KEY, startFauxServer } from './faux-server.ts';
import { lockedOptions, toolPrefix } from './locked-options.ts';
import { startRssSampler } from './measure.ts';
import { fauxTools, tenTurnScript, PROFILE_INSTRUCTIONS, PROMPT } from './profile.ts';

async function oneRun(): Promise<string> {
    const base = mkdtempSync(join(tmpdir(), 'agent-sdk-conc-'));
    const tools = fauxTools();
    const faux = await startFauxServer({ turns: tenTurnScript(tools), toolPrefix, finalText: 'done' });
    try {
        mkdirSync(join(base, 'cwd'));
        const options = lockedOptions({
            tools,
            systemPrompt: PROFILE_INSTRUCTIONS,
            model: 'claude-sonnet-5-5',
            maxTurns: 15,
            maxBudgetUsd: 5,
            apiKey: FAUX_KEY,
            baseUrl: faux.url,
            configDir: join(base, 'config'),
            cwd: join(base, 'cwd'),
            home: base,
            abortController: new AbortController(),
        });
        let outcome = 'no result';
        try {
            for await (const m of query({ prompt: PROMPT, options })) {
                if (m.type === 'result') outcome = `${m.subtype}/${m.terminal_reason}`;
            }
        } catch (e) {
            outcome = `threw: ${String(e).slice(0, 120)}`;
        }
        return outcome;
    } finally {
        await faux.close();
        rmSync(base, { recursive: true, force: true });
    }
}

const levels = process.argv.slice(2).map(Number).filter((n) => n > 0);
for (const n of levels.length ? levels : [1, 3, 5]) {
    const sampler = startRssSampler();
    const t0 = performance.now();
    const outcomes = await Promise.all(Array.from({ length: n }, () => oneRun()));
    const rss = sampler.stop();
    process.stdout.write(
        `${JSON.stringify({ concurrent: n, wallMs: Math.round(performance.now() - t0), childTreePeakMiB: rss.childTreePeakMiB, hostPeakMiB: rss.hostPeakMiB, combinedPeakMiB: rss.combinedPeakMiB, outcomes })}\n`,
    );
}
