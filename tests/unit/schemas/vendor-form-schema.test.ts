/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Wave-B coverage — new-vendor form Zod schema (previously ~0%).
 *
 * Exercises defaults, the URL `.refine()` (empty + valid + invalid),
 * the YYYY-MM-DD `.refine()`, the data-access `.refine()`, the two
 * required enums, and the required `name` min/max branches.
 */
import { NewVendorFormSchema } from '@/lib/schemas/vendor-form';

describe('NewVendorFormSchema', () => {
    const minimalValid = {
        name: 'Acme',
        criticality: 'HIGH' as const,
    };

    it('applies all defaults for a minimal valid input', () => {
        const r = NewVendorFormSchema.parse(minimalValid);
        expect(r.name).toBe('Acme');
        expect(r.legalName).toBe('');
        expect(r.websiteUrl).toBe('');
        expect(r.domain).toBe('');
        expect(r.country).toBe('');
        expect(r.description).toBe('');
        expect(r.dataAccess).toBe('');
        expect(r.isSubprocessor).toBe(false);
        expect(r.nextReviewAt).toBe('');
        expect(r.contractRenewalAt).toBe('');
    });

    it('trims the name', () => {
        const r = NewVendorFormSchema.parse({ ...minimalValid, name: '  Acme Inc  ' });
        expect(r.name).toBe('Acme Inc');
    });

    it('parses a fully-populated valid input', () => {
        const r = NewVendorFormSchema.parse({
            name: 'Acme',
            legalName: 'Acme Incorporated',
            websiteUrl: 'https://acme.example.com',
            domain: 'acme.example.com',
            country: 'IE',
            description: 'A vendor',
            criticality: 'CRITICAL',
            dataAccess: 'HIGH',
            isSubprocessor: true,
            nextReviewAt: '2026-01-01',
            contractRenewalAt: '2026-12-31',
        });
        expect(r.websiteUrl).toBe('https://acme.example.com');
        expect(r.dataAccess).toBe('HIGH');
        expect(r.isSubprocessor).toBe(true);
    });

    // name required / min(1)
    it('rejects a missing name', () => {
        expect(
            NewVendorFormSchema.safeParse({
                criticality: 'LOW',
            } as any).success,
        ).toBe(false);
    });

    it('rejects an empty (whitespace) name after trim', () => {
        expect(NewVendorFormSchema.safeParse({ ...minimalValid, name: '   ' }).success).toBe(
            false,
        );
    });

    // name max(255)
    it('rejects an over-long name', () => {
        expect(
            NewVendorFormSchema.safeParse({ ...minimalValid, name: 'a'.repeat(256) }).success,
        ).toBe(false);
    });

    // criticality enum branch
    it('rejects an invalid criticality', () => {
        expect(
            NewVendorFormSchema.safeParse({ ...minimalValid, criticality: 'SEVERE' as any })
                .success,
        ).toBe(false);
    });

    // #4462 — the create form offers no status. A new vendor starts
    // ONBOARDING (the server default); ACTIVE needs a completed assessment
    // review, which a vendor that does not exist yet cannot have. The schema
    // used to accept ACTIVE, and the form sent it.
    it('carries no status, so the form can never send ACTIVE', () => {
        expect(Object.keys(NewVendorFormSchema.shape)).not.toContain('status');
        const r = NewVendorFormSchema.parse({ ...minimalValid, status: 'ACTIVE' } as any);
        expect(r).not.toHaveProperty('status');
    });

    // optionalUrl .refine — empty string passes (the early-return branch)
    it('accepts an empty websiteUrl', () => {
        const r = NewVendorFormSchema.parse({ ...minimalValid, websiteUrl: '' });
        expect(r.websiteUrl).toBe('');
    });

    // optionalUrl .refine — malformed URL fails
    it('rejects a malformed websiteUrl', () => {
        expect(
            NewVendorFormSchema.safeParse({ ...minimalValid, websiteUrl: 'not a url' })
                .success,
        ).toBe(false);
    });

    // optionalUrl max(1024)
    it('rejects an over-long websiteUrl', () => {
        expect(
            NewVendorFormSchema.safeParse({
                ...minimalValid,
                websiteUrl: 'https://e.com/' + 'a'.repeat(1024),
            }).success,
        ).toBe(false);
    });

    // data-access .refine — valid value
    it('accepts a valid dataAccess level', () => {
        const r = NewVendorFormSchema.parse({ ...minimalValid, dataAccess: 'MEDIUM' });
        expect(r.dataAccess).toBe('MEDIUM');
    });

    // data-access .refine — invalid value
    it('rejects an invalid dataAccess level', () => {
        expect(
            NewVendorFormSchema.safeParse({ ...minimalValid, dataAccess: 'EXTREME' }).success,
        ).toBe(false);
    });

    // optionalYmd .refine — valid + invalid
    it('accepts a valid YYYY-MM-DD nextReviewAt and rejects a bad format', () => {
        expect(
            NewVendorFormSchema.safeParse({ ...minimalValid, nextReviewAt: '2026-06-24' })
                .success,
        ).toBe(true);
        expect(
            NewVendorFormSchema.safeParse({ ...minimalValid, nextReviewAt: '24/06/2026' })
                .success,
        ).toBe(false);
    });

    it('rejects a bad contractRenewalAt format', () => {
        expect(
            NewVendorFormSchema.safeParse({ ...minimalValid, contractRenewalAt: 'soon' })
                .success,
        ).toBe(false);
    });

    // isSubprocessor type branch
    it('rejects a non-boolean isSubprocessor', () => {
        expect(
            NewVendorFormSchema.safeParse({ ...minimalValid, isSubprocessor: 'yes' as any })
                .success,
        ).toBe(false);
    });
});
