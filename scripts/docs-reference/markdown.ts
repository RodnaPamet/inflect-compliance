/**
 * Markdown for the generated reference pages. Pure: every function takes the
 * computed data and returns text, so the shapes are unit-tested without a repo.
 *
 * Links to source files are written repo-root-relative (`/src/…`); the docs
 * stager turns them into github.com links, the same as any doc's.
 */
import type { PageActions } from './page-actions';
import type { DomainCode, ErrorClass, Refusal } from './refusals';
import type { RoleMatrix } from './roles';

/** A table cell: no pipe or line break can end it early. */
export function cell(text: string): string {
    return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** A link target with the characters Next.js route folders use, encoded for markdown. */
export function repoHref(file: string, line?: number): string {
    const enc = `/${file}`.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/ /g, '%20');
    return line ? `${enc}#L${line}` : enc;
}

export function repoLink(file: string, line?: number, label?: string): string {
    const text = label ?? `${file.split('/').pop()}${line ? `:${line}` : ''}`;
    return `[${cell(text).replace(/[[\]]/g, '\\$&')}](${repoHref(file, line)})`;
}

/** `access_reviews` → `Access reviews`. */
export function humanise(key: string): string {
    const s = key.replace(/_/g, ' ');
    return s.charAt(0).toUpperCase() + s.slice(1);
}

const YES = '✓';
const NO = '—';

export function rolesMarkdown(
    matrix: RoleMatrix,
    roleLabel: (role: string) => string,
    org: { roles: string[]; rows: { key: string; held: boolean[] }[] },
): string {
    const head = (roles: string[]) => `| Permission | ${roles.map((r) => cell(roleLabel(r))).join(' | ')} |\n| --- |${roles.map(() => ' :---: |').join('')}`;
    const out: string[] = [];
    const areas = [...new Set(matrix.rows.map((r) => r.area))];
    for (const area of areas) {
        out.push(`### ${humanise(area)}`, '', head(matrix.roles));
        for (const row of matrix.rows.filter((r) => r.area === area)) {
            out.push(`| \`${area}.${row.action}\` | ${row.held.map((h) => (h ? YES : NO)).join(' | ')} |`);
        }
        out.push('');
    }
    out.push('### Organisation roles', '', head(org.roles));
    for (const row of org.rows) out.push(`| \`${row.key}\` | ${row.held.map((h) => (h ? YES : NO)).join(' | ')} |`);
    out.push('');
    return out.join('\n');
}

export interface InventoryRow {
    route: string;
    file: string;
    areaLabel: string;
    redirect: boolean;
    guide: string | null;
    actions: number;
}

export function inventoryMarkdown(rows: readonly InventoryRow[], display: (route: string) => string): string {
    const real = rows.filter((r) => !r.redirect);
    const documented = real.filter((r) => r.guide);
    const out: string[] = [
        `**${rows.length} pages.** ${real.length} render a page of their own, and ${documented.length} of those have a page guide; ${rows.length - real.length} only redirect to another page.`,
        '',
    ];
    const areas = [...new Set(rows.map((r) => r.areaLabel))];
    for (const area of areas) {
        const inArea = rows.filter((r) => r.areaLabel === area);
        const doc = inArea.filter((r) => !r.redirect && r.guide).length;
        const pages = inArea.filter((r) => !r.redirect).length;
        out.push(`### ${area}`, '', `${doc} of ${pages} pages documented.`, '', '| Page address | Page guide | API calls | Source |', '| --- | --- | ---: | --- |');
        for (const r of inArea) {
            const guide = r.redirect ? 'Redirect' : r.guide ? `[Guide](/${r.guide})` : NO;
            out.push(`| \`${cell(display(r.route))}\` | ${guide} | ${r.redirect ? NO : r.actions} | ${repoLink(r.file, undefined, 'page.tsx')} |`);
        }
        out.push('');
    }
    return out.join('\n');
}

const MAX_SITES = 2;

export function actionsMarkdown(
    pages: readonly { route: string; areaLabel: string; actions: PageActions }[],
    display: (route: string) => string,
    stats: { resolved: number; unresolved: number },
): string {
    const total = stats.resolved + stats.unresolved;
    const pct = total ? Math.round((stats.resolved / total) * 1000) / 10 : 100;
    const out: string[] = [
        `**${total} API calls found; ${stats.resolved} (${pct}%) matched to the route and permission they reach.** Each unmatched call is listed under its page with the reason.`,
        '',
    ];
    const areas = [...new Set(pages.map((p) => p.areaLabel))];
    for (const area of areas) {
        out.push(`## ${area}`, '');
        for (const p of pages.filter((x) => x.areaLabel === area)) {
            out.push(`### \`${cell(display(p.route))}\``, '');
            const { resolved, unresolved } = p.actions;
            if (resolved.length === 0 && unresolved.length === 0) {
                out.push('No API calls: the page renders what the server loads for it.', '');
                continue;
            }
            if (resolved.length) {
                out.push('| Method | API route | Permission the route checks | Called from |', '| --- | --- | --- | --- |');
                for (const a of resolved) {
                    const perm = a.permission.length ? a.permission.map((k) => `\`${k}\``).join(', ') : 'Checked in the use case';
                    const sites = a.sites.slice(0, MAX_SITES).map((s) => repoLink(s.file, s.line));
                    const more = a.sites.length > MAX_SITES ? ` and ${a.sites.length - MAX_SITES} more` : '';
                    out.push(`| ${a.method} | ${repoLink(a.route.file, undefined, display(a.route.url))} | ${perm} | ${sites.join(', ')}${more} |`);
                }
                out.push('');
            }
            if (unresolved.length) {
                out.push('Not matched by the scan:', '');
                for (const u of unresolved) out.push(`- ${repoLink(u.file, u.line)}: ${u.why}. \`${u.expression.replace(/`/g, "'")}\``);
                out.push('');
            }
        }
    }
    return out.join('\n');
}

export function refusalsMarkdown(classes: Map<string, ErrorClass>, domain: readonly DomainCode[], reasons: readonly Refusal[]): string {
    const out: string[] = ['### Error codes', '', '| Code | HTTP status | Raised as |', '| --- | ---: | --- |'];
    for (const [name, c] of [...classes.entries()].sort((a, b) => a[1].status - b[1].status)) {
        if (!c.code) continue;
        out.push(`| \`${c.code}\` | ${c.status} | \`${name}\` |`);
    }
    out.push('', '### Domain codes', '', 'A `DomainError` carries one of these codes in place of the generic one, so the page can tell the cases apart.', '', '| Code | Meaning |', '| --- | --- |');
    for (const d of domain) out.push(`| \`${d.code}\` | ${cell(d.description || NO)} |`);
    out.push(
        '',
        '### Refusal reasons',
        '',
        `${reasons.length} named reasons. The API returns the reason in \`error.details.reason\`, beside the code and the message below.`,
        '',
        '| Reason | Code and HTTP status | Message | Raised in |',
        '| --- | --- | --- | --- |',
    );
    for (const r of reasons) {
        const msg = r.messages.length ? r.messages.map((m) => cell(m)).join('<br>') : 'Written by the caller';
        const sites = r.sites.slice(0, MAX_SITES).map((s) => repoLink(s.file, s.line));
        const more = r.sites.length > MAX_SITES ? ` and ${r.sites.length - MAX_SITES} more` : '';
        const answers = r.answers.map((a) => `\`${a.split(' ')[0]}\` ${a.split(' ')[1]}`).join('<br>');
        out.push(`| \`${r.reason}\` | ${answers} | ${msg} | ${sites.length ? `${sites.join(', ')}${more}` : NO} |`);
    }
    out.push('');
    return out.join('\n');
}
