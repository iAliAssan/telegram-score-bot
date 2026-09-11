CREATE TABLE IF NOT EXISTS public.daily_scores (
  chat_id    BIGINT      NOT NULL,
  user_id    BIGINT      NOT NULL,
  user_name  TEXT        NOT NULL,
  day        DATE        NOT NULL,
  score      INTEGER     NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chat_id, user_id, day)
);

CREATE INDEX IF NOT EXISTS daily_scores_chat_day_score_idx
  ON public.daily_scores (chat_id, day, score DESC);

CREATE INDEX IF NOT EXISTS daily_scores_chat_user_day_idx
  ON public.daily_scores (chat_id, user_id, day);

CREATE TABLE IF NOT EXISTS public.leaderboards (
  chat_id    BIGINT      PRIMARY KEY,
  message_id BIGINT      NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- processed_updates از قبل در دیتابیس شما وجود دارد؛
-- این دستور no-op است و هیچ داده‌ای را تغییر نمی‌دهد.
CREATE TABLE IF NOT EXISTS public.processed_updates (
  update_id    BIGINT      PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
