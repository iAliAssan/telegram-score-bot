import CONFIG from "../config.js";
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);

const TG = (method) => `https://api.telegram.org/bot${process.env.BOT_TOKEN}/${method}`;

async function tg(method, body = {}) {
  const res = await fetch(TG(method), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function userName(user) {
  return user.username
    ? `@${user.username}`
    : ([user.first_name, user.last_name].filter(Boolean).join(" ").trim() || "کاربر");
}

function dateKeys() {
  const now = new Date();
  const dayKey = now.toISOString().slice(0, 10);

  const d = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate()
  ));

  const weekday = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - weekday);

  const year = d.getUTCFullYear();
  const first = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((d - first) / 86400000) + 1) / 7);

  return {
    dayKey,
    weekKey: `${year}-W${String(week).padStart(2, "0")}`,
  };
}

async function ensureSchema() {
  await sql`
    CREATE TABLE IF NOT EXISTS groups (
      chat_id BIGINT PRIMARY KEY,
      leaderboard_message_id BIGINT
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS users (
      chat_id BIGINT NOT NULL,
      user_id BIGINT NOT NULL,
      name TEXT NOT NULL,
      daily_score INTEGER NOT NULL DEFAULT 0,
      weekly_score INTEGER NOT NULL DEFAULT 0,
      total_score INTEGER NOT NULL DEFAULT 0,
      day_key TEXT NOT NULL,
      week_key TEXT NOT NULL,
      PRIMARY KEY (chat_id, user_id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS processed_updates (
      update_id BIGINT PRIMARY KEY
    )
  `;
}

async function ensureGroup(chatId) {
  await sql`
    INSERT INTO groups (chat_id)
    VALUES (${chatId})
    ON CONFLICT (chat_id) DO NOTHING
  `;
}

async function addScore(chatId, user) {
  const { dayKey, weekKey } = dateKeys();
  const points = CONFIG.pointsPerMatch;
  const name = userName(user);

  await sql`
    INSERT INTO users (
      chat_id, user_id, name,
      daily_score, weekly_score, total_score,
      day_key, week_key
    )
    VALUES (
      ${chatId}, ${user.id}, ${name},
      ${points}, ${points}, ${points},
      ${dayKey}, ${weekKey}
    )
    ON CONFLICT (chat_id, user_id)
    DO UPDATE SET
      name = EXCLUDED.name,
      daily_score = CASE
        WHEN users.day_key = EXCLUDED.day_key
        THEN users.daily_score + ${points}
        ELSE ${points}
      END,
      weekly_score = CASE
        WHEN users.week_key = EXCLUDED.week_key
        THEN users.weekly_score + ${points}
        ELSE ${points}
      END,
      total_score = users.total_score + ${points},
      day_key = EXCLUDED.day_key,
      week_key = EXCLUDED.week_key
  `;
}

async function top(chatId, column) {
  const result = await sql.query(
    `SELECT name, ${column} AS score
     FROM users
     WHERE chat_id = $1 AND ${column} > 0
     ORDER BY ${column} DESC, user_id ASC
     LIMIT 3`,
    [chatId]
  );
  return result.rows;
}

function formatTop(rows, title) {
  if (!rows.length) return `${title}\n\n${CONFIG.noScoresText}`;

  return [
    title,
    "",
    ...rows.map((u, i) =>
      `${CONFIG.medals[i]} ${escapeHtml(u.name)} — <b>${u.score}</b>`
    ),
  ].join("\n");
}

async function leaderboard(chatId) {
  const daily = await top(chatId, "daily_score");
  const weekly = await top(chatId, "weekly_score");

  return [
    CONFIG.leaderboardTitle,
    "",
    formatTop(daily, CONFIG.dailyTitle),
    "",
    formatTop(weekly, CONFIG.weeklyTitle),
  ].join("\n");
}

async function updateLeaderboard(chatId) {
  await ensureGroup(chatId);

  const text = await leaderboard(chatId);

  const result = await sql`
    SELECT leaderboard_message_id
    FROM groups
    WHERE chat_id = ${chatId}
  `;

  const messageId = result[0]?.leaderboard_message_id;

  if (messageId) {
    const edited = await tg("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
    });

    if (edited.ok) return;
  }

  const sent = await tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
  });

  if (sent.ok) {
    await sql`
      UPDATE groups
      SET leaderboard_message_id = ${sent.result.message_id}
      WHERE chat_id = ${chatId}
    `;
  }
}

async function command(env, message) {
  const chatId = message.chat.id;
  const user = message.from;
  const commandName = (message.text || "")
    .trim()
    .split(/\s+/)[0]
    .split("@")[0]
    .toLowerCase();

  if (commandName === "/start") {
    if (message.chat.type !== "private") return;

    const bot = await tg("getMe");
    const username = bot.result?.username;

    await tg("sendMessage", {
      chat_id: chatId,
      text: CONFIG.botStartText,
      reply_markup: {
        inline_keyboard: [[{
          text: CONFIG.addToGroupButton,
          url: `https://t.me/${username}?startgroup=true`,
        }]],
      },
    });
    return;
  }

  if (CONFIG.commands.tops.includes(commandName)) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: await leaderboard(chatId),
      parse_mode: "HTML",
    });
    return;
  }

  if (CONFIG.commands.score.includes(commandName)) {
    const { dayKey, weekKey } = dateKeys();

    const result = await sql`
      SELECT *
      FROM users
      WHERE chat_id = ${chatId} AND user_id = ${user.id}
    `;

    const data = result.rows[0];
    const daily = data?.day_key === dayKey ? data.daily_score : 0;
    const weekly = data?.week_key === weekKey ? data.weekly_score : 0;
    const total = data?.total_score || 0;

    const text = CONFIG.scoreText
      .replaceAll("{name}", escapeHtml(userName(user)))
      .replaceAll("{daily}", daily)
      .replaceAll("{weekly}", weekly)
      .replaceAll("{total}", total);

    await tg("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
    });
  }
}

async function chatMember(update) {
  const change = update.my_chat_member;
  if (!change) return;

  const chat = change.chat;
  if (!["group", "supergroup"].includes(chat.type)) return;

  const status = change.new_chat_member?.status;
  if (!["member", "administrator"].includes(status)) return;

  await ensureGroup(chat.id);

  const text = CONFIG.groupWelcomeText.replace(
    "{keyword1}", escapeHtml(CONFIG.keywords[0])
  ).replace(
    "{keyword2}", escapeHtml(CONFIG.keywords[1])
  );

  await tg("sendMessage", {
    chat_id: chat.id,
    text,
    parse_mode: "HTML",
  });

  await updateLeaderboard(chat.id);
}

function containsKeyword(text, keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const regex = new RegExp(
    `(^|[\\s\\u200c\\u200d.,!?،؛:()\\[\\]{}"«»])` +
    escaped +
    `(?=$|[\\s\\u200c\\u200d.,!?،؛:()\\[\\]{}"«»])`,
    "iu"
  );

  return regex.test(text);
}

async function message(update) {
  const message = update.message;
  if (!message?.text) return;

  if (message.text.startsWith("/")) {
    await command(null, message);
    return;
  }

  if (!["group", "supergroup"].includes(message.chat.type)) return;
  if (message.from?.is_bot) return;

  const matched = CONFIG.keywords.some((keyword) =>
    containsKeyword(message.text, keyword)
  );

  if (!matched) return;

  await addScore(message.chat.id, message.from);
  await updateLeaderboard(message.chat.id);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("OK");
  }

  try {
    await ensureSchema();

    const update = req.body;

    if (update.update_id !== undefined) {
      const inserted = await sql`
        INSERT INTO processed_updates (update_id)
        VALUES (${update.update_id})
        ON CONFLICT (update_id) DO NOTHING
        RETURNING update_id
      `;

      if (!inserted.length) {
        return res.status(200).send("OK");
      }
    }

    if (update.my_chat_member) {
      await chatMember(update);
    }

    if (update.message) {
      await message(update);
    }

    return res.status(200).send("OK");
  } catch (error) {
    console.error(error);
    return res.status(200).send("OK");
  }
}
