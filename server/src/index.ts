import { config } from "./config.js";
import { getDb } from "./db/client.js";
import { createApp } from "./app.js";
import { processPendingRestore } from "./services/RestoreService.js";

// Restart-mediated restore MUST complete before the singleton DB opens.
processPendingRestore();
getDb();
const app = createApp();

const server = app.listen(config.port, config.host, () => {
  console.log(
    `Personal Dev Hub listening on http://${config.host}:${config.port}`,
  );
});

function shutdown(): void {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
