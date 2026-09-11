-- امتیاز روزانه هر کاربر در هر گروه
CREATE TABLE IF NOT EXISTS daily_scores (
  chat_id   BIGINT  NOT NULL,
  user_id   BIGINT  NOT NULL,
  user_name TEXT    NOT NULL,
  day       DATE    NOT NULL,
  score     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, user_id, day)
);

CREATE INDEX IF NOT EXISTS daily_scores_chat_day_score_idx
  ON daily_scores (chat_id, day, score DESC);

CREATE INDEX IF NOT EXISTS daily_scores_chat_user_day_idx
  ON daily_scores (chat_id, user_id, day);

-- پیام Leaderboard پایدار هر گروه
CREATE TABLE IF NOT EXISTS leaderboards (
  chat_id    BIGINT      PRIMARY KEY,
  message_id BIGINT      NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- جلوگیری از پردازش تکراری Update
CREATE TABLE IF NOT EXISTS processed_updates (
  update_id  BIGINT      PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
