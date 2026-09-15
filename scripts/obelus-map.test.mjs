import test from "node:test";
import assert from "node:assert/strict";
import {
  mapObelusType,
  isFoundryAssetPath,
  foundryIdFromUuid,
  contentToHtml,
  contentLooksLikeHtml,
} from "./obelus-map.mjs";

test("mapObelusType routes npc/pc to actor", () => {
  assert.equal(mapObelusType("npc"), "actor");
  assert.equal(mapObelusType("PC"), "actor");
});

test("mapObelusType routes items and lore types", () => {
  assert.equal(mapObelusType("item"), "item");
  assert.equal(mapObelusType("location"), "location");
  assert.equal(mapObelusType("handout"), "journal");
  assert.equal(mapObelusType("faction"), "journal");
  assert.equal(mapObelusType("quest"), "journal");
  assert.equal(mapObelusType("unknown"), "journal");
});

test("isFoundryAssetPath accepts Data-relative paths only", () => {
  assert.equal(isFoundryAssetPath("uploads/map.png"), true);
  assert.equal(isFoundryAssetPath("icons/svg/mystery-man.svg"), true);
  assert.equal(isFoundryAssetPath("/api/uploads/portrait.webp"), false);
  assert.equal(isFoundryAssetPath("https://obelus.example/x.png"), false);
});

test("foundryIdFromUuid returns the last id segment", () => {
  assert.equal(foundryIdFromUuid("Actor.abcdefghijklmnop"), "abcdefghijklmnop");
  assert.equal(foundryIdFromUuid("Compendium.pf2e.bestiary.Actor.abcdefghijklmnop"), "abcdefghijklmnop");
  assert.equal(foundryIdFromUuid(""), null);
});

test("contentToHtml wraps markdown-like text and keeps HTML", () => {
  assert.equal(contentLooksLikeHtml("<p>Hi</p>"), true);
  assert.equal(contentToHtml("<h2>Notes</h2>"), "<h2>Notes</h2>");
  assert.match(contentToHtml("Hello\n\nWorld"), /<p>Hello<\/p>/);
});
