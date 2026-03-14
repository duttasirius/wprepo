const express = require("express");
const cron = require("node-cron");
const readline = require("readline");
const { MongoClient } = require("mongodb");
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const { useMongoDBAuthState } = require("./mongoAuthState");

const app = express();
app.get("/", (req, res) => res.send("Baileys WhatsApp Bot Running ✅"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));

let activeSock = null;
let cronJobsRegistered = false;
let reconnectAttempts = 0;

// ─── MongoDB — connected ONCE at startup, reused forever ─────────────────────
// ✅ FIX: connectMongo() is called once in main(), NOT inside startBot()
// Old code called connectMongo() inside startBot() → new connection on every
// reconnect → connection pool leak → bot crash after a few reconnects
let mongoCollection = null;
let metaCollection = null;

async function connectMongo() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("❌ MONGODB_URI env variable is not set!");
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db("whatsapp_bot");
  mongoCollection = db.collection("auth_state");
  metaCollection = db.collection("bot_meta");
  console.log("✅ MongoDB connected");
}

// ─── Last Sent Tracker ────────────────────────────────────────────────────────

async function loadLastSent() {
  try {
    const doc = await metaCollection.findOne({ _id: "last_sent" });
    return doc?.data || {};
  } catch {
    return {};
  }
}

async function saveLastSent(data) {
  try {
    await metaCollection.updateOne(
      { _id: "last_sent" },
      { $set: { data } },
      { upsert: true },
    );
  } catch (err) {
    console.log("Could not save last_sent:", err.message);
  }
}

// ─── Double Send Prevention ───────────────────────────────────────────────────

async function alreadySentToday(slot) {
  try {
    const doc = await metaCollection.findOne({ _id: "sent_today" });
    const today = new Date().toDateString();
    return doc?.data?.[slot] === today;
  } catch {
    return false;
  }
}

async function markSentToday(slot) {
  try {
    const today = new Date().toDateString();
    const doc = await metaCollection.findOne({ _id: "sent_today" });
    const data = doc?.data || {};
    data[slot] = today;
    await metaCollection.updateOne(
      { _id: "sent_today" },
      { $set: { data } },
      { upsert: true },
    );
  } catch (err) {
    console.log("Could not mark sent_today:", err.message);
  }
}

// ─── Message Pools (16 variations each) ──────────────────────────────────────

const messages = {
  morning: [
    "Good morning madam ji! 👀",
    "Good morning! ☀️",
    "Good morning! Have a pleasant day ahead 😄",
    "Ghum  holo thik thak ? Good morning!",
    "Good morning! Rise & shine 🌤️",
    "Morning! Have a great day 🙂",
    "Hey sunshine ☀️",
    "Morning! Hope you have a magnificent day ✨",
    "Good morning! plenty energy for survive summer 😄",
    "Good morning! Jai bajrangbali  ",
    " good morning  May Bajrangbali blessed your day 🌞",
    "Madam ji, have a great day ahead",
    "Suprovat madam  😊",
    "Have a maginificent morning accompanied by Bajranngbali 🌸",
    "Good morning! have a nice day ahead? ⚡",
    "Sleepyhead 😴 wake up, good morning!",
  ],
  lunch: [
    "dupure kheyecho",
    "lunch time! ki khaccho ajke? 👀",
    "lunch hoyeche ? 😄",
    "dupur hoye gelo… kheyecho toh?",
    "ajke ki ranna holo? curious 😋",
    "lunch miss korona madam ji 🙏",
    "khabar kheye nao ekhon, tarpor kaaj koro",
    "dupur belay ki korcho? kheyecho? 🍱",
    "bhat ghum combo plan ache? kheye nio 😄",
    "khaoa daoa holo ? ki khele? 😋",
    "kheyecho toh?  😑",
    "complete your lunch madam ji ",
    "lunch done ? 😄",
    "ki menu ajke lunch a ?? kheye nio timely",
    " kheyecho madam ji?",
    "dupure khele ? 😄",
  ],
  evening: [
    "ki obostha? ki kora hocche 😊",
    "din ta kemon gelo ajke?",
    "cha holo bikel bela? ☕",
    "ekhon ki korcho? 👀",
    "ajke hectic chilo naki chill? 😌",
    "ki kora hocche ? cha khele ?😄",
    "energy ache ekhono naki battery low? 😂",
    "cha khele ki korcho? ☕",
    "ajke din ta overall kemon gelo?",
    "ektu breathe nao, onek kaaj hoyeche nishchoi",
    "ki korcho  bikal belay ?",
    " cha & leisure time enjoy korcho  ? 🌇",
    "gaan shunchho naki with bevarage??  🎧",
    "ajke din ta smooth chilo toh ?",
    "take sufficent rest Madam ji with beverage  😌",
    "ki kora hocche?  😄",
  ],
  night: [
    "khaoa daoa korecho? sleep well 😴",
    "dinner hyache? have a pleasant night  👀",
    "ajke din ta kemon gelo overall? tata sweet dreams & complete your dinner ",
    "Have a great night, madam ji. Dinner ta complete kore nin 😄",
    "good night! kal abar kotha hobe 🌙",
    "rest nin properly madam ji  , kehey nio  ",
    "Khaoa hyache ? sleep well😊",
    "ajker dinner ta done ??😴",
    "Kheyecho to? Tahole ekhon rest nao 😴",
    "🌙 kheyecho ? rest nio sufficiently ",
    "good night! take care 🌙",
    " kheyecho ? ajker moto bye, rest nao 😌",
    "Dinner complete , madam ?? tata   ??",
    "good night! kal kotha hobe ,,kheyecho to ? ✨",
    "ajke kaaj sesh? rest koro ekhon & dinnner koro timely   ,   🌙",
    "Ghum dao… kal abar kotha hobe. Dinner ta kore nio 😄",
  ],
};

// ─── Utility Functions ────────────────────────────────────────────────────────

async function getRandomMessage(slot) {
  const lastSent = await loadLastSent();
  const pool = messages[slot];
  const lastMsg = lastSent[slot] || "";
  const filtered = pool.filter((m) => m !== lastMsg);
  const chosen = filtered[Math.floor(Math.random() * filtered.length)];
  lastSent[slot] = chosen;
  await saveLastSent(lastSent);
  return chosen;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function isWeekend() {
  const day = new Date().getDay();
  return day === 0 || day === 6;
}

function typingDuration(message) {
  return Math.min(Math.max(message.length * 50, 2000), 6000);
}

// ─── Ask Question (for pairing code) ─────────────────────────────────────────

function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) =>
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans.trim());
    }),
  );
}

// ─── Core Send Function ───────────────────────────────────────────────────────

async function sendToAll(message) {
  let retries = 0;
  while (!activeSock && retries < 10) {
    console.log(`Socket not ready, waiting... (${retries + 1}/10)`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    retries++;
  }

  if (!activeSock) {
    console.log("❌ Socket still not ready after 30s, skipping send.");
    return;
  }

  const numbers = [
    "918373089194@s.whatsapp.net",
    "919832143723@s.whatsapp.net",
    "918777806094@s.whatsapp.net",
    "918777276338@s.whatsapp.net",
    "918515826746@s.whatsapp.net",
    "918697265007@s.whatsapp.net",
    "917603044527@s.whatsapp.net",
    "919749923910@s.whatsapp.net",
    "919647983919@s.whatsapp.net",
  ];

  const shuffled = shuffle(numbers);
  const baseDelay = isWeekend() ? 12000 : 8000;
  const extraDelay = isWeekend() ? 10000 : 8000;

  for (const num of shuffled) {
    try {
      const perPersonDelay = Math.floor(Math.random() * extraDelay) + baseDelay;
      await new Promise((r) => setTimeout(r, perPersonDelay));
      await activeSock?.sendPresenceUpdate("composing", num);
      await new Promise((r) => setTimeout(r, typingDuration(message)));
      await activeSock?.sendPresenceUpdate("paused", num);
      await new Promise((r) =>
        setTimeout(r, Math.floor(Math.random() * 1000) + 500),
      );
      const variations = [
        message,
        message + " 🙂",
        message + " 😊",
        message + " 👀",
        message + "!",
        message + "!!",
        message + " 🙂🙂",
        message + " ",
        message + " ..",
        message + " 😄",
      ];

      const finalMsg =
        variations[Math.floor(Math.random() * variations.length)];

      await activeSock.sendMessage(num, { text: finalMsg });
      console.log(`✅ Sent to ${num}`);
    } catch (err) {
      console.log(`❌ Failed sending to ${num}:`, err.message);
    }
  }
}

// ─── 3-Cron Handler ───────────────────────────────────────────────────────────

function handleCron(label, slot, isLastCron = false) {
  return async () => {
    if (await alreadySentToday(slot)) {
      console.log(`${label}: Already sent today, skipping 🛡️`);
      return;
    }

    if (!isLastCron && Math.random() > 0.33) {
      console.log(`${label}: Passing to next cron window...`);
      return;
    }

    const msg = await getRandomMessage(slot);

    // ✅ Mark slot as claimed BEFORE waiting — blocks Cron-2/3 immediately
    await markSentToday(slot);

    console.log(`${label} preparing message: "${msg}"`);

    // random delay between 0–40 minutes
    const randomDelay = Math.floor(Math.random() * 2400000);

    console.log(
      `⏳ Waiting ${Math.floor(randomDelay / 60000)} minutes before sending...`,
    );

    await new Promise((resolve) => setTimeout(resolve, randomDelay));

    console.log(`${label} sending now`);

    await sendToAll(msg);

    console.log(`${label} ✅ All done!`);
  };
}

// ─── Register Crons ───────────────────────────────────────────────────────────

function registerCrons() {
  if (cronJobsRegistered) return;
  cronJobsRegistered = true;

  // 🌞 Morning — 7:00 / 7:05 / 7:10 AM IST
  cron.schedule("0 7 * * *", handleCron("Morning-1", "morning", false), {
    timezone: "Asia/Kolkata",
  });
  cron.schedule("5 7 * * *", handleCron("Morning-2", "morning", false), {
    timezone: "Asia/Kolkata",
  });
  cron.schedule("10 7 * * *", handleCron("Morning-3", "morning", true), {
    timezone: "Asia/Kolkata",
  });

  // 🍽️ Lunch — 1:00 / 1:05 / 1:10 PM IST
  cron.schedule("0 13 * * *", handleCron("Lunch-1", "lunch", false), {
    timezone: "Asia/Kolkata",
  });
  cron.schedule("5 13 * * *", handleCron("Lunch-2", "lunch", false), {
    timezone: "Asia/Kolkata",
  });
  cron.schedule("10 13 * * *", handleCron("Lunch-3", "lunch", true), {
    timezone: "Asia/Kolkata",
  });

  // 🌆 Evening — 6:30 / 6:35 / 6:40 PM IST
  cron.schedule("30 18 * * *", handleCron("Evening-1", "evening", false), {
    timezone: "Asia/Kolkata",
  });
  cron.schedule("35 18 * * *", handleCron("Evening-2", "evening", false), {
    timezone: "Asia/Kolkata",
  });
  cron.schedule("40 18 * * *", handleCron("Evening-3", "evening", true), {
    timezone: "Asia/Kolkata",
  });

  // 🌙 Night — 10:00 / 10:05 / 10:10 PM IST
  cron.schedule("0 23 * * *", handleCron("Night-1", "night", false), {
    timezone: "Asia/Kolkata",
  });
  cron.schedule("5 23 * * *", handleCron("Night-2", "night", false), {
    timezone: "Asia/Kolkata",
  });
  cron.schedule("10 23 * * *", handleCron("Night-3", "night", true), {
    timezone: "Asia/Kolkata",
  });

  console.log("✅ 12 crons registered (3 per slot)");
  console.log(
    "📅 Schedule: Morning 7AM | Lunch 2PM | Evening 6:30PM | Night 11PM (IST)",
  );
}

// ─── Online Presence Simulation ───────────────────────────────────────────────
let presenceSimulationStarted = false;

function startPresenceSimulation() {
  if (presenceSimulationStarted) return;
  presenceSimulationStarted = true;
  setInterval(
    async () => {
      if (!activeSock || Math.random() > 0.3) return;
      try {
        await activeSock.sendPresenceUpdate("available");
        console.log("👀 Presence: appeared online");
        const onlineTime = Math.floor(Math.random() * 60000) + 30000;
        setTimeout(async () => {
          try {
            await activeSock?.sendPresenceUpdate("unavailable");
            console.log("💤 Presence: went offline");
          } catch {}
        }, onlineTime);
      } catch {}
    },
    2 * 60 * 60 * 1000,
  );
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

process.on("SIGTERM", () => {
  console.log("SIGTERM received — shutting down gracefully 🛑");
  try {
    activeSock?.end();
  } catch {}
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("SIGINT received — shutting down gracefully 🛑");
  try {
    activeSock?.end();
  } catch {}
  process.exit(0);
});

// ─── Bot Start (reconnects reuse existing Mongo connection) ──────────────────

async function startBot() {
  // ✅ mongoCollection already set by main() — no new connection here
  const { state, saveCreds } = await useMongoDBAuthState(mongoCollection);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    printQRInTerminal: false,
    keepAliveIntervalMs: 30000,
  });

  sock.ev.on("creds.update", saveCreds);

  let pairingCodeRequested = false;

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !pairingCodeRequested) {
      pairingCodeRequested = true;
      let phoneNumber = process.env.WHATSAPP_NUMBER;
      if (!phoneNumber) {
        phoneNumber = await askQuestion(
          "Enter your WhatsApp number with country code: ",
        );
      }
      phoneNumber = phoneNumber.replace(/\D/g, "");
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        const formatted = code.match(/.{1,4}/g)?.join("-") ?? code;
        console.log(`\nPairing Code: ${formatted}\n`);
      } catch (err) {
        console.error("Failed to get pairing code:", err.message);
      }
    }

    if (connection === "open") {
      activeSock = sock;
      reconnectAttempts = 0;
      console.log("WhatsApp connected ✅");
      registerCrons();
      startPresenceSimulation();
    }

    if (connection === "close") {
      activeSock = null;
      const statusCode =
        lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output.statusCode
          : null;

      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(
        `Connection closed (code: ${statusCode}). Reconnect: ${shouldReconnect}`,
      );

      if (shouldReconnect) {
        reconnectAttempts++;
        const backoff = Math.min(
          3000 * Math.pow(2, reconnectAttempts - 1),
          60000,
        );
        console.log(
          `Reconnecting in ${backoff / 1000}s (attempt ${reconnectAttempts})`,
        );
        setTimeout(() => startBot(), backoff);
      } else {
        console.log("Logged out — not reconnecting. Re-scan QR to restart.");
      }
    }
  });
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────
// ✅ MongoDB connects ONCE here, then startBot() reuses the connection forever

async function main() {
  await connectMongo();
  await startBot();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
