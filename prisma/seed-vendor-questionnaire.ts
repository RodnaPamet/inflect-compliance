/**
 * Seed: Vendor Baseline Questionnaire Template
 * Run via: npx ts-node prisma/seed-vendor-questionnaire.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    const existing = await prisma.questionnaireTemplate.findUnique({ where: { key: 'VENDOR_BASELINE' } });
    if (existing) {
        console.log('VENDOR_BASELINE template already exists. Skipping seed.');
        return;
    }

    const template = await prisma.questionnaireTemplate.create({
        data: {
            key: 'VENDOR_BASELINE',
            name: 'Vendor Baseline Security Assessment',
            description: 'Standard baseline questionnaire for evaluating vendor security posture, data handling practices, and compliance readiness.',
            version: 1,
            isGlobal: true,
            questions: {
                create: [
                    // Section 1: General Security
                    { section: 'General Security', prompt: 'Does the vendor have a documented information security policy?', answerType: 'YES_NO', weight: 2, riskPointsJson: { YES: 0, NO: 8 }, required: true, sortOrder: 1 },
                    { section: 'General Security', prompt: 'Is there a dedicated security team or CISO?', answerType: 'YES_NO', weight: 1.5, riskPointsJson: { YES: 0, NO: 6 }, required: true, sortOrder: 2 },
                    { section: 'General Security', prompt: 'Does the vendor perform regular security awareness training?', answerType: 'YES_NO', weight: 1, riskPointsJson: { YES: 0, NO: 5 }, required: true, sortOrder: 3 },
                    { section: 'General Security', prompt: 'Does the vendor have an incident response plan?', answerType: 'YES_NO', weight: 2, riskPointsJson: { YES: 0, NO: 9 }, required: true, sortOrder: 4 },

                    // Section 2: Data Protection
                    { section: 'Data Protection', prompt: 'Is data encrypted at rest?', answerType: 'YES_NO', weight: 2.5, riskPointsJson: { YES: 0, NO: 10 }, required: true, sortOrder: 5 },
                    { section: 'Data Protection', prompt: 'Is data encrypted in transit (TLS/HTTPS)?', answerType: 'YES_NO', weight: 2.5, riskPointsJson: { YES: 0, NO: 10 }, required: true, sortOrder: 6 },
                    { section: 'Data Protection', prompt: 'What level of access does the vendor have to your data?', answerType: 'SINGLE_SELECT', optionsJson: ['None', 'Read-only metadata', 'Read customer data', 'Read/Write customer data'], weight: 2, riskPointsJson: { NONE: 0, 'READ-ONLY METADATA': 2, 'READ CUSTOMER DATA': 6, 'READ/WRITE CUSTOMER DATA': 10 }, required: true, sortOrder: 7 },
                    { section: 'Data Protection', prompt: 'Are data backups performed and tested regularly?', answerType: 'YES_NO', weight: 1.5, riskPointsJson: { YES: 0, NO: 6 }, required: true, sortOrder: 8 },
                    { section: 'Data Protection', prompt: 'Is there a data retention and deletion policy?', answerType: 'YES_NO', weight: 1.5, riskPointsJson: { YES: 0, NO: 5 }, required: true, sortOrder: 9 },

                    // Section 3: Compliance & Certifications
                    { section: 'Compliance', prompt: 'Does the vendor hold SOC 2 Type II certification?', answerType: 'YES_NO', weight: 2, riskPointsJson: { YES: 0, NO: 7 }, required: true, sortOrder: 10 },
                    { section: 'Compliance', prompt: 'Does the vendor hold ISO 27001 certification?', answerType: 'YES_NO', weight: 1.5, riskPointsJson: { YES: 0, NO: 5 }, required: false, sortOrder: 11 },
                    { section: 'Compliance', prompt: 'Is the vendor GDPR compliant?', answerType: 'YES_NO', weight: 2, riskPointsJson: { YES: 0, NO: 8 }, required: true, sortOrder: 12 },
                    { section: 'Compliance', prompt: 'Can the vendor provide a Data Processing Agreement (DPA)?', answerType: 'YES_NO', weight: 2, riskPointsJson: { YES: 0, NO: 7 }, required: true, sortOrder: 13 },

                    // Section 4: Access Control
                    { section: 'Access Control', prompt: 'Does the vendor enforce multi-factor authentication (MFA)?', answerType: 'YES_NO', weight: 2, riskPointsJson: { YES: 0, NO: 8 }, required: true, sortOrder: 14 },
                    { section: 'Access Control', prompt: 'Is role-based access control (RBAC) implemented?', answerType: 'YES_NO', weight: 1.5, riskPointsJson: { YES: 0, NO: 5 }, required: true, sortOrder: 15 },
                    { section: 'Access Control', prompt: 'Are access logs monitored and retained?', answerType: 'YES_NO', weight: 1.5, riskPointsJson: { YES: 0, NO: 6 }, required: true, sortOrder: 16 },

                    // Section 5: Business Continuity
                    { section: 'Business Continuity', prompt: 'Does the vendor have a business continuity / disaster recovery plan?', answerType: 'YES_NO', weight: 2, riskPointsJson: { YES: 0, NO: 7 }, required: true, sortOrder: 17 },
                    { section: 'Business Continuity', prompt: 'What is the vendor\'s guaranteed uptime SLA?', answerType: 'SINGLE_SELECT', optionsJson: ['99.99%', '99.9%', '99.5%', '99%', 'No SLA'], weight: 1.5, riskPointsJson: { '99.99%': 0, '99.9%': 1, '99.5%': 3, '99%': 5, 'NO SLA': 10 }, required: true, sortOrder: 18 },

                    // Section 6: Vulnerability Management
                    { section: 'Vulnerability Management', prompt: 'Does the vendor perform regular penetration testing?', answerType: 'YES_NO', weight: 2, riskPointsJson: { YES: 0, NO: 7 }, required: true, sortOrder: 19 },
                    { section: 'Vulnerability Management', prompt: 'Is there a responsible disclosure / bug bounty program?', answerType: 'YES_NO', weight: 1, riskPointsJson: { YES: 0, NO: 3 }, required: false, sortOrder: 20 },
                ],
            },
        },
    });

    console.log(`Seeded VENDOR_BASELINE template with ${20} questions (ID: ${template.id})`);
}

main()
    .catch((err) => {
        // Not `catch(console.error)`: that logs and returns, so the process
        // still exits 0 and a failed seed is indistinguishable from a clean
        // one. See tests/guardrails/seeders-fail-loudly.test.ts.
        console.error('❌ Vendor-questionnaire seed failed:', err);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
