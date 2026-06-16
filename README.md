# CashiBot — Conversational AI (ElevenLabs, WebRTC)

Aplikacja webowa do rozmowy głosowej z agentem ElevenLabs **w czasie rzeczywistym (WebRTC)**,
zaprojektowana pod kiosk/stoisko: minimalne opóźnienia i wielowarstwowa ochrona przed
sprzężeniem zwrotnym (echo/zapętlanie). Gotowa do wdrożenia na **Railway** (Nixpacks, `npm start`).

## Architektura

```
┌─────────────────────────┐         ┌──────────────────────────────┐
│  Przeglądarka (public/)  │         │  Node/Express (server.js)     │
│                          │  GET    │                                │
│  ElevenLabs WebRTC SDK   │ ──────▶ │  /api/webrtc-token             │
│  (window.ElevenLabsClient)│ token  │   → getWebrtcToken(agentId)    │
│                          │ ◀────── │   (klucz API tylko na serwerze)│
└───────────┬──────────────┘         └──────────────────────────────┘
            │ WebRTC (audio) — bezpośrednio do ElevenLabs/LiveKit
            ▼
   🎙️ Mikrofon (DJI)   🔊 Głośnik (Bluetooth)
```

- **Backend** robi jedną rzecz: generuje krótkożyciowy **token sesji WebRTC**. Klucz API
  ElevenLabs **nigdy** nie trafia do przeglądarki. Serwer nasłuchuje na `process.env.PORT`.
- **Frontend** (czysty JS w `public/`) łączy się z agentem przez oficjalny SDK.
  Sam dźwięk WebRTC płynie bezpośrednio między przeglądarką a ElevenLabs (niskie opóźnienia).
- **SDK przeglądarkowy** jest serwowany lokalnie z `node_modules` pod `/vendor/lib.iife.js`
  — brak zależności od zewnętrznego CDN i brak kroku budowania frontendu.

## Ochrona przed sprzężeniem (echo/zapętlanie)

1. **Wymuszone flagi audio** na torze WebRTC: `echoCancellation`, `noiseSuppression`,
   `autoGainControl` (SDK ustawia je na `true` przy tworzeniu tracka mikrofonu).
2. **Jawny wybór urządzeń** wejścia (DJI) i wyjścia (głośnik BT) — aplikowany po połączeniu
   przez `changeInputDevice` / `changeOutputDevice`, co dodatkowo potwierdza powyższe flagi
   na konkretnym sprzęcie.
3. **Trzy tryby mikrofonu** (przełącznik w UI):
   - **Otwarty mikrofon** — pełny duplex, polega na redukcji echa.
   - **Auto‑wyciszanie (zalecane)** — mikrofon jest automatycznie wyciszany, gdy bot mówi.
     Najpewniejsza ochrona, gdy sprzętowa redukcja echa głośnika Bluetooth zawodzi.
   - **Push‑to‑Talk** — mikrofon wyciszony; mówisz tylko trzymając przycisk (lub spację).
4. **Ręczne wyciszenie** (przycisk) zawsze nadrzędne.
5. **Mierniki poziomu** mikrofonu i bota — wizualne potwierdzenie, że mikrofon milczy,
   gdy bot mówi.

## Wymagania

- Node.js ≥ 18 (zalecane 20+).
- Konto ElevenLabs z agentem Conversational AI (`agent_…`) oraz klucz API.

## Konfiguracja (zmienne środowiskowe)

Skopiuj `.env.example` do `.env` i uzupełnij:

| Zmienna | Wymagana | Opis |
|---|---|---|
| `ELEVENLABS_API_KEY` | ✅ | Klucz API (tylko po stronie serwera). |
| `ELEVENLABS_AGENT_ID` | ✅ | ID agenta (`agent_…`). |
| `PORT` | ➖ | Port. Na Railway ustawiany automatycznie. Lokalnie domyślnie `3000`. |
| `ALLOWED_ORIGIN` | ➖ | Ogranicza CORS do podanego origin (domyślnie odbija origin żądania). |

## Uruchomienie lokalne

```bash
npm install
cp .env.example .env   # i uzupełnij klucze
npm start
# otwórz http://localhost:3000
```

> `getUserMedia` i wybór urządzeń wymagają **bezpiecznego kontekstu**: `http://localhost`
> działa w dev, a w sieci/produkcji wymagane jest **HTTPS** (Railway zapewnia je automatycznie).

## Wdrożenie na Railway (Nixpacks)

1. Wypchnij repo do GitHub i utwórz nowy projekt na Railway z tego repozytorium.
2. Railway (Nixpacks) automatycznie wykryje Node.js i uruchomi:
   - instalację: `npm install`
   - start: `npm start` (czyli `node server.js`)
   - `npm run build` jest no‑opem (frontend jest statyczny, bez budowania).
3. W zakładce **Variables** ustaw `ELEVENLABS_API_KEY` i `ELEVENLABS_AGENT_ID`.
   `PORT` jest wstrzykiwany przez Railway — nie ustawiaj go ręcznie.
4. Po wdrożeniu otwórz publiczny URL (HTTPS), zezwól na mikrofon, wybierz urządzenia i kliknij **Start**.

Nie jest potrzebny Dockerfile — wystarcza standardowy setup Node.

### Sieć (egress)

- **Serwer** potrzebuje wyjścia do `api.elevenlabs.io` (mintowanie tokenu). Na Railway egress
  jest domyślnie otwarty. W środowiskach z białą listą hostów dodaj `api.elevenlabs.io`.
- **Przeglądarka** łączy się bezpośrednio z ElevenLabs/LiveKit (WebRTC) — wymaga normalnego
  dostępu do internetu z urządzenia (telefonu na stoisku).

## API serwera

| Metoda | Ścieżka | Opis |
|---|---|---|
| `GET` | `/api/health` | Health‑check: `{ ok, agentConfigured }`. |
| `GET` | `/api/webrtc-token` | Zwraca `{ token }` — krótkożyciowy token sesji WebRTC. |
| `GET` | `/vendor/lib.iife.js` | Oficjalny SDK przeglądarkowy (z `node_modules`). |

## Uwagi o urządzeniach audio

- **Wybór głośnika (wyjścia)** z poziomu strony wymaga API `setSinkId` (Chrome/Edge na
  desktopie i Androidzie). Gdy nie jest dostępne (np. iOS/Safari), lista jest wyłączona,
  a wyjście wybiera system operacyjny (przy podłączonym Bluetooth — automatycznie na BT).
- Etykiety urządzeń pojawiają się dopiero po przyznaniu uprawnień do mikrofonu — użyj
  przycisku 🔄, aby udzielić zgody i odświeżyć listę.
- Lista odświeża się automatycznie przy podłączeniu/odłączeniu sprzętu (`devicechange`).

## Struktura projektu

```
.
├── server.js            # Backend: token WebRTC + serwowanie statyków i SDK
├── package.json         # Skrypty (start/build) i zależności
├── .env.example         # Wzór konfiguracji
└── public/
    ├── index.html       # UI
    ├── styles.css       # Style
    └── app.js           # Logika: WebRTC, wybór urządzeń, tryby mikrofonu, mierniki
```
