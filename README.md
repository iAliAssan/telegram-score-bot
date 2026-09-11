# Telegram Score Bot (Vercel + Neon)

بات ساده ثبت امتیاز در گروه‌های تلگرام روی Vercel Serverless و Neon PostgreSQL.

## ویژگی‌ها
- دو کلیدواژه: `ک م خ` و `ک م م خ`
- پشتیبانی از variantهای چسبیده (`کمخ`)، ZWNJ (`ک‌م‌خ`)، NBSP و Unicode spaces
- هر پیام حداکثر ۱ امتیاز
- امتیازها کاملاً per-group
- Leaderboard پایدار با `editMessageText`
- Top 3 امروز و این هفته
- Dedup با `update_id`
- ساخت خودکار جداول در اولین اجرا (بدون نیاز به SQL Editor)

## Environment Variables (Vercel)
| Name           | Value                              |
|----------------|------------------------------------|
| `BOT_TOKEN`    | توکن از BotFather                  |
| `DATABASE_URL` | connection string از Neon          |

هیچ‌کدام را داخل repo قرار ندهید.

## Deploy
```bash
vercel --prod
