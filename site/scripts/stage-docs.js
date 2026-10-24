'use strict';
/**
 * Stage the published docs into the two documentation sites.
 *
 * One GitHub Pages deployment carries two separate Starlight sites, each with
 * its own navigation and search (owner decision, 2026-10-24):
 *
 *   - the USER site, at https://rodnapamet.github.io/inflect-compliance/, for
 *     people who use the product: page guides, how-tos, runbooks. It publishes
 *     only `docs/user/`, and nothing else may publish from there.
 *   - the DEVELOPER site, at …/inflect-compliance/developers/, for people who
 *     build, run or integrate with it: the architecture and contributor docs,
 *     and the reference generated from the code.
 *
 * Each site's `manifest.json` is an ALLOWLIST: a doc reaches a site only when
 * somebody lists it there, so a new doc is unpublished until a person decides
 * otherwise. That is the fail-closed direction, and the reason a manifest is
 * not a denylist. A site may list a FOLDER only among its own `folders`
 * (`docs/user/` for users, `docs/reference/` for developers), which publishes
 * every doc under it; anywhere else a doc is published by name.
 *
 * Two policies ride on top of the allowlists and are enforced HERE, in the
 * step that actually writes what gets published, rather than only in a test:
 *
 *   - NEVER_PUBLISH: docs the owner excluded by name (2026-10-23) — the
 *     deployment and production-VM material and the DPA template. Listing one
 *     in either manifest stops the build.
 *   - FORBIDDEN_CONTENT: coordinates of the production estate. A published doc
 *     carrying one stops the build, whatever the manifest says.
 *
 * WHAT EXCLUSION DOES NOT MEAN. The repository is public, so every file in
 * `docs/` is already readable on github.com. Excluding a doc keeps it off the
 * sites, out of their search and out of their navigation; it does not make it
 * confidential. A secret never belongs in `docs/` at all, and the repo's secret
 * scanner (`.secret-patterns`) is what holds that.
 *
 * Three things in a page are generated rather than typed, and a build that
 * cannot generate them fails rather than printing something wrong:
 *   - `{{ui:<key>}}` prints the app's own label from `messages/en.json`, so a
 *     renamed button renames itself in the docs on the next build;
 *   - a guide's `route:` frontmatter names the page it documents, and must
 *     match a `page.tsx` under `src/app/` — so removing a page shows up in the
 *     pull request that removed it;
 *   - a line holding only `{{generated:<name>}}` is replaced by the fragment
 *     `scripts/docs-reference/generate.ts` wrote to `site/.generated/<name>.md`
 *     from the code — the roles table, the page inventory, each page's API
 *     calls, the refusal codes. A missing fragment refuses the page, so a
 *     reference page is never published without its generated half.
 * None is checked by the Ratchets guardrail, which runs on every pull
 * request: renaming a label in the app must never fail an unrelated code
 * change. The docs build, which is not a required check, is what reports it.
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
const MESSAGES_PATH = 'messages/en.json';
const APP_DIR = 'src/app';

/**
 * The two sites. `folders` are the folders a site's manifest may list whole;
 * `only` restricts everything a site publishes to one folder, `never` keeps a
 * folder off it. Together they make `docs/user/` the user site's alone.
 */
/**
 * @typedef {Readonly<{
 *   name: string,
 *   title: string,
 *   base: string,
 *   folders: readonly string[],
 *   only: string | null,
 *   never: string | null,
 * }>} Site
 */

/** @type {Readonly<{ users: Site, developers: Site }>} */
const SITES = Object.freeze({
    users: Object.freeze({
        name: 'users',
        title: 'Inflect Compliance Help',
        base: SITE_BASE,
        folders: Object.freeze(['docs/user/']),
        only: 'docs/user/',
        never: null,
    }),
    developers: Object.freeze({
        name: 'developers',
        title: 'Inflect Compliance for developers',
        base: `${SITE_BASE}/developers`,
        folders: Object.freeze(['docs/reference/']),
        only: null,
        never: 'docs/user/',
    }),
});

const siteDir = (site) => path.join(SITE_DIR, site.name);
const manifestPath = (site) => path.join(siteDir(site), 'manifest.json');
const contentDir = (site) => path.join(siteDir(site), 'src', 'content', 'docs');
const landingPage = (site) => `site/${site.name}/index.md`;

/**
 * Every folder a manifest may list whole, on either site. Each is classified
 * `authoritative` by path in tests/guardrails/docs-accuracy.test.ts. Adding a
 * folder publishes everything ever written in it, which is why the list is
 * short.
 */
const PUBLIC_FOLDERS = Object.freeze([...SITES.users.folders, ...SITES.developers.folders]);

/** A doc under this folder documents one page, and names it in `route:`. */
const GUIDE_FOLDER = 'docs/user/guide/';

/** The only frontmatter keys a doc may carry. Anything else is a typo. */
const FRONTMATTER_KEYS = Object.freeze(['route']);

/** Where `scripts/docs-reference/generate.ts` writes the reference fragments. */
const GENERATED_DIR = path.join(SITE_DIR, '.generated');

/** A line that is only `{{generated:<name>}}`. */
const GENERATED_LINE_RE = /^\{\{generated:([a-z0-9-]+)\}\}\s*$/;

/** `{{ui:risks.bulk.setStatus}}` — a label read from messages/en.json. */
const UI_TOKEN_RE = /\{\{ui:([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\}\}/g;
/** Anything that looks like it was meant to be a token. */
const UI_TOKEN_SHAPE_RE = /\{\{\s*ui\s*:[^}]*\}\}/g;

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

/**
 * `docs/adr/0001-x.md` → `adr/0001-x`; `CONTRIBUTING.md` → `contributing`.
 * A user doc loses `docs/user/` as well: the whole help site is user docs, so
 * the segment would say nothing in every one of its addresses.
 */
function slugFor(repoPath) {
    return repoPath.replace(/^docs\/(user\/)?/, '').replace(/\.md$/i, '').toLowerCase();
}

/** A manifest entry ending in `/` names a folder rather than a doc. */
function isFolderEntry(entry) {
    return entry.endsWith('/');
}

/**
 * Each section with its folder entries expanded. A folder entry adds every
 * `.md` under it, in path order, that the manifest does not already list by
 * name — so a section can list a few docs first to put them in the order the
 * app shows them, and let the folder pick up the rest. `listFolder(folder)`
 * returns the repo paths of the files under `folder`, at any depth.
 *
 * @param {{ sections?: { label: string, group?: string, docs?: string[] }[] }} manifest
 * @param {((folder: string) => string[]) | undefined} [listFolder]
 * @param {Site} [site]
 */
function expandSections(manifest, listFolder, site = SITES.developers) {
    const sections = Array.isArray(manifest.sections) ? manifest.sections : [];
    const named = new Set(sections.flatMap((s) => (s.docs ?? []).filter((d) => !isFolderEntry(d))));
    return sections.map((s) => ({
        ...s,
        docs: (s.docs ?? []).flatMap((entry) => {
            if (!isFolderEntry(entry)) return [entry];
            // A folder outside PUBLIC_FOLDERS expands to nothing; the policy
            // refuses it, and nothing in it is ever staged on the way there.
            if (!listFolder || !site.folders.some((f) => entry.startsWith(f))) return [];
            return listFolder(entry)
                .filter((f) => f.startsWith(entry) && /\.md$/i.test(f) && !named.has(f))
                .sort();
        }),
    }));
}

/**
 * Every doc in the manifest, in order, folder entries expanded.
 *
 * @param {{ sections?: { label: string, group?: string, docs?: string[] }[] }} manifest
 * @param {((folder: string) => string[]) | undefined} [listFolder]
 * @param {Site} [site]
 */
function manifestDocs(manifest, listFolder, site = SITES.developers) {
    return expandSections(manifest, listFolder, site).flatMap((s) => s.docs);
}

/**
 * Starlight sidebar groups, in manifest order. A section that names a
 * `group` sits inside it — "Page guides", "How-tos" — and groups appear in
 * the order their first section does. `label(text)` resolves `{{ui:…}}` in a
 * section's label, so a sidebar heading follows the app's own name for it.
 *
 * @param {{ sections?: { label: string, group?: string, docs?: string[] }[] }} manifest
 * @param {((folder: string) => string[]) | undefined} [listFolder]
 * @param {(text: string) => string} [label]
 * @param {Site} [site]
 */
function sidebarFrom(manifest, listFolder, label = (text) => text, site = SITES.developers) {
    const out = [];
    const groups = new Map();
    for (const s of expandSections(manifest, listFolder, site)) {
        const item = {
            label: label(s.label),
            collapsed: true,
            items: s.docs.map((d) => ({ slug: slugFor(d) })),
        };
        if (!s.group) {
            out.push(item);
            continue;
        }
        if (!groups.has(s.group)) {
            const group = { label: label(s.group), collapsed: false, items: [] };
            groups.set(s.group, group);
            out.push(group);
        }
        groups.get(s.group).items.push(item);
    }
    return out;
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
 * `null` when the file does not exist) and, for folder entries, the files
 * under a folder (`listFolder`). Empty means publishable.
 *
 * @param {{ sections?: { label: string, group?: string, docs?: string[] }[] }} manifest
 * @param {(repoPath: string) => string | null} readDoc
 * @param {((folder: string) => string[]) | undefined} [listFolder]
 * @param {Site} [site]
 */
function publicationRefusals(manifest, readDoc, listFolder, site = SITES.developers) {
    const refusals = [];
    const seen = new Set();
    if (!Array.isArray(manifest.sections) || manifest.sections.length === 0) {
        return ['the manifest lists no sections — an empty site is not a published site'];
    }
    const entries = manifest.sections.flatMap((s) => s.docs ?? []);
    for (const entry of entries.filter(isFolderEntry)) {
        if (!site.folders.some((f) => entry.startsWith(f))) {
            refusals.push(
                `${entry}: the ${site.name} site may list only ${site.folders.join(', ')}, or a folder inside it, as a folder — anywhere else a doc is published by name`,
            );
        } else if (!listFolder || !listFolder(entry).some((f) => f.startsWith(entry) && /\.md$/i.test(f))) {
            refusals.push(`${entry}: lists no docs`);
        }
    }
    for (const entry of entries) {
        if (site.only && !entry.startsWith(site.only)) {
            refusals.push(`${entry}: the ${site.name} site publishes only ${site.only}`);
        }
        if (site.never && entry.startsWith(site.never)) {
            refusals.push(`${entry}: ${site.never} is published on the users site, not the ${site.name} site`);
        }
    }
    for (const doc of manifestDocs(manifest, listFolder, site)) {
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

/**
 * A doc's frontmatter, if it opens with one. Only `key: value` lines with a
 * key from FRONTMATTER_KEYS are accepted, so a typo is an error and not a
 * field nobody reads.
 */
function splitFrontmatter(markdown) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(markdown);
    if (!m) return { data: {}, body: markdown, problems: [] };
    const data = {};
    const problems = [];
    for (const line of m[1].split(/\r?\n/)) {
        if (line.trim() === '') continue;
        const kv = /^([A-Za-z][\w-]*):\s*(.*?)\s*$/.exec(line);
        if (!kv) {
            problems.push(`frontmatter line is not "key: value": ${line.trim()}`);
            continue;
        }
        const [, key, raw] = kv;
        if (!FRONTMATTER_KEYS.includes(key)) {
            problems.push(`unknown frontmatter key "${key}" (allowed: ${FRONTMATTER_KEYS.join(', ')})`);
            continue;
        }
        data[key] = raw.replace(/^(["'])(.*)\1$/, '$2');
    }
    return { data, body: markdown.slice(m[0].length), problems };
}

/**
 * The URL of every page in the app, from the repo paths of its `page.tsx`
 * files: `src/app/t/[tenantSlug]/(app)/risks/page.tsx` → `/t/[tenantSlug]/risks`.
 * Route groups — a `(folder)` — are not part of the URL and are dropped.
 */
function appRoutes(files) {
    const routes = new Set();
    for (const f of files) {
        const m = new RegExp(`^${APP_DIR}((?:/[^/]+)*)/page\\.(?:tsx|ts|jsx|js|mdx)$`).exec(f);
        if (!m) continue;
        const segs = m[1].split('/').filter((x) => x && !/^\(.*\)$/.test(x));
        routes.add(`/${segs.join('/')}`);
    }
    return routes;
}

/** How a route reads to a user: `/t/[tenantSlug]/risks` → `/t/<workspace>/risks`. */
function displayRoute(route) {
    return route.replace(/\[(\.\.\.)?([^\]]+)\]/g, (_, rest, name) => {
        const words = { tenantSlug: 'workspace', orgSlug: 'organisation' };
        return `<${words[name] ?? name}${rest ? '…' : ''}>`;
    });
}

/**
 * The label `key` names in the message catalogue, or why it cannot be used.
 * A message with ICU arguments (`{count}`) is a sentence the app fills in,
 * not a label, and printing it raw would show the braces.
 */
function uiLabel(messages, key) {
    let v = messages;
    for (const part of key.split('.')) {
        v = v !== null && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, part) ? v[part] : undefined;
    }
    if (typeof v !== 'string') {
        return { problem: `{{ui:${key}}} names ${v === undefined ? 'no message' : 'a group of messages, not one'} in ${MESSAGES_PATH}` };
    }
    if (/[{}]/.test(v)) return { problem: `{{ui:${key}}} is a message with arguments, not a label: ${v}` };
    return { value: v };
}

/** Markdown-escape a label so it prints as written, in a table cell too. */
function escapeLabel(text) {
    return text.replace(/[\\`*_[\]|]/g, '\\$&').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Replace every `{{ui:…}}` in `text`, recording any that cannot resolve. */
function resolveUiTokens(text, messages, problems, escape = escapeLabel) {
    for (const shaped of text.match(UI_TOKEN_SHAPE_RE) ?? []) {
        if (!new RegExp(`^${UI_TOKEN_RE.source}$`).test(shaped)) problems.push(`malformed label token ${shaped}`);
    }
    return text.replace(UI_TOKEN_RE, (whole, key) => {
        if (!messages) {
            problems.push(`${whole} cannot resolve: no message catalogue was loaded`);
            return whole;
        }
        const r = uiLabel(messages, key);
        if (r.problem) {
            problems.push(r.problem);
            return whole;
        }
        return escape(r.value);
    });
}

/**
 * Replace each `{{generated:<name>}}` line, outside fenced code, with the
 * fragment `generated(name)` returns, recording a problem when there is none.
 */
function expandGenerated(markdown, generated, problems) {
    let fence = null;
    return markdown
        .split('\n')
        .map((line) => {
            const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
            if (fence) {
                if (open && open[1][0] === fence[0] && open[1].length >= fence.length && line.trim() === open[1]) fence = null;
                return line;
            }
            if (open) {
                fence = open[1];
                return line;
            }
            const m = GENERATED_LINE_RE.exec(line);
            if (!m) return line;
            const text = generated ? generated(m[1]) : null;
            if (text === null) {
                problems.push(`{{generated:${m[1]}}} has no fragment: run \`npx tsx scripts/docs-reference/generate.ts\` before staging`);
                return line;
            }
            return text.replace(/\n+$/, '');
        })
        .join('\n');
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
 * Where a link should go on the site. `ctx.published` maps repo path → the
 * page's address (`/inflect-compliance/developers/auth/`);
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
    // `published` maps a repo path to its page on whichever site carries it,
    // so a developer doc's link to a user guide crosses to the user site.
    if (ctx.published.has(target)) {
        return { kind: 'site', href: `${ctx.published.get(target)}${frag}` };
    }
    const kind = ctx.kindOf(target);
    if (kind === null) return { kind: 'text', missing: target };
    if (target.startsWith('docs/') && /\.md$/i.test(target)) return { kind: 'text' };
    // `(app)` route-group folders would end a markdown link at their `)`.
    const enc = target.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/ /g, '%20');
    if (kind === 'dir') return { kind: 'github', href: `${GITHUB}/tree/main/${enc}` };
    return { kind: 'github', href: isImage ? `${RAW}${enc}` : `${GITHUB}/blob/main/${enc}${frag}` };
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

/**
 * Rewrite links, tag-shaped placeholders and label tokens in prose, never
 * inside code — a doc that explains the token syntax shows it in a code span.
 */
function rewriteProse(chunk, fromPath, ctx, missing, problems) {
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
    // Last, so a label's own characters are never read as a link or a tag.
    return unmask(resolveUiTokens(rewritten, ctx.messages, problems));
}

/**
 * Rewrite one doc's markdown for the site. Fenced code is copied verbatim.
 * Prose is rewritten a PARAGRAPH at a time, not a line at a time, because an
 * inline code span may wrap across a line break — masking line by line once
 * escaped the `<old>` inside such a span and the page showed `&lt;old>`.
 */
function transformMarkdown(markdown, fromPath, ctx) {
    const missing = [];
    const problems = [];
    const out = [];
    let prose = [];
    let fence = null;
    const flush = () => {
        if (prose.length) out.push(rewriteProse(prose.join('\n'), fromPath, ctx, missing, problems));
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
    return { text: out.join('\n'), missing, problems };
}

/**
 * The staged page: frontmatter, then the rewritten body. `problems` are
 * reasons the page must not be built — a label that does not resolve, a route
 * that matches no page — as opposed to `missing`, links to nothing, which the
 * build only warns about.
 */
function stagePage(markdown, fromPath, ctx, extraFrontmatter = {}) {
    const fm = splitFrontmatter(markdown);
    const problems = [...fm.problems];
    const split = splitTitle(fm.body);
    if (!split) throw new Error(`${fromPath}: no "# " title`);
    const title = resolveUiTokens(split.title, ctx.messages, problems, (v) => v);
    const body = expandGenerated(split.body, ctx.generated, problems);
    const route = fm.data.route;
    if (fromPath.startsWith(GUIDE_FOLDER) && !route) {
        problems.push('a page guide names the page it documents in "route:" frontmatter');
    }
    if (route && (!ctx.routes || !ctx.routes.has(route))) {
        problems.push(`route ${route} matches no page.tsx under ${APP_DIR}/`);
    }
    const { text, missing, problems: bodyProblems } = transformMarkdown(body, fromPath, ctx);
    problems.push(...bodyProblems);
    const meta = { title, ...extraFrontmatter };
    const yaml = Object.entries(meta)
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`)
        .join('\n');
    return { page: `---\n${yaml}\n---\n\n${text}`, missing, problems };
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

/** Repo paths of every file under `folder`, at any depth; `[]` if it is absent. */
function listRepoFolder(folder) {
    const out = [];
    const walk = (rel) => {
        let entries;
        try {
            entries = fs.readdirSync(path.join(REPO_ROOT, rel), { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const child = `${rel.replace(/\/$/, '')}/${e.name}`;
            if (e.isDirectory()) walk(child);
            else if (e.isFile()) out.push(child);
        }
    };
    walk(folder);
    return out.sort();
}

/**
 * What the stager reads from the repository: docs, folders, the label
 * catalogue and the app's page routes. Astro's config reads the sidebar
 * through the same object, so the two cannot disagree about a folder.
 */
function repoIo() {
    const raw = readRepoFile(MESSAGES_PATH);
    let messages = null;
    try {
        messages = raw === null ? null : JSON.parse(raw);
    } catch {
        messages = null;
    }
    return {
        readDoc: readRepoFile,
        listFolder: listRepoFolder,
        messages,
        routes: appRoutes(listRepoFolder(`${APP_DIR}/`)),
        generated: (name) => {
            try {
                return fs.readFileSync(path.join(GENERATED_DIR, `${name}.md`), 'utf8');
            } catch {
                return null;
            }
        },
    };
}

/** A sidebar label with its `{{ui:…}}` tokens resolved, as plain text. */
function sidebarLabel(io) {
    return (text) => resolveUiTokens(text, io.messages, [], (v) => v);
}

/** Each site's manifest, read from disk. */
function readManifests() {
    return Object.values(SITES).map((site) => ({ site, manifest: JSON.parse(fs.readFileSync(manifestPath(site), 'utf8')) }));
}

/**
 * Where every published doc lives: repo path → its page's address. One map
 * for both sites, so a link from either one reaches the other. A doc listed
 * by both is refused, because one doc has one home.
 */
function publishedAddresses(sites, listFolder) {
    const published = new Map();
    const refusals = [];
    for (const { site, manifest } of sites) {
        for (const doc of manifestDocs(manifest, listFolder, site)) {
            if (published.has(doc)) refusals.push(`${doc}: listed by more than one site`);
            published.set(doc, `${site.base}/${slugFor(doc)}/`);
        }
    }
    return { published, refusals };
}

function main() {
    const io = repoIo();
    const sites = readManifests();
    const refusals = sites.flatMap(({ site, manifest }) =>
        publicationRefusals(manifest, io.readDoc, io.listFolder, site).map((r) => `[${site.name}] ${r}`),
    );
    const { published, refusals: shared } = publishedAddresses(sites, io.listFolder);
    refusals.push(...shared);
    if (refusals.length) {
        process.stderr.write(`docs site: refusing to publish\n  ${refusals.join('\n  ')}\n`);
        process.exit(1);
    }
    const ctx = { published, kindOf: kindOnDisk, messages: io.messages, routes: io.routes, generated: io.generated };

    // Everything is staged in memory first, so a page that cannot be built
    // leaves the previous staging untouched rather than half-replaced.
    const staged = new Map();
    const problems = [];
    const warnings = [];
    for (const { site, manifest } of sites) {
        const pages = new Map();
        const manifestRel = path.relative(REPO_ROOT, manifestPath(site));
        for (const label of manifest.sections.flatMap((s) => [s.group, s.label]).filter(Boolean)) {
            const labelProblems = [];
            resolveUiTokens(label, io.messages, labelProblems, (v) => v);
            problems.push(...labelProblems.map((p) => `${manifestRel}: ${p}`));
        }
        const docs = manifestDocs(manifest, io.listFolder, site);
        for (const doc of docs) {
            // A developer can edit the doc a page came from; a reader of the
            // help site is not offered the repository.
            const extra = site.name === 'developers' ? { editUrl: `${GITHUB}/edit/main/${doc}` } : {};
            const page = stagePage(io.readDoc(doc), doc, ctx, extra);
            problems.push(...page.problems.map((p) => `${doc}: ${p}`));
            // Checked again AFTER labels are resolved: the source passed, but a
            // label printed into it is text the policy has not seen yet.
            for (const hit of forbiddenContentIn(page.page)) {
                problems.push(`${doc}: the built page carries ${hit.why} (${hit.id})`);
            }
            for (const m of page.missing) warnings.push(`${doc}: link to a missing target (${m})`);
            pages.set(`${slugFor(doc)}.md`, page.page);
        }
        // A site's landing page links to docs by their repo paths, so it goes
        // through the same rewrite and fails the same way if it points at a
        // page that is not published.
        const landingRel = landingPage(site);
        const landing = transformMarkdown(io.readDoc(landingRel), landingRel, ctx);
        problems.push(...landing.problems.map((p) => `${landingRel}: ${p}`));
        if (landing.missing.length || /\]\((?!https?:|\/inflect-compliance\/|#)/.test(landing.text)) {
            problems.push(`${landingRel}: links to something that is not a published page`);
        }
        pages.set('index.md', landing.text);
        staged.set(site, { pages, count: docs.length });
    }
    if (problems.length) {
        process.stderr.write(`docs site: refusing to build\n  ${problems.join('\n  ')}\n`);
        process.exit(1);
    }

    for (const [site, { pages, count }] of staged) {
        const dir = contentDir(site);
        fs.rmSync(dir, { recursive: true, force: true });
        for (const [rel, page] of pages) {
            const dest = path.join(dir, rel);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, page);
        }
        process.stdout.write(`docs site: staged ${count} docs + landing page for the ${site.name} site into ${path.relative(REPO_ROOT, dir)}\n`);
    }
    if (warnings.length) process.stdout.write(`docs site: ${warnings.length} warning(s)\n  ${warnings.join('\n  ')}\n`);
}

module.exports = {
    FORBIDDEN_CONTENT,
    GENERATED_DIR,
    SITES,
    GUIDE_FOLDER,
    NEVER_PUBLISH,
    PUBLIC_FOLDERS,
    SITE_BASE,
    appRoutes,
    displayRoute,
    expandGenerated,
    expandSections,
    forbiddenContentIn,
    manifestDocs,
    neverPublishReason,
    publicationRefusals,
    publishedAddresses,
    readManifests,
    repoIo,
    resolveLink,
    resolveUiTokens,
    sidebarFrom,
    sidebarLabel,
    slugFor,
    splitFrontmatter,
    splitTitle,
    stagePage,
    transformMarkdown,
    uiLabel,
};

if (require.main === module) main();
