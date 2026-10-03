import { config } from "./config.js";
import { getDb } from "./db/client.js";
import { createApp } from "./app.js";
import { processPendingRestore } from "./services/RestoreService.js";
import {
  registerGracefulShutdown,
  requestGracefulShutdown,
} from "./services/RuntimeShutdown.js";

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

registerGracefulShutdown(shutdown);
process.on("SIGINT", () => requestGracefulShutdown());
process.on("SIGTERM", () => requestGracefulShutdown());
