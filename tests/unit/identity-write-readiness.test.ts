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

/**
 * Every pre-existing case here is AD-shaped — bind DNs — so the helper says so
 * rather than letting a default decide. `provider` is required on the input for
 * that reason: the readiness vocabulary is not shared between directories, and
 * a default would describe one in the other's terms (#2843).
 */
const r = (
    merged: Record<string, unknown> | null,
    config: Record<string, unknown> = {},
    provider = 'active-directory',
): IdentityWriteReadiness => describeWriteReadiness({ provider, merged, config }).readiness;

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
            provider: 'active-directory',
            merged: { writeBindDN: 'CN=svc-write,DC=x' },
            config: {},
        }).detail;
        expect(detail).toMatch(/only established by attempting/i);
        expect(detail).not.toMatch(/will succeed|is able to|guarantee/i);
    });

    it('names the consequence an operator can act on', () => {
        const detail = describeWriteReadiness({
            provider: 'active-directory',
            merged: { bindDN: 'CN=svc-read,DC=x' },
            config: {},
        }).detail;
        expect(detail).toMatch(/result 50/);
        expect(detail).toMatch(/not offboarded/i);
    });
});

describe('Entra is not asked an LDAP question — #2843', () => {
    const entra = (merged: Record<string, unknown>) =>
        describeWriteReadiness({ provider: 'entra-id', merged, config: merged });

    it('does NOT report a working connection as having no credential', () => {
        // The defect verbatim. An Entra connection has neither writeBindDN nor
        // bindDN, so it fell through every arm to the last — which has no
        // condition — and was described as "No bind credential is configured
        // for this connection at all, so no write can be attempted". That went
        // into the DRY_RUN artefact the seven-day dwell exists to produce.
        const report = entra({ clientSecret: 'shh', writesEnabled: true });
        expect(report.readiness).toBe('APPLICATION_CREDENTIAL');
        expect(report.detail).not.toMatch(/no bind credential/i);
        expect(report.detail).not.toMatch(/no write can be attempted/i);
    });

    it('names writesEnabled, which is what actually gates an Entra write', () => {
        // A readiness report that omits the one flag standing between this
        // connection and a directory write is answering a question nobody asked.
        expect(entra({ clientSecret: 'shh', writesEnabled: true }).detail).toMatch(
            /allow offboarding writes/i,
        );
        const off = entra({ clientSecret: 'shh' });
        expect(off.readiness).toBe('APPLICATION_CREDENTIAL');
        expect(off.detail).toMatch(/OFF/);
        expect(off.detail).toMatch(/deliberate/i);
    });

    it('reports UNKNOWN when the credential cannot be read, never "none"', () => {
        // The same rule the bind arms already follow: an unread secret is not a
        // secret that is absent.
        const report = entra({ writesEnabled: true });
        expect(report.readiness).toBe('UNKNOWN');
        expect(report.detail).toMatch(/not a bind/i);
    });

    it('still gives AD the bind vocabulary — the positive control', () => {
        // Without this, an Entra arm that swallowed every provider would pass
        // every assertion above while destroying the AD report.
        expect(
            describeWriteReadiness({
                provider: 'active-directory',
                merged: { bindDN: 'CN=svc,DC=x' },
                config: {},
            }).readiness,
        ).toBe('READ_BIND_ONLY');
    });
});
