-- Enable pg_trgm extension (built into Postgres, run once per database)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN indexes for fuzzy name search
CREATE INDEX IF NOT EXISTS idx_customers_name_norm_trgm
  ON customers USING GIN (customer_name_norm gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_connote_sender_trgm
  ON daily_connote USING GIN (sender gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_repair_jobs_customer_name_trgm
  ON repair_jobs USING GIN (customer_name gin_trgm_ops);
