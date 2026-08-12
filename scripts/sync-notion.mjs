/**
 * sync-notion.mjs
 * Liest abgehakte Aufgaben aus Notion → berechnet XP → schreibt notion-xp.json
 *
 * Umgebungsvariablen (als GitHub Secrets setzen):
 *   NOTION_TOKEN           → dein Notion Integration Token
 *   NOTION_DB_AUFGABEN     → Database ID der Aufgaben-Datenbank
 *   NOTION_DB_REFLEXIONEN  → Database ID der Reflexionen-Datenbank
 */

import { writeFile, readFile } from "fs/promises";
import { join } from "path";

// ─── Konfiguration ────────────────────────────────────────────────────────────
const TOKEN           = process.env.NOTION_TOKEN;
const DB_AUFGABEN     = process.env.NOTION_DB_AUFGABEN     || "0ba369bad4074d348f4ac5124b7e1040";
const DB_REFLEXIONEN  = process.env.NOTION_DB_REFLEXIONEN  || "8a20d28a79d44ff4b2d9cce9d118fe1c";
const OUTPUT          = join(process.cwd(), "public", "notion-xp.json");

if (!TOKEN) {
  console.error("❌ NOTION_TOKEN fehlt. Als Umgebungsvariable oder GitHub Secret setzen.");
  process.exit(1);
}

// Schwierigkeit → XP (muss mit Notion-Schema übereinstimmen)
const XP_MAP = {
  "⚪ Routine":           5,
  "🟢 Normal":           15,
  "🔵 Herausforderung":  30,
  "🟣 Epic":             60,
  "🔴 Boss":            100,
};

// Notion-Bereich → App-Skill
const BEREICH_SKILL = {
  "🎓 Schule":       "school",
  "🌏 Sprachen":     "chinese",   // Chinesisch ist die Haupt-Sprache
  "🔬 Lernen":       "school",    // Allgemeines Lernen → Schule
  "💪 Sport":        "sport",
  "🎯 Nebenprojekt": "neben",     // Nebenprojekte → eigene Säule
  // Arbeit + Sonstiges → kein XP
};

// ─── Notion API ───────────────────────────────────────────────────────────────
async function queryAll(dbId, filter) {
  const pages = [];
  let cursor;

  do {
    const body = { filter, page_size: 100 };
    if (cursor) body.start_cursor = cursor;

    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method:  "POST",
      headers: {
        "Authorization":  `Bearer ${TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type":   "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Notion API ${res.status}: ${err}`);
    }

    const data = await res.json();
    pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return pages;
}

// ─── Hauptlogik ───────────────────────────────────────────────────────────────
async function main() {
  // Bestehende base_xp aus JSON lesen (manuell gesetzte Startpunkte beibehalten)
  let base_xp = { chinese: 1150, sport: 780, school: 1400, neben: 220 };
  try {
    const existing = JSON.parse(await readFile(OUTPUT, "utf8"));
    if (existing.base_xp) base_xp = existing.base_xp;
  } catch { /* Datei existiert noch nicht */ }

  // ── 1. Erledigte Aufgaben ────────────────────────────────────────────────
  console.log("→ Lade erledigte Aufgaben…");
  const tasks = await queryAll(DB_AUFGABEN, {
    property: "Status",
    select:   { equals: "✅ Erledigt" },
  });

  const task_xp    = { chinese: 0, sport: 0, school: 0, neben: 0 };
  const task_count = { chinese: 0, sport: 0, school: 0, neben: 0 };

  for (const page of tasks) {
    const bereich = page.properties["Bereich"]?.select?.name;
    const schwier = page.properties["Schwierigkeit"]?.select?.name;
    const skill   = BEREICH_SKILL[bereich];

    if (skill && schwier && XP_MAP[schwier] != null) {
      task_xp[skill]    += XP_MAP[schwier];
      task_count[skill] += 1;
    }
  }

  console.log(`   ${tasks.length} Aufgaben verarbeitet`);

  // ── 2. Wochen-Reviews ────────────────────────────────────────────────────
  console.log("→ Lade Wochen-Reviews…");
  let reviews = [];
  try {
    reviews = await queryAll(DB_REFLEXIONEN, {
      property: "Typ",
      select:   { equals: "📅 Wochen-Review" },
    });
    // Jeder Wochen-Review = +10 XP pro Skill (bewusste Reflexion zählt)
    const reviewBonus = reviews.length * 10;
    task_xp.chinese += reviewBonus;
    task_xp.sport   += reviewBonus;
    task_xp.school  += reviewBonus;
    task_xp.neben   += reviewBonus;
    console.log(`   ${reviews.length} Reviews (+${reviewBonus} XP pro Skill)`);
  } catch (e) {
    console.warn("   Reflexionen übersprungen:", e.message);
  }

  // ── 3. Ergebnis berechnen + schreiben ────────────────────────────────────
  const total_xp = {
    chinese: base_xp.chinese + task_xp.chinese,
    sport:   base_xp.sport   + task_xp.sport,
    school:  base_xp.school  + task_xp.school,
    neben:   base_xp.neben   + task_xp.neben,
  };

  const output = {
    _comment:     "Auto-generiert. base_xp = manuell. task_xp = aus Notion.",
    synced_at:    new Date().toISOString(),
    base_xp,
    task_xp,
    total_xp,
    task_count,
    review_count: reviews.length,
  };

  await writeFile(OUTPUT, JSON.stringify(output, null, 2));

  console.log("\n✓ Synchronisierung abgeschlossen:");
  console.log(`  Chinesisch:  ${total_xp.chinese} XP (${task_count.chinese} Tasks)`);
  console.log(`  Sport:       ${total_xp.sport} XP (${task_count.sport} Tasks)`);
  console.log(`  Schule:      ${total_xp.school} XP (${task_count.school} Tasks)`);
  console.log(`  Reviews:     ${reviews.length}`);
}

main().catch(err => {
  console.error("❌ Fehler:", err.message);
  process.exit(1);
});
