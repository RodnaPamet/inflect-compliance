/**
 * The stack's alert rules, read from the Grafana provisioning file (#5238).
 *
 * The rules used to be Prometheus alerting rules; they are now Grafana-managed,
 * because Grafana routes only the rules it evaluates. Each rule's PromQL is the
 * `expr` of its query `A` against the Prometheus datasource. This reads the
 * file back into the shape the Prometheus rule file had (group, alert, expr,
 * labels, annotations), so a test asks the same question of either.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as yaml from 'js-yaml';

export const GRAFANA_ALERT_RULES_PATH = 'infra/observability/grafana/provisioning/alerting/alert-rules.yml';

export interface AlertRule {
    readonly group: string;
    readonly alert: string;
    readonly expr: string;
    readonly for?: string;
    readonly labels: Record<string, string>;
    readonly annotations: Record<string, string>;
}

interface ProvisionedQuery {
    refId: string;
    datasourceUid: string;
    model?: { expr?: string };
}
interface ProvisionedRule {
    title: string;
    condition: string;
    data: ProvisionedQuery[];
    for?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
}
interface ProvisionedFile {
    groups: Array<{ name: string; rules: ProvisionedRule[] }>;
}

export function readGrafanaAlertRules(repoRoot: string): AlertRule[] {
    const doc = yaml.load(fs.readFileSync(path.join(repoRoot, GRAFANA_ALERT_RULES_PATH), 'utf8')) as ProvisionedFile;
    return doc.groups.flatMap((g) =>
        g.rules.map((r) => {
            const query = r.data.find((q) => q.refId === 'A' && q.datasourceUid === 'prometheus');
            if (!query?.model?.expr) throw new Error(`${g.name}/${r.title}: no Prometheus query A`);
            return {
                group: g.name,
                alert: r.title,
                expr: query.model.expr,
                for: r.for,
                labels: r.labels ?? {},
                annotations: r.annotations ?? {},
            };
        }),
    );
}
