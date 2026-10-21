// Load programme site locations for the map from scripts/data/south-sudan-sites.json
// (built from "ACF GPS coordinate.xlsx": coordinates converted to decimal degrees,
// checked against the official county boundaries; contact details left out).
//
//   node scripts/load-map-sites.js            (dry run: shows what would change)
//   node scripts/load-map-sites.js --apply
// Safe to re-run: sites are matched by name and updated.

require("dotenv").config({ quiet: true });
const path = require("path");
const { prisma } = require("../src/db");

const IMPL = "impl_south_sudan_logistics";
const APPLY = process.argv.includes("--apply");

(async () => {
  try {
    const file = require(path.join(__dirname, "data", "south-sudan-sites.json"));
    const impl = await prisma.implementation.findUnique({ where: { id: IMPL } });
    if (!impl) throw new Error("South Sudan implementation not found");
    const existing = new Map((await prisma.mapSite.findMany({ where: { implementationId: IMPL } })).map((s) => [s.name, s]));
    let added = 0;
    let updated = 0;
    for (const s of file.sites) {
      const data = {
        state: s.state || null,
        county: s.county || null,
        payam: s.payam || null,
        latitude: s.latitude,
        longitude: s.longitude,
        issues: s.issues.length ? s.issues : undefined,
        source: file.source,
      };
      if (existing.has(s.name)) updated += 1;
      else added += 1;
      if (APPLY) {
        await prisma.mapSite.upsert({
          where: { implementationId_name: { implementationId: IMPL, name: s.name } },
          create: { implementationId: IMPL, name: s.name, ...data },
          update: { ...data, issues: s.issues.length ? s.issues : null },
        });
      }
    }
    const located = file.sites.filter((s) => s.latitude !== null).length;
    console.log(`${APPLY ? "Loaded" : "Would load"} ${file.sites.length} sites (${located} with coordinates): ${added} new, ${updated} updated.`);
    console.log(`${file.sites.filter((s) => s.issues.length).length} sites carry a note to check (shown on the map page).`);
    if (!APPLY) console.log("Dry run: nothing changed. Re-run with --apply.");
  } catch (err) {
    console.error("STOPPED:", err.message || err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
