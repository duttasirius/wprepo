const express = require("express");
const cron = require("node-cron");
const readline = require("readline");
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

async function sendToAll(message) {
  // ✅ Wait for socket to be ready (max 30 seconds)
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
    "919832970480@s.whatsapp.net",
    "917908232980@s.whatsapp.net",
    "918777806094@s.whatsapp.net",
    "919547212244@s.whatsapp.net",
    "918515826746@s.whatsapp.net",
  ];

  for (const num of numbers) {
    try {
      await activeSock.sendMessage(num, { text: message });
      console.log("Sent to", num);
    } catch (err) {
      console.log("Failed sending to", num, err.message);
    }
  }
}

function registerCrons() {
  if (cronJobsRegistered) return;
  cronJobsRegistered = true;

  cron.schedule(
    "0 7 * * *",
    () => {
      console.log("Morning cron");
      sendToAll("🌞 Good Morning! Uthle naki? Bhalo ekta din hok! 😊");
    },
    { timezone: "Asia/Kolkata" },
  );

  cron.schedule(
    "0 14 * * *",
    () => {
      console.log("Lunch cron");
      sendToAll("🍽️ Kheyecho? Somoy moto kheye nio!");
    },
    { timezone: "Asia/Kolkata" },
  );

  cron.schedule(
    "0 18 * * *",
    () => {
      console.log("Tea cron");
      sendToAll("☕ Ki korcho? Cha khele? 😄");
    },
    { timezone: "Asia/Kolkata" },
  );

  cron.schedule(
    "0 22 * * *",
    () => {
      console.log("Dinner cron");
      sendToAll("🌙 Dinner korecho? Bhalo kore kheye nao!");
    },
    { timezone: "Asia/Kolkata" },
  );

  cron.schedule(
    "0 23 * * *",
    () => {
      console.log("11PM cron");
      sendToAll("🌙 ki korcho ?");
    },
    { timezone: "Asia/Kolkata" },
  );

  cron.schedule(
    "30 23 * * *",
    () => {
      console.log("Good Night cron");
      sendToAll("🌙 GOOD NIGHT ?");
    },
    { timezone: "Asia/Kolkata" },
  );

  cron.schedule(
    "0 0 * * *",
    () => {
      console.log("Midnight cron");
      sendToAll("🌙 Time to sleep Madam ji , SLEEP TIGHT !!!!!");
    },
    { timezone: "Asia/Kolkata" },
  );

  console.log("Crons registered ✅");
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    printQRInTerminal: false,
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
      activeSock = sock; // ✅ Only when fully connected
      console.log("WhatsApp connected ✅");
      registerCrons();
    }

    if (connection === "close") {
      activeSock = null;
      const shouldReconnect =
        lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output.statusCode !==
            DisconnectReason.loggedOut
          : true;

      console.log("Connection closed. Reconnecting:", shouldReconnect);
      if (shouldReconnect) {
        setTimeout(() => startBot(), 3000);
      }
    }
  });
}

startBot();
