const express = require("express");
const cron = require("node-cron");
const qrcode = require("qrcode-terminal");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");

const { Boom } = require("@hapi/boom");

const app = express();

/* Render keep-alive server */
app.get("/", (req, res) => {
  res.send("Baileys WhatsApp Bot Running ✅");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
  });

  sock.ev.on("creds.update", saveCreds);

  console.log("Bot started 🚀");

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    /* Show QR */
    if (qr) {
      console.log("Scan this QR with WhatsApp:");
      qrcode.generate(qr, { small: true });
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

  /* Scheduled messages */

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
