require("dotenv").config();
const fs = require("fs");
const express = require("express");
const axios = require("axios");
const { exec } = require("child_process");
const { google } = require("googleapis");

const app = express();
const PORT = 5000;

app.use(express.static("public"));
app.use(express.json());

/* ================= CONFIG ================= */

const CHECK_INTERVAL = 3300;
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
  if (!fs.existsSync("nightbot_token.json")) return;

  const tokenData = JSON.parse(
    fs.readFileSync("nightbot_token.json", "utf8")
  );

  await axios.post(
    "https://api.nightbot.tv/1/channel/send",
    { message },
    { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
  );
}

/* ================= TTS ================= */
function generateTTS(text) {
  return new Promise((resolve) => {
    exec(`python tts.py "${text}" "en-IN-PrabhatNeural"`, () => {
      resolve();
    });
  });
}


/* ================= OVERLAY API ================= */

app.get("/current-alert", (req, res) => {
  if (currentAlert) {
    res.json({ active: true, ...currentAlert });
    currentAlert = null;
  } else {
    res.json({ active: false });
  }
});

/* ================= EMAIL CHECKER ================= */

async function checkEmails() {
  if (isBusy) return;

  try {
    console.log("Checking Gmail...");

    const res = await gmail.users.messages.list({
      userId: "me",
      q: 'from:hdfcbank is:unread newer_than:1d',
      maxResults: 3
    });

    if (!res.data.messages) return;

    const msgData = await gmail.users.messages.get({
      userId: "me",
      id: res.data.messages[0].id
    });

    const body = getBody(msgData.data.payload);

    if (!/successfully credited/i.test(body)) return;

    const parsed = parseHDFC(body);
    if (!parsed.amount || !parsed.name || !parsed.utr) return;

    isBusy = true;

    const formattedName = formatName(parsed.name);
    const fullName = formatName(parsed.name);
    // ✅ First name extract

    const firstName = fullName.split(" ")[0];
      let cleanAmount = parseFloat(parsed.amount);
      if (Number.isInteger(cleanAmount)) {
          cleanAmount = cleanAmount.toString();
      } else {
          cleanAmount = cleanAmount.toFixed(2);
      }
    const message = `${firstName} Tipped ${cleanAmount} rupees! Thank-you so much for your support!`;
    const nightBotmessage = `${firstName} Tipped ${cleanAmount} rupees💸 Thank-you so much for your support 💖`;

    /* ===== Save to logs.json ===== */

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
    }

    /* ===== Generate TTS ===== */

    await generateTTS(message);

    /* ===== Trigger Overlay ===== */

    currentAlert = {
      name: formattedName,
      amount: parsed.amount,
      nightBotmessage
    };

    /* ===== Send Nightbot ===== */

    await sendNightbot(nightBotmessage);

    /* ===== Mark Email Read ===== */

    await gmail.users.messages.modify({
      userId: "me",
      id: msgData.data.id,
      resource: { removeLabelIds: ["UNREAD"] }
    });

    console.log("Donation processed:", formattedName);

    /* ===== Resume after alert finishes ===== */

    setTimeout(() => {
      isBusy = false;
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

app.get("/auth/nightbot", (req, res) => {
  const clientId = process.env.NIGHTBOT_CLIENT_ID;
  const redirectUri = process.env.NIGHTBOT_REDIRECT_URI;

  const url = `https://api.nightbot.tv/oauth2/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=channel_send`;

  res.redirect(url);
});

const qs = require("querystring");

app.get("/auth/nightbot/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send("No code received");

  try {
    const response = await axios.post(
      "https://api.nightbot.tv/oauth2/token",
      qs.stringify({
        client_id: process.env.NIGHTBOT_CLIENT_ID,
        client_secret: process.env.NIGHTBOT_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: process.env.NIGHTBOT_REDIRECT_URI
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        }
      }
    );

    fs.writeFileSync(
      "nightbot_token.json",
      JSON.stringify(response.data, null, 2)
    );

    res.send("Nightbot connected successfully ✅");
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.send("Nightbot OAuth failed ❌");
  }
});
/* ================= START ================= */

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
  console.log("Gmail check every 8 seconds");
});