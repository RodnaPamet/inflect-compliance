/**
 * The lockdown check: run a profile through `lockedOptions` against the faux
 * API and list every way the run differs from "exactly the resolved set, and
 * nothing from the host". An empty list is a pass.
 *
 * It reads three witnesses, because `system/init` alone is the CLI describing
 * itself: the init message, every request the faux API received (what actually
 * reached the model), and every outbound connection the subprocess attempted.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { query, type SDKResultMessage, type SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk';

import { startEgressLogger, egressHosts } from './egress-logger.ts';
import { FAUX_KEY, startFauxServer, type FauxRequest } from './faux-server.ts';
import { MARK } from './hostile-host.ts';
import { expectedInitTools, lockedOptions, SERVER, toolPrefix, type SpikeRun } from './locked-options.ts';

/**
 * What the pinned CLI (Claude Code 2.1.323, SDK 0.3.323) carries in its own
 * binary and reports under lockedOptions on an EMPTY host. Not from the host:
 * these are compiled in. A version bump that changes them fails the check, so
 * the bump is read rather than inherited.
 */
export const BUILTIN_PLUGINS = ['cc-plugin-agents-md', 'cc-plugin-plugin-authoring', 'cc-plugin-privacy'];
export const BUNDLED_SKILLS_LEFT = ['doctor', 'plugin-authoring'];

export interface Observed {
    /** `analytics_disabled` is reported by the CLI but not declared in the SDK's type. */
    init: (SDKSystemMessage & { analytics_disabled?: boolean }) | undefined;
    requests: FauxRequest[];
    egress: string[];
    results: SDKResultMessage[];
    thrown: string | null;
}

/** Materialise the run's skills as a local plugin: the one path that loads under settingSources: []. */
export function materialiseSkillPlugin(dir: string, skills: Record<string, string>) {
    mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
    writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'inflect-skills', version: '0.0.0' }));
    for (const [name, body] of Object.entries(skills)) {
        mkdirSync(join(dir, 'skills', name), { recursive: true });
        writeFileSync(join(dir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Inflect skill ${name}.\n---\n\n${body}\n`);
    }
    return { pluginDir: dir, names: Object.keys(skills).map((n) => `inflect-skills:${n}`) };
}

export async function observeLockedRun(
    run: Omit<SpikeRun, 'baseUrl' | 'apiKey' | 'abortController'>,
    script: string[][],
): Promise<Observed> {
    const faux = await startFauxServer({
        turns: script,
        toolPrefix,
        finalText: 'done',
        inputFor: (t) => (t === 'Skill' ? { skill: run.skills?.names[0] ?? 'none' } : {}),
    });
    const egress = await startEgressLogger();
    const options = lockedOptions({
        ...run,
        apiKey: FAUX_KEY,
        baseUrl: faux.url,
        abortController: new AbortController(),
        spikeEnv: { ...(run.spikeEnv ?? {}), HTTPS_PROXY: egress.url, HTTP_PROXY: egress.url, NO_PROXY: '127.0.0.1,localhost' },
    });
    const out: Observed = { init: undefined, requests: faux.requests, egress: [], results: [], thrown: null };
    try {
        for await (const m of query({ prompt: 'Summarise what needs attention.', options })) {
            if (m.type === 'system' && m.subtype === 'init' && !out.init) out.init = m;
            if (m.type === 'result') out.results.push(m);
        }
    } catch (e) {
        out.thrown = String(e).slice(0, 300);
    } finally {
        await faux.close();
        await egress.close();
        out.egress = egressHosts(egress.attempts);
    }
    return out;
}

function transcriptFiles(configDir: string): string[] {
    try {
        return readdirSync(join(configDir, 'projects'), { recursive: true })
            .map(String)
            .filter((f) => f.endsWith('.jsonl'));
    } catch {
        return [];
    }
}

const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

const SKILL_LISTING = 'The following skills are available for use with the Skill tool:';

function allStrings(v: unknown, out: string[] = []): string[] {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) for (const x of v) allStrings(x, out);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) allStrings(x, out);
    return out;
}

/** The skill names the CLI listed to the model, read off a recorded request (`FauxRequest.text` is JSON). */
export function skillsListedToModel(text: string): string[] {
    const names: string[] = [];
    for (const s of allStrings(JSON.parse(text))) {
        const at = s.indexOf(SKILL_LISTING);
        if (at < 0) continue;
        for (const line of s.slice(at + SKILL_LISTING.length).split('\n')) {
            const m = line.match(/^- ([^\s:]+(?::[^\s:]+)?):/);
            if (m) names.push(m[1]);
            else if (names.length && line.trim() === '') break;
        }
    }
    return [...new Set(names)];
}

export function lockdownViolations(
    o: Observed,
    run: Pick<SpikeRun, 'tools' | 'skills' | 'model' | 'configDir'>,
    hookFlags: string[] = [],
    /** Resolved tools the run's own gate (kill switch, budget) refused: each must appear as a denial. */
    expectDenied: string[] = [],
): string[] {
    const v: string[] = [];
    const init = o.init;
    if (!init) return [`no system/init message (thrown: ${o.thrown ?? 'nothing'})`];
    const expectedTools = expectedInitTools(run);
    const ourSkills = run.skills?.names ?? [];

    if (!same(init.tools ?? [], expectedTools)) v.push(`init.tools ${JSON.stringify(init.tools)} != resolved ${JSON.stringify(expectedTools)}`);
    const servers = (init.mcp_servers ?? []).map((s) => `${s.name}/${s.status}/${s.source}`);
    if (!same(servers, [`${SERVER}/connected/sdk`])) v.push(`init.mcp_servers ${JSON.stringify(servers)}`);
    if ((init.agents ?? []).length) v.push(`init.agents ${JSON.stringify(init.agents)}`);
    if (init.model !== run.model) v.push(`init.model ${init.model} != ${run.model}`);
    if (init.permissionMode !== 'dontAsk') v.push(`init.permissionMode ${init.permissionMode}`);
    if (init.output_style !== 'default') v.push(`init.output_style ${init.output_style}`);
    if (init.analytics_disabled !== true) v.push(`init.analytics_disabled ${init.analytics_disabled}`);
    const plugins = (init.plugins ?? []).map((p) => p.name);
    const expectedPlugins = [...BUILTIN_PLUGINS, ...(run.skills?.pluginDir ? ['inflect-skills'] : [])];
    if (!same(plugins, expectedPlugins)) v.push(`init.plugins ${JSON.stringify(plugins)} != ${JSON.stringify(expectedPlugins)}`);
    if (!same(init.skills ?? [], [...BUNDLED_SKILLS_LEFT, ...ourSkills])) v.push(`init.skills ${JSON.stringify(init.skills)}`);
    const named = [...(init.slash_commands ?? []), ...(init.skills ?? []), ...(init.agents ?? []), ...plugins, ...servers];
    const hostileNames = named.filter((n: string) => /hostile/i.test(n));
    if (hostileNames.length) v.push(`host names in init: ${JSON.stringify(hostileNames)}`);

    // What reached the model.
    const apiTools = [...expectedTools];
    for (const r of o.requests) {
        if (!r.main) v.push(`a request without the profile's tools reached the API (${r.path}): a side call`);
        else if (!same(r.toolNames, apiTools)) v.push(`request tools ${JSON.stringify(r.toolNames)} != ${JSON.stringify(apiTools)}`);
        const leaks = [...new Set(r.text.match(new RegExp(`${MARK}_[A-Z_]+`, 'g')) ?? [])];
        if (leaks.length) v.push(`host content reached the model: ${leaks.join(', ')}`);
        const listed = skillsListedToModel(r.text);
        if (!same(listed, ourSkills)) v.push(`skills listed to the model ${JSON.stringify(listed)} != ${JSON.stringify(ourSkills)}`);
    }
    const denied = (o.results[o.results.length - 1]?.permission_denials ?? []).map((d) => d.tool_name);
    for (const t of expectDenied) if (!denied.includes(t)) v.push(`the run's gate refused ${t}, but it was not denied (the catch-all hook did not run)`);
    const extraDenials = denied.filter((t: string) => !expectDenied.includes(t));
    if (extraDenials.length) v.push(`resolved tools were denied that the gate allowed: ${JSON.stringify(extraDenials)}`);
    if (o.egress.length) v.push(`outbound connections beyond the model endpoint: ${o.egress.join(', ')}`);
    for (const f of hookFlags) if (existsSync(f)) v.push(`a host hook ran (${f})`);
    const transcripts = transcriptFiles(run.configDir);
    if (transcripts.length) v.push(`a session transcript was written to disk: ${transcripts.join(', ')}`);
    if (o.thrown) v.push(`the run threw: ${o.thrown}`);
    const last = o.results[o.results.length - 1];
    if (last?.subtype !== 'success') v.push(`result ${last?.subtype}/${last?.terminal_reason}`);
    return v;
}

export const freshDir = (base: string, name: string) => mkdtempSync(join(base, `${name}-`));
