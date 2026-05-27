#!/usr/bin/env python3
"""
CashiBot - Conversational AI Agent
ElevenLabs Conversational AI z auto-reconnect i wysyłaniem dynamicznego kontekstu.
"""

import os
import signal
import sys
import time
import threading
from datetime import datetime

from dotenv import load_dotenv
from elevenlabs.client import ElevenLabs
from elevenlabs.conversational_ai.conversation import Conversation
from elevenlabs.conversational_ai.default_audio_interface import DefaultAudioInterface

load_dotenv()

KLUCZ_API = os.getenv("ELEVENLABS_API_KEY")
AGENT_ID = os.getenv("ELEVENLABS_AGENT_ID")

# Jak często (w sekundach) wysyłać aktualizację kontekstu do agenta
CONTEXT_INTERVAL = 30

# Czas oczekiwania przed ponowieniem połączenia po rozłączeniu
RETRY_DELAY = 5

_shutdown = threading.Event()


def buduj_kontekst() -> str:
    """Zwraca aktualny kontekst do wysłania agentowi."""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    return f"[Aktualizacja systemowa] Godzina: {now} | Status systemu: aktywny"


def petla_kontekstu(konwersacja: Conversation, stop: threading.Event) -> None:
    """Wątek wysyłający kontekst co CONTEXT_INTERVAL sekund."""
    # Czekamy chwilę, aż WebSocket się ustabilizuje po starcie sesji
    if stop.wait(timeout=3):
        return

    while not stop.wait(timeout=CONTEXT_INTERVAL):
        tekst = buduj_kontekst()
        try:
            konwersacja.send_contextual_update(tekst)
            print(f"  [kontekst] {tekst}")
        except RuntimeError:
            # Sesja jeszcze niegotowa lub już zakończona – pomijamy tę iterację
            pass
        except Exception as e:
            print(f"  [kontekst] Blad wysylania: {e}")


def uruchom_sesje(klient: ElevenLabs) -> None:
    """Tworzy i prowadzi jedną sesję rozmowy."""
    stop_kontekstu = threading.Event()

    konwersacja = Conversation(
        client=klient,
        agent_id=AGENT_ID,
        requires_auth=True,
        audio_interface=DefaultAudioInterface(),
        callback_user_transcript=lambda text: print(f"  [TY]  {text}"),
        callback_agent_response=lambda text: print(f"  [BOT] {text}"),
    )

    context_thread = threading.Thread(
        target=petla_kontekstu,
        args=(konwersacja, stop_kontekstu),
        daemon=True,
    )

    try:
        konwersacja.start_session()
        print("Polaczono! Mozesz mowic. Ctrl+C = wyjscie.\n")
        context_thread.start()
        konwersacja.wait_for_session_end()
    finally:
        stop_kontekstu.set()
        try:
            konwersacja.end_session()
        except Exception:
            pass


def main() -> None:
    print("=" * 60)
    print("  CashiBot - Agent ElevenLabs")
    print("=" * 60)

    if not KLUCZ_API:
        print("BLAD: Brak ELEVENLABS_API_KEY w pliku .env")
        sys.exit(1)
    if not AGENT_ID:
        print("BLAD: Brak ELEVENLABS_AGENT_ID w pliku .env")
        sys.exit(1)

    klient = ElevenLabs(api_key=KLUCZ_API)
    print("Klient ElevenLabs zainicjalizowany.\n")

    def handle_interrupt(sig, frame):
        print("\nZamykanie... (Ctrl+C)")
        _shutdown.set()
        sys.exit(0)

    signal.signal(signal.SIGINT, handle_interrupt)

    while not _shutdown.is_set():
        print("-" * 60)
        print("Nawiazuje polaczenie z agentem...")
        try:
            uruchom_sesje(klient)
            print(f"Sesja zakonczona. Ponawiam za {RETRY_DELAY}s...")
        except KeyboardInterrupt:
            _shutdown.set()
            break
        except Exception as e:
            print(f"Blad sesji ({type(e).__name__}): {e}")
            print(f"Ponawiam za {RETRY_DELAY}s...")

        if not _shutdown.is_set():
            time.sleep(RETRY_DELAY)

    print("Do widzenia!")


if __name__ == "__main__":
    main()
