import { z } from "zod";
import { ValidationError } from "../errors.js";
import type { Order, OrdersRepository } from "../repositories/orders.js";
import { parseRub, toKop } from "../utils/money.js";
import { parseUtc } from "../utils/time.js";

/** Заказ в формате внешнего API (поля, которые нам нужны; остальные игнорируем). */
const ExternalOrder = z.object({
  id: z.string().min(1),
  customerId: z.string().min(1),
  amount: z.union([z.number(), z.string()]),
  amountPaid: z.union([z.number(), z.string()]).optional(),
  discountPercent: z.union([z.number(), z.string()]).optional(),
  status: z.enum(["pending", "paid", "refunded"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ApplyResult = "created" | "updated" | "stale";

export class OrdersService {
  constructor(private readonly orders: OrdersRepository) {}

  normalize(raw: unknown): Order {
    const parsed = ExternalOrder.safeParse(raw);
    if (!parsed.success) throw new ValidationError(`invalid order: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
    const o = parsed.data;
    try {
      const amountKop = toKop(parseRub(o.amount));
      const discountPercent = o.discountPercent === undefined ? 0 : parseRub(o.discountPercent);
      if (discountPercent > 100) throw new Error("discountPercent must be between 0 and 100");
      if (o.amountPaid === undefined && discountPercent > 0) {
        throw new Error("amountPaid is required for discounted orders");
      }
      const amountPaidKop = o.amountPaid === undefined ? amountKop : toKop(parseRub(o.amountPaid));
      if (amountPaidKop > amountKop) throw new Error("amountPaid must not exceed amount");
      return {
        id: o.id,
        customerId: o.customerId,
        amountKop,
        amountPaidKop,
        status: o.status,
        createdAt: parseUtc(o.createdAt),
        updatedAt: parseUtc(o.updatedAt),
      };
    } catch (e) {
      throw new ValidationError((e as Error).message);
    }
  }

  /**
   * Применяет версию заказа (из синка или вебхука).
   * Вебхуки приходят с повторами и не по порядку, поэтому версию сохраняем,
   * только если она новее уже сохранённой (по updatedAt).
   * Исключение: заполнение amountPaid у мигрированной строки той же версии,
   * если все прежние поля совпадают. Проверка и запись атомарны в репозитории.
   */
  async apply(raw: unknown): Promise<ApplyResult> {
    const incoming = this.normalize(raw);
    // The version check belongs in the UPSERT so a concurrent sync/webhook
    // cannot overwrite a newer order after reading an older version.
    return this.orders.save(incoming);
  }
}
