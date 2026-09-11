export default {
  // هر کدام از این دو کلمه گفته شود، یک امتیاز می‌دهد.
  keywords: [
    "ک م خ",
    "ک م م خ"
  ],

  pointsPerMatch: 1,

  botStartText:
    "👋 سلام!\n\n" +
    "من بات امتیازدهی گروه هستم.\n" +
    "برای استفاده، من رو به گروهت اضافه کن 👇",

  addToGroupButton: "➕ افزودن بات به گروه",

  groupWelcomeText:
    "🤖 <b>بات فعال شد!</b>\n\n" +
    "کلمه‌های امتیازدهی:\n" +
    "🔹 <b>{keyword1}</b>\n" +
    "🔹 <b>{keyword2}</b>\n\n" +
    "هر بار یکی از این دو کلمه گفته شود، یک امتیاز ثبت می‌شود ⭐\n\n" +
    "🏆 برترین‌ها: <code>/tops</code>\n" +
    "👤 امتیاز شما: <code>/score</code>",

  scoreText:
    "👤 <b>{name}</b>\n\n" +
    "📅 امروز: <b>{daily}</b>\n" +
    "📆 این هفته: <b>{weekly}</b>\n" +
    "🏆 کل: <b>{total}</b>",

  leaderboardTitle: "🏆 <b>برترین‌های گروه</b>",
  dailyTitle: "📅 برترین‌های امروز",
  weeklyTitle: "📆 برترین‌های این هفته",

  noScoresText: "هنوز امتیازی ثبت نشده.",

  medals: ["🥇", "🥈", "🥉"],

  commands: {
    tops: ["/tops", "/top", "/برترین"],
    score: ["/score", "/امتیاز"]
  }
};
