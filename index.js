require("dotenv").config();
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcodeTerminal = require("qrcode-terminal");
const QRCode = require("qrcode");
const nodemailer = require("nodemailer");
const { execSync } = require("child_process");
const path = require("path");
const cron = require("node-cron");
const { getTodaysMenu } = require("./scraper");
const { checkForNewMenu: refreshBlavatnik } = require("./blavatnik");
const { checkForNewSchwarzmanMenu: refreshSchwarzman } = require("./schwarzman");

const GROUP_NAME = process.env.GROUP_NAME;
if (!GROUP_NAME) {
  console.error("ERROR: GROUP_NAME not set in .env");
  process.exit(1);
}

/**
 * Send an alert email to calebagoha@gmail.com when something goes wrong.
 */
async function sendAlert(subject, body) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return;
  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user, pass },
    });
    await transporter.sendMail({
      from: user,
      to: "calebagoha@gmail.com",
      subject: `[lunch-bot] ${subject}`,
      text: body,
    });
    console.log("Alert email sent.");
  } catch (err) {
    console.error("Failed to send alert email:", err.message);
  }
}

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    protocolTimeout: 300000,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
      "--no-zygote",
      "--disable-extensions",
    ],
  },
});

client.on("qr", async (qr) => {
  const qrPath = path.join(__dirname, "qr-code.png");
  await QRCode.toFile(qrPath, qr, { width: 400, margin: 2 });
  console.log(`QR code saved to: ${qrPath}`);
  console.log("Opening QR code image — scan it with WhatsApp (Linked Devices)...");
  try {
    execSync(`open "${qrPath}"`);
  } catch {
    qrcodeTerminal.generate(qr, { small: true });
  }
});

client.on("authenticated", () => {
  console.log("WhatsApp authenticated.");
});

client.on("auth_failure", async (msg) => {
  console.error("Authentication failed:", msg);
  await sendAlert("Authentication failed", `WhatsApp auth failed: ${msg}`);
});

client.on("disconnected", async (reason) => {
  console.error("WhatsApp disconnected:", reason);
  await sendAlert(
    "WhatsApp disconnected",
    `The lunch bot was disconnected from WhatsApp.\nReason: ${reason}\n\nPM2 will attempt to restart it. If it keeps failing, re-scan the QR code.`
  );
  process.exit(1);
});

const SEND_NOW = process.argv.includes("--send-now");

client.on("ready", async () => {
  console.log("WhatsApp client is ready!");

  if (SEND_NOW) {
    console.log("--send-now flag detected, sending menu immediately...");
    await sendMenuToGroup();
    process.exit(0);
  }

  startCronJob();
});

// On-demand: reply to "!menu" or "!refresh" in the target group
client.on("message", async (msg) => {
  const body = msg.body.trim();
  if (body !== "!menu" && body !== "!refresh") return;

  const chat = await msg.getChat();
  if (!chat.isGroup || chat.name !== GROUP_NAME) return;

  if (body === "!refresh") {
    console.log(`!refresh requested in "${chat.name}"`);
    await chat.sendMessage("Refreshing menus from Gmail...");
    try {
      await Promise.all([refreshBlavatnik(), refreshSchwarzman()]);
      await chat.sendMessage("Done! Menus refreshed. Send !menu to see the latest.");
    } catch (err) {
      console.error("Error refreshing menus:", err.message);
      await chat.sendMessage("Something went wrong refreshing the menus.");
    }
    return;
  }

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
    const group = chats.find((c) => c.isGroup && c.name === GROUP_NAME);

    if (!group) {
      const msg = `Group "${GROUP_NAME}" not found.`;
      console.error(msg);
      await sendAlert("Group not found", msg);
      return;
    }

    const menu = await getTodaysMenu();
    await group.sendMessage(menu);
    console.log(`Menu sent to "${GROUP_NAME}".`);
  } catch (err) {
    console.error("Error sending menu:", err.message);
    await sendAlert(
      "Failed to send menu",
      `The lunch bot failed to send today's menu.\n\nError: ${err.message}\n\nCheck PM2 logs: pm2 logs lunch-bot`
    );
  }
}

client.initialize();
