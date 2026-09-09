import { resolve } from 'node:path';
import { startServer, type Tokens } from './index';

const supplied = { view: process.env.SCADA_VIEW_TOKEN, operator: process.env.SCADA_OPERATOR_TOKEN, research: process.env.SCADA_RESEARCH_TOKEN };
if (Object.values(supplied).some(Boolean) && !Object.values(supplied).every(Boolean)) throw new Error('Set all three SCADA_VIEW_TOKEN, SCADA_OPERATOR_TOKEN and SCADA_RESEARCH_TOKEN, or leave all unset for generated local tokens');
const app = await startServer({
  host: process.env.SCADA_HOST ?? '127.0.0.1', port: Number(process.env.SCADA_PORT ?? 4175),
  dataPath: process.env.SCADA_DATA_PATH ?? resolve('data/runs.sqlite'), staticDir: process.env.SCADA_STATIC_DIR ?? resolve('dist'),
  tokens: Object.values(supplied).every(Boolean) ? supplied as Tokens : undefined,
  project: process.env.SCADA_PROJECT_REPO ? {
    repository: process.env.SCADA_PROJECT_REPO,
    ref: process.env.SCADA_PROJECT_REF ?? 'HEAD',
    manifest: process.env.SCADA_PROJECT_MANIFEST ?? 'scada.project.json',
    pollMs: Number(process.env.SCADA_PROJECT_POLL_MS ?? 1000),
    writable: process.env.SCADA_PROJECT_WRITABLE === '1',
    remote: process.env.SCADA_PROJECT_REMOTE, branch: process.env.SCADA_PROJECT_BRANCH,
  } : undefined,
  allowedOrigins: (process.env.SCADA_ALLOWED_ORIGINS ?? '').split(',').map(origin => origin.trim()).filter(Boolean),
});
console.log(`SCADA local demo: ${app.url}/scada/`);
console.log(`VIEW token: ${app.tokens.view}\nOPERATOR token: ${app.tokens.operator}\nRESEARCH token: ${app.tokens.research}`);
if (app.project) console.log('Git project:', app.project.list());
console.log('Synthetic equipment only. Access tokens belong in the connection panel, never in the TS document or share link.');
const stop = () => { void app.close().then(() => process.exit(0)); };
process.once('SIGINT', stop); process.once('SIGTERM', stop);
