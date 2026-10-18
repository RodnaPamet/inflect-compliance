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
 *
 * ── THE CATALOGUE BUDGET IS PER RUN, NOT PER CORPUS (owner decision, 2026-10-17)
 *
 * The always-present cost is paid for the skills a run MOUNTS, and a run mounts
 * exactly what its workflow declares. So the cap binds where it is paid: on
 * every run's mounted set (`resolveSkillsFor`) and on every workflow
 * definition's declared set (`assertWorkflowCatalogsWithinBudget`). It used to
 * bind the whole corpus as well, which capped the corpus at about seven skills
 * whatever any run mounted — a limit on what the product can know, charged as
 * if every skill were in every prompt. The corpus may now exceed the budget;
 * no workflow may.
 *
 * ── OPTIONAL METADATA THE STANDARD DEFINES ──────────────────────────────────
 *
 * `docs/agent-skill-standard.md` adds four optional `metadata` keys. Absent,
 * they change nothing; present, they are validated here, because a malformed
 * declaration that loaded anyway would be a claim nobody checked:
 *
 *   requiredInput  comma-separated input names the skill cannot work without
 *   output         `proposal` or `report` — what the procedure ends in
 *   controls       comma-separated control identifiers, cited by id only
 *   evaluation     the evaluation set's file name inside the skill directory
 *   tools          comma-separated tool names the skill expects a run to hold
 *
 * ── THE TEXT SCAN, AND WHY A REFUSAL DOES NOT TAKE THE CORPUS DOWN ──────────
 *
 * Every document that passes the structural checks is then scanned
 * (`text-scan.ts`, #3667). A skill that fails is REFUSED: `loadSkillCorpus`
 * returns it beside the loaded skills, by name and rule ids, and it is never
 * mounted. Structural errors still throw, because a malformed document is a
 * defect in the corpus that CI must see. A refused one is held apart instead,
 * so one suspect skill stops the runs that declare it rather than every run,
 * and the Skills tab can show what was refused rather than failing to load.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { scanSkillText, type SkillTextRuleId } from './text-scan';

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

/**
 * A skill the load-time text scan refused. The message names rule ids and
 * nothing else: the text is what is under suspicion, so it is never repeated.
 */
export class SkillTextRefusedError extends SkillLoadError {
    constructor(
        skillName: string,
        public readonly rules: readonly SkillTextRuleId[],
        public readonly guardRules: readonly string[],
    ) {
        super(skillName, `refused by the skill text scan (${[...rules, ...guardRules].join(', ')})`);
        this.name = 'SkillTextRefusedError';
    }
}

/** A refused skill, as every surface reports it: by name and rule ids, never by text. */
export interface RefusedSkill {
    readonly name: string;
    readonly rules: readonly SkillTextRuleId[];
    readonly guardRules: readonly string[];
}

const SKILLS_DIR = path.join(process.cwd(), 'src/lib/agentic/flue/skills');

/** A skill's own directory, where its SKILL.md and evaluation set live. */
export function skillDirectory(name: string): string {
    if (!NAME_RE.test(name)) throw new SkillLoadError(name, 'name is not a valid Agent Skills identifier');
    return path.join(SKILLS_DIR, name);
}
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
    return loadSkillFrom(SKILLS_DIR, name);
}

function loadSkillFrom(dir: string, name: string): LoadedSkill {
    let raw: string;
    try {
        raw = fs.readFileSync(path.join(dir, name, 'SKILL.md'), 'utf-8');
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
    const metadata = fm.metadata;
    if (metadata !== undefined && typeof metadata !== 'object') {
        throw new SkillLoadError(name, 'metadata must be a map');
    }
    return validateSkillFields(name, {
        description: str('description'),
        instructions: body,
        license: str('license'),
        metadata: (metadata as Record<string, string> | undefined) ?? {},
    });
}

/** The fields of one skill, wherever its text is kept. */
export interface SkillFields {
    readonly description: string;
    readonly instructions: string;
    readonly license: string;
    readonly metadata: Readonly<Record<string, string>>;
}

/**
 * The loader's rules on one skill's fields, then the text scan — the SAME rules
 * whether the skill is a document in the repository or a version a tenant
 * authored (#3680). A structural failure throws `SkillLoadError`; text the scan
 * refuses throws `SkillTextRefusedError`, which names rule ids only.
 */
export function validateSkillFields(name: string, f: SkillFields): LoadedSkill {
    if (!NAME_RE.test(name) || name.length > 64) throw new SkillLoadError(name, 'name is not a valid Agent Skills identifier');
    const { description, instructions } = f;
    if (!description) throw new SkillLoadError(name, 'description is required — it carries the entire routing decision');
    if (description.length > MAX_DESCRIPTION_CHARS) throw new SkillLoadError(name, `description exceeds ${MAX_DESCRIPTION_CHARS} chars`);
    if (!instructions) throw new SkillLoadError(name, 'instructions are empty');
    if (Buffer.byteLength(instructions, 'utf8') > MAX_SKILL_BYTES) throw new SkillLoadError(name, `instructions exceed ${MAX_SKILL_BYTES} bytes`);
    if (!f.license) throw new SkillLoadError(name, 'license is required — a skill with no stated licence cannot be audited');
    validateStandardMetadata(name, f.metadata);

    // Last, so a refusal is only ever about text that was otherwise a valid skill.
    const scan = scanSkillText({
        description,
        instructions,
        declaredTools: f.metadata.tools === undefined ? [] : listOf(f.metadata.tools),
    });
    if (scan.rules.length > 0) throw new SkillTextRefusedError(name, scan.rules, scan.guardRules);

    return {
        name,
        description,
        instructions,
        license: f.license,
        metadata: Object.freeze({ ...f.metadata }),
    };
}

/** Is this an Agent Skills identifier the loader would accept? */
export function isSkillName(name: string): boolean {
    return NAME_RE.test(name) && name.length <= 64;
}

const INPUT_NAME_RE = /^[a-z][A-Za-z0-9]{0,63}$/;
/** A control id as frameworks print it: `A.5.18`, `CC6.3`, `ASI03`, `Art.23(4)`. */
const CONTROL_ID_RE = /^[A-Za-z][A-Za-z0-9.()-]{0,39}$/;
const EVALUATION_FILE_RE = /^[a-z0-9][a-z0-9-]{0,63}\.json$/;
/** A tool name as the MCP catalogue spells one: `list_controls`, `propose_risks`. */
const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SKILL_OUTPUTS = ['proposal', 'report'] as const;

function listOf(value: string): string[] {
    return value.split(',').map((v) => v.trim());
}

/** The four optional keys `docs/agent-skill-standard.md` defines, checked when present. */
function validateStandardMetadata(name: string, m: Readonly<Record<string, string>>): void {
    if (m.requiredInput !== undefined && !listOf(m.requiredInput).every((v) => INPUT_NAME_RE.test(v))) {
        throw new SkillLoadError(name, 'metadata.requiredInput must be comma-separated camelCase input names');
    }
    if (m.output !== undefined && !(SKILL_OUTPUTS as readonly string[]).includes(m.output)) {
        throw new SkillLoadError(name, `metadata.output must be one of ${SKILL_OUTPUTS.join(', ')}`);
    }
    if (m.controls !== undefined && !listOf(m.controls).every((v) => CONTROL_ID_RE.test(v))) {
        throw new SkillLoadError(name, 'metadata.controls must be comma-separated control identifiers, never standard text');
    }
    if (m.evaluation !== undefined && !EVALUATION_FILE_RE.test(m.evaluation)) {
        throw new SkillLoadError(name, 'metadata.evaluation must be a .json file name inside the skill directory');
    }
    if (m.tools !== undefined && !listOf(m.tools).every((v) => TOOL_NAME_RE.test(v))) {
        throw new SkillLoadError(name, 'metadata.tools must be comma-separated tool names');
    }
}

export interface SkillCorpus {
    /** The skills a run may mount, in directory order. */
    readonly skills: LoadedSkill[];
    /** The skills the text scan refused, in directory order. Never mounted. */
    readonly refused: RefusedSkill[];
}

/**
 * The corpus, with every refused skill held apart. A structural error in any
 * document still throws.
 *
 * `dir` is a test seam; production reads the shipped corpus.
 */
export function loadSkillCorpus(dir: string = SKILLS_DIR): SkillCorpus {
    const names = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    const loaded: LoadedSkill[] = [];
    const refused: RefusedSkill[] = [];
    for (const name of names) {
        try {
            loaded.push(loadSkillFrom(dir, name));
        } catch (err) {
            if (!(err instanceof SkillTextRefusedError)) throw err;
            refused.push({ name, rules: err.rules, guardRules: err.guardRules });
        }
    }

    // "Each skill name mounts once per render; mounting the same name twice
    // throws." Directory names are unique on a filesystem, so this can only
    // fire if the set is ever assembled from somewhere else — which is exactly
    // when it would be missed.
    const seen = new Set<string>();
    for (const s of loaded) {
        if (seen.has(s.name)) throw new SkillLoadError(s.name, 'duplicate skill name');
        seen.add(s.name);
    }
    // No catalogue check here: the budget binds what a run mounts and what a
    // workflow declares, not the corpus. See the header.
    return { skills: loaded, refused };
}

/** Every skill a run may mount, in directory order. Refused skills are not among them. */
export function loadAllSkills(): LoadedSkill[] {
    return loadSkillCorpus().skills;
}

/** The always-present cost: what every mounted skill adds to every prompt. */
export function catalogBytes(skills: readonly Pick<LoadedSkill, 'name' | 'description'>[]): number {
    return skills.reduce((n, s) => n + Buffer.byteLength(`${s.name}: ${s.description}\n`, 'utf8'), 0);
}

export function assertCatalogWithinBudget(skills: readonly Pick<LoadedSkill, 'name' | 'description'>[]): void {
    const bytes = catalogBytes(skills);
    if (bytes > MAX_CATALOG_BYTES) {
        throw new SkillLoadError(
            '<catalog>',
            `the always-present catalog is ${bytes} bytes, over the ${MAX_CATALOG_BYTES} budget — `
                + 'this cost is paid on every turn of every run, so shorten a description or mount fewer skills',
        );
    }
}
