// Set GPS positions of the Kenya (Isiolo) SQ-LNS facilities for the programme map,
// from scripts/data/kenya-facility-locations.json (matched by KMHFL code).
//
//   node scripts/load-kenya-locations.js            (dry run: shows what would change)
//   node scripts/load-kenya-locations.js --apply
//   node scripts/load-kenya-locations.js --apply --force   (also replace positions already set)
// Positions already entered in Anchor are kept unless --force is given.

require("dotenv").config({ quiet: true });
const path = require("path");
const { prisma } = require("../src/db");

// The country's implementation is found by its country code ("KE"), so the
// script works whatever id the implementation has on this server.
const COUNTRY = "KE";
const APPLY = process.argv.includes("--apply");
const FORCE = process.argv.includes("--force");

(async () => {
  try {
    const file = require(path.join(__dirname, "data", "kenya-facility-locations.json"));
    const impls = await prisma.implementation.findMany({ where: { country: { code: COUNTRY } }, select: { id: true, name: true } });
    if (!impls.length) throw new Error(`No implementation found for country ${COUNTRY}`);
    const ids = impls.map((i) => i.id);
    console.log(`Implementation(s): ${impls.map((i) => `${i.name} (${i.id})`).join(", ")}`);
    const facilities = await prisma.facility.findMany({
      where: { implementationId: { in: ids }, code: { in: file.facilities.map((f) => f.code) } },
      select: { id: true, code: true, name: true, latitude: true, longitude: true },
    });
    const byCode = new Map(facilities.map((f) => [f.code, f]));
    let set = 0;
    for (const row of file.facilities) {
      const f = byCode.get(row.code);
      if (!f) {
        console.log(`- ${row.code} ${row.name}: not in Anchor, skipped`);
        continue;
      }
      if (row.latitude === null) {
        console.log(`- ${f.code} ${f.name}: no position found online, add it in Anchor when known`);
        continue;
      }
      if (f.latitude !== null && !FORCE) {
        console.log(`- ${f.code} ${f.name}: already has a position, kept`);
        continue;
      }
      set += 1;
      console.log(`+ ${f.code} ${f.name}: ${row.latitude}, ${row.longitude}${row.approximate ? " (approximate)" : ""}`);
      if (APPLY) await prisma.facility.update({ where: { id: f.id }, data: { latitude: row.latitude, longitude: row.longitude } });
    }
    console.log(`${APPLY ? "Set" : "Would set"} ${set} position(s).`);
    if (!APPLY) console.log("Dry run: nothing changed. Re-run with --apply.");
  } catch (err) {
    console.error("STOPPED:", err.message || err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
