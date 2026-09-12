/**
 * Render the agent-governance pack as the plain-text document that gets FILED.
 *
 * The pack on screen is read by somebody who is already in the product, with the
 * banner above it and the register one click away. The exported document is read
 * by somebody who is not: an assessor, months later, holding a file. Every piece
 * of context the screen supplies by being the screen has to be written INTO this
 * text or it is gone.
 *
 * ── THE CAVEAT IS THE WHOLE REASON THIS MODULE EXISTS ───────────────────────
 *
 * When `requireRegisteredAgent` is off, the register is a list of the agents
 * somebody chose to write down, and an unregistered agent acts unimpeded. Every
 * figure below is then a count over a voluntary sample, not a population. On
 * screen that is survivable, because the enablement banner is right there. In a
 * filed document it is the difference between evidence and a misrepresentation,
 * and a filed document outlives the conversation that would have corrected it.
 *
 * So the caveat is the FIRST thing in the body, above the stamp, and it is not
 * conditional on anything but the flag. `tests/unit/agentic-pack-document.test.ts`
 * asserts it in BOTH directions: a renderer that emitted it unconditionally
 * would pass a one-way test while telling every enforcing tenant their own pack
 * is worthless, which is its own kind of wrong answer.
 *
 * ── NO FIGURE IS EVER COERCED ──────────────────────────────────────────────
 *
 * A `Measure` that is not MEASURED renders its basis CODE and the sentence that
 * code stands for — never `0`, never a blank, never an em dash. The four states
 * exist precisely because "we counted none" and "there was nothing to count" and
 * "nobody has assessed this" are different answers to an assessor's question,
 * and flattening them here would undo the work `report-measures.ts` did to keep
 * them apart.
 *
 * The basis map below is typed `Record<MeasureBasis, string>` ON PURPOSE.
 * Written as `Record<string, string>` it compiled with SEVEN INVENTED KEYS —
 * names recalled rather than read — so seven of the twelve real codes fell
 * through to "no explanation is registered for this code", in the one artefact
 * whose whole job is explaining its own absences. The PAGE never had this bug,
 * because `agents-copy-keys-resolve` checks its i18n keys resolve; the document
 * had no equivalent, and this type is now that guard. A unit test is not a
 * substitute: the one written alongside it asserted the same invented constant
 * and passed.
 *
 * ── THE DEFINITIONS TRAVEL WITH IT ─────────────────────────────────────────
 *
 * Every metric the document cites gets its population, moment, inclusions and
 * exclusions written out in the appendix. A figure whose definition stayed
 * behind in the product cannot be challenged, and a figure that cannot be
 * challenged is not evidence.
 *
 * Pure: no clock, no I/O, no Prisma. The `generatedAt` it stamps is the pack's
 * own, so re-rendering a stored pack cannot silently restamp it.
 */
import { sanitizePlainText } from '@/lib/security/sanitize';

import type { Measure, MeasureBasis } from './report-measures';
import type { MetricDefinition } from './report-definitions';

/** Tenant-controlled text is stripped by the caller; this only bounds length. */
const MAX_FIELD = 200;

/** How many rows of any one list the document enumerates before summarising. */
export const DOCUMENT_ROW_CAP = 100;

/**
 * What each non-MEASURED basis MEANS, in the document's own words.
 *
 * Written here rather than pulled from the UI message catalogue on purpose: the
 * document is not localised. It is filed, cited, and read by people outside the
 * workspace, and a figure whose explanation changes with the reader's locale is
 * a figure two readers can disagree about while both quoting it correctly.
 */
const BASIS_SENTENCE: Record<MeasureBasis, string> = {
    NO_AGENTS_REGISTERED: 'No agents are registered, so there is nothing to count.',
    NO_AGENTS_IN_SCOPE: 'No agent of the kind this figure counts over exists here.',
    ASI_FRAMEWORK_NOT_INSTALLED:
        'The OWASP agentic framework is not installed in this workspace, so ' +
        'coverage has not been assessed. This is NOT a coverage of zero.',
    ASI_FRAMEWORK_EMPTY:
        'The agentic framework is installed but carries no risk rows, so there ' +
        'is nothing to assess against — which is not the same as failing to cover them.',
    NO_DECIDED_PROPOSALS: 'No proposal was approved or rejected in the window.',
    BELOW_REPORTABLE_SAMPLE:
        'Decisions exist, but too few to report a rate without misleading.',
    NO_ANSWERED_SAMPLE_AUDITS:
        'No sampled approval has been re-checked, so a disagreement rate has no base.',
    NO_DRILLS_RUN:
        'The stop control has never been drilled, so nothing has been proven about it.',
    ALL_DRILLS_ERRORED:
        'Drills ran and every one of them errored, so none produced a ' +
        'measurement. Distinct from never having drilled: the control is not ' +
        'unproven here, it is failing to be exercised.',
    NO_KILLS_ENGAGED: 'No kill switch was engaged in the window.',
    NO_SUPPLYING_VENDORS:
        'No vendor supplies an agent here, so vendor assurance has no subject.',
    OUTSIDE_PLATFORM_BOUNDARY:
        'This fact is not observable from inside this platform. See the definition.',
};

/**
 * THE ONE FUNNEL every tenant-controlled string passes through.
 *
 * Agent names, kill reasons, vendor names and framework labels are all written
 * by people in the workspace, and this document is filed, re-read and in some
 * deployments re-rendered by a viewer that is not a terminal. Stripping here
 * rather than at each of the thirty-odd call sites is deliberate: a funnel can
 * be audited by reading one function, and a per-site convention cannot.
 *
 * Sanitising at field level rather than over the finished document, because the
 * document's own structure (rules, arrows, the `!!` banner) is content too, and
 * a pass over the whole string would put it at the mercy of the sanitiser's
 * idea of markup.
 */
function clip(s: string | null | undefined): string {
    if (s == null || s === '') return '(none)';
    const clean = sanitizePlainText(s);
    if (clean === '') return '(none)';
    return clean.length > MAX_FIELD ? `${clean.slice(0, MAX_FIELD)}…` : clean;
}

/** Risk codes come from an installable framework, so they are tenant text too. */
function codes(list: readonly string[]): string {
    if (list.length === 0) return '(none)';
    return list.map((c) => sanitizePlainText(c)).join(', ');
}

function iso(d: Date | null | undefined): string {
    return d ? d.toISOString() : '(never)';
}

/**
 * One figure, with its state carried rather than resolved away.
 *
 * `MEASURED` with a value of 0 prints `0` — that is a real count and reads as
 * one. Every other state prints its code first, because the code is what
 * aggregates across a set of packs, and then the sentence, because the code
 * alone is not readable by the person the document is for.
 */
export function renderMeasure(id: string, measure: Measure | undefined): string {
    if (!measure) return `${id}: NOT REPORTED (no measure was produced for this id)`;
    if (measure.state === 'MEASURED') return `${id}: ${measure.value}`;
    const sentence = BASIS_SENTENCE[measure.basis] ?? 'No explanation is registered for this code.';
    return `${id}: ${measure.state} [${measure.basis}] — ${sentence}`;
}

function renderMetrics(metrics: Partial<Record<string, Measure>>): string[] {
    const ids = Object.keys(metrics).sort();
    if (ids.length === 0) return ['  (this report publishes no figures)'];
    return ids.map((id) => `  ${renderMeasure(id, metrics[id])}`);
}

function renderDefinitions(defs: readonly MetricDefinition[]): string[] {
    const out: string[] = [];
    for (const d of [...defs].sort((a, b) => a.id.localeCompare(b.id))) {
        out.push(`  ${d.id} — ${d.label}`);
        out.push(`    Population: ${d.population}`);
        out.push(
            `    Moment: ${d.moment === 'OVER_WINDOW' ? 'measured over the reporting window' : 'true as of the generation instant'}`,
        );
        for (const inc of d.includes) out.push(`    Includes: ${inc}`);
        for (const exc of d.excludes) out.push(`    Excludes: ${exc}`);
        out.push('');
    }
    return out;
}

/** Shapes this module reads. Structural, so the usecase can pass the pack as-is. */
interface Envelope {
    reportId: string;
    generatedAt: Date;
    window: { days: number; since: Date } | null;
    truncated: boolean;
    metrics: Partial<Record<string, Measure>>;
    definitions: readonly MetricDefinition[];
    body: unknown;
}

export interface PackDocumentInput {
    pack: {
        generatedAt: Date;
        tenantId: string;
        inventory: Envelope;
        asiCoverage: Envelope;
        approvals: Envelope;
        incidents: Envelope;
        thirdParty: Envelope;
    };
    /** `requireRegisteredAgent`. FALSE turns every count into a voluntary sample. */
    enforcing: boolean;
    /** MCP-capable credentials bound to no agent — the size of the blind spot. */
    unboundCredentials: number;
    /** Who asked for the export. Named in the document, not just in the audit row. */
    exportedByUserId: string;
    /** Workspace name as the operator knows it, already stripped by the caller. */
    workspaceName: string;
}

const RULE = '='.repeat(78);
const THIN = '-'.repeat(78);

/**
 * The caveat block. Returned as lines so the caller can put it FIRST without
 * the renderer having to trust it to.
 */
function caveatLines(input: PackDocumentInput): string[] {
    if (input.enforcing) {
        return [
            'REGISTRATION IS ENFORCED in this workspace. An unregistered agent cannot',
            'obtain a credential that acts here, so the register below is the population',
            'and not a sample of it.',
            '',
        ];
    }
    return [
        '!! READ THIS FIRST — THE FIGURES BELOW ARE A SAMPLE, NOT A POPULATION !!',
        '',
        'Agent registration is NOT ENFORCED in this workspace (requireRegisteredAgent',
        'is off). An agent that was never written into the register can act here',
        'unimpeded, and nothing in this document would show it. Every count, every',
        'percentage and every "none found" below describes only the agents somebody',
        'chose to register.',
        '',
        `Credentials that can call agent tools while bound to NO agent: ${input.unboundCredentials}`,
        'Each one is an actor this document does not describe.',
        '',
        'This pack is a fair account of the register. It is not an account of what',
        'acted in this workspace, and it must not be read as one.',
        '',
    ];
}

export function renderGovernancePackDocument(input: PackDocumentInput): string {
    const { pack } = input;
    const L: string[] = [];

    L.push(RULE);
    L.push('AGENT GOVERNANCE PACK');
    L.push(RULE);
    L.push('');

    // The caveat precedes the stamp deliberately: a reader who stops after the
    // first screen must have stopped AFTER the thing that qualifies everything.
    L.push(...caveatLines(input));

    L.push(THIN);
    L.push('PROVENANCE');
    L.push(THIN);
    L.push(`Workspace:      ${clip(input.workspaceName)}`);
    L.push(`Workspace id:   ${pack.tenantId}`);
    L.push(`Generated at:   ${iso(pack.generatedAt)} (UTC)`);
    L.push(`Exported by:    ${input.exportedByUserId}`);
    const w = pack.approvals.window ?? pack.incidents.window;
    L.push(
        w
            ? `Window:         ${w.days} days, from ${iso(w.since)} to ${iso(pack.generatedAt)}`
            : 'Window:         (no windowed figure in this pack)',
    );
    L.push('');
    L.push('Figures marked AS_OF_GENERATION are true at the instant above. Figures');
    L.push('marked OVER_WINDOW are counted across the window above. The two are not');
    L.push('comparable and are never summed.');
    L.push('');

    const section = (heading: string, env: Envelope, bodyLines: string[]): void => {
        L.push(THIN);
        L.push(heading);
        L.push(THIN);
        if (env.truncated) {
            L.push(
                `TRUNCATED — the underlying population exceeded this pack's row cap, so the`,
            );
            L.push('rows below are not the whole of it. Narrow the window or read the register.');
            L.push('');
        }
        L.push('Figures:');
        L.push(...renderMetrics(env.metrics));
        L.push('');
        L.push(...bodyLines);
        L.push('');
    };

    // ── 1 — inventory ───────────────────────────────────────────────────────
    const inv = pack.inventory.body as {
        agents: {
            agentId: string;
            name: string;
            status: string;
            autonomyLevel: number;
            unattended: boolean;
            ownerName: string | null;
            ownerUserId: string;
            riskTier: string | null;
            assessmentState: string;
            killState: string;
            policyCardVersion: number | null;
        }[];
        legacyPlaceholderPresent: boolean;
    };
    const invLines: string[] = ['Register:'];
    if (inv.agents.length === 0) {
        invLines.push('  No agent is registered in this workspace.');
    }
    for (const a of inv.agents.slice(0, DOCUMENT_ROW_CAP)) {
        invLines.push(
            `  ${clip(a.name)} [${a.agentId}] — ${a.status}, autonomy ${a.autonomyLevel}` +
                `${a.unattended ? ' (UNATTENDED)' : ''}`,
        );
        invLines.push(
            `    Owner: ${clip(a.ownerName) === '(none)' ? a.ownerUserId : clip(a.ownerName)}` +
                ` · Risk tier: ${a.riskTier ?? 'UNSCORED'} (${a.assessmentState})` +
                ` · Policy card: ${a.policyCardVersion === null ? 'NONE' : `v${a.policyCardVersion}`}` +
                ` · ${a.killState}`,
        );
    }
    if (inv.agents.length > DOCUMENT_ROW_CAP) {
        invLines.push(`  … and ${inv.agents.length - DOCUMENT_ROW_CAP} more, not enumerated here.`);
    }
    if (inv.legacyPlaceholderPresent) {
        invLines.push('');
        invLines.push(
            '  NOTE: a legacy placeholder row is present. It adopts proposals raised',
        );
        invLines.push(
            '  before the register existed, is counted OUT of every figure above, and',
        );
        invLines.push('  represents work nobody has yet attributed to a real agent.');
    }
    section('1 — AGENT INVENTORY', pack.inventory, invLines);

    // ── 2 — ASI coverage ────────────────────────────────────────────────────
    const asi = pack.asiCoverage.body as {
        frameworkInstalled: boolean;
        framework: { key: string; name: string } | null;
        agents: {
            agentId: string;
            name: string;
            covered: string[];
            partiallyCovered: string[];
            reviewNeeded: string[];
            uncovered: string[];
            notApplicable: string[];
        }[];
    };
    const asiLines: string[] = [];
    // Two unrelated figures in this product are called "ASI coverage". Naming
    // which one this is costs three lines and prevents an assessor being handed
    // a number about the platform's own source tree as though it described them.
    asiLines.push('WHICH "ASI COVERAGE" THIS IS: the coverage of THIS WORKSPACE\'S control');
    asiLines.push('library against THIS WORKSPACE\'S registered agents. It is unrelated to the');
    asiLines.push("platform's internal CI measure of the same name, which describes the");
    asiLines.push('product\'s own source tree and says nothing about this workspace.');
    asiLines.push('');
    if (!asi.frameworkInstalled) {
        asiLines.push('The framework is NOT INSTALLED in this workspace. No coverage has been');
        asiLines.push('assessed. This is not a coverage of zero, and must not be reported as one.');
    } else {
        asiLines.push(`Framework: ${clip(asi.framework?.name)} [${clip(asi.framework?.key)}]`);
        asiLines.push('');
        asiLines.push('Per agent — OPEN RISKS ARE NAMED, because a percentage cannot answer');
        asiLines.push('"which risk is open":');
        for (const a of asi.agents.slice(0, DOCUMENT_ROW_CAP)) {
            asiLines.push(`  ${clip(a.name)} [${a.agentId}]`);
            asiLines.push(`    Covered:            ${codes(a.covered)}`);
            asiLines.push(`    Partially covered:  ${codes(a.partiallyCovered)}`);
            asiLines.push(
                `    Claimed, unverified: ${codes(a.reviewNeeded)}` +
                    (a.reviewNeeded.length > 0 ? '  ← a claim nobody has checked' : ''),
            );
            asiLines.push(
                `    UNCOVERED:          ${codes(a.uncovered)}` +
                    (a.uncovered.length > 0 ? '  ← open findings' : ''),
            );
            asiLines.push(`    Not applicable:     ${codes(a.notApplicable)}`);
        }
        if (asi.agents.length > DOCUMENT_ROW_CAP) {
            asiLines.push(
                `  … and ${asi.agents.length - DOCUMENT_ROW_CAP} more, not enumerated here.`,
            );
        }
    }
    section('2 — ASI RISK COVERAGE', pack.asiCoverage, asiLines);

    // ── 3 — approval quality ────────────────────────────────────────────────
    const appr = pack.approvals.body as {
        unobservable: readonly string[];
        sampleAudit: {
            sampled: number;
            answered: number;
            pending: number;
            concurred: number;
            dissented: number;
            indeterminate: number;
        };
        signals: unknown[];
        thresholds: Record<string, number>;
    };
    const apprLines: string[] = [];
    apprLines.push('Second-opinion audit — the only retrospective quality signal here:');
    apprLines.push(
        `  sampled ${appr.sampleAudit.sampled} · answered ${appr.sampleAudit.answered} · ` +
            `pending ${appr.sampleAudit.pending}`,
    );
    apprLines.push(
        `  concurred ${appr.sampleAudit.concurred} · dissented ${appr.sampleAudit.dissented} · ` +
            `indeterminate ${appr.sampleAudit.indeterminate}`,
    );
    apprLines.push('');
    apprLines.push(`Patterns fired in the window: ${appr.signals.length}`);
    const thresholdIds = Object.keys(appr.thresholds).sort();
    if (thresholdIds.length > 0) {
        apprLines.push('Measured against these constants:');
        for (const k of thresholdIds) apprLines.push(`  ${k} = ${appr.thresholds[k]}`);
    }
    apprLines.push('');
    apprLines.push('WHAT THIS REPORT CANNOT ANSWER — stated rather than approximated, because');
    apprLines.push('a pack showing only what it can measure reads as though it were complete:');
    if (appr.unobservable.length === 0) {
        apprLines.push('  (nothing is recorded as unobservable for this report)');
    }
    for (const u of appr.unobservable) apprLines.push(`  · ${u}`);
    section('3 — APPROVAL QUALITY', pack.approvals, apprLines);

    // ── 4 — incidents ───────────────────────────────────────────────────────
    const inc = pack.incidents.body as {
        kills: {
            scope: string;
            agentName: string | null;
            reason: string;
            engagedByUserId: string;
            engagedAt: Date;
            durationMinutes: number;
            stillInForce: boolean;
        }[];
        drillCanaryKills: unknown[];
        drills: { startedAt: Date; outcome: string; toolCallsAfterKill: number }[];
        breakers: { agentName: string | null; state: string; trippedAt: Date | null }[];
    };
    const incLines: string[] = [];
    incLines.push(`Kill switch engaged ${inc.kills.length} time(s) in the window:`);
    if (inc.kills.length === 0) incLines.push('  (none)');
    for (const k of inc.kills.slice(0, DOCUMENT_ROW_CAP)) {
        incLines.push(
            `  ${iso(k.engagedAt)} · ${k.scope} scope · ${clip(k.agentName) === '(none)' ? 'whole workspace' : clip(k.agentName)}`,
        );
        incLines.push(`    Engaged by: ${k.engagedByUserId}`);
        incLines.push(`    Reason: ${clip(k.reason)}`);
        incLines.push(
            `    Duration: ${k.durationMinutes} min${k.stillInForce ? ' — STILL IN FORCE' : ''}`,
        );
    }
    incLines.push('');
    incLines.push(
        `Drill-canary kills, counted separately because an exercise is not an ` +
            `incident: ${inc.drillCanaryKills.length}`,
    );
    incLines.push('');
    incLines.push(`Kill-switch drills: ${inc.drills.length}`);
    for (const d of inc.drills.slice(0, DOCUMENT_ROW_CAP)) {
        incLines.push(
            `  ${iso(d.startedAt)} · ${d.outcome} · tool calls after kill: ${d.toolCallsAfterKill}`,
        );
    }
    incLines.push('');
    incLines.push(`Circuit breakers observed: ${inc.breakers.length}`);
    for (const b of inc.breakers.slice(0, DOCUMENT_ROW_CAP)) {
        incLines.push(`  ${clip(b.agentName)} · ${b.state} · tripped ${iso(b.trippedAt)}`);
    }
    section('4 — INCIDENTS', pack.incidents, incLines);

    // ── 5 — third-party assurance ───────────────────────────────────────────
    const tp = pack.thirdParty.body as {
        agents: {
            agentId: string;
            name: string;
            vendorName: string | null;
            vendorUnresolved: boolean;
            latestCompletedAssessment: { status: string; decidedAt: Date | null; riskRating: string | null } | null;
        }[];
        toolManifests: { toolName: string; status: string; blocked: boolean; revision: number | null }[];
    };
    const tpLines: string[] = [];
    if (tp.agents.length === 0) {
        tpLines.push('No agent here is supplied by a third party.');
    }
    for (const a of tp.agents.slice(0, DOCUMENT_ROW_CAP)) {
        tpLines.push(`  ${clip(a.name)} [${a.agentId}]`);
        if (a.vendorUnresolved) {
            // The worst row in the pack: somebody else's code, running here,
            // with no supplier record to hang assurance on.
            tpLines.push(
                `    SUPPLIER CANNOT BE RESOLVED — this agent names a vendor the register`,
            );
            tpLines.push(
                `    cannot find. It is third-party code with no supplier record attached.`,
            );
        } else {
            tpLines.push(`    Supplier: ${clip(a.vendorName)}`);
        }
        const asmt = a.latestCompletedAssessment;
        tpLines.push(
            asmt
                ? `    Assessment: ${asmt.status}, decided ${iso(asmt.decidedAt)}, rating ${asmt.riskRating ?? '(none)'}`
                : '    Assessment: NONE COMPLETED — this supplier has never been assessed.',
        );
    }
    if (tp.toolManifests.length > 0) {
        tpLines.push('');
        tpLines.push('Supplier-served tool manifests:');
        for (const m of tp.toolManifests.slice(0, DOCUMENT_ROW_CAP)) {
            tpLines.push(
                `  ${clip(m.toolName)} · ${m.status}` +
                    `${m.revision === null ? ' · unpinned' : ` · rev ${m.revision}`}` +
                    `${m.blocked ? ' · BLOCKED' : ''}`,
            );
        }
    }
    section('5 — THIRD-PARTY ASSURANCE', pack.thirdParty, tpLines);

    // ── definitions ─────────────────────────────────────────────────────────
    L.push(RULE);
    L.push('APPENDIX — WHAT EVERY FIGURE COUNTS');
    L.push(RULE);
    L.push('');
    L.push('Each figure cited above is defined here by the rows it counts, the instant');
    L.push('or window it is true of, and what it deliberately leaves out. The exclusions');
    L.push('are listed because they are the arguable part.');
    L.push('');
    const seen = new Set<string>();
    const allDefs: MetricDefinition[] = [];
    for (const env of [pack.inventory, pack.asiCoverage, pack.approvals, pack.incidents, pack.thirdParty]) {
        for (const d of env.definitions) {
            if (seen.has(d.id)) continue;
            seen.add(d.id);
            allDefs.push(d);
        }
    }
    L.push(...renderDefinitions(allDefs));

    L.push(RULE);
    L.push('END OF PACK');
    L.push(RULE);

    return L.join('\n');
}

/**
 * The filed record's title.
 *
 * It carries the generation instant because an export is a SNAPSHOT and two
 * exports are two different documents — see the usecase header for why this is
 * deliberately not idempotent.
 */
export function packExportTitle(generatedAt: Date): string {
    return `Agent governance pack — ${generatedAt.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}
