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
/*  Database initialization (fast path + idempotent + race-safe)      */
/* ================================================================== */

let _dbInitPromise = null;

function ensureDatabase() {
  if (!_dbInitPromise) {
    _dbInitPromise = doInit().catch((err) => {
      _dbInitPromise = null;
      throw err;
    });
  }
  return _dbInitPromise;
}

async function doInit() {
  const sql = getSql();
  const t0 = Date.now();

  // ---------- Fast path ----------
  // اگر جداول از قبل ساخته شده‌اند، هیچ DDL ای اجرا نکن.
  // این تنها یک SELECT سبک روی information_schema است.
  try {
    const rows = await sql`
      SELECT
        (SELECT COUNT(*)::int FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = 'daily_scores') AS ds,
        (SELECT COUNT(*)::int FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = 'leaderboards') AS lb
    `;
    if (rows[0]?.ds > 0 && rows[0]?.lb > 0) {
      console.log(`[db-init] schema exists, skip DDL (${Date.now() - t0}ms)`);
      return;
    }
  } catch (e) {
    console.warn("[db-init] fast check failed, falling back to DDL:", e?.message);
  }

  // ---------- Slow path ----------
  console.log("[db-init] creating schema...");
  const t1 = Date.now();

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

  await sql`
    CREATE TABLE IF NOT EXISTS public.leaderboards (
      chat_id    BIGINT      PRIMARY KEY,
      message_id BIGINT      NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  // اگر جدول موجود باشد، no-op است و هیچ داده‌ای دست نمی‌خورد.
  await sql`
    CREATE TABLE IF NOT EXISTS public.processed_updates (
      update_id    BIGINT      PRIMARY KEY,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  console.log(`[db-init] schema created (${Date.now() - t1}ms)`);
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

function normalizeForMatch(input) {
  if (input == null) return "";
  return String(input)
    .replace(/\u0643/g, "\u06A9") // ك → ک
    .replace(/\u064A/g, "\u06CC") // ي → ی
    .replace(/[\u200B\u200C\u200D\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .replace(/[\s\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/g, " ")
    .trim();
}

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

function findKeyword(rawText) {
  const text = normalizeForMatch(rawText);
  if (!text) return null;
  for (const kw of NORMALIZED_KEYWORDS) {
    if (text.includes(kw.spaced) || text.includes(kw.compact)) return kw;
  }
  return null;
}

/* ================================================================== */
/*  Score message picker (per-container anti-repeat)                  */
/* ================================================================== */

let _lastScoreMsgIdx = -1;

function pickRandomScoreMessage() {
  const list = cfg.scoreMessages || [];
  const n = list.length;
  if (n === 0) return "";
  if (n === 1) return list[0];
  let idx;
  do {
    idx = Math.floor(Math.random() * n);
  } while (idx === _lastScoreMsgIdx);
  _lastScoreMsgIdx = idx;
  return list[idx];
}

function renderScoreMessage(template, vars) {
  return String(template)
    .replace(/\{user\}/g,    String(vars.user))
    .replace(/\{keyword\}/g, String(vars.keyword))
    .replace(/\{points\}/g,  String(vars.points))
    .replace(/\{score\}/g,   String(vars.score));
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
/*  Leaderboard formatting                                            */
/* ================================================================== */

const MEDALS = ["🥇", "🥈", "🥉"];

function formatLeaderboard(daily, weekly) {
  const T = cfg.texts;

  if (!daily.length && !weekly.length) {
    return [
      `<b>${esc(T.leaderboardTitle)}</b>`,
      ``,
      esc(T.noScores),
      `اولین امتیاز را ثبت کن. ✊`,
      ``,
      esc(T.emptyLeaderboardFooter)
    ].join("\n");
  }

  const lines = [`<b>${esc(T.leaderboardTitle)}</b>`, ``];
  lines.push(`<b>${esc(T.dailyTitle)}</b>`);
  if (!daily.length) {
    lines.push(esc(T.noScores));
  } else {
    daily.forEach((r, i) => {
      lines.push(`${MEDALS[i]} ${esc(r.user_name)} — ${r.score}`);
    });
  }

  lines.push(``, `━━━━━━━━━━━━`, ``);
  lines.push(`<b>${esc(T.weeklyTitle)}</b>`);
  if (!weekly.length) {
    lines.push(esc(T.noScores));
  } else {
    weekly.forEach((r, i) => {
      lines.push(`${MEDALS[i]} ${esc(r.user_name)} — ${r.score}`);
    });
  }

  lines.push(``, esc(T.leaderboardFooter));
  return lines.join("\n");
}

async function fetchLeaderboardRows(chatId) {
  const sql = getSql();
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
/*  /tops and /score replies                                          */
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

  const T = cfg.texts;
  const lines = [
    `<b>${esc(T.scoreTitle)}</b> ${esc(displayName(from))}`,
    ``,
    `${esc(T.scoreToday)}: <b>${today}</b>`,
    `${esc(T.scoreWeek)}: <b>${week}</b>`,
    `${esc(T.scoreTotal)}: <b>${total}</b>`,
    ``,
    esc(T.scoreFooter)
  ];
  const text = lines.join("\n");

  await tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_to_message_id: replyTo,
    allow_sending_without_reply: true,
    disable_web_page_preview: true
  });
}

/* ================================================================== */
/*  Commands                                                          */
/* ================================================================== */

async function handleCommand(message) {
  const text = typeof message.text === "string" ? message.text : "";
  const chat = message.chat;
  const from = message.from;
  if (!chat || !from) return false;

  const first = text.split(/\s+/)[0] || "";
  const m = first.match(/^\/([a-zA-Z0-9_\u0600-\u06FF]+)(?:@([a-zA-Z0-9_]+))?/);
  if (!m) return false;

  const cmd = m[1].toLowerCase();
  const target = m[2];

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

  // 1) commandها
  if (text.startsWith("/")) {
    try {
      const handled = await handleCommand(message);
      if (handled) return;
    } catch (e) {
      console.error("[command] failed:", e?.message);
      return;
    }
  }

  // 2) امتیاز فقط در گروه
  if (chat.type !== "group" && chat.type !== "supergroup") return;
  if (!text) return;

  // 3) یک‌بار ثبت commands کافی است؛ همین‌جا (نه در مسیر هر update)
  try { await ensureCommands(); }
  catch (e) { console.error("[commands]", e?.message); }

  // 4) keyword
  const kw = findKeyword(text);
  if (!kw) {
    console.log(
      `[score-skip] chat=${chat.id} user=${from.id} text="${text.slice(0, 40)}"`
    );
    return;
  }

  // 5) insert/upsert
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

  // 6) امتیاز فعلی کاربر در همین گروه
  let currentScore = 0;
  try {
    const totalRows = await sql`
      SELECT COALESCE(SUM(score), 0)::int AS score
      FROM public.daily_scores
      WHERE chat_id = ${chat.id} AND user_id = ${from.id}
    `;
    currentScore = totalRows[0]?.score ?? 0;
  } catch (e) {
    console.error("[score] read-back failed:", e?.message);
  }

  // 7) Reply به همان پیام کاربر
  try {
    const template = pickRandomScoreMessage();
    const body = renderScoreMessage(template, {
      user:    userName,
      keyword: kw.compact,
      points:  kw.points,
      score:   currentScore
    });
    await tg("sendMessage", {
      chat_id: chat.id,
      text: body,
      reply_to_message_id: message.message_id,
      allow_sending_without_reply: true,
      disable_web_page_preview: true
    });
  } catch (e) {
    console.error("[score-reply] failed:", e?.message);
  }

  // 8) leaderboard (non-critical)
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
/*  processUpdate (با fast-path برای /start خصوصی)                    */
/* ================================================================== */

async function processUpdate(update) {
  if (!update || typeof update !== "object") return;

  const msg = update.message;

  /* ---------- Fast path: private /start بدون هیچ DB ---------- */
  if (
    msg &&
    msg.chat?.type === "private" &&
    typeof msg.text === "string" &&
    /^\/start(\s|$|@)/i.test(msg.text)
  ) {
    const t0 = Date.now();
    try {
      await handleCommand(msg);
      console.log(`[start-private] replied in ${Date.now() - t0}ms`);
    } catch (e) {
      console.error("[start-private] failed:", e?.message);
    }
    return;
  }

  /* ---------- بقیه: DB لازم است ---------- */
  const tDb = Date.now();
  try {
    await ensureDatabase();
  } catch (e) {
    console.error("[db-init] failed:", e?.message);
  }
  console.log(`[db] ensured in ${Date.now() - tDb}ms`);

  // dedup
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

  // dispatch
  if (update.message) {
    await handleMessage(update.message);
    return;
  }
  if (update.my_chat_member) {
    await handleMyChatMember(update.my_chat_member);
    return;
  }
}

/* ================================================================== */
/*  HTTP handler                                                      */
/* ================================================================== */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, service: "telegram-score-bot" });
  }

  if (!BOT_TOKEN || !DATABASE_URL) {
    console.error("[webhook] missing env vars (BOT_TOKEN or DATABASE_URL)");
    return res.status(200).json({ ok: true });
  }

  let update = null;
  try {
    update = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || null);
  } catch (e) {
    console.error("[webhook] body parse error:", e?.message);
    return res.status(200).json({ ok: true });
  }

  if (!update) return res.status(200).json({ ok: true });

  try { logUpdate(update); }
  catch (e) { console.error("[logUpdate]", e?.message); }

  try {
    await processUpdate(update);
  } catch (e) {
    console.error("[webhook] fatal:", e?.message);
    if (e?.stack) console.error(e.stack);
  }

  return res.status(200).json({ ok: true });
}
