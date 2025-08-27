require("dotenv").config();
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");
const schedule = require("node-schedule");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is required in .env");
  process.exit(1);
}

// URLs
const BACKEND_BASE = "https://kiya-lotteryv1-5.onrender.com"; // Render backend
const FRONTEND_BASE = "https://kiya-lottery-v1-phcv.vercel.app"; // Vercel frontend

// Create bot instance in polling or webhook mode depending on env
const USE_WEBHOOK =
  (process.env.USE_WEBHOOK || "false").toLowerCase() === "true";
let bot;
let server = null;
if (USE_WEBHOOK) {
  bot = new TelegramBot(TOKEN);
} else {
  bot = new TelegramBot(TOKEN, { polling: true });
}

// Register visible bot commands
async function registerBotCommands() {
  try {
    await bot.setMyCommands([
      { command: "start", description: "Open MiniApp / get quick actions" },
      { command: "deposit", description: "Open deposit page" },
      { command: "withdraw", description: "Open withdraw page" },
      { command: "balance", description: "View wallet / balance" },
      { command: "todays_lotteries", description: "Show today's lotteries" },
      { command: "subscribe", description: "Subscribe to daily reminders" },
      { command: "unsubscribe", description: "Unsubscribe from reminders" },
      { command: "help", description: "Show help and commands" },
    ]);
  } catch (err) {}
}

// Data persistence (JSON file)
const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadUsers() {
  try {
    ensureDataDir();
    if (!fs.existsSync(USERS_FILE)) return new Map();
    const raw = fs.readFileSync(USERS_FILE, "utf8");
    const obj = JSON.parse(raw);
    return new Map(Object.entries(obj));
  } catch (err) {
    console.warn("Failed to load users, starting fresh:", err?.message || err);
    return new Map();
  }
}

function saveUsers(map) {
  try {
    ensureDataDir();
    const obj = Object.fromEntries(map);
    fs.writeFileSync(USERS_FILE, JSON.stringify(obj, null, 2), "utf8");
  } catch (err) {
    console.error("Failed to save users:", err?.message || err);
  }
}

const users = loadUsers();
const menus = new Map();
const REMINDERS = [
  "Hey there! Ever tried your luck with the Kiya Lottery? Today could be your lucky day!",
  "Don't miss out! Check out today's lotteries and maybe win big! 💰",
  "Feeling lucky? Play the Kiya Lottery today and turn your day around! ✨",
  "A small bet, a big dream. Join the Kiya Lottery now!",
  "Did you know? Your next ticket could be a winner! Play the Kiya Lottery today.",
  "Yes, it maybe a bad day, but if you win a lottery it'd be not. 😉 Play today!",
  "Your chance to win big is just a tap away! Explore today's lotteries.",
  "Don't let luck pass you by! Participate in the Kiya Lottery now.",
];

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Backend helpers
async function backendLinkTelegram(telegramId, username) {
  if (!BACKEND_BASE) return;
  try {
    await axios.post(`${BACKEND_BASE}/api/integrations/telegram/link`, {
      telegramId,
      username,
    });
  } catch (_) {}
}

async function backendSetSubscription(telegramId, subscribed) {
  if (!BACKEND_BASE) return;
  try {
    await axios.post(`${BACKEND_BASE}/api/integrations/telegram/subscription`, {
      telegramId,
      subscribed,
    });
  } catch (_) {}
}

// Register/unregister users
function registerUser(telegramUser, chatId) {
  if (!telegramUser || !telegramUser.id) return null;
  const userId = String(telegramUser.id);
  const prev = users.get(userId) || {};
  const record = {
    chatId,
    username: telegramUser.username || prev.username || null,
    subscribed: prev.subscribed !== undefined ? prev.subscribed : true,
  };
  users.set(userId, record);
  saveUsers(users);
  backendLinkTelegram(userId, record.username);
  return userId;
}

function unsubscribeUser(userId) {
  const rec = users.get(userId);
  if (!rec) return false;
  rec.subscribed = false;
  users.set(userId, rec);
  saveUsers(users);
  backendSetSubscription(userId, false);
  return true;
}

function subscribeUser(userId) {
  const rec = users.get(userId) || { chatId: null, username: null, subscribed: true };
  rec.subscribed = true;
  users.set(userId, rec);
  saveUsers(users);
  backendSetSubscription(userId, true);
  return true;
}

// Buttons
function makeInlineButton(url, text) {
  if (typeof url === "string" && url.startsWith("https://")) {
    return { text, web_app: { url } };
  }
  return { text, url };
}

function webAppButton(url, text) {
  return { reply_markup: { inline_keyboard: [[makeInlineButton(url, text)]] } };
}

function webAppButtons(buttons) {
  const keyboard = buttons.map((b) => [makeInlineButton(b.url, b.text)]);
  return { reply_markup: { inline_keyboard: keyboard } };
}

function coreButtonsFor(userId) {
  const deepLink = `${FRONTEND_BASE}/?userId=${encodeURIComponent(userId)}&action=handle_start`;
  return [
    { text: "Dashboard", url: deepLink },
    { text: "Deposit", url: `${FRONTEND_BASE}/deposit` },
    { text: "Wallet", url: `${FRONTEND_BASE}/wallet` },
    { text: "Withdraw", url: `${FRONTEND_BASE}/withdraw` },
    { text: "Lotteries", url: `${FRONTEND_BASE}/` },
  ];
}

async function ensureMenuForUser(userId) {
  const rec = users.get(userId);
  if (!rec || !rec.chatId) return;
  const chatId = rec.chatId;
  const buttons = coreButtonsFor(userId);
  const markup = webAppButtons(buttons).reply_markup;
  const existing = menus.get(userId);
  try {
    if (existing && existing.chatId === chatId && existing.messageId) {
      await bot.editMessageReplyMarkup(markup, {
        chat_id: chatId,
        message_id: existing.messageId,
      });
    } else {
      const sent = await bot.sendMessage(chatId, "Quick actions:", webAppButtons(buttons));
      menus.set(userId, { chatId, messageId: sent.message_id });
      try {
        await bot.pinChatMessage(chatId, sent.message_id);
      } catch (_) {}
    }
  } catch (_) {}
}

// Command handlers
bot.onText(/\/start(?:\s+(.*))?/, (msg) => {
  const chatId = msg.chat.id;
  const tgUser = msg.from;
  const userId = registerUser(tgUser, chatId);
  ensureMenuForUser(userId);
});

bot.onText(/\/deposit(?:\s+(.*))?/, (msg) => {
  const chatId = msg.chat.id;
  const tgUser = msg.from;
  registerUser(tgUser, chatId);
  bot.sendMessage(chatId, "Open deposit page:", webAppButton(`${FRONTEND_BASE}/deposit`, "Deposit"));
});

bot.onText(/\/balance(?:\s+(.*))?/, (msg) => {
  const chatId = msg.chat.id;
  const tgUser = msg.from;
  registerUser(tgUser, chatId);
  bot.sendMessage(chatId, "View your wallet:", webAppButton(`${FRONTEND_BASE}/wallet`, "Wallet"));
});

bot.onText(/\/todays_lotteries(?:\s+(.*))?/, (msg) => {
  const chatId = msg.chat.id;
  const tgUser = msg.from;
  registerUser(tgUser, chatId);
  bot.sendMessage(chatId, "Today's lotteries:", webAppButton(`${FRONTEND_BASE}/`, "Lotteries"));
});

bot.onText(/\/withdraw(?:\s+(.*))?/, (msg) => {
  const chatId = msg.chat.id;
  const tgUser = msg.from;
  registerUser(tgUser, chatId);
  bot.sendMessage(chatId, "Open withdraw page:", webAppButton(`${FRONTEND_BASE}/withdraw`, "Withdraw"));
});

bot.onText(/\/help(?:\s+(.*))?/, (msg) => {
  const chatId = msg.chat.id;
  const helpText = `Available commands:
/start - Open quick actions menu
/deposit - Open deposit page
/withdraw - Open withdraw page
/balance - View wallet/balance
/todays_lotteries - Open lotteries list
/subscribe - Subscribe to daily reminders
/unsubscribe - Unsubscribe from reminders
/help - Show this help message
`;
  bot.sendMessage(chatId, helpText);
  const userId = msg.from && msg.from.id ? String(msg.from.id) : null;
  if (userId) ensureMenuForUser(userId);
});

bot.onText(/\/unsubscribe(?:\s+(.*))?/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from && msg.from.id ? String(msg.from.id) : null;
  if (!userId) return bot.sendMessage(chatId, "Could not determine your user id.");
  const ok = unsubscribeUser(userId);
  bot.sendMessage(chatId, ok ? "You have been unsubscribed from reminders." : "You were not subscribed.");
});

bot.onText(/\/subscribe(?:\s+(.*))?/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from && msg.from.id ? String(msg.from.id) : null;
  if (!userId) return bot.sendMessage(chatId, "Could not determine your user id.");
  subscribeUser(userId);
  bot.sendMessage(chatId, "You have been subscribed to reminders.");
});

bot.on("message", (msg) => {
  if (!msg.from) return;
  if (msg.text && msg.text.startsWith("/")) return;
  registerUser(msg.from, msg.chat.id);
});

// Scheduled reminders
const TZ = process.env.REMINDER_TZ || undefined;
const DAILY_CRON = process.env.REMINDER_CRON || "0 9 * * *";

function sendReminders() {
  const message = pickRandom(REMINDERS);
  let count = 0;
  for (const [userId, rec] of users.entries()) {
    if (!rec.subscribed) continue;
    const chatId = rec.chatId;
    if (!chatId) continue;
    (async () => {
      try {
        await bot.sendMessage(chatId, message);
        count++;
      } catch (_) {}
    })();
  }
  console.log(`Triggered reminders; messages attempted to ${count} users. ${new Date().toISOString()}`);
}

schedule.scheduleJob({ cron: DAILY_CRON, tz: TZ }, sendReminders);

// Webhook server
if (USE_WEBHOOK) {
  const WEBHOOK_URL = process.env.WEBHOOK_URL;
  const WEBHOOK_PORT = process.env.PORT || 3000;
  if (!WEBHOOK_URL) {
    console.error("USE_WEBHOOK=true but WEBHOOK_URL not set in .env");
    process.exit(1);
  }
  const app = express();
  app.use(express.json());

  const hookPath = `/bot${TOKEN}`;
  app.post(hookPath, (req, res) => {
    try {
      bot.processUpdate(req.body);
    } catch (_) {}
    res.sendStatus(200);
  });

  server = app.listen(WEBHOOK_PORT, async () => {
    console.log(`Webhook server listening on port ${WEBHOOK_PORT}`);
    const fullUrl = `${WEBHOOK_URL}${hookPath}`;
    try {
      await bot.setWebHook(fullUrl);
      console.log(`Webhook registered at ${fullUrl}`);
      await registerBotCommands();
    } catch (_) {}
  });
} else {
  (async () => {
    await registerBotCommands();
  })();
}

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("Shutting down bot...");
  try {
    if (!USE_WEBHOOK) {
      await bot.stopPolling();
    } else if (server) {
      server.close();
      try {
        await bot.deleteWebHook();
      } catch (_) {}
    }
  } catch (_) {}
  process.exit(0);
});

console.log(`Telegram bot started (mode=${USE_WEBHOOK ? "webhook" : "polling"})`);
