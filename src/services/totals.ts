import type { OrdersRepository } from "../repositories/orders.js";
import { fromKop } from "../utils/money.js";
import { datesBetween } from "../utils/time.js";
import type { CustomersService } from "./customers.js";

export interface DailyTotal {
  date: string;
  total: number;
  gross: number;
  discount: number;
  net: number;
}

const DAY = 86_400_000;

export class TotalsService {
  constructor(
    private readonly orders: OrdersRepository,
    private readonly customers: CustomersService,
  ) {}

  /**
   * Сумма оплаченных заказов клиента по дням в его таймзоне, from..to включительно.
   * Дни без оплат — с нулём.
   */
  async daily(customerId: string, from: string, to: string): Promise<DailyTotal[]> {
    const timezone = await this.customers.timezone(customerId);
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    });

    // Смещения таймзон в пределах ±14 ч: берём с запасом в сутки с каждой стороны
    const rows = await this.orders.paidCreatedBetween(
      customerId,
      new Date(Date.parse(`${from}T00:00:00Z`) - DAY),
      new Date(Date.parse(`${to}T00:00:00Z`) + 2 * DAY),
    );

    const sums = new Map(datesBetween(from, to).map((d) => [d, { gross: 0, net: 0 }]));
    for (const o of rows) {
      const parts = formatter.formatToParts(o.createdAt);
      const part = (type: string) => parts.find((p) => p.type === type)!.value;
      const date = `${part("year")}-${part("month")}-${part("day")}`;
      const cur = sums.get(date);
      if (cur !== undefined) {
        cur.gross += o.amountKop;
        cur.net += o.amountPaidKop ?? o.amountKop;
      }
    }
    return [...sums].map(([date, { gross, net }]) => ({
      date, total: fromKop(gross), gross: fromKop(gross),
      discount: fromKop(gross - net), net: fromKop(net),
    }));
  }
}
