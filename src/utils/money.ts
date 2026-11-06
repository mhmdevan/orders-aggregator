/**
 * Деньги внутри сервиса — целые копейки. Рубли — только на входе (внешний API) и в ответах.
 */

/** Сумма из внешнего API: число или строка с числом ("250.10"). */
export function parseRub(raw: unknown): number {
  if (typeof raw === "string" && !/^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw.trim())) {
    throw new Error(`invalid amount: ${JSON.stringify(raw)}`);
  }
  const value = typeof raw === "string" ? Number(raw.trim()) : raw;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`invalid amount: ${JSON.stringify(raw)}`);
  }
  return value;
}

/** Decimal conversion avoids losing a kopeck to binary floats (e.g. 545.49 * 100).
 * Preserve the existing policy: truncate actual fractions of a kopeck.
 */
export function toKop(rub: number): number {
  if (!Number.isFinite(rub) || rub < 0) throw new Error("invalid amount");
  const [mantissa, exponent = "0"] = rub.toString().toLowerCase().split("e");
  const fractionDigits = mantissa.split(".")[1]?.length ?? 0;
  const digits = BigInt(mantissa.replace(".", ""));
  const shift = Number(exponent) - fractionDigits + 2;
  const kop = shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift);
  const result = Number(kop);
  if (!Number.isSafeInteger(result)) throw new Error("amount exceeds safe integer range");
  return result;
}

/** Копейки → рубли для ответа API. */
export function fromKop(kop: number): number {
  if (!Number.isSafeInteger(kop)) throw new Error("amount exceeds safe integer range");
  return kop / 100;
}
