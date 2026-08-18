/**
 * H3-1 — the hardening is only as good as its visibility.
 *
 * The four preceding PRs each added a behaviour whose only signal was a log
 * line: throttles absorbed or deferred, credentials marked revoked, queue
 * retries suppressed, fan-out enqueues dropped, sync locks contended. None of
 * them was countable, so none was alertable.
 *
 * The assertion that matters most here is the CARDINALITY one. Okta and
 * SharePoint hosts are per-tenant, so labelling by raw host would create one
 * metric series per customer — the classic way to take down a metrics backend
 * with an observability change. That is a worse outage than the one the metric
 * was added to detect.
 */
import { providerLabelFor } from '@/app-layer/integrations/http-resilience';

describe('providerLabelFor — bounded cardinality', () => {
    it.each([
        ['https://acme.okta.com/api/v1/users', 'okta'],
        ['https://another-customer.okta.com/api/v1/users', 'okta'],
        ['https://dev-123.oktapreview.com/api/v1/users', 'okta'],
        ['https://graph.microsoft.com/v1.0/users', 'microsoft-graph'],
        ['https://login.microsoftonline.com/x/oauth2/v2.0/token', 'microsoft-graph'],
        ['https://contoso.sharepoint.com/sites/x/_api', 'sharepoint'],
        ['https://admin.googleapis.com/admin/directory/v1/users', 'google-workspace'],
        ['https://acme.bamboohr.com/api/gateway.php/acme/v1/employees', 'bamboohr'],
        ['https://api.github.com/repos/x/y', 'github'],
        ['https://wd2-impl-services1.workday.com/ccx/oauth2/acme/token', 'workday'],
        ['https://wd5-services1.workdaysuv.com/ccx/service/customreport2/acme/Roster', 'workday'],
        ['https://acme.service-now.com/api/now/table/change_request', 'servicenow'],
        ['https://agency.servicenowservices.com/api/now/table/change_request', 'servicenow'],
    ])('%s → %s', (url, label) => {
        expect(providerLabelFor(url)).toBe(label);
    });

    it('collapses PER-TENANT hosts onto one series', () => {
        // The whole point. A thousand Okta customers must be one series, not a
        // thousand — an unbounded label is how an observability change becomes
        // the outage.
        const labels = new Set(
            Array.from({ length: 1000 }, (_, i) =>
                providerLabelFor(`https://tenant-${i}.okta.com/api/v1/users`),
            ),
        );
        expect(labels).toEqual(new Set(['okta']));
    });

    it('falls back to ONE shared label for anything unrecognised', () => {
        // An unknown provider must cost one shared series, not one per host.
        const labels = new Set(
            Array.from({ length: 100 }, (_, i) => providerLabelFor(`https://host-${i}.example.com/x`)),
        );
        expect(labels).toEqual(new Set(['other']));
    });

    it('does not throw on a malformed URL', () => {
        // A metric label must never be able to fail the request it describes.
        expect(providerLabelFor('not a url')).toBe('other');
        expect(providerLabelFor('')).toBe('other');
    });

    it('matches on a host boundary, not a bare substring', () => {
        // `evil-okta.com.attacker.test` must not be labelled okta — and more
        // practically, a suffix check without the dot would mislabel unrelated
        // hosts and quietly merge two providers' series.
        expect(providerLabelFor('https://notokta.com/x')).toBe('other');
        expect(providerLabelFor('https://okta.com.attacker.test/x')).toBe('other');
        // Same trap for every entry added since. The label is metrics
        // cardinality, not authorisation, but a lookalike host silently
        // attributed to a real provider makes its error rate someone else's.
        expect(providerLabelFor('https://evil-workday.com/x')).toBe('other');
        expect(providerLabelFor('https://workday.com.attacker.test/x')).toBe('other');
        expect(providerLabelFor('https://evil-service-now.com/x')).toBe('other');
        expect(providerLabelFor('https://service-now.com.attacker.test/x')).toBe('other');
    });
});

describe('the metric surface exists and is callable', () => {
    // Smoke-level on purpose: these are fire-and-forget counters, and the
    // valuable assertions (label sets, when each fires) live with the code that
    // calls them. What matters here is that a missing OTel SDK cannot make a
    // metric call throw and take down the sync it was measuring.
    it('every recorder is a no-throw call', async () => {
        const m = await import('@/lib/observability/integration-metrics');

        expect(() => m.recordIntegrationThrottled({ provider: 'okta', outcome: 'absorbed' })).not.toThrow();
        expect(() => m.recordIntegrationThrottled({ provider: 'okta', outcome: 'deferred', retryAfterMs: 600_000 })).not.toThrow();
        expect(() => m.recordIntegrationHttpAttempts({ provider: 'okta', attempts: 2, outcome: 'ok' })).not.toThrow();
        expect(() => m.recordConnectionAuthState({ provider: 'okta', state: 'marked' })).not.toThrow();
        expect(() => m.recordConnectionAuthState({ provider: 'okta', state: 'recovered' })).not.toThrow();
        expect(() => m.recordQueueRetryBypass({ jobName: 'identity-sync', reason: 'terminal' })).not.toThrow();
        expect(() => m.recordDispatchEnqueueFailed({ component: 'identity-sync' })).not.toThrow();
        expect(() => m.recordSyncLock({ component: 'integrations', outcome: 'reaped' })).not.toThrow();
    });
});
