/**
 * Directory identifiers are not credentials, which is exactly why they were
 * missing from the log-redaction list: that list was "things that
 * authenticate", and an objectGUID does not. It identifies a PERSON, in a line
 * carrying no RLS, no tenant scope and no retention policy.
 */
import { redactDirectoryIdentifiers } from '@/lib/security/redact-directory-identifiers';

describe('redactDirectoryIdentifiers', () => {
    it('removes the account id the caller names, whatever shape it has', () => {
        // By exact match, because a sAMAccountName has no shape at all — no
        // pattern below would catch `svc-inflect`, and it is the identifier most
        // likely to appear in an LDAP error.
        const out = redactDirectoryIdentifiers('LDAP result 50 for svc-inflect', 'svc-inflect');
        expect(out).toBe('LDAP result 50 for {account}');
    });

    it('removes a GUID embedded in a provider message', () => {
        const out = redactDirectoryIdentifiers(
            'Entra refused to disable account 11111111-2222-3333-4444-555555555555.',
        );
        expect(out).not.toMatch(/1111/);
        expect(out).toContain('{account}');
    });

    it('removes a distinguished name whose CN contains a space', () => {
        // The regression this locks. The value class excluded whitespace, so
        // `CN=Alice Smith,OU=…` redacted to `{account} Smith,{account}` — the
        // surname survived, in notification bodies as well as logs, which is most
        // of what the redaction existed for. A CN with a space is the ordinary
        // case.
        const out = redactDirectoryIdentifiers('Refusing to disable CN=Alice Smith,OU=Staff,DC=corp,DC=example');
        expect(out).toBe('Refusing to disable {account}');
        expect(out).not.toMatch(/Smith/);
    });

    it('over-redacts rather than under-redacts when prose follows a DN', () => {
        // The price of allowing spaces: text right after a DN, with no comma
        // between, is absorbed. Asserted deliberately so the trade-off is a
        // decision on record and not a surprise — a scrubber that removes too
        // much is still diagnosable; one that leaves half a name is a disclosure
        // that looks handled.
        const out = redactDirectoryIdentifiers('bind failed for CN=Svc,DC=corp during the write');
        expect(out).toBe('bind failed for {account}');
    });

    it('removes an address', () => {
        expect(redactDirectoryIdentifiers('no mailbox for alice@corp.example')).toBe('no mailbox for {account}');
    });

    it('ignores an id too short to remove safely', () => {
        // A two-character id would match inside ordinary words and turn a
        // message into confetti. Two characters is not an identifier worth
        // protecting; a readable message is worth keeping.
        expect(redactDirectoryIdentifiers('an ordinary sentence', 'an')).toBe('an ordinary sentence');
    });

    it('treats the id as a literal, not as a pattern', () => {
        // An identifier containing regex metacharacters must not compile into
        // one. `CN=a.b(c)` as a pattern would match text that is not the id.
        const out = redactDirectoryIdentifiers('bind failed for a.b(c)+d', 'a.b(c)+d');
        expect(out).toBe('bind failed for {account}');
    });

    it('leaves a message with nothing to remove exactly as it was', () => {
        const msg = 'The directory closed the connection before the write completed.';
        expect(redactDirectoryIdentifiers(msg, 'ext-1')).toBe(msg);
    });
});
