-- NULL identifies rows imported before discount support. Until re-synced,
-- they retain the legacy assumption that the full amount was paid.
ALTER TABLE orders ADD COLUMN amount_paid_kop BIGINT;
ALTER TABLE orders ADD CONSTRAINT orders_amount_paid_valid
  CHECK (amount_paid_kop IS NULL OR (amount_paid_kop >= 0 AND amount_paid_kop <= amount_kop));
