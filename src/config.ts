export interface AppConfig {
  port: number;
  /** Directory containing trade pack YAML files (e.g. plumbing.yaml). */
  tradePacksDir: string;
  /** Serve the dev-only /demo-site fixture route. */
  exposeDemoSite: boolean;
  llm: {
    baseURL: string | undefined;
    apiKey: string | undefined;
    model: string;
    /** DEMO_STUB_LLM=1 — deterministic canned outputs, no API key needed. */
    stubMode: boolean;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const stubMode = env.DEMO_STUB_LLM === "1";
  return {
    port: Number(env.PORT ?? 3200),
    tradePacksDir: env.TRADE_PACKS_DIR ?? "trade-packs",
    exposeDemoSite: stubMode || env.ENABLE_DEMO_SITE === "1",
    llm: {
      // Kimi API (Moonshot AI) — OpenAI-compatible. Override base URL/model
      // for any other compatible provider.
      baseURL: env.OPENAI_BASE_URL ?? "https://api.moonshot.ai/v1",
      apiKey: env.KIMI_API_KEY ?? env.OPENAI_API_KEY,
      model: env.MODEL ?? "kimi-k2.6",
      stubMode,
    },
  };
}
