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

- Node.js 22 (ustawione w `package.json` → `engines`; Railway wybiera tę wersję automatycznie).
- Konto ElevenLabs z agentem Conversational AI (`agent_…`) oraz klucz API.

## Konfiguracja (zmienne środowiskowe)

Skopiuj `.env.example` do `.env` i uzupełnij:

| Zmienna | Wymagana | Opis |
|---|---|---|
| `ELEVENLABS_API_KEY` | ✅* | Domyślny klucz API (tylko po stronie serwera) — dla agentów bez własnego klucza. |
| `AGENT_<NAZWA>_ID` | ✅* | ID agenta, np. `AGENT_LEXAI_ID`, `AGENT_BENIO_ID`, `AGENT_JERZY_ID`. Każda taka zmienna dodaje agenta do wyboru w aplikacji (nazwa bez podkreśleń). |
| `AGENT_<NAZWA>_API_KEY` | ➖ | Osobny klucz API dla agenta z innego konta ElevenLabs, np. `AGENT_JERZY_API_KEY`. |
| `AGENT_<NAZWA>_NAME` | ➖ | Nazwa przycisku. Domyślnie LexAI / Benio / Jerzy albo nazwa ze zmiennej. |
| `ELEVENLABS_AGENT_ID` | ➖ | Stara konfiguracja. Bez żadnego `AGENT_<NAZWA>_ID` — jedyny agent (jak dotąd). Z nimi — agent zaznaczony domyślnie na nowych telefonach (spoza listy: dodany jako „CashiBot”). |
| `PORT` | ➖ | Port. Na Railway ustawiany automatycznie. Lokalnie domyślnie `3000`. |
| `ALLOWED_ORIGIN` | ➖ | Ogranicza CORS do podanego origin (domyślnie odbija origin żądania). |

\* Potrzebny jest co najmniej jeden agent (`AGENT_<NAZWA>_ID` albo `ELEVENLABS_AGENT_ID`) i dla każdego
klucz: własny `AGENT_<NAZWA>_API_KEY` albo wspólny `ELEVENLABS_API_KEY`. ID agentów i klucze trzymamy
wyłącznie w Variables — nie w repozytorium.

### Agenci pod jednym linkiem

Wszyscy używają tego samego adresu aplikacji, a każdy wybiera na górze ekranu swojego agenta.
Wybór jest zapamiętywany na danym telefonie; w trakcie rozmowy nie można go zmienić.
Przykład Variables na Railway:

```
ELEVENLABS_API_KEY=...          # wspólny klucz
AGENT_LEXAI_ID=agent_...
AGENT_BENIO_ID=agent_...
AGENT_JERZY_ID=agent_...
AGENT_JERZY_API_KEY=...         # opcjonalnie, gdy Jerzy jest na innym koncie ElevenLabs
```

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

Najprościej: wyślij link **`https://<adres-aplikacji>/instaluj`** — strona z przyciskiem
„Zainstaluj aplikację” (Chrome na Androidzie) i instrukcją dla iPhone'a. Ręcznie, po otwarciu
publicznego adresu HTTPS:

- **Android (Chrome):** menu ⋮ → **Zainstaluj aplikację** / **Dodaj do ekranu głównego**.
- **iOS 26 (Safari):** przycisk **⋯** obok paska adresu → **Udostępnij** → przewiń w dół →
  **Do ekranu początkowego** → zostaw włączone „Otwórz jako aplikację” (*Open as Web App*) →
  **Dodaj**.

Aplikacja uruchamia się wtedy z ikony, na pełnym ekranie. Service worker (`public/sw.js`)
działa w trybie *network-first*: zawsze pobiera najnowszą wersję po wdrożeniu, a cache służy
tylko do szybkiego otwarcia, gdy brak sieci. Żądania `/api/*` nigdy nie są cache'owane.

## Wdrożenie na Railway (Nixpacks)

1. Wypchnij repo do GitHub i utwórz nowy projekt na Railway z tego repozytorium.
2. Railway (Nixpacks) automatycznie wykryje Node.js i uruchomi:
   - instalację: `npm install`
   - start: `npm start` (czyli `node server.js`)
   - `npm run build` jest no‑opem (frontend jest statyczny, bez budowania).
3. W zakładce **Variables** ustaw `ELEVENLABS_API_KEY` i agentów (`AGENT_<NAZWA>_ID`, patrz wyżej).
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
| `GET` | `/api/health` | Health‑check: `{ ok, agents }` (lista identyfikatorów agentów). |
| `GET` | `/api/agents` | Agenci do wyboru: `{ agents: [{ slug, name }] }` (bez kluczy API). |
| `GET` | `/api/webrtc-token?agent=<slug>` | Zwraca `{ token }` — krótkożyciowy token sesji WebRTC dla wybranego agenta. Bez `agent` działa tylko przy jednym agencie. |
| `GET` | `/vendor/lib.iife.js` | Oficjalny SDK przeglądarkowy (z `node_modules`). |

## Uwagi o urządzeniach audio

- **Wybór głośnika (wyjścia)** z poziomu strony wymaga API `setSinkId` (Chrome/Edge na
  desktopie i Androidzie). Gdy nie jest dostępne (np. iOS/Safari), lista jest wyłączona,
  a wyjście wybiera system operacyjny (przy podłączonym Bluetooth — automatycznie na BT).
- Etykiety urządzeń pojawiają się dopiero po przyznaniu uprawnień do mikrofonu — użyj
  przycisku 🔄, aby udzielić zgody i odświeżyć listę.
- Lista odświeża się automatycznie przy podłączeniu/odłączeniu sprzętu (`devicechange`).
- **iPhone / iPad + głośnik Bluetooth:** każda przeglądarka na iOS (także Chrome) działa na
  silniku WebKit, który przy aktywnym mikrofonie ustawia sesję audio iOS w tryb rozmowy
  (`PlayAndRecord` + `VideoChat`, opcje Bluetooth HFP + A2DP + `DefaultToSpeaker`) —
  niezależnie od flag `getUserMedia`, więc trik z Androida (wyłączenie redukcji echa) nic tu
  nie zmienia, a głośnik wybiera iOS. Ta logika jest identyczna w całej linii iOS 26.x.
  W iOS 27 WebKit zmienia przy mikrofonie politykę trasy na `LongFormAudio`
  (`MediaSessionManagerCocoa.mm`) — po aktualizacji do iOS 27 przetestuj głośnik BT przed
  wydarzeniem.
- **iPhone gra z telefonu zamiast z głośnika BT (także na stronach testowych WebRTC, np.
  webrtc.github.io/samples → peerconnection/audio)?** To stan iOS, nie aplikacji — pomógł
  restart iPhone'a (czasem dopiero kolejny). Przed wydarzeniem: połącz głośnik, uruchom krótką
  rozmowę i sprawdź, skąd leci dźwięk; Android jako zapas.
