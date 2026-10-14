const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("../server.js"), "utf8");

function extractFunction(name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `could not find ${name}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "{") depth++;
    if (ch === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`could not parse function ${name}`);
}

function harness({ total = 235, insertRowCount = 1, refundResponse = { id: "rf_test_1", status: "processed" } } = {}) {
  const calls = { queries: [], refunds: [] };
  const pool = {
    async query(sql, params) {
      calls.queries.push({ sql, params });
      if (sql.includes("SELECT total FROM orders")) return { rowCount: 1, rows: [{ total }] };
      if (sql.includes("INSERT INTO razorpay_duplicate_payments")) {
        return { rowCount: insertRowCount, rows: insertRowCount ? [{ id: 9 }] : [] };
      }
      if (sql.includes("UPDATE razorpay_duplicate_payments")) return { rowCount: 1, rows: [] };
      throw new Error("Unexpected SQL in test: " + sql);
    }
  };
  const razorpay = {
    payments: {
      async refund(id, options) {
        calls.refunds.push({ id, options });
        return refundResponse;
      }
    }
  };
  const sandbox = { pool, razorpay, console: { error() {}, info() {} } };
  vm.runInNewContext(extractFunction("refundDuplicateCapturedPayment"), sandbox);
  return { run: sandbox.refundDuplicateCapturedPayment, calls };
}

const payment = (overrides = {}) => ({
  id: "pay_duplicate_test",
  order_id: "order_test",
  amount: 23500,
  status: "captured",
  captured: true,
  ...overrides
});

test("amount mismatch is recorded for manual review and never auto-refunded", async () => {
  const h = harness();
  await h.run(6, "pay_original_test", payment({ amount: 20000 }));
  const insert = h.calls.queries.find(x => x.sql.includes("INSERT INTO razorpay_duplicate_payments"));
  assert.ok(insert, "mismatched captured payment should be recorded");
  assert.equal(insert.params[3], 20000);
  assert.match(insert.sql, /'manual_review'/);
  assert.match(insert.params[4], /no automatic refund was submitted/);
  assert.equal(h.calls.refunds.length, 0, "mismatched amount must not be refunded automatically");
});

test("matching duplicate amount is refunded and refund result is persisted", async () => {
  const h = harness();
  await h.run(6, "pay_original_test", payment());
  assert.equal(h.calls.refunds.length, 1);
  assert.equal(h.calls.refunds[0].id, "pay_duplicate_test");
  assert.equal(h.calls.refunds[0].options.amount, 23500);
  const update = h.calls.queries.find(x => x.sql.includes("UPDATE razorpay_duplicate_payments"));
  assert.ok(update, "refund status should be persisted");
  assert.ok(update.params.includes("rf_test_1"));
  assert.ok(update.params.includes("processed"));
});

test("already-recorded duplicate payment ID does not submit another refund", async () => {
  const h = harness({ insertRowCount: 0 });
  await h.run(6, "pay_original_test", payment());
  assert.equal(h.calls.refunds.length, 0);
});

test("invalid non-positive captured amount is not inserted or refunded", async () => {
  const h = harness();
  await h.run(6, "pay_original_test", payment({ amount: 0 }));
  assert.equal(h.calls.queries.some(x => x.sql.includes("INSERT INTO razorpay_duplicate_payments")), false);
  assert.equal(h.calls.refunds.length, 0);
});
