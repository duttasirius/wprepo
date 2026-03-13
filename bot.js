const express = require("express");
const cron = require("node-cron");
const readline = require("readline");
const fs = require("fs");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");

const app = express();
app.get("/", (req, res) => res.send("Baileys WhatsApp Bot Running ✅"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));

let activeSock = null;
let cronJobsRegistered = false;
let reconnectAttempts = 0;

// ─── Last Sent Tracker (avoids repeating same message) ────────────────────────
const LAST_SENT_FILE = "./last_sent.json";

function loadLastSent() {
  try {
    if (fs.existsSync(LAST_SENT_FILE)) {
      return JSON.parse(fs.readFileSync(LAST_SENT_FILE, "utf8"));
    }
  } catch {}
  return {};
}

function saveLastSent(data) {
  try {
    fs.writeFileSync(LAST_SENT_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.log("Could not save last_sent:", err.message);
  }
}

// ─── Double Send Prevention (saved to FILE not RAM) ───────────────────────────
// ✅ KEY FIX: sentToday is now saved to a file
// Old code stored in RAM → Render restart wipes it → Cron 2/3 could duplicate
// New code saves to file → survives Render restarts → no duplicates ever
const SENT_TODAY_FILE = "./sent_today.json";

function loadSentToday() {
  try {
    if (fs.existsSync(SENT_TODAY_FILE)) {
      return JSON.parse(fs.readFileSync(SENT_TODAY_FILE, "utf8"));
    }
  } catch {}
  return {};
}

function saveSentToday(data) {
  try {
    fs.writeFileSync(SENT_TODAY_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.log("Could not save sent_today:", err.message);
  }
}

function alreadySentToday(slot) {
  const today = new Date().toDateString();
  const data = loadSentToday();
  return data[slot] === today;
}

function markSentToday(slot) {
  const today = new Date().toDateString();
  const data = loadSentToday();
  data[slot] = today;
  saveSentToday(data);
}

// ─── Message Pools (16 variations each) ──────────────────────────────────────

const messages = {
  morning: [
    "🌞 Good Morning! Uthle naki? Bhalo ekta din hok! 😊",
    "☀️ Shubho shokal! Aaj ke sundor din hobe inshallah! 🌸",
    "🌅 Morning! Cha kheyecho? Din ta valo kato! ☕",
    "😴 Uthechho toh? Bhalo kore breakfast koro aaj! 🥐",
    "🌻 Good Morning! Aaj ke din ta tomar hok! 💛",
    "🌤️ Subho shokal! Kemon acho? Fresh din shuru koro! 😄",
    "☕ Morning vibes! Have a great day ahead! 💙",
    "🌈 Notun din, notun energy! Bhalo theko aaj! 🌟",
    "🌞 Good Morning Madam ji! Breakfast korecho toh? 🥞",
    "☀️ Uthechho naki ekhono ghumachho? 😄 Uthte hobe!",
    "🌅 Shokal hoye geche! Aaj ke din ta bhalo jacche toh? 🌸",
    "🫖 Morning! Cha ta diye din shuru koro, energy ashbe! ⚡",
    "😊 Shubho shokal! Jai Bajrangbali 💫",
    "🌤️ Good Morning! Ready for the day? pleasent day ahead! 💪",
    "☀️ Notun shokaler notun shuru! Bhalo theko Madam ji! 🌻",
    "🌞 Rise & shine! Aaj ke din ta sundor hobe! 🌈",
  ],
  lunch: [
    "🍽️ Kheyecho? Somoy moto kheye nio!",
    "🍱 Lunch time! Bhat kheyecho naki bhule gecho? 😄",
    "😋 Dupur hoyeche! Ki khachho aaj? Valo kore kheyo!",
    "🍛 Khawa daowa thik moto korcho toh? Khiye nio! 🙏",
    "⏰ Lunch break! Shob kaaj bad diye ektu kheye nao!",
    "🥘 Dupur er shalam! Bhalo mota kheyo aaj! 😊",
    "🍜 Khabar time! Skip korona please, health first! 💚",
    "😅 Busy thakleo khabar khete bhule jeo na kintu!",
    "🍱 Dupur dupur! Madam ji khabar kheyecho toh? 👀",
    "🍛 Lunch skip korona , take care of your health 💚",
    "😋 Ki ranna hoyeche aaj? Valo kore khao! 🥘",
    "🍽️ Onek kaaj korecho, ekhon ektu kheye nao! Deserve korcho! 😊",
    "⏰ Dupur 1ta! Official lunch alarm 🔔 Khete jao ekhoni!",
    "🤭 Bhat & ki menu ? Jei hok, bhalo kore kheyo aaj!",
    "🍜 Madam ji reminder: khabar skip = bad mood. Kheye nao! 😄",
    "💚 Kheye properly 1ta vat ghum dio 🍽️",
  ],
  evening: [
    "🌆 Bikel hoyeche! Kemon gelo din ta? ☕",
    "🌇 Evening! Ektu rest nao, cha khao! 😊",
    "🌤️ Din ta kaemon katlo? Bhalo chhile toh? 💙",
    "😊 ki kora hocche Madam ji ",
    "🌸 Evening vibes! Ektu relax koro aaj! 🎵",
    "🍵 Cha er time! Ektu break nao, deserve korcho! ☕",
    "🌆 Bikel holo! Onek kaaj korecho? take rest! 😌",
    "💆 Evening! Mind off koro ektu, relax mode on! 🎧",
    "🌇 Bikel er cha ta kheyecho? Naki bhule gecho? ☕😄",
    "🌸 Din ta kaemon gelo Madam ji? Valo katlo toh? 💙",
    "😌 Onek busy din? Ekhon ektu breathe nao! 🍃",
    "🌆 Evening chill time!  cha khao, relax! 🫖",
    "💫 Aaj ke din ta kemon laglo? Share me with a cup of bevarage! 😊",
    "🌇 Shondhya holo! Kaaj shesh? take slightly rest ! 😌",
    "🎵 Evening mood! Favorite gaan shuno ektu, chill koro! 🎧",
    "🍵 Bikel 5ta mane mandatory cha break! && ki kora hocche ??! 😄☕",
  ],
  night: [
    "🌙 Time to sleep! SLEEP TIGHT!!!! 😴",
    "😴 Shhuye poro ekhon! Kal abar notun din! 🌟",
    "🌙 Good Night Madam ji !! Valo ghum hok! 💤",
    "⭐ Ghum dao ekhon, shokale fresh feel korbe! 😊",
    "🌙 Good Night! Sleep Tight ✨",
    "😴 Late night? Shhuye poro! take sufficent rest 📵",
    "🌙 Raat hoyeche! Rest nao, kal fresh start! 💫",
    "⭐ Good Night! Bhalo ghum hok, kal dekha hobe! 🌙",
    "🌙 Good night ! Kal abar katha hobe! 💤",
    "😴 Madam ji shhuye poro! Late night healthy na! 🙏",
    "⭐ Aaj ta valo gelo toh? Bhalo ghum hok! Good Night! 🌙",
    "🌟 Rest is important! Shhuye poro, shokale uthbe! ☀️",
    "🌙 Take proper rest so that dark circle dont appeared ! 💫",
    "😊 Good Night Madam ji! Sundor shopno dekhio aaj! 🌸",
    "💤 Sleep time! TATA 🌙",
    "🌟 Hectic day ? Now rest koro, 😴",
  ],
};

// ─── Utility Functions ────────────────────────────────────────────────────────

function getRandomMessage(slot) {
  const lastSent = loadLastSent();
  const pool = messages[slot];
  const lastMsg = lastSent[slot] || "";
  const filtered = pool.filter((m) => m !== lastMsg);
  const chosen = filtered[Math.floor(Math.random() * filtered.length)];
  lastSent[slot] = chosen;
  saveLastSent(lastSent);
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
    "919775115357@s.whatsapp.net",
    "918777806094@s.whatsapp.net",
    "919547212244@s.whatsapp.net",
    "918515826746@s.whatsapp.net",
    "918697265007@s.whatsapp.net",
    "917603044527@s.whatsapp.net",
    "919749923910@s.whatsapp.net",
  ];

  const shuffled = shuffle(numbers);
  const baseDelay = isWeekend() ? 12000 : 8000;
  const extraDelay = isWeekend() ? 10000 : 8000;

  for (const num of shuffled) {
    try {
      const perPersonDelay = Math.floor(Math.random() * extraDelay) + baseDelay;
      await new Promise((r) => setTimeout(r, perPersonDelay));

      await activeSock.sendPresenceUpdate("composing", num);
      await new Promise((r) => setTimeout(r, typingDuration(message)));
      await activeSock.sendPresenceUpdate("paused", num);

      await new Promise((r) =>
        setTimeout(r, Math.floor(Math.random() * 1000) + 500),
      );

      await activeSock.sendMessage(num, { text: message });
      console.log(`✅ Sent to ${num}`);
    } catch (err) {
      console.log(`❌ Failed sending to ${num}:`, err.message);
    }
  }
}

// ─── 3-Cron Handler ───────────────────────────────────────────────────────────
// Each slot has 3 crons (e.g. 5:00, 5:05, 5:10 PM)
// Cron 1 & 2 → 33% chance to send
// Cron 3 (isLastCron) → ALWAYS sends if others skipped
// sentToday saved to FILE → survives Render restarts → no duplicates ever

function handleCron(label, slot, isLastCron = false) {
  return async () => {
    // ✅ Check file — not RAM — so survives Render restarts
    if (alreadySentToday(slot)) {
      console.log(`${label}: Already sent today, skipping 🛡️`);
      return;
    }

    // ✅ Cron 1 & 2: 33% chance — Cron 3: always sends
    if (!isLastCron && Math.random() > 0.33) {
      console.log(`${label}: Passing to next cron window...`);
      return;
    }

    // ✅ Mark sent to FILE before sending — blocks duplicates even after restart
    markSentToday(slot);

    const msg = getRandomMessage(slot);
    console.log(`${label} sending: "${msg}"`);
    await sendToAll(msg);
    console.log(`${label} ✅ All done!`);
  };
}

// ─── Register Crons (3 per slot = 12 total) ───────────────────────────────────

function registerCrons() {
  if (cronJobsRegistered) return;
  cronJobsRegistered = true;

  // 🌞 Morning — 7:00 / 7:05 / 7:10 AM
  cron.schedule("0 7 * * *", handleCron("Morning-1", "morning", false), {
    timezone: "Asia/Kolkata",
  });
  cron.schedule("5 7 * * *", handleCron("Morning-2", "morning", false), {
    timezone: "Asia/Kolkata",
  });
  cron.schedule("10 7 * * *", handleCron("Morning-3", "morning", true), {
    timezone: "Asia/Kolkata",
  });

  // 🍽️ Lunch — 1:00 / 1:05 / 1:10 PM
  cron.schedule("0 13 * * *", handleCron("Lunch-1", "lunch", false), {
    timezone: "Asia/Kolkata",
  });
  cron.schedule("5 13 * * *", handleCron("Lunch-2", "lunch", false), {
    timezone: "Asia/Kolkata",
  });
  cron.schedule("10 13 * * *", handleCron("Lunch-3", "lunch", true), {
    timezone: "Asia/Kolkata",
  });

  // 🌆 Evening — 5:00 / 5:05 / 5:10 PM
  cron.schedule("0 17 * * *", handleCron("Evening-1", "evening", false), {
    timezone: "Asia/Kolkata",
  });
  cron.schedule("5 17 * * *", handleCron("Evening-2", "evening", false), {
    timezone: "Asia/Kolkata",
  });
  cron.schedule("10 17 * * *", handleCron("Evening-3", "evening", true), {
    timezone: "Asia/Kolkata",
  });

  // 🌙 Night — 10:00 / 10:05 / 10:10 PM
  cron.schedule("0 22 * * *", handleCron("Night-1", "night", false), {
    timezone: "Asia/Kolkata",
  });
  cron.schedule("5 22 * * *", handleCron("Night-2", "night", false), {
    timezone: "Asia/Kolkata",
  });
  cron.schedule("10 22 * * *", handleCron("Night-3", "night", true), {
    timezone: "Asia/Kolkata",
  });

  console.log(
    "✅ 12 crons registered (3 per slot) — guaranteed daily delivery",
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

// ─── Bot Start with Exponential Backoff ──────────────────────────────────────

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
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

startBot();
