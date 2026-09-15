# Hermes Bridge

REST API bridge between external automation tools (e.g. [Hermes Agent](https://github.com/themockster/hermes-bridge)) and **Foundry VTT v14**, designed for Pathfinder 2e session prep — scenes, NPCs, tokens, journals, compendiums, and more.

Foundry v14 does not expose Express to modules. This project uses a **WebSocket relay**: the Foundry module runs in the GM browser tab and executes API calls against the live game world.

```
┌─────────────┐   REST :9998    ┌──────────────┐   WebSocket :9997   ┌─────────────────────┐
│ curl/Hermes │ ──────────────► │  relay.py    │ ◄────────────────── │ hermes-bridge module │
│  any client │ ◄────────────── │  (Oracle)    │ ──────────────────► │ (GM browser tab)     │
└─────────────┘                 └──────────────┘                     └─────────────────────┘
                                                                              │
                                                                              ▼
                                                                    Foundry VTT v14 world
```

**Current version:** `1.5.0`

## What the relay does

`relay.py` is a small **Python server** that sits between your automation tools and Foundry. It solves a fundamental constraint: **Foundry modules cannot expose an HTTP API** on the game server (Express is private in v14), and the bridge module only runs inside the **GM's browser tab**.

The relay has two jobs:

### 1. Protocol translator (REST ↔ WebSocket)

| Side | Who connects | Protocol |
|------|--------------|----------|
| **Clients** (curl, Hermes, scripts) | Call the relay | HTTP REST on port `9998` |
| **Foundry module** | GM browser tab connects outbound | WebSocket on port `9997` |

When a client sends `POST /scene`, the relay:

1. Checks the `x-hermes-key` header
2. Verifies a Foundry WebSocket is connected (GM tab open)
3. Forwards the request as a JSON message over WebSocket: `{ "type": "request", "action": "create_scene", "data": { ... } }`
4. Waits for the module's response (up to 30 seconds)
5. Returns the result as HTTP JSON to the client

The Foundry module is the only component that can call `Scene.create()`, `Actor.create()`, compendium imports, etc. — because it runs with full access to the live `game` object. The relay never touches Foundry directly; it only **relays messages**.

```
curl POST /actor  →  relay  →  WS request  →  hermes-api.mjs  →  Actor.create()
                     ↑                                              │
                     └──────── WS response ←────────────────────────┘
```

If no GM tab is connected, the relay immediately returns `503 Foundry not connected` — it does not queue requests.

### 2. File upload handler (optional SSH path)

`POST /upload` is handled partly on the relay itself. Browser-based file upload via Foundry's `FilePicker` can hang on some setups, so the relay can write files **directly to Foundry's `Data/uploads/`** via SSH (Proxmox → LXC container), without going through the browser.

| Mode | What happens |
|------|----------------|
| `ssh` | Relay decodes base64 and writes the file on the Foundry host (~2s) |
| `foundry` | Relay forwards to the browser module (Foundry `FilePicker`) |
| `auto` | Try Foundry first; fallback to SSH after 15s timeout |

The relay can also read a local file on its own disk (`"path": "/tmp/map.png"`) and upload it — useful when the client and relay are on the same machine.

### What the relay does NOT do

- It does **not** run inside Foundry or modify game data by itself
- It does **not** stay connected if the GM closes the browser tab
- It does **not** support multiple simultaneous Foundry connections (one GM tab at a time)
- It does **not** replace Foundry's login — the GM must already be logged in

### Relay endpoints handled locally (not forwarded to Foundry)

| Endpoint | Handled by |
|----------|------------|
| `GET /status` | Relay only (no auth) — connection health |
| `POST /upload` | Relay (SSH) or forwarded to Foundry depending on mode |

Everything else is forwarded to the Foundry module via WebSocket.

## Table of contents

- [What the relay does](#what-the-relay-does)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Authentication](#authentication)
- [Quick start](#quick-start)
- [API reference](#api-reference)
- [Detailed endpoint guide](#detailed-endpoint-guide)
- [Session prep workflow](#session-prep-workflow)
- [File uploads](#file-uploads)
- [Environment variables](#environment-variables)
- [systemd service](#systemd-service)
- [Architecture notes](#architecture-notes)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Changelog](#changelog)
- [License](#license)

## Features

| Area | Capabilities |
|------|--------------|
| **Scenes** | CRUD, activate, duplicate, background images (v14 Level docs) |
| **Scene embeds** | Walls, ambient lights, tiles |
| **Actors** | CRUD, PF2e stat blocks, items, active effects |
| **Tokens** | Place, move, update (rotation, vision, light, HP bars) |
| **Folders** | List, create, update, delete; auto-create by name on scene/actor |
| **Uploads** | Push files to `Data/uploads/` via relay SSH |
| **Compendiums** | Search, preview entry, import any document type |
| **Journals** | CRUD with HTML content pages |
| **Roll tables** | CRUD with results |
| **Playlists** | CRUD with embedded sounds |
| **Batch** | `POST /encounter` — scene + creatures + tokens in one call |

Full endpoint list: [docs/API.md](docs/API.md)

## Requirements

- **Foundry VTT** v13+ (verified on v14)
- **PF2e system** (optional but recommended for actor defaults)
- **Python 3.10+** with `aiohttp` (relay server)
- A **GM browser tab** with the world loaded (module is client-side)
- Network access from clients to the relay HTTP port

## Installation

### 1. Relay server

```bash
git clone https://github.com/themockster/hermes-bridge.git
cd hermes-bridge
pip install -r requirements.txt
HERMES_KEY=your-secret-key python relay.py
```

Default ports:

| Port | Purpose |
|------|---------|
| `9997` | WebSocket — Foundry module connects here |
| `9998` | REST API — clients call here |

### 2. Foundry module

**Option A — Manifest URL** (Foundry UI → Install Module):

```
https://raw.githubusercontent.com/themockster/hermes-bridge/main/module.json
```

**Option B — Manual copy:**

```bash
cp -r hermes-bridge /path/to/Foundry/Data/modules/hermes-bridge/
```

### 3. Enable in your world

1. **Game Settings → Manage Modules** → enable **Hermes Bridge**
2. Reload the world (F5)
3. Open as **Gamemaster**
4. Notification: *"Hermes Bridge: Connected to Hermes relay"*

### Module settings (world scope)

| Setting | Default | Description |
|---------|---------|-------------|
| Relay WebSocket URL | `ws://<relay-host>:9997/ws` | Relay WebSocket endpoint |
| Shared API Key | `hermes-foundry-bridge-key-2026` | Must match relay `HERMES_KEY` |
| Bridge Enabled | `true` | Toggle connection |

## Authentication

All REST endpoints except `GET /status` require:

```
x-hermes-key: <your-shared-key>
```

Responses on auth failure: `401 Unauthorized`.

If the GM tab is not connected: `503` with `{"ok":false,"error":"Foundry not connected"}`.

All routes also work under the `/api/hermes/` prefix (e.g. `/api/hermes/scenes`).

## Quick start

```bash
KEY="hermes-foundry-bridge-key-2026"
RELAY="http://<relay-host>:9998"
AUTH=(-H "x-hermes-key: $KEY")

# Relay + Foundry status
curl -s "$RELAY/status" | jq
curl -s "$RELAY/ping" "${AUTH[@]}" | jq

# Create session folder
curl -s -X POST "$RELAY/folder" "${AUTH[@]}" \
  -H "Content-Type: application/json" \
  -d '{"name":"S76 - Session","type":"Scene"}' | jq

# Upload a map
B64=$(base64 -i map.png)
curl -s -X POST "$RELAY/upload" "${AUTH[@]}" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"map.png\",\"data\":\"$B64\"}" | jq

# Create scene
curl -s -X POST "$RELAY/scene" "${AUTH[@]}" \
  -H "Content-Type: application/json" \
  -d '{"name":"Throne Room","img":"uploads/map.png","folder":"S76 - Session","width":4000,"height":2800}' | jq

# Import NPC from PF2e compendium
curl -s "$RELAY/compendium/pf2e.kingmaker-bestiary/entries?search=goblin&limit=5" "${AUTH[@]}" | jq
curl -s -X POST "$RELAY/actor/import" "${AUTH[@]}" \
  -H "Content-Type: application/json" \
  -d '{"packId":"pf2e.kingmaker-bestiary","documentId":"DOCUMENT_ID","folder":"S76 - Session"}' | jq

# Full encounter in one call
curl -s -X POST "$RELAY/encounter" "${AUTH[@]}" \
  -H "Content-Type: application/json" \
  -d @encounter.json | jq
```

## API reference

### Meta

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/status` | Relay status (no auth) |
| `GET` | `/ping` | Health check + Foundry version |
| `GET` | `/uuid/:uuid` | Resolve any document by UUID |

### Scenes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/scenes?name=` | List scenes |
| `GET` | `/scene/:id` | Get scene details |
| `POST` | `/scene` | Create scene |
| `PATCH` | `/scene/:id` | Update scene |
| `DELETE` | `/scene/:id` | Delete scene |
| `POST` | `/scene/:id/activate` | Activate for all users |
| `POST` | `/scene/:id/duplicate` | Duplicate scene |
| `GET` | `/scene/:id/tokens` | List tokens |
| `POST` | `/scene/:id/token` | Place token |
| `PATCH` | `/scene/:id/token/:tokenId` | Update token |
| `DELETE` | `/scene/:id/token/:tokenId` | Remove token |
| `GET` | `/scene/:id/walls` | List walls |
| `POST` | `/scene/:id/wall` | Create wall(s) |
| `PATCH` | `/scene/:id/wall/:wallId` | Update wall |
| `DELETE` | `/scene/:id/wall/:wallId` | Delete wall |
| `GET` | `/scene/:id/lights` | List ambient lights |
| `POST` | `/scene/:id/light` | Create light(s) |
| `PATCH` | `/scene/:id/light/:lightId` | Update light |
| `DELETE` | `/scene/:id/light/:lightId` | Delete light |
| `GET` | `/scene/:id/tiles` | List tiles |
| `POST` | `/scene/:id/tile` | Create tile(s) |
| `PATCH` | `/scene/:id/tile/:tileId` | Update tile |
| `DELETE` | `/scene/:id/tile/:tileId` | Delete tile |

### Actors

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/actors?name=&type=` | List actors |
| `GET` | `/actor/:id` | Get actor with stats + items |
| `POST` | `/actor` | Create NPC |
| `POST` | `/actor/import` | Import actor from compendium |
| `PATCH` | `/actor/:id` | Update actor |
| `DELETE` | `/actor/:id` | Delete actor |
| `GET` | `/actor/:id/items` | List items |
| `POST` | `/actor/:id/item` | Add item(s) |
| `PATCH` | `/actor/:id/item/:itemId` | Update item |
| `DELETE` | `/actor/:id/item/:itemId` | Delete item |
| `GET` | `/actor/:id/effects` | List active effects |
| `POST` | `/actor/:id/effect` | Add effect(s) |
| `PATCH` | `/actor/:id/effect/:effectId` | Update effect |
| `DELETE` | `/actor/:id/effect/:effectId` | Delete effect |

### Folders & uploads

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/folders?type=Scene` | List folders |
| `POST` | `/folder` | Create folder |
| `PATCH` | `/folder/:id` | Rename / move folder |
| `DELETE` | `/folder/:id` | Delete folder |
| `POST` | `/upload` | Upload file to `uploads/` |

### Compendiums

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/compendiums?type=Actor` | List packs |
| `GET` | `/compendium/:packId/entries?search=&limit=` | Search entries |
| `GET` | `/compendium/:packId/entry/:documentId?full=1` | Preview entry |
| `POST` | `/compendium/:packId/import` | Import any document type |

### Journals

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/journals?name=` | List journals |
| `GET` | `/journal/:id` | Get journal with pages |
| `POST` | `/journal` | Create journal |
| `PATCH` | `/journal/:id` | Update journal |
| `DELETE` | `/journal/:id` | Delete journal |

### Roll tables & playlists

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/tables?name=` | List roll tables |
| `GET` | `/table/:id` | Get roll table |
| `POST` | `/table` | Create roll table |
| `PATCH` | `/table/:id` | Update roll table |
| `DELETE` | `/table/:id` | Delete roll table |
| `GET` | `/playlists?name=` | List playlists |
| `GET` | `/playlist/:id` | Get playlist |
| `POST` | `/playlist` | Create playlist |
| `PATCH` | `/playlist/:id` | Update playlist |
| `DELETE` | `/playlist/:id` | Delete playlist |
| `POST` | `/playlist/:id/sound` | Add sound(s) |
| `DELETE` | `/playlist/:id/sound/:soundId` | Remove sound |

### Batch

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/encounter` | Create scene + actors + tokens |

## Detailed endpoint guide

### POST /scene

```json
{
  "name": "Ambush at the Ford",
  "img": "uploads/kingmaker/ambush.png",
  "folder": "S76 - Session Name",
  "width": 3060,
  "height": 2040,
  "gridSize": 100,
  "gridType": 0,
  "padding": 0.25,
  "navigation": true
}
```

- `img` — relative to Foundry `Data/`; in **v14** this is written to the Scene **Level** `background.src` (Scene no longer has `background` / `img`). The module also regenerates the scene thumbnail.
- `gridType` — Foundry `CONST.GRID_TYPES` (`1` = square, `0` = gridless)
- `folder` — folder **name or ID**; auto-created if missing

### POST /actor

```json
{
  "name": "Goblin Warrior",
  "type": "npc",
  "img": "uploads/goblin.png",
  "folder": "S76 - Session Name",
  "system": {
    "details": { "level": { "value": 1 } },
    "attributes": { "hp": { "value": 16, "max": 16 }, "ac": { "value": 17 } },
    "skills": { "stealth": { "value": 7 } }
  },
  "items": [
    {
      "name": "Shortsword",
      "type": "melee",
      "system": {
        "bonus": { "value": 8 },
        "damageRolls": { "0": { "damage": "1d6", "damageType": "slashing" } }
      }
    }
  ]
}
```

Shorthand also works: `"level": 1`, `"hp": 16`, `"ac": 17` inside `system`.

PF2e normalizations applied automatically:
- skills `{ value: N }` → also sets `base: N` so PF2e does not overwrite from ability mods
- items created via `Item.create(..., { parent: actor })`; `damageRolls` object→array; melee `bonus`→`attackBonus`
- spell / spellcastingEntry `level: N` → `{ value: N }`
- `type: "affliction"` is auto-converted to `action` with a `warnings[]` entry (not available in PF2e production)

### POST /scene/:id/token

```json
{
  "actorId": "abc123",
  "x": 1500,
  "y": 1000,
  "width": 1,
  "height": 1,
  "elevation": 0,
  "hidden": false,
  "disposition": -1,
  "rotation": 45,
  "scale": 1.5,
  "displayBars": 50,
  "bar1": { "attribute": "attributes.hp" },
  "light": { "bright": 10, "dim": 20, "color": "#ff9900" },
  "sight": { "enabled": true, "range": 60 }
}
```

### POST /folder

```json
{ "name": "S76 - Le Palais de Rhoswen", "type": "Scene", "parent": null }
```

Types: `Scene`, `Actor`, `Item`, `JournalEntry`, `RollTable`, `Playlist`, etc.

Response: `{"ok":true,"id":"...","name":"...","type":"Scene","existed":false}`

### POST /upload

```json
{ "name": "rhoswen-token.png", "data": "<base64>" }
```

Or from a file on the relay host:

```json
{ "path": "/tmp/token.png", "name": "token.png" }
```

Response: `{"ok":true,"url":"uploads/rhoswen-token.png","method":"ssh"}`

### GET /compendium/:packId/entry/:documentId

Returns preview for actors: `level`, `hp`, `ac`, `itemCount`. Add `?full=1` for complete document data.

### POST /compendium/:packId/import

```json
{ "documentId": "abc123", "name": "Custom Name", "folder": "S76 - Session" }
```

Works for any compendium document type (Actor, Item, JournalEntry, etc.).

### POST /journal

```json
{
  "name": "S76 - Notes MJ",
  "folder": "S76 - Session",
  "content": "<h2>Tactiques</h2><p>Les gobelins attaquent par...</p>"
}
```

### POST /encounter

```json
{
  "scene": {
    "name": "Goblin Camp",
    "img": "uploads/camp.png",
    "folder": "S75 - Session",
    "width": 4000,
    "height": 2800
  },
  "activate": true,
  "creatures": [
    {
      "fromCompendium": {
        "packId": "pf2e.kingmaker-bestiary",
        "documentId": "DOCUMENT_ID"
      },
      "name": "Goblin Warrior",
      "folder": "S75 - Session",
      "token": { "x": 1500, "y": 1000, "hidden": false }
    },
    {
      "name": "Custom Troll",
      "type": "npc",
      "img": "uploads/troll.png",
      "system": { "details": { "level": { "value": 5 } } },
      "token": { "x": 2000, "y": 1200 }
    }
  ]
}
```

### PF2e compendium packs (Kingmaker)

| Pack ID | Contents |
|---------|----------|
| `pf2e.kingmaker-bestiary` | Kingmaker creatures |
| `pf2e.pathfinder-monster-core` | Remaster core monsters |
| `pf2e.pathfinder-bestiary` | Bestiary 1 |
| `pf2e.pathfinder-bestiary-2` | Bestiary 2 |
| `pf2e.pathfinder-bestiary-3` | Bestiary 3 |

## Session prep workflow

```
1. GET  /status              → verify relay + Foundry connected
2. POST /folder              → create session folder (optional)
3. POST /upload              → push maps and token images
4. POST /journal             → push session notes
5. GET  /compendium/.../entry/:id → preview creatures
6. POST /encounter           → batch create scene + NPCs + tokens
   OR individual POST /scene, /actor/import, /scene/:id/token
7. POST /scene/:id/light     → add lighting (optional)
8. POST /scene/:id/activate  → switch active scene
```

## File uploads

The relay supports three upload modes via `HERMES_UPLOAD_MODE`:

| Mode | Behavior |
|------|----------|
| `ssh` | Write directly to Foundry `Data/uploads/` via SSH (fast, ~2s) |
| `foundry` | Use Foundry `FilePicker` API in browser (may hang on some setups) |
| `auto` | Try Foundry first, fallback to SSH after 15s timeout |

SSH upload requires relay access to the Foundry host. See [Environment variables](#environment-variables).

## Environment variables

### Relay core

| Variable | Default | Description |
|----------|---------|-------------|
| `HERMES_KEY` | `hermes-foundry-bridge-key-2026` | Shared auth key |
| `HERMES_WS_PORT` | `9997` | WebSocket port |
| `HERMES_HTTP_PORT` | `9998` | REST port |
| `HERMES_BIND` | `0.0.0.0` | Bind address |
| `HERMES_REQUEST_TIMEOUT` | `30` | Seconds to wait for Foundry response |

### Upload (SSH mode)

| Variable | Default | Description |
|----------|---------|-------------|
| `HERMES_UPLOAD_MODE` | `auto` | `ssh`, `foundry`, or `auto` |
| `HERMES_FOUNDRY_SSH` | `root@<foundry-host>` | SSH target (Proxmox / Foundry host) |
| `HERMES_FOUNDRY_CT` | `200` | LXC container ID |
| `HERMES_FOUNDRY_UPLOADS` | `/mnt/data/foundry/Data/uploads` | Upload path on Foundry |
| `HERMES_FOUNDRY_SSH_PASS` | _(empty)_ | SSH password for `sshpass` |
| `HERMES_FOUNDRY_UPLOAD_OWNER` | `1000:1000` | `chown` after upload |

Example systemd drop-in for SSH uploads:

```ini
# /etc/systemd/system/hermes-relay.service.d/upload.conf
[Service]
Environment=HERMES_UPLOAD_MODE=ssh
Environment=HERMES_FOUNDRY_SSH_PASS=your-proxmox-password
```

## systemd service

```ini
[Unit]
Description=Hermes Foundry Bridge Relay
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/hermes-bridge
Environment=HERMES_KEY=hermes-foundry-bridge-key-2026
ExecStart=/usr/bin/python3 relay.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now hermes-relay
journalctl -u hermes-relay -f
```

## Architecture notes

See [What the relay does](README.md#what-the-relay-does) for the full relay explanation. Summary:

- **`relay.py`** — Python server; translates REST → WebSocket; handles SSH uploads
- **`hermes-api.mjs`** — Foundry module in the GM browser; executes game API calls
- Only **one GM WebSocket** connection is held by the relay at a time
- Foundry v14 stores scene backgrounds on **Level** embedded documents (`background.src`) — do **not** set `Scene.background` / `Scene.img` (ignored). The module also regenerates `thumb`.
- Scene `img` paths must be relative to Foundry `Data/` (e.g. `uploads/map.png`)
- `folder` fields accept **name or 16-char ID** — folders are auto-created when referenced by name

### Why other approaches fail

| Approach | Problem |
|----------|---------|
| Express monkey-patch | Foundry v14 keeps Express private |
| `import { Hooks } from 'foundryvtt'` | Invalid — use global `Hooks` |
| Direct JSON file writes | Foundry v14 uses LevelDB |
| `console.log` in ES modules | Does not appear in `debug.log` |

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `503 Foundry not connected` | GM tab closed or module not loaded | Open world as GM, F5 reload |
| `401 Unauthorized` | Wrong API key | Check `x-hermes-key` header |
| `Unknown action: ...` | Old module in browser memory | F5 reload Foundry |
| Scene image blank | Wrong path or file missing | Use `uploads/...`, verify with `POST /upload` |
| Upload timeout | Browser FilePicker hangs | Set `HERMES_UPLOAD_MODE=ssh` on relay |
| Module won't connect | Relay down or wrong WS URL | Check `GET /status`, module settings |

```bash
# Diagnostics
curl -s http://RELAY_HOST:9998/status | jq
curl -s http://RELAY_HOST:9998/ping -H "x-hermes-key: KEY" | jq
```

## Development

### Project structure

```
hermes-bridge/
├── module.json           # Foundry manifest
├── scripts/
│   └── hermes-api.mjs    # Client module (WebSocket + handlers)
├── relay.py              # REST ↔ WebSocket bridge
├── requirements.txt
├── README.md
└── docs/
    └── API.md            # Full API reference
```

### Local relay

```bash
pip install -r requirements.txt
HERMES_KEY=test-key python relay.py
```

### Deploy

```bash
# Relay
scp relay.py root@RELAY_HOST:/opt/hermes-bridge/
ssh root@RELAY_HOST systemctl restart hermes-relay

# Module
tar czf - module.json scripts | ssh root@FOUNDRY_HOST \
  'tar xzf - -C /path/to/Foundry/Data/modules/hermes-bridge/'
# Then F5 in Foundry GM tab
```

## Changelog

### v1.3.0
- `DELETE/PATCH /folder`
- Journals CRUD
- Compendium preview + generic import
- Scene duplicate, walls, lights, tiles
- Advanced token properties
- Roll tables, playlists, active effects

### v1.2.0
- `POST /folder`, `POST /upload`
- Auto-create folders by name on scene/actor
- SSH upload fallback

### v1.1.0
- Full CRUD for scenes, actors, tokens, items
- Compendium search, actor import
- `POST /encounter` batch

### v1.0.0
- Initial bridge: ping, scenes, actors, tokens

## License

MIT
