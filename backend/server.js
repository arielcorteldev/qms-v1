const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// ─── State ───────────────────────────────────────────────────────────────────

const DEFAULT_COUNTERS = [
  { id: 1, name: 'Counter 1', enabled: true },
  { id: 2, name: 'Counter 2', enabled: true },
  { id: 3, name: 'Counter 3', enabled: true },
];

function freshState() {
  return {
    // Lanes: each has a sequential "next" plus a pool of returned tickets.
    lanes: {
      regular: { next: 1, returned: [] },   // returned: number[]
      priority: { next: 1, returned: [] },  // returned: number[]
    },
    // activeNumbers: { counterId -> { lane: 'regular'|'priority', seq: number, display: string } }
    activeNumbers: {},
    // completedNumbers: string[] of ticket display values (e.g. "1", "P1")
    completedNumbers: [],
    servedCounts: { regular: 0, priority: 0 },
    counters: DEFAULT_COUNTERS.map(c => ({ ...c })),
    log: [],        // { ticket, lane, counterId, counterName, timestamp, status }
    started: false,
  };
}

// ─── Persistence (survive restarts) ──────────────────────────────────────────
//
// The whole queue state is saved to a JSON file after every change, and loaded
// again when the server starts. That way a power cut, Windows update, or service
// restart in the middle of the day doesn't reset the queue to #1.

// Where the file lives. Defaults to backend/state.json (next to this file, so it
// works no matter which folder the Windows service starts from).
// Can be overridden with the QMS_STATE_FILE environment variable.
const STATE_FILE = process.env.QMS_STATE_FILE || path.join(__dirname, 'state.json');
const STATE_TMP_FILE = STATE_FILE + '.tmp';

// Today's date as YYYY-MM-DD in the server's LOCAL time zone.
// ('en-CA' is just a trick: that locale formats dates as YYYY-MM-DD.)
function todayKey() {
  return new Date().toLocaleDateString('en-CA');
}

// Save the current state to disk.
// We write to a temporary file first, then rename it over the real file.
// A rename is (nearly) instant, so if power dies mid-write we still have the
// previous complete state.json instead of a half-written, corrupted one.
function saveState() {
  try {
    // savedDate = the day of the LAST change. On startup we only restore the
    // file if it was last changed today, so yesterday's queue never comes back.
    const payload = { savedDate: todayKey(), state };
    fs.writeFileSync(STATE_TMP_FILE, JSON.stringify(payload));
    fs.renameSync(STATE_TMP_FILE, STATE_FILE);
  } catch (err) {
    // Never crash the queue just because saving failed (e.g. antivirus briefly
    // locking the file). Log it and carry on; the next change will try again.
    console.error('Could not save queue state:', err.message);
  }
}

// Load the saved state, or fall back to a fresh queue.
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      console.log('No saved state found. Starting a fresh queue.');
      return freshState();
    }

    const payload = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

    // Saved on a previous day -> new day, new queue.
    if (!payload || payload.savedDate !== todayKey()) {
      console.log('Saved state is from a previous day. Starting a fresh queue.');
      return freshState();
    }

    // Basic shape check, so a damaged file can't break the server later.
    const s = payload.state;
    const looksValid =
      s &&
      s.lanes && s.lanes.regular && s.lanes.priority &&
      Array.isArray(s.lanes.regular.returned) &&
      Array.isArray(s.lanes.priority.returned) &&
      Array.isArray(s.counters) &&
      Array.isArray(s.completedNumbers) &&
      Array.isArray(s.log) &&
      s.activeNumbers && typeof s.activeNumbers === 'object';
    if (!looksValid) {
      console.error('Saved state is damaged. Starting a fresh queue.');
      return freshState();
    }

    // Start from a fresh state and overlay the saved one, so any field added to
    // freshState() in a future version still gets a default value.
    console.log('Restored queue state from', STATE_FILE);
    return { ...freshState(), ...s };
  } catch (err) {
    // Unreadable or invalid JSON -> don't crash on boot, just start fresh.
    console.error('Could not load queue state:', err.message);
    return freshState();
  }
}

// Load whatever was saved (or start fresh).
let state = loadState();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getCounter(id) {
  return state.counters.find(c => c.id === id);
}

function ticketDisplay(lane, seq) {
  return lane === 'priority' ? `P${seq}` : String(seq);
}

function normalizeReturned(arr) {
  // Keep returned pool ordered, so we re-issue oldest/smallest first.
  arr.sort((a, b) => a - b);
}

function takeNextFromLane(lane) {
  const laneState = state.lanes[lane];
  if (!laneState) throw new Error(`invalid lane: ${lane}`);

  if (laneState.returned.length) {
    normalizeReturned(laneState.returned);
    return laneState.returned.shift();
  }
  const seq = laneState.next;
  laneState.next += 1;
  return seq;
}

function returnToLane(lane, seq) {
  const laneState = state.lanes[lane];
  if (!laneState) return;
  if (!Number.isInteger(seq) || seq <= 0) return;
  laneState.returned.push(seq);
}

function broadcastState() {
  // Every handler that changes the queue (start, call, done, reset, rename,
  // toggle) already ends by calling this function. Saving here means one place
  // covers them all, and a future handler can't forget to persist its change.
  saveState();
  io.emit('state', publicState());
}

function publicState() {
  return {
    // Backward-friendly: keep nextNumber as "next regular".
    nextNumber: state.lanes.regular.next,
    nextPriority: state.lanes.priority.next,
    servedCounts: state.servedCounts,
    activeNumbers: state.activeNumbers,
    completedNumbers: state.completedNumbers,
    counters: state.counters,
    log: state.log,
    started: state.started,
  };
}

function logEntry({ ticket, lane, counterId, status }) {
  const counter = getCounter(counterId);
  state.log.unshift({
    ticket,
    lane,
    counterId,
    counterName: counter ? counter.name : `Counter ${counterId}`,
    timestamp: new Date().toISOString(),
    status,
  });
  // Keep log bounded
  if (state.log.length > 200) state.log.length = 200;
}

// ─── Socket Events ───────────────────────────────────────────────────────────

// ─── Admin PIN ───────────────────────────────────────────────────────────────
//
// Admin actions (start, reset, rename counter, enable/disable counter) require
// a PIN. The check happens HERE on the server, because anyone on the LAN can
// send these socket events without ever opening admin.html. Hiding a button in
// the page would not protect anything.

// The PIN comes from an environment variable so it never lives in the code.
// With NSSM:  nssm set QMS AppEnvironmentExtra PORT=3000 ADMIN_PIN=yourpin
const ADMIN_PIN = process.env.ADMIN_PIN || '';
if (!ADMIN_PIN) {
  console.warn('WARNING: ADMIN_PIN is not set. All admin actions will be refused until it is.');
}

// Brute-force protection: after MAX_FAILS wrong PINs from one IP address,
// that IP is locked out for LOCK_MS. (A 4-digit PIN has only 10,000 options,
// so without this a script on the LAN could guess it in seconds.)
const MAX_FAILS = 5;
const LOCK_MS = 60 * 1000;
const pinFailures = new Map(); // ip -> { count, lockedUntil }

// Compare PINs without leaking information through timing.
// Hashing both sides first gives equal-length buffers, which timingSafeEqual requires.
function pinMatches(candidate) {
  const a = crypto.createHash('sha256').update(String(candidate ?? '')).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PIN).digest();
  return crypto.timingSafeEqual(a, b);
}

// Returns true if this request may proceed. Otherwise it sends the reason back
// through `reply` (the acknowledgement callback) and returns false.
function requireAdmin(socket, pin, reply) {
  if (!ADMIN_PIN) {
    reply({ ok: false, code: 'not-configured', error: 'Admin PIN is not configured on the server.' });
    return false;
  }

  const ip = socket.handshake.address;
  const now = Date.now();
  const record = pinFailures.get(ip) || { count: 0, lockedUntil: 0 };

  if (record.lockedUntil > now) {
    const secs = Math.ceil((record.lockedUntil - now) / 1000);
    reply({ ok: false, code: 'locked', error: `Too many wrong PINs. Try again in ${secs}s.` });
    return false;
  }

  if (!pinMatches(pin)) {
    record.count += 1;
    if (record.count >= MAX_FAILS) {
      record.lockedUntil = now + LOCK_MS;
      record.count = 0;
    }
    pinFailures.set(ip, record);
    reply({ ok: false, code: 'bad-pin', error: 'Wrong PIN.' });
    return false;
  }

  pinFailures.delete(ip); // correct PIN -> clear this IP's failure history
  return true;
}

// Wraps an admin handler so the PIN is checked before it runs.
// The client sends: socket.emit(event, { ...data, pin }, ackCallback)
// and gets back { ok: true } or { ok: false, code, error }.
function adminOnly(socket, handler) {
  return (payload, ack) => {
    // Tolerate old clients that send no payload and/or no callback.
    if (typeof payload === 'function') { ack = payload; payload = {}; }
    payload = payload || {};
    const reply = typeof ack === 'function' ? ack : () => {};

    if (!requireAdmin(socket, payload.pin, reply)) return;

    handler(payload);
    reply({ ok: true });
  };
}

io.on('connection', (socket) => {
  // Send current state on connect
  socket.emit('state', publicState());

  // Start queue (admin only)
  socket.on('queue:start', adminOnly(socket, () => {
    if (!state.started) {
      state.started = true;
      broadcastState();
    }
  }));

  // Reset queue (admin only)
  socket.on('queue:reset', adminOnly(socket, () => {
    state = freshState();
    broadcastState();
  }));

  function emitCalled({ lane, seq, counter }) {
    io.emit('number:called', {
      ticket: ticketDisplay(lane, seq),
      lane,
      // Keep legacy keys for existing clients, but prefer ticket/lane going forward.
      number: lane === 'regular' ? seq : `P${seq}`,
      counterName: counter.name,
      timestamp: Date.now(),
    });
  }

  function setActive(cid, lane, seq) {
    state.activeNumbers[cid] = { lane, seq, display: ticketDisplay(lane, seq) };
  }

  // Call next REGULAR number for a counter
  socket.on('counter:callNext', ({ counterId }) => {
    const cid = parseInt(counterId, 10);
    const counter = getCounter(cid);

    if (!state.started) return socket.emit('error', 'Queue not started.');
    if (!counter) return socket.emit('error', 'Invalid counter.');
    if (!counter.enabled) return socket.emit('error', 'Counter is disabled.');
    const current = state.activeNumbers[cid];
    if (current !== undefined && current?.lane !== 'priority') {
      return socket.emit('error', 'Finish current number first.');
    }

    // If currently serving a priority ticket and the counter calls regular next,
    // auto-cancel and return the priority ticket to its lane.
    if (current?.lane === 'priority') {
      returnToLane('priority', current.seq);
      logEntry({ ticket: current.display, lane: 'priority', counterId: cid, status: 'Cancelled' });
      delete state.activeNumbers[cid];
    }

    const seq = takeNextFromLane('regular');
    setActive(cid, 'regular', seq);

    emitCalled({ lane: 'regular', seq, counter });

    logEntry({ ticket: ticketDisplay('regular', seq), lane: 'regular', counterId: cid, status: 'Called' });
    broadcastState();
  });

  // Call next PRIORITY number for a counter
  socket.on('counter:callPriority', ({ counterId }) => {
    const cid = parseInt(counterId, 10);
    const counter = getCounter(cid);

    if (!state.started) return socket.emit('error', 'Queue not started.');
    if (!counter) return socket.emit('error', 'Invalid counter.');
    if (!counter.enabled) return socket.emit('error', 'Counter is disabled.');
    if (state.activeNumbers[cid] !== undefined) return socket.emit('error', 'Finish current number first.');

    const seq = takeNextFromLane('priority');
    setActive(cid, 'priority', seq);

    emitCalled({ lane: 'priority', seq, counter });

    logEntry({ ticket: ticketDisplay('priority', seq), lane: 'priority', counterId: cid, status: 'Called' });
    broadcastState();
  });

  // Mark current number as done
  socket.on('counter:markDone', ({ counterId }) => {
    const cid = parseInt(counterId, 10);
    const current = state.activeNumbers[cid];

    if (current === undefined) return socket.emit('error', 'No active number to complete.');

    const lane = current.lane === 'priority' ? 'priority' : 'regular';
    state.completedNumbers.push(current.display);
    state.servedCounts[lane] = (state.servedCounts[lane] || 0) + 1;
    delete state.activeNumbers[cid];

    logEntry({ ticket: current.display, lane, counterId: cid, status: 'Completed' });
    broadcastState();
  });

  // Rename a counter (admin only)
  socket.on('admin:renameCounter', adminOnly(socket, ({ counterId, name }) => {
    const cid = parseInt(counterId, 10);
    const counter = getCounter(cid);
    if (!counter) return;
    if (!name || !name.trim()) return;
    counter.name = name.trim().slice(0, 30);
    broadcastState();
  }));

  // Enable / disable a counter (admin only)
  socket.on('admin:toggleCounter', adminOnly(socket, ({ counterId }) => {
    const cid = parseInt(counterId, 10);
    const counter = getCounter(cid);
    if (!counter) return;
    counter.enabled = !counter.enabled;
    broadcastState();
  }));
});

// ─── Static Frontend ─────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, '../frontend')));

// Catch-all: serve index for unknown routes (SPA-style)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ─── Start ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`QMS running on http://0.0.0.0:${PORT}`);
  console.log(`Access from other devices: http://<your-ip>:${PORT}`);
});