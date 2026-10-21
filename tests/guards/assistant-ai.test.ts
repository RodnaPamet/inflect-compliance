/**
 * PR-10 — conversational assistant: structural ratchet.
 *
 * The load-bearing safety property is propose-not-commit: the assistant answers
 * read questions from live data, but an ACTION request is routed to the EXISTING
 * agent-proposal queue (a human approves before anything is created) — the
 * assistant NEVER imports or calls a create-usecase directly.
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

describe('assistant AI — governance + propose-not-commit', () => {
    const usecase = read('src/app-layer/usecases/assistant.ts');

    it('follows the governed-AI ordering (gate → rate-limit → record)', () => {
        expect(usecase).toMatch(/enforceFeatureGate\(ctx, 'assistant'\)/);
        expect(usecase).toMatch(/checkRateLimit\(ctx\.tenantId, ctx\.userId\)/);
        expect(usecase).toMatch(/recordGeneration\(ctx\.tenantId, ctx\.userId\)/);
        expect(usecase.indexOf('enforceFeatureGate')).toBeLessThan(usecase.indexOf('checkRateLimit'));
        expect(usecase.indexOf('checkRateLimit')).toBeLessThan(usecase.indexOf('recordGeneration'));
    });

    it('guards untrusted input AND egress', () => {
        expect(usecase).toMatch(/guardUntrustedInput\(ctx, question/);
        expect(usecase).toMatch(/guardEgress\(ctx, \{ message/);
        expect(usecase).toMatch(/assertGuardAllowed/);
    });

    it('actions are PROPOSED through the funnel, never executed directly', () => {
        // ═══ THE NEEDLE MOVED; THE PROPERTY DID NOT ═══
        //
        // This asserted `createAgentProposal(ctx, {` plus `kind: 'FINDING'`
        // and `kind: 'RISK'` — the two keyword branches that used to own
        // proposing. #3882 removed them: the model now calls a propose TOOL,
        // and `runProposeTool` calls `createAgentProposal` on the other side
        // of the same funnel that authorizes it.
        //
        // So the old needles are gone and the guarantee is stronger, not
        // weaker — the funnel also enforces the capability, the scope, the
        // autonomy rung and the policy-card pin, none of which the direct call
        // did. Re-aimed at the mechanism that now carries it rather than
        // deleted, because a guard whose subject moves and is deleted leaves
        // the property unguarded at exactly the moment it changed hands.
        //
        // The import allowlist below is the other half and needs no change: it
        // already fails on ANY create-usecase import, and the assistant now
        // imports fewer of them than before.

        // The propose surface reaches the MODEL — `readOnly: false` is what
        // offers it, and `true` would silently return to read-only.
        expect(usecase).toMatch(/assistantTools\(inv, \{ readOnly: false \}\)/);

        // The outcome is read from the funnel's structured result, and the
        // user-facing sentence is COMPOSED from it rather than relayed. A
        // relayed sentence is how "quarantined" becomes "queued for review".
        expect(usecase).toMatch(/set\.proposals\(\)/);
        expect(usecase).toMatch(/proposalOutcomeMessage\(proposals\)/);

        // And the verdict is never taken from the model's text: the only
        // `message:` on the proposal path is the composed one.
        expect(usecase).not.toMatch(/message: result\.text,[\s\S]{0,200}proposalId/);
    });

    it('the keyword propose branches are GONE, not merely bypassed', () => {
        // Left in front of the loop they would win whenever their regex
        // matched, so two producers would disagree about which phrasings
        // propose — and a user would get a proposal or an answer depending on
        // their wording.
        expect(usecase).not.toMatch(/\bcreateAgentProposal\(ctx, \{/);
        expect(usecase).not.toMatch(/extractTitle\(question/);
    });

    // H5 — POSITIVE allowlist (was a 3-name blacklist that missed
    // createControl / createPolicy / any update*/delete*). The assistant may
    // reach ONLY these usecase-layer modules; any other app-layer/usecases
    // import is a propose-not-commit escape and fails CI.
    it('imports ONLY the allowlisted usecase-layer modules (read + the propose queue)', () => {
        const ALLOWED_USECASE_MODULES = new Set(['dashboard', 'agent-proposals']);
        // Match every `from './x'` / `from '../x'` / `@/app-layer/usecases/x` import.
        const importRe = /from\s+['"]((?:\.\.?\/|@\/app-layer\/usecases\/)[^'"]+)['"]/g;
        const offenders: string[] = [];
        let m: RegExpExecArray | null;
        while ((m = importRe.exec(usecase)) !== null) {
            const spec = m[1];
            // Only police the usecases layer: bare './name' (sibling usecase) or
            // an explicit @/app-layer/usecases/ path. Other layers (ai, types,
            // lib, db-context) are not create-usecases.
            const isSiblingUsecase = /^\.\/[a-z-]+$/.test(spec); // './dashboard'
            const isExplicitUsecase = spec.includes('@/app-layer/usecases/');
            if (!isSiblingUsecase && !isExplicitUsecase) continue;
            if (spec === '../types') continue; // the RequestContext type
            const base = spec.split('/').pop()!;
            if (!ALLOWED_USECASE_MODULES.has(base)) offenders.push(spec);
        }
        expect(offenders).toEqual([]);
    });

    it('read answers come from live tenant posture data', () => {
        expect(usecase).toMatch(/getDashboardData\(ctx\)/);
    });

    it('the ask route is permission-gated and validates input', () => {
        const route = read('src/app/api/t/[tenantSlug]/assistant/ask/route.ts');
        expect(route).toMatch(/requirePermission<\{ tenantSlug: string \}>\('controls\.view'/);
        expect(route).toMatch(/AskAssistantSchema/);
        expect(route).toMatch(/askAssistant\(ctx, body\)/);
    });
});
