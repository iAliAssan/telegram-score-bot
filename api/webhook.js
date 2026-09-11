// api/webhook.js
import { neon } from "@neondatabase/serverless";
import cfg from "../config.js";

/* ------------------------------------------------------------------ */
/*  ENV                                                                */
/* ------------------------------------------------------------------ */

const BOT_TOKEN    = process.env.BOT_TOKEN    || "";
const DATABASE_URL = process.env.DATABASE_URL || "";

/* ------------------------------------------------------------------ */
/*  Neon client (lazy)                                                 */
/* ------------------------------------------------------------------ */

let _sql = null;
function sql() {
  if (_sql) return _sql;
  if (!DATABASE_URL) throw new Error("DATABASE_URL is not set");
  _sql = neon(DATABASE_URL);
  return _sql;
}

/* ------------------------------------------------------------------ */
/*  Telegram API helper                                                */
/* ------------------------------------------------------------------ */

async function tg(method, payload) {
  if (!BOT_TOKEN) throw new Error("BOT_TOKEN is not set");
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {})
  });
  let data;
  try { data = await res.json(); }
  catch { data = { ok: false, description: "invalid-json" }; }
  if (!data.ok) {
    console.warn(`[tg] ${method} failed: ${data.description || res.status}`);
  }
  return data;
}

/* ------------------------------------------------------------------ */
/*  Text normalization & keyword matching                              */
/* ------------------------------------------------------------------ */

function normalizeText(text) {
  if (!text) return "";
  return String(text)
    // space-like → " "
    .replace(/[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000]/g, " ")
    // zero-width + directional marks → remove
    .replace(/[\u200C\u200D\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    // collapse whitespace
    .replace(/\s+/g, " ")
    .trim();
}

const NORMALIZED_KEYWORDS = cfg.keywords.map(normalizeText).filter(Boolean);

function matchesKeyword(text) {
  const t = normalizeText(text);
  if (!t) return null;
  for (const kw of NORMALIZED_KEYWORDS) {
    if (t.includes(kw)) return kw;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  HTML escape                                                        */
/* ------------------------------------------------------------------ */

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ------------------------------------------------------------------ */
/*  Dates (UTC)                                                        */
/* ------------------------------------------------------------------ */

function todayUTC() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function weekStartUTC() {
  const now = new Date();
  const dow = now.getUTCDay();               // 0=Sun..6=Sat
  const diff = dow === 0 ? 6 : dow - 1;      // Monday = start
  const mon = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - diff
  ));
  return mon.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/*  Bot username (cached per container)                                */
/* ------------------------------------------------------------------ */

let _botUsername = null;
async function getBotUsername() {
  if (_botUsername) return _botUsername;
  const r = await tg("getMe", {});
  if (r.ok && r.result?.username) _botUsername = r.result.username;
  return _botUsername || cfg.botUsername;
}

/* ------------------------------------------------------------------ */
/*  setMyCommands (once per container)                                 */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Display name                                                       */
/* ------------------------------------------------------------------ */

function displayName(from) {
  const parts = [from?.first_name, from?.last_name].filter(Boolean);
  if (parts.length) return parts.join(" ");
  if (from?.username) return "@" + from.username;
  return String(from?.id ?? "?");
}

/* ------------------------------------------------------------------ */
/*  Leaderboard rendering                                              */
/* ------------------------------------------------------------------ */

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
  return { daily, weekly };
}

/* ------------------------------------------------------------------ */
/*  Persistent leaderboard message                                     */
/* ------------------------------------------------------------------ */

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
  const { daily, weekly } = await fetchLeaderboardRows(chatId);
  const text = formatLeaderboard(daily, weekly);

  const db = sql();
  const existing = await db`
    SELECT message_id FROM leaderboards WHERE chat_id = ${chatId}
  `;

  if (existing.length === 0) {
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
  if (desc.includes("not modified")) return; // محتوای یکسان
  // پیام قبلی پاک شده یا قابل ویرایش نیست → ارسال جدید
  await sendAndStoreLeaderboard(chatId, text);
}

/* ------------------------------------------------------------------ */
/*  Commands                                                           */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Message handler                                                    */
/* ------------------------------------------------------------------ */

async function handleCommand(message) {
  const text = typeof message.text === "string" ? message.text : "";
  const chat = message.chat;
  const from = message.from;
  if (!chat || !from) return false;

  const first = text.split(/\s+/)[0] || "";
  const m = first.match(/^\/([^\s@]+)(?:@(\S+))?/);
  if (!m) return false;

  const cmd = m[1].toLowerCase();
  const target = m[2];

  // /cmd@OtherBot → ignore
  if (target) {
    const me = await getBotUsername();
    if (me && target.toLowerCase() !== me.toLowerCase()) return true;
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

async function handleMessage(message) {
  const chat = message.chat;
  const from = message.from;
  const text = typeof message.text === "string" ? message.text : "";

  if (!chat || !from) return;
  if (from.is_bot) return;

  // دستورات
  if (text.startsWith("/")) {
    const handled = await handleCommand(message);
    if (handled) return;
  }

  // امتیاز فقط در گروه / سوپرگروه
  if (chat.type !== "group" && chat.type !== "supergroup") return;
  if (!text) return;

  const kw = matchesKeyword(text);
  if (!kw) return;

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
  } catch (e) {
    console.error("[score] insert failed:", e?.message);
    return;
  }

  console.log(`[score] chat=${chat.id} user=${from.id} kw="${kw}"`);

  try {
    await updateLeaderboard(chat.id);
  } catch (e) {
    console.error("[leaderboard] update failed:", e?.message);
  }
}

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

/* ------------------------------------------------------------------ */
/*  Main webhook handler                                               */
/* ------------------------------------------------------------------ */

async function processUpdate(update) {
  if (!update || typeof update !== "object") return;

  // ---------- dedup ----------
  if (typeof update.update_id === "number") {
    const db = sql();
    const inserted = await db`
      INSERT INTO processed_updates (update_id)
      VALUES (${update.update_id})
      ON CONFLICT (update_id) DO NOTHING
      RETURNING update_id
    `;
    if (inserted.length === 0) {
      console.log(`[dedup] skip update_id=${update.update_id}`);
      return;
    }
  }

  // ---------- register commands (once/container) ----------
  try { await ensureCommands(); } catch (e) { console.error("[ensureCommands]", e?.message); }

  if (update.message)          return handleMessage(update.message);
  if (update.my_chat_member)   return handleMyChatMember(update.my_chat_member);
  // بقیه انواع Update نادیده گرفته می‌شوند
}

export default async function handler(req, res) {
  // health check
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true });
  }

  if (!BOT_TOKEN || !DATABASE_URL) {
    console.error("[env] BOT_TOKEN or DATABASE_URL missing");
    return res.status(200).json({ ok: true });
  }

  // parse body
  let update = null;
  try {
    update = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || null);
  } catch (e) {
    console.error("[body] JSON parse error:", e?.message);
    return res.status(200).json({ ok: true });
  }

  // IMPORTANT: await processing BEFORE returning.
  try {
    await processUpdate(update);
  } catch (e) {
    console.error("[process] fatal:", e?.message, e?.stack);
  }

  return res.status(200).json({ ok: true });
}
