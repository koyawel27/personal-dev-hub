import { config } from "./config.js";
import { getDb } from "./db/client.js";
import { createApp } from "./app.js";

getDb();
const app = createApp();

const server = app.listen(config.port, config.host, () => {
  console.log(
    `Local Developer Dashboard listening on http://${config.host}:${config.port}`,
  );
});

function shutdown(): void {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
