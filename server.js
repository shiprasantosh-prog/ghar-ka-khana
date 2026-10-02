
require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET;

if (!SECRET) {
  console.warn("Set JWT_SECRET in environment variables before production use.");
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing from environment variables.");
}

// Neon PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

pool.on("error", (err) => {
  console.error("Unexpected PostgreSQL error:", err);
});
app.set("trust proxy", 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "200kb" }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

const asyncRoute = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// Create PostgreSQL tables
async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      address TEXT DEFAULT '',
      role TEXT NOT NULL DEFAULT 'customer',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS menu (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      category TEXT NOT NULL,
      price INTEGER NOT NULL CHECK (price > 0),
      image TEXT DEFAULT '',
      available BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      total INTEGER NOT NULL,
      address TEXT NOT NULL,
      notes TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Received',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      menu_id INTEGER,
      item_name TEXT NOT NULL,
      unit_price INTEGER NOT NULL,
      quantity INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS daily_specials (
      id SERIAL PRIMARY KEY,
      special_date DATE NOT NULL,
      menu_id INTEGER NOT NULL REFERENCES menu(id),
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (special_date, menu_id)
    );
  `);

  // Create owner account if it does not exist
  if (process.env.ADMIN_PHONE && process.env.ADMIN_PASSWORD) {
    const existing = await pool.query(
      "SELECT id FROM users WHERE phone = $1",
      [process.env.ADMIN_PHONE]
    );

    if (existing.rowCount === 0) {
      await pool.query(
        `INSERT INTO users
         (name, phone, email, password_hash, role)
         VALUES ($1, $2, $3, $4, 'admin')`,
        [
          process.env.ADMIN_NAME || "Ghar ka Khana Owner",
          process.env.ADMIN_PHONE,
          process.env.ADMIN_EMAIL || null,
          bcrypt.hashSync(process.env.ADMIN_PASSWORD, 12)
        ]
      );

      console.log("Owner account created.");
    }
  }

  // Add starter menu only when menu table is empty
  const count = await pool.query("SELECT COUNT(*) AS n FROM menu");

  if (Number(count.rows[0].n) === 0) {
    const starterMenu = [
      ["Paneer Makhani", "Soft paneer in a rich tomato gravy", "Main Course", 160, ""],
      ["Matar Paneer", "Paneer and peas in homestyle masala", "Main Course", 150, ""],
      ["Aloo Do Pyaza", "Potatoes with onions and aromatic spices", "Main Course", 150, ""],
      ["Daal Fry", "Comforting lentils finished with tadka", "Main Course", 120, ""],
      ["Aloo Paratha", "Golden paratha stuffed with spiced potato", "Parathas", 60, ""],
      ["Paneer Paratha", "Flaky paratha with savoury paneer filling", "Parathas", 80, ""],
      ["Pav Bhaji", "Spiced vegetable mash with pav", "Snacks", 120, ""],
      ["Samosa", "Crisp pastry with potato filling", "Snacks", 25, ""],
      ["Poha", "Light flattened rice with peanuts and herbs", "Breakfast", 90, ""]
    ];

    for (const item of starterMenu) {
      await pool.query(
        `INSERT INTO menu (name, description, category, price, image)
         VALUES ($1, $2, $3, $4, $5)`,
        item
      );
    }

    console.log("Starter menu created.");
  }

  console.log("PostgreSQL database is ready.");
}

function tokenFor(user) {
  return jwt.sign(
    { id: user.id, role: user.role },
    SECRET || "dev-only-change-me",
    { expiresIn: "7d" }
  );
}

function auth(req, res, next) {
  try {
    const token =
      req.cookies.gkk_token ||
      ((req.headers.authorization || "").startsWith("Bearer ")
        ? req.headers.authorization.slice(7)
        : null);

    if (!token) throw Error();

    req.user = jwt.verify(token, SECRET || "dev-only-change-me");
    next();
  } catch (e) {
    res.status(401).json({ error: "Please sign in." });
  }
}

function admin(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Owner access required." });
  }
  next();
}

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false
});

app.use("/api", limiter);

// Customer registration
app.post("/api/auth/register", asyncRoute(async (req, res) => {
  const { name, phone, email, password, address = "" } = req.body || {};

  if (!name || !phone || !password || String(password).length < 8) {
    return res.status(400).json({
      error: "Name, phone and password (8+ characters) are required."
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO users
       (name, phone, email, password_hash, address)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, phone, email, address, role`,
      [
        name.trim(),
        phone.trim(),
        email || null,
        bcrypt.hashSync(password, 12),
        address
      ]
    );

    const user = result.rows[0];

    res.cookie("gkk_token", tokenFor(user), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 7 * 864e5
    });

    res.json({ user });
  } catch (e) {
    if (e.code === "23505") {
      return res.status(409).json({
        error: "Phone or email already registered."
      });
    }
    throw e;
  }
}));

// Customer login
app.post("/api/auth/login", asyncRoute(async (req, res) => {
  const { phone, password } = req.body || {};

  const result = await pool.query(
    "SELECT * FROM users WHERE phone = $1",
    [phone || ""]
  );

  const user = result.rows[0];

  if (!user || !bcrypt.compareSync(password || "", user.password_hash)) {
    return res.status(401).json({ error: "Invalid phone or password." });
  }

  const safeUser = {
    id: user.id,
    name: user.name,
    phone: user.phone,
    email: user.email,
    address: user.address,
    role: user.role
  };

  res.cookie("gkk_token", tokenFor(safeUser), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 864e5
  });

  res.json({ user: safeUser });
}));

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("gkk_token").json({ ok: true });
});

// Current customer session
app.get("/api/auth/me", auth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT id, name, phone, email, address, role
     FROM users WHERE id = $1`,
    [req.user.id]
  );

  res.json({ user: result.rows[0] || null });
}));

// Update the signed-in customer's profile. Phone numbers remain fixed because they identify the login account.
app.patch("/api/auth/profile", auth, asyncRoute(async (req, res) => {
  const { name, email, address } = req.body || {};
  if (!String(name || "").trim()) {
    return res.status(400).json({ error: "Name is required." });
  }
  try {
    const result = await pool.query(
      `UPDATE users
       SET name = $1, email = $2, address = $3
       WHERE id = $4
       RETURNING id, name, phone, email, address, role`,
      [String(name).trim(), String(email || "").trim() || null, String(address || "").trim(), req.user.id]
    );
    res.json({ user: result.rows[0] });
  } catch (e) {
    if (e.code === "23505") {
      return res.status(409).json({ error: "That email address is already in use." });
    }
    throw e;
  }
}));

// Public menu
app.get("/api/menu", asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT id, name, description, category, price, image, available
     FROM menu
     WHERE available = TRUE
     ORDER BY category, name`
  );

  res.json(result.rows);
}));

// Owner menu
app.get("/api/admin/menu", auth, admin, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT id, name, description, category, price, image, available
     FROM menu ORDER BY category, name`
  );

  res.json(result.rows);
}));


// Get daily specials for customers
app.get("/api/specials", asyncRoute(async (req, res) => {
  const requestedDate = req.query.date;

  if (requestedDate && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
    return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD." });
  }

  const result = await pool.query(
    `SELECT m.id, m.name, m.description, m.category, m.price, m.image, m.available
     FROM daily_specials ds
     JOIN menu m ON m.id = ds.menu_id
     WHERE ds.special_date = COALESCE(
       $1::date,
       (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date
     )
     AND m.available = TRUE
     ORDER BY m.category, m.name`,
    [requestedDate || null]
  );

  res.json(result.rows);
}));

// Get saved specials for the owner
app.get("/api/admin/specials", auth, admin, asyncRoute(async (req, res) => {
  const requestedDate = req.query.date;

  if (requestedDate && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
    return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD." });
  }

  const result = await pool.query(
    `SELECT menu_id
     FROM daily_specials
     WHERE special_date = COALESCE(
       $1::date,
       (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date
     )
     ORDER BY menu_id`,
    [requestedDate || null]
  );

  res.json(result.rows.map(row => row.menu_id));
}));

// Save daily specials (owner only)
app.put("/api/admin/specials", auth, admin, asyncRoute(async (req, res) => {
  const { date, menuIds } = req.body || {};

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Array.isArray(menuIds)) {
    return res.status(400).json({
      error: "A valid date and list of menu item IDs are required."
    });
  }

  const ids = [...new Set(menuIds.map(Number))];

  if (ids.some(id => !Number.isInteger(id) || id < 1)) {
    return res.status(400).json({ error: "Invalid menu item ID." });
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (ids.length > 0) {
      const check = await client.query(
        `SELECT id FROM menu WHERE id = ANY($1::int[]) AND available = TRUE`,
        [ids]
      );

      if (check.rowCount !== ids.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "One or more selected dishes are unavailable or do not exist."
        });
      }
    }

    await client.query(
      "DELETE FROM daily_specials WHERE special_date = $1::date",
      [date]
    );

    for (const id of ids) {
      await client.query(
        `INSERT INTO daily_specials (special_date, menu_id)
         VALUES ($1::date, $2)`,
        [date, id]
      );
    }

    await client.query("COMMIT");

    res.json({
      ok: true,
      date,
      menuIds: ids,
      message: "Daily specials saved successfully."
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}));


// Bulk import menu from owner-uploaded CSV
app.post("/api/admin/menu/import", auth, admin, asyncRoute(async (req, res) => {
  const { items } = req.body || {};

  if (!Array.isArray(items) || items.length < 1 || items.length > 1000) {
    return res.status(400).json({
      error: "Upload a CSV containing between 1 and 1,000 menu rows."
    });
  }

  const clean = [];
  const seen = new Set();

  for (let i = 0; i < items.length; i++) {
    const row = items[i] || {};
    const name = String(row.name || "").trim();
    const category = String(row.category || "").trim();
    const price = Number(row.price);

    if (!name || !category || !Number.isInteger(price) || price < 1) {
      return res.status(400).json({
        error: `Row ${i + 1}: name, category and a positive whole-number price are required.`
      });
    }

    if (name.length > 100 || category.length > 60) {
      return res.status(400).json({
        error: `Row ${i + 1}: name or category is too long.`
      });
    }

    const key = `${category.toLowerCase()}::${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    clean.push({
      name,
      category,
      price,
      description: String(row.description || "").trim().slice(0, 500),
      image: String(row.image || "").trim().slice(0, 1000),
      available:
        row.available === false ||
        String(row.available).toLowerCase() === "false" ||
        String(row.available) === "0"
          ? false
          : true
    });
  }

  const client = await pool.connect();
  let inserted = 0;
  let updated = 0;

  try {
    await client.query("BEGIN");

    for (const item of clean) {
      const existing = await client.query(
        `SELECT id FROM menu
         WHERE LOWER(name) = LOWER($1)
         AND LOWER(category) = LOWER($2)
         ORDER BY id LIMIT 1`,
        [item.name, item.category]
      );

      if (existing.rowCount) {
        await client.query(
          `UPDATE menu
           SET name = $1,
               category = $2,
               price = $3,
               description = CASE WHEN $4 <> '' THEN $4 ELSE description END,
               image = CASE WHEN $5 <> '' THEN $5 ELSE image END,
               available = $6
           WHERE id = $7`,
          [
            item.name,
            item.category,
            item.price,
            item.description,
            item.image,
            item.available,
            existing.rows[0].id
          ]
        );
        updated++;
      } else {
        await client.query(
          `INSERT INTO menu
           (name, category, price, description, image, available)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            item.name,
            item.category,
            item.price,
            item.description,
            item.image,
            item.available
          ]
        );
        inserted++;
      }
    }

    await client.query("COMMIT");

    res.json({
      ok: true,
      imported: clean.length,
      inserted,
      updated,
      message: `Imported ${clean.length} menu rows: ${inserted} new and ${updated} updated.`
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}));

// Add menu item
app.post("/api/menu", auth, admin, asyncRoute(async (req, res) => {
  const { name, description = "", category, price, image = "" } = req.body || {};

  if (!name || !category || !Number.isInteger(Number(price)) || Number(price) < 1) {
    return res.status(400).json({
      error: "Valid name, category and whole-number price required."
    });
  }

  const result = await pool.query(
    `INSERT INTO menu (name, description, category, price, image)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [name, description, category, Number(price), image]
  );

  res.status(201).json(result.rows[0]);
}));

// Update menu item
app.patch("/api/menu/:id", auth, admin, asyncRoute(async (req, res) => {
  const oldResult = await pool.query(
    "SELECT * FROM menu WHERE id = $1",
    [req.params.id]
  );

  const old = oldResult.rows[0];

  if (!old) {
    return res.status(404).json({ error: "Dish not found." });
  }

  const d = { ...old, ...req.body };

  const available =
    d.available === false || d.available === 0 || d.available === "0"
      ? false
      : true;

  const result = await pool.query(
    `UPDATE menu
     SET name = $1, description = $2, category = $3,
         price = $4, image = $5, available = $6
     WHERE id = $7
     RETURNING *`,
    [
      d.name,
      d.description,
      d.category,
      Number(d.price),
      d.image,
      available,
      old.id
    ]
  );

  res.json(result.rows[0]);
}));

// Soft-delete menu item
app.delete("/api/menu/:id", auth, admin, asyncRoute(async (req, res) => {
  await pool.query(
    "UPDATE menu SET available = FALSE WHERE id = $1",
    [req.params.id]
  );

  res.json({ ok: true });
}));

// Place customer order
app.post("/api/orders", auth, asyncRoute(async (req, res) => {
  const { items, address, notes = "" } = req.body || {};

  if (!Array.isArray(items) || !items.length || !address) {
    return res.status(400).json({
      error: "Cart and delivery address are required."
    });
  }

  let total = 0;
  const validated = [];

  for (const item of items) {
    const result = await pool.query(
      `SELECT id, name, price FROM menu
       WHERE id = $1 AND available = TRUE`,
      [Number(item.menuId)]
    );

    const dish = result.rows[0];
    const quantity = Number(item.quantity);

    if (!dish || !Number.isInteger(quantity) || quantity < 1 || quantity > 50) {
      return res.status(400).json({ error: "Invalid cart item." });
    }

    total += dish.price * quantity;
    validated.push({ ...dish, quantity });
  }

  // Use a transaction so order and order items are saved together
  const client = await pool.connect();
  let orderId;

  try {
    await client.query("BEGIN");

    const orderResult = await client.query(
      `INSERT INTO orders (user_id, total, address, notes)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [req.user.id, total, address, notes]
    );

    orderId = orderResult.rows[0].id;

    for (const item of validated) {
      await client.query(
        `INSERT INTO order_items
         (order_id, menu_id, item_name, unit_price, quantity)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderId, item.id, item.name, item.price, item.quantity]
      );
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  const order = await readOrder(orderId);

  notifyWhatsApp(order).catch((e) =>
    console.error("WhatsApp notification failed:", e.message)
  );

  res.status(201).json(order);
}));

// Read one order with its items
async function readOrder(id) {
  const result = await pool.query(
    `SELECT o.*, u.name AS customer_name, u.phone AS customer_phone
     FROM orders o
     JOIN users u ON u.id = o.user_id
     WHERE o.id = $1`,
    [id]
  );

  const order = result.rows[0];

  if (!order) return null;

  const itemsResult = await pool.query(
    `SELECT item_name AS name, unit_price AS price, quantity
     FROM order_items WHERE order_id = $1`,
    [id]
  );

  order.items = itemsResult.rows;
  return order;
}

// Customer order history
app.get("/api/orders/mine", auth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT id, total, address, status, created_at
     FROM orders WHERE user_id = $1
     ORDER BY id DESC`,
    [req.user.id]
  );

  res.json(result.rows);
}));

// Owner: all orders
app.get("/api/admin/orders", auth, admin, asyncRoute(async (req, res) => {
  const result = await pool.query(
    "SELECT id FROM orders ORDER BY id DESC"
  );

  const orders = await Promise.all(
    result.rows.map((row) => readOrder(row.id))
  );

  res.json(orders);
}));

// Owner: update order status
app.patch("/api/admin/orders/:id", auth, admin, asyncRoute(async (req, res) => {
  const allowed = [
    "Received",
    "Accepted",
    "Preparing",
    "Ready",
    "Out for delivery",
    "Delivered",
    "Cancelled"
  ];

  if (!allowed.includes(req.body.status)) {
    return res.status(400).json({ error: "Invalid status." });
  }

  const result = await pool.query(
    `UPDATE orders SET status = $1
     WHERE id = $2 RETURNING id`,
    [req.body.status, req.params.id]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ error: "Order not found." });
  }

  res.json(await readOrder(req.params.id));
}));

// WhatsApp notification

async function notifyWhatsApp(order) {
  const {
    WHATSAPP_TOKEN,
    WHATSAPP_PHONE_NUMBER_ID,
    WHATSAPP_TO_NUMBER,
    WHATSAPP_API_VERSION = "v21.0"
  } = process.env;

  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_TO_NUMBER) {
    console.log("WhatsApp credentials are missing. Notification skipped.");
    return;
  }

  const orderId = `GKK-${String(order.id).padStart(4, "0")}`;

  // Remove line breaks, tabs and repeated spaces from WhatsApp template values.
  const cleanWhatsAppText = (value, fallback = "Not provided") =>
    String(value ?? fallback)
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim() || fallback;
  
  const customerName = cleanWhatsAppText(order.customer_name, "Customer");
  const customerPhone = cleanWhatsAppText(order.customer_phone, "Not available");

  const itemList = (order.items || [])
    .map((item) => {
      const quantity = Number(item.quantity) || 0;
      const lineTotal = Number(item.price) * quantity;
      const name = cleanWhatsAppText(item.name, "Dish");
      return `${name} x ${quantity} - Rs. ${lineTotal}`;
    })
    .join("; ") || "No items found";

  const totalAmount = `Rs. ${Number(order.total) || 0}`;
  const deliveryAddress = cleanWhatsAppText(order.address);

  const response = await fetch(
    `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: WHATSAPP_TO_NUMBER,
        type: "template",
        template: {
          name: "ghar_ka_khana_new_order",
          language: {
            code: "en"
          },
          components: [
            {
              type: "body",
              parameters: [
                { type: "text", text: orderId },
                { type: "text", text: customerName },
                { type: "text", text: customerPhone },
                { type: "text", text: itemList },
                { type: "text", text: totalAmount },
                { type: "text", text: deliveryAddress }
              ]
            },
            ...(process.env.WHATSAPP_ORDER_BUTTONS_ENABLED === "true" ? [
              { index: "0", payload: `ACCEPT|${order.id}` },
              { index: "1", payload: `CANCEL|${order.id}` },
              { index: "2", payload: `MORE|${order.id}` }
            ].map((button) => ({
              type: "button",
              sub_type: "quick_reply",
              index: button.index,
              parameters: [{ type: "payload", payload: button.payload }]
            })) : [])
        }
      })
    }
  );

  const result = await response.json();

  if (!response.ok) {
    console.error("WhatsApp template notification failed:", result);
    throw new Error("WhatsApp notification failed.");
  }

  console.log("WhatsApp order notification sent successfully.");
}

// Meta WhatsApp webhook verification (configure WHATSAPP_VERIFY_TOKEN in Render).
app.get("/webhooks/whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && process.env.WHATSAPP_VERIFY_TOKEN && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "").replace(/^0+/, "");
}

// Notify the customer only for Accepted and Delivered statuses.
async function notifyCustomerOrderStatus(orderId, status) {
  if (!["Accepted", "Delivered"].includes(status)) return;

  const { WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_API_VERSION = "v21.0" } = process.env;
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    console.warn("Customer WhatsApp status notification skipped: API credentials missing.");
    return;
  }

  const order = await readOrder(orderId);
  if (!order?.customer_phone) {
    console.warn(`Customer WhatsApp status notification skipped for order ${orderId}: phone missing.`);
    return;
  }

  let customerPhone = normalizePhone(order.customer_phone);
  // Website accounts commonly store Indian mobile numbers without the country code.
  if (customerPhone.length === 10) customerPhone = `91${customerPhone}`;

  const orderCode = `GKK-${String(orderId).padStart(4, "0")}`;
  const templateName = process.env.WHATSAPP_CUSTOMER_STATUS_TEMPLATE || "ghar_ka_khana_order_update";
  const response = await fetch(
    `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: customerPhone,
        type: "template",
        template: {
          name: templateName,
          language: { code: "en" },
          components: [{
            type: "body",
            parameters: [
              { type: "text", text: orderCode },
              { type: "text", text: status }
            ]
          }]
        }
      })
    }
  );

  const result = await response.json();
  if (!response.ok) {
    console.error(`Customer WhatsApp notification failed for order ${orderCode}:`, result);
    throw new Error("Customer WhatsApp notification failed.");
  }
  console.log(`Customer WhatsApp status notification sent for ${orderCode}: ${status}`);
}

async function sendWhatsAppText(to, body) {
  const { WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_API_VERSION = "v21.0" } = process.env;
  const response = await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body } })
  });
  if (!response.ok) {
    const result = await response.text();
    console.error("WhatsApp status reply failed:", result);
  }
}

async function sendWhatsAppActionList(to, orderId) {
  const { WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_API_VERSION = "v21.0" } = process.env;
  const code = `GKK-${String(orderId).padStart(4, "0")}`;
  const response = await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: `Choose the next status for order ${code}:` },
        action: {
          button: "More actions",
          sections: [{
            title: "Order status",
            rows: [
              { id: `PREPARING|${orderId}`, title: "Preparing" },
              { id: `PREPARED|${orderId}`, title: "Prepared" },
              { id: `OUT FOR DELIVERY|${orderId}`, title: "Out for Delivery" },
              { id: `DELIVERED|${orderId}`, title: "Delivered" }
            ]
          }]
        }
      }
    })
  });
  if (!response.ok) {
    const result = await response.text();
    console.error("WhatsApp action list failed:", result);
  }
}

// Incoming owner WhatsApp replies update the order status shown in customer order history.
app.post("/webhooks/whatsapp", asyncRoute(async (req, res) => {
  // Log delivery metadata only; never log phone numbers or message contents.
  const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];
  let changeCount = 0;
  let messageCount = 0;
  let statusCount = 0;

  for (const entry of entries) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    changeCount += changes.length;
    for (const change of changes) {
      messageCount += Array.isArray(change.value?.messages) ? change.value.messages.length : 0;
      statusCount += Array.isArray(change.value?.statuses) ? change.value.statuses.length : 0;
    }
  }

  console.log("Meta WhatsApp webhook received:", JSON.stringify({
    object: req.body?.object || "unknown",
    entries: entries.length,
    changes: changeCount,
    messages: messageCount,
    statuses: statusCount
  }));

  res.sendStatus(200);
  try {
    const expectedOwner = normalizePhone(process.env.WHATSAPP_TO_NUMBER);
    for (const item of entries) {
      for (const change of item.changes || []) {
        for (const message of change.value?.messages || []) {
          if (!expectedOwner || normalizePhone(message.from) !== expectedOwner) continue;

          let replyId = "";
          if (message.type === "interactive") {
            replyId = message.interactive?.button_reply?.id || message.interactive?.list_reply?.id || "";
          } else if (message.type === "button") {
            replyId = message.button?.payload || message.button?.text || "";
          } else if (message.type === "text") {
            const textBody = String(message.text?.body || "").trim().toUpperCase();
            const legacy = textBody.match(/^(ACCEPT|ACCEPTED|CANCEL|CANCELLED|PREPARING|READY|PREPARED|OUT|OUT FOR DELIVERY|DELIVERED)\s+GKK-?(\d+)$/);
            if (legacy) replyId = `${legacy[1]}|${Number(legacy[2])}`;
          }
          if (!replyId) continue;

          const parts = replyId.split("|");
          const action = String(parts[0] || "").trim().toUpperCase();
          const orderId = Number(parts[1]);
          if (!Number.isInteger(orderId) || orderId < 1) continue;

          if (action === "MORE") {
            await sendWhatsAppActionList(message.from, orderId);
            continue;
          }

          const statuses = {
            ACCEPT: "Accepted", CANCEL: "Cancelled",
            PREPARING: "Preparing", PREPARED: "Ready", READY: "Ready",
            "OUT FOR DELIVERY": "Out for delivery", OUT: "Out for delivery",
            DELIVERED: "Delivered"
          };
          const status = statuses[action];
          if (!status) continue;

          const result = await pool.query(
            "UPDATE orders SET status = $1 WHERE id = $2 AND status IS DISTINCT FROM $1 RETURNING id",
            [status, orderId]
          );
          const code = `GKK-${String(orderId).padStart(4, "0")}`;
          if (!result.rowCount) {
            const existing = await pool.query("SELECT id, status FROM orders WHERE id = $1", [orderId]);
            if (!existing.rowCount) {
              await sendWhatsAppText(message.from, `Order ${code} was not found.`);
            } else {
              await sendWhatsAppText(message.from, `Order ${code} is already marked ${existing.rows[0].status}.`);
            }
          } else {
            await sendWhatsAppText(message.from, `Order ${code} updated to: ${status}.`);
            console.log(`WhatsApp owner updated order ${orderId} to ${status}`);
            if (status === "Accepted" || status === "Delivered") {
              notifyCustomerOrderStatus(orderId, status).catch((error) =>
                console.error("Customer status notification error:", error.message)
              );
            }
          }
        }
      }
    }
  } catch (error) {
    console.error("WhatsApp webhook processing error:", error);
  }
}));

// Serve the customer website
app.get("*", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

// General error handler
app.use((err, req, res, next) => {
  console.error("Server error:", err);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

// Start server only after database is ready
initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Ghar ka Khana running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Database initialization failed:", err);
    process.exit(1);
  });
