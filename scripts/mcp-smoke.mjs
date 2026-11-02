// Starts a Conclave MCP server over stdio and lists its tools, as Claude Code would.
//   node scripts/mcp-smoke.mjs <command> [args...]
// e.g. node scripts/mcp-smoke.mjs npm run -s conclave -- mcp
//      node scripts/mcp-smoke.mjs apps/desktop/release/win-unpacked/Conclave.exe --mcp
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('Usage: node scripts/mcp-smoke.mjs <command> [args...]');
  process.exit(2);
}
const transport = new StdioClientTransport({
  command,
  args,
  env: { ...process.env },
  stderr: 'inherit',
});
const client = new Client({ name: 'conclave-smoke', version: '1' });
const timer = setTimeout(() => {
  console.error('No answer within 60 s');
  process.exit(1);
}, 60_000);
await client.connect(transport);
const { tools } = await client.listTools();
console.log(
  `Connected to ${client.getServerVersion()?.name} ${client.getServerVersion()?.version}`,
);
console.log(`Tools: ${tools.map((t) => t.name).join(', ')}`);
const projects = await client.callTool({ name: 'list_projects', arguments: {} });
console.log(`list_projects: ${projects.content[0].text.slice(0, 80)}`);
clearTimeout(timer);
await client.close();
