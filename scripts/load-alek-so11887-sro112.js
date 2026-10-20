// Load SQ-LNS stock at Alek Field Base and the August 2026 distribution to its sites.
//
//   1. Product SS-SQLNS and donor CIFF (created if missing)
//   2. Purchase order SO11887 (Edesia, 1,640 cartons) received at Alek on 7 Aug 2026:
//      886 cartons batch FG8010X + 754 batch FG8010, expiry 31 Oct 2027 (labels SO11887-1..1640)
//   3. Stock Release Order SS-ALK-LOG-112: 568 cartons dispatched from Alek to 31 sites
//      on 10 Aug 2026 (waybill = the line's delivery note) and received at each site.
//
// Everything goes through the running API (same rules, events, labels and waybills as the
// apps), as a Super Admin; afterwards the dates are set to when it really happened.
//
// Run from the backend folder on the server:
//   node scripts/load-alek-so11887-sro112.js --as <super-admin-email>            (dry run: checks only)
//   node scripts/load-alek-so11887-sro112.js --as <super-admin-email> --apply    (does it)
// Safe to re-run: finished parts are recognised and skipped.

require("dotenv").config({ quiet: true });
const { prisma } = require("../src/db");
const { signAccessToken } = require("../src/utils");

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const APPLY = args.includes("--apply");
const AS = arg("--as");
const API = (arg("--api") || `http://localhost:${process.env.PORT || 4000}`).replace(/\/+$/, "") + "/api";

const IMPL = "impl_south_sudan_logistics";
const ALEK = "SS-FB-ALEK";
const PO_NUMBER = "SO11887";
const RECEIVED_AT = "2026-08-07T09:00:00.000Z"; // 12:00 in South Sudan
const DISPATCHED_AT = new Date("2026-08-10T06:00:00.000Z"); // 09:00
const SITE_RECEIVED_AT = new Date("2026-08-10T13:00:00.000Z"); // 16:00
const SRO = "SS-ALK-LOG-112";

// SRO SS-ALK-LOG-112 (7 Aug 2026). The SRO uses delivery note SS-AK-LOG-1285 twice (Atukuel and
// Gogrial); waybill numbers must be unique, so Gogrial's is recorded as SS-AK-LOG-1285-B.
const LINES = [
  ["SS-ST-AGEI", 29, "SS-AK-LOG-1280"],
  ["SS-ST-AJIEP", 17, "SS-AK-LOG-1281"],
  ["SS-ST-AKHON", 12, "SS-AK-LOG-1282"],
  ["SS-ST-ALEK", 23, "SS-AK-LOG-1283"],
  ["SS-ST-ARIANG", 12, "SS-AK-LOG-1284"],
  ["SS-ST-ATUKUEL", 17, "SS-AK-LOG-1285"],
  ["SS-ST-GOGRIAL", 35, "SS-AK-LOG-1285-B"],
  ["SS-ST-KEET", 20, "SS-AK-LOG-1286"],
  ["SS-ST-KUAJOK-HOSPITAL", 30, "SS-AK-LOG-1287"],
  ["SS-ST-LUKLUK", 24, "SS-AK-LOG-1288"],
  ["SS-ST-MABIL", 13, "SS-AK-LOG-1289"],
  ["SS-ST-MABIOR-ATUOT", 23, "SS-AK-LOG-1290"],
  ["SS-ST-MADOL", 12, "SS-AK-LOG-1291"],
  ["SS-ST-MAGAI", 23, "SS-AK-LOG-1292"],
  ["SS-ST-MAJAK-BOL", 14, "SS-AK-LOG-1293"],
  ["SS-ST-MALUIL-AJAK", 10, "SS-AK-LOG-1294"],
  ["SS-ST-MANDENG", 20, "SS-AK-LOG-1295"],
  ["SS-ST-MANGAR", 16, "SS-AK-LOG-1296"],
  ["SS-ST-MANKUAC", 14, "SS-AK-LOG-1297"],
  ["SS-ST-MATHIANGDIT", 20, "SS-AK-LOG-1298"],
  ["SS-ST-MAYEN-PAJOK", 11, "SS-AK-LOG-1299"],
  ["SS-ST-MAYEN-GUMEL", 16, "SS-AK-LOG-1230"],
  ["SS-ST-MAYOM", 25, "SS-AK-LOG-1231"],
  ["SS-ST-NGAPATHIAN", 19, "SS-AK-LOG-1232"],
  ["SS-ST-NYIEL-KOU", 14, "SS-AK-LOG-1233"],
  ["SS-ST-PAJOK-BEK", 16, "SS-AK-LOG-1234"],
  ["SS-ST-PANLIET", 24, "SS-AK-LOG-1235"],
  ["SS-ST-PEETH-PHCU", 14, "SS-AK-LOG-1236"],
  ["SS-ST-RUMAMETH", 14, "SS-AK-LOG-1237"],
  ["SS-ST-THURNYIOR-PHCU", 18, "SS-AK-LOG-1238"],
  ["SS-ST-WUN-KUEL", 13, "SS-AK-LOG-1239"],
];

let token = null;
async function call(method, path, body, idem) {
  const r = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(idem ? { "X-Idempotency-Key": idem } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${json?.message || JSON.stringify(json)}`);
  return json;
}
const uidNo = (uid) => Number(String(uid).split("-").pop());

(async () => {
  let ok = true;
  const say = (m) => console.log(m);
  const problem = (m) => {
    ok = false;
    console.log("  PROBLEM: " + m);
  };
  try {
    say(`Mode: ${APPLY ? "APPLY (writes to the database)" : "DRY RUN (nothing is changed)"}`);
    say(`API: ${API}`);
    if (!AS) throw new Error("Pass --as <email of an active SUPER_ADMIN>");

    // ---------------------------------------------------------------- checks
    say("\n1. Checks");
    const admin = await prisma.user.findFirst({ where: { email: AS, role: "SUPER_ADMIN", isActive: true } });
    if (!admin) throw new Error(`No active SUPER_ADMIN with email ${AS}`);
    token = signAccessToken({ userId: admin.id });
    say(`  acting as ${admin.email}`);
    const health = await fetch(API.replace(/\/api$/, "") + "/health").then((r) => r.json()).catch(() => null);
    if (!health?.ok) throw new Error(`The API is not answering at ${API} (is the backend running?)`);
    const impl = await prisma.implementation.findUnique({ where: { id: IMPL } });
    if (!impl) throw new Error("South Sudan implementation missing (run the migrations first)");
    const alek = await prisma.facility.findUnique({ where: { code: ALEK } });
    if (!alek) throw new Error(`${ALEK} not found (load the South Sudan locations first)`);
    const sites = await prisma.facility.findMany({ where: { code: { in: LINES.map((l) => l[0]) } } });
    const siteByCode = new Map(sites.map((s) => [s.code, s]));
    for (const [code] of LINES) {
      const s = siteByCode.get(code);
      if (!s) problem(`site ${code} not found`);
      else if (s.parentStockLocationId !== alek.id) problem(`site ${code} is not linked to Alek`);
    }
    const total = LINES.reduce((n, l) => n + l[1], 0);
    say(`  Alek ok, ${sites.length}/${LINES.length} sites found and linked, ${total} cartons on the SRO`);
    if (total !== 568) problem(`SRO total is ${total}, expected 568`);
    if (!ok) throw new Error("Fix the problems above first");

    // ---------------------------------------------------------- product/donor
    say("\n2. Product and donor");
    let product = await prisma.product.findUnique({ where: { code: "SS-SQLNS" } });
    if (product && product.implementationId !== IMPL) throw new Error("Product code SS-SQLNS belongs to another country");
    say(`  product SS-SQLNS: ${product ? "exists" : "will be created"}`);
    let donor = await prisma.donor.findFirst({ where: { implementationId: IMPL, name: "CIFF" } });
    say(`  donor CIFF: ${donor ? "exists" : "will be created"}`);
    if (APPLY && !product) {
      product = await call("POST", "/products", {
        code: "SS-SQLNS",
        name: "SQLNS",
        implementationId: IMPL,
        baseUnitName: "Sachet",
        packUnitName: "Carton",
        unitsPerPack: 600,
        grossPackWeightKg: 13.2,
        cartonsPerPallet: 90,
        defaultUnitValue: 0.0798,
        defaultCurrencyCode: "USD",
      });
      product = product.product || product;
      say("  product created");
    }
    if (APPLY && !donor) {
      donor = await call("POST", "/donors", { name: "CIFF", implementationId: IMPL });
      donor = donor.donor || donor;
      say("  donor created");
    }

    // ------------------------------------------------------------ PO+receipt
    say("\n3. Purchase order SO11887 received at Alek on 7 Aug 2026");
    let po = await prisma.purchaseOrder.findFirst({ where: { implementationId: IMPL, poNumber: PO_NUMBER }, include: { lines: true } });
    say(`  purchase order: ${po ? `exists (${po.status})` : "will be created"}`);
    if (APPLY && !po) {
      const created = await call("POST", "/purchase-orders", {
        poNumber: PO_NUMBER,
        supplierName: "Edesia Nutrition",
        destinationWarehouseId: alek.id,
        orderDate: "2025-12-17",
        expectedDeliveryDate: "2026-06-05",
        currencyCode: "USD",
        note: "Edesia Sales Order 11887 / PO ref ACF_Innovation_122025 / invoice 12199 / Kenfreight file TRT260182. RAMP project, CIFF-funded SQ-LNS (Enov NB Plus). This PO covers the 1,640 cartons placed at Alek.",
        lines: [{ productId: product.id, donorId: donor.id, grantCode: "RAMP", quantityPacks: 1640, unitPrice: 47.88 }],
      });
      po = await prisma.purchaseOrder.findUnique({ where: { id: created.id }, include: { lines: true } });
      say("  purchase order created");
    }
    if (po && po.lines[0].receivedPacks === 0) {
      say("  receipt: will receive 886 x FG8010X + 754 x FG8010 (expiry 2027-10-31)");
      if (APPLY) {
        await call(
          "POST",
          `/purchase-orders/${po.id}/receipts`,
          {
            receivedAt: RECEIVED_AT,
            deliveryNote: "TRT260182",
            note: "Enov NB Plus (SQ-LNS) received at Alek. Recorded in Anchor from the delivery documents.",
            lines: [
              { lineId: po.lines[0].id, batchNo: "FG8010X", expiryDate: "2027-10-31", packs: 886 },
              { lineId: po.lines[0].id, batchNo: "FG8010", expiryDate: "2027-10-31", packs: 754 },
            ],
          },
          "SO11887-ALEK-INITIAL"
        );
        say("  received: 1,640 cartons, labels SO11887-1 to SO11887-1640");
      }
    } else if (po) {
      say(`  receipt: already done (${po.lines[0].receivedPacks} cartons received)`);
    } else {
      say("  receipt: 886 x FG8010X + 754 x FG8010 after the PO is created");
    }

    // -------------------------------------------------------------- SRO lines
    say(`\n4. ${SRO}: dispatch to 31 sites on 10 Aug 2026 and receive there`);
    const productId = product?.id;
    const doneShipments = await prisma.shipment.findMany({ where: { manifestNo: { in: LINES.map((l) => l[2]) } }, select: { manifestNo: true, status: true } });
    const done = new Map(doneShipments.map((s) => [s.manifestNo, s.status]));
    const atAlek = productId
      ? (await prisma.box.findMany({
          where: { productId, currentFacilityId: alek.id, status: "IN_WAREHOUSE", heldAt: null },
          select: { boxUid: true, batchNo: true },
        })).sort((a, b) => uidNo(a.boxUid) - uidNo(b.boxUid))
      : [];
    const needed = LINES.filter((l) => !done.has(l[2])).reduce((n, l) => n + l[1], 0);
    say(`  cartons at Alek now: ${atAlek.length}${APPLY || po ? "" : " (1,640 after the receipt)"} · still to send: ${needed} · lines already recorded: ${done.size}/31`);
    if (APPLY && atAlek.length < needed) throw new Error(`Only ${atAlek.length} cartons at Alek, ${needed} needed`);

    let next = 0;
    const stamped = [];
    for (const [code, qty, dn] of LINES) {
      const site = siteByCode.get(code);
      if (done.get(dn) === "RECEIVED") continue;
      if (!APPLY) {
        say(`  ${dn.padEnd(17)} ${String(qty).padStart(3)} cartons -> ${site.name}`);
        continue;
      }
      let shipment = await prisma.shipment.findUnique({ where: { manifestNo: dn }, include: { items: { include: { box: { select: { boxUid: true } } } } } });
      if (!shipment) {
        const boxes = atAlek.slice(next, next + qty);
        next += qty;
        const d = await call(
          "POST",
          "/boxes/dispatch",
          {
            fromFacilityId: alek.id,
            toFacilityId: site.id,
            boxUids: boxes.map((b) => b.boxUid),
            manifestNo: dn,
            note: `${SRO} · delivery note ${dn === "SS-AK-LOG-1285-B" ? "SS-AK-LOG-1285 (used twice on the SRO)" : dn}`,
          },
          `${SRO}:${code}`
        );
        shipment = await prisma.shipment.findUnique({ where: { id: d.shipmentId }, include: { items: { include: { box: { select: { boxUid: true } } } } } });
      }
      if (shipment.status !== "RECEIVED") {
        await call(
          "POST",
          "/boxes/facility-receive",
          {
            toFacilityId: site.id,
            shipmentId: shipment.id,
            boxUids: shipment.items.map((i) => i.box.boxUid),
            note: `Received at ${site.name} (${SRO})`,
          },
          `${SRO}:${code}:receive`
        );
      }
      stamped.push(shipment.id);
      say(`  ${dn.padEnd(17)} ${String(qty).padStart(3)} cartons -> ${site.name}: dispatched and received`);
    }

    // ---------------------------------------------------------- real dates
    // Date every SRO shipment, including ones from an earlier, interrupted run.
    if (APPLY) {
      const all = await prisma.shipment.findMany({ where: { manifestNo: { in: LINES.map((l) => l[2]) }, fromWarehouseId: alek.id }, select: { id: true } });
      stamped.splice(0, stamped.length, ...all.map((s) => s.id));
    }
    if (APPLY && stamped.length) {
      say("\n5. Setting the real dates (10 Aug 2026)");
      const items = await prisma.shipmentItem.findMany({ where: { shipmentId: { in: stamped } }, select: { boxId: true, shipment: { select: { fromWarehouseId: true, toFacilityId: true } } } });
      await prisma.$transaction(async (tx) => {
        await tx.shipment.updateMany({ where: { id: { in: stamped } }, data: { dispatchedAt: DISPATCHED_AT, receivedAt: SITE_RECEIVED_AT, createdAt: DISPATCHED_AT } });
        await tx.shipmentItem.updateMany({ where: { shipmentId: { in: stamped } }, data: { receivedAt: SITE_RECEIVED_AT } });
        const boxIds = items.map((i) => i.boxId);
        await tx.boxEvent.updateMany({ where: { boxId: { in: boxIds }, type: "DISPATCH", fromFacilityId: alek.id }, data: { createdAt: DISPATCHED_AT } });
        await tx.boxEvent.updateMany({ where: { boxId: { in: boxIds }, type: "FACILITY_RECEIVE" }, data: { createdAt: SITE_RECEIVED_AT } });
      });
      say(`  ${stamped.length} shipments and their box events dated 10 Aug 2026`);
    }

    // --------------------------------------------------------------- result
    if (productId) {
      say("\n6. Result");
      const byPlace = await prisma.box.groupBy({ by: ["currentFacilityId", "status"], where: { productId }, _count: { _all: true } });
      const alekNow = byPlace.filter((r) => r.currentFacilityId === alek.id).reduce((n, r) => n + r._count._all, 0);
      const siteIds = new Set(sites.map((s) => s.id));
      const atSites = byPlace.filter((r) => siteIds.has(r.currentFacilityId) && r.status === "IN_FACILITY").reduce((n, r) => n + r._count._all, 0);
      const transit = byPlace.filter((r) => r.status === "IN_TRANSIT").reduce((n, r) => n + r._count._all, 0);
      say(`  Alek: ${alekNow} cartons (expected 1072) · at the 31 sites: ${atSites} (expected 568) · in transit: ${transit} (expected 0)`);
    }
    say(APPLY ? "\nDone." : "\nDry run finished: nothing was changed. Re-run with --apply to load.");
  } catch (err) {
    console.error("\nSTOPPED: " + (err.message || err));
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
