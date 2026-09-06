const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const qrcode = require('qrcode');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || 'tps_secret_gateway_key_2026';
const AUTH_FOLDER = path.join(__dirname, 'auth_info');

if (!fs.existsSync(AUTH_FOLDER)) {
  fs.mkdirSync(AUTH_FOLDER, { recursive: true });
}

let waSock = null;
let waStatus = 'disconnected'; // 'disconnected' | 'connecting' | 'qr' | 'connected'
let waQrBase64 = '';
let connectedPhone = '';

async function initBaileys() {
  if (waStatus === 'connected' || waStatus === 'connecting') return;
  waStatus = 'connecting';
  waQrBase64 = '';

  try {
    const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = await import('@whiskeysockets/baileys');
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();

    waSock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
      logger: pino({ level: 'silent' }),
      browser: ['Tapowan School Gateway', 'Chrome', '1.0.0']
    });

    waSock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        waStatus = 'qr';
        waQrBase64 = await qrcode.toDataURL(qr, { margin: 2, scale: 8, color: { dark: '#0f172a', light: '#ffffff' } });
        console.log('📱 WhatsApp QR Code generated. Scan from Web UI or Terminal.');
      }

      if (connection === 'close') {
        waStatus = 'disconnected';
        waQrBase64 = '';
        connectedPhone = '';
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`⚠️ Connection closed (code: ${statusCode}). Reconnecting in 5s...`);
        
        if (statusCode === DisconnectReason.loggedOut) {
          console.log('Logged out. Cleaning auth directory...');
          try { fs.rmSync(AUTH_FOLDER, { recursive: true, force: true }); } catch (e) {}
        }
        setTimeout(initBaileys, 5000);
      } else if (connection === 'open') {
        waStatus = 'connected';
        waQrBase64 = '';
        connectedPhone = waSock.user?.id ? waSock.user.id.split(':')[0] : 'Connected';
        console.log(`✅ WhatsApp Gateway Connected Successfully! Phone: ${connectedPhone}`);
      }
    });

    waSock.ev.on('creds.update', saveCreds);
  } catch (err) {
    waStatus = 'disconnected';
    console.error('❌ Failed to initialize Baileys:', err.message);
    setTimeout(initBaileys, 10000);
  }
}

// Start WhatsApp Gateway
initBaileys();

// Helper: Auth middleware (optional, skips if API_KEY not sent or matching)
const checkApiKey = (req, res, next) => {
  const key = req.headers['x-api-key'] || req.query.key;
  if (API_KEY && key && key !== API_KEY) {
    return res.status(401).json({ error: 'Invalid API Key' });
  }
  next();
};

// ==========================================
// 1. WEB UI DASHBOARD & QR SCANNER
// ==========================================
app.get('/', (req, res) => {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TPS WhatsApp Gateway Cloud</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    * { margin:0; padding:0; box-sizing:border-box; font-family:'Plus Jakarta Sans', sans-serif; }
    body { background:#0f172a; color:#f8fafc; min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:20px; }
    .card { background:#1e293b; border:1px solid #334155; border-radius:24px; padding:32px; width:100%; max-width:540px; box-shadow:0 20px 40px rgba(0,0,0,0.4); text-align:center; }
    .header { display:flex; align-items:center; justify-content:center; gap:12px; margin-bottom:20px; }
    .logo { width:44px; height:44px; background:#10b981; border-radius:12px; display:flex; align-items:center; justify-content:center; font-size:24px; }
    h1 { font-size:20px; font-weight:800; color:#ffffff; }
    .sub { font-size:13px; color:#94a3b8; margin-top:2px; }
    .status-pill { display:inline-flex; align-items:center; gap:8px; padding:6px 16px; border-radius:20px; font-size:13px; font-weight:700; margin:16px 0; }
    .status-connected { background:rgba(16,185,129,0.15); color:#10b981; border:1px solid rgba(16,185,129,0.3); }
    .status-qr { background:rgba(245,158,11,0.15); color:#f59e0b; border:1px solid rgba(245,158,11,0.3); }
    .status-disconnected { background:rgba(239,68,68,0.15); color:#ef4444; border:1px solid rgba(239,68,68,0.3); }
    .qr-box { background:#ffffff; border-radius:16px; padding:16px; margin:20px auto; width:280px; height:280px; display:flex; align-items:center; justify-content:center; }
    .qr-box img { width:100%; height:100%; object-fit:contain; }
    .connected-box { background:rgba(16,185,129,0.1); border:1.5px dashed #10b981; border-radius:16px; padding:24px; margin:20px 0; text-align:center; }
    .connected-box h3 { color:#10b981; font-size:18px; margin-bottom:6px; }
    .test-box { margin-top:24px; text-align:left; background:#0f172a; padding:18px; border-radius:16px; border:1px solid #334155; }
    .test-box h4 { font-size:14px; font-weight:700; margin-bottom:12px; color:#cbd5e1; }
    input, textarea, button { width:100%; padding:10px 14px; border-radius:10px; border:1px solid #334155; background:#1e293b; color:#fff; font-size:13px; margin-bottom:10px; outline:none; }
    input:focus, textarea:focus { border-color:#3b82f6; }
    button { background:#10b981; color:#fff; font-weight:700; cursor:pointer; border:none; transition:0.2s; }
    button:hover { background:#059669; }
    .logout-btn { background:#ef4444; margin-top:8px; }
    .logout-btn:hover { background:#dc2626; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="logo">💬</div>
      <div>
        <h1>Tapowan WhatsApp Gateway</h1>
        <div class="sub">24/7 Dedicated Cloud Microservice</div>
      </div>
    </div>

    <div id="statusContainer">
      <div class="status-pill status-qr">🔄 Connecting to WhatsApp...</div>
    </div>

    <div id="qrContainer" style="display:none;">
      <div class="qr-box">
        <img id="qrImg" src="" alt="Scan QR Code" />
      </div>
      <p style="font-size:12px; color:#94a3b8;">Open WhatsApp on phone ➔ Linked Devices ➔ Link a Device and scan.</p>
    </div>

    <div id="connectedContainer" style="display:none;" class="connected-box">
      <h3>✅ Gateway Online & Active</h3>
      <p style="font-size:13px; color:#cbd5e1;">Connected Phone: <b id="phoneVal"></b></p>
      <button class="logout-btn" onclick="logout()">Disconnect / Logout</button>
    </div>

    <!-- Quick Live Test Sender -->
    <div class="test-box">
      <h4>⚡ Quick Message Test</h4>
      <input type="text" id="testPhone" placeholder="Enter Phone (e.g. 919876543210)" />
      <textarea id="testMsg" rows="2" placeholder="Message content">Test from Tapowan Cloud WhatsApp Gateway! 🚀</textarea>
      <button onclick="sendTestMsg()">Send Test Message</button>
      <div id="testResult" style="font-size:12px; margin-top:6px;"></div>
    </div>
  </div>

  <script>
    async function updateStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        
        const statusDiv = document.getElementById('statusContainer');
        const qrDiv = document.getElementById('qrContainer');
        const connDiv = document.getElementById('connectedContainer');
        const qrImg = document.getElementById('qrImg');
        const phoneVal = document.getElementById('phoneVal');

        if (data.status === 'connected') {
          statusDiv.innerHTML = '<div class="status-pill status-connected">🟢 Connected 24/7</div>';
          qrDiv.style.display = 'none';
          connDiv.style.display = 'block';
          phoneVal.innerText = data.phone || 'Active';
        } else if (data.status === 'qr' && data.qr) {
          statusDiv.innerHTML = '<div class="status-pill status-qr">🟡 Scan QR to Connect</div>';
          qrImg.src = data.qr;
          qrDiv.style.display = 'block';
          connDiv.style.display = 'none';
        } else {
          statusDiv.innerHTML = '<div class="status-pill status-disconnected">🔴 Disconnected (Reconnecting...)</div>';
          qrDiv.style.display = 'none';
          connDiv.style.display = 'none';
        }
      } catch (e) {}
    }

    async function sendTestMsg() {
      const to = document.getElementById('testPhone').value.trim();
      const message = document.getElementById('testMsg').value.trim();
      const resDiv = document.getElementById('testResult');
      if (!to || !message) return alert('Enter phone number and message.');

      resDiv.innerText = 'Sending...';
      try {
        const res = await fetch('/api/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to, message })
        });
        const d = await res.json();
        if (d.ok) {
          resDiv.innerHTML = '<span style="color:#10b981;">✅ Sent successfully!</span>';
        } else {
          resDiv.innerHTML = '<span style="color:#ef4444;">❌ ' + (d.error || 'Failed') + '</span>';
        }
      } catch (e) {
        resDiv.innerHTML = '<span style="color:#ef4444;">❌ ' + e.message + '</span>';
      }
    }

    async function logout() {
      if (!confirm('Are you sure you want to disconnect?')) return;
      await fetch('/api/logout', { method: 'POST' });
      updateStatus();
    }

    setInterval(updateStatus, 3000);
    updateStatus();
  </script>
</body>
</html>
  `;
  res.send(html);
});

// ==========================================
// 2. REST API ENDPOINTS
// ==========================================

// GET /api/status
app.get('/api/status', (req, res) => {
  res.json({
    status: waStatus,
    phone: connectedPhone,
    qr: waQrBase64,
    uptime: Math.round(process.uptime())
  });
});

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({ ok: true, status: waStatus, uptime: process.uptime() });
});

// POST /api/logout
app.post('/api/logout', checkApiKey, async (req, res) => {
  try {
    if (waSock) {
      await waSock.logout();
    }
    waStatus = 'disconnected';
    waQrBase64 = '';
    connectedPhone = '';
    if (fs.existsSync(AUTH_FOLDER)) {
      fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
    }
    setTimeout(initBaileys, 1000);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/send (Send Text or Media)
app.post('/api/send', checkApiKey, async (req, res) => {
  const { to, message, attachment } = req.body || {};
  if (!to || (!message && !attachment)) {
    return res.status(400).json({ error: "Missing 'to' or 'message' parameters" });
  }

  if (waStatus !== 'connected' || !waSock) {
    return res.status(503).json({ error: 'WhatsApp is not connected on gateway.' });
  }

  try {
    let cleanNumber = String(to).replace(/\D/g, '');
    if (cleanNumber.length === 10) cleanNumber = '91' + cleanNumber;
    const jid = `${cleanNumber}@s.whatsapp.net`;

    if (attachment) {
      let buffer, mimetype = 'image/jpeg', fileName = 'document.pdf';
      
      if (typeof attachment === 'object' && attachment.base64) {
        buffer = Buffer.from(attachment.base64, 'base64');
        mimetype = attachment.mimetype || mimetype;
        fileName = attachment.fileName || fileName;
      } else if (typeof attachment === 'string' && attachment.startsWith('data:')) {
        const parts = attachment.split(',');
        const mimeMatch = parts[0].match(/:(.*?);/);
        mimetype = mimeMatch ? mimeMatch[1] : mimetype;
        buffer = Buffer.from(parts[1], 'base64');
      } else if (typeof attachment === 'string') {
        buffer = Buffer.from(attachment, 'base64');
      }

      if (mimetype.includes('pdf')) {
        await waSock.sendMessage(jid, { document: buffer, mimetype, caption: message || '', fileName });
      } else if (mimetype.includes('image')) {
        await waSock.sendMessage(jid, { image: buffer, caption: message || '' });
      } else if (mimetype.includes('video')) {
        await waSock.sendMessage(jid, { video: buffer, caption: message || '' });
      } else if (mimetype.includes('audio')) {
        await waSock.sendMessage(jid, { audio: buffer, mimetype });
      } else {
        await waSock.sendMessage(jid, { document: buffer, mimetype, caption: message || '', fileName });
      }
    } else {
      await waSock.sendMessage(jid, { text: message });
    }

    res.json({ ok: true, to: cleanNumber });
  } catch (err) {
    console.error('Error sending message:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/send-bulk (Rate-limited safe bulk sender)
app.post('/api/send-bulk', checkApiKey, async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Messages must be a non-empty array.' });
  }

  if (waStatus !== 'connected' || !waSock) {
    return res.status(503).json({ error: 'WhatsApp is not connected.' });
  }

  // Respond immediately, process in background with delays to protect WhatsApp number
  res.json({ ok: true, queued: messages.length, message: 'Processing in background safely...' });

  (async () => {
    for (let i = 0; i < messages.length; i++) {
      const item = messages[i];
      try {
        let cleanNumber = String(item.to).replace(/\D/g, '');
        if (cleanNumber.length === 10) cleanNumber = '91' + cleanNumber;
        const jid = `${cleanNumber}@s.whatsapp.net`;
        await waSock.sendMessage(jid, { text: item.message });
        console.log(`[Bulk] Sent to ${cleanNumber} (${i + 1}/${messages.length})`);
      } catch (err) {
        console.error(`[Bulk Error] Failed for ${item.to}:`, err.message);
      }
      // Safety delay: 3 to 6 seconds between messages
      const delay = Math.floor(Math.random() * 3000) + 3000;
      await new Promise(r => setTimeout(r, delay));
    }
    console.log('✅ Bulk messaging campaign completed.');
  })();
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`🚀 Tapowan WhatsApp Gateway running on port ${PORT}`);
  console.log(`🌐 Web UI & QR Scanner: http://localhost:${PORT}`);
  console.log(`====================================================`);
});
