/**
 * The Bulgarian content dictionaries (#5996), one JSON file per catalogue:
 * `{ "<English source text>": "<Bulgarian text>" }`.
 *
 * Imported statically so the server bundle carries them (a runtime `fs` read
 * would depend on output file tracing). A JSON file in this folder that is
 * missing from the list fails `tests/unit/content-i18n/dictionary.test.ts`.
 * `generic-tasks` is the one dictionary built in code (see its header).
 */
import { genericTasks } from './generic-tasks';
import aiuc1 from './aiuc-1.json';
import cisV8 from './cis-v8.json';
import cosoIcf from './coso-icf.json';
import dora from './dora.json';
import euAiAct from './eu-ai-act.json';
import euUasOps from './eu-uas-ops.json';
import finosAigf from './finos-aigf.json';
import gdpr from './gdpr.json';
import generic from './generic.json';
import imdaMgf from './imda-mgf.json';
import internalControls from './internal-controls.json';
import iso27001 from './iso-27001.json';
import iso27701 from './iso-27701.json';
import iso42001 from './iso-42001.json';
import isoClauses from './iso-clauses.json';
import nis2 from './nis2.json';
import nistCsf from './nist-csf.json';
import nistPrivacy from './nist-privacy.json';
import nistSsdf from './nist-ssdf.json';
import owaspAgentic from './owasp-agentic.json';
import owaspAisvs from './owasp-aisvs.json';
import owaspAsvs from './owasp-asvs.json';
import policyTemplates from './policy-templates.json';
import shared from './shared.json';
import soc2 from './soc2.json';
import vendorQuestionnaires from './vendor-questionnaires.json';

export const BG_DICTIONARIES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    'generic-tasks': genericTasks,
    'aiuc-1': aiuc1,
    'cis-v8': cisV8,
    'coso-icf': cosoIcf,
    dora,
    'eu-ai-act': euAiAct,
    'eu-uas-ops': euUasOps,
    'finos-aigf': finosAigf,
    gdpr,
    generic,
    'imda-mgf': imdaMgf,
    'internal-controls': internalControls,
    'iso-27001': iso27001,
    'iso-27701': iso27701,
    'iso-42001': iso42001,
    'iso-clauses': isoClauses,
    nis2,
    'nist-csf': nistCsf,
    'nist-privacy': nistPrivacy,
    'nist-ssdf': nistSsdf,
    'owasp-agentic': owaspAgentic,
    'owasp-aisvs': owaspAisvs,
    'owasp-asvs': owaspAsvs,
    'policy-templates': policyTemplates,
    shared,
    soc2,
    'vendor-questionnaires': vendorQuestionnaires,
};
