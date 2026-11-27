/**
 * THE PARSE-FIDELITY SET — ten documents, each written ONCE here.
 *
 * `docs/ai-architecture/ragflow.md` Phase 0.1: documents of the kinds the
 * product actually holds (a policy PDF, an SoA export, a SOC 2 report excerpt,
 * an ISO 27001 clause list, scans for OCR, a questionnaire export, a Word
 * procedure), each with the tables and section headings a parser should find.
 *
 * Every document is authored for this repository: no customer content, no
 * copied report, no ISO text beyond clause numbers and their short titles.
 * Each spec below is the single source for TWO things:
 *
 *   - the HTML the generator renders into the committed file
 *     (`generate.ts`: Chromium for PDFs and scans, LibreOffice for DOCX and
 *     XLSX), and
 *   - the expected headings and tables (`expectedFor`), committed beside it.
 *
 * So an expectation cannot drift from its document: both come from the same
 * object, and `tests/unit/parse-fidelity-fixtures.test.ts` re-derives every
 * expected file from these specs and checks each committed binary against the
 * manifest's sha256.
 */

/** How the generator turns a spec into its committed file. */
export type FixtureRender =
    /** Born-digital PDF: Chromium prints the HTML. Real text, real fonts. */
    | 'pdf'
    /** A photographed or scanned page: rendered, degraded, saved as PNG. OCR only. */
    | 'scan-png'
    /** The same, wrapped in a PDF with no text layer. OCR only. */
    | 'scan-pdf'
    /** LibreOffice Writer from the HTML: Heading 1/2/3 styles, a real table. */
    | 'docx'
    /** LibreOffice Calc from the HTML table: one sheet, one table. */
    | 'xlsx';

export interface FixtureTable {
    /** First row is the header row. Every row has the header's width. */
    readonly rows: readonly (readonly string[])[];
}

export interface FixtureSection {
    readonly heading: string;
    /** 1 for a top-level section (h2), 2 for a subsection (h3). */
    readonly level: 1 | 2;
    readonly paragraphs?: readonly string[];
    readonly table?: FixtureTable;
}

export interface FixtureSpec {
    /** Stable id: the file's stem and the expected file's name. */
    readonly id: string;
    readonly render: FixtureRender;
    /** What the product holds that this stands for, for the record and the note. */
    readonly kind: string;
    readonly lang: 'en' | 'bg';
    /** The document title (h1). A spreadsheet has none: a sheet carries no title. */
    readonly title?: string;
    readonly sections: readonly FixtureSection[];
}

export const RENDER_FILE: Record<FixtureRender, { ext: string; mime: string }> = {
    pdf: { ext: 'pdf', mime: 'application/pdf' },
    'scan-png': { ext: 'png', mime: 'image/png' },
    'scan-pdf': { ext: 'pdf', mime: 'application/pdf' },
    docx: { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    xlsx: { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
};

export function fixtureFileName(spec: FixtureSpec): string {
    return `${spec.id}.${RENDER_FILE[spec.render].ext}`;
}

// ── The SoA rows, shared by the spreadsheet export and the two-page PDF ──────
// Control numbers are ISO/IEC 27001:2022 Annex A's; the titles are this
// repository's own short paraphrases, and every justification is invented.

const SOA_HEADER = ['Control', 'Title', 'Applicable', 'Justification', 'Status'] as const;

const SOA_THEMES: readonly (readonly [string, string])[] = [
    ['5.1', 'Information security policies'],
    ['5.2', 'Security roles and responsibilities'],
    ['5.3', 'Segregation of duties'],
    ['5.4', 'Management responsibilities'],
    ['5.5', 'Contact with authorities'],
    ['5.6', 'Contact with special interest groups'],
    ['5.7', 'Threat intelligence'],
    ['5.8', 'Security in project management'],
    ['5.9', 'Inventory of information and assets'],
    ['5.10', 'Acceptable use of assets'],
    ['5.11', 'Return of assets'],
    ['5.12', 'Classification of information'],
    ['5.13', 'Labelling of information'],
    ['5.14', 'Information transfer'],
    ['5.15', 'Access control'],
    ['5.16', 'Identity management'],
    ['5.17', 'Authentication information'],
    ['5.18', 'Access rights'],
    ['5.19', 'Security in supplier relationships'],
    ['5.20', 'Security in supplier agreements'],
    ['5.21', 'ICT supply chain security'],
    ['5.22', 'Monitoring of supplier services'],
    ['5.23', 'Security for cloud services'],
    ['5.24', 'Incident management planning'],
    ['5.25', 'Assessment of security events'],
    ['5.26', 'Response to incidents'],
    ['5.27', 'Learning from incidents'],
    ['5.28', 'Collection of evidence'],
    ['5.29', 'Security during disruption'],
    ['5.30', 'ICT readiness for continuity'],
    ['5.31', 'Legal and contractual requirements'],
    ['5.32', 'Intellectual property rights'],
    ['5.33', 'Protection of records'],
    ['5.34', 'Privacy and protection of PII'],
    ['5.35', 'Independent review of security'],
    ['5.36', 'Compliance with policies and standards'],
    ['5.37', 'Documented operating procedures'],
    ['6.1', 'Screening'],
    ['6.2', 'Terms of employment'],
    ['6.3', 'Awareness, education and training'],
    ['6.4', 'Disciplinary process'],
    ['6.5', 'Responsibilities after termination'],
    ['6.6', 'Confidentiality agreements'],
    ['6.7', 'Remote working'],
    ['6.8', 'Event reporting'],
];

const SOA_STATUSES = ['Implemented', 'Partially implemented', 'Planned'] as const;

function soaRows(count: number): string[][] {
    return SOA_THEMES.slice(0, count).map(([id, title], i) => {
        // Every eleventh control is out of scope, so the column is not constant.
        const applicable = i % 11 === 10 ? 'No' : 'Yes';
        const justification =
            applicable === 'No'
                ? 'No in-house development or physical site in scope'
                : `Required by risk R-${String(100 + i).padStart(3, '0')}`;
        const status = applicable === 'No' ? 'Not applicable' : SOA_STATUSES[i % SOA_STATUSES.length];
        return [id, title, applicable, justification, status];
    });
}

// ── The ten specs ────────────────────────────────────────────────────────────

export const FIXTURES: readonly FixtureSpec[] = [
    {
        id: '01-policy-infosec',
        render: 'pdf',
        kind: 'policy PDF (born digital)',
        lang: 'en',
        title: 'Information Security Policy',
        sections: [
            {
                heading: '1 Purpose',
                level: 1,
                paragraphs: [
                    'This policy sets out how Example Ltd protects the confidentiality, integrity and availability of the information it holds and processes.',
                    'It applies the requirements of the information security management system to every team and every system.',
                ],
            },
            {
                heading: '2 Scope',
                level: 1,
                paragraphs: [
                    'The policy covers all employees, contractors and suppliers with access to company information, wherever they work.',
                ],
            },
            {
                heading: '3 Roles and responsibilities',
                level: 1,
                paragraphs: ['Each role below owns part of the security programme and reviews it on the stated cycle.'],
                table: {
                    rows: [
                        ['Role', 'Responsibility', 'Review frequency'],
                        ['Chief Executive', 'Approves this policy and the risk appetite', 'Annual'],
                        ['Security Officer', 'Maintains the risk register and the control set', 'Quarterly'],
                        ['System Owner', 'Grants and recertifies access to the system', 'Quarterly'],
                        ['People Team', 'Runs screening and security awareness training', 'Annual'],
                        ['All Staff', 'Report suspected incidents within one hour', 'Continuous'],
                    ],
                },
            },
            {
                heading: '4 Policy statements',
                level: 1,
                paragraphs: ['The statements below are mandatory. Exceptions follow section 5.'],
            },
            {
                heading: '4.1 Access control',
                level: 2,
                paragraphs: [
                    'Access is granted on the principle of least privilege and removed within one working day of a leaver’s last day.',
                ],
            },
            {
                heading: '4.2 Cryptography',
                level: 2,
                paragraphs: ['Data at rest is encrypted with keys held in a managed key service, and keys are rotated every year.'],
            },
            {
                heading: '4.3 Supplier relationships',
                level: 2,
                paragraphs: ['A supplier with access to personal data is assessed before onboarding and every year after.'],
            },
            {
                heading: '5 Exceptions',
                level: 1,
                paragraphs: ['An exception is requested in writing, approved by the Security Officer, and expires after ninety days.'],
            },
            {
                heading: '6 Review',
                level: 1,
                paragraphs: ['This policy is reviewed every year and after any significant change to the business.'],
            },
        ],
    },
    {
        id: '02-policy-bg',
        render: 'pdf',
        kind: 'policy PDF in Bulgarian (Cyrillic)',
        lang: 'bg',
        title: 'Политика за информационна сигурност',
        sections: [
            {
                heading: '1 Цел',
                level: 1,
                paragraphs: [
                    'Тази политика определя как Примерна ООД защитава поверителността, целостта и наличността на информацията.',
                ],
            },
            {
                heading: '2 Обхват',
                level: 1,
                paragraphs: ['Политиката се прилага за всички служители, изпълнители и доставчици с достъп до фирмена информация.'],
            },
            {
                heading: '3 Роли и отговорности',
                level: 1,
                table: {
                    rows: [
                        ['Роля', 'Отговорност', 'Преглед'],
                        ['Управител', 'Одобрява политиката и апетита за риск', 'Годишно'],
                        ['Служител по сигурността', 'Поддържа регистъра на рисковете', 'Тримесечно'],
                        ['Собственик на система', 'Предоставя и преразглежда достъпа', 'Тримесечно'],
                        ['Всички служители', 'Докладват инциденти до един час', 'Постоянно'],
                    ],
                },
            },
            {
                heading: '4 Контрол на достъпа',
                level: 1,
                paragraphs: ['Достъпът се предоставя по принципа на най-малките привилегии и се отнема до един работен ден след напускане.'],
            },
            {
                heading: '5 Преглед',
                level: 1,
                paragraphs: ['Политиката се преглежда ежегодно и след всяка съществена промяна.'],
            },
        ],
    },
    {
        id: '03-soa-export',
        render: 'xlsx',
        kind: 'Statement of Applicability export (spreadsheet)',
        lang: 'en',
        sections: [
            {
                heading: 'Statement of Applicability',
                level: 1,
                table: { rows: [[...SOA_HEADER], ...soaRows(20)] },
            },
        ],
    },
    {
        id: '04-soa-two-page',
        render: 'pdf',
        kind: 'Statement of Applicability PDF (a table across a page break)',
        lang: 'en',
        title: 'Statement of Applicability',
        sections: [
            {
                heading: 'Annex A controls',
                level: 1,
                paragraphs: ['Version 3, approved by the Security Officer. Controls 5.1 to 6.8.'],
                table: { rows: [[...SOA_HEADER], ...soaRows(45)] },
            },
        ],
    },
    {
        id: '05-soc2-excerpt',
        render: 'pdf',
        kind: 'vendor SOC 2 Type II report excerpt (synthetic)',
        lang: 'en',
        title: 'Report on Controls Relevant to Security at Example Cloud Ltd',
        sections: [
            {
                heading: "Section I: Independent Service Auditor's Report",
                level: 1,
                paragraphs: [
                    'We have examined the description of the system and the suitability of the design and operating effectiveness of the controls stated in it.',
                    'In our opinion, in all material respects, the controls operated effectively throughout the period 1 January 2026 to 30 June 2026.',
                ],
            },
            {
                heading: 'Section IV: Description of Tests of Controls and Results',
                level: 1,
                paragraphs: ['The tests below were performed on a sample of the population for the whole period.'],
                table: {
                    rows: [
                        ['Ref', 'Control activity', 'Test performed', 'Result'],
                        [
                            'CC6.1',
                            'Logical access to production systems requires multi-factor authentication through the corporate identity provider.',
                            'Inspected the identity provider configuration and a sample of 25 sign-in events.',
                            'No exceptions noted.',
                        ],
                        [
                            'CC6.2',
                            'New user access is approved by the system owner before it is provisioned.',
                            'Inspected approval tickets for a sample of 25 new users.',
                            'One exception: access granted one day before approval.',
                        ],
                        [
                            'CC6.3',
                            'Access of leavers is removed within one business day of termination.',
                            'Compared the HR leaver list with directory deactivation dates for 25 leavers.',
                            'No exceptions noted.',
                        ],
                        [
                            'CC7.2',
                            'Security events are monitored and alerts are triaged within four hours.',
                            'Inspected the alert queue for a sample of 40 alerts.',
                            'No exceptions noted.',
                        ],
                        [
                            'CC8.1',
                            'Changes to production are peer reviewed and pass automated tests before deployment.',
                            'Inspected change records for a sample of 40 deployments.',
                            'No exceptions noted.',
                        ],
                        [
                            'A1.2',
                            'Backups are taken daily, and a restore is tested every quarter.',
                            'Inspected backup logs and the two quarterly restore test records.',
                            'No exceptions noted.',
                        ],
                    ],
                },
            },
        ],
    },
    {
        id: '06-iso27001-clauses',
        render: 'pdf',
        kind: 'ISO 27001 clause list',
        lang: 'en',
        title: 'ISO/IEC 27001:2022 Requirements Checklist',
        sections: [
            { heading: '4 Context of the organization', level: 1, paragraphs: ['Internal and external issues, interested parties, and the scope of the ISMS.'] },
            { heading: '5 Leadership', level: 1, paragraphs: ['Leadership commitment, the information security policy, and roles.'] },
            { heading: '6 Planning', level: 1, paragraphs: ['Actions to address risks and opportunities, and information security objectives.'] },
            { heading: '6.1 Actions to address risks and opportunities', level: 2, paragraphs: ['Risk assessment and risk treatment, including the Statement of Applicability.'] },
            { heading: '7 Support', level: 1, paragraphs: ['Resources, competence, awareness, communication and documented information.'] },
            { heading: '8 Operation', level: 1, paragraphs: ['Operational planning, risk assessments and risk treatment carried out at planned intervals.'] },
            { heading: '9 Performance evaluation', level: 1, paragraphs: ['Monitoring, internal audit and management review.'] },
            { heading: '10 Improvement', level: 1, paragraphs: ['Continual improvement, nonconformity and corrective action.'] },
            {
                heading: 'Annex A themes',
                level: 1,
                table: {
                    rows: [
                        ['Theme', 'Clause', 'Controls'],
                        ['Organizational controls', 'A.5', '37'],
                        ['People controls', 'A.6', '8'],
                        ['Physical controls', 'A.7', '14'],
                        ['Technological controls', 'A.8', '34'],
                    ],
                },
            },
        ],
    },
    {
        id: '07-scanned-access-review',
        render: 'scan-png',
        kind: 'scanned access review sign-off (image, OCR)',
        lang: 'en',
        title: 'Quarterly Access Review Q3 2026',
        sections: [
            {
                heading: 'Finance system',
                level: 1,
                paragraphs: ['Reviewed by the system owner on 2 October 2026.'],
                table: {
                    rows: [
                        ['User', 'Role', 'Decision'],
                        ['Anna Petrova', 'Approver', 'Keep'],
                        ['Boris Ivanov', 'Administrator', 'Remove'],
                        ['Clara Jones', 'Viewer', 'Keep'],
                        ['David Smith', 'Approver', 'Modify'],
                        ['Elena Georgieva', 'Viewer', 'Keep'],
                    ],
                },
            },
            { heading: 'Sign-off', level: 1, paragraphs: ['All decisions above were applied by 9 October 2026.'] },
        ],
    },
    {
        id: '08-scanned-bcp-test',
        render: 'scan-pdf',
        kind: 'scanned evidence PDF with no text layer (OCR)',
        lang: 'en',
        title: 'Business Continuity Test Summary',
        sections: [
            {
                heading: 'Test scope',
                level: 1,
                paragraphs: ['A full failover of the customer portal to the secondary region was performed on 14 September 2026.'],
            },
            {
                heading: 'Results',
                level: 1,
                table: {
                    rows: [
                        ['Measure', 'Target', 'Achieved'],
                        ['Recovery time', '4 hours', '2 hours 35 minutes'],
                        ['Recovery point', '15 minutes', '6 minutes'],
                        ['Data integrity checks', '100%', '100%'],
                    ],
                },
            },
            { heading: 'Follow-up actions', level: 1, paragraphs: ['Update the runbook with the new DNS step before the next test.'] },
        ],
    },
    {
        id: '09-vendor-questionnaire',
        render: 'xlsx',
        kind: 'vendor security questionnaire export (spreadsheet)',
        lang: 'en',
        sections: [
            {
                heading: 'Questionnaire',
                level: 1,
                table: {
                    rows: [
                        ['ID', 'Section', 'Question', 'Answer', 'Evidence'],
                        ['Q1', 'Governance', 'Do you maintain an information security policy approved by management?', 'Yes', 'Policy v4'],
                        ['Q2', 'Governance', 'Is the policy reviewed at least once a year?', 'Yes', 'Review minutes'],
                        ['Q3', 'Access', 'Is multi-factor authentication enforced for all staff?', 'Yes', 'IdP report'],
                        ['Q4', 'Access', 'Are access rights reviewed every quarter?', 'Yes', 'Q3 review'],
                        ['Q5', 'Access', 'Are leavers removed within one business day?', 'Partially', 'HR process'],
                        ['Q6', 'Data', 'Is customer data encrypted at rest?', 'Yes', 'Key policy'],
                        ['Q7', 'Data', 'Where is customer data stored?', 'EU region', 'Data map'],
                        ['Q8', 'Operations', 'Are backups tested at least quarterly?', 'Yes', 'Restore log'],
                        ['Q9', 'Operations', 'Do you run vulnerability scans every month?', 'Yes', 'Scan report'],
                        ['Q10', 'Incidents', 'Will you notify us of a breach within 24 hours?', 'Yes', 'DPA clause 9'],
                        ['Q11', 'Incidents', 'Do you test your incident response plan?', 'No', 'Planned Q1'],
                        ['Q12', 'Suppliers', 'Do you assess your own sub-processors?', 'Yes', 'Vendor register'],
                    ],
                },
            },
        ],
    },
    {
        id: '10-incident-procedure',
        render: 'docx',
        kind: 'incident response procedure (Word)',
        lang: 'en',
        title: 'Incident Response Procedure',
        sections: [
            { heading: 'Detection', level: 1, paragraphs: ['Anyone who suspects an incident reports it to the security channel straight away.'] },
            { heading: 'Triage', level: 1, paragraphs: ['The on-call engineer classifies the incident within one hour using the severity matrix.'] },
            {
                heading: 'Notification',
                level: 1,
                paragraphs: ['A significant incident is notified to the national CSIRT on the timeline below.'],
                table: {
                    rows: [
                        ['Report', 'Deadline', 'Recipient'],
                        ['Early warning', 'Within 24 hours', 'National CSIRT'],
                        ['Incident notification', 'Within 72 hours', 'National CSIRT'],
                        ['Final report', 'Within one month', 'National CSIRT'],
                    ],
                },
            },
            { heading: 'Containment and recovery', level: 1, paragraphs: ['Affected systems are isolated, restored from known-good backups and monitored.'] },
            { heading: 'Lessons learned', level: 2, paragraphs: ['A review is held within two weeks and its actions are tracked as tasks.'] },
        ],
    },
];

// ── Expectations, derived ────────────────────────────────────────────────────

export interface ExpectedHeading {
    readonly text: string;
    /** 0 for the title, then the section level. Reported, never scored. */
    readonly level: number;
}

export interface FixtureExpectation {
    readonly id: string;
    readonly file: string;
    readonly mime: string;
    readonly kind: string;
    readonly lang: 'en' | 'bg';
    /** Needs OCR: the file carries no text layer. */
    readonly ocr: boolean;
    readonly headings: readonly ExpectedHeading[];
    readonly tables: readonly FixtureTable[];
}

/**
 * What a parser should find. A spreadsheet's headings are empty: a sheet has
 * no headings to find, and its section heading is the sheet name, which
 * Docling is not asked to report as one.
 */
export function expectedFor(spec: FixtureSpec): FixtureExpectation {
    const spreadsheet = spec.render === 'xlsx';
    const headings: ExpectedHeading[] = [];
    if (!spreadsheet) {
        if (spec.title) headings.push({ text: spec.title, level: 0 });
        for (const s of spec.sections) headings.push({ text: s.heading, level: s.level });
    }
    return {
        id: spec.id,
        file: fixtureFileName(spec),
        mime: RENDER_FILE[spec.render].mime,
        kind: spec.kind,
        lang: spec.lang,
        ocr: spec.render === 'scan-png' || spec.render === 'scan-pdf',
        headings,
        tables: spec.sections.flatMap((s) => (s.table ? [s.table] : [])),
    };
}

// ── The HTML every rendering starts from ─────────────────────────────────────

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function tableHtml(t: FixtureTable): string {
    const [header, ...body] = t.rows;
    const th = header.map((c) => `<th>${esc(c)}</th>`).join('');
    const trs = body.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('\n');
    // <thead> makes Chromium repeat the header row after a page break, as a
    // real exported report does.
    return `<table>\n<thead><tr>${th}</tr></thead>\n<tbody>\n${trs}\n</tbody>\n</table>`;
}

/**
 * The document as HTML. A spreadsheet's HTML is its table alone, so Calc reads
 * one table into one sheet with the header in row 1.
 */
export function htmlFor(spec: FixtureSpec): string {
    const style = `
    body { font-family: 'DejaVu Sans', 'Liberation Sans', sans-serif; font-size: 11pt; line-height: 1.4; margin: 0; }
    h1 { font-size: 20pt; margin: 0 0 12pt; }
    h2 { font-size: 14pt; margin: 16pt 0 6pt; }
    h3 { font-size: 12pt; margin: 12pt 0 4pt; }
    p { margin: 0 0 6pt; }
    table { border-collapse: collapse; width: 100%; margin: 6pt 0 10pt; }
    th, td { border: 1px solid #333; padding: 4pt 6pt; text-align: left; vertical-align: top; }
    th { background: #e5e5e5; }
    tr { break-inside: avoid; }`;
    let body: string;
    if (spec.render === 'xlsx') {
        body = spec.sections.map((s) => (s.table ? tableHtml(s.table) : '')).join('\n');
    } else {
        const parts: string[] = [];
        if (spec.title) parts.push(`<h1>${esc(spec.title)}</h1>`);
        for (const s of spec.sections) {
            parts.push(`<h${s.level + 1}>${esc(s.heading)}</h${s.level + 1}>`);
            for (const p of s.paragraphs ?? []) parts.push(`<p>${esc(p)}</p>`);
            if (s.table) parts.push(tableHtml(s.table));
        }
        body = parts.join('\n');
    }
    return `<!doctype html>\n<html lang="${spec.lang}">\n<head>\n<meta charset="utf-8">\n<title>${esc(spec.title ?? spec.id)}</title>\n<style>${style}\n</style>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
}
