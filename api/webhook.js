// api/webhook.js
// مهم: @neondatabase/serverless فقط tagged-template را به‌عنوان API اصلی
// پشتیبانی می‌کند. هرگز sql.query(...) یا db.query(...) نوشته نشود.
import { neon } from "@neondatabase/serverless";
import cfg from "../config.js";

/* ================================================================== */
/*  ENV                                                               */
/* ================================================================== */

const BOT_TOKEN    = process.env.BOT_TOKEN    || "";
const DATABASE_URL = process.env.DATABASE_URL || "";

/* ================================================================== */
/*  Neon client (lazy, cached per container)                          */
/* ================================================================== */

let _sqlClient = null;
function getSql() {
  if (_sqlClient) return _sqlClient;
  if (!DATABASE_URL) throw new Error("DATABASE_URL is not set");
  _sqlClient = neon(DATABASE_URL);
  return _sqlClient;
}

/* ================================================================== */
/*  Database initialization (idempotent, race-safe, cached)           */
/* ================================================================== */

let _dbInitPromise = null;

function ensureDatabase() {
  if (!_dbInitPromise) {
    _dbInitPromise = doInit().catch((err) => {
      // اجازه بده درخواست بعدی دوباره تلاش کند
      _dbInitPromise = null;
      throw err;
    });
  }
  return _dbInitPromise;
}

async function doInit() {
  const sql = getSql();

  // --- daily_scores ---
  await sql`
    CREATE TABLE IF NOT EXISTS public.daily_scores (
      chat_id    BIGINT      NOT NULL,
      user_id    BIGINT      NOT NULL,
      user_name  TEXT        NOT NULL,
      day        DATE        NOT NULL,
      score      INTEGER     NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (chat_id, user_id, day)
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS daily_scores_chat_day_score_idx
      ON public.daily_scores (chat_id, day, score DESC)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS daily_scores_chat_user_day_idx
      ON public.daily_scores (chat_id, user_id, day)
  `;

  // --- leaderboards ---
  await sql`
    CREATE TABLE IF NOT EXISTS public.leaderboards (
      chat_id    BIGINT      PRIMARY KEY,
      message_id BIGINT      NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // --- processed_updates ---
  // کاربر گفته این جدول از قبل وجود دارد. با IF NOT EXISTS،
  // اگر موجود باشد no-op است و هیچ داده‌ای دست نمی‌خورد.
  await sql`
    CREATE TABLE IF NOT EXISTS public.processed_updates (
      update_id    BIGINT      PRIMARY KEY,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  console.log("[db-init] schema ready");
}

/* ================================================================== */
/*  Telegram API                                                      */
/* ================================================================== */

async function tg(method, payload) {
  if (!BOT_TOKEN) throw new Error("BOT_TOKEN is not set");
  let res;
  try {
    res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    });
  } catch (e) {
    console.error(`[tg] ${method} network error:`, e?.message);
    return { ok: false, description: "network-error" };
  }
  let data;
  try { data = await res.json(); }
  catch { data = { ok: false, description: "invalid-json" }; }
  if (!data.ok) {
    console.warn(`[tg] ${method} failed: ${data.description || res.status}`);
  }
  return data;
}

/* ================================================================== */
/*  Normalization & keyword matching                                  */
/* ================================================================== */

// normalizeForMatch:
//   1) ك عربی → ک فارسی، ي عربی → ی فارسی
//   2) حذف ZWNJ/ZWJ/ZWSP/LRM/RLM/BOM
//   3) تمام فاصله‌های Unicode (NBSP, thin space, ...) → space معمولی
//   4) collapse multiple spaces و trim
//
// نتیجه: "ک‌م‌خ" و "کمخ" هر دو → "کمخ"
//         "ک م خ" → "ک م خ" (بدون تغییر، چون space معمولی است)
//         "کم خ" → "کم خ" (space بین م و خ باقی می‌ماند)
function normalizeForMatch(input) {
  if (input == null) return "";
  return String(input)
    .replace(/\u0643/g, "\u06A9") // Arabic kaf → Persian kaf
    .replace(/\u064A/g, "\u06CC") // Arabic yeh → Persian yeh
    .replace(/[\u200B\u200C\u200D\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .replace(/[\s\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/g, " ")
    .trim();
}

// از config، فرم‌های spaced و compact را می‌سازیم.
const NORMALIZED_KEYWORDS = cfg.keywords
  .map((entry) => {
    const canonical = normalizeForMatch(entry.canonical ?? entry).replace(/\s+/g, "");
    if (!canonical) return null;
    return {
      compact: canonical,
      spaced:  canonical.split("").join(" "),
      points:  typeof entry.points === "number" ? entry.points : cfg.pointsPerMessage
    };
  })
  .filter(Boolean);

/**
 * اگر پیام شامل یکی از دو فرم spaced یا compact باشد، آن keyword را برمی‌گرداند.
 * منطق:
 *   - "ک م خ"  → spaced "ک م خ" match → ✓
 *   - "کمخ"    → compact "کمخ" match → ✓
 *   - "ک‌م‌خ"   → normalize → "کمخ" → compact match → ✓
 *   - "کم خ"   → نه spaced نه compact → ✗
 *   - "خ م ک"  → نه spaced نه compact → ✗
 *   - "کمح"    → نه spaced نه compact → ✗
 *   - "ک_م_خ"  → underscore حذف نمی‌شود، پس نه spaced نه compact → ✗
 *   - "ک م ک"  → نه spaced نه compact → ✗
 *   - "ک م م"  → نه spaced نه compact (keyword2 "ک م م خ" نیاز به خ دارد) → ✗
 */
function findKeyword(rawText) {
  const text = normalizeForMatch(rawText);
  if (!text) return null;
  for (const kw of NORMALIZED_KEYWORDS) {
    if (text.includes(kw.spaced) || text.includes(kw.compact)) {
      return kw;
    }
  }
  return null;
}

/* ================================================================== */
/*  Helpers                                                           */
/* ================================================================== */

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function weekStartUTC() {
  const now = new Date();
  const dow = now.getUTCDay();
  const diff = dow === 0 ? 6 : dow - 1;
  const d = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - diff
  ));
  return d.toISOString().slice(0, 10);
}

function displayName(from) {
  if (!from) return "?";
  const parts = [from.first_name, from.last_name].filter(Boolean);
  if (parts.length) return parts.join(" ");
  if (from.username) return "@" + from.username;
  return String(from.id);
}

/* ================================================================== */
/*  Bot metadata (cached per container)                               */
/* ================================================================== */

let _botUsername = null;
async function getBotUsername() {
  if (_botUsername) return _botUsername;
  try {
    const r = await tg("getMe", {});
    if (r.ok && r.result?.username) {
      _botUsername = r.result.username;
      return _botUsername;
    }
  } catch (e) {
    console.error("[getMe]", e?.message);
  }
  return cfg.botUsername;
}

let _commandsSet = false;
async function ensureCommands() {
  if (_commandsSet) return;
  try {
    const r = await tg("setMyCommands", { commands: cfg.commands });
    if (r.ok) _commandsSet = true;
  } catch (e) {
    console.error("[setMyCommands]", e?.message);
  }
}

/* ================================================================== */
/*  Leaderboard                                                       */
/* ================================================================== */

const MEDALS = ["🥇", "🥈", "🥉"];

function formatLeaderboard(daily, weekly) {
  let out = `<b>${esc(cfg.texts.leaderboardTitle)}</b>\n\n`;
  out += `<b>${esc(cfg.texts.dailyTitle)}</b>\n`;
  if (!daily.length) {
    out += esc(cfg.texts.noScores) + "\n";
  } else {
    daily.forEach((r, i) => {
      out += `${MEDALS[i]} ${esc(r.user_name)} — ${r.score}\n`;
    });
  }
  out += `\n<b>${esc(cfg.texts.weeklyTitle)}</b>\n`;
  if (!weekly.length) {
    out += esc(cfg.texts.noScores) + "\n";
  } else {
    weekly.forEach((r, i) => {
      out += `${MEDALS[i]} ${esc(r.user_name)} — ${r.score}\n`;
    });
  }
  return out.trim();
}

async function fetchLeaderboardRows(chatId) {
  const sql = getSql();
  // neon serverless نتیجه را مستقیماً Array برمی‌گرداند
  const daily = await sql`
    SELECT user_name, score
    FROM public.daily_scores
    WHERE chat_id = ${chatId}
      AND day = ${todayUTC()}::date
    ORDER BY score DESC, user_id ASC
    LIMIT 3
  `;
  const weekly = await sql`
    SELECT user_name, SUM(score)::int AS score
    FROM public.daily_scores
    WHERE chat_id = ${chatId}
      AND day >= ${weekStartUTC()}::date
    GROUP BY user_id, user_name
    ORDER BY score DESC, user_id ASC
    LIMIT 3
  `;
  return { daily, weekly };
}

async function sendAndStoreLeaderboard(chatId, text) {
  const r = await tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });
  if (!r.ok) return;
  const sql = getSql();
  await sql`
    INSERT INTO public.leaderboards (chat_id, message_id)
    VALUES (${chatId}, ${r.result.message_id})
    ON CONFLICT (chat_id) DO UPDATE
      SET message_id = EXCLUDED.message_id,
          updated_at = NOW()
  `;
}

async function updateLeaderboard(chatId) {
  let daily, weekly;
  try {
    ({ daily, weekly } = await fetchLeaderboardRows(chatId));
  } catch (e) {
    console.error("[leaderboard] fetch failed:", e?.message);
    return;
  }
  const text = formatLeaderboard(daily, weekly);

  const sql = getSql();
  let existing;
  try {
    existing = await sql`
      SELECT message_id FROM public.leaderboards WHERE chat_id = ${chatId}
    `;
  } catch (e) {
    console.error("[leaderboard] lookup failed:", e?.message);
    return;
  }

  if (!existing.length) {
    await sendAndStoreLeaderboard(chatId, text);
    return;
  }

  const messageId = existing[0].message_id;
  const r = await tg("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true
  });

  if (r.ok) return;

  const desc = String(r.description || "").toLowerCase();
  if (desc.includes("not modified")) return;

  if (
    desc.includes("message to edit not found") ||
    desc.includes("message can't be edited") ||
    desc.includes("message_id_invalid") ||
    desc.includes("chat not found")
  ) {
    await sendAndStoreLeaderboard(chatId, text);
    return;
  }

  console.warn(`[leaderboard] edit failed unexpectedly: ${r.description}`);
}

/* ================================================================== */
/*  Command handlers                                                  */
/* ================================================================== */

async function replyTops(chatId, replyTo) {
  const { daily, weekly } = await fetchLeaderboardRows(chatId);
  const text = formatLeaderboard(daily, weekly);
  await tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_to_message_id: replyTo,
    allow_sending_without_reply: true
  });
}

async function replyScore(chatId, from, replyTo) {
  const sql = getSql();
  const todayRows = await sql`
    SELECT score FROM public.daily_scores
    WHERE chat_id = ${chatId}
      AND user_id = ${from.id}
      AND day = ${todayUTC()}::date
  `;
  const weekRows = await sql`
    SELECT COALESCE(SUM(score), 0)::int AS score
    FROM public.daily_scores
    WHERE chat_id = ${chatId}
      AND user_id = ${from.id}
      AND day >= ${weekStartUTC()}::date
  `;
  const totalRows = await sql`
    SELECT COALESCE(SUM(score), 0)::int AS score
    FROM public.daily_scores
    WHERE chat_id = ${chatId}
      AND user_id = ${from.id}
  `;

  const today = todayRows[0]?.score ?? 0;
  const week  = weekRows[0]?.score  ?? 0;
  const total = totalRows[0]?.score ?? 0;

  const text =
    `<b>${esc(cfg.texts.scoreTitle)}</b> — ${esc(displayName(from))}\n` +
    `${esc(cfg.texts.scoreToday)}: <b>${today}</b>\n` +
    `${esc(cfg.texts.scoreWeek)}: <b>${week}</b>\n` +
    `${esc(cfg.texts.scoreTotal)}: <b>${total}</b>`;

  await tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_to_message_id: replyTo,
    allow_sending_without_reply: true
  });
}

async function handleCommand(message) {
  const text = typeof message.text === "string" ? message.text : "";
  const chat = message.chat;
  const from = message.from;
  if (!chat || !from) return false;

  const first = text.split(/\s+/)[0] || "";
  // پشتیبانی /cmd و /cmd@username و /برترین
  const m = first.match(/^\/([a-zA-Z0-9_\u0600-\u06FF]+)(?:@([a-zA-Z0-9_]+))?/);
  if (!m) return false;

  const cmd = m[1].toLowerCase();
  const target = m[2];

  // اگر @username برای بات دیگری است → ignore
  if (target) {
    const me = await getBotUsername();
    if (me && target.toLowerCase() !== me.toLowerCase()) {
      console.log(`[command] ignored for other bot: @${target}`);
      return true;
    }
  }

  /* ---------- /start ---------- */
  if (cmd === "start") {
    if (chat.type === "private") {
      const me = await getBotUsername();
      const url = `https://t.me/${me}?startgroup=true`;
      await tg("sendMessage", {
        chat_id: chat.id,
        text: cfg.texts.start,
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [[{ text: cfg.texts.addToGroup, url }]]
        }
      });
    } else if (chat.type === "group" || chat.type === "supergroup") {
      await tg("sendMessage", {
        chat_id: chat.id,
        text: cfg.texts.startInGroup,
        disable_web_page_preview: true
      });
    }
    return true;
  }

  /* ---------- /tops /top /برترین ---------- */
  if (cmd === "tops" || cmd === "top" || cmd === "برترین") {
    if (chat.type !== "group" && chat.type !== "supergroup") {
      await tg("sendMessage", { chat_id: chat.id, text: cfg.texts.notGroup });
      return true;
    }
    await replyTops(chat.id, message.message_id);
    return true;
  }

  /* ---------- /score /امتیاز ---------- */
  if (cmd === "score" || cmd === "امتیاز") {
    if (chat.type !== "group" && chat.type !== "supergroup") {
      await tg("sendMessage", { chat_id: chat.id, text: cfg.texts.notGroup });
      return true;
    }
    await replyScore(chat.id, from, message.message_id);
    return true;
  }

  return false;
}

/* ================================================================== */
/*  Message handler                                                   */
/* ================================================================== */

async function handleMessage(message) {
  const chat = message.chat;
  const from = message.from;
  if (!chat || !from) return;
  if (from.is_bot) return;

  const text = typeof message.text === "string" ? message.text : "";

  // 1) دستورات — هم private و هم گروه
  if (text.startsWith("/")) {
    try {
      const handled = await handleCommand(message);
      if (handled) return;
    } catch (e) {
      console.error("[command] failed:", e?.message);
      return;
    }
  }

  // 2) امتیاز فقط در گروه / سوپرگروه
  if (chat.type !== "group" && chat.type !== "supergroup") return;
  if (!text) return;

  // 3) keyword matching
  const kw = findKeyword(text);
  if (!kw) {
    console.log(
      `[score-skip] chat=${chat.id} user=${from.id} text="${text.slice(0, 40)}"`
    );
    return;
  }

  // 4) insert/upsert
  const sql = getSql();
  const userName = displayName(from);
  try {
    await sql`
      INSERT INTO public.daily_scores
        (chat_id, user_id, user_name, day, score)
      VALUES
        (${chat.id}, ${from.id}, ${userName}, ${todayUTC()}::date, ${kw.points})
      ON CONFLICT (chat_id, user_id, day)
      DO UPDATE SET
        score      = public.daily_scores.score + ${kw.points},
        user_name  = EXCLUDED.user_name,
        updated_at = NOW()
    `;
    console.log(
      `[score] +${kw.points} chat=${chat.id} user=${from.id} kw="${kw.compact}"`
    );
  } catch (e) {
    console.error("[score] insert failed:", e?.message);
    return;
  }

  // 5) leaderboard (non-critical)
  try {
    await updateLeaderboard(chat.id);
  } catch (e) {
    console.error("[leaderboard] update failed:", e?.message);
  }
}

/* ================================================================== */
/*  my_chat_member                                                    */
/* ================================================================== */

async function handleMyChatMember(upd) {
  const chat = upd.chat;
  if (!chat) return;
  if (chat.type !== "group" && chat.type !== "supergroup") return;

  const oldS = upd.old_chat_member?.status;
  const newS = upd.new_chat_member?.status;
  const wasOut = oldS === "left" || oldS === "kicked";
  const isIn   = newS === "member" || newS === "administrator";

  if (!(wasOut && isIn)) return;

  try {
    await tg("sendMessage", {
      chat_id: chat.id,
      text: cfg.texts.groupWelcome,
      disable_web_page_preview: true
    });
  } catch (e) {
    console.error("[welcome] failed:", e?.message);
  }

  try {
    await updateLeaderboard(chat.id);
  } catch (e) {
    console.error("[welcome-leaderboard] failed:", e?.message);
  }
}

/* ================================================================== */
/*  Logging                                                           */
/* ================================================================== */

function logUpdate(update) {
  const type =
    update.message ? "message" :
    update.my_chat_member ? "my_chat_member" :
    update.callback_query ? "callback_query" :
    update.edited_message ? "edited_message" :
    "other";

  const chatType =
    update.message?.chat?.type ||
    update.my_chat_member?.chat?.type ||
    null;

  const chatId =
    update.message?.chat?.id ||
    update.my_chat_member?.chat?.id ||
    null;

  const userId =
    update.message?.from?.id ||
    update.my_chat_member?.from?.id ||
    null;

  const text =
    typeof update.message?.text === "string"
      ? update.message.text.slice(0, 80)
      : undefined;

  console.log("[UPDATE]", JSON.stringify({
    update_id: update.update_id,
    type,
    chat_type: chatType,
    chat_id: chatId,
    user_id: userId,
    text
  }));
}

/* ================================================================== */
/*  processUpdate                                                     */
/* ================================================================== */

async function processUpdate(update) {
  if (!update || typeof update !== "object") return;

  // ---- 1) اطمینان از وجود جداول ----
  try {
    await ensureDatabase();
  } catch (e) {
    console.error("[db-init] failed:", e?.message);
    // ادامه می‌دهیم؛ ممکن است فقط یک DDL شکست خورده باشد
  }

  // ---- 2) dedup ----
  if (typeof update.update_id === "number") {
    try {
      const sql = getSql();
      const rows = await sql`
        INSERT INTO public.processed_updates (update_id)
        VALUES (${update.update_id})
        ON CONFLICT (update_id) DO NOTHING
        RETURNING update_id
      `;
      if (!rows || rows.length === 0) {
        console.log(`[dedup] skip update_id=${update.update_id}`);
        return;
      }
    } catch (e) {
      console.error("[dedup] insert failed (continuing):", e?.message);
    }
  }

  // ---- 3) register commands ----
  try { await ensureCommands(); }
  catch (e) { console.error("[commands]", e?.message); }

  // ---- 4) dispatch ----
  if (update.message) {
    await handleMessage(update.message);
    return;
  }
  if (update.my_chat_member) {
    await handleMyChatMember(update.my_chat_member);
    return;
  }
  // بقیه انواع Update نادیده گرفته می‌شوند
}

/* ================================================================== */
/*  HTTP handler                                                      */
/* ================================================================== */

export default async function handler(req, res) {
  // health check
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, service: "telegram-score-bot" });
  }

  if (!BOT_TOKEN || !DATABASE_URL) {
    console.error("[webhook] missing env vars (BOT_TOKEN or DATABASE_URL)");
    // 200 می‌دهیم تا Telegram retry بی‌فایده نکند
    return res.status(200).json({ ok: true });
  }

  // parse body
  let update = null;
  try {
    update = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || null);
  } catch (e) {
    console.error("[webhook] body parse error:", e?.message);
    return res.status(200).json({ ok: true });
  }

  if (!update) {
    return res.status(200).json({ ok: true });
  }

  try { logUpdate(update); }
  catch (e) { console.error("[logUpdate]", e?.message); }

  // IMPORTANT: پردازش را کامل await کن، سپس 200 برگردان.
  // حتی در صورت خطا، 200 برمی‌گردانیم تا Telegram retry نکند.
  try {
    await processUpdate(update);
  } catch (e) {
    console.error("[webhook] fatal:", e?.message);
    if (e?.stack) console.error(e.stack);
  }

  return res.status(200).json({ ok: true });
}
