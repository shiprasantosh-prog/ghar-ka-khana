
require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const { Pool } = require("pg");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET;

const razorpay = (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) ? new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET }) : null;
const razorpayEnvironment = String(process.env.RAZORPAY_KEY_ID || "").startsWith("rzp_test_") ? "TEST" : String(process.env.RAZORPAY_KEY_ID || "").startsWith("rzp_live_") ? "LIVE" : "UNKNOWN";
console.log(`Razorpay environment: ${razorpayEnvironment}`);

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
app.use(express.json({ limit: "3mb", verify: (req, res, buf) => { req.rawBody = Buffer.from(buf); } }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "public")));

// The Maps browser key is intentionally served to the frontend; protect it with
// HTTP-referrer and API restrictions in Google Cloud Console.
const MENU_IMAGE_FOLDERS = {
  "Breakfast": "Breakfast", "Chinese": "Chinese", "Main Course": "Main Course",
  "Snacks": "Snacks", "Parathas": "Parathas", "Healthy Salads": "Healthy Salads",
  "Sweets & Desserts": "Sweets & Deserts", "Beverages": "Beverages"
};
const menuImageCatalog = {};
const normalizeMenuImageName = value => String(value || "").toLowerCase()
  .replace(/\.(jpg|jpeg|png|webp)$/i, "").replace(/\([^)]*\)/g, " ")
  .replace(/\b(daal)\b/g, "dal").replace(/\b(cheela)\b/g, "chilla")
  .replace(/\b(sooji)\b/g, "suji").replace(/\b(chilly)\b/g, "chilli")
  .replace(/\b(momos)\b/g, "momo").replace(/\b(pcs?|pieces?)\b/g, " ")
  .replace(/\b(serve|serves|serving)\s*\d+\b/g, " ").replace(/[^a-z0-9]/g, "");
function getMenuImageCandidates(category) {
  const canonicalCategory = canonicalMenuImageCategory(category);
  const folder = MENU_IMAGE_FOLDERS[canonicalCategory]; if (!folder) return [];
  if (menuImageCatalog[canonicalCategory]) return menuImageCatalog[canonicalCategory];
  try { menuImageCatalog[canonicalCategory] = require("fs").readdirSync(path.join(__dirname, "public", "images", folder), {withFileTypes:true})
    .filter(e => e.isFile() && /\.(jpe?g|png|webp)$/i.test(e.name)).map(e => e.name).sort((a,b)=>a.localeCompare(b));
  } catch (error) { menuImageCatalog[canonicalCategory] = []; }
  return menuImageCatalog[canonicalCategory];
}
function levenshteinMenuImage(a,b){
  const prev=Array.from({length:b.length+1},(_,i)=>i);
  for(let i=1;i<=a.length;i++){ let left=prev[0]; prev[0]=i;
    for(let j=1;j<=b.length;j++){ const above=prev[j]; prev[j]=Math.min(prev[j]+1,prev[j-1]+1,left+(a[i-1]===b[j-1]?0:1)); left=above; }
  } return prev[b.length];
}
function canonicalMenuImageCategory(category) {
  const value = String(category || "").trim().toLowerCase();
  return Object.keys(MENU_IMAGE_FOLDERS).find(key => key.toLowerCase() === value) || "";
}
function menuImagePath(name, category) {
  const canonicalCategory = canonicalMenuImageCategory(category);
  const candidates=getMenuImageCandidates(canonicalCategory), target=normalizeMenuImageName(name);
  if(!target || !candidates.length) return ""; let best={file:"",score:0};
  for(const file of candidates){ const candidate=normalizeMenuImageName(file); if(!candidate) continue;
    let score=1-(levenshteinMenuImage(target,candidate)/Math.max(target.length,candidate.length));
    if(target===candidate) score=1; else if(target.includes(candidate)||candidate.includes(target)) score=Math.max(score,.86);
    if(score>best.score) best={file,score};
  }
  return best.score>=.68 ? "/images/"+encodeURIComponent(MENU_IMAGE_FOLDERS[canonicalCategory])+"/"+encodeURIComponent(best.file) : "";
}
app.get("/api/menu-images", (req, res) => {
  const result={}; for(const category of Object.keys(MENU_IMAGE_FOLDERS)) result[category]=getMenuImageCandidates(category);
  res.set("Cache-Control","no-store"); res.json(result);
});

app.get("/api/maps-config", (req, res) => {
  res.set("Cache-Control", "no-store");
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "Google Maps API key is not configured." });
  res.json({ apiKey });
});

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
      referral_code TEXT UNIQUE,
      referred_by_user_id INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS bulk_enquiries (
      id SERIAL PRIMARY KEY,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      occasion TEXT NOT NULL,
      event_date DATE NOT NULL,
      guests INTEGER NOT NULL,
      delivery_location TEXT NOT NULL,
      food_preferences TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      customer_whatsapp_status TEXT DEFAULT 'unknown',
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
      cancellation_reason TEXT DEFAULT '',
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

  await pool.query("ALTER TABLE menu ADD COLUMN IF NOT EXISTS variant_parent_id INTEGER REFERENCES menu(id) ON DELETE SET NULL");
  await pool.query("CREATE TABLE IF NOT EXISTS menu_variants (id SERIAL PRIMARY KEY, menu_id INTEGER NOT NULL REFERENCES menu(id) ON DELETE CASCADE, variant_label TEXT NOT NULL, price INTEGER NOT NULL CHECK (price > 0), available BOOLEAN NOT NULL DEFAULT TRUE, UNIQUE(menu_id, variant_label))");
  await pool.query("ALTER TABLE order_items ADD COLUMN IF NOT EXISTS variant_label TEXT DEFAULT ''");
  // Pilot variant grouping: keep the 350 ml mango juice as the parent item and
  // turn the existing 200 ml menu row into its second variant.
  await pool.query(`
    DO $gkk$
    DECLARE parent_id INTEGER; child_id INTEGER;
    BEGIN
      SELECT id INTO parent_id FROM menu WHERE LOWER(name) LIKE '%fresh mango juice%350%' ORDER BY id LIMIT 1;
      IF parent_id IS NULL THEN
        SELECT id INTO parent_id FROM menu WHERE LOWER(name) = 'fresh mango juice' ORDER BY id LIMIT 1;
      END IF;
      SELECT id INTO child_id FROM menu WHERE LOWER(name) LIKE '%mango fresh juice%200%' ORDER BY id LIMIT 1;
      IF parent_id IS NOT NULL THEN
        UPDATE menu SET name='Fresh Mango Juice', price=70 WHERE id=parent_id;
        INSERT INTO menu_variants(menu_id,variant_label,price,available)
          VALUES(parent_id,'350 ml',70,TRUE)
          ON CONFLICT(menu_id,variant_label) DO UPDATE SET price=EXCLUDED.price,available=TRUE;
        IF child_id IS NOT NULL AND child_id <> parent_id THEN
          UPDATE menu SET variant_parent_id=parent_id, available=FALSE WHERE id=child_id;
          INSERT INTO menu_variants(menu_id,variant_label,price,available)
            VALUES(parent_id,'200 ml',50,TRUE)
            ON CONFLICT(menu_id,variant_label) DO UPDATE SET price=EXCLUDED.price,available=TRUE;
        END IF;
      END IF;
    END $gkk$;
  `);
  // Group regular Samosa and Mini Samosa as selectable variants.
  // The existing prices are read from the menu table so this migration does not hard-code pricing.
  await pool.query(`
    DO $gkk_samosa$
    DECLARE parent_id INTEGER; child_id INTEGER; parent_price INTEGER; child_price INTEGER;
    BEGIN
      SELECT id, price INTO parent_id, parent_price FROM menu WHERE LOWER(TRIM(name)) = 'samosa' AND (variant_parent_id IS NULL OR variant_parent_id = id) ORDER BY id LIMIT 1;
      SELECT id, price INTO child_id, child_price FROM menu WHERE LOWER(TRIM(name)) = 'mini samosa' ORDER BY id LIMIT 1;
      IF parent_id IS NOT NULL AND child_id IS NOT NULL AND child_id <> parent_id THEN
        INSERT INTO menu_variants(menu_id, variant_label, price, available)
          VALUES(parent_id, 'Regular', parent_price, TRUE)
          ON CONFLICT(menu_id, variant_label) DO UPDATE SET price=EXCLUDED.price, available=TRUE;
        INSERT INTO menu_variants(menu_id, variant_label, price, available)
          VALUES(parent_id, 'Mini', child_price, TRUE)
          ON CONFLICT(menu_id, variant_label) DO UPDATE SET price=EXCLUDED.price, available=TRUE;
        UPDATE menu SET available=TRUE WHERE id=parent_id;
        UPDATE menu SET variant_parent_id=parent_id, available=FALSE WHERE id=child_id;
      END IF;
    END $gkk_samosa$;
  `);
  // Group French Fries, Maggi and Noodles variants under single customer-facing cards.
  // Existing menu prices are preserved; only the presentation/selection is grouped.
  await pool.query(`
    DO $gkk_variants$
    DECLARE parent_id INTEGER; row_item RECORD; variant_text TEXT;
    BEGIN
      -- French Fries: Salted / Peri Peri
      SELECT id INTO parent_id FROM menu
        WHERE LOWER(TRIM(name)) IN ('french fries salted','french fries peri peri','french fries')
        ORDER BY CASE WHEN LOWER(TRIM(name))='french fries' THEN 0 ELSE 1 END, id LIMIT 1;
      IF parent_id IS NOT NULL THEN
        FOR row_item IN
          SELECT id, name, price FROM menu
          WHERE id <> parent_id
            AND LOWER(TRIM(name)) IN ('french fries salted','french fries peri peri')
            AND (variant_parent_id IS NULL OR variant_parent_id=id)
        LOOP
          variant_text := CASE
            WHEN LOWER(TRIM(row_item.name)) LIKE '%peri peri%' THEN 'Peri Peri'
            ELSE 'Salted'
          END;
          INSERT INTO menu_variants(menu_id,variant_label,price,available)
            VALUES(parent_id,variant_text,row_item.price,TRUE)
            ON CONFLICT(menu_id,variant_label) DO UPDATE SET price=EXCLUDED.price,available=TRUE;
          UPDATE menu SET variant_parent_id=parent_id,available=FALSE WHERE id=row_item.id;
        END LOOP;
        UPDATE menu SET name='French Fries' WHERE id=parent_id;
        INSERT INTO menu_variants(menu_id,variant_label,price,available)
          SELECT parent_id,'Salted',price,TRUE FROM menu WHERE id=parent_id
          ON CONFLICT(menu_id,variant_label) DO UPDATE SET price=EXCLUDED.price,available=TRUE;
      END IF;

      -- Maggi: group all existing Maggi menu rows as selectable variants.
      SELECT id INTO parent_id FROM menu
        WHERE LOWER(name) LIKE '%maggi%' AND (variant_parent_id IS NULL OR variant_parent_id=id)
        ORDER BY LENGTH(name), id LIMIT 1;
      IF parent_id IS NOT NULL THEN
        FOR row_item IN
          SELECT id, name, price FROM menu
          WHERE LOWER(name) LIKE '%maggi%' AND id <> parent_id
            AND (variant_parent_id IS NULL OR variant_parent_id=id)
        LOOP
          variant_text := BTRIM(REPLACE(LOWER(row_item.name),'maggi',''));
          IF variant_text = '' THEN variant_text := 'Regular'; END IF;
          variant_text := INITCAP(variant_text);
          INSERT INTO menu_variants(menu_id,variant_label,price,available)
            VALUES(parent_id,variant_text,row_item.price,TRUE)
            ON CONFLICT(menu_id,variant_label) DO UPDATE SET price=EXCLUDED.price,available=TRUE;
          UPDATE menu SET variant_parent_id=parent_id,available=FALSE WHERE id=row_item.id;
        END LOOP;
        UPDATE menu SET name='Maggi' WHERE id=parent_id;
        INSERT INTO menu_variants(menu_id,variant_label,price,available)
          SELECT parent_id,'Regular',price,TRUE FROM menu WHERE id=parent_id
          ON CONFLICT(menu_id,variant_label) DO UPDATE SET price=EXCLUDED.price,available=TRUE;
      END IF;

      -- Noodles: group all existing Noodles menu rows as selectable variants.
      SELECT id INTO parent_id FROM menu
        WHERE LOWER(name) LIKE '%noodles%' AND (variant_parent_id IS NULL OR variant_parent_id=id)
        ORDER BY LENGTH(name), id LIMIT 1;
      IF parent_id IS NOT NULL THEN
        FOR row_item IN
          SELECT id, name, price FROM menu
          WHERE LOWER(name) LIKE '%noodles%' AND id <> parent_id
            AND (variant_parent_id IS NULL OR variant_parent_id=id)
        LOOP
          variant_text := BTRIM(REPLACE(LOWER(row_item.name),'noodles',''));
          IF variant_text = '' THEN variant_text := 'Regular'; END IF;
          variant_text := INITCAP(variant_text);
          INSERT INTO menu_variants(menu_id,variant_label,price,available)
            VALUES(parent_id,variant_text,row_item.price,TRUE)
            ON CONFLICT(menu_id,variant_label) DO UPDATE SET price=EXCLUDED.price,available=TRUE;
          UPDATE menu SET variant_parent_id=parent_id,available=FALSE WHERE id=row_item.id;
        END LOOP;
        UPDATE menu SET name='Noodles' WHERE id=parent_id;
        INSERT INTO menu_variants(menu_id,variant_label,price,available)
          SELECT parent_id,'Regular',price,TRUE FROM menu WHERE id=parent_id
          ON CONFLICT(menu_id,variant_label) DO UPDATE SET price=EXCLUDED.price,available=TRUE;
      END IF;
    END $gkk_variants$;
  `);
  // Add cancellation reason to existing orders without affecting order history.
  await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancellation_reason TEXT DEFAULT ''");
  await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS estimated_delivery_minutes INTEGER");
  await pool.query("CREATE TABLE IF NOT EXISTS whatsapp_pending_eta (id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1), order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ");
  await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_slot TEXT DEFAULT ''");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT");
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by_user_id INTEGER REFERENCES users(id)");
  await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS promo_code TEXT DEFAULT ''");
  await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_source TEXT NOT NULL DEFAULT ''");
  await pool.query("CREATE TABLE IF NOT EXISTS referral_rewards (id SERIAL PRIMARY KEY, referrer_user_id INTEGER NOT NULL REFERENCES users(id), referred_user_id INTEGER NOT NULL UNIQUE REFERENCES users(id), reward_amount INTEGER NOT NULL DEFAULT 75 CHECK (reward_amount > 0), status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','reserved','used')), reserved_order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL, earned_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, used_at TIMESTAMPTZ)");
  await pool.query("CREATE INDEX IF NOT EXISTS referral_rewards_available_idx ON referral_rewards(referrer_user_id,status,id)");
  await pool.query("UPDATE users SET referral_code='GKK' || UPPER(SUBSTRING(MD5(id::text || phone) FROM 1 FOR 8)) WHERE role='customer' AND (referral_code IS NULL OR referral_code='')");
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code_unique ON users(referral_code) WHERE referral_code IS NOT NULL");
  await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount INTEGER NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_fee INTEGER NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS handling_fee INTEGER NOT NULL DEFAULT 5");
  await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'unpaid'");
  await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS razorpay_order_id TEXT");
  await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS razorpay_payment_id TEXT");
  await pool.query("CREATE TABLE IF NOT EXISTS razorpay_payment_attempts (id SERIAL PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE, razorpay_order_id TEXT NOT NULL UNIQUE, razorpay_payment_id TEXT, status TEXT NOT NULL DEFAULT 'created', created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  await pool.query("INSERT INTO razorpay_payment_attempts(order_id,razorpay_order_id,razorpay_payment_id,status) SELECT id,razorpay_order_id,razorpay_payment_id,CASE WHEN payment_status='paid' THEN 'paid' WHEN payment_status='failed' THEN 'failed' ELSE 'created' END FROM orders WHERE razorpay_order_id IS NOT NULL ON CONFLICT(razorpay_order_id) DO NOTHING");
  await pool.query("CREATE TABLE IF NOT EXISTS order_refunds (id SERIAL PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE, razorpay_refund_id TEXT UNIQUE, amount_paise INTEGER NOT NULL CHECK (amount_paise > 0), status TEXT NOT NULL DEFAULT 'pending', initiated_by TEXT NOT NULL DEFAULT 'owner', failure_reason TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS order_refunds_one_active_per_order ON order_refunds(order_id) WHERE status IN ('pending','processing','created')");
  await pool.query("CREATE INDEX IF NOT EXISTS order_refunds_order_id_idx ON order_refunds(order_id, created_at DESC)");
  await pool.query("CREATE TABLE IF NOT EXISTS promo_codes (id SERIAL PRIMARY KEY, code TEXT NOT NULL UNIQUE, customer_phone TEXT NOT NULL DEFAULT '', discount_type TEXT NOT NULL CHECK (discount_type IN ('percent','fixed')), discount_value INTEGER NOT NULL CHECK (discount_value > 0), minimum_order INTEGER NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT TRUE, valid_from DATE NOT NULL DEFAULT CURRENT_DATE, valid_until DATE NOT NULL DEFAULT CURRENT_DATE, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  await pool.query("ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS customer_phone TEXT NOT NULL DEFAULT ''");
  await pool.query("ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS valid_from DATE NOT NULL DEFAULT CURRENT_DATE");
  await pool.query("ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS valid_until DATE NOT NULL DEFAULT CURRENT_DATE");
  await pool.query("ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS excluded_menu_ids INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[]");
  await pool.query("CREATE TABLE IF NOT EXISTS delivery_slots (id SERIAL PRIMARY KEY, slot_label TEXT NOT NULL UNIQUE, active BOOLEAN NOT NULL DEFAULT TRUE)");
  await pool.query("INSERT INTO delivery_slots (slot_label) VALUES ('12:00 PM - 1:00 PM'),('1:00 PM - 2:00 PM'),('2:00 PM - 3:00 PM'),('6:00 PM - 7:00 PM'),('7:00 PM - 8:00 PM'),('8:00 PM - 9:00 PM') ON CONFLICT (slot_label) DO NOTHING");


  await pool.query(`CREATE TABLE IF NOT EXISTS kitchen_settings (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    is_open BOOLEAN NOT NULL DEFAULT TRUE,
    reopen_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query("INSERT INTO kitchen_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING");
  await pool.query("ALTER TABLE kitchen_settings ADD COLUMN IF NOT EXISTS daily_schedule_enabled BOOLEAN NOT NULL DEFAULT FALSE");
  await pool.query("ALTER TABLE kitchen_settings ADD COLUMN IF NOT EXISTS daily_open_time TIME");
  await pool.query("ALTER TABLE kitchen_settings ADD COLUMN IF NOT EXISTS daily_close_time TIME");
  await pool.query("CREATE TABLE IF NOT EXISTS delivery_area_settings (id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1), kitchen_address TEXT NOT NULL DEFAULT 'Brigade 7 Gardens, Paduka Madira Road, Subramanyapura, Uttarahalli, Bengaluru 560061', latitude DOUBLE PRECISION NOT NULL DEFAULT 12.89627, longitude DOUBLE PRECISION NOT NULL DEFAULT 77.528264, radius_km NUMERIC(5,2) NOT NULL DEFAULT 12 CHECK (radius_km > 0 AND radius_km <= 100), grace_meters INTEGER NOT NULL DEFAULT 300 CHECK (grace_meters >= 0 AND grace_meters <= 5000), updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  await pool.query("INSERT INTO delivery_area_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING");
  // Current delivery policy: 12 km radius. Keep existing installations in sync.
  await pool.query("UPDATE delivery_area_settings SET radius_km=12 WHERE id=1");

  // Owner-curated dishes featured in the customer-facing Popular section.
  await pool.query(`CREATE TABLE IF NOT EXISTS popular_menu (menu_id INTEGER PRIMARY KEY REFERENCES menu(id) ON DELETE CASCADE, display_order INTEGER NOT NULL UNIQUE CHECK (display_order BETWEEN 1 AND 5), created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)`);

  // Create reviews separately so existing table initialization remains unchanged.
  await pool.query(`CREATE TABLE IF NOT EXISTS reviews (
    id SERIAL PRIMARY KEY,
    order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment TEXT NOT NULL DEFAULT '',
    approved BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  // Link Meta's incoming quick-reply context back to the order notification.
  await pool.query(`CREATE TABLE IF NOT EXISTS whatsapp_order_messages (
    wamid TEXT PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  // Track a customer's WhatsApp rating while waiting for optional written feedback.
  await pool.query(`CREATE TABLE IF NOT EXISTS whatsapp_pending_reviews (
    customer_phone TEXT PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS customer_addresses (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    house TEXT NOT NULL DEFAULT '',
    street TEXT NOT NULL,
    city TEXT NOT NULL,
    state TEXT NOT NULL,
    pincode TEXT NOT NULL,
    formatted_address TEXT NOT NULL,
    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  // Allow address-book entries to be saved while map coordinates are pending.
  await pool.query("ALTER TABLE customer_addresses ALTER COLUMN latitude DROP NOT NULL");
  await pool.query("ALTER TABLE customer_addresses ALTER COLUMN longitude DROP NOT NULL");
  await pool.query("CREATE INDEX IF NOT EXISTS customer_addresses_user_idx ON customer_addresses(user_id)");

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
    } else {
      // If this phone was registered as a customer before owner credentials
      // were configured, promote that same account so owner sign-in works.
      await pool.query("UPDATE users SET role = 'admin' WHERE phone = $1 AND role <> 'admin'", [process.env.ADMIN_PHONE]);
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

// Production keeps the original same-site Lax cookie. Outside production the app is
// served inside the cross-site v0 preview iframe, where browsers drop Lax cookies, so
// the session cookie must be SameSite=None + Secure (Partitioned for third-party cookie blocking).
function sessionCookieOptions() {
  if (process.env.NODE_ENV === "production") {
    return { httpOnly: true, sameSite: "lax", secure: true };
  }
  return { httpOnly: true, sameSite: "none", secure: true, partitioned: true };
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
  const submittedReferralCode = String(req.body?.referralCode || "").trim().toUpperCase();
  let referrerId = null;
  if (submittedReferralCode) {
    const referrer = await pool.query("SELECT id FROM users WHERE UPPER(referral_code)=UPPER($1) AND role='customer'", [submittedReferralCode]);
    if (!referrer.rowCount) return res.status(400).json({ error: "That referral code is not valid." });
    referrerId = Number(referrer.rows[0].id);
  }

  if (!name || !phone || !password || String(password).length < 8) {
    return res.status(400).json({
      error: "Name, phone and password (8+ characters) are required."
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO users
       (name, phone, email, password_hash, address, referred_by_user_id, referral_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, phone, email, address, role, referral_code, referred_by_user_id`,
      [name.trim(), phone.trim(), email || null, bcrypt.hashSync(password, 12), address, referrerId, "GKK" + crypto.randomBytes(5).toString("hex").toUpperCase()]
    );

    const user = result.rows[0];

    res.cookie("gkk_token", tokenFor(user), {
      ...sessionCookieOptions(),
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
    role: user.role,
    referral_code: user.referral_code,
    referred_by_user_id: user.referred_by_user_id
  };

  res.cookie("gkk_token", tokenFor(safeUser), {
    ...sessionCookieOptions(),
    maxAge: 7 * 864e5
  });

  res.json({ user: safeUser });
}));

const passwordResetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false });
function normalizeOtpPhone(value) {
  const raw=String(value||"").trim();
  if(/^\+\d{10,15}$/.test(raw)) return raw;
  const digits=raw.replace(/\D/g,"");
  if(/^\d{10}$/.test(digits)) return "+91"+digits;
  if(/^91\d{10}$/.test(digits)) return "+"+digits;
  return "";
}
async function twilioVerifyRequest(path, params) {
  const sid=process.env.TWILIO_ACCOUNT_SID, token=process.env.TWILIO_AUTH_TOKEN, service=process.env.TWILIO_VERIFY_SERVICE_SID;
  if(!sid||!token||!service) throw Object.assign(new Error("Password reset by SMS is not configured yet. Please contact Ghar ka Khana for help."),{status:503});
  const response=await fetch("https://verify.twilio.com/v2/Services/"+encodeURIComponent(service)+path,{
    method:"POST",headers:{"Authorization":"Basic "+Buffer.from(sid+":"+token).toString("base64"),"Content-Type":"application/x-www-form-urlencoded"},
    body:new URLSearchParams(params),signal:AbortSignal.timeout(12000)
  });
  const payload=await response.json().catch(()=>({}));
  if(!response.ok) { const error=new Error("We could not complete SMS verification. Please check the mobile number and try again.");error.status=502;throw error; }
  return payload;
}
app.post("/api/auth/password-reset/request",passwordResetLimiter,asyncRoute(async(req,res)=>{
  if(!process.env.TWILIO_ACCOUNT_SID||!process.env.TWILIO_AUTH_TOKEN||!process.env.TWILIO_VERIFY_SERVICE_SID)return res.status(503).json({error:"SMS password reset is not configured yet. No OTP was sent. Please contact Ghar ka Khana for help."});
  const phone=String(req.body?.phone||"").trim(),to=normalizeOtpPhone(phone);
  if(!to)return res.status(400).json({error:"Enter a valid mobile number including the 10-digit number."});
  const found=await pool.query("SELECT id FROM users WHERE phone=$1 AND role='customer'",[phone]);
  // Do not reveal whether a customer account exists.
  if(found.rowCount) await twilioVerifyRequest("/Verifications",{To:to,Channel:"sms"});
  res.json({ok:true,message:"If this is a registered customer number, an OTP has been requested for the mobile ending in "+to.slice(-4)+". If no SMS arrives within a minute, check the number and try again or contact support."});
}));
app.post("/api/auth/password-reset/confirm",passwordResetLimiter,asyncRoute(async(req,res)=>{
  const phone=String(req.body?.phone||"").trim(),to=normalizeOtpPhone(phone),code=String(req.body?.code||"").trim(),password=String(req.body?.newPassword||"");
  if(!to||/^\d{4,10}$/.test(code)===false||password.length<8)return res.status(400).json({error:"Enter your mobile number, the OTP, and a new password of at least 8 characters."});
  const found=await pool.query("SELECT id FROM users WHERE phone=$1 AND role='customer'",[phone]);
  if(!found.rowCount)return res.status(400).json({error:"We could not verify this reset request. Check the mobile number and request a new OTP."});
  const verified=await twilioVerifyRequest("/VerificationCheck",{To:to,Code:code});
  if(verified.status!=="approved")return res.status(400).json({error:"That OTP is invalid or expired. Request a new code and try again."});
  await pool.query("UPDATE users SET password_hash=$1 WHERE id=$2",[bcrypt.hashSync(password,12),found.rows[0].id]);
  res.json({ok:true,message:"Password reset successfully. You can now sign in with your new password."});
}));

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("gkk_token", sessionCookieOptions()).json({ ok: true });
});

// Current customer session
app.get("/api/auth/me", auth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT id, name, phone, email, address, role, referral_code, referred_by_user_id
     FROM users WHERE id = $1`,
    [req.user.id]
  );

  res.json({ user: result.rows[0] || null });
}));

app.get("/api/referrals/me", auth, asyncRoute(async (req,res)=>{
 const user=await pool.query("SELECT referral_code FROM users WHERE id=$1 AND role='customer'",[req.user.id]);
 if(!user.rowCount)return res.status(403).json({error:"Customer account required."});
 const eligible=await pool.query("SELECT 1 FROM orders WHERE user_id=$1 AND status<>'Cancelled' AND (discount_source='first_order' OR payment_status IN ('paid','cod') OR status NOT IN ('Payment Pending')) LIMIT 1",[req.user.id]);
 const rewards=await pool.query("SELECT COUNT(*)::int AS available FROM referral_rewards WHERE referrer_user_id=$1 AND status='available'",[req.user.id]);
 const referrals=await pool.query("SELECT COUNT(*)::int AS successful FROM referral_rewards WHERE referrer_user_id=$1",[req.user.id]);
 res.json({referralCode:user.rows[0].referral_code,firstOrderEligible:!eligible.rowCount,availableRewards:Number(rewards.rows[0].available),successfulReferrals:Number(referrals.rows[0].successful)});
}));

// Saved customer delivery addresses
app.get("/api/addresses", auth, asyncRoute(async (req,res)=>{
 const result=await pool.query("SELECT id,label,house,street,city,state,pincode,formatted_address,latitude,longitude,is_default FROM customer_addresses WHERE user_id=$1 ORDER BY is_default DESC,id ASC",[req.user.id]);
 res.json(result.rows);
}));
app.post("/api/addresses", auth, asyncRoute(async(req,res)=>{
 const b=req.body||{};let label=String(b.label||"Other").trim().slice(0,40);const house=String(b.house||"").trim(),street=String(b.street||"").trim(),city=String(b.city||"").trim(),state=String(b.state||"").trim(),pincode=String(b.pincode||"").trim(),formatted=String(b.formatted_address||"").trim(),latitude=b.latitude===null||b.latitude===""||b.latitude===undefined?null:Number(b.latitude),longitude=b.longitude===null||b.longitude===""||b.longitude===undefined?null:Number(b.longitude);
 if(!street)return res.status(400).json({error:"Please enter the Street / Area."});if(!city)return res.status(400).json({error:"Please enter the City."});if(!state)return res.status(400).json({error:"Please enter the State."});if(!/^[0-9]{6}$/.test(pincode))return res.status(400).json({error:"Please enter a valid 6-digit PIN code."});if(!formatted)return res.status(400).json({error:"Please enter the business, street, or locality in the location field."});if((latitude===null)!==(longitude===null)||latitude!==null&&(!Number.isFinite(latitude)||latitude < -90||latitude>90||!Number.isFinite(longitude)||longitude < -180||longitude>180))return res.status(400).json({error:"The selected location coordinates are invalid. Please try again."});
 const existing=await pool.query("SELECT COUNT(*)::int AS n FROM customer_addresses WHERE user_id=$1",[req.user.id]),isDefault=Number(existing.rows[0].n)===0;if(isDefault)label="Home";
 const result=await pool.query(`INSERT INTO customer_addresses(user_id,label,house,street,city,state,pincode,formatted_address,latitude,longitude,is_default) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id,label,house,street,city,state,pincode,formatted_address,latitude,longitude,is_default`,[req.user.id,label||"Other",house,street,city,state,pincode,formatted,latitude,longitude,isDefault]);
 res.status(201).json({address:result.rows[0]});
}));
app.patch("/api/addresses/:id", auth, asyncRoute(async(req,res)=>{
 const b=req.body||{},id=Number(req.params.id),label=String(b.label||"Other").trim().slice(0,40),house=String(b.house||"").trim(),street=String(b.street||"").trim(),city=String(b.city||"").trim(),state=String(b.state||"").trim(),pincode=String(b.pincode||"").trim(),formatted=String(b.formatted_address||"").trim(),latitude=b.latitude===null||b.latitude===""||b.latitude===undefined?null:Number(b.latitude),longitude=b.longitude===null||b.longitude===""||b.longitude===undefined?null:Number(b.longitude);
 if(!Number.isInteger(id)||!street||!city||!state||!/^\d{6}$/.test(pincode)||!formatted||(latitude===null)!==(longitude===null)||latitude!==null&&(!Number.isFinite(latitude)||latitude < -90||latitude>90||!Number.isFinite(longitude)||longitude < -180||longitude>180))return res.status(400).json({error:"Enter a complete address with a valid PIN code."});
 const result=await pool.query(`UPDATE customer_addresses SET label=$1,house=$2,street=$3,city=$4,state=$5,pincode=$6,formatted_address=$7,latitude=$8,longitude=$9 WHERE id=$10 AND user_id=$11 RETURNING id,label,house,street,city,state,pincode,formatted_address,latitude,longitude,is_default`,[label||"Other",house,street,city,state,pincode,formatted,latitude,longitude,id,req.user.id]);
 if(!result.rowCount)return res.status(404).json({error:"Saved address not found."});res.json({address:result.rows[0]});
}));
app.delete("/api/addresses/:id",auth,asyncRoute(async(req,res)=>{
 const id=Number(req.params.id),client=await pool.connect();try{await client.query("BEGIN");const found=await client.query("SELECT is_default FROM customer_addresses WHERE id=$1 AND user_id=$2 FOR UPDATE",[id,req.user.id]);if(!found.rowCount){await client.query("ROLLBACK");return res.status(404).json({error:"Saved address not found."});}await client.query("DELETE FROM customer_addresses WHERE id=$1 AND user_id=$2",[id,req.user.id]);if(found.rows[0].is_default)await client.query("UPDATE customer_addresses SET is_default=TRUE WHERE id=(SELECT id FROM customer_addresses WHERE user_id=$1 ORDER BY id LIMIT 1)",[req.user.id]);await client.query("COMMIT");res.json({ok:true});}catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
}));
app.post("/api/addresses/:id/default",auth,asyncRoute(async(req,res)=>{
 const id=Number(req.params.id),client=await pool.connect();try{await client.query("BEGIN");const exists=await client.query("SELECT id FROM customer_addresses WHERE id=$1 AND user_id=$2",[id,req.user.id]);if(!exists.rowCount){await client.query("ROLLBACK");return res.status(404).json({error:"Saved address not found."});}await client.query("UPDATE customer_addresses SET is_default=(id=$1) WHERE user_id=$2",[id,req.user.id]);await client.query("COMMIT");res.json({ok:true});}catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
}));

// Allow an authenticated owner to change their password from the dashboard.
app.post("/api/admin/password/change", auth, admin, asyncRoute(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== "string" || typeof newPassword !== "string" || newPassword.length < 8) {
    return res.status(400).json({ error: "Enter your current password and a new password of at least 8 characters." });
  }
  const result = await pool.query("SELECT password_hash FROM users WHERE id = $1 AND role = 'admin'", [req.user.id]);
  const owner = result.rows[0];
  if (!owner || !bcrypt.compareSync(currentPassword, owner.password_hash)) {
    return res.status(401).json({ error: "Current password is incorrect." });
  }
  await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [bcrypt.hashSync(newPassword, 12), req.user.id]);
  res.json({ ok: true, message: "Password changed successfully. Use your new password next time you sign in." });
}));

app.post("/api/auth/password/change",auth,asyncRoute(async(req,res)=>{const {currentPassword,newPassword}=req.body||{};if(typeof currentPassword!=="string"||typeof newPassword!=="string"||newPassword.length<8)return res.status(400).json({error:"Enter your current password and a new password of at least 8 characters."});const r=await pool.query("SELECT password_hash FROM users WHERE id=$1 AND role<>'admin'",[req.user.id]);const user=r.rows[0];if(!user||!bcrypt.compareSync(currentPassword,user.password_hash))return res.status(401).json({error:"Current password is incorrect."});await pool.query("UPDATE users SET password_hash=$1 WHERE id=$2",[bcrypt.hashSync(newPassword,12),req.user.id]);res.json({ok:true,message:"Password changed successfully."});}));

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
      return res.status(409).json({ error: "That email address is already in use." });    }
    throw e;
  }
}));

async function attachMenuVariants(rows) {
  if (!rows.length) return rows.map(row => ({...row, variants: []}));
  const ids = rows.map(row => Number(row.id));
  const result = await pool.query(
    "SELECT id,menu_id,variant_label,price,available FROM menu_variants WHERE menu_id = ANY($1::int[]) ORDER BY menu_id,id",
    [ids]
  );
  const byMenu = new Map();
  result.rows.forEach(v => {
    if (!v.available) return;
    const list = byMenu.get(Number(v.menu_id)) || [];
    list.push({ id:Number(v.id), label:v.variant_label, price:Number(v.price) });
    byMenu.set(Number(v.menu_id), list);
  });
  return rows.map(row => ({...row, variants:byMenu.get(Number(row.id)) || []}));
}

// Public menu
// Customer favourites: top five dishes by quantity ordered, excluding cancelled orders.
app.get("/api/popular-menu", asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT m.id, m.name, m.description, m.category, m.price, m.image, m.available
     FROM popular_menu p JOIN menu m ON m.id = p.menu_id
     WHERE m.available = TRUE ORDER BY p.display_order ASC`
  );
  res.json(await attachMenuVariants(result.rows.map(row => ({ ...row, image_url: menuImagePath(row.name, row.category) }))));
}));

app.get("/api/admin/popular", auth, admin, asyncRoute(async (req, res) => {
  const result = await pool.query("SELECT menu_id FROM popular_menu ORDER BY display_order");
  res.json(result.rows.map(row => row.menu_id));
}));

app.put("/api/admin/popular", auth, admin, asyncRoute(async (req, res) => {
  const { menuIds } = req.body || {};
  if (!Array.isArray(menuIds) || menuIds.length > 5) return res.status(400).json({ error: "Select no more than five Popular dishes." });
  const ids = [...new Set(menuIds.map(Number))];
  if (ids.length !== menuIds.length || ids.some(id => !Number.isInteger(id) || id < 1)) return res.status(400).json({ error: "Invalid or duplicate menu item selection." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (ids.length) {
      const check = await client.query("SELECT id FROM menu WHERE id = ANY($1::int[]) AND available = TRUE", [ids]);
      if (check.rowCount !== ids.length) { await client.query("ROLLBACK"); return res.status(400).json({ error: "All selected dishes must exist and be available." }); }
    }
    await client.query("DELETE FROM popular_menu");
    for (let i = 0; i < ids.length; i++) await client.query("INSERT INTO popular_menu (menu_id, display_order) VALUES ($1, $2)", [ids[i], i + 1]);
    await client.query("COMMIT");
    res.json({ ok: true, menuIds: ids, message: "Popular items saved." });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}));

app.get("/api/menu", asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT id, name, description, category, price, image, available
     FROM menu
     WHERE available = TRUE AND variant_parent_id IS NULL
     ORDER BY category, name`
  );
  const rows = result.rows.map(row => ({ ...row, image_url: menuImagePath(row.name, row.category) }));
  res.json(await attachMenuVariants(rows));
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

  res.json(result.rows.map(row => ({ ...row, image_url: menuImagePath(row.name, row.category) })));
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

// Replace the complete customer menu with an owner-uploaded CSV.
app.post("/api/admin/menu/replace", auth, admin, asyncRoute(async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || items.length < 1 || items.length > 1000) {
    return res.status(400).json({ error: "Upload a CSV containing between 1 and 1,000 menu rows." });
  }

  const clean = [];
  const seen = new Set();
  for (let i = 0; i < items.length; i++) {
    const row = items[i] || {};
    const name = String(row.name || "").trim();
    const category = String(row.category || "").trim();
    const price = Number(row.price);
    if (!name || !category || !Number.isInteger(price) || price < 1) {
      return res.status(400).json({ error: `Row ${i + 1}: name, category and a positive whole-number price are required.` });
    }
    if (name.length > 100 || category.length > 60) {
      return res.status(400).json({ error: `Row ${i + 1}: name or category is too long.` });
    }
    const key = `${category.toLowerCase()}::${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push({
      name, category, price,
      description: String(row.description || "").trim().slice(0, 500),
      image: String(row.image || "").trim().slice(0, 1000),
      available: row.available === false ||
        ["false", "0", "no"].includes(String(row.available).toLowerCase()) ? false : true
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Clear only menu-dependent selections. Order history and customer data remain untouched.
    await client.query("DELETE FROM daily_specials");
    await client.query("DELETE FROM popular_menu");
    await client.query("DELETE FROM menu");
    for (const item of clean) {
      await client.query(
        `INSERT INTO menu (name, description, category, price, image, available)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [item.name, item.description, item.category, item.price, item.image, item.available]
      );
    }
    await client.query("COMMIT");
    res.json({
      ok: true,
      replaced: clean.length,
      message: `Menu replaced successfully with ${clean.length} dishes. Customer accounts, orders and reviews were preserved. Please reselect Today’s Specials and Best Selling Items.`
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
  if (typeof image === "string" && image.startsWith("data:image/") && image.length > 1500000) {
    return res.status(413).json({ error: "Dish image is too large. Please choose a smaller photo." });
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

  if (typeof d.image === "string" && d.image.startsWith("data:image/") && d.image.length > 1500000) {
    return res.status(413).json({ error: "Dish image is too large. Please choose a smaller photo." });
  }

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

async function getDrivingDistanceKm(originLat,originLng,destinationLat,destinationLng){
 const apiKey=process.env.GOOGLE_MAPS_SERVER_API_KEY;if(!apiKey){const e=new Error("Driving-distance service is not configured. Please contact the kitchen.");e.status=503;throw e;}
 const response=await fetch("https://routes.googleapis.com/directions/v2:computeRoutes",{method:"POST",headers:{"Content-Type":"application/json","X-Goog-Api-Key":apiKey,"X-Goog-FieldMask":"routes.distanceMeters"},body:JSON.stringify({origin:{location:{latLng:{latitude:Number(originLat),longitude:Number(originLng)}}},destination:{location:{latLng:{latitude:Number(destinationLat),longitude:Number(destinationLng)}}},travelMode:"DRIVE",routingPreference:"TRAFFIC_UNAWARE",units:"METRIC"}),signal:AbortSignal.timeout(12000)});
 if(!response.ok){console.error("[routes] Google Routes API HTTP",response.status,(await response.text().catch(()=>"")).slice(0,500));const e=new Error("We could not calculate the driving distance right now. Please try again.");e.status=502;throw e;}
 const data=await response.json(),meters=Number(data.routes?.[0]?.distanceMeters);if(!Number.isFinite(meters)||meters<0){const e=new Error("Google Maps could not find a driving route to this address. Please check the address or move the map pin.");e.status=400;throw e;}return meters/1000;
}
function isKitchenSocietyAddress(address){const s=String(address||"").toLowerCase();return s.includes("brigade 7 gardens")&&(/560061/.test(s)||s.includes("bharath housing society"));}
function isCodEligibleAddress(address){return String(address||"").toLowerCase().includes("brigade 7 gardens");}
function calculateDeliveryFee(distanceKm,address){if(isKitchenSocietyAddress(address))return 0;return distanceKm>=1.5&&distanceKm<=2.5?25:distanceKm>2.5&&distanceKm<=5?50:distanceKm>5&&distanceKm<=7.5?75:distanceKm>7.5&&distanceKm<=12?100:0;}
function deliveryDistanceForAddress(address){return isKitchenSocietyAddress(address)?{distanceKm:0,distanceType:"same-society"}:null;}

// Credit a referral reward only after the referred customer completes their first order.
async function creditReferralRewardForCompletedOrder(userId) {
  await pool.query(`INSERT INTO referral_rewards(referrer_user_id,referred_user_id,reward_amount,status)
    SELECT referred_by_user_id,id,75,'available' FROM users WHERE id=$1 AND referred_by_user_id IS NOT NULL AND role='customer'
    AND EXISTS (SELECT 1 FROM orders WHERE user_id=$1 AND status<>'Cancelled' AND (payment_status IN ('paid','cod') OR status NOT IN ('Payment Pending')))
    ON CONFLICT (referred_user_id) DO NOTHING`,[userId]);
}

// Place customer order
app.post("/api/orders", auth, asyncRoute(async (req, res) => {
  let { items, address, notes = "", orderMode = "now", scheduledAt = null, deliverySlot = "", promoCode = "", paymentMethod = "online" } = req.body || {};
  if (!Array.isArray(items) || !items.length || !address) return res.status(400).json({error:"Cart and delivery address are required."});
  const kitchenStatus = await getKitchenStatus();
  if (!kitchenStatus.isOpen) return res.status(400).json({ error: "Our kitchen is currently closed. Please place your order during our daily opening hours." });
  let customerLat=Number(req.body.latitude),customerLng=Number(req.body.longitude);
  const savedAddressId=Number(req.body.addressId);
  if(Number.isInteger(savedAddressId)&&savedAddressId>0){
    const saved=await pool.query("SELECT house,formatted_address,latitude,longitude FROM customer_addresses WHERE id=$1 AND user_id=$2",[savedAddressId,req.user.id]);
    if(!saved.rowCount)return res.status(400).json({error:"Please select a saved delivery address."});
    address=[saved.rows[0].house,saved.rows[0].formatted_address].filter(Boolean).join(", ");
    customerLat=Number(saved.rows[0].latitude);customerLng=Number(saved.rows[0].longitude);
  }else if(req.body.addressId!==undefined){
    return res.status(400).json({error:"Please select a valid saved delivery address."});
  }
  if(!Number.isFinite(customerLat)||customerLat < -90||customerLat>90||!Number.isFinite(customerLng)||customerLng < -180||customerLng>180)return res.status(400).json({error:"Please select and verify a saved delivery address before placing an order."});
  const areaResult=await pool.query("SELECT latitude,longitude,radius_km,grace_meters FROM delivery_area_settings WHERE id=1");
  const area=areaResult.rows[0];if(!area)return res.status(503).json({error:"Delivery area is not configured yet."});
  const sameSociety=deliveryDistanceForAddress(address);
  const distanceKm=sameSociety?sameSociety.distanceKm:await getDrivingDistanceKm(area.latitude,area.longitude,customerLat,customerLng);
  const maxDistanceKm=Number(area.radius_km)+Number(area.grace_meters)/1000;
  if(!sameSociety&&distanceKm>maxDistanceKm)return res.status(400).json({error:"Your driving route is "+distanceKm.toFixed(1)+" km from our kitchen. We currently deliver up to "+maxDistanceKm.toFixed(1)+" km by road."});
  let subtotal=0; const validated=[];
  const deliveryFee=calculateDeliveryFee(distanceKm,address);
  for(const item of items){
    const result=await pool.query("SELECT id,name,price FROM menu WHERE id=$1 AND available=TRUE AND variant_parent_id IS NULL",[Number(item.menuId)]);
    const dish=result.rows[0],quantity=Number(item.quantity),variantId=Number(item.variantId||0);
    if(!dish||!Number.isInteger(quantity)||quantity<1||quantity>50)return res.status(400).json({error:"Invalid cart item."});
    let unitPrice=Number(dish.price),variantLabel="";
    const variants=await pool.query("SELECT id,variant_label,price FROM menu_variants WHERE menu_id=$1 AND available=TRUE ORDER BY id",[dish.id]);
    if(variants.rowCount){
      if(!Number.isInteger(variantId)||variantId<1)return res.status(400).json({error:"Please choose a size or option for "+dish.name+"."});
      const selected=variants.rows.find(v=>Number(v.id)===variantId);
      if(!selected)return res.status(400).json({error:"Invalid option selected for "+dish.name+"."});
      unitPrice=Number(selected.price);variantLabel=selected.variant_label;
    }else if(variantId){
      return res.status(400).json({error:"Invalid option selected for "+dish.name+"."});
    }
    subtotal+=unitPrice*quantity;validated.push({...dish,quantity,price:unitPrice,variantId,variantLabel});
  }
  let scheduledDate=null;
  if(orderMode==="scheduled"){
    scheduledDate=new Date(scheduledAt);
    if(!scheduledAt||Number.isNaN(scheduledDate.getTime())||scheduledDate<=new Date())return res.status(400).json({error:"Choose a future delivery date and time."});

  }else if(orderMode!=="now")return res.status(400).json({error:"Choose Order Now or Prior Order."});
  let discount=0,appliedCode="",discountSource="";
  if(String(promoCode).trim()){
    const result=await pool.query("SELECT *, ((NOW() AT TIME ZONE 'Asia/Kolkata')::date >= valid_from) AS date_started, ((NOW() AT TIME ZONE 'Asia/Kolkata')::date <= valid_until) AS date_not_expired FROM promo_codes WHERE UPPER(code)=UPPER($1)",[String(promoCode).trim()]);
    const code=result.rows[0];
    if(!code||!code.active)return res.status(400).json({error:"Invalid Promo Code."});
    if(!code.date_started)return res.status(400).json({error:"Promo code is not valid yet."});
    if(!code.date_not_expired)return res.status(400).json({error:"Promo code expired."});
    const customer=await pool.query("SELECT phone FROM users WHERE id=$1",[req.user.id]);
    const normalizePromoPhone=value=>String(value||"").replace(/\D/g,"").replace(/^0+/,"").replace(/^91(?=\d{10}$)/,"");
    const normalizedPhone=normalizePromoPhone(customer.rows[0]?.phone);
    if(normalizedPhone!==normalizePromoPhone(code.customer_phone))return res.status(400).json({error:"This promo code is not assigned to your mobile number."});
    if(subtotal<code.minimum_order)return res.status(400).json({error:"This code requires a minimum order of Rs. "+code.minimum_order+"."});
    const excludedIds=Array.isArray(code.excluded_menu_ids)?code.excluded_menu_ids.map(Number):[];
    const eligibleSubtotal=validated.filter(item=>!excludedIds.includes(Number(item.id))).reduce((sum,item)=>sum+item.price*item.quantity,0);
    if(eligibleSubtotal<=0)return res.status(400).json({error:"This promo code does not apply to the items in your basket."});
    discount=code.discount_type==="percent"?Math.floor(eligibleSubtotal*code.discount_value/100):code.discount_value;
    discount=Math.min(eligibleSubtotal,discount);appliedCode=code.code;discountSource="promo";
  } else {
    const priorSuccessful=await pool.query("SELECT 1 FROM orders WHERE user_id=$1 AND status<>'Cancelled' AND (discount_source='first_order' OR payment_status IN ('paid','cod') OR status NOT IN ('Payment Pending')) LIMIT 1",[req.user.id]);
    if(!priorSuccessful.rowCount){discount=Math.min(subtotal,Math.floor(subtotal*0.10),100);discountSource=discount>0?"first_order":"";}
    else {const reward=await pool.query("SELECT id,reward_amount FROM referral_rewards WHERE referrer_user_id=$1 AND status='available' ORDER BY id LIMIT 1",[req.user.id]);if(reward.rowCount){discount=Math.min(subtotal,Math.floor(subtotal*0.10),Number(reward.rows[0].reward_amount),75);discountSource=discount>0?"referral_reward":"";appliedCode="REFERRAL REWARD";}}
  }
  const normalizedPaymentMethod=String(paymentMethod||"online").trim().toLowerCase();
  if(!["online","cod"].includes(normalizedPaymentMethod))return res.status(400).json({error:"Please choose a valid payment method."});
  const isCod=normalizedPaymentMethod==="cod";
  if(isCod&&!isCodEligibleAddress(address))return res.status(400).json({error:"Cash on Delivery is available only for addresses containing Brigade 7 Gardens."});
  if(!isCod&&!razorpay)return res.status(503).json({error:"Online payment is not configured yet. Please try again shortly."});
  const handlingFee=(subtotal < 250 ? 5 : Math.round(subtotal*0.02));
   const total=Number(subtotal-discount+handlingFee+deliveryFee);
  const client=await pool.connect();let orderId;
  try{
    await client.query("BEGIN");
    const result=await client.query("INSERT INTO orders(user_id,total,address,notes,status,scheduled_at,delivery_slot,promo_code,discount,delivery_fee,handling_fee,payment_status,discount_source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id",[req.user.id,total,address,notes,isCod?"Received":"Payment Pending",scheduledDate,orderMode==="scheduled"?String(deliverySlot):"",appliedCode,discount,deliveryFee,handlingFee,isCod?"cod":"created",discountSource]);
    orderId=result.rows[0].id;
    if(discountSource==="referral_reward"){const reserved=await client.query("UPDATE referral_rewards SET status='reserved',reserved_order_id=$1 WHERE id=(SELECT id FROM referral_rewards WHERE referrer_user_id=$2 AND status='available' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id",[orderId,req.user.id]);if(!reserved.rowCount)throw new Error("Your referral reward was just used elsewhere. Please refresh checkout and try again.");}
    for(const item of validated)await client.query("INSERT INTO order_items(order_id,menu_id,item_name,unit_price,quantity,variant_label) VALUES($1,$2,$3,$4,$5,$6)",[orderId,item.id,item.name,item.price,item.quantity,item.variantLabel||""]);
    await client.query("COMMIT");
  }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
  if(isCod){
    await creditReferralRewardForCompletedOrder(req.user.id);
    if(discountSource==="referral_reward")await pool.query("UPDATE referral_rewards SET status='used',used_at=CURRENT_TIMESTAMP WHERE reserved_order_id=$1 AND status='reserved'",[orderId]);
    const order=await readOrder(orderId);
    notifyWhatsApp(order).catch(e=>console.error("WhatsApp notification failed:",e.message));
    return res.status(201).json({...order,payment:{method:"cod"}});
  }
  try{
    const rpOrder=await razorpay.orders.create({amount:total*100,currency:"INR",receipt:"GKK-"+String(orderId),notes:{ghar_ka_khana_order_id:String(orderId)}});
    await pool.query("UPDATE orders SET razorpay_order_id=$1 WHERE id=$2",[rpOrder.id,orderId]);
    await pool.query("INSERT INTO razorpay_payment_attempts(order_id,razorpay_order_id,status) VALUES($1,$2,'created') ON CONFLICT(razorpay_order_id) DO NOTHING",[orderId,rpOrder.id]);
    const order=await readOrder(orderId);
    res.status(201).json({...order,payment:{keyId:process.env.RAZORPAY_KEY_ID,orderId:rpOrder.id,amount:rpOrder.amount,currency:rpOrder.currency}});
  }catch(e){
    await pool.query("UPDATE referral_rewards SET status='available',reserved_order_id=NULL WHERE reserved_order_id=$1 AND status='reserved'",[orderId]).catch(()=>{});
    await pool.query("DELETE FROM orders WHERE id=$1",[orderId]).catch(()=>{});
    console.error("Razorpay order creation failed:",e.message);
    return res.status(502).json({error:"We could not start the online payment. Please try again."});
  }
}));

 
// Verify a successful Razorpay Checkout payment before confirming the customer order.
app.post("/api/orders/:id/retry-payment", auth, asyncRoute(async (req,res)=>{
  if(!razorpay)return res.status(503).json({error:"Online payment is not configured yet."});
  const orderId=Number(req.params.id);
  if(!Number.isInteger(orderId)||orderId<1)return res.status(400).json({error:"Invalid order."});
  const found=await pool.query("SELECT id,total,status,payment_status FROM orders WHERE id=$1 AND user_id=$2",[orderId,req.user.id]);
  const row=found.rows[0];
  if(!row)return res.status(404).json({error:"Order not found."});
  if(row.status!=="Payment Pending"||row.payment_status==="paid")return res.status(409).json({error:"Only unpaid orders with Payment Pending status can be retried."});
  if(!["created","failed","unpaid"].includes(String(row.payment_status||"").toLowerCase()))return res.status(409).json({error:"This order is not eligible for payment retry."});
  const rpOrder=await razorpay.orders.create({amount:Number(row.total)*100,currency:"INR",receipt:"GKK-"+String(orderId)+"-R"+Date.now().toString().slice(-6),notes:{ghar_ka_khana_order_id:String(orderId),payment_retry:"true"}});
  // Atomically re-check eligibility: an owner/customer cancellation or successful
  // payment may have happened after the initial read while Razorpay created this order.
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    const locked=await client.query("SELECT status,payment_status FROM orders WHERE id=$1 AND user_id=$2 FOR UPDATE",[orderId,req.user.id]);
    const current=locked.rows[0];
    if(!current){await client.query("ROLLBACK");return res.status(404).json({error:"Order not found."});}
    if(current.status!=="Payment Pending"||current.payment_status==="paid"||!["created","failed","unpaid"].includes(String(current.payment_status||"").toLowerCase())){
      await client.query("ROLLBACK");
      return res.status(409).json({error:"This order is no longer eligible for payment retry. Refresh your orders and check its current status."});
    }
    await client.query("INSERT INTO razorpay_payment_attempts(order_id,razorpay_order_id,status) VALUES($1,$2,'created')",[orderId,rpOrder.id]);
    await client.query("UPDATE orders SET razorpay_order_id=$1,payment_status='created',status='Payment Pending' WHERE id=$2",[rpOrder.id,orderId]);
    await client.query("COMMIT");
  }catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}
  finally{client.release();}
  const order=await readOrder(orderId);
  return res.status(201).json({...order,payment:{keyId:process.env.RAZORPAY_KEY_ID,orderId:rpOrder.id,amount:rpOrder.amount,currency:rpOrder.currency}});
}));

app.post("/api/payments/verify", auth, asyncRoute(async (req,res)=>{
  const orderId=Number(req.body?.orderId),razorpayOrderId=String(req.body?.razorpay_order_id||""),razorpayPaymentId=String(req.body?.razorpay_payment_id||""),razorpaySignature=String(req.body?.razorpay_signature||"");
  if(!Number.isInteger(orderId)||orderId<1||!razorpayOrderId||!razorpayPaymentId||!razorpaySignature)return res.status(400).json({error:"Incomplete payment verification details."});
  if(!razorpay)return res.status(503).json({error:"Online payment is not configured yet."});
  const result=await pool.query("SELECT id,total,payment_status,razorpay_order_id FROM orders WHERE id=$1 AND user_id=$2",[orderId,req.user.id]),row=result.rows[0];
  if(!row)return res.status(404).json({error:"Order not found."});
  if(row.payment_status==="paid")return res.json(await readOrder(orderId));
  const attempt=await pool.query("SELECT id FROM razorpay_payment_attempts WHERE order_id=$1 AND razorpay_order_id=$2",[orderId,razorpayOrderId]);
  if(!attempt.rowCount)return res.status(400).json({error:"Payment order does not match this order."});
  const expected=crypto.createHmac("sha256",process.env.RAZORPAY_KEY_SECRET).update(razorpayOrderId+"|"+razorpayPaymentId).digest("hex");
  const ok=expected.length===razorpaySignature.length&&crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(razorpaySignature));
  if(!ok)return res.status(400).json({error:"Payment verification failed. Your order has not been confirmed."});
  const payment=await razorpay.payments.fetch(razorpayPaymentId);
  if(String(payment.order_id||"")!==razorpayOrderId)return res.status(400).json({error:"Payment order does not match this order."});
  if(Number(payment.amount)!==Number(row.total)*100)return res.status(400).json({error:"Payment amount does not match this order."});
  if(payment.status!=="captured" && payment.captured!==true)return res.status(400).json({error:"Payment has not been captured yet. Your order remains pending."});
  await pool.query("UPDATE razorpay_payment_attempts SET razorpay_payment_id=$1,status='paid',updated_at=CURRENT_TIMESTAMP WHERE order_id=$2 AND razorpay_order_id=$3",[razorpayPaymentId,orderId,razorpayOrderId]);
  const updated=await pool.query("UPDATE orders SET payment_status='paid',razorpay_payment_id=$1,status=CASE WHEN status='Cancelled' THEN status ELSE 'Received' END WHERE id=$2 AND user_id=$3 AND payment_status<>'paid' RETURNING id",[razorpayPaymentId,orderId,req.user.id]);
  const order=await readOrder(orderId);
  if(updated.rowCount){
    if(order.status==="Cancelled")await refundLateCapturedCancelledOrder(orderId);
    else {
      await creditReferralRewardForCompletedOrder(req.user.id);
      await pool.query("UPDATE referral_rewards SET status='used',used_at=CURRENT_TIMESTAMP WHERE reserved_order_id=$1 AND status='reserved'",[orderId]);
      notifyWhatsApp(order).catch(e=>console.error("WhatsApp notification failed:",e.message));
    }
  }
  res.json(order);
}));

// Razorpay Callback URL fallback. Razorpay POSTs successful Checkout results here,
// allowing the order to be confirmed even when the browser cannot execute the
// client-side handler. Signature is verified against our stored Razorpay order ID.
app.post("/api/payments/callback", express.urlencoded({extended:false}), asyncRoute(async (req,res)=>{
  const razorpayOrderId=String(req.body?.razorpay_order_id||"");
  const razorpayPaymentId=String(req.body?.razorpay_payment_id||"");
  const razorpaySignature=String(req.body?.razorpay_signature||"");
  if(!razorpay||!razorpayOrderId||!razorpayPaymentId||!razorpaySignature)return res.redirect("/?payment=failed&reason=invalid_callback");
  const result=await pool.query("SELECT id,total,payment_status,status FROM orders WHERE razorpay_order_id=$1",[razorpayOrderId]);
  const row=result.rows[0];
  if(!row)return res.redirect("/?payment=failed&reason=order_not_found");
  if(row.payment_status!=="paid"){
    const expected=crypto.createHmac("sha256",process.env.RAZORPAY_KEY_SECRET).update(razorpayOrderId+"|"+razorpayPaymentId).digest("hex");
    const ok=expected.length===razorpaySignature.length&&crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(razorpaySignature));
    if(!ok)return res.redirect("/?payment=failed&reason=verification_failed");
    const payment=await razorpay.payments.fetch(razorpayPaymentId);
    if(String(payment.order_id||"")!==razorpayOrderId || Number(payment.amount)!==Number(row.total)*100 || (payment.status!=="captured" && payment.captured!==true)){
      return res.redirect("/?payment=failed&reason=payment_not_captured");
    }
    const updated=await pool.query("UPDATE orders SET payment_status='paid',razorpay_payment_id=$1,status=CASE WHEN status='Cancelled' THEN status ELSE 'Received' END WHERE id=$2 AND payment_status<>'paid' RETURNING id",[razorpayPaymentId,row.id]);
    if(updated.rowCount){
      const order=await readOrder(row.id);
      if(order.status==="Cancelled")await refundLateCapturedCancelledOrder(row.id);
      else {await creditReferralRewardForCompletedOrder(order.user_id);await pool.query("UPDATE referral_rewards SET status='used',used_at=CURRENT_TIMESTAMP WHERE reserved_order_id=$1 AND status='reserved'",[row.id]);notifyWhatsApp(order).catch(e=>console.error("WhatsApp notification failed:",e.message));}
    }
  }
  return res.redirect("/?payment=success&orderId="+encodeURIComponent(String(row.id)));
}));

// Razorpay server-to-server webhook.
// Configure RAZORPAY_WEBHOOK_SECRET in Render and use the same secret in Razorpay Dashboard.
// The webhook is intentionally kept alongside the Checkout callback as a second confirmation path.
// Safely refund a payment captured after its order was already cancelled.
// This function never retries an existing local refund record automatically: an ambiguous
// outcome must be reconciled with Razorpay rather than risking a duplicate refund.
async function refundLateCapturedCancelledOrder(orderId) {
  if (!razorpay) {
    console.error("[Late payment refund] Razorpay is not configured; owner action required.", { orderId });
    return;
  }

  const client = await pool.connect();
  let refundRecord;
  let paymentId;
  try {
    await client.query("BEGIN");
    const found = await client.query(
      "SELECT id,total,status,payment_status,razorpay_payment_id FROM orders WHERE id=$1 FOR UPDATE",
      [orderId]
    );
    const order = found.rows[0];
    if (!order || order.status !== "Cancelled" || order.payment_status !== "paid" || !order.razorpay_payment_id) {
      await client.query("ROLLBACK");
      return;
    }

    const prior = await client.query(
      "SELECT id,status,razorpay_refund_id FROM order_refunds WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1",
      [orderId]
    );
    if (prior.rows[0]) {
      await client.query("COMMIT");
      console.info("[Late payment refund] Existing refund record found; automatic duplicate prevented.", {
        orderId, refundId: prior.rows[0].razorpay_refund_id, status: prior.rows[0].status
      });
      return;
    }

    paymentId = order.razorpay_payment_id;
    const inserted = await client.query(
      "INSERT INTO order_refunds(order_id,amount_paise,status,initiated_by) VALUES($1,$2,'processing','late_payment_auto') RETURNING *",
      [orderId, Number(order.total) * 100]
    );
    refundRecord = inserted.rows[0];
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23505") {
      console.warn("[Late payment refund] Existing refund/unique constraint prevented duplicate.", { orderId });
      return;
    }
    throw error;
  } finally {
    client.release();
  }

  try {
    const response = await razorpay.payments.refund(paymentId, {
      amount: refundRecord.amount_paise,
      notes: { order_id: String(orderId), source: "Ghar ka Khana late captured payment after cancellation" }
    });
    const remoteStatus = String(response.status || "").toLowerCase();
    const status = ["processed", "pending", "failed"].includes(remoteStatus) ? remoteStatus : "processing";
    await pool.query(
      "UPDATE order_refunds SET razorpay_refund_id=$1,status=$2,failure_reason=$3,updated_at=CURRENT_TIMESTAMP WHERE id=$4",
      [response.id || null, status, status === "failed" ? "Razorpay reported refund failure; owner review required." : "", refundRecord.id]
    );
    console.info("[Late payment refund] Automatic refund submitted.", {
      orderId, refundId: response.id || null, status
    });
  } catch (error) {
    await pool.query(
      "UPDATE order_refunds SET status='processing',failure_reason=$1,updated_at=CURRENT_TIMESTAMP WHERE id=$2",
      ["Automatic refund outcome unclear; reconcile in Razorpay before retrying.", refundRecord.id]
    );
    console.error("[Late payment refund] Submission needs reconciliation; no retry attempted.", {
      orderId, message: error.message
    });
  }
}

app.post("/api/payments/razorpay-webhook", asyncRoute(async (req, res) => {
  // Correlate each delivery attempt without logging secrets, signatures, or payloads.
  const diagnosticId = crypto.randomUUID();
  const startedAt = Date.now();
  res.on("finish", () => {
    console.info("[Razorpay webhook] Request completed:", {
      diagnosticId,
      event: String(req.body?.event || "unknown"),
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt
    });
  });
  const webhookSecret = String(process.env.RAZORPAY_WEBHOOK_SECRET || "");
  const signature = String(req.headers["x-razorpay-signature"] || "");
  console.info("[Razorpay webhook] Request received:", {
    diagnosticId,
    method: req.method,
    path: req.path,
    contentType: String(req.headers["content-type"] || ""),
    signaturePresent: Boolean(signature),
    secretConfigured: Boolean(webhookSecret),
    rawBodyPresent: Boolean(req.rawBody)
  });
  if (!webhookSecret || !signature || !req.rawBody) {
    console.warn("[Razorpay webhook] Rejected: missing secret, signature, or raw request body.", { diagnosticId });
    return res.status(400).json({ error: "Invalid webhook configuration." });
  }

  const expected = crypto.createHmac("sha256", webhookSecret).update(req.rawBody).digest("hex");
  const valid = expected.length === signature.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  if (!valid) {
    console.warn("[Razorpay webhook] Rejected: signature verification failed.", { diagnosticId });
    return res.status(400).json({ error: "Invalid webhook signature." });
  }
  console.info("[Razorpay webhook] Signature verified.", { diagnosticId });

  const event = String(req.body?.event || "");
  console.info("[Razorpay webhook] Verified event received:", { diagnosticId, event });

  // Refund events carry a refund entity rather than a payment entity.
  // Match the Razorpay refund ID to the durable local refund record and
  // update its status so the owner dashboard reflects Razorpay's final state.
  if (event === "refund.processed" || event === "refund.failed" || event === "refund.created") {
    const refund = req.body?.payload?.refund?.entity;
    const refundId = String(refund?.id || "");
    if (!refundId) return res.status(200).json({ ok: true });

    const status = event === "refund.processed" ? "processed"
      : event === "refund.failed" ? "failed" : "pending";
    const failureReason = status === "failed"
      ? String(refund?.failure_reason || refund?.error_description || "Razorpay reported refund failure.")
      : "";

    const updatedRefund = await pool.query(
      "UPDATE order_refunds SET status=$1, failure_reason=$2, updated_at=CURRENT_TIMESTAMP WHERE razorpay_refund_id=$3 RETURNING id,order_id",
      [status, failureReason, refundId]
    );
    if (!updatedRefund.rowCount) {
      console.warn("[Razorpay webhook] Refund event had no matching local refund record:", { diagnosticId, event, refundId });
    } else {
      console.info("[Razorpay webhook] Refund status updated:", {
        diagnosticId,
        event,
        refundId,
        status,
        orderId: updatedRefund.rows[0].order_id
      });
    }
    return res.status(200).json({ ok: true });
  }

  const payment = req.body?.payload?.payment?.entity;
  if (!payment) return res.status(200).json({ ok: true });

  const razorpayOrderId = String(payment.order_id || "");
  const razorpayPaymentId = String(payment.id || "");
  if (!razorpayOrderId || !razorpayPaymentId) return res.status(200).json({ ok: true });

  const result = await pool.query(
    "SELECT o.id,o.total,o.payment_status,o.status FROM orders o JOIN razorpay_payment_attempts a ON a.order_id=o.id WHERE a.razorpay_order_id=$1",
    [razorpayOrderId]
  );
  const row = result.rows[0];
  if (!row) {
    console.warn("Razorpay webhook received for unknown order:", razorpayOrderId);
    return res.status(200).json({ ok: true });
  }

  if (event === "payment.captured") {
    await pool.query("UPDATE razorpay_payment_attempts SET razorpay_payment_id=$1,status='paid',updated_at=CURRENT_TIMESTAMP WHERE razorpay_order_id=$2",[razorpayPaymentId,razorpayOrderId]);
    if (Number(payment.amount) !== Number(row.total) * 100) {
      console.error("Razorpay webhook amount mismatch for order:", row.id);
      return res.status(400).json({ error: "Payment amount does not match the order." });
    }

    const updated = await pool.query(
      "UPDATE orders SET payment_status='paid',razorpay_payment_id=$1,status=CASE WHEN status='Cancelled' THEN status ELSE 'Received' END WHERE id=$2 AND payment_status<>'paid' RETURNING id",
      [razorpayPaymentId, row.id]
    );

    if (updated.rowCount) {
      if (row.status === "Cancelled") {
        await refundLateCapturedCancelledOrder(row.id);
      } else {
        const order = await readOrder(row.id);
        await creditReferralRewardForCompletedOrder(order.user_id);
        await pool.query("UPDATE referral_rewards SET status='used',used_at=CURRENT_TIMESTAMP WHERE reserved_order_id=$1 AND status='reserved'",[row.id]);
        notifyWhatsApp(order).catch(error =>
          console.error("WhatsApp notification failed after Razorpay webhook:", error.message)
        );
      }
    }
  } else if (event === "payment.failed") {
    // Mark this specific attempt failed. An older attempt's delayed failure
    // must not overwrite the status of a newer retry attempt.
    await pool.query("UPDATE razorpay_payment_attempts SET status='failed',updated_at=CURRENT_TIMESTAMP WHERE razorpay_order_id=$1 AND status<>'paid'",[razorpayOrderId]);
    await pool.query(
      "UPDATE orders SET payment_status='failed',status='Payment Pending' WHERE id=$1 AND razorpay_order_id=$2 AND payment_status<>'paid'",
      [row.id,razorpayOrderId]
    );
  }

  return res.status(200).json({ ok: true });
}));

// Owner-triggered full refund. Durable local records prevent duplicate requests.
app.post("/api/admin/orders/:id/refund", auth, admin, asyncRoute(async (req, res) => {
  if (!razorpay) return res.status(503).json({ error: "Razorpay is not configured." });
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId) || orderId < 1) return res.status(400).json({ error: "Invalid order." });
  const client = await pool.connect();
  let refundRecord;
  let paymentId;
  try {
    await client.query("BEGIN");
    const found = await client.query("SELECT id,total,status,payment_status,razorpay_payment_id FROM orders WHERE id=$1 FOR UPDATE", [orderId]);
    const order = found.rows[0];
    if (!order) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Order not found." }); }
    if (order.status !== "Cancelled") { await client.query("ROLLBACK"); return res.status(409).json({ error: "Cancel the order before requesting a refund." }); }
    if (order.payment_status !== "paid" || !order.razorpay_payment_id) { await client.query("ROLLBACK"); return res.status(409).json({ error: "This order has no verified captured payment to refund." }); }
    paymentId = order.razorpay_payment_id;
    const prior = await client.query("SELECT * FROM order_refunds WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1", [orderId]);
    if (prior.rows[0] && ["pending","processing","created","processed"].includes(prior.rows[0].status)) {
      await client.query("COMMIT");
      return res.status(200).json({ refund: prior.rows[0], message: "A refund already exists for this order; no duplicate was created." });
    }
    const inserted = await client.query("INSERT INTO order_refunds(order_id,amount_paise,status,initiated_by) VALUES($1,$2,\'processing\',\'owner\') RETURNING *", [orderId, Number(order.total) * 100]);
    refundRecord = inserted.rows[0];
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23505") return res.status(409).json({ error: "A refund is already in progress for this order." });
    throw error;
  } finally { client.release(); }
  try {
    const response = await razorpay.payments.refund(paymentId, { amount: refundRecord.amount_paise, notes: { order_id: String(orderId), source: "Ghar ka Khana owner dashboard" } });
    const status = ["processed","pending","failed"].includes(String(response.status)) ? String(response.status) : "processing";
    const saved = await pool.query("UPDATE order_refunds SET razorpay_refund_id=$1,status=$2,failure_reason=$3,updated_at=CURRENT_TIMESTAMP WHERE id=$4 RETURNING *", [response.id || null, status, status === "failed" ? "Razorpay reported refund failure." : "", refundRecord.id]);
    if (status === "failed") return res.status(502).json({ error: "Razorpay reported that the refund failed.", refund: saved.rows[0] });
    return res.status(200).json({ message: status === "processed" ? "Refund processed by Razorpay." : "Refund submitted to Razorpay and is awaiting confirmation.", refund: saved.rows[0] });
  } catch (error) {
    console.error("Razorpay refund submission requires reconciliation:", error.message);
    await pool.query("UPDATE order_refunds SET status=\'processing\',failure_reason=$1,updated_at=CURRENT_TIMESTAMP WHERE id=$2", ["Submission outcome unclear; reconcile in Razorpay before retrying.", refundRecord.id]);
    return res.status(202).json({ message: "Refund submission needs reconciliation in Razorpay. It has been kept in processing to prevent a duplicate refund.", refundId: refundRecord.id });
  }
}));
// Reconcile an existing refund with Razorpay without creating a new refund.
app.post("/api/admin/orders/:id/refund/refresh", auth, admin, asyncRoute(async (req, res) => {
  if (!razorpay) return res.status(503).json({ error: "Razorpay is not configured." });
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId) || orderId < 1) return res.status(400).json({ error: "Invalid order." });

  const found = await pool.query(
    `SELECT r.id, r.razorpay_refund_id, r.status, r.failure_reason,
            o.razorpay_payment_id
     FROM order_refunds r
     JOIN orders o ON o.id = r.order_id
     WHERE r.order_id = $1
     ORDER BY r.created_at DESC
     LIMIT 1`,
    [orderId]
  );
  const refund = found.rows[0];
  if (!refund) return res.status(404).json({ error: "No refund record exists for this order." });
  if (!refund.razorpay_refund_id) {
    return res.status(409).json({ error: "This refund has no Razorpay refund ID yet. Check Razorpay before retrying anything." });
  }
  if (!refund.razorpay_payment_id) {
    return res.status(409).json({ error: "The original Razorpay payment ID is missing; the refund cannot be reconciled automatically." });
  }

  // Fetch the existing refund only. This endpoint never submits a refund request.
  const remote = await razorpay.payments.fetchRefund(refund.razorpay_payment_id, refund.razorpay_refund_id);
  const remoteStatus = String(remote?.status || "").toLowerCase();
  const status = ["processed", "failed", "pending"].includes(remoteStatus)
    ? remoteStatus
    : ["created", "processing"].includes(remoteStatus) ? "processing" : refund.status;
  const failureReason = status === "failed"
    ? String(remote?.failure_reason || remote?.error_description || "Razorpay reported refund failure.")
    : "";

  const updated = await pool.query(
    "UPDATE order_refunds SET status=$1, failure_reason=$2, updated_at=CURRENT_TIMESTAMP WHERE id=$3 RETURNING id,order_id,razorpay_refund_id,status,failure_reason,updated_at",
    [status, failureReason, refund.id]
  );
  console.info("[Razorpay refund reconciliation] Existing refund checked:", {
    orderId, refundId: refund.razorpay_refund_id, status
  });
  return res.status(200).json({ message: "Existing refund status refreshed from Razorpay.", refund: updated.rows[0] });
}));

app.post("/api/payments/cancel",auth,asyncRoute(async(req,res)=>{
  const orderId=Number(req.body?.orderId);
  if(!Number.isInteger(orderId)||orderId<1)return res.status(400).json({error:"Invalid order."});
  await pool.query("UPDATE orders SET status='Payment Pending' WHERE id=$1 AND user_id=$2 AND payment_status='created'",[orderId,req.user.id]);
  res.json({ok:true});
}));

app.post("/api/promo/validate",auth,asyncRoute(async(req,res)=>{
 const {items,promoCode}=req.body||{};
 if(!Array.isArray(items)||!items.length||!String(promoCode||"").trim())return res.status(400).json({error:"Enter a promo code and add items to your basket."});
 const result=await pool.query("SELECT *, ((NOW() AT TIME ZONE 'Asia/Kolkata')::date >= valid_from) AS date_started, ((NOW() AT TIME ZONE 'Asia/Kolkata')::date <= valid_until) AS date_not_expired FROM promo_codes WHERE UPPER(code)=UPPER($1)",[String(promoCode).trim()]);const code=result.rows[0];
 if(!code||!code.active)return res.status(400).json({error:"Invalid Promo Code."});
 if(!code.date_started)return res.status(400).json({error:"Promo code is not valid yet."});if(!code.date_not_expired)return res.status(400).json({error:"Promo code expired."});
 const user=await pool.query("SELECT phone FROM users WHERE id=$1",[req.user.id]);const normalize=value=>String(value||"").replace(/\D/g,"").replace(/^0+/,"").replace(/^91(?=\d{10}$)/,"");if(normalize(user.rows[0]?.phone)!==normalize(code.customer_phone))return res.status(400).json({error:"This promo code is not assigned to your mobile number."});
 let subtotal=0,eligibleSubtotal=0;const excluded=Array.isArray(code.excluded_menu_ids)?code.excluded_menu_ids.map(Number):[];const excludedItems=[];
 for(const item of items){
  const q=Number(item.quantity),r=await pool.query("SELECT id,name,price FROM menu WHERE id=$1 AND available=TRUE AND variant_parent_id IS NULL",[Number(item.menuId)]),dish=r.rows[0],variantId=Number(item.variantId||0);
  if(!dish||!Number.isInteger(q)||q<1||q>50)return res.status(400).json({error:"Invalid cart item."});
  let unitPrice=Number(dish.price);
  const variants=await pool.query("SELECT id,price FROM menu_variants WHERE menu_id=$1 AND available=TRUE",[dish.id]);
  if(variants.rowCount){const selected=variants.rows.find(v=>Number(v.id)===variantId);if(!selected)return res.status(400).json({error:"Please choose a size or option for "+dish.name+"."});unitPrice=Number(selected.price);}
  const amount=unitPrice*q;subtotal+=amount;if(excluded.includes(Number(dish.id)))excludedItems.push({name:dish.name,amount});else eligibleSubtotal+=amount;
 }
 if(subtotal<code.minimum_order)return res.status(400).json({error:"This code requires a minimum order of Rs. "+code.minimum_order+"."});if(eligibleSubtotal<=0)return res.status(400).json({error:"This promo code does not apply to the items in your basket."});
 const discount=Math.min(eligibleSubtotal,code.discount_type==="percent"?Math.floor(eligibleSubtotal*code.discount_value/100):code.discount_value);res.json({code:code.code,discount,subtotal,eligibleSubtotal,handlingFee:Math.round(subtotal*0.02),deliveryFee:0,total:subtotal-discount+Math.round(subtotal*0.02),excludedItems,discountType:code.discount_type,discountValue:code.discount_value});
}));

app.get("/api/checkout/options", asyncRoute(async(req,res)=>{
  res.json({});
}));

app.get("/api/admin/promo-codes",auth,admin,asyncRoute(async(req,res)=>{const r=await pool.query("SELECT * FROM promo_codes ORDER BY created_at DESC");res.json(r.rows)}));
app.post("/api/admin/promo-codes",auth,admin,asyncRoute(async(req,res)=>{
 const b=req.body||{},phone=String(b.customerPhone||"").replace(/\D/g,""),type=b.discountType,value=Number(b.discountValue),minimum=Number(b.minimumOrder||0),from=b.validFrom,until=b.validUntil,excludedIds=Array.isArray(b.excludedMenuIds)?[...new Set(b.excludedMenuIds.map(Number))]:[];
 if(excludedIds.some(id=>!Number.isInteger(id)||id<1)||phone.length<10||phone.length>15||!["percent","fixed"].includes(type)||!Number.isInteger(value)||value<1||minimum<0||(type==="percent"&&value>100)||!/^\d{4}-\d{2}-\d{2}$/.test(from||"")||!/^\d{4}-\d{2}-\d{2}$/.test(until||"")||until<from)return res.status(400).json({error:"Enter a valid customer mobile, discount and valid-from/valid-until dates."});
 const code=String(b.code||("GKK"+Math.random().toString(36).slice(2,8).toUpperCase())).trim().toUpperCase();
 if(!/^[A-Z0-9_-]{4,30}$/.test(code))return res.status(400).json({error:"Promo code must be 4–30 letters, numbers, hyphens or underscores."});
 try{const r=await pool.query("INSERT INTO promo_codes(code,customer_phone,discount_type,discount_value,minimum_order,valid_from,valid_until,excluded_menu_ids,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,TRUE) RETURNING *",[code,phone,type,value,minimum,from,until,excludedIds]);res.status(201).json(r.rows[0]);}
 catch(e){if(e.code==="23505")return res.status(409).json({error:"Promo code already exists. Generate another code."});throw e;}
}));
app.patch("/api/admin/promo-codes/:id",auth,admin,asyncRoute(async(req,res)=>{
 const id=Number(req.params.id),b=req.body||{};
 if(typeof b.active==="boolean"&&Object.keys(b).length===1){const r=await pool.query("UPDATE promo_codes SET active=$1 WHERE id=$2 RETURNING *",[b.active,id]);if(!r.rowCount)return res.status(404).json({error:"Promo code not found."});return res.json(r.rows[0]);}
 const phone=String(b.customerPhone||"").replace(/\D/g,""),type=b.discountType,value=Number(b.discountValue),minimum=Number(b.minimumOrder||0),from=b.validFrom,until=b.validUntil,excludedIds=Array.isArray(b.excludedMenuIds)?[...new Set(b.excludedMenuIds.map(Number))]:[],code=String(b.code||"").trim().toUpperCase();
 if(excludedIds.some(x=>!Number.isInteger(x)||x<1)||phone.length<10||phone.length>15||!["percent","fixed"].includes(type)||!Number.isInteger(value)||value<1||minimum<0||(type==="percent"&&value>100)||!/^\d{4}-\d{2}-\d{2}$/.test(from||"")||!/^\d{4}-\d{2}-\d{2}$/.test(until||"")||until<from||! /^[A-Z0-9_-]{4,30}$/.test(code))return res.status(400).json({error:"Enter a valid promo code, customer mobile, discount and validity dates."});
 try{const r=await pool.query("UPDATE promo_codes SET code=$1,customer_phone=$2,discount_type=$3,discount_value=$4,minimum_order=$5,valid_from=$6,valid_until=$7,excluded_menu_ids=$8 WHERE id=$9 RETURNING *",[code,phone,type,value,minimum,from,until,excludedIds,id]);if(!r.rowCount)return res.status(404).json({error:"Promo code not found."});res.json(r.rows[0]);}catch(e){if(e.code==="23505")return res.status(409).json({error:"That promo code already exists. Choose a different code."});throw e;}
}));
app.delete("/api/admin/promo-codes/:id",auth,admin,asyncRoute(async(req,res)=>{const r=await pool.query("DELETE FROM promo_codes WHERE id=$1 RETURNING id",[Number(req.params.id)]);if(!r.rowCount)return res.status(404).json({error:"Promo code not found."});res.json({ok:true,id:r.rows[0].id})}));

app.get("/api/delivery-area",asyncRoute(async(req,res)=>{const r=await pool.query("SELECT kitchen_address,latitude,longitude,radius_km,grace_meters FROM delivery_area_settings WHERE id=1");res.json(r.rows[0]||{});}));
app.post("/api/check-delivery-area",asyncRoute(async(req,res)=>{
 const address=String(req.body.address||"").trim();if(address.length<8)return res.status(400).json({error:"Please enter the complete delivery address."});
 const areaResult=await pool.query("SELECT latitude,longitude,radius_km,grace_meters FROM delivery_area_settings WHERE id=1"),area=areaResult.rows[0];if(!area)return res.status(503).json({error:"Delivery area is not configured."});
 // Honor an explicitly selected map pin rather than re-geocoding the address text.
 const suppliedLat=req.body.latitude,suppliedLng=req.body.longitude;
 if(suppliedLat!==undefined||suppliedLng!==undefined){
  const latitude=Number(suppliedLat),longitude=Number(suppliedLng);
  if(suppliedLat===undefined||suppliedLng===undefined||!Number.isFinite(latitude)||latitude < -90||latitude>90||!Number.isFinite(longitude)||longitude < -180||longitude>180)return res.status(400).json({error:"Please select a valid point on the map."});
  const sameSociety=deliveryDistanceForAddress(address);
  const distanceKm=sameSociety?sameSociety.distanceKm:await getDrivingDistanceKm(area.latitude,area.longitude,latitude,longitude),maxDistanceKm=Number(area.radius_km)+Number(area.grace_meters)/1000;
  const deliveryFee=calculateDeliveryFee(distanceKm,address);
  return res.json({latitude,longitude,distanceKm,maxDistanceKm,available:Boolean(sameSociety)||distanceKm<=maxDistanceKm,deliveryFee,matchedAddress:sameSociety?"Brigade 7 Gardens — kitchen society":"Customer-selected map pin",distanceType:sameSociety?"same-society":"driving"});
 }
 const normalized=address.replace(/\bBangalore\b/ig,"Bengaluru").replace(/\bBengaluru\s*[-,]?\s*(\d{6})\b/ig,"Bengaluru $1").replace(/\s+/g," ").trim();
 const parts=normalized.split(",").map(x=>x.trim()).filter(Boolean);
 const queries=[...new Set([normalized,...[1,5,4,3,2].map(n=>parts.slice(-n).join(", "))].filter(x=>x.length>20).map(x=>x+", Bengaluru, Karnataka, India").map(x=>x.replace(/(?:,\s*)+/g,", ").trim()))];
 let match=null,providerFailed=false;
 const pin=normalized.match(/\b\d{6}\b/)?.[0]||"";
 const tokens=normalized.toLowerCase().replace(/\b(flat|apartment|apt|floor|block|tower|door|no|number|near|opposite|beside|bengaluru|bangalore|karnataka|india)\b/g," ").split(/[^a-z0-9]+/).filter(t=>t.length>2&&!/^\d+$/.test(t));
 const score=(props,label)=>{
  const searchable=[label,props?.name,props?.street,props?.district,props?.city,props?.county,props?.state,props?.postcode].filter(Boolean).join(" ").toLowerCase();
  const matchedTokens=tokens.filter(t=>searchable.includes(t));
  let points=matchedTokens.length*2;
  if(pin&&String(props?.postcode||"")===pin)points+=30;
  if(/bengaluru|bangalore/.test(searchable))points+=5;
  if(/karnataka/.test(searchable))points+=3;
  const pinMismatch=Boolean(pin&&props?.postcode&&String(props.postcode)!==pin);
  if(pinMismatch)points-=100;
  return {points,matchedTokens:matchedTokens.length,pinMismatch};
 };
 const matches=[];
 for(const query of queries){
  try{
   const url="https://photon.komoot.io/api/?limit=10&lang=en&lat="+encodeURIComponent(area.latitude)+"&lon="+encodeURIComponent(area.longitude)+"&zoom=12&location_bias_scale=0.2&q="+encodeURIComponent(query);
   const response=await fetch(url,{headers:{"User-Agent":"GharKaKhanaDeliveryChecker/1.4"},signal:AbortSignal.timeout(10000)});
   if(!response.ok){providerFailed=true;console.warn("[delivery-area] Photon returned HTTP",response.status);continue;}
   const data=await response.json(),features=Array.isArray(data.features)?data.features:[];
   for(const feature of features){
    if(!feature.geometry||!Array.isArray(feature.geometry.coordinates)||feature.geometry.coordinates.length<2)continue;
    const props=feature.properties||{};if(props.countrycode&&String(props.countrycode).toLowerCase()!=="in")continue;
    if(props.state&&!/karnataka/i.test(String(props.state)))continue;
    const label=[props.name,props.street,props.district,props.city,props.state,props.postcode,props.country].filter((v,i,a)=>v&&a.indexOf(v)===i).join(", ");
    const confidence=score(props,label);
    if(confidence.pinMismatch||confidence.matchedTokens<1)continue;
    matches.push({latitude:Number(feature.geometry.coordinates[1]),longitude:Number(feature.geometry.coordinates[0]),displayName:label||query,...confidence});
   }
  }catch(error){providerFailed=true;console.warn("[delivery-area] Photon request failed:",error.message);}
 }
 if(matches.length)match=matches.sort((a,b)=>b.score-a.score)[0];
 if(!match){
  try{
   const url="https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&addressdetails=1&countrycodes=in&q="+encodeURIComponent(normalized+", India");
   const response=await fetch(url,{headers:{"User-Agent":"GharKaKhanaDeliveryChecker/1.4 (Ghar ka Khana delivery lookup)","Accept-Language":"en"},signal:AbortSignal.timeout(10000)});
   if(response.ok){
    const results=await response.json();
    if(Array.isArray(results)&&results.length){
     const candidates=results.map(r=>{const confidence=score(r.address||{},r.display_name);return {latitude:Number(r.lat),longitude:Number(r.lon),displayName:r.display_name,...confidence,state:r.address?.state};})
      .filter(r=>!r.pinMismatch&&r.matchedTokens>=1&&(!r.state||/karnataka/i.test(String(r.state))));
     if(candidates.length)match=candidates.sort((a,b)=>b.points-a.points)[0];
    }
   }
   else{providerFailed=true;console.warn("[delivery-area] Nominatim returned HTTP",response.status);}
  }catch(error){providerFailed=true;console.warn("[delivery-area] Nominatim request failed:",error.message);}
 }
 if(!match){
  if(providerFailed)return res.status(502).json({error:"Address lookup is temporarily unavailable. Please try again."});
  return res.status(400).json({error:"We could not confidently match this address. Please include the correct locality and PIN code, then check again."});
 }
 const {latitude,longitude,displayName}=match;
 if(!Number.isFinite(latitude)||!Number.isFinite(longitude)||latitude < -90||latitude>90||longitude < -180||longitude>180)return res.status(502).json({error:"The address service returned invalid coordinates. Please try again."});
 const sameSociety=deliveryDistanceForAddress(address);
 const distanceKm=sameSociety?sameSociety.distanceKm:await getDrivingDistanceKm(area.latitude,area.longitude,latitude,longitude),maxDistanceKm=Number(area.radius_km)+Number(area.grace_meters)/1000;
 const deliveryFee=calculateDeliveryFee(distanceKm,address);
 res.json({latitude,longitude,distanceKm,maxDistanceKm,available:Boolean(sameSociety)||distanceKm<=maxDistanceKm,deliveryFee,matchedAddress:sameSociety?"Brigade 7 Gardens — kitchen society":displayName,distanceType:sameSociety?"same-society":"driving"});
}));
app.put("/api/admin/delivery-area",auth,admin,asyncRoute(async(req,res)=>{
 const address=String(req.body.address||"").trim(),latitude=Number(req.body.latitude),longitude=Number(req.body.longitude),radiusKm=Number(req.body.radiusKm),graceMeters=Number(req.body.graceMeters);
 if(!address||!Number.isFinite(latitude)||latitude < -90||latitude>90||!Number.isFinite(longitude)||longitude < -180||longitude>180||!Number.isFinite(radiusKm)||radiusKm<=0||radiusKm>100||!Number.isInteger(graceMeters)||graceMeters<0||graceMeters>5000)return res.status(400).json({error:"Enter a valid address, coordinates, radius and grace distance."});
 const r=await pool.query("UPDATE delivery_area_settings SET kitchen_address=$1,latitude=$2,longitude=$3,radius_km=$4,grace_meters=$5,updated_at=NOW() WHERE id=1 RETURNING kitchen_address,latitude,longitude,radius_km,grace_meters",[address,latitude,longitude,radiusKm,graceMeters]);res.json(r.rows[0]);
}));
app.get("/api/admin/delivery-slots",auth,admin,asyncRoute(async(req,res)=>{const r=await pool.query("SELECT * FROM delivery_slots ORDER BY id");res.json(r.rows)}));
app.put("/api/admin/delivery-slots",auth,admin,asyncRoute(async(req,res)=>{
  const slots=req.body.slots;if(!Array.isArray(slots)||slots.some(x=>typeof x.label!=="string"||!x.label.trim()))return res.status(400).json({error:"Provide valid delivery slots."});
  const c=await pool.connect();try{await c.query("BEGIN");await c.query("DELETE FROM delivery_slots");for(const x of slots)await c.query("INSERT INTO delivery_slots(slot_label,active) VALUES($1,$2)",[x.label.trim(),x.active!==false]);await c.query("COMMIT");}catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}res.json({ok:true});
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
    `SELECT item_name AS name, variant_label AS variant, unit_price AS price, quantity
     FROM order_items WHERE order_id = $1`,
    [id]
  );

  order.items = itemsResult.rows;
  const refundsResult = await pool.query(
    "SELECT id, razorpay_refund_id, amount_paise, status, failure_reason, created_at, updated_at FROM order_refunds WHERE order_id=$1 ORDER BY created_at DESC",
    [id]
  );
  order.refunds = refundsResult.rows;
  return order;
}

// Public kitchen availability. Scheduled reopening automatically takes effect at reopen_at.
async function getKitchenStatus() {
  const result = await pool.query(`SELECT is_open, reopen_at, daily_schedule_enabled, daily_open_time, daily_close_time,
    CASE WHEN is_open = FALSE AND reopen_at IS NOT NULL AND reopen_at <= NOW()
      THEN TRUE ELSE is_open END AS currently_open
    FROM kitchen_settings WHERE id = 1`);
  const row = result.rows[0] || { is_open: true, reopen_at: null, currently_open: true, daily_schedule_enabled: false };
  if (row.daily_schedule_enabled && row.daily_open_time && row.daily_close_time) {
    const local = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
    const [hour, minute] = local.split(":").map(Number);
    const nowMinutes = hour * 60 + minute;
    const [openHour, openMinute] = String(row.daily_open_time).slice(0, 5).split(":").map(Number);
    const [closeHour, closeMinute] = String(row.daily_close_time).slice(0, 5).split(":").map(Number);
    const openMinutes = openHour * 60 + openMinute;
    const closeMinutes = closeHour * 60 + closeMinute;
    const isOpen = openMinutes === closeMinutes ? false : openMinutes < closeMinutes
      ? nowMinutes >= openMinutes && nowMinutes < closeMinutes
      : nowMinutes >= openMinutes || nowMinutes < closeMinutes;
    return { isOpen, reopenAt: null, scheduleEnabled: true, dailyOpenTime: String(row.daily_open_time).slice(0, 5), dailyCloseTime: String(row.daily_close_time).slice(0, 5) };
  }
  if (row.currently_open && !row.is_open) {
    await pool.query("UPDATE kitchen_settings SET is_open = TRUE, reopen_at = NULL, updated_at = NOW() WHERE id = 1");
    return { isOpen: true, reopenAt: null, scheduleEnabled: false, dailyOpenTime: null, dailyCloseTime: null };
  }
  return { isOpen: row.currently_open, reopenAt: row.reopen_at, scheduleEnabled: false, dailyOpenTime: row.daily_open_time || null, dailyCloseTime: row.daily_close_time || null };
}
app.get("/api/kitchen/status", asyncRoute(async (req, res) => {
  res.json(await getKitchenStatus());
}));
app.patch("/api/admin/kitchen", auth, admin, asyncRoute(async (req, res) => {
  if (Object.prototype.hasOwnProperty.call(req.body || {}, "dailyOpenTime") || Object.prototype.hasOwnProperty.call(req.body || {}, "dailyCloseTime")) {
    const { dailyOpenTime, dailyCloseTime } = req.body || {};
    const validTime = value => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
    if (!validTime(dailyOpenTime) || !validTime(dailyCloseTime) || dailyOpenTime === dailyCloseTime) {
      return res.status(400).json({ error: "Choose valid daily opening and closing times. They cannot be the same." });
    }
    await pool.query("UPDATE kitchen_settings SET daily_schedule_enabled = TRUE, daily_open_time = $1, daily_close_time = $2, reopen_at = NULL, updated_at = NOW() WHERE id = 1", [dailyOpenTime, dailyCloseTime]);
    return res.json(await getKitchenStatus());
  }
  const isOpen = req.body.isOpen;
  if (typeof isOpen !== "boolean") return res.status(400).json({ error: "Choose whether the kitchen is open or closed." });
  let reopenAt = null;
  if (!isOpen && req.body.reopenAt) {
    const parsed = new Date(req.body.reopenAt);
    if (Number.isNaN(parsed.getTime()) || parsed <= new Date()) {
      return res.status(400).json({ error: "Choose a future reopening date and time." });
    }
    reopenAt = parsed.toISOString();
  }
  await pool.query(
    "UPDATE kitchen_settings SET is_open = $1, reopen_at = $2, daily_schedule_enabled = FALSE, updated_at = NOW() WHERE id = 1",
    [isOpen, reopenAt]
  );
  res.json(await getKitchenStatus());
}));

// Customer order history
app.get("/api/orders/mine", auth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT o.id, o.total, o.address, o.status, o.payment_status, o.created_at, o.estimated_delivery_minutes,
            (SELECT rf.status FROM order_refunds rf WHERE rf.order_id = o.id ORDER BY rf.created_at DESC LIMIT 1) AS refund_status,
            (SELECT rf.amount_paise FROM order_refunds rf WHERE rf.order_id = o.id ORDER BY rf.created_at DESC LIMIT 1) AS refund_amount_paise,
            EXISTS (SELECT 1 FROM reviews r WHERE r.order_id = o.id) AS reviewed
     FROM orders o WHERE o.user_id = $1
     ORDER BY id DESC`,
    [req.user.id]
  );

  res.json(result.rows);
}));

// Customer: read one of the signed-in customer's orders with full item and checkout details.
app.get("/api/orders/mine/:id", auth, asyncRoute(async (req, res) => {
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId) || orderId < 1) {
    return res.status(400).json({ error: "Invalid order." });
  }

  const result = await pool.query(
    "SELECT id FROM orders WHERE id = $1 AND user_id = $2",
    [orderId, req.user.id]
  );
  if (!result.rowCount) {
    return res.status(404).json({ error: "Order not found." });
  }

  const order = await readOrder(orderId);
  if (!order) return res.status(404).json({ error: "Order not found." });
  res.json(order);
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

// Owner: update order status and notify customers of supported status changes.
app.patch("/api/admin/orders/:id", auth, admin, asyncRoute(async (req, res) => {
  const allowed = [
    "Payment Pending",
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

  const cancellationReason = String(req.body.cancellationReason || "").trim();
  if (req.body.status === "Cancelled" &&
      cancellationReason !== "Kitchen Closed" && !cancellationReason) {
    return res.status(400).json({ error: "Please select a cancellation reason." });
  }
  const savedCancellationReason = req.body.status === "Cancelled" && cancellationReason !== "Kitchen Closed"
    ? `Out of Stock: ${cancellationReason}`
    : cancellationReason;

  const result = await pool.query(
    `UPDATE orders
     SET status = $1,
         cancellation_reason = CASE WHEN $1 = 'Cancelled' THEN $2 ELSE cancellation_reason END
     WHERE id = $3
     RETURNING id, status`,
    [req.body.status, savedCancellationReason, req.params.id]
  );

  if (result.rowCount === 0) {
    return res.status(404).json({ error: "Order not found." });
  }

  const order = await readOrder(req.params.id);
  if (result.rows[0].status === "Cancelled") {
    notifyCustomerOrderStatus(order.id, "Cancelled", cancellationReason).catch((error) =>
      console.error("Customer cancellation notification error:", error.message)
    );
  } else if (["Accepted", "Delivered"].includes(result.rows[0].status)) {
    notifyCustomerOrderStatus(order.id, result.rows[0].status).catch((error) =>
      console.error("Customer status notification error:", error.message)
    );
  }

  res.json(order);
}));


// Publicly display only owner-approved customer reviews.
app.get("/api/reviews", asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT r.id, r.rating, r.comment, r.created_at,
            split_part(u.name, ' ', 1) AS customer_name
     FROM reviews r JOIN users u ON u.id = r.user_id
     WHERE r.approved = TRUE
     ORDER BY r.created_at DESC LIMIT 50`
  );
  const summary = await pool.query(
    "SELECT COALESCE(ROUND(AVG(rating), 1), 0) AS average, COUNT(*)::int AS count FROM reviews WHERE approved = TRUE"
  );
  res.json({ reviews: result.rows, summary: summary.rows[0] });
}));

// Customers may review each completed order once; all reviews require owner approval.
app.post("/api/reviews", auth, asyncRoute(async (req, res) => {
  const orderId = Number(req.body.orderId);
  const rating = Number(req.body.rating);
  const comment = String(req.body.comment || "").trim().slice(0, 1000);
  if (!Number.isInteger(orderId) || orderId < 1 || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: "Choose a valid order and a rating from 1 to 5 stars." });
  }
  const order = await pool.query("SELECT id, status FROM orders WHERE id = $1 AND user_id = $2", [orderId, req.user.id]);
  if (!order.rowCount) return res.status(404).json({ error: "Order not found." });
  if (order.rows[0].status !== "Delivered") return res.status(400).json({ error: "You can review an order after it has been delivered." });
  try {
    const result = await pool.query(
      `INSERT INTO reviews (order_id, user_id, rating, comment)
       VALUES ($1, $2, $3, $4) RETURNING id, rating, comment, approved`,
      [orderId, req.user.id, rating, comment]
    );
    res.status(201).json({ review: result.rows[0], message: "Thank you! Your review has been submitted for approval." });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ error: "You have already reviewed this order." });
    throw error;
  }
}));

// Owner review moderation.
app.get("/api/admin/reviews", auth, admin, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT r.id, r.order_id, r.rating, r.comment, r.approved, r.created_at,
            u.name AS customer_name, u.phone AS customer_phone
     FROM reviews r JOIN users u ON u.id = r.user_id
     ORDER BY r.created_at DESC`
  );
  res.json(result.rows);
}));
app.patch("/api/admin/reviews/:id", auth, admin, asyncRoute(async (req, res) => {
  if (typeof req.body.approved !== "boolean") return res.status(400).json({ error: "Choose approve or hide." });
  const result = await pool.query("UPDATE reviews SET approved = $1 WHERE id = $2 RETURNING id, approved", [req.body.approved, req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: "Review not found." });
  res.json(result.rows[0]);
}));

// Owner CTA redirect for bulk enquiry WhatsApp chat.
// Meta does not allow direct wa.me links in template buttons, so the
// template points to this route and the server redirects the owner to WhatsApp.
app.get("/bulk-chat/:phone", (req, res) => {
  const rawBulkChatPhone = String(req.params.phone || "");
  console.log("Bulk chat requested:", {
    rawPhone: rawBulkChatPhone,
    normalizedInput: normalizePhone(rawBulkChatPhone),
    url: req.originalUrl
  });

  let customerPhone = normalizePhone(rawBulkChatPhone);

  // Normalize common Indian phone formats for WhatsApp click-to-chat.
  if (customerPhone.length === 10) {
    customerPhone = "91" + customerPhone;
  } else if (customerPhone.length === 11 && customerPhone.startsWith("0")) {
    customerPhone = "91" + customerPhone.slice(1);
  }

  if (!/^\d{10,15}$/.test(customerPhone)) {
    return res.status(400).send("Invalid customer WhatsApp number.");
  }

  // Open the final WhatsApp URL from the browser instead of relying on an
  // HTTP redirect. This preserves the exact click-to-chat number.
  const whatsappUrl = `https://wa.me/${customerPhone}`;
  console.log("Bulk chat final WhatsApp URL:", whatsappUrl);
  const safeUrl = whatsappUrl.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Chat with Customer</title>
  <meta http-equiv="refresh" content="0;url=${safeUrl}">
</head>
<body style="font-family:Arial,sans-serif;padding:32px;text-align:center">
  <p>Opening WhatsApp…</p>
  <p><a href="${safeUrl}">Tap here if WhatsApp does not open</a></p>
  <script>window.location.replace(${JSON.stringify(whatsappUrl)});</script>
</body>
</html>`);
});

// Bulk & party order enquiries
app.post("/api/bulk-enquiries", asyncRoute(async (req, res) => {
  const clean = (value, max = 1000) => String(value ?? "").trim().replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").slice(0, max);
  const customerName = clean(req.body?.name, 120);
  const rawPhone = clean(req.body?.phone, 30);
  const occasion = clean(req.body?.occasion, 80);
  const eventDate = clean(req.body?.date, 20);
  const guests = Number(req.body?.guests);
  const deliveryLocation = clean(req.body?.location, 1000);
  const foodPreferences = clean(req.body?.preferences, 600);
  const notes = clean(req.body?.notes, 1000);
  if (!customerName || !rawPhone || !occasion || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || !Number.isInteger(guests) || guests < 1 || guests > 5000 || !deliveryLocation) return res.status(400).json({ error: "Please complete all required enquiry details." });
  let customerPhone = normalizePhone(rawPhone);
  if (customerPhone.length === 10) customerPhone = "91" + customerPhone;
  if (customerPhone.length < 10 || customerPhone.length > 15) return res.status(400).json({ error: "Please enter a valid mobile number." });
  const saved = await pool.query('INSERT INTO bulk_enquiries (customer_name, customer_phone, occasion, event_date, guests, delivery_location, food_preferences, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at', [customerName, customerPhone, occasion, eventDate, guests, deliveryLocation, foodPreferences, notes]);
  const enquiryId = saved.rows[0].id;
  const { WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_TO_NUMBER, WHATSAPP_API_VERSION = "v21.0", WHATSAPP_BULK_ENQUIRY_TEMPLATE = "ghar_ka_khana_bulk_enquiry" } = process.env;
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID || !WHATSAPP_TO_NUMBER) {
    await pool.query("UPDATE bulk_enquiries SET customer_whatsapp_status='not_configured' WHERE id=$1", [enquiryId]);
    return res.status(503).json({ error: "Bulk enquiry WhatsApp delivery is not configured yet. The enquiry was saved." });
  }
  let customerWhatsappStatus = "unknown";
  let customerWhatsappId = customerPhone;
  try {
    const contactResponse = await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/contacts`, { method: "POST", headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ messaging_product: "whatsapp", blocking: "wait", contacts: [customerPhone] }) });
    const contactResult = await contactResponse.json().catch(() => ({}));
    const contact = contactResult.contacts?.[0];
    customerWhatsappStatus = contact?.status === "valid" ? "valid" : "invalid";

    // Keep the click-to-chat target as the normalized phone number.
    // WhatsApp click-to-chat expects the full international phone number,
    // not a Meta API identifier.
    customerWhatsappId = customerPhone;
  } catch (error) { console.warn("Bulk enquiry WhatsApp contact check failed:", error.message); }
  const cleanTemplate = value => String(value || "Not provided").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  const templateParameters = [customerName, customerPhone, occasion, eventDate, String(guests), deliveryLocation, foodPreferences || "Not specified", notes || "None"].map(value => ({ type: "text", text: cleanTemplate(value) }));
  // The approved Meta template contains a required dynamic URL button.
  // Pass Meta's canonical WhatsApp ID when available.
  const buttonParameters = [
    {
      type: "button",
      sub_type: "url",
      index: "0",
      parameters: [{ type: "text", text: customerWhatsappId }]
    }
  ];
  const response = await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`, { method: "POST", headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: WHATSAPP_TO_NUMBER, type: "template", template: { name: WHATSAPP_BULK_ENQUIRY_TEMPLATE, language: { code: "en" }, components: [{ type: "body", parameters: templateParameters }, ...buttonParameters] } }) });
  const result = await response.json().catch(() => ({}));
  await pool.query("UPDATE bulk_enquiries SET customer_whatsapp_status=$1 WHERE id=$2", [customerWhatsappStatus, enquiryId]);
  if (!response.ok) { console.error("Bulk enquiry WhatsApp notification failed:", result); return res.status(502).json({ error: "The enquiry was saved, but WhatsApp could not deliver it to the owner. Please try again." }); }
  res.json({ success: true, enquiryId, customerWhatsappStatus, message: "Your enquiry has been sent to Ghar ka Khana. We will contact you shortly." });
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
      const variant = cleanWhatsAppText(item.variant, "");
      return `${name}${variant ? " ("+variant+")" : ""} x ${quantity} - Rs. ${lineTotal}`;
    })
    .join("; ") || "No items found";

  const deliveryFee=Number(order.delivery_fee)||0;
  const handlingFee=Number(order.handling_fee??5);
  // Keep the approved Meta template's existing parameter count; include payment state
  // in its existing total/charges parameter so no WhatsApp template edit is required.
  const paymentState = String(order.payment_status || "").toLowerCase();
  const paymentSummary = paymentState === "cod"
    ? `COD — Rs. ${Number(order.total) || 0} due on delivery`
    : paymentState === "paid"
      ? `ONLINE — PAID${order.razorpay_payment_id ? " | Razorpay ID: " + cleanWhatsAppText(order.razorpay_payment_id) : ""}`
      : paymentState === "failed"
        ? "ONLINE — PAYMENT FAILED / NOT PAID"
        : "ONLINE — PAYMENT PENDING / NOT CONFIRMED";
  const totalAmount = `PAYMENT: ${paymentSummary}; Items subtotal Rs. ${(Number(order.total)||0)-handlingFee-deliveryFee+(Number(order.discount)||0)}; Handling & processing fee Rs. ${handlingFee}; Delivery Charge Rs. ${deliveryFee}; ${Number(order.discount)>0 ? `Promo savings Rs. ${Number(order.discount)} (${order.promo_code}); ` : ""}Total Rs. ${Number(order.total)||0}`;
  const scheduledInfo = order.scheduled_at ? `Scheduled: ${new Date(order.scheduled_at).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})}${order.delivery_slot ? " ("+order.delivery_slot+")" : ""}. ` : "";
  const deliveryAddress = cleanWhatsAppText(scheduledInfo + order.address);

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
        type: "template",        template: {
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
                { type: "text", text: deliveryAddress },
                { type: "text", text: cleanWhatsAppText(order.notes, "None") }
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
            })) : [])]
        }
      })
    }
  );

  const result = await response.json();

  if (!response.ok) {
    console.error("WhatsApp template notification failed:", result);
    throw new Error("WhatsApp notification failed.");
  }

  const sentMessageId = result.messages?.[0]?.id;
  if (sentMessageId) {
    await pool.query(
      `INSERT INTO whatsapp_order_messages (wamid, order_id)
       VALUES ($1, $2)
       ON CONFLICT (wamid) DO NOTHING`,
      [sentMessageId, order.id]
    );
  } else {
    console.warn("WhatsApp notification succeeded but Meta returned no message ID; quick replies cannot be linked to this order.");
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

// Notify customers when an order is accepted, delivered, or cancelled.
async function notifyCustomerOrderStatus(orderId, status, cancellationReason = "") {
  if (!["Accepted", "Delivered", "Cancelled"].includes(status)) return;

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
  const customerMessage = status === "Accepted"
    ? (order.estimated_delivery_minutes ? `Your estimated delivery time is ${order.estimated_delivery_minutes} minutes.` : "We'll keep you updated.")
    : status === "Delivered"
      ? "Thank you for choosing us! We hope you enjoy your meal. Reply with a rating from 1 to 5 to share your experience; we'll ask for optional feedback next."
      : cancellationReason === "Kitchen Closed"
        ? "Your order has been cancelled — our kitchen is closed. We apologise for the inconvenience."
        : cancellationReason === "Cancelled by owner via WhatsApp"
          ? "Your order has been cancelled by the kitchen. We apologise for the inconvenience."
          : `Your order has been cancelled because ${(String(cancellationReason || "").startsWith("Out of Stock: ") ? String(cancellationReason).slice("Out of Stock: ".length) : String(cancellationReason || "")) || "an item"} is out of stock. We apologise for the inconvenience.`;
  // Use the single approved Meta template for both customer status updates.
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
              { type: "text", text: status },
              { type: "text", text: customerMessage }
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

// Accept customer WhatsApp ratings and optional feedback for their latest eligible delivered order.
async function handleCustomerWhatsAppReview(message) {
  if (message.type !== "text") return;
  const phone = normalizePhone(message.from);
  const textBody = String(message.text?.body || "").trim();
  if (!phone || !textBody) return;

  const pending = await pool.query(
    "SELECT order_id, user_id, rating FROM whatsapp_pending_reviews WHERE customer_phone = $1",
    [phone]
  );

  if (pending.rowCount) {
    const pendingReview = pending.rows[0];
    const comment = /^(SKIP|NO|NONE)$/i.test(textBody) ? "" : textBody.slice(0, 1000);
    try {
      await pool.query(
        "INSERT INTO reviews (order_id, user_id, rating, comment) VALUES ($1, $2, $3, $4)",
        [pendingReview.order_id, pendingReview.user_id, pendingReview.rating, comment]
      );
      await pool.query("DELETE FROM whatsapp_pending_reviews WHERE customer_phone = $1", [phone]);
      await sendWhatsAppText(message.from, `Thank you for rating Ghar ka Khana ${pendingReview.rating}/5! Your review has been submitted and will appear on our website after review approval.`);
    } catch (error) {
      await pool.query("DELETE FROM whatsapp_pending_reviews WHERE customer_phone = $1", [phone]);
      if (error.code === "23505") {
        await sendWhatsAppText(message.from, "Thank you! This order already has a review recorded.");
        return;
      }
      throw error;
    }
    return;
  }

  if (!/^[1-5]$/.test(textBody)) return;
  const latest = await pool.query(
    `SELECT o.id AS order_id, o.user_id
     FROM orders o
     JOIN users u ON u.id = o.user_id
     LEFT JOIN reviews r ON r.order_id = o.id
     WHERE o.status = 'Delivered'
       AND r.id IS NULL
       AND RIGHT(REGEXP_REPLACE(COALESCE(u.phone, ''), '[^0-9]', '', 'g'), 10) = RIGHT($1, 10)
     ORDER BY o.created_at DESC
     LIMIT 1`,
    [phone]
  );
  if (!latest.rowCount) {
    await sendWhatsAppText(message.from, "Thanks for reaching out to Ghar ka Khana. Ratings are available after an order is delivered. Please reply 1 to 5 after delivery.");
    return;
  }

  await pool.query(
    `INSERT INTO whatsapp_pending_reviews (customer_phone, order_id, user_id, rating)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (customer_phone) DO UPDATE
       SET order_id = EXCLUDED.order_id, user_id = EXCLUDED.user_id,
           rating = EXCLUDED.rating, created_at = CURRENT_TIMESTAMP`,
    [phone, latest.rows[0].order_id, latest.rows[0].user_id, Number(textBody)]
  );
  await sendWhatsAppText(message.from, "Thank you for your " + textBody + "/5 rating! You can now send optional written feedback in your next message, or reply SKIP.");
}

// Incoming owner WhatsApp replies update order status; customer replies can submit ratings.
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
          const ownerMatch = Boolean(expectedOwner) && normalizePhone(message.from) === expectedOwner;
          if (!ownerMatch) {
            try {
              await handleCustomerWhatsAppReview(message);
            } catch (error) {
              console.error("Customer WhatsApp review processing failed:", error.message);
            }
            continue;
          }

          // If the owner is replying with an ETA, consume the numeric reply before status parsing.
          if (message.type === "text") {
            const pending = await pool.query("SELECT order_id FROM whatsapp_pending_eta WHERE id = 1");
            const minutesText = String(message.text?.body || "").trim();
            if (pending.rowCount && /^\d{1,3}$/.test(minutesText)) {
              const minutes = Number(minutesText);
              if (minutes < 5 || minutes > 480) {
                await sendWhatsAppText(message.from, "Please enter an estimate between 5 and 480 minutes.");
                continue;
              }
              const orderId = Number(pending.rows[0].order_id);
              await pool.query("UPDATE orders SET estimated_delivery_minutes = $1 WHERE id = $2", [minutes, orderId]);
              await pool.query("DELETE FROM whatsapp_pending_eta WHERE id = 1");
              await sendWhatsAppText(message.from, `Saved ${minutes} minutes for order GKK-${String(orderId).padStart(4,"0")}. The customer will be notified.`);
              notifyCustomerOrderStatus(orderId, "Accepted").catch(error => console.error("Customer ETA notification failed:", error.message));
              continue;
            }
          }

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
          let parts = replyId.split("|");
          let action = String(parts[0] || "").trim().toUpperCase();
          let orderId = Number(parts[1]);

          // Meta quick-reply callbacks can return only the visible button label.
          // Use the original message context to identify the order safely.
          if ((!Number.isInteger(orderId) || orderId < 1) && message.context?.id) {
            const linked = await pool.query(
              "SELECT order_id FROM whatsapp_order_messages WHERE wamid = $1",
              [message.context.id]
            );
            if (linked.rowCount) {
              orderId = Number(linked.rows[0].order_id);
              action = action.replace(/[^A-Z ]/g, "").trim();
              if (action === "MORE ACTIONS" || action === "MORE" || action === "UPDATE STATUS") action = "MORE";
              else if (action === "ACCEPTED") action = "ACCEPT";
              else if (action === "CANCELLED") action = "CANCEL";
            }
          }

          console.log("WhatsApp owner reply received:", JSON.stringify({
            type: message.type || "unknown",
            interactiveType: message.interactive?.button_reply ? "button_reply" : message.interactive?.list_reply ? "list_reply" : null,
            hasReplyId: Boolean(replyId),
            action: action || "unrecognized",
            hasOrderContext: Number.isInteger(orderId) && orderId > 0
          }));
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

          if (status === "Accepted") {
            const accepted = await pool.query("UPDATE orders SET status = 'Accepted' WHERE id = $1 AND status IS DISTINCT FROM 'Accepted' RETURNING id", [orderId]);
            if (!accepted.rowCount) {
              await sendWhatsAppText(message.from, `Order GKK-${String(orderId).padStart(4,"0")} is already accepted or was not found.`);
              continue;
            }
            await pool.query("INSERT INTO whatsapp_pending_eta(id, order_id, created_at) VALUES (1, $1, NOW()) ON CONFLICT (id) DO UPDATE SET order_id = EXCLUDED.order_id, created_at = NOW()", [orderId]);
            await sendWhatsAppText(message.from, `Order GKK-${String(orderId).padStart(4,"0")} accepted. Reply with the estimated delivery time in minutes (for example, 40). The customer will be notified after you enter it.`);
            continue;
          }

          const result = await pool.query(
            "UPDATE orders SET status = $1, cancellation_reason = CASE WHEN $1 = 'Cancelled' THEN 'Cancelled by owner via WhatsApp' ELSE cancellation_reason END WHERE id = $2 AND status IS DISTINCT FROM $1 RETURNING id",
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
            // Keep the owner's WhatsApp uncluttered; the live status is visible in My Orders and the owner dashboard.
            console.log(`WhatsApp owner updated order ${orderId} to ${status}`);
            if (status === "Accepted" || status === "Delivered" || status === "Cancelled") {
              const cancellationReason = status === "Cancelled" ? "Cancelled by owner via WhatsApp" : "";
              notifyCustomerOrderStatus(orderId, status, cancellationReason).catch((error) =>
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
  console.error("Server error:", { method: req.method, path: req.path, code: err.code, message: err.message, stack: err.stack });
  if (req.path === "/api/addresses" && req.method === "POST") {
    return res.status(500).json({ error: `Address could not be saved (${err.code || "SERVER_ERROR"}). Please try again; if it repeats, share this code with support.` });
  }
  const status=Number(err.statusCode||err.status)||500;
  res.status(status>=400&&status<600?status:500).json({ error: status>=400&&status<500||status===502||status===503 ? err.message : "Something went wrong. Please try again." });
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