#!/usr/bin/env python3
"""Hermes Bridge Relay v1.5 — WebSocket ↔ REST bridge for Foundry VTT."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import shlex
import uuid
from typing import Any, Awaitable, Callable

from aiohttp import web

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("hermes-relay")

HERMES_KEY = os.environ.get("HERMES_KEY", "hermes-foundry-bridge-key-2026")
WS_PORT = int(os.environ.get("HERMES_WS_PORT", "9997"))
HTTP_PORT = int(os.environ.get("HERMES_HTTP_PORT", "9998"))
BIND = os.environ.get("HERMES_BIND", "0.0.0.0")
REQUEST_TIMEOUT = float(os.environ.get("HERMES_REQUEST_TIMEOUT", "30"))
FOUNDRY_SSH = os.environ.get("HERMES_FOUNDRY_SSH", "root@foundry-host")
FOUNDRY_CT = os.environ.get("HERMES_FOUNDRY_CT", "200")
FOUNDRY_UPLOADS = os.environ.get("HERMES_FOUNDRY_UPLOADS", "/mnt/data/foundry/Data/uploads")
UPLOAD_MODE = os.environ.get("HERMES_UPLOAD_MODE", "auto")  # foundry | ssh | auto
FOUNDRY_SSH_PASS = os.environ.get("HERMES_FOUNDRY_SSH_PASS", "")
FOUNDRY_UPLOAD_OWNER = os.environ.get("HERMES_FOUNDRY_UPLOAD_OWNER", "1000:1000")

async def upload_via_ssh(name: str, raw: bytes) -> dict[str, Any]:
    safe = name.replace("..", "").lstrip("/")
    remote_path = f"{FOUNDRY_UPLOADS}/{safe}"
    remote_dir = os.path.dirname(remote_path)
    data_b64 = base64.b64encode(raw).decode()
    inner = (
        f"mkdir -p {shlex.quote(remote_dir)} && "
        f"echo {shlex.quote(data_b64)} | base64 -d > {shlex.quote(remote_path)} && "
        f"chown {FOUNDRY_UPLOAD_OWNER} {shlex.quote(remote_path)}"
    )
    remote_cmd = f"pct exec {FOUNDRY_CT} -- bash -c {shlex.quote(inner)}"
    if FOUNDRY_SSH_PASS:
        cmd = (
            f"sshpass -p {shlex.quote(FOUNDRY_SSH_PASS)} ssh -o StrictHostKeyChecking=no "
            f"{FOUNDRY_SSH} {shlex.quote(remote_cmd)}"
        )
    else:
        cmd = (
            f"ssh -o BatchMode=yes -o StrictHostKeyChecking=no {FOUNDRY_SSH} "
            f"{shlex.quote(remote_cmd)}"
        )
    proc = await asyncio.create_subprocess_shell(
        cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        err = (stderr or stdout).decode().strip()
        raise RuntimeError(err or f"SSH upload failed (exit {proc.returncode})")
    url = f"uploads/{safe}"
    log.info("SSH upload OK: %s", url)
    return {"ok": True, "url": url, "path": url, "method": "ssh"}


async def upload_file(body: dict[str, Any]) -> dict[str, Any]:
    name = body.get("name")
    data_b64 = body.get("data")
    if not name:
        raise ValueError("name is required")
    if not data_b64:
        raise ValueError("data (base64) is required")
    raw = base64.b64decode(data_b64)

    if UPLOAD_MODE == "ssh":
        return await upload_via_ssh(name, raw)

    if UPLOAD_MODE == "foundry":
        return await send_to_foundry("upload_file", body)

    try:
        return await asyncio.wait_for(send_to_foundry("upload_file", body), timeout=15)
    except Exception as exc:
        log.warning("Foundry upload failed (%s), trying SSH fallback", exc)
        return await upload_via_ssh(name, raw)


foundry_ws: web.WebSocketResponse | None = None
foundry_meta: dict[str, Any] = {}
pending: dict[str, asyncio.Future] = {}


def auth_ok(request: web.Request) -> bool:
    return request.headers.get("x-hermes-key", "") == HERMES_KEY


def json_response(data: Any, status: int = 200) -> web.Response:
    return web.Response(text=json.dumps(data), status=status, content_type="application/json")


def error_response(message: str, status: int = 400) -> web.Response:
    return json_response({"ok": False, "error": message}, status=status)


async def require_foundry() -> None:
    if foundry_ws is None or foundry_ws.closed:
        raise web.HTTPServiceUnavailable(
            text=json.dumps({"ok": False, "error": "Foundry not connected"}),
            content_type="application/json",
        )


async def send_to_foundry(action: str, data: dict | None = None, *, timeout: float | None = None) -> Any:
    await require_foundry()
    request_id = str(uuid.uuid4())
    future: asyncio.Future = asyncio.get_running_loop().create_future()
    pending[request_id] = future
    await foundry_ws.send_str(json.dumps({"type": "request", "id": request_id, "action": action, "data": data or {}}))
    wait = timeout if timeout is not None else REQUEST_TIMEOUT
    try:
        return await asyncio.wait_for(future, timeout=wait)
    except asyncio.TimeoutError:
        pending.pop(request_id, None)
        raise web.HTTPGatewayTimeout(
            text=json.dumps({"ok": False, "error": "Foundry request timed out"}),
            content_type="application/json",
        )


def resolve_pending(msg: dict) -> None:
    request_id = msg.get("id")
    if not request_id:
        return
    future = pending.pop(request_id, None)
    if future is None or future.done():
        return
    if msg.get("ok"):
        future.set_result(msg.get("data"))
    else:
        future.set_exception(RuntimeError(msg.get("error") or "Unknown Foundry error"))


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------


async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    global foundry_ws, foundry_meta
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)
    if foundry_ws is not None and not foundry_ws.closed:
        await foundry_ws.close()
    foundry_ws = ws
    foundry_meta = {}
    log.info("Foundry WebSocket connected from %s", request.remote)
    try:
        async for msg in ws:
            if msg.type != web.WSMsgType.TEXT:
                continue
            try:
                data = json.loads(msg.data)
            except json.JSONDecodeError:
                continue
            msg_type = data.get("type")
            if msg_type == "register":
                if data.get("key") != HERMES_KEY:
                    await ws.close()
                    return ws
                foundry_meta = {"world": data.get("world"), "foundry": data.get("foundry"), "user": data.get("user")}
                await ws.send_str(json.dumps({"type": "registered", "ok": True}))
            elif msg_type == "heartbeat":
                await ws.send_str(json.dumps({"type": "pong"}))
            elif msg_type == "response":
                resolve_pending(data)
    finally:
        if foundry_ws is ws:
            foundry_ws = None
            foundry_meta = {}
        for request_id, future in list(pending.items()):
            if not future.done():
                future.set_exception(RuntimeError("Foundry disconnected"))
            pending.pop(request_id, None)
    return ws


# ---------------------------------------------------------------------------
# REST helpers
# ---------------------------------------------------------------------------


async def _parse_body(request: web.Request) -> dict:
    if request.body_exists:
        try:
            return await request.json()
        except json.JSONDecodeError:
            raise ValueError("Invalid JSON body")
    return {}


def foundry_route(
    action: str,
    *,
    id_key: str = "id",
    id_param: str | None = None,
    wrap: str | None = None,
    body: bool = True,
    query: bool = False,
) -> Callable[[web.Request], Awaitable[web.Response]]:
    async def handler(request: web.Request) -> web.Response:
        if not auth_ok(request):
            return error_response("Unauthorized", 401)
        try:
            data: dict[str, Any] = {}
            if query:
                data.update(dict(request.query))
            if id_param:
                data[id_key] = request.match_info[id_param]
            if body and request.method in ("POST", "PATCH", "PUT"):
                data.update(await _parse_body(request))
            result = await send_to_foundry(action, data)
            if isinstance(result, dict) and result.get("ok") is not None:
                return json_response(result)
            if wrap:
                return json_response({"ok": True, wrap: result})
            return json_response(result if isinstance(result, dict) else {"ok": True, "data": result})
        except web.HTTPException:
            raise
        except ValueError as exc:
            return error_response(str(exc))
        except Exception as exc:
            return error_response(str(exc), 502)

    return handler


async def handle_ping(request: web.Request) -> web.Response:
    if not auth_ok(request):
        return error_response("Unauthorized", 401)
    if foundry_ws is None or foundry_ws.closed:
        return json_response({"ok": False, "error": "Foundry not connected", "relay": True}, status=503)
    try:
        data = await send_to_foundry("ping")
        return json_response({"ok": True, **data, **foundry_meta})
    except web.HTTPException:
        raise
    except Exception as exc:
        return error_response(str(exc), 502)


async def handle_status(request: web.Request) -> web.Response:
    return json_response({
        "relay": True,
        "version": "1.5.0",
        "foundry_connected": foundry_ws is not None and not foundry_ws.closed,
        "foundry": foundry_meta,
        "pending_requests": len(pending),
    })


def register_routes(app: web.Application, prefix: str = "") -> None:
    p = prefix
    r = app.router

    r.add_get(f"{p}/ping", handle_ping)
    r.add_get(f"{p}/status", handle_status)

    async def uuid_handler(request: web.Request) -> web.Response:
        if not auth_ok(request):
            return error_response("Unauthorized", 401)
        try:
            result = await send_to_foundry("resolve_uuid", {"uuid": request.match_info["uuid"]})
            return json_response(result)
        except Exception as exc:
            return error_response(str(exc), 502)

    r.add_get(f"{p}/uuid/{{uuid}}", uuid_handler)

    # Scenes
    r.add_get(f"{p}/scenes", foundry_route("list_scenes", body=False, query=True, wrap="scenes"))
    r.add_get(f"{p}/scene/{{scene_id}}", foundry_route("get_scene", id_param="scene_id", body=False, wrap="scene"))
    r.add_post(f"{p}/scene", foundry_route("create_scene"))
    r.add_patch(f"{p}/scene/{{scene_id}}", foundry_route("update_scene", id_param="scene_id"))
    r.add_put(f"{p}/scene/{{scene_id}}", foundry_route("update_scene", id_param="scene_id"))
    r.add_delete(f"{p}/scene/{{scene_id}}", foundry_route("delete_scene", id_param="scene_id", body=False))
    r.add_post(f"{p}/scene/{{scene_id}}/activate", foundry_route("activate_scene", id_param="scene_id"))
    r.add_get(f"{p}/scene/{{scene_id}}/tokens", foundry_route("list_scene_tokens", id_param="scene_id", body=False, wrap="tokens"))
    r.add_post(f"{p}/scene/{{scene_id}}/duplicate", foundry_route("duplicate_scene", id_param="scene_id"))

    def scene_embedded_list(action: str, wrap: str, id_param: str = "scene_id"):
        async def handler(request: web.Request) -> web.Response:
            if not auth_ok(request):
                return error_response("Unauthorized", 401)
            try:
                result = await send_to_foundry(action, {"id": request.match_info[id_param]})
                return json_response({"ok": True, wrap: result})
            except Exception as exc:
                return error_response(str(exc), 502)
        return handler

    def scene_embedded_create(action: str, id_key: str, id_param: str = "scene_id"):
        async def handler(request: web.Request) -> web.Response:
            if not auth_ok(request):
                return error_response("Unauthorized", 401)
            try:
                data = await _parse_body(request)
                data[id_key] = request.match_info[id_param]
                result = await send_to_foundry(action, data)
                return json_response(result)
            except Exception as exc:
                return error_response(str(exc), 502)
        return handler

    def scene_embedded_mutate(action: str, id_param: str, child_param: str, child_key: str):
        async def handler(request: web.Request) -> web.Response:
            if not auth_ok(request):
                return error_response("Unauthorized", 401)
            try:
                data = await _parse_body(request) if request.method in ("POST", "PATCH", "PUT") else {}
                data["sceneId"] = request.match_info[id_param]
                data[child_key] = request.match_info[child_param]
                result = await send_to_foundry(action, data)
                return json_response(result)
            except Exception as exc:
                return error_response(str(exc), 502)
        return handler

    r.add_get(f"{p}/scene/{{scene_id}}/walls", scene_embedded_list("list_scene_walls", "walls"))
    r.add_post(f"{p}/scene/{{scene_id}}/wall", scene_embedded_create("create_scene_wall", "sceneId"))
    r.add_patch(f"{p}/scene/{{scene_id}}/wall/{{wall_id}}", scene_embedded_mutate("update_scene_wall", "scene_id", "wall_id", "wallId"))
    r.add_delete(f"{p}/scene/{{scene_id}}/wall/{{wall_id}}", scene_embedded_mutate("delete_scene_wall", "scene_id", "wall_id", "wallId"))

    r.add_get(f"{p}/scene/{{scene_id}}/lights", scene_embedded_list("list_scene_lights", "lights"))
    r.add_post(f"{p}/scene/{{scene_id}}/light", scene_embedded_create("create_scene_light", "sceneId"))
    r.add_patch(f"{p}/scene/{{scene_id}}/light/{{light_id}}", scene_embedded_mutate("update_scene_light", "scene_id", "light_id", "lightId"))
    r.add_delete(f"{p}/scene/{{scene_id}}/light/{{light_id}}", scene_embedded_mutate("delete_scene_light", "scene_id", "light_id", "lightId"))

    r.add_get(f"{p}/scene/{{scene_id}}/tiles", scene_embedded_list("list_scene_tiles", "tiles"))
    r.add_post(f"{p}/scene/{{scene_id}}/tile", scene_embedded_create("create_scene_tile", "sceneId"))
    r.add_patch(f"{p}/scene/{{scene_id}}/tile/{{tile_id}}", scene_embedded_mutate("update_scene_tile", "scene_id", "tile_id", "tileId"))
    r.add_delete(f"{p}/scene/{{scene_id}}/tile/{{tile_id}}", scene_embedded_mutate("delete_scene_tile", "scene_id", "tile_id", "tileId"))

    r.add_get(f"{p}/scene/{{scene_id}}/notes", scene_embedded_list("list_scene_notes", "notes"))
    r.add_post(f"{p}/scene/{{scene_id}}/note", scene_embedded_create("create_scene_note", "sceneId"))
    r.add_patch(f"{p}/scene/{{scene_id}}/note/{{note_id}}", scene_embedded_mutate("update_scene_note", "scene_id", "note_id", "noteId"))
    r.add_delete(f"{p}/scene/{{scene_id}}/note/{{note_id}}", scene_embedded_mutate("delete_scene_note", "scene_id", "note_id", "noteId"))

    r.add_post(f"{p}/scene/{{scene_id}}/token", foundry_route("place_token", id_key="sceneId", id_param="scene_id"))

    async def token_patch(request: web.Request) -> web.Response:
        if not auth_ok(request):
            return error_response("Unauthorized", 401)
        try:
            data = await _parse_body(request)
            data["sceneId"] = request.match_info["scene_id"]
            data["tokenId"] = request.match_info["token_id"]
            result = await send_to_foundry("update_token", data)
            return json_response(result)
        except Exception as exc:
            return error_response(str(exc), 502)

    async def token_delete(request: web.Request) -> web.Response:
        if not auth_ok(request):
            return error_response("Unauthorized", 401)
        try:
            result = await send_to_foundry("delete_token", {
                "sceneId": request.match_info["scene_id"],
                "tokenId": request.match_info["token_id"],
            })
            return json_response(result)
        except Exception as exc:
            return error_response(str(exc), 502)

    r.add_patch(f"{p}/scene/{{scene_id}}/token/{{token_id}}", token_patch)
    r.add_delete(f"{p}/scene/{{scene_id}}/token/{{token_id}}", token_delete)

    # Actors
    r.add_get(f"{p}/actors", foundry_route("list_actors", body=False, query=True, wrap="actors"))
    r.add_get(f"{p}/actor/{{actor_id}}", foundry_route("get_actor", id_param="actor_id", body=False, wrap="actor"))
    r.add_post(f"{p}/actor", foundry_route("create_actor"))
    r.add_post(f"{p}/actor/import", foundry_route("import_actor"))
    r.add_patch(f"{p}/actor/{{actor_id}}", foundry_route("update_actor", id_param="actor_id"))
    r.add_put(f"{p}/actor/{{actor_id}}", foundry_route("update_actor", id_param="actor_id"))
    r.add_delete(f"{p}/actor/{{actor_id}}", foundry_route("delete_actor", id_param="actor_id", body=False))
    r.add_get(f"{p}/actor/{{actor_id}}/items", foundry_route("list_actor_items", id_param="actor_id", body=False, wrap="items"))

    async def item_create(request: web.Request) -> web.Response:
        if not auth_ok(request):
            return error_response("Unauthorized", 401)
        try:
            data = await _parse_body(request)
            data["id"] = request.match_info["actor_id"]
            result = await send_to_foundry("create_actor_item", data)
            return json_response(result)
        except Exception as exc:
            return error_response(str(exc), 502)

    async def item_patch(request: web.Request) -> web.Response:
        if not auth_ok(request):
            return error_response("Unauthorized", 401)
        try:
            data = await _parse_body(request)
            data["id"] = request.match_info["actor_id"]
            data["itemId"] = request.match_info["item_id"]
            result = await send_to_foundry("update_actor_item", data)
            return json_response(result)
        except Exception as exc:
            return error_response(str(exc), 502)

    async def item_delete(request: web.Request) -> web.Response:
        if not auth_ok(request):
            return error_response("Unauthorized", 401)
        try:
            result = await send_to_foundry("delete_actor_item", {
                "id": request.match_info["actor_id"],
                "itemId": request.match_info["item_id"],
            })
            return json_response(result)
        except Exception as exc:
            return error_response(str(exc), 502)

    r.add_post(f"{p}/actor/{{actor_id}}/item", item_create)
    r.add_patch(f"{p}/actor/{{actor_id}}/item/{{item_id}}", item_patch)
    r.add_delete(f"{p}/actor/{{actor_id}}/item/{{item_id}}", item_delete)

    async def effect_create(request: web.Request) -> web.Response:
        if not auth_ok(request):
            return error_response("Unauthorized", 401)
        try:
            data = await _parse_body(request)
            data["id"] = request.match_info["actor_id"]
            result = await send_to_foundry("create_actor_effect", data)
            return json_response(result)
        except Exception as exc:
            return error_response(str(exc), 502)

    async def effect_patch(request: web.Request) -> web.Response:
        if not auth_ok(request):
            return error_response("Unauthorized", 401)
        try:
            data = await _parse_body(request)
            data["actorId"] = request.match_info["actor_id"]
            data["effectId"] = request.match_info["effect_id"]
            result = await send_to_foundry("update_actor_effect", data)
            return json_response(result)
        except Exception as exc:
            return error_response(str(exc), 502)

    async def effect_delete(request: web.Request) -> web.Response:
        if not auth_ok(request):
            return error_response("Unauthorized", 401)
        try:
            result = await send_to_foundry("delete_actor_effect", {
                "actorId": request.match_info["actor_id"],
                "effectId": request.match_info["effect_id"],
            })
            return json_response(result)
        except Exception as exc:
            return error_response(str(exc), 502)

    r.add_get(f"{p}/actor/{{actor_id}}/effects", foundry_route("list_actor_effects", id_param="actor_id", body=False, wrap="effects"))
    r.add_post(f"{p}/actor/{{actor_id}}/effect", effect_create)
    r.add_patch(f"{p}/actor/{{actor_id}}/effect/{{effect_id}}", effect_patch)
    r.add_delete(f"{p}/actor/{{actor_id}}/effect/{{effect_id}}", effect_delete)

    # Folders & compendiums
    r.add_get(f"{p}/folders", foundry_route("list_folders", body=False, query=True, wrap="folders"))
    r.add_post(f"{p}/folder", foundry_route("create_folder"))
    r.add_patch(f"{p}/folder/{{folder_id}}", foundry_route("update_folder", id_param="folder_id"))
    r.add_delete(f"{p}/folder/{{folder_id}}", foundry_route("delete_folder", id_param="folder_id", body=False))

    async def handle_upload(request: web.Request) -> web.Response:
        if not auth_ok(request):
            return error_response("Unauthorized", 401)
        try:
            body = await _parse_body(request)
            if body.get("path") and not body.get("data"):
                from pathlib import Path
                local = Path(body["path"])
                if not local.is_file():
                    return error_response(f"Local path not found: {body['path']}", 404)
                body["data"] = base64.b64encode(local.read_bytes()).decode()
                body.setdefault("name", local.name)
            result = await upload_file(body)
            return json_response(result)
        except web.HTTPException:
            raise
        except ValueError as exc:
            return error_response(str(exc))
        except Exception as exc:
            return error_response(str(exc), 502)

    r.add_post(f"{p}/upload", handle_upload)
    r.add_get(f"{p}/compendiums", foundry_route("list_compendiums", body=False, query=True, wrap="compendiums"))

    async def compendium_search(request: web.Request) -> web.Response:
        if not auth_ok(request):
            return error_response("Unauthorized", 401)
        try:
            data = dict(request.query)
            data["packId"] = request.match_info["pack_id"]
            result = await send_to_foundry("search_compendium", data)
            return json_response({"ok": True, "entries": result})
        except Exception as exc:
            return error_response(str(exc), 502)

    r.add_get(f"{p}/compendium/{{pack_id}}/entries", compendium_search)

    async def compendium_entry(request: web.Request) -> web.Response:
        if not auth_ok(request):
            return error_response("Unauthorized", 401)
        try:
            data = dict(request.query)
            data["packId"] = request.match_info["pack_id"]
            data["documentId"] = request.match_info["document_id"]
            result = await send_to_foundry("get_compendium_entry", data)
            return json_response(result)
        except Exception as exc:
            return error_response(str(exc), 502)

    async def compendium_import(request: web.Request) -> web.Response:
        if not auth_ok(request):
            return error_response("Unauthorized", 401)
        try:
            data = await _parse_body(request)
            data["packId"] = request.match_info["pack_id"]
            result = await send_to_foundry("import_compendium", data)
            return json_response(result)
        except Exception as exc:
            return error_response(str(exc), 502)

    r.add_get(f"{p}/compendium/{{pack_id}}/entry/{{document_id}}", compendium_entry)
    r.add_post(f"{p}/compendium/{{pack_id}}/import", compendium_import)

    # Journals
    r.add_get(f"{p}/journals", foundry_route("list_journals", body=False, query=True, wrap="journals"))
    r.add_get(f"{p}/journal/{{journal_id}}", foundry_route("get_journal", id_param="journal_id", body=False, wrap="journal"))
    r.add_post(f"{p}/journal", foundry_route("create_journal"))
    r.add_patch(f"{p}/journal/{{journal_id}}", foundry_route("update_journal", id_param="journal_id"))
    r.add_delete(f"{p}/journal/{{journal_id}}", foundry_route("delete_journal", id_param="journal_id", body=False))
    r.add_post(f"{p}/journal/{{journal_id}}/page", foundry_route("create_journal_page", id_param="journal_id"))

    # Roll tables
    r.add_get(f"{p}/tables", foundry_route("list_roll_tables", body=False, query=True, wrap="tables"))
    r.add_get(f"{p}/table/{{table_id}}", foundry_route("get_roll_table", id_param="table_id", body=False, wrap="table"))
    r.add_post(f"{p}/table", foundry_route("create_roll_table"))
    r.add_patch(f"{p}/table/{{table_id}}", foundry_route("update_roll_table", id_param="table_id"))
    r.add_delete(f"{p}/table/{{table_id}}", foundry_route("delete_roll_table", id_param="table_id", body=False))

    # Playlists
    r.add_get(f"{p}/playlists", foundry_route("list_playlists", body=False, query=True, wrap="playlists"))
    r.add_get(f"{p}/playlist/{{playlist_id}}", foundry_route("get_playlist", id_param="playlist_id", body=False, wrap="playlist"))
    r.add_post(f"{p}/playlist", foundry_route("create_playlist"))
    r.add_patch(f"{p}/playlist/{{playlist_id}}", foundry_route("update_playlist", id_param="playlist_id"))
    r.add_delete(f"{p}/playlist/{{playlist_id}}", foundry_route("delete_playlist", id_param="playlist_id", body=False))

    async def playlist_sound_create(request: web.Request) -> web.Response:
        if not auth_ok(request):
            return error_response("Unauthorized", 401)
        try:
            data = await _parse_body(request)
            data["id"] = request.match_info["playlist_id"]
            result = await send_to_foundry("create_playlist_sound", data)
            return json_response(result)
        except Exception as exc:
            return error_response(str(exc), 502)

    async def playlist_sound_delete(request: web.Request) -> web.Response:
        if not auth_ok(request):
            return error_response("Unauthorized", 401)
        try:
            result = await send_to_foundry("delete_playlist_sound", {
                "playlistId": request.match_info["playlist_id"],
                "soundId": request.match_info["sound_id"],
            })
            return json_response(result)
        except Exception as exc:
            return error_response(str(exc), 502)

    r.add_post(f"{p}/playlist/{{playlist_id}}/sound", playlist_sound_create)
    r.add_delete(f"{p}/playlist/{{playlist_id}}/sound/{{sound_id}}", playlist_sound_delete)

    # World items
    r.add_get(f"{p}/items", foundry_route("list_items", body=False, query=True, wrap="items"))
    r.add_get(f"{p}/item/{{item_id}}", foundry_route("get_item", id_param="item_id", body=False, wrap="item"))
    r.add_post(f"{p}/item", foundry_route("create_item"))
    r.add_patch(f"{p}/item/{{item_id}}", foundry_route("update_item", id_param="item_id"))
    r.add_delete(f"{p}/item/{{item_id}}", foundry_route("delete_item", id_param="item_id", body=False))

    # Batch encounter, Obelus push, JS execute
    r.add_post(f"{p}/encounter", foundry_route("setup_encounter"))

    async def handle_push_obelus(request: web.Request) -> web.Response:
        if not auth_ok(request):
            return error_response("Unauthorized", 401)
        try:
            data = await _parse_body(request)
            result = await send_to_foundry("push_obelus", data, timeout=120)
            return json_response(result)
        except web.HTTPException:
            raise
        except Exception as exc:
            return error_response(str(exc), 502)

    async def handle_execute(request: web.Request) -> web.Response:
        if not auth_ok(request):
            return error_response("Unauthorized", 401)
        try:
            data = await _parse_body(request)
            result = await send_to_foundry("execute", data, timeout=60)
            return json_response(result)
        except web.HTTPException:
            raise
        except Exception as exc:
            return error_response(str(exc), 502)

    r.add_post(f"{p}/push-obelus", handle_push_obelus)
    r.add_post(f"{p}/execute", handle_execute)


def create_app() -> web.Application:
    app = web.Application()
    app.router.add_get("/", ws_handler)
    app.router.add_get("/ws", ws_handler)
    register_routes(app, "")
    register_routes(app, "/api/hermes")
    return app


async def start_servers() -> None:
    app = create_app()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, BIND, HTTP_PORT)
    await site.start()
    log.info("Hermes relay v1.5 on http://%s:%s", BIND, HTTP_PORT)
    if WS_PORT != HTTP_PORT:
        ws_runner = web.AppRunner(app)
        await ws_runner.setup()
        await web.TCPSite(ws_runner, BIND, WS_PORT).start()
        log.info("WebSocket also on ws://%s:%s/ws", BIND, WS_PORT)
    await asyncio.Event().wait()


def main() -> None:
    try:
        asyncio.run(start_servers())
    except KeyboardInterrupt:
        log.info("Shutting down")


if __name__ == "__main__":
    main()
