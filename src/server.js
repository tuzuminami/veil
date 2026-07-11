import { buildServer } from "./transport/http-server.js";

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const host = process.env.HOST ?? "127.0.0.1";
const runtime = process.env.NODE_ENV === "production"
  ? await import("./runtime/production.js").then(({ createProductionServer }) => createProductionServer())
  : { server: buildServer(process.env.VEIL_STORE_PATH), close: async () => undefined };

runtime.server.listen(port, host, () => {
  process.stdout.write(`VEIL listening on http://${host}:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    runtime.server.close(async () => {
      await runtime.close();
      process.exit(0);
    });
  });
}
