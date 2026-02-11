const prisma = require("../src/lib/prisma"); // use prisma

async function main() {
  const warehouseCode = process.argv[2];
  if (!warehouseCode) {
    console.log("Usage: node scripts/backfillWarehouse.js WH-A");
    process.exit(1);
  }

  const wh = await prisma.facility.findUnique({ where: { code: warehouseCode } });
  if (!wh) throw new Error(`Warehouse with code "${warehouseCode}" not found`);

  const result = await prisma.facility.updateMany({
    where: { type: "FACILITY", warehouseId: null },
    data: { warehouseId: wh.id },
  });

  console.log(`✅ Linked ${result.count} facilities to warehouse ${wh.code} (${wh.id})`);
}

main()
  .catch((e) => {
    console.error("❌ Error:", e.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
