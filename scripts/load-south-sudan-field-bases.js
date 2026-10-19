// Load South Sudan's main warehouse and field base warehouses (ACF SSD supply
// chain list).
//
//   node scripts/load-south-sudan-field-bases.js            # apply
//   node scripts/load-south-sudan-field-bases.js --dry-run  # show what would change
//
// Safe to re-run:
// - ensures the Juba main warehouse exists (the capital warehouse and the
//   "Juba" field base in the source list are the same site);
// - creates only field bases that do not exist yet (matched by code);
// - never overwrites a location an admin has since edited in the dashboard;
// - links unlinked field bases to the main warehouse.
require("dotenv").config();
const { prisma } = require("../src/db");

const IMPLEMENTATION_ID = "impl_south_sudan_logistics";

// Capital warehouse in Juba (listed as the 210 MT "Juba" field base).
const MAIN_WAREHOUSE = { code: "SS-WH-JUBA", name: "Juba Main Warehouse", county: "Juba", capacityMetricTonnes: 210 };
// Earlier runs of this script created it as a field base under this code.
const LEGACY_JUBA_FIELD_BASE_CODE = "SS-FB-JUBA";

// Source: "List of Field Base Warehouses" (State, County, Name, Capacity MT),
// minus Juba (the main warehouse). County names match the preloaded counties.
const FIELD_BASES = [
  { code: "SS-FB-ALEK", name: "Alek Field Base", county: "Gogrial West", capacityMetricTonnes: 700 },
  { code: "SS-FB-KUAJOK", name: "Kuajok Field Base", county: "Gogrial West", capacityMetricTonnes: 13 },
  { code: "SS-FB-AWEIL-TOWN", name: "Aweil Town Field Base", county: "Aweil Center", capacityMetricTonnes: 155 },
  { code: "SS-FB-MALUALKON", name: "Malualkon Field Base", county: "Aweil East", capacityMetricTonnes: 155 },
  { code: "SS-FB-DUK", name: "Duk Field Base", county: "Duk", capacityMetricTonnes: 13 },
  { code: "SS-FB-OLD-FANGAK", name: "Old Fangak Field Base", county: "Fangak", capacityMetricTonnes: 64 },
  { code: "SS-FB-NEW-FANGAK", name: "New Fangak Field Base", county: "Fangak", capacityMetricTonnes: 64 },
  { code: "SS-FB-PAGUIR", name: "Paguir Field Base", county: "Fangak", capacityMetricTonnes: 64 },
  { code: "SS-FB-TOCH", name: "Toch Field Base", county: "Fangak", capacityMetricTonnes: 64 },
  { code: "SS-FB-JUAIBOR", name: "Juaibor Field Base", county: "Fangak", capacityMetricTonnes: 64 },
];

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const implementation = await prisma.implementation.findUnique({ where: { id: IMPLEMENTATION_ID } });
  if (!implementation) {
    throw new Error(`Implementation ${IMPLEMENTATION_ID} not found. Run "npx prisma migrate deploy" first.`);
  }

  const counties = await prisma.county.findMany({ where: { implementationId: IMPLEMENTATION_ID } });
  const countyByName = new Map(counties.map((c) => [c.name, c]));
  const missingCounties = [...new Set([MAIN_WAREHOUSE, ...FIELD_BASES].map((b) => b.county))].filter((n) => !countyByName.has(n));
  if (missingCounties.length) {
    throw new Error(`Counties not found for South Sudan: ${missingCounties.join(", ")}. Run "npx prisma migrate deploy" first.`);
  }

  const main = await ensureMainWarehouse(countyByName.get(MAIN_WAREHOUSE.county), dryRun);

  const summary = { created: 0, linked: 0, unchanged: 0 };

  for (const base of FIELD_BASES) {
    const county = countyByName.get(base.county);
    const existing = await prisma.facility.findUnique({ where: { code: base.code } });

    if (existing) {
      if (existing.implementationId !== IMPLEMENTATION_ID) {
        throw new Error(`Code ${base.code} is already used by a location in another programme.`);
      }
      if (main && !existing.parentStockLocationId) {
        console.log(`${dryRun ? "[dry run] would link" : "link"}  ${base.name} -> ${main.name}`);
        if (!dryRun) {
          await prisma.facility.update({ where: { id: existing.id }, data: { parentStockLocationId: main.id } });
        }
        summary.linked += 1;
      } else {
        summary.unchanged += 1;
      }
      continue;
    }

    console.log(
      `${dryRun ? "[dry run] would create" : "create"}  ${base.name.padEnd(24)} county=${county.name.padEnd(13)} ${String(base.capacityMetricTonnes).padStart(4)} MT${main ? `  under ${main.name}` : ""}`
    );
    if (!dryRun) {
      await prisma.facility.create({
        data: {
          code: base.code,
          name: base.name,
          type: "WAREHOUSE", // legacy type for field bases (dispatch/user rules)
          stockLocationType: "FIELD_BASE_WAREHOUSE",
          implementationId: IMPLEMENTATION_ID,
          countyId: county.id,
          capacityMetricTonnes: base.capacityMetricTonnes,
          parentStockLocationId: main ? main.id : null,
        },
      });
    }
    summary.created += 1;
  }

  console.log(
    `${dryRun ? "[dry run] " : ""}Field bases: ${summary.created} created, ${summary.linked} linked to the main warehouse, ${summary.unchanged} already present.`
  );
}

// Returns the Juba main warehouse ({ id, name }), creating it if needed. If an
// earlier run created Juba as a field base, that record is converted in place
// (same site, so no duplicate). In a dry run a placeholder is returned.
async function ensureMainWarehouse(county, dryRun) {
  const byCode = await prisma.facility.findUnique({ where: { code: MAIN_WAREHOUSE.code } });
  if (byCode) {
    if (byCode.implementationId !== IMPLEMENTATION_ID) {
      throw new Error(`Code ${MAIN_WAREHOUSE.code} is already used by a location in another programme.`);
    }
    console.log(`main warehouse present: ${byCode.name}`);
    return { id: byCode.id, name: byCode.name };
  }

  const legacy = await prisma.facility.findUnique({ where: { code: LEGACY_JUBA_FIELD_BASE_CODE } });
  if (legacy && legacy.implementationId === IMPLEMENTATION_ID) {
    console.log(`${dryRun ? "[dry run] would convert" : "convert"}  ${legacy.name} -> ${MAIN_WAREHOUSE.name} (main warehouse)`);
    if (dryRun) return { id: legacy.id, name: MAIN_WAREHOUSE.name };
    const converted = await prisma.facility.update({
      where: { id: legacy.id },
      data: {
        code: MAIN_WAREHOUSE.code,
        name: MAIN_WAREHOUSE.name,
        type: "WAREHOUSE",
        stockLocationType: "CENTRAL_WAREHOUSE",
        parentStockLocationId: null, // a main warehouse is the top of the hierarchy
        warehouseId: null,
      },
    });
    return { id: converted.id, name: converted.name };
  }

  console.log(`${dryRun ? "[dry run] would create" : "create"}  ${MAIN_WAREHOUSE.name} (main warehouse, ${MAIN_WAREHOUSE.capacityMetricTonnes} MT)`);
  if (dryRun) return { id: "(new)", name: MAIN_WAREHOUSE.name };
  const created = await prisma.facility.create({
    data: {
      code: MAIN_WAREHOUSE.code,
      name: MAIN_WAREHOUSE.name,
      type: "WAREHOUSE",
      stockLocationType: "CENTRAL_WAREHOUSE",
      implementationId: IMPLEMENTATION_ID,
      countyId: county.id,
      capacityMetricTonnes: MAIN_WAREHOUSE.capacityMetricTonnes,
    },
  });
  return { id: created.id, name: created.name };
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
