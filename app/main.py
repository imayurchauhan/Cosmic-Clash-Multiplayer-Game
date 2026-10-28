import asyncio
import json
import math
import os
import random
import re
import secrets
import string
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


ROOT = Path(__file__).resolve().parent.parent
WIDTH = 1000
HEIGHT = 640
ARENA_X = WIDTH / 2
ARENA_Y = HEIGHT / 2
ARENA_RADIUS = 282
MIN_ZONE_RADIUS = 68
START_ZONE_RADIUS = 280
RECONNECT_SECONDS = 22
MAX_PLAYERS = 8
TICK_SECONDS = 0.05
COLORS = ["#45e4ff", "#b78aff", "#ff6b91", "#78f0b2", "#ffcb72", "#7f9cff", "#ff8f59", "#ed80ff"]
OBSTACLES = [
    {"x": 350, "y": 235, "r": 25},
    {"x": 660, "y": 235, "r": 24},
    {"x": 500, "y": 385, "r": 30},
    {"x": 350, "y": 445, "r": 22},
    {"x": 655, "y": 455, "r": 26},
]

app = FastAPI(title="Cosmic Clash", docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=str(ROOT / "static")), name="static")
rooms = {}
game_task = None


class PlayerName(BaseModel):
    displayName: str = Field(min_length=1, max_length=18)


def clean_name(value):
    name = re.sub(r"[^A-Za-z0-9 _.-]", "", value or "").strip()
    return (name or "Pilot")[:18]


def new_token():
    return secrets.token_urlsafe(28)


def new_code():
    alphabet = string.ascii_uppercase + "23456789"
    while True:
        code = "".join(secrets.choice(alphabet) for _ in range(5))
        if code not in rooms:
            return code


def player_by_token(room, token):
    return room["players"].get(token)


def connected_players(room):
    return [p for p in room["players"].values() if p["connected"]]


def living_players(room):
    return [p for p in room["players"].values() if p["alive"]]


def add_feed(room, message, kind="info"):
    room["feed"].insert(0, {"id": secrets.token_hex(4), "message": message, "kind": kind, "at": time.time()})
    room["feed"] = room["feed"][:7]


def create_player(name, color_index, host=False):
    now = time.monotonic()
    token = new_token()
    return token, {
        "id": secrets.token_hex(5),
        "token": token,
        "name": clean_name(name),
        "color": COLORS[color_index % len(COLORS)],
        "host": host,
        "ready": host,
        "x": ARENA_X,
        "y": ARENA_Y,
        "hp": 100,
        "alive": True,
        "kills": 0,
        "damage": 0,
        "attacks": 0,
        "connected": False,
        "socket": None,
        "disconnectedAt": now,
        "move": {"x": 0, "y": 0},
        "lastInputAt": 0,
        "lastAttackAt": 0,
        "lastDashAt": -100,
        "dashUntil": 0,
        "lastHitBy": None,
        "lastHitAt": 0,
        "joinedAt": now,
        "invulnerableUntil": 0,
    }


def make_room(host_name):
    code = new_code()
    token, player = create_player(host_name, 0, True)
    now = time.monotonic()
    room = {
        "code": code,
        "players": {token: player},
        "hostToken": token,
        "phase": "lobby",
        "countdownEnd": 0,
        "startedAt": 0,
        "finishedAt": 0,
        "winnerToken": None,
        "draw": False,
        "projectiles": [],
        "pickups": [],
        "nextPickupAt": now + 7,
        "zone": {"x": ARENA_X, "y": ARENA_Y, "radius": START_ZONE_RADIUS},
        "feed": [],
        "lastTick": now,
        "createdAt": now,
        "round": 0,
    }
    rooms[code] = room
    return room, token


def public_player(player, now):
    return {
        "id": player["id"],
        "name": player["name"],
        "color": player["color"],
        "host": player["host"],
        "ready": player["ready"],
        "x": round(player["x"], 1),
        "y": round(player["y"], 1),
        "hp": max(0, round(player["hp"])),
        "alive": player["alive"],
        "connected": player["connected"],
        "kills": player["kills"],
        "damage": round(player["damage"]),
        "dashReadyIn": max(0, round(3 - (now - player["lastDashAt"]), 1)),
        "attackReadyIn": max(0, round(0.85 - (now - player["lastAttackAt"]), 1)),
    }


def snapshot(room, token=None):
    now = time.monotonic()
    elapsed = max(0, now - room["startedAt"]) if room["startedAt"] else 0
    if elapsed < 18:
        zone_message = "Safe zone active"
    elif room["zone"]["radius"] > MIN_ZONE_RADIUS + 3:
        zone_message = "Zone contracting"
    else:
        zone_message = "Final zone"
    return {
        "type": "state",
        "code": room["code"],
        "phase": room["phase"],
        "you": player_by_token(room, token)["id"] if player_by_token(room, token) else None,
        "hostId": player_by_token(room, room["hostToken"])["id"] if player_by_token(room, room["hostToken"]) else None,
        "countdown": max(0, round(room["countdownEnd"] - now, 1)),
        "elapsed": round(elapsed, 1),
        "players": [public_player(p, now) for p in room["players"].values()],
        "zone": dict(room["zone"]),
        "obstacles": OBSTACLES,
        "projectiles": [
            {"x": round(b["x"], 1), "y": round(b["y"], 1), "color": b["color"], "id": b["id"]}
            for b in room["projectiles"]
        ],
        "pickups": [{"x": round(o["x"], 1), "y": round(o["y"], 1), "id": o["id"]} for o in room["pickups"]],
        "feed": room["feed"][:7],
        "remaining": len([p for p in room["players"].values() if p["alive"]]),
        "zoneMessage": zone_message,
        "winnerId": player_by_token(room, room["winnerToken"])["id"] if player_by_token(room, room["winnerToken"]) else None,
        "draw": room["draw"],
        "rankings": sorted(
            [public_player(p, now) for p in room["players"].values()],
            key=lambda p: (p["alive"], p["hp"], p["kills"], p["damage"]),
            reverse=True,
        ),
    }


async def send_json(socket, payload):
    try:
        await socket.send_json(payload)
        return True
    except Exception:
        return False


async def broadcast(room):
    recipients = [(p["socket"], token) for token, p in room["players"].items() if p["connected"] and p["socket"]]
    if not recipients:
        return
    await asyncio.gather(
        *(send_json(socket, snapshot(room, token)) for socket, token in recipients),
        return_exceptions=True,
    )


def distance(ax, ay, bx, by):
    return math.hypot(ax - bx, ay - by)


def clear_position(x, y, radius=15):
    if distance(x, y, ARENA_X, ARENA_Y) > ARENA_RADIUS - radius:
        return False
    for obstacle in OBSTACLES:
        if distance(x, y, obstacle["x"], obstacle["y"]) < obstacle["r"] + radius:
            return False
    return True


def find_spawn(occupied):
    for _ in range(120):
        angle = random.random() * math.tau
        radial = random.uniform(145, 222)
        x = ARENA_X + math.cos(angle) * radial
        y = ARENA_Y + math.sin(angle) * radial
        if clear_position(x, y) and all(distance(x, y, ox, oy) >= 40 for ox, oy in occupied):
            return x, y
    return ARENA_X, ARENA_Y


def start_countdown(room):
    now = time.monotonic()
    connected = connected_players(room)
    if len(connected) < 2:
        return False
    room["round"] += 1
    room["phase"] = "countdown"
    room["countdownEnd"] = now + 3.4
    room["startedAt"] = room["countdownEnd"]
    room["finishedAt"] = 0
    room["winnerToken"] = None
    room["draw"] = False
    room["projectiles"] = []
    room["pickups"] = []
    room["zone"] = {"x": ARENA_X, "y": ARENA_Y, "radius": START_ZONE_RADIUS}
    room["nextPickupAt"] = now + 11
    room["feed"] = []
    occupied = []
    for player in connected:
        x, y = find_spawn(occupied)
        occupied.append((x, y))
        player.update({
            "x": x,
            "y": y,
            "hp": 100,
            "alive": True,
            "kills": 0,
            "damage": 0,
            "attacks": 0,
            "move": {"x": 0, "y": 0},
            "lastAttackAt": 0,
            "lastDashAt": -100,
            "dashUntil": 0,
            "lastHitBy": None,
            "lastHitAt": 0,
            "invulnerableUntil": room["countdownEnd"] + 1.1,
            "ready": False,
        })
    add_feed(room, "Match starts in 3…", "round")
    return True


def eliminate(room, token, reason="eliminated"):
    player = player_by_token(room, token)
    if not player or not player["alive"]:
        return
    player["alive"] = False
    player["hp"] = 0
    player["move"] = {"x": 0, "y": 0}
    killer = player_by_token(room, player["lastHitBy"]) if player["lastHitBy"] else None
    if killer and killer["token"] != token and time.monotonic() - player["lastHitAt"] < 10:
        killer["kills"] += 1
        add_feed(room, killer["name"] + " eliminated " + player["name"], "elimination")
    else:
        add_feed(room, player["name"] + " " + reason, "elimination")


def finish_match(room, winner_token=None, draw=False):
    room["phase"] = "results"
    room["finishedAt"] = time.monotonic()
    room["winnerToken"] = winner_token
    room["draw"] = draw
    if draw:
        add_feed(room, "The arena claims everyone. Draw!", "round")
    else:
        winner = player_by_token(room, winner_token)
        if winner:
            add_feed(room, winner["name"] + " is the last pilot standing!", "round")


def damage_player(room, target, amount, attacker_token=None, reason=None):
    now = time.monotonic()
    if not target["alive"] or now < target["invulnerableUntil"]:
        return
    target["hp"] -= amount
    target["damage"] += amount
    if attacker_token and attacker_token != target["token"]:
        target["lastHitBy"] = attacker_token
        target["lastHitAt"] = now
    if target["hp"] <= 0:
        target["hp"] = 0
        eliminate(room, target["token"], reason or "was lost to the void")


def tick_room(room, dt, now):
    if room["phase"] == "lobby":
        for token, player in list(room["players"].items()):
            if not player["connected"] and now - player["disconnectedAt"] > RECONNECT_SECONDS:
                del room["players"][token]
                if room["hostToken"] == token and room["players"]:
                    next_host = next(iter(room["players"].values()))
                    room["hostToken"] = next_host["token"]
                    next_host["host"] = True
        if room["players"] and room["hostToken"] not in room["players"]:
            next_host = next(iter(room["players"].values()))
            room["hostToken"] = next_host["token"]
            next_host["host"] = True
        return

    for token, player in list(room["players"].items()):
        if not player["connected"] and now - player["disconnectedAt"] > RECONNECT_SECONDS:
            if room["phase"] == "active":
                eliminate(room, token, "drifted off the comms grid")
            else:
                del room["players"][token]
                if room["hostToken"] == token and room["players"]:
                    next_host = next(iter(room["players"].values()))
                    room["hostToken"] = next_host["token"]
                    next_host["host"] = True

    if room["phase"] == "countdown":
        if len(connected_players(room)) < 2:
            room["phase"] = "lobby"
            add_feed(room, "Countdown paused. Two pilots are needed.", "round")
        elif now >= room["countdownEnd"]:
            room["phase"] = "active"
            room["startedAt"] = now
            add_feed(room, "Arena live. Last pilot standing wins!", "round")
        return

    if room["phase"] != "active":
        return

    elapsed = now - room["startedAt"]
    contraction = max(0, elapsed - 18)
    room["zone"]["radius"] = max(MIN_ZONE_RADIUS, START_ZONE_RADIUS - contraction * 1.72)

    for player in room["players"].values():
        if not player["alive"] or not player["connected"]:
            continue
        move = player["move"]
        length = math.hypot(move["x"], move["y"])
        if length > 0:
            speed = 222
            if now < player["dashUntil"]:
                speed = 600
            dx = move["x"] / length * speed * dt
            dy = move["y"] / length * speed * dt
            nx = player["x"] + dx
            ny = player["y"] + dy
            if clear_position(nx, player["y"]):
                player["x"] = nx
            if clear_position(player["x"], ny):
                player["y"] = ny
        if distance(player["x"], player["y"], room["zone"]["x"], room["zone"]["y"]) > room["zone"]["radius"] - 8:
            damage_player(room, player, 11 * dt, reason="was swallowed by the shrinking zone")

    if len(room["pickups"]) < 5 and now >= room["nextPickupAt"]:
        for _ in range(30):
            angle = random.random() * math.tau
            radius = random.uniform(30, max(32, room["zone"]["radius"] - 22))
            x = room["zone"]["x"] + math.cos(angle) * radius
            y = room["zone"]["y"] + math.sin(angle) * radius
            if clear_position(x, y, 14):
                room["pickups"].append({"id": secrets.token_hex(4), "x": x, "y": y})
                break
        room["nextPickupAt"] = now + 12

    for pickup in list(room["pickups"]):
        collector = next(
            (p for p in room["players"].values() if p["alive"] and p["connected"] and distance(p["x"], p["y"], pickup["x"], pickup["y"]) < 24),
            None,
        )
        if collector:
            old_health = collector["hp"]
            collector["hp"] = min(100, collector["hp"] + 28)
            if collector["hp"] > old_health:
                add_feed(room, collector["name"] + " collected a health orb", "pickup")
            room["pickups"].remove(pickup)

    active_projectiles = []
    for projectile in room["projectiles"]:
        projectile["x"] += projectile["vx"] * dt
        projectile["y"] += projectile["vy"] * dt
        projectile["ttl"] -= dt
        hit = False
        for target in room["players"].values():
            if target["alive"] and target["token"] != projectile["owner"] and now >= target["invulnerableUntil"]:
                if distance(projectile["x"], projectile["y"], target["x"], target["y"]) < 19:
                    damage_player(room, target, 20, projectile["owner"], "was lost to the void")
                    add_feed(room, target["name"] + " took 20 damage", "hit")
                    hit = True
                    break
        blocked = any(
            distance(projectile["x"], projectile["y"], obstacle["x"], obstacle["y"]) < obstacle["r"]
            for obstacle in OBSTACLES
        )
        if not hit and not blocked and projectile["ttl"] > 0:
            if distance(projectile["x"], projectile["y"], ARENA_X, ARENA_Y) < ARENA_RADIUS:
                active_projectiles.append(projectile)
    room["projectiles"] = active_projectiles

    alive = living_players(room)
    if len(alive) <= 1 and elapsed >= 2:
        finish_match(room, alive[0]["token"] if alive else None, not alive)
    elif elapsed >= 190:
        if not alive:
            finish_match(room, None, True)
        else:
            champion = max(alive, key=lambda p: (p["hp"], p["kills"], p["damage"]))
            finish_match(room, champion["token"], False)


async def game_loop():
    while True:
        now = time.monotonic()
        for code, room in list(rooms.items()):
            dt = min(0.1, max(0.01, now - room["lastTick"]))
            room["lastTick"] = now
            tick_room(room, dt, now)
            if room["phase"] == "lobby" and not room["players"]:
                del rooms[code]
                continue
            if room["phase"] != "lobby" and not connected_players(room) and now - room["createdAt"] > RECONNECT_SECONDS:
                del rooms[code]
                continue
            await broadcast(room)
        await asyncio.sleep(TICK_SECONDS)


@app.on_event("startup")
async def startup():
    global game_task
    game_task = asyncio.create_task(game_loop())


@app.on_event("shutdown")
async def shutdown():
    global game_task
    if game_task:
        game_task.cancel()
        try:
            await game_task
        except asyncio.CancelledError:
            pass


@app.get("/")
async def home():
    return FileResponse(str(ROOT / "static" / "index.html"))


@app.get("/healthz")
async def health():
    return {"status": "ok", "rooms": len(rooms)}


@app.post("/api/rooms")
async def create_room(body: PlayerName, request: Request):
    room, token = make_room(body.displayName)
    base = str(request.base_url).rstrip("/")
    return {"code": room["code"], "token": token, "invite": base + "/?room=" + room["code"]}


@app.post("/api/rooms/{code}/join")
async def join_room(code: str, body: PlayerName):
    code = code.upper()
    room = rooms.get(code)
    if not room:
        raise HTTPException(status_code=404, detail="That room code was not found.")
    if room["phase"] != "lobby":
        raise HTTPException(status_code=409, detail="That match has already started.")
    if len(room["players"]) >= MAX_PLAYERS:
        raise HTTPException(status_code=409, detail="This room is full (8 pilots max).")
    token, player = create_player(body.displayName, len(room["players"]))
    room["players"][token] = player
    add_feed(room, player["name"] + " joined the lobby", "join")
    return {"code": code, "token": token, "host": False}


@app.websocket("/ws/{code}")
async def websocket_room(socket: WebSocket, code: str):
    code = code.upper()
    await socket.accept()
    token = None
    player = None
    room = rooms.get(code)
    try:
        if not room:
            await socket.close(code=4404, reason="Room not found")
            return
        raw = await asyncio.wait_for(socket.receive_text(), timeout=7)
        auth = json.loads(raw)
        token = auth.get("token")
        player = player_by_token(room, token)
        if not player or not secrets.compare_digest(player["token"], str(token)):
            await socket.close(code=4401, reason="Invalid room pass")
            return
        if player["socket"] and player["socket"] is not socket:
            try:
                await player["socket"].close(code=4001, reason="Reconnected in another tab")
            except Exception:
                pass
        player["socket"] = socket
        player["connected"] = True
        player["disconnectedAt"] = 0
        add_feed(room, player["name"] + " connected", "join")
        await socket.send_json(snapshot(room, token))
        await broadcast(room)
        while True:
            try:
                data = await asyncio.wait_for(socket.receive_json(), timeout=18)
            except asyncio.TimeoutError:
                await socket.send_json({"type": "ping"})
                continue
            kind = data.get("type")
            now = time.monotonic()
            if kind == "input":
                if room["phase"] != "active" or not player["alive"] or now - player["lastInputAt"] < 0.018:
                    continue
                keys = data.get("keys", {})
                mx = float(bool(keys.get("right"))) - float(bool(keys.get("left")))
                my = float(bool(keys.get("down"))) - float(bool(keys.get("up")))
                length = math.hypot(mx, my)
                if length > 0:
                    mx, my = mx / length, my / length
                player["move"] = {"x": mx, "y": my}
                player["lastInputAt"] = now
            elif kind == "ready" and room["phase"] == "lobby":
                player["ready"] = bool(data.get("ready"))
                await broadcast(room)
            elif kind == "start" and room["phase"] == "lobby":
                if token != room["hostToken"]:
                    await socket.send_json({"type": "error", "message": "Only the host can start the match."})
                elif len(connected_players(room)) < 2:
                    await socket.send_json({"type": "error", "message": "Invite at least one more pilot first."})
                elif start_countdown(room):
                    await broadcast(room)
            elif kind == "rematch" and room["phase"] == "results":
                if token != room["hostToken"]:
                    await socket.send_json({"type": "error", "message": "Only the host can start a rematch."})
                elif not start_countdown(room):
                    await socket.send_json({"type": "error", "message": "At least two pilots must be connected to play again."})
                else:
                    await broadcast(room)
            elif kind == "return_lobby" and room["phase"] == "results":
                if token != room["hostToken"]:
                    await socket.send_json({"type": "error", "message": "Only the host can return the crew to the lobby."})
                else:
                    room["phase"] = "lobby"
                    room["projectiles"] = []
                    room["pickups"] = []
                    room["winnerToken"] = None
                    room["draw"] = False
                    room["feed"] = []
                    for pilot in room["players"].values():
                        pilot["ready"] = pilot["token"] == room["hostToken"]
                        pilot["alive"] = True
                    add_feed(room, "Crew returned to the lobby", "round")
                    await broadcast(room)
            elif kind == "attack" and room["phase"] == "active" and player["alive"]:
                if now - player["lastAttackAt"] < 0.85:
                    continue
                target = data.get("target", {})
                try:
                    tx = float(target.get("x"))
                    ty = float(target.get("y"))
                except (TypeError, ValueError):
                    continue
                if not math.isfinite(tx) or not math.isfinite(ty) or not (0 <= tx <= WIDTH and 0 <= ty <= HEIGHT):
                    continue
                dx, dy = tx - player["x"], ty - player["y"]
                length = math.hypot(dx, dy)
                if length < 1:
                    continue
                player["lastAttackAt"] = now
                player["attacks"] += 1
                room["projectiles"].append({
                    "id": secrets.token_hex(4),
                    "owner": token,
                    "x": player["x"] + dx / length * 18,
                    "y": player["y"] + dy / length * 18,
                    "vx": dx / length * 520,
                    "vy": dy / length * 520,
                    "ttl": 0.9,
                    "color": player["color"],
                })
            elif kind == "dash" and room["phase"] == "active" and player["alive"]:
                if now - player["lastDashAt"] >= 3:
                    player["lastDashAt"] = now
                    player["dashUntil"] = now + 0.16
            elif kind == "leave":
                if player and token in room["players"]:
                    del room["players"][token]
                    if room["hostToken"] == token and room["players"]:
                        next_host = next(iter(room["players"].values()))
                        room["hostToken"] = next_host["token"]
                        next_host["host"] = True
                    if not room["players"]:
                        rooms.pop(code, None)
                    else:
                        add_feed(room, player["name"] + " left the room", "join")
                        await broadcast(room)
                await socket.close(code=1000, reason="Left room")
                return
    except (WebSocketDisconnect, asyncio.TimeoutError, ValueError, json.JSONDecodeError):
        pass
    except Exception:
        pass
    finally:
        if player and player.get("socket") is socket:
            player["socket"] = None
            player["connected"] = False
            player["disconnectedAt"] = time.monotonic()
            player["move"] = {"x": 0, "y": 0}
            if room and token == room["hostToken"]:
                replacement = next((p for p in room["players"].values() if p["connected"] and p["token"] != token), None)
                if replacement:
                    player["host"] = False
                    room["hostToken"] = replacement["token"]
                    replacement["host"] = True
                    add_feed(room, replacement["name"] + " is now the host", "join")
            if room:
                add_feed(room, player["name"] + " disconnected (22 sec reconnect window)", "join")
                await broadcast(room)
