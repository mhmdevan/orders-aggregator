import { describe, expect, it } from "vitest";
import { apiOrder, postWebhook, setupTestApp } from "./helpers.js";

const ctx = setupTestApp();

describe("POST /webhooks/order", () => {
  it("updates payments and ignores older or duplicate discounts", async () => {
    const original = apiOrder({ amount: 627, discountPercent: 13, amountPaid: 545.49 });
    expect((await postWebhook(ctx.app, original)).json()).toEqual({ result: "created" });
    const fresh = { ...original, amountPaid: 500, updatedAt: "2026-02-11T00:00:00Z" };
    expect((await postWebhook(ctx.app, fresh)).json()).toEqual({ result: "updated" });
    expect((await postWebhook(ctx.app, original)).json()).toEqual({ result: "stale" });
    expect((await postWebhook(ctx.app, fresh)).json()).toEqual({ result: "stale" });
    const { rows } = await ctx.db.query(`SELECT amount_paid_kop FROM orders WHERE id = $1`, [original.id]);
    expect(Number(rows[0].amount_paid_kop)).toBe(50000);
  });

  it.each([
    { amountPaid: -1 }, { amountPaid: "" }, { amountPaid: null }, { amountPaid: "abc" },
    { amountPaid: 1001 }, { discountPercent: -1 }, { discountPercent: 101 },
    { discountPercent: "" }, { discountPercent: 10 }, { amountPaid: 1e20 },
  ])("rejects invalid discount data: %j", async (fields) => {
    expect((await postWebhook(ctx.app, apiOrder(fields))).statusCode).toBe(400);
    expect((await ctx.db.query(`SELECT count(*)::int AS n FROM orders`)).rows[0].n).toBe(0);
  });

  it("atomically keeps the newest version under concurrent delivery", async () => {
    const original = apiOrder({ amountPaid: 900 });
    const versions = [3, 1, 5, 2, 4, 5, 1, 3].map((day) => ({
      ...original, updatedAt: `2026-02-${10 + day}T00:00:00Z`, amountPaid: 900 - day,
    }));
    const responses = await Promise.all(versions.map((order) => postWebhook(ctx.app, order)));
    expect(responses.every((res) => res.statusCode === 200)).toBe(true);
    const { rows } = await ctx.db.query(`SELECT amount_paid_kop, updated_at FROM orders WHERE id = $1`, [original.id]);
    expect(Number(rows[0].amount_paid_kop)).toBe(89500);
    expect(rows[0].updated_at.toISOString()).toBe("2026-02-15T00:00:00.000Z");
  });

  it("backfills migrated rows at the same version without accepting older updates", async () => {
    const original = apiOrder({ amount: 627, amountPaid: 545.49, discountPercent: 13 });
    await ctx.db.query(
      `INSERT INTO orders (id, customer_id, amount_kop, status, created_at, updated_at)
       VALUES ($1, $2, 62700, $3, $4, $5)`,
      [original.id, original.customerId, original.status, original.createdAt, original.updatedAt],
    );
    expect((await postWebhook(ctx.app, { ...original, updatedAt: "2026-02-09T00:00:00Z" })).json()).toEqual({ result: "stale" });
    expect((await postWebhook(ctx.app, original)).json()).toEqual({ result: "updated" });
    expect((await postWebhook(ctx.app, original)).json()).toEqual({ result: "stale" });
    const { rows } = await ctx.db.query(`SELECT amount_paid_kop FROM orders WHERE id = $1`, [original.id]);
    expect(Number(rows[0].amount_paid_kop)).toBe(54549);
  });

  it("does not change conflicting order fields during same-version backfill", async () => {
    const original = apiOrder({ amount: 627, amountPaid: 545.49 });
    await ctx.db.query(
      `INSERT INTO orders (id, customer_id, amount_kop, status, created_at, updated_at)
       VALUES ($1, $2, 62700, $3, $4, $5)`,
      [original.id, original.customerId, original.status, original.createdAt, original.updatedAt],
    );
    expect((await postWebhook(ctx.app, { ...original, status: "refunded" })).json()).toEqual({ result: "stale" });
    const { rows } = await ctx.db.query(`SELECT status, amount_paid_kop FROM orders WHERE id = $1`, [original.id]);
    expect(rows[0]).toEqual({ status: "paid", amount_paid_kop: null });
  });

  it("создаёт заказ", async () => {
    const res = await postWebhook(ctx.app, apiOrder());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: "created" });
  });

  it("повтор того же события ничего не меняет", async () => {
    const o = apiOrder();
    await postWebhook(ctx.app, o);
    expect((await postWebhook(ctx.app, o)).json()).toEqual({ result: "stale" });
  });

  it("устаревшее событие после нового игнорируется", async () => {
    const o = apiOrder({ status: "paid", updatedAt: "2026-02-10T12:00:00Z" });
    await postWebhook(ctx.app, { ...o, status: "refunded", updatedAt: "2026-02-11T12:00:00Z" });
    expect((await postWebhook(ctx.app, o)).json()).toEqual({ result: "stale" });
    const { rows } = await ctx.db.query(`SELECT status FROM orders WHERE id = $1`, [o.id]);
    expect(rows[0].status).toBe("refunded");
  });

  it("новое событие обновляет заказ", async () => {
    const o = apiOrder({ status: "pending" });
    await postWebhook(ctx.app, o);
    const res = await postWebhook(ctx.app, { ...o, status: "paid", updatedAt: "2026-02-11T00:00:00Z" });
    expect(res.json()).toEqual({ result: "updated" });
  });

  it("невалидное тело — 400", async () => {
    const res = await postWebhook(ctx.app, { id: "x" });
    expect(res.statusCode).toBe(400);
  });
});
