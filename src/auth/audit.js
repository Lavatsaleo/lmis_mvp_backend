// Append-only audit trail for account administration and sign-in security.
// Never throws: a failed audit write must not break the action it records.

const prisma = require("../lib/prisma");
const { clientIp } = require("./access");

async function audit(req, { action, target = null, targetType = null, implementationId = null, details = null, actor = null }) {
  try {
    const who = actor || req?.user || null;
    await prisma.auditLog.create({
      data: {
        action,
        actorId: who?.id || null,
        actorEmail: who?.email || null,
        targetType: targetType || (target ? "USER" : null),
        targetId: target?.id || null,
        targetLabel: target ? String(target.email || target.name || target.code || target.id).slice(0, 191) : null,
        implementationId: implementationId || target?.implementationId || who?.implementationId || null,
        details: details || undefined,
        ipAddress: req ? clientIp(req) : null,
      },
    });
  } catch (err) {
    console.error("audit log write failed:", err.message || err);
  }
}

module.exports = { audit };
