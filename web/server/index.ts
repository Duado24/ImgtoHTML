import { createApp, HOST, PORT } from "./app";

const app = await createApp({ logger: true });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => { void app.close().catch((error: unknown) => { console.error(error); process.exitCode = 1; }); });
}
try {
  await app.listen({ host: HOST, port: PORT });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
