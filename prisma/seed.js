require("dotenv").config();
const bcrypt = require("bcrypt");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const KENYA_COUNTRY_ID = "country_kenya";
const KENYA_IMPLEMENTATION_ID = "impl_kenya_sqlns";

async function ensureKenyaPlatformContext() {
  const country = await prisma.country.upsert({
    where: { code: "KE" },
    update: { name: "Kenya", isActive: true },
    create: {
      id: KENYA_COUNTRY_ID,
      code: "KE",
      name: "Kenya",
      isActive: true,
    },
  });

  const implementation = await prisma.implementation.upsert({
    where: {
      countryId_code: {
        countryId: country.id,
        code: "SQLNS",
      },
    },
    update: { name: "SQLNS Programme", isActive: true },
    create: {
      id: KENYA_IMPLEMENTATION_ID,
      countryId: country.id,
      code: "SQLNS",
      name: "SQLNS Programme",
      isActive: true,
    },
  });

  for (const module of ["LOGISTICS", "PHARMACY", "CLINICAL"]) {
    await prisma.implementationModule.upsert({
      where: {
        implementationId_module: {
          implementationId: implementation.id,
          module,
        },
      },
      update: { isEnabled: true },
      create: {
        implementationId: implementation.id,
        module,
        isEnabled: true,
      },
    });
  }

  return implementation.id;
}

async function main() {
  const implementationId = await ensureKenyaPlatformContext();

  // Safe backfill for local/dev databases where the seed is run after upgrading.
  await Promise.all([
    prisma.facility.updateMany({
      where: { implementationId: null },
      data: { implementationId },
    }),
    prisma.product.updateMany({
      where: { implementationId: null },
      data: { implementationId },
    }),
    prisma.user.updateMany({
      where: { implementationId: null },
      data: { implementationId },
    }),
  ]);

  const email = process.env.SEED_ADMIN_EMAIL || "admin@lmis.local";
  const password = process.env.SEED_ADMIN_PASSWORD || "Admin@1234!";
  const fullName = "LMIS Super Admin";

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (!existing.implementationId) {
      await prisma.user.update({
        where: { id: existing.id },
        data: { implementationId },
      });
    }
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
      implementationId,
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
