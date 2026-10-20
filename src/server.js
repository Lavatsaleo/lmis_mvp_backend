require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const boxesRoutes = require("./routes/boxes");
const orderRoutes = require("./routes/orders");
const facilityRoutes = require("./routes/facilities");
const clinicalRoutes = require("./routes/clinical");
const shipmentRoutes = require("./routes/shipments");
const stockLocationRoutes = require("./routes/stockLocations");
const productRoutes = require("./routes/products");
const inventoryRoutes = require("./routes/inventory");
const implementationRoutes = require("./routes/implementations");
const countyRoutes = require("./routes/counties");
const warehouseRoutes = require("./routes/warehouses");
const donorRoutes = require("./routes/donors");
const purchaseOrderRoutes = require("./routes/purchaseOrders");
const warehouseReportRoutes = require("./routes/warehouseReports");
const stockAdjustmentRoutes = require("./routes/stockAdjustments");
const stockCountRoutes = require("./routes/stockCounts");
const labelRoutes = require("./routes/labels");
const dhis2Routes = require("./routes/dhis2");
const dhis2ChildrenRoutes = require("./routes/dhis2Children");
const dhis2Sync = require("./dhis2/sync");

// ✅ ADD THIS (new)
const dashboardRoutes = require("./routes/dashboard");

const app = express();

// Behind a reverse proxy (nginx, a load balancer) set TRUST_PROXY, e.g. "1"
// for one hop, so req.ip is the real client for sign-in rate limits and audit.
if (process.env.TRUST_PROXY) {
  const value = process.env.TRUST_PROXY;
  app.set("trust proxy", /^\d+$/.test(value) ? Number(value) : value === "true" ? true : value);
}

// TEMP for MVP: allow all origins (we’ll lock this down later)
app.use(cors());
app.use(helmet());
app.use(morgan("dev"));
app.use(express.json({ limit: "2mb" }));

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);

// Put specific routes first
app.use("/api/boxes", boxesRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/facilities", facilityRoutes);
app.use("/api/clinical", clinicalRoutes);
app.use("/api/shipments", shipmentRoutes);
app.use("/api/stock-locations", stockLocationRoutes);
app.use("/api/products", productRoutes);
app.use("/api/inventory", inventoryRoutes);
app.use("/api/implementations", implementationRoutes);
app.use("/api/counties", countyRoutes);
app.use("/api/warehouses", warehouseRoutes);
app.use("/api/donors", donorRoutes);
app.use("/api/purchase-orders", purchaseOrderRoutes);
app.use("/api/warehouse-reports", warehouseReportRoutes);
app.use("/api/stock-adjustments", stockAdjustmentRoutes);
app.use("/api/stock-counts", stockCountRoutes);
app.use("/api/labels", labelRoutes);
app.use("/api/dhis2", dhis2Routes);
app.use("/api/dhis2-children", dhis2ChildrenRoutes);

// ✅ ADD THIS (new) — keep it BEFORE app.use("/api", userRoutes)
app.use("/api/dashboard", dashboardRoutes);

// Keep /api (me + users) last
app.use("/api", userRoutes);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅ API running: http://localhost:${PORT}`);
  dhis2Sync.startScheduler();
});