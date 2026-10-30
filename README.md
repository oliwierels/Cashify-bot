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
│  (window.ElevenLabsClient)│ token  │   → token z API ElevenLabs     │
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
- **PWA** — aplikację można zainstalować na ekranie głównym telefonu (ikona, pełny ekran,
  bez paska adresu). Zobacz [Instalacja na telefonie](#instalacja-na-telefonie-pwa).

## Ochrona przed sprzężeniem (echo/zapętlanie)

1. **Wymuszone flagi audio** na torze WebRTC: `echoCancellation`, `noiseSuppression`,
   `autoGainControl` (SDK ustawia je na `true` przy tworzeniu tracka mikrofonu).
2. **Jawny wybór urządzeń** wejścia (DJI) i wyjścia (głośnik BT) — mikrofon jest przekazywany
   do `startSession` i publikowany od pierwszej chwili (SDK ≥ 1.22), a głośnik aplikowany po
   połączeniu przez `changeOutputDevice`. Odłączony mikrofon → automatyczny powrót do domyślnego.
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
| `ACCESS_CODE` | ➖ (zalecane) | Kod dostępu wymagany do rozpoczęcia rozmowy. Bez niego każdy, kto zna link, może prowadzić rozmowy na koszt konta ElevenLabs. Aplikacja pyta o kod raz i zapamiętuje go na urządzeniu. Użyj min. 8 znaków — po 20 błędnych próbach w ciągu 15 min serwer blokuje tokeny (dla wszystkich) do końca okna. |

## Uruchomienie lokalne

```bash
npm install
cp .env.example .env   # i uzupełnij klucze
npm start
# otwórz http://localhost:3000
```

> `getUserMedia` i wybór urządzeń wymagają **bezpiecznego kontekstu**: `http://localhost`
> działa w dev, a w sieci/produkcji wymagane jest **HTTPS** (Railway zapewnia je automatycznie).

## Instalacja na telefonie (PWA)

Po otwarciu publicznego adresu HTTPS:

- **Android (Chrome):** menu ⋮ → **Zainstaluj aplikację** / **Dodaj do ekranu głównego**.
- **iOS (Safari):** przycisk Udostępnij → **Do ekranu początkowego**.

Aplikacja uruchamia się wtedy z ikony, na pełnym ekranie. Service worker (`public/sw.js`)
działa w trybie *network-first*: zawsze pobiera najnowszą wersję po wdrożeniu, a cache służy
tylko do szybkiego otwarcia, gdy brak sieci. Żądania `/api/*` nigdy nie są cache'owane.

## Wdrożenie na Railway (Nixpacks)

1. Wypchnij repo do GitHub i utwórz nowy projekt na Railway z tego repozytorium.
2. Railway (Nixpacks) automatycznie wykryje Node.js i uruchomi:
   - instalację: `npm install`
   - start: `npm start` (czyli `node server.js`)
   - `npm run build` jest no‑opem (frontend jest statyczny, bez budowania).
3. W zakładce **Variables** ustaw `ELEVENLABS_API_KEY` i `ELEVENLABS_AGENT_ID`
   (zalecane też `ACCESS_CODE`).
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
| `GET` | `/api/health` | Health‑check: `{ ok, agentConfigured, accessCodeRequired }`. |
| `GET` | `/api/webrtc-token` | Zwraca `{ token }` — krótkożyciowy token sesji WebRTC. Gdy ustawiono `ACCESS_CODE`, wymaga nagłówka `x-access-code` (inaczej `401`; po zbyt wielu błędach `429`). |
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
    ├── index.html             # UI
    ├── styles.css             # Style
    ├── app.js                 # Logika: WebRTC, wybór urządzeń, tryby mikrofonu, mierniki
    ├── manifest.webmanifest   # PWA: nazwa, ikony, tryb pełnoekranowy
    ├── sw.js                  # PWA: service worker (network-first)
    └── icons/                 # Ikony aplikacji (Android, iOS)
```
