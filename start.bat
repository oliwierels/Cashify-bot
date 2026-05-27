@echo off
title CashiBot
cd /d "%~dp0"

echo ============================================================
echo   CashiBot - uruchamianie...
echo ============================================================
echo.

if not exist "venv\Scripts\activate.bat" (
    echo BLAD: Nie znaleziono srodowiska venv.
    echo Upewnij sie ze skrypt uruchamiasz z folderu projektu.
    pause
    exit /b 1
)

if not exist ".env" (
    echo BLAD: Nie znaleziono pliku .env z kluczami API.
    echo Skopiuj .env.example do .env i uzupelnij klucze.
    pause
    exit /b 1
)

call venv\Scripts\activate.bat
python cashibot.py

echo.
echo ============================================================
echo   Bot zatrzymany. Nacisnij dowolny klawisz aby zamknac...
echo ============================================================
pause > nul
