/**
 * Can GitHub credit the right person for this email?
 *
 * THE COST THIS AVOIDS
 * ────────────────────
 * GitHub attributes a commit to whichever ACCOUNT has registered its email —
 * the author's, the committer's, and every `Co-authored-by:` trailer's. An
 * address that is not really anybody's (`x@y`, `user@users-Mac-mini.local`,
 * `user@192.168.1.13`) is not attributed to nobody: anyone may add it to their
 * own account, and from then on GitHub shows them as a contributor to every
 * commit that carries it.
 *
 * That is what happened. Two commits on `main` (b0a20c27b, c74cebbd1, both
 * 2026-10-08) carry `Co-authored-by: h0mele55 <x@y>`, and `x@y` is registered
 * to a stranger's account, so GitHub lists that account as a contributor to
 * the repository. Squash-merge is the entry path: it turns the author of
 * every commit in a pull request into a `Co-authored-by:` trailer on the
 * squash, so a placeholder `user.email` on a machine that pushed to a branch
 * reaches `main` without anybody typing it.
 *
 * History cannot be repaired — rewriting `main` is not on the table — so the
 * rule is to stop the next one at the pull request that would carry it.
 *
 * THE RULE
 * ────────
 * An email passes when it is a syntactically plain address whose domain is a
 * public, multi-label DNS name. It fails when its domain:
 *   - has a single label (`x@y`, `me@localhost`);
 *   - is an IP address or an IP literal (`user@192.168.1.13`, `a@[::1]`);
 *   - ends in a special-use or private-use name (`.local`, `.lan`, `.internal`,
 *     `.test`, `.invalid`, `.example`, …; RFC 2606 / 6761 / 6762 / 8375);
 *   - is a documentation domain (`example.com`, `.net`, `.org`).
 *
 * There is deliberately NO allowlist. GitHub's noreply addresses
 * (`<id>+<login>@users.noreply.github.com`, `noreply@github.com`), the release
 * bot's and Anthropic's all pass on structure, so a new bot needs no entry —
 * and an allowlist is the thing that would grow an exception for `x@y`.
 *
 * WHAT IT CANNOT SEE
 * ──────────────────
 * A real domain with a made-up mailbox (`user@inflect.dev`) passes. Nothing
 * offline can tell whether a mailbox exists, and the harm this rule closes —
 * an address anyone can claim — needs control of the domain's mail to repeat
 * on a real domain, which is a different threat.
 */

/**
 * Top-level labels reserved for special or private use. Any domain ENDING in
 * one of these cannot be a public mailbox.
 */
const RESERVED_TLDS = new Set([
    'local', // mDNS (RFC 6762) — what macOS writes for `user@<host>.local`
    'localhost', // RFC 6761
    'localdomain', // common /etc/hosts default
    'invalid', // RFC 2606 / 6761
    'test', // RFC 2606 / 6761
    'example', // RFC 2606 / 6761
    'internal', // ICANN private-use (2024)
    'lan',
    'home', // also home.arpa, below
    'corp',
    'intranet',
    'private',
    'arpa', // infrastructure, never a mailbox domain (home.arpa: RFC 8375)
]);

/** Second-level documentation domains (RFC 2606). */
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/** A DNS label: letters, digits, hyphens, not at either end. Punycode passes. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * @param {string} email
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function classifyEmail(email) {
    const value = String(email ?? '').trim();
    if (value === '') return { ok: false, reason: 'the email is empty' };
    if (/\s/.test(value)) return { ok: false, reason: 'the email contains whitespace' };

    const at = value.lastIndexOf('@');
    if (at <= 0 || at === value.length - 1) {
        return { ok: false, reason: 'the email is not of the form mailbox@domain' };
    }
    if (value.indexOf('@') !== at) {
        return { ok: false, reason: 'the email contains more than one @' };
    }

    const domain = value.slice(at + 1).toLowerCase().replace(/\.$/, '');

    if (domain.startsWith('[') || IPV4.test(domain) || domain.includes(':')) {
        return { ok: false, reason: `"${domain}" is an IP address, not a domain anyone owns mail for` };
    }

    const labels = domain.split('.');
    if (labels.length < 2) {
        return {
            ok: false,
            reason: `"${domain}" is a single-label domain — no public mailbox can have it, so anyone can claim the address on GitHub`,
        };
    }
    if (!labels.every((l) => LABEL.test(l))) {
        return { ok: false, reason: `"${domain}" is not a valid DNS name` };
    }

    const tld = labels[labels.length - 1];
    if (RESERVED_TLDS.has(tld)) {
        return { ok: false, reason: `".${tld}" is a special-use or private name, not a public mail domain` };
    }
    if (/^\d+$/.test(tld)) {
        return { ok: false, reason: `"${domain}" has a numeric top-level label` };
    }
    const reserved = RESERVED_DOMAINS.find((d) => domain === d || domain.endsWith(`.${d}`));
    if (reserved) {
        return { ok: false, reason: `"${reserved}" is a documentation domain (RFC 2606)` };
    }

    return { ok: true };
}

/**
 * The co-authors a commit message names, as GitHub reads them: a line
 * `Co-authored-by: Name <email>`, case-insensitive. A line without an
 * `<email>` links nobody on GitHub, so it is not returned.
 *
 * @param {string} message
 * @returns {{ name: string, email: string }[]}
 */
function parseCoAuthors(message) {
    const out = [];
    for (const line of String(message ?? '').split(/\r?\n/)) {
        const m = /^\s*co-authored-by:\s*(.*?)\s*<([^<>]*)>\s*$/i.exec(line);
        if (m) out.push({ name: m[1], email: m[2] });
    }
    return out;
}

/**
 * @typedef {{ sha: string, authorName: string, authorEmail: string,
 *             committerName: string, committerEmail: string, message: string }} Commit
 * @typedef {{ sha: string, subject: string, role: 'author' | 'committer' | 'co-author',
 *             name: string, email: string, reason: string }} IdentityProblem
 */

/**
 * Every identity in `commits` that GitHub could credit to the wrong person.
 *
 * @param {Commit[]} commits
 * @returns {IdentityProblem[]}
 */
function findIdentityProblems(commits) {
    const problems = [];
    for (const c of commits) {
        const subject = String(c.message ?? '').split('\n', 1)[0];
        const identities = [
            { role: 'author', name: c.authorName, email: c.authorEmail },
            { role: 'committer', name: c.committerName, email: c.committerEmail },
            ...parseCoAuthors(c.message).map((a) => ({ role: 'co-author', ...a })),
        ];
        for (const id of identities) {
            const verdict = classifyEmail(id.email);
            if (!verdict.ok) {
                problems.push({ sha: c.sha, subject, role: id.role, name: id.name, email: id.email, reason: verdict.reason });
            }
        }
    }
    return problems;
}

/** Field and record separators for `git log --format`, which no commit field contains. */
const FIELD = '\x1f';
const RECORD = '\x1e';
const GIT_LOG_FORMAT = ['%H', '%an', '%ae', '%cn', '%ce', '%B'].join('%x1f') + '%x1e';

/**
 * Parse the output of `git log --format=<GIT_LOG_FORMAT>`.
 *
 * @param {string} raw
 * @returns {Commit[]}
 */
function parseGitLog(raw) {
    return String(raw ?? '')
        .split(RECORD)
        .map((r) => r.replace(/^\n+/, ''))
        .filter((r) => r.trim() !== '')
        .map((r) => {
            const [sha, authorName, authorEmail, committerName, committerEmail, ...rest] = r.split(FIELD);
            return { sha, authorName, authorEmail, committerName, committerEmail, message: rest.join(FIELD) };
        });
}

module.exports = { classifyEmail, parseCoAuthors, findIdentityProblems, parseGitLog, GIT_LOG_FORMAT };
