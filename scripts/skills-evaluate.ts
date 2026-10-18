/**
 * Run each skill's evaluation set through a model and write the evaluation
 * record the mount gate requires (#3666).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS SCRIPT IS FOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A skill is mounted only when a committed `evaluation-record.json` — its
 * evaluation set plus the answers a named model revision gave — passes the
 * set's thresholds, recomputed from the raw answers
 * (`src/lib/agentic/flue/skills/mount-gate.ts`). This is the only thing that
 * makes one. Like `scripts/eval-identity-match.ts`, it is deliberately dumb: it
 * asks, it records, and it refuses to write a record it knows will not pass. It
 * grades nothing itself — `checkEvaluationRecord` does, the same function the
 * gate calls.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * HOW A CASE IS ASKED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The system prompt is the skill's instructions, exactly as activation delivers
 * them to a run; the user message is the case's input. One request per case, no
 * conversation, no tools. No sampling parameters and no thinking configuration
 * are sent: current models reject non-default sampling, and the record should
 * show how the model behaves as the runtime calls it, not under settings the
 * runtime never uses.
 *
 * The model is the one the Flue runtime's external provider names —
 * `AGENT_FLUE_MODEL`, defaulting as `src/env.ts` does (`claude-sonnet-5-5`) —
 * unless `--model` says otherwise. Not `ANTHROPIC_MODEL`: that is the
 * compliance-posture summary's and the risk suggestions' model, and the agent
 * runtime has its own (owner decision, 2026-10-18). The record stores the revision the API REPORTED, not the one
 * asked for, and a run in which two answers report different revisions writes
 * nothing.
 *
 * The cases are synthetic and authored in this repository; no tenant data is
 * sent. The request goes to the same API, under the same credential, that the
 * runtime's external provider already uses.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *   ANTHROPIC_API_KEY=... npm run skills:evaluate                      # every skill with a set
 *   ANTHROPIC_API_KEY=... npm run skills:evaluate -- --skill soa-authoring
 *   ANTHROPIC_API_KEY=... npm run skills:evaluate -- --model claude-haiku-4-5
 *
 * An organisation-level key also needs `ANTHROPIC_WORKSPACE_ID=wrkspc_...`;
 * a key created inside a workspace does not.
 *
 * In CI it runs from the manual workflow `.github/workflows/skills-evaluate.yml`,
 * which holds the credential as a repository secret and uploads the records as
 * an artifact to be committed in a pull request.
 *
 * Exits non-zero if any skill's record would not pass; that skill's record is
 * not written, and its per-kind result is printed. Its answers go to
 * `skill-evaluation-failures/<skill>.json` instead, with each case marked
 * passed or not — gitignored, outside the skills tree, and never a record.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadSkillCorpus, skillDirectory, type LoadedSkill } from '../src/lib/agentic/flue/skills';
import {
    answerPasses,
    checkEvaluationRecord,
    checkEvaluationSet,
    readEvaluationSet,
} from '../src/lib/agentic/flue/skills/evaluation-record';
import { EVALUATION_RECORD_FILE } from '../src/lib/agentic/flue/skills/mount-gate';

/** Where a run that did not pass leaves its answers for diagnosis. Gitignored. */
const FAILURES_DIR = path.join(process.cwd(), 'skill-evaluation-failures');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
/** `src/env.ts`'s default for `AGENT_FLUE_MODEL`, the agent runtime's model. */
const DEFAULT_MODEL = 'claude-sonnet-5-5';
const MAX_TOKENS = 4_096;
const TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 4;

interface Args {
    skill: string | null;
    model: string;
}

function parseArgs(argv: readonly string[]): Args {
    let skill: string | null = null;
    let model = process.env.AGENT_FLUE_MODEL || DEFAULT_MODEL;
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--skill') skill = argv[++i] ?? null;
        else if (argv[i] === '--model') model = argv[++i] ?? model;
        else throw new Error(`unknown argument ${argv[i]}`);
    }
    return { skill, model };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The credential, and the workspace an organisation-level key must name.
 *
 * A key created inside a workspace carries its workspace; an organisation key
 * does not, and the API refuses its requests unless `anthropic-workspace-id`
 * says which workspace they belong to. The header is sent only when
 * `ANTHROPIC_WORKSPACE_ID` is set, so a workspace key works unchanged.
 */
interface ApiAuth {
    apiKey: string;
    workspaceId: string | null;
}

/** One case, one request. Returns the text the model gave and the revision the API reported. */
async function ask(auth: ApiAuth, model: string, system: string, input: string): Promise<{ answer: string; revision: string }> {
    for (let attempt = 1; ; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        let res: Response;
        try {
            res = await fetch(ANTHROPIC_API_URL, {
                method: 'POST',
                headers: {
                    'x-api-key': auth.apiKey,
                    ...(auth.workspaceId ? { 'anthropic-workspace-id': auth.workspaceId } : {}),
                    'anthropic-version': ANTHROPIC_VERSION,
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    model,
                    max_tokens: MAX_TOKENS,
                    system,
                    messages: [{ role: 'user', content: input }],
                }),
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timer);
        }
        if (res.ok) {
            const data = (await res.json()) as {
                model?: string;
                stop_reason?: string;
                content?: Array<{ type?: string; text?: string }>;
            };
            if (typeof data.model !== 'string' || !data.model) throw new Error('the API reported no model revision');
            // A refusal is an answer, and an empty one: it fails every case
            // that requires content, which is the honest grade for it.
            const answer = data.stop_reason === 'refusal'
                ? ''
                : (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
            return { answer, revision: data.model };
        }
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt >= MAX_ATTEMPTS) {
            const body = await res.text().catch(() => '');
            throw new Error(`Anthropic API error ${res.status}: ${body.slice(0, 200)}`);
        }
        const after = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : 2 ** attempt * 1000);
    }
}

async function evaluate(auth: ApiAuth, model: string, skill: LoadedSkill): Promise<boolean> {
    const rawSet = readEvaluationSet(skill);
    const setCheck = checkEvaluationSet(rawSet, skill);
    if (!setCheck.ok) {
        console.error(`✗ ${skill.name}: the set is not usable (${setCheck.reason}: ${setCheck.detail})`);
        return false;
    }

    const answers: Array<{ caseId: string; answer: string }> = [];
    const revisions = new Set<string>();
    for (const c of setCheck.set.cases) {
        const { answer, revision } = await ask(auth, model, skill.instructions, c.input);
        answers.push({ caseId: c.id, answer });
        revisions.add(revision);
    }
    if (revisions.size !== 1) {
        console.error(`✗ ${skill.name}: answers came from more than one revision (${[...revisions].join(', ')}); nothing written`);
        return false;
    }

    const record = {
        // The set exactly as committed, so the gate's SET_MISMATCH comparison
        // holds — never the parsed copy, which would carry Zod's defaults.
        set: rawSet,
        model: { provider: 'anthropic', revision: [...revisions][0] },
        ranAt: new Date().toISOString(),
        answers,
    };
    const verdict = checkEvaluationRecord(record, skill);
    if (!verdict.ok) {
        // Kept for DIAGNOSIS, never as a record: outside the skills tree, under a
        // gitignored directory, and named for the skill rather than
        // `evaluation-record.json`, so the mount gate cannot read it and nobody
        // can commit it by accident. It says which case failed and with what
        // answer, which a pass rate alone cannot — an expectation a correct
        // answer misses and an answer that is wrong look identical as a ratio.
        const failed = path.join(FAILURES_DIR, `${skill.name}.json`);
        fs.mkdirSync(FAILURES_DIR, { recursive: true });
        fs.writeFileSync(failed, `${JSON.stringify({
            ...record,
            verdict: { reason: verdict.reason, detail: verdict.detail },
            cases: setCheck.set.cases.map((c) => ({
                caseId: c.id,
                kind: c.kind,
                passed: answerPasses(c.expect, answers.find((a) => a.caseId === c.id)?.answer ?? ''),
            })),
        }, null, 4)}\n`);
        console.error(`✗ ${skill.name}: ${verdict.reason} — ${verdict.detail}; nothing written (diagnosis in ${path.relative(process.cwd(), failed)})`);
        return false;
    }
    const out = path.join(skillDirectory(skill.name), EVALUATION_RECORD_FILE);
    fs.writeFileSync(out, `${JSON.stringify(record, null, 4)}\n`);
    const rates = Object.entries(verdict.rates).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(', ');
    console.log(`✓ ${skill.name} on ${record.model.revision}: ${rates} → ${path.relative(process.cwd(), out)}`);
    return true;
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        console.error('ANTHROPIC_API_KEY is not set. A record can only be made by asking a real model.');
        process.exit(2);
    }
    const auth: ApiAuth = { apiKey, workspaceId: process.env.ANTHROPIC_WORKSPACE_ID?.trim() || null };
    const { skills, refused } = loadSkillCorpus();
    for (const r of refused) console.error(`- ${r.name}: refused by the text scan (${r.rules.join(', ')}); not evaluated`);
    const targets = skills.filter((s) => s.metadata.evaluation !== undefined && (args.skill === null || s.name === args.skill));
    if (targets.length === 0) {
        console.error(args.skill ? `No evaluable skill named ${args.skill}.` : 'No skill names an evaluation set.');
        process.exit(2);
    }
    let failed = 0;
    for (const skill of targets) {
        if (!(await evaluate(auth, args.model, skill))) failed += 1;
    }
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
