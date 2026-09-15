/**
 * Obelus → Foundry document mapping (pure helpers, no Foundry globals).
 */

export const JOURNAL_ENTITY_TYPES = new Set([
  "handout",
  "rules-note",
  "faction",
  "quest",
  "adventure",
  "session",
]);

export const PUSH_FOLDER_TYPES = ["Actor", "Item", "JournalEntry", "Scene"];

/** @param {unknown} type */
export function mapObelusType(type) {
  const t = String(type || "").toLowerCase().trim();
  if (t === "npc" || t === "pc") return "actor";
  if (t === "item") return "item";
  if (t === "location") return "location";
  if (JOURNAL_ENTITY_TYPES.has(t)) return "journal";
  return "journal";
}

/** @param {unknown} path */
export function isFoundryAssetPath(path) {
  if (!path || typeof path !== "string") return false;
  const p = path.trim();
  return /^(uploads|modules|systems|worlds)\//.test(p) || p.startsWith("icons/");
}

/** @param {unknown} content */
export function contentLooksLikeHtml(content) {
  return typeof content === "string" && /<[a-z][\s\S]*>/i.test(content);
}

/** @param {unknown} uuid */
export function foundryIdFromUuid(uuid) {
  if (!uuid || typeof uuid !== "string") return null;
  const parts = uuid.trim().split(".").filter(Boolean);
  if (parts.length < 2) return null;
  return parts[parts.length - 1] || null;
}

/** @param {unknown} content */
export function contentToHtml(content) {
  if (content == null) return "";
  const text = String(content);
  if (!text.trim()) return "";
  if (contentLooksLikeHtml(text)) return text;
  return text
    .split(/\n{2,}/)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

/** @param {string} value */
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
