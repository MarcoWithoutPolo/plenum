// Runs a crash-test project in its own process; PLENUM_CRASH_AT ends it at the named point.
import { runProject, type CrashProject } from './kit.js';

const [json, mode] = process.argv.slice(2);
const project = JSON.parse(json!) as CrashProject;
await runProject(project, mode === 'conflict');
// Reaching the end means the crash point never came: the test reports that.
process.exit(0);
