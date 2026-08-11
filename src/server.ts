import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Fastify from "fastify";
import { z } from "zod";
import { loadConfig, type AppConfig } from "./config.js";
import { loadTradePack, type TradePack } from "./packs/tradePack.js";
import { mergePacks } from "./packs/merge.js";
import { RedlineFilter } from "./guardrails/redlines.js";
import { buildPackRules } from "./guardrails/packRules.js";
import { LlmClient } from "./llm/client.js";
import { PlaygroundEngine } from "./conversation/engine.js";
import { SessionStore } from "./playground/session.js";
import { scrapeSite } from "./intake/scrape.js";
import { extractOverlay } from "./intake/extract.js";
import { landingPage, chatPage } from "./web/pages.js";

const CreateBodySchema = z.object({
  url: z.string().min(3).max(500),
  trade: z.string().default("plumbing"),
  paragraphs: z.string().max(4000).default(""),
});

const MessageBodySchema = z.object({
  text: z.string().min(1).max(1000),
});

const DEMO_SITE_PATH = fileURLToPath(
  new URL("../test/fixtures/fake-plumber-site.html", import.meta.url)
);

export function buildServer(env: NodeJS.ProcessEnv = process.env) {
  const config: AppConfig = loadConfig(env);
  const tradePacks = new Map<string, TradePack>();
  tradePacks.set(
    "plumbing",
    loadTradePack(path.join(config.tradePacksDir, "plumbing.yaml"))
  );

  const llm = new LlmClient(config.llm);
  const engine = new PlaygroundEngine({ llm });
  const sessions = new SessionStore();

  const app = Fastify({ logger: false });

  // Minimal urlencoded form parser — avoids an extra dependency.
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_req, body, done) => {
      const params = new URLSearchParams(body as string);
      const obj: Record<string, string> = {};
      for (const [k, v] of params) obj[k] = v;
      done(null, obj);
    }
  );

  app.get("/health", async () => ({
    ok: true,
    llm: llm.isLive ? ("live" as const) : ("stub" as const),
  }));

  app.get("/", async (_req, reply) => {
    reply.type("text/html").send(landingPage());
  });

  // Dev-only fixture site so the scripted demo can run fully locally.
  if (config.exposeDemoSite) {
    app.get("/demo-site", async (_req, reply) => {
      reply.type("text/html").send(readFileSync(DEMO_SITE_PATH, "utf8"));
    });
  }

  app.post("/playground/create", async (req, reply) => {
    const parsed = CreateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .type("text/html")
        .send(landingPage("That didn't look like a website address — try again."));
    }
    const { url, trade, paragraphs } = parsed.data;
    const tradePack = tradePacks.get(trade) ?? tradePacks.get("plumbing")!;

    // Fetch the site; if it fails, proceed with the paragraphs alone.
    const site = await scrapeSite(url);
    const overlay = await extractOverlay(llm, tradePack, {
      siteText: site.text,
      ownerText: paragraphs,
      url,
    });
    const pack = mergePacks(tradePack, overlay);
    const filter = new RedlineFilter(buildPackRules(pack));

    const session = sessions.create({
      sourceUrl: url,
      pack,
      overlay,
      filter,
      state: "greeted",
    });
    return reply.redirect(`/playground/${session.id}`, 303);
  });

  app.get("/playground/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = sessions.get(id);
    if (!session) {
      return reply
        .status(404)
        .type("text/html")
        .send(landingPage("That preview session expired — start a new one."));
    }
    return reply
      .type("text/html")
      .send(chatPage(session, engine.greeting(session.pack)));
  });

  app.post("/playground/:id/message", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = sessions.get(id);
    if (!session) {
      return reply.status(404).send({ error: "session not found" });
    }
    const parsed = MessageBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "expected {text}" });
    }
    const { reply: text, xray } = await engine.handleMessage(
      session,
      parsed.data.text
    );
    return { reply: text, xray };
  });

  return { app, config, sessions, llm };
}
