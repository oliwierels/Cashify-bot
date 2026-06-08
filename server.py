#!/usr/bin/env python3
"""
CashiBot Web - serwer udostepniajacy strone z botem glosowym do przegladarki.
Dziala na telefonie: mikrofon/glosnik obsluguje przegladarka (np. przez Bluetooth - DJI mic).
Klucz API zostaje bezpiecznie po stronie serwera - frontend dostaje tylko jednorazowy signed URL.
"""

import os

from dotenv import load_dotenv
from elevenlabs.client import ElevenLabs
from flask import Flask, jsonify, send_from_directory

load_dotenv()

API_KEY = os.getenv("ELEVENLABS_API_KEY")
AGENT_ID = os.getenv("ELEVENLABS_AGENT_ID")

if not API_KEY:
    raise RuntimeError("Brak ELEVENLABS_API_KEY w zmiennych srodowiskowych")
if not AGENT_ID:
    raise RuntimeError("Brak ELEVENLABS_AGENT_ID w zmiennych srodowiskowych")

client = ElevenLabs(api_key=API_KEY)

app = Flask(__name__, static_folder="static", static_url_path="")


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/signed-url")
def signed_url():
    response = client.conversational_ai.conversations.get_signed_url(agent_id=AGENT_ID)
    return jsonify({"signedUrl": response.signed_url})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port)
