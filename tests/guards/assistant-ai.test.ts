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

    it('actions are PROPOSED via the existing agent-proposal queue, never executed directly', () => {
        expect(usecase).toMatch(/createAgentProposal\(ctx, \{/);
        expect(usecase).toMatch(/kind: 'FINDING'/);
        expect(usecase).toMatch(/kind: 'RISK'/);
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
