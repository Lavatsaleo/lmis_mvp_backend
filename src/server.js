require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const boxesRoutes = require("./routes/boxes");
const txRoutes = require("./routes/transactions");
const orderRoutes = require("./routes/orders");

const app = express();

// TEMP for MVP: allow all origins (we’ll lock this down later)
app.use(cors());
app.use(helmet());
app.use(morgan("dev"));
app.use(express.json({ limit: "2mb" }));

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);

// Put specific routes first
app.use("/api/boxes", boxesRoutes);
app.use("/api/transactions", txRoutes);
app.use("/api/orders", orderRoutes);

// Keep /api (me + users) last
app.use("/api", userRoutes);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`✅ API running: http://localhost:${PORT}`);
});
