/**
 * OPERATOR-FACING COPY NAMES THE FEATURE, NEVER THE TRANSPORT.
 *
 * AGENTIC UI 3/4, item 8, opens with the principle the rest of the item is an
 * instance of: "NAME THINGS FOR WHAT THEY DO. `MCP` is a transport acronym;
 * operators are governing agents." The item's other two demands — the bare
 * noun `Agent` on the create button, `Search agents…` with one U+2026 — both
 * shipped and are pinned by `action-button-canonical-entity-label.test.ts` and
 * `search-placeholder-vocabulary.test.ts`. The sentence they were instances of
 * reached one surface (`use-palette-commands.ts`, which labels its three
 * agentic entries by DESTINATION and says why in a comment) and stopped.
 * Twelve catalogue values still led with the acronym when this guard was
 * written, five of them the first word on a surface: the admin landing pill,
 * the `/admin/mcp` breadcrumb and page title, and the `<ForbiddenPage title>`
 * on `/agents/proposals` and `/agents/runs` — neither of which is gated on
 * anything MCP-shaped (both check `ctx.appPermissions.admin.view`).
 *
 * ── WHY NOTHING ELSE COULD SEE IT ───────────────────────────────────────────
 *
 * The three i18n checks are each structurally blind to the WORDS:
 *
 *   · `i18n-completeness` compares `en.json` against `bg.json`. Both files
 *     agreed perfectly about the acronym, so there was no drift to report.
 *   · `i18n-adoption-ratchet` scans source for hardcoded text and is satisfied
 *     the moment a string sits behind `t()`. `#2442` moved the admin pill's
 *     label from a bare literal `"MCP"` to a `t()` key — and set that key to
 *     `"MCP credentials"`. The ratchet counted that as a fix.
 *   · `i18n-keys-resolve` / `agents-copy-keys-resolve` check that call sites
 *     resolve to a defined key. A key resolving to the wrong WORD resolves.
 *
 * So this is the only check in the suite that reads a catalogue VALUE and has
 * an opinion about it.
 *
 * ── TWO CASES, AND THE SECOND IS THE REGRESSION LOCK ────────────────────────
 *
 * CASE 1 (catalogue) is the one that was red when this file landed: no
 * `messages/*.json` leaf value may contain the token `MCP`. Both locales, one
 * pass, so a fix applied to `en.json` alone is still red on `bg.json` — the
 * shape that would otherwise leave a Bulgarian operator reading the acronym
 * nobody in English does any more.
 *
 * CASE 2 (source) is green from birth and exists because nothing prevented the
 * ORIGINAL defect returning. `admin/page.tsx:79-85` records the pill's label
 * being promoted from a bare literal by hand in `#2442`; a new
 * `label: 'MCP'` landing beside it tomorrow would be invisible to every check
 * above, because a bare literal has no key to resolve and the adoption ratchet
 * is a ratchet — it caps the population, it does not forbid a member.
 *
 * ── WHAT IS DELIBERATELY NOT IN SCOPE ───────────────────────────────────────
 *
 * `MCP` is the correct word for the PROTOCOL, and this guard never looks where
 * the protocol is what is being named: the `/admin/mcp` route and its
 * `/api/mcp` counterpart, `src/lib/mcp/`, the `admin.mcp.*` catalogue
 * NAMESPACE (a key, not a value — and one `admin/mcp/page.tsx:38-41` says
 * prompt 2/4 retires into `/admin/api-keys`), element ids like
 * `mcp-pill-btn` / `mcp-agent-credentials` that e2e specs and
 * `p3-integrations-hub.test.ts` pin, and every source COMMENT — which is why
 * CASE 2 reads through `codeOf`. Those are engineer-facing, or an identifier
 * something else depends on. The rule is about what an OPERATOR reads.
 *
 * ── NO ALLOWLIST, ON PURPOSE ────────────────────────────────────────────────
 *
 * Both offender sets must be EMPTY. There is no exemption array, so there is
 * nothing to go stale and nothing to quietly grow. If a surface one day has to
 * name the protocol to an operator — a developer-settings page printing the
 * MCP endpoint URL is the plausible one — that is a decision worth making in
 * the open: add the exemption here, beside this paragraph, with the reason.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf } from '../helpers/source-blocks';
import { repoFiles, repoRelative } from '../helpers/repo-files';

const ROOT = path.resolve(__dirname, '../..');

/** The transport acronym, as a whole token, in either case. */
const MCP_TOKEN = /\bMCP\b/i;

/** Every locale catalogue, so a fix in `en` alone cannot go green. */
const LOCALES = ['en', 'bg'] as const;

/** The subtree an operator navigates. */
const APP_TREE = 'src/app/t';

type Bag = Record<string, unknown>;

interface Leaf {
    /** `admin.nav.mcp` — the dotted path, for the failure message. */
    readonly path: string;
    readonly value: string;
}

/**
 * Flatten a catalogue to its STRING leaves.
 *
 * Object keys are walked but never tested, which is the whole distinction
 * this guard rests on: `admin.mcp` is a namespace an engineer types and
 * `admin.mcp.title` is a sentence an operator reads. Renaming the first is
 * churn on a namespace already scheduled for retirement; renaming the second
 * is the job.
 */
function leavesOf(bag: Bag, prefix: string, out: Leaf[]): Leaf[] {
    for (const [key, value] of Object.entries(bag)) {
        const dotted = prefix === '' ? key : `${prefix}.${key}`;
        if (typeof value === 'string') out.push({ path: dotted, value });
        else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            leavesOf(value as Bag, dotted, out);
        }
    }
    return out;
}

function catalogue(locale: string): Leaf[] {
    const raw = fs.readFileSync(path.join(ROOT, 'messages', `${locale}.json`), 'utf8');
    return leavesOf(JSON.parse(raw) as Bag, '', []);
}

/**
 * A JSX attribute (or object-literal property) whose NAME ends in one of the
 * four operator-visible roles, assigned a plain string literal.
 *
 * `[:=]` rather than `=` because the shape that actually shipped was an
 * object-literal property in the admin page's `pills` array — `label: 'MCP'`,
 * not `label="MCP"`. A guard written only for the JSX spelling would have
 * missed the exact line `#2442` fixed by hand.
 *
 * Suffix-matched and case-insensitive on the NAME, so `searchPlaceholder`,
 * `emptyTitle` and `aria-label` are all in without listing them one by one.
 * The value must be a quote-delimited literal: `title={t('mcp.title')}` opens
 * a brace, not a quote, so a `t()` call is never an offender here — the key it
 * names is CASE 1's business.
 */
const ATTR_LITERAL =
    /([A-Za-z-]*(?:title|label|description|placeholder))\s*[:=]\s*(['"`])([^'"`]*)\2/gi;

interface AttrSite {
    readonly file: string;
    readonly line: number;
    readonly name: string;
    readonly value: string;
}

/** Every operator-visible attribute literal in the app tree, MCP or not. */
function attributeSites(): AttrSite[] {
    const sites: AttrSite[] = [];
    for (const abs of repoFiles({ under: APP_TREE, extensions: ['.tsx'] })) {
        // COMMENTS BLANKED, string literals kept. Half the files in this
        // subtree carry a docblock explaining what MCP is and why the route
        // keeps its name; a guard that read those would be permanently red on
        // prose it has no opinion about.
        const code = codeOf(fs.readFileSync(abs, 'utf8'));
        const rel = repoRelative(abs);
        const lines = code.split('\n');
        lines.forEach((line, i) => {
            for (const m of line.matchAll(ATTR_LITERAL)) {
                sites.push({ file: rel, line: i + 1, name: m[1], value: m[3] });
            }
        });
    }
    return sites;
}

const CATALOGUES = LOCALES.map((locale) => ({ locale, leaves: catalogue(locale) }));
const ATTR_SITES = attributeSites();
const TSX_FILE_COUNT = repoFiles({ under: APP_TREE, extensions: ['.tsx'] }).length;

describe('the scan has a population at all', () => {
    // An empty selection is a PASS, so each denominator is asserted before any
    // "zero offenders" claim below is allowed to mean anything.

    it.each(CATALOGUES.map((c) => [c.locale, c.leaves.length] as const))(
        'messages/%s.json flattens to a real catalogue (%d string leaves)',
        (_locale, count) => {
            expect(count).toBeGreaterThan(5000);
        },
    );

    it('both locales flatten to the SAME number of leaves', () => {
        // `i18n-completeness` owns keyset parity; this is the cheap restatement
        // that says CASE 1 is comparing like with like — a truncated read of
        // one file would otherwise let its half of the check pass vacuously.
        const counts = CATALOGUES.map((c) => c.leaves.length);
        expect(new Set(counts).size).toBe(1);
    });

    it('the app tree exists and the attribute pattern matches real attributes', () => {
        expect(TSX_FILE_COUNT).toBeGreaterThan(100);
        // The POSITIVE CONTROL for CASE 2's regex. Without it, a pattern that
        // matched nothing at all would report zero offenders forever.
        expect(ATTR_SITES.length).toBeGreaterThan(50);
        const names = new Set(ATTR_SITES.map((s) => s.name.toLowerCase()));
        expect(names.has('title')).toBe(true);
        expect(names.has('label')).toBe(true);
    });
});

describe('CASE 1 — no catalogue value carries the transport acronym', () => {
    it.each(CATALOGUES.map((c) => [c.locale] as const))(
        'messages/%s.json',
        (locale) => {
            const leaves = CATALOGUES.find((c) => c.locale === locale)!.leaves;
            const offenders = leaves.filter((l) => MCP_TOKEN.test(l.value));
            if (offenders.length > 0) {
                throw new Error(
                    `${offenders.length} value(s) in messages/${locale}.json name the ` +
                        `transport instead of the feature. "MCP" is a protocol an ` +
                        `operator never speaks; say what the surface DOES.\n\n` +
                        offenders
                            .map((o) => `  ${o.path} — ${JSON.stringify(o.value)}`)
                            .join('\n') +
                        `\n\nThe key may keep its name (a namespace is engineer-facing); ` +
                        `the VALUE may not. Both locales move together.`,
                );
            }
            expect(offenders).toHaveLength(0);
        },
    );
});

describe('CASE 2 — no bare literal reintroduces it on an operator surface', () => {
    it('no title / label / description / placeholder literal in src/app/t says MCP', () => {
        const offenders = ATTR_SITES.filter((s) => MCP_TOKEN.test(s.value));
        if (offenders.length > 0) {
            throw new Error(
                `${offenders.length} operator-visible literal(s) name the transport:\n\n` +
                    offenders
                        .map((o) => `  ${o.file}:${o.line}  ${o.name} = ${JSON.stringify(o.value)}`)
                        .join('\n') +
                    `\n\nThis is the shape #2442 removed by hand from the admin pill. ` +
                    `Route paths, element ids and comments are out of scope — only ` +
                    `what the operator reads.`,
            );
        }
        expect(offenders).toHaveLength(0);
    });
});

describe('the two surfaces this was sharpest on now name themselves', () => {
    // The `<ForbiddenPage title>` on /agents/proposals and /agents/runs reached
    // for a shared top-level `agents.mcpAccessRequired` while five sibling
    // surfaces each carried their own `accessTitle` beside the `accessMessage`
    // they already had. Pinned so a later tidy-up cannot re-centralise them
    // onto one key named after the protocol.
    const AGENTS = JSON.parse(
        fs.readFileSync(path.join(ROOT, 'messages/en.json'), 'utf8'),
    ).agents as Bag;

    it('the shared acronym key is gone from the catalogue', () => {
        expect(AGENTS.mcpAccessRequired).toBeUndefined();
        expect(AGENTS.crumbMcp).toBeUndefined();
    });

    it.each([['proposals'], ['runs']])(
        'agents.%s carries its own accessTitle beside its accessMessage',
        (surface) => {
            const bag = AGENTS[surface] as Bag;
            expect(typeof bag.accessTitle).toBe('string');
            expect(typeof bag.accessMessage).toBe('string');
        },
    );

    it.each([
        ['proposals', "t('proposals.accessTitle')"],
        ['runs', "t('runs.accessTitle')"],
    ])('the /agents/%s page asks for it', (surface, call) => {
        const code = codeOf(
            fs.readFileSync(
                path.join(ROOT, `src/app/t/[tenantSlug]/(app)/agents/${surface}/page.tsx`),
                'utf8',
            ),
        );
        // The subject is the boolean, not the file text: this file must not
        // join the `raw-source-assertion-ratchet` population, whose baseline is
        // a zero-headroom set equality shared with every open PR.
        expect(code.includes(call)).toBe(true);
    });
});
