/**
 * `Plenum --mcp` (F9), run by the app's own executable as plain Node (ELECTRON_RUN_AS_NODE):
 * Electron's main process can't read stdin on Windows, and an MCP client talks over stdio. No
 * window and no Electron APIs here, just the engine on the same data as the app.
 */
import { Engine, serveMcp, silenceSqliteWarning } from '@plenum/core';
import { demoAdapters } from './demo.js';

silenceSqliteWarning();
const engine = new Engine(process.env.PLENUM_DEMO === '1' ? { adapters: demoAdapters() } : {});
await serveMcp(engine, process.env.PLENUM_VERSION ?? '0.0.0');
engine.close();
process.exit(0);
