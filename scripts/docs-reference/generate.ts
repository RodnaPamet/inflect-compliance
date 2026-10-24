/**
 * Generate the docs site's reference pages from the code.
 *
 *   npx tsx scripts/docs-reference/generate.ts
 *
 * Writes four markdown fragments to site/.generated/ (gitignored). The docs in
 * docs/reference/ embed them with `{{generated:<name>}}`, and the stager
 * refuses to build a page whose fragment is missing — so a stale or absent
 * fragment can never be published as if it were current. The docs workflow
 * runs this before the stager; see docs/docs-site.md.
 *
 * Nothing here is a gate. The undocumented-page count and the share of API
 * calls the scan could match are REPORTED (stdout, and as notices on a GitHub
 * run), never enforced: the repo does not fail a build on documentation
 * coverage (docs-site expansion plan, decision 3).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type ts from 'typescript';
import { getOrgPermissions, getPermissionsForRole, PERMISSION_SCHEMA } from '@/lib/permissions';
import * as stage from '../../site/scripts/stage-docs.js';
import { apiRouteTable } from './api-routes';
import { areaOf, isRedirectOnly, sidebarSections, type Area } from './inventory';
import { actionsMarkdown, inventoryMarkdown, refusalsMarkdown, rolesMarkdown, type InventoryRow } from './markdown';
import { appPages, pageActions, UrlResolver, type PageActions, type Source } from './page-actions';
import { domainCodes, errorClasses, ERRORS_FILE, refusals } from './refusals';
import { enumValues, flatMatrix, roleMatrix } from './roles';
import { parse, readRepoFile, REPO_ROOT, repoFiles } from './source';

export const OUT_DIR = path.join(REPO_ROOT, 'site', '.generated');
const SIDEBAR_FILE = 'src/components/layout/SidebarNav.tsx';
const RESOLUTION_TARGET = 0.9;

type Messages = Record<string, unknown>;

function message(messages: Messages, key: string): string | null {
    let v: unknown = messages;
    for (const part of key.split('.')) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[part] : undefined;
    return typeof v === 'string' ? v : null;
}

function areaLabel(area: Area, messages: Messages): string {
    switch (area.kind) {
        case 'sidebar':
            return message(messages, `nav.${area.labelKey}`) ?? area.labelKey;
        case 'admin':
            return message(messages, 'nav.admin') ?? 'Admin';
        case 'org':
            return 'Organisation workspace';
        case 'other-tenant':
            return 'Workspace pages not in the sidebar';
        case 'outside':
            return 'Sign-in, account and public pages';
    }
}

const AREA_ORDER = ['sidebar', 'other-tenant', 'admin', 'org', 'outside'];

export interface Generated {
    fragments: Record<string, string>;
    summary: { pages: number; documented: number; undocumented: number; redirects: number; resolved: number; unresolved: number };
}

export function generate(root: string = REPO_ROOT): Generated {
    const files = repoFiles(root);
    const present = new Set(files);
    const cache = new Map<string, ts.SourceFile>();
    const read = (f: string) => readRepoFile(f, root);
    const src: Source = {
        exists: (f) => present.has(f),
        parsed: (f) => {
            let sf = cache.get(f);
            if (!sf) {
                sf = parse(f, read(f));
                cache.set(f, sf);
            }
            return sf;
        },
    };
    const messages = JSON.parse(read('messages/en.json')) as Messages;

    // Roles and permissions.
    const roles = enumValues(read('prisma/schema/enums.prisma'), 'Role');
    const orgRoles = enumValues(read('prisma/schema/enums.prisma'), 'OrgRole');
    const matrix = roleMatrix(roles, PERMISSION_SCHEMA, (r) => getPermissionsForRole(r as never) as never);
    const org = flatMatrix(orgRoles, (r) => getOrgPermissions(r as never) as never);
    const roleLabel = (r: string) => message(messages, `roles.${r}`) ?? message(messages, `orgRoles.${r}`) ?? r;

    // Pages, their areas, their guides, their calls.
    const sections = sidebarSections(src.parsed(SIDEBAR_FILE));
    const guides = new Map<string, string>();
    for (const f of files.filter((x) => x.startsWith(stage.GUIDE_FOLDER) && x.endsWith('.md'))) {
        const route = stage.splitFrontmatter(read(f)).data.route;
        if (route) guides.set(route, f);
    }
    const routes = apiRouteTable(files, read);
    const resolver = new UrlResolver(src);
    const pages = appPages(files)
        .map((p) => {
            const area = areaOf(p.route, sections);
            return { ...p, area, areaLabel: areaLabel(area, messages), redirect: isRedirectOnly(src.parsed(p.file)) };
        })
        .sort((a, b) => AREA_ORDER.indexOf(a.area.kind) - AREA_ORDER.indexOf(b.area.kind) || a.route.localeCompare(b.route));
    const actions = new Map<string, PageActions>();
    const seen = new Set<string>();
    let resolved = 0;
    let unresolved = 0;
    for (const p of pages) {
        if (p.redirect) continue;
        const a = pageActions(p.file, src, routes, resolver);
        actions.set(p.route, a);
        // A shared component's call is counted once, however many pages reach it.
        for (const r of a.resolved) for (const s of r.sites) {
            const k = `${s.file}:${s.line}`;
            if (!seen.has(k)) {
                seen.add(k);
                resolved++;
            }
        }
        for (const u of a.unresolved) {
            const k = `${u.file}:${u.line}`;
            if (!seen.has(k)) {
                seen.add(k);
                unresolved++;
            }
        }
    }
    const rows: InventoryRow[] = pages.map((p) => ({
        route: p.route,
        file: p.file,
        areaLabel: p.areaLabel,
        redirect: p.redirect,
        guide: guides.get(p.route) ?? null,
        actions: actions.get(p.route)?.resolved.length ?? 0,
    }));

    // Refusals.
    const errorsSf = src.parsed(ERRORS_FILE);
    const reasons = refusals(files, errorsSf, src.exists, src.parsed);

    const display = stage.displayRoute;
    const real = rows.filter((r) => !r.redirect);
    return {
        fragments: {
            'roles-matrix': rolesMarkdown(matrix, roleLabel, org),
            'page-inventory': inventoryMarkdown(rows, display),
            'page-actions': actionsMarkdown(
                pages.filter((p) => !p.redirect).map((p) => ({ route: p.route, areaLabel: p.areaLabel, actions: actions.get(p.route)! })),
                display,
                { resolved, unresolved },
            ),
            'refusal-codes': refusalsMarkdown(errorClasses(errorsSf), domainCodes(errorsSf), reasons),
        },
        summary: {
            pages: rows.length,
            documented: real.filter((r) => r.guide).length,
            undocumented: real.filter((r) => !r.guide).length,
            redirects: rows.length - real.length,
            resolved,
            unresolved,
        },
    };
}

function main(): void {
    const { fragments, summary } = generate();
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const [name, text] of Object.entries(fragments)) fs.writeFileSync(path.join(OUT_DIR, `${name}.md`), text);
    const share = summary.resolved / Math.max(1, summary.resolved + summary.unresolved);
    const lines = [
        `docs reference: ${Object.keys(fragments).length} fragments written to ${path.relative(REPO_ROOT, OUT_DIR)}`,
        `docs reference: ${summary.pages} pages; ${summary.documented} documented, ${summary.undocumented} without a page guide, ${summary.redirects} redirects`,
        `docs reference: ${summary.resolved} of ${summary.resolved + summary.unresolved} API calls matched (${(share * 100).toFixed(1)}%)`,
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
    if (process.env.GITHUB_ACTIONS) {
        process.stdout.write(`::notice title=Docs coverage::${summary.undocumented} pages have no page guide yet (${summary.documented} documented).\n`);
        if (share < RESOLUTION_TARGET) {
            process.stdout.write(
                `::warning title=Docs action scan::${(share * 100).toFixed(1)}% of API calls matched, below the ${RESOLUTION_TARGET * 100}% target. See docs/reference/page-actions.md for the unmatched calls.\n`,
            );
        }
    }
}

if (require.main === module) main();
