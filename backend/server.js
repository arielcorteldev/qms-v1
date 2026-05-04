const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

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

let state = freshState();

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

io.on('connection', (socket) => {
  // Send current state on connect
  socket.emit('state', publicState());

  // Start queue
  socket.on('queue:start', () => {
    if (!state.started) {
      state.started = true;
      broadcastState();
    }
  });

  // Reset queue
  socket.on('queue:reset', () => {
    state = freshState();
    broadcastState();
  });

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

  // Rename a counter
  socket.on('admin:renameCounter', ({ counterId, name }) => {
    const cid = parseInt(counterId, 10);
    const counter = getCounter(cid);
    if (!counter) return;
    if (!name || !name.trim()) return;
    counter.name = name.trim().slice(0, 30);
    broadcastState();
  });

  // Enable / disable a counter
  socket.on('admin:toggleCounter', ({ counterId }) => {
    const cid = parseInt(counterId, 10);
    const counter = getCounter(cid);
    if (!counter) return;
    counter.enabled = !counter.enabled;
    broadcastState();
  });
});

// ─── Static Frontend ─────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, '../frontend')));

// Catch-all: serve index for unknown routes (SPA-style)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// ─── Start ───────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3003;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`QMS running on http://0.0.0.0:${PORT}`);
  console.log(`Access from other devices: http://<your-ip>:${PORT}`);
});
