/**
 * Every literal `t('…')` key a component calls must resolve in `messages/en.json`.
 *
 * This guard exists because nothing else in CI could see a missing key, and the
 * hole was not hypothetical: an entire tab shipped calling nine keys that were
 * never merged into either locale, and every i18n check stayed green.
 *
 * The reason they stayed green is worth stating, because it is the general
 * shape of the blind spot. `i18n-completeness` and `scripts/i18n-diff.mjs`
 * compare en.json to bg.json — MISSING, ORPHAN, PLACEHOLDER-DRIFT, DUPLICATE —
 * so they answer "do the two locales agree?". Two equally stale files agree
 * perfectly. `i18n-adoption-ratchet` scans SOURCE for hardcoded UI text, so it
 * is satisfied the moment a string is behind a `t()` call and never asks
 * whether that call resolves. Nobody was comparing the code to the catalogue,
 * in either direction, so the failure surfaced as raw dotted key paths rendered
 * in the browser.
 *
 * Scope, stated plainly rather than implied:
 *
 *   • A file that opens two namespaces used to be skipped outright, because
 *     `t('x')` is ambiguous to a static reader and guessing produces false
 *     failures. That gap SHIPPED A RED MAIN: `AgentDetailClient.tsx` opens
 *     `admin` and `agents`, so it was in the skipped set, and the Skills tab's
 *     label was merged under `agents.agentDetail.tabSkills` while the component
 *     asked for `admin.agentDetail.tabSkills`. The key existed in BOTH locales,
 *     so every parity check agreed; the page rendered `MISSING_MESSAGE` and the
 *     only thing that caught it was an E2E spec reading the rendered strings.
 *
 *     So the binding analysis the old note called for is now done, and it is
 *     not a guess: `const <id> = useTranslations('<ns>')` NAMES the binding, so
 *     `<id>('key')` resolves against that namespace and nothing else. A file
 *     qualifies only when every namespace it opens is bound to a DISTINCT
 *     identifier and the declaration count matches the namespace count —
 *     anything else still falls back, or is still skipped and COUNTED as
 *     skipped by the test below.
 *   • Still NOT covered: a file that opens a namespace without binding it to a
 *     const, or binds two namespaces to the same identifier. The count is
 *     asserted rather than described, so the gap cannot quietly grow.
 *   • Only LITERAL keys. `t(`${prefix}.${state}`)` cannot be resolved
 *     statically, and template-literal lookups are used deliberately in this
 *     codebase (the circuit-breaker posture badges, for one). Those keys are
 *     the ones a rendered test has to cover instead.
 *
 * Comments are stripped before scanning, so prose naming a key path — including
 * the prose above — cannot satisfy or trip the check.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');
const EN = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/en.json'), 'utf8'));

const NAMESPACE_RE =
    /useTranslations\(\s*['"]([^'"]+)['"]\s*\)|getTranslations\(\s*['"]([^'"]+)['"]\s*\)/g;
const CALL_RE = /\bt\(\s*'([A-Za-z0-9_.]+)'/g;
/**
 * `const <id> = useTranslations('<ns>')` — the declaration that BINDS an
 * identifier to a namespace. `await getTranslations(...)` is matched too
 * because the server components use that form.
 */
const DECL_RE =
    /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Every `<callee>('<literal>')` in one file, grouped by callee.
 *
 * ONE pass with a static pattern rather than a `new RegExp` per bound
 * identifier. Building the pattern from the identifier meant escaping it, and
 * a hand-rolled escape that handles `$` but not `\\` is the
 * incomplete-escaping shape CodeQL flags — correctly, even though `DECL_RE`
 * can only ever yield a JS identifier. Not escaping is better than escaping
 * carefully.
 *
 * It matches calls that have nothing to do with i18n (`require('x')`), which
 * costs nothing: only callees present in the binding map are ever consulted.
 */
function callsByCallee(src: string): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\(\s*'([A-Za-z0-9_.]+)'/g)) {
        const list = out.get(m[1]);
        if (list) list.push(m[2]);
        else out.set(m[1], [m[2]]);
    }
    return out;
}

function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

function resolves(dotted: string): boolean {
    let node: unknown = EN;
    for (const seg of dotted.split('.')) {
        if (typeof node !== 'object' || node === null || !(seg in (node as object))) return false;
        node = (node as Record<string, unknown>)[seg];
    }
    return true;
}

function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.next') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else if (e.name.endsWith('.tsx') || e.name.endsWith('.ts')) out.push(full);
    }
    return out;
}

interface Unresolved {
    file: string;
    key: string;
}

interface ScanResult {
    unresolved: Unresolved[];
    filesChecked: number;
    keysChecked: number;
    /** Files with >1 namespace that binding analysis DID resolve. */
    multiBound: number;
    /** Files with >1 namespace still skipped — the remaining gap, counted. */
    multiSkipped: number;
}

function scan(): ScanResult {
    const unresolved: Unresolved[] = [];
    let filesChecked = 0;
    let keysChecked = 0;
    let multiBound = 0;
    let multiSkipped = 0;

    const record = (file: string, ns: string, key: string) => {
        // A key ending in `.` is a PREFIX somebody concatenated —
        // `t('statusOption.' + row.status)`. It is not a key and it never
        // resolves, so counting it would make the widened scan report three
        // defects that are not there (measured: exactly these three, all in
        // VendorsClient). Dynamic lookups are out of scope per the header; a
        // trailing dot is their one unambiguous signature in a string literal.
        if (key.endsWith('.') || key.includes('..')) return;
        keysChecked++;
        const full = `${ns}.${key}`;
        if (!resolves(full)) unresolved.push({ file: path.relative(ROOT, file), key: full });
    };

    for (const file of walk(SRC)) {
        const src = stripComments(fs.readFileSync(file, 'utf8'));
        const namespaces = [...src.matchAll(NAMESPACE_RE)].map((m) => m[1] ?? m[2]);
        if (namespaces.length === 0) continue;

        // BOUND: every namespace this file opens is assigned to its own
        // identifier, so each call site names its namespace unambiguously.
        const decls = [...src.matchAll(DECL_RE)].map((m) => ({ id: m[1], ns: m[2] }));
        const distinct = new Set(decls.map((d) => d.id)).size === decls.length;
        if (decls.length === namespaces.length && distinct) {
            filesChecked++;
            if (new Set(namespaces).size > 1) multiBound++;
            const byCallee = callsByCallee(src);
            for (const { id, ns } of decls) {
                for (const key of byCallee.get(id) ?? []) record(file, ns, key);
            }
            continue;
        }

        // FALLBACK: one namespace, reached some other way (an inline call, a
        // re-bound `t`). Only `t('…')` is attributable here.
        if (new Set(namespaces).size === 1) {
            filesChecked++;
            for (const m of src.matchAll(CALL_RE)) record(file, namespaces[0], m[1]);
            continue;
        }

        multiSkipped++;
    }
    return { unresolved, filesChecked, keysChecked, multiBound, multiSkipped };
}

describe('i18n — every literal t() key resolves in en.json', () => {
    const { unresolved, filesChecked, keysChecked, multiBound, multiSkipped } = scan();

    it('the scan actually reached the code it claims to cover', () => {
        // Positive companion. A scan that silently matched nothing would report
        // zero unresolved keys and look identical to a clean tree — the exact
        // ambiguity that let the missing keys through in the first place.
        expect(filesChecked).toBeGreaterThan(250);
        expect(keysChecked).toBeGreaterThan(4000);
    });

    it('and the multi-namespace files it used to skip are mostly covered now', () => {
        // The gap is a NUMBER, not a sentence in the header. 28 of the 53
        // multi-namespace files bind every namespace to its own identifier and
        // are now resolved; the other 25 are still skipped, and that figure is
        // asserted so it cannot quietly grow while the header still claims
        // "mostly covered".
        expect(multiBound).toBeGreaterThanOrEqual(28);
        expect(multiSkipped).toBeLessThanOrEqual(25);
    });

    it('a per-identifier call is attributed to ITS namespace, not the file\'s first', () => {
        // The exact shape that shipped a red main: `AgentDetailClient` opens
        // `admin` as `t` and `agents` as `tAgents`, and the Skills tab label was
        // merged under the wrong one. Both locales held it, so every parity
        // check agreed.
        const bound = stripComments(
            "const t = useTranslations('admin');\n" +
            "const tAgents = useTranslations('agents');\n" +
            "t('agentDetail.tabSkills');\n" +
            "tAgents('runs.title');\n",
        );
        const byCallee = callsByCallee(bound);
        expect(byCallee.get('t')).toEqual(['agentDetail.tabSkills']);
        expect(byCallee.get('tAgents')).toEqual(['runs.title']);
        // A longer identifier is NOT matched as a shorter one's call: looking up
        // `t` must not pick up `tAgents(...)`, which is the bug a per-identifier
        // regex with a loose boundary would have.
        expect(byCallee.get('t')).not.toContain('runs.title');
        // …and the label really does live under `admin`, which is the fix.
        expect(resolves('admin.agentDetail.tabSkills')).toBe(true);
        expect(resolves('agents.agentDetail.tabSkills')).toBe(false);
    });

    it('resolves a key that is known to exist, and rejects one that is not', () => {
        // Proves the resolver itself works, so a green run means "checked and
        // found nothing" rather than "the resolver returns true for anything".
        expect(resolves('admin.agentDetail.tabOverview')).toBe(true);
        expect(resolves('admin.agentDetail.__definitely_not_a_key__')).toBe(false);
    });

    it('no component calls a key the catalogue does not have', () => {
        const sample = unresolved
            .slice(0, 20)
            .map((u) => `  ${u.file}\n    -> ${u.key}`)
            .join('\n');
        expect(
            unresolved.length === 0
                ? ''
                : `${unresolved.length} t() call(s) reference a key absent from messages/en.json.\n` +
                  `These render as the raw dotted path in the UI, in every locale.\n\n${sample}`,
        ).toBe('');
    });
});
