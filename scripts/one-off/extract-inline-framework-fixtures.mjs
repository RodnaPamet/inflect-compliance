/**
 * Move five frameworks' control templates out of `prisma/seed.ts` and into
 * fixture files.
 *
 * WHY. DORA (24), ISO 9001 (22), NIS2 (20), ISO 39001 (17) and ISO 28000 (15)
 * were declared as inline TypeScript arrays. 98 templates that no
 * fixture-reading tool can see: a content PR cannot author into them, and the
 * `control-task-actionability` ratchet can neither hold them to its bar nor
 * honestly allowlist them, because it has no record they exist.
 *
 * PARSED, NOT TRANSCRIBED. 98 entries copied by hand is 98 chances to drop a
 * requirement code, and the failure would be silent — a template that seeds
 * fine and links to nothing. This reads the array text out of the source and
 * round-trips it, so the fixture is derived from the thing it replaces.
 *
 * Run once: `node scripts/one-off/extract-inline-framework-fixtures.mjs`
 */
import fs from 'node:fs';

const SEED = 'prisma/seed.ts';

/** const name -> { file, category } */
const FRAMEWORKS = {
    nis2Templates: { file: 'nis2-control-templates.json', category: 'NIS2' },
    doraTemplates: { file: 'dora-control-templates.json', category: 'DORA' },
    iso9001Templates: { file: 'iso9001-control-templates.json', category: 'ISO9001' },
    iso28000Templates: { file: 'iso28000-control-templates.json', category: 'ISO28000' },
    iso39001Templates: { file: 'iso39001-control-templates.json', category: 'ISO39001' },
};

const src = fs.readFileSync(SEED, 'utf8');

/** The array literal for `const <name> = [ ... ];`, brace-balanced. */
function arrayTextFor(name) {
    const start = src.indexOf(`const ${name} = [`);
    if (start === -1) throw new Error(`no array for ${name}`);
    const open = src.indexOf('[', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '[') depth++;
        else if (src[i] === ']') {
            depth--;
            if (depth === 0) return src.slice(open, i + 1);
        }
    }
    throw new Error(`unbalanced array for ${name}`);
}

/** One `{ code, title, reqs }` entry per line. Deliberately strict: an entry
 *  this cannot parse throws rather than being silently dropped. */
function parseEntries(text, name) {
    const entries = [];
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        const code = /code:\s*'([^']+)'/.exec(t);
        const title = /title:\s*'((?:[^'\\]|\\.)*)'/.exec(t);
        const reqs = /reqs:\s*\[([^\]]*)\]/.exec(t);
        if (!code || !title) throw new Error(`unparseable entry in ${name}: ${t}`);
        entries.push({
            code: code[1],
            title: title[1].replace(/\\'/g, "'"),
            requirements: reqs
                ? [...reqs[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
                : [],
        });
    }
    return entries;
}

let total = 0;
for (const [name, { file, category }] of Object.entries(FRAMEWORKS)) {
    const entries = parseEntries(arrayTextFor(name), name);
    const templates = entries.map((e) => ({
        code: e.code,
        title: e.title,
        // Applied uniformly by the loop being replaced; carried per-template
        // here so the fixture is self-describing like every other one.
        category,
        defaultFrequency: 'QUARTERLY',
        requirements: e.requirements,
    }));
    fs.writeFileSync(`prisma/fixtures/${file}`, JSON.stringify(templates, null, 2) + '\n');
    console.log(`${file.padEnd(36)} ${String(templates.length).padStart(3)} templates`);
    total += templates.length;
}
console.log(`total ${total}`);
