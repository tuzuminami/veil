import { buildServer } from "./transport/http-server.js";

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const storePath = process.env.VEIL_STORE_PATH ?? ".local-data/veil-store.json";

buildServer(storePath).listen(port, () => {
  process.stdout.write(`VEIL listening on http://127.0.0.1:${port}\n`);
});
