/**
 * THE LOAD-TIME SCAN OF SKILL TEXT (#3667, rule 9 of docs/agent-skill-standard.md).
 *
 * A skill's description sits in every system prompt of every run that mounts
 * it, and its instructions reach the model the moment it activates the skill.
 * Both are text the model TRUSTS, so they are scanned before they are trusted:
 * when the corpus loads, before any prompt is assembled, and a skill that fails
 * is refused rather than mounted.
 *
 * ── TWO SOURCES OF RULES ────────────────────────────────────────────────────
 *
 *   • The AI Guard's own scanners, unchanged. The injection scanner reads both
 *     fields as untrusted input would be read, and ANY flag refuses — a skill is
 *     reviewed text, so even the `suspicious` verdict that a run's input could
 *     survive is a reason to stop here. The egress scanner finds secret-shaped
 *     strings.
 *   • Four rules of its own, for the ways a skill can be dangerous while reading
 *     as ordinary prose to the injection scanner: a fetchable URL, an instruction
 *     about revealing the prompt, a tool the skill did not declare, a secret.
 *
 * ── WHAT IS REPORTED ────────────────────────────────────────────────────────
 *
 * Stable ids only — the skill rule ids below, plus the guard rule ids that made
 * `skill.injection` or `skill.secret_shape` fire. Never the matched text: a
 * refused skill's text is the thing under suspicion, and the surfaces that
 * report a refusal (the Skills tab, the run's error) must not become a way to
 * deliver it.
 *
 * ── WHY "ANY FETCHABLE URL" RATHER THAN "A URL THE MODEL IS TOLD TO FETCH" ──
 *
 * The standard's words are the second. The rule enforces the first, because
 * telling a link that is cited from a link that is followed is the model's call
 * at run time, and that call is what the rule exists to take away. A skill
 * cites standards by identifier; it has no need for an address. Reference
 * schemes that cannot be fetched — the `kv://` and `entra-sp:` credential
 * references the harness contract uses — are not URLs here.
 *
 * ── TOOL NAMES ──────────────────────────────────────────────────────────────
 *
 * A skill teaches; it never grants (rule 1). Naming a tool confers nothing,
 * but an instruction to call a tool the run was not built around is how a skill
 * steers a model toward reach it should not be using. So a skill names the
 * tools it expects in `metadata.tools`, and any OTHER tool this build knows by
 * name — the MCP catalogue and the runtime's own tools — is a refusal. A name
 * the build does not know (a tenant's external tool) cannot be recognised in
 * prose and is not claimed to be.
 *
 * PURE: no I/O. Imports only leaf modules.
 */
import { scanInjection } from '@/app-layer/ai/guard/injection-scanner';
import { scanEgress } from '@/app-layer/ai/guard/egress-scanner';
import { normalizeForScan } from '@/app-layer/ai/guard/normalize';
import { MCP_TOOL_NAMES } from '@/lib/mcp/tool-catalogue';

import { FLUE_RUNTIME_TOOLS } from '../runtime-tools';

/** The rules, by stable id. Ids are reported and must never be renamed. */
export const SKILL_TEXT_RULES = {
    'skill.injection': 'The AI Guard injection scanner flagged the description or the instructions.',
    'skill.fetchable_url': 'The text contains a fetchable URL or a host the model is directed to.',
    'skill.reveal_context': 'The text tells the model to reveal its prompt, instructions or context.',
    'skill.undeclared_tool': 'The text names a tool the skill does not declare in metadata.tools.',
    'skill.secret_shape': 'The text contains a secret-shaped string.',
} as const;

export type SkillTextRuleId = keyof typeof SKILL_TEXT_RULES;

export interface SkillTextScan {
    /** The skill rules that fired, in the order `SKILL_TEXT_RULES` lists them. */
    readonly rules: readonly SkillTextRuleId[];
    /** The AI Guard rule ids behind `skill.injection` and `skill.secret_shape`, sorted. */
    readonly guardRules: readonly string[];
}

const FETCHABLE_SCHEME = /\b(?:https?|ftps?|sftp|wss?|file|gopher|smb|ldaps?):\/\//;
const WWW_HOST = /(?:^|[^a-z0-9.-])www\.[a-z0-9-]+(?:\.[a-z0-9-]+)+/;
/** A bare host on a common public suffix, within a sentence of a verb that goes and gets it. */
const DIRECTED_HOST = new RegExp(
    '\\b(?:fetch|download|retrieve|visit|browse|curl|wget|navigate to|go to|open|load|request|post to|send to|upload to)\\b'
        + '[^.\\n]{0,40}\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.'
        + '(?:com|net|org|io|dev|app|ai|co|cloud|info|biz|xyz|me|sh|site|online|link|ly|gg)\\b',
);

const REVEAL_CONTEXT = new RegExp(
    '\\b(?:reveal|repeat|print|output|disclose|leak|show|share|dump|echo|recite|quote|copy|send|tell|summari[sz]e)\\b'
        + '[^.\\n]{0,40}\\b(?:'
        + 'system (?:prompt|message|instructions?)'
        + '|developer (?:message|prompt|instructions?)'
        + '|hidden (?:prompt|instructions?)'
        + '|(?:your|these|the above|the previous|prior|initial|original) (?:instructions|prompt|system prompt|context|rules)'
        + '|context window|conversation history|chain of thought|scratchpad'
        + ')\\b',
);

/** Every tool this build knows by name. */
const KNOWN_TOOL_NAMES: readonly string[] = [...MCP_TOOL_NAMES, ...FLUE_RUNTIME_TOOLS.map((t) => t.name)];

function escape(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * How a tool name is recognised in prose. A snake_case name is a word nobody
 * writes by accident. A plain word — the runtime's `task` — is recognised only
 * where it is plainly a tool: in backticks or quotes, as a call, or as "the task
 * tool", so "the task at hand" is not a refusal.
 */
function toolMention(name: string): RegExp {
    const n = escape(name);
    return name.includes('_')
        ? new RegExp(`(?<![a-z0-9_])${n}(?![a-z0-9_])`)
        : new RegExp(`[\`'"]${n}[\`'"]|\\b${n}\\s*\\(|\\b${n} tool\\b`);
}

function anyMatch(re: RegExp, texts: readonly string[]): boolean {
    return texts.some((t) => re.test(t));
}

/**
 * Scan one skill's text. `declaredTools` is the skill's `metadata.tools`, as a
 * list. Returns no rules for a skill that may be mounted.
 */
export function scanSkillText(input: {
    readonly description: string;
    readonly instructions: string;
    readonly declaredTools: readonly string[];
}): SkillTextScan {
    const fields = [input.description, input.instructions];
    // The raw text, lower-cased, and the guard's folded form: base64 and hex
    // blobs decoded, homoglyphs folded, invisible characters stripped. A rule
    // fires on either, so the evasions the guard already defeats defeat these
    // rules too.
    const views = fields.flatMap((f) => [f.toLowerCase(), normalizeForScan(f)]);

    const rules = new Set<SkillTextRuleId>();
    const guardRules = new Set<string>();

    for (const f of fields) {
        const inj = scanInjection(f);
        if (inj.verdict !== 'clean') {
            rules.add('skill.injection');
            inj.ruleIds.forEach((id) => guardRules.add(id));
        }
        const egress = scanEgress(f);
        if (egress.verdict !== 'clean') {
            rules.add('skill.secret_shape');
            egress.ruleIds.forEach((id) => guardRules.add(id));
        }
    }
    if (anyMatch(FETCHABLE_SCHEME, views) || anyMatch(WWW_HOST, views) || anyMatch(DIRECTED_HOST, views)) {
        rules.add('skill.fetchable_url');
    }
    if (anyMatch(REVEAL_CONTEXT, views)) rules.add('skill.reveal_context');

    const declared = new Set(input.declaredTools);
    const lowered = fields.map((f) => f.toLowerCase());
    if (KNOWN_TOOL_NAMES.some((name) => !declared.has(name) && anyMatch(toolMention(name), lowered))) {
        rules.add('skill.undeclared_tool');
    }

    return {
        rules: (Object.keys(SKILL_TEXT_RULES) as SkillTextRuleId[]).filter((id) => rules.has(id)),
        guardRules: [...guardRules].sort(),
    };
}
