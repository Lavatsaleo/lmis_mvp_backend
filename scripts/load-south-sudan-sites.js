// Load South Sudan clinic sites (ACF SSD "Clinics Names, Locations, Caseloads").
//
//   node scripts/load-south-sudan-sites.js            # apply
//   node scripts/load-south-sudan-sites.js --dry-run  # show what would change
//
// Each site is created under its county. Counties with one field base get
// their sites linked to it; counties with several (Gogrial West: Alek / Kuajok)
// are left unlinked for an admin to link in Supply Configuration
// ("Link sites to a field base"). Fangak is not loaded yet.
//
// Safe to re-run: creates only missing sites (matched by code), never
// overwrites dashboard edits, and links still-unlinked sites when their county
// has a single field base. Run load-south-sudan-field-bases.js first.
require("dotenv").config();
const { prisma } = require("../src/db");

const IMPLEMENTATION_ID = "impl_south_sudan_logistics";

// Coordinates are copied from the source sheet as given. parseCoordinate()
// handles decimal degrees, degrees-minutes-seconds (N 08°36'1.45) and decimal
// minutes (027°23.107).
const COUNTIES = [
  {
    county: "Aweil East",
    fieldBaseCode: "SS-FB-MALUALKON",
    sites: [
      ["Malualkon", "9.013378", "27.624429"],
      ["Malualbai", "9.065", "27.76666667"],
      ["Yargot", "9.014166667", "27.46527778"],
      ["Mabil Biet", "9.210833333", "27.86972222"],
      ["Lieth", "9.25", "27.78361111"],
      ["Omdurman", "9.235", "27.51666667"],
      ["Warbekdit", "9.299166667", "27.53388889"],
      ["Warawar", "9.15", "27.61694444"],
      ["Warmalual", "9.5925", "27.39361111"],
      ["Bakou", "9.433333333", "27.60888889"],
      ["Angot", "9.502777778", "27.59333333"],
      ["Mathiang Nientok", "9.210833333", "27.86944444"],
      ["Wanjok", "9.016666667", "27.58333333"],
      ["Akuem", "8.962217", "27.499671"],
      ["Ameth Gol Duang", "8.966666667", "27.8"],
      ["Rumwetkor", "9.398888889", "27.41555556"],
      // Source has latitude and longitude swapped (and in decimal minutes).
      ["Mabior Wundiing", "09°02.537", "027°23.107"],
      ["Mabok Tong", "8.983333333", "27.71666667"],
      ["Madhol", "9.045", "27.705"],
      ["Majok Yith Thiou", "9.7", "27.78916667"],
      ["Majok Akeen", "9.433333333", "27.48305556"],
      ["Malith", "9.45", "27.71666667"],
      ["Malualdit", "9.249444444", "27.35"],
      ["Mangartong", "9.078611111", "27.55"],
      ["Mangok", "9.131006", "27.387391"],
      ["Mayom Wel", "8.75", "27.45"],
      ["Peth Lou", "8.966666667", "27.8"],
      ["Titchok", "8.863611111", "27.5425"],
      ["Warlang", "9.437777778", "27.23777778"],
      ["Wunlang", "9.154444444", "27.43638889"],
      ["Akong", "9.1037933", "27.872325"],
    ],
  },
  {
    county: "Aweil Center",
    fieldBaseCode: "SS-FB-AWEIL-TOWN",
    sites: [
      ["Gabat", "8.759326", "27.385448"],
      ["Kuom", "8.721666667", "27.41583333"],
      ["Aulic", "8.838611111", "27.42388889"],
      ["Alok", "8.443055556", "27.52583333"],
      ["Barmayen", "8.359722222", "27.61472222"],
      ["Baau", "8.439166667", "27.75916667"],
      ["Aroyo", "8.675912", "26.857055"],
      ["Mabong Akot", "8.888888889", "27.89472222"],
      ["Panjap (outreach)", "N 08°36'1.45", "E 027°29'10.71"],
      ["Barlana (outreach)", "N 08°31'7.51", "E 027°31'17.23"],
      ["Kabat (outreach)", "8.320555556", "27.56972222"],
      ["Maluil Akot (outreach)", "8.528055556", "27.77166667"],
      ["Nyalath (outreach)", "N 08°42'41.74", "E 027°17'6.05"],
      ["Longruwec (outreach)", "8.638055556", "27.12"],
      ["Awoda (outreach)", "N 08°04'6.36", "E 026°50'21.86"],
      ["Akuangkar (outreach)", "N 08°48'29.65", "E 026°51'4.22"],
      ["Machot (outreach, seasonal)", "N 08°45'12.11", "E 026°51'59.78"],
    ],
  },
  {
    county: "Duk",
    fieldBaseCode: "SS-FB-DUK",
    sites: [
      ["Duk Padiet", "7.752869", "31.393988"],
      ["Payuel", "7.48257", "31.5107"],
      ["Poktap", "7.45833", "31.41281"],
      ["Pajut", "7.4258", "31.68114"],
      ["Pulguor", "7.98675", "31.46417"],
      ["Pagaak", "7.92935", "31.49575"],
      ["Pajimar", "8.00105", "31.52654"],
      ["Patuet", "7.84937", "31.69672"],
      ["Choltim", "7.87978", "31.72174"],
      ["Tindiir", "7.86276", "31.67986"],
      ["Tiam", "7.78333", "31.77633"],
      ["Khoat", "7.91145", "31.76982"],
      ["Koyoom", "7.48599", "30.85115"],
    ],
  },
  {
    // Two field bases (Alek, Kuajok): sites are left for an admin to link.
    county: "Gogrial West",
    fieldBaseCode: null,
    sites: [
      ["Agei", "8.66394", "28.14856"],
      ["Ajiep", "8.26555", "28.08942"],
      ["Akhon", "8.887348", "27.95695"],
      ["Alek", "8.66394", "28.14856"],
      ["Ariang", "8.789226", "27.8092"],
      ["Atukuel", "8.64406", "27.99594"],
      ["Gogrial", "8.52683", "28.10014"],
      ["Thurnyior PHCU", "8.14492", "28.13195"],
      ["Keet", "8.81848", "28.07093"],
      ["Kuajok Hospital", "8.29658", "27.98236"],
      ["Lukluk", "8.19531", "27.98592"],
      ["Mabil", "8.5849", "27.521761"],
      ["Mabior-Atuot", "8.0633", "27.5722"],
      ["Madol", "8.573979", "27.573353"],
      ["Magai", "8.10439", "28.00818"],
      ["Majak-Bol", "9.14831", "27.9185"],
      ["Rumameth", "8.501784", "28.103581"],
      ["Maluil-Ajak", "8.52884", "27.97612"],
      ["Mandeng", "8.3429", "27.576"],
      ["Mangar", "8.223778", "27.595355"],
      ["Wun-kuel", "8.394814676", "28.85523216"],
      ["Mankuac", "8.413411", "28.1795"],
      ["Mathiangdit", "8.53576", "27.571928"],
      ["Mayen Pajok", "9.01653", "27.92304"],
      ["Mayen-Gumel", "8.45276", "28.120064"],
      ["Mayom", "8.682773", "28.27306"],
      ["Ngapathian", "8.354275", "28.768"],
      ["Nyiel-Kou", "8.3459", "28.22"],
      ["Pajok Bek", "8.341", "28.1331"],
      ["Peeth PHCU", "8.96718", "28.01134"],
      ["Panliet", "8.84237", "28.25539"],
    ],
  },
];

// Decimal degrees from "9.0134", "N 08°36'1.45" or "027°23.107".
function parseCoordinate(raw) {
  const s = String(raw).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = s.match(/^([NSEW])?\s*(\d+)°\s*(\d+(?:\.\d+)?)(?:'\s*(\d+(?:\.\d+)?))?/i);
  if (!m) throw new Error(`Unrecognised coordinate: ${raw}`);
  const [, hemi, deg, min, sec] = m;
  let value = Number(deg) + Number(min) / 60 + (sec ? Number(sec) / 3600 : 0);
  if (hemi && /[SW]/i.test(hemi)) value = -value;
  return Number(value.toFixed(6));
}

const siteCode = (name) => `SS-ST-${name.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "")}`;

// Rough bounding box for South Sudan, to catch swapped/garbled coordinates.
const inSouthSudan = (lat, lon) => lat >= 3 && lat <= 13 && lon >= 23 && lon <= 36;

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const tag = dryRun ? "[dry run] would " : "";

  const counties = await prisma.county.findMany({ where: { implementationId: IMPLEMENTATION_ID } });
  const countyByName = new Map(counties.map((c) => [c.name, c]));

  // Validate everything before writing anything.
  const codes = new Set();
  for (const block of COUNTIES) {
    if (!countyByName.has(block.county)) throw new Error(`County not found: ${block.county}. Run "npx prisma migrate deploy" first.`);
    for (const [name, lat, lon] of block.sites) {
      const code = siteCode(name);
      if (codes.has(code)) throw new Error(`Duplicate site code ${code} (${name})`);
      codes.add(code);
      const la = parseCoordinate(lat);
      const lo = parseCoordinate(lon);
      if (!inSouthSudan(la, lo)) throw new Error(`Coordinates for ${name} fall outside South Sudan: ${la}, ${lo}`);
    }
  }

  const summary = { created: 0, linked: 0, unchanged: 0, unlinked: 0 };

  for (const block of COUNTIES) {
    const county = countyByName.get(block.county);
    let base = null;
    if (block.fieldBaseCode) {
      base = await prisma.facility.findUnique({ where: { code: block.fieldBaseCode } });
      if (!base) throw new Error(`Field base ${block.fieldBaseCode} not found. Run load-south-sudan-field-bases.js first.`);
    }
    console.log(`\n${block.county}: ${block.sites.length} sites${base ? ` -> ${base.name}` : " (left unlinked: several field bases)"}`);

    for (const [name, lat, lon] of block.sites) {
      const code = siteCode(name);
      const existing = await prisma.facility.findUnique({ where: { code } });

      if (existing) {
        if (existing.implementationId !== IMPLEMENTATION_ID) throw new Error(`Code ${code} is used in another programme.`);
        if (base && !existing.parentStockLocationId) {
          console.log(`  ${tag}link   ${name}`);
          if (!dryRun) {
            await prisma.facility.update({
              where: { id: existing.id },
              data: { parentStockLocationId: base.id, warehouseId: base.id },
            });
          }
          summary.linked += 1;
        } else {
          summary.unchanged += 1;
        }
        continue;
      }

      console.log(`  ${tag}create ${name.padEnd(28)} ${code}`);
      if (!dryRun) {
        await prisma.facility.create({
          data: {
            code,
            name,
            type: "FACILITY", // legacy type for stores (dispatch/receive/user rules)
            stockLocationType: "CLINIC_STORE",
            implementationId: IMPLEMENTATION_ID,
            countyId: county.id,
            latitude: parseCoordinate(lat),
            longitude: parseCoordinate(lon),
            parentStockLocationId: base ? base.id : null,
            // Legacy link used by dispatch: a site is supplied by its warehouse.
            warehouseId: base ? base.id : null,
          },
        });
      }
      summary.created += 1;
      if (!base) summary.unlinked += 1;
    }
  }

  console.log(
    `\n${dryRun ? "[dry run] " : ""}Sites: ${summary.created} created (${summary.unlinked} left unlinked), ${summary.linked} linked, ${summary.unchanged} already present.`
  );
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
