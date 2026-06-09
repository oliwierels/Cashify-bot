#!/usr/bin/env python3
"""
CashiBot - Conversational AI Agent
Produkcyjny bot głosowy na stoisko: 8h/dzień, keepalive, auto-reconnect, live context.
"""

import logging
import os
import queue
import signal
import sys
import time
import threading
from datetime import datetime

import pyaudio
from dotenv import load_dotenv
from elevenlabs.client import ElevenLabs
from elevenlabs.conversational_ai.conversation import Conversation, AudioInterface

load_dotenv()

# ---------------------------------------------------------------------------
# Konfiguracja
# ---------------------------------------------------------------------------

KLUCZ_API = os.getenv("ELEVENLABS_API_KEY")
AGENT_ID = os.getenv("ELEVENLABS_AGENT_ID")

# Keepalive: ElevenLabs rozłącza sesję po ~30s ciszy – pingujemy co 20s.
KEEPALIVE_INTERVAL = 20

# Co ile sekund dosyłamy dynamiczny kontekst (godzina, status itp.)
CONTEXT_INTERVAL = 30

# Proaktywny restart po 4h – zapobiega problemom z bardzo długimi sesjami.
MAX_SESSION_SECS = 4 * 3600

# Backoff przy błędach: 5s → 10s → 20s → 30s (cap)
RETRY_DELAYS = [5, 10, 20, 30]

# ---------------------------------------------------------------------------
# Logging: konsola + plik (przydatne przy 8h dyżurze)
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("cashibot.log", encoding="utf-8"),
    ],
)
log = logging.getLogger("cashibot")

_shutdown = threading.Event()

# ---------------------------------------------------------------------------
# Buforowany interfejs audio – eliminuje cięcia przy jitterze sieci
# ---------------------------------------------------------------------------

class BufferedAudioInterface(AudioInterface):
    """
    Własna implementacja AudioInterface z kolejką wyjściową.
    Sieć może dostarczać audio nieregularnie – kolejka wygładza odtwarzanie.
    """
    RATE = 16000
    CHANNELS = 1
    FORMAT = pyaudio.paInt16
    INPUT_CHUNK = 4000   # 250ms – zalecane przez ElevenLabs
    OUTPUT_CHUNK = 8192  # większy bufor wyjściowy = mniej cięć

    def start(self, input_callback):
        self._pa = pyaudio.PyAudio()
        self._stop = threading.Event()
        self._out_queue = queue.Queue()
        self._last_output_time = 0.0  # timestamp ostatniego odtworzonego chunka

        self._in_stream = self._pa.open(
            format=self.FORMAT,
            channels=self.CHANNELS,
            rate=self.RATE,
            input=True,
            frames_per_buffer=self.INPUT_CHUNK,
        )
        self._out_stream = self._pa.open(
            format=self.FORMAT,
            channels=self.CHANNELS,
            rate=self.RATE,
            output=True,
            frames_per_buffer=self.OUTPUT_CHUNK,
        )

        threading.Thread(target=self._reader, args=(input_callback,), daemon=True).start()
        threading.Thread(target=self._writer, daemon=True).start()

    POST_SPEECH_MUTE_SECS = 0.30  # cisza po wypowiedzi bota przed wznowieniem nasłuchu

    def _reader(self, callback):
        while not self._stop.is_set():
            try:
                data = self._in_stream.read(self.INPUT_CHUNK, exception_on_overflow=False)
                if time.monotonic() - self._last_output_time >= self.POST_SPEECH_MUTE_SECS:
                    callback(data)
            except Exception:
                break

    def _writer(self):
        while not self._stop.is_set():
            try:
                chunk = self._out_queue.get(timeout=0.1)
                if chunk is None:
                    break
                self._out_stream.write(chunk)
                self._last_output_time = time.monotonic()
            except queue.Empty:
                continue
            except Exception:
                break

    def stop(self):
        self._stop.set()
        self._out_queue.put(None)
        try:
            self._in_stream.stop_stream()
            self._in_stream.close()
            self._out_stream.stop_stream()
            self._out_stream.close()
            self._pa.terminate()
        except Exception:
            pass

    def output(self, audio: bytes):
        try:
            self._out_queue.put_nowait(audio)
        except queue.Full:
            pass  # pełna kolejka = odrzucamy chunk zamiast blokować

    def interrupt(self):
        while not self._out_queue.empty():
            try:
                self._out_queue.get_nowait()
            except queue.Empty:
                break


# ---------------------------------------------------------------------------
# Wątki pomocnicze sesji
# ---------------------------------------------------------------------------

def petla_keepalive(konwersacja: Conversation, stop: threading.Event) -> None:
    """Pinguje serwer co KEEPALIVE_INTERVAL sekund, żeby sesja nie wygasła podczas ciszy."""
    while not stop.wait(timeout=KEEPALIVE_INTERVAL):
        try:
            konwersacja.register_user_activity()
        except Exception:
            # Sesja właśnie się kończy – pętla i tak zaraz się zatrzyma.
            pass


def buduj_kontekst() -> str:
    """Zwraca aktualny kontekst do wstrzyknięcia do rozmowy."""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    return f"Aktualizacja systemowa: godzina {now}, system aktywny."


def petla_kontekstu(konwersacja: Conversation, stop: threading.Event) -> None:
    """Co CONTEXT_INTERVAL sekund wysyła kontekst do agenta (nie przerywa rozmowy)."""
    # Krótkie opóźnienie żeby WebSocket zdążył się ustabilizować.
    if stop.wait(timeout=3):
        return
    while not stop.wait(timeout=CONTEXT_INTERVAL):
        try:
            konwersacja.send_contextual_update(buduj_kontekst())
        except RuntimeError:
            # Sesja jeszcze niegotowa lub już zakończona – pomijamy.
            pass
        except Exception as e:
            log.warning("Blad wysylania kontekstu: %s", e)

# ---------------------------------------------------------------------------
# Logika sesji
# ---------------------------------------------------------------------------

def uruchom_sesje(klient: ElevenLabs, numer: int) -> None:
    """Tworzy i prowadzi jedną sesję rozmowy."""
    log.info("=== Sesja #%d: start ===", numer)
    stop = threading.Event()
    start_ts = time.monotonic()

    konwersacja = Conversation(
        client=klient,
        agent_id=AGENT_ID,
        requires_auth=True,
        audio_interface=BufferedAudioInterface(),
        callback_user_transcript=lambda text: log.info("[TY]  %s", text),
        callback_agent_response=lambda text: log.info("[BOT] %s", text),
    )

    keepalive_thread = threading.Thread(
        target=petla_keepalive, args=(konwersacja, stop), daemon=True
    )
    context_thread = threading.Thread(
        target=petla_kontekstu, args=(konwersacja, stop), daemon=True
    )

    def watchdog():
        """Proaktywnie kończy sesję po MAX_SESSION_SECS (np. po 4h)."""
        if not stop.wait(timeout=MAX_SESSION_SECS):
            log.info("Sesja #%d: proaktywny restart po %dh.", numer, MAX_SESSION_SECS // 3600)
            try:
                konwersacja.end_session()
            except Exception:
                pass

    watchdog_thread = threading.Thread(target=watchdog, daemon=True)

    try:
        konwersacja.start_session()
        keepalive_thread.start()
        context_thread.start()
        watchdog_thread.start()
        log.info("Sesja #%d: polaczona. Czekam na klientow...", numer)
        konwersacja.wait_for_session_end()
    finally:
        stop.set()
        elapsed = time.monotonic() - start_ts
        log.info("Sesja #%d: zakonczona po %.0fs.", numer, elapsed)
        try:
            konwersacja.end_session()
        except Exception:
            pass

# ---------------------------------------------------------------------------
# Główna pętla
# ---------------------------------------------------------------------------

def main() -> None:
    if not KLUCZ_API:
        print("BLAD: Brak ELEVENLABS_API_KEY w pliku .env")
        sys.exit(1)
    if not AGENT_ID:
        print("BLAD: Brak ELEVENLABS_AGENT_ID w pliku .env")
        sys.exit(1)

    log.info("CashiBot uruchomiony.")
    klient = ElevenLabs(api_key=KLUCZ_API)

    def handle_interrupt(sig, frame):
        log.info("Ctrl+C – zamykam.")
        _shutdown.set()
        sys.exit(0)

    signal.signal(signal.SIGINT, handle_interrupt)

    numer_sesji = 0
    retry_idx = 0

    while not _shutdown.is_set():
        numer_sesji += 1
        try:
            uruchom_sesje(klient, numer_sesji)
            # Sesja zakończyła się normalnie (np. proaktywny restart lub klient zakończył).
            retry_idx = 0  # reset backoff – wszystko działało poprawnie
        except KeyboardInterrupt:
            _shutdown.set()
            break
        except Exception as e:
            log.error("Sesja #%d blad: %s: %s", numer_sesji, type(e).__name__, e)

        if _shutdown.is_set():
            break

        delay = RETRY_DELAYS[min(retry_idx, len(RETRY_DELAYS) - 1)]
        retry_idx += 1
        log.info("Ponawiam polaczenie za %ds...", delay)
        # wait zamiast sleep: od razu reaguje na Ctrl+C
        _shutdown.wait(timeout=delay)

    log.info("CashiBot zatrzymany.")


if __name__ == "__main__":
    main()
