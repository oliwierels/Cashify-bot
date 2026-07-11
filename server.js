/**
 * CashiBot — backend dla Conversational AI (ElevenLabs, WebRTC).
 *
 * Rola serwera jest CELOWO minimalna i bezpieczna:
 *   1. Generuje krótkożyciowy token sesji WebRTC (`/api/webrtc-token`).
 *      Dzięki temu klucz API ElevenLabs NIGDY nie trafia do przeglądarki.
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
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

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

if (!API_KEY) {
  console.error("FATAL: brak zmiennej ELEVENLABS_API_KEY.");
  process.exit(1);
}
if (!AGENT_ID) {
  console.error("FATAL: brak zmiennej ELEVENLABS_AGENT_ID.");
  process.exit(1);
}

const elevenlabs = new ElevenLabsClient({ apiKey: API_KEY });

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

// Statyczny frontend.
app.use(express.static(path.join(__dirname, "public")));

// Health-check (przydatny dla monitoringu Railway).
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, agentConfigured: Boolean(AGENT_ID) });
});

/**
 * Mintuje krótkożyciowy token sesji WebRTC dla skonfigurowanego agenta.
 * Frontend przekazuje ten token do `Conversation.startSession({ connectionType: "webrtc", conversationToken })`.
 */
app.get("/api/webrtc-token", async (_req, res) => {
  try {
    const response = await elevenlabs.conversationalAi.conversations.getWebrtcToken({
      agentId: AGENT_ID,
    });
    const token = response?.token;
    if (!token) {
      throw new Error("Odpowiedź ElevenLabs nie zawiera pola 'token'.");
    }
    res.set("Cache-Control", "no-store");
    res.json({ token });
  } catch (err) {
    const detail = err?.message || String(err);
    console.error("Nie udało się wygenerować tokenu WebRTC:", detail);
    res.status(502).json({ error: "Nie udało się pobrać tokenu sesji WebRTC." });
  }
});

// Fallback: każde inne żądanie GET (np. odświeżenie SPA-podobnej ścieżki) -> index.html.
app.get(/^(?!\/api\/|\/vendor\/).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const server = app.listen(PORT, () => {
  console.log(`CashiBot (WebRTC) nasłuchuje na porcie ${PORT}`);
  console.log(`Agent ID: ${AGENT_ID.slice(0, 10)}…`);
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
