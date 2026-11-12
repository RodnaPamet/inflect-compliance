/**
 * Validate an Inspect evaluation record against the committed task set and
 * print the verdicts the record module RECOMPUTES from its facts.
 *
 *   npx tsx scripts/inspect-record-check.ts <record.json> [--md <summary.md>]
 *
 * Exit 1 on a refusal (a malformed record is never a night's evidence); exit 0
 * otherwise, whatever the verdicts. Whether a failing verdict fails the job is
 * the workflow's decision, under its dated AGENT-EVAL-NON-BLOCKING-UNTIL marker.
 */
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';

import { checkInspectRecord } from '@/lib/ai/evals/inspect-record';

const [recordPath, ...rest] = process.argv.slice(2);
if (!recordPath) {
    process.stderr.write('usage: inspect-record-check <record.json> [--md <file>]\n');
    process.exit(2);
}
const mdIndex = rest.indexOf('--md');
const set = JSON.parse(readFileSync(path.join(process.cwd(), 'evals/inspect/task-set.json'), 'utf8'));
const check = checkInspectRecord(JSON.parse(readFileSync(recordPath, 'utf8')), set);
if (!check.ok) {
    process.stderr.write(`record refused: ${JSON.stringify(check.refusal)}\n`);
    process.exit(1);
}
const v = check.verdicts;
const lines = [
    `### Inspect — ${v.engine}: ${v.passed ? 'every task PASS' : 'NOT passed'}`,
    '',
    '| Task | Criterion | Verdict |',
    '| --- | --- | --- |',
    ...v.tasks.map((t) => `| \`${t.taskId}\` | \`${t.criterion}\` | ${t.verdict} |`),
    '',
    `Criteria evidenced: ${v.criteriaEvidenced.map((c) => `\`${c}\``).join(', ') || 'none'}`,
];
if (mdIndex !== -1 && rest[mdIndex + 1]) writeFileSync(rest[mdIndex + 1], `${lines.join('\n')}\n`);
process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
