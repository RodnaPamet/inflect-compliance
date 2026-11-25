/**
 * The process entry of the DSAR erasure command (#5940). Everything it does is
 * `scripts/dsar-erase.ts`; this file only runs it, so the command module can
 * be imported by a test, and bundled by esbuild into `dist/dsar-erase.mjs`
 * (ESM, where `require.main === module` does not exist) for the production
 * image, whose `VM apply` actions run `node dist/dsar-erase.mjs --due`.
 */
import { main } from './dsar-erase';

void main(process.argv.slice(2)).then((code) => process.exit(code));
