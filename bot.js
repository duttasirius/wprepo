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

app.get("/", (req, res) => {
  res.send("Baileys WhatsApp Bot Running ✅");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

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

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    printQRInTerminal: false, // disable QR completely
  });

  sock.ev.on("creds.update", saveCreds);
  console.log("Bot started 🚀");

  let pairingCodeRequested = false;

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // When QR fires → intercept and use pairing code instead
    if (qr && !pairingCodeRequested) {
      pairingCodeRequested = true;

      let phoneNumber = process.env.WHATSAPP_NUMBER;

      if (!phoneNumber) {
        phoneNumber = await askQuestion(
          "Enter your WhatsApp number with country code (e.g. 916295094945): ",
        );
      }

      phoneNumber = phoneNumber.replace(/\D/g, "");
      console.log(`\nRequesting pairing code for +${phoneNumber} ...`);

      try {
        const code = await sock.requestPairingCode(phoneNumber);
        const formatted = code.match(/.{1,4}/g)?.join("-") ?? code;
        console.log("\n===========================================");
        console.log(`  Your Pairing Code: ${formatted}`);
        console.log("  Steps:");
        console.log("  1. Open WhatsApp on your phone");
        console.log("  2. Settings → Linked Devices");
        console.log("  3. Link a Device → Link with phone number");
        console.log(`  4. Enter code: ${formatted}`);
        console.log("===========================================\n");
      } catch (err) {
        console.error("Failed to get pairing code:", err.message);
      }
    }

    if (connection === "open") {
      console.log("WhatsApp connected ✅");
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output.statusCode !==
            DisconnectReason.loggedOut
          : true;

      console.log("Connection closed. Reconnecting:", shouldReconnect);
      if (shouldReconnect) startBot();
    }
  });

  const numbers = [
    "919832970480@s.whatsapp.net",
    "917908232980@s.whatsapp.net",
    "918777806094@s.whatsapp.net",
  ];

  async function sendToAll(message) {
    for (const num of numbers) {
      try {
        await sock.sendMessage(num, { text: message });
        console.log("Sent message to", num);
      } catch (err) {
        console.log("Failed sending to", num);
      }
    }
  }

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
}

startBot();
