/**
 * High-level PF2e NPC statblock → Foundry documents.
 * Hermes-friendly schema; bridge expands to PF2e data + resolves SRD packs.
 */

const SPELL_PACK = "pf2e.spells-srd";
const EQUIP_PACK = "pf2e.equipment-srd";

/** Legacy / adventure names → Remaster SRD names */
export const SPELL_ALIASES = {
  "call lightning": "Lightning Storm",
  "barkskin": "Mountain Resilience",
  "freedom of movement": "Unfettered Movement",
  "longstrider": "Tailwind",
  "produce flame": "Ignition",
  "know direction": "Know the Way",
  "protection from energy": "Energy Aegis",
  "neutralize poison": "Cleanse Affliction",
  "antiplant shell": "Safe Passage",
  "stoneskin": "Mountain Resilience",
  "goodberry": null, // not in SRD as spell item; becomes action/consumable text
  "flame blade": null, // typically a strike on NPCs
  "heal animal": "Heal Animal",
  "air walk": "Air Walk",
  "dispel magic": "Dispel Magic",
  "poison": null, // too ambiguous — keep as descriptive if unresolved
  "protection": "Protection",
  "resist energy": "Resist Energy",
  "shillelagh": "Shillelagh",
  "detect magic": "Detect Magic",
  "guidance": "Guidance",
  "stabilize": "Stabilize",
};

const SIZE_MAP = {
  tiny: "tiny", sm: "sm", small: "sm", med: "med", medium: "med",
  lg: "lg", large: "lg", huge: "huge", grg: "grg", gargantuan: "grg",
};

const SENSE_ALIASES = {
  "low-light vision": "low-light-vision",
  "low light vision": "low-light-vision",
  "darkvision": "darkvision",
  "scent": "scent",
  "tremorsense": "tremorsense",
};

function slugify(name) {
  return String(name ?? "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function titleCase(s) {
  return String(s).replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function normalizeLang(lang) {
  return String(lang).toLowerCase().replace(/\s+/g, "-");
}

function parseDamage(dmg) {
  if (!dmg) return { damage: "1d4", damageType: "bludgeoning" };
  if (typeof dmg === "object") {
    return {
      damage: dmg.damage ?? dmg.formula ?? "1d4",
      damageType: dmg.damageType ?? dmg.type ?? "untyped",
      category: dmg.category ?? null,
    };
  }
  const raw = String(dmg).trim();
  const m = raw.match(/^([\dd+\-\s]+)\s+(\w+)$/i);
  if (m) return { damage: m[1].replace(/\s+/g, ""), damageType: m[2].toLowerCase(), category: null };
  return { damage: raw, damageType: "untyped", category: null };
}

function emptySlots() {
  const slots = {};
  for (let i = 0; i <= 11; i++) {
    slots[`slot${i}`] = { prepared: [], value: 0, max: 0 };
  }
  return slots;
}

/**
 * Best-effort exact / alias / substring match in a pack index.
 */
async function findInPack(packId, query, { type = null } = {}) {
  const pack = game.packs.get(packId);
  if (!pack) return null;
  const q = String(query ?? "").trim();
  if (!q) return null;

  const alias = SPELL_ALIASES[q.toLowerCase()];
  if (alias === null) return null; // explicitly unmapped
  const want = (alias || q).toLowerCase();

  const index = await pack.getIndex({ fields: ["name", "type", "img"] });
  const rows = [...index].filter((e) => !type || e.type === type);

  const exact = rows.find((e) => e.name.toLowerCase() === want);
  if (exact) return { packId, documentId: exact._id, name: exact.name, type: exact.type, img: exact.img };

  const starts = rows.filter((e) => e.name.toLowerCase().startsWith(want));
  if (starts.length === 1) {
    const e = starts[0];
    return { packId, documentId: e._id, name: e.name, type: e.type, img: e.img };
  }

  // Prefer length-closest includes match (avoid "Scroll of X" when looking for "Sling")
  const includes = rows
    .filter((e) => e.name.toLowerCase().includes(want))
    .sort((a, b) => a.name.length - b.name.length);
  if (includes.length) {
    // If query is short word, require word-boundary-ish exact token
    const e = includes.find((x) => x.name.toLowerCase() === want)
      ?? (want.length >= 4 ? includes[0] : null);
    if (e) return { packId, documentId: e._id, name: e.name, type: e.type, img: e.img };
  }
  return null;
}

async function cloneFromPack(hit) {
  const pack = game.packs.get(hit.packId);
  const doc = await pack.getDocument(hit.documentId);
  const data = doc.toObject();
  delete data._id;
  delete data.folder;
  return data;
}

function buildSystemFromStatblock(sb) {
  const level = sb.level ?? 1;
  const abilities = sb.abilities ?? {};
  const ability = (k) => {
    const v = abilities[k];
    if (v == null) return { mod: 0 };
    return typeof v === "object" ? { mod: v.mod ?? v.value ?? 0 } : { mod: Number(v) || 0 };
  };

  const skills = {};
  for (const [key, val] of Object.entries(sb.skills ?? {})) {
    const n = typeof val === "object" ? (val.value ?? val.base ?? 0) : val;
    skills[key.toLowerCase()] = { value: Number(n) || 0, base: Number(n) || 0 };
  }

  const savesIn = sb.saves ?? {};
  const save = (a, b, c) => {
    const v = savesIn[a] ?? savesIn[b] ?? savesIn[c] ?? 0;
    const n = typeof v === "object" ? (v.value ?? v.base ?? 0) : v;
    return { value: Number(n) || 0, base: Number(n) || 0 };
  };

  const hp = sb.hp ?? 10;
  const hpVal = typeof hp === "object" ? (hp.value ?? hp.max ?? 10) : hp;
  const ac = typeof sb.ac === "object" ? (sb.ac.value ?? 10) : (sb.ac ?? 10);

  const traits = [...(sb.traits ?? [])].map((t) => String(t).toLowerCase());
  const rarity = (sb.rarity ?? (traits.includes("unique") ? "unique" : traits.includes("rare") ? "rare" : "common"));
  const sizeRaw = sb.size ?? traits.find((t) => SIZE_MAP[t]) ?? "med";
  const size = SIZE_MAP[String(sizeRaw).toLowerCase()] ?? "med";

  const perception = typeof sb.perception === "object"
    ? (sb.perception.mod ?? sb.perception.value ?? 0)
    : (sb.perception ?? 0);

  const senses = [];
  for (const s of sb.senses ?? []) {
    if (typeof s === "string") {
      const key = SENSE_ALIASES[s.toLowerCase()] ?? slugify(s);
      senses.push({ type: key });
    } else if (s && typeof s === "object") {
      senses.push(s);
    }
  }

  const languages = (sb.languages ?? []).map(normalizeLang);

  const speedVal = typeof sb.speed === "object" ? (sb.speed.value ?? 25) : (sb.speed ?? 25);
  const otherSpeeds = typeof sb.speed === "object" ? (sb.speed.otherSpeeds ?? []) : [];

  const resistances = (sb.resistances ?? []).map((r) => {
    if (typeof r === "string") return { type: r.toLowerCase(), value: 0 };
    return {
      type: String(r.type ?? "physical").toLowerCase(),
      value: Number(r.value ?? 0),
      exceptions: r.exceptions ?? [],
      doubleVs: r.doubleVs ?? [],
    };
  });

  const notes = [sb.notes, sb.tactics].filter(Boolean).join("\n\n");

  return {
    details: {
      level: { value: level },
      blurb: sb.blurb ?? "",
      publicNotes: sb.publicNotes ?? "",
      privateNotes: notes,
      languages: { value: languages, details: sb.languageDetails ?? "" },
    },
    traits: {
      value: traits.filter((t) => !SIZE_MAP[t] && t !== "unique" && t !== "rare" && t !== "uncommon"),
      rarity,
      size: { value: size },
    },
    attributes: {
      hp: { value: hpVal, max: hpVal, base: hpVal, details: typeof hp === "object" ? (hp.details ?? "") : "" },
      ac: { value: Number(ac) || 10 },
      speed: { value: Number(speedVal) || 25, otherSpeeds },
      resistances,
      immunities: sb.immunities ?? [],
      weaknesses: sb.weaknesses ?? [],
    },
    abilities: {
      str: ability("str"), dex: ability("dex"), con: ability("con"),
      int: ability("int"), wis: ability("wis"), cha: ability("cha"),
    },
    saves: {
      fortitude: save("fortitude", "fort", "fortitude"),
      reflex: save("reflex", "ref", "reflex"),
      will: save("will", "wil", "will"),
    },
    perception: {
      mod: Number(perception) || 0,
      // PF2e may overwrite; also set value/base for NPC sheets that use them
      value: Number(perception) || 0,
      base: Number(perception) || 0,
      senses,
      details: sb.perceptionDetails ?? "",
    },
    skills,
  };
}

function buildStrikeItem(strike) {
  const name = strike.name ?? "Strike";
  const dmg = parseDamage(strike.damage ?? strike.damageRolls);
  const bonus = strike.bonus ?? strike.attack ?? 0;
  const traits = [...(strike.traits ?? [])];
  if (strike.touch && !traits.includes("touch")) traits.push("touch");
  const isRanged = (strike.type === "ranged") || traits.includes("ranged") || strike.range != null;

  const damageKey = foundry.utils.randomID?.() ?? Math.random().toString(36).slice(2, 18);
  const system = {
    bonus: { value: Number(bonus) || 0 },
    damageRolls: {
      [damageKey]: {
        damage: dmg.damage,
        damageType: dmg.damageType,
        category: dmg.category,
      },
    },
    traits: { value: traits },
    attackEffects: { value: strike.attackEffects ?? [] },
    description: { value: strike.description ?? "" },
  };
  if (isRanged && strike.range != null) {
    // NPC melee items are used for both; range lives in traits often as "range-increment-X"
    const ri = `range-increment-${Number(strike.range) || 20}`;
    if (!system.traits.value.includes(ri)) system.traits.value.push(ri);
  }
  return {
    name: titleCase(name),
    type: "melee",
    img: strike.img ?? "systems/pf2e/icons/default-icons/melee.svg",
    system,
  };
}

function buildActionItem(action) {
  const actions = action.actions ?? action.cost ?? null;
  let actionType = action.actionType ?? "action";
  let actionsValue = null;
  if (actions === "reaction" || actions === "free") {
    actionType = actions;
  } else if (actions === "one" || actions === 1 || actions === "◆") {
    actionsValue = 1;
  } else if (actions === "two" || actions === 2 || actions === "◆◆") {
    actionsValue = 2;
  } else if (actions === "three" || actions === 3 || actions === "◆◆◆") {
    actionsValue = 3;
  } else if (typeof actions === "number") {
    actionsValue = actions;
  }

  return {
    name: action.name ?? "Action",
    type: "action",
    img: action.img ?? "systems/pf2e/icons/default-icons/action.svg",
    system: {
      description: { value: action.description ?? "" },
      actionType: { value: actionType },
      actions: { value: actionsValue },
      category: action.category ?? "",
      traits: { value: action.traits ?? [] },
    },
  };
}

function buildSpellcastingEntry(sc) {
  const tradition = sc.tradition ?? "arcane";
  const preparedType = sc.type ?? sc.castingType ?? "prepared"; // prepared | spontaneous | focus
  const ability = sc.ability ?? (tradition === "arcane" || tradition === "occult" ? "int" : tradition === "divine" ? "wis" : "wis");
  const dc = sc.dc ?? 10;
  const attack = sc.attack ?? (dc - 8);
  // spelldc.value is the spell attack modifier for NPCs in observed data; dc is save DC
  const slots = emptySlots();
  const slotCounts = sc.slots ?? {};
  for (const [lvl, count] of Object.entries(slotCounts)) {
    const n = Number(lvl);
    const c = Number(count) || 0;
    if (Number.isNaN(n) || n < 0 || n > 11) continue;
    slots[`slot${n}`] = { prepared: [], value: c, max: c };
  }

  const name = sc.name
    ?? `${titleCase(tradition)} ${titleCase(preparedType)} Spells`;

  return {
    name,
    type: "spellcastingEntry",
    img: "systems/pf2e/icons/default-icons/spellcastingEntry.svg",
    system: {
      ability: { value: ability },
      spelldc: { value: Number(attack) || 0, dc: Number(dc) || 10 },
      tradition: { value: tradition },
      prepared: { value: preparedType, flexible: false, validItems: null },
      proficiency: { value: 1 },
      slots,
      showSlotlessLevels: { value: true },
      autoHeightenLevel: { value: sc.autoHeightenLevel ?? sc.cantripRank ?? null },
      description: { value: sc.description ?? "" },
    },
  };
}

/**
 * After entry exists, resolve spell names → embedded spell items linked to entry.
 */
async function createSpellsForEntry(actor, entry, sc, warnings) {
  const created = [];
  const spellsByLevel = sc.spells ?? {};
  // Accept array form: [{ name, level }] as well
  const entries = [];
  if (Array.isArray(spellsByLevel)) {
    for (const s of spellsByLevel) {
      entries.push({ level: Number(s.level ?? 0), name: s.name ?? s });
    }
  } else {
    for (const [lvl, names] of Object.entries(spellsByLevel)) {
      for (const name of names ?? []) {
        entries.push({ level: Number(lvl), name });
      }
    }
  }

  const preparedBySlot = {};

  for (const { level, name } of entries) {
    const hit = await findInPack(SPELL_PACK, name, { type: "spell" });
    if (!hit) {
      warnings.push(`Spell not found in ${SPELL_PACK}: "${name}" (rank ${level}) — added as placeholder action`);
      const placeholder = await Item.create({
        name: `${name} (${level === 0 ? "cantrip" : `rank ${level}`})`,
        type: "action",
        system: {
          description: { value: `<p>Unresolved spell from statblock: <strong>${name}</strong>.</p>` },
          actionType: { value: "action" },
          actions: { value: null },
        },
      }, { parent: actor });
      const item = Array.isArray(placeholder) ? placeholder[0] : placeholder;
      if (item) created.push(item);
      continue;
    }

    try {
      const data = await cloneFromPack(hit);
      data.system = data.system ?? {};
      data.system.location = {
        value: entry.id,
        heightenedLevel: level,
      };
      // Keep original cantrip level; heightenedLevel controls cast height for cantrips via entry
      const doc = await Item.create(data, { parent: actor });
      const item = Array.isArray(doc) ? doc[0] : doc;
      if (item) {
        created.push(item);
        if ((sc.type ?? "prepared") === "prepared" && level >= 1) {
          preparedBySlot[level] ??= [];
          preparedBySlot[level].push({ id: item.id });
        }
      }
    } catch (err) {
      warnings.push(`Failed to add spell "${name}": ${err.message ?? err}`);
    }
  }

  // Write prepared slot lists for prepared casters
  if ((sc.type ?? "prepared") === "prepared" && Object.keys(preparedBySlot).length) {
    const slotUpdates = {};
    for (const [lvl, prep] of Object.entries(preparedBySlot)) {
      const key = `system.slots.slot${lvl}.prepared`;
      slotUpdates[key] = prep.map((p) => ({ id: p.id }));
    }
    try {
      await entry.update(slotUpdates);
    } catch (err) {
      warnings.push(`Could not write prepared slots: ${err.message ?? err}`);
    }
  }

  return created;
}

async function createGearItems(actor, gear, warnings) {
  const created = [];
  for (const g of gear ?? []) {
    const name = typeof g === "string" ? g : g.name;
    if (!name) continue;
    // Strip leading +N for search
    const search = name.replace(/^\+\d+\s+/, "").replace(/\s*\(.*?\)\s*$/, "").trim();
    const hit = await findInPack(EQUIP_PACK, search);
    if (!hit) {
      warnings.push(`Gear not found in ${EQUIP_PACK}: "${name}" — added as treasure placeholder`);
      try {
        const doc = await Item.create({
          name,
          type: "treasure",
          system: {
            description: { value: `<p>Unresolved gear from statblock.</p>` },
            quantity: typeof g === "object" ? (g.quantity ?? 1) : 1,
          },
        }, { parent: actor });
        const item = Array.isArray(doc) ? doc[0] : doc;
        if (item) created.push(item);
      } catch (err) {
        warnings.push(`Failed placeholder gear "${name}": ${err.message ?? err}`);
      }
      continue;
    }
    try {
      const data = await cloneFromPack(hit);
      if (name !== hit.name) data.name = name; // keep "+1 leather armor" labeling
      if (typeof g === "object" && g.quantity) {
        data.system = data.system ?? {};
        data.system.quantity = g.quantity;
      }
      const doc = await Item.create(data, { parent: actor });
      const item = Array.isArray(doc) ? doc[0] : doc;
      if (item) created.push(item);
    } catch (err) {
      warnings.push(`Failed to add gear "${name}": ${err.message ?? err}`);
    }
  }
  return created;
}

/**
 * Populate an existing NPC actor from a high-level statblock.
 * @returns {{ items: Document[], warnings: string[] }}
 */
export async function populateActorFromStatblock(actor, sb, warnings = []) {
  const created = [];
  if (!sb || typeof sb !== "object") return { items: created, warnings };

  // Core system fields
  const system = buildSystemFromStatblock(sb);
  await actor.update({ system: foundry.utils.mergeObject(actor.system, system, { inplace: false, overwrite: true }) });

  // Token size from creature size
  const size = system.traits?.size?.value;
  const sizeToToken = { tiny: 0.5, sm: 1, med: 1, lg: 2, huge: 3, grg: 4 };
  if (size && sizeToToken[size] != null) {
    const dim = sizeToToken[size];
    await actor.update({
      prototypeToken: foundry.utils.mergeObject(
        actor.prototypeToken.toObject(),
        { width: dim, height: dim },
        { inplace: false },
      ),
    });
  }

  // Strikes
  for (const strike of sb.strikes ?? sb.attacks ?? []) {
    try {
      const doc = await Item.create(buildStrikeItem(strike), { parent: actor });
      const item = Array.isArray(doc) ? doc[0] : doc;
      if (item) created.push(item);
    } catch (err) {
      warnings.push(`Strike "${strike.name}" failed: ${err.message ?? err}`);
    }
  }

  // Actions (Wild Shape, etc.)
  for (const action of sb.actions ?? []) {
    try {
      const doc = await Item.create(buildActionItem(action), { parent: actor });
      const item = Array.isArray(doc) ? doc[0] : doc;
      if (item) created.push(item);
    } catch (err) {
      warnings.push(`Action "${action.name}" failed: ${err.message ?? err}`);
    }
  }

  // Spellcasting: one or many entries
  const casters = sb.spellcasting
    ? (Array.isArray(sb.spellcasting) ? sb.spellcasting : [sb.spellcasting])
    : [];
  for (const sc of casters) {
    try {
      const entryDoc = await Item.create(buildSpellcastingEntry(sc), { parent: actor });
      const entry = Array.isArray(entryDoc) ? entryDoc[0] : entryDoc;
      if (!entry) continue;
      created.push(entry);
      const spells = await createSpellsForEntry(actor, entry, sc, warnings);
      created.push(...spells);
    } catch (err) {
      warnings.push(`Spellcasting entry failed: ${err.message ?? err}`);
    }
  }

  // Gear
  const gearItems = await createGearItems(actor, sb.gear ?? sb.items ?? [], warnings);
  created.push(...gearItems);

  return { items: created, warnings };
}

/**
 * Build mergeable system + name from statblock without creating items (actor.create preload).
 */
export function previewSystemFromStatblock(sb) {
  return buildSystemFromStatblock(sb ?? {});
}
