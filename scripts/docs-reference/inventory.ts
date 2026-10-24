/**
 * Every page of the app, where the sidebar puts it, whether a page guide
 * documents it, and whether it is only a redirect to another page.
 *
 * The sidebar sections are read from `SidebarNav.tsx` itself — each section's
 * `title: t('<key>')` and its items' `href: tenantHref('/<path>')` — so a page
 * moved in the app moves here. A page sits in the section whose item is the
 * longest prefix of its path.
 */
import ts from 'typescript';
import { literalText, walk } from './source';

export interface SidebarSection {
    /** The `nav.*` message key of the section's title, or of its first item when it has no title. */
    labelKey: string;
    /** Tenant-relative item paths: `/risks`. */
    hrefs: string[];
}

function tCallKey(e: ts.Expression | undefined): string | null {
    if (e && ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 't') {
        return literalText(e.arguments[0]);
    }
    return null;
}

function prop(o: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
    const p = o.properties.find((x): x is ts.PropertyAssignment => ts.isPropertyAssignment(x) && ts.isIdentifier(x.name) && x.name.text === name);
    return p?.initializer;
}

export function sidebarSections(sf: ts.SourceFile): SidebarSection[] {
    const sections: SidebarSection[] = [];
    walk(sf, (n) => {
        if (!ts.isObjectLiteralExpression(n)) return;
        let items = prop(n, 'items');
        // `items: [...].filter(...)`
        while (items && ts.isCallExpression(items) && ts.isPropertyAccessExpression(items.expression)) items = items.expression.expression;
        if (!items || !ts.isArrayLiteralExpression(items)) return;
        const hrefs: string[] = [];
        let firstLabel: string | null = null;
        for (const el of items.elements) {
            if (!ts.isObjectLiteralExpression(el)) continue;
            const href = prop(el, 'href');
            if (href && ts.isCallExpression(href) && ts.isIdentifier(href.expression) && href.expression.text === 'tenantHref') {
                const h = literalText(href.arguments[0]);
                if (h) hrefs.push(h);
            }
            firstLabel ??= tCallKey(prop(el, 'label'));
        }
        const labelKey = tCallKey(prop(n, 'title')) ?? firstLabel;
        if (hrefs.length && labelKey) sections.push({ labelKey, hrefs });
    });
    return sections;
}

export type Area = { kind: 'sidebar'; labelKey: string } | { kind: 'admin' } | { kind: 'org' } | { kind: 'other-tenant' } | { kind: 'outside' };

const TENANT = '/t/[tenantSlug]';

export function areaOf(route: string, sections: readonly SidebarSection[]): Area {
    if (route.startsWith('/org/')) return { kind: 'org' };
    if (!route.startsWith(`${TENANT}/`) && route !== TENANT) return { kind: 'outside' };
    const rel = route.slice(TENANT.length) || '/';
    if (rel === '/admin' || rel.startsWith('/admin/')) return { kind: 'admin' };
    let best: { key: string; len: number } | null = null;
    for (const s of sections) {
        for (const h of s.hrefs) {
            if ((rel === h || rel.startsWith(`${h}/`)) && (!best || h.length > best.len)) best = { key: s.labelKey, len: h.length };
        }
    }
    return best ? { kind: 'sidebar', labelKey: best.key } : { kind: 'other-tenant' };
}

/**
 * A page that renders nothing of its own: it calls `redirect()` and contains
 * no JSX. It is documented by the page it sends the reader to.
 */
export function isRedirectOnly(sf: ts.SourceFile): boolean {
    let jsx = false;
    let redirects = false;
    walk(sf, (n) => {
        if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) jsx = true;
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /^(redirect|permanentRedirect)$/.test(n.expression.text)) redirects = true;
    });
    return redirects && !jsx;
}
