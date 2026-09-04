/**
 * An authored control task must be something a practitioner can DO.
 *
 * The bar, applied to every task that carries authored `steps`:
 *   • the title starts with an imperative verb
 *   • 3-8 steps, none shorter than 25 characters
 *   • an OPERATE task names the proof artifact (`evidenceHint`)
 *   • a template with authored content carries >= 3 tasks over >= 3 phases
 *
 * ═══ WHY THE ALLOWLIST IS KEYED BY CODE PREFIX, NOT FRAMEWORK ═══
 *
 * The obvious key is the framework, and it does not work. 151 internal
 * controls (`ICN-`) and 10 legacy templates belong to NO framework, so they
 * have no key to be allowlisted under — and they are the largest and the
 * worst-off populations respectively. A framework-keyed list would silently
 * omit them, and "the allowlist is empty" would certify nothing about the
 * 161 templates it could not name.
 *
 * ═══ WHY THIS PASSES TODAY WITHOUT ASSERTING ANYTHING ═══
 *
 * No template has authored steps yet — this PR is plumbing, the content comes
 * in the PRs after it. So the rules below currently apply to an empty set.
 * That is stated rather than hidden: the `it` that counts the population is
 * what will start failing the moment content lands unchecked, and the
 * allowlist shrinks as each content PR removes its prefix.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../helpers/repo-files';

const FIXTURE_DIR = path.join(REPO_ROOT, 'prisma/fixtures');

/**
 * Template-code prefixes whose tasks are not yet held to the bar.
 *
 * SHRINK THIS. Each content PR removes its own prefix in the same diff that
 * authors the content; when it is empty, every shipped template is actionable.
 */
const LEGACY_GENERIC_ALLOWLIST: Record<string, string> = {
    'TSC-': 'SOC 2 (29). Carries bespoke tasks already, not yet in the steps format.',
    'SDLC-': 'NIST SSDF starter (19). Carries bespoke tasks already, not yet in the steps format.',
    'CIS-': 'CIS v8 IG1 (15). Its existing tasks are formulaic ("Implement IG1 safeguards for Control {n}").',
    'ASVS-': 'OWASP ASVS L1 (13). Same formulaic shape as CIS.',
    'PIMS-': 'ISO 27701 (10).',
    'DORA-': 'DORA (24). Fixture extracted from seed.ts, no authored tasks yet.',
    'QMS-': 'ISO 9001 (22). Fixture extracted from seed.ts, no authored tasks yet.',
    'NIS2-': 'NIS2 (20). Fixture extracted from seed.ts, no authored tasks yet.',
    'RTS-': 'ISO 39001 (17). Fixture extracted from seed.ts, no authored tasks yet.',
    'SCS-': 'ISO 28000 (15). Fixture extracted from seed.ts, no authored tasks yet.',
    'AC-': 'Legacy starter templates. Belong to no framework and carry ZERO tasks — the worst current state of any population.',
    'IR-': 'Legacy starter templates.',
    'RA-': 'Legacy starter templates.',
    'CM-': 'Legacy starter templates.',
    'SC-': 'Legacy starter templates.',
    'BC-': 'Legacy starter templates.',
    'SA-': 'Legacy starter templates.',
    'AU-': 'Legacy starter templates.',
    'VN-': 'Legacy starter templates.',
};

/**
 * There are none left, and that is what the fixture-extraction PR was for.
 *
 * This slot held DORA (24), ISO 9001 (22), NIS2 (20), ISO 39001 (17) and ISO
 * 28000 (15) — 98 templates declared as inline TypeScript arrays in
 * `prisma/seed.ts`, which this scan had no way to see. They could be neither
 * held to the bar nor honestly allowlisted, so "the allowlist is empty" would
 * have certified nothing about them. They now have fixture files and appear in
 * `LEGACY_GENERIC_ALLOWLIST` above like every other population.
 *
 * Kept as an empty record rather than deleted, because the assertion below is
 * the thing that stops a future framework being added inline again.
 */
export const UNSCANNABLE_INLINE_POPULATIONS: Record<string, number> = {};

/**
 * Curated for this repo's subject matter. Extend deliberately.
 *
 * It grew from 61 to 125 when the first authored content landed: the original
 * list was written before any existed, so it was a guess at the vocabulary and
 * it missed 'List', 'Compare', 'Reconcile' and 'Score' — four of the commonest
 * openers a real task set uses. The failure direction is what makes growing it
 * safe: an absent verb is a LOUD false positive that someone fixes here, while
 * the noun-phrase titles this exists to reject ('Cryptography management')
 * still cannot get in. Boilerplate is a separate check — the frozen phrase
 * list in control-task-conformance.test.ts — so admitting 'Check' and 'Update'
 * as verbs does not admit 'Check compliance' or 'Update documentation'.
 */
const IMPERATIVE_VERBS = new Set([
    'Account', 'Add', 'Agree', 'Align', 'Allocate', 'Analyse', 'Annotate', 'Apply', 'Approve',
    'Assemble', 'Assess', 'Assign', 'Audit', 'Authorise', 'Baseline', 'Build', 'Capture',
    'Catalogue', 'Check', 'Cite', 'Classify', 'Close', 'Collect', 'Compare', 'Compile',
    'Complete', 'Configure', 'Confirm', 'Consolidate', 'Correlate', 'Cross-check',
    'Cross-reference', 'Define', 'Deliver', 'Deploy', 'Design', 'Destroy', 'Detect',
    'Determine', 'Diagram', 'Disable', 'Document', 'Enable', 'Enforce', 'Enrol', 'Establish',
    'Evaluate', 'Examine', 'Exercise', 'Export', 'Express', 'Extend', 'Extract', 'File', 'Flag',
    'Generate', 'Group', 'Identify', 'Implement', 'Inspect', 'Inventory', 'Issue', 'Label',
    'Limit', 'List', 'Log', 'Maintain', 'Map', 'Mark', 'Match', 'Measure', 'Minute', 'Monitor',
    'Move', 'Name', 'Notify', 'Onboard', 'Photograph', 'Populate', 'Produce', 'Publish',
    'Raise', 'Rate', 'Re-verify', 'Reassess', 'Reconcile', 'Record', 'Register', 'Remove',
    'Report', 'Restore', 'Restrict', 'Retest', 'Retire', 'Review', 'Revoke', 'Rotate', 'Run',
    'Sample', 'Sanitise', 'Scan', 'Schedule', 'Scope', 'Score', 'Search', 'Seed', 'Segment',
    'Select', 'Send', 'Separate', 'Set', 'Spot-check', 'Store', 'Summarise', 'Test', 'Trace',
    'Track', 'Train', 'Triage', 'Turn', 'Update', 'Validate', 'Verify', 'Walk', 'Write',
]);

/**
 * Controls whose own material spans fewer than three phases.
 *
 * The >= 3 rule holds for 150 of 151 authored controls, so it keeps its
 * signal and this stays a named exception rather than a weakened rule.
 *
 * ICN-048's subject IS the review activity — its objective, successCriteria
 * and testingMethodology describe running and reviewing an ISMS that already
 * exists, and carry nothing to scope or implement. Adding a SCOPE task to
 * satisfy this check would mean inventing an obligation the control does not
 * state, which `docs/control-task-authoring.md` rejects by name. The rule
 * asserted that every control spans most of a lifecycle; a control that IS a
 * lifecycle stage refutes that, and the content is right.
 */
const PHASE_SPREAD_EXCEPTIONS: Record<string, string> = {
    'ICN-048': 'ISMS Review and Monitoring — OPERATE + REVIEW only; metadata carries no scope or implementation content.',
};

const MIN_STEP_CHARS = 25;

interface AuthoredTaskLike {
    title?: unknown;
    phase?: unknown;
    steps?: unknown[];
    evidenceHint?: unknown;
}

interface TemplateLike {
    code?: string;
    tasks?: AuthoredTaskLike[];
    /** Which fixture it came from. Scopes the reuse check below. */
    file?: string;
}

function allTemplates(): TemplateLike[] {
    if (!fs.existsSync(FIXTURE_DIR)) return [];
    // EVERY fixture json, not `*control-templates.json`. The first draft of
    // this scan used that glob and silently missed `internal-controls.json` —
    // 151 templates, the largest population there is. A scan whose denominator
    // is its own naming convention reports full coverage of the subset it
    // happens to match.
    return fs
        .readdirSync(FIXTURE_DIR)
        .filter((f) => f.endsWith('.json'))
        .flatMap((f) => {
            let raw: unknown;
            try {
                raw = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8'));
            } catch {
                return [];
            }
            // Three shapes ship today: a bare array, `{ templates: [...] }`,
            // and `{ _meta, controls: [...] }` — the last is
            // internal-controls.json, the biggest file, and reading only the
            // first two is how 151 templates stayed invisible to the first
            // two drafts of this scan.
            const obj = raw as { templates?: unknown[]; controls?: unknown[] };
            const list = (Array.isArray(raw)
                ? raw
                : (obj.templates ?? obj.controls ?? [])) as TemplateLike[];
            return list
                .filter((t) => typeof t?.code === 'string')
                .map((t) => ({ ...t, file: f }));
        });
}

function isAllowlisted(code: string): boolean {
    return Object.keys(LEGACY_GENERIC_ALLOWLIST).some((prefix) => code.startsWith(prefix));
}

/** Templates held to the bar: authored steps, and not allowlisted. */
function heldToTheBar(): TemplateLike[] {
    return allTemplates().filter(
        (t) => !isAllowlisted(t.code ?? '') && (t.tasks ?? []).some((k) => Array.isArray(k.steps)),
    );
}

function titleOf(task: AuthoredTaskLike): string {
    const t = task.title;
    if (typeof t === 'string') return t;
    if (t && typeof t === 'object' && typeof (t as { en?: unknown }).en === 'string') {
        return (t as { en: string }).en;
    }
    return '';
}

describe('authored control tasks are actionable', () => {
    const held = heldToTheBar();

    it('titles start with an imperative verb', () => {
        const bad = held.flatMap((t) =>
            (t.tasks ?? [])
                .filter((k) => Array.isArray(k.steps))
                .filter((k) => !IMPERATIVE_VERBS.has(titleOf(k).split(/\s+/)[0] ?? ''))
                .map((k) => `${t.code}: ${titleOf(k)}`),
        );
        expect(bad).toEqual([]);
    });

    it('every task has 3-8 steps, none shorter than 25 characters', () => {
        const bad: string[] = [];
        for (const t of held) {
            for (const k of t.tasks ?? []) {
                if (!Array.isArray(k.steps)) continue;
                if (k.steps.length < 3 || k.steps.length > 8) {
                    bad.push(`${t.code}: ${titleOf(k)} has ${k.steps.length} steps`);
                }
                for (const step of k.steps) {
                    const text =
                        typeof step === 'string'
                            ? step
                            : ((step as { text?: { en?: string } })?.text?.en ?? '');
                    if (text.length < MIN_STEP_CHARS) {
                        bad.push(`${t.code}: step too short — "${text}"`);
                    }
                }
            }
        }
        expect(bad).toEqual([]);
    });

    it('an OPERATE task names the proof artifact', () => {
        const bad = held.flatMap((t) =>
            (t.tasks ?? [])
                .filter((k) => Array.isArray(k.steps) && k.phase === 'OPERATE' && !k.evidenceHint)
                .map((k) => `${t.code}: ${titleOf(k)}`),
        );
        expect(bad).toEqual([]);
    });

    it('no task title is reused across controls', () => {
        // The reject list's first entry is "if the title would fit under any
        // control in the catalogue, it belongs under none of them", and reuse
        // is what that failure looks like from outside: the fastest way to
        // author hundreds of task sets badly is to paste one set and swap a
        // noun. A duplicate title is not proof of boilerplate, but boilerplate
        // at volume cannot avoid producing duplicates.
        //
        // Scoped PER FIXTURE FILE, not globally. Two frameworks may each
        // legitimately need "Inventory every system and application using
        // cryptography"; one framework needing it twice is the defect.
        const byFile = new Map<string, Map<string, string[]>>();
        for (const t of held) {
            const titles = byFile.get(t.file ?? '') ?? new Map<string, string[]>();
            for (const k of t.tasks ?? []) {
                const title = titleOf(k);
                if (!title) continue;
                titles.set(title, [...(titles.get(title) ?? []), t.code ?? '(no code)']);
            }
            byFile.set(t.file ?? '', titles);
        }
        const reused = [...byFile].flatMap(([file, titles]) =>
            [...titles]
                .filter(([, codes]) => new Set(codes).size > 1)
                .map(([title, codes]) => `${file}: "${title}" — ${[...new Set(codes)].join(', ')}`),
        );
        expect(reused).toEqual([]);
    });

    it('a template with authored content carries >= 3 tasks over >= 3 phases', () => {
        const bad = held
            .filter((t) => !PHASE_SPREAD_EXCEPTIONS[t.code ?? ''])
            .filter((t) => {
                const tasks = t.tasks ?? [];
                const phases = new Set(tasks.map((k) => k.phase).filter(Boolean));
                return tasks.length < 3 || phases.size < 3;
            })
            .map((t) => t.code ?? '(no code)');
        expect(bad).toEqual([]);
    });
});

describe('the allowlist is honest', () => {
    it('every prefix still matches at least one shipped template (no stale entries)', () => {
        const codes = allTemplates().map((t) => t.code ?? '');
        const stale = Object.keys(LEGACY_GENERIC_ALLOWLIST).filter(
            (prefix) => !codes.some((c) => c.startsWith(prefix)),
        );
        // No carve-out. The first draft of this list carried six prefixes
        // taken from the roadmap's framework NAMES — 'A-', 'AIMS-', 'EUAIA-',
        // 'PRIV-', 'AISVS-', 'SSDF-' — none of which match any code that
        // ships. An allowlist of phantoms is worse than none: it makes
        // "empty" reachable by deleting entries that never guarded anything.
        expect(stale).toEqual([]);
    });

    it('sees the population it claims to guard', () => {
        // 345 across twelve fixture files, after the five inline frameworks and
        // the legacy starter set were extracted. Was 237 across six.
        expect(allTemplates().length).toBeGreaterThanOrEqual(340);
    });

    it('the phase-spread exceptions are real and are not growing', () => {
        // Same discipline as the prefix allowlist: an entry naming a control
        // that no longer ships, or that now spans three phases, is a carve-out
        // for a problem that is gone.
        const codes = new Set(allTemplates().map((t) => t.code ?? ''));
        expect(Object.keys(PHASE_SPREAD_EXCEPTIONS).filter((c) => !codes.has(c))).toEqual([]);
        expect(Object.keys(PHASE_SPREAD_EXCEPTIONS)).toHaveLength(1);
    });

    it('records how much is still exempt, so progress is visible', () => {
        // A downward ratchet. Each content PR deletes its prefix here in the
        // same diff that authors the content; at zero, every shipped template
        // is held to the bar and this whole allowlist is deleted.
        expect(Object.keys(LEGACY_GENERIC_ALLOWLIST)).toHaveLength(19);
    });

    it('no framework is seeded from an inline array any more', () => {
        // The reason the five extractions happened. A framework declared
        // inline in seed.ts is invisible to every fixture-reading tool: a
        // content PR cannot author into it and this ratchet cannot see it, so
        // it would sit outside the bar without ever appearing to.
        expect(UNSCANNABLE_INLINE_POPULATIONS).toEqual({});
    });
});
