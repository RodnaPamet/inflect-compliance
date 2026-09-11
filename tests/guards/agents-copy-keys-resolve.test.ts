/**
 * EVERY `agents.*` KEY THE AGENTIC SUBTREE ASKS FOR EXISTS IN BOTH CATALOGUES.
 *
 * ── THE DEFECT THIS EXISTS FOR, MEASURED ON ITSELF ──────────────────────────
 *
 * next-intl renders a MISSING key as its own dotted path. So a surface asking
 * for a key nobody defined does not throw, does not warn in production, and
 * does not fail any test that renders it — it renders `register.new.title`
 * where a title should be, and only a human looking at the page notices.
 *
 * That is not hypothetical here. AGENTIC UI 1/4 moved the register's ~30 keys
 * from `admin.agentRegistry.*` to `agents.register.*` (#2426) and
 * `NewAgentModal.tsx` — 36 call sites, none of them rendered by any existing
 * test — kept asking for the old names. Every guard, every guardrail, the
 * completeness ratchet and `tsc` were green on a create modal whose every
 * label and every error message was a dotted path.
 *
 * `i18n-completeness.test.ts` cannot see this: it compares locale keysets
 * against each other, so a key that exists in NEITHER locale is not drift. It
 * polices the catalogue. This polices the CALL SITES.
 *
 * ── WHY THIS SUBTREE, AND WHY NOT REPO-WIDE ─────────────────────────────────
 *
 * Repo-wide would be the better guard and is a different job: `t` is bound to a
 * namespace per file, several files open two or three, and a handful build keys
 * from a variable. Narrowed to the `agents` namespace, the resolution is exact
 * — one namespace, and every call site in one subtree — so the check makes a
 * claim it can actually keep rather than a partial one dressed as total.
 *
 * ── INTERPOLATED KEYS ARE CHECKED AT THE PREFIX ─────────────────────────────
 *
 * `t(`register.filterEnums.status.${row.original.status}`)` cannot be resolved
 * statically, so the PARENT is: `agents.register.filterEnums.status` must exist
 * and must be an object. That catches the whole-subtree rename this file was
 * written for, and does not pretend to catch a single bad enum member.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf } from '../helpers/source-blocks';
import { repoFiles, repoRelative } from '../helpers/repo-files';

const ROOT = path.resolve(__dirname, '../..');
const AGENTS_DIR = 'src/app/t/[tenantSlug]/(app)/agents';

type Bag = Record<string, unknown>;
const EN = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/en.json'), 'utf8')) as Bag;
const BG = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/bg.json'), 'utf8')) as Bag;

/** Walk a dotted path through a catalogue. */
function resolve(bag: Bag, dotted: string): unknown {
    return dotted
        .split('.')
        .reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Bag)[k] : undefined),
            bag,
        );
}

/**
 * Every key the subtree asks the `agents` namespace for.
 *
 * Two shapes, and the distinction is the whole design:
 *   · a STRING key      — `t('register.title')`, resolved exactly
 *   · an INTERPOLATED   — `` t(`register.reversibility.${x}`) ``, resolved to
 *                         its parent object
 *
 * THE IDENTIFIER BOUND TO THE NAMESPACE IS RESOLVED PER FILE, and that is not
 * a refinement — it is the difference between this guard working and lying.
 * Several files in this subtree open TWO namespaces (`t` for one, `tAdmin` /
 * `tAgents` / `tGroup` / `tCommon` for another), and a pattern that matched a
 * bare `t(` wherever `useTranslations('agents')` appeared collected fifteen
 * `admin.agentDetail.*` keys and reported them missing from `agents`. A guard
 * that names the wrong namespace fails on correct code, which is the failure
 * mode that gets a guard deleted rather than fixed.
 *
 * Both binding forms count: `useTranslations` (client) and the awaited
 * `getTranslations` (server).
 */
function collect(): { exact: Set<string>; prefixes: Set<string>; sites: number } {
    const exact = new Set<string>();
    const prefixes = new Set<string>();
    let sites = 0;

    for (const abs of repoFiles({ under: AGENTS_DIR, extensions: ['.ts', '.tsx'] })) {
        // COMMENTS STRIPPED. A docstring naming a key it no longer uses would
        // otherwise be a call site the catalogue has to satisfy.
        const code = codeOf(fs.readFileSync(abs, 'utf8'));

        // Which local name is bound to THIS namespace in THIS file. There can
        // be more than one (a component and a helper in one file), so they all
        // count; a file that binds none is skipped entirely.
        const bound = [
            ...code.matchAll(
                /const\s+(\w+)\s*=\s*(?:await\s+)?(?:use|get)Translations\(\s*['"]agents['"]\s*\)/g,
            ),
        ].map((m) => m[1]);
        if (bound.length === 0) continue;

        for (const name of bound) {
            for (const m of code.matchAll(new RegExp('\\b' + name + "\\(\\s*'([^']+)'", 'g'))) {
                sites++;
                exact.add(m[1]);
            }
            for (const m of code.matchAll(new RegExp('\\b' + name + '\\(\\s*`([^`]+)`', 'g'))) {
                sites++;
                // Everything before the first interpolation, minus the
                // trailing dot.
                const prefix = m[1].split('${')[0].replace(/\.$/, '');
                if (prefix !== '') prefixes.add(prefix);
            }
        }
    }
    return { exact, prefixes, sites };
}

const { exact, prefixes, sites } = collect();

describe('the scan found call sites at all', () => {
    it('reads the agents subtree and finds `agents`-namespace keys', () => {
        // Without this, every "resolves" assertion below is vacuous over an
        // empty set — which is how a guard reports total coverage of nothing.
        expect(sites).toBeGreaterThan(40);
        expect(exact.size).toBeGreaterThan(20);
        expect(prefixes.size).toBeGreaterThanOrEqual(3);
    });

    it('the subtree exists where this guard looks for it', () => {
        expect(fs.existsSync(path.join(ROOT, AGENTS_DIR))).toBe(true);
    });

    it('does NOT pick up keys from the other namespaces those files open', () => {
        // `tAdmin('agentDetail.…')`, `tGroup('attributes')` and
        // `tCommon('…')` all live in this subtree, bound to OTHER namespaces in
        // the same files. The first version of this collector matched a bare
        // `t(` wherever the agents namespace was opened anywhere in the file
        // and swept in fifteen `admin.agentDetail.*` keys — correct code,
        // reported as missing.
        //
        // A leading `agentDetail.` is the tell, because `AgentDetailClient`
        // opens both namespaces in one component and is where that went wrong.
        for (const key of exact) {
            expect(key.startsWith('agentDetail.')).toBe(false);
            expect(key.startsWith('crumb.')).toBe(false);
        }
        // Paired POSITIVE: the `admin`-namespace keys really are in those
        // files, so the absences above are the binding resolution working
        // rather than a scan that read nothing.
        const detailClient = codeOf(
            fs.readFileSync(path.join(ROOT, AGENTS_DIR, '[agentId]/AgentDetailClient.tsx'), 'utf8'),
        );
        expect(detailClient).toContain("t('agentDetail.tabOverview')");
        expect(detailClient).toContain("useTranslations('agents')");
    });
});

describe('every exact key resolves to a string in BOTH locales', () => {
    it('en.json defines all of them', () => {
        const missing = [...exact]
            .filter((k) => typeof resolve(EN, `agents.${k}`) !== 'string')
            .sort();
        if (missing.length > 0) {
            throw new Error(
                `${missing.length} key(s) the agents subtree asks for do not exist ` +
                    `under \`agents\` in messages/en.json:\n  ${missing.join('\n  ')}\n\n` +
                    `next-intl renders a missing key as its own dotted path, so these ` +
                    `render as literal text on the page and fail nothing. Define them, ` +
                    `or fix the call site's namespace.`,
            );
        }
        expect(missing).toEqual([]);
    });

    it('bg.json defines all of them', () => {
        // The completeness ratchet already pins en ⇔ bg, so this cannot fail
        // alone — which makes it the paired check that says so rather than a
        // second copy of the same assertion.
        const missing = [...exact]
            .filter((k) => typeof resolve(BG, `agents.${k}`) !== 'string')
            .sort();
        expect(missing).toEqual([]);
    });
});

describe('every interpolated key’s PARENT resolves to an object', () => {
    it.each([...prefixes].sort().map((p) => [p] as const))(
        'agents.%s is a populated object',
        (prefix) => {
            const bag = resolve(EN, `agents.${prefix}`);
            expect(typeof bag).toBe('object');
            expect(bag).not.toBeNull();
            // POPULATED, not merely present: an empty object would satisfy
            // every member lookup with `undefined` and render dotted paths for
            // all of them.
            expect(Object.keys(bag as Bag).length).toBeGreaterThan(0);
        },
    );
});

describe('the register’s copy left the admin namespace entirely', () => {
    it('admin.agentRegistry is gone from both locales', () => {
        // The other half of the move. Leaving the old subtree behind would mean
        // two copies of thirty strings, free to drift — which is the state
        // #2380 was about, one level up.
        expect(resolve(EN, 'admin.agentRegistry')).toBeUndefined();
        expect(resolve(BG, 'admin.agentRegistry')).toBeUndefined();
    });

    it('nothing anywhere in src/ still asks for it', () => {
        const offenders = repoFiles({ under: 'src', extensions: ['.ts', '.tsx'] })
            .filter((abs) => codeOf(fs.readFileSync(abs, 'utf8')).includes('agentRegistry.'))
            .map((abs) => repoRelative(abs));
        expect(offenders).toEqual([]);
    });

    it('but `admin.agentDetail` STAYED, and the register still reaches for one of its keys', () => {
        // Deliberate, and the reason is #2380: the register's owner column and
        // the detail page's overview answer ONE question about one agent, and
        // they answered it differently. One key is the only arrangement in
        // which they cannot drift apart again — so the register reads across
        // rather than minting a second string. Pinned here so a later tidy-up
        // that "finishes the move" has to read this first.
        expect(typeof resolve(EN, 'admin.agentDetail.overview.ownerEmpty')).toBe('string');
        const register = fs.readFileSync(
            path.join(ROOT, AGENTS_DIR, 'AgentsClient.tsx'),
            'utf8',
        );
        expect(codeOf(register)).toContain("tAdmin('agentDetail.overview.ownerEmpty')");
    });
});
