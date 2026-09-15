/**
 * Parse PF2e-style creature text blocks into Hermes high-level `statblock` JSON.
 * Aimed at formats like:
 *   Name — Creature 8
 *   Unique Small Gnome Humanoid Druid
 *   Perception +16; low-light vision
 *   ...
 */

const ABILITY_ORDER = ["str", "dex", "con", "int", "wis", "cha"];

const SIZE_WORDS = new Set(["tiny", "small", "medium", "large", "huge", "gargantuan"]);

const RANK_WORDS = {
  cantrips: 0,
  cantrip: 0,
  "0th": 0,
  "0": 0,
  "1st": 1,
  "2nd": 2,
  "3rd": 3,
  "4th": 4,
  "5th": 5,
  "6th": 6,
  "7th": 7,
  "8th": 8,
  "9th": 9,
  "10th": 10,
};

function stripNoise(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[◆◇⭘]/g, "") // action icons
    .replace(/\u2014/g, "—")
    .replace(/\u2013/g, "-")
    .trim();
}

function splitSections(text) {
  // Prefer blank-line / ——— separators; keep as line stream with soft section tags
  return text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l && !/^—+$/.test(l) && !/^-{3,}$/.test(l));
}

function parseMod(s) {
  const m = String(s).trim().match(/([+-]?\d+)/);
  return m ? Number(m[1]) : 0;
}

function parseCsvNames(list) {
  // Split on commas not inside parentheses
  const out = [];
  let buf = "";
  let depth = 0;
  for (const ch of String(list)) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      const s = buf.trim();
      if (s) out.push(s);
      buf = "";
      continue;
    }
    buf += ch;
  }
  const last = buf.trim();
  if (last) out.push(last);
  return out
    .map((s) => s.replace(/\s*\(.*?\)\s*$/, "").trim())
    .filter(Boolean);
}

function parseGearList(list) {
  // Like parseCsvNames but keep "(8, heal...)" / "(20 bullets)" on the token
  const out = [];
  let buf = "";
  let depth = 0;
  for (const ch of String(list)) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      const s = buf.trim();
      if (s) out.push(s);
      buf = "";
      continue;
    }
    buf += ch;
  }
  const last = buf.trim();
  if (last) out.push(last);
  return out;
}

function parseHeader(lines, sb, warnings) {
  const header = lines[0] ?? "";
  let m = header.match(/^(.+?)\s*[—\-–]+\s*Creature\s+(\d+)\s*$/i);
  if (!m) m = header.match(/^(.+?)\s+Creature\s+(\d+)\s*$/i);
  if (m) {
    sb.name = m[1].trim();
    sb.level = Number(m[2]);
    return 1;
  }
  warnings.push(`Could not parse creature header from: "${header}"`);
  sb.name = header || "Unnamed Creature";
  sb.level = 1;
  return 1;
}

function parseTraitsLine(line, sb) {
  // "Unique Small Gnome Humanoid Druid"
  const parts = line.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return false;
  // Heuristic: line has a size word and no colons / plus signs
  if (/[:+]/.test(line)) return false;
  const lower = parts.map((p) => p.toLowerCase());
  if (!lower.some((p) => SIZE_WORDS.has(p))) return false;

  sb.traits = [];
  for (const p of parts) {
    const l = p.toLowerCase();
    if (SIZE_WORDS.has(l)) {
      sb.size = { tiny: "tiny", small: "sm", medium: "med", large: "lg", huge: "huge", gargantuan: "grg" }[l];
      continue;
    }
    if (["unique", "rare", "uncommon", "common"].includes(l)) {
      sb.rarity = l;
      if (l !== "common") sb.traits.push(l);
      continue;
    }
    sb.traits.push(l);
  }
  sb.blurb = line;
  return true;
}

function parsePerception(line, sb) {
  const m = line.match(/^Perception\s*([+-]?\d+)\s*(?:;\s*(.*))?$/i);
  if (!m) return false;
  sb.perception = parseMod(m[1]);
  if (m[2]) {
    sb.senses = m[2].split(/,\s*/).map((s) => s.trim()).filter(Boolean);
  }
  return true;
}

function parseLanguages(line, sb) {
  const m = line.match(/^Languages?\s+(.+)$/i);
  if (!m) return false;
  sb.languages = m[1].split(/,\s*/).map((s) => s.trim()).filter(Boolean);
  return true;
}

function parseSkills(line, sb) {
  const m = line.match(/^Skills?\s+(.+)$/i);
  if (!m) return false;
  sb.skills = {};
  for (const part of m[1].split(/,\s*/)) {
    const km = part.trim().match(/^([A-Za-z ]+?)\s+([+-]?\d+)\s*$/);
    if (!km) continue;
    const key = km[1].trim().toLowerCase().replace(/\s+/g, "-");
    // lore skills keep hyphen; standard skills drop to single token
    const skillKey = key.includes("lore") ? key : key.replace(/-/g, "");
    // map "acrobatics" etc — Nature → nature
    const flat = key.includes("lore") ? key : km[1].trim().toLowerCase().replace(/\s+/g, "");
    sb.skills[flat] = parseMod(km[2]);
  }
  return true;
}

function parseAbilities(line, sb) {
  // Str +2 · Dex +2 · Con +4 ...
  if (!/\bStr\b/i.test(line) || !/\bDex\b/i.test(line)) return false;
  sb.abilities = {};
  for (const ab of ABILITY_ORDER) {
    const m = line.match(new RegExp(`\\b${ab}\\b\\s*([+-]?\\d+)`, "i"));
    sb.abilities[ab] = m ? parseMod(m[1]) : 0;
  }
  return Object.values(sb.abilities).some((v) => v !== 0) || /\bStr\s*[+-]?0\b/i.test(line);
}

function parseDefense(line, sb) {
  // AC 26 (28 with barkskin); Fort +18, Ref +14, Will +20
  if (!/^AC\b/i.test(line)) return false;
  const acm = line.match(/\bAC\s+(\d+)/i);
  if (acm) sb.ac = Number(acm[1]);
  sb.saves = sb.saves ?? {};
  const fort = line.match(/\bFort(?:itude)?\s*([+-]?\d+)/i);
  const ref = line.match(/\bRef(?:lex)?\s*([+-]?\d+)/i);
  const will = line.match(/\bWill\s*([+-]?\d+)/i);
  if (fort) sb.saves.fortitude = parseMod(fort[1]);
  if (ref) sb.saves.reflex = parseMod(ref[1]);
  if (will) sb.saves.will = parseMod(will[1]);
  return true;
}

function parseHP(line, sb) {
  // HP 135; Resistances physical 5 (stoneskin)
  if (!/^HP\b/i.test(line)) return false;
  const hpm = line.match(/\bHP\s+(\d+)/i);
  if (hpm) sb.hp = Number(hpm[1]);
  const res = line.match(/Resistances?\s+(.+)$/i);
  if (res) {
    sb.resistances = [];
    for (const part of res[1].split(/,\s*/)) {
      const rm = part.trim().match(/^([a-zA-Z\-]+)\s+(\d+)/);
      if (rm) sb.resistances.push({ type: rm[1].toLowerCase(), value: Number(rm[2]) });
    }
  }
  const imm = line.match(/Immunit(?:y|ies)\s+(.+)$/i);
  if (imm) {
    sb.immunities = imm[1].split(/,\s*/).map((s) => ({ type: s.trim().toLowerCase() }));
  }
  return true;
}

function parseSpeed(line, sb) {
  const m = line.match(/^Speed\s+(\d+)\s*feet?(.*)$/i);
  if (!m) return false;
  sb.speed = { value: Number(m[1]), otherSpeeds: [] };
  // ", fly 40 feet" style in remainder
  const rest = m[2] ?? "";
  for (const om of rest.matchAll(/\b(fly|swim|climb|burrow)\s+(\d+)/gi)) {
    sb.speed.otherSpeeds.push({ type: om[1].toLowerCase(), value: Number(om[2]) });
  }
  return true;
}

function parseStrike(line, sb) {
  // Melee club +16, Damage 2d6+5 bludgeoning
  // Ranged sling +14 (range 50 ft, reload 1), Damage 1d6+2 bludgeoning
  const m = line.match(/^(Melee|Ranged)\s+(.+?)\s+([+-]\d+)\s*(?:\(([^)]*)\))?\s*,\s*Damage\s+(.+)$/i);
  if (!m) return false;
  const kind = m[1].toLowerCase();
  const name = m[2].trim();
  const bonus = parseMod(m[3]);
  const traitsRaw = m[4] ?? "";
  const damage = m[5].trim();
  const traits = [];
  let range = null;
  if (traitsRaw) {
    for (const t of traitsRaw.split(/,\s*/)) {
      const tt = t.trim();
      const rm = tt.match(/^range\s+(\d+)/i);
      if (rm) {
        range = Number(rm[1]);
        continue;
      }
      if (/^reload\b/i.test(tt)) continue;
      if (tt) traits.push(tt.toLowerCase().replace(/\s+/g, "-"));
    }
  }
  sb.strikes = sb.strikes ?? [];
  sb.strikes.push({
    name,
    type: kind === "ranged" ? "ranged" : "melee",
    bonus,
    damage,
    traits,
    ...(range != null ? { range } : {}),
  });
  return true;
}

function parseActionish(line, sb) {
  // Wild Shape (3/day) Bird ...
  // Skip if already consumed as strike
  if (/^(Melee|Ranged)\b/i.test(line)) return false;
  if (/^(Perception|Languages|Skills|AC|HP|Speed|Items|Str\b)/i.test(line)) return false;
  if (/Spells?\b/i.test(line) && /DC\s*\d+/i.test(line)) return false;

  // Lines that look like named special abilities: Title rest...
  const m = line.match(/^([A-Z][A-Za-z'’\-]*(?:\s+[A-Z][A-Za-z'’\-]*){0,4})\s+(.+)$/);
  if (!m) return false;
  // Avoid matching trait-only leftovers
  const title = m[1].trim();
  const rest = m[2].trim();
  if (/^(Unique|Small|Medium|Large|Common|Rare)\b/i.test(title)) return false;
  if (rest.length < 8) return false;
  // Prefer if rest mentions frequency / form effects
  if (!/\b(\d+\/day|Frequency|effect|fly|HP|Damage|feet)\b/i.test(rest) && !/^[\[(]/.test(rest)) {
    // still allow "Wild Shape ◆◆ (3/day) ..."
    if (!/\(\d+\/day\)/i.test(line)) return false;
  }
  sb.actions = sb.actions ?? [];
  let actionsCost = "two";
  if (/\b1\s*action\b|◆(?!◆)/i.test(line) && !/◆◆/.test(line)) actionsCost = "one";
  if (/◆◆◆/.test(line) || /\b3\s*actions?\b/i.test(line)) actionsCost = "three";
  sb.actions.push({
    name: title,
    actions: actionsCost,
    description: `<p>${rest}</p>`,
  });
  return true;
}

function parseSpellcastingHeader(line, sb) {
  // Primal Prepared Spells DC 26, attack +18
  const m = line.match(/^(\w+)\s+(Prepared|Spontaneous|Focus)\s+Spells?\s+DC\s+(\d+)\s*,\s*attack\s*([+-]?\d+)/i);
  if (!m) return false;
  const tradition = m[1].toLowerCase();
  const type = m[2].toLowerCase();
  const dc = Number(m[3]);
  const attack = parseMod(m[4]);
  sb.spellcasting = {
    tradition,
    type,
    dc,
    attack,
    ability: tradition === "arcane" || tradition === "occult" ? "int" : "wis",
    slots: {},
    spells: {},
  };
  return true;
}

function parseSpellRankLine(line, sb) {
  if (!sb.spellcasting) return false;
  // 4th (3 slots) air walk, dispel magic, freedom of movement
  // Cantrips (5th) detect magic, guidance, ...
  let m = line.match(/^Cantrips?\s*(?:\((\d+)(?:st|nd|rd|th)?\))?\s+(.+)$/i);
  if (m) {
    const heighten = m[1] ? Number(m[1]) : (sb.level ?? 1);
    sb.spellcasting.autoHeightenLevel = heighten;
    sb.spellcasting.spells["0"] = parseCsvNames(m[2]);
    return true;
  }
  m = line.match(/^(\d+)(?:st|nd|rd|th)\s*(?:\((\d+)\s*slots?\))?\s+(.+)$/i);
  if (!m) return false;
  const rank = Number(m[1]);
  if (m[2]) sb.spellcasting.slots[String(rank)] = Number(m[2]);
  sb.spellcasting.spells[String(rank)] = parseCsvNames(m[3]);
  return true;
}

function parseItems(line, sb) {
  const m = line.match(/^Items?\s+(.+)$/i);
  if (!m) return false;
  sb.gear = [];
  for (const part of parseGearList(m[1])) {
    let name = part.trim();
    if (!name) continue;
    const bullets = name.match(/^sling\s*\((\d+)\s*bullets?\)$/i);
    if (bullets) {
      sb.gear.push("Sling");
      sb.gear.push({ name: "Sling Bullets", quantity: Number(bullets[1]) });
      continue;
    }
    const qty = name.match(/^(.+?)\s*\((\d+)(?:,.*)?\)$/);
    if (qty && !/gp\b/i.test(name) && !/dust\b/i.test(name) && !/^scroll\b/i.test(name) && !/^pearl\b/i.test(name)) {
      sb.gear.push({ name: qty[1].trim(), quantity: Number(qty[2]) });
      continue;
    }
    if (/^\d+\s*gp$/i.test(name)) continue;
    if (/\d+\s*gp\b/i.test(name) && !/^scroll\b/i.test(name) && !/^pearl\b/i.test(name)) continue;
    sb.gear.push(name);
  }
  return true;
}

function parseTactics(line, sb) {
  const m = line.match(/^(?:⚔\s*)?Tactics\s+(.+)$/i);
  if (!m) return false;
  sb.tactics = m[1].trim();
  return true;
}

/**
 * @param {string} text
 * @returns {{ statblock: object, warnings: string[] }}
 */
export function parseStatblockText(text) {
  const warnings = [];
  const cleaned = stripNoise(text);
  if (!cleaned) throw new Error("Empty statblock text");

  const lines = splitSections(cleaned);
  const sb = {
    strikes: [],
    actions: [],
    skills: {},
    abilities: {},
  };

  let i = 0;
  i += parseHeader(lines, sb, warnings);

  while (i < lines.length) {
    const line = lines[i];
    i += 1;
    if (parseTraitsLine(line, sb)) continue;
    if (parsePerception(line, sb)) continue;
    if (parseLanguages(line, sb)) continue;
    if (parseSkills(line, sb)) continue;
    if (parseAbilities(line, sb)) continue;
    if (parseDefense(line, sb)) continue;
    if (parseHP(line, sb)) continue;
    if (parseSpeed(line, sb)) continue;
    if (parseStrike(line, sb)) continue;
    if (parseSpellcastingHeader(line, sb)) continue;
    if (parseSpellRankLine(line, sb)) continue;
    if (parseItems(line, sb)) continue;
    if (parseTactics(line, sb)) continue;
    if (parseActionish(line, sb)) continue;
    // Unknown line — ignore quietly unless it looks important
    if (/^[A-Z]/.test(line) && line.length > 20) {
      warnings.push(`Unrecognized line (skipped): ${line.slice(0, 80)}`);
    }
  }

  // Defaults
  if (!sb.level) sb.level = 1;
  if (!sb.size) sb.size = "med";
  if (sb.spellcasting && !Object.keys(sb.spellcasting.slots || {}).length) {
    // infer 3 slots for each prepared rank that has spells listed (except cantrips)
    for (const [rank, names] of Object.entries(sb.spellcasting.spells || {})) {
      if (rank === "0") continue;
      sb.spellcasting.slots[rank] = Math.max(names.length, 1);
    }
  }

  return { statblock: sb, warnings };
}
