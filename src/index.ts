import { buildServer } from "./server.js";

const { app, config } = buildServer();

app
  .listen({ port: config.port, host: "0.0.0.0" })
  .then(() => {
    console.log(`Prodworth P2 playground on http://localhost:${config.port}`);
    console.log(
      `LLM mode: ${config.llm.stubMode ? "DEMO_STUB_LLM (deterministic)" : config.llm.apiKey ? "live" : "stub (no API key)"}`
    );
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
