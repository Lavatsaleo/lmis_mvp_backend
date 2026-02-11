// scripts/reset_order.js
const prisma = require("../src/lib/prisma");

async function main() {
  const orderNumber = process.argv[2];
  const donorName = process.argv[3];

  if (!orderNumber) {
    console.log('Usage: node scripts/reset_order.js "SPO-ISL-00884-001" "Innocent Foundation"');
    process.exit(1);
  }

  const order = await prisma.order.findUnique({ where: { orderNumber } });
  if (!order) {
    console.log("❌ Order not found:", orderNumber);
    process.exit(1);
  }

  // Update donorName (force set to your required donor)
  if (donorName) {
    await prisma.order.update({
      where: { id: order.id },
      data: { donorName },
    });
  }

  // Delete BoxEvents first (FK safety), then Boxes
  const deletedEvents = await prisma.boxEvent.deleteMany({
    where: { box: { orderId: order.id } },
  });

  const deletedBoxes = await prisma.box.deleteMany({
    where: { orderId: order.id },
  });

  console.log("✅ Reset complete for order:", orderNumber);
  console.log("Deleted BoxEvents:", deletedEvents.count);
  console.log("Deleted Boxes:", deletedBoxes.count);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("❌ Reset failed:", e);
  await prisma.$disconnect();
  process.exit(1);
});
