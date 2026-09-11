// config.js
// تمام متن‌ها و کلیدواژه‌های قابل تغییر اینجا هستند.
// هیچ توکن یا Secretی در این فایل نگذارید.

export default {
  // دستورهای منوی بات (setMyCommands)
  commands: [
    { command: "tops",  description: "برترین‌های گروه" },
    { command: "score", description: "امتیاز من" }
  ],

  // فقط همین دو عبارت معتبرند
  keywords: [
    "ک م خ",
    "ک م م خ"
  ],

  // امتیاز هر پیام
  pointsPerMessage: 1,

  // یوزرنیم پیش‌فرض (اگر getMe در دسترس نبود)
  botUsername: "kmkhscorebot",

  texts: {
    start:
      "سلام 👋\n" +
      "من بات ثبت امتیاز در گروه هستم.\n" +
      "برای استفاده، مرا به گروه اضافه کنید.",
    addToGroup: "➕ افزودن بات به گروه",
    groupWelcome:
      "✅ بات به گروه اضافه شد.\n" +
      "از این پس پیام‌های دارای عبارت‌های تعیین‌شده امتیاز می‌گیرند.",
    leaderboardTitle: "🏆 برترین‌های گروه",
    dailyTitle: "📅 برترین‌های امروز",
    weeklyTitle: "📆 برترین‌های این هفته",
    noScores: "هنوز امتیازی ثبت نشده است.",
    scoreTitle: "📊 امتیاز شما",
    scoreToday: "امروز",
    scoreWeek: "این هفته",
    scoreTotal: "مجموع",
    notGroup: "این دستور فقط در گروه‌ها کار می‌کند."
  }
};
