/**
 * The observability stack joins a network the production app actually has
 * (#5308).
 *
 * `infra/observability/docker-compose.observability.yml` joins the app's
 * network as `external`, so Compose refuses to start the stack when that
 * network does not exist. Its default, and its `.env.example`, named
 * `inflect_internal` — the network the LOCAL root `docker-compose.prod.yml`
 * declares. Production runs `deploy/docker-compose.prod.yml`, which declares
 * no networks, so its services sit on the Compose project's default network:
 * `<project>_default`, the project being the directory apply.sh deploys to.
 * Following the README on the VM therefore failed with "network
 * inflect_internal declared as external, but could not be found".
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The network deploy/docker-compose.prod.yml's services are on, on the VM. */
function productionAppNetwork(): string {
    const deployed = yaml.load(read('deploy/docker-compose.prod.yml')) as {
        name?: string;
        networks?: Record<string, unknown>;
    };
    // If the deployed file ever declares its own networks, this derivation no
    // longer holds and must be rewritten rather than trusted.
    expect(deployed.networks).toBeUndefined();
    const remoteDir = /^REMOTE_DIR="\$\{REMOTE_DIR:-([^}]+)\}"$/m.exec(read('deploy/apply.sh'));
    if (!remoteDir) throw new Error('REMOTE_DIR default not found in deploy/apply.sh');
    const project = deployed.name ?? path.posix.basename(remoteDir[1]);
    return `${project}_default`;
}

describe('observability stack → production app network', () => {
    const expected = productionAppNetwork();

    it('defaults APP_NETWORK_NAME to the production app network', () => {
        const obs = yaml.load(read('infra/observability/docker-compose.observability.yml')) as {
            networks: Record<string, { external?: boolean; name?: string }>;
        };
        const app = obs.networks.app;
        expect(app.external).toBe(true);
        const m = /^\$\{APP_NETWORK_NAME:-([^}]+)\}$/.exec(app.name ?? '');
        expect(m?.[1]).toBe(expected);
    });

    it('ships .env.example with the same network name', () => {
        const line = read('infra/observability/.env.example')
            .split('\n')
            .find((l) => l.startsWith('APP_NETWORK_NAME='));
        expect(line).toBe(`APP_NETWORK_NAME=${expected}`);
    });
});
