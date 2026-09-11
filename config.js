// config.js
// تمام متن‌ها و کلیدواژه‌های قابل تغییر اینجا هستند.
// هیچ Token یا Secretی نباید اینجا باشد.

export default {
  // دستورهای منوی Bot (setMyCommands)
  // توجه: Telegram فقط commandهای ASCII را در منو می‌پذیرد.
  commands: [
    { command: "tops",  description: "برترین‌های گروه" },
    { command: "score", description: "امتیاز من" }
  ],

  // فقط همین دو عبارت معتبرند. فرم canonical (با فاصله‌ی معمولی).
  // normalizer بقیه‌ی variantها (بدون فاصله، ZWNJ، Unicode spaces) را
  // به این فرم تبدیل می‌کند.
  keywords: [
    "ک م خ",
    "ک م م خ"
  ],

  // امتیاز هر پیام
  pointsPerMessage: 1,

  // اگر getMe در دسترس نبود، این fallback استفاده می‌شود.
  botUsername: "kmkhscorebot",

  // Timezone (فعلاً فقط UTC پشتیبانی می‌شود تا ساده بماند)
  timezone: "UTC",

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
