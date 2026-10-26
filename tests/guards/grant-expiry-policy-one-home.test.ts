import * as fs from 'fs';

import { repoFiles, repoRelative } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';

/**
 * #3314 — THE GRANT-EXPIRY POLICY HAS ONE HOME, AND A SECOND GRANT TARGET
 * MOVES IT OUT OF THE ENTRA MODULE.
 *
 * `expiryRefusal` and `MAX_GRANT_DAYS` live in
 * `providers/entra-id/entitlement.ts`. They are product policy, not facts about
 * Microsoft Graph: a grant names when it ends, the end parses, it lies in the
 * future, and it ends before the quarterly review that would catch it. With one
 * grant target, keeping the policy beside its only caller is right, and #3314
 * says to do nothing until a second target exists.
 *
 * That condition rots quietly: the day it becomes true, nothing announces it.
 * The failure that follows is two copies of one predicate, and the one that
 * matters is the quiet one. A second target whose copy of the cap drifted
 * UPWARD would grant access that outlives a review cycle, and nothing would
 * fail. So this guard announces the condition, and holds the policy to one
 * definition until then:
 *
 *   1. `expiryRefusal` and `MAX_GRANT_DAYS` are each defined exactly once
 *      under `src/`.
 *   2. A provider is a grant target when it has an `entitlement.ts` or any of
 *      its files names `TimeBoundedGrantInput`. While there is one, the policy
 *      may live in that provider. With two or more, it may not: lift it into a
 *      provider-neutral module and have every target call that.
 */

const PROVIDERS = 'src/app-layer/integrations/providers';
const POLICY_SYMBOLS = ['expiryRefusal', 'MAX_GRANT_DAYS'] as const;

interface Definition {
    readonly symbol: string;
    readonly file: string;
}

/** What the guard decides, given what it found. Pure, so it can be tested. */
function grantPolicyProblems(targets: readonly string[], definitions: readonly Definition[]): string[] {
    const problems: string[] = [];
    for (const symbol of POLICY_SYMBOLS) {
        const where = definitions.filter((d) => d.symbol === symbol).map((d) => d.file);
        if (where.length !== 1) {
            problems.push(
                `\`${symbol}\` must be defined exactly once under src/; found ${where.length}` +
                    (where.length ? `: ${where.join(', ')}` : '') +
                    '. Two copies of the grant-expiry policy can disagree, and the one that drifted is the one nobody reads (#3314).',
            );
        }
    }
    if (targets.length > 1) {
        for (const d of definitions) {
            if (d.file.startsWith(`${PROVIDERS}/`)) {
                problems.push(
                    `There are ${targets.length} grant targets (${targets.join(', ')}), and \`${d.symbol}\` still lives in ${d.file}. ` +
                        'Lift it into a provider-neutral module and have every target call it — #3314 says what moves and why.',
                );
            }
        }
    }
    return problems;
}

const DEFINITION = (symbol: string) =>
    new RegExp(`\\bexport\\s+(?:async\\s+)?(?:function\\s+${symbol}\\b|const\\s+${symbol}\\b)|\\b(?:function|const|let)\\s+${symbol}\\b`);

function scan(): { targets: string[]; definitions: Definition[]; providerDirs: Set<string> } {
    const files = repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] }).map((abs) => ({
        rel: repoRelative(abs),
        code: codeOf(fs.readFileSync(abs, 'utf8')),
    }));

    const providerDirs = new Set<string>();
    const targets = new Set<string>();
    for (const { rel, code } of files) {
        if (!rel.startsWith(`${PROVIDERS}/`)) continue;
        const provider = rel.slice(PROVIDERS.length + 1).split('/')[0];
        if (!rel.slice(PROVIDERS.length + 1).includes('/')) continue; // a file directly under providers/
        providerDirs.add(provider);
        if (rel.endsWith('/entitlement.ts') || /\bTimeBoundedGrantInput\b/.test(code)) targets.add(provider);
    }

    const definitions: Definition[] = [];
    for (const { rel, code } of files) {
        for (const symbol of POLICY_SYMBOLS) {
            if (DEFINITION(symbol).test(code)) definitions.push({ symbol, file: rel });
        }
    }
    return { targets: [...targets].sort(), definitions, providerDirs };
}

describe('the grant-expiry policy has one home (#3314)', () => {
    const { targets, definitions, providerDirs } = scan();

    it('scans a real population', () => {
        // A clean result over nothing would say nothing.
        expect(providerDirs.size).toBeGreaterThanOrEqual(10);
        expect(targets).toContain('entra-id');
        expect(definitions.map((d) => d.symbol).sort()).toEqual([...POLICY_SYMBOLS].sort());
    });

    it('holds the policy to one definition, outside any provider once there are two targets', () => {
        expect(grantPolicyProblems(targets, definitions)).toEqual([]);
    });

    describe('the rule fires', () => {
        const inEntra: Definition[] = POLICY_SYMBOLS.map((symbol) => ({
            symbol,
            file: `${PROVIDERS}/entra-id/entitlement.ts`,
        }));

        it('accepts the policy in the only target', () => {
            expect(grantPolicyProblems(['entra-id'], inEntra)).toEqual([]);
        });

        it('refuses it in a provider once a second target exists', () => {
            const problems = grantPolicyProblems(['entra-id', 'okta'], inEntra);
            expect(problems).toHaveLength(2);
            expect(problems[0]).toContain('2 grant targets (entra-id, okta)');
        });

        it('accepts two targets once the policy is provider-neutral', () => {
            const lifted = POLICY_SYMBOLS.map((symbol) => ({ symbol, file: 'src/lib/grants/expiry-policy.ts' }));
            expect(grantPolicyProblems(['entra-id', 'okta'], lifted)).toEqual([]);
        });

        it('refuses a second copy, whatever the target count', () => {
            const copied = [...inEntra, { symbol: 'MAX_GRANT_DAYS', file: `${PROVIDERS}/okta/entitlement.ts` }];
            expect(grantPolicyProblems(['entra-id'], copied).join('\n')).toContain('`MAX_GRANT_DAYS` must be defined exactly once');
        });
    });
});
