/**
 * Prompt-template hygiene — a lightweight structural ratchet over IC's OWN
 * prompt-construction code (NOT a new CI system). It locks three invariants
 * that keep the LLM prompt surface safe:
 *
 *   1. DELIMITING — untrusted/tenant free-text is fenced + neutralised in the
 *      assembled prompt, never bare-concatenated (ties to the input guard).
 *   2. NO SECRETS — no hardcoded credential/API-key patterns in a prompt
 *      template (reuses the .secret-patterns tripwire).
 *   3. ROLE SEPARATION — system-instruction and user-content are distinct
 *      roles; untrusted free-text is never interpolated into the SYSTEM role.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// At the seam, not per assertion, so a new `expect(read(...))` inherits it.
// String literals are KEPT — masking them would silently empty assertions that
// harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike, re-derived per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

// The prompt-builders in the repo. Each returns { system, user, ... }.
//   - risk-assessment interpolates FREE-TEXT tenant data (asset names, context)
//     → must fence + neutralise.
//   - vendor-doc places PRE-SANITISED document text in the user role.
//   - compliance-posture serialises STRUCTURED numeric signals (no free text).
const PROMPT_BUILDERS = [
    'src/app-layer/ai/risk-assessment/prompt-builder.ts',
    'src/app-layer/ai/compliance-posture/prompt-builder.ts',
    'src/app-layer/ai/vendor-doc/index.ts',
] as const;

describe('1. delimiting — free-text tenant data is fenced + neutralised', () => {
    it('the risk-assessment builder fences AND neutralises untrusted tenant text', () => {
        const src = read('src/app-layer/ai/risk-assessment/prompt-builder.ts');
        // Fence markers wrap the untrusted block.
        expect(src).toMatch(/UNTRUSTED_DATA_OPEN/);
        expect(src).toMatch(/UNTRUSTED_DATA_CLOSE/);
        // A neutraliser strips forged markers / reserved chat-template tokens.
        expect(src).toMatch(/function neutralizeUntrustedText\b/);
        // …and the assembled prompt actually applies it to tenant values.
        expect(src).toMatch(/neutralizeUntrustedText\(/);
    });

    it('mutation proof — removing the neutraliser call is detectable', () => {
        const mutated = read('src/app-layer/ai/risk-assessment/prompt-builder.ts')
            .replace(/neutralizeUntrustedText\(/g, 'passthrough(');
        expect(/neutralizeUntrustedText\(/.test(mutated)).toBe(false);
    });

    it('the vendor-doc builder consumes PRE-SANITISED text (not raw)', () => {
        const src = read('src/app-layer/ai/vendor-doc/index.ts');
        expect(src).toMatch(/buildPrompt\(\s*sanitizedText/);
    });
});

describe('2. no hardcoded secrets in prompt templates', () => {
    // Minimal loader mirroring tests/guardrails/no-secrets.test.ts: `name | regex`,
    // `#`/blank lines skipped, first `|` splits, a leading `(?i)` → 'i' flag.
    function loadPatterns(): { name: string; regex: RegExp }[] {
        const raw = read('.secret-patterns');
        const out: { name: string; regex: RegExp }[] = [];
        for (const line of raw.split('\n')) {
            const t = line.trim();
            if (!t || t.startsWith('#')) continue;
            const bar = t.indexOf('|');
            if (bar === -1) continue;
            const name = t.slice(0, bar).trim();
            let body = t.slice(bar + 1).trim();
            let flags = '';
            if (body.startsWith('(?i)')) {
                flags = 'i';
                body = body.slice(4);
            }
            try {
                out.push({ name, regex: new RegExp(body, flags) });
            } catch {
                // skip a pattern this minimal loader can't compile
            }
        }
        return out;
    }

    const patterns = loadPatterns();

    it('loads the shared secret patterns', () => {
        expect(patterns.length).toBeGreaterThan(0);
    });

    it.each(PROMPT_BUILDERS)('%s contains no secret-shaped content', (rel) => {
        const src = read(rel);
        const hits: string[] = [];
        for (const p of patterns) {
            if (p.regex.test(src)) hits.push(p.name);
        }
        expect(hits).toEqual([]);
    });
});

describe('3. system/user role separation', () => {
    it.each(PROMPT_BUILDERS)('%s returns distinct system + user roles', (rel) => {
        const src = read(rel);
        expect(src).toMatch(/system:/);
        expect(src).toMatch(/user:/);
    });

    it('untrusted free-text is placed in the USER role, never the SYSTEM role', () => {
        // In the risk-assessment builder the SYSTEM message is assigned first
        // (static instructions + the trust-boundary directive); every
        // neutralizeUntrustedText() call — i.e. all tenant free-text — appears
        // AFTER, in the user-message assembly.
        const src = read('src/app-layer/ai/risk-assessment/prompt-builder.ts');
        const systemAssign = src.search(/const system\s*=/);
        const userAssign = src.search(/const user\s*=/);
        // The neutraliser is aliased `const nz = neutralizeUntrustedText` AFTER
        // the system string is fixed; every `nz(...)` application (all tenant
        // free-text) therefore lands in the user assembly, not the system role.
        const nzAliasAssign = src.search(/const nz\s*=\s*neutralizeUntrustedText/);
        const firstNzApply = src.search(/\bnz\(/);
        expect(systemAssign).toBeGreaterThan(-1);
        expect(userAssign).toBeGreaterThan(-1);
        // The user assembly comes after the system assembly.
        expect(userAssign).toBeGreaterThan(systemAssign);
        // Tenant free-text (nz applications) is applied only after the system
        // instructions are fixed — never interpolated into the system role.
        expect(nzAliasAssign).toBeGreaterThan(systemAssign);
        expect(firstNzApply).toBeGreaterThan(systemAssign);
    });
});
