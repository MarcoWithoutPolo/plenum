// Start the recipe book: node server.js (PORT, DATA_FILE).
import { createApp } from './src/app.js';

const port = Number(process.env.PORT) || 3000;
const dataFile = process.env.DATA_FILE || './recipes.db';

const server = createApp(dataFile);
server.listen(port, () =>
  console.log(`Recipe book on http://localhost:${port} (data: ${dataFile})`),
);

for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
