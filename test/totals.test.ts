import { afterEach, describe, expect, it, vi } from "vitest";
import { apiOrder, dailyTotals, postWebhook, setupTestApp } from "./helpers.js";

const ctx = setupTestApp();
afterEach(() => vi.useRealTimers());

describe("GET /customers/:id/daily-totals", () => {
  it("keeps migrated orders readable before payment metadata is backfilled", async () => {
    await ctx.db.query(`INSERT INTO orders (id, customer_id, amount_kop, status, created_at, updated_at)
      VALUES ('legacy', 'c_1', 1999, 'paid', '2026-02-10T12:00:00Z', '2026-02-10T12:00:00Z')`);
    expect((await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10")).json()).toEqual([
      { date: "2026-02-10", total: 19.99, gross: 19.99, discount: 0, net: 19.99 },
    ]);
  });

  it("sums actual payments, keeping total equal to gross and zero days present", async () => {
    await postWebhook(ctx.app, apiOrder({ amount: 2500, discountPercent: "16.5", amountPaid: "2087.50" }));
    await postWebhook(ctx.app, apiOrder({ amount: 19.99, discountPercent: 0, amountPaid: 19.99 }));
    await postWebhook(ctx.app, apiOrder({ amount: 100, discountPercent: 100, amountPaid: 0 }));
    await postWebhook(ctx.app, apiOrder({ amount: 500, amountPaid: 400, status: "pending" }));
    await postWebhook(ctx.app, apiOrder({ amount: 700, amountPaid: 600, status: "refunded" }));
    const res = await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-11");
    expect(res.json()).toEqual([
      { date: "2026-02-10", total: 2619.99, gross: 2619.99, discount: 512.5, net: 2107.49 },
      { date: "2026-02-11", total: 0, gross: 0, discount: 0, net: 0 },
    ]);
  });

  it("uses amountPaid as the source of truth instead of recalculating the percentage", async () => {
    await postWebhook(ctx.app, apiOrder({ amount: 100, discountPercent: 10, amountPaid: 89.99 }));
    expect((await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10")).json()).toEqual([
      { date: "2026-02-10", total: 100, gross: 100, discount: 10.01, net: 89.99 },
    ]);
  });

  it.each(["2026-01-15T00:00:00Z", "2026-07-15T00:00:00Z"])(
    "groups Berlin orders using historical DST regardless of server date %s", async (now) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(now));
      ctx.api.customers.set("c_7", "Europe/Berlin");
      const points = [
        ["2026-03-26T22:59:59Z", 1], // outside the requested local dates
        ["2026-03-26T23:00:00Z", 2],
        ["2026-03-27T22:30:00Z", 4], // still March 27 (UTC+1)
        ["2026-03-28T23:00:00Z", 8],
        ["2026-03-29T00:59:59Z", 16], // before the clock change
        ["2026-03-29T01:00:00Z", 32], // after the clock change
        ["2026-03-29T22:00:00Z", 64], // March 30 (UTC+2)
        ["2026-03-30T22:00:00", 128], // no zone still means UTC
        ["2026-03-31T21:59:59Z", 256],
        ["2026-03-31T22:00:00Z", 512], // outside the requested local dates
      ] as const;
      for (const [createdAt, amount] of points) {
        const res = await postWebhook(ctx.app, apiOrder({ customerId: "c_7", createdAt, amount, amountPaid: amount / 2 }));
        expect(res.statusCode).toBe(200);
      }
      expect((await dailyTotals(ctx.app, "c_7", "2026-03-27", "2026-03-31")).json()).toEqual(
        [6, 0, 56, 64, 384].map((gross, i) => ({
          date: `2026-03-${27 + i}`, total: gross, gross, discount: gross / 2, net: gross / 2,
        })),
      );
    },
  );

  it("handles the repeated hour and midnight when Berlin returns to standard time", async () => {
    ctx.api.customers.set("c_7", "Europe/Berlin");
    for (const createdAt of ["2026-10-25T00:30:00Z", "2026-10-25T01:30:00Z", "2026-10-25T22:30:00Z"]) {
      await postWebhook(ctx.app, apiOrder({ customerId: "c_7", createdAt, amount: 1 }));
    }
    expect((await dailyTotals(ctx.app, "c_7", "2026-10-25", "2026-10-26")).json()).toEqual([
      { date: "2026-10-25", total: 3, gross: 3, discount: 0, net: 3 },
      { date: "2026-10-26", total: 0, gross: 0, discount: 0, net: 0 },
    ]);
  });

  it.each(["Pacific/Kiritimati", "America/Adak"])("includes midnight orders at extreme UTC offsets: %s", async (timezone) => {
    ctx.api.customers.set("c_edge", timezone);
    const createdAt = timezone === "Pacific/Kiritimati" ? "2026-02-09T10:00:00Z" : "2026-02-11T09:59:59Z";
    await postWebhook(ctx.app, apiOrder({ customerId: "c_edge", createdAt, amount: 19.99, amountPaid: 1.15 }));
    expect((await dailyTotals(ctx.app, "c_edge", "2026-02-10", "2026-02-10")).json()).toEqual([
      { date: "2026-02-10", total: 19.99, gross: 19.99, discount: 18.84, net: 1.15 },
    ]);
  });

  it("суммирует оплаченные заказы по дням в таймзоне клиента", async () => {
    // c_1 — Europe/Moscow (UTC+3): 20:30Z ещё 10-е, 21:30Z уже 11-е
    await postWebhook(ctx.app, apiOrder({ amount: 1000, createdAt: "2026-02-10T20:30:00Z" }));
    await postWebhook(ctx.app, apiOrder({ amount: 250, createdAt: "2026-02-10T21:30:00Z" }));
    await postWebhook(ctx.app, apiOrder({ amount: "99", createdAt: "2026-02-11T10:00:00Z" }));

    const res = await dailyTotals(ctx.app, "c_1", "2026-02-09", "2026-02-11");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      { date: "2026-02-09", total: 0, gross: 0, discount: 0, net: 0 },
      { date: "2026-02-10", total: 1000, gross: 1000, discount: 0, net: 1000 },
      { date: "2026-02-11", total: 349, gross: 349, discount: 0, net: 349 },
    ]);
  });

  it("не учитывает pending и refunded", async () => {
    await postWebhook(ctx.app, apiOrder({ amount: 500 }));
    await postWebhook(ctx.app, apiOrder({ amount: 700, status: "pending" }));
    await postWebhook(ctx.app, apiOrder({ amount: 900, status: "refunded" }));
    const res = await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    expect(res.json()).toEqual([{ date: "2026-02-10", total: 500, gross: 500, discount: 0, net: 500 }]);
  });

  it("учитывает только заказы этого клиента", async () => {
    ctx.api.customers.set("c_2", "Asia/Novosibirsk");
    await postWebhook(ctx.app, apiOrder({ amount: 500 }));
    await postWebhook(ctx.app, apiOrder({ amount: 800, customerId: "c_2" }));
    const res = await dailyTotals(ctx.app, "c_2", "2026-02-10", "2026-02-10");
    expect(res.json()).toEqual([{ date: "2026-02-10", total: 800, gross: 800, discount: 0, net: 800 }]);
  });

  it("таймзона клиента берётся из API один раз", async () => {
    await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    ctx.api.customers.set("c_1", "UTC");
    await dailyTotals(ctx.app, "c_1", "2026-02-10", "2026-02-10");
    const { rows } = await ctx.db.query(`SELECT timezone FROM customers WHERE id = 'c_1'`);
    expect(rows[0].timezone).toBe("Europe/Moscow");
  });

  it("валидирует даты", async () => {
    expect((await dailyTotals(ctx.app, "c_1", "2026-02-30", "2026-03-01")).statusCode).toBe(400);
    expect((await dailyTotals(ctx.app, "c_1", "2026-03-02", "2026-03-01")).statusCode).toBe(400);
    expect((await dailyTotals(ctx.app, "c_1", "2026-99-99", "2026-03-01")).statusCode).toBe(400);
  });

  it("неизвестный клиент — 404", async () => {
    const res = await dailyTotals(ctx.app, "nobody", "2026-02-10", "2026-02-10");
    expect(res.statusCode).toBe(404);
  });
});
