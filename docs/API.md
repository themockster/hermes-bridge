# Hermes Bridge API Reference

**Version:** 1.5.0

Base URL: `http://<relay-host>:9998`

## About the relay

This API is served by **`relay.py`**, a Python process that does not talk to Foundry's database directly. It exposes HTTP endpoints and forwards almost every request to the **hermes-bridge Foundry module** over a persistent WebSocket connection from the GM's browser tab.

```
Client  ──HTTP──►  relay.py  ──WebSocket──►  hermes-api.mjs (GM browser)  ──►  game.world
```

- The relay **authenticates** clients via `x-hermes-key`
- The relay **waits** for the module to execute the action and return a result (30s timeout)
- The relay returns **503** if no GM browser tab is connected
- **`POST /upload`** may be handled by the relay itself (SSH write to `Data/uploads/`) instead of forwarding to Foundry

Full relay documentation: [README — What the relay does](../README.md#what-the-relay-does)

---

All endpoints except `GET /status` require header:

```
x-hermes-key: <HERMES_KEY>
```

Alternative prefix: `/api/hermes/` (e.g. `/api/hermes/scenes`).

## Response format

### Success

Most endpoints return JSON with `"ok": true` plus relevant fields.

List endpoints wrap arrays:

```json
{ "ok": true, "scenes": [ ... ] }
```

### Error

```json
{ "ok": false, "error": "Human-readable message" }
```

| HTTP status | Meaning |
|-------------|---------|
| `200` | Success |
| `400` | Bad request / validation error |
| `401` | Missing or wrong `x-hermes-key` |
| `404` | Local file not found (upload `path`) |
| `502` | Foundry handler error |
| `503` | Foundry not connected (GM tab closed) |
| `504` | Foundry request timed out (30s default) |

---

## Meta

### GET /status

No authentication required.

**Response:**

```json
{
  "relay": true,
  "version": "1.3.0",
  "foundry_connected": true,
  "foundry": {
    "world": "kingmaker",
    "foundry": "14.364",
    "user": "Gamemaster"
  },
  "pending_requests": 0
}
```

### GET /ping

**Response:**

```json
{
  "ok": true,
  "foundry": "14.364",
  "world": "kingmaker",
  "system": "pf2e",
  "user": "Gamemaster"
}
```

### GET /uuid/:uuid

Resolve any Foundry document by UUID.

**Example:** `GET /uuid/Actor.abc123def456`

**Response:**

```json
{
  "ok": true,
  "uuid": "Actor.abc123def456",
  "id": "abc123def456",
  "name": "Goblin Warrior",
  "documentName": "Actor"
}
```

---

## Scenes

### GET /scenes

**Query parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `name` | string | Filter by name (substring, case-insensitive) |

**Response:** `{ "ok": true, "scenes": [ { "id", "uuid", "name", "img", "width", "height", "active", "navigation", "folder", "tokenCount" } ] }`

### GET /scene/:id

**Response:** `{ "ok": true, "scene": { ...detailed fields including grid, padding, folderId } }`

### POST /scene

**Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | yes | Scene name |
| `img` | string | no | Background image path (`uploads/...`). **v14:** written to Level `background.src` (Scene no longer has `background`/`img`); thumbnail is regenerated |
| `folder` | string | no | Folder name or ID (auto-created) |
| `width` | number | no | Default `4000` |
| `height` | number | no | Default `2800` |
| `gridSize` | number | no | Default `100` |
| `gridType` | number | no | Foundry `CONST.GRID_TYPES` (`1` = square, `0` = gridless) |
| `padding` | number | no | Default `0.25` |
| `navigation` | boolean | no | Default `true` |

### PATCH /scene/:id

Same fields as POST (partial update). `img` updates the initial Level `background.src` and refreshes `thumb`.

### DELETE /scene/:id

**Response:** `{ "ok": true, "id": "...", "deleted": true }`

### POST /scene/:id/activate

**Body (optional):** `{ "pullUsers": false }`

### POST /scene/:id/duplicate

**Body (optional):** `{ "name": "Copy Name", "folder": "Session Folder" }`

**Response:** `{ "ok": true, "id": "...", "name": "...", "duplicatedFrom": "..." }`

---

## Scene tokens

### GET /scene/:id/tokens

**Response:** `{ "ok": true, "tokens": [ ... ] }`

### POST /scene/:id/token

**Body:**

| Field | Type | Description |
|-------|------|-------------|
| `actorId` | string | **Required** — actor to place |
| `x`, `y` | number | Position in pixels |
| `width`, `height` | number | Grid units (default `1`) |
| `elevation` | number | Default `0` |
| `hidden` | boolean | Default `false` |
| `disposition` | number | `-1` hostile, `0` neutral, `1` friendly |
| `rotation` | number | Degrees |
| `scale` | number | Token scale |
| `lockRotation` | boolean | |
| `displayBars` | number | HP bar display mode |
| `displayName` | number | Name display mode |
| `bar1`, `bar2` | object | `{ "attribute": "attributes.hp" }` |
| `light` | object | `{ "bright": 10, "dim": 20, "color": "#fff" }` |
| `sight` | object | `{ "enabled": true, "range": 60 }` |

### PATCH /scene/:id/token/:tokenId

Any fields from POST (partial update).

### DELETE /scene/:id/token/:tokenId

---

## Scene walls

Walls use Foundry's wall schema. Pass wall data as documented in [Foundry WallData](https://foundryvtt.com/api/).

### GET /scene/:id/walls

### POST /scene/:id/wall

**Body:** single wall object, or `{ "walls": [ ... ] }` for batch.

**Example:**

```json
{
  "c": [100, 100, 500, 100],
  "light": 1,
  "move": 1,
  "sight": 1,
  "door": 0
}
```

### PATCH /scene/:id/wall/:wallId

### DELETE /scene/:id/wall/:wallId

---

## Scene lights

### GET /scene/:id/lights

### POST /scene/:id/light

**Example:**

```json
{
  "x": 2000,
  "y": 1500,
  "config": {
    "bright": 20,
    "dim": 40,
    "color": "#ff9900",
    "alpha": 0.5
  }
}
```

Batch: `{ "lights": [ ... ] }`

### PATCH /scene/:id/light/:lightId

### DELETE /scene/:id/light/:lightId

---

## Scene tiles

### GET /scene/:id/tiles

### POST /scene/:id/tile

**Example:**

```json
{
  "x": 1000,
  "y": 800,
  "width": 200,
  "height": 200,
  "rotation": 0,
  "alpha": 1,
  "texture": { "src": "uploads/decoration.png" }
}
```

Batch: `{ "tiles": [ ... ] }`

### PATCH /scene/:id/tile/:tileId

### DELETE /scene/:id/tile/:tileId

---

## Actors

### GET /actors

**Query:** `name` (filter), `type` (`npc`, `character`, etc.)

### GET /actor/:id

Returns full actor with `system`, `items`, `prototypeToken`.

### POST /actor

See [README POST /actor](../README.md#post-actor).

**Two modes** (combinable):

1. **Raw PF2e** — `system` + `items` (normalized on create).
2. **High-level `statblock`** — expandable NPC payload (spells/gear resolved from SRD packs).
3. **Raw creature `text`** (recommended for Hermes) — paste an adventure-style block; bridge parses → `statblock` → Foundry. Aliases: `statblockText`, `statblock_text`.

```json
{
  "text": "Tenzekil Braybittle — Creature 8\nUnique Small Gnome Humanoid Druid\nPerception +16; low-light vision\n..."
}
```

Parsed fields returned in response as `statblock` for debugging. Unresolved lines/spells appear in `warnings[]`.

High-level JSON form:

```json
{
  "name": "Tenzekil Braybittle",
  "type": "npc",
  "folder": "Session",
  "statblock": {
    "level": 8,
    "traits": ["unique", "gnome", "humanoid", "druid"],
    "size": "sm",
    "abilities": { "str": 2, "dex": 2, "con": 4, "int": 1, "wis": 5, "cha": 0 },
    "perception": 16,
    "senses": ["low-light vision"],
    "languages": ["Common", "Gnomish", "Sylvan", "Aquan"],
    "skills": { "nature": 18, "survival": 16, "medicine": 14, "stealth": 12, "acrobatics": 10 },
    "ac": 26,
    "saves": { "fortitude": 18, "reflex": 14, "will": 20 },
    "hp": 135,
    "resistances": [{ "type": "physical", "value": 5 }],
    "speed": 20,
    "strikes": [
      { "name": "club", "bonus": 16, "damage": "2d6+5 bludgeoning" },
      { "name": "flame blade", "bonus": 18, "damage": "2d8+4 fire", "traits": ["touch"] },
      { "name": "sling", "type": "ranged", "bonus": 14, "damage": "1d6+2 bludgeoning", "range": 50 }
    ],
    "actions": [
      { "name": "Wild Shape", "actions": "two", "description": "<p>3/day: Bird / Bear forms…</p>" }
    ],
    "spellcasting": {
      "tradition": "primal",
      "type": "prepared",
      "dc": 26,
      "attack": 18,
      "ability": "wis",
      "autoHeightenLevel": 5,
      "slots": { "1": 3, "2": 3, "3": 3, "4": 3 },
      "spells": {
        "4": ["air walk", "dispel magic", "freedom of movement"],
        "3": ["call lightning", "protection", "protection from energy"],
        "2": ["barkskin", "resist energy", "shillelagh"],
        "1": ["heal animal", "longstrider", "shillelagh"],
        "0": ["detect magic", "guidance", "know direction", "produce flame", "stabilize"]
      }
    },
    "gear": ["Leather Armor", "Club", "Sling", "Sling Bullets"],
    "tactics": "Stay airborne. Capitulates if HP < 25."
  }
}
```

You can still pass raw `items` / `system` alongside `statblock`/`text` (merged afterward).

PF2e helpers on create: skills `{value}` → also set `base`; items via `Item.create({parent})` with `damageRolls` kept as object; melee `bonus`; spell `level: N` → `{value:N}`; `affliction` auto-downgraded to `action` with `warnings[]`.

### POST /actor/import

Import actor from compendium (shortcut for actor packs).

**Body:**

```json
{
  "packId": "pf2e.kingmaker-bestiary",
  "documentId": "abc123",
  "name": "Optional Rename",
  "folder": "Session Folder"
}
```

### PATCH /actor/:id

Fields: `name`, `type`, `img`, `folder`, `system`, `prototypeToken`.

### DELETE /actor/:id

---

## Actor items

### GET /actor/:id/items

### POST /actor/:id/item

**Body:** `{ "item": { ... } }` or `{ "items": [ ... ] }`

### PATCH /actor/:id/item/:itemId

Fields: `name`, `img`, `type`, `system`.

### DELETE /actor/:id/item/:itemId

---

## Actor active effects

### GET /actor/:id/effects

### POST /actor/:id/effect

**Body:**

```json
{
  "effect": {
    "name": "Frightened 1",
    "icon": "icons/svg/aura.svg",
    "origin": null,
    "disabled": false,
    "duration": { "seconds": 60, "startTime": null },
    "changes": [],
    "flags": {}
  }
}
```

Batch: `{ "effects": [ ... ] }`

### PATCH /actor/:id/effect/:effectId

### DELETE /actor/:id/effect/:effectId

---

## Folders

### GET /folders

**Query:** `type` — `Scene`, `Actor`, `Item`, `JournalEntry`, `RollTable`, `Playlist`, etc.

### POST /folder

```json
{ "name": "S76 - Session", "type": "Scene", "parent": null }
```

`parent` — optional parent folder name or ID.

**Response:** `{ "ok": true, "id", "name", "type", "existed": false }`

### PATCH /folder/:id

```json
{ "name": "Renamed Folder", "parent": "Parent Folder Name" }
```

### DELETE /folder/:id

---

## Upload

### POST /upload

**Body (base64):**

```json
{ "name": "map.png", "data": "<base64>" }
```

**Body (relay local file):**

```json
{ "path": "/tmp/map.png", "name": "map.png" }
```

**Subdirectories:** `"name": "kingmaker/s76-map.png"` → `uploads/kingmaker/s76-map.png`

**Response:**

```json
{
  "ok": true,
  "url": "uploads/map.png",
  "path": "uploads/map.png",
  "method": "ssh"
}
```

---

## Compendiums

### GET /compendiums

**Query:** `type` — `Actor`, `Item`, `JournalEntry`, etc.

### GET /compendium/:packId/entries

**Query:** `search` (name filter), `limit` (max results)

**Example:** `GET /compendium/pf2e.kingmaker-bestiary/entries?search=goblin&limit=10`

### GET /compendium/:packId/entry/:documentId

**Query:** `full=1` — include complete `data` object

**Response (actor):**

```json
{
  "ok": true,
  "entry": {
    "id": "abc123",
    "name": "Goblin Warrior",
    "type": "npc",
    "img": "systems/pf2e/icons/...",
    "documentName": "Actor",
    "packId": "pf2e.kingmaker-bestiary",
    "level": 1,
    "hp": { "value": 16, "max": 16 },
    "ac": 17,
    "itemCount": 5
  }
}
```

### POST /compendium/:packId/import

Generic import for any document type in the pack.

```json
{ "documentId": "abc123", "name": "Custom Name", "folder": "Session Folder" }
```

---

## Journals

### GET /journals

**Query:** `name` (filter)

### GET /journal/:id

Returns journal with all pages and HTML content.

### POST /journal

```json
{
  "name": "S76 - Notes MJ",
  "folder": "S76 - Session",
  "content": "<h2>Objectifs</h2><ul><li>...</li></ul>",
  "pageName": "Notes"
}
```

### PATCH /journal/:id

Fields: `name`, `folder`, `content` (updates first page), `pages` (array for multi-page).

### DELETE /journal/:id

---

## Roll tables

### GET /tables

**Query:** `name`

### GET /table/:id

### POST /table

```json
{
  "name": "Random Encounter",
  "formula": "1d6",
  "description": "Forest encounters",
  "folder": "Encounters",
  "results": [
    { "type": "text", "text": "Goblins", "weight": 1, "range": [1, 3] },
    { "type": "text", "text": "Wolves", "weight": 1, "range": [4, 6] }
  ]
}
```

### PATCH /table/:id

### DELETE /table/:id

---

## Playlists

### GET /playlists

### GET /playlist/:id

### POST /playlist

```json
{
  "name": "Forest Ambience",
  "mode": 0,
  "folder": "Ambience",
  "sounds": [
    { "name": "Wind", "path": "audio/ambience/wind.ogg", "volume": 0.5, "repeat": true }
  ]
}
```

`mode`: `0` sequential, `1` shuffle, etc. (Foundry `CONST.PLAYLIST_MODES`).

### PATCH /playlist/:id

Fields: `name`, `mode`, `playing`, `channel`, `folder`.

### DELETE /playlist/:id

### POST /playlist/:id/sound

```json
{ "sound": { "name": "Rain", "path": "audio/rain.ogg", "volume": 0.3 } }
```

Batch: `{ "sounds": [ ... ] }`

### DELETE /playlist/:id/sound/:soundId

---

## Batch encounter

### POST /encounter

Creates a scene (optional), imports/creates actors, places tokens, optionally activates scene.

```json
{
  "scene": { "name": "...", "img": "uploads/...", "folder": "...", "width": 4000, "height": 2800 },
  "sceneId": "existing-scene-id",
  "activate": true,
  "creatures": [
    {
      "fromCompendium": { "packId": "pf2e.kingmaker-bestiary", "documentId": "..." },
      "name": "Override Name",
      "folder": "Session Folder",
      "token": { "x": 1500, "y": 1000, "hidden": false }
    },
    {
      "name": "Custom NPC",
      "type": "npc",
      "img": "uploads/token.png",
      "system": { "details": { "level": { "value": 3 } } },
      "items": [ ... ],
      "token": { "x": 2000, "y": 1000 }
    }
  ]
}
```

Either `scene` or `sceneId` is required (unless only adding to existing scene via `sceneId`).

**Response:**

```json
{
  "ok": true,
  "scene": { "id": "...", "name": "..." },
  "actors": [ { "id": "...", "name": "..." } ],
  "tokens": [ { "id": "...", "x": 1500, "y": 1000 } ]
}
```

---

## World items

World-level items (not embedded on an actor).

### GET /items

**Query:** `name`, `type`

### GET /item/:id

### POST /item

```json
{ "name": "Feather Token", "type": "equipment", "folder": "S76", "img": "icons/svg/item-bag.svg", "system": {} }
```

### PATCH /item/:id · DELETE /item/:id

---

## Scene notes

Map pins pointing at a journal entry.

### GET /scene/:id/notes

### POST /scene/:id/note

```json
{ "entryId": "JOURNAL_ID", "x": 1500, "y": 1200 }
```

### PATCH /scene/:id/note/:noteId · DELETE /scene/:id/note/:noteId

### POST /journal/:id/page

```json
{ "pageName": "Tactiques", "content": "<p>…</p>" }
```

---

## POST /push-obelus

Batch-create Foundry documents from Obelus entities. Timeout 120s. Prefer **compendium import** for PF2e monsters.

```json
{
  "folder": "S76 - Le Palais de Rhoswen",
  "entities": [
    {
      "obelusId": 215,
      "type": "npc",
      "title": "Spriggan Bully",
      "content": "Lore markdown…",
      "compendium": { "packId": "pf2e.pathfinder-bestiary-2", "documentId": "…" }
    },
    {
      "obelusId": 88,
      "type": "location",
      "title": "Palais de Rhoswen",
      "content": "Description…",
      "scene": { "img": "uploads/s76-map.png", "width": 3060, "height": 2040 }
    },
    { "obelusId": 12, "type": "item", "title": "Token de plume", "itemType": "equipment" },
    { "obelusId": 40, "type": "handout", "title": "Lettre de Nyrissa", "content": "<p>…</p>" }
  ]
}
```

| Obelus `type` | Foundry |
|---------------|---------|
| `npc` / `pc` | Actor (compendium → import, else create). Lore → journal if `content` without statblock |
| `item` | World Item (or compendium import) |
| `location` | Scene if `scene.img` / Foundry `uploads/…` path, plus journal if `content` |
| `handout`, `faction`, `quest`, `adventure`, `session`, `rules-note` | Journal |

Existing `foundryUuid` on an entity updates that document instead of creating a new one. `img` must be a Foundry Data path (`uploads/…`) — Obelus `/api/uploads/…` is ignored (upload via `POST /upload` first).

**Response:** `{ "ok", "folder", "created", "failed", "results": [{ "ok", "obelusId", "kind", "foundryUuid", "error" }] }`

---

## POST /execute

Run JavaScript in the GM client against the public Foundry API. LAN + shared key only.

```json
{ "js": "return game.actors.map(a => ({ id: a.id, name: a.name }))" }
```

Available bindings: `game`, `foundry`, `fromUuid`, `fromUuidSync`, `CONFIG`, `canvas`, `ui`, `Hooks`, `Roll`, `Actor`, `Item`, `Scene`, `JournalEntry`, `Folder`, `TokenDocument`. Max 20k characters. **Use a `return`.**

---

## WebSocket protocol (relay ↔ module)

Not intended for direct client use. Documented for contributors.

### Module → Relay (register)

```json
{ "type": "register", "key": "...", "world": "kingmaker", "foundry": "14.364", "user": "Gamemaster" }
```

### Relay → Module (request)

```json
{ "type": "request", "id": "uuid", "action": "create_scene", "data": { ... } }
```

### Module → Relay (response)

```json
{ "type": "response", "id": "uuid", "ok": true, "data": { ... }, "error": null }
```

### Heartbeat

Module sends `{ "type": "heartbeat" }` every 25s. Relay replies `{ "type": "pong" }`.
