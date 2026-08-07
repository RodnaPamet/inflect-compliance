import { PrismaClient, type ControlFrequency } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { createTenantWithOwner } from '@/app-layer/usecases/tenant-lifecycle';
import { hashForLookup } from '@/lib/security/encryption';
import { seedDefaultOrgDashboard } from '@/app-layer/usecases/org-dashboard-presets';

// Prisma 7 — adapter is required for PrismaClient construction.
const prisma = new PrismaClient({
    adapter: new PrismaPg({
        connectionString: process.env.DATABASE_URL ?? '',
    }),
});

async function main() {
    console.log('🌱 Seeding Inflect Compliance database...');

    // ─── Users (no role/tenantId — membership is sole authority) ───
    //
    // Pre-create the admin user BEFORE calling `createTenantWithOwner`
    // below. The usecase upserts the owner email (find-or-create); when
    // it finds an existing row it reuses it without overwriting fields.
    // Pre-creating with the password hash + name preserves credentials
    // login + the friendly display name on the OWNER user that the
    // production tenant-creation path otherwise leaves blank.
    // B9 — the demo password is overridable via SEED_PASSWORD; the
    // literal is the well-known local-dev default (prod users are
    // provisioned via OAuth, never this seed). Tests/CI leave it unset
    // so the default holds.
    const seedPassword = process.env.SEED_PASSWORD || 'password123';
    const pwd = await bcrypt.hash(seedPassword, 10);

    const admin = await prisma.user.upsert({
        where: { emailHash: hashForLookup('admin@acme.com') },
        update: {},
        create: { email: 'admin@acme.com', emailHash: hashForLookup('admin@acme.com'), passwordHash: pwd, name: 'Alice Admin' },
    });
    const editor = await prisma.user.upsert({
        where: { emailHash: hashForLookup('editor@acme.com') },
        update: {},
        create: { email: 'editor@acme.com', emailHash: hashForLookup('editor@acme.com'), passwordHash: pwd, name: 'Bob Editor' },
    });
    const reader = await prisma.user.upsert({
        where: { emailHash: hashForLookup('viewer@acme.com') },
        update: {},
        create: { email: 'viewer@acme.com', emailHash: hashForLookup('viewer@acme.com'), passwordHash: pwd, name: 'Carol Reader' },
    });
    const auditor = await prisma.user.upsert({
        where: { emailHash: hashForLookup('auditor@acme.com') },
        update: {},
        create: { email: 'auditor@acme.com', emailHash: hashForLookup('auditor@acme.com'), passwordHash: pwd, name: 'Dan Auditor' },
    });
    console.log('✅ Users created');

    // ─── Tenant (production path: createTenantWithOwner) ───
    //
    // GAP-07 alignment — the seed used to call `prisma.tenant.upsert`
    // directly + manually grant `role: 'ADMIN'`, which diverged from the
    // production tenant-creation path in two important ways:
    //
    //   1. No wrapped DEK was generated, so encrypted-field writes against
    //      the seed tenant silently fell back to v1 (global KEK) instead
    //      of v2 (per-tenant DEK) — masking real-world encryption shape
    //      in dev / E2E.
    //   2. The first membership was ADMIN, not OWNER — diverging from the
    //      role model where every tenant must have ≥ 1 ACTIVE OWNER
    //      (enforced by the `tenant_membership_last_owner_guard` trigger).
    //
    // Now the seed routes through the canonical
    // `createTenantWithOwner` usecase — same path used by the
    // platform-admin `POST /api/admin/tenants` route. Idempotent:
    // checked before calling so re-runs against an existing dev DB
    // don't error on the unique slug.
    let tenant = await prisma.tenant.findUnique({
        where: { slug: 'acme-corp' },
    });
    if (!tenant) {
        const result = await createTenantWithOwner({
            name: 'Acme Corp',
            slug: 'acme-corp',
            ownerEmail: admin.email,
            requestId: `seed-${randomUUID()}`,
        });
        tenant = await prisma.tenant.findUnique({
            where: { id: result.tenant.id },
        });
    }
    if (!tenant) {
        throw new Error('seed: failed to create or load acme-corp tenant');
    }

    // Apply the seed-only fields (`industry`, `maxRiskScale`) that
    // `createTenantWithOwner` doesn't take — purely cosmetic on the
    // dev tenant; production sets these via subsequent usecases.
    await prisma.tenant.update({
        where: { id: tenant.id },
        data: { industry: 'Technology', maxRiskScale: 5 },
    });
    console.log('✅ Tenant:', tenant.name, '(OWNER:', admin.email + ')');

    // ─── Tenant Memberships (non-owner roles) ───
    //
    // The OWNER membership for `admin` was created atomically inside
    // `createTenantWithOwner` above. Only the non-owner fixtures land
    // here.
    await prisma.tenantMembership.upsert({
        where: { tenantId_userId: { tenantId: tenant.id, userId: editor.id } },
        update: {},
        create: { tenantId: tenant.id, userId: editor.id, role: 'EDITOR' },
    });
    await prisma.tenantMembership.upsert({
        where: { tenantId_userId: { tenantId: tenant.id, userId: reader.id } },
        update: {},
        create: { tenantId: tenant.id, userId: reader.id, role: 'READER' },
    });
    await prisma.tenantMembership.upsert({
        where: { tenantId_userId: { tenantId: tenant.id, userId: auditor.id } },
        update: {},
        create: { tenantId: tenant.id, userId: auditor.id, role: 'AUDITOR' },
    });
    console.log('✅ Tenant memberships created');

    // ─── Hub-and-spoke organization layer (Epic O-1) ───
    //
    // Default org "Acme Corp" parented over the acme-corp tenant.
    // Demonstrates the full hub-and-spoke shape:
    //   1. Organization (parent) ← linked tenant
    //   2. CISO user as ORG_ADMIN
    //   3. Auto-provisioned AUDITOR membership in every child tenant,
    //      with `provisionedByOrgId` set so the (future) Epic O-2
    //      deprovision usecase can distinguish auto-created from
    //      manually-granted memberships.
    //
    // Slugs live in separate tables (Organization vs Tenant) so they
    // could share names; we deliberately use distinct slugs (`acme-org`
    // vs `acme-corp`) to avoid confusion in URL paths.
    //
    // Idempotent: every step uses upsert + the natural unique key.
    const organization = await prisma.organization.upsert({
        where: { slug: 'acme-org' },
        update: {},
        create: { name: 'Acme Corp', slug: 'acme-org' },
    });
    console.log('✅ Organization:', organization.name);

    // Link the existing acme-corp tenant to the org (no-op on re-run
    // because writing the same FK is idempotent).
    await prisma.tenant.update({
        where: { id: tenant.id },
        data: { organizationId: organization.id },
    });
    console.log('✅ Tenant linked to organization');

    // Seed the eight default org-dashboard widgets (KPI tiles +
    // donut + trend + tenant-coverage list + drill-down CTAs). The
    // ciso-portfolio E2E suite asserts on `#org-stat-coverage` etc.
    // — those id anchors come from the dispatched widgets, so the
    // dashboard must be pre-populated before the test runs.
    // Idempotent — short-circuits on any pre-existing widget row.
    const dashboardSeed = await seedDefaultOrgDashboard(prisma, organization.id);
    if (dashboardSeed.seeded) {
        console.log(`✅ Org dashboard widgets seeded (${dashboardSeed.created})`);
    }

    // CISO is the canonical ORG_ADMIN — sees every child tenant as
    // AUDITOR via the auto-provisioning fan-out below.
    const ciso = await prisma.user.upsert({
        where: { emailHash: hashForLookup('ciso@acme.com') },
        update: {},
        create: { email: 'ciso@acme.com', emailHash: hashForLookup('ciso@acme.com'), passwordHash: pwd, name: 'Carla CISO' },
    });

    await prisma.orgMembership.upsert({
        where: {
            organizationId_userId: {
                organizationId: organization.id,
                userId: ciso.id,
            },
        },
        update: {},
        create: {
            organizationId: organization.id,
            userId: ciso.id,
            role: 'ORG_ADMIN',
        },
    });
    console.log('✅ Org membership created (CISO as ORG_ADMIN)');

    // Auto-provisioned AUDITOR fan-out. In production this is the
    // job of `provisionOrgAdminToTenants` (Epic O-2); the seed
    // inlines the equivalent rows so the deployed dev/test DB has a
    // realistic post-provisioning state immediately. `provisionedByOrgId`
    // is set so the deprovision usecase will recognise these rows as
    // auto-created when ORG_ADMIN is removed.
    const orgTenants = await prisma.tenant.findMany({
        where: { organizationId: organization.id },
        select: { id: true },
    });
    let provisioned = 0;
    for (const t of orgTenants) {
        const result = await prisma.tenantMembership.upsert({
            where: { tenantId_userId: { tenantId: t.id, userId: ciso.id } },
            // Update path runs only if the row exists from a prior seed.
            // We refresh `provisionedByOrgId` so a pre-existing manual
            // membership of CISO would NOT be overwritten — only the
            // auto-created row carries the org id. (In practice this
            // seed creates the membership from scratch.)
            update: {},
            create: {
                tenantId: t.id,
                userId: ciso.id,
                role: 'AUDITOR',
                provisionedByOrgId: organization.id,
            },
        });
        if (result.provisionedByOrgId === organization.id) provisioned++;
    }
    console.log(
        `✅ Auto-provisioned AUDITOR memberships in ${provisioned} tenant(s)`,
    );

    // ─── Seed clauses ───
    const clauseData = [
        { number: '4', title: 'Context of the Organization', sortOrder: 4 },
        { number: '5', title: 'Leadership', sortOrder: 5 },
        { number: '6', title: 'Planning', sortOrder: 6 },
        { number: '7', title: 'Support', sortOrder: 7 },
        { number: '8', title: 'Operation', sortOrder: 8 },
        { number: '9', title: 'Performance Evaluation', sortOrder: 9 },
        { number: '10', title: 'Improvement', sortOrder: 10 },
    ];
    for (const c of clauseData) {
        await prisma.clause.upsert({ where: { number: c.number }, create: c, update: {} });
    }
    console.log('✅ Clauses seeded');

    // ─── Seed assets ───
    const assetCount = await prisma.asset.count({ where: { tenantId: tenant.id } });
    if (assetCount === 0) {
        await prisma.asset.create({ data: { tenantId: tenant.id, name: 'Customer Database', type: 'DATA_STORE', classification: 'Confidential', owner: 'IT', confidentiality: 5, integrity: 5, availability: 4 } });
        await prisma.asset.create({ data: { tenantId: tenant.id, name: 'Production Servers', type: 'SYSTEM', classification: 'Internal', owner: 'DevOps', confidentiality: 4, integrity: 5, availability: 5 } });
        await prisma.asset.create({ data: { tenantId: tenant.id, name: 'Email Service', type: 'SERVICE', classification: 'Internal', owner: 'IT', confidentiality: 3, integrity: 4, availability: 4 } });
    }
    console.log('✅ Assets seeded');

    // ─── Seed risk templates (global) ───
    const riskTemplates = [
        { title: 'Data Breach via SQL Injection', description: 'Risk of unauthorized data access through SQL injection attacks on input fields.', category: 'Cybersecurity', defaultLikelihood: 3, defaultImpact: 5, frameworkTag: 'ISO27001:A.8' },
        { title: 'Phishing Attack Compromise', description: 'Risk of credential theft through targeted phishing campaigns against employees.', category: 'Cybersecurity', defaultLikelihood: 4, defaultImpact: 4, frameworkTag: 'ISO27001:A.6' },
        { title: 'DDoS Service Disruption', description: 'Risk of service downtime caused by distributed denial-of-service attacks.', category: 'Cybersecurity', defaultLikelihood: 3, defaultImpact: 4, frameworkTag: 'ISO27001:A.8' },
        { title: 'Ransomware Infection', description: 'Risk of data encryption and extortion through ransomware malware.', category: 'Cybersecurity', defaultLikelihood: 3, defaultImpact: 5, frameworkTag: 'ISO27001:A.8' },
        { title: 'Insider Data Theft', description: 'Risk of sensitive data exfiltration by privileged internal users.', category: 'Cybersecurity', defaultLikelihood: 2, defaultImpact: 5, frameworkTag: 'ISO27001:A.6' },
        { title: 'Third-Party Vendor Breach', description: 'Risk of data exposure through compromised third-party service providers.', category: 'Vendor', defaultLikelihood: 3, defaultImpact: 4, frameworkTag: 'ISO27001:A.5' },
        { title: 'Physical Server Room Intrusion', description: 'Risk of unauthorized physical access to server rooms and data centers.', category: 'Physical', defaultLikelihood: 2, defaultImpact: 4, frameworkTag: 'ISO27001:A.7' },
        { title: 'Natural Disaster Impact', description: 'Risk of infrastructure damage from earthquakes, floods, or severe weather.', category: 'Physical', defaultLikelihood: 1, defaultImpact: 5, frameworkTag: 'ISO27001:A.7' },
        { title: 'GDPR Non-Compliance', description: 'Risk of penalties from failure to comply with EU data protection regulations.', category: 'Legal', defaultLikelihood: 2, defaultImpact: 5, frameworkTag: 'GDPR' },
        { title: 'License Violation', description: 'Risk of legal action from unauthorized use of third-party software licenses.', category: 'Legal', defaultLikelihood: 2, defaultImpact: 3, frameworkTag: null },
        { title: 'Key Personnel Departure', description: 'Risk of knowledge loss and operational disruption from critical staff turnover.', category: 'Operational', defaultLikelihood: 3, defaultImpact: 3, frameworkTag: 'ISO27001:A.6' },
        { title: 'Backup Failure', description: 'Risk of data loss due to failed or incomplete backup procedures.', category: 'Operational', defaultLikelihood: 2, defaultImpact: 5, frameworkTag: 'ISO27001:A.8' },
        { title: 'Cloud Misconfiguration', description: 'Risk of data exposure through improperly configured cloud services.', category: 'Cybersecurity', defaultLikelihood: 3, defaultImpact: 4, frameworkTag: 'ISO27001:A.8' },
        { title: 'Weak Access Controls', description: 'Risk of unauthorized system access due to inadequate authentication and authorization.', category: 'Cybersecurity', defaultLikelihood: 3, defaultImpact: 4, frameworkTag: 'ISO27001:A.8' },
        { title: 'Business Email Compromise', description: 'Risk of financial loss through fraudulent email impersonation of executives.', category: 'Cybersecurity', defaultLikelihood: 3, defaultImpact: 4, frameworkTag: 'ISO27001:A.5' },
    ];
    for (const t of riskTemplates) {
        await prisma.riskTemplate.upsert({
            where: { id: t.title.replace(/\s+/g, '-').toLowerCase().slice(0, 25) },
            create: t,
            update: {},
        });
    }
    console.log('✅ Risk templates seeded (15 templates)');

    // ─── Privacy risk templates (LINDDUN lens + OWASP Top 10 Privacy Risks) ───
    // P2: IC's risk register had only one privacy template ("GDPR Non-Compliance").
    // These add a privacy set, each carrying a LINDDUN privacy-threat
    // classification (src/lib/privacy/linddun.ts — LINDDUN © KU Leuven) and a
    // frameworkTag onto a NIST Privacy Framework subcategory. They ride the
    // SAME RiskTemplate → createRiskFromTemplate path as every other template.
    //
    // P3: the OWASP Top 10 Privacy Risks (© OWASP, CC-BY-SA) entries are
    // PARAPHRASED + attributed via the "[OWASP Top 10 Privacy Risks]" marker —
    // never the verbatim OWASP text.
    const privacyRiskTemplates: Array<{ id: string; title: string; description: string; category: string; defaultLikelihood: number; defaultImpact: number; frameworkTag: string; linddunCategories: string[] }> = [
        // P2 — LINDDUN-categorized privacy risks
        { id: 'priv-reidentification', title: 'Re-identification of De-identified Data', description: 'Individuals are singled out or re-identified from data that was meant to be anonymous or pseudonymous.', category: 'Privacy', defaultLikelihood: 2, defaultImpact: 5, frameworkTag: 'NIST-PF:CT.DP-P2', linddunCategories: ['I'] },
        { id: 'priv-excessive-linking', title: 'Excessive Data Linking', description: 'Records meant to stay separate are correlated, building a fuller profile of an individual than any single source intended.', category: 'Privacy', defaultLikelihood: 3, defaultImpact: 3, frameworkTag: 'NIST-PF:CT.DP-P1', linddunCategories: ['L'] },
        { id: 'priv-unlawful-processing', title: 'Unlawful or Non-compliant Processing', description: 'Personal data is processed without a valid legal basis or outside the bounds of applicable privacy regulation.', category: 'Privacy', defaultLikelihood: 2, defaultImpact: 5, frameworkTag: 'NIST-PF:GV.PO-P5', linddunCategories: ['NC'] },
        { id: 'priv-excessive-disclosure', title: 'Excessive Data Collection and Disclosure', description: 'More personal data is collected, stored, or shared than necessary for the stated purpose.', category: 'Privacy', defaultLikelihood: 3, defaultImpact: 4, frameworkTag: 'NIST-PF:CT.PO-P2', linddunCategories: ['DD'] },
        { id: 'priv-transparency-control', title: 'Lack of Transparency and Data-Subject Control', description: 'Individuals are unaware of how their data is processed and cannot exercise access, correction, deletion, or consent-withdrawal rights.', category: 'Privacy', defaultLikelihood: 3, defaultImpact: 3, frameworkTag: 'NIST-PF:CM.AW-P1', linddunCategories: ['U'] },
        { id: 'priv-covert-tracking', title: 'Covert Tracking and Behavioral Detection', description: 'An individual\'s presence or activity is inferred from observable side effects without their awareness.', category: 'Privacy', defaultLikelihood: 2, defaultImpact: 3, frameworkTag: 'NIST-PF:CT.DP-P3', linddunCategories: ['D'] },
        // P3 — OWASP Top 10 Privacy Risks (paraphrased + attributed)
        { id: 'owasp-priv-webapp-breach', title: 'Web Application Vulnerability Leading to Data Breach', description: 'A web-application security flaw is exploited to expose personal data. [OWASP Top 10 Privacy Risks]', category: 'Privacy', defaultLikelihood: 3, defaultImpact: 5, frameworkTag: 'NIST-PF:PR.PO-P10', linddunCategories: ['DD'] },
        { id: 'owasp-priv-operator-leak', title: 'Operator-Sided Data Leakage', description: 'Personal data leaks through the operator\'s own systems, staff, or processes rather than an external attack. [OWASP Top 10 Privacy Risks]', category: 'Privacy', defaultLikelihood: 3, defaultImpact: 5, frameworkTag: 'NIST-PF:PR.DS-P5', linddunCategories: ['DD'] },
        { id: 'owasp-priv-breach-response', title: 'Insufficient Data Breach Response', description: 'The organization detects, handles, or notifies individuals of a privacy breach too slowly or incompletely. [OWASP Top 10 Privacy Risks]', category: 'Privacy', defaultLikelihood: 2, defaultImpact: 4, frameworkTag: 'NIST-PF:CM.AW-P7', linddunCategories: ['NC'] },
        { id: 'owasp-priv-overbroad-consent', title: 'Overbroad or Bundled Consent', description: 'Consent is requested for everything at once rather than granular, purpose-specific choices. [OWASP Top 10 Privacy Risks]', category: 'Privacy', defaultLikelihood: 3, defaultImpact: 3, frameworkTag: 'NIST-PF:CT.PO-P1', linddunCategories: ['U'] },
        { id: 'owasp-priv-nontransparent', title: 'Non-Transparent Policies and Terms', description: 'Privacy policies and terms are unclear, hard to find, or do not reflect actual data practices. [OWASP Top 10 Privacy Risks]', category: 'Privacy', defaultLikelihood: 3, defaultImpact: 3, frameworkTag: 'NIST-PF:CM.PO-P1', linddunCategories: ['U'] },
        { id: 'owasp-priv-insufficient-deletion', title: 'Insufficient Deletion of Personal Data', description: 'Personal data is retained beyond its purpose or not fully deleted on request or expiry. [OWASP Top 10 Privacy Risks]', category: 'Privacy', defaultLikelihood: 3, defaultImpact: 4, frameworkTag: 'NIST-PF:CT.DM-P4', linddunCategories: ['DD'] },
        { id: 'owasp-priv-data-quality', title: 'Insufficient Data Quality', description: 'Outdated or inaccurate personal data leads to wrong decisions about individuals. [OWASP Top 10 Privacy Risks]', category: 'Privacy', defaultLikelihood: 2, defaultImpact: 3, frameworkTag: 'NIST-PF:CT.DM-P1', linddunCategories: ['NC'] },
        { id: 'owasp-priv-session-expiry', title: 'Missing or Insufficient Session Expiration', description: 'Sessions exposing personal data are not expired, leaving data accessible on shared or lost devices. [OWASP Top 10 Privacy Risks]', category: 'Privacy', defaultLikelihood: 2, defaultImpact: 3, frameworkTag: 'NIST-PF:PR.AC-P1', linddunCategories: ['DD'] },
        { id: 'owasp-priv-access-modify', title: 'Inability of Users to Access and Modify Data', description: 'Individuals cannot view, correct, or export the personal data held about them. [OWASP Top 10 Privacy Risks]', category: 'Privacy', defaultLikelihood: 2, defaultImpact: 3, frameworkTag: 'NIST-PF:CT.PO-P3', linddunCategories: ['U'] },
        { id: 'owasp-priv-unnecessary-collection', title: 'Collection of Data Not Required for the Primary Purpose', description: 'Personal data unrelated to the service\'s primary purpose is collected and retained. [OWASP Top 10 Privacy Risks]', category: 'Privacy', defaultLikelihood: 3, defaultImpact: 4, frameworkTag: 'NIST-PF:ID.IM-P6', linddunCategories: ['DD'] },
    ];
    for (const t of privacyRiskTemplates) {
        await prisma.riskTemplate.upsert({
            where: { id: t.id },
            create: t,
            update: { description: t.description, category: t.category, defaultLikelihood: t.defaultLikelihood, defaultImpact: t.defaultImpact, frameworkTag: t.frameworkTag, linddunCategories: t.linddunCategories },
        });
    }
    console.log(`✅ Privacy risk templates seeded (${privacyRiskTemplates.length} LINDDUN + OWASP templates)`);

    // ─── SSDF secure-development risk templates ───
    // Companion to the SSDF Starter Pack: the failure modes the SSDF practices
    // exist to prevent. frameworkTag 'SSDF', category 'Secure Development'. Ride
    // the SAME RiskTemplate → createRiskFromTemplate path as every other template.
    const ssdfRiskTemplates: Array<{ id: string; title: string; description: string; category: string; defaultLikelihood: number; defaultImpact: number; frameworkTag: string }> = [
        { id: 'ssdf-vulnerable-dependency', title: 'Vulnerable Dependency Shipped', description: 'A third-party component with a known vulnerability is included in a release because it was not caught by software composition analysis.', category: 'Secure Development', defaultLikelihood: 4, defaultImpact: 4, frameworkTag: 'SSDF' },
        { id: 'ssdf-unreviewed-merge', title: 'Unreviewed Code Merged to Production', description: 'Code reaches production without mandatory peer review, allowing defects or malicious changes to slip through.', category: 'Secure Development', defaultLikelihood: 3, defaultImpact: 4, frameworkTag: 'SSDF' },
        { id: 'ssdf-secrets-committed', title: 'Secrets Committed to Source Control', description: 'Credentials, tokens, or keys are committed to a repository and exposed to anyone with read access or in history.', category: 'Secure Development', defaultLikelihood: 3, defaultImpact: 5, frameworkTag: 'SSDF' },
        { id: 'ssdf-exploitable-vuln-released', title: 'Exploitable Vulnerability Released', description: 'A security defect reaches production because SAST/DAST and security testing were not performed or not gated in CI.', category: 'Secure Development', defaultLikelihood: 3, defaultImpact: 5, frameworkTag: 'SSDF' },
        { id: 'ssdf-compromised-pipeline', title: 'Compromised Build Pipeline', description: 'An attacker gains control of the CI/CD pipeline or build environment and injects malicious code into artifacts.', category: 'Secure Development', defaultLikelihood: 2, defaultImpact: 5, frameworkTag: 'SSDF' },
        { id: 'ssdf-tampered-artifact', title: 'Tampered or Unsigned Release Artifact', description: 'A release artifact is altered after build, or ships without integrity verification information, so acquirers cannot detect tampering.', category: 'Secure Development', defaultLikelihood: 2, defaultImpact: 5, frameworkTag: 'SSDF' },
        { id: 'ssdf-unpatched-disclosed-vuln', title: 'Unpatched Disclosed Vulnerability', description: 'A publicly disclosed vulnerability in the software is not remediated within its SLA because there is no coordinated vulnerability-disclosure and response process.', category: 'Secure Development', defaultLikelihood: 3, defaultImpact: 4, frameworkTag: 'SSDF' },
    ];
    for (const t of ssdfRiskTemplates) {
        await prisma.riskTemplate.upsert({
            where: { id: t.id },
            create: t,
            update: { description: t.description, category: t.category, defaultLikelihood: t.defaultLikelihood, defaultImpact: t.defaultImpact, frameworkTag: t.frameworkTag },
        });
    }
    console.log(`✅ SSDF risk templates seeded (${ssdfRiskTemplates.length} secure-development templates)`);

    // ─── CIS Controls v8 cyber-hygiene risk templates ───
    // Companion to the CIS v8 IG1 Starter Pack: the failure modes the essential
    // CIS safeguards exist to prevent. frameworkTag 'CIS', category 'Cyber
    // Hygiene'. Rides the shared RiskTemplate upsert path (no bespoke machinery).
    const cisRiskTemplates: Array<{ id: string; title: string; description: string; category: string; defaultLikelihood: number; defaultImpact: number; frameworkTag: string }> = [
        { id: 'cis-unmanaged-asset', title: 'Unmanaged Asset on the Network', description: 'A device that is not on the asset inventory connects to the network and receives access without going through onboarding or hardening.', category: 'Cyber Hygiene', defaultLikelihood: 4, defaultImpact: 3, frameworkTag: 'CIS' },
        { id: 'cis-unauthorized-software', title: 'Unauthorized or Unsupported Software in Use', description: 'Software that is unapproved or past end-of-life runs on enterprise assets, expanding the attack surface with no patch path.', category: 'Cyber Hygiene', defaultLikelihood: 4, defaultImpact: 3, frameworkTag: 'CIS' },
        { id: 'cis-unpatched-vulnerability', title: 'Unpatched Known Vulnerability Exploited', description: 'A known vulnerability is exploited because operating-system or application patches were not applied within the remediation window.', category: 'Cyber Hygiene', defaultLikelihood: 4, defaultImpact: 5, frameworkTag: 'CIS' },
        { id: 'cis-weak-authentication', title: 'Account Compromise via Weak Authentication', description: 'An account is taken over because it lacked multi-factor authentication or reused a weak password.', category: 'Cyber Hygiene', defaultLikelihood: 3, defaultImpact: 5, frameworkTag: 'CIS' },
        { id: 'cis-malware-infection', title: 'Malware Infection on Enterprise Assets', description: 'Malicious code executes on assets due to missing anti-malware defenses, autorun exposure, or unfiltered email and web content.', category: 'Cyber Hygiene', defaultLikelihood: 3, defaultImpact: 4, frameworkTag: 'CIS' },
        { id: 'cis-unrecoverable-data', title: 'Unrecoverable Data After Incident', description: 'Data cannot be restored after ransomware or failure because backups were missing, unprotected, or never tested.', category: 'Cyber Hygiene', defaultLikelihood: 2, defaultImpact: 5, frameworkTag: 'CIS' },
        { id: 'cis-sensitive-data-exposure', title: 'Sensitive Data Exposure', description: 'Sensitive information is disclosed because it was not classified, access-controlled, or encrypted at rest and in transit.', category: 'Cyber Hygiene', defaultLikelihood: 3, defaultImpact: 5, frameworkTag: 'CIS' },
        { id: 'cis-untrained-workforce', title: 'Successful Social-Engineering Attack', description: 'A phishing or social-engineering attack succeeds because staff were not trained to recognize and report it.', category: 'Cyber Hygiene', defaultLikelihood: 4, defaultImpact: 4, frameworkTag: 'CIS' },
    ];
    for (const t of cisRiskTemplates) {
        await prisma.riskTemplate.upsert({
            where: { id: t.id },
            create: t,
            update: { description: t.description, category: t.category, defaultLikelihood: t.defaultLikelihood, defaultImpact: t.defaultImpact, frameworkTag: t.frameworkTag },
        });
    }
    console.log(`✅ CIS risk templates seeded (${cisRiskTemplates.length} cyber-hygiene templates)`);

    // ─── OWASP ASVS application-security risk templates ───
    // Companion to the ASVS 4.0.3 L1 Starter Pack: the failure modes the Level 1
    // verification requirements exist to prevent. frameworkTag 'ASVS', category
    // 'Application Security'. Shared RiskTemplate path.
    const asvsRiskTemplates: Array<{ id: string; title: string; description: string; category: string; defaultLikelihood: number; defaultImpact: number; frameworkTag: string }> = [
        { id: 'asvs-injection', title: 'Injection Vulnerability Exploited', description: 'Untrusted input reaches an interpreter (SQL, OS command, LDAP, template) because it was not parameterized or validated, letting an attacker execute unintended commands.', category: 'Application Security', defaultLikelihood: 4, defaultImpact: 5, frameworkTag: 'ASVS' },
        { id: 'asvs-broken-authentication', title: 'Broken Authentication', description: 'Weak password handling, missing anti-automation, or poor recovery flows let an attacker take over user accounts.', category: 'Application Security', defaultLikelihood: 3, defaultImpact: 5, frameworkTag: 'ASVS' },
        { id: 'asvs-broken-access-control', title: 'Broken Access Control', description: 'Authorization is enforced only client-side or object references are not checked, so a user can reach data or actions outside their permission.', category: 'Application Security', defaultLikelihood: 4, defaultImpact: 5, frameworkTag: 'ASVS' },
        { id: 'asvs-xss', title: 'Cross-Site Scripting', description: 'User-supplied content is rendered without context-aware output encoding, allowing script execution in the browser of another user.', category: 'Application Security', defaultLikelihood: 4, defaultImpact: 4, frameworkTag: 'ASVS' },
        { id: 'asvs-sensitive-data-exposure', title: 'Sensitive Data Exposure', description: 'Sensitive data is transmitted or stored without adequate encryption, or leaks through caching, logs, or client-side storage.', category: 'Application Security', defaultLikelihood: 3, defaultImpact: 5, frameworkTag: 'ASVS' },
        { id: 'asvs-security-misconfiguration', title: 'Security Misconfiguration', description: 'Missing security headers, verbose errors, debug modes, or permissive CORS leave the application exposed in production.', category: 'Application Security', defaultLikelihood: 4, defaultImpact: 4, frameworkTag: 'ASVS' },
        { id: 'asvs-vulnerable-components', title: 'Vulnerable and Outdated Components', description: 'A known-vulnerable dependency is exploited because components were not kept current or their integrity was not verified.', category: 'Application Security', defaultLikelihood: 4, defaultImpact: 5, frameworkTag: 'ASVS' },
        { id: 'asvs-business-logic-abuse', title: 'Business Logic Abuse', description: 'Workflow steps, timing, or quantity limits are not enforced server-side, letting an attacker automate or bypass business rules.', category: 'Application Security', defaultLikelihood: 3, defaultImpact: 4, frameworkTag: 'ASVS' },
    ];
    for (const t of asvsRiskTemplates) {
        await prisma.riskTemplate.upsert({
            where: { id: t.id },
            create: t,
            update: { description: t.description, category: t.category, defaultLikelihood: t.defaultLikelihood, defaultImpact: t.defaultImpact, frameworkTag: t.frameworkTag },
        });
    }
    console.log(`✅ ASVS risk templates seeded (${asvsRiskTemplates.length} application-security templates)`);

    // ─── Seed risks (tenant-wide) ───
    const riskCount = await prisma.risk.count({ where: { tenantId: tenant.id } });
    if (riskCount === 0) {
        await prisma.risk.create({ data: { tenantId: tenant.id, title: 'Data Breach via SQL Injection', description: 'Unvalidated input fields in production APIs', category: 'Cybersecurity', threat: 'External attacker', vulnerability: 'Unvalidated input fields', impact: 5, likelihood: 3, score: 15, inherentScore: 15, status: 'OPEN', treatment: 'TREAT', treatmentOwner: 'DevOps', createdByUserId: admin.id } });
        await prisma.risk.create({ data: { tenantId: tenant.id, title: 'Server Downtime from DDoS', description: 'Production servers vulnerable to volumetric attacks', category: 'Cybersecurity', threat: 'DDoS attack', vulnerability: 'No rate limiting', impact: 4, likelihood: 3, score: 12, inherentScore: 12, status: 'MITIGATING', treatment: 'TREAT', treatmentOwner: 'Infrastructure', createdByUserId: admin.id } });
        await prisma.risk.create({ data: { tenantId: tenant.id, title: 'Phishing Compromise', description: 'Staff susceptible to social engineering attacks', category: 'Cybersecurity', threat: 'Social engineering', vulnerability: 'Lack of awareness training', impact: 4, likelihood: 4, score: 16, inherentScore: 16, status: 'OPEN', treatment: 'TREAT', treatmentOwner: 'HR', createdByUserId: admin.id } });
        await prisma.risk.create({ data: { tenantId: tenant.id, title: 'Dev Environment Data Leak', description: 'Sensitive production data used in dev testing', category: 'Operational', threat: 'Data leak', vulnerability: 'No data masking in dev', impact: 3, likelihood: 3, score: 9, inherentScore: 9, status: 'OPEN', createdByUserId: editor.id } });
    }
    console.log('✅ Risks seeded (tenant-wide)');

    // ─── Seed controls ───
    const sampleControls = [
        { annexId: 'A.5.1', name: 'Information Security Policies', objective: 'Ensure management direction and support for information security.', status: 'IMPLEMENTED' },
        { annexId: 'A.5.2', name: 'Information Security Roles', objective: 'Establish defined roles and responsibilities.', status: 'IMPLEMENTING' },
        { annexId: 'A.8.1', name: 'User Endpoint Devices', objective: 'Protect information on user endpoint devices.', status: 'IMPLEMENTED' },
        { annexId: 'A.8.9', name: 'Configuration Management', objective: 'Ensure correct and secure configuration of systems.', status: 'PLANNED' },
    ];
    for (const c of sampleControls) {
        const existing = await prisma.control.findFirst({ where: { annexId: c.annexId, tenantId: tenant.id } });
        if (!existing) {
            await prisma.control.create({ data: { tenantId: tenant.id, ...c } });
        } else {
            // Reset applicability to APPLICABLE so the pill-toggle E2E
            // always finds a "Yes" row regardless of prior mutations.
            await prisma.control.update({
                where: { id: existing.id },
                data: {
                    applicability: 'APPLICABLE',
                    applicabilityJustification: null,
                    applicabilityDecidedByUserId: null,
                    applicabilityDecidedAt: null,
                },
            });
        }
    }
    console.log('✅ Controls seeded (applicability reset to APPLICABLE)');

    // ─── Policy Templates ───
    const policyTemplates = [
        // NOTE: the thin one-paragraph "starter stubs" (Information Security,
        // Access Control, Data Classification, Acceptable Use, Incident
        // Response, Business Continuity, Risk Management, Change Management,
        // Physical Security, HR Security, Third-Party, Logging) were removed —
        // they rendered as near-empty "5-6 row" documents. The full versions
        // of those topics come from the Expanded starter set below, the
        // flagship HTML templates, the ciso-toolkit library, and the imported
        // library (which supersedes overlaps by title).

        // ─── Expanded starter set ───────────────────────────────────────
        // ORIGINAL content authored for Inflect. The topic coverage was
        // informed by the public JupiterOne security-policy-templates
        // domain list (CC-BY-SA-4.0) used ONLY as a subject checklist — no
        // text was copied; these are independent originals, consistent with
        // the "ORIGINAL content" stance in src/data/policy-templates.ts. See
        // docs/implementation-notes/2026-06-26-policy-template-expansion.md.
        { title: 'Asset Management Policy', category: 'Operations', tags: 'asset,inventory', contentText: `# Asset Management Policy

## Purpose
Ensure information assets are identified, owned, classified, and handled appropriately throughout their lifecycle.

## Scope
All hardware, software, data, and cloud resources used to process organizational information.

## Policy Statements
1. A current inventory of information assets is maintained, with an assigned owner for each.
2. Assets are classified by sensitivity and handled per their classification.
3. Acceptable handling, transfer, and return rules apply to all assets.
4. Assets are securely sanitized or destroyed at end of life, with disposal recorded.

## Review
Reviewed at least annually and after significant change.` },

        { title: 'Vulnerability Management Policy', category: 'Technical', tags: 'vulnerability,patching', contentText: `# Vulnerability Management Policy

## Purpose
Identify, evaluate, and remediate technical vulnerabilities before they can be exploited.

## Scope
All systems, applications, containers, and dependencies in the organization's environments.

## Policy Statements
1. Authenticated vulnerability scanning runs on a defined, recurring schedule.
2. Findings are risk-ranked; remediation timelines are tied to severity (e.g. critical promptly, high within a defined window).
3. Patch and configuration management keep systems on supported, current versions.
4. Exceptions are time-bound, justified, and approved by a risk owner.

## Review
Reviewed at least annually.` },

        { title: 'Secure Development (SDLC) Policy', category: 'Technical', tags: 'sdlc,development', contentText: `# Secure Development (SDLC) Policy

## Purpose
Build security into software across the development lifecycle.

## Scope
All in-house and contracted software development and the pipelines that build and deploy it.

## Policy Statements
1. Security requirements are defined alongside functional requirements.
2. Code is peer-reviewed; automated SAST, dependency, and secret scanning gate the pipeline.
3. Environments are separated; production data is not used in development or test without protection.
4. Releases are versioned and traceable, with the ability to roll back.

## Review
Reviewed at least annually.` },

        { title: 'Data Protection & Encryption Policy', category: 'Technical', tags: 'encryption,data-protection', contentText: `# Data Protection & Encryption Policy

## Purpose
Protect the confidentiality and integrity of data at rest and in transit.

## Scope
All systems that store or transmit confidential or restricted information.

## Policy Statements
1. Confidential and restricted data is encrypted at rest using current, strong algorithms.
2. Data in transit over untrusted networks is encrypted (e.g. TLS).
3. Cryptographic keys are generated, stored, rotated, and revoked under a defined key-management process; keys are never stored alongside the data they protect.
4. Removable media and endpoints holding sensitive data use full-disk or volume encryption.

## Review
Reviewed at least annually.` },

        { title: 'Mobile Device & BYOD Policy', category: 'Technical', tags: 'mobile,byod,mdm', contentText: `# Mobile Device & BYOD Policy

## Purpose
Reduce the risk of mobile and personally-owned devices accessing organizational data.

## Scope
All mobile devices — corporate-owned or personal (BYOD) — used to access organizational systems or data.

## Policy Statements
1. Devices accessing organizational data are enrolled in management and meet a minimum security baseline (screen lock, encryption, current OS).
2. Organizational data is containerized where feasible and can be remotely wiped on loss, theft, or offboarding.
3. Lost or stolen devices are reported promptly.
4. Jailbroken/rooted devices are not permitted to access organizational data.

## Review
Reviewed at least annually.` },

        { title: 'Privacy Policy', category: 'Core', tags: 'privacy,data-subject', contentText: `# Privacy Policy

## Purpose
Govern the lawful, fair, and transparent processing of personal data.

## Scope
All processing of personal data by the organization, on any system or service.

## Policy Statements
1. Personal data is collected for specified, legitimate purposes and limited to what is necessary.
2. A lawful basis is established for each processing activity, and processing is recorded.
3. Data-subject rights (access, rectification, erasure, portability, objection) are supported and honored within required timeframes.
4. Personal data is retained only as long as necessary and then securely disposed of.

## Review
Reviewed at least annually and on regulatory change.` },

        { title: 'Threat Intelligence & Management Policy', category: 'Operations', tags: 'threat,intelligence', contentText: `# Threat Intelligence & Management Policy

## Purpose
Anticipate, detect, and respond to threats relevant to the organization.

## Scope
All systems, data, and personnel that could be targeted by security threats.

## Policy Statements
1. Relevant threat sources are monitored and assessed for applicability.
2. Actionable intelligence informs detection rules, controls, and risk decisions.
3. Indicators of compromise are tracked and fed into monitoring and incident response.
4. Threat findings are reviewed periodically with stakeholders.

## Review
Reviewed at least annually.` },

        { title: 'Security Governance Policy', category: 'Core', tags: 'governance,program', contentText: `# Security Governance Policy

## Purpose
Establish accountability, structure, and oversight for the information security program.

## Scope
The organization's overall security program and the roles that govern it.

## Policy Statements
1. Leadership owns and supports the security program and allocates adequate resources.
2. Security roles and responsibilities are defined and assigned.
3. Objectives and metrics are set, measured, and reported to leadership.
4. The program is reviewed at planned intervals and improved based on results, incidents, and change.

## Review
Reviewed at least annually.` },

        { title: 'Data Retention & Disposal Policy', category: 'Core', tags: 'data,retention,disposal', contentText: `# Data Retention & Disposal Policy

## Purpose
Retain information only as long as required and dispose of it securely.

## Scope
All organizational records and data, in any format or location.

## Policy Statements
1. Retention periods are defined per data type based on legal, regulatory, and business need.
2. Data is not kept beyond its retention period unless under a legal hold.
3. Disposal uses methods appropriate to the media and sensitivity, and is recorded.
4. Retention and disposal apply equally to backups and third-party-held data.

## Review
Reviewed at least annually.` },

        { title: 'Data Breach Notification Policy', category: 'Operations', tags: 'breach,notification', contentText: `# Data Breach Notification Policy

## Purpose
Ensure breaches of personal or sensitive data are assessed and notified correctly and promptly.

## Scope
Any confirmed or suspected breach affecting personal or confidential data.

## Policy Statements
1. Suspected breaches are escalated immediately to the response team and assessed for impact.
2. Notifications to regulators and affected individuals are made within applicable legal deadlines.
3. Breach details, decisions, and timelines are documented.
4. Post-breach reviews drive corrective and preventive actions.

## Review
Reviewed at least annually.` },

        { title: 'Compliance & Audit Management Policy', category: 'Core', tags: 'compliance,audit', contentText: `# Compliance & Audit Management Policy

## Purpose
Maintain compliance with legal, regulatory, and contractual obligations and verify controls through audit.

## Scope
All applicable obligations and the controls implemented to meet them.

## Policy Statements
1. Applicable legal, regulatory, and contractual requirements are identified and tracked.
2. Controls are mapped to requirements and assessed for effectiveness.
3. Internal and external audits are planned, conducted, and their findings remediated.
4. Evidence of compliance is collected and retained.

## Review
Reviewed at least annually.` },

        { title: 'Policy Management Policy', category: 'Core', tags: 'policy,governance', contentText: `# Policy Management Policy

## Purpose
Govern how security policies are created, approved, communicated, and maintained.

## Scope
All information security policies, standards, and procedures.

## Policy Statements
1. Policies have an owner and follow a defined approval workflow before publication.
2. Approved policies are communicated and made accessible to affected personnel.
3. Personnel acknowledge applicable policies, and acknowledgements are recorded.
4. Policies are reviewed on a defined cadence and on significant change, with versions retained.

## Review
Reviewed at least annually.` },

        { title: 'Cloud Security Policy', category: 'Technical', tags: 'cloud,saas', contentText: `# Cloud Security Policy

## Purpose
Securely adopt and operate cloud and SaaS services.

## Scope
All cloud infrastructure, platform, and software services used by the organization.

## Policy Statements
1. Cloud services are risk-assessed and approved before use; shared-responsibility boundaries are understood.
2. Configurations follow secure baselines and are monitored for drift.
3. Access to cloud consoles uses least privilege and strong authentication.
4. Cloud data is classified, protected, and recoverable consistent with other policies.

## Review
Reviewed at least annually.` },
    ];
    for (const tmpl of policyTemplates) {
        const existing = await prisma.policyTemplate.findFirst({ where: { title: tmpl.title } });
        if (!existing) {
            await prisma.policyTemplate.create({ data: tmpl });
        }
    }

    // ─── Flagship full-text HTML templates ───
    // Rich, ready-to-publish documents (cover title → page break →
    // section headings → real prose). Authored as HTML so the policy
    // view auto-renders a Table of Contents from the headings and the
    // `<hr>` renders as a page break (on screen + in PDF export). These
    // UPSERT their content — re-seeding upgrades the matching thin
    // starter to the full document.
    const flagshipTemplates: Array<{
        title: string; category: string; tags: string; contentType: 'HTML'; contentText: string;
    }> = [
        {
            title: 'Acceptable Use Policy',
            category: 'HR',
            tags: 'acceptable-use,hr,information-security',
            contentType: 'HTML',
            contentText:
                '<h1>Acceptable Use Policy</h1>' +
                '<hr>' +
                '<h2>Purpose and Scope</h2>' +
                '<p>This policy defines the acceptable use of the organisation’s information, information assets, and IT facilities. It applies to all employees, contractors, and third parties who access organisational systems or data, on any device, whether on or off premises.</p>' +
                '<h2>Introduction</h2>' +
                '<p>Information and the systems that process it are valuable assets. Used appropriately they enable the business; used carelessly they expose the organisation to legal, financial, and reputational harm. Every user shares responsibility for protecting these assets and must act in line with this policy at all times.</p>' +
                '<h2>Business use of information assets</h2>' +
                '<p>Information assets are provided primarily for legitimate business purposes. Users must access only the information required to perform their role, must not bypass or disable security controls, and must protect their authentication credentials. Loss, theft, or suspected compromise of any asset must be reported to IT without delay.</p>' +
                '<h2>Personal use of information assets</h2>' +
                '<p>Limited, reasonable personal use is permitted provided it does not interfere with work, consume disproportionate resources, incur cost to the organisation, or breach any policy or law. The organisation may monitor use of its systems in accordance with applicable law.</p>' +
                '<h2>Use of email and other electronic communication</h2>' +
                '<p>Email and messaging must be used professionally. Users must not send confidential information to unauthorised recipients, open unexpected attachments or links, or use organisational addresses for personal registrations, spam, or unlawful content. Suspected phishing must be reported, not actioned.</p>' +
                '<h2>Use of internet</h2>' +
                '<p>Internet access is provided for business use. Users must not access, store, or distribute material that is illegal, offensive, or infringes intellectual-property rights, and must not download software or services that have not been approved by IT.</p>' +
                '<h2>Use of social media</h2>' +
                '<p>When identifiable as associated with the organisation, users must be respectful, must not disclose confidential or personal information, and must not speak on the organisation’s behalf unless explicitly authorised to do so.</p>' +
                '<h2>Clear desk policy</h2>' +
                '<p>Sensitive information in physical form must not be left unattended. Documents must be secured when away from the desk and at the end of the working day, and disposed of via approved confidential-waste channels.</p>' +
                '<h2>Clear screen policy</h2>' +
                '<p>Devices must be locked when unattended and configured to lock automatically after a short period of inactivity. Sensitive information must not be displayed where unauthorised people can view it.</p>' +
                '<h2>Compliance</h2>' +
                '<p>Breaches of this policy may result in withdrawal of access and disciplinary action up to and including termination, and may be reported to the relevant authorities where the law has been broken. Questions about this policy should be raised with the information security team.</p>',
        },
    ];
    for (const tmpl of flagshipTemplates) {
        const existing = await prisma.policyTemplate.findFirst({ where: { title: tmpl.title } });
        if (existing) {
            await prisma.policyTemplate.update({
                where: { id: existing.id },
                data: { category: tmpl.category, tags: tmpl.tags, contentType: tmpl.contentType, contentText: tmpl.contentText },
            });
        } else {
            await prisma.policyTemplate.create({ data: tmpl });
        }
    }
    console.log('✅ Policy Templates seeded');

    // ─── ciso-toolkit ISMS policy library (MIT — imported content) ───
    // 15 ISO 27001 + NIS2 policy templates from the pinned fixture. Upsert
    // by externalRef OR title (idempotent + re-syncable) so the rich
    // toolkit versions SUPERSEDE the two thin hand-written overlaps
    // ('Information Security Policy', 'Risk Management Policy') by title,
    // while the other 13 are added new. Attribution rides the `source`
    // column (see prisma/fixtures/policy-templates-ciso-toolkit.LICENSE.md).
    const cisoToolkit = require('./fixtures/policy-templates-ciso-toolkit.json') as {
        templates: Array<{
            externalRef: string; title: string; category: string; language: string;
            contentType: string; contentText: string; tags: string; source: string;
        }>;
    };
    for (const t of cisoToolkit.templates) {
        const data = {
            title: t.title,
            category: t.category,
            language: t.language,
            contentType: t.contentType as 'MARKDOWN',
            contentText: t.contentText,
            tags: t.tags,
            isGlobal: true,
            source: t.source,
            externalRef: t.externalRef,
        };
        const existing = await prisma.policyTemplate.findFirst({
            where: { OR: [{ externalRef: t.externalRef }, { title: t.title }] },
        });
        if (existing) {
            await prisma.policyTemplate.update({ where: { id: existing.id }, data });
        } else {
            await prisma.policyTemplate.create({ data });
        }
    }
    console.log(`✅ ciso-toolkit policy templates seeded (${cisoToolkit.templates.length})`);

    // Imported policy templates (generic security policies converted from a
    // vendored CSV export to clean Markdown — see
    // scripts/import-policy-templates.ts). These are the canonical copies:
    // upsert by externalRef OR title so an imported policy SUPERSEDES any
    // earlier same-titled template (the ciso-toolkit "Information Security
    // Policy" / "Risk Management Policy", the expanded-starter originals)
    // rather than creating a duplicate card. The imported externalRefs are
    // mapped to the same frameworks in policy-template-framework-map.json.
    const importedPolicies = require('./fixtures/policy-templates-imported.json') as {
        templates: Array<{
            externalRef: string; title: string; category: string; language: string;
            contentType: string; contentText: string; tags: string; source: string;
        }>;
    };
    for (const t of importedPolicies.templates) {
        const data = {
            title: t.title,
            category: t.category,
            language: t.language,
            contentType: t.contentType as 'MARKDOWN',
            contentText: t.contentText,
            tags: t.tags,
            isGlobal: true,
            source: t.source,
            externalRef: t.externalRef,
        };
        const existing = await prisma.policyTemplate.findFirst({
            where: { OR: [{ externalRef: t.externalRef }, { title: t.title }] },
        });
        if (existing) {
            await prisma.policyTemplate.update({ where: { id: existing.id }, data });
        } else {
            await prisma.policyTemplate.create({ data });
        }
    }
    console.log(`✅ imported policy templates seeded (${importedPolicies.templates.length})`);

    // IC ORIGINAL gap-fill policy templates — topics genuinely absent from the
    // ciso-toolkit + imported sets (threat & vulnerability management, corporate
    // governance, data classification & handling, MDM/BYOD). Original prose in
    // IC house style; framework refs live in policy-template-framework-map.json
    // keyed by these externalRefs. Same upsert-by-(externalRef|title) shape.
    const originalGapPolicies = require('./fixtures/policy-templates-original-gaps.json') as {
        templates: Array<{
            externalRef: string; title: string; category: string; language: string;
            contentType: string; contentText: string; tags: string; source: string;
        }>;
    };
    for (const t of originalGapPolicies.templates) {
        const data = {
            title: t.title,
            category: t.category,
            language: t.language,
            contentType: t.contentType as 'MARKDOWN',
            contentText: t.contentText,
            tags: t.tags,
            isGlobal: true,
            source: t.source,
            externalRef: t.externalRef,
        };
        const existing = await prisma.policyTemplate.findFirst({
            where: { OR: [{ externalRef: t.externalRef }, { title: t.title }] },
        });
        if (existing) {
            await prisma.policyTemplate.update({ where: { id: existing.id }, data });
        } else {
            await prisma.policyTemplate.create({ data });
        }
    }
    console.log(`✅ IC original gap-fill policy templates seeded (${originalGapPolicies.templates.length})`);

    // ─── Frameworks & Requirements ───
    const annexAData = require('./fixtures/iso27001_2022_annexA.json') as Array<{
        key: string; theme: string; themeNumber: number; sortOrder: number; title: string; summary?: string;
    }>;

    // ISO 27001:2022
    const iso27001 = await prisma.framework.upsert({
        where: { key: 'ISO27001' },
        update: { name: 'ISO/IEC 27001', version: '2022', description: 'ISO/IEC 27001:2022 Information Security Management' },
        create: { key: 'ISO27001', name: 'ISO/IEC 27001', version: '2022', description: 'ISO/IEC 27001:2022 Information Security Management' },
    });

    // Upsert all 93 Annex A requirements
    const requirementMap: Record<string, string> = {};
    for (const req of annexAData) {
        const r = await prisma.frameworkRequirement.upsert({
            where: { frameworkId_code: { frameworkId: iso27001.id, code: req.key } },
            update: { title: req.title, description: req.summary || null, theme: req.theme, themeNumber: req.themeNumber, sortOrder: req.sortOrder },
            create: { frameworkId: iso27001.id, code: req.key, title: req.title, description: req.summary || null, category: req.theme, theme: req.theme, themeNumber: req.themeNumber, sortOrder: req.sortOrder },
        });
        requirementMap[req.key] = r.id;
    }
    console.log(`✅ ISO 27001:2022 framework + ${annexAData.length} Annex A requirements seeded`);

    // SOC2
    const soc2 = await prisma.framework.upsert({
        where: { key: 'SOC2' },
        update: { name: 'SOC 2', description: 'SOC 2 Trust Services Criteria' },
        create: { key: 'SOC2', name: 'SOC 2', description: 'SOC 2 Trust Services Criteria' },
    });
    const soc2Reqs = [
        { code: 'CC1.1', title: 'COSO principle 1 — Integrity and ethical values', category: 'Control Environment' },
        { code: 'CC2.1', title: 'Information for internal controls', category: 'Communication' },
        { code: 'CC3.1', title: 'Specifies objectives', category: 'Risk Assessment' },
        { code: 'CC5.1', title: 'Selects and develops control activities', category: 'Control Activities' },
        { code: 'CC6.1', title: 'Logical and physical access controls', category: 'Logical Access' },
        { code: 'CC7.1', title: 'System operations monitoring', category: 'System Operations' },
        { code: 'CC8.1', title: 'Change management', category: 'Change Management' },
    ];
    for (let i = 0; i < soc2Reqs.length; i++) {
        const req = soc2Reqs[i];
        await prisma.frameworkRequirement.upsert({
            where: { frameworkId_code: { frameworkId: soc2.id, code: req.code } },
            update: {},
            create: { frameworkId: soc2.id, code: req.code, title: req.title, category: req.category, sortOrder: i },
        });
    }

    // NIS2 — full fixture-driven
    const nis2Data = require('./fixtures/nis2_requirements.json') as Array<{ key: string; section: string; sortOrder: number; title: string }>;
    const nis2 = await prisma.framework.upsert({
        where: { key_version: { key: 'NIS2', version: '2022/2555' } },
        update: { name: 'NIS2 Directive', kind: 'EU_DIRECTIVE', description: 'Directive (EU) 2022/2555 on cybersecurity' },
        create: { key: 'NIS2', name: 'NIS2 Directive', version: '2022/2555', kind: 'EU_DIRECTIVE', description: 'Directive (EU) 2022/2555 on cybersecurity' },
    });
    // Clean old NIS2 requirements from key-only era
    const oldNis2 = await prisma.framework.findFirst({ where: { key: 'NIS2', version: null } });
    if (oldNis2 && oldNis2.id !== nis2.id) {
        await prisma.frameworkRequirement.deleteMany({ where: { frameworkId: oldNis2.id } });
        await prisma.framework.delete({ where: { id: oldNis2.id } }).catch(() => { });
    }
    const nis2ReqMap: Record<string, string> = {};
    for (const req of nis2Data) {
        const r = await prisma.frameworkRequirement.upsert({
            where: { frameworkId_code: { frameworkId: nis2.id, code: req.key } },
            update: { title: req.title, section: req.section, sortOrder: req.sortOrder },
            create: { frameworkId: nis2.id, code: req.key, title: req.title, section: req.section, category: req.section, sortOrder: req.sortOrder },
        });
        nis2ReqMap[req.key] = r.id;
    }
    console.log(`✅ NIS2 framework + ${nis2Data.length} requirements seeded`);

    // DORA — Digital Operational Resilience Act (Regulation (EU) 2022/2554).
    // Fixture-driven, mirroring the NIS2 pattern above. DORA is a Regulation
    // (directly applicable), so kind=REGULATION (vs NIS2's EU_DIRECTIVE).
    // Requirement codes follow the official article structure (DORA.Art.N),
    // matching the dora-2022.yaml library ref_ids.
    const doraData = require('./fixtures/dora_requirements.json') as Array<{ key: string; section: string; sortOrder: number; title: string }>;
    const dora = await prisma.framework.upsert({
        where: { key_version: { key: 'DORA', version: '2022/2554' } },
        update: { name: 'Digital Operational Resilience Act', kind: 'REGULATION', description: 'Regulation (EU) 2022/2554 on digital operational resilience for the financial sector' },
        create: { key: 'DORA', name: 'Digital Operational Resilience Act', version: '2022/2554', kind: 'REGULATION', description: 'Regulation (EU) 2022/2554 on digital operational resilience for the financial sector' },
    });
    const doraReqMap: Record<string, string> = {};
    for (const req of doraData) {
        const r = await prisma.frameworkRequirement.upsert({
            where: { frameworkId_code: { frameworkId: dora.id, code: req.key } },
            update: { title: req.title, section: req.section, sortOrder: req.sortOrder },
            create: { frameworkId: dora.id, code: req.key, title: req.title, section: req.section, category: req.section, sortOrder: req.sortOrder },
        });
        doraReqMap[req.key] = r.id;
    }
    console.log(`✅ DORA framework + ${doraData.length} requirements seeded`);

    // NIS2 gap-assessment question set — imported open-data (CC BY 4.0).
    // SEPARATE artifact from the NIS2 framework requirements above: the
    // gap-assessment questions are a self-assessment checklist, not
    // normative framework requirements, so they live in their own
    // Nis2GapDomain / Nis2GapQuestion reference tables side by side.
    // See prisma/fixtures/nis2-gap-assessment.LICENSE.md for attribution.
    const nis2Gap = require('./fixtures/nis2-gap-assessment.json') as {
        version: string;
        domains: Array<{
            id: number;
            code: string;
            name: unknown;
            description: unknown;
            day: number;
        }>;
        questions: Array<{
            id: string;
            domain: number;
            text: unknown;
            plainText: unknown;
            legalBasis: string;
            criticality: string;
            respondent: string;
            consequence: string;
            fineExposure: boolean;
            timeToFix: string;
            day: number;
            dependsOn: string[];
        }>;
    };
    for (const d of nis2Gap.domains) {
        await prisma.nis2GapDomain.upsert({
            where: { id: d.id },
            update: { code: d.code, name: d.name as object, description: d.description as object, day: d.day },
            create: { id: d.id, code: d.code, name: d.name as object, description: d.description as object, day: d.day },
        });
    }
    for (const q of nis2Gap.questions) {
        const data = {
            domainId: q.domain,
            text: q.text as object,
            plainText: q.plainText as object,
            legalBasis: q.legalBasis,
            criticality: q.criticality,
            respondent: q.respondent,
            consequence: q.consequence,
            fineExposure: q.fineExposure,
            timeToFix: q.timeToFix,
            day: q.day,
            dependsOn: q.dependsOn,
        };
        await prisma.nis2GapQuestion.upsert({
            where: { id: q.id },
            update: data,
            create: { id: q.id, ...data },
        });
    }
    console.log(
        `✅ NIS2 gap-assessment ${nis2Gap.version} — ${nis2Gap.domains.length} domains + ${nis2Gap.questions.length} questions seeded`,
    );

    // ─── AI-Governance self-assessment (unified AISVS / ISO 42001 / EU AI Act) ───
    // Global reference content (AiGovDomain + AiGovQuestion), idempotent —
    // mirrors the NIS2 gap-assessment seed. One 30-question set whose answers
    // project onto three standards via mappingsJson. Paraphrased questions
    // (AISVS CC-BY-SA-4.0; ISO 42001 clause refs only; EU AI Act public domain).
    const aiGov = require('./fixtures/ai-governance-self-assessment.json') as {
        questionSetVersion: number;
        domains: Array<{ id: number; code: string; name: string }>;
        questions: Array<{ id: string; domainId: number; criticality: string; conditional: string | null; text: string; mappings: { aisvs: string[]; iso42001: string[]; euAiAct: string[] } }>;
    };
    for (const d of aiGov.domains) {
        await prisma.aiGovDomain.upsert({
            where: { id: d.id },
            update: { code: d.code, name: d.name },
            create: { id: d.id, code: d.code, name: d.name },
        });
    }
    for (const q of aiGov.questions) {
        const data = {
            domainId: q.domainId,
            text: q.text,
            mappingsJson: q.mappings,
            conditional: q.conditional,
            criticality: q.criticality,
        };
        await prisma.aiGovQuestion.upsert({
            where: { id: q.id },
            update: data,
            create: { id: q.id, ...data },
        });
    }
    console.log(`✅ AI-governance self-assessment v${aiGov.questionSetVersion} — ${aiGov.domains.length} domains + ${aiGov.questions.length} questions seeded`);

    // ISO 9001
    const iso9001Data = require('./fixtures/iso9001_clauses.json') as Array<{ key: string; section: string; sortOrder: number; title: string }>;
    const iso9001 = await prisma.framework.upsert({
        where: { key_version: { key: 'ISO9001', version: '2015' } },
        update: { name: 'ISO 9001', description: 'ISO 9001:2015 Quality Management Systems' },
        create: { key: 'ISO9001', name: 'ISO 9001', version: '2015', kind: 'ISO_STANDARD', description: 'ISO 9001:2015 Quality Management Systems' },
    });
    const iso9001ReqMap: Record<string, string> = {};
    for (const req of iso9001Data) {
        const r = await prisma.frameworkRequirement.upsert({
            where: { frameworkId_code: { frameworkId: iso9001.id, code: req.key } },
            update: { title: req.title, section: req.section, sortOrder: req.sortOrder },
            create: { frameworkId: iso9001.id, code: req.key, title: req.title, section: req.section, category: req.section, sortOrder: req.sortOrder },
        });
        iso9001ReqMap[req.key] = r.id;
    }
    console.log(`✅ ISO 9001 framework + ${iso9001Data.length} requirements seeded`);

    // ISO 28000
    const iso28000Data = require('./fixtures/iso28000_clauses.json') as Array<{ key: string; section: string; sortOrder: number; title: string }>;
    const iso28000 = await prisma.framework.upsert({
        where: { key_version: { key: 'ISO28000', version: '2022' } },
        update: { name: 'ISO 28000', description: 'ISO 28000:2022 Supply Chain Security Management' },
        create: { key: 'ISO28000', name: 'ISO 28000', version: '2022', kind: 'ISO_STANDARD', description: 'ISO 28000:2022 Supply Chain Security Management' },
    });
    const iso28000ReqMap: Record<string, string> = {};
    for (const req of iso28000Data) {
        const r = await prisma.frameworkRequirement.upsert({
            where: { frameworkId_code: { frameworkId: iso28000.id, code: req.key } },
            update: { title: req.title, section: req.section, sortOrder: req.sortOrder },
            create: { frameworkId: iso28000.id, code: req.key, title: req.title, section: req.section, category: req.section, sortOrder: req.sortOrder },
        });
        iso28000ReqMap[req.key] = r.id;
    }
    console.log(`✅ ISO 28000 framework + ${iso28000Data.length} requirements seeded`);

    // ISO 39001
    const iso39001Data = require('./fixtures/iso39001_clauses.json') as Array<{ key: string; section: string; sortOrder: number; title: string }>;
    const iso39001 = await prisma.framework.upsert({
        where: { key_version: { key: 'ISO39001', version: '2012' } },
        update: { name: 'ISO 39001', description: 'ISO 39001:2012 Road Traffic Safety Management' },
        create: { key: 'ISO39001', name: 'ISO 39001', version: '2012', kind: 'ISO_STANDARD', description: 'ISO 39001:2012 Road Traffic Safety Management' },
    });
    const iso39001ReqMap: Record<string, string> = {};
    for (const req of iso39001Data) {
        const r = await prisma.frameworkRequirement.upsert({
            where: { frameworkId_code: { frameworkId: iso39001.id, code: req.key } },
            update: { title: req.title, section: req.section, sortOrder: req.sortOrder },
            create: { frameworkId: iso39001.id, code: req.key, title: req.title, section: req.section, category: req.section, sortOrder: req.sortOrder },
        });
        iso39001ReqMap[req.key] = r.id;
    }
    console.log(`✅ ISO 39001 framework + ${iso39001Data.length} requirements seeded`);

    console.log('✅ SOC2 + NIS2 + ISO9001 + ISO28000 + ISO39001 frameworks seeded');

    // ─── ISO 27001:2022 Control Templates (one per Annex A control) ───
    const defaultTasks = [
        { title: 'Define control owner and scope', description: 'Assign an owner and define the scope of this control within the organization.' },
        { title: 'Document procedure or policy', description: 'Create or reference the policy/procedure that implements this control.' },
        { title: 'Implement technical or operational measure', description: 'Put the control into practice — deploy tooling, configure settings, or establish processes.' },
        { title: 'Collect evidence of implementation', description: 'Gather evidence demonstrating the control is operating effectively.' },
        { title: 'Review effectiveness', description: 'Periodically review and assess whether the control meets its objectives.' },
    ];

    let templatesCreated = 0;
    for (const req of annexAData) {
        const code = `A-${req.key}`;
        const existing = await prisma.controlTemplate.findUnique({ where: { code } });
        if (!existing) {
            const template = await prisma.controlTemplate.create({
                data: { code, title: req.title, description: req.summary || null, category: req.theme, defaultFrequency: 'QUARTERLY' },
            });
            for (const task of defaultTasks) {
                await prisma.controlTemplateTask.create({
                    data: { templateId: template.id, title: task.title, description: task.description },
                });
            }
            await prisma.controlTemplateRequirementLink.create({
                data: { templateId: template.id, requirementId: requirementMap[req.key] },
            });
            templatesCreated++;
        }
    }
    console.log(`✅ ISO 27001 control templates seeded (${templatesCreated} new)`);

    // ─── NIS2 Control Templates ───
    const nis2Templates = [
        { code: 'NIS2-RA', title: 'Risk analysis and information security policies', reqs: ['Art.21(2)(a)'] },
        { code: 'NIS2-IH', title: 'Incident handling procedures', reqs: ['Art.21(2)(b)'] },
        { code: 'NIS2-BC', title: 'Business continuity and crisis management', reqs: ['Art.21(2)(c)'] },
        { code: 'NIS2-SC', title: 'Supply chain security management', reqs: ['Art.21(2)(d)'] },
        { code: 'NIS2-NS', title: 'Network and information system security', reqs: ['Art.21(2)(e)'] },
        { code: 'NIS2-EF', title: 'Effectiveness assessment of cybersecurity measures', reqs: ['Art.21(2)(f)'] },
        { code: 'NIS2-CH', title: 'Cyber hygiene and security training', reqs: ['Art.21(2)(g)'] },
        { code: 'NIS2-CR', title: 'Cryptography and encryption policies', reqs: ['Art.21(2)(h)'] },
        { code: 'NIS2-HR', title: 'HR security and access control', reqs: ['Art.21(2)(i)'] },
        { code: 'NIS2-MFA', title: 'Multi-factor authentication and secured communications', reqs: ['Art.21(2)(j)'] },
        { code: 'NIS2-EW', title: 'Early warning notification (24h)', reqs: ['Art.23(1)'] },
        { code: 'NIS2-IN', title: 'Incident notification (72h)', reqs: ['Art.23(2)'] },
        { code: 'NIS2-FR', title: 'Final incident report (1 month)', reqs: ['Art.23(3)'] },
        { code: 'NIS2-GO', title: 'Management body cybersecurity oversight', reqs: ['Art.20(1)'] },
        { code: 'NIS2-TR', title: 'Management cybersecurity training', reqs: ['Art.20(2)'] },
        { code: 'NIS2-CE', title: 'Cybersecurity certification schemes', reqs: ['Art.24(1)'] },
        { code: 'NIS2-ST', title: 'Standards and technical specifications', reqs: ['Art.25'] },
        { code: 'NIS2-DN', title: 'Domain name registration accuracy', reqs: ['Art.28(1)'] },
        { code: 'NIS2-IS', title: 'Information sharing arrangements', reqs: ['Art.29(1)'] },
        { code: 'NIS2-NS2', title: 'National cybersecurity strategy compliance', reqs: ['Art.7(1)'] },
    ];
    for (const t of nis2Templates) {
        const existing = await prisma.controlTemplate.findUnique({ where: { code: t.code } });
        if (!existing) {
            const tmpl = await prisma.controlTemplate.create({
                data: { code: t.code, title: t.title, category: 'NIS2', defaultFrequency: 'QUARTERLY' },
            });
            for (const task of defaultTasks) {
                await prisma.controlTemplateTask.create({ data: { templateId: tmpl.id, title: task.title, description: task.description } });
            }
            for (const rk of t.reqs) {
                if (nis2ReqMap[rk]) {
                    await prisma.controlTemplateRequirementLink.create({ data: { templateId: tmpl.id, requirementId: nis2ReqMap[rk] } }).catch(() => { });
                }
            }
        }
    }
    console.log('✅ NIS2 control templates seeded');

    // ─── DORA Control Templates ───
    // One starter control per assessable DORA article, linked to its
    // requirement. Stable codes (DORA-<article>) keep the pack + install
    // flow idempotent. Rides the generic ControlTemplate/Pack machinery —
    // no DORA-specific install path.
    const doraTemplates = [
        { code: 'DORA-5',  title: 'ICT governance and management-body accountability', reqs: ['DORA.Art.5'] },
        { code: 'DORA-6',  title: 'ICT risk management framework', reqs: ['DORA.Art.6'] },
        { code: 'DORA-7',  title: 'ICT systems, protocols and tools', reqs: ['DORA.Art.7'] },
        { code: 'DORA-8',  title: 'Asset and dependency identification', reqs: ['DORA.Art.8'] },
        { code: 'DORA-9',  title: 'Protection and prevention controls', reqs: ['DORA.Art.9'] },
        { code: 'DORA-10', title: 'Anomalous-activity detection', reqs: ['DORA.Art.10'] },
        { code: 'DORA-11', title: 'Response and recovery / ICT business continuity', reqs: ['DORA.Art.11'] },
        { code: 'DORA-12', title: 'Backup, restoration and recovery procedures', reqs: ['DORA.Art.12'] },
        { code: 'DORA-13', title: 'Learning and evolving (post-incident review)', reqs: ['DORA.Art.13'] },
        { code: 'DORA-14', title: 'Crisis communication', reqs: ['DORA.Art.14'] },
        { code: 'DORA-16', title: 'Simplified ICT risk management framework', reqs: ['DORA.Art.16'] },
        { code: 'DORA-17', title: 'ICT-related incident management process', reqs: ['DORA.Art.17'] },
        { code: 'DORA-18', title: 'Incident classification', reqs: ['DORA.Art.18'] },
        { code: 'DORA-19', title: 'Major-incident reporting to competent authority', reqs: ['DORA.Art.19'] },
        { code: 'DORA-23', title: 'Payment-related operational/security incident handling', reqs: ['DORA.Art.23'] },
        { code: 'DORA-24', title: 'Digital operational resilience testing programme', reqs: ['DORA.Art.24'] },
        { code: 'DORA-25', title: 'Testing of ICT tools and systems', reqs: ['DORA.Art.25'] },
        { code: 'DORA-26', title: 'Threat-led penetration testing (TLPT)', reqs: ['DORA.Art.26'] },
        { code: 'DORA-27', title: 'TLPT tester suitability and independence', reqs: ['DORA.Art.27'] },
        { code: 'DORA-28', title: 'ICT third-party risk strategy and Register of Information', reqs: ['DORA.Art.28'] },
        { code: 'DORA-29', title: 'ICT concentration-risk assessment', reqs: ['DORA.Art.29'] },
        { code: 'DORA-30', title: 'Key contractual provisions for ICT services', reqs: ['DORA.Art.30'] },
        { code: 'DORA-31', title: 'Critical ICT third-party provider tracking', reqs: ['DORA.Art.31'] },
        { code: 'DORA-45', title: 'Cyber threat information-sharing arrangements', reqs: ['DORA.Art.45'] },
    ];
    for (const t of doraTemplates) {
        const existing = await prisma.controlTemplate.findUnique({ where: { code: t.code } });
        if (!existing) {
            const tmpl = await prisma.controlTemplate.create({
                data: { code: t.code, title: t.title, category: 'DORA', defaultFrequency: 'QUARTERLY' },
            });
            for (const task of defaultTasks) {
                await prisma.controlTemplateTask.create({ data: { templateId: tmpl.id, title: task.title, description: task.description } });
            }
            for (const rk of t.reqs) {
                if (doraReqMap[rk]) {
                    await prisma.controlTemplateRequirementLink.create({ data: { templateId: tmpl.id, requirementId: doraReqMap[rk] } }).catch(() => { });
                }
            }
        }
    }
    console.log('✅ DORA control templates seeded');

    // ─── ISO 9001 Control Templates ───
    const iso9001Templates = [
        { code: 'QMS-CTX', title: 'Organizational context determination', reqs: ['4.1', '4.2'] },
        { code: 'QMS-SCP', title: 'QMS scope definition', reqs: ['4.3'] },
        { code: 'QMS-PRC', title: 'QMS process management', reqs: ['4.4'] },
        { code: 'QMS-LDR', title: 'Leadership commitment and customer focus', reqs: ['5.1', '5.1.2'] },
        { code: 'QMS-POL', title: 'Quality policy establishment', reqs: ['5.2'] },
        { code: 'QMS-ROL', title: 'Roles and responsibilities assignment', reqs: ['5.3'] },
        { code: 'QMS-RSK', title: 'Risk and opportunity management', reqs: ['6.1'] },
        { code: 'QMS-OBJ', title: 'Quality objectives planning', reqs: ['6.2'] },
        { code: 'QMS-CHG', title: 'Change planning', reqs: ['6.3'] },
        { code: 'QMS-RES', title: 'Resource management', reqs: ['7.1', '7.1.5', '7.1.6'] },
        { code: 'QMS-CMP', title: 'Competence and awareness', reqs: ['7.2', '7.3'] },
        { code: 'QMS-COM', title: 'Communication management', reqs: ['7.4'] },
        { code: 'QMS-DOC', title: 'Documented information control', reqs: ['7.5'] },
        { code: 'QMS-OPC', title: 'Operational planning and control', reqs: ['8.1'] },
        { code: 'QMS-REQ', title: 'Product/service requirements', reqs: ['8.2'] },
        { code: 'QMS-DES', title: 'Design and development control', reqs: ['8.3'] },
        { code: 'QMS-EXT', title: 'External provider control', reqs: ['8.4'] },
        { code: 'QMS-PRD', title: 'Production and service provision', reqs: ['8.5', '8.5.1', '8.6', '8.7'] },
        { code: 'QMS-MON', title: 'Performance monitoring and evaluation', reqs: ['9.1', '9.1.2', '9.1.3'] },
        { code: 'QMS-AUD', title: 'Internal audit program', reqs: ['9.2'] },
        { code: 'QMS-MGR', title: 'Management review', reqs: ['9.3'] },
        { code: 'QMS-IMP', title: 'Improvement and corrective action', reqs: ['10.1', '10.2', '10.3'] },
    ];
    for (const t of iso9001Templates) {
        const existing = await prisma.controlTemplate.findUnique({ where: { code: t.code } });
        if (!existing) {
            const tmpl = await prisma.controlTemplate.create({
                data: { code: t.code, title: t.title, category: 'ISO9001', defaultFrequency: 'QUARTERLY' },
            });
            for (const task of defaultTasks) {
                await prisma.controlTemplateTask.create({ data: { templateId: tmpl.id, title: task.title, description: task.description } });
            }
            for (const rk of t.reqs) {
                if (iso9001ReqMap[rk]) {
                    await prisma.controlTemplateRequirementLink.create({ data: { templateId: tmpl.id, requirementId: iso9001ReqMap[rk] } }).catch(() => { });
                }
            }
        }
    }
    console.log('✅ ISO 9001 control templates seeded');

    // ─── ISO 28000 Control Templates ───
    const iso28000Templates = [
        { code: 'SCS-CTX', title: 'Supply chain context determination', reqs: ['4.1', '4.2'] },
        { code: 'SCS-SCP', title: 'Security management system scope', reqs: ['4.3', '4.4'] },
        { code: 'SCS-LDR', title: 'Leadership and security policy', reqs: ['5.1', '5.2'] },
        { code: 'SCS-ROL', title: 'Security roles and authorities', reqs: ['5.3'] },
        { code: 'SCS-RSK', title: 'Security risk assessment and treatment', reqs: ['6.1', '8.2', '8.3'] },
        { code: 'SCS-OBJ', title: 'Security objectives planning', reqs: ['6.2'] },
        { code: 'SCS-RES', title: 'Resource and competence management', reqs: ['7.1', '7.2', '7.3'] },
        { code: 'SCS-COM', title: 'Communication management', reqs: ['7.4'] },
        { code: 'SCS-DOC', title: 'Documented information', reqs: ['7.5'] },
        { code: 'SCS-OPC', title: 'Operational control', reqs: ['8.1'] },
        { code: 'SCS-SUP', title: 'Supply chain security management', reqs: ['8.4'] },
        { code: 'SCS-MON', title: 'Performance monitoring', reqs: ['9.1'] },
        { code: 'SCS-AUD', title: 'Internal audit program', reqs: ['9.2'] },
        { code: 'SCS-MGR', title: 'Management review', reqs: ['9.3'] },
        { code: 'SCS-IMP', title: 'Improvement and corrective action', reqs: ['10.1', '10.2'] },
    ];
    for (const t of iso28000Templates) {
        const existing = await prisma.controlTemplate.findUnique({ where: { code: t.code } });
        if (!existing) {
            const tmpl = await prisma.controlTemplate.create({
                data: { code: t.code, title: t.title, category: 'ISO28000', defaultFrequency: 'QUARTERLY' },
            });
            for (const task of defaultTasks) {
                await prisma.controlTemplateTask.create({ data: { templateId: tmpl.id, title: task.title, description: task.description } });
            }
            for (const rk of t.reqs) {
                if (iso28000ReqMap[rk]) {
                    await prisma.controlTemplateRequirementLink.create({ data: { templateId: tmpl.id, requirementId: iso28000ReqMap[rk] } }).catch(() => { });
                }
            }
        }
    }
    console.log('✅ ISO 28000 control templates seeded');

    // ─── ISO 39001 Control Templates ───
    const iso39001Templates = [
        { code: 'RTS-CTX', title: 'Organization context and interested parties', reqs: ['4.1', '4.2'] },
        { code: 'RTS-SCP', title: 'RTS management system scope', reqs: ['4.3', '4.4'] },
        { code: 'RTS-LDR', title: 'Leadership and RTS policy', reqs: ['5.1', '5.2'] },
        { code: 'RTS-ROL', title: 'RTS roles and authorities', reqs: ['5.3'] },
        { code: 'RTS-RSK', title: 'RTS risk and opportunity management', reqs: ['6.1'] },
        { code: 'RTS-OBJ', title: 'RTS performance factors and objectives', reqs: ['6.2'] },
        { code: 'RTS-CHG', title: 'RTS change planning', reqs: ['6.3'] },
        { code: 'RTS-RES', title: 'Resource and competence management', reqs: ['7.1', '7.2', '7.3'] },
        { code: 'RTS-COM', title: 'Communication management', reqs: ['7.4'] },
        { code: 'RTS-DOC', title: 'Documented information', reqs: ['7.5'] },
        { code: 'RTS-OPC', title: 'Operational planning and control', reqs: ['8.1'] },
        { code: 'RTS-EMR', title: 'Emergency preparedness and response', reqs: ['8.2'] },
        { code: 'RTS-MON', title: 'Performance monitoring and evaluation', reqs: ['9.1'] },
        { code: 'RTS-INV', title: 'Crash and incident investigation', reqs: ['9.2'] },
        { code: 'RTS-AUD', title: 'Internal audit program', reqs: ['9.3'] },
        { code: 'RTS-MGR', title: 'Management review', reqs: ['9.4'] },
        { code: 'RTS-IMP', title: 'Improvement and corrective action', reqs: ['10.1', '10.2'] },
    ];
    for (const t of iso39001Templates) {
        const existing = await prisma.controlTemplate.findUnique({ where: { code: t.code } });
        if (!existing) {
            const tmpl = await prisma.controlTemplate.create({
                data: { code: t.code, title: t.title, category: 'ISO39001', defaultFrequency: 'QUARTERLY' },
            });
            for (const task of defaultTasks) {
                await prisma.controlTemplateTask.create({ data: { templateId: tmpl.id, title: task.title, description: task.description } });
            }
            for (const rk of t.reqs) {
                if (iso39001ReqMap[rk]) {
                    await prisma.controlTemplateRequirementLink.create({ data: { templateId: tmpl.id, requirementId: iso39001ReqMap[rk] } }).catch(() => { });
                }
            }
        }
    }
    console.log('✅ ISO 39001 control templates seeded');

    // ─── Framework Packs ───
    const allIsoTemplates = await prisma.controlTemplate.findMany({ where: { code: { startsWith: 'A-' } } });
    const pack = await prisma.frameworkPack.upsert({
        where: { key: 'ISO27001_2022_BASE' },
        update: { name: 'ISO 27001:2022 Starter Pack', frameworkId: iso27001.id, version: '2022' },
        create: { key: 'ISO27001_2022_BASE', name: 'ISO 27001:2022 Starter Pack', frameworkId: iso27001.id, version: '2022', description: 'Full Annex A control set with default implementation tasks.' },
    });
    for (const tmpl of allIsoTemplates) {
        const existing = await prisma.packTemplateLink.findUnique({
            where: { packId_templateId: { packId: pack.id, templateId: tmpl.id } },
        });
        if (!existing) {
            await prisma.packTemplateLink.create({ data: { packId: pack.id, templateId: tmpl.id } });
        }
    }

    // NIS2 Pack
    const nis2Tmpls = await prisma.controlTemplate.findMany({ where: { code: { startsWith: 'NIS2-' } } });
    const nis2Pack = await prisma.frameworkPack.upsert({
        where: { key: 'NIS2_BASELINE' },
        update: { name: 'NIS2 Baseline Pack', frameworkId: nis2.id, version: '2022/2555' },
        create: { key: 'NIS2_BASELINE', name: 'NIS2 Baseline Pack', frameworkId: nis2.id, version: '2022/2555', description: 'NIS2 directive security measures baseline.' },
    });
    for (const tmpl of nis2Tmpls) {
        await prisma.packTemplateLink.upsert({
            where: { packId_templateId: { packId: nis2Pack.id, templateId: tmpl.id } },
            create: { packId: nis2Pack.id, templateId: tmpl.id }, update: {},
        });
    }

    // DORA Pack
    const doraTmpls = await prisma.controlTemplate.findMany({ where: { code: { startsWith: 'DORA-' } } });
    const doraPack = await prisma.frameworkPack.upsert({
        where: { key: 'DORA_BASELINE' },
        update: { name: 'DORA Baseline Pack', frameworkId: dora.id, version: '2022/2554' },
        create: { key: 'DORA_BASELINE', name: 'DORA Baseline Pack', frameworkId: dora.id, version: '2022/2554', description: 'DORA digital operational resilience baseline controls across the five pillars.' },
    });
    for (const tmpl of doraTmpls) {
        await prisma.packTemplateLink.upsert({
            where: { packId_templateId: { packId: doraPack.id, templateId: tmpl.id } },
            create: { packId: doraPack.id, templateId: tmpl.id }, update: {},
        });
    }

    // ─── OWASP AISVS v1.0 — AI Security Verification Standard ───
    // CC-BY-SA-4.0 (OWASP). Inflect stores a REFERENCE INDEX (canonical IDs +
    // verification levels + paraphrased titles), NOT the verbatim requirement
    // prose; the full text stays at the OWASP source. metadataJson carries the
    // OWASP attribution + license the framework picker surfaces. Rides the
    // generic framework/pack machinery — no AISVS-specific code paths.
    const aisvsData = require('./fixtures/owasp_aisvs_requirements.json') as Array<{ key: string; section: string; level: string; sortOrder: number; title: string }>;
    const aisvsMeta = JSON.stringify({
        locale: 'en',
        provider: 'OWASP',
        packager: 'inflect',
        publicationDate: '2025-05-01',
        license: 'CC-BY-SA-4.0',
        sourceUrl: 'https://github.com/OWASP/AISVS',
        referenceIndexOnly: true,
        copyright:
            'OWASP AISVS v1.0 © OWASP Foundation, licensed CC-BY-SA-4.0 ' +
            '(https://creativecommons.org/licenses/by-sa/4.0/). Source: ' +
            'https://github.com/OWASP/AISVS. Inflect stores a reference index ' +
            '(IDs, levels, paraphrased titles) and links to the canonical text.',
    });
    const aisvs = await prisma.framework.upsert({
        where: { key_version: { key: 'OWASP-AISVS', version: '1.0' } },
        update: { name: 'OWASP AISVS v1.0', kind: 'INDUSTRY_STANDARD', description: 'OWASP AI Security Verification Standard v1.0 — AI-security controls for AI-enabled systems.', metadataJson: aisvsMeta, sourceUrn: 'urn:inflect:library:owasp-aisvs-1.0' },
        create: { key: 'OWASP-AISVS', name: 'OWASP AISVS v1.0', version: '1.0', kind: 'INDUSTRY_STANDARD', description: 'OWASP AI Security Verification Standard v1.0 — AI-security controls for AI-enabled systems.', metadataJson: aisvsMeta, sourceUrn: 'urn:inflect:library:owasp-aisvs-1.0' },
    });
    const aisvsReqMap: Record<string, string> = {};
    for (const req of aisvsData) {
        const r = await prisma.frameworkRequirement.upsert({
            where: { frameworkId_code: { frameworkId: aisvs.id, code: req.key } },
            update: { title: req.title, section: req.section, sortOrder: req.sortOrder },
            create: { frameworkId: aisvs.id, code: req.key, title: req.title, section: req.section, category: req.section, sortOrder: req.sortOrder },
        });
        aisvsReqMap[req.key] = r.id;
    }
    // One control template per AISVS chapter (12), each linked to its chapter's
    // requirements — keeps the installable pack chapter-scoped.
    const aisvsChapters = new Map<string, { title: string; reqs: string[] }>();
    for (const req of aisvsData) {
        const ch = req.key.split('.')[0]; // 'C1'..'C12'
        if (!aisvsChapters.has(ch)) aisvsChapters.set(ch, { title: req.section, reqs: [] });
        aisvsChapters.get(ch)!.reqs.push(req.key);
    }
    for (const [ch, info] of aisvsChapters) {
        const code = `AISVS-${ch}`;
        const existing = await prisma.controlTemplate.findUnique({ where: { code } });
        if (!existing) {
            const tmpl = await prisma.controlTemplate.create({
                data: { code, title: info.title, category: 'OWASP AISVS', defaultFrequency: 'QUARTERLY' },
            });
            for (const task of defaultTasks) {
                await prisma.controlTemplateTask.create({ data: { templateId: tmpl.id, title: task.title, description: task.description } });
            }
            for (const rk of info.reqs) {
                if (aisvsReqMap[rk]) {
                    await prisma.controlTemplateRequirementLink.create({ data: { templateId: tmpl.id, requirementId: aisvsReqMap[rk] } }).catch(() => { });
                }
            }
        }
    }
    const aisvsTmpls = await prisma.controlTemplate.findMany({ where: { code: { startsWith: 'AISVS-' } } });
    const aisvsPack = await prisma.frameworkPack.upsert({
        where: { key: 'AISVS_BASELINE' },
        update: { name: 'OWASP AISVS Baseline Pack', frameworkId: aisvs.id, version: '1.0' },
        create: { key: 'AISVS_BASELINE', name: 'OWASP AISVS Baseline Pack', frameworkId: aisvs.id, version: '1.0', description: 'OWASP AISVS v1.0 AI-security controls across all 12 chapters.' },
    });
    for (const tmpl of aisvsTmpls) {
        await prisma.packTemplateLink.upsert({
            where: { packId_templateId: { packId: aisvsPack.id, templateId: tmpl.id } },
            create: { packId: aisvsPack.id, templateId: tmpl.id }, update: {},
        });
    }
    console.log(`✅ OWASP AISVS framework + ${aisvsData.length} requirements + ${aisvsChapters.size} chapter packs seeded`);

    // ─── ISO/IEC 42001:2023 — AI Management System ───
    // COPYRIGHTED ISO standard: IC stores a structural outline (clause + Annex A
    // control numbers + paraphrased titles), NOT the verbatim ISO text — mirrors
    // the ISO 27001 handling. Rides the generic framework/pack machinery.
    const iso42001Data = require('./fixtures/iso_42001_requirements.json') as Array<{ key: string; section: string; sortOrder: number; title: string }>;
    const iso42001Meta = JSON.stringify({
        locale: 'en',
        provider: 'ISO/IEC',
        packager: 'inflect',
        publicationDate: '2023-12-18',
        license: 'ISO-copyright',
        sourceUrl: 'https://www.iso.org/standard/81230',
        referenceIndexOnly: true,
        copyright:
            'Structural outline of ISO/IEC 42001:2023 (clause + Annex A control ' +
            'numbers with paraphrased titles), NOT a reproduction of the ' +
            'copyrighted ISO text. Purchase the full standard from ISO.',
    });
    const iso42001 = await prisma.framework.upsert({
        where: { key_version: { key: 'ISO42001', version: '2023' } },
        update: { name: 'ISO/IEC 42001:2023', kind: 'ISO_STANDARD', description: 'AI Management System (AIMS) — requirements + Annex A controls.', metadataJson: iso42001Meta, sourceUrn: 'urn:inflect:library:iso-42001' },
        create: { key: 'ISO42001', name: 'ISO/IEC 42001:2023', version: '2023', kind: 'ISO_STANDARD', description: 'AI Management System (AIMS) — requirements + Annex A controls.', metadataJson: iso42001Meta, sourceUrn: 'urn:inflect:library:iso-42001' },
    });
    const iso42001ReqMap: Record<string, string> = {};
    for (const req of iso42001Data) {
        const r = await prisma.frameworkRequirement.upsert({
            where: { frameworkId_code: { frameworkId: iso42001.id, code: req.key } },
            update: { title: req.title, section: req.section, sortOrder: req.sortOrder },
            create: { frameworkId: iso42001.id, code: req.key, title: req.title, section: req.section, category: req.section, sortOrder: req.sortOrder },
        });
        iso42001ReqMap[req.key] = r.id;
    }
    // One control template per top-level grouping (clauses 4-10 + Annex A.2-A.10).
    const iso42001Groups = new Map<string, { title: string; reqs: string[] }>();
    for (const req of iso42001Data) {
        const group = req.section; // already the grouping label
        if (!iso42001Groups.has(group)) iso42001Groups.set(group, { title: group, reqs: [] });
        iso42001Groups.get(group)!.reqs.push(req.key);
    }
    let iso42001GroupIdx = 0;
    for (const [, info] of iso42001Groups) {
        const code = `AIMS-${String(iso42001GroupIdx++).padStart(2, '0')}`;
        const existing = await prisma.controlTemplate.findUnique({ where: { code } });
        if (!existing) {
            const tmpl = await prisma.controlTemplate.create({
                data: { code, title: info.title, category: 'ISO 42001', defaultFrequency: 'ANNUALLY' },
            });
            for (const task of defaultTasks) {
                await prisma.controlTemplateTask.create({ data: { templateId: tmpl.id, title: task.title, description: task.description } });
            }
            for (const rk of info.reqs) {
                if (iso42001ReqMap[rk]) {
                    await prisma.controlTemplateRequirementLink.create({ data: { templateId: tmpl.id, requirementId: iso42001ReqMap[rk] } }).catch(() => { });
                }
            }
        }
    }
    const iso42001Tmpls = await prisma.controlTemplate.findMany({ where: { code: { startsWith: 'AIMS-' } } });
    const iso42001Pack = await prisma.frameworkPack.upsert({
        where: { key: 'ISO42001_BASELINE' },
        update: { name: 'ISO 42001 AIMS Baseline Pack', frameworkId: iso42001.id, version: '2023' },
        create: { key: 'ISO42001_BASELINE', name: 'ISO 42001 AIMS Baseline Pack', frameworkId: iso42001.id, version: '2023', description: 'ISO/IEC 42001:2023 AI management system clauses + Annex A controls.' },
    });
    for (const tmpl of iso42001Tmpls) {
        await prisma.packTemplateLink.upsert({
            where: { packId_templateId: { packId: iso42001Pack.id, templateId: tmpl.id } },
            create: { packId: iso42001Pack.id, templateId: tmpl.id }, update: {},
        });
    }
    console.log(`✅ ISO 42001 framework + ${iso42001Data.length} requirements + ${iso42001Groups.size} group packs seeded`);

    // ─── EU AI Act — Regulation (EU) 2024/1689 ───
    // EU legislation = PUBLIC DOMAIN: obligation text may be used directly.
    // Modelled risk-tiered (prohibited / high-risk / limited / GPAI / minimal);
    // tier classification is a tenant + counsel decision, NOT legal advice.
    // Rides the generic framework/pack machinery.
    const euAiActData = require('./fixtures/eu_ai_act_requirements.json') as Array<{ key: string; section: string; sortOrder: number; title: string }>;
    const euAiActMeta = JSON.stringify({
        locale: 'en',
        provider: 'European Union',
        packager: 'inflect',
        publicationDate: '2024-06-13',
        license: 'public-domain',
        sourceUrl: 'https://eur-lex.europa.eu/eli/reg/2024/1689/oj',
        notLegalAdvice: true,
        copyright:
            'Regulation (EU) 2024/1689 is EU legislation in the public domain. ' +
            'Source: https://eur-lex.europa.eu/eli/reg/2024/1689/oj. Risk-tier ' +
            'classification is a tenant + legal-counsel decision; not legal advice.',
    });
    const euAiAct = await prisma.framework.upsert({
        where: { key_version: { key: 'EU-AI-ACT', version: '2024' } },
        update: { name: 'EU AI Act (2024/1689)', kind: 'REGULATION', description: 'Risk-tiered AI regulation obligations (prohibited / high-risk / limited / GPAI / minimal).', metadataJson: euAiActMeta, sourceUrn: 'urn:inflect:library:eu-ai-act' },
        create: { key: 'EU-AI-ACT', name: 'EU AI Act (2024/1689)', version: '2024', kind: 'REGULATION', description: 'Risk-tiered AI regulation obligations (prohibited / high-risk / limited / GPAI / minimal).', metadataJson: euAiActMeta, sourceUrn: 'urn:inflect:library:eu-ai-act' },
    });
    const euAiActReqMap: Record<string, string> = {};
    for (const req of euAiActData) {
        const r = await prisma.frameworkRequirement.upsert({
            where: { frameworkId_code: { frameworkId: euAiAct.id, code: req.key } },
            update: { title: req.title, section: req.section, sortOrder: req.sortOrder },
            create: { frameworkId: euAiAct.id, code: req.key, title: req.title, section: req.section, category: req.section, sortOrder: req.sortOrder },
        });
        euAiActReqMap[req.key] = r.id;
    }
    // One control template per risk tier.
    const euAiActTiers = new Map<string, { title: string; reqs: string[] }>();
    for (const req of euAiActData) {
        if (!euAiActTiers.has(req.section)) euAiActTiers.set(req.section, { title: req.section, reqs: [] });
        euAiActTiers.get(req.section)!.reqs.push(req.key);
    }
    let euTierIdx = 0;
    for (const [, info] of euAiActTiers) {
        const code = `EUAIA-${String(euTierIdx++).padStart(2, '0')}`;
        const existing = await prisma.controlTemplate.findUnique({ where: { code } });
        if (!existing) {
            const tmpl = await prisma.controlTemplate.create({
                data: { code, title: info.title, category: 'EU AI Act', defaultFrequency: 'ANNUALLY' },
            });
            for (const task of defaultTasks) {
                await prisma.controlTemplateTask.create({ data: { templateId: tmpl.id, title: task.title, description: task.description } });
            }
            for (const rk of info.reqs) {
                if (euAiActReqMap[rk]) {
                    await prisma.controlTemplateRequirementLink.create({ data: { templateId: tmpl.id, requirementId: euAiActReqMap[rk] } }).catch(() => { });
                }
            }
        }
    }
    const euAiActTmpls = await prisma.controlTemplate.findMany({ where: { code: { startsWith: 'EUAIA-' } } });
    const euAiActPack = await prisma.frameworkPack.upsert({
        where: { key: 'EU_AI_ACT_BASELINE' },
        update: { name: 'EU AI Act Baseline Pack', frameworkId: euAiAct.id, version: '2024' },
        create: { key: 'EU_AI_ACT_BASELINE', name: 'EU AI Act Baseline Pack', frameworkId: euAiAct.id, version: '2024', description: 'EU AI Act (2024/1689) obligations across the five risk tiers.' },
    });
    for (const tmpl of euAiActTmpls) {
        await prisma.packTemplateLink.upsert({
            where: { packId_templateId: { packId: euAiActPack.id, templateId: tmpl.id } },
            create: { packId: euAiActPack.id, templateId: tmpl.id }, update: {},
        });
    }
    console.log(`✅ EU AI Act framework + ${euAiActData.length} obligations + ${euAiActTiers.size} risk-tier packs seeded`);

    // ─── NIST Privacy Framework v1.0 ───
    // PUBLIC DOMAIN (NIST): "Information presented on NIST sites is considered
    // public information and may be distributed or copied." The privacy
    // companion to NIST CSF 2.0 (same Function/Category/Subcategory structure).
    // Rides the generic framework/pack machinery — no special-casing.
    const nistPrivacyData = require('./fixtures/nist_privacy_framework_requirements.json') as Array<{ key: string; section: string; sortOrder: number; title: string }>;
    const nistPrivacyMeta = JSON.stringify({
        locale: 'en',
        provider: 'NIST',
        packager: 'inflect',
        publicationDate: '2020-01-16',
        license: 'public-domain',
        sourceUrl: 'https://www.nist.gov/privacy-framework',
        copyright:
            'Information presented on NIST sites is considered public ' +
            'information and may be distributed or copied.',
    });
    const nistPrivacy = await prisma.framework.upsert({
        where: { key_version: { key: 'NIST-PRIVACY', version: '1.0' } },
        update: { name: 'NIST Privacy Framework v1.0', kind: 'NIST_FRAMEWORK', description: 'Privacy outcomes (Functions/Categories/Subcategories) for managing privacy risk — the privacy companion to NIST CSF.', metadataJson: nistPrivacyMeta, sourceUrn: 'urn:inflect:library:nist-privacy-framework-1.0' },
        create: { key: 'NIST-PRIVACY', name: 'NIST Privacy Framework v1.0', version: '1.0', kind: 'NIST_FRAMEWORK', description: 'Privacy outcomes (Functions/Categories/Subcategories) for managing privacy risk — the privacy companion to NIST CSF.', metadataJson: nistPrivacyMeta, sourceUrn: 'urn:inflect:library:nist-privacy-framework-1.0' },
    });
    const nistPrivacyReqMap: Record<string, string> = {};
    for (const req of nistPrivacyData) {
        const r = await prisma.frameworkRequirement.upsert({
            where: { frameworkId_code: { frameworkId: nistPrivacy.id, code: req.key } },
            update: { title: req.title, section: req.section, sortOrder: req.sortOrder },
            create: { frameworkId: nistPrivacy.id, code: req.key, title: req.title, section: req.section, category: req.section, sortOrder: req.sortOrder },
        });
        nistPrivacyReqMap[req.key] = r.id;
    }
    // One control template per Category (the 18 privacy Categories).
    const nistPrivacyGroups = new Map<string, { title: string; reqs: string[] }>();
    for (const req of nistPrivacyData) {
        if (!nistPrivacyGroups.has(req.section)) nistPrivacyGroups.set(req.section, { title: req.section, reqs: [] });
        nistPrivacyGroups.get(req.section)!.reqs.push(req.key);
    }
    let nistPrivacyGroupIdx = 0;
    for (const [, info] of nistPrivacyGroups) {
        const code = `PRIV-${String(nistPrivacyGroupIdx++).padStart(2, '0')}`;
        const existing = await prisma.controlTemplate.findUnique({ where: { code } });
        if (!existing) {
            const tmpl = await prisma.controlTemplate.create({
                data: { code, title: info.title, category: 'NIST Privacy', defaultFrequency: 'ANNUALLY' },
            });
            for (const task of defaultTasks) {
                await prisma.controlTemplateTask.create({ data: { templateId: tmpl.id, title: task.title, description: task.description } });
            }
            for (const rk of info.reqs) {
                if (nistPrivacyReqMap[rk]) {
                    await prisma.controlTemplateRequirementLink.create({ data: { templateId: tmpl.id, requirementId: nistPrivacyReqMap[rk] } }).catch(() => { });
                }
            }
        }
    }
    const nistPrivacyTmpls = await prisma.controlTemplate.findMany({ where: { code: { startsWith: 'PRIV-' } } });
    const nistPrivacyPack = await prisma.frameworkPack.upsert({
        where: { key: 'NIST_PRIVACY_BASELINE' },
        update: { name: 'NIST Privacy Framework Baseline Pack', frameworkId: nistPrivacy.id, version: '1.0' },
        create: { key: 'NIST_PRIVACY_BASELINE', name: 'NIST Privacy Framework Baseline Pack', frameworkId: nistPrivacy.id, version: '1.0', description: 'NIST Privacy Framework v1.0 privacy Functions, Categories, and Subcategories.' },
    });
    for (const tmpl of nistPrivacyTmpls) {
        await prisma.packTemplateLink.upsert({
            where: { packId_templateId: { packId: nistPrivacyPack.id, templateId: tmpl.id } },
            create: { packId: nistPrivacyPack.id, templateId: tmpl.id }, update: {},
        });
    }
    console.log(`✅ NIST Privacy Framework + ${nistPrivacyData.length} subcategories + ${nistPrivacyGroups.size} category packs seeded`);

    // ─── NIST SSDF (SP 800-218) v1.1 ───
    // PUBLIC DOMAIN (NIST): "Information presented on NIST sites is considered
    // public information and may be distributed or copied." The Secure Software
    // Development Framework — four practice groups (PO/PS/PW/RV) → practices →
    // tasks. Underpins US federal secure-software self-attestation (EO 14028 /
    // OMB M-22-18). Rides the generic framework/pack machinery — no special-casing.
    const nistSsdfData = require('./fixtures/nist_ssdf_requirements.json') as Array<{ key: string; section: string; sortOrder: number; title: string }>;
    const nistSsdfMeta = JSON.stringify({
        locale: 'en',
        provider: 'NIST',
        packager: 'inflect',
        publicationDate: '2022-02-03',
        license: 'public-domain',
        sourceUrl: 'https://csrc.nist.gov/Projects/ssdf',
        selfAttestation: 'US federal secure-software self-attestation (EO 14028 / OMB M-22-18)',
        copyright:
            'Information presented on NIST sites is considered public ' +
            'information and may be distributed or copied.',
    });
    const nistSsdf = await prisma.framework.upsert({
        where: { key_version: { key: 'NIST-SSDF', version: '1.1' } },
        update: { name: 'NIST SSDF (SP 800-218) v1.1', kind: 'NIST_FRAMEWORK', description: 'Secure software development practices (Prepare / Protect / Produce / Respond) — the SSDF underpins US federal secure-software self-attestation.', metadataJson: nistSsdfMeta, sourceUrn: 'urn:inflect:library:nist-ssdf-800-218' },
        create: { key: 'NIST-SSDF', name: 'NIST SSDF (SP 800-218) v1.1', version: '1.1', kind: 'NIST_FRAMEWORK', description: 'Secure software development practices (Prepare / Protect / Produce / Respond) — the SSDF underpins US federal secure-software self-attestation.', metadataJson: nistSsdfMeta, sourceUrn: 'urn:inflect:library:nist-ssdf-800-218' },
    });
    const nistSsdfReqMap: Record<string, string> = {};
    for (const req of nistSsdfData) {
        const r = await prisma.frameworkRequirement.upsert({
            where: { frameworkId_code: { frameworkId: nistSsdf.id, code: req.key } },
            update: { title: req.title, section: req.section, sortOrder: req.sortOrder },
            create: { frameworkId: nistSsdf.id, code: req.key, title: req.title, section: req.section, category: req.section, sortOrder: req.sortOrder },
        });
        nistSsdfReqMap[req.key] = r.id;
    }
    // One control template per practice (the 19 SSDF practices). Curated,
    // higher-quality control templates land with the SSDF Starter Pack.
    const nistSsdfGroups = new Map<string, { title: string; reqs: string[] }>();
    for (const req of nistSsdfData) {
        if (!nistSsdfGroups.has(req.section)) nistSsdfGroups.set(req.section, { title: req.section, reqs: [] });
        nistSsdfGroups.get(req.section)!.reqs.push(req.key);
    }
    let nistSsdfGroupIdx = 0;
    for (const [, info] of nistSsdfGroups) {
        const code = `SSDF-${String(nistSsdfGroupIdx++).padStart(2, '0')}`;
        const existing = await prisma.controlTemplate.findUnique({ where: { code } });
        if (!existing) {
            const tmpl = await prisma.controlTemplate.create({
                data: { code, title: info.title, category: 'Secure Development', defaultFrequency: 'ANNUALLY' },
            });
            for (const task of defaultTasks) {
                await prisma.controlTemplateTask.create({ data: { templateId: tmpl.id, title: task.title, description: task.description } });
            }
            for (const rk of info.reqs) {
                if (nistSsdfReqMap[rk]) {
                    await prisma.controlTemplateRequirementLink.create({ data: { templateId: tmpl.id, requirementId: nistSsdfReqMap[rk] } }).catch(() => { });
                }
            }
        }
    }
    const nistSsdfTmpls = await prisma.controlTemplate.findMany({ where: { code: { startsWith: 'SSDF-' } } });
    const nistSsdfPack = await prisma.frameworkPack.upsert({
        where: { key: 'NIST_SSDF_BASELINE' },
        update: { name: 'NIST SSDF Baseline Pack', frameworkId: nistSsdf.id, version: '1.1' },
        create: { key: 'NIST_SSDF_BASELINE', name: 'NIST SSDF Baseline Pack', frameworkId: nistSsdf.id, version: '1.1', description: 'NIST SSDF (SP 800-218) v1.1 practice groups, practices, and tasks.' },
    });
    for (const tmpl of nistSsdfTmpls) {
        await prisma.packTemplateLink.upsert({
            where: { packId_templateId: { packId: nistSsdfPack.id, templateId: tmpl.id } },
            create: { packId: nistSsdfPack.id, templateId: tmpl.id }, update: {},
        });
    }
    console.log(`✅ NIST SSDF + ${nistSsdfData.length} tasks + ${nistSsdfGroups.size} practice packs seeded`);

    // ─── SSDF Starter Pack (curated secure-development controls) ───
    // Curated, higher-quality control templates (one per SSDF practice) that
    // give an SSDF adopter a real coverage baseline on day one — quality over
    // count. Distinct 'SDLC-' code prefix so they do not collide with the
    // auto-generated NIST_SSDF_BASELINE 'SSDF-NN' templates. Each control links
    // to the specific SSDF task requirement(s) it satisfies (via nistSsdfReqMap
    // from the framework block above), so installing the pack produces mapped
    // coverage, not bare 0%.
    const ssdfStarterControls = require('./fixtures/ssdf-control-templates.json') as Array<{
        code: string; title: string; description: string; defaultFrequency: string; requirements: string[]; tasks: Array<{ title: string; description: string }>;
    }>;
    for (const c of ssdfStarterControls) {
        const existing = await prisma.controlTemplate.findUnique({ where: { code: c.code } });
        if (!existing) {
            const tmpl = await prisma.controlTemplate.create({
                data: {
                    code: c.code,
                    title: c.title,
                    description: c.description,
                    category: 'Secure Development',
                    defaultFrequency: c.defaultFrequency as ControlFrequency,
                },
            });
            for (const task of c.tasks) {
                await prisma.controlTemplateTask.create({ data: { templateId: tmpl.id, title: task.title, description: task.description } });
            }
            for (const rk of c.requirements) {
                if (nistSsdfReqMap[rk]) {
                    await prisma.controlTemplateRequirementLink.create({ data: { templateId: tmpl.id, requirementId: nistSsdfReqMap[rk] } }).catch(() => { });
                }
            }
        }
    }
    const ssdfStarterTmpls = await prisma.controlTemplate.findMany({ where: { code: { startsWith: 'SDLC-' } } });
    const ssdfStarterPack = await prisma.frameworkPack.upsert({
        where: { key: 'SSDF_STARTER_PACK' },
        update: { name: 'SSDF Starter Pack', frameworkId: nistSsdf.id, version: '1.1' },
        create: { key: 'SSDF_STARTER_PACK', name: 'SSDF Starter Pack', frameworkId: nistSsdf.id, version: '1.1', description: 'Curated secure-development controls (one per SSDF practice) with default tasks, mapped to SSDF requirements.' },
    });
    for (const tmpl of ssdfStarterTmpls) {
        await prisma.packTemplateLink.upsert({
            where: { packId_templateId: { packId: ssdfStarterPack.id, templateId: tmpl.id } },
            create: { packId: ssdfStarterPack.id, templateId: tmpl.id }, update: {},
        });
    }
    console.log(`✅ SSDF Starter Pack + ${ssdfStarterControls.length} curated controls seeded`);

    // ─── CIS Critical Security Controls v8 ───
    // STRUCTURAL OUTLINE ONLY. CIS Controls v8 are (c) Center for Internet
    // Security, licensed CC BY-NC-SA 4.0 (NonCommercial + ShareAlike). Because
    // Inflect Compliance is a commercial product, we ship ONLY the factual
    // identifiers (Control 1-18, Safeguard numbers), the short factual titles,
    // and the IG1/IG2/IG3 structure. All descriptive text is our own paraphrase.
    // Full CIS Controls: https://www.cisecurity.org/controls. Rides the generic
    // framework/pack machinery — no special-casing.
    const cisData = require('./fixtures/cis-v8-requirements.json') as Array<{ key: string; section: string; category: string; sortOrder: number; title: string }>;
    const cisMeta = JSON.stringify({
        locale: 'en',
        provider: 'Center for Internet Security',
        packager: 'inflect',
        publicationDate: '2021-05-18',
        license: 'CC-BY-NC-SA-4.0',
        sourceUrl: 'https://www.cisecurity.org/controls',
        note: 'Structural outline only — identifiers, titles, and IG structure reused under CC BY-NC-SA 4.0; all descriptions are original paraphrases.',
        copyright:
            'CIS Critical Security Controls v8 are (c) Center for Internet ' +
            'Security and licensed CC BY-NC-SA 4.0.',
    });
    const cisFramework = await prisma.framework.upsert({
        where: { key_version: { key: 'CIS-V8', version: '8' } },
        update: { name: 'CIS Critical Security Controls v8', kind: 'INDUSTRY_STANDARD', description: 'A prioritized set of 18 controls and 153 safeguards, grouped into Implementation Groups IG1-IG3, to mitigate the most common cyber attacks.', metadataJson: cisMeta, sourceUrn: 'urn:inflect:library:cis-controls-v8' },
        create: { key: 'CIS-V8', name: 'CIS Critical Security Controls v8', version: '8', kind: 'INDUSTRY_STANDARD', description: 'A prioritized set of 18 controls and 153 safeguards, grouped into Implementation Groups IG1-IG3, to mitigate the most common cyber attacks.', metadataJson: cisMeta, sourceUrn: 'urn:inflect:library:cis-controls-v8' },
    });
    const cisReqMap: Record<string, string> = {};
    for (const req of cisData) {
        const r = await prisma.frameworkRequirement.upsert({
            where: { frameworkId_code: { frameworkId: cisFramework.id, code: req.key } },
            update: { title: req.title, section: req.section, category: req.category, sortOrder: req.sortOrder },
            create: { frameworkId: cisFramework.id, code: req.key, title: req.title, section: req.section, category: req.category, sortOrder: req.sortOrder },
        });
        cisReqMap[req.key] = r.id;
    }
    // ─── CIS v8 IG1 Starter Pack (curated essential cyber-hygiene controls) ───
    // Curated control templates — one per CIS control that carries IG1 safeguards
    // (the essential cyber-hygiene baseline) — so a CIS adopter gets mapped
    // coverage on day one, not a bare 0%. Distinct 'CIS-' code prefix. Each
    // control links to the specific IG1 safeguard requirement(s) it satisfies.
    const cisIg1Controls = require('./fixtures/cis-v8-ig1-control-templates.json') as Array<{
        code: string; title: string; description: string; defaultFrequency: string; requirements: string[]; tasks: Array<{ title: string; description: string }>;
    }>;
    for (const c of cisIg1Controls) {
        const existing = await prisma.controlTemplate.findUnique({ where: { code: c.code } });
        if (!existing) {
            const tmpl = await prisma.controlTemplate.create({
                data: {
                    code: c.code,
                    title: c.title,
                    description: c.description,
                    category: 'Cyber Hygiene',
                    defaultFrequency: c.defaultFrequency as ControlFrequency,
                },
            });
            for (const task of c.tasks) {
                await prisma.controlTemplateTask.create({ data: { templateId: tmpl.id, title: task.title, description: task.description } });
            }
            for (const rk of c.requirements) {
                if (cisReqMap[rk]) {
                    await prisma.controlTemplateRequirementLink.create({ data: { templateId: tmpl.id, requirementId: cisReqMap[rk] } }).catch(() => { });
                }
            }
        }
    }
    const cisIg1Tmpls = await prisma.controlTemplate.findMany({ where: { code: { startsWith: 'CIS-' } } });
    const cisIg1Pack = await prisma.frameworkPack.upsert({
        where: { key: 'CIS_V8_IG1_PACK' },
        update: { name: 'CIS Controls v8 — IG1 Starter Pack', frameworkId: cisFramework.id, version: '8' },
        create: { key: 'CIS_V8_IG1_PACK', name: 'CIS Controls v8 — IG1 Starter Pack', frameworkId: cisFramework.id, version: '8', description: 'Curated essential cyber-hygiene controls covering the IG1 safeguards of the CIS Critical Security Controls v8, each mapped to its safeguards.' },
    });
    for (const tmpl of cisIg1Tmpls) {
        await prisma.packTemplateLink.upsert({
            where: { packId_templateId: { packId: cisIg1Pack.id, templateId: tmpl.id } },
            create: { packId: cisIg1Pack.id, templateId: tmpl.id }, update: {},
        });
    }
    console.log(`✅ CIS Controls v8 + ${cisData.length} safeguards + IG1 Starter Pack (${cisIg1Controls.length} controls) seeded`);

    // ─── OWASP Application Security Verification Standard (ASVS) 4.0.3 ───
    // STRUCTURAL OUTLINE ONLY. OWASP ASVS is (c) the OWASP Foundation, licensed
    // CC BY-SA 4.0 (ShareAlike). Because ShareAlike would force us to relicense
    // derivative content — incompatible with Inflect Compliance as a proprietary
    // product — we ship ONLY the factual identifiers (chapters V1-V14, requirement
    // numbers such as V2.1.1), the short factual titles, and the L1/L2/L3
    // verification-level structure. All descriptive text is our own paraphrase.
    // Full standard: https://owasp.org/www-project-application-security-verification-standard/
    // Rides the generic framework/pack machinery — no special-casing.
    const asvsData = require('./fixtures/asvs-requirements.json') as Array<{ key: string; section: string; category: string; sortOrder: number; title: string }>;
    const asvsMeta = JSON.stringify({
        locale: 'en',
        provider: 'OWASP Foundation',
        packager: 'inflect',
        publicationDate: '2021-10-01',
        license: 'CC-BY-SA-4.0',
        sourceUrl: 'https://owasp.org/www-project-application-security-verification-standard/',
        note: 'Structural outline only — identifiers, titles, and L1/L2/L3 structure reused under CC BY-SA 4.0; all descriptions are original paraphrases because the share-alike term is incompatible with embedding the text in a proprietary product.',
        copyright:
            'OWASP Application Security Verification Standard 4.0.3 is (c) the ' +
            'OWASP Foundation and licensed CC BY-SA 4.0.',
    });
    const asvsFramework = await prisma.framework.upsert({
        where: { key_version: { key: 'OWASP-ASVS', version: '4.0.3' } },
        update: { name: 'OWASP Application Security Verification Standard 4.0.3', kind: 'INDUSTRY_STANDARD', description: 'Application security requirements organized into 14 chapters across three cumulative verification levels (L1, L2, L3).', metadataJson: asvsMeta, sourceUrn: 'urn:inflect:library:owasp-asvs-4.0.3' },
        create: { key: 'OWASP-ASVS', name: 'OWASP Application Security Verification Standard 4.0.3', version: '4.0.3', kind: 'INDUSTRY_STANDARD', description: 'Application security requirements organized into 14 chapters across three cumulative verification levels (L1, L2, L3).', metadataJson: asvsMeta, sourceUrn: 'urn:inflect:library:owasp-asvs-4.0.3' },
    });
    const asvsReqMap: Record<string, string> = {};
    for (const req of asvsData) {
        const r = await prisma.frameworkRequirement.upsert({
            where: { frameworkId_code: { frameworkId: asvsFramework.id, code: req.key } },
            update: { title: req.title, section: req.section, category: req.category, sortOrder: req.sortOrder },
            create: { frameworkId: asvsFramework.id, code: req.key, title: req.title, section: req.section, category: req.category, sortOrder: req.sortOrder },
        });
        asvsReqMap[req.key] = r.id;
    }
    // ─── ASVS L1 Starter Pack (curated Level 1 application-security controls) ───
    // Curated control templates — one per ASVS chapter that carries L1 requirements
    // (the Level 1 verification baseline) — so an ASVS adopter gets mapped coverage
    // on day one, not a bare 0%. Distinct 'ASVS-' code prefix. Each control links to
    // the specific L1 requirement(s) it satisfies.
    const asvsL1Controls = require('./fixtures/asvs-l1-control-templates.json') as Array<{
        code: string; title: string; description: string; defaultFrequency: string; requirements: string[]; tasks: Array<{ title: string; description: string }>;
    }>;
    for (const c of asvsL1Controls) {
        const existing = await prisma.controlTemplate.findUnique({ where: { code: c.code } });
        if (!existing) {
            const tmpl = await prisma.controlTemplate.create({
                data: {
                    code: c.code,
                    title: c.title,
                    description: c.description,
                    category: 'Application Security',
                    defaultFrequency: c.defaultFrequency as ControlFrequency,
                },
            });
            for (const task of c.tasks) {
                await prisma.controlTemplateTask.create({ data: { templateId: tmpl.id, title: task.title, description: task.description } });
            }
            for (const rk of c.requirements) {
                if (asvsReqMap[rk]) {
                    await prisma.controlTemplateRequirementLink.create({ data: { templateId: tmpl.id, requirementId: asvsReqMap[rk] } }).catch(() => { });
                }
            }
        }
    }
    const asvsL1Tmpls = await prisma.controlTemplate.findMany({ where: { code: { startsWith: 'ASVS-' } } });
    const asvsL1Pack = await prisma.frameworkPack.upsert({
        where: { key: 'ASVS_L1_PACK' },
        update: { name: 'OWASP ASVS 4.0.3 — L1 Starter Pack', frameworkId: asvsFramework.id, version: '4.0.3' },
        create: { key: 'ASVS_L1_PACK', name: 'OWASP ASVS 4.0.3 — L1 Starter Pack', frameworkId: asvsFramework.id, version: '4.0.3', description: 'Curated Level 1 application-security controls covering the L1 verification requirements of OWASP ASVS 4.0.3, each mapped to its requirements.' },
    });
    for (const tmpl of asvsL1Tmpls) {
        await prisma.packTemplateLink.upsert({
            where: { packId_templateId: { packId: asvsL1Pack.id, templateId: tmpl.id } },
            create: { packId: asvsL1Pack.id, templateId: tmpl.id }, update: {},
        });
    }
    console.log(`✅ OWASP ASVS 4.0.3 + ${asvsData.length} requirements + L1 Starter Pack (${asvsL1Controls.length} controls) seeded`);

    // ─── ISO/IEC 27701:2019 — Privacy Information Management System (PIMS) ───
    // ISO 27701 is the privacy extension of ISO 27001/27002 (controller Annex A +
    // processor Annex B). Requirement descriptions are OURS (clause-ref only — ISO
    // text is copyrighted). Ships a curated privacy starter pack so an adopter gets
    // mapped coverage on day one, not a bare 0%. Rides the generic pack machinery.
    const iso27701Data = require('./fixtures/iso27701_requirements.json') as Array<{ key: string; section: string; sortOrder: number; title: string }>;
    const iso27701Meta = JSON.stringify({
        locale: 'en',
        provider: 'ISO/IEC',
        packager: 'inflect',
        publicationDate: '2019-08-06',
        license: 'iso-copyright',
        sourceUrl: 'https://www.iso.org/standard/71670.html',
        copyright: 'Structural clause-reference outline; ISO/IEC 27701:2019 normative text is ISO-copyrighted.',
    });
    const iso27701 = await prisma.framework.upsert({
        where: { key_version: { key: 'ISO27701', version: '2019' } },
        update: { name: 'ISO/IEC 27701:2019', kind: 'ISO_STANDARD', description: 'Privacy Information Management System (PIMS) — the privacy extension of ISO/IEC 27001/27002.', metadataJson: iso27701Meta, sourceUrn: 'urn:inflect:library:iso27701-2019' },
        create: { key: 'ISO27701', name: 'ISO/IEC 27701:2019', version: '2019', kind: 'ISO_STANDARD', description: 'Privacy Information Management System (PIMS) — the privacy extension of ISO/IEC 27001/27002.', metadataJson: iso27701Meta, sourceUrn: 'urn:inflect:library:iso27701-2019' },
    });
    const iso27701ReqMap: Record<string, string> = {};
    for (const req of iso27701Data) {
        const r = await prisma.frameworkRequirement.upsert({
            where: { frameworkId_code: { frameworkId: iso27701.id, code: req.key } },
            update: { title: req.title, section: req.section, sortOrder: req.sortOrder },
            create: { frameworkId: iso27701.id, code: req.key, title: req.title, section: req.section, category: req.section, sortOrder: req.sortOrder },
        });
        iso27701ReqMap[req.key] = r.id;
    }
    // Curated privacy starter-pack controls (PIMS-NN) with tasks + requirement links.
    const iso27701Controls = require('./fixtures/iso27701-control-templates.json') as Array<{
        code: string; title: string; description: string; defaultFrequency: string; requirements: string[]; tasks: Array<{ title: string; description: string }>;
    }>;
    for (const c of iso27701Controls) {
        const existing = await prisma.controlTemplate.findUnique({ where: { code: c.code } });
        if (!existing) {
            const tmpl = await prisma.controlTemplate.create({
                data: { code: c.code, title: c.title, description: c.description, category: 'Privacy', defaultFrequency: c.defaultFrequency as ControlFrequency },
            });
            for (const task of c.tasks) {
                await prisma.controlTemplateTask.create({ data: { templateId: tmpl.id, title: task.title, description: task.description } });
            }
            for (const rk of c.requirements) {
                if (iso27701ReqMap[rk]) {
                    await prisma.controlTemplateRequirementLink.create({ data: { templateId: tmpl.id, requirementId: iso27701ReqMap[rk] } }).catch(() => { });
                }
            }
        }
    }
    const iso27701Tmpls = await prisma.controlTemplate.findMany({ where: { code: { startsWith: 'PIMS-' } } });
    const iso27701Pack = await prisma.frameworkPack.upsert({
        where: { key: 'ISO27701_BASELINE' },
        update: { name: 'ISO 27701 Privacy Baseline Pack', frameworkId: iso27701.id, version: '2019' },
        create: { key: 'ISO27701_BASELINE', name: 'ISO 27701 Privacy Baseline Pack', frameworkId: iso27701.id, version: '2019', description: 'Curated ISO/IEC 27701 privacy controls (purpose, consent, PIA, RoPA, rights, transfers) with tasks, mapped to PIMS clauses.' },
    });
    for (const tmpl of iso27701Tmpls) {
        await prisma.packTemplateLink.upsert({
            where: { packId_templateId: { packId: iso27701Pack.id, templateId: tmpl.id } },
            create: { packId: iso27701Pack.id, templateId: tmpl.id }, update: {},
        });
    }
    console.log(`✅ ISO 27701 PIMS + ${iso27701Data.length} requirements + ${iso27701Controls.length} privacy controls seeded`);

    // ─── ISO 27701 privacy risk templates ───
    // The failure modes the PIMS controls exist to prevent. frameworkTag 'ISO27701'.
    const iso27701RiskTemplates: Array<{ id: string; title: string; description: string; category: string; defaultLikelihood: number; defaultImpact: number; frameworkTag: string; linddunCategories: string[] }> = [
        { id: 'pims-no-lawful-basis', title: 'Processing Without a Valid Lawful Basis', description: 'PII is processed for a purpose that has no documented lawful basis, breaching the PIMS conditions for processing.', category: 'Privacy', defaultLikelihood: 2, defaultImpact: 5, frameworkTag: 'ISO27701', linddunCategories: ['NC'] },
        { id: 'pims-unfulfilled-rights', title: 'Unfulfilled Data-Subject Rights Request', description: 'An access, correction or erasure request is missed or answered late because no rights-handling process is in place.', category: 'Privacy', defaultLikelihood: 3, defaultImpact: 4, frameworkTag: 'ISO27701', linddunCategories: ['U'] },
        { id: 'pims-unlawful-transfer', title: 'Unlawful Cross-Border Transfer', description: 'PII is transferred to another jurisdiction without an established transfer basis or safeguards.', category: 'Privacy', defaultLikelihood: 2, defaultImpact: 4, frameworkTag: 'ISO27701', linddunCategories: ['NC'] },
        { id: 'pims-unmanaged-subprocessor', title: 'Unmanaged Sub-processor', description: 'A sub-processor handles PII without an agreement or disclosure to the customer, breaking the chain of accountability.', category: 'Privacy', defaultLikelihood: 3, defaultImpact: 4, frameworkTag: 'ISO27701', linddunCategories: ['NC'] },
        { id: 'pims-retention-overrun', title: 'PII Retained Beyond Purpose', description: 'PII is kept past its retention period or not de-identified when the processing purpose ends.', category: 'Privacy', defaultLikelihood: 3, defaultImpact: 3, frameworkTag: 'ISO27701', linddunCategories: ['DD'] },
    ];
    for (const t of iso27701RiskTemplates) {
        await prisma.riskTemplate.upsert({
            where: { id: t.id },
            create: t,
            update: { description: t.description, category: t.category, defaultLikelihood: t.defaultLikelihood, defaultImpact: t.defaultImpact, frameworkTag: t.frameworkTag, linddunCategories: t.linddunCategories },
        });
    }
    console.log(`✅ ISO 27701 privacy risk templates seeded (${iso27701RiskTemplates.length})`);

    // ─── Internal Controls library (imported from customer GRC export) ───
    // 151 deduped internal controls, seeded as GLOBAL ControlTemplates — NOT a
    // standalone pack. Each carries an objective, success criteria, and testing/
    // audit methodology (surfaced on the control detail Overview + Tests tabs) and
    // its related policy names. Framework coverage is POLICY-MEDIATED: a control's
    // exact related policies (from the source) map to ISO 27001 Annex A + NIS2
    // requirements via internal-controls-policy-framework-map.json, resolved here
    // into ControlTemplateRequirementLinks. So installing a framework pack ALSO
    // populates the internal controls whose policies map to that framework, plus
    // their policy links (see usecases/framework/install.ts).
    const internalControls = require('./fixtures/internal-controls.json') as {
        controls: Array<{ code: string; title: string; objective: string; successCriteria: string; testingMethodology: string; relatedPolicies: string[]; category: string }>;
    };
    const icPolicyFwMap = (require('./fixtures/internal-controls-policy-framework-map.json') as {
        policies: Record<string, { iso27001?: string[]; nis2?: string[] }>;
    }).policies;
    // ISO 27001 Annex A code → requirement id (NIS2 uses nis2ReqMap seeded above).
    const isoReqMap: Record<string, string> = {};
    for (const r of await prisma.frameworkRequirement.findMany({ where: { frameworkId: iso27001.id }, select: { id: true, code: true } })) {
        isoReqMap[r.code] = r.id;
    }
    let icReqLinks = 0;
    for (const c of internalControls.controls) {
        const data = {
            title: c.title,
            description: c.objective || null,
            category: c.category || null,
            objective: c.objective || null,
            successCriteria: c.successCriteria || null,
            testingMethodology: c.testingMethodology || null,
            relatedPolicies: c.relatedPolicies.join('|') || null,
        };
        const tmpl = await prisma.controlTemplate.upsert({
            where: { code: c.code },
            update: data,
            create: { code: c.code, ...data },
        });
        // Policy-mediated framework mapping → ControlTemplateRequirementLink.
        const reqIds = new Set<string>();
        for (const p of c.relatedPolicies) {
            const map = icPolicyFwMap[p];
            if (!map) continue;
            for (const code of map.iso27001 ?? []) if (isoReqMap[code]) reqIds.add(isoReqMap[code]);
            for (const code of map.nis2 ?? []) if (nis2ReqMap[code]) reqIds.add(nis2ReqMap[code]);
        }
        for (const requirementId of reqIds) {
            await prisma.controlTemplateRequirementLink.upsert({
                where: { templateId_requirementId: { templateId: tmpl.id, requirementId } },
                create: { templateId: tmpl.id, requirementId },
                update: {},
            });
            icReqLinks++;
        }
    }
    console.log(`✅ Internal Controls library + ${internalControls.controls.length} controls + ${icReqLinks} policy-mediated requirement links seeded`);

    // ISO 9001 Pack
    const iso9001Tmpls = await prisma.controlTemplate.findMany({ where: { code: { startsWith: 'QMS-' } } });
    const iso9001Pack = await prisma.frameworkPack.upsert({
        where: { key: 'ISO9001_CORE' },
        update: { name: 'ISO 9001 Core Pack', frameworkId: iso9001.id, version: '2015' },
        create: { key: 'ISO9001_CORE', name: 'ISO 9001 Core Pack', frameworkId: iso9001.id, version: '2015', description: 'ISO 9001 quality management core controls.' },
    });
    for (const tmpl of iso9001Tmpls) {
        await prisma.packTemplateLink.upsert({
            where: { packId_templateId: { packId: iso9001Pack.id, templateId: tmpl.id } },
            create: { packId: iso9001Pack.id, templateId: tmpl.id }, update: {},
        });
    }

    // ISO 28000 Pack
    const iso28000Tmpls = await prisma.controlTemplate.findMany({ where: { code: { startsWith: 'SCS-' } } });
    const iso28000Pack = await prisma.frameworkPack.upsert({
        where: { key: 'ISO28000_CORE' },
        update: { name: 'ISO 28000 Core Pack', frameworkId: iso28000.id, version: '2022' },
        create: { key: 'ISO28000_CORE', name: 'ISO 28000 Core Pack', frameworkId: iso28000.id, version: '2022', description: 'ISO 28000 supply chain security core controls.' },
    });
    for (const tmpl of iso28000Tmpls) {
        await prisma.packTemplateLink.upsert({
            where: { packId_templateId: { packId: iso28000Pack.id, templateId: tmpl.id } },
            create: { packId: iso28000Pack.id, templateId: tmpl.id }, update: {},
        });
    }

    // ISO 39001 Pack
    const iso39001Tmpls = await prisma.controlTemplate.findMany({ where: { code: { startsWith: 'RTS-' } } });
    const iso39001Pack = await prisma.frameworkPack.upsert({
        where: { key: 'ISO39001_CORE' },
        update: { name: 'ISO 39001 Core Pack', frameworkId: iso39001.id, version: '2012' },
        create: { key: 'ISO39001_CORE', name: 'ISO 39001 Core Pack', frameworkId: iso39001.id, version: '2012', description: 'ISO 39001 road traffic safety core controls.' },
    });
    for (const tmpl of iso39001Tmpls) {
        await prisma.packTemplateLink.upsert({
            where: { packId_templateId: { packId: iso39001Pack.id, templateId: tmpl.id } },
            create: { packId: iso39001Pack.id, templateId: tmpl.id }, update: {},
        });
    }

    console.log('✅ All Framework Packs seeded');

    // ─── Legacy Control Templates ───
    const legacyTemplates = [
        { code: 'AC-01', title: 'Access Control Policy', category: 'Access Control', description: 'Define and enforce access control policies.', defaultFrequency: 'ANNUALLY' as const },
        { code: 'AC-02', title: 'Account Management', category: 'Access Control', description: 'Manage user accounts lifecycle.', defaultFrequency: 'QUARTERLY' as const },
        { code: 'IR-01', title: 'Incident Response Plan', category: 'Incident Management', description: 'Establish incident response plan.', defaultFrequency: 'ANNUALLY' as const },
        { code: 'RA-01', title: 'Risk Assessment', category: 'Risk Management', description: 'Conduct regular risk assessments.', defaultFrequency: 'ANNUALLY' as const },
        { code: 'CM-01', title: 'Change Management', category: 'Operations', description: 'Control changes to production systems.', defaultFrequency: 'MONTHLY' as const },
        { code: 'SC-01', title: 'System Protection', category: 'Technical', description: 'Protect communications and enforce encryption.', defaultFrequency: 'QUARTERLY' as const },
        { code: 'BC-01', title: 'Business Continuity', category: 'Business Continuity', description: 'Maintain BC plans.', defaultFrequency: 'ANNUALLY' as const },
        { code: 'SA-01', title: 'Security Awareness', category: 'Human Resource', description: 'Security training for employees.', defaultFrequency: 'ANNUALLY' as const },
        { code: 'AU-01', title: 'Audit Logging', category: 'Operations', description: 'Audit logging and monitoring.', defaultFrequency: 'MONTHLY' as const },
        { code: 'VN-01', title: 'Vendor Risk Management', category: 'Supply Chain', description: 'Assess vendor security risks.', defaultFrequency: 'ANNUALLY' as const },
    ];
    for (const tpl of legacyTemplates) {
        const existing = await prisma.controlTemplate.findUnique({ where: { code: tpl.code } });
        if (!existing) {
            await prisma.controlTemplate.create({ data: tpl });
        }
    }
    console.log('✅ Legacy control templates seeded');

    // ─── Tasks (E2E: tasks list + CopyText(task.key) flow) ───
    // Seeds three tasks with deterministic keys (TSK-1/2/3) so the tasks
    // list is never empty and the task-key CopyText affordance always
    // has a target to exercise in E2E.
    const existingTasks = await prisma.task.count({ where: { tenantId: tenant.id } });
    if (existingTasks === 0) {
        await prisma.task.create({
            data: {
                tenantId: tenant.id,
                key: 'TSK-1',
                title: 'Implement MFA for privileged accounts',
                description: 'All privileged users must have MFA enabled within 30 days.',
                type: 'TASK',
                severity: 'HIGH',
                priority: 'P1',
                status: 'OPEN',
                source: 'MANUAL',
                createdByUserId: admin.id,
                assigneeUserId: editor.id,
            },
        });
        await prisma.task.create({
            data: {
                tenantId: tenant.id,
                key: 'TSK-2',
                title: 'Quarterly access review',
                description: 'Review and recertify user access for production systems.',
                type: 'TASK',
                severity: 'MEDIUM',
                priority: 'P2',
                status: 'IN_PROGRESS',
                source: 'MANUAL',
                createdByUserId: admin.id,
                assigneeUserId: admin.id,
            },
        });
        await prisma.task.create({
            data: {
                tenantId: tenant.id,
                key: 'TSK-3',
                title: 'Patch critical vulnerabilities',
                description: 'Apply security patches to all production systems within SLA.',
                type: 'TASK',
                severity: 'HIGH',
                priority: 'P1',
                status: 'OPEN',
                source: 'MANUAL',
                createdByUserId: editor.id,
            },
        });
        // Seed the per-tenant key counter to match. `WorkItemRepository`
        // mints `TSK-N` from `TaskKeySequence`; the #102 migration
        // backfills that counter from existing keys, but the backfill
        // runs BEFORE this seed inserts TSK-1/2/3. Without this row the
        // first API-created task mints `TSK-1` and collides with the
        // seeded task on the unique `[tenantId, key]` index.
        await prisma.taskKeySequence.upsert({
            where: { tenantId: tenant.id },
            create: { tenantId: tenant.id, lastValue: 3 },
            update: { lastValue: 3 },
        });
        console.log('✅ Tasks seeded (TSK-1 / TSK-2 / TSK-3) + key counter');
    }

    // ─── Policies (E2E: policies list + detail navigation) ───
    // Promote 3 policy templates into live tenant policies with published
    // versions so the /policies list is never empty and row-click tests
    // can navigate to a detail page.
    const existingPolicies = await prisma.policy.count({ where: { tenantId: tenant.id } });
    if (existingPolicies === 0) {
        // These titles MUST exist in one of the policy-template fixtures
        // loaded above (ciso-toolkit / imported / original-gaps). They
        // previously named templates that do not exist — 'Access Control
        // Policy' and 'Incident Response Policy' are CONTROL titles, not
        // policy templates — so the `continue` below silently skipped two
        // of the three and every seeded tenant got ONE policy while this
        // block claimed three. `tests/e2e/data-table-platform.spec.ts`
        // documents "Seed provisions 3 published policies"; it was wrong.
        const toSeed = [
            'Information Security Policy',
            'Access Management Policy',
            'Incident Management Policy',
        ];
        const missingTemplates: string[] = [];
        for (const title of toSeed) {
            const template = await prisma.policyTemplate.findFirst({ where: { title } });
            if (!template) {
                // Loudly, not silently: a renamed or removed fixture entry
                // must surface here rather than quietly shrinking the seed.
                missingTemplates.push(title);
                continue;
            }
            const policy = await prisma.policy.create({
                data: {
                    tenantId: tenant.id,
                    slug: title.replace(/\s+/g, '-').toLowerCase(),
                    title: template.title,
                    description: `Tenant adoption of ${template.title}`,
                    category: template.category || null,
                    status: 'PUBLISHED',
                    ownerUserId: admin.id,
                },
            });
            const version = await prisma.policyVersion.create({
                data: {
                    tenantId: tenant.id,
                    policyId: policy.id,
                    versionNumber: 1,
                    contentType: template.contentType,
                    contentText: template.contentText,
                    createdById: admin.id,
                },
            });
            await prisma.policy.update({
                where: { id: policy.id },
                data: { currentVersionId: version.id },
            });
        }
        // Report what ACTUALLY landed, not what was intended — the old
        // hardcoded "(3 published policies)" is precisely what hid this.
        const seededCount = await prisma.policy.count({ where: { tenantId: tenant.id } });
        if (missingTemplates.length > 0) {
            console.warn(
                `⚠️  Policy seed: ${missingTemplates.length} template(s) not found and skipped: ` +
                `${missingTemplates.join(', ')}. Check the policy-template fixtures — a rename ` +
                `or removal silently shrinks the seeded policy set.`,
            );
        }
        console.log(`✅ Policies seeded (${seededCount} published ${seededCount === 1 ? 'policy' : 'policies'})`);
    }

    // ─── ISO27001 pack install (E2E: coverage metrics + reports) ───
    // Link the seeded tenant controls to ISO27001 Annex A requirements so
    // the coverage report has mapped rows to render. Without this the
    // reporting.spec.ts "coverage metrics" test has no coverage data
    // available and would fall back to the legacy "not installed" skip.
    const tenantControls = await prisma.control.findMany({ where: { tenantId: tenant.id } });
    const annexMap: Record<string, string> = {};
    const annexReqs = await prisma.frameworkRequirement.findMany({
        where: { frameworkId: iso27001.id },
    });
    for (const r of annexReqs) annexMap[r.code] = r.id;
    for (const ctrl of tenantControls) {
        // Seed-created controls use annexId like 'A.5.1' which matches the
        // requirement code directly.
        const code = ctrl.annexId ?? '';
        const reqId = annexMap[code];
        if (!reqId) continue;
        const existing = await prisma.controlRequirementLink.findFirst({
            where: { controlId: ctrl.id, requirementId: reqId },
        });
        if (!existing) {
            await prisma.controlRequirementLink.create({
                data: { tenantId: tenant.id, controlId: ctrl.id, requirementId: reqId },
            });
        }
    }
    console.log('✅ ISO27001 control→requirement links seeded (coverage report ready)');

    // ─── Audit cycle + frozen pack + share token (E2E prerequisites) ───
    // A sizeable portion of the E2E suite depends on a tenant having an
    // existing frozen pack with a share link (tooltip-and-copy, reporting,
    // audit-readiness). Seeding this once removes the "no audit pack
    // available" / "share link not yet generated" skip branches.
    const bcryptLib = bcrypt;
    let seedCycle = await prisma.auditCycle.findFirst({
        where: { tenantId: tenant.id, frameworkKey: 'ISO27001' },
    });
    if (!seedCycle) {
        seedCycle = await prisma.auditCycle.create({
            data: {
                tenantId: tenant.id,
                frameworkKey: 'ISO27001',
                frameworkVersion: '2022',
                name: 'Seeded ISO27001 Audit Cycle',
                status: 'PLANNING',
                createdByUserId: admin.id,
            },
        });
    }
    let seedPack = await prisma.auditPack.findFirst({
        where: { tenantId: tenant.id, auditCycleId: seedCycle.id },
    });
    if (!seedPack) {
        seedPack = await prisma.auditPack.create({
            data: {
                tenantId: tenant.id,
                auditCycleId: seedCycle.id,
                name: 'Seeded ISO27001 Audit Pack',
                status: 'FROZEN',
                frozenAt: new Date(),
                frozenByUserId: admin.id,
            },
        });
        // Minimal item snapshots so the pack has content to display.
        for (let i = 0; i < tenantControls.length; i++) {
            const c = tenantControls[i];
            await prisma.auditPackItem.create({
                data: {
                    tenantId: tenant.id,
                    auditPackId: seedPack.id,
                    entityType: 'CONTROL',
                    entityId: c.id,
                    snapshotJson: JSON.stringify({ id: c.id, annexId: c.annexId, name: c.name, status: c.status }),
                    sortOrder: i,
                },
            });
        }
    }
    // Share token — create one if none is active. We use a deterministic
    // seed token so E2Es can assert against a known value and the share
    // link is consistent across `db:reset` cycles.
    const crypto = require('crypto');
    const existingShare = await prisma.auditPackShare.findFirst({
        where: { auditPackId: seedPack.id, revokedAt: null },
    });
    if (!existingShare) {
        const rawToken = crypto.randomBytes(32).toString('hex');
        const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
        await prisma.auditPackShare.create({
            data: {
                tenantId: tenant.id,
                auditPackId: seedPack.id,
                tokenHash: hash,
                createdByUserId: admin.id,
            },
        });
        console.log(`✅ Audit pack share token generated (raw token: ${rawToken})`);
    }
    console.log('✅ Audit cycle + frozen pack + share link seeded');

    // ─── Audit log entries (E2E: admin/audit-log table render) ───
    // The DataTable platform regression spec exercises the admin audit
    // log page, which renders an empty-state placeholder when there
    // are no entries. Seed a handful so the `<table>` element is always
    // present (the spec asserts on table structure, not content).
    const auditLogCount = await prisma.auditLog.count({ where: { tenantId: tenant.id } });
    if (auditLogCount === 0) {
        await prisma.auditLog.createMany({
            data: [
                { tenantId: tenant.id, userId: admin.id, entity: 'Tenant', entityId: tenant.id, action: 'TENANT_SEEDED', details: 'Initial seed', actorType: 'SYSTEM' },
                { tenantId: tenant.id, userId: admin.id, entity: 'Control', entityId: tenantControls[0]?.id ?? '', action: 'CONTROL_CREATED', details: 'Seeded control', actorType: 'USER' },
                { tenantId: tenant.id, userId: admin.id, entity: 'Risk', entityId: '', action: 'RISK_CREATED', details: 'Seeded risk', actorType: 'USER' },
                { tenantId: tenant.id, userId: admin.id, entity: 'Policy', entityId: '', action: 'POLICY_PUBLISHED', details: 'Seeded policy', actorType: 'USER' },
                { tenantId: tenant.id, userId: admin.id, entity: 'Task', entityId: '', action: 'TASK_CREATED', details: 'Seeded task', actorType: 'USER' },
            ],
        });
        console.log('✅ Audit log entries seeded (5 entries)');
    }
    // ─── OWASP AISVS — AI Vendor Security Questionnaire ───
    // A global, published VendorAssessmentTemplate the tenant sends to a
    // third-party AI vendor (BUYER assessing a SELLER's AI). Rides the existing
    // vendor-assessment send → respond → review → score flow + builder UI — this
    // is TEMPLATE CONTENT only. Questions paraphrase AISVS L1/L2 requirements
    // (referenced by ID); CC-BY-SA-4.0, attribution to OWASP. VendorAssessment-
    // Template is RLS-tenant-scoped, so the global baseline is seeded per-tenant
    // (here, the demo tenant); tenants clone+customise via the existing flow.
    const aisvsVendorQ = require('./fixtures/aisvs-vendor-questionnaire.json') as {
        key: string; name: string; description: string; attribution: string;
        sections: Array<{ title: string; weight: number; conditional: boolean; appliesTo?: string;
            questions: Array<{ aisvsId: string; level: string; weight: number; prompt: string; type?: string }> }>;
    };
    const existingAisvsTpl = await prisma.vendorAssessmentTemplate.findUnique({
        where: { tenantId_key_version: { tenantId: tenant.id, key: aisvsVendorQ.key, version: 1 } },
    });
    if (!existingAisvsTpl) {
        // Yes / Partial / No / N/A — risk points (Yes = lowest risk) for the
        // existing vendor-scoring service; per-option points mirror it.
        const SELECT_OPTIONS = [
            { label: 'Yes', value: 'yes', points: 0 },
            { label: 'Partial', value: 'partial', points: 5 },
            { label: 'No', value: 'no', points: 10 },
            { label: 'N/A', value: 'na', points: 0 },
        ];
        const SELECT_RISK = { YES: 0, PARTIAL: 5, NO: 10, 'N/A': 0 };
        const ARCHETYPE_OPTIONS = [
            { label: 'Prompt-completion (no RAG/agents)', value: 'prompt', points: 0 },
            { label: 'RAG / retrieval-augmented', value: 'rag', points: 0 },
            { label: 'Agentic / tool-using', value: 'agentic', points: 0 },
            { label: 'Other', value: 'other', points: 0 },
        ];
        const tpl = await prisma.vendorAssessmentTemplate.create({
            data: {
                tenantId: tenant.id,
                key: aisvsVendorQ.key,
                version: 1,
                isLatestVersion: true,
                isPublished: true,
                isGlobal: true,
                name: aisvsVendorQ.name,
                description: `${aisvsVendorQ.description}\n\n${aisvsVendorQ.attribution}`,
                scoringConfigJson: {
                    mode: 'WEIGHTED_AVERAGE',
                    ratingThresholds: [
                        { rating: 'LOW', minScore: 0, maxScore: 25 },
                        { rating: 'MEDIUM', minScore: 26, maxScore: 50 },
                        { rating: 'HIGH', minScore: 51, maxScore: 75 },
                        { rating: 'CRITICAL', minScore: 76, maxScore: 100 },
                    ],
                },
                createdByUserId: admin.id,
            },
        });
        let sOrder = 0;
        for (const section of aisvsVendorQ.sections) {
            const sec = await prisma.vendorAssessmentTemplateSection.create({
                data: {
                    tenantId: tenant.id,
                    templateId: tpl.id,
                    sortOrder: sOrder++,
                    title: section.title,
                    description: section.conditional ? `Applies only to ${section.appliesTo} vendors — answer N/A otherwise.` : null,
                    weight: section.weight,
                },
            });
            let qOrder = 0;
            for (const q of section.questions) {
                const isArchetype = q.type === 'ARCHETYPE';
                await prisma.vendorAssessmentTemplateQuestion.create({
                    data: {
                        tenantId: tenant.id,
                        templateId: tpl.id,
                        sectionId: sec.id,
                        sortOrder: qOrder++,
                        prompt: q.prompt,
                        answerType: 'SINGLE_SELECT',
                        required: !section.conditional && !isArchetype,
                        weight: q.weight,
                        optionsJson: isArchetype ? ARCHETYPE_OPTIONS : SELECT_OPTIONS,
                        riskPointsJson: isArchetype ? {} : SELECT_RISK,
                    },
                });
            }
        }
        const qCount = aisvsVendorQ.sections.reduce((n, s) => n + s.questions.length, 0);
        console.log(`✅ AISVS AI-vendor questionnaire seeded (${aisvsVendorQ.sections.length} sections, ${qCount} questions)`);
    }

    // Built-in vendor-assessment questionnaire templates imported from the
    // customer's prior GRC tool — the Supplier Due Diligence Questionnaire and
    // the Supplier Security Assessment. Global, published, per-tenant (RLS-
    // scoped), seeded here into the demo tenant for dev/test parity with the
    // standalone scripts/seed-vendor-questionnaires.ts (which seeds all tenants
    // on prod deploys). Idempotent via the same (tenantId,key,version) guard.
    type VendorQFixture = {
        key: string; name: string; description: string; scoringConfig: unknown;
        sections: Array<{
            title: string; description: string | null; weight: number;
            questions: Array<{
                prompt: string; answerType: string; required: boolean; weight: number;
                options?: Array<{ label: string; value: string; points: number }>;
                riskPoints?: Record<string, number>;
            }>;
        }>;
    };
    const vendorQFixtures: VendorQFixture[] = [
        require('./fixtures/vendor-questionnaire-supplier-due-diligence.json') as VendorQFixture,
        require('./fixtures/vendor-questionnaire-supplier-security-assessment.json') as VendorQFixture,
    ];
    for (const fixture of vendorQFixtures) {
        const existingVq = await prisma.vendorAssessmentTemplate.findUnique({
            where: { tenantId_key_version: { tenantId: tenant.id, key: fixture.key, version: 1 } },
        });
        if (existingVq) continue;
        const vqTpl = await prisma.vendorAssessmentTemplate.create({
            data: {
                tenantId: tenant.id,
                key: fixture.key,
                version: 1,
                isLatestVersion: true,
                isPublished: true,
                isGlobal: true,
                name: fixture.name,
                description: fixture.description,
                scoringConfigJson: fixture.scoringConfig as object,
                createdByUserId: admin.id,
            },
        });
        let vqSOrder = 0;
        for (const section of fixture.sections) {
            const vqSec = await prisma.vendorAssessmentTemplateSection.create({
                data: {
                    tenantId: tenant.id,
                    templateId: vqTpl.id,
                    sortOrder: vqSOrder++,
                    title: section.title,
                    description: section.description,
                    weight: section.weight,
                },
            });
            let vqQOrder = 0;
            for (const q of section.questions) {
                await prisma.vendorAssessmentTemplateQuestion.create({
                    data: {
                        tenantId: tenant.id,
                        templateId: vqTpl.id,
                        sectionId: vqSec.id,
                        sortOrder: vqQOrder++,
                        prompt: q.prompt,
                        answerType: q.answerType as never,
                        required: q.required,
                        weight: q.weight,
                        optionsJson: q.options ?? undefined,
                        riskPointsJson: q.riskPoints ?? undefined,
                    },
                });
            }
        }
        const vqCount = fixture.sections.reduce((n, s) => n + s.questions.length, 0);
        console.log(`✅ ${fixture.name} seeded (${fixture.sections.length} sections, ${vqCount} questions)`);
    }

    // Silence unused-binding lint for the re-exported bcrypt alias above.
    void bcryptLib;

    console.log('\n🎉 Seed complete! Login as admin@acme.com — password set via SEED_PASSWORD (default in prisma/seed.ts)');
}

main().catch(console.error).finally(() => prisma.$disconnect());
