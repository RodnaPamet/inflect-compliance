/**
 * Strip directory identifiers out of free text that is about to leave the
 * tenant boundary — an outbound notification body, or a log line.
 *
 * WHY A LOG COUNTS. The note that introduced the notification-side version
 * ended its section with "An email is not a log", and that was right about
 * emails: a mail has a named recipient and a retention story. A log line has
 * neither. It carries no RLS, no tenant scope and no retention policy, and it
 * lands in whatever aggregator the deployment happens to use — so a terminated
 * worker's objectGUID written to stdout is the same disclosure the notification
 * layer already refuses to make, minus the addressee.
 *
 * REMOVES ONLY. Every substitution is a fixed literal that cannot carry markup
 * back in, so this is safe to run after sanitisation as well as before.
 */
const EMAIL_LIKE_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// The value class allows SPACES. It did not, and `CN=Alice Smith,OU=…` therefore
// redacted to `{account} Smith,{account}` — the surname survived, in notification
// bodies as well as logs, which is most of what the redaction was for. A CN
// containing a space is the ordinary case, not the exotic one.
//
// The cost is over-redaction: prose immediately following a DN, with no comma
// between, is absorbed into the match. That is the correct direction for a
// scrubber to fail in — a log line that reads `bind failed for {account}` is
// still diagnosable, and one that reads `bind failed for {account} Smith` is a
// disclosure that looks like it was handled.
const DN_LIKE_RE = /\b(?:CN|OU|DC|UID)=[^,"'\n]+(?:\s*,\s*(?:CN|OU|DC|UID)=[^,"'\n]+)*/gi;
const GUID_LIKE_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * @param text            the message to scrub
 * @param externalUserId  the account's own id, when the caller knows it
 */
export function redactDirectoryIdentifiers(text: string, externalUserId?: string | null): string {
    let out = text;
    // The account's own id first and by exact match, because it is the one
    // identifier we can remove with certainty rather than by shape — and a
    // sAMAccountName carries no shape at all, so nothing else here would catch
    // it.
    const own = (externalUserId ?? '').trim();
    if (own.length >= 3) {
        const escaped = own.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        out = out.replace(new RegExp(escaped, 'gi'), '{account}');
    }
    return out
        .replace(DN_LIKE_RE, '{account}')
        .replace(EMAIL_LIKE_RE, '{account}')
        .replace(GUID_LIKE_RE, '{account}');
}
