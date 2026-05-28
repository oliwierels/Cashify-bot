import time
from elevenlabs.client import ElevenLabs
from elevenlabs.conversational_ai.conversation import Conversation
from elevenlabs.conversational_ai.default_audio_interface import DefaultAudioInterface

# Twoje dane logowania
API_KEY = "f6829c821d47fa08512c596bdff29d8f0b56b64d0ff8a3972e78c2896a172fc4" 
AGENT_ID = "agent_7701kseab0zhexxt811hgm2bratn"

# Inicjalizacja klienta
client = ElevenLabs(api_key=API_KEY)

print("Uruchamianie Agenta... Naciśnij Ctrl+C aby zakończyć program na stałe.")

# Pętla nieskończona - to ona odpowiada za obejście limitu rozłączeń
while True:
    try:
        print("\n--- Łączenie z Agentem... ---")
        
        # Konfiguracja sesji (używa domyślnego mikrofonu i głośnika w PC)
        conversation = Conversation(
            client=client,
            agent_id=AGENT_ID,
            requires_auth=True,
            audio_interface=DefaultAudioInterface(),
        )
        
        # Uruchomienie rozmowy - skrypt "zatrzyma się" w tym miejscu dopóki trwa sesja
        conversation.start_session()
        
        # Gdy serwer ElevenLabs zamknie sesję przez brak aktywności (po 10 min ciszy),
        # kod przejdzie dalej.
        conversation.wait_for_session_end()
        print("Sesja została przerwana przez serwer (limit ciszy).")

    except KeyboardInterrupt:
        # Zatrzymanie skryptu skrótem na klawiaturze
        print("\nZamykanie programu. Do widzenia!")
        break
    except Exception as e:
        print(f"Wystąpił błąd połączenia: {e}")
        
    print("Automatyczny restart za 10 sekund...")
    time.sleep(10)
