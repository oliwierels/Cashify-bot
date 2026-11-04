/**
 * CashiBot — logika frontendu (Conversational AI, ElevenLabs WebRTC).
 *
 * Założenia anty‑sprzężeniowe:
 *  - getUserMedia / track mikrofonu jest tworzony przez SDK z wymuszonymi flagami
 *    { echoCancellation, noiseSuppression, autoGainControl } = true (ścieżka WebRTC).
 *  - Mikrofon (DJI) przekazujemy w startSession — od SDK 1.22 jest publikowany od
 *    pierwszej chwili (wcześniej SDK startował z domyślnego mikrofonu telefonu).
 *    Głośnik (Bluetooth) aplikujemy PO połączeniu przez changeOutputDevice — na ścieżce
 *    WebRTC SDK nie honoruje outputDeviceId w momencie startu.
 *  - Trzy tryby mikrofonu (Otwarty / Auto‑wyciszanie / Push‑to‑Talk) jako warstwy
 *    obrony przed echem, gdyby sprzętowa redukcja głośnika BT zawiodła.
 */

// --- Stałe ------------------------------------------------------------------

// UWAGA: flagi echoCancellation/noiseSuppression/autoGainControl NIE są już
// ustawiane tutaj. Reguluje je globalny patch getUserMedia z <head> w index.html,
// sterowany przez window.__forceMediaProfile (tryb Bluetooth/A2DP).

const MODE_NOTES = {
  open: "Mikrofon zawsze aktywny. UWAGA: w trybie Bluetooth (bez systemowej redukcji echa) grozi sprzężeniem — użyj „Auto‑wyciszanie”.",
  duplex:
    "Mikrofon jest automatycznie wyciszany, gdy bot mówi. Najlepsza ochrona przed sprzężeniem przy głośniku Bluetooth.",
  ptt: "Mikrofon wyciszony. Przytrzymaj przycisk (lub spację), aby mówić.",
};

// Czy przeglądarka pozwala wybrać urządzenie WYJŚCIOWE z poziomu strony (setSinkId)?
const outputSelectionSupported =
  typeof HTMLMediaElement !== "undefined" &&
  "setSinkId" in HTMLMediaElement.prototype;

// iPhone/iPad (także Chrome na iOS — ten sam silnik WebKit). iPadOS przedstawia się jak Mac,
// więc rozpoznajemy go po ekranie dotykowym.
const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

// Kod dostępu (gdy serwer ma ustawione ACCESS_CODE) — zapamiętywany na urządzeniu.
const ACCESS_CODE_KEY = "cashibot.accessCode";

// --- Referencje do elementów ------------------------------------------------

const $ = (id) => document.getElementById(id);
const secureWarning = $("secureWarning");
const statusPill = $("statusPill");
const statusText = $("statusText");
const modePill = $("modePill");
const micSelect = $("micSelect");
const spkSelect = $("spkSelect");
const spkHint = $("spkHint");
const refreshBtn = $("refreshBtn");
const modeNote = $("modeNote");
const pttBtn = $("pttBtn");
const muteBtn = $("muteBtn");
const volume = $("volume");
const volumeVal = $("volumeVal");
const micState = $("micState");
const micMeterFill = $("micMeterFill");
const botMeterFill = $("botMeterFill");
const toggleBtn = $("toggleBtn");
const ctxForm = $("ctxForm");
const ctxInput = $("ctxInput");
const logEl = $("log");
const btMode = $("btMode");
const audioBadges = $("audioBadges");

// --- Stan -------------------------------------------------------------------

let conversation = null;
let connected = false;
let agentSpeaking = false; // czy bot aktualnie mówi (onModeChange)
let manualMuted = false; // ręczne wyciszenie (przycisk)
let pttHeld = false; // czy trzymany jest przycisk Push‑to‑Talk
let micMode = "duplex"; // 'open' | 'duplex' | 'ptt'
let meterRAF = 0;
let accessCode = loadAccessCode();

// --- Pomocnicze -------------------------------------------------------------

function setStatus(text, kind = "") {
  statusText.textContent = text;
  statusPill.className = "pill" + (kind ? " " + kind : "");
}

function setSpkHint(text, warn = false) {
  spkHint.textContent = text;
  spkHint.classList.remove("hidden");
  spkHint.classList.toggle("warn", warn);
}

// Pokazuje aktualny profil audio w zależności od trybu Bluetooth (A2DP) vs VoIP.
function renderAudioBadges() {
  if (!audioBadges) return;
  const bt = !!window.__forceMediaProfile;
  audioBadges.innerHTML = "";
  const make = (text, cls) => {
    const s = document.createElement("span");
    s.className = "badge" + (cls ? " " + cls : "");
    s.textContent = text;
    audioBadges.appendChild(s);
  };
  if (isIOS) {
    // WebKit przy aktywnym mikrofonie zawsze ustawia sesję audio iOS w tryb rozmowy
    // (PlayAndRecord + VideoChat), niezależnie od flag getUserMedia — profilu A2DP
    // nie da się wymusić ze strony.
    make("🍎 iOS: tryb rozmowy — wyjście wybiera system", "off");
    make(bt ? "✕ Echo cancellation" : "✓ Echo cancellation", bt ? "off" : "");
    return;
  }
  if (bt) {
    make("🔵 Profil: Multimedia / A2DP", "accent");
    make("✕ Echo cancellation", "off");
    make("✕ Noise suppression", "off");
    make("Echo eliminuje „Auto‑wyciszanie”");
  } else {
    make("📞 Profil: Komunikacja (VoIP)", "off");
    make("✓ Echo cancellation");
    make("✓ Noise suppression");
    make("✓ Auto gain control");
  }
}

function addLog(who, text) {
  const div = document.createElement("div");
  const cls = who === "user" ? "user" : who === "ctx" ? "ctx" : "agent";
  div.className = "msg " + cls;
  const label = document.createElement("span");
  label.className = "who";
  label.textContent = who === "user" ? "Ty" : who === "ctx" ? "Kontekst" : "Bot";
  div.appendChild(label);
  div.appendChild(document.createTextNode(text));
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

// Efektywny stan wyciszenia wynika z trybu + nadrzędnego ręcznego wyciszenia.
function computeMuted() {
  if (manualMuted) return true;
  if (micMode === "ptt") return !pttHeld;
  if (micMode === "duplex") return agentSpeaking;
  return false; // 'open'
}

function applyMute() {
  const muted = computeMuted();
  if (conversation) {
    try {
      conversation.setMicMuted(muted);
    } catch (e) {
      console.warn("setMicMuted:", e);
    }
  }
  micState.textContent = muted ? "🔇 wyciszony" : "🎤 aktywny";
  muteBtn.classList.toggle("muted", manualMuted);
  muteBtn.textContent = manualMuted ? "🔊 Włącz mikrofon" : "🎤 Wycisz mikrofon";
}

function updateMicModeUI() {
  pttBtn.classList.toggle("hidden", micMode !== "ptt");
  modeNote.textContent = MODE_NOTES[micMode] || "";
}

function loadAccessCode() {
  try {
    return localStorage.getItem(ACCESS_CODE_KEY) || "";
  } catch {
    return "";
  }
}

function saveAccessCode(code) {
  try {
    if (code) localStorage.setItem(ACCESS_CODE_KEY, code);
    else localStorage.removeItem(ACCESS_CODE_KEY);
  } catch {
    /* np. tryb prywatny — kod obowiązuje do odświeżenia strony */
  }
}

// Pobiera krótkożyciowy token sesji WebRTC (klucz API zostaje na serwerze).
// Gdy serwer wymaga kodu dostępu (401), pyta o niego i zapamiętuje poprawny.
async function fetchToken() {
  let promptText = "Podaj kod dostępu do CashiBota:";
  for (;;) {
    const res = await fetch("/api/webrtc-token", {
      cache: "no-store",
      headers: accessCode ? { "x-access-code": accessCode } : {},
    });
    if (res.status === 401) {
      if (accessCode) promptText = "Nieprawidłowy kod dostępu. Spróbuj ponownie:";
      accessCode = "";
      saveAccessCode("");
      const code = (window.prompt(promptText) || "").trim();
      if (!code) throw new Error("Wymagany kod dostępu");
      accessCode = code;
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) throw new Error(data.error || `HTTP ${res.status}`);
    saveAccessCode(accessCode);
    return data.token;
  }
}

// Czeka aż globalny obiekt SDK (window.ElevenLabsClient) będzie dostępny.
function whenSdkReady(timeoutMs = 4000) {
  return new Promise((resolve) => {
    const ready = () => window.ElevenLabsClient && window.ElevenLabsClient.Conversation;
    if (ready()) return resolve(window.ElevenLabsClient.Conversation);
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (ready()) {
        clearInterval(iv);
        resolve(window.ElevenLabsClient.Conversation);
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(iv);
        resolve(null);
      }
    }, 40);
  });
}

// --- Urządzenia audio -------------------------------------------------------

function populateSelect(sel, devices, fallbackPrefix) {
  const prev = sel.value;
  sel.innerHTML = "";
  const def = document.createElement("option");
  def.value = "";
  def.textContent = "Domyślny (system)";
  sel.appendChild(def);
  devices.forEach((d, idx) => {
    const o = document.createElement("option");
    o.value = d.deviceId;
    o.textContent = d.label || `${fallbackPrefix} ${idx + 1}`;
    sel.appendChild(o);
  });
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    populateSelect(
      micSelect,
      devices.filter((d) => d.kind === "audioinput"),
      "Mikrofon"
    );
    if (outputSelectionSupported) {
      populateSelect(
        spkSelect,
        devices.filter((d) => d.kind === "audiooutput"),
        "Głośnik"
      );
    }
  } catch (e) {
    console.warn("enumerateDevices:", e);
  }
}

// Wybrany mikrofon mógł zostać odłączony — start z nieistniejącym urządzeniem by się
// nie powiódł, więc wracamy wtedy do domyślnego.
async function resolveInputDeviceId() {
  const id = micSelect.value;
  if (!id || !navigator.mediaDevices?.enumerateDevices) return undefined;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (devices.some((d) => d.kind === "audioinput" && d.deviceId === id)) return id;
  } catch {
    return id;
  }
  console.warn("Wybrany mikrofon jest niedostępny — używam domyślnego.");
  micSelect.value = "";
  return undefined;
}

// Wymusza prompt o mikrofon (żeby pojawiły się etykiety urządzeń), potem odświeża listę.
async function ensurePermissionAndRefresh() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Brak API mediaDevices (wymagane HTTPS)", "error");
    return;
  }
  try {
    // Flagi audio (echoCancellation itd.) ustawia globalny patch z <head>
    // w zależności od trybu Bluetooth — tu prosimy tylko o dostęp do mikrofonu.
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
  } catch (e) {
    console.warn("getUserMedia:", e);
    setStatus("Brak dostępu do mikrofonu", "error");
    return;
  }
  await refreshDevices();
  setStatus("Gotowy");
}

// --- Sesja rozmowy ----------------------------------------------------------

async function start() {
  // Blokada od razu — podwójne kliknięcie nie może otworzyć dwóch sesji.
  toggleBtn.disabled = true;
  const Conversation = await whenSdkReady();
  if (!Conversation) {
    setStatus("Błąd: nie udało się załadować SDK ElevenLabs", "error");
    toggleBtn.disabled = false;
    return;
  }

  setStatus("Łączenie…", "connecting");

  const inputDeviceId = await resolveInputDeviceId();
  const outputDeviceId =
    outputSelectionSupported && spkSelect.value ? spkSelect.value : undefined;

  let conv = null;
  try {
    // 1) Pobierz krótkożyciowy token sesji WebRTC z backendu.
    const token = await fetchToken();

    // 2) Nawiąż sesję WebRTC (mikrofon publikowany od razu z wybranego urządzenia).
    conv = await Conversation.startSession({
      connectionType: "webrtc",
      conversationToken: token,
      inputDeviceId,
      outputDeviceId,

      onStatusChange: ({ status }) => {
        if (status === "connecting") setStatus("Łączenie…", "connecting");
        else if (status === "connected") setStatus("Połączono — mów śmiało", "connected");
        else if (status === "disconnecting") setStatus("Kończenie…", "connecting");
      },
      onModeChange: ({ mode }) => {
        agentSpeaking = mode === "speaking";
        modePill.textContent = agentSpeaking ? "🗣️ Bot mówi" : "👂 Słucha";
        applyMute(); // realizuje auto‑wyciszanie w trybie duplex
      },
      onMessage: (payload) => {
        if (!payload?.message) return;
        const role = payload.role || (payload.source === "ai" ? "agent" : "user");
        addLog(role === "agent" ? "agent" : "user", payload.message);
      },
      onError: (message) => {
        console.error("SDK error:", message);
        setStatus("Błąd: " + message, "error");
      },
      onDisconnect: () => cleanup(),
    });
    conversation = conv;

    // 3) startSession rozwiązuje się dopiero po nawiązaniu połączenia (isConnected=true),
    //    więc bezpiecznie aplikujemy wybrane wyjście teraz.
    if (outputDeviceId) {
      try {
        await conv.changeOutputDevice({ outputDeviceId });
      } catch (e) {
        console.warn("changeOutputDevice:", e);
        setSpkHint("Nie udało się przełączyć wyjścia — używam domyślnego.", true);
      }
    }

    // Sesja mogła się zakończyć w trakcie konfiguracji (onDisconnect -> cleanup()).
    if (conversation !== conv) return;

    conv.setVolume({ volume: Number(volume.value) / 100 });
    applyMute();
    startMeters();

    // UI: stan połączony
    connected = true;
    modePill.classList.remove("hidden");
    muteBtn.disabled = false;
    toggleBtn.textContent = "■ Zakończ rozmowę";
    toggleBtn.classList.add("danger");
    toggleBtn.disabled = false;
  } catch (err) {
    console.error(err);
    setStatus("Błąd: " + (err?.message || err), "error");
    conversation = null;
    // Nie zostawiaj otwartej sesji (i włączonego mikrofonu), jeśli błąd wystąpił po połączeniu.
    if (conv) conv.endSession().catch(() => {});
    toggleBtn.disabled = false;
  }
}

async function stop() {
  toggleBtn.disabled = true;
  setStatus("Kończenie…", "connecting");
  try {
    if (conversation) await conversation.endSession();
  } catch (e) {
    console.warn("endSession:", e);
  } finally {
    // endSession wywoła onDisconnect -> cleanup(); wołamy też tutaj na wypadek braku zdarzenia.
    cleanup();
  }
}

function cleanup() {
  if (!connected && !conversation && toggleBtn.textContent.startsWith("▶")) return; // już posprzątane
  connected = false;
  agentSpeaking = false;
  pttHeld = false;
  manualMuted = false;
  conversation = null;
  stopMeters();

  setStatus("Rozłączono");
  toggleBtn.textContent = "▶︎ Start rozmowy";
  toggleBtn.classList.remove("danger");
  toggleBtn.disabled = false;
  muteBtn.disabled = true;
  muteBtn.classList.remove("muted");
  muteBtn.textContent = "🎤 Wycisz mikrofon";
  pttBtn.classList.remove("holding");
  modePill.classList.add("hidden");
  micState.textContent = "—";
  micMeterFill.style.width = "0%";
  botMeterFill.style.width = "0%";
}

// --- Mierniki poziomu (VU) --------------------------------------------------

function startMeters() {
  stopMeters();
  const loop = () => {
    if (!conversation) return;
    try {
      const inV = conversation.getInputVolume ? conversation.getInputVolume() : 0;
      const outV = conversation.getOutputVolume ? conversation.getOutputVolume() : 0;
      micMeterFill.style.width = Math.min(100, Math.round(inV * 140)) + "%";
      botMeterFill.style.width = Math.min(100, Math.round(outV * 140)) + "%";
    } catch (e) {
      /* ignore */
    }
    meterRAF = requestAnimationFrame(loop);
  };
  meterRAF = requestAnimationFrame(loop);
}

function stopMeters() {
  if (meterRAF) cancelAnimationFrame(meterRAF);
  meterRAF = 0;
}

// --- Obsługa zdarzeń UI -----------------------------------------------------

toggleBtn.addEventListener("click", () => {
  if (conversation) stop();
  else start();
});

refreshBtn.addEventListener("click", ensurePermissionAndRefresh);

muteBtn.addEventListener("click", () => {
  manualMuted = !manualMuted;
  applyMute();
});

document.querySelectorAll('input[name="micmode"]').forEach((r) => {
  r.addEventListener("change", () => {
    micMode = document.querySelector('input[name="micmode"]:checked').value;
    pttHeld = false;
    pttBtn.classList.remove("holding");
    updateMicModeUI();
    applyMute();
  });
});

// Tryb Bluetooth (A2DP): wyłącza systemową redukcję echa (echoCancellation itd.),
// dzięki czemu Android nie przełącza sesji w tryb VoIP i dźwięk trafia na głośnik BT.
if (btMode) {
  btMode.addEventListener("change", () => {
    window.__forceMediaProfile = btMode.checked;
    renderAudioBadges();
    if (connected) {
      // Track mikrofonu już istnieje — nowy profil zadziała przy następnym połączeniu.
      setStatus("Tryb Bluetooth zmieni się po ponownym połączeniu", "connected");
    }
  });
}

// Push‑to‑Talk: wciśnięcie = mów, puszczenie = cisza.
pttBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  pttHeld = true;
  pttBtn.classList.add("holding");
  applyMute();
});
const releasePtt = () => {
  if (!pttHeld) return;
  pttHeld = false;
  pttBtn.classList.remove("holding");
  applyMute();
};
["pointerup", "pointerleave", "pointercancel"].forEach((ev) =>
  pttBtn.addEventListener(ev, releasePtt)
);

// Spacja jako Push‑to‑Talk (gdy aktywny tryb PTT i nie piszemy w polu kontekstu).
window.addEventListener("keydown", (e) => {
  if (
    e.code === "Space" &&
    micMode === "ptt" &&
    connected &&
    !e.repeat &&
    document.activeElement !== ctxInput
  ) {
    e.preventDefault();
    pttHeld = true;
    pttBtn.classList.add("holding");
    applyMute();
  }
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space" && micMode === "ptt") {
    e.preventDefault();
    releasePtt();
  }
});

volume.addEventListener("input", () => {
  volumeVal.textContent = volume.value + "%";
  if (conversation) conversation.setVolume({ volume: Number(volume.value) / 100 });
});

ctxForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = ctxInput.value.trim();
  if (!text || !conversation) return;
  try {
    conversation.sendContextualUpdate(text);
    addLog("ctx", text);
  } catch (err) {
    console.warn("sendContextualUpdate:", err);
  }
  ctxInput.value = "";
});

// --- Inicjalizacja ----------------------------------------------------------

function init() {
  if (!window.isSecureContext || !navigator.mediaDevices) {
    secureWarning.classList.remove("hidden");
  }

  // Zsynchronizuj tryb Bluetooth (A2DP) z przełącznikiem i pokaż aktualny profil audio.
  window.__forceMediaProfile = btMode ? btMode.checked : true;
  renderAudioBadges();

  if (isIOS) {
    spkSelect.disabled = !outputSelectionSupported;
    setSpkHint(
      "iPhone: gdy strona używa mikrofonu, iOS przełącza dźwięk w tryb rozmowy i może grać przez głośnik telefonu zamiast przez głośnik Bluetooth. Strona nie może tego zmienić — na stoisko z głośnikiem BT użyj Androida albo komputera.",
      true
    );
    const btNote = btMode?.closest(".switch-field")?.querySelector("small");
    if (btNote) btNote.textContent = "Działa tylko na Androidzie. Na iPhonie nie wpływa na wybór głośnika.";
  } else if (!outputSelectionSupported) {
    spkSelect.disabled = true;
    setSpkHint(
      "Twoja przeglądarka nie pozwala wybrać wyjścia z poziomu strony — system (np. Bluetooth) wybiera je automatycznie."
    );
  } else if (window.__forceMediaProfile) {
    setSpkHint(
      "W trybie Bluetooth zostaw „Domyślny (system)” — Android sam skieruje dźwięk na głośnik Bluetooth (A2DP)."
    );
  }

  updateMicModeUI();

  // PWA: service worker (instalacja na ekranie głównym, szybsze otwieranie).
  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("serviceWorker:", e));
  }

  // Wstępna enumeracja (etykiety mogą być puste do czasu przyznania uprawnień).
  refreshDevices();
  navigator.mediaDevices?.addEventListener?.("devicechange", refreshDevices);
}

init();
