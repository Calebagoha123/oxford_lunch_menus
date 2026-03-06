require("dotenv").config();
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

const SEND_NOW = process.argv.includes("--send-now");

let sock;
let groupJid = null;
let cronStarted = false;

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

async function cacheGroupJid() {
  try {
    const groups = await sock.groupFetchAllParticipating();
    const group = Object.values(groups).find((g) => g.subject === GROUP_NAME);
    if (group) {
      groupJid = group.id;
      console.log(`Group "${GROUP_NAME}" found.`);
    } else {
      console.error(`Group "${GROUP_NAME}" not found.`);
    }
  } catch (err) {
    console.error("Error fetching groups:", err.message);
  }
}

async function sendMenuToGroup() {
  try {
    if (!groupJid) await cacheGroupJid();
    if (!groupJid) {
      const msg = `Group "${GROUP_NAME}" not found.`;
      console.error(msg);
      await sendAlert("Group not found", msg);
      return;
    }
    const menu = await getTodaysMenu();
    await sock.sendMessage(groupJid, { text: menu });
    console.log(`Menu sent to "${GROUP_NAME}".`);
  } catch (err) {
    console.error("Error sending menu:", err.message);
    await sendAlert(
      "Failed to send menu",
      `The lunch bot failed to send today's menu.\n\nError: ${err.message}\n\nCheck PM2 logs: pm2 logs lunch-bot`
    );
  }
}

function startCronJob() {
  if (cronStarted) return;
  cronStarted = true;
  cron.schedule("0 11 * * 1-5", async () => {
    console.log("Cron triggered: sending daily menu...");
    await sendMenuToGroup();
  });
  console.log("Cron job scheduled: 11:00 AM Mon–Fri");
}

async function connectToWhatsApp() {
  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
  } = await import("@whiskeysockets/baileys");

  const pino = (await import("pino")).default;

  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrPath = path.join(__dirname, "qr-code.png");
      await QRCode.toFile(qrPath, qr, { width: 400, margin: 2 });
      console.log(`QR code saved to: ${qrPath}`);
      try {
        execSync(`open "${qrPath}"`);
      } catch {}
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        console.error("Logged out from WhatsApp.");
        await sendAlert(
          "Logged out",
          "The lunch bot was logged out of WhatsApp. Please re-authenticate by restarting and scanning the QR code."
        );
        process.exit(1);
      } else {
        console.log(`Connection closed (code ${statusCode}), reconnecting...`);
        connectToWhatsApp();
      }
    }

    if (connection === "open") {
      console.log("WhatsApp connected!");
      await cacheGroupJid();

      if (SEND_NOW) {
        await sendMenuToGroup();
        process.exit(0);
      }

      startCronJob();
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;

      const body =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        "";

      if (body !== "!menu" && body !== "!refresh") continue;

      const chatJid = msg.key.remoteJid;
      if (!chatJid.endsWith("@g.us")) continue;

      if (groupJid && chatJid !== groupJid) continue;
      if (!groupJid) {
        const meta = await sock.groupMetadata(chatJid);
        if (meta.subject !== GROUP_NAME) continue;
        groupJid = chatJid;
      }

      if (body === "!refresh") {
        console.log(`!refresh requested in "${GROUP_NAME}"`);
        await sock.sendMessage(chatJid, { text: "Refreshing menus from Gmail..." });
        try {
          await Promise.all([refreshBlavatnik(), refreshSchwarzman()]);
          await sock.sendMessage(chatJid, {
            text: "Done! Menus refreshed. Send !menu to see the latest.",
          });
        } catch (err) {
          console.error("Error refreshing menus:", err.message);
          await sock.sendMessage(chatJid, {
            text: "Something went wrong refreshing the menus.",
          });
        }
        continue;
      }

      console.log(`!menu requested in "${GROUP_NAME}"`);
      try {
        const menu = await getTodaysMenu();
        await sock.sendMessage(chatJid, { text: menu });
      } catch (err) {
        console.error("Error fetching menu:", err.message);
        await sock.sendMessage(chatJid, {
          text: "Sorry, I couldn't fetch today's menu. Try again later.",
        });
      }
    }
  });
}

connectToWhatsApp();
