# Cosmic Clash

Cosmic Clash is a browser based, real-time multiplayer survival arena. Two to eight pilots join a room code, move around a shared arena, fire energy bolts, collect health orbs, and try to be the last pilot standing while the safe zone contracts.

## Run locally

The project pins Python **3.8.10** in the Python version file. Create the virtual environment with that interpreter:

    py -3.8 -m venv .venv
    .venv/Scripts/Activate.ps1
    python -m pip install --upgrade pip
    pip install -r requirements.txt
    python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload

Open <http://127.0.0.1:8000>. For a second local player, use another browser profile or tab and join with the five character room code. If PowerShell activation is blocked, run the commands with .venv/Scripts/python.exe directly.

## Play

- Enter a pilot name and create a room, or enter a shared room code.
- Share the invite link or code with one to seven other pilots.
- The host launches after at least two players are connected.
- Move with **WASD** or arrow keys. On phones, use the movement pad.
- Aim with the mouse and fire with **Space** or left click. The on-screen Fire button targets the nearest opponent.
- Dash with **Shift** (three second cooldown), or the on-screen Dash button.
- Health orbs restore hull integrity. The safe ring starts closing after 18 seconds; stay inside it.
- The last survivor wins. The host can start a rematch or return the room to its lobby.

Each room is isolated by a random room code and a separate high entropy player token. The server owns movement, health, attacks, damage, pickups, arena timing, eliminations, and victory. Clients submit movement and aim input only. A disconnected player has 22 seconds to reconnect before being removed from the lobby or eliminated from a match. The host role transfers automatically.

## Deploy to Render

The Render blueprint describes the single Python Web Service. Deploy it from a connected Git repository or with the Render dashboard. The service serves the browser client and WebSocket game on the same origin and listens on Render's PORT.

The service uses in-memory rooms and is configured for one service instance. Free instances may sleep when unused, so the first visit after inactivity can take longer to connect. Room state does not persist across a service restart.
