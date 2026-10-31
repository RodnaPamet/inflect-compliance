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
 *   • MULTI-NAMESPACE FILES ARE NOW COVERED, and that gap is why this guard
 *     changed. It used to check only files with exactly ONE namespace (328 of
 *     373), skipping any file that opened two because `t('x')` was called
 *     ambiguous to a static reader. The 45 skipped files were named here as "a
 *     real gap, not a rounding error" — and on 2026-10-13 the gap bit exactly
 *     as described: `AgentDetailClient.tsx` opens `admin` AND `agents`, a tab
 *     label was written as `t('agentDetail.tabSkills')` against the `admin`
 *     translator, and the key was added under `agents.agentDetail` instead.
 *     Both locales had it, so every parity check passed; the page threw
 *     `MISSING_MESSAGE` and E2E was red on main for four runs.
 *
 *     The ambiguity was never real. `const t = useTranslations('admin')` binds
 *     `t` to a namespace in the same statement, so the namespace of a call is
 *     readable from the IDENTIFIER rather than guessed from the file. Each
 *     translator variable is bound to its own namespace and its calls resolved
 *     against that one. A file whose namespace call is not a simple `const`
 *     binding (an inline call, a destructure, a re-export) still cannot be
 *     bound and is still skipped — that residue is counted and asserted below,
 *     so it cannot grow silently.
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
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');
const EN = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/en.json'), 'utf8'));

/**
 * Files whose translator namespace cannot be bound to an identifier.
 *
 * A DOWNWARD ratchet. Set to the live count when per-identifier binding landed;
 * every one of these is a file this guard does not cover, so the number is a
 * debt rather than a budget.
 */
const UNBOUND_CEILING = 25;

const NAMESPACE_RE =
    /useTranslations\(\s*['"]([^'"]+)['"]\s*\)|getTranslations\(\s*['"]([^'"]+)['"]\s*\)/g;
const CALL_RE = /\bt\(\s*'([A-Za-z0-9_.]+)'\s*(?=[),])/g;

/**
 * `const t = useTranslations('admin')` — the identifier AND its namespace.
 *
 * `await` is allowed because the server-component form is
 * `const t = await getTranslations('admin')`.
 */
const BINDING_RE =
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Calls on ONE translator identifier, with literal keys. */
function callsOn(src: string, ident: string): readonly string[] {
    // The lookbehind matters: with `ident` of `t`, a bare /\bt\(/ also matches
    // the `t(` inside `tAgents(`... no — but `\b` DOES match at the `t` of a
    // member call like `obj.t(`, and in this codebase `tAgents` and `tAdmin`
    // live beside `t`, so the boundary has to exclude a preceding word char,
    // dot or `$` to keep the three apart.
    //
    // The `(?=[),])` is load-bearing. `t('statusOption.' + row.original.status)`
    // is a CONCATENATED key, and matching the literal alone reads the prefix
    // `statusOption.` as a whole key that resolves nowhere — three such calls in
    // `VendorsClient.tsx` were reported on the first widened run. Requiring the
    // closing quote to be followed by `)` or `,` keeps a literal key that carries
    // interpolation values (`t('a.b', { n })`) while excluding a built one.
    // Dynamic keys stay out of scope and are the rendered tests' job, as the
    // header says.
    const re = new RegExp(`(?<![\\w.$])${ident}\\(\\s*'([A-Za-z0-9_.]+)'\\s*(?=[),])`, 'g');
    return [...src.matchAll(re)].map((m) => m[1]);
}

/**
 * Every fully-qualified key a source text calls, or null when the file cannot
 * be bound.
 *
 * Exported for the synthetic proofs at the bottom: a detector whose only
 * subject is the tree it polices is green the moment it stops matching.
 */
export function qualifiedKeys(src: string): readonly string[] | null {
    const stripped = stripComments(src);
    const namespaces = [...stripped.matchAll(NAMESPACE_RE)].map((m) => m[1] ?? m[2]);
    if (namespaces.length === 0) return null;

    const bindings = [...stripped.matchAll(BINDING_RE)].map((m) => ({ ident: m[1], ns: m[2] }));

    // ONE BINDING PER IDENTIFIER, or the identifier is ambiguous too.
    //
    // This condition is not belt-and-braces; without it the widened guard
    // reported 137 false positives on its first run. `src/app/login/page.tsx`
    // binds `t` TWICE — to `login` in one component and to `common` in another,
    // 330 lines apart — and a regex has no scopes, so every `t('x')` in the file
    // was attributed to BOTH namespaces and roughly half could not resolve. A
    // rebound identifier is exactly as unreadable as an unbound namespace, so it
    // is skipped the same way rather than guessed at.
    const byIdent = new Map<string, Set<string>>();
    for (const b of bindings) {
        const seen = byIdent.get(b.ident) ?? new Set<string>();
        seen.add(b.ns);
        byIdent.set(b.ident, seen);
    }
    const reboundIdent = [...byIdent.values()].some((namespacesForIdent) => namespacesForIdent.size > 1);
    const duplicateBinding = byIdent.size !== bindings.length;

    // Every namespace call accounted for by a simple binding, and no identifier
    // bound twice: resolve per identifier, which is what makes a two-namespace
    // file readable.
    if (bindings.length === namespaces.length && !reboundIdent && !duplicateBinding) {
        const out: string[] = [];
        for (const b of bindings) {
            for (const key of callsOn(stripped, b.ident)) out.push(`${b.ns}.${key}`);
        }
        return out;
    }

    // Unbound namespace calls. One namespace is still unambiguous; more is not.
    if (new Set(namespaces).size !== 1) return null;
    return [...stripped.matchAll(CALL_RE)].map((m) => `${namespaces[0]}.${m[1]}`);
}

function stripComments(src: string): string {
    return codeOf(src);
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

function scan(): {
    unresolved: Unresolved[];
    filesChecked: number;
    keysChecked: number;
    unbound: string[];
} {
    const unresolved: Unresolved[] = [];
    const unbound: string[] = [];
    let filesChecked = 0;
    let keysChecked = 0;

    for (const file of walk(SRC)) {
        const raw = fs.readFileSync(file, 'utf8');
        if (!/useTranslations\(|getTranslations\(/.test(stripComments(raw))) continue;
        const keys = qualifiedKeys(raw);
        if (keys === null) {
            // Still skipped, but COUNTED — an uncovered file is a fact held
            // rather than a silence.
            unbound.push(path.relative(ROOT, file));
            continue;
        }
        filesChecked++;
        for (const full of keys) {
            keysChecked++;
            if (!resolves(full)) {
                unresolved.push({ file: path.relative(ROOT, file), key: full });
            }
        }
    }
    return { unresolved, filesChecked, keysChecked, unbound };
}

describe('i18n — every literal t() key resolves in en.json', () => {
    const { unresolved, filesChecked, keysChecked, unbound } = scan();

    it('the scan actually reached the code it claims to cover', () => {
        // Positive companion. A scan that silently matched nothing would report
        // zero unresolved keys and look identical to a clean tree — the exact
        // ambiguity that let the missing keys through in the first place.
        expect(filesChecked).toBeGreaterThan(250);
        expect(keysChecked).toBeGreaterThan(4000);
    });

    it('resolves a key that is known to exist, and rejects one that is not', () => {
        // Proves the resolver itself works, so a green run means "checked and
        // found nothing" rather than "the resolver returns true for anything".
        expect(resolves('admin.agentDetail.tabOverview')).toBe(true);
        expect(resolves('admin.agentDetail.__definitely_not_a_key__')).toBe(false);
    });

    it('binds EACH translator identifier to its own namespace', () => {
        // The exact shape that shipped broken: two namespaces, and a key called
        // through the `admin` translator while living under `agents`.
        const two = [
            "const t = useTranslations('admin');",
            "const tAgents = useTranslations('agents');",
            "const a = t('agentDetail.tabTools');",
            "const b = tAgents('register.breadcrumb');",
        ].join('\n');
        const keys = qualifiedKeys(two);
        expect(keys).not.toBeNull();
        // Each call qualified by ITS OWN translator, not by the file.
        expect([...(keys ?? [])].sort()).toEqual([
            'admin.agentDetail.tabTools',
            'agents.register.breadcrumb',
        ]);
    });

    it('keeps `t` and `tAgents` apart, which is what the lookbehind is for', () => {
        // Without the lookbehind, scanning for `t(` also matches the `t(` inside
        // `tAgents(`, and every `agents` key would be reported under `admin`.
        const src2 = [
            "const t = useTranslations('admin');",
            "const tAgents = useTranslations('agents');",
            "const b = tAgents('register.breadcrumb');",
        ].join('\n');
        const keys = qualifiedKeys(src2) ?? [];
        expect(keys).toEqual(['agents.register.breadcrumb']);
        expect(keys).not.toContain('admin.register.breadcrumb');
    });

    it('the single-namespace path still works when the call is not a const binding', () => {
        // An inline `useTranslations('x')` with no binding: one namespace, so
        // still unambiguous, and the old path handles it.
        const inline = [
            "export function C() { return <p>{useTranslations('common')('appName')}</p>; }",
            "const t = useTranslations('common');",
            "const a = t('appName');",
        ].join('\n');
        const keys = qualifiedKeys(inline) ?? [];
        expect(keys).toContain('common.appName');
    });

    it('ignores a CONCATENATED key rather than reading its prefix as one', () => {
        // `VendorsClient.tsx` line 568, in miniature. Reading the literal alone
        // yields `vendors.statusOption.`, which resolves nowhere and is not a key
        // anybody wrote.
        const concat = [
            "const t = useTranslations('vendors');",
            "const tCommon = useTranslations('common');",
            "const a = t('statusOption.' + row.original.status);",
            "const b = t('statusOption.ACTIVE');",
            "const c = t('withValues', { n: 3 });",
            "const d = tCommon('appName');",
        ].join('\n');
        const keys = [...(qualifiedKeys(concat) ?? [])].sort();
        // The built key is skipped; the literal one and the one with
        // interpolation VALUES are both kept.
        expect(keys).toEqual([
            'common.appName',
            'vendors.statusOption.ACTIVE',
            'vendors.withValues',
        ]);
    });

    it('returns null when ONE identifier is bound to two namespaces', () => {
        // `src/app/login/page.tsx` in miniature, and the source of 137 false
        // positives on this guard's first widened run. A regex has no scopes, so
        // `t` here is as unreadable as no binding at all.
        const rebound = [
            "function A() { const t = useTranslations('login'); return t('title'); }",
            "function B() { const t = useTranslations('common'); return t('appName'); }",
        ].join('\n');
        expect(qualifiedKeys(rebound)).toBeNull();
    });

    it('returns null — skipped, not guessed — for an unbindable multi-namespace file', () => {
        // Two DIFFERENT namespaces and a count mismatch, so nothing can be
        // attributed. Reporting a guess here is what would produce false reds.
        const unbindable = [
            "const t = useTranslations('admin');",
            "export const other = () => useTranslations('agents')('x.y');",
            "const a = t('agentDetail.tabTools');",
        ].join('\n');
        expect(qualifiedKeys(unbindable)).toBeNull();
    });

    it('would have caught the key that shipped under the wrong namespace', () => {
        // The regression itself, as a unit: the call goes through `admin`, so the
        // key must resolve under `admin` — and `agents.agentDetail.tabSkills`
        // does not satisfy it however many locales carry it.
        const broken = [
            "const t = useTranslations('admin');",
            "const tAgents = useTranslations('agents');",
            "const label = t('agentDetail.tabSkills');",
        ].join('\n');
        const keys = qualifiedKeys(broken) ?? [];
        expect(keys).toEqual(['admin.agentDetail.tabSkills']);
        // And that key now resolves, because the fix moved it there.
        expect(resolves('admin.agentDetail.tabSkills')).toBe(true);
        // The place it used to live is gone, so the orphan cannot be reintroduced
        // silently by a parity tool copying it back.
        expect(resolves('agents.agentDetail.tabSkills')).toBe(false);
    });

    it('counts the files it still cannot bind, so the residue cannot grow silently', () => {
        // These are files whose namespace call is not a simple const binding.
        // The number only goes DOWN; raising it means a new unbindable shape was
        // introduced and nobody looked.
        expect(unbound.length).toBeLessThanOrEqual(UNBOUND_CEILING);
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
