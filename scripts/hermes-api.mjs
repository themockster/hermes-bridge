/**
 * Hermes Bridge — Foundry VTT client module (v1.5)
 * Full CRUD API for scenes, actors, tokens, items, folders, compendiums.
 * Do NOT import from 'foundryvtt' — Hooks, game, Scene, Actor are globals.
 */

import {
  populateActorFromStatblock,
  previewSystemFromStatblock,
} from "./npc-statblock.mjs";
import { parseStatblockText } from "./statblock-parse.mjs";
import {
  PUSH_FOLDER_TYPES,
  contentToHtml,
  foundryIdFromUuid,
  isFoundryAssetPath,
  mapObelusType,
} from "./obelus-map.mjs";

const MODULE_ID = "hermes-bridge";
const DEFAULT_RELAY_URL = "ws://127.0.0.1:9997/ws";
const DEFAULT_SHARED_KEY = "hermes-foundry-bridge-key-2026";
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const PING_INTERVAL_MS = 25000;

let ws = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let pingTimer = null;
let connected = false;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level, ...args) {
  console[level](`[${MODULE_ID}]`, ...args);
  if (game.user?.isGM && (level === "warn" || level === "error")) {
    const msg = args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
    ui.notifications?.notify(`Hermes Bridge: ${msg}`, level === "error" ? "error" : "warning");
  }
}

function notifyGM(message, type = "info") {
  if (game.user?.isGM) ui.notifications?.notify(`Hermes Bridge: ${message}`, type);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function registerSettings() {
  game.settings.register(MODULE_ID, "relayUrl", {
    name: "Relay WebSocket URL",
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_RELAY_URL,
    onChange: () => { disconnect(); scheduleReconnect(500); },
  });
  game.settings.register(MODULE_ID, "sharedKey", {
    name: "Shared API Key",
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_SHARED_KEY,
  });
  game.settings.register(MODULE_ID, "enabled", {
    name: "Bridge Enabled",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: (v) => { if (v) scheduleReconnect(500); else disconnect(); },
  });
}

function getRelayUrl() { return game.settings.get(MODULE_ID, "relayUrl") || DEFAULT_RELAY_URL; }
function getSharedKey() { return game.settings.get(MODULE_ID, "sharedKey") || DEFAULT_SHARED_KEY; }
function isEnabled() { return game.settings.get(MODULE_ID, "enabled") !== false; }

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

function connect() {
  if (!game.user?.isGM || !isEnabled()) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try {
    ws = new WebSocket(getRelayUrl());
  } catch (err) {
    log("error", "WebSocket failed:", err);
    scheduleReconnect();
    return;
  }
  ws.addEventListener("open", onOpen);
  ws.addEventListener("message", onMessage);
  ws.addEventListener("close", onClose);
  ws.addEventListener("error", onError);
}

function disconnect() {
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);
  reconnectTimer = pingTimer = null;
  connected = false;
  if (!ws) return;
  ws.removeEventListener("open", onOpen);
  ws.removeEventListener("message", onMessage);
  ws.removeEventListener("close", onClose);
  ws.removeEventListener("error", onError);
  try { ws.close(); } catch (_) { /* ignore */ }
  ws = null;
}

function onOpen() {
  reconnectAttempts = 0;
  connected = true;
  notifyGM("Connected to Hermes relay", "info");
  ws.send(JSON.stringify({
    type: "register", key: getSharedKey(),
    world: game.world?.id, foundry: game.version, user: game.user?.name,
  }));
  pingTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "heartbeat" }));
  }, PING_INTERVAL_MS);
}

function onClose(event) {
  connected = false;
  clearInterval(pingTimer);
  pingTimer = null;
  scheduleReconnect();
}

function onError(event) { log("error", "WebSocket error", event); }

function scheduleReconnect(delayMs) {
  clearTimeout(reconnectTimer);
  if (!isEnabled() || !game.user?.isGM) return;
  const delay = delayMs ?? Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS);
  reconnectAttempts++;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
}

async function onMessage(event) {
  let msg;
  try { msg = JSON.parse(event.data); } catch { return; }
  if (msg.type === "pong" || msg.type === "registered") return;
  if (msg.type !== "request" || !msg.id || !msg.action) return;
  try {
    sendResponse(msg.id, true, await handleAction(msg.action, msg.data ?? {}));
  } catch (err) {
    sendResponse(msg.id, false, null, err.message ?? String(err));
  }
}

function sendResponse(id, ok, data, error) {
  if (ws?.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "response", id, ok, data: data ?? null, error: error ?? null }));
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/** Resolve the active Level document (v14 stores backgrounds on Levels, not Scene). */
function resolveSceneLevel(scene) {
  const levels = scene?.levels;
  if (!levels) return null;
  let level = scene.initialLevel;
  if (typeof level === "string") level = levels.get(level);
  if (level) return level;
  const first = scene.firstLevel;
  if (first) return typeof first === "string" ? levels.get(first) : first;
  return levels.contents?.[0] ?? null;
}

function getSceneBackgroundSrc(scene) {
  const level = resolveSceneLevel(scene);
  if (level?.background?.src) return level.background.src;
  // Legacy pre-v14 fields (harmless fallback)
  return scene.background?.src ?? scene.img ?? "";
}

function serializeScene(scene, detailed = false) {
  const base = {
    id: scene.id,
    uuid: scene.uuid,
    name: scene.name,
    img: getSceneBackgroundSrc(scene),
    width: scene.width,
    height: scene.height,
    active: scene.active,
    navigation: scene.navigation,
    folder: scene.folder?.name ?? null,
    tokenCount: scene.tokens?.size ?? 0,
  };
  if (!detailed) return base;
  return {
    ...base,
    folderId: scene.folder?.id ?? null,
    grid: { size: scene.grid.size, type: scene.grid.type },
    padding: scene.padding,
    thumb: scene.thumb,
    initialLevelId: typeof scene.initialLevel === "string"
      ? scene.initialLevel
      : scene.initialLevel?.id ?? null,
    levels: scene.levels?.contents?.map((l) => ({
      id: l.id,
      name: l.name,
      background: l.background?.src ?? null,
    })) ?? [],
  };
}

function serializeActor(actor, detailed = false) {
  const base = {
    id: actor.id,
    uuid: actor.uuid,
    name: actor.name,
    type: actor.type,
    img: actor.img,
    folder: actor.folder?.name ?? null,
    itemCount: actor.items.size,
  };
  if (!detailed) return base;
  return {
    ...base,
    folderId: actor.folder?.id ?? null,
    prototypeToken: {
      texture: actor.prototypeToken.texture?.src ?? actor.img,
      disposition: actor.prototypeToken.disposition,
      width: actor.prototypeToken.width,
      height: actor.prototypeToken.height,
    },
    system: actor.system,
    items: actor.items.map(serializeItem),
  };
}

function serializeToken(token) {
  return {
    id: token.id,
    name: token.name,
    actorId: token.actorId,
    x: token.x,
    y: token.y,
    width: token.width,
    height: token.height,
    elevation: token.elevation,
    hidden: token.hidden,
    disposition: token.disposition,
    texture: token.texture?.src ?? "",
    rotation: token.rotation,
    scale: token.scale,
    lockRotation: token.lockRotation,
    displayBars: token.displayBars,
    displayName: token.displayName,
    bar1: token.bar1,
    bar2: token.bar2,
    light: token.light,
    sight: token.sight,
  };
}

function serializeJournal(journal, detailed = false) {
  const base = {
    id: journal.id,
    uuid: journal.uuid,
    name: journal.name,
    folder: journal.folder?.name ?? null,
    pageCount: journal.pages?.size ?? 0,
  };
  if (!detailed) return base;
  return {
    ...base,
    folderId: journal.folder?.id ?? null,
    pages: journal.pages.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      content: p.text?.content ?? "",
    })),
  };
}

function serializeWall(wall) {
  return {
    id: wall.id,
    c: wall.c,
    light: wall.light,
    move: wall.move,
    sight: wall.sight,
    door: wall.door,
    dir: wall.dir,
    threshold: wall.threshold,
  };
}

function serializeAmbientLight(light) {
  return {
    id: light.id,
    x: light.x,
    y: light.y,
    rotation: light.rotation,
    hidden: light.hidden,
    config: light.config,
  };
}

function serializeTile(tile) {
  return {
    id: tile.id,
    x: tile.x,
    y: tile.y,
    width: tile.width,
    height: tile.height,
    rotation: tile.rotation,
    alpha: tile.alpha,
    hidden: tile.hidden,
    overhead: tile.overhead,
    occlusion: tile.occlusion,
    texture: tile.texture?.src ?? "",
  };
}

function serializeRollTable(table, detailed = false) {
  const base = {
    id: table.id,
    name: table.name,
    folder: table.folder?.name ?? null,
    formula: table.formula,
    resultCount: table.results?.size ?? 0,
  };
  if (!detailed) return base;
  return {
    ...base,
    folderId: table.folder?.id ?? null,
    description: table.description,
    results: table.results.map((r) => ({
      id: r.id,
      type: r.type,
      text: r.text,
      weight: r.weight,
      range: r.range,
    })),
  };
}

function serializePlaylist(playlist, detailed = false) {
  const base = {
    id: playlist.id,
    name: playlist.name,
    folder: playlist.folder?.name ?? null,
    mode: playlist.mode,
    playing: playlist.playing,
    soundCount: playlist.sounds?.size ?? 0,
  };
  if (!detailed) return base;
  return {
    ...base,
    folderId: playlist.folder?.id ?? null,
    sounds: playlist.sounds.map((s) => ({
      id: s.id,
      name: s.name,
      path: s.path,
      volume: s.volume,
      repeat: s.repeat,
    })),
  };
}

function serializeActiveEffect(effect) {
  return {
    id: effect.id,
    name: effect.name,
    icon: effect.icon,
    disabled: effect.disabled,
    duration: effect.duration,
    changes: effect.changes,
    flags: effect.flags,
  };
}

function serializeItem(item) {
  return {
    id: item.id,
    uuid: item.uuid,
    name: item.name,
    type: item.type,
    img: item.img,
    folder: item.folder?.name ?? null,
    system: item.system,
  };
}

function serializeNote(note) {
  return {
    id: note.id,
    entryId: note.entryId,
    pageId: note.pageId ?? null,
    x: note.x,
    y: note.y,
    text: note.text ?? "",
    icon: note.texture?.src ?? note.icon ?? null,
  };
}

function filterByName(docs, name) {
  if (!name) return docs;
  const q = name.toLowerCase();
  return docs.filter((d) => d.name.toLowerCase().includes(q));
}

function requireDoc(collection, id, label) {
  const doc = collection.get(id);
  if (!doc) throw new Error(`${label} not found: ${id}`);
  return doc;
}

// ---------------------------------------------------------------------------
// Folder helpers
// ---------------------------------------------------------------------------

const FOLDER_ID_RE = /^[a-zA-Z0-9]{16}$/;
const VALID_FOLDER_TYPES = new Set([
  "Scene", "Actor", "Item", "JournalEntry", "Macro", "RollTable", "Cards", "Playlist",
]);

async function resolveFolderId(folder, type) {
  if (folder == null || folder === "") return null;
  if (typeof folder === "string" && FOLDER_ID_RE.test(folder)) return folder;

  const name = String(folder);
  const existing = game.folders.find((f) => f.name === name && f.type === type);
  if (existing) return existing.id;

  const created = await Folder.create({ name, type });
  return created.id;
}

async function createFolder(data) {
  const { name, type, parent } = data;
  if (!name) throw new Error("name is required");
  const folderType = type ?? "Scene";
  if (!VALID_FOLDER_TYPES.has(folderType)) {
    throw new Error(`Invalid folder type: ${folderType}`);
  }

  const parentId = parent ? await resolveFolderId(parent, folderType) : null;
  const existing = game.folders.find(
    (f) => f.name === name && f.type === folderType && (f.folder?.id ?? null) === parentId,
  );
  if (existing) {
    return { ok: true, id: existing.id, name: existing.name, type: existing.type, existed: true };
  }

  const folder = await Folder.create({ name, type: folderType, folder: parentId });
  return { ok: true, id: folder.id, name: folder.name, type: folder.type, existed: false };
}

async function updateFolder(data) {
  const folder = requireDoc(game.folders, data.id, "Folder");
  const updates = {};
  if (data.name !== undefined) updates.name = data.name;
  if (data.parent !== undefined || data.folder !== undefined) {
    updates.folder = data.parent === null || data.folder === null
      ? null
      : await resolveFolderId(data.parent ?? data.folder, folder.type);
  }
  if (Object.keys(updates).length) await folder.update(updates);
  return { ok: true, id: folder.id, name: folder.name, type: folder.type };
}

async function deleteFolder(data) {
  const folder = requireDoc(game.folders, data.id, "Folder");
  const id = folder.id;
  await folder.delete();
  return { ok: true, id, deleted: true };
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

function decodeBase64(base64) {
  const clean = base64.replace(/^data:[^;]+;base64,/, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function guessMime(name) {
  const ext = name.split(".").pop()?.toLowerCase();
  const map = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
    gif: "image/gif", svg: "image/svg+xml", txt: "text/plain", json: "application/json",
  };
  return map[ext ?? ""] ?? "application/octet-stream";
}

function getFilePicker() {
  return foundry.applications.apps.FilePicker ?? globalThis.FilePicker;
}

async function uploadFile(data) {
  const { name, data: base64, path: subdir, mime } = data;
  if (!name) throw new Error("name is required");
  if (!base64) throw new Error("data (base64) is required");
  if (!game.user?.can("FILES_UPLOAD")) {
    throw new Error("Current user lacks FILES_UPLOAD permission");
  }

  const FP = getFilePicker();
  if (!FP?.uploadURL) throw new Error("FilePicker.uploadURL is unavailable");

  const parts = name.split("/").filter(Boolean);
  const fileName = parts.pop() ?? name;
  const dirParts = parts.length ? parts : (subdir ? String(subdir).split("/").filter(Boolean) : []);
  const targetPath = dirParts.length ? `uploads/${dirParts.join("/")}` : "uploads";
  const url = `${targetPath}/${fileName}`;

  const bytes = decodeBase64(base64);
  const file = new File([bytes], fileName, { type: mime ?? guessMime(fileName) });

  const formData = new FormData();
  formData.append("source", "data");
  formData.append("target", targetPath);
  formData.append("upload", file, file.name);

  const endpoint = FP.uploadURL;
  const response = await fetch(endpoint, { method: "POST", body: formData });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Upload failed (${response.status}): ${detail.slice(0, 300)}`);
  }

  const json = await response.json().catch(() => ({}));
  const resultPath = String(json.path ?? json.url ?? url).replace(/^\//, "");
  return { ok: true, url: resultPath, path: resultPath };
}

// ---------------------------------------------------------------------------
// Scene operations
// ---------------------------------------------------------------------------

async function refreshSceneThumbnail(scene, level) {
  if (typeof scene.createThumbnail !== "function") return;
  try {
    const opts = {};
    if (level) opts.level = level.id ?? level;
    const thumbData = await scene.createThumbnail(opts);
    if (thumbData?.thumb) await scene.update({ thumb: thumbData.thumb });
  } catch (err) {
    log("warn", "Scene thumbnail generation failed:", err.message ?? err);
  }
}

/**
 * Foundry v14: Scene.background / Scene.img are gone.
 * Background lives on the Level embedded document (`background.src`).
 * Also regenerates `thumb` so the sidebar does not look empty.
 */
async function applySceneBackground(scene, src) {
  if (!src) return;
  const live = game.scenes.get(scene.id) ?? scene;
  let level = resolveSceneLevel(live);
  if (level) {
    await live.updateEmbeddedDocuments("Level", [{
      _id: level.id,
      background: { src },
    }]);
    level = resolveSceneLevel(live) ?? level;
  } else {
    const [created] = await live.createEmbeddedDocuments("Level", [{
      name: live.name || "Ground",
      elevation: { bottom: 0, top: 5 },
      background: { src },
    }]);
    level = created;
    if (created?.id && !live.initialLevel) {
      try { await live.update({ initialLevel: created.id }); } catch (_) { /* ignore */ }
    }
  }
  await refreshSceneThumbnail(live, level);
}

async function createScene(data) {
  const { name, img, width, height, gridSize, gridType, padding, navigation, folder } = data;
  if (!name) throw new Error("Scene name is required");
  const folderId = await resolveFolderId(folder, "Scene");
  // Prefer embedding the Level at create-time so v14 never sees a Scene-level background.
  const sceneData = {
    name,
    width: width ?? 4000,
    height: height ?? 2800,
    padding: padding ?? 0.25,
    navigation: navigation ?? true,
    folder: folderId,
    grid: { size: gridSize ?? 100, type: gridType ?? CONST.GRID_TYPES.SQUARE },
  };
  if (img) {
    sceneData.levels = [{
      name: "Ground",
      elevation: { bottom: 0, top: 5 },
      background: { src: img },
    }];
  }
  let scene = await Scene.create(sceneData);
  scene = game.scenes.get(scene.id) ?? scene;
  if (img) {
    if (getSceneBackgroundSrc(scene) !== img) await applySceneBackground(scene, img);
    else await refreshSceneThumbnail(scene, resolveSceneLevel(scene));
  }
  return { ok: true, ...serializeScene(game.scenes.get(scene.id) ?? scene) };
}

async function updateScene(data) {
  const scene = requireDoc(game.scenes, data.id, "Scene");
  const updates = {};
  for (const key of ["name", "width", "height", "padding", "navigation"]) {
    if (data[key] !== undefined) updates[key] = data[key];
  }
  if (data.gridSize !== undefined || data.gridType !== undefined) {
    updates.grid = {
      size: data.gridSize ?? scene.grid.size,
      type: data.gridType ?? scene.grid.type,
    };
  }
  if (data.folder !== undefined) {
    updates.folder = await resolveFolderId(data.folder, "Scene");
  }
  if (Object.keys(updates).length) await scene.update(updates);
  if (data.img) await applySceneBackground(scene, data.img);
  return { ok: true, ...serializeScene(game.scenes.get(scene.id) ?? scene) };
}

async function deleteScene(data) {
  const scene = requireDoc(game.scenes, data.id, "Scene");
  const id = scene.id;
  await scene.delete();
  return { ok: true, id, deleted: true };
}

async function activateScene(data) {
  const scene = requireDoc(game.scenes, data.id, "Scene");
  await scene.activate({ pullUsers: data.pullUsers ?? false });
  return { ok: true, id: scene.id, name: scene.name, active: true };
}

async function duplicateScene(data) {
  const scene = requireDoc(game.scenes, data.id, "Scene");
  const name = data.name ?? `${scene.name} (Copy)`;
  let duplicate;
  if (typeof scene.duplicate === "function") {
    const dup = await scene.duplicate({ name }, { save: true });
    duplicate = Array.isArray(dup) ? dup[0] : dup;
  } else {
    const obj = scene.toObject();
    delete obj._id;
    obj.name = name;
    if (data.folder !== undefined) {
      obj.folder = await resolveFolderId(data.folder, "Scene");
    }
    duplicate = await Scene.create(obj);
  }
  return { ok: true, ...serializeScene(duplicate), duplicatedFrom: scene.id };
}

function getSceneEmbedded(scene, collection, id, label) {
  const doc = scene[collection]?.get(id);
  if (!doc) throw new Error(`${label} not found: ${id}`);
  return doc;
}

async function listSceneWalls(data) {
  return requireDoc(game.scenes, data.id ?? data.sceneId, "Scene").walls.map(serializeWall);
}

async function createSceneWall(data) {
  const scene = requireDoc(game.scenes, data.id ?? data.sceneId, "Scene");
  const walls = data.walls ?? [data.wall ?? data];
  const created = await scene.createEmbeddedDocuments("Wall", walls);
  return { ok: true, walls: created.map(serializeWall), sceneId: scene.id };
}

async function updateSceneWall(data) {
  const scene = requireDoc(game.scenes, data.sceneId, "Scene");
  const wall = getSceneEmbedded(scene, "walls", data.wallId, "Wall");
  const { wallId, sceneId, id, ...updates } = data;
  if (Object.keys(updates).length) await wall.update(updates);
  return { ok: true, ...serializeWall(wall), sceneId: scene.id };
}

async function deleteSceneWall(data) {
  const scene = requireDoc(game.scenes, data.sceneId, "Scene");
  const wall = getSceneEmbedded(scene, "walls", data.wallId, "Wall");
  const id = wall.id;
  await wall.delete();
  return { ok: true, id, sceneId: scene.id, deleted: true };
}

async function listSceneLights(data) {
  return requireDoc(game.scenes, data.id ?? data.sceneId, "Scene").lights.map(serializeAmbientLight);
}

async function createSceneLight(data) {
  const scene = requireDoc(game.scenes, data.id ?? data.sceneId, "Scene");
  const lights = data.lights ?? [data.light ?? data];
  const created = await scene.createEmbeddedDocuments("AmbientLight", lights);
  return { ok: true, lights: created.map(serializeAmbientLight), sceneId: scene.id };
}

async function updateSceneLight(data) {
  const scene = requireDoc(game.scenes, data.sceneId, "Scene");
  const light = getSceneEmbedded(scene, "lights", data.lightId, "Light");
  const { lightId, sceneId, id, ...updates } = data;
  if (Object.keys(updates).length) await light.update(updates);
  return { ok: true, ...serializeAmbientLight(light), sceneId: scene.id };
}

async function deleteSceneLight(data) {
  const scene = requireDoc(game.scenes, data.sceneId, "Scene");
  const light = getSceneEmbedded(scene, "lights", data.lightId, "Light");
  const id = light.id;
  await light.delete();
  return { ok: true, id, sceneId: scene.id, deleted: true };
}

async function listSceneTiles(data) {
  return requireDoc(game.scenes, data.id ?? data.sceneId, "Scene").tiles.map(serializeTile);
}

async function createSceneTile(data) {
  const scene = requireDoc(game.scenes, data.id ?? data.sceneId, "Scene");
  const tiles = data.tiles ?? [data.tile ?? data];
  const created = await scene.createEmbeddedDocuments("Tile", tiles);
  return { ok: true, tiles: created.map(serializeTile), sceneId: scene.id };
}

async function updateSceneTile(data) {
  const scene = requireDoc(game.scenes, data.sceneId, "Scene");
  const tile = getSceneEmbedded(scene, "tiles", data.tileId, "Tile");
  const { tileId, sceneId, id, ...updates } = data;
  if (Object.keys(updates).length) await tile.update(updates);
  return { ok: true, ...serializeTile(tile), sceneId: scene.id };
}

async function deleteSceneTile(data) {
  const scene = requireDoc(game.scenes, data.sceneId, "Scene");
  const tile = getSceneEmbedded(scene, "tiles", data.tileId, "Tile");
  const id = tile.id;
  await tile.delete();
  return { ok: true, id, sceneId: scene.id, deleted: true };
}

async function listSceneNotes(data) {
  const scene = requireDoc(game.scenes, data.id ?? data.sceneId, "Scene");
  return scene.notes.map(serializeNote);
}

async function createSceneNote(data) {
  const scene = requireDoc(game.scenes, data.sceneId ?? data.id, "Scene");
  const notes = data.notes ?? [data.note ?? data];
  const created = await scene.createEmbeddedDocuments("Note", notes.map((n) => {
    const { sceneId: _s, id: _i, notes: _n, note: _note, ...rest } = n;
    return rest;
  }));
  return { ok: true, notes: created.map(serializeNote), sceneId: scene.id };
}

async function updateSceneNote(data) {
  const scene = requireDoc(game.scenes, data.sceneId, "Scene");
  const note = getSceneEmbedded(scene, "notes", data.noteId, "Note");
  const { noteId, sceneId, id, ...updates } = data;
  if (Object.keys(updates).length) await note.update(updates);
  return { ok: true, ...serializeNote(note), sceneId: scene.id };
}

async function deleteSceneNote(data) {
  const scene = requireDoc(game.scenes, data.sceneId, "Scene");
  const note = getSceneEmbedded(scene, "notes", data.noteId, "Note");
  const id = note.id;
  await note.delete();
  return { ok: true, id, sceneId: scene.id, deleted: true };
}

// ---------------------------------------------------------------------------
// Actor operations
// ---------------------------------------------------------------------------

function buildPf2eSystem(input) {
  const src = foundry.utils.deepClone(input ?? {});
  if (src.skills) src.skills = buildSkills(src.skills);
  const defaults = {
    details: {
      level: { value: src.details?.level?.value ?? src.level ?? 1 },
      blurb: src.details?.blurb ?? "",
      publicNotes: src.details?.publicNotes ?? "",
    },
    attributes: {
      hp: {
        value: src.attributes?.hp?.value ?? src.hp ?? 10,
        max: src.attributes?.hp?.max ?? src.attributes?.hp?.value ?? src.hp ?? 10,
        temp: 0,
      },
      ac: { value: src.attributes?.ac?.value ?? src.ac ?? 10 },
      hardness: { value: 0 },
    },
    abilities: buildAbilities(src.abilities ?? src),
    saves: {
      fortitude: { value: src.saves?.fortitude?.value ?? src.saves?.fort ?? 0 },
      reflex: { value: src.saves?.reflex?.value ?? src.saves?.ref ?? 0 },
      will: { value: src.saves?.will?.value ?? src.saves?.wil ?? 0 },
    },
    perception: { mod: src.perception?.mod ?? src.perception ?? 0, senses: [] },
    skills: {},
  };
  const merged = foundry.utils.mergeObject(defaults, src, { inplace: false, overwrite: true });
  // PF2e recalculates skills from ability mods unless `base` is set.
  if (merged.skills) merged.skills = buildSkills(merged.skills);
  return merged;
}

function buildAbilities(src) {
  const ability = (key) => ({ mod: src[key]?.mod ?? src[key] ?? 0 });
  return { str: ability("str"), dex: ability("dex"), con: ability("con"),
    int: ability("int"), wis: ability("wis"), cha: ability("cha") };
}

function buildSkills(skills) {
  const result = {};
  for (const [key, val] of Object.entries(skills ?? {})) {
    const skill = (typeof val === "object" && val !== null) ? { ...val } : { value: val };
    if (typeof skill.value === "number" && skill.base === undefined) {
      skill.base = skill.value;
    }
    result[key] = skill;
  }
  return result;
}

function buildPrototypeToken(imgPath, actorType, prototypeToken) {
  return foundry.utils.mergeObject({
    texture: { src: imgPath },
    disposition: actorType === "npc"
      ? CONST.TOKEN_DISPOSITIONS.HOSTILE
      : CONST.TOKEN_DISPOSITIONS.FRIENDLY,
  }, prototypeToken ?? {}, { inplace: false, overwrite: true });
}

/**
 * Normalize PF2e item payloads so Item.create does not drop attack/damage/level data.
 * Affliction is not available in PF2e production builds → downgrade to action.
 */
function normalizeItemData(itemData, warnings = []) {
  const item = foundry.utils.deepClone(itemData ?? {});
  if (item.type === "affliction") {
    warnings.push(
      `Item "${item.name ?? "unnamed"}": type affliction is not available in PF2e production; converted to action.`,
    );
    item.type = "action";
    item.system = item.system ?? {};
    const existing = item.system.description;
    if (typeof existing === "string") {
      item.system.description = { value: existing };
    } else if (!existing || typeof existing !== "object") {
      item.system.description = { value: "" };
    } else if (existing.value === undefined) {
      item.system.description = { ...existing, value: existing.value ?? "" };
    }
  }
  if (item.system) {
    if ((item.type === "spell" || item.type === "spellcastingEntry")
        && typeof item.system.level === "number") {
      item.system.level = { value: item.system.level };
    }
    // PF2e melee damageRolls is Record<string, DamageRoll>, NOT an array.
    // Arrays are wiped by the DataModel; convert array → keyed object instead.
    if (Array.isArray(item.system.damageRolls)) {
      const keyed = {};
      item.system.damageRolls.forEach((roll, i) => {
        if (roll && typeof roll === "object") keyed[String(i)] = roll;
      });
      item.system.damageRolls = keyed;
    } else if (item.system.damageRolls && typeof item.system.damageRolls === "object") {
      // Keep as-is; ensure each entry has damage + damageType when possible
      for (const [k, roll] of Object.entries(item.system.damageRolls)) {
        if (!roll || typeof roll !== "object") continue;
        if (roll.damage == null && roll.formula) roll.damage = roll.formula;
        if (roll.damageType == null && roll.type) roll.damageType = roll.type;
      }
    }
    if (item.type === "melee" && item.system.bonus !== undefined) {
      // Ensure bonus is { value: N } — PF2e uses system.bonus.value for NPC strikes
      const bonus = item.system.bonus;
      if (typeof bonus === "number") item.system.bonus = { value: bonus };
      else if (bonus && typeof bonus === "object" && bonus.value === undefined
          && typeof bonus.total === "number") {
        item.system.bonus = { value: bonus.total };
      }
    }
  }
  return item;
}

async function createActorItems(actor, items) {
  const warnings = [];
  const created = [];
  if (!items?.length) return { items: created, warnings };
  let sort = 0;
  for (const raw of items) {
    const itemData = normalizeItemData(raw, warnings);
    try {
      const doc = await Item.create(
        { ...itemData, folder: null, sort: sort * 1000 },
        { parent: actor },
      );
      const item = Array.isArray(doc) ? doc[0] : doc;
      if (item) created.push(item);
      sort += 1;
    } catch (err) {
      const msg = `Item "${itemData.name ?? "unnamed"}" failed: ${err.message ?? err}`;
      warnings.push(msg);
      log("warn", msg);
    }
  }
  return { items: created, warnings };
}

async function createActor(data) {
  const { type, img, prototypeToken, folder } = data;
  let { name, system, items, statblock } = data;
  const warnings = [];

  // Raw creature text → high-level statblock (Hermes can paste adventure blocks).
  const rawText = data.text ?? data.statblockText ?? data.statblock_text;
  if (rawText && typeof rawText === "string") {
    const parsed = parseStatblockText(rawText);
    warnings.push(...parsed.warnings);
    statblock = foundry.utils.mergeObject(parsed.statblock, statblock ?? {}, {
      inplace: false,
      overwrite: true,
    });
  }

  // High-level Hermes-friendly payload: expand into PF2e system (+ items after create).
  if (statblock && typeof statblock === "object") {
    if (!name) name = statblock.name;
    system = foundry.utils.mergeObject(
      previewSystemFromStatblock(statblock),
      system ?? {},
      { inplace: false, overwrite: true },
    );
  }

  if (!name) throw new Error("Actor name is required (or provide statblock.name / parseable text)");
  const actorType = type ?? "npc";
  const imgPath = img ?? "icons/svg/mystery-man.svg";
  const folderId = await resolveFolderId(folder, "Actor");
  const actorData = {
    name, type: actorType, img: imgPath, folder: folderId,
    prototypeToken: buildPrototypeToken(imgPath, actorType, prototypeToken),
    system: buildPf2eSystem(system ?? {}),
  };
  // Create actor without embedded items, then add via Item.create({parent})
  // so PF2e properly initializes attackBonus / damageRolls / spell level.
  const actor = await Actor.create(actorData);

  let createdItems = [];
  if (statblock && typeof statblock === "object") {
    const populated = await populateActorFromStatblock(actor, statblock, warnings);
    createdItems = populated.items;
  }
  if (items?.length) {
    const extra = await createActorItems(actor, items);
    createdItems = createdItems.concat(extra.items);
    warnings.push(...extra.warnings);
  }

  const result = {
    ok: true,
    ...serializeActor(actor, true),
    itemCount: createdItems.length,
  };
  if (statblock && typeof statblock === "object") result.statblock = statblock;
  if (warnings.length) result.warnings = warnings;
  return result;
}

async function importActor(data) {
  const { packId, documentId, name, folder } = data;
  if (!packId || !documentId) throw new Error("packId and documentId are required");
  const pack = game.packs.get(packId);
  if (!pack) throw new Error(`Compendium not found: ${packId}`);
  if (pack.documentName !== "Actor") throw new Error(`Pack is not an Actor pack: ${packId}`);
  const source = await pack.getDocument(documentId);
  if (!source) throw new Error(`Actor not found in compendium: ${documentId}`);
  const actorData = source.toObject();
  delete actorData._id;
  if (name) actorData.name = name;
  if (folder) actorData.folder = await resolveFolderId(folder, "Actor");
  const actor = await Actor.create(actorData);
  return { ok: true, imported: true, packId, ...serializeActor(actor) };
}

async function updateActor(data) {
  const actor = requireDoc(game.actors, data.id, "Actor");
  const updates = {};
  for (const key of ["name", "type"]) {
    if (data[key] !== undefined) updates[key] = data[key];
  }
  if (data.folder !== undefined) {
    updates.folder = await resolveFolderId(data.folder, "Actor");
  }
  if (data.img) {
    updates.img = data.img;
    updates.prototypeToken = foundry.utils.mergeObject(
      actor.prototypeToken.toObject(),
      { texture: { src: data.img } },
      { inplace: false },
    );
  }
  if (data.prototypeToken) {
    updates.prototypeToken = foundry.utils.mergeObject(
      updates.prototypeToken ?? actor.prototypeToken.toObject(),
      data.prototypeToken,
      { inplace: false, overwrite: true },
    );
  }
  if (data.system) {
    updates.system = foundry.utils.mergeObject(actor.system, data.system, { inplace: false, overwrite: true });
  }
  if (Object.keys(updates).length) await actor.update(updates);
  return { ok: true, ...serializeActor(actor) };
}

async function deleteActor(data) {
  const actor = requireDoc(game.actors, data.id, "Actor");
  const id = actor.id;
  await actor.delete();
  return { ok: true, id, deleted: true };
}

// ---------------------------------------------------------------------------
// Item operations (on actor)
// ---------------------------------------------------------------------------

async function createActorItem(data) {
  const actor = requireDoc(game.actors, data.actorId ?? data.id, "Actor");
  if (!data.item && !data.items) throw new Error("item or items array required");
  const { items: created, warnings } = await createActorItems(actor, data.items ?? [data.item]);
  const result = { ok: true, items: created.map(serializeItem) };
  if (warnings.length) result.warnings = warnings;
  return result;
}

async function updateActorItem(data) {
  const actor = requireDoc(game.actors, data.actorId ?? data.id, "Actor");
  const item = actor.items.get(data.itemId);
  if (!item) throw new Error(`Item not found: ${data.itemId}`);
  const { name, img, system, type } = data;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (img !== undefined) updates.img = img;
  if (type !== undefined) updates.type = type;
  if (system) updates.system = foundry.utils.mergeObject(item.system, system, { inplace: false, overwrite: true });
  if (Object.keys(updates).length) await item.update(updates);
  return { ok: true, item: serializeItem(item) };
}

async function deleteActorItem(data) {
  const actor = requireDoc(game.actors, data.actorId ?? data.id, "Actor");
  const item = actor.items.get(data.itemId);
  if (!item) throw new Error(`Item not found: ${data.itemId}`);
  const id = item.id;
  await item.delete();
  return { ok: true, id, deleted: true };
}

// ---------------------------------------------------------------------------
// Token operations
// ---------------------------------------------------------------------------

async function placeToken(data) {
  const scene = requireDoc(game.scenes, data.sceneId, "Scene");
  const actor = requireDoc(game.actors, data.actorId, "Actor");
  const tokenOverrides = {
    x: data.x ?? 0,
    y: data.y ?? 0,
    width: data.width ?? 1,
    height: data.height ?? 1,
    elevation: data.elevation ?? 0,
    hidden: data.hidden ?? false,
    disposition: data.disposition ?? actor.prototypeToken.disposition,
  };
  for (const key of [
    "rotation", "scale", "lockRotation", "displayBars", "displayName", "bar1", "bar2", "light", "sight",
  ]) {
    if (data[key] !== undefined) tokenOverrides[key] = data[key];
  }
  const tokenDoc = await actor.getTokenDocument(tokenOverrides);
  const [token] = await scene.createEmbeddedDocuments("Token", [tokenDoc]);
  return { ok: true, ...serializeToken(token), sceneId: scene.id };
}

async function updateToken(data) {
  const scene = requireDoc(game.scenes, data.sceneId, "Scene");
  const token = scene.tokens.get(data.tokenId);
  if (!token) throw new Error(`Token not found: ${data.tokenId}`);
  const updates = {};
  for (const key of [
    "x", "y", "width", "height", "elevation", "hidden", "disposition", "name",
    "rotation", "scale", "lockRotation", "displayBars", "displayName", "bar1", "bar2", "light", "sight",
  ]) {
    if (data[key] !== undefined) updates[key] = data[key];
  }
  if (Object.keys(updates).length) await token.update(updates);
  return { ok: true, ...serializeToken(token), sceneId: scene.id };
}

async function deleteToken(data) {
  const scene = requireDoc(game.scenes, data.sceneId, "Scene");
  const token = scene.tokens.get(data.tokenId);
  if (!token) throw new Error(`Token not found: ${data.tokenId}`);
  const id = token.id;
  await token.delete();
  return { ok: true, id, sceneId: scene.id, deleted: true };
}

// ---------------------------------------------------------------------------
// Folders & compendiums
// ---------------------------------------------------------------------------

async function listFolders(data) {
  const type = data.type ?? "Actor";
  return game.folders.filter((f) => f.type === type).map((f) => ({
    id: f.id, name: f.name, type: f.type, folder: f.folder?.id ?? null,
  }));
}

async function listCompendiums(data) {
  const type = data.type ?? "Actor";
  return game.packs.filter((p) => p.documentName === type).map((p) => ({
    id: p.collection, title: p.title, type: p.documentName, locked: p.locked,
  }));
}

async function searchCompendium(data) {
  const { packId, search, limit } = data;
  if (!packId) throw new Error("packId is required");
  const pack = game.packs.get(packId);
  if (!pack) throw new Error(`Compendium not found: ${packId}`);
  const index = await pack.getIndex({ fields: ["name", "type", "img"] });
  let entries = index.map((e) => ({
    id: e._id, name: e.name, type: e.type, img: e.img,
  }));
  if (search) {
    const q = search.toLowerCase();
    entries = entries.filter((e) => e.name.toLowerCase().includes(q));
  }
  if (limit) entries = entries.slice(0, limit);
  return entries;
}

async function getCompendiumEntry(data) {
  const { packId, documentId } = data;
  if (!packId || !documentId) throw new Error("packId and documentId are required");
  const pack = game.packs.get(packId);
  if (!pack) throw new Error(`Compendium not found: ${packId}`);
  const doc = await pack.getDocument(documentId);
  if (!doc) throw new Error(`Document not found: ${documentId}`);
  const preview = {
    id: doc.id,
    name: doc.name,
    type: doc.type,
    img: doc.img,
    documentName: pack.documentName,
    packId,
  };
  if (pack.documentName === "Actor") {
    preview.level = doc.system?.details?.level?.value;
    preview.hp = doc.system?.attributes?.hp;
    preview.ac = doc.system?.attributes?.ac?.value;
    preview.itemCount = doc.items?.size ?? 0;
  }
  if (data.full) preview.data = doc.toObject();
  return { ok: true, entry: preview };
}

async function importFromCompendium(data) {
  const { packId, documentId, name, folder } = data;
  if (!packId || !documentId) throw new Error("packId and documentId are required");
  const pack = game.packs.get(packId);
  if (!pack) throw new Error(`Compendium not found: ${packId}`);
  const source = await pack.getDocument(documentId);
  if (!source) throw new Error(`Document not found: ${documentId}`);
  const docData = source.toObject();
  delete docData._id;
  if (name) docData.name = name;
  const docName = pack.documentName;
  if (folder && VALID_FOLDER_TYPES.has(docName)) {
    docData.folder = await resolveFolderId(folder, docName);
  }
  const doc = await pack.documentClass.create(docData);
  return {
    ok: true,
    imported: true,
    packId,
    documentName: docName,
    id: doc.id,
    name: doc.name,
    type: doc.type ?? docName,
    img: doc.img,
  };
}

// ---------------------------------------------------------------------------
// Journals
// ---------------------------------------------------------------------------

async function listJournals(data) {
  return filterByName(
    game.journal.map((j) => serializeJournal(j)),
    data.name,
  );
}

async function getJournal(data) {
  return serializeJournal(requireDoc(game.journal, data.id, "Journal"), true);
}

async function createJournal(data) {
  const { name, content, pages, folder } = data;
  if (!name) throw new Error("name is required");
  const folderId = await resolveFolderId(folder, "JournalEntry");
  const journalPages = pages ?? [{
    name: data.pageName ?? name,
    type: "text",
    text: { content: content ?? "" },
  }];
  const journal = await JournalEntry.create({ name, folder: folderId });
  if (journalPages.length) {
    await journal.createEmbeddedDocuments("JournalEntryPage", journalPages);
  }
  return { ok: true, ...serializeJournal(journal, true) };
}

async function updateJournal(data) {
  const journal = requireDoc(game.journal, data.id, "Journal");
  const updates = {};
  if (data.name !== undefined) updates.name = data.name;
  if (data.folder !== undefined) {
    updates.folder = await resolveFolderId(data.folder, "JournalEntry");
  }
  if (Object.keys(updates).length) await journal.update(updates);
  if (data.content !== undefined && journal.pages.size) {
    const page = journal.pages.contents[0];
    await page.update({ text: { content: data.content } });
  }
  if (data.pages) {
    for (const pageData of data.pages) {
      if (pageData.id) {
        const page = journal.pages.get(pageData.id);
        if (page) await page.update(pageData);
      } else {
        await journal.createEmbeddedDocuments("JournalEntryPage", [pageData]);
      }
    }
  }
  return { ok: true, ...serializeJournal(journal, true) };
}

async function deleteJournal(data) {
  const journal = requireDoc(game.journal, data.id, "Journal");
  const id = journal.id;
  await journal.delete();
  return { ok: true, id, deleted: true };
}

// ---------------------------------------------------------------------------
// Roll tables
// ---------------------------------------------------------------------------

async function listRollTables(data) {
  return filterByName(game.tables.map((t) => serializeRollTable(t)), data.name);
}

async function getRollTable(data) {
  return serializeRollTable(requireDoc(game.tables, data.id, "RollTable"), true);
}

async function createRollTable(data) {
  const { name, formula, description, results, folder } = data;
  if (!name) throw new Error("name is required");
  const folderId = await resolveFolderId(folder, "RollTable");
  const table = await RollTable.create({
    name,
    formula: formula ?? "1d20",
    description: description ?? "",
    folder: folderId,
  });
  if (results?.length) {
    await table.createEmbeddedDocuments("TableResult", results);
  }
  return { ok: true, ...serializeRollTable(table, true) };
}

async function updateRollTable(data) {
  const table = requireDoc(game.tables, data.id, "RollTable");
  const updates = {};
  for (const key of ["name", "formula", "description"]) {
    if (data[key] !== undefined) updates[key] = data[key];
  }
  if (data.folder !== undefined) {
    updates.folder = await resolveFolderId(data.folder, "RollTable");
  }
  if (Object.keys(updates).length) await table.update(updates);
  if (data.results) {
    for (const result of data.results) {
      if (result.id) {
        const row = table.results.get(result.id);
        if (row) await row.update(result);
      } else {
        await table.createEmbeddedDocuments("TableResult", [result]);
      }
    }
  }
  return { ok: true, ...serializeRollTable(table, true) };
}

async function deleteRollTable(data) {
  const table = requireDoc(game.tables, data.id, "RollTable");
  const id = table.id;
  await table.delete();
  return { ok: true, id, deleted: true };
}

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------

async function listPlaylists(data) {
  return filterByName(game.playlists.map((p) => serializePlaylist(p)), data.name);
}

async function getPlaylist(data) {
  return serializePlaylist(requireDoc(game.playlists, data.id, "Playlist"), true);
}

async function createPlaylist(data) {
  const { name, mode, sounds, folder } = data;
  if (!name) throw new Error("name is required");
  const folderId = await resolveFolderId(folder, "Playlist");
  const playlist = await Playlist.create({
    name,
    mode: mode ?? CONST.PLAYLIST_MODES.SEQUENTIAL,
    folder: folderId,
    sounds: sounds ?? [],
  });
  return { ok: true, ...serializePlaylist(playlist, true) };
}

async function updatePlaylist(data) {
  const playlist = requireDoc(game.playlists, data.id, "Playlist");
  const updates = {};
  for (const key of ["name", "mode", "playing", "channel"]) {
    if (data[key] !== undefined) updates[key] = data[key];
  }
  if (data.folder !== undefined) {
    updates.folder = await resolveFolderId(data.folder, "Playlist");
  }
  if (Object.keys(updates).length) await playlist.update(updates);
  return { ok: true, ...serializePlaylist(playlist, true) };
}

async function deletePlaylist(data) {
  const playlist = requireDoc(game.playlists, data.id, "Playlist");
  const id = playlist.id;
  await playlist.delete();
  return { ok: true, id, deleted: true };
}

async function createPlaylistSound(data) {
  const playlist = requireDoc(game.playlists, data.id ?? data.playlistId, "Playlist");
  const sounds = data.sounds ?? [data.sound ?? data];
  const created = await playlist.createEmbeddedDocuments("PlaylistSound", sounds);
  return { ok: true, sounds: created.map((s) => ({ id: s.id, name: s.name, path: s.path })), playlistId: playlist.id };
}

async function deletePlaylistSound(data) {
  const playlist = requireDoc(game.playlists, data.playlistId, "Playlist");
  const sound = playlist.sounds.get(data.soundId);
  if (!sound) throw new Error(`Sound not found: ${data.soundId}`);
  const id = sound.id;
  await sound.delete();
  return { ok: true, id, playlistId: playlist.id, deleted: true };
}

// ---------------------------------------------------------------------------
// Active effects (on actor)
// ---------------------------------------------------------------------------

async function listActorEffects(data) {
  return requireDoc(game.actors, data.id ?? data.actorId, "Actor").effects.map(serializeActiveEffect);
}

async function createActorEffect(data) {
  const actor = requireDoc(game.actors, data.id ?? data.actorId, "Actor");
  const effects = data.effects ?? [data.effect ?? data];
  const created = await actor.createEmbeddedDocuments("ActiveEffect", effects);
  return { ok: true, effects: created.map(serializeActiveEffect) };
}

async function updateActorEffect(data) {
  const actor = requireDoc(game.actors, data.actorId, "Actor");
  const effect = actor.effects.get(data.effectId);
  if (!effect) throw new Error(`Effect not found: ${data.effectId}`);
  const { effectId, actorId, id, ...updates } = data;
  if (Object.keys(updates).length) await effect.update(updates);
  return { ok: true, effect: serializeActiveEffect(effect) };
}

async function deleteActorEffect(data) {
  const actor = requireDoc(game.actors, data.actorId, "Actor");
  const effect = actor.effects.get(data.effectId);
  if (!effect) throw new Error(`Effect not found: ${data.effectId}`);
  const id = effect.id;
  await effect.delete();
  return { ok: true, id, deleted: true };
}

async function resolveUuid(data) {
  if (!data.uuid) throw new Error("uuid is required");
  const doc = await fromUuid(data.uuid);
  if (!doc) throw new Error(`Document not found: ${data.uuid}`);
  return {
    ok: true,
    uuid: doc.uuid,
    id: doc.id,
    name: doc.name,
    documentName: doc.documentName ?? doc.constructor.documentName,
  };
}

// ---------------------------------------------------------------------------
// Batch encounter
// ---------------------------------------------------------------------------

async function setupEncounter(data) {
  const result = { ok: true, scene: null, actors: [], tokens: [] };

  if (data.scene) {
    result.scene = await createScene(data.scene);
  } else if (data.sceneId) {
    result.scene = serializeScene(requireDoc(game.scenes, data.sceneId, "Scene"));
  }

  const sceneId = result.scene?.id ?? data.sceneId;
  if (!sceneId) throw new Error("scene or sceneId required");

  for (const creature of data.creatures ?? []) {
    let actorResult;
    if (creature.fromCompendium) {
      actorResult = await importActor({
        packId: creature.fromCompendium.packId,
        documentId: creature.fromCompendium.documentId,
        name: creature.name,
        folder: creature.folder,
      });
    } else {
      actorResult = await createActor(creature);
    }
    result.actors.push(actorResult);

    if (creature.token) {
      const tokenResult = await placeToken({
        sceneId,
        actorId: actorResult.id,
        ...creature.token,
      });
      result.tokens.push(tokenResult);
    }
  }

  if (data.activate && result.scene) {
    await activateScene({ id: sceneId });
    result.scene.active = true;
  }

  return result;
}

// ---------------------------------------------------------------------------
// World items
// ---------------------------------------------------------------------------

async function listWorldItems(data) {
  let items = game.items.map(serializeItem);
  if (data.type) items = items.filter((i) => i.type === data.type);
  return filterByName(items, data.name);
}

async function getWorldItem(data) {
  return serializeItem(requireDoc(game.items, data.id, "Item"));
}

async function createWorldItem(data) {
  const { name, type, img, system, folder } = data;
  if (!name) throw new Error("name is required");
  const folderId = await resolveFolderId(folder, "Item");
  const item = await Item.create({
    name,
    type: type ?? "equipment",
    img: img ?? "icons/svg/item-bag.svg",
    folder: folderId,
    system: system ?? {},
  });
  return { ok: true, ...serializeItem(item) };
}

async function updateWorldItem(data) {
  const item = requireDoc(game.items, data.id, "Item");
  const updates = {};
  for (const key of ["name", "type", "img", "system"]) {
    if (data[key] !== undefined) updates[key] = data[key];
  }
  if (data.folder !== undefined) {
    updates.folder = await resolveFolderId(data.folder, "Item");
  }
  if (Object.keys(updates).length) await item.update(updates);
  return { ok: true, ...serializeItem(item) };
}

async function deleteWorldItem(data) {
  const item = requireDoc(game.items, data.id, "Item");
  const id = item.id;
  await item.delete();
  return { ok: true, id, deleted: true };
}

async function createJournalPage(data) {
  const journal = requireDoc(game.journal, data.id ?? data.journalId, "Journal");
  const pages = data.pages ?? [{
    name: data.pageName ?? data.name ?? "Page",
    type: data.pageType ?? "text",
    text: { content: data.content ?? "" },
  }];
  const created = await journal.createEmbeddedDocuments("JournalEntryPage", pages);
  return { ok: true, ...serializeJournal(journal, true), createdPageIds: created.map((p) => p.id) };
}

// ---------------------------------------------------------------------------
// Execute (public Foundry JS in the GM tab)
// ---------------------------------------------------------------------------

const EXECUTE_MAX_CHARS = 20_000;

function serializeExecuteResult(value, depth = 0) {
  if (depth > 4) return String(value);
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (typeof value.then === "function") return "[Promise]";
  if (value.documentName && value.id) {
    return {
      id: value.id,
      uuid: value.uuid,
      name: value.name,
      documentName: value.documentName,
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => serializeExecuteResult(entry, depth + 1));
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

async function executeJs(data) {
  const js = data.js ?? data.code;
  if (!js || typeof js !== "string") throw new Error("js is required");
  if (js.length > EXECUTE_MAX_CHARS) throw new Error(`js exceeds ${EXECUTE_MAX_CHARS} characters`);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction(
    "game", "foundry", "fromUuid", "fromUuidSync", "CONFIG", "canvas", "ui", "Hooks", "Roll",
    "Actor", "Item", "Scene", "JournalEntry", "Folder", "TokenDocument",
    js,
  );
  const result = await fn(
    game, foundry, fromUuid, fromUuidSync, CONFIG, canvas, ui, Hooks, Roll,
    Actor, Item, Scene, JournalEntry, Folder, TokenDocument,
  );
  return { ok: true, result: serializeExecuteResult(result) };
}

// ---------------------------------------------------------------------------
// Obelus entity push
// ---------------------------------------------------------------------------

async function resolveExistingByUuid(uuid, collection) {
  const id = foundryIdFromUuid(uuid);
  if (!id) return null;
  return collection.get(id) ?? null;
}

async function upsertJournalFromEntity(entity, folder) {
  const name = entity.title;
  if (!name) throw new Error("title is required for journal");
  const html = contentToHtml(entity.content);
  const existing = await resolveExistingByUuid(entity.foundryUuid ?? entity.journalUuid, game.journal);
  if (existing) {
    return updateJournal({ id: existing.id, name, content: html, folder });
  }
  return createJournal({ name, content: html, folder, pageName: name });
}

async function pushActorEntity(entity, folder, type) {
  const name = entity.title;
  if (!name) throw new Error("title is required");
  const img = isFoundryAssetPath(entity.img) ? entity.img : undefined;
  const existing = await resolveExistingByUuid(entity.foundryUuid, game.actors);
  const actorType = type === "pc" ? (entity.actorType ?? "character") : (entity.actorType ?? "npc");

  let actorResult;
  if (existing) {
    actorResult = await updateActor({
      id: existing.id,
      name,
      img,
      folder,
      system: entity.system,
    });
  } else {
    const comp = entity.compendium ?? entity.fromCompendium;
    if (comp?.packId && comp?.documentId) {
      actorResult = await importActor({
        packId: comp.packId,
        documentId: comp.documentId,
        name,
        folder,
      });
    } else {
      actorResult = await createActor({
        name,
        type: actorType,
        img,
        folder,
        system: entity.system,
        items: entity.items,
        text: entity.text ?? entity.statblockText ?? entity.statblock_text,
        statblock: entity.statblock,
      });
    }
  }

  let journal = null;
  if (entity.content && !entity.text && !entity.statblock && !entity.statblockText) {
    journal = await createJournal({
      name: `${name} · lore`,
      content: contentToHtml(entity.content),
      folder,
    });
  }

  return {
    kind: "actor",
    foundryUuid: actorResult.uuid ?? `Actor.${actorResult.id}`,
    ...actorResult,
    journal,
  };
}

async function pushItemEntity(entity, folder) {
  const name = entity.title;
  if (!name) throw new Error("title is required");
  const img = isFoundryAssetPath(entity.img) ? entity.img : undefined;
  const existing = await resolveExistingByUuid(entity.foundryUuid, game.items);
  const comp = entity.compendium ?? entity.fromCompendium;

  if (existing) {
    const updated = await updateWorldItem({
      id: existing.id,
      name,
      img,
      folder,
      type: entity.itemType ?? entity.systemType,
      system: entity.system,
    });
    return { kind: "item", foundryUuid: existing.uuid, ...updated };
  }

  if (comp?.packId && comp?.documentId) {
    const imported = await importFromCompendium({
      packId: comp.packId,
      documentId: comp.documentId,
      name,
      folder,
    });
    return { kind: "item", foundryUuid: imported.id ? `${imported.documentName}.${imported.id}` : null, ...imported };
  }

  const created = await createWorldItem({
    name,
    type: entity.itemType ?? "equipment",
    img,
    folder,
    system: entity.system,
  });
  return { kind: "item", foundryUuid: created.uuid, ...created };
}

async function pushLocationEntity(entity, folder) {
  const name = entity.title;
  if (!name) throw new Error("title is required");
  const sceneImg = entity.scene?.img ?? (isFoundryAssetPath(entity.img) ? entity.img : undefined);
  const sceneUuid = entity.sceneUuid
    ?? (String(entity.foundryUuid || "").startsWith("Scene.") ? entity.foundryUuid : null);
  let scene = null;
  if (sceneImg || entity.scene || sceneUuid) {
    const existingScene = await resolveExistingByUuid(sceneUuid, game.scenes);
    if (existingScene) {
      scene = await updateScene({
        id: existingScene.id,
        name,
        img: sceneImg,
        folder,
        width: entity.scene?.width,
        height: entity.scene?.height,
      });
    } else if (sceneImg || entity.scene?.width) {
      scene = await createScene({
        name,
        img: sceneImg,
        folder,
        width: entity.scene?.width,
        height: entity.scene?.height,
        gridSize: entity.scene?.gridSize,
      });
    }
  }

  const journal = entity.content
    ? await upsertJournalFromEntity(
      { ...entity, foundryUuid: scene ? entity.journalUuid : entity.foundryUuid },
      folder,
    )
    : null;

  return {
    kind: scene ? "scene" : "journal",
    foundryUuid: scene?.id ? `Scene.${scene.id}` : (journal?.id ? `JournalEntry.${journal.id}` : null),
    scene,
    journal,
  };
}

async function pushOneObelusEntity(entity, folder) {
  const type = String(entity.type || "").toLowerCase();
  const kind = mapObelusType(type);
  if (kind === "actor") return pushActorEntity(entity, folder, type);
  if (kind === "item") return pushItemEntity(entity, folder);
  if (kind === "location") return pushLocationEntity(entity, folder);
  const journal = await upsertJournalFromEntity(entity, folder);
  return {
    kind: "journal",
    foundryUuid: journal.uuid ?? (journal.id ? `JournalEntry.${journal.id}` : null),
    ...journal,
  };
}

async function pushObelus(data) {
  const folder = data.folder ?? null;
  const entities = data.entities;
  if (!Array.isArray(entities) || entities.length === 0) {
    throw new Error("entities array is required");
  }
  if (folder) {
    for (const folderType of PUSH_FOLDER_TYPES) {
      await resolveFolderId(folder, folderType);
    }
  }

  const results = [];
  for (const entity of entities) {
    try {
      const pushed = await pushOneObelusEntity(entity, folder);
      results.push({
        ok: true,
        obelusId: entity.obelusId ?? entity.id ?? null,
        type: entity.type,
        title: entity.title,
        kind: pushed.kind,
        foundryUuid: pushed.foundryUuid,
        id: pushed.id ?? null,
        journalId: pushed.journal?.id ?? null,
        sceneId: pushed.scene?.id ?? null,
      });
    } catch (err) {
      results.push({
        ok: false,
        obelusId: entity.obelusId ?? entity.id ?? null,
        type: entity.type,
        title: entity.title,
        error: err.message ?? String(err),
      });
    }
  }

  return {
    ok: results.every((r) => r.ok),
    folder,
    created: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

// ---------------------------------------------------------------------------
// Action router
// ---------------------------------------------------------------------------

async function handleAction(action, data) {
  switch (action) {
    case "ping":
      return { ok: true, foundry: game.version, world: game.world?.id,
        system: game.system?.id, user: game.user?.name };

    case "resolve_uuid":
      return resolveUuid(data);

    // Scenes
    case "list_scenes":
      return filterByName(game.scenes.map((s) => serializeScene(s)), data.name);
    case "get_scene":
      return serializeScene(requireDoc(game.scenes, data.id, "Scene"), true);
    case "create_scene":
      return createScene(data);
    case "update_scene":
      return updateScene(data);
    case "delete_scene":
      return deleteScene(data);
    case "activate_scene":
      return activateScene(data);
    case "duplicate_scene":
      return duplicateScene(data);
    case "list_scene_tokens":
      return requireDoc(game.scenes, data.id, "Scene").tokens.map(serializeToken);
    case "list_scene_walls":
      return listSceneWalls(data);
    case "create_scene_wall":
      return createSceneWall(data);
    case "update_scene_wall":
      return updateSceneWall(data);
    case "delete_scene_wall":
      return deleteSceneWall(data);
    case "list_scene_lights":
      return listSceneLights(data);
    case "create_scene_light":
      return createSceneLight(data);
    case "update_scene_light":
      return updateSceneLight(data);
    case "delete_scene_light":
      return deleteSceneLight(data);
    case "list_scene_tiles":
      return listSceneTiles(data);
    case "create_scene_tile":
      return createSceneTile(data);
    case "update_scene_tile":
      return updateSceneTile(data);
    case "delete_scene_tile":
      return deleteSceneTile(data);
    case "list_scene_notes":
      return listSceneNotes(data);
    case "create_scene_note":
      return createSceneNote(data);
    case "update_scene_note":
      return updateSceneNote(data);
    case "delete_scene_note":
      return deleteSceneNote(data);

    // Actors
    case "list_actors": {
      let actors = game.actors.map((a) => serializeActor(a));
      if (data.type) actors = actors.filter((a) => a.type === data.type);
      return filterByName(actors, data.name);
    }
    case "get_actor":
      return serializeActor(requireDoc(game.actors, data.id, "Actor"), data.detailed !== false);
    case "create_actor":
      return createActor(data);
    case "import_actor":
      return importActor(data);
    case "update_actor":
      return updateActor(data);
    case "delete_actor":
      return deleteActor(data);
    case "list_actor_items":
      return requireDoc(game.actors, data.id, "Actor").items.map(serializeItem);
    case "create_actor_item":
      return createActorItem({ ...data, actorId: data.id ?? data.actorId });
    case "update_actor_item":
      return updateActorItem({ ...data, actorId: data.id ?? data.actorId });
    case "delete_actor_item":
      return deleteActorItem({ ...data, actorId: data.id ?? data.actorId });

    // Active effects
    case "list_actor_effects":
      return listActorEffects(data);
    case "create_actor_effect":
      return createActorEffect({ ...data, actorId: data.id ?? data.actorId });
    case "update_actor_effect":
      return updateActorEffect(data);
    case "delete_actor_effect":
      return deleteActorEffect(data);

    // Tokens
    case "place_token":
      return placeToken(data);
    case "update_token":
      return updateToken(data);
    case "delete_token":
      return deleteToken(data);

    // Folders & compendiums
    case "list_folders":
      return listFolders(data);
    case "create_folder":
      return createFolder(data);
    case "update_folder":
      return updateFolder(data);
    case "delete_folder":
      return deleteFolder(data);
    case "upload_file":
      return uploadFile(data);
    case "list_compendiums":
      return listCompendiums(data);
    case "search_compendium":
      return searchCompendium(data);
    case "get_compendium_entry":
      return getCompendiumEntry(data);
    case "import_compendium":
      return importFromCompendium(data);

    // Journals
    case "list_journals":
      return listJournals(data);
    case "get_journal":
      return getJournal(data);
    case "create_journal":
      return createJournal(data);
    case "update_journal":
      return updateJournal(data);
    case "delete_journal":
      return deleteJournal(data);
    case "create_journal_page":
      return createJournalPage(data);

    // Roll tables
    case "list_roll_tables":
      return listRollTables(data);
    case "get_roll_table":
      return getRollTable(data);
    case "create_roll_table":
      return createRollTable(data);
    case "update_roll_table":
      return updateRollTable(data);
    case "delete_roll_table":
      return deleteRollTable(data);

    // Playlists
    case "list_playlists":
      return listPlaylists(data);
    case "get_playlist":
      return getPlaylist(data);
    case "create_playlist":
      return createPlaylist(data);
    case "update_playlist":
      return updatePlaylist(data);
    case "delete_playlist":
      return deletePlaylist(data);
    case "create_playlist_sound":
      return createPlaylistSound(data);
    case "delete_playlist_sound":
      return deletePlaylistSound(data);

    // World items
    case "list_items":
      return listWorldItems(data);
    case "get_item":
      return getWorldItem(data);
    case "create_item":
      return createWorldItem(data);
    case "update_item":
      return updateWorldItem(data);
    case "delete_item":
      return deleteWorldItem(data);

    // Batch
    case "setup_encounter":
      return setupEncounter(data);
    case "push_obelus":
      return pushObelus(data);
    case "execute":
      return executeJs(data);

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

Hooks.once("init", () => {
  log("info", "Initializing v1.5");
  registerSettings();
});

Hooks.once("ready", () => {
  if (!game.user?.isGM) return;
  notifyGM("Hermes Bridge v1.5 — connecting…", "info");
  setTimeout(() => connect(), 1500);
});

Hooks.on("canvasReady", () => {
  if (game.user?.isGM && isEnabled() && !connected) scheduleReconnect(1000);
});
