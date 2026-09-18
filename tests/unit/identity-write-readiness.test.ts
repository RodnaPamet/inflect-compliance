/**
 * Readiness must distinguish "no write bind" from "could not tell".
 *
 * The second is the one that matters. This subsystem has already shipped the
 * other shape once — an admin the read did not return was recorded as an
 * authoritative non-admin — so a connection whose secrets will not decrypt must
 * report UNKNOWN, never READ_BIND_ONLY.
 */
import {
    describeWriteReadiness,
    type IdentityWriteReadiness,
} from '@/app-layer/integrations/identity-write-readiness';

const r = (
    merged: Record<string, unknown> | null,
    config: Record<string, unknown> = {},
): IdentityWriteReadiness => describeWriteReadiness({ merged, config }).readiness;

describe('identity write readiness', () => {
    it('reports a dedicated write bind when one is configured', () => {
        expect(r({ writeBindDN: 'CN=svc-write,DC=x', bindDN: 'CN=svc-read,DC=x' })).toBe(
            'DEDICATED_WRITE_BIND',
        );
    });

    it('reports read-bind-only when the write bind is absent', () => {
        expect(r({ bindDN: 'CN=svc-read,DC=x' })).toBe('READ_BIND_ONLY');
    });

    it('treats an empty or whitespace write bind as absent, not present', () => {
        expect(r({ writeBindDN: '', bindDN: 'CN=svc-read,DC=x' })).toBe('READ_BIND_ONLY');
        expect(r({ writeBindDN: '   ', bindDN: 'CN=svc-read,DC=x' })).toBe('READ_BIND_ONLY');
    });

    it('UNDECRYPTABLE SECRETS ARE UNKNOWN, NOT "no write bind"', () => {
        // The load-bearing case. `writeBindDN` is a secret and `bindDN` is not,
        // so a failed decrypt leaves a connection that LOOKS read-bind-only.
        // Reporting that would be a failed read recorded as a positive
        // negative — the defect this subsystem was already bitten by.
        expect(r(null, { bindDN: 'CN=svc-read,DC=x' })).toBe('UNKNOWN');
        expect(r(null, {})).toBe('UNKNOWN');
    });

    it('never claims a write will succeed', () => {
        // Configuration is reportable; rights are not. AdminSDHolder re-stamps
        // protected-group ACLs hourly, so even a dedicated bind can be refused
        // on exactly the admin accounts an offboarding most wants disabled.
        const detail = describeWriteReadiness({
            merged: { writeBindDN: 'CN=svc-write,DC=x' },
            config: {},
        }).detail;
        expect(detail).toMatch(/only established by attempting/i);
        expect(detail).not.toMatch(/will succeed|is able to|guarantee/i);
    });

    it('names the consequence an operator can act on', () => {
        const detail = describeWriteReadiness({
            merged: { bindDN: 'CN=svc-read,DC=x' },
            config: {},
        }).detail;
        expect(detail).toMatch(/result 50/);
        expect(detail).toMatch(/not offboarded/i);
    });
});
