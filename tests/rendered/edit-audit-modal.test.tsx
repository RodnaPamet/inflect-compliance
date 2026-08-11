/**
 * EditAuditModal — the write-back half of audit metadata.
 *
 * This component had **no test of any kind** before this suite, which is why
 * the request could sit here as a hand-rolled duplicate of `AuditsClient`'s
 * `auditWrite` mutation without anything noticing. The repo's worked example of
 * why that matters is the Assets status control: a guard asserted the schema
 * *mentioned* `status` while the control persisted nothing for months.
 *
 * So the load-bearing cases here are about what reaches the wire and what the
 * user is told, not about what renders:
 *
 *   - the exact body the save is called with (trimming, `null` clearing, the
 *     `YYYY-MM-DD` schedule format the API schema accepts)
 *   - a FAILED save must not look like a saved one — no close, no `onSaved`
 *   - the catalogues are read from the shared cache keys, and a failure of
 *     either leaves the edit usable rather than blocking it
 */

import React from 'react';
import { render, fireEvent, act, waitFor } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme-corp' }),
    useRouter: () => ({ push: jest.fn(), refresh: jest.fn(), replace: jest.fn() }),
    usePathname: () => '/t/acme-corp/audits',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    const cache = new Map<string, unknown>();
    const lookup = (ns: string, key: string) =>
        key
            .split('.')
            .reduce(
                (o: unknown, k) =>
                    o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined,
                (en as Record<string, unknown>)[ns],
            );
    const make = (ns: string) => {
        const t = ((key: string, params?: Record<string, unknown>) => {
            let v = lookup(ns, key);
            if (typeof v !== 'string') return key;
            if (params) {
                for (const [p, val] of Object.entries(params)) {
                    v = (v as string).replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
                }
            }
            return v as string;
        }) as ((key: string, params?: Record<string, unknown>) => string) & Record<string, unknown>;
        t.has = (key: string) => typeof lookup(ns, key) === 'string';
        t.raw = (key: string) => lookup(ns, key);
        t.rich = (key: string) => lookup(ns, key) ?? key;
        return t;
    };
    return {
        useTranslations: (ns: string) => {
            if (!cache.has(ns)) cache.set(ns, make(ns));
            return cache.get(ns);
        },
        useLocale: () => 'en',
    };
});

const toastMock = { success: jest.fn(), error: jest.fn(), warning: jest.fn(), info: jest.fn() };
jest.mock('@/components/ui/hooks', () => {
    const actual = jest.requireActual('@/components/ui/hooks');
    return { ...actual, useToast: () => toastMock };
});

import { SWRConfig } from 'swr';
import { EditAuditModal } from '@/app/t/[tenantSlug]/(app)/audits/EditAuditModal';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { getPermissionsForRole } from '@/lib/permissions';

const TENANT_CTX = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    tenantSlug: 'acme-corp',
    tenantName: 'Acme Corp',
    role: 'OWNER' as const,
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
    appPermissions: getPermissionsForRole('OWNER'),
};

const AUDIT = {
    id: 'aud-1',
    title: 'Q1 Internal Audit',
    auditScope: 'All ISMS controls',
    criteria: 'ISO 27001:2022',
    schedule: null as string | null,
    departments: 'Engineering',
    frameworkKey: 'ISO27001',
    auditCycleId: null as string | null,
};

let requestedUrls: string[] = [];
let failCatalogues = false;

function installFetch() {
    (global as unknown as { fetch: jest.Mock }).fetch = jest.fn(async (url: string) => {
        requestedUrls.push(url);
        if (failCatalogues) {
            return {
                ok: false,
                status: 503,
                json: async () => ({ error: { code: 'UPSTREAM', message: 'down' } }),
            };
        }
        if (url.endsWith('/frameworks')) {
            return {
                ok: true,
                json: async () => [
                    { key: 'ISO27001', name: 'ISO/IEC 27001' },
                    { key: 'NIS2', name: 'NIS2 Directive' },
                ],
            };
        }
        if (url.endsWith('/audits/cycles')) {
            return {
                ok: true,
                json: async () => [{ id: 'cyc-1', name: 'Surveillance 2026', frameworkKey: 'ISO27001' }],
            };
        }
        return { ok: true, json: async () => null };
    });
}

function mount(overrides: {
    open?: boolean;
    save?: jest.Mock;
    onSaved?: jest.Mock;
    setOpen?: jest.Mock;
} = {}) {
    const save = overrides.save ?? jest.fn().mockResolvedValue({ id: 'aud-1' });
    const onSaved = overrides.onSaved ?? jest.fn();
    const setOpen = overrides.setOpen ?? jest.fn();
    const utils = render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
            <TenantProvider value={TENANT_CTX}>
                <TooltipProvider>
                    <EditAuditModal
                        open={overrides.open ?? true}
                        setOpen={setOpen}
                        audit={AUDIT}
                        save={save}
                        onSaved={onSaved}
                    />
                </TooltipProvider>
            </TenantProvider>
        </SWRConfig>,
    );
    return { ...utils, save, onSaved, setOpen };
}

beforeEach(() => {
    requestedUrls = [];
    failCatalogues = false;
    toastMock.success.mockReset();
    toastMock.error.mockReset();
    installFetch();
});
afterEach(() => {
    delete (global as unknown as { fetch?: unknown }).fetch;
});

async function submit() {
    const form = document.querySelector('#edit-audit-form') as HTMLFormElement;
    await act(async () => {
        fireEvent.submit(form);
    });
}

describe('EditAuditModal — what reaches the wire', () => {
    it('sends the edited metadata, trimmed, and clears emptied fields with null', async () => {
        const { save } = mount();
        await waitFor(() => expect(document.querySelector('#edit-audit-title')).toBeTruthy());

        // Retitle with padding, and empty two optional fields.
        await act(async () => {
            fireEvent.change(document.querySelector('#edit-audit-title')!, {
                target: { value: '  Q2 Internal Audit  ' },
            });
            fireEvent.change(document.querySelector('#edit-audit-criteria')!, {
                target: { value: '   ' },
            });
            fireEvent.change(document.querySelector('#edit-audit-departments')!, {
                target: { value: '' },
            });
        });

        await submit();

        expect(save).toHaveBeenCalledTimes(1);
        const body = save.mock.calls[0][0];
        expect(body.title).toBe('Q2 Internal Audit');
        // Whitespace-only and empty optional fields CLEAR the column rather
        // than writing a blank string.
        expect(body.criteria).toBeNull();
        expect(body.departments).toBeNull();
        // Untouched fields still ride along — a PATCH-shaped omission here
        // would silently drop them, since the endpoint is a PUT.
        expect(body.scope).toBe('All ISMS controls');
        expect(body.frameworkKey).toBe('ISO27001');
        // Never set on this audit, and `null` is what clears it.
        expect(body.schedule).toBeNull();
        expect(body.auditCycleId).toBeNull();
    });

    it('closes and reports success only after the save resolves', async () => {
        const { save, onSaved, setOpen } = mount();
        await waitFor(() => expect(document.querySelector('#edit-audit-title')).toBeTruthy());

        await submit();

        expect(save).toHaveBeenCalled();
        expect(setOpen).toHaveBeenCalledWith(false);
        expect(onSaved).toHaveBeenCalledTimes(1);
        expect(toastMock.success).toHaveBeenCalled();
        expect(toastMock.error).not.toHaveBeenCalled();
    });

    it('a failed save does not look like a saved one', async () => {
        const save = jest.fn().mockRejectedValue(new Error('audit_write_failed'));
        const { onSaved, setOpen } = mount({ save });
        await waitFor(() => expect(document.querySelector('#edit-audit-title')).toBeTruthy());

        await submit();

        // The regression this guards: an operator who sees the modal close and
        // no error believes the edit landed. It must stay open, unreported.
        expect(setOpen).not.toHaveBeenCalledWith(false);
        expect(onSaved).not.toHaveBeenCalled();
        expect(toastMock.success).not.toHaveBeenCalled();
        expect(toastMock.error).toHaveBeenCalled();
        // And the form is still there to retry from, with the title intact.
        expect((document.querySelector('#edit-audit-title') as HTMLInputElement).value).toBe(
            'Q1 Internal Audit',
        );
    });

    it('does not submit an empty title', async () => {
        const { save } = mount();
        await waitFor(() => expect(document.querySelector('#edit-audit-title')).toBeTruthy());
        await act(async () => {
            fireEvent.change(document.querySelector('#edit-audit-title')!, {
                target: { value: '   ' },
            });
        });

        await submit();

        expect(save).not.toHaveBeenCalled();
    });
});

describe('EditAuditModal — the catalogue reads', () => {
    it('reads both catalogues from the shared tenant cache keys', async () => {
        mount();
        await waitFor(() => {
            expect(requestedUrls.some((u) => u.endsWith('/api/t/acme-corp/frameworks'))).toBe(true);
            expect(requestedUrls.some((u) => u.endsWith('/api/t/acme-corp/audits/cycles'))).toBe(
                true,
            );
        });
    });

    it('fetches nothing while closed', async () => {
        mount({ open: false });
        // The null key is what preserves the old `if (!open) return` — a closed
        // modal that still polled two catalogues would be a per-row cost on
        // every list render.
        await act(async () => {
            await Promise.resolve();
        });
        expect(requestedUrls).toHaveLength(0);
    });

    it('stays usable when a catalogue read fails', async () => {
        failCatalogues = true;
        const { save } = mount();
        await waitFor(() => expect(document.querySelector('#edit-audit-title')).toBeTruthy());

        // Fail-soft: the edit must still be submittable, because the catalogues
        // only populate two optional pickers.
        await submit();
        expect(save).toHaveBeenCalledTimes(1);
        expect(save.mock.calls[0][0].title).toBe('Q1 Internal Audit');
    });
});
