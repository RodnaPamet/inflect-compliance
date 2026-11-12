/**
 * Breach-intelligence providers.
 *
 * TestMode is the default (deterministic, CI-safe, zero network). The real
 * provider queries the public HIBP breach catalog (the free, keyless
 * `/api/v3/breaches` endpoint returns every breach with its affected
 * `Domain`) and filters by the vendor's domain — a keyless domain-appearance
 * check, NOT the paid HIBP domain-search API. It rides the shared
 * `fetchWithRetry` seam.
 */
import { env } from '@/env';
import { fetchWithRetry } from '@/lib/http/fetch-with-retry';
import { vendorMonitorUserAgent } from '@/lib/web-bot-auth/bot-fetch';
import type { BreachProvider, BreachSignal, BreachRecord } from './types';

/**
 * Deterministic stub — a domain "is breached" iff its hash is divisible by a
 * fixed modulus, so a given domain is stably breached-or-not across runs
 * (idempotency tests depend on this). No network, safe in CI.
 */
export class TestModeBreachProvider implements BreachProvider {
    readonly name = 'stub';

    async check(domain: string): Promise<BreachSignal> {
        const hash = simpleHash(domain);
        // ~1 in 4 domains are "breached" in the stub — enough that the seeded
        // integration fixtures can pick a breached + a clean domain by name.
        const breached = domain.includes('breached') || hash % 4 === 0;
        if (!breached) {
            return { source: this.name, breached: false, breaches: [] };
        }
        // Deterministic breach date derived from the hash (stable per domain).
        const year = 2020 + (hash % 5);
        const month = String(1 + (hash % 12)).padStart(2, '0');
        const date = `${year}-${month}-15`;
        return {
            source: this.name,
            breached: true,
            latestBreachAt: date,
            breaches: [{ name: `${capitalize(domain.split('.')[0])} data exposure`, date }],
        };
    }
}

/**
 * Real provider — public HIBP breach catalog, filtered by domain.
 * Keyless + cache-friendly; returns every catalogued breach whose `Domain`
 * matches the vendor's registrable domain.
 */
export class HibpDomainBreachProvider implements BreachProvider {
    readonly name = 'hibp-domain';
    private readonly endpoint = 'https://haveibeenpwned.com/api/v3/breaches';

    async check(domain: string): Promise<BreachSignal> {
        const target = domain.trim().toLowerCase();
        try {
            const res = await fetchWithRetry(
                `${this.endpoint}?domain=${encodeURIComponent(target)}`,
                // The bot's honest User-Agent, from the seam that owns it. Not
                // signed: this is a fixed API host on `fetchWithRetry`, not a
                // website the monitor crawls (Web Bot Auth Phase 2 signs the
                // TLS grade's requests; moving this one onto `botFetch` is open).
                { headers: { 'User-Agent': vendorMonitorUserAgent(env.APP_URL) } },
                { timeout: 8000, maxRetries: 3, retryDelay: 1000 },
            );
            const raw = (await res.json()) as Array<{ Name?: string; Title?: string; Domain?: string; BreachDate?: string }>;
            const hits: BreachRecord[] = raw
                .filter((b) => (b.Domain ?? '').toLowerCase() === target)
                .map((b) => ({ name: b.Title || b.Name || 'Unknown breach', date: b.BreachDate }));
            if (hits.length === 0) {
                return { source: this.name, breached: false, breaches: [] };
            }
            const latest = hits
                .map((h) => h.date)
                .filter((d): d is string => Boolean(d))
                .sort()
                .at(-1);
            return { source: this.name, breached: true, latestBreachAt: latest, breaches: hits };
        } catch {
            // Fail-open: a breach-feed outage must not fabricate a breach.
            return { source: this.name, breached: false, breaches: [] };
        }
    }
}

/**
 * Factory — defaults to the deterministic stub for safety (no env read here;
 * the caller passes the configured provider name so tests stay hermetic).
 */
export function getBreachProvider(providerName?: string): BreachProvider {
    if (providerName === 'hibp-domain') return new HibpDomainBreachProvider();
    return new TestModeBreachProvider();
}

function simpleHash(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return Math.abs(h);
}

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}
