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
const ADMIN_PIN = process.env.ADMIN_PIN || 'tapowan2026';
const AUTH_FOLDER = path.join(__dirname, 'auth_info');
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || 'https://tapowan-whatsapp-gateway.onrender.com';

const TURSO_URL = process.env.TURSO_DATABASE_URL || 'https://tapowan-v2-tapowan.aws-ap-south-1.turso.io';
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODkwOTIyMTUsImlkIjoiMDFhMDhlMzQtODMwMS03MDI0LTk5ZWQtMGQ0MmYwMGJiNjFlIiwia2lkIjoiVFRPdk5ISlFYZVAtX1FsNG9ZUXM4cTBTYXRiZzJ1UmVhYjlUbjFyem1tcyIsInJpZCI6ImVjNjc2YzExLTRhNGUtNGZhNi1hMTM1LTJmZDk4YTIxNzliMSJ9.RmzczPOvgV3Hd83byF7fMfQsCzlJnF8r9MCGtzTfZDj8k--VqtItniZN5GCiPfv4-dCEmDZaIWDGPOnM-EknDA';

if (!fs.existsSync(AUTH_FOLDER)) {
  fs.mkdirSync(AUTH_FOLDER, { recursive: true });
}

// ----------------------------------------------------
// Turso Cloud Session Backup & Restore Helper
// ----------------------------------------------------
async function executeTursoQuery(sql, args = []) {
  try {
    const formattedArgs = args.map(arg => {
      if (typeof arg === 'number') return { type: 'integer', value: String(arg) };
      if (arg === null || arg === undefined) return { type: 'null' };
      return { type: 'text', value: String(arg) };
    });

    const res = await fetch(`${TURSO_URL.replace(/\/$/, '')}/v2/pipeline`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + TURSO_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        requests: [
          { type: 'execute', stmt: { sql, args: formattedArgs } }
        ]
      })
    });
    return await res.json();
  } catch (err) {
    console.error('Turso session sync error:', err.message);
    return null;
  }
}

async function restoreSessionFromTurso() {
  try {
    // Ensure unique index on settings table key
    await executeTursoQuery("CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_key ON settings(key)");

    if (fs.existsSync(path.join(AUTH_FOLDER, 'creds.json'))) {
      console.log('📦 Local credentials exist, skipping Turso restore.');
      return;
    }
    console.log('🔄 Checking Turso Cloud for saved WhatsApp session...');
    const result = await executeTursoQuery("SELECT value FROM settings WHERE key = 'baileys_cloud_auth' LIMIT 1");
    const row = result?.results?.[0]?.response?.result?.rows?.[0];
    if (row && row[0]?.value) {
      const filesObj = JSON.parse(row[0].value);
      for (const [filename, content] of Object.entries(filesObj)) {
        fs.writeFileSync(path.join(AUTH_FOLDER, filename), content, 'utf8');
      }
      console.log(`✅ Restored ${Object.keys(filesObj).length} WhatsApp session files from Turso Cloud!`);
    } else {
      console.log('ℹ️ No saved WhatsApp session in Turso Cloud. Ready for QR scan.');
    }
  } catch (e) {
    console.error('Failed restoring session from Turso:', e.message);
  }
}

let syncTimeout = null;
function debouncedSaveSessionToTurso(delay = 2000) {
  if (syncTimeout) clearTimeout(syncTimeout);
  syncTimeout = setTimeout(async () => {
    try {
      if (!fs.existsSync(AUTH_FOLDER)) return;
      const fileNames = fs.readdirSync(AUTH_FOLDER);
      if (!fileNames.includes('creds.json')) return;

      const filesObj = {};
      for (const name of fileNames) {
        filesObj[name] = fs.readFileSync(path.join(AUTH_FOLDER, name), 'utf8');
      }
      const jsonStr = JSON.stringify(filesObj);
      
      const saveRes = await executeTursoQuery(
        "INSERT INTO settings (key, value, category, updatedBy) VALUES ('baileys_cloud_auth', ?, 'system', 'whatsapp_gateway') ON CONFLICT(key) DO UPDATE SET value = excluded.value, category = 'system', updatedBy = 'whatsapp_gateway'",
        [jsonStr]
      );
      
      // Fallback if ON CONFLICT had an issue
      if (saveRes?.results?.[0]?.type === 'error') {
        await executeTursoQuery("DELETE FROM settings WHERE key = 'baileys_cloud_auth'");
        await executeTursoQuery(
          "INSERT INTO settings (key, value, category, updatedBy) VALUES ('baileys_cloud_auth', ?, 'system', 'whatsapp_gateway')",
          [jsonStr]
        );
      }
      console.log(`☁️ WhatsApp Session (${fileNames.length} files, ${Math.round(jsonStr.length / 1024)} KB) backed up to Turso Cloud!`);
    } catch (e) {
      console.error('Failed saving session to Turso:', e.message);
    }
  }, delay);
}

// ----------------------------------------------------
// Baileys Socket Lifecycle
// ----------------------------------------------------
let waSock = null;
let waStatus = 'disconnected';
let waQrBase64 = '';
let connectedPhone = '';

// In-memory debug log of last 50 inbound messages
const inboundLog = [];
function logInbound(entry) {
  inboundLog.unshift({ ...entry, ts: new Date().toISOString() });
  if (inboundLog.length > 50) inboundLog.length = 50;
}

async function initBaileys() {
  if (waStatus === 'connected' || waStatus === 'connecting') return;
  waStatus = 'connecting';
  waQrBase64 = '';

  await restoreSessionFromTurso();

  try {
    const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = await import('@whiskeysockets/baileys');
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();

    waSock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true,
      logger: pino({ level: 'silent' }),
      browser: ['Tapowan Cloud Gateway', 'Chrome', '1.0.0']
    });

    waSock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        waStatus = 'qr';
        waQrBase64 = await qrcode.toDataURL(qr, { margin: 2, scale: 8, color: { dark: '#0f172a', light: '#ffffff' } });
        console.log('📱 WhatsApp QR Code generated. Scan from Web UI.');
      }

      if (connection === 'close') {
        waStatus = 'disconnected';
        waQrBase64 = '';
        connectedPhone = '';
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`⚠️ Connection closed (code: ${statusCode}). Reconnecting in 5s...`);
        
        if (statusCode === DisconnectReason.loggedOut) {
          console.log('Logged out. Cleaning auth directory and Turso session...');
          try { fs.rmSync(AUTH_FOLDER, { recursive: true, force: true }); } catch (e) {}
          await executeTursoQuery("DELETE FROM settings WHERE key = 'baileys_cloud_auth'");
        }
        setTimeout(initBaileys, 5000);
      } else if (connection === 'open') {
        waStatus = 'connected';
        waQrBase64 = '';
        connectedPhone = waSock.user?.id ? waSock.user.id.split(':')[0] : 'Connected';
        console.log(`✅ WhatsApp Gateway Connected Successfully! Phone: ${connectedPhone}`);
        debouncedSaveSessionToTurso();
      }
    });

    waSock.ev.on('creds.update', () => {
      saveCreds();
      debouncedSaveSessionToTurso();
    });

    // Inbound WhatsApp Message Listener (Auto-Approval & Webhook Forwarder)
    waSock.ev.on('messages.upsert', async ({ messages, type }) => {
      try {
        if (!Array.isArray(messages)) return;
        for (const msg of messages) {
          if (!msg.message) continue;

          // CRITICAL: Skip ALL outgoing messages from the bot itself
          if (msg.key.fromMe) {
            continue;
          }

          let sender = msg.key.remoteJid;
          if (!sender || sender.includes('@g.us') || sender.includes('@broadcast')) continue;

          // Skip protocol/system messages
          if (msg.message.protocolMessage || msg.message.senderKeyDistributionMessage) continue;

          // Unpack message from ephemeral / viewOnce wrappers
          const realMsg = msg.message.ephemeralMessage?.message ||
                         msg.message.viewOnceMessage?.message ||
                         msg.message.viewOnceMessageV2?.message ||
                         msg.message.documentWithCaptionMessage?.message ||
                         msg.message;


          const text = (realMsg?.conversation ||
                       realMsg?.extendedTextMessage?.text ||
                       realMsg?.imageMessage?.caption ||
                       realMsg?.videoMessage?.caption ||
                       realMsg?.documentMessage?.caption ||
                       "").trim();

          if (!text) continue;

          const cleanPhone = sender.replace('@s.whatsapp.net', '').replace(/:\d+/, '').replace(/\D/g, '');
          
          // Log every inbound message for debugging
          logInbound({ from: cleanPhone, jid: sender, text: text.substring(0, 200), forwarded: true });
          console.log(`📩 [Gateway Inbound] From ${cleanPhone} (JID: ${sender}): "${text}"`);

          // Forward to Tapowan Public School Vercel Webhook
          const webhookUrl = process.env.TAPOWAN_WEBHOOK_URL || 'https://tapowan-school.vercel.app/api/whatsapp/webhook';
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 25000);
            const res = await fetch(webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                from: cleanPhone,
                sender: cleanPhone,
                jid: sender,
                message: text,
                text: text
              }),
              signal: controller.signal
            });
            clearTimeout(timeoutId);
            const resJson = await res.json();
            console.log(`✅ [Webhook Response] for ${cleanPhone}:`, JSON.stringify(resJson));
            logInbound({ from: cleanPhone, jid: sender, text: text.substring(0, 100), webhookResult: resJson.ok ? 'SUCCESS' : 'FAIL', detail: JSON.stringify(resJson).substring(0, 200) });
          } catch (whErr) {
            console.error(`❌ [Webhook Forward Error] for ${cleanPhone}:`, whErr.message);
            logInbound({ from: cleanPhone, text: text.substring(0, 100), webhookResult: 'ERROR', detail: whErr.message });
          }
        }
      } catch (err) {
        console.error('❌ [messages.upsert error]:', err.message);
        logInbound({ error: err.message });
      }
    });
  } catch (err) {
    waStatus = 'disconnected';
    console.error('❌ Failed to initialize Baileys:', err.message);
    setTimeout(initBaileys, 10000);
  }
}

initBaileys();

// ----------------------------------------------------
// 24/7 Keep-Alive Engine (Anti-Sleep for Render)
// ----------------------------------------------------
setInterval(async () => {
  try {
    const urls = [
      `http://localhost:${PORT}/api/health`,
      `${RENDER_EXTERNAL_URL.replace(/\/$/, '')}/api/health`
    ];
    for (const u of urls) {
      await fetch(u).catch(() => {});
    }
  } catch (e) {}
}, 4 * 60 * 1000);

// ----------------------------------------------------
// Auth Middleware
// ----------------------------------------------------
const checkAuth = (req, res, next) => {
  const key = req.headers['x-api-key'] || req.query.key;
  const pin = req.headers['x-admin-pin'] || req.body?.pin;
  if ((key && key === API_KEY) || (pin && pin === ADMIN_PIN)) {
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized: Invalid Admin PIN or API Key' });
};

// ==========================================
// 1. SECURE WEB UI DASHBOARD (PIN PROTECTED)
// ==========================================
app.get('/', (req, res) => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>TPS WhatsApp Cloud Gateway (Protected)</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    * { margin:0; padding:0; box-sizing:border-box; font-family:'Plus Jakarta Sans', sans-serif; }
    body { background:#0b0f19; color:#f8fafc; min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:20px; }
    .card { background:#151c2c; border:1px solid #28354f; border-radius:24px; padding:32px; width:100%; max-width:540px; box-shadow:0 25px 50px -12px rgba(0,0,0,0.6); text-align:center; }
    .header { display:flex; align-items:center; justify-content:center; gap:12px; margin-bottom:20px; }
    .logo { width:46px; height:46px; background:#10b981; border-radius:14px; display:flex; align-items:center; justify-content:center; font-size:24px; box-shadow:0 8px 16px rgba(16,185,129,0.3); }
    h1 { font-size:20px; font-weight:800; color:#ffffff; }
    .sub { font-size:13px; color:#94a3b8; margin-top:2px; }
    
    .status-pill { display:inline-flex; align-items:center; gap:8px; padding:6px 18px; border-radius:20px; font-size:13px; font-weight:700; margin:16px 0; }
    .status-connected { background:rgba(16,185,129,0.15); color:#10b981; border:1px solid rgba(16,185,129,0.3); }
    .status-qr { background:rgba(245,158,11,0.15); color:#f59e0b; border:1px solid rgba(245,158,11,0.3); }
    .status-disconnected { background:rgba(239,68,68,0.15); color:#ef4444; border:1px solid rgba(239,68,68,0.3); }
    
    .qr-box { background:#ffffff; border-radius:16px; padding:16px; margin:20px auto; width:280px; height:280px; display:flex; align-items:center; justify-content:center; }
    .qr-box img { width:100%; height:100%; object-fit:contain; }
    .connected-box { background:rgba(16,185,129,0.08); border:1.5px dashed #10b981; border-radius:16px; padding:24px; margin:20px 0; text-align:center; }
    .connected-box h3 { color:#10b981; font-size:18px; margin-bottom:6px; }
    
    .lock-box { background:#1e293b; border:1px solid #334155; border-radius:16px; padding:24px; margin-top:20px; }
    .test-box { margin-top:24px; text-align:left; background:#0b0f19; padding:20px; border-radius:16px; border:1px solid #28354f; }
    .test-box h4 { font-size:14px; font-weight:700; margin-bottom:12px; color:#cbd5e1; }
    
    input, textarea, button { width:100%; padding:12px 14px; border-radius:12px; border:1px solid #28354f; background:#1e293b; color:#fff; font-size:13px; margin-bottom:12px; outline:none; transition:0.2s; }
    input:focus, textarea:focus { border-color:#10b981; }
    button { background:#10b981; color:#fff; font-weight:700; cursor:pointer; border:none; transition:0.2s; }
    button:hover { background:#059669; }
    .logout-btn { background:#ef4444; margin-top:8px; }
    .logout-btn:hover { background:#dc2626; }
    .lock-btn { background:#3b82f6; }
    .lock-btn:hover { background:#2563eb; }
    .pin-input { font-size:18px; letter-spacing:4px; text-align:center; font-weight:bold; }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="logo">💬</div>
      <div>
        <h1>Tapowan WhatsApp Gateway</h1>
        <div class="sub">24/7 Cloud Microservice • Anti-Sleep Active ⚡</div>
      </div>
    </div>

    <!-- LOCK SCREEN (Shown when not authenticated) -->
    <div id="lockScreen" class="lock-box">
      <div style="font-size:36px; margin-bottom:10px;">🔒</div>
      <h3 style="font-size:16px; margin-bottom:6px; color:#f8fafc;">Admin PIN Protected</h3>
      <p style="font-size:12px; color:#94a3b8; margin-bottom:16px;">Enter the Master PIN to manage WhatsApp connection, scan QR, or send messages.</p>
      <input type="password" id="pinInput" class="pin-input" placeholder="••••••••" onkeydown="if(event.key==='Enter') verifyPin()" />
      <button onclick="verifyPin()" class="lock-btn">Unlock Gateway Dashboard</button>
      <div id="pinError" style="color:#ef4444; font-size:12px; margin-top:6px; display:none;">❌ Invalid Admin PIN</div>
    </div>

    <!-- DASHBOARD CONTENT (Shown only after PIN verification) -->
    <div id="dashboardScreen" style="display:none;">
      <div id="statusContainer">
        <div class="status-pill status-qr">🔄 Connecting...</div>
      </div>

      <div id="qrContainer" style="display:none;">
        <div class="qr-box">
          <img id="qrImg" src="" alt="Scan QR Code" />
        </div>
        <p style="font-size:12px; color:#94a3b8;">Open WhatsApp on phone ➔ Linked Devices ➔ Link a Device and scan.</p>
      </div>

      <div id="connectedContainer" style="display:none;" class="connected-box">
        <h3>✅ Gateway Online & Active</h3>
        <p style="font-size:14px; color:#cbd5e1; margin-bottom:12px;">Connected Phone: <b id="phoneVal" style="color:#10b981;"></b></p>
        <button class="logout-btn" onclick="logout()">Disconnect / Logout</button>
      </div>

      <!-- Quick Live Test Sender -->
      <div class="test-box">
        <h4>⚡ Send Test WhatsApp Message</h4>
        <input type="text" id="testPhone" placeholder="Enter Phone (e.g. 917488061954)" />
        <textarea id="testMsg" rows="2" placeholder="Message content">Test from Tapowan 24/7 Cloud WhatsApp Gateway! 🚀</textarea>
        <button onclick="sendTestMsg()">Send Message</button>
        <div id="testResult" style="font-size:12px; margin-top:6px;"></div>
      </div>

      <button onclick="lockDashboard()" style="background:transparent; border:1px solid #334155; color:#94a3b8; font-size:12px; margin-top:16px;">
        🔒 Lock Dashboard
      </button>
    </div>
  </div>

  <script>
    let savedPin = localStorage.getItem('tps_gateway_pin') || '';

    function checkSavedPin() {
      if (savedPin) {
        document.getElementById('lockScreen').style.display = 'none';
        document.getElementById('dashboardScreen').style.display = 'block';
        updateStatus();
      } else {
        document.getElementById('lockScreen').style.display = 'block';
        document.getElementById('dashboardScreen').style.display = 'none';
      }
    }

    async function verifyPin() {
      const pin = document.getElementById('pinInput').value.trim();
      if (!pin) return;
      
      const res = await fetch('/api/verify-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin })
      });
      const data = await res.json();
      if (data.ok) {
        savedPin = pin;
        localStorage.setItem('tps_gateway_pin', pin);
        document.getElementById('pinError').style.display = 'none';
        document.getElementById('lockScreen').style.display = 'none';
        document.getElementById('dashboardScreen').style.display = 'block';
        updateStatus();
      } else {
        document.getElementById('pinError').style.display = 'block';
      }
    }

    function lockDashboard() {
      localStorage.removeItem('tps_gateway_pin');
      savedPin = '';
      document.getElementById('lockScreen').style.display = 'block';
      document.getElementById('dashboardScreen').style.display = 'none';
      document.getElementById('pinInput').value = '';
    }

    async function updateStatus() {
      if (!savedPin) return;
      try {
        const res = await fetch('/api/status', {
          headers: { 'x-admin-pin': savedPin }
        });
        const data = await res.json();
        
        const statusDiv = document.getElementById('statusContainer');
        const qrDiv = document.getElementById('qrContainer');
        const connDiv = document.getElementById('connectedContainer');
        const qrImg = document.getElementById('qrImg');
        const phoneVal = document.getElementById('phoneVal');

        if (data.status === 'connected') {
          statusDiv.innerHTML = '<div class="status-pill status-connected">🟢 Connected 24/7 (Protected)</div>';
          qrDiv.style.display = 'none';
          connDiv.style.display = 'block';
          phoneVal.innerText = data.phone || 'Active';
        } else if (data.status === 'qr' && data.qr) {
          statusDiv.innerHTML = '<div class="status-pill status-qr">🟡 Scan QR to Connect</div>';
          qrImg.src = data.qr;
          qrDiv.style.display = 'block';
          connDiv.style.display = 'none';
        } else {
          statusDiv.innerHTML = '<div class="status-pill status-disconnected">🔴 Disconnected (Connecting...)</div>';
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
          headers: {
            'Content-Type': 'application/json',
            'x-admin-pin': savedPin
          },
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
      if (!confirm('Are you sure you want to disconnect WhatsApp from Cloud?')) return;
      await fetch('/api/logout', {
        method: 'POST',
        headers: { 'x-admin-pin': savedPin }
      });
      updateStatus();
    }

    checkSavedPin();
    setInterval(updateStatus, 3000);
  </script>
</body>
</html>`;
  res.send(html);
});

// ==========================================
// 2. REST API ENDPOINTS (AUTHENTICATED)
// ==========================================

// POST /api/verify-pin (PIN Validation)
app.post('/api/verify-pin', (req, res) => {
  const { pin } = req.body || {};
  if (pin && pin === ADMIN_PIN) {
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Invalid PIN' });
});

// GET /api/status (Status query)
app.get('/api/status', (req, res) => {
  const key = req.headers['x-api-key'] || req.query.key;
  const pin = req.headers['x-admin-pin'] || req.query.pin;
  const isAuth = (key && key === API_KEY) || (pin && pin === ADMIN_PIN);

  res.json({
    status: waStatus,
    phone: isAuth ? connectedPhone : (waStatus === 'connected' ? 'Connected' : ''),
    qr: isAuth ? waQrBase64 : (waStatus === 'qr' ? 'PROTECTED_PIN_REQUIRED' : ''),
    uptime: Math.round(process.uptime()),
    antiSleep: true,
    protected: true
  });
});

// GET /api/health (Keep-Alive health check)
app.get('/api/health', (req, res) => {
  res.json({ ok: true, status: waStatus, uptime: Math.round(process.uptime()), antiSleep: true });
});

// POST /api/logout (Protected)
app.post('/api/logout', checkAuth, async (req, res) => {
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
    await executeTursoQuery("DELETE FROM settings WHERE key = 'baileys_cloud_auth'");
    setTimeout(initBaileys, 1000);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/recent-messages (Debug - shows last 50 inbound messages)
app.get('/api/recent-messages', checkAuth, (req, res) => {
  res.json({ ok: true, count: inboundLog.length, messages: inboundLog });
});

// POST /api/send (Send Text or Media - Protected)
app.post('/api/send', checkAuth, async (req, res) => {
  const { to, message, attachment } = req.body || {};
  if (!to || (!message && !attachment)) {
    return res.status(400).json({ error: "Missing 'to' or 'message' parameters" });
  }

  if (waStatus !== 'connected' || !waSock) {
    return res.status(503).json({ error: 'WhatsApp is not connected on gateway.' });
  }

  try {
    let target = String(to).trim();
    let jid;
    if (target.includes('@lid') || target.includes('@s.whatsapp.net')) {
      jid = target;
    } else {
      const digits = target.replace(/\D/g, '');
      if (digits.length > 13) {
        jid = `${digits}@lid`;
      } else {
        let cleanNumber = digits.length === 10 ? '91' + digits : digits;
        jid = `${cleanNumber}@s.whatsapp.net`;
      }
    }

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

    res.json({ ok: true, to: jid });
  } catch (err) {
    console.error('Error sending message:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/send-bulk (Rate-limited safe bulk sender - Protected)
app.post('/api/send-bulk', checkAuth, async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Messages must be a non-empty array.' });
  }

  if (waStatus !== 'connected' || !waSock) {
    return res.status(503).json({ error: 'WhatsApp is not connected.' });
  }

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
      const delay = Math.floor(Math.random() * 3000) + 3000;
      await new Promise(r => setTimeout(r, delay));
    }
    console.log('✅ Bulk messaging campaign completed.');
  })();
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('====================================================');
  console.log(`🚀 Tapowan Protected WhatsApp Gateway running on port ${PORT}`);
  console.log('🔒 Admin PIN Protection: ENABLED');
  console.log('⚡ Anti-Sleep Keep-Alive: ACTIVE');
  console.log('☁️ Turso Session Sync: ACTIVE');
  console.log('====================================================');
});
