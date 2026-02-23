require("dotenv").config();
const fs = require("fs");
const express = require("express");
const axios = require("axios");
const { exec } = require("child_process");
const { google } = require("googleapis");
const qs = require("querystring");

const app = express();
const PORT = 5000;

app.use(express.static("public"));
app.use(express.json());

/* ================= CONFIG ================= */

const CHECK_INTERVAL = 10000;
let isBusy = false;
let currentAlert = null;

/* ================= GMAIL AUTH ================= */

const token = JSON.parse(fs.readFileSync("token.json"));
const credentials = JSON.parse(fs.readFileSync("credentials.json"));
const { client_id, client_secret, redirect_uris } = credentials.installed;

const oAuth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  redirect_uris[0]
);

oAuth2Client.setCredentials(token);

const gmail = google.gmail({
  version: "v1",
  auth: oAuth2Client
});

// ======================= LOGGER SYSTEM =======================

const DEBUG_MODE = true; // 👈 true = debug logs ON | false = hide debug logs

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m"
};

function logInfo(msg) {
  console.log(`${colors.cyan}ℹ️  ${msg}${colors.reset}`);
}

function logSuccess(msg) {
  console.log(`${colors.green}✅ ${msg}${colors.reset}`);
}

function logError(msg) {
  console.log(`${colors.red}❌ ${msg}${colors.reset}`);
}

function logWarning(msg) {
  console.log(`${colors.yellow}⚠️  ${msg}${colors.reset}`);
}

function logDebug(msg) {
  if (DEBUG_MODE) {
    console.log(`${colors.magenta}🐛 DEBUG: ${msg}${colors.reset}`);
  }
}

/* ================= PARSER ================= */

function getBody(payload) {
  if (!payload.parts) return "";
  for (const part of payload.parts) {
    if (part.mimeType === "text/html" && part.body?.data) {
      return Buffer.from(part.body.data, "base64").toString("utf8");
    }
  }
  return "";
}

function parseHDFC(body) {
  const amount = body.match(/Rs\.?\s?([0-9.]+)/i)?.[1];
  const name = body.match(/VPA\s+[^\s]+\s+([A-Z\s]+?)\s+on/i)?.[1]?.trim();
  const utr = body.match(/reference number is\s+([0-9]+)/i)?.[1];
  return { amount, name, utr };
}

function formatName(name) {
  return name
    .toLowerCase()
    .split(" ")
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/* ================= NIGHTBOT ================= */

async function sendNightbot(message) {
  logInfo("🤖 Sending message to Nightbot...");
  if (!fs.existsSync("nightbot_token.json")) {
    console.log("Nightbot token not found.");
    return;
  }

  const tokenData = JSON.parse(
    fs.readFileSync("nightbot_token.json", "utf8")
  );

  await axios.post(
    "https://api.nightbot.tv/1/channel/send",
    { message },
    { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
  );

  logSuccess("✅ Nightbot message sent successfully.");
}

/* ================= TTS ================= */

function generateTTS(text) {
  logInfo("🎙️ Generating voice alert...");
  return new Promise((resolve, reject) => {
    exec(`python3 tts.py "${text}" "en-IN-PrabhatNeural"`, (err, stdout, stderr) => {
      if (err) {
        console.log("TTS Error:", err);
        reject(err);
      } else {
        logSuccess(`🔊 Voice generated successfully for: ${text}`);
        resolve();
      }
    });
  });
}

/* ================= OVERLAY API ================= */

app.get("/current-alert", (req, res) => {
  if (currentAlert) {
    console.log("Overlay requested. Sending alert.");
    res.json({ active: true, ...currentAlert });
    currentAlert = null;
  } else {
    res.json({ active: false });
  }
});

/* ================= EMAIL CHECKER ================= */

async function checkEmails() {
  if (isBusy) {
    logWarning("⏳ System busy processing donation. Skipping check...");
    return;
  }

  try {
    logInfo("📬 Checking Gmail for new donations...");

    const res = await gmail.users.messages.list({
      userId: "me",
      q: 'from:hdfcbank is:unread newer_than:1d',
      maxResults: 3
    });

    if (!res.data.messages) {
      logWarning("😴 No new donation emails found.");
      return;
    }

    logSuccess("📨 Donation email found! Fetching details...");

    const msgData = await gmail.users.messages.get({
      userId: "me",
      id: res.data.messages[0].id
    });

    const body = getBody(msgData.data.payload);

    if (!/successfully credited/i.test(body)) {
      console.log("⚠️ Email is not a valid credit transaction.");
      return;
    }

    const parsed = parseHDFC(body);

    if (!parsed.amount || !parsed.name || !parsed.utr) {
      logError("❌ Failed to parse donation email.");
      return;
    }

    logSuccess("🎉 Donation Details Extracted:");
    logDebug(`👤 Name: ${parsed.name}`);
    logDebug(`💰 Amount: ${parsed.amount}`);
    logDebug(`🔢 UTR: ${parsed.utr}`);

    isBusy = true;

    const formattedName = formatName(parsed.name);
    const firstName = formattedName.split(" ")[0];

    let cleanAmount = parseFloat(parsed.amount);
    if (Number.isInteger(cleanAmount)) {
      cleanAmount = cleanAmount.toString();
    } else {
      cleanAmount = cleanAmount.toFixed(2);
    }

    const message = `${firstName} Tipped ${cleanAmount} ₹! Thank-you so much for your support!`;
    const nightBotmessage = `${firstName} Tipped ${cleanAmount} rupees💸 Thank-you so much for your support 💖`;

    /* ===== Save Logs ===== */

    console.log("💾 Saving donation to logs.json...");

    let logs = [];
    if (fs.existsSync("logs.json")) {
      logs = JSON.parse(fs.readFileSync("logs.json", "utf8"));
    }

    if (!logs.some(l => l.utr === parsed.utr)) {
      logs.push({
        name: formattedName,
        amount: parsed.amount,
        utr: parsed.utr,
        time: new Date().toISOString()
      });

      fs.writeFileSync("logs.json", JSON.stringify(logs, null, 2));
      console.log("✅ Donation log saved successfully.");
    } else {
      logWarning("🔁 Duplicate UTR detected. Skipping...");
    }

    /* ===== TTS ===== */

    await generateTTS(message);

    /* ===== Overlay ===== */

    logInfo("🚨 Triggering donation overlay animation...");
    currentAlert = {
      name: firstName,
      amount: parsed.amount,
      nightBotmessage
    };

    /* ===== Nightbot ===== */

    await sendNightbot(nightBotmessage);

    /* ===== Mark Read ===== */

    console.log("📩 Marking donation email as read...");
    await gmail.users.messages.modify({
      userId: "me",
      id: msgData.data.id,
      resource: { removeLabelIds: ["UNREAD"] }
    });

    logSuccess(`🎊 Donation processed successfully for: ${formattedName}`);

    setTimeout(() => {
      isBusy = false;
      console.log("System ready for next donation.");
    }, 15000);

  } catch (err) {
    console.log("Gmail error:", err.message);
  }
}

setInterval(checkEmails, CHECK_INTERVAL);

/* ================= LEADERBOARD ================= */

app.get("/api/leaderboard", (req, res) => {
  if (!fs.existsSync("logs.json")) return res.json([]);

  const logs = JSON.parse(fs.readFileSync("logs.json", "utf8"));
  const totals = {};

  logs.forEach(l => {
    if (!totals[l.name]) totals[l.name] = 0;
    totals[l.name] += Number(l.amount);
  });

  const sorted = Object.entries(totals)
    .sort((a,b)=>b[1]-a[1])
    .slice(0,10);

  res.json(sorted);
});

/* ================= START ================= */

app.listen(PORT, () => {
  logSuccess(`🚀 Donation Server running on port ${PORT}`);
  console.log("⏱️ Gmail auto-check every 5 seconds enabled.");
});