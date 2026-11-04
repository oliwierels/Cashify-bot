/**
 * CashiBot — backend dla Conversational AI (ElevenLabs, WebRTC).
 *
 * Rola serwera jest CELOWO minimalna i bezpieczna:
 *   1. Generuje krótkożyciowy token sesji WebRTC (`/api/webrtc-token?agent=…`) dla
 *      wybranego agenta. Klucze API ElevenLabs NIGDY nie trafiają do przeglądarki.
 *   2. Serwuje statyczny frontend z katalogu `public/`.
 *   3. Serwuje oficjalny pakiet przeglądarkowy SDK z `node_modules` pod `/vendor`
 *      (brak zależności od zewnętrznego CDN, brak kroku budowania).
 *
 * Nasłuchuje na `process.env.PORT` — wymóg Railway/Nixpacks (`npm start`).
 */

import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import cors from "cors";

// Zapobiegaj crashowi procesu z powodu niezłapanych błędów asynchronicznych.
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception — serwer kontynuuje działanie:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled promise rejection — serwer kontynuuje działanie:", reason);
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Konfiguracja ze zmiennych środowiskowych
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;
// Domyślny klucz API — używany przez agentów bez własnego AGENT_<NAZWA>_API_KEY.
const DEFAULT_API_KEY = (process.env.ELEVENLABS_API_KEY || "").trim();
// Opcjonalnie: ogranicz CORS do konkretnego origin (np. https://twoja-domena.up.railway.app).
// Domyślnie odbicie origin żądania (wygodne, bo frontend i tak jest serwowany z tego serwera).
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || "").trim();

// Endpoint ElevenLabs mintujący token WebRTC (ten sam, którego używa oficjalny SDK).
const TOKEN_URL = "https://api.elevenlabs.io/v1/convai/conversation/token";
// Twardy limit czasu na odpowiedź ElevenLabs — użytkownik nie czeka w nieskończoność.
const TOKEN_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Agenci (wybierani w aplikacji)
// ---------------------------------------------------------------------------

// Nazwy i kolejność znanych agentów na przyciskach. ID agentów i klucze API są
// wyłącznie w zmiennych środowiskowych (Railway → Variables), nigdy w kodzie.
const KNOWN_AGENT_NAMES = { LEXAI: "LexAI", BENIO: "Benio", JERZY: "Jerzy" };

/**
 * Agenci do wyboru w aplikacji — ze zmiennych środowiskowych:
 *   AGENT_<NAZWA>_ID       — ID agenta ElevenLabs (dodaje agenta), np. AGENT_BENIO_ID,
 *   AGENT_<NAZWA>_API_KEY  — klucz API tylko dla tego agenta (domyślnie ELEVENLABS_API_KEY),
 *   AGENT_<NAZWA>_NAME     — nazwa przycisku (domyślnie LexAI / Benio / Jerzy albo z nazwy zmiennej).
 * Stare ELEVENLABS_AGENT_ID: bez żadnego AGENT_<NAZWA>_ID działa jak dotąd (jeden agent);
 * w przeciwnym razie wskazuje agenta zaznaczonego domyślnie na nowych telefonach.
 */
function loadAgents(env) {
  const read = (name) => (env[name] || "").trim();
  const agents = [];
  for (const key of Object.keys(env)) {
    const match = /^AGENT_([A-Z0-9]+)_ID$/.exec(key);
    if (!match || !read(key)) continue;
    const upper = match[1];
    agents.push({
      slug: upper.toLowerCase(),
      name: read(`AGENT_${upper}_NAME`) || KNOWN_AGENT_NAMES[upper] || upper.charAt(0) + upper.slice(1).toLowerCase(),
      agentId: read(key),
      apiKey: read(`AGENT_${upper}_API_KEY`) || DEFAULT_API_KEY,
    });
  }

  const knownOrder = Object.keys(KNOWN_AGENT_NAMES).map((k) => k.toLowerCase());
  const rank = (a) => (knownOrder.includes(a.slug) ? knownOrder.indexOf(a.slug) : knownOrder.length);
  agents.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "pl"));

  const legacyAgentId = read("ELEVENLABS_AGENT_ID");
  let defaultSlug = agents.find((a) => a.agentId === legacyAgentId)?.slug || "";
  if (legacyAgentId && !defaultSlug) {
    agents.push({
      slug: "default",
      name: read("ELEVENLABS_AGENT_NAME") || "CashiBot",
      agentId: legacyAgentId,
      apiKey: DEFAULT_API_KEY,
    });
    defaultSlug = "default";
  }

  const usable = agents.filter((a) => {
    if (a.apiKey) return true;
    console.error(`Agent „${a.name}” pominięty: brak AGENT_${a.slug.toUpperCase()}_API_KEY i ELEVENLABS_API_KEY.`);
    return false;
  });
  if (!usable.some((a) => a.slug === defaultSlug)) defaultSlug = usable[0]?.slug || "";
  return { agents: usable, defaultSlug };
}

const { agents: AGENTS, defaultSlug: DEFAULT_AGENT } = loadAgents(process.env);

if (!AGENTS.length) {
  console.error(
    "FATAL: brak agentów. Ustaw AGENT_<NAZWA>_ID (np. AGENT_BENIO_ID) albo ELEVENLABS_AGENT_ID " +
      "oraz klucz: ELEVENLABS_API_KEY lub AGENT_<NAZWA>_API_KEY."
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Aplikacja Express
// ---------------------------------------------------------------------------

const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: ALLOWED_ORIGIN || true }));

// Oficjalny, samowystarczalny bundle przeglądarkowy SDK (IIFE -> window.ElevenLabsClient).
// Serwujemy prosto z node_modules: zawsze zgodny z zainstalowaną wersją, bez CDN i bez bundlera.
app.use(
  "/vendor",
  express.static(
    path.join(__dirname, "node_modules", "@elevenlabs", "client", "dist"),
    { maxAge: "1h" }
  )
);

// Statyczny frontend. HTML, service worker i manifest zawsze rewalidowane,
// żeby zainstalowana aplikacja (PWA) od razu dostawała nową wersję po wdrożeniu.
const NO_CACHE_FILES = new Set(["index.html", "sw.js", "manifest.webmanifest"]);
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res, filePath) => {
      if (NO_CACHE_FILES.has(path.basename(filePath))) {
        res.set("Cache-Control", "no-cache");
      }
    },
  })
);

// Health-check (przydatny dla monitoringu Railway).
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, agents: AGENTS.map((a) => a.slug) });
});

// Lista agentów do wyboru w aplikacji (bez kluczy API).
app.get("/api/agents", (_req, res) => {
  res.json({ agents: AGENTS.map(({ slug, name }) => ({ slug, name })), defaultAgent: DEFAULT_AGENT });
});

/**
 * Mintuje krótkożyciowy token sesji WebRTC dla skonfigurowanego agenta.
 * Frontend przekazuje ten token do `Conversation.startSession({ connectionType: "webrtc", conversationToken })`.
 */
app.get("/api/webrtc-token", async (req, res) => {
  res.set("Cache-Control", "no-store");

  // Bez parametru ?agent= działa tylko, gdy skonfigurowano jednego agenta.
  const slug = typeof req.query.agent === "string" ? req.query.agent : "";
  const agent = slug ? AGENTS.find((a) => a.slug === slug) : AGENTS.length === 1 ? AGENTS[0] : null;
  if (!agent) {
    return res.status(400).json({ error: slug ? "Nieznany agent." : "Wybierz agenta." });
  }

  try {
    const url = `${TOKEN_URL}?agent_id=${encodeURIComponent(agent.agentId)}`;
    const response = await fetch(url, {
      headers: { "xi-api-key": agent.apiKey },
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`ElevenLabs HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
    const data = await response.json();
    const token = data?.token;
    if (!token) {
      throw new Error("Odpowiedź ElevenLabs nie zawiera pola 'token'.");
    }
    res.json({ token });
  } catch (err) {
    const detail = err?.name === "TimeoutError" ? `timeout po ${TOKEN_TIMEOUT_MS} ms` : err?.message || String(err);
    console.error(`Nie udało się wygenerować tokenu WebRTC (agent: ${agent.slug}):`, detail);
    res.status(502).json({ error: "Nie udało się pobrać tokenu sesji WebRTC." });
  }
});

// Nieznane ścieżki API -> JSON 404 (zamiast strony HTML).
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "Nie znaleziono." });
});

// Fallback: każde inne żądanie GET (np. odświeżenie SPA-podobnej ścieżki) -> index.html.
// Brakujące pliki (ścieżka z rozszerzeniem, np. /favicon.ico) dostają zwykłe 404.
app.get(/^(?!\/api\/|\/vendor\/).*/, (req, res) => {
  if (path.extname(req.path)) return res.sendStatus(404);
  res.sendFile(path.join(__dirname, "public", "index.html"), {
    headers: { "Cache-Control": "no-cache" },
  });
});

const server = app.listen(PORT, () => {
  console.log(`CashiBot (WebRTC) nasłuchuje na porcie ${PORT}`);
  for (const a of AGENTS) {
    const keySource = a.apiKey === DEFAULT_API_KEY ? "ELEVENLABS_API_KEY" : `AGENT_${a.slug.toUpperCase()}_API_KEY`;
    const mark = a.slug === DEFAULT_AGENT ? " (domyślny)" : "";
    console.log(`Agent: ${a.name}${mark} (${a.slug}) → ${a.agentId.slice(0, 12)}… [klucz: ${keySource}]`);
  }
  console.log(`Start: ${new Date().toISOString()}`);
});

// Graceful shutdown przy sygnałach Railway/Docker (SIGTERM) i Ctrl+C (SIGINT).
function shutdown(signal) {
  console.log(`[${signal}] Zamykam serwer…`);
  server.close(() => {
    console.log("Serwer zamknięty.");
    process.exit(0);
  });
  // Wymuszony exit po 10 s, jeśli połączenia nie zakończą się same.
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
