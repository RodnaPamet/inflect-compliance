import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { getTranslations } from 'next-intl/server';
import { AppShell } from '@/components/layout/AppShell';
import { ClientProviders } from '@/components/layout/ClientProviders';
import { NavigationTracker } from '@/components/nav/NavigationTracker';
import { isAiFeatureEnabled, isAIRiskEnabled } from '@/app-layer/ai/risk-assessment/feature-gate';
import { AssistantLauncher } from '@/components/assistant/AssistantLauncher';
import { AssistantPageContextProvider } from '@/components/assistant/assistant-page-context';

/**
 * Tenant app layout — Server Component.
 *
 * Responsibilities:
 *   - Resolve session server-side (via auth())
 *   - Resolve translations server-side (via getTranslations())
 *   - Compose client wrappers with minimal, serializable props
 *
 * Client boundaries:
 *   - AppShell: layout chrome (sidebar, drawer, mobile bar, signOut)
 *   - ClientProviders: data-layer providers (QueryClientProvider)
 *
 * Tenant context (tenantId, role, permissions) is provided by the parent
 * TenantLayout at src/app/t/[tenantSlug]/layout.tsx.
 */
export default async function AppLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    // Resolve session server-side — no client-side useSession() needed
    const session = await auth();
    if (!session?.user) {
        redirect('/login');
    }

    // Resolve translations server-side — passed as plain string to AppShell
    const tc = await getTranslations('common');

    // ClientProviders sits inside AppShell so the page tree (children)
    // gets QueryClient + OnboardingTour context. AppShell's own
    // SidebarNav must NOT depend on either provider — the
    // calendar-badge hook (Epic 49) uses a plain fetch + useState
    // instead of useQuery for that reason.
    // ═══ WHERE THE LAUNCHER MOUNTS, AND WHY NOT IN AppShell ═══
    //
    // The roadmap says "mount it in AppShell.tsx, NOT AppShellFrame.tsx", for
    // two reasons: the frame's docstring is "layout, drawer state, collapse
    // state. No content" and it is written to be vendored byte-identical, so
    // product content must stay out of it; and the mount must be ONCE rather
    // than page by page.
    //
    // It mounts HERE instead, which keeps both of those and drops a cost the
    // roadmap could not have known about. `AppShell.tsx` sits inside a
    // SHARED_UI_ROOT, so importing `@/components/assistant/*` into it adds a
    // `domain-import` edge — and `tests/guards/shared-ui-coupling-ratchet`
    // counts those by population and deliberately "never opens the
    // classification map", so AppShell already being COUPLED does not exempt
    // it. The ratchet's own advice is to let the host supply the product part,
    // with AppShellFrame's render props as the worked example. This layout IS
    // that host: it is the product's server component, it already reads the
    // kill switch, and it wraps every page under `/t/<slug>/(app)` — so the
    // mount is still once and still not per-page.
    //
    // It also settles the org shell structurally rather than by a defaulted
    // prop: `src/app/org/[orgSlug]/layout.tsx` renders the same `AppShell` but
    // nothing mounts `TenantProvider` there, and `useTenantContext` THROWS
    // without it. An assistant on the org shell would crash the page, not
    // degrade. Mounting in the tenant layout means the org shell cannot get
    // one by accident.
    //
    // The provider wraps BOTH the shell and the launcher: pages inside report
    // their context, and the launcher outside reads it.
    // BOTH env switches, not just the per-feature one.
    //
    // ═══ THIS SHIPPED WRONG AND PRODUCTION PROVED IT ═══
    //
    // The first version checked `isAiFeatureEnabled('assistant')` alone. That
    // reads `AI_ASSISTANT_ENABLED`, which is absent in production and defaults
    // to true — so the launcher rendered on all 151 tenant app pages while
    // `AI_RISK_ENABLED=false` made `enforceFeatureGate` refuse every single
    // turn with "AI features are currently disabled".
    //
    // `AI_RISK_ENABLED` is predicate 1 of the gate's default-deny allowlist
    // and its own comment calls it the "kill switch for ALL AI features" — it
    // is checked for every `AiFeature`, the assistant included. Reasoning
    // carefully about the per-feature flag and never looking at the global one
    // is how a button that always errors reached every page.
    //
    // Which is exactly what the comment three lines down already warned
    // about. The rule was right and this call site did not implement it.
    const assistantEnabled = isAiFeatureEnabled('assistant') && isAIRiskEnabled();

    return (
        <AssistantPageContextProvider>
        <AppShell
            user={{
                name: session.user.name,
                email: session.user.email,
                image: session.user.image,
                memberships: session.user.memberships,
                // B4 — thread orgMemberships into the workspace
                // switcher. JWT field may be undefined for sessions
                // minted pre-B4 / for users with no org memberships;
                // an empty array reads as "no orgs section".
                orgMemberships: session.user.orgMemberships,
            }}
            appName={tc('appName')}
        >
            <ClientProviders userId={session.user.id ?? null}>
                <NavigationTracker />
                {children}
            </ClientProviders>
        </AppShell>
        {assistantEnabled ? <AssistantLauncher /> : null}
        </AssistantPageContextProvider>
    );
}
