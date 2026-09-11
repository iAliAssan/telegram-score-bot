-- این فایل اختیاری است. کد api/webhook.js به‌صورت خودکار
-- این جداول را با CREATE TABLE IF NOT EXISTS می‌سازد.

CREATE TABLE IF NOT EXISTS public.daily_scores (
  chat_id   BIGINT  NOT NULL,
  user_id   BIGINT  NOT NULL,
  user_name TEXT    NOT NULL,
  day       DATE    NOT NULL,
  score     INTEGER NOT NULL DEFAULT 0,
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

-- توجه: public.processed_updates از قبل وجود دارد و توسط کد ساخته نمی‌شود.
