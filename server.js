
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
  const customerName = order.customer_name || "Customer";
  const customerPhone = order.customer_phone || "Not available";

  const itemList = (order.items || [])
    .map(item => {
      const quantity = Number(item.quantity);
      const price = Number(item.price);
      const subtotal = quantity * price;

      return `${item.name} x ${quantity} - Rs. ${subtotal}`;
    })
    .join("\n");

  const formattedItems = itemList || "No items found";
  const totalAmount = `Rs. ${order.total}`;
  const deliveryAddress = order.address || "Not provided";

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
                {
                  type: "text",
                  text: orderId
                },
                {
                  type: "text",
                  text: customerName
                },
                {
                  type: "text",
                  text: customerPhone
                },
                {
                  type: "text",
                  text: formattedItems
                },
                {
                  type: "text",
                  text: totalAmount
                },
                {
                  type: "text",
                  text: deliveryAddress
                }
              ]
            }
          ]
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
