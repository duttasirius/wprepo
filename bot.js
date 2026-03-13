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

// ─── Double Send Prevention ───────────────────────────────────────────────────
// Tracks which slots have already been sent today — survives within the process
const sentToday = {};

function alreadySentToday(slot) {
  const today = new Date().toDateString();
  return sentToday[slot] === today;
}

function markSentToday(slot) {
  const today = new Date().toDateString();
  sentToday[slot] = today;
}

// ─── Message Pools (16 variations each) ──────────────────────────────────────

const messages = {
  morning: [
    // --- Original 8 ---
    "🌞 Good Morning! Uthle naki? Bhalo ekta din hok! 😊",
    "☀️ Shubho shokal! Aaj ke sundor din hobe inshallah! 🌸",
    "🌅 Morning! Cha kheyecho? Din ta valo kato! ☕",
    "😴 Uthechho toh? Bhalo kore breakfast koro aaj! 🥐",
    "🌻 Good Morning! Aaj ke din ta tomar hok! 💛",
    "🌤️ Subho shokal! Kemon acho? Fresh din shuru koro! 😄",
    "☕ Morning vibes! Have a great day ahead! 💙",
    "🌈 Notun din, notun energy! Bhalo theko aaj! 🌟",
    // --- New 8 ---
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
    // --- Original 8 ---
    "🍽️ Kheyecho? Somoy moto kheye nio!",
    "🍱 Lunch time! Bhat kheyecho naki bhule gecho? 😄",
    "😋 Dupur hoyeche! Ki khachho aaj? Valo kore kheyo!",
    "🍛 Khawa daowa thik moto korcho toh? Khiye nio! 🙏",
    "⏰ Lunch break! Shob kaaj bad diye ektu kheye nao!",
    "🥘 Dupur er shalam! Bhalo mota kheyo aaj! 😊",
    "🍜 Khabar time! Skip korona please, health first! 💚",
    "😅 Busy thakleo khabar khete bhule jeo na kintu!",
    // --- New 8 ---
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
    // --- Original 8 ---
    "🌆 Bikel hoyeche! Kemon gelo din ta? ☕",
    "🌇 Evening! Ektu rest nao, cha khao! 😊",
    "🌤️ Din ta kaemon katlo? Bhalo chhile toh? 💙",
    "😊 ki kora hocche Madam ji ",
    "🌸 Evening vibes! Ektu relax koro aaj! 🎵",
    "🍵 Cha er time! Ektu break nao, deserve korcho! ☕",
    "🌆 Bikel holo! Onek kaaj korecho? Ektu rest! 😌",
    "💆 Evening! Mind off koro ektu, relax mode on! 🎧",
    // --- New 8 ---
    "🌇 Bikel er cha ta kheyecho? Naki bhule gecho? ☕😄",
    "🌸 Din ta kaemon gelo Madam ji? Valo katlo toh? 💙",
    "😌 Onek busy din? Ekhon ektu breathe nao! 🍃",
    "🌆 Evening chill time! Phone rakho, cha khao, relax! 🫖",
    "💫 Aaj ke din ta kemon laglo? Share me with a cup of bevarage! 😊",
    "🌇 Shondhya holo! Kaaj shesh? Ektu rest toh dao nijer! 😌",
    "🎵 Evening mood! Favorite gaan shuno ektu, chill koro! 🎧",
    "🍵 Bikel 5ta mane mandatory cha break! Rules ache! 😄☕",
  ],
  night: [
    // --- Original 8 ---
    "🌙 Time to sleep! SLEEP TIGHT!!!! 😴",
    "😴 Shhuye poro ekhon! Kal abar notun din! 🌟",
    "🌙 Good Night Madam ji !! Valo ghum hok! 💤",
    "⭐ Ghum dao ekhon, shokale fresh feel korbe! 😊",
    "🌙 Good Night! Sleep Tight ✨",
    "😴 Late night? Shhuye poro! take sufficent rest 📵",
    "🌙 Raat hoyeche! Rest nao, kal fresh start! 💫",
    "⭐ Good Night! Bhalo ghum hok, kal dekha hobe! 🌙",
    // --- New 8 ---
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

// Pick random message, never repeat last sent for this slot
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

// Random offset ±15 minutes in ms
function randomOffsetMs() {
  return (Math.floor(Math.random() * 31) - 15) * 60 * 1000;
}

// Shuffle array — randomize recipient order each send
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Weekend check — longer delays on Sat/Sun
function isWeekend() {
  const day = new Date().getDay();
  return day === 0 || day === 6;
}

// Typing duration scales with message length (feels real)
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
    console.log("Socket still not ready after 30s, skipping send.");
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

  // ✅ Different order every time
  const shuffled = shuffle(numbers);

  // ✅ Weekends = lazier/slower delays
  const baseDelay = isWeekend() ? 12000 : 8000;
  const extraDelay = isWeekend() ? 10000 : 8000;

  for (const num of shuffled) {
    try {
      // Random gap between recipients
      const perPersonDelay = Math.floor(Math.random() * extraDelay) + baseDelay;
      await new Promise((r) => setTimeout(r, perPersonDelay));

      // Typing indicator with realistic duration
      await activeSock.sendPresenceUpdate("composing", num);
      await new Promise((r) => setTimeout(r, typingDuration(message)));
      await activeSock.sendPresenceUpdate("paused", num);

      // Small pause after typing stops
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

// ─── Schedule With Random Offset + Occasional Skip ───────────────────────────

function scheduleWithRandomOffset(label, slot) {
  return () => {
    // ✅ Double send prevention — skip if already sent today
    if (alreadySentToday(slot)) {
      console.log(`${label}: Already sent today, skipping duplicate 🛡️`);
      return;
    }

    // ✅ 10% chance to skip — humans forget sometimes
    if (Math.random() < 0.1) {
      console.log(`${label}: Randomly skipping today (human behaviour) 🙈`);
      return;
    }

    // ✅ Mark as sent immediately to block any duplicate cron fire
    markSentToday(slot);

    const offset = randomOffsetMs();
    const waitMs = offset + 15 * 60 * 1000;
    const mins = Math.round(waitMs / 60000);
    console.log(`${label} cron fired → sending in ~${mins} min`);

    setTimeout(async () => {
      const msg = getRandomMessage(slot);
      console.log(`${label} sending: "${msg}"`);
      await sendToAll(msg);
    }, waitMs);
  };
}

// ─── Register Crons (4 per day) ───────────────────────────────────────────────

function registerCrons() {
  if (cronJobsRegistered) return;
  cronJobsRegistered = true;

  // 🌞 Morning  ~ 7:00 AM  (fires 6:45, sends 6:45–7:15)
  cron.schedule("45 6 * * *", scheduleWithRandomOffset("Morning", "morning"), {
    timezone: "Asia/Kolkata",
  });

  // 🍽️ Lunch   ~ 1:00 PM  (fires 12:45, sends 12:45–1:15)
  cron.schedule("45 12 * * *", scheduleWithRandomOffset("Lunch", "lunch"), {
    timezone: "Asia/Kolkata",
  });

  // 🌆 Evening  ~ 5:00 PM  (fires 4:45, sends 4:45–5:15)
  cron.schedule("45 16 * * *", scheduleWithRandomOffset("Evening", "evening"), {
    timezone: "Asia/Kolkata",
  });

  // 🌙 Night    ~ 10:00 PM (fires 9:45, sends 9:45–10:15)
  cron.schedule("45 21 * * *", scheduleWithRandomOffset("Night", "night"), {
    timezone: "Asia/Kolkata",
  });

  console.log("✅ 4 crons registered with all safety features");
}

// ─── Feature 3: Simulate Random Online Presence ───────────────────────────────
// Appears online 30% of the time, every 2 hours — like a real person checking phone

function startPresenceSimulation() {
  setInterval(
    async () => {
      if (!activeSock || Math.random() > 0.3) return;
      try {
        await activeSock.sendPresenceUpdate("available");
        console.log("👀 Presence: appeared online");
        const onlineTime = Math.floor(Math.random() * 60000) + 30000; // 30s–90s online
        setTimeout(async () => {
          try {
            await activeSock?.sendPresenceUpdate("unavailable");
            console.log("💤 Presence: went offline");
          } catch {}
        }, onlineTime);
      } catch {}
    },
    2 * 60 * 60 * 1000,
  ); // every 2 hours
}

// ─── Feature 2: Graceful Shutdown on Render Restart ──────────────────────────

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
    keepAliveIntervalMs: 30000, // ✅ Ping every 30s to keep connection alive
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
      reconnectAttempts = 0; // ✅ Reset backoff counter on success
      console.log("WhatsApp connected ✅");
      registerCrons();
      startPresenceSimulation(); // ✅ Start random online presence
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
        // ✅ Exponential backoff: 3s → 6s → 12s → 24s → ... max 60s
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
