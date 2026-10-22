/**
 * Runs the browser checks against the app as it is actually running.
 *
 *     npm run test          # all of them
 *     npm run test -- map   # only the suites whose name matches
 *
 * Both servers have to be up, because nothing here is stubbed:
 *
 *     cd backend && ./run.sh
 *     cd frontend && npm run dev
 *
 * Started on another port? `MAPHEX_PORT=9000` for both, as usual; these go
 * through Vite's proxy, so they only need `MAPHEX_APP` if the dev server
 * itself has moved.
 *
 * They run one at a time. Each drives a whole browser against a real
 * backend, and a parallel run would have two of them writing the same
 * project's model file.
 */

import { APP, findProject } from './harness.mjs';
import * as modelScreen from './model-screen.mjs';
import * as examplesScreen from './examples-screen.mjs';
import * as layerOpacity from './layer-opacity.mjs';
import * as mapScreen from './map-screen.mjs';

const SUITES = [modelScreen, examplesScreen, layerOpacity, mapScreen];

const only = process.argv.slice(2).filter((argument) => !argument.startsWith('-'));
const wanted = SUITES.filter(
  (s) => only.length === 0 || only.some((m) => s.name.toLowerCase().includes(m.toLowerCase())),
);

async function reachable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return response.ok;
  } catch {
    return false;
  }
}

if (!(await reachable(APP))) {
  console.error(`The app is not answering at ${APP}.\n\n  cd frontend && npm run dev\n`);
  process.exit(2);
}
if (!(await reachable(`${APP}/api/pipeline`))) {
  console.error(
    `The app is up but ${APP}/api is not answering — the backend is down, or on` +
      ` another port.\n\n  cd backend && ./run.sh\n`,
  );
  process.exit(2);
}

// Found rather than named: the project ids are per machine. Everything here
// needs one with processed variables to look at.
const workspace = await findProject();
if (!workspace) {
  console.error(
    'No project here has any processed variables, so there is nothing to check.\n' +
      'Add a variable on the Data screen and process it, then run this again.\n',
  );
  process.exit(2);
}
console.log(`Project: ${workspace.project.name} (${workspace.inputs.length} rendered)\n`);

const all = [];
for (const s of wanted) {
  console.log(s.name);
  try {
    all.push(await s.run(workspace));
  } catch (error) {
    console.log(`  FAIL  the suite did not finish — ${error.message}`);
    all.push({ name: s.name, pass: 0, fail: 1, skipped: null });
  }
  console.log('');
}

const pass = all.reduce((total, r) => total + r.pass, 0);
const fail = all.reduce((total, r) => total + r.fail, 0);
for (const result of all) {
  const state = result.skipped
    ? `skipped — ${result.skipped}`
    : `${result.pass}/${result.pass + result.fail}`;
  console.log(`${result.fail ? '✗' : '✓'} ${result.name}: ${state}`);
}
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
