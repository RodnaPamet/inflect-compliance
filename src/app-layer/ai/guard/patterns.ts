/**
 * AI Guard — rule table (injection + egress/DLP).
 *
 * Two rule families, each entry a stable `id` + `severity` + a matcher that
 * runs against the NORMALIZED text (see `normalize.ts`). Matching against the
 * folded form is what makes base64 / homoglyph / zero-width evasion futile.
 *
 * ── Attribution ──────────────────────────────────────────────────────────
 * The injection taxonomy (ignore-previous / system-role-injection /
 * instruction-override / tool-poisoning / exfil-directive) and several of the
 * secret-shape regexes are ADAPTED from the pipelock project's rule blueprint,
 * used here under the Apache License 2.0. pipelock is a taxonomy REFERENCE
 * only — it is NOT a dependency of this codebase. See the repo-root `NOTICE`.
 *
 * Rules never capture or return the raw matched substring — only the rule id
 * flows outward (audit + telemetry), so no injected text or secret material
 * is ever logged.
 */

export type GuardSeverity = 'low' | 'medium' | 'high';

export type InjectionCategory =
    | 'ignore_previous'
    | 'system_role_injection'
    | 'instruction_override'
    | 'tool_poisoning'
    | 'exfil_directive';

export type EgressCategory =
    | 'api_key'
    | 'bearer_or_jwt'
    | 'private_key'
    | 'seed_phrase'
    | 'high_entropy_secret';

export interface GuardRule<Cat extends string> {
    /** Stable identifier — safe to log (carries no user content). */
    id: string;
    category: Cat;
    severity: GuardSeverity;
    /** Matcher over the normalized text. MUST NOT return captured content. */
    test: (normalized: string) => boolean;
}

const has = (re: RegExp) => (s: string): boolean => {
    re.lastIndex = 0;
    return re.test(s);
};

// ─── Injection rules (untrusted content → model) ────────────────────────────

export const INJECTION_RULES: ReadonlyArray<GuardRule<InjectionCategory>> = [
    // ignore-previous family
    {
        id: 'inj.ignore_previous.instructions',
        category: 'ignore_previous',
        severity: 'high',
        test: has(/\b(?:ignore|disregard|forget|override)\b[^.]{0,40}\b(?:previous|prior|above|earlier|all|any|the)\b[^.]{0,30}\b(?:instruction|instructions|prompt|prompts|context|rules?|message|messages)\b/),
    },
    {
        id: 'inj.ignore_previous.start_over',
        category: 'ignore_previous',
        severity: 'medium',
        test: has(/\b(?:forget everything|start over|clean slate|reset your (?:context|memory|instructions))\b/),
    },
    // system-role injection
    {
        id: 'inj.system_role.declared',
        category: 'system_role_injection',
        severity: 'high',
        test: has(/(?:^|[\n>])\s*(?:system|assistant|developer)\s*:/),
    },
    {
        id: 'inj.system_role.chat_template_token',
        category: 'system_role_injection',
        severity: 'high',
        // ChatML <|...|>, Llama [INST]/<<SYS>>, sequence tokens <s>/</s>.
        test: (s) =>
            has(/<\|[^|>]*\|>/)(s) ||
            has(/\[\/?inst\]/)(s) ||
            has(/<<\/?sys>>/)(s) ||
            has(/<\/?s>/)(s),
    },
    {
        id: 'inj.system_role.new_persona',
        category: 'system_role_injection',
        severity: 'medium',
        test: has(/\b(?:you are now|from now on you are|act as|pretend to be|roleplay as|you must act as)\b/),
    },
    // instruction-override
    {
        id: 'inj.instruction_override.new_rules',
        category: 'instruction_override',
        severity: 'high',
        test: has(/\b(?:new|updated|revised|real|actual)\s+(?:instruction|instructions|rules?|system prompt|directive)s?\s*:/),
    },
    {
        id: 'inj.instruction_override.reveal_prompt',
        category: 'instruction_override',
        severity: 'high',
        test: has(/\b(?:reveal|print|repeat|show|output|dump|leak)\b[^.]{0,30}\b(?:system prompt|your (?:instructions|prompt|rules)|the prompt above|initial prompt)\b/),
    },
    {
        id: 'inj.instruction_override.dan_jailbreak',
        category: 'instruction_override',
        severity: 'medium',
        test: has(/\b(?:do anything now|developer mode|jailbreak|no restrictions|without any (?:filter|restriction|guardrail)s?)\b/),
    },
    // tool poisoning (agent surfaces)
    {
        id: 'inj.tool_poisoning.call_tool',
        category: 'tool_poisoning',
        severity: 'high',
        test: has(/\b(?:call|invoke|execute|run|use)\b[^.]{0,25}\b(?:tool|function|command|shell|api|mcp)\b[^.]{0,25}\b(?:with|to|and)\b/),
    },
    {
        id: 'inj.tool_poisoning.override_tool_args',
        category: 'tool_poisoning',
        severity: 'medium',
        test: has(/\b(?:set|change|override|replace)\b[^.]{0,20}\b(?:parameter|argument|arg|field|recipient|amount|address|url)\b[^.]{0,20}\bto\b/),
    },
    // exfil directive (asking the model to send data out)
    {
        id: 'inj.exfil.send_data',
        category: 'exfil_directive',
        severity: 'high',
        test: has(/\b(?:send|post|exfiltrate|upload|transmit|leak|email|forward)\b[^.]{0,40}\b(?:to https?:\/\/|to www\.|to [a-z0-9.+_-]+@|api key|secret|token|credential|password|private key)\b/),
    },
    {
        id: 'inj.exfil.render_remote',
        category: 'exfil_directive',
        severity: 'medium',
        test: has(/!\[[^\]]*\]\(\s*https?:\/\/|\b(?:fetch|load|render|embed)\b[^.]{0,20}https?:\/\//),
    },
    {
        // Markdown-IMAGE exfil with a DATA-BEARING query string. Separate from
        // `render_remote` above, and high rather than medium, because the two
        // are not the same act: a bare `![logo](https://cdn/x.png)` is an image,
        // which is why that rule is deliberately tempered — but an image URL
        // carrying `?k=<something>` exfiltrates on RENDER, with no click and no
        // tool call, and the query string is what separates the two. Requiring
        // the `?`/`&` + `=` is what keeps this specific enough to be high.
        id: 'inj.exfil.markdown_image_beacon',
        category: 'exfil_directive',
        severity: 'high',
        test: has(/!\[[^\]]*\]\(\s*https?:\/\/[^)\s]*[?&][^)\s]*=/),
    },
];

// ─── Egress / DLP rules (model + agent output → outward) ─────────────────────
//
// These run against the RAW outbound text (not lower-cased) via a dedicated
// normalizer in the egress scanner, because secret shapes are case-sensitive.

export const EGRESS_RULES: ReadonlyArray<GuardRule<EgressCategory>> = [
    // Cloud / provider API keys.
    {
        id: 'egr.api_key.aws_access_key',
        category: 'api_key',
        severity: 'high',
        test: has(/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[A-Z0-9]{16}\b/),
    },
    {
        id: 'egr.api_key.google',
        category: 'api_key',
        severity: 'high',
        test: has(/\bAIza[0-9A-Za-z_-]{35}\b/),
    },
    {
        id: 'egr.api_key.slack',
        category: 'api_key',
        severity: 'high',
        test: has(/\bxox[baprs]-[0-9A-Za-z-]{10,}\b/),
    },
    {
        id: 'egr.api_key.stripe',
        category: 'api_key',
        severity: 'high',
        test: has(/\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/),
    },
    {
        id: 'egr.api_key.github',
        category: 'api_key',
        severity: 'high',
        test: has(/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[0-9A-Za-z_]{20,}\b/),
    },
    {
        id: 'egr.api_key.openai',
        category: 'api_key',
        severity: 'high',
        test: has(/\bsk-(?:proj-)?[0-9A-Za-z_-]{20,}\b/),
    },
    {
        id: 'egr.api_key.generic_assignment',
        category: 'api_key',
        severity: 'medium',
        test: has(/\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?[0-9A-Za-z/_+-]{16,}/i),
    },
    // Bearer tokens + JWTs.
    {
        id: 'egr.bearer_or_jwt.bearer',
        category: 'bearer_or_jwt',
        severity: 'high',
        test: has(/\bbearer\s+[0-9A-Za-z._-]{20,}\b/i),
    },
    {
        id: 'egr.bearer_or_jwt.jwt',
        category: 'bearer_or_jwt',
        severity: 'high',
        // three base64url segments separated by dots, starting eyJ (…{"…).
        test: has(/\beyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{5,}\b/),
    },
    // Private-key PEM blocks.
    {
        id: 'egr.private_key.pem',
        category: 'private_key',
        severity: 'high',
        test: has(/-----begin\s+(?:rsa\s+|dsa\s+|ec\s+|openssh\s+|pgp\s+)?private key-----/i),
    },
    // Crypto seed / mnemonic phrases (BIP-39-shaped: 12/24 lowercase words).
    {
        id: 'egr.seed_phrase.mnemonic',
        category: 'seed_phrase',
        severity: 'high',
        test: (s) => {
            const m = s.match(/\b(?:seed phrase|mnemonic|recovery phrase)\b/i);
            if (!m) return false;
            // Require a long run of space-separated lowercase words nearby.
            return /(?:\b[a-z]{3,8}\b\s+){11,}\b[a-z]{3,8}\b/.test(s);
        },
    },
    // Generic high-entropy secret shape — a long, mixed-charset token that
    // does not look like natural language. Deliberately medium severity to
    // temper false positives; the assignment-context rule above is stronger.
    {
        id: 'egr.high_entropy_secret.token',
        category: 'high_entropy_secret',
        severity: 'medium',
        test: (s) => {
            const re = /\b[0-9A-Za-z+/_-]{32,}\b/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(s)) !== null) {
                const tok = m[0];
                const hasLower = /[a-z]/.test(tok);
                const hasUpper = /[A-Z]/.test(tok);
                const hasDigit = /[0-9]/.test(tok);
                // Require all three classes to fire — filters out plain hex ids,
                // slugs, and sentences.
                if (hasLower && hasUpper && hasDigit) return true;
            }
            return false;
        },
    },
];
