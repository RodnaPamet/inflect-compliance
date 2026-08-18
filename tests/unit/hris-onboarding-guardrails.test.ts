/**
 * Onboarding a second HRIS provider must not be a memory test.
 *
 * Two things here, both of which fail SILENTLY — nothing errors, the provider
 * simply does the wrong thing — and both of which are invisible while
 * `HRIS_PROVIDERS` has exactly one member.
 *
 * 1. THE ALLOWLIST WAS DUPLICATED across a job/usecase boundary:
 *      jobs/hris-sync.ts      const HRIS_PROVIDERS = ['bamboohr']
 *      usecases/hris-sync.ts  new Set(['bamboohr'])
 *    The job's copy drives the dispatch query, the usecase's copy guards the
 *    run. Add a provider to one and not the other and you get either a
 *    provider that registers but is never dispatched, or one that is
 *    dispatched and then refused. Neither raises anything.
 *
 * 2. THE TRUNCATION METRIC WAS HARDCODED to 'bamboohr' where the identity twin
 *    (identity-sync.ts:191) passes `conn.provider`. With one HRIS provider that
 *    is accidentally correct. With two it is silently wrong in the worst
 *    direction: a Workday truncation alerts as bamboohr, so the page routes to
 *    whoever owns bamboohr, and a real Workday truncation reads as somebody
 *    else's problem. The metric exists precisely to catch silent truncation,
 *    so mislabelling it defeats the thing it was added for.
 *
 * Landed BEFORE the second provider exists, so it constrains the first draft
 * rather than being retrofitted to one already written.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HRIS_PROVIDERS, isHrisProviderId } from '@/app-layer/integrations/providers/hris';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const codeOnly = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const JOB = 'src/app-layer/jobs/hris-sync.ts';
const USECASE = 'src/app-layer/usecases/hris-sync.ts';

describe('the HRIS allowlist exists once', () => {
    it('both consumers import it rather than declaring their own', () => {
        for (const f of [JOB, USECASE]) {
            const src = codeOnly(read(f));
            // A local `const HRIS_PROVIDERS = [...]` / `new Set([...])` is the
            // shape that drifted. Importing the name is fine; redeclaring is not.
            expect(src).not.toMatch(/const\s+HRIS_PROVIDERS\s*=/);
            expect(src).toMatch(/providers\/hris/);
        }
    });

    it('the membership test and the query list agree by construction', () => {
        // The job needs an array (Prisma `in`), the usecase needs a predicate.
        // Deriving both from one source is the point — assert they cannot
        // disagree rather than that they happen to match today.
        for (const id of HRIS_PROVIDERS) {
            expect(isHrisProviderId(id)).toBe(true);
        }
        expect(isHrisProviderId('definitely-not-an-hris-provider')).toBe(false);
    });

    it('bamboohr is still in it — the collapse must not have dropped a member', () => {
        expect(isHrisProviderId('bamboohr')).toBe(true);
    });
});

describe('the truncation metric reports the provider that truncated', () => {
    it('passes conn.provider, not a literal', () => {
        const src = codeOnly(read(USECASE));
        expect(src).toMatch(/recordSyncTruncated\(\{\s*provider:\s*conn\.provider\s*\}\)/);
        expect(src).not.toMatch(/recordSyncTruncated\(\{\s*provider:\s*['"]/);
    });

    it('matches the identity-sync twin it drifted from', () => {
        // The two sync paths should report truncation identically; the HRIS one
        // having a literal was the only difference.
        const identity = codeOnly(read('src/app-layer/usecases/identity-sync.ts'));
        expect(identity).toMatch(/recordSyncTruncated\(\{\s*provider:\s*conn\.provider\s*\}\)/);
    });
});
