/**
 * CashiBot — backend dla Conversational AI (ElevenLabs, WebRTC).
 *
 * Rola serwera jest CELOWO minimalna i bezpieczna:
 *   1. Generuje krótkożyciowy token sesji WebRTC (`/api/webrtc-token`).
 *      Dzięki temu klucz API ElevenLabs NIGDY nie trafia do przeglądarki.
 *   2. Serwuje statyczny frontend z katalogu `public/`.
 *   3. Serwuje oficjalny pakiet przeglądarkowy SDK z `node_modules` pod `/vendor`
 *      (brak zależności od zewnętrznego CDN, brak kroku budowania).
 *   4. Opcjonalnie chroni mintowanie tokenów kodem dostępu (`ACCESS_CODE`).
 *
 * Nasłuchuje na `process.env.PORT` — wymóg Railway/Nixpacks (`npm start`).
 */

import "dotenv/config";
import path from "node:path";
import crypto from "node:crypto";
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
const API_KEY = (process.env.ELEVENLABS_API_KEY || "").trim();
const AGENT_ID = (process.env.ELEVENLABS_AGENT_ID || "").trim();
// Opcjonalnie: ogranicz CORS do konkretnego origin (np. https://twoja-domena.up.railway.app).
// Domyślnie odbicie origin żądania (wygodne, bo frontend i tak jest serwowany z tego serwera).
const ALLOWED_ORIGIN = (process.env.ALLOWED_ORIGIN || "").trim();
// Opcjonalnie: kod dostępu wymagany do rozpoczęcia rozmowy. Bez niego każdy, kto zna
// adres aplikacji, może uruchamiać sesje na koszt konta ElevenLabs.
const ACCESS_CODE = (process.env.ACCESS_CODE || "").trim();

// Endpoint ElevenLabs mintujący token WebRTC (ten sam, którego używa oficjalny SDK).
const TOKEN_URL = "https://api.elevenlabs.io/v1/convai/conversation/token";
// Twardy limit czasu na odpowiedź ElevenLabs — użytkownik nie czeka w nieskończoność.
const TOKEN_TIMEOUT_MS = 10_000;

if (!API_KEY) {
  console.error("FATAL: brak zmiennej ELEVENLABS_API_KEY.");
  process.exit(1);
}
if (!AGENT_ID) {
  console.error("FATAL: brak zmiennej ELEVENLABS_AGENT_ID.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Kod dostępu (opcjonalny)
// ---------------------------------------------------------------------------

// Globalny limit nieudanych prób (ochrona przed zgadywaniem kodu).
const MAX_FAILED_ATTEMPTS = 20;
const FAILED_WINDOW_MS = 15 * 60_000;
let failedAttempts = 0;
let failedWindowStart = Date.now();

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Zwraca kod HTTP błędu (401/429) albo null, gdy dostęp jest dozwolony. */
function checkAccess(req) {
  if (!ACCESS_CODE) return null;
  if (Date.now() - failedWindowStart > FAILED_WINDOW_MS) {
    failedAttempts = 0;
    failedWindowStart = Date.now();
  }
  if (failedAttempts >= MAX_FAILED_ATTEMPTS) return 429;
  const given = String(req.get("x-access-code") || "").trim();
  if (given && safeEqual(given, ACCESS_CODE)) return null;
  if (given) failedAttempts++;
  return 401;
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
  res.json({ ok: true, agentConfigured: Boolean(AGENT_ID), accessCodeRequired: Boolean(ACCESS_CODE) });
});

/**
 * Mintuje krótkożyciowy token sesji WebRTC dla skonfigurowanego agenta.
 * Frontend przekazuje ten token do `Conversation.startSession({ connectionType: "webrtc", conversationToken })`.
 */
app.get("/api/webrtc-token", async (req, res) => {
  res.set("Cache-Control", "no-store");

  const denied = checkAccess(req);
  if (denied === 429) {
    return res.status(429).json({ error: "Zbyt wiele błędnych kodów. Spróbuj ponownie za kilka minut." });
  }
  if (denied === 401) {
    return res.status(401).json({ error: "Wymagany poprawny kod dostępu.", accessCodeRequired: true });
  }

  try {
    const url = `${TOKEN_URL}?agent_id=${encodeURIComponent(AGENT_ID)}`;
    const response = await fetch(url, {
      headers: { "xi-api-key": API_KEY },
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
    console.error("Nie udało się wygenerować tokenu WebRTC:", detail);
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
  console.log(`Agent ID: ${AGENT_ID.slice(0, 10)}…`);
  console.log(`Kod dostępu: ${ACCESS_CODE ? "włączony" : "WYŁĄCZONY (każdy z linkiem może rozmawiać)"}`);
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
