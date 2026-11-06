import type { Db } from "../db.js";

export interface Order {
  id: string;
  customerId: string;
  amountKop: number;
  amountPaidKop: number | null;
  status: "pending" | "paid" | "refunded";
  createdAt: Date;
  updatedAt: Date;
}

interface Row {
  id: string;
  customer_id: string;
  amount_kop: string;
  amount_paid_kop: string | null;
  status: Order["status"];
  created_at: Date;
  updated_at: Date;
}

const fromRow = (r: Row): Order => ({
  id: r.id,
  customerId: r.customer_id,
  amountKop: Number(r.amount_kop),
  amountPaidKop: r.amount_paid_kop === null ? null : Number(r.amount_paid_kop),
  status: r.status,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class OrdersRepository {
  constructor(private readonly db: Db) {}

  async get(id: string): Promise<Order | null> {
    const { rows } = await this.db.query<Row>(`SELECT * FROM orders WHERE id = $1`, [id]);
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async save(o: Order): Promise<"created" | "updated" | "stale"> {
    const { rows } = await this.db.query<{ inserted: boolean }>(
      `INSERT INTO orders (id, customer_id, amount_kop, status, created_at, updated_at, amount_paid_kop)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         customer_id = excluded.customer_id,
         amount_kop  = excluded.amount_kop,
         amount_paid_kop = excluded.amount_paid_kop,
         status      = excluded.status,
         created_at  = excluded.created_at,
         updated_at  = excluded.updated_at
       WHERE orders.updated_at < excluded.updated_at
          OR (orders.updated_at = excluded.updated_at AND orders.amount_paid_kop IS NULL
              AND excluded.amount_paid_kop IS NOT NULL
              AND orders.customer_id = excluded.customer_id
              AND orders.amount_kop = excluded.amount_kop
              AND orders.status = excluded.status
              AND orders.created_at = excluded.created_at)
       RETURNING (xmax = 0) AS inserted`,
      [o.id, o.customerId, o.amountKop, o.status, o.createdAt, o.updatedAt, o.amountPaidKop],
    );
    return rows.length === 0 ? "stale" : rows[0].inserted ? "created" : "updated";
  }

  /** Оплаченные заказы клиента, созданные в [from, to). */
  async paidCreatedBetween(customerId: string, from: Date, to: Date): Promise<Order[]> {
    const { rows } = await this.db.query<Row>(
      `SELECT * FROM orders
        WHERE customer_id = $1 AND status = 'paid' AND created_at >= $2 AND created_at < $3`,
      [customerId, from, to],
    );
    return rows.map(fromRow);
  }
}
