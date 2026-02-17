require("dotenv").config();
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcodeTerminal = require("qrcode-terminal");
const QRCode = require("qrcode");
const { execSync } = require("child_process");
const path = require("path");
const cron = require("node-cron");
const { getTodaysMenu } = require("./scraper");

const GROUP_NAME = process.env.GROUP_NAME;
if (!GROUP_NAME) {
  console.error("ERROR: GROUP_NAME not set in .env");
  process.exit(1);
}

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true },
});

client.on("qr", async (qr) => {
  // Save QR as PNG image and open it
  const qrPath = path.join(__dirname, "qr-code.png");
  await QRCode.toFile(qrPath, qr, { width: 400, margin: 2 });
  console.log(`QR code saved to: ${qrPath}`);
  console.log("Opening QR code image — scan it with WhatsApp (Linked Devices)...");
  try {
    execSync(`open "${qrPath}"`);
  } catch {
    // Also print in terminal as fallback
    qrcodeTerminal.generate(qr, { small: true });
  }
});

client.on("authenticated", () => {
  console.log("WhatsApp authenticated.");
});

client.on("auth_failure", (msg) => {
  console.error("Authentication failed:", msg);
});

const SEND_NOW = process.argv.includes("--send-now");

client.on("ready", async () => {
  console.log("WhatsApp client is ready!");

  if (SEND_NOW) {
    console.log("--send-now flag detected, sending menu immediately...");
    await sendMenuToGroup();
  }

  startCronJob();
});

// On-demand: reply to "!menu" in the target group
client.on("message", async (msg) => {
  if (msg.body.trim() !== "!menu") return;

  const chat = await msg.getChat();
  if (!chat.isGroup || chat.name !== GROUP_NAME) return;

  console.log(`!menu requested in "${chat.name}"`);
  try {
    const menu = await getTodaysMenu();
    await chat.sendMessage(menu);
  } catch (err) {
    console.error("Error fetching menu:", err.message);
    await chat.sendMessage("Sorry, I couldn't fetch today's menu. Try again later.");
  }
});

/**
 * Schedule daily menu send at 11:00 AM, Monday–Friday.
 */
function startCronJob() {
  cron.schedule("0 11 * * 1-5", async () => {
    console.log("Cron triggered: sending daily menu...");
    await sendMenuToGroup();
  });
  console.log("Cron job scheduled: 11:00 AM Mon–Fri");
}

/**
 * Find the target group by name and send today's menu.
 */
async function sendMenuToGroup() {
  try {
    const chats = await client.getChats();
    const group = chats.find(
      (c) => c.isGroup && c.name === GROUP_NAME,
    );

    if (!group) {
      console.error(`Group "${GROUP_NAME}" not found.`);
      return;
    }

    const menu = await getTodaysMenu();
    await group.sendMessage(menu);
    console.log(`Menu sent to "${GROUP_NAME}".`);
  } catch (err) {
    console.error("Error sending menu:", err.message);
  }
}

client.initialize();
