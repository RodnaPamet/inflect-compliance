/**
 * WEB BOT AUTH — robots.txt, read the way RFC 9309 says a crawler reads it
 * (Phase 2, D-L1-6: robots.txt honoured).
 *
 * Pure: text in, verdict out. Fetching is the caller's, through `botFetch`.
 *
 *   - Groups start at one or more consecutive `user-agent` lines; the rules
 *     that follow belong to every agent the group names.
 *   - The crawler obeys EVERY group whose `user-agent` equals its product
 *     token, compared case-insensitively, merged; only when none does, every
 *     `*` group, merged (RFC 9309 §2.2.1).
 *   - The longest matching rule wins; on a tie between `allow` and
 *     `disallow`, `allow` wins. An empty `disallow:` is no rule. `*` matches
 *     any run of characters and a trailing `$` anchors the end (§2.2.2-3).
 *   - Only the first `ROBOTS_MAX_BYTES` are read (§2.5 asks for at least
 *     500 KiB); the caller stops reading there.
 *
 * Other lines are ignored, `crawl-delay` among them: honouring it was put to
 * the owner as a proposal (decisions note, 2026-11-11) and has not been
 * adopted. The monitor sends one homepage request per vendor per day, which
 * is under any crawl delay a site is likely to set.
 */

/** RFC 9309 §2.5: a crawler MUST parse at least 500 KiB. */
export const ROBOTS_MAX_BYTES = 500 * 1024;

interface Rule {
    readonly allow: boolean;
    readonly pattern: string;
}

interface Group {
    readonly agents: string[];
    readonly rules: Rule[];
}

export function parseRobots(text: string): Group[] {
    const groups: Group[] = [];
    let current: Group | null = null;
    let lastWasAgent = false;
    for (const rawLine of text.split(/\r\n|\r|\n/)) {
        const line = rawLine.replace(/#.*$/, '').trim();
        if (!line) continue;
        const colon = line.indexOf(':');
        if (colon <= 0) continue;
        const field = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (field === 'user-agent') {
            if (!current || !lastWasAgent) {
                current = { agents: [], rules: [] };
                groups.push(current);
            }
            current.agents.push(value.toLowerCase());
            lastWasAgent = true;
            continue;
        }
        lastWasAgent = false;
        if (!current) continue; // a rule before any user-agent line belongs to no group
        if (field === 'allow' || field === 'disallow') {
            if (value === '') continue; // `disallow:` with no path is no rule
            current.rules.push({ allow: field === 'allow', pattern: value });
        }
    }
    return groups;
}

/**
 * Percent-encode what RFC 3986 does not allow in a path, so a pattern and a
 * path compare in the same spelling; existing `%XX` escapes are upper-cased.
 */
function normalisePath(p: string): string {
    return p
        .replace(/%[0-9a-fA-F]{2}/g, (m) => m.toUpperCase())
        .replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@/%?]/g, (c) =>
            Array.from(new TextEncoder().encode(c))
                .map((b) => `%${b.toString(16).toUpperCase().padStart(2, '0')}`)
                .join(''),
        );
}

function patternMatches(pattern: string, path: string): boolean {
    const anchored = pattern.endsWith('$');
    const body = normalisePath(anchored ? pattern.slice(0, -1) : pattern);
    const re = new RegExp(
        `^${body
            .split('*')
            .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
            .join('.*')}${anchored ? '$' : ''}`,
    );
    return re.test(path);
}

/**
 * May the crawler whose product token is `token` request `path` (path plus
 * query, as sent)? `null` text — no robots.txt, or one that is "unavailable"
 * in RFC 9309's sense — allows everything.
 */
export function robotsAllows(text: string | null, token: string, path: string): boolean {
    if (text === null) return true;
    const groups = parseRobots(text);
    const wanted = token.toLowerCase();
    let applicable = groups.filter((g) => g.agents.includes(wanted));
    if (applicable.length === 0) applicable = groups.filter((g) => g.agents.includes('*'));
    const target = normalisePath(path || '/');
    let best: Rule | null = null;
    for (const rule of applicable.flatMap((g) => g.rules)) {
        if (!patternMatches(rule.pattern, target)) continue;
        if (
            !best ||
            rule.pattern.length > best.pattern.length ||
            (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
        ) {
            best = rule;
        }
    }
    return best ? best.allow : true;
}
