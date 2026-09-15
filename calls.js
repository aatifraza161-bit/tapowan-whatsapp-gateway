/**
 * 🎙️ Real-Time VoIP Call & Audio Room Signaling Engine for Render (Persistent Node.js)
 * Provides ultra-low latency (<20ms) WebRTC signaling, in-memory state, and Turso DB persistence.
 */

const TURSO_URL = process.env.TURSO_DATABASE_URL || 'https://tapowan-v2-tapowan.aws-ap-south-1.turso.io';
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODkwOTIyMTUsImlkIjoiMDFhMDhlMzQtODMwMS03MDI0LTk5ZWQtMGQ0MmYwMGJiNjFlIiwia2lkIjoiVFRPdk5ISlFYZVAtX1FsNG9ZUXM4cTBTYXRiZzJ1UmVhYjlUbjFyem1tcyIsInJpZCI6ImVjNjc2YzExLTRhNGUtNGZhNi1hMTM1LTJmZDk4YTIxNzliMSJ9.RmzczPOvgV3Hd83byF7fMfQsCzlJnF8r9MCGtzTfZDj8k--VqtItniZN5GCiPfv4-dCEmDZaIWDGPOnM-EknDA';

async function executeTursoQuery(sql, args = []) {
  try {
    const formattedArgs = args.map(arg => {
      if (typeof arg === 'number') return Number.isInteger(arg) ? { type: 'integer', value: String(arg) } : { type: 'float', value: arg };
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
          { type: 'execute', stmt: { sql, args: formattedArgs } },
          { type: 'close' }
        ]
      })
    });
    return await res.json();
  } catch (err) {
    console.error('[Render VoIP] Turso query error:', err.message);
    return null;
  }
}

// ── In-Memory Fast Cache for Instant Sub-Millisecond Signaling ──
const activeCallsMap = new Map(); // call_id -> callObj
const activeRoomsMap = new Map(); // room_id -> roomObj
const groupSignalsMap = new Map(); // room_id -> array of signals

async function initVoiceCallTables() {
  try {
    await executeTursoQuery(`CREATE TABLE IF NOT EXISTS app_voice_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id TEXT UNIQUE,
      caller_id TEXT,
      caller_name TEXT,
      caller_role TEXT,
      caller_avatar TEXT,
      receiver_id TEXT,
      receiver_name TEXT,
      receiver_role TEXT,
      status TEXT DEFAULT 'initiating',
      offer_sdp TEXT,
      answer_sdp TEXT,
      caller_ice TEXT,
      receiver_ice TEXT,
      duration_sec INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    await executeTursoQuery(`CREATE TABLE IF NOT EXISTS app_voice_rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT UNIQUE,
      title TEXT,
      host_id TEXT,
      host_name TEXT,
      host_role TEXT,
      target_type TEXT,
      target_class TEXT,
      status TEXT DEFAULT 'active',
      participants TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ended_at DATETIME
    )`);

    console.log("✅ [Render VoIP] Voice Call tables verified successfully.");
  } catch (err) {
    console.error("[Render VoIP] Failed to initialize voice call tables:", err.message);
  }
}

initVoiceCallTables();

function isStudent(role) {
  const r = String(role || '').toLowerCase();
  return r === 'student' || r === 'parent';
}

function isTeacherOrStaff(role) {
  const r = String(role || '').toLowerCase();
  return r === 'teacher' || r === 'staff' || r === 'faculty' || r === 'principal' || r === 'administrator' || r === 'admin';
}

const crypto = require('crypto');

const FCM_SERVICE_ACCOUNT = {
  project_id: "tps-app-8dde5",
  client_email: "firebase-adminsdk-fbsvc@tps-app-8dde5.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDd+EiteRU4Dff3\nmNGqE5+DGkYKV2pCIGXIhV/eeVd2xosfTQKFpJb6s7udY1Lhpsu1sHyscKK6ZZFf\nfPrtF0GqWKZcewM27TMEgsx/o6f+WQSYx+d7jpf96ihJWPE4mIEBfhzeamJpRw21\ng03JUh6VyTyNXL0qNCmMGptCic7YvOUu7RIE0jopZYkcD0XhFNvhtdXi4txUpUXx\nbFqqL9HMcp4yMXvK3e9bJu0AFwR1izeKWcl37rjCJsfx86EGd7GDcKwp0+JebCtS\nwZIveQ1Pfbkdtgq3scwdwBlqfjoSLrDTwg0KxsoAzKPy0UJdvk7p0zU7gnHA7MSP\n6TsssoTTAgMBAAECggEAOnayQcqiDZ0UQkkkdAzuFxxc9U1X5endlSaX/SNtp5Gc\nxBZHA0c6IvcjA83M3zVM82J0PAEAw2KMGx/ygW7+My1dR/94dcedB+OhlD7ZORNe\nNBV3AWKp4s2BZexAwLzeQbPjS6uulvcJg9T9MHjqKF6UDdGu20ZY6Rd67FgavJfq\nY2SIYmHAztIwGj/EnShx8M6P7UbVdMgCXvE5dZeO9M2oY1Ts5Az9FUxOY5yT5OH/\nEhrLFeGrzucyZaTrNU84c63uK9p2yb8jfeNNmIeSYhEvRLboLDgsHTnO5n0+a4TJ\n5hMrV7XA1PxjZVAxacpZMsoy3Bj1US+4gFTcL2rM2QKBgQD9DRjNm1vFNOm0znXk\nsF0+eM6npkhlOOXjwwFZuWKP2Uld/XQw0GHiw8bwtQW8N4Ugk22OU2aMmQTJPy68\ntleT1KWDqa6jKBysUki5Qt1numLQn6sAV6qZw5n3LpdgCIQUNioqm4SXXjsbN0WA\n3FfnwH3Xg2dR2QSyGdz5l5VGKQKBgQDgjncU9mHFy8frV/IKILiyMPYtqwsut9OJ\nQss/uL+5URUMbqYMxX8M5+onI+whmBW1BWoU2swd02Gz/5wSku5t438G7VWfXwll\nMjAFgBjEadQBTFXgvG7buFyxqD7Iw3ZXnEPTS1Rud0ZBWXgfxQREuPhiAh0irVUH\nyiegQAX6mwKBgAxcFGcOfIgAUp3rK6T03EkN24IixAx1n/zk7G72eBLwmP3HQGKV\n+wH5cAEXxmTwDUePC93UwwCBBNPTizPacCKfU0pAAnCjp+rexgCOfIPxfZwVAGQu\n4/1IqX+CPhCJufHGx353RB2kk5x7saBeosiGBV9+YpCD2g/c5YcnWTopAoGBAK+/\nUHvbiRIhN0p9/jTm/yaXI1UCtTHPNYQL/r7UfVkwmGSuhM8iExmquJwBhWGVgge3\nQRspUu9U7PbPavsue+UNU/G79nNREi1dZjAn3Tp8CS0q7VuCntDgLcvtfZXrRMe0\nyXCpWF9MgnPK7jUPIRQYIG20cdEeD5qVIQZOlV9ZAoGBAKVUTqU8VKW4OLhI3umU\nfFiePOoZUcHqB/UFWhEPWNROSRVb7kZvkwLJ4jBD1zD2t2ZT8DXxENPwTLVqo3dN\ngLj3HfrzZAwUeMompY/sVty376F15mai+bQUX7yTgY0ah4XszW90hxxNkDyudoac\nRrhmGbNqG5Yzjyqbf52/0Z/d\n-----END PRIVATE KEY-----\n",
  token_uri: "https://oauth2.googleapis.com/token"
};

let cachedFcmToken = null;
let cachedFcmTokenExpiry = 0;

async function getFcmAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (cachedFcmToken && cachedFcmTokenExpiry > now + 60) {
    return cachedFcmToken;
  }
  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss: FCM_SERVICE_ACCOUNT.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: FCM_SERVICE_ACCOUNT.token_uri,
    exp: now + 3600,
    iat: now
  };

  const b64Header = Buffer.from(JSON.stringify(header)).toString('base64url');
  const b64Claim = Buffer.from(JSON.stringify(claimSet)).toString('base64url');
  const signatureInput = `${b64Header}.${b64Claim}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signatureInput);
  const signature = signer.sign(FCM_SERVICE_ACCOUNT.private_key, 'base64url');

  const jwt = `${signatureInput}.${signature}`;

  const res = await fetch(FCM_SERVICE_ACCOUNT.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });

  const data = await res.json();
  if (data.access_token) {
    cachedFcmToken = data.access_token;
    cachedFcmTokenExpiry = now + (data.expires_in || 3600);
    return cachedFcmToken;
  }
  return null;
}

/**
 * Send High-Priority Incoming Call Push Notification via Direct Firebase FCM v1 & Expo
 */
async function sendIncomingCallPush({ receiverId, receiverName, receiverRole, callerId, callerName, callerRole, callerAvatar, callId, offerSdp }) {
  try {
    const sReceiverId = String(receiverId || '').trim();
    const cleanId = sReceiverId
      .replace(/^student_/i, '')
      .replace(/^teacher_/i, '')
      .replace(/^EMP-/i, '')
      .trim();
    const cleanName = String(receiverName || '')
      .replace(/\s*\([^)]*\)/g, '')
      .replace(/👨‍🏫|👩‍🏫|📞/g, '')
      .trim();

    const idAliases = new Set([sReceiverId, cleanId, `EMP-${cleanId}`, `student_${cleanId}`]);
    if (/^\d+$/.test(cleanId)) {
      const num = parseInt(cleanId, 10);
      idAliases.add(String(num));
      idAliases.add(String(num).padStart(2, '0'));
      idAliases.add(String(num).padStart(3, '0'));
      idAliases.add(String(num).padStart(4, '0'));
      idAliases.add(`EMP-${num}`);
      idAliases.add(`EMP-${String(num).padStart(2, '0')}`);
    }
    if (cleanId.includes('/')) {
      const parts = cleanId.split('/');
      idAliases.add(cleanId.replace(/^0+/, ''));
      idAliases.add(cleanId.replace('/', ''));
      if (parts[0]) {
        idAliases.add(parts[0]);
        idAliases.add(parts[0].replace(/^0+/, ''));
        if (parts[1]) {
          idAliases.add(`${parts[0].replace(/^0+/, '')}/${parts[1]}`);
        }
      }
    }

    const aliasArr = [...idAliases].filter(Boolean);
    const isGenuineName = cleanName.length >= 3 && !['Student', 'Guest', 'Receiver', 'Faculty Member', 'School Contact', 'Faculty'].includes(cleanName);

    let tokens = [];

    // 1. Direct match on exact aliases in app_push_tokens
    const placeholders = aliasArr.map(() => '?').join(',');
    const directRes = await executeTursoQuery(
      `SELECT token, admission_no, student_name FROM app_push_tokens WHERE admission_no IN (${placeholders}) ORDER BY id DESC LIMIT 15`,
      aliasArr
    );
    const rows = directRes?.results?.[0]?.response?.result?.rows || [];
    tokens.push(...rows.map(r => r[0]?.value).filter(Boolean));

    // 2. Direct match on exact name if genuine
    if (isGenuineName) {
      const nameRes = await executeTursoQuery(
        `SELECT token, admission_no, student_name FROM app_push_tokens WHERE student_name = ? OR UPPER(student_name) = UPPER(?) ORDER BY id DESC LIMIT 10`,
        [cleanName, cleanName]
      );
      const nameRows = nameRes?.results?.[0]?.response?.result?.rows || [];
      tokens.push(...nameRows.map(r => r[0]?.value).filter(Boolean));
    }

    // 3. Relational Student Lookup (if receiver is a student or role unstated)
    if (receiverRole === 'student' || (!receiverRole && !sReceiverId.startsWith('EMP-'))) {
      const sRes = await executeTursoQuery(
        `SELECT id, admissionNo, phone, phone1, phone2, fullName FROM students 
         WHERE admissionNo IN (${placeholders}) OR CAST(id AS TEXT) IN (${placeholders}) OR phone = ? OR phone1 = ? OR fullName = ? OR UPPER(fullName) = UPPER(?) LIMIT 5`,
        [...aliasArr, ...aliasArr, cleanId, cleanId, cleanName, cleanName]
      );
      const sResultRows = sRes?.results?.[0]?.response?.result?.rows || [];
      const sCols = sRes?.results?.[0]?.response?.result?.cols || [];
      for (const sRow of sResultRows) {
        const s = {};
        sCols.forEach((c, idx) => { s[c.name] = sRow[idx]?.value; });
        const sAliases = [s.admissionNo, s.phone, s.phone1, s.phone2, String(s.id), s.fullName].filter(Boolean);
        const sPlaceholders = sAliases.map(() => '?').join(',');
        const sPushRes = await executeTursoQuery(
          `SELECT token, admission_no, student_name FROM app_push_tokens WHERE admission_no IN (${sPlaceholders}) OR student_name = ? ORDER BY id DESC LIMIT 10`,
          [...sAliases, s.fullName]
        );
        const sPushRows = sPushRes?.results?.[0]?.response?.result?.rows || [];
        tokens.push(...sPushRows.map(r => r[0]?.value).filter(Boolean));
      }
    }

    // 4. Relational Teacher Lookup (if receiver is a teacher or role is teacher/staff)
    if (receiverRole === 'teacher' || (!receiverRole && sReceiverId.startsWith('EMP-'))) {
      const tRes = await executeTursoQuery(
        `SELECT id, employeeNo, phone, fullName FROM teachers 
         WHERE id = ? OR employeeNo = ? OR ('EMP-' || employeeNo) = ? OR ('EMP-' || id) = ? OR phone = ? OR fullName = ? OR UPPER(fullName) = UPPER(?) LIMIT 5`,
        [cleanId, cleanId, sReceiverId, sReceiverId, cleanId, cleanName, cleanName]
      );
      const tResultRows = tRes?.results?.[0]?.response?.result?.rows || [];
      const tCols = tRes?.results?.[0]?.response?.result?.cols || [];
      for (const tRow of tResultRows) {
        const t = {};
        tCols.forEach((c, idx) => { t[c.name] = tRow[idx]?.value; });
        const tAliases = [
          String(t.id),
          `EMP-${t.id}`,
          String(t.employeeNo),
          `EMP-${t.employeeNo}`,
          t.phone,
          t.fullName
        ].filter(Boolean);
        const tPlaceholders = tAliases.map(() => '?').join(',');
        const tPushRes = await executeTursoQuery(
          `SELECT token, admission_no, student_name FROM app_push_tokens WHERE admission_no IN (${tPlaceholders}) OR student_name = ? ORDER BY id DESC LIMIT 10`,
          [...tAliases, t.fullName]
        );
        const tPushRows = tPushRes?.results?.[0]?.response?.result?.rows || [];
        tokens.push(...tPushRows.map(r => r[0]?.value).filter(Boolean));
      }
    }

    // 5. Active Student Sessions fallback
    if (tokens.length === 0 && receiverRole !== 'teacher') {
      const sessRes = await executeTursoQuery(
        `SELECT admission_no, phone, student_name FROM app_student_sessions 
         WHERE admission_no IN (${placeholders}) OR phone = ? OR student_name = ? OR UPPER(student_name) = UPPER(?) LIMIT 5`,
        [...aliasArr, cleanId, cleanName, cleanName]
      );
      const sessResultRows = sessRes?.results?.[0]?.response?.result?.rows || [];
      const sessCols = sessRes?.results?.[0]?.response?.result?.cols || [];
      for (const sessRow of sessResultRows) {
        const sess = {};
        sessCols.forEach((c, idx) => { sess[c.name] = sessRow[idx]?.value; });
        const sessAliases = [sess.admission_no, sess.phone, sess.student_name].filter(Boolean);
        const sessPlaceholders = sessAliases.map(() => '?').join(',');
        const sessPushRes = await executeTursoQuery(
          `SELECT token, admission_no, student_name FROM app_push_tokens WHERE admission_no IN (${sessPlaceholders}) OR student_name = ? ORDER BY id DESC LIMIT 10`,
          [...sessAliases, sess.student_name]
        );
        const sessPushRows = sessPushRes?.results?.[0]?.response?.result?.rows || [];
        tokens.push(...sessPushRows.map(r => r[0]?.value).filter(Boolean));
      }
    }

    // Exclude caller's own push tokens to prevent caller ringing themselves
    const sCallerId = String(callerId || '').trim();
    if (sCallerId) {
      try {
        const callerClean = sCallerId.replace(/^EMP-/i, '').trim();
        const callerRes = await executeTursoQuery(
          `SELECT token FROM app_push_tokens WHERE admission_no = ? OR admission_no = ? OR admission_no = ? OR student_name = ?`,
          [sCallerId, callerClean, `EMP-${callerClean}`, callerName || '']
        );
        const callerRows = callerRes?.results?.[0]?.response?.result?.rows || [];
        const callerTokens = new Set(callerRows.map(r => r[0]?.value).filter(Boolean));
        tokens = tokens.filter(t => !callerTokens.has(t));
      } catch (e) {}
    }

    const uniqueTokens = [...new Set(tokens)];
    if (uniqueTokens.length === 0) {
      console.log(`[Render VoIP] No push token found for receiver: ${sReceiverId} (${cleanName})`);
      return;
    }

    console.log(`[Render VoIP] Dispatching call push to ${uniqueTokens.length} token(s) for ${cleanName}`);

    // Direct Google Firebase FCM v1 Delivery for native Android tokens
    const fcmTokens = uniqueTokens.filter(t => !t.startsWith('ExponentPushToken'));
    if (fcmTokens.length > 0) {
      try {
        const accessToken = await getFcmAccessToken();
        if (accessToken) {
          const fcmPromises = fcmTokens.map(async (token) => {
            try {
              const fcmData = {
                title: `${callerName}`,
                message: `📞 Incoming voice call`,
                body: `📞 Incoming voice call`,
                channelId: 'calls',
                categoryId: 'call_incoming',
                categoryIdentifier: 'call_incoming',
                _category: 'call_incoming',
                type: 'INCOMING_CALL',
                callId: callId,
                callerId: String(callerId || ''),
                callerName: callerName,
                callerRole: callerRole,
                callerAvatar: callerAvatar || '',
                sound: 'default',
                vibrate: '[0, 800, 500, 800, 500, 800]'
              };
              if (offerSdp && typeof offerSdp === 'string' && offerSdp.length < 3200) {
                fcmData.offerSdp = offerSdp;
              }

              const fcmRes = await fetch(`https://fcm.googleapis.com/v1/projects/${FCM_SERVICE_ACCOUNT.project_id}/messages:send`, {
                method: 'POST',
                headers: {
                  'Authorization': 'Bearer ' + accessToken,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  message: {
                    token: token,
                    android: {
                      priority: 'HIGH',
                      ttl: '60s'
                    },
                    data: fcmData
                  }
                })
              });
              if (fcmRes.status === 200) {
                console.log(`[FCM v1] Direct call push sent to token ${token.substring(0, 15)}...`);
              } else if (fcmRes.status === 404) {
                console.log(`[FCM v1] Dead token (404) -> removing ${token.substring(0, 15)}...`);
                executeTursoQuery('DELETE FROM app_push_tokens WHERE token = ?', [token]).catch(() => {});
              } else {
                const errTxt = await fcmRes.text();
                console.log(`[FCM v1] Response ${fcmRes.status}:`, errTxt);
              }
            } catch (e) {
              console.log('[FCM v1] Push error:', e.message);
            }
          });
          await Promise.all(fcmPromises);
        }
      } catch (e) {
        console.log('[FCM v1] Access token error:', e.message);
      }
    }

    // Expo Push Service Delivery for ExponentPushTokens
    const expoTokens = uniqueTokens.filter(t => t.startsWith('ExponentPushToken'));
    if (expoTokens.length > 0) {
      const messages = expoTokens.map(token => ({
        to: token,
        sound: 'default',
        title: `${callerName}`,
        body: `📞 Incoming voice call`,
        channelId: 'calls',
        priority: 'high',
        categoryId: 'call_incoming',
        categoryIdentifier: 'call_incoming',
        _category: 'call_incoming',
        badge: 1,
        ttl: 60,
        data: {
          type: 'INCOMING_CALL',
          categoryId: 'call_incoming',
          categoryIdentifier: 'call_incoming',
          callId: callId,
          callerId: String(callerId || ''),
          callerName: callerName,
          callerRole: callerRole,
          callerAvatar: callerAvatar,
          ...(offerSdp && typeof offerSdp === 'string' && offerSdp.length < 3200 ? { offerSdp } : {})
        },
        _displayInForeground: true
      }));

      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Accept-encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(messages),
      }).catch(() => {});
    }
  } catch (err) {
    console.log('[Render VoIP] Push notification error:', err.message);
  }
}

/**
 * 1. Initiate 1-on-1 Voice Call
 */
async function initiateCall({ callerId, callerName, callerRole, callerAvatar, receiverId, receiverName, receiverRole, receiverAvatar, offerSdp }) {
  if (!callerId || !receiverId) {
    return { ok: false, status: 400, error: "Missing callerId or receiverId" };
  }

  // Block student to student calls
  if (isStudent(callerRole) && isStudent(receiverRole)) {
    return {
      ok: false,
      status: 403,
      error: "Direct voice calls between students are strictly disabled by school policy."
    };
  }

  const callId = "CALL_" + Date.now() + "_" + Math.random().toString(36).substring(2, 7);
  const now = new Date().toISOString();

  const callRecord = {
    call_id: callId,
    caller_id: String(callerId),
    caller_name: callerName || 'Caller',
    caller_role: callerRole || 'student',
    caller_avatar: callerAvatar || '',
    receiver_id: String(receiverId),
    receiver_name: receiverName || 'Receiver',
    receiver_role: receiverRole || 'teacher',
    receiver_avatar: receiverAvatar || '',
    status: 'ringing',
    offer_sdp: offerSdp || null,
    answer_sdp: null,
    caller_ice: '[]',
    receiver_ice: '[]',
    duration_sec: 0,
    created_at: now,
    updated_at: now
  };

  activeCallsMap.set(callId, callRecord);

  // Send push notification to wake receiver
  await sendIncomingCallPush({
    receiverId: callRecord.receiver_id,
    receiverName: callRecord.receiver_name,
    receiverRole: callRecord.receiver_role,
    callerId: callRecord.caller_id,
    callerName: callRecord.caller_name,
    callerRole: callRecord.caller_role,
    callerAvatar: callRecord.caller_avatar,
    callId: callRecord.call_id,
    offerSdp: offerSdp || null
  }).catch(() => {});

  // Async persist to Turso DB
  executeTursoQuery(`INSERT INTO app_voice_calls (
    call_id, caller_id, caller_name, caller_role, caller_avatar, 
    receiver_id, receiver_name, receiver_role, status, offer_sdp, caller_ice, receiver_ice
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    callRecord.call_id, callRecord.caller_id, callRecord.caller_name, callRecord.caller_role, callRecord.caller_avatar,
    callRecord.receiver_id, callRecord.receiver_name, callRecord.receiver_role, callRecord.status,
    callRecord.offer_sdp, callRecord.caller_ice, callRecord.receiver_ice
  ]).catch(e => console.error("[Render VoIP] DB insert error:", e.message));

  return { ok: true, callId, call: callRecord };
}

/**
 * 2. Respond to 1-on-1 Call (Accept / Decline / Busy)
 */
async function respondCall({ callId, userId, action, answerSdp }) {
  if (!callId || !action) return { ok: false, status: 400, error: "Missing callId or action" };

  let call = activeCallsMap.get(callId);
  try {
    const res = await executeTursoQuery("SELECT * FROM app_voice_calls WHERE call_id = ? LIMIT 1", [callId]);
    const row = res?.results?.[0]?.response?.result?.rows?.[0];
    if (row) {
      const cols = res.results[0].response.result.cols.map(c => c.name);
      const dbCall = {};
      cols.forEach((col, idx) => { dbCall[col] = row[idx]?.value; });
      call = { ...(call || {}), ...dbCall };
    }
  } catch (e) {}

  if (!call) return { ok: false, status: 404, error: "Call not found" };

  const now = new Date().toISOString();
  if (action === 'accept') {
    call.status = 'connected';
    if (answerSdp) call.answer_sdp = answerSdp;
  } else if (action === 'decline') {
    call.status = 'declined';
  } else if (action === 'busy') {
    call.status = 'busy';
  }
  call.updated_at = now;
  activeCallsMap.set(callId, call);

  executeTursoQuery("UPDATE app_voice_calls SET status = ?, answer_sdp = COALESCE(?, answer_sdp), updated_at = ? WHERE call_id = ?", [
    call.status, answerSdp || null, now, callId
  ]).catch(() => {});

  return { ok: true, call };
}

// ── In-Memory Accumulated ICE Candidates Map (Prevents Race-Condition Overwrites) ──
const callCandidatesStore = new Map(); // call_id -> { caller: Map<string, object>, receiver: Map<string, object> }

/**
 * 3. Send WebRTC Signal (SDP or ICE Candidates)
 */
async function sendCallSignal({ callId, senderId, offerSdp, answerSdp, iceCandidate, iceCandidates, isCaller }) {
  if (!callId) return { ok: false, status: 400, error: "Missing callId" };

  let call = activeCallsMap.get(callId);
  try {
    const res = await executeTursoQuery("SELECT * FROM app_voice_calls WHERE call_id = ? LIMIT 1", [callId]);
    const row = res?.results?.[0]?.response?.result?.rows?.[0];
    if (row) {
      const cols = res.results[0].response.result.cols.map(c => c.name);
      const dbCall = {};
      cols.forEach((col, idx) => { dbCall[col] = row[idx]?.value; });
      call = { ...(call || {}), ...dbCall };
    }
  } catch (e) {}

  if (!call) return { ok: false, status: 404, error: "Call not found" };

  if (offerSdp) call.offer_sdp = offerSdp;
  if (answerSdp) call.answer_sdp = answerSdp;

  // Initialize or retrieve in-memory candidate store
  if (!callCandidatesStore.has(callId)) {
    callCandidatesStore.set(callId, {
      caller: new Map(),
      receiver: new Map()
    });
  }
  const store = callCandidatesStore.get(callId);

  // Hydrate store from existing DB record if in-memory set is empty
  if (store.caller.size === 0 && call.caller_ice) {
    try {
      const parsed = typeof call.caller_ice === 'string' ? JSON.parse(call.caller_ice) : call.caller_ice;
      if (Array.isArray(parsed)) {
        parsed.forEach(c => {
          if (c?.candidate) store.caller.set(c.candidate, c);
        });
      }
    } catch (e) {}
  }
  if (store.receiver.size === 0 && call.receiver_ice) {
    try {
      const parsed = typeof call.receiver_ice === 'string' ? JSON.parse(call.receiver_ice) : call.receiver_ice;
      if (Array.isArray(parsed)) {
        parsed.forEach(c => {
          if (c?.candidate) store.receiver.set(c.candidate, c);
        });
      }
    } catch (e) {}
  }

  // Ingest incoming candidate(s)
  const incomingList = [];
  if (Array.isArray(iceCandidates)) incomingList.push(...iceCandidates);
  if (iceCandidate) incomingList.push(iceCandidate);

  if (incomingList.length > 0) {
    const targetMap = isCaller ? store.caller : store.receiver;
    for (const cand of incomingList) {
      if (!cand) continue;
      let candObj = cand;
      if (typeof candObj === 'string') {
        try { candObj = JSON.parse(candObj); } catch (e) {}
      }
      const key = candObj?.candidate || (typeof candObj === 'string' ? candObj : JSON.stringify(candObj));
      if (key) {
        targetMap.set(key, candObj);
      }
    }
  }

  const callerIceStr = JSON.stringify(Array.from(store.caller.values()));
  const receiverIceStr = JSON.stringify(Array.from(store.receiver.values()));
  const now = new Date().toISOString();

  call.caller_ice = callerIceStr;
  call.receiver_ice = receiverIceStr;
  call.updated_at = now;
  activeCallsMap.set(callId, call);

  executeTursoQuery(`UPDATE app_voice_calls SET 
    offer_sdp = COALESCE(?, offer_sdp), 
    answer_sdp = COALESCE(?, answer_sdp), 
    caller_ice = ?, 
    receiver_ice = ?, 
    updated_at = ? 
    WHERE call_id = ?`, [
    call.offer_sdp || null, call.answer_sdp || null, callerIceStr, receiverIceStr, now, callId
  ]).catch(() => {});

  return { ok: true, call };
}

async function sendCallEndedPush({ receiverId, receiverName, callId }) {
  try {
    const sReceiverId = String(receiverId || '').trim();
    const rawId = sReceiverId.replace('EMP-', '');

    const tokens = [];
    const directRes = await executeTursoQuery(
      "SELECT token FROM app_push_tokens WHERE admission_no = ? OR admission_no = ? ORDER BY id DESC LIMIT 5",
      [sReceiverId, rawId]
    );
    tokens.push(...(directRes?.results?.[0]?.response?.result?.rows || []).map(r => r[0]?.value).filter(Boolean));

    const uniqueTokens = [...new Set(tokens)];
    if (uniqueTokens.length === 0) return;

    const fcmTokens = uniqueTokens.filter(t => !t.startsWith('ExponentPushToken'));
    if (fcmTokens.length > 0) {
      try {
        const accessToken = await getFcmAccessToken();
        if (accessToken) {
          const endPromises = fcmTokens.map(async (token) => {
            try {
              await fetch(`https://fcm.googleapis.com/v1/projects/${FCM_SERVICE_ACCOUNT.project_id}/messages:send`, {
                method: 'POST',
                headers: {
                  'Authorization': 'Bearer ' + accessToken,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  message: {
                    token: token,
                    android: {
                      priority: 'HIGH',
                      ttl: '30s'
                    },
                    data: {
                      type: 'CALL_ENDED',
                      callId: callId
                    }
                  }
                })
              });
            } catch (e) {}
          });
          await Promise.all(endPromises);
        }
      } catch (e) {}
    }
  } catch (err) {
    console.log('[Render VoIP] sendCallEndedPush error:', err.message);
  }
}

/**
 * 4. End 1-on-1 Voice Call
 */
async function endCall({ callId, durationSec = 0 }) {
  if (!callId) return { ok: false, status: 400, error: "Missing callId" };

  let call = activeCallsMap.get(callId);
  const wasRinging = call?.status === 'ringing';
  if (call) {
    call.status = 'ended';
    call.duration_sec = durationSec || call.duration_sec || 0;
    call.updated_at = new Date().toISOString();
  }

  if (wasRinging && call?.receiver_id) {
    await sendCallEndedPush({
      receiverId: call.receiver_id,
      receiverName: call.receiver_name,
      callId: callId
    }).catch(() => {});
  }

  executeTursoQuery("UPDATE app_voice_calls SET status = 'ended', duration_sec = ?, updated_at = CURRENT_TIMESTAMP WHERE call_id = ?", [
    durationSec || 0, callId
  ]).catch(() => {});

  setTimeout(() => activeCallsMap.delete(callId), 15000);

  return { ok: true, message: "Call ended successfully" };
}

/**
 * 5. Poll Calls for User (Instant In-Memory Lookup on Render)
 */
async function pollUserCalls({ userId, userRole, className, admissionNo, phone, fullName, activeCallId }) {
  if (!userId && !admissionNo && !phone) return { ok: false, status: 400, error: "Missing userId" };

  const sUserId = String(userId || '').trim();
  const sAdm = String(admissionNo || '').trim();
  const sPhone = String(phone || '').trim();
  const sActiveCallId = String(activeCallId || '').trim();
  const sFullName = String(fullName || '').trim();

  const isUserTeacher = isTeacherOrStaff(userRole);
  const isUserStudent = isStudent(userRole) || (!isUserTeacher && !sUserId.startsWith('EMP-'));

  const possibleIds = new Set([
    sUserId,
    sAdm,
    sPhone,
    sUserId.replace('EMP-', ''),
    `EMP-${sUserId.replace('EMP-', '')}`,
    sAdm.replace('EMP-', ''),
    `EMP-${sAdm.replace('EMP-', '')}`
  ].filter(Boolean));

  // Expand teacher and student aliases STRICTLY by role to prevent shared phone number collisions
  const rawId = sUserId.replace('EMP-', '').trim();
  if (isUserTeacher) {
    // Only expand teacher aliases for teacher users!
    try {
      const tLookup = await executeTursoQuery(
        `SELECT id, employeeNo, phone, fullName FROM teachers 
         WHERE id = ? OR employeeNo = ? OR ('EMP-' || employeeNo) = ? OR ('EMP-' || id) = ? OR phone = ? OR fullName = ? LIMIT 1`,
        [rawId, rawId, sUserId, sUserId, sPhone || rawId, sFullName || '']
      );
      const tRow = tLookup?.results?.[0]?.response?.result?.rows?.[0];
      if (tRow) {
        const tId = String(tRow[0]?.value || '');
        const tEmpNo = String(tRow[1]?.value || '');
        const tPhone = String(tRow[2]?.value || '');
        const tName = String(tRow[3]?.value || '');
        [tId, `EMP-${tId}`, tEmpNo, `EMP-${tEmpNo}`, tPhone, tName].filter(Boolean).forEach(id => possibleIds.add(id));
      }
    } catch(e) {}
  } else {
    // Only expand student aliases for student users!
    try {
      const sLookup = await executeTursoQuery(
        `SELECT id, admissionNo, phone, fullName FROM students 
         WHERE admissionNo = ? OR CAST(id AS TEXT) = ? OR phone = ? LIMIT 1`,
        [sAdm || rawId, rawId, sPhone || rawId]
      );
      const sRow = sLookup?.results?.[0]?.response?.result?.rows?.[0];
      if (sRow) {
        const sId = String(sRow[0]?.value || '');
        const sAdmNo = String(sRow[1]?.value || '');
        const sPh = String(sRow[2]?.value || '');
        const sName = String(sRow[3]?.value || '');
        [sId, sAdmNo, sPh, sName].filter(Boolean).forEach(id => possibleIds.add(id));
      }
    } catch(e) {}
  }

  let incomingCall = null;
  let activeCall = null;
  const nowMs = Date.now();

  // 1. Instant RAM Lookup
  for (const call of activeCallsMap.values()) {
    const recId = String(call.receiver_id || '').trim();
    const callerId = String(call.caller_id || '').trim();

    let isReceiver = possibleIds.has(recId);
    if (!isReceiver && call.receiver_name && sFullName && String(call.receiver_name).trim().toLowerCase() === sFullName.toLowerCase()) {
      isReceiver = true;
    }

    // Role-aware caller identification (teacher calling student is NEVER a self-call)
    let isCaller = false;
    if (isUserTeacher && call.caller_role === 'teacher') {
      isCaller = possibleIds.has(callerId);
    } else if (isUserStudent && call.caller_role === 'student') {
      isCaller = possibleIds.has(callerId);
    } else if (!userRole) {
      isCaller = possibleIds.has(callerId) && !isReceiver;
    }

    let ageMs = 0;
    if (call.created_at) {
      ageMs = nowMs - new Date(call.created_at).getTime();
    }

    // Incoming call: strictly receiver only, ringing status, age < 45s, not self
    if (isReceiver && !isCaller && call.status === 'ringing' && ageMs < 45000 && !incomingCall) {
      incomingCall = call;
    }

    // Active call:
    if (sActiveCallId && call.call_id === sActiveCallId) {
      activeCall = call;
    } else if (!sActiveCallId && (isCaller || isReceiver)) {
      if ((call.status === 'connected' || call.status === 'ringing') && ageMs < 120000 && !activeCall) {
        activeCall = call;
      }
    }
  }

  // 2. Authoritative DB lookup if activeCallId requested (refresh from DB if not in RAM or still ringing or missing answer)
  if (sActiveCallId && (!activeCall || activeCall.status === 'ringing' || !activeCall.answer_sdp)) {
    try {
      const res = await executeTursoQuery(
        `SELECT * FROM app_voice_calls WHERE call_id = ? LIMIT 1`,
        [sActiveCallId]
      );
      const rows = res?.results?.[0]?.response?.result?.rows || [];
      if (rows.length > 0) {
        const cols = res.results[0].response.result.cols.map(c => c.name);
        const row = {};
        cols.forEach((col, idx) => { row[col] = rows[0][idx]?.value; });
        activeCallsMap.set(row.call_id, row);
        activeCall = row;
      }
    } catch (e) {}
  }

  // 3. Fallback DB lookup for ringing incoming calls if none in RAM
  if (!incomingCall && !activeCall && !sActiveCallId) {
    try {
      const idArray = Array.from(possibleIds);
      const placeholders = idArray.map(() => '?').join(',');
      const res = await executeTursoQuery(
        `SELECT * FROM app_voice_calls 
         WHERE (receiver_id IN (${placeholders}) OR receiver_name = ?)
           AND status = 'ringing'
         ORDER BY id DESC LIMIT 1`,
        [...idArray, sFullName || '']
      );
      const rows = res?.results?.[0]?.response?.result?.rows || [];
      if (rows.length > 0) {
        const cols = res.results[0].response.result.cols.map(c => c.name);
        const row = {};
        cols.forEach((col, idx) => { row[col] = rows[0][idx]?.value; });
        const callAge = nowMs - new Date(row.created_at || row.updated_at || Date.now()).getTime();
        const isSelfCall = (isUserTeacher && row.caller_role === 'teacher' && possibleIds.has(String(row.caller_id))) ||
                           (isUserStudent && row.caller_role === 'student' && possibleIds.has(String(row.caller_id)));
        if (callAge < 45000 && !isSelfCall) {
          activeCallsMap.set(row.call_id, row);
          incomingCall = row;
          activeCall = row;
        }
      }
    } catch (e) {}
  }

  // 4. Check for active class group voice room
  let activeClassRoom = null;
  if (className || userRole) {
    for (const room of activeRoomsMap.values()) {
      if (room.status === 'active') {
        if (room.target_type === 'class' && room.target_class === className) {
          activeClassRoom = room;
          break;
        }
        if (room.target_type === 'staff' && isTeacherOrStaff(userRole)) {
          activeClassRoom = room;
          break;
        }
      }
    }
  }

  // Ensure activeCall has all in-memory accumulated candidates
  if (activeCall && callCandidatesStore.has(activeCall.call_id)) {
    const store = callCandidatesStore.get(activeCall.call_id);
    if (store.caller.size > 0) {
      activeCall.caller_ice = JSON.stringify(Array.from(store.caller.values()));
    }
    if (store.receiver.size > 0) {
      activeCall.receiver_ice = JSON.stringify(Array.from(store.receiver.values()));
    }
  }

  return {
    ok: true,
    incomingCall,
    activeCall,
    activeGroupRoom: activeClassRoom
  };
}

/**
 * 6. Create Group Room (Teacher Hosted)
 */
async function createGroupRoom({ hostId, hostName, hostRole, title, targetType = 'class', targetClass = '' }) {
  if (!hostId || !hostName) return { ok: false, status: 400, error: "Missing host details" };

  if (!isTeacherOrStaff(hostRole)) {
    return { ok: false, status: 403, error: "Only teachers and staff can host class voice sessions." };
  }

  const roomId = "ROOM_" + Date.now() + "_" + Math.random().toString(36).substring(2, 6);
  const now = new Date().toISOString();

  const initialParticipants = [
    {
      id: String(hostId),
      name: hostName,
      role: hostRole,
      isHost: true,
      isMuted: false,
      handRaised: false,
      joinedAt: now
    }
  ];

  const roomObj = {
    room_id: roomId,
    title: title || ((targetClass || 'Class') + ' Voice Session'),
    host_id: String(hostId),
    host_name: hostName,
    host_role: hostRole,
    target_type: targetType,
    target_class: targetClass || '',
    status: 'active',
    participants: initialParticipants,
    created_at: now
  };

  activeRoomsMap.set(roomId, roomObj);
  groupSignalsMap.set(roomId, []);

  executeTursoQuery(`INSERT INTO app_voice_rooms (
    room_id, title, host_id, host_name, host_role, target_type, target_class, status, participants
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`, [
    roomId, roomObj.title, roomObj.host_id, roomObj.host_name, roomObj.host_role, roomObj.target_type, roomObj.target_class, JSON.stringify(initialParticipants)
  ]).catch(() => {});

  return { ok: true, roomId, room: roomObj };
}

/**
 * 7. Join Group Room
 */
async function joinGroupRoom({ roomId, participantId, participantName, participantRole, participantAvatar }) {
  if (!roomId || !participantId) return { ok: false, status: 400, error: "Missing details" };

  const room = activeRoomsMap.get(roomId);
  if (!room || room.status !== 'active') {
    return { ok: false, status: 404, error: "Active class voice session not found." };
  }

  const sPartId = String(participantId);
  const exists = room.participants.find(p => String(p.id) === sPartId);
  if (!exists) {
    room.participants.push({
      id: sPartId,
      name: participantName || 'Student',
      role: participantRole || 'student',
      avatar: participantAvatar || '',
      isHost: String(room.host_id) === sPartId,
      isMuted: false,
      handRaised: false,
      joinedAt: new Date().toISOString()
    });
  }

  activeRoomsMap.set(roomId, room);
  executeTursoQuery("UPDATE app_voice_rooms SET participants = ? WHERE room_id = ?", [
    JSON.stringify(room.participants), roomId
  ]).catch(() => {});

  return { ok: true, room };
}

/**
 * 8. Leave Group Room
 */
async function leaveGroupRoom({ roomId, participantId }) {
  if (!roomId || !participantId) return { ok: false, status: 400, error: "Missing details" };

  const sPartId = String(participantId);
  const room = activeRoomsMap.get(roomId);
  if (room) {
    room.participants = room.participants.filter(p => String(p.id) !== sPartId);
    if (String(room.host_id) === sPartId || room.participants.length === 0) {
      room.status = 'ended';
      executeTursoQuery("UPDATE app_voice_rooms SET status = 'ended', ended_at = CURRENT_TIMESTAMP WHERE room_id = ?", [roomId]).catch(() => {});
    } else {
      executeTursoQuery("UPDATE app_voice_rooms SET participants = ? WHERE room_id = ?", [JSON.stringify(room.participants), roomId]).catch(() => {});
    }
  }

  return { ok: true };
}

/**
 * 9. Host Ends Group Room
 */
async function endGroupRoom({ roomId, hostId }) {
  if (!roomId) return { ok: false, status: 400, error: "Missing roomId" };

  const room = activeRoomsMap.get(roomId);
  if (room) room.status = 'ended';

  executeTursoQuery("UPDATE app_voice_rooms SET status = 'ended', ended_at = CURRENT_TIMESTAMP WHERE room_id = ?", [roomId]).catch(() => {});
  activeRoomsMap.delete(roomId);
  groupSignalsMap.delete(roomId);

  return { ok: true, message: "Group voice room ended" };
}

/**
 * 10. Send Group Signal (Mesh WebRTC)
 */
async function sendGroupSignal({ roomId, fromId, toId, signalType, signalData }) {
  if (!roomId || !fromId) return { ok: false, status: 400, error: "Missing signal data" };

  let signals = groupSignalsMap.get(roomId) || [];
  signals.push({
    id: Date.now() + Math.random(),
    roomId,
    fromId: String(fromId),
    toId: toId ? String(toId) : null,
    signalType,
    signalData,
    createdAt: Date.now()
  });

  if (signals.length > 100) signals = signals.slice(-100);
  groupSignalsMap.set(roomId, signals);

  return { ok: true };
}

/**
 * 11. Poll Group Room
 */
async function pollGroupRoom({ roomId, participantId, since = 0 }) {
  if (!roomId || !participantId) return { ok: false, status: 400, error: "Missing parameters" };

  const sPartId = String(participantId);
  const room = activeRoomsMap.get(roomId);
  const allSignals = groupSignalsMap.get(roomId) || [];
  const relevantSignals = allSignals.filter(s => 
    s.createdAt > since &&
    s.fromId !== sPartId &&
    (!s.toId || s.toId === sPartId)
  );

  return {
    ok: true,
    room: room || { status: 'ended' },
    signals: relevantSignals,
    now: Date.now()
  };
}

module.exports = {
  initVoiceCallTables,
  initiateCall,
  respondCall,
  sendCallSignal,
  endCall,
  pollUserCalls,
  createGroupRoom,
  joinGroupRoom,
  leaveGroupRoom,
  endGroupRoom,
  sendGroupSignal,
  pollGroupRoom
};
