/**
 * The Microsoft Entra ID rules a session carries after sign-in (#4869):
 * whose email domains a workspace allows, and which workspaces the gate
 * refused this session.
 */
import { emailDomainAllowed, isRefusedByEntraGate, normaliseAllowedDomain } from '@/lib/auth/entra-gate-scope';

describe('emailDomainAllowed', () => {
    it('allows every domain when the list is empty or holds only blanks', () => {
        expect(emailDomainAllowed('ana@anywhere.example', [])).toBe(true);
        expect(emailDomainAllowed('ana@anywhere.example', ['', '  '])).toBe(true);
        expect(emailDomainAllowed(null, [])).toBe(true);
    });

    it('matches the whole domain, case insensitive, with the list as typed', () => {
        const list = [' Contoso.com ', '@fabrikam.com'];
        expect(emailDomainAllowed('ana@contoso.com', list)).toBe(true);
        expect(emailDomainAllowed('ANA@CONTOSO.COM', list)).toBe(true);
        expect(emailDomainAllowed('ivan@fabrikam.com', list)).toBe(true);
        expect(emailDomainAllowed('ana@mail.contoso.com', list)).toBe(false);
        expect(emailDomainAllowed('ana@contoso.com.evil.example', list)).toBe(false);
        expect(emailDomainAllowed('ana@notcontoso.com', list)).toBe(false);
    });

    it('reads the domain after the last @', () => {
        expect(emailDomainAllowed('"a@contoso.com"@evil.example', ['contoso.com'])).toBe(false);
    });

    it('refuses no email, and an email with no domain, when there is a list', () => {
        expect(emailDomainAllowed(null, ['contoso.com'])).toBe(false);
        expect(emailDomainAllowed(undefined, ['contoso.com'])).toBe(false);
        expect(emailDomainAllowed('ana', ['contoso.com'])).toBe(false);
        expect(emailDomainAllowed('ana@', ['contoso.com'])).toBe(false);
    });

    it('normalises a typed domain', () => {
        expect(normaliseAllowedDomain('  @@Contoso.COM ')).toBe('contoso.com');
    });
});

describe('isRefusedByEntraGate', () => {
    it('refuses only the workspaces the gate refused', () => {
        expect(isRefusedByEntraGate(['t1', 't2'], 't2')).toBe(true);
        expect(isRefusedByEntraGate(['t1'], 't2')).toBe(false);
    });

    it('refuses nothing for a session with no refusal, including one minted before the claim', () => {
        expect(isRefusedByEntraGate([], 't1')).toBe(false);
        expect(isRefusedByEntraGate(undefined, 't1')).toBe(false);
        expect(isRefusedByEntraGate(null, 't1')).toBe(false);
    });
});
