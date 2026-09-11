// config.js
// تمام متن‌ها و کلیدواژه‌های قابل تغییر اینجا هستند.
// هیچ Token یا Secretی نباید اینجا باشد.

export default {
  // دستورهای منوی Bot (setMyCommands)
  // توجه: Telegram فقط commandهای ASCII را در منو می‌پذیرد.
  // نسخه‌های فارسی (/برترین /امتیاز) توسط کد پشتیبانی می‌شوند
  // ولی در منوی خودکار Telegram نمایش داده نمی‌شوند.
  commands: [
    { command: "tops",  description: "برترین‌های گروه" },
    { command: "score", description: "امتیاز من" }
  ],

  // فرم canonical (با فاصله معمولی).
  // normalizer بقیه variantها (چسبیده، ZWNJ، NBSP، Unicode spaces) را
  // به این فرم تبدیل می‌کند.
  keywords: [
    "ک م خ",
    "ک م م خ"
  ],

  pointsPerMessage: 1,

  // fallback اگر getMe در دسترس نبود
  botUsername: "kmkhscorebot",

  texts: {
    start:
      "👋 سلام!\n" +
      "من بات امتیازدهی گروه هستم.\n" +
      "برای استفاده، من رو به گروهت اضافه کن 👇",
    addToGroup: "➕ افزودن بات به گروه",
    groupWelcome:
      "✅ بات به گروه اضافه شد.\n" +
      "از این پس پیام‌های دارای عبارت‌های تعیین‌شده امتیاز می‌گیرند.",
    startInGroup:
      "🤖 بات آماده است.\n" +
      "برای مشاهده‌ی برترین‌ها: /tops\n" +
      "برای مشاهده‌ی امتیاز خودتان: /score",
    leaderboardTitle: "🏆 برترین‌های گروه",
    dailyTitle: "📅 برترین‌های امروز",
    weeklyTitle: "📆 برترین‌های این هفته",
    noScores: "هنوز امتیازی ثبت نشده است.",
    scoreTitle: "📊 امتیاز شما",
    scoreToday: "امروز",
    scoreWeek: "این هفته",
    scoreTotal: "مجموع",
    notGroup: "این دستور فقط در گروه کار می‌کند."
  }
};
