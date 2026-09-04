/**
 * The mechanical half of `docs/control-task-authoring.md`.
 *
 * ~1,400 tasks will be authored against that spec. At that volume human review
 * becomes a rubber stamp, so everything in the spec's REJECT list that a
 * machine can decide is decided here — leaving reviewers' attention for the
 * things only a human can judge.
 *
 * WHAT THIS CANNOT DO, stated so nobody mistakes a green run for a good
 * catalogue: it cannot tell whether a task is GROUNDED in its control's
 * metadata, whether the evidence it names actually exists, or whether a
 * plausible-sounding obligation was invented. A fabricated deadline sails
 * through every assertion below. That is what the human review is for, and it
 * is the reason this file exists — to stop that review being spent on things a
 * regex can catch.
 *
 * SCOPE. Only tasks carrying authored content are checked. A template still on
 * the generic five is the `control-task-actionability` allowlist's business,
 * not this file's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../helpers/repo-files';

const FIXTURE_DIR = path.join(REPO_ROOT, 'prisma/fixtures');

/**
 * Titles that fit under any control, and therefore under none.
 *
 * Matched as a whole normalised title, not a substring: "Review effectiveness
 * of the key register" is specific and must pass, while "Review effectiveness"
 * alone must not. The sibling `no-generic-task-strings` guard learned that
 * distinction the hard way, on an ISO clause item that merely began with one
 * of these.
 */
const BOILERPLATE_TITLES = [
    'review control',
    'review the control',
    'update documentation',
    'update the documentation',
    'assign owner',
    'assign a control owner',
    'assign control owner',
    'check compliance',
    'ensure compliance',
    'review policy',
    'review the policy',
    'implement control',
    'implement the control',
    'document procedure or policy',
    'review effectiveness',
];

/** Openers that describe a state rather than an act — nothing to finish. */
const UNFINISHABLE_OPENERS = ['ensure', 'maintain', 'be ', 'remain', 'continue', 'keep'];

const MIN_STEP_CHARS = 25;
const MIN_TASKS = 3;
const MAX_TASKS = 6;

interface Authored {
    title?: { en?: string } | string;
    description?: { en?: string } | string;
    phase?: string;
    sortOrder?: number;
    evidenceHint?: { en?: string } | string;
    suggestedRole?: string;
    steps?: unknown[];
}

interface Template {
    code?: string;
    title?: string;
    tasks?: Authored[];
}

const en = (v: unknown): string => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object' && typeof (v as { en?: unknown }).en === 'string') {
        return (v as { en: string }).en;
    }
    return '';
};

const norm = (s: string): string => s.trim().toLowerCase().replace(/[.\s]+$/, '');

function authoredTemplates(): Template[] {
    if (!fs.existsSync(FIXTURE_DIR)) return [];
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
            const obj = raw as { templates?: unknown[]; controls?: unknown[] };
            const list = (Array.isArray(raw)
                ? raw
                : (obj.templates ?? obj.controls ?? [])) as Template[];
            // "Authored" means the task carries spec-format content. A legacy
            // `{title, description}` pair is not in scope here.
            return list.filter((t) =>
                (t.tasks ?? []).some((k) => typeof k.title === 'object' || k.phase !== undefined),
            );
        });
}

const templates = authoredTemplates();
const everyTask = templates.flatMap((t) => (t.tasks ?? []).map((k) => ({ t, k })));

describe('authored control tasks conform to the spec', () => {
    it('is looking at something (an empty scan proves nothing)', () => {
        // Until the first content PR lands this is legitimately zero, and the
        // suite says so rather than reporting silent success over nothing.
        if (templates.length === 0) {
            expect(everyTask).toHaveLength(0);
            return;
        }
        expect(everyTask.length).toBeGreaterThan(0);
    });

    it('no title is boilerplate that would fit any control', () => {
        const bad = everyTask
            .filter(({ k }) => BOILERPLATE_TITLES.includes(norm(en(k.title))))
            .map(({ t, k }) => `${t.code}: "${en(k.title)}"`);
        expect(bad).toEqual([]);
    });

    it('no title merely restates the control it belongs to', () => {
        const bad = everyTask
            .filter(({ t, k }) => t.title && norm(en(k.title)) === norm(t.title))
            .map(({ t }) => `${t.code}: task title equals the control title`);
        expect(bad).toEqual([]);
    });

    it('every title is an act, not a state', () => {
        const bad = everyTask
            .filter(({ k }) => {
                const title = norm(en(k.title));
                return UNFINISHABLE_OPENERS.some((o) => title.startsWith(o));
            })
            .map(({ t, k }) => `${t.code}: "${en(k.title)}" has no observable completion state`);
        expect(bad).toEqual([]);
    });

    it('every description says more than the title', () => {
        const bad = everyTask
            .filter(({ k }) => {
                const d = norm(en(k.description));
                const ti = norm(en(k.title));
                return !d || d === ti || d.length < ti.length;
            })
            .map(({ t, k }) => `${t.code}: "${en(k.title)}" — description restates or is shorter`);
        expect(bad).toEqual([]);
    });

    it('an OPERATE task names the artifact it produces', () => {
        // The phase whose whole output is proof. A recurring task with no
        // named artifact is the one most likely to be closed without doing
        // anything.
        const bad = everyTask
            .filter(({ k }) => k.phase === 'OPERATE' && !en(k.evidenceHint).trim())
            .map(({ t, k }) => `${t.code}: OPERATE "${en(k.title)}" has no evidenceHint`);
        expect(bad).toEqual([]);
    });

    it('every control carries 3-6 tasks', () => {
        const bad = templates
            .filter((t) => (t.tasks ?? []).length < MIN_TASKS || (t.tasks ?? []).length > MAX_TASKS)
            .map((t) => `${t.code}: ${(t.tasks ?? []).length} tasks`);
        expect(bad).toEqual([]);
    });

    it('sortOrder is contiguous from 0 within each control', () => {
        const bad = templates
            .filter((t) => {
                const orders = (t.tasks ?? []).map((k) => k.sortOrder ?? -1).sort((a, b) => a - b);
                return orders.some((o, i) => o !== i);
            })
            .map((t) => `${t.code}: sortOrder not contiguous from 0`);
        expect(bad).toEqual([]);
    });

    it('steps, where present, are 3-8 and none is a fragment', () => {
        const bad: string[] = [];
        for (const { t, k } of everyTask) {
            if (!Array.isArray(k.steps)) continue;
            if (k.steps.length < 3 || k.steps.length > 8) {
                bad.push(`${t.code}: "${en(k.title)}" has ${k.steps.length} steps`);
            }
            for (const s of k.steps) {
                const text = en((s as { text?: unknown })?.text ?? s);
                if (text.length < MIN_STEP_CHARS) {
                    bad.push(`${t.code}: step under ${MIN_STEP_CHARS} chars — "${text}"`);
                }
            }
        }
        expect(bad).toEqual([]);
    });

    it('no step merely repeats its task description', () => {
        const bad = everyTask
            .filter(
                ({ k }) =>
                    Array.isArray(k.steps) &&
                    k.steps.some(
                        (s) => norm(en((s as { text?: unknown })?.text ?? s)) === norm(en(k.description)),
                    ),
            )
            .map(({ t, k }) => `${t.code}: "${en(k.title)}" has a step repeating the description`);
        expect(bad).toEqual([]);
    });
});
