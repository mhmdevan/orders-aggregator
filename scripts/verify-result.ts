import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { config } from "../src/config.js";
import { createDb } from "../src/db.js";

// Independent reference: PostgreSQL's historical timezone rules and exact
// NUMERIC sums, without calling TotalsService or the application's money helpers.
const db = createDb(config.databaseUrl);
try {
  const { rows: expected } = await db.query(`
    WITH days AS (
      SELECT day::date AS date
      FROM generate_series(date '2026-03-27', date '2026-03-31', interval '1 day') day
    ), sums AS (
      SELECT (o.created_at AT TIME ZONE c.timezone)::date AS date,
             sum(o.amount_kop)::numeric AS gross,
             sum(coalesce(o.amount_paid_kop, o.amount_kop))::numeric AS net
      FROM orders o JOIN customers c ON c.id = o.customer_id
      WHERE o.customer_id = 'c_7' AND o.status = 'paid'
      GROUP BY 1
    )
    SELECT to_char(d.date, 'YYYY-MM-DD') AS date,
           (coalesce(s.gross, 0) / 100)::float8 AS total,
           (coalesce(s.gross, 0) / 100)::float8 AS gross,
           ((coalesce(s.gross, 0) - coalesce(s.net, 0)) / 100)::float8 AS discount,
           (coalesce(s.net, 0) / 100)::float8 AS net
    FROM days d LEFT JOIN sums s USING (date)
    ORDER BY d.date
  `);
  const result = JSON.parse(await readFile(new URL("../result.json", import.meta.url), "utf8"));
  assert.deepEqual(result, expected, "result.json must match the independent PostgreSQL calculation");
  const response = await fetch(`http://localhost:${config.port}/customers/c_7/daily-totals?from=2026-03-27&to=2026-03-31`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), expected, "live HTTP response must match PostgreSQL");

  const { rows: timezone } = await db.query(`SELECT id, timezone FROM customers WHERE id = 'c_7'`);
  const { rows: counts } = await db.query(`SELECT count(*)::int AS orders, count(amount_paid_kop)::int AS orders_with_payment FROM orders`);
  // Show which days change when a single winter/summer offset is used.
  const { rows: offsetComparison } = await db.query(`
    WITH offsets AS (SELECT unnest(ARRAY[60, 120]) AS minutes), sums AS (
      SELECT offsets.minutes,
             to_char((o.created_at AT TIME ZONE 'UTC') + offsets.minutes * interval '1 minute', 'YYYY-MM-DD') AS date,
             (sum(o.amount_kop)::numeric / 100)::float8 AS gross
      FROM orders o CROSS JOIN offsets WHERE o.customer_id = 'c_7' AND o.status = 'paid'
      GROUP BY 1, 2
    ) SELECT * FROM sums WHERE date BETWEEN '2026-03-27' AND '2026-03-31' ORDER BY minutes, date
  `);
  console.log(JSON.stringify({ verified: true, customer: timezone[0], counts: counts[0], expected, offsetComparison }, null, 2));
} finally {
  await db.end();
}
