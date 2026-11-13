/**
 * Step 4a's measurements (docs/claude-agent-sdk-design.md, "Operational cost"):
 * one fixed profile, twenty tools, run through `lockedOptions` and measured.
 *
 *   npm run faux -- [--reps 5]                 a local faux Messages API; runs here
 *   npm run real -- [--reps 2] [--model id]    the real API; the OWNER runs this
 *
 * For each repetition it runs the profile twice: COLD (`query()` spawns the
 * subprocess) and WARM (`startup()` spawns it first, then `query()`), and
 * reports time to init, time to the first assistant message (TTFT), the
 * number of model turns and tool calls, and the peak RSS of the subprocess
 * tree and of this process. It also reports the installed size of the SDK and
 * its native binary, and whether `system/init` named exactly the resolved set.
 *
 * In `--faux` mode TTFT is PROCESS OVERHEAD, not model latency: the faux API
 * answers in under a millisecond. Only `--real` measures what a user waits for.
 *
 * `--real` reads the Anthropic API key from a hidden prompt. It is never an
 * argument, never read from this shell's environment, never printed and never
 * written to disk; it reaches the subprocess only through lockedOptions' env.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query, startup, type Query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { startEgressLogger, egressHosts, type EgressLogger } from './egress-logger.ts';
import { FAUX_KEY, startFauxServer, type FauxServer } from './faux-server.ts';
import { lockedOptions, expectedInitTools, toolPrefix, type SpikeRun } from './locked-options.ts';
import { installedSizes, startRssSampler, type RssReport } from './measure.ts';
import { fauxTools, tenTurnScript, PROFILE_INSTRUCTIONS, PROMPT, TOOL_COUNT } from './profile.ts';
import { readHidden } from './read-hidden.ts';

const argv = process.argv.slice(2);
const mode = argv.includes('--faux') ? 'faux' : argv.includes('--real') ? 'real' : null;
if (!mode) {
    process.stderr.write('usage: tsx run-spike.ts --faux|--real [--reps N] [--model id]\n');
    process.exit(2);
}
const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
};
const reps = Number(flag('--reps') ?? (mode === 'faux' ? 5 : 2));
// Faux only: a longer script (N model turns, two tools a turn, cycling) to see how RSS grows with length.
const turnsFlag = flag('--turns');
const longTurns = mode === 'faux' && turnsFlag ? Number(turnsFlag) : null;
// The Tool Runner's "balanced" tier (src/lib/agentic/tool-runner/client.ts). In faux mode the id is only echoed.
const model = flag('--model') ?? 'claude-sonnet-5-5';

const REAL_PROMPT =
    `Call every one of your ${TOOL_COUNT} tools exactly once, two or three per turn, in the order they are listed. ` +
    'Then summarise, in one short paragraph, what needs attention.';

// The spike reads loosely shaped messages and records; one alias, scoped to this file.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = Record<string, any>;

interface RunMetrics {
    kind: 'cold' | 'warm';
    startupMs: number | null;
    initMs: number | null;
    ttftMs: number | null;
    firstApiRequestMs: number | null;
    totalMs: number;
    modelTurns: number;
    toolCalls: number;
    result: { subtype?: string; terminal_reason?: string; num_turns?: number; total_cost_usd?: number };
    initMatchesResolvedSet: boolean;
    initTools: string[];
    rss: RssReport;
    egressHosts: string[];
    sideRequests: number;
}

async function oneRun(kind: 'cold' | 'warm', apiKey: string): Promise<RunMetrics> {
    const base = mkdtempSync(join(tmpdir(), 'agent-sdk-spike-'));
    const cwd = join(base, 'cwd');
    const home = join(base, 'home');
    mkdirSync(cwd);
    mkdirSync(home);
    const tools = fauxTools();
    let faux: FauxServer | undefined;
    let egress: EgressLogger | undefined;
    const spikeEnv: Record<string, string> = {};
    if (mode === 'faux') {
        const turns = longTurns
            ? Array.from({ length: longTurns - 1 }, (_, k) => [tools[(2 * k) % tools.length].name, tools[(2 * k + 1) % tools.length].name])
            : tenTurnScript(tools);
        faux = await startFauxServer({ turns, toolPrefix, finalText: 'Faux summary: nothing needs attention.' });
        egress = await startEgressLogger();
        Object.assign(spikeEnv, { HTTPS_PROXY: egress.url, HTTP_PROXY: egress.url, NO_PROXY: '127.0.0.1,localhost' });
    } else {
        // The owner's own network settings, passed through if their shell has them.
        for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS']) if (process.env[k]) spikeEnv[k] = process.env[k]!;
    }
    const run: SpikeRun = {
        tools,
        systemPrompt: PROFILE_INSTRUCTIONS,
        model,
        maxTurns: (longTurns ?? 10) + 5,
        maxBudgetUsd: mode === 'real' ? 1 : 5,
        apiKey,
        baseUrl: faux?.url,
        configDir: join(base, 'config'),
        cwd,
        home,
        abortController: new AbortController(),
        spikeEnv,
    };
    const options = lockedOptions(run);
    const prompt = mode === 'faux' ? PROMPT : REAL_PROMPT;
    const sampler = startRssSampler();
    let startupMs: number | null = null;
    let q: Query;
    let t0: number;
    try {
        if (kind === 'warm') {
            const s0 = performance.now();
            const warm = await startup({ options });
            startupMs = performance.now() - s0;
            t0 = performance.now();
            q = warm.query(prompt);
        } else {
            t0 = performance.now();
            q = query({ prompt, options });
        }
        const wall0 = Date.now();
        let initMs: number | null = null;
        let ttftMs: number | null = null;
        let init: Any | undefined;
        let result: Any = {};
        const ids = new Set<string>();
        let toolCalls = 0;
        try {
            for await (const m of q as AsyncIterable<SDKMessage>) {
                const a = m as Any;
                const t = performance.now() - t0;
                if (a.type === 'system' && a.subtype === 'init' && !init) {
                    init = a;
                    initMs = t;
                }
                if (a.type === 'assistant') {
                    ttftMs ??= t;
                    ids.add(a.message.id);
                    toolCalls += (a.message.content ?? []).filter((c: Any) => c.type === 'tool_use').length;
                }
                if (a.type === 'result') result = a;
            }
        } catch (e) {
            // The iterator throws after an error result; the result message itself was already seen.
            result.thrown = String(e).slice(0, 200);
        }
        const totalMs = performance.now() - t0;
        const rss = sampler.stop();
        const expected = expectedInitTools(run);
        const initTools = [...(init?.tools ?? [])].sort();
        const firstMain = faux?.requests.find((r) => r.main);
        return {
            kind,
            startupMs: startupMs === null ? null : Math.round(startupMs),
            initMs: initMs === null ? null : Math.round(initMs),
            ttftMs: ttftMs === null ? null : Math.round(ttftMs),
            firstApiRequestMs: firstMain ? firstMain.at - wall0 : null,
            totalMs: Math.round(totalMs),
            modelTurns: ids.size,
            toolCalls,
            result: { subtype: result.subtype, terminal_reason: result.terminal_reason, num_turns: result.num_turns, total_cost_usd: result.total_cost_usd },
            initMatchesResolvedSet: JSON.stringify(initTools) === JSON.stringify(expected),
            initTools,
            rss,
            egressHosts: egress ? egressHosts(egress.attempts) : [],
            sideRequests: faux ? faux.requests.filter((r) => !r.main).length : 0,
        };
    } finally {
        sampler.stop();
        await faux?.close();
        await egress?.close();
        rmSync(base, { recursive: true, force: true });
    }
}

const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};
const max = (xs: number[]) => (xs.length ? Math.max(...xs) : null);
const nums = (xs: Array<number | null>) => xs.filter((x): x is number => typeof x === 'number');

async function main() {
    const apiKey = mode === 'real' ? await readHidden('Anthropic API key (hidden): ') : FAUX_KEY;
    if (!apiKey) throw new Error('No key entered.');
    const runs: RunMetrics[] = [];
    for (let i = 0; i < reps; i++) {
        runs.push(await oneRun('cold', apiKey));
        runs.push(await oneRun('warm', apiKey));
        process.stderr.write(`rep ${i + 1}/${reps} done\n`);
    }
    const cold = runs.filter((r) => r.kind === 'cold');
    const warm = runs.filter((r) => r.kind === 'warm');
    const summary = {
        date: new Date().toISOString(),
        mode,
        model,
        scriptTurns: longTurns ?? 10,
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        reps,
        sizes: installedSizes(),
        ttftMs: { coldMedian: median(nums(cold.map((r) => r.ttftMs))), coldMax: max(nums(cold.map((r) => r.ttftMs))), warmMedian: median(nums(warm.map((r) => r.ttftMs))), warmMax: max(nums(warm.map((r) => r.ttftMs))) },
        startupMs: { median: median(nums(warm.map((r) => r.startupMs))), max: max(nums(warm.map((r) => r.startupMs))) },
        firstApiRequestMs: { coldMedian: median(nums(cold.map((r) => r.firstApiRequestMs))), warmMedian: median(nums(warm.map((r) => r.firstApiRequestMs))) },
        totalMs: { coldMedian: median(cold.map((r) => r.totalMs)), warmMedian: median(warm.map((r) => r.totalMs)) },
        peakRssMiB: {
            childTree: max(runs.map((r) => r.rss.childTreePeakMiB)),
            childMaxHwm: max(runs.map((r) => r.rss.childMaxHwmMiB)),
            host: max(runs.map((r) => r.rss.hostPeakMiB)),
            hostMaxRss: max(runs.map((r) => r.rss.hostMaxRssMiB)),
            combined: max(runs.map((r) => r.rss.combinedPeakMiB)),
        },
        modelTurns: [...new Set(runs.map((r) => r.modelTurns))],
        toolCalls: [...new Set(runs.map((r) => r.toolCalls))],
        results: [...new Set(runs.map((r) => `${r.result.subtype}/${r.result.terminal_reason}`))],
        initMatchesResolvedSetEveryRun: runs.every((r) => r.initMatchesResolvedSet),
        egressHosts: [...new Set(runs.flatMap((r) => r.egressHosts))],
        sideRequests: runs.reduce((s, r) => s + r.sideRequests, 0),
        costUsd: mode === 'real' ? runs.reduce((s, r) => s + (r.result.total_cost_usd ?? 0), 0) : null,
        runs,
    };
    const dir = new URL('./results/', import.meta.url);
    mkdirSync(dir, { recursive: true });
    const file = new URL(`${mode}-${summary.date.slice(0, 10)}${longTurns ? `-${longTurns}turns` : ''}.json`, dir);
    writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
    const { runs: _runs, ...brief } = summary;
    process.stdout.write(`${JSON.stringify(brief, null, 2)}\nwritten: ${file.pathname}\n`);
}

await main();
