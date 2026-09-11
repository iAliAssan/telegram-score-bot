// config.js
// تمام متن‌ها و کلیدواژه‌های قابل تغییر اینجا هستند.
// هیچ Token یا Secretی نباید اینجا باشد.

export default {
  // دستورهای منوی Bot (setMyCommands)
  // توجه: Telegram فقط commandهای ASCII را در منو می‌پذیرد،
  // ولی نسخه‌های فارسی (/برترین /امتیاز) هم توسط کد پشتیبانی می‌شوند.
  commands: [
    { command: "tops",  description: "برترین‌های گروه" },
    { command: "score", description: "امتیاز من" }
  ],

  // کلیدواژه‌ها با فرم canonical (چسبیده، بدون فاصله، بدون ZWNJ).
  // ماژول webhook از canonical، دو فرم مشتق می‌سازد:
  //   spaced  = "ک م خ"  (حروف با فاصله معمولی)
  //   compact = "کمخ"
  // سپس هر دو فرم spaced و compact (و معادل‌هایشان با ZWNJ/NBSP)
  // در متن normalize شده چک می‌شوند.
  keywords: [
    { canonical: "کمخ",  points: 1 },
    { canonical: "کممخ", points: 1 }
  ],

  // امتیاز پیش‌فرض برای هر پیام (اگر points در keyword مشخص نشده باشد)
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
