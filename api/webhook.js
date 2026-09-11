// api/webhook.js
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

let _sql = null;
function sql() {
  if (_sql) return _sql;
  if (!DATABASE_URL) throw new Error("DATABASE_URL is not set");
  _sql = neon(DATABASE_URL);
  return _sql;
}

/* ================================================================== */
/*  Telegram API                                                      */
/* ================================================================== */

async function tg(method, payload) {
  if (!BOT_TOKEN) throw new Error("BOT_TOKEN is not set");
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {})
  });
  let data;
  try {
    data = await res.json();
  } catch {
    data = { ok: false, description: "invalid-json-from-telegram" };
  }
  if (!data.ok) {
    // هیچ توکنی log نمی‌شود، فقط description
    console.warn(`[tg] ${method} failed: ${data.description || res.status}`);
  }
  return data;
}

/* ================================================================== */
/*  Text normalization                                                */
/* ================================================================== */

function normalize(text) {
  if (text == null) return "";
  return String(text)
    // 1) حذف zero-width / bidi marks
    .replace(/[\u200B\u200C\u200D\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    // 2) تبدیل تمام فضای‌های Unicode به space معمولی
    .replace(/[\s\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/g, " ")
    // 3) یکسان‌سازی حروف عربی با فارسی (ک و ی)
    .replace(/\u0643/g, "\u06A9") // ك → ک
    .replace(/\u064A/g, "\u06CC") // ي → ی
    .trim();
}

const NORMALIZED_KEYWORDS = cfg.keywords
  .map((kw) => normalize(kw))
  .filter(Boolean)
  .map((spaced) => ({
    spaced,
    compact: spaced.replace(/ /g, "")
  }));

function matchesKeyword(text) {
  const n = normalize(text);
  if (!n) return null;
  const c = n.replace(/ /g, "");
  for (const kw of NORMALIZED_KEYWORDS) {
    if (n.includes(kw.spaced) || c.includes(kw.compact)) {
      return kw.spaced;
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
  const dow = now.getUTCDay();                // 0=Sun..6=Sat
  const diff = dow === 0 ? 6 : dow - 1;       // Monday = start
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
/*  Bot username / setMyCommands                                      */
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
  const db = sql();
  const daily = await db`
    SELECT user_name, score
    FROM daily_scores
    WHERE chat_id = ${chatId}
      AND day = ${todayUTC()}::date
    ORDER BY score DESC, user_id ASC
    LIMIT 3
  `;
  const weekly = await db`
    SELECT user_name, SUM(score)::int AS score
    FROM daily_scores
    WHERE chat_id = ${chatId}
      AND day >= ${weekStartUTC()}::date
    GROUP BY user_id, user_name
    ORDER BY score DESC, user_id ASC
    LIMIT 3
  `;
  // توجه: neon serverless نتیجه را مستقیماً Array برمی‌گرداند
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
  const db = sql();
  await db`
    INSERT INTO leaderboards (chat_id, message_id)
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

  const db = sql();
  let existing;
  try {
    existing = await db`
      SELECT message_id FROM leaderboards WHERE chat_id = ${chatId}
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

  // پیام حذف شده یا قابل ویرایش نیست → ارسال جدید
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
/*  Commands                                                          */
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
  const db = sql();
  const todayRows = await db`
    SELECT score FROM daily_scores
    WHERE chat_id = ${chatId}
      AND user_id = ${from.id}
      AND day = ${todayUTC()}::date
  `;
  const weekRows = await db`
    SELECT COALESCE(SUM(score), 0)::int AS score
    FROM daily_scores
    WHERE chat_id = ${chatId}
      AND user_id = ${from.id}
      AND day >= ${weekStartUTC()}::date
  `;
  const totalRows = await db`
    SELECT COALESCE(SUM(score), 0)::int AS score
    FROM daily_scores
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

/* ================================================================== */
/*  Command parsing                                                   */
/* ================================================================== */

async function handleCommand(message) {
  const text = typeof message.text === "string" ? message.text : "";
  const chat = message.chat;
  const from = message.from;
  if (!chat || !from) return false;

  // اولین توکن قبل از هر whitespace
  const first = text.split(/\s+/)[0] || "";
  // /cmd یا /cmd@username
  const m = first.match(/^\/([^\s@]+)(?:@(\S+))?$/);
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

  // 1) دستورات — هم در private و هم در گروه
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
  const kw = matchesKeyword(text);
  if (!kw) return;

  // 4) insert / upsert
  const db = sql();
  const userName = displayName(from);
  try {
    await db`
      INSERT INTO daily_scores (chat_id, user_id, user_name, day, score)
      VALUES (${chat.id}, ${from.id}, ${userName}, ${todayUTC()}::date, ${cfg.pointsPerMessage})
      ON CONFLICT (chat_id, user_id, day)
      DO UPDATE SET score     = daily_scores.score + ${cfg.pointsPerMessage},
                    user_name = EXCLUDED.user_name
    `;
    console.log(
      `[score] +${cfg.pointsPerMessage} chat=${chat.id} user=${from.id} kw="${kw}"`
    );
  } catch (e) {
    console.error("[score] insert failed:", e?.message);
    // اجازه بده به لایه‌ی بالا برسد تا dedup پاک شود و Telegram retry کند
    throw e;
  }

  // 5) leaderboard
  try {
    await updateLeaderboard(chat.id);
  } catch (e) {
    console.error("[leaderboard] update failed:", e?.message);
    // leaderboard خطا نگیرد کل update را retry نمی‌کنیم
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
/*  Logging helper                                                    */
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

  // ---- dedup ----
  // اگر insert موفق شد => پردازش
  // اگر conflict خورد => skip
  // در صورت خطا در ادامه، dedup پاک می‌شود تا Telegram retry کند.
  let insertedId = null;
  if (typeof update.update_id === "number") {
    try {
      const db = sql();
      const rows = await db`
        INSERT INTO processed_updates (update_id)
        VALUES (${update.update_id})
        ON CONFLICT (update_id) DO NOTHING
        RETURNING update_id
      `;
      if (rows.length === 0) {
        console.log(`[dedup] skip update_id=${update.update_id}`);
        return;
      }
      insertedId = update.update_id;
    } catch (e) {
      console.error("[dedup] insert failed:", e?.message);
      // بدون dedup ادامه نمی‌دهیم؛ اجازه بده Telegram retry کند
      throw e;
    }
  }

  try {
    // register commands (idempotent, per container)
    try { await ensureCommands(); }
    catch (e) { console.error("[ensureCommands]", e?.message); }

    if (update.message)        { await handleMessage(update.message);        return; }
    if (update.my_chat_member) { await handleMyChatMember(update.my_chat_member); return; }
    // بقیه انواع Update نادیده گرفته می‌شوند
  } catch (e) {
    // خطا → dedup را پاک کن تا Telegram retry کند
    if (insertedId != null) {
      try {
        const db = sql();
        await db`DELETE FROM processed_updates WHERE update_id = ${insertedId}`;
        console.warn(`[dedup] rolled back update_id=${insertedId}`);
      } catch (e2) {
        console.error("[dedup] rollback failed:", e2?.message);
      }
    }
    throw e;
  }
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
    console.error("[env] missing BOT_TOKEN or DATABASE_URL");
    // به Telegram بگو موفق بود تا retry بی‌فایده نکند
    return res.status(200).json({ ok: true });
  }

  // parse body (Vercel معمولاً object می‌دهد، ولی هر دو حالت را پوشش می‌دهیم)
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

  // Log
  try { logUpdate(update); } catch (e) { console.error("[logUpdate]", e?.message); }

  // IMPORTANT: پردازش را کامل await کن، بعد پاسخ بده
  try {
    await processUpdate(update);
  } catch (e) {
    console.error("[webhook] fatal:", e?.message, e?.stack);
    // 500 می‌دهیم تا Telegram retry کند (چون dedup هم rollback شده)
    return res.status(500).json({ ok: false });
  }

  return res.status(200).json({ ok: true });
}
