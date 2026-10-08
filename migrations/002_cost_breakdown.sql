ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS cost_api_calls_micros BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost_input_micros BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost_cached_input_micros BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost_output_micros BIGINT NOT NULL DEFAULT 0;

UPDATE usage_events SET
  cost_api_calls_micros = api_calls::bigint * 1000,
  cost_input_micros = (input_tokens::bigint * 300000 + 999999) / 1000000,
  cost_cached_input_micros = (cached_input_tokens::bigint * 75000 + 999999) / 1000000,
  cost_output_micros = ((output_tokens + reasoning_tokens)::bigint * 2500000 + 999999) / 1000000;
