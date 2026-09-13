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
          { type: 'execute', stmt: { sql, args: formattedArgs } }
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

/**
 * Send High-Priority Incoming Call Push Notification via Expo
 */
async function sendIncomingCallPush({ receiverId, receiverName, callerId, callerName, callerRole, callerAvatar, callId }) {
  try {
    const sReceiverId = String(receiverId || '').trim();
    const rawId = sReceiverId.replace('EMP-', '');

    const res = await executeTursoQuery(
      `SELECT token FROM app_push_tokens 
       WHERE admission_no = ? 
          OR admission_no = ? 
          OR admission_no = ?
       ORDER BY id DESC LIMIT 10`,
      [sReceiverId, rawId, `EMP-${rawId}`]
    );

    const rows = res?.results?.[0]?.response?.result?.rows || [];
    const tokens = [...new Set(rows.map(r => r[0]?.value).filter(t => t && t.startsWith('ExponentPushToken')))];
    if (tokens.length === 0) return;

    const messages = tokens.map(token => ({
      to: token,
      sound: 'default',
      title: `📞 Incoming Voice Call: ${callerName}`,
      body: `${callerRole === 'teacher' ? '👨‍🏫 Faculty Member' : '🎓 Student'} is calling you. Tap to open and answer.`,
      channelId: 'calls',
      priority: 'high',
      badge: 1,
      data: {
        type: 'INCOMING_CALL',
        callId: callId,
        callerId: String(callerId || ''),
        callerName: callerName,
        callerRole: callerRole,
        callerAvatar: callerAvatar
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
    });
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
  sendIncomingCallPush({
    receiverId: callRecord.receiver_id,
    receiverName: callRecord.receiver_name,
    callerId: callRecord.caller_id,
    callerName: callRecord.caller_name,
    callerRole: callRecord.caller_role,
    callerAvatar: callRecord.caller_avatar,
    callId: callRecord.call_id
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
  if (!call) {
    const res = await executeTursoQuery("SELECT * FROM app_voice_calls WHERE call_id = ? LIMIT 1", [callId]);
    const row = res?.results?.[0]?.response?.result?.rows?.[0];
    if (row) {
      const cols = res.results[0].response.result.cols.map(c => c.name);
      call = {};
      cols.forEach((col, idx) => { call[col] = row[idx]?.value; });
    }
  }

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

/**
 * 3. Send WebRTC Signal (SDP or ICE Candidates)
 */
async function sendCallSignal({ callId, senderId, offerSdp, answerSdp, iceCandidate, isCaller }) {
  if (!callId) return { ok: false, status: 400, error: "Missing callId" };

  let call = activeCallsMap.get(callId);
  if (!call) {
    const res = await executeTursoQuery("SELECT * FROM app_voice_calls WHERE call_id = ? LIMIT 1", [callId]);
    const row = res?.results?.[0]?.response?.result?.rows?.[0];
    if (row) {
      const cols = res.results[0].response.result.cols.map(c => c.name);
      call = {};
      cols.forEach((col, idx) => { call[col] = row[idx]?.value; });
    }
  }

  if (!call) return { ok: false, status: 404, error: "Call not found" };

  if (offerSdp) call.offer_sdp = offerSdp;
  if (answerSdp) call.answer_sdp = answerSdp;

  if (iceCandidate) {
    const key = isCaller ? 'caller_ice' : 'receiver_ice';
    let currentIce = [];
    try {
      currentIce = typeof call[key] === 'string' ? JSON.parse(call[key] || '[]') : (call[key] || []);
    } catch (e) {
      currentIce = [];
    }
    if (!Array.isArray(currentIce)) currentIce = [];

    const candStr = JSON.stringify(iceCandidate);
    if (!currentIce.some(existing => JSON.stringify(existing) === candStr)) {
      currentIce.push(iceCandidate);
    }
    call[key] = JSON.stringify(currentIce);
  }

  call.updated_at = new Date().toISOString();
  activeCallsMap.set(callId, call);

  executeTursoQuery(`UPDATE app_voice_calls SET 
    offer_sdp = COALESCE(?, offer_sdp), 
    answer_sdp = COALESCE(?, answer_sdp), 
    caller_ice = ?, 
    receiver_ice = ?, 
    updated_at = ? 
    WHERE call_id = ?`, [
    call.offer_sdp || null, call.answer_sdp || null, call.caller_ice, call.receiver_ice, call.updated_at, callId
  ]).catch(() => {});

  return { ok: true, call };
}

/**
 * 4. End 1-on-1 Voice Call
 */
async function endCall({ callId, durationSec = 0 }) {
  if (!callId) return { ok: false, status: 400, error: "Missing callId" };

  let call = activeCallsMap.get(callId);
  if (call) {
    call.status = 'ended';
    call.duration_sec = durationSec || call.duration_sec || 0;
    call.updated_at = new Date().toISOString();
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

  const possibleIds = new Set([
    sUserId,
    sAdm,
    sPhone,
    sUserId.replace('EMP-', ''),
    `EMP-${sUserId.replace('EMP-', '')}`,
    sAdm.replace('EMP-', ''),
    `EMP-${sAdm.replace('EMP-', '')}`
  ].filter(Boolean));

  let incomingCall = null;
  let activeCall = null;
  const nowMs = Date.now();

  // 1. Instant RAM Lookup
  for (const call of activeCallsMap.values()) {
    const recId = String(call.receiver_id || '').trim();
    const callerId = String(call.caller_id || '').trim();

    const isReceiver = possibleIds.has(recId);
    const isCaller = possibleIds.has(callerId);

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

  // 2. Fallback DB lookup if activeCallId requested but not in RAM
  if (sActiveCallId && !activeCall) {
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
         WHERE receiver_id IN (${placeholders})
           AND status = 'ringing'
         ORDER BY id DESC LIMIT 1`,
        [...idArray]
      );
      const rows = res?.results?.[0]?.response?.result?.rows || [];
      if (rows.length > 0) {
        const cols = res.results[0].response.result.cols.map(c => c.name);
        const row = {};
        cols.forEach((col, idx) => { row[col] = rows[0][idx]?.value; });
        const callAge = nowMs - new Date(row.created_at || row.updated_at || Date.now()).getTime();
        if (callAge < 45000 && !possibleIds.has(String(row.caller_id))) {
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
