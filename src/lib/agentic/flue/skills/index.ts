/**
 * THE COMPLIANCE CORPUS AS FLUE SKILLS (#3470, plan point 06).
 *
 * ── WHY `defineSkill` AND NOT A `SKILL.md` IMPORT ───────────────────────────
 *
 * Flue documents the import as the primary path — `import s from './x/SKILL.md'`
 * — and says it works "everywhere your project builds: the dev server,
 * `vite build`, and `flue run`". Every one of those is Flue's own Vite
 * pipeline. This application builds with Next.js and webpack, where that
 * specifier has no loader behind it, and the guide forbids a dynamic import as
 * an escape hatch ("a build error"). So the markdown is read here and handed to
 * `defineSkill`, which the guide describes as equivalent: "the runtime packages
 * it into the same shape a `SKILL.md` import produces, writing spec-valid
 * frontmatter itself".
 *
 * The files stay markdown on disk because the plan wants the list to BE an
 * audit artifact — "what did the agent know" is a question an assessor asks,
 * and a directory of readable documents answers it better than a TypeScript
 * array of template literals.
 *
 * ── LICENCE POSTURE ─────────────────────────────────────────────────────────
 *
 * Every skill here is ORIGINAL guidance that cites public instruments by
 * identifier — Annex A control ids, NIS2 article numbers, DORA articles, AI Act
 * articles and annexes. None reproduces standard text. That is deliberate and
 * is the owner's decision of 2026-10-13: it keeps #3478 (an ISO fixture with no
 * recorded provenance) off this path entirely, and it means no third-party
 * licence obligation travels into prompt assembly, which is where an
 * attribution requirement would be hardest to honour.
 *
 * ── THE TWO BUDGETS, WHICH ARE NOT THE SAME BUDGET ──────────────────────────
 *
 * Skills are progressively disclosed: "each mounted skill costs one
 * always-present catalog line (name + description) in the system prompt, and
 * nothing more until the model decides the task at hand matches."
 *
 * So the plan's "cap total skill payload per run" bounds the wrong thing on its
 * own — it bounds the rare case (everything activated) and leaves the cost paid
 * on EVERY turn unbounded. Both are capped: `MAX_CATALOG_BYTES` over the
 * always-present cost, and `MAX_SKILL_BYTES` per skill over the activated one.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Per-skill instruction budget. Paid only when the model activates the skill. */
export const MAX_SKILL_BYTES = 8_192;
/**
 * Budget for the ALWAYS-PRESENT catalog — every mounted skill's name plus
 * description, in every system prompt, on every turn. The binding one.
 */
export const MAX_CATALOG_BYTES = 2_048;
/** The Agent Skills specification's own ceiling on a description. */
export const MAX_DESCRIPTION_CHARS = 1_024;

export interface LoadedSkill {
    /** Lowercase-hyphen, ≤64 chars, and equal to the directory name (spec). */
    readonly name: string;
    /** The routing decision the model sees on every turn. */
    readonly description: string;
    /** The procedure, loaded only on activation. */
    readonly instructions: string;
    /** Spec frontmatter field — informational, but ours to keep honest. */
    readonly license: string;
    /** Uninterpreted by Flue; carries provenance the plan asked a registry for. */
    readonly metadata: Readonly<Record<string, string>>;
}

export class SkillLoadError extends Error {
    constructor(public readonly skillName: string, reason: string) {
        super(`Skill "${skillName}": ${reason}`);
        this.name = 'SkillLoadError';
    }
}

const SKILLS_DIR = path.join(process.cwd(), 'src/lib/agentic/flue/skills');
/** Spec: lowercase letters, digits and hyphens; no leading/trailing/double hyphen. */
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Split `---\n…\n---\n<body>`. Deliberately not a YAML library: the frontmatter
 * here is a flat string map plus one nested `metadata`, and a parser that
 * accepted anchors, aliases and arbitrary types would accept skills the Agent
 * Skills spec does not.
 */
function parseFrontmatter(raw: string, name: string): { fm: Record<string, string | Record<string, string>>; body: string } {
    if (!raw.startsWith('---\n')) throw new SkillLoadError(name, 'missing frontmatter');
    const end = raw.indexOf('\n---\n', 4);
    if (end === -1) throw new SkillLoadError(name, 'unterminated frontmatter');
    const fm: Record<string, string | Record<string, string>> = {};
    let current: string | null = null;
    for (const line of raw.slice(4, end).split('\n')) {
        if (!line.trim()) continue;
        const nested = /^ {2}([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
        if (nested && current) {
            (fm[current] as Record<string, string>)[nested[1]] = nested[2].replace(/^'(.*)'$/, '$1');
            continue;
        }
        const top = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
        if (!top) throw new SkillLoadError(name, `unparseable frontmatter line: ${line.slice(0, 40)}`);
        if (top[2] === '') {
            current = top[1];
            fm[current] = {};
        } else {
            current = null;
            fm[top[1]] = top[2].replace(/^'(.*)'$/, '$1');
        }
    }
    return { fm, body: raw.slice(end + 5).trim() };
}

/** Read and validate one skill directory. */
export function loadSkill(name: string): LoadedSkill {
    let raw: string;
    try {
        raw = fs.readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf-8');
    } catch (err) {
        throw new SkillLoadError(name, `could not read SKILL.md: ${err instanceof Error ? err.message : String(err)}`);
    }
    return parseSkillDocument(name, raw);
}

/**
 * Validate one skill document. PURE — separated from the read so every refusal
 * below can be asserted by a named test.
 *
 * It was not separate at first, and the mutation run said so: breaking a skill's
 * frontmatter reddened the suite as `0 total` rather than as a failing
 * assertion, because `loadAllSkills()` runs at describe scope and a throw there
 * takes the file down with a stack trace. The loader refusing is correct; a
 * detection nobody can read is not.
 */
export function parseSkillDocument(name: string, raw: string): LoadedSkill {
    const { fm, body } = parseFrontmatter(raw, name);
    const str = (k: string): string => (typeof fm[k] === 'string' ? (fm[k] as string) : '');

    // The spec requires the name to MATCH THE DIRECTORY. Checked rather than
    // taken from the directory, so a copied skill that kept its old name is a
    // load error instead of a silently renamed skill.
    if (str('name') !== name) throw new SkillLoadError(name, `frontmatter name "${str('name')}" does not match its directory`);
    if (!NAME_RE.test(name) || name.length > 64) throw new SkillLoadError(name, 'name is not a valid Agent Skills identifier');
    const description = str('description');
    if (!description) throw new SkillLoadError(name, 'description is required — it carries the entire routing decision');
    if (description.length > MAX_DESCRIPTION_CHARS) throw new SkillLoadError(name, `description exceeds ${MAX_DESCRIPTION_CHARS} chars`);
    if (!body) throw new SkillLoadError(name, 'instructions are empty');
    if (Buffer.byteLength(body, 'utf8') > MAX_SKILL_BYTES) throw new SkillLoadError(name, `instructions exceed ${MAX_SKILL_BYTES} bytes`);
    if (!str('license')) throw new SkillLoadError(name, 'license is required — a skill with no stated licence cannot be audited');

    return {
        name,
        description,
        instructions: body,
        license: str('license'),
        metadata: Object.freeze({ ...((fm.metadata as Record<string, string>) ?? {}) }),
    };
}

/** Every skill in the corpus, in directory order. */
export function loadAllSkills(): LoadedSkill[] {
    const names = fs
        .readdirSync(SKILLS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    const loaded = names.map(loadSkill);

    // "Each skill name mounts once per render; mounting the same name twice
    // throws." Directory names are unique on a filesystem, so this can only
    // fire if the set is ever assembled from somewhere else — which is exactly
    // when it would be missed.
    const seen = new Set<string>();
    for (const s of loaded) {
        if (seen.has(s.name)) throw new SkillLoadError(s.name, 'duplicate skill name');
        seen.add(s.name);
    }
    assertCatalogWithinBudget(loaded);
    return loaded;
}

/** The always-present cost: what every mounted skill adds to every prompt. */
export function catalogBytes(skills: readonly LoadedSkill[]): number {
    return skills.reduce((n, s) => n + Buffer.byteLength(`${s.name}: ${s.description}\n`, 'utf8'), 0);
}

export function assertCatalogWithinBudget(skills: readonly LoadedSkill[]): void {
    const bytes = catalogBytes(skills);
    if (bytes > MAX_CATALOG_BYTES) {
        throw new SkillLoadError(
            '<catalog>',
            `the always-present catalog is ${bytes} bytes, over the ${MAX_CATALOG_BYTES} budget — `
                + 'this cost is paid on every turn of every run, so shorten a description or mount fewer skills',
        );
    }
}
