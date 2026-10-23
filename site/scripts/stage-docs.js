'use strict';
/**
 * Stage the published docs into Starlight's content collection.
 *
 * The public site at https://rodnapamet.github.io/inflect-compliance/ is built
 * from `docs/`, but not from all of it. `site/published-docs.json` is an
 * ALLOWLIST: a doc reaches the site only when somebody lists it there, so a
 * new doc is unpublished until a person decides otherwise. That is the
 * fail-closed direction, and the reason the manifest is not a denylist.
 *
 * Two policies ride on top of the allowlist and are enforced HERE, in the step
 * that actually writes what gets published, rather than only in a test:
 *
 *   - NEVER_PUBLISH: docs the owner excluded by name (2026-10-23) — the
 *     deployment and production-VM material and the DPA template. Listing one
 *     in the manifest stops the build.
 *   - FORBIDDEN_CONTENT: coordinates of the production estate. A published doc
 *     carrying one stops the build, whatever the manifest says.
 *
 * WHAT EXCLUSION DOES NOT MEAN. The repository is public, so every file in
 * `docs/` is already readable on github.com. Excluding a doc keeps it off the
 * site, out of the site's search and out of its navigation; it does not make it
 * confidential. A secret never belongs in `docs/` at all, and the repo's secret
 * scanner (`.secret-patterns`) is what holds that.
 *
 * Links are rewritten so the site has no dead ends:
 *   - to a published doc      → its page on the site;
 *   - to an unpublished doc   → the label as plain text, so the site does not
 *                               route readers to a page the owner kept off it;
 *   - to any other repo file  → that file on github.com (code is public);
 *   - to nothing that exists  → plain text, reported as a warning.
 *
 * CommonJS `.js` with no dependencies on purpose: CI runs it with bare `node`,
 * and the Jest suite requires it to test the pure functions below directly.
 * Not `.cjs` — the repo's ESLint config cannot lint that extension — and so
 * site/package.json declares no `"type": "module"`; Astro's own config is
 * `.mjs` and does not need it.
 */
const fs = require('node:fs');
const path = require('node:path');

const REPO = 'RodnaPamet/inflect-compliance';
const GITHUB = `https://github.com/${REPO}`;
const RAW = `https://raw.githubusercontent.com/${REPO}/main/`;
/** The project site's base path: rodnapamet.github.io/<repo>/. */
const SITE_BASE = '/inflect-compliance';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SITE_DIR = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(SITE_DIR, 'published-docs.json');
const CONTENT_DIR = path.join(SITE_DIR, 'src', 'content', 'docs');
const LANDING_PAGE = 'site/pages/index.md';

/**
 * Owner decision, 2026-10-23: kept off the public site. An entry ending in `/`
 * covers everything under that directory.
 */
const NEVER_PUBLISH = Object.freeze({
    'docs/deployment.md': 'the production VM deployment guide',
    'docs/staging.md': 'the staging deployment guide',
    'docs/disaster-recovery.md': 'the restore procedure for the production VM',
    'docs/incident-response.md': 'the on-call runbook against the production VM',
    'docs/observability/01-deployment-topology.md': 'the observability stack as deployed on the production VM',
    'docs/observability/04-production-hardening.md': 'production hardening of the VM-hosted observability stack',
    'docs/runbooks/': 'operator procedures against the production estate',
    'docs/data-processing-agreement-template.md': 'the contract template',
});

/**
 * Coordinates of the production estate. Each is already in the public repo
 * somewhere, which is exactly why the site must not become a second, indexed,
 * searchable copy of them.
 */
const FORBIDDEN_CONTENT = Object.freeze([
    { id: 'gcp-project-id', re: /hazel-design-\d+/, why: 'the production GCP project id' },
    { id: 'vm-host-path', re: /\/opt\/inflect\b/, why: 'the Compose root on the production VM' },
    { id: 'vm-access-command', re: /gcloud\s+compute\s+(?:ssh|scp|instances)\b/, why: 'a command that reaches the production VM' },
    { id: 'gce-zone-flag', re: /--zone[=\s]+[a-z]+-[a-z]+\d+-[a-z]\b/, why: "the production VM's zone" },
    { id: 'staff-address', re: /[A-Za-z0-9._%+-]+@inflect\.bg\b/i, why: "a person's email address" },
    { id: 'prod-env-file', re: /\.env\.prod\b/, why: 'the production secrets file' },
]);

/**
 * Real HTML elements the docs write on purpose. Any other tag-shaped token in
 * prose — `<DataTable>`, `<slug>` — is a component name or a placeholder:
 * GitHub's sanitiser strips it and a browser would swallow it, so it is
 * escaped to show as written.
 */
const HTML_TAGS = new Set([
    'a', 'abbr', 'b', 'br', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark',
    'ol', 'p', 'picture', 'pre', 's', 'samp', 'small', 'source', 'span', 'strong',
    'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul',
]);

// ── Pure helpers (unit-tested) ──────────────────────────────────────────────

/** `docs/adr/0001-x.md` → `adr/0001-x`; `CONTRIBUTING.md` → `contributing`. */
function slugFor(repoPath) {
    return repoPath.replace(/^docs\//, '').replace(/\.md$/i, '').toLowerCase();
}

/** Every doc in the manifest, in order. */
function manifestDocs(manifest) {
    return manifest.sections.flatMap((s) => s.docs);
}

/** Starlight sidebar groups, in manifest order. */
function sidebarFrom(manifest) {
    return manifest.sections.map((s) => ({
        label: s.label,
        collapsed: true,
        items: s.docs.map((d) => ({ slug: slugFor(d) })),
    }));
}

function neverPublishReason(repoPath) {
    for (const [key, why] of Object.entries(NEVER_PUBLISH)) {
        if (key.endsWith('/') ? repoPath.startsWith(key) : repoPath === key) return why;
    }
    return null;
}

/** Every forbidden coordinate in `text`, with its 1-based line. */
function forbiddenContentIn(text) {
    const hits = [];
    text.split('\n').forEach((line, i) => {
        for (const rule of FORBIDDEN_CONTENT) {
            if (rule.re.test(line)) hits.push({ id: rule.id, why: rule.why, line: i + 1 });
        }
    });
    return hits;
}

/**
 * Refusals for a manifest, given each listed doc's text (`readDoc` returns
 * `null` when the file does not exist). Empty means publishable.
 */
function publicationRefusals(manifest, readDoc) {
    const refusals = [];
    const seen = new Set();
    if (!Array.isArray(manifest.sections) || manifest.sections.length === 0) {
        return ['the manifest lists no sections — an empty site is not a published site'];
    }
    for (const doc of manifestDocs(manifest)) {
        if (seen.has(doc)) refusals.push(`${doc}: listed twice`);
        seen.add(doc);
        const never = neverPublishReason(doc);
        if (never) refusals.push(`${doc}: never published (${never})`);
        const text = readDoc(doc);
        if (text === null) {
            refusals.push(`${doc}: does not exist`);
            continue;
        }
        for (const hit of forbiddenContentIn(text)) {
            refusals.push(`${doc}:${hit.line}: carries ${hit.why} (${hit.id})`);
        }
        if (!/^# .+$/m.test(text)) refusals.push(`${doc}: has no "# " title`);
    }
    const slugs = new Map();
    for (const doc of seen) {
        const s = slugFor(doc);
        if (slugs.has(s)) refusals.push(`${doc}: same page address as ${slugs.get(s)}`);
        slugs.set(s, doc);
    }
    return refusals;
}

/** The first `# ` heading becomes the page title; the body loses it. */
function splitTitle(markdown) {
    const lines = markdown.split('\n');
    const i = lines.findIndex((l) => /^# .+/.test(l));
    if (i === -1) return null;
    const title = lines[i]
        .slice(2)
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/`/g, '')
        .trim();
    const rest = lines.slice(0, i).concat(lines.slice(i + 1));
    while (rest.length && rest[0].trim() === '') rest.shift();
    return { title, body: rest.join('\n') };
}

/**
 * Where a link should go on the site. `ctx.published` maps repo path → slug;
 * `ctx.kindOf(repoPath)` answers 'file' | 'dir' | null.
 */
function resolveLink(href, fromPath, ctx, isImage) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#')) {
        return { kind: 'keep' };
    }
    const hashAt = href.indexOf('#');
    const rawPath = hashAt === -1 ? href : href.slice(0, hashAt);
    const frag = hashAt === -1 ? '' : href.slice(hashAt);
    let p;
    try {
        p = decodeURI(rawPath);
    } catch {
        p = rawPath;
    }
    const target = (
        p.startsWith('/')
            ? path.posix.normalize(p.slice(1))
            : path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), p))
    ).replace(/\/$/, '');
    if (target === '.' || target.startsWith('..')) return { kind: 'text', missing: href };
    if (ctx.published.has(target)) {
        return { kind: 'site', href: `${SITE_BASE}/${ctx.published.get(target)}/${frag}` };
    }
    const kind = ctx.kindOf(target);
    if (kind === null) return { kind: 'text', missing: target };
    if (target.startsWith('docs/') && /\.md$/i.test(target)) return { kind: 'text' };
    if (kind === 'dir') return { kind: 'github', href: `${GITHUB}/tree/main/${target}` };
    return { kind: 'github', href: isImage ? `${RAW}${target}` : `${GITHUB}/blob/main/${target}${frag}` };
}

/** Mask the code spans in a chunk of prose, so rewrites never touch code. */
function maskCodeSpans(line) {
    const spans = [];
    let out = '';
    let i = 0;
    while (i < line.length) {
        if (line[i] !== '`') {
            out += line[i++];
            continue;
        }
        let n = 0;
        while (line[i + n] === '`') n++;
        const fence = '`'.repeat(n);
        let j = i + n;
        let close = -1;
        while ((j = line.indexOf(fence, j)) !== -1) {
            if (line[j + n] !== '`' && line[j - 1] !== '`') {
                close = j;
                break;
            }
            j += n;
        }
        if (close === -1) {
            out += fence;
            i += n;
            continue;
        }
        spans.push(line.slice(i, close + n));
        out += `\u0000${spans.length - 1}\u0000`;
        i = close + n;
    }
    return { masked: out, unmask: (s) => s.replace(/\u0000(\d+)\u0000/g, (_, k) => spans[Number(k)]) };
}

const LINK_RE = /(!?)\[([^\]\n]*)\]\(([^)\s]+)((?:\s+"[^"\n]*")?)\)/g;
const TAG_RE = /<(\/?)([A-Za-z][\w.-]*)(?=[\s>/])/g;

/** Rewrite links and tag-shaped placeholders in prose, never inside code. */
function rewriteProse(chunk, fromPath, ctx, missing) {
    const { masked, unmask } = maskCodeSpans(chunk);
    const rewritten = masked
        .replace(LINK_RE, (whole, bang, label, href, title) => {
            const r = resolveLink(href, fromPath, ctx, bang === '!');
            if (r.missing) missing.push(r.missing);
            if (r.kind === 'keep') return whole;
            if (r.kind === 'text') return label;
            return `${bang}[${label}](${r.href}${title})`;
        })
        .replace(TAG_RE, (whole, slash, name) =>
            /^[A-Z]/.test(name) || !HTML_TAGS.has(name.toLowerCase()) ? `&lt;${slash}${name}` : whole,
        );
    return unmask(rewritten);
}

/**
 * Rewrite one doc's markdown for the site. Fenced code is copied verbatim.
 * Prose is rewritten a PARAGRAPH at a time, not a line at a time, because an
 * inline code span may wrap across a line break — masking line by line once
 * escaped the `<old>` inside such a span and the page showed `&lt;old>`.
 */
function transformMarkdown(markdown, fromPath, ctx) {
    const missing = [];
    const out = [];
    let prose = [];
    let fence = null;
    const flush = () => {
        if (prose.length) out.push(rewriteProse(prose.join('\n'), fromPath, ctx, missing));
        prose = [];
    };
    for (const line of markdown.split('\n')) {
        const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
        if (fence) {
            out.push(line);
            if (open && open[1][0] === fence[0] && open[1].length >= fence.length && line.trim() === open[1]) fence = null;
            continue;
        }
        if (open) {
            flush();
            fence = open[1];
            out.push(line);
            continue;
        }
        if (line.trim() === '') {
            flush();
            out.push(line);
            continue;
        }
        prose.push(line);
    }
    flush();
    return { text: out.join('\n'), missing };
}

/** The staged page: frontmatter, then the rewritten body. */
function stagePage(markdown, fromPath, ctx, extraFrontmatter = {}) {
    const split = splitTitle(markdown);
    if (!split) throw new Error(`${fromPath}: no "# " title`);
    const { text, missing } = transformMarkdown(split.body, fromPath, ctx);
    const fm = { title: split.title, ...extraFrontmatter };
    const yaml = Object.entries(fm)
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`)
        .join('\n');
    return { page: `---\n${yaml}\n---\n\n${text}`, missing };
}

// ── Main ────────────────────────────────────────────────────────────────────

function kindOnDisk(repoPath) {
    try {
        const st = fs.statSync(path.join(REPO_ROOT, repoPath));
        return st.isDirectory() ? 'dir' : 'file';
    } catch {
        return null;
    }
}

function readRepoFile(repoPath) {
    try {
        return fs.readFileSync(path.join(REPO_ROOT, repoPath), 'utf8');
    } catch {
        return null;
    }
}

function main() {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const refusals = publicationRefusals(manifest, readRepoFile);
    if (refusals.length) {
        process.stderr.write(`docs site: refusing to publish\n  ${refusals.join('\n  ')}\n`);
        process.exit(1);
    }
    const docs = manifestDocs(manifest);
    const ctx = { published: new Map(docs.map((d) => [d, slugFor(d)])), kindOf: kindOnDisk };

    fs.rmSync(CONTENT_DIR, { recursive: true, force: true });
    fs.mkdirSync(CONTENT_DIR, { recursive: true });
    const warnings = [];
    const write = (slug, page) => {
        const dest = path.join(CONTENT_DIR, `${slug}.md`);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, page);
    };
    for (const doc of docs) {
        const { page, missing } = stagePage(readRepoFile(doc), doc, ctx, {
            editUrl: `${GITHUB}/edit/main/${doc}`,
        });
        for (const m of missing) warnings.push(`${doc}: link to a missing target (${m})`);
        write(slugFor(doc), page);
    }
    // The landing page lives in site/ and links to docs by their repo paths,
    // so it goes through the same rewrite and fails the same way if it points
    // at a page that is not published.
    const landing = readRepoFile(LANDING_PAGE);
    const { text, missing } = transformMarkdown(landing, LANDING_PAGE, ctx);
    if (missing.length || /\]\((?!https?:|\/inflect-compliance\/|#)/.test(text)) {
        process.stderr.write(`docs site: ${LANDING_PAGE} links to something that is not a published page\n`);
        process.exit(1);
    }
    fs.writeFileSync(path.join(CONTENT_DIR, 'index.md'), text);

    process.stdout.write(`docs site: staged ${docs.length} docs + landing page into ${path.relative(REPO_ROOT, CONTENT_DIR)}\n`);
    if (warnings.length) process.stdout.write(`docs site: ${warnings.length} warning(s)\n  ${warnings.join('\n  ')}\n`);
}

module.exports = {
    FORBIDDEN_CONTENT,
    NEVER_PUBLISH,
    SITE_BASE,
    forbiddenContentIn,
    manifestDocs,
    neverPublishReason,
    publicationRefusals,
    resolveLink,
    sidebarFrom,
    slugFor,
    splitTitle,
    stagePage,
    transformMarkdown,
};

if (require.main === module) main();
