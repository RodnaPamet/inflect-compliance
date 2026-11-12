/**
 * Public bot page — /bots/vendor-monitor (Web Bot Auth Phase 2, D-L1-6).
 *
 * UNAUTHENTICATED. The vendor monitor's User-Agent links here, so a site owner
 * who sees it in a log can read what it fetches, when, how its requests are
 * signed and how to opt out. Every fact on the page is read from the seam the
 * requests use (`vendorMonitorBotFacts` in `src/lib/web-bot-auth/bot-fetch.ts`),
 * so the page cannot describe a User-Agent or a key the bot does not send.
 *
 * It names the DEPLOYMENT's bot and nothing else: no tenant, no customer, no
 * monitored vendor (D-L1-5). It reads no database row.
 */
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Heading } from '@/components/ui/typography';
import { vendorMonitorBotFacts } from '@/lib/web-bot-auth/bot-fetch';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
    const t = await getTranslations('external.botPage');
    return { title: t('metaTitle'), robots: { index: true, follow: false } };
}

export default async function VendorMonitorBotPage() {
    const t = await getTranslations('external.botPage');
    const facts = vendorMonitorBotFacts();
    const optOut = `User-agent: ${facts.token}\nDisallow: /`;

    return (
        <main className="mx-auto max-w-3xl px-6 py-12 space-y-section">
            <header className="space-y-default">
                <Heading level={1}>{t('title')}</Heading>
                <p className="text-lg text-content-muted">{t('intro')}</p>
            </header>

            <section className="space-y-default" aria-labelledby="bot-identity">
                <Heading level={2} id="bot-identity">{t('identityHeading')}</Heading>
                <p className="text-content-default">{t('userAgentLabel')}</p>
                <pre className="overflow-x-auto rounded-md border border-border-subtle bg-bg-subtle p-3 text-sm text-content-default">
                    {facts.userAgent}
                </pre>
                <p className="text-content-muted">{t('robotsToken', { token: facts.token })}</p>
            </section>

            <section className="space-y-default" aria-labelledby="bot-fetches">
                <Heading level={2} id="bot-fetches">{t('fetchesHeading')}</Heading>
                <ul className="list-disc space-y-tight pl-6 text-content-default">
                    <li>{t('fetchesRobots')}</li>
                    <li>{t('fetchesHomepage')}</li>
                    <li>{t('fetchesBreach')}</li>
                </ul>
                <p className="text-content-muted">{t('schedule')}</p>
                <p className="text-content-muted">{t('origin')}</p>
            </section>

            <section className="space-y-default" aria-labelledby="bot-signatures">
                <Heading level={2} id="bot-signatures">{t('signaturesHeading')}</Heading>
                {facts.directoryUrl ? (
                    <>
                        <p className="text-content-default">{t('signaturesOn')}</p>
                        <p className="break-all text-sm text-content-default">
                            {t('directoryLabel')} <code>{facts.directoryUrl}</code>
                        </p>
                        {facts.keyid && (
                            <p className="break-all text-sm text-content-muted">
                                {t('keyidLabel')} <code>{facts.keyid}</code>
                            </p>
                        )}
                    </>
                ) : (
                    <p className="text-content-muted">{t('signaturesOff')}</p>
                )}
            </section>

            <section className="space-y-default" aria-labelledby="bot-opt-out">
                <Heading level={2} id="bot-opt-out">{t('optOutHeading')}</Heading>
                <p className="text-content-default">{t('optOutBody')}</p>
                <pre className="overflow-x-auto rounded-md border border-border-subtle bg-bg-subtle p-3 text-sm text-content-default">
                    {optOut}
                </pre>
                <p className="text-content-muted">{t('contact')}</p>
            </section>
        </main>
    );
}
