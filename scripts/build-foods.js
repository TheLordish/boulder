/* build-foods.js — turns the USDA release into something a phone can hold.

   Runs in CI, where the network is open. The full SR Legacy download is about
   50 MB of JSON describing 150 nutrients per food; Boulder needs four of them,
   so this strips it to name plus calories, protein, carbs and fat per 100 g.
   That takes it under half a megabyte, and under 150 KB over the wire.

   SR Legacy is public domain (CC0) and is the set most other food databases
   are derived from, so the numbers are lab-derived rather than crowdsourced. */
const fs = require("fs");
const path = require("path");
const https = require("https");
const { execSync } = require("child_process");

const SR_LEGACY =
  "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip";
const FOUNDATION =
  "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_json_2025-04-24.zip";

// USDA nutrient ids for the four we keep
const N = { kcal: 1008, protein: 1003, fat: 1004, carb: 1005 };

function download(url, dest) {
  return new Promise((res, rej) => {
    const go = (u, depth) => {
      if (depth > 5) return rej(new Error("too many redirects"));
      https.get(u, r => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
          r.resume();
          return go(new URL(r.headers.location, u).toString(), depth + 1);
        }
        if (r.statusCode !== 200) { r.resume(); return rej(new Error(u + " -> " + r.statusCode)); }
        const f = fs.createWriteStream(dest);
        r.pipe(f);
        f.on("finish", () => f.close(() => res(dest)));
      }).on("error", rej);
    };
    go(url, 0);
  });
}

/* USDA names read like "Beef, ground, 85% lean meat / 15% fat, raw". Reverse the
   leading clauses so a person searching "ground beef" actually finds it. */
function tidy(desc) {
  let s = String(desc).replace(/\s+/g, " ").trim();
  s = s.replace(/,\s*(raw|all classes|NFS|UPC:.*)$/i, "");
  const parts = s.split(",").map(x => x.trim()).filter(Boolean);
  if (parts.length > 1 && parts.length <= 4) {
    const head = parts.shift();
    s = parts.join(" ") + " " + head;
  } else if (parts.length > 4) {
    s = parts.slice(0, 3).reverse().join(" ");
  }
  s = s.replace(/\s+/g, " ").trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function extract(food) {
  const out = {};
  for (const fn of food.foodNutrients || []) {
    const id = fn.nutrient && fn.nutrient.id;
    const v = fn.amount;
    if (v == null) continue;
    if (id === N.kcal) out.k = Math.round(v);
    else if (id === N.protein) out.p = Math.round(v * 10) / 10;
    else if (id === N.carb) out.c = Math.round(v * 10) / 10;
    else if (id === N.fat) out.f = Math.round(v * 10) / 10;
  }
  if (out.k == null || out.k <= 0) return null;
  return out;
}

async function harvest(url, tag, rows) {
  const zip = path.join("/tmp", tag + ".zip");
  console.log("downloading", tag);
  await download(url, zip);
  execSync(`cd /tmp && rm -rf ${tag} && mkdir ${tag} && unzip -oq ${zip} -d ${tag}`);
  const file = execSync(`find /tmp/${tag} -name "*.json" | head -1`).toString().trim();
  console.log("parsing", file, (fs.statSync(file).size / 1048576).toFixed(0) + " MB");
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  const list = doc.SRLegacyFoods || doc.FoundationFoods || doc.foods || [];
  let kept = 0;
  for (const food of list) {
    const m = extract(food);
    if (!m) continue;
    const name = tidy(food.description);
    if (!name || name.length > 60) continue;
    rows.push([name, m.k, m.p || 0, m.c || 0, m.f || 0]);
    kept++;
  }
  console.log(tag + ": kept", kept, "of", list.length);
}

(async () => {
  const rows = [];
  try { await harvest(FOUNDATION, "foundation", rows); }
  catch (e) { console.warn("foundation skipped:", e.message); }
  try { await harvest(SR_LEGACY, "srlegacy", rows); }
  catch (e) { console.warn("sr legacy skipped:", e.message); }

  if (!rows.length) { console.error("nothing harvested"); process.exit(1); }

  // the hand-written regional set, which no public database covers
  const localFile = path.join("data", "regional.json");
  let regional = [];
  if (fs.existsSync(localFile)) {
    regional = JSON.parse(fs.readFileSync(localFile, "utf8")).foods || [];
    console.log("regional entries:", regional.length);
  }

  // first name wins, and the regional set goes first so it beats a USDA near-match
  const seen = new Set();
  const merged = [];
  for (const r of regional.concat(rows)) {
    const key = r[0].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(r);
  }
  merged.sort((a, b) => a[0].localeCompare(b[0]));

  fs.mkdirSync("data", { recursive: true });
  const out = { v: 1, built: new Date().toISOString().slice(0, 10),
    note: "per 100 g or 100 ml: name, kcal, protein, carbs, fat",
    foods: merged };
  fs.writeFileSync("data/foods.json", JSON.stringify(out));
  const kb = Math.round(fs.statSync("data/foods.json").size / 1024);
  console.log("wrote data/foods.json:", merged.length, "foods,", kb, "KB");
})();
