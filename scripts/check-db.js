require("dotenv").config();
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function main() {
  const db = await prisma.$queryRaw`SELECT DATABASE() AS db`;
  const boxCount = await prisma.box.count();
  const orderCount = await prisma.order.count();
  const facilityCount = await prisma.facility.count();

  console.log("DATABASE() =>", db);
  console.log("Counts =>", { boxCount, orderCount, facilityCount });
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
m