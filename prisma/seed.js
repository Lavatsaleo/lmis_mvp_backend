require("dotenv").config();
const bcrypt = require("bcrypt");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL || "admin@lmis.local";
  const password = process.env.SEED_ADMIN_PASSWORD || "Admin@1234!";
  const fullName = "LMIS Super Admin";

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log("Seed admin already exists:", email);
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);

  await prisma.user.create({
    data: {
      email,
      fullName,
      passwordHash,
      role: "SUPER_ADMIN",
      isActive: true,
    },
  });

  console.log("✅ Seeded SUPER_ADMIN:", email, "password:", password);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
