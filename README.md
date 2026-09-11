# Telegram Score Bot (Vercel + Neon)

بات ساده ثبت امتیاز در گروه‌های تلگرام، روی Vercel Serverless Functions و Neon PostgreSQL.

## ویژگی‌ها
- ثبت امتیاز با دو عبارت: `ک م خ` و `ک م م خ`
- پشتیبانی از variantهای چسبیده (`کمخ`) و ZWNJ (`ک‌م‌خ`) و NBSP
- هر پیام حداکثر ۱ امتیاز
- امتیازها کاملاً per-group
- Leaderboard پایدار با `editMessageText`
- Top 3 روزانه و Top 3 هفتگی
- Dedup بر اساس `update_id`
- ساخت خودکار جداول در اولین اجرا (بدون نیاز به SQL Editor)

## Environment Variables (Vercel)
| Name           | Value                              |
|----------------|------------------------------------|
| `BOT_TOKEN`    | توکن از BotFather                  |
| `DATABASE_URL` | connection string از Neon          |

## Deploy روی Vercel
```bash
vercel --prod
