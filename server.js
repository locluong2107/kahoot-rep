// Kohaat - real-time team quiz server
// Run: npm install && npm start

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  // Generous timeouts — helps on flaky mobile connections
  pingTimeout: 30000,
  pingInterval: 10000,
});

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'quizzes.json');

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- persistence ----------
function loadQuizzes() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      const seed = require('./data/seed.js')();
      fs.writeFileSync(DATA_FILE, JSON.stringify(seed, null, 2));
      return seed;
    }
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    console.error('loadQuizzes failed', err);
    return { quizzes: [] };
  }
}
function saveQuizzes(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}
let store = loadQuizzes();

// ---------- QR code endpoint ----------
app.get('/qr', async (req, res) => {
  const target = String(req.query.url || '');
  if (!target) return res.status(400).send('missing url');
  try {
    const svg = await QRCode.toString(target, {
      type: 'svg', errorCorrectionLevel: 'M', margin: 1,
      color: { dark: '#00144A', light: '#FFFFFF' },
    });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(svg);
  } catch (err) {
    res.status(500).send('qr generation failed');
  }
});

// ---------- REST: quiz management ----------
app.get('/api/quizzes', (_req, res) => res.json(store.quizzes));
app.get('/api/quizzes/:id', (req, res) => {
  const q = store.quizzes.find(q => q.id === req.params.id);
  if (!q) return res.status(404).json({ error: 'not found' });
  res.json(q);
});
app.post('/api/quizzes', (req, res) => {
  const quiz = req.body;
  if (!quiz.id) quiz.id = 'q_' + Math.random().toString(36).slice(2, 9);
  const idx = store.quizzes.findIndex(q => q.id === quiz.id);
  if (idx >= 0) store.quizzes[idx] = quiz;
  else store.quizzes.push(quiz);
  saveQuizzes(store);
  res.json(quiz);
});
app.delete('/api/quizzes/:id', (req, res) => {
  store.quizzes = store.quizzes.filter(q => q.id !== req.params.id);
  saveQuizzes(store);
  res.json({ ok: true });
});

// ---------- in-memory game state ----------
/**
 * games: pin -> {
 *   pin, hostId, quizId, quiz, state, currentIndex,
 *
 *   players: { token -> { name, score, lastAnswer, lastDelta, streak,
 *                         socketId (current, null when offline) } }
 *
 *   rejoinMap: { token -> playerRecord }   // same objects as players values
 *   tokenBySocket: { socketId -> token }   // reverse lookup
 *
 *   answers: Map<token, { choice?, time?, words?, done? }>
 *   questionStartAt, timerHandle
 * }
 */
const games = {};

function newPin() {
  let pin;
  do { pin = String(Math.floor(100000 + Math.random() * 900000)); }
  while (games[pin]);
  return pin;
}

function newToken() { return crypto.randomBytes(16).toString('hex'); }

// Active player count (connected OR not — all who joined)
function activePlayers(game) { return Object.values(game.players); }

// How many sockets are currently online for this game
function onlineCount(game) {
  return Object.values(game.players).filter(p => p.socketId).length;
}

function gameSnapshot(game) {
  return {
    pin: game.pin,
    state: game.state,
    quizTitle: game.quiz.title,
    currentIndex: game.currentIndex,
    totalQuestions: game.quiz.questions.length,
    players: activePlayers(game).map(p => ({ name: p.name, score: p.score })),
  };
}

function publicQuestion(q) {
  const base = { type: q.type, text: q.text, time: q.time || 20 };
  if (q.subtype) base.subtype = q.subtype;
  if (q.type === 'quiz')           base.options = q.options.map(o => ({ text: o.text }));
  else if (q.type === 'truefalse') base.options = [{ text: 'True' }, { text: 'False' }];
  else if (q.type === 'poll')      base.options = q.options.map(o => ({ text: o.text }));
  else if (q.type === 'wordcloud') base.options = [];
  return base;
}

function clearTimer(game) {
  if (game.timerHandle) { clearTimeout(game.timerHandle); game.timerHandle = null; }
}

// Count finalised answers (by token)
function countAnswered(game) {
  const q = game.quiz.questions[game.currentIndex];
  let n = 0;
  for (const a of game.answers.values()) {
    if (q.type === 'wordcloud') { if (a.done) n++; }
    else n++;
  }
  return n;
}

function normalizeWord(raw) {
  let w = String(raw || '').trim().toLowerCase()
    .replace(/[\s ]+/g, ' ')
    .replace(/[.,!?;:"'()\[\]{}]/g, '');
  if (w.length >= 4 && w.endsWith('s')) w = w.slice(0, -1);
  return w;
}

function aggregateWords(game) {
  const counts = {}, display = {};
  for (const a of game.answers.values()) {
    if (!a.words) continue;
    for (const raw of a.words) {
      const key = normalizeWord(raw);
      if (!key) continue;
      counts[key] = (counts[key] || 0) + 1;
      if (!display[key]) display[key] = String(raw).trim();
    }
  }
  return Object.keys(counts).map(k => ({ word: display[k], count: counts[k] }));
}

function emitLiveUpdate(game) {
  const q = game.quiz.questions[game.currentIndex];
  if (!q) return;
  if (q.type === 'poll' || q.type === 'quiz' || q.type === 'truefalse') {
    const tally = {};
    const optCount = q.type === 'truefalse' ? 2 : q.options.length;
    for (let i = 0; i < optCount; i++) tally[i] = 0;
    for (const a of game.answers.values()) {
      if (typeof a.choice === 'number') tally[a.choice] = (tally[a.choice] || 0) + 1;
    }
    io.to(game.pin).emit('live:tally', {
      type: q.type, tally,
      totalPlayers: activePlayers(game).length,
      answered: countAnswered(game),
    });
  } else if (q.type === 'wordcloud') {
    io.to(game.pin).emit('live:wordcloud', {
      words: aggregateWords(game),
      totalPlayers: activePlayers(game).length,
      donePlayers: countAnswered(game),
    });
  }
}

function endQuestion(game) {
  clearTimer(game);
  const q = game.quiz.questions[game.currentIndex];

  const tally = {};
  let correctIndex = null;
  if (q.type === 'quiz') {
    correctIndex = q.options.findIndex(o => o.correct);
    q.options.forEach((_, i) => (tally[i] = 0));
  } else if (q.type === 'truefalse') {
    correctIndex = q.answer === true ? 0 : 1;
    tally[0] = 0; tally[1] = 0;
  } else if (q.type === 'poll') {
    q.options.forEach((_, i) => (tally[i] = 0));
  }

  const maxTime = (q.time || 20) * 1000;

  for (const [token, a] of game.answers.entries()) {
    const player = game.players[token];
    if (!player) continue;
    if (q.type === 'wordcloud') continue;
    if (typeof a.choice !== 'number') continue;
    tally[a.choice] = (tally[a.choice] || 0) + 1;
    let delta = 0;
    if (q.type === 'quiz' || q.type === 'truefalse') {
      if (a.choice === correctIndex) {
        const base = q.points === 'double' ? 2000 : 1000;
        const speedFactor = 1 - (a.time / maxTime) * 0.5;
        delta = Math.round(base * Math.max(0.5, speedFactor));
        player.streak = (player.streak || 0) + 1;
        if (player.streak >= 2) delta += 100 * (player.streak - 1);
      } else {
        player.streak = 0;
      }
    }
    player.score += delta;
    player.lastAnswer = a.choice;
    player.lastDelta = delta;
  }

  const words = q.type === 'wordcloud' ? aggregateWords(game) : [];
  const totalAnswered = countAnswered(game);
  game.state = 'reveal';

  const result = {
    type: q.type,
    text: q.text,
    options: q.type === 'wordcloud' ? []
      : (q.type === 'truefalse' ? ['True', 'False'] : q.options.map(o => o.text)),
    tally, correctIndex, words,
    totalAnswers: totalAnswered,
    totalPlayers: activePlayers(game).length,
    isScored: q.type === 'quiz' || q.type === 'truefalse',
  };

  io.to(game.pin).emit('question:reveal', result);

  const ranked = activePlayers(game).sort((a, b) => b.score - a.score);
  for (const p of activePlayers(game)) {
    if (!p.socketId) continue;
    const a = game.answers.get(p.token);
    const answeredAny = !!a && (
      q.type === 'wordcloud' ? (a.words && a.words.length > 0) : (typeof a.choice === 'number')
    );
    const isCorrect = answeredAny && (q.type === 'quiz' || q.type === 'truefalse') && a.choice === correctIndex;
    io.to(p.socketId).emit('player:result', {
      answered: answeredAny,
      isCorrect: isCorrect || false,
      score: p.score,
      delta: p.lastDelta || 0,
      type: q.type,
      isScored: q.type === 'quiz' || q.type === 'truefalse',
    });
    const rank = ranked.indexOf(p);
    io.to(p.socketId).emit('player:rank', { rank: rank + 1, total: ranked.length, score: p.score });
  }

  io.to(game.pin).emit('state', gameSnapshot(game));
}

function startQuestion(game) {
  clearTimer(game);
  const q = game.quiz.questions[game.currentIndex];
  game.answers = new Map();
  game.questionStartAt = Date.now();
  game.state = 'question';

  io.to(game.pin).emit('question:start', {
    index: game.currentIndex,
    total: game.quiz.questions.length,
    question: publicQuestion(q),
  });
  io.to(game.pin).emit('state', gameSnapshot(game));
  emitLiveUpdate(game);

  const ms = (q.time || 20) * 1000;
  game.timerHandle = setTimeout(() => endQuestion(game), ms + 500);
}

// Check auto-end — only count online players, so a disconnected player doesn't
// block the question from ever ending.
function checkAutoEnd(game) {
  const pin = game.pin;
  const total = activePlayers(game).length;
  if (total === 0) return;
  // Count finalised answers only from players currently online
  // (disconnected players simply don't have an answer — that's fine)
  const online = activePlayers(game).filter(p => p.socketId);
  const answeredOnline = online.filter(p => {
    const a = game.answers.get(p.token);
    if (!a) return false;
    const q = game.quiz.questions[game.currentIndex];
    return q.type === 'wordcloud' ? a.done : true;
  }).length;
  if (online.length > 0 && answeredOnline >= online.length) {
    setTimeout(() => {
      if (games[pin] && games[pin].state === 'question') endQuestion(games[pin]);
    }, 500);
  }
}

// ---------- socket.io ----------
io.on('connection', socket => {

  // HOST creates a game
  socket.on('host:create', ({ quizId }, cb) => {
    const quiz = store.quizzes.find(q => q.id === quizId);
    if (!quiz) return cb && cb({ error: 'quiz not found' });
    const pin = newPin();
    const game = {
      pin, hostId: socket.id, quizId, quiz,
      state: 'lobby', currentIndex: -1,
      players: {}, rejoinMap: {}, tokenBySocket: {},
      answers: new Map(),
    };
    games[pin] = game;
    socket.join(pin);
    socket.data.role = 'host';
    socket.data.pin = pin;
    cb && cb({ pin, quiz: { title: quiz.title, questions: quiz.questions.length } });
    io.to(pin).emit('state', gameSnapshot(game));
  });

  // PLAYER joins for the first time (any game state — allow late joiners)
  socket.on('player:join', ({ pin, name }, cb) => {
    const game = games[pin];
    if (!game) return cb && cb({ error: 'Game not found. Check the PIN.' });
    if (game.state === 'finished') return cb && cb({ error: 'This game has already finished.' });

    name = String(name || '').trim().slice(0, 24);
    if (!name) return cb && cb({ error: 'Name required.' });
    if (Object.values(game.players).some(p => p.name.toLowerCase() === name.toLowerCase())) {
      return cb && cb({ error: 'Name already taken.' });
    }

    const token = newToken();
    const player = { token, name, score: 0, streak: 0, socketId: socket.id, lastDelta: 0 };
    game.players[token] = player;
    game.rejoinMap[token] = player;
    game.tokenBySocket[socket.id] = token;

    socket.join(pin);
    socket.data.role = 'player';
    socket.data.pin = pin;
    socket.data.token = token;

    cb && cb({ ok: true, name, token });
    io.to(pin).emit('player:joined', { name, count: activePlayers(game).length });
    io.to(pin).emit('state', gameSnapshot(game));

    // If the game is mid-question, send the current question immediately so late
    // joiners can participate (they won't earn points — they missed the timer start).
    if (game.state === 'question') {
      const q = game.quiz.questions[game.currentIndex];
      const elapsed = Date.now() - game.questionStartAt;
      const remaining = Math.max(0, (q.time || 20) * 1000 - elapsed);
      socket.emit('question:start', {
        index: game.currentIndex,
        total: game.quiz.questions.length,
        question: publicQuestion(q),
        timeRemaining: Math.round(remaining / 1000),
      });
    } else if (game.state === 'reveal' || game.state === 'leaderboard') {
      // Let them know to wait
      socket.emit('player:waiting', { msg: 'You joined between questions. Next question coming soon!' });
    }
  });

  // PLAYER rejoins with their token after a disconnect
  socket.on('player:rejoin', ({ token, pin }, cb) => {
    const game = games[pin];
    if (!game) return cb && cb({ error: 'Game not found.' });
    if (game.state === 'finished') return cb && cb({ error: 'This game has already finished.' });

    const player = game.rejoinMap[token];
    if (!player) return cb && cb({ error: 'Session expired. Please join with a new name.' });

    // Detach old socket if it somehow still exists
    if (player.socketId && player.socketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(player.socketId);
      if (oldSocket) oldSocket.leave(pin);
      delete game.tokenBySocket[player.socketId];
    }

    player.socketId = socket.id;
    game.tokenBySocket[socket.id] = token;

    socket.join(pin);
    socket.data.role = 'player';
    socket.data.pin = pin;
    socket.data.token = token;

    cb && cb({ ok: true, name: player.name, score: player.score, token });
    io.to(pin).emit('player:rejoined', { name: player.name, count: onlineCount(game) });
    io.to(pin).emit('state', gameSnapshot(game));

    // Send the current game state so the player's screen catches up
    if (game.state === 'question') {
      const q = game.quiz.questions[game.currentIndex];
      const elapsed = Date.now() - game.questionStartAt;
      const remaining = Math.max(0, (q.time || 20) * 1000 - elapsed);
      const alreadyAnswered = game.answers.has(token);
      socket.emit('question:start', {
        index: game.currentIndex,
        total: game.quiz.questions.length,
        question: publicQuestion(q),
        timeRemaining: Math.round(remaining / 1000),
        alreadyAnswered,
      });
    } else if (game.state === 'reveal' || game.state === 'leaderboard') {
      socket.emit('player:waiting', { msg: 'You\'re back! Waiting for the next question…' });
    }

    // A rejoining player might complete the answer set — recheck auto-end
    if (game.state === 'question') checkAutoEnd(game);
  });

  // HOST next
  socket.on('host:next', () => {
    const pin = socket.data.pin;
    const game = games[pin];
    if (!game || game.hostId !== socket.id) return;
    if (game.state === 'lobby' || game.state === 'leaderboard' || game.state === 'reveal') {
      game.currentIndex++;
      if (game.currentIndex >= game.quiz.questions.length) {
        game.state = 'finished';
        const ranked = activePlayers(game).sort((a, b) => b.score - a.score);
        io.to(pin).emit('game:finished', { podium: ranked.slice(0, 10) });
        io.to(pin).emit('state', gameSnapshot(game));
        return;
      }
      startQuestion(game);
    }
  });

  socket.on('host:showLeaderboard', () => {
    const pin = socket.data.pin;
    const game = games[pin];
    if (!game || game.hostId !== socket.id) return;
    game.state = 'leaderboard';
    const ranked = activePlayers(game).sort((a, b) => b.score - a.score).slice(0, 10);
    io.to(pin).emit('leaderboard', { players: ranked });
    io.to(pin).emit('state', gameSnapshot(game));
  });

  socket.on('host:skip', () => {
    const pin = socket.data.pin;
    const game = games[pin];
    if (!game || game.hostId !== socket.id) return;
    if (game.state === 'question') endQuestion(game);
  });

  socket.on('host:back', () => {
    const pin = socket.data.pin;
    const game = games[pin];
    if (!game || game.hostId !== socket.id) return;
    let target;
    if (game.state === 'reveal' || game.state === 'leaderboard') target = game.currentIndex;
    else if (game.state === 'question') target = game.currentIndex - 1;
    else return;
    if (target < 0) return;
    for (const p of activePlayers(game)) {
      if (typeof p.lastDelta === 'number' && p.lastDelta > 0) {
        p.score = Math.max(0, p.score - p.lastDelta);
      }
      p.lastDelta = 0; p.lastAnswer = null;
    }
    game.currentIndex = target;
    startQuestion(game);
  });

  socket.on('host:end', () => {
    const pin = socket.data.pin;
    const game = games[pin];
    if (!game || game.hostId !== socket.id) return;
    clearTimer(game);
    io.to(pin).emit('game:ended', {});
    delete games[pin];
  });

  socket.on('host:newSession', ({ quizId } = {}, cb) => {
    const oldPin = socket.data.pin;
    const oldGame = games[oldPin];
    if (oldGame && oldGame.hostId === socket.id) {
      clearTimer(oldGame);
      io.to(oldPin).emit('game:ended', { reason: 'New session started' });
      delete games[oldPin];
    }
    const quiz = store.quizzes.find(q => q.id === quizId) || (oldGame && oldGame.quiz);
    if (!quiz) return cb && cb({ error: 'quiz not found' });
    const pin = newPin();
    const game = {
      pin, hostId: socket.id, quizId: quiz.id, quiz,
      state: 'lobby', currentIndex: -1,
      players: {}, rejoinMap: {}, tokenBySocket: {},
      answers: new Map(),
    };
    games[pin] = game;
    socket.leave(oldPin);
    socket.join(pin);
    socket.data.pin = pin;
    cb && cb({ pin, quiz: { title: quiz.title, questions: quiz.questions.length } });
    io.to(pin).emit('state', gameSnapshot(game));
  });

  // PLAYER answers
  socket.on('player:answer', ({ choice, text }) => {
    const pin = socket.data.pin;
    const game = games[pin];
    if (!game || game.state !== 'question') return;
    const token = socket.data.token || game.tokenBySocket[socket.id];
    if (!token || !game.players[token]) return;
    const q = game.quiz.questions[game.currentIndex];
    const elapsed = Date.now() - game.questionStartAt;

    if (q.type === 'wordcloud') {
      let entry = game.answers.get(token);
      if (!entry) { entry = { words: [], done: false }; game.answers.set(token, entry); }
      if (entry.done) return;
      const word = String(text || '').trim().slice(0, 40);
      if (!word) return;
      if (entry.words.length >= 20) return;
      entry.words.push(word);
      socket.emit('player:answered', { ok: true, count: entry.words.length });
    } else {
      if (game.answers.has(token)) return;
      game.answers.set(token, {
        choice: typeof choice === 'number' ? choice : null,
        time: elapsed,
      });
      socket.emit('player:answered', { ok: true });
    }

    emitLiveUpdate(game);
    io.to(pin).emit('answers:count', {
      answered: countAnswered(game),
      total: activePlayers(game).length,
    });
    checkAutoEnd(game);
  });

  socket.on('player:wordDone', () => {
    const pin = socket.data.pin;
    const game = games[pin];
    if (!game || game.state !== 'question') return;
    const token = socket.data.token || game.tokenBySocket[socket.id];
    if (!token || !game.players[token]) return;
    const q = game.quiz.questions[game.currentIndex];
    if (q.type !== 'wordcloud') return;
    let entry = game.answers.get(token);
    if (!entry) { entry = { words: [], done: true }; game.answers.set(token, entry); }
    else entry.done = true;
    socket.emit('player:wordDoneAck', { count: entry.words.length });
    emitLiveUpdate(game);
    io.to(pin).emit('answers:count', {
      answered: countAnswered(game),
      total: activePlayers(game).length,
    });
    checkAutoEnd(game);
  });

  socket.on('disconnect', () => {
    const pin = socket.data.pin;
    const game = games[pin];
    if (!game) return;

    if (socket.data.role === 'player') {
      const token = socket.data.token || game.tokenBySocket[socket.id];
      const player = token && game.players[token];
      if (player && player.socketId === socket.id) {
        // Mark offline but KEEP them in the game — they can rejoin
        player.socketId = null;
        delete game.tokenBySocket[socket.id];
        io.to(pin).emit('player:offline', {
          name: player.name,
          online: onlineCount(game),
          total: activePlayers(game).length,
        });
        io.to(pin).emit('state', gameSnapshot(game));

        // If they were mid-question and everyone else has answered, don't block end
        if (game.state === 'question') checkAutoEnd(game);
      }
    } else if (socket.data.role === 'host' && game.hostId === socket.id) {
      io.to(pin).emit('game:ended', { reason: 'Host disconnected' });
      clearTimer(game);
      delete games[pin];
    }
  });
});

// ---------- start ----------
function localIPs() {
  const nets = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(nets))
    for (const n of nets[name])
      if (n.family === 'IPv4' && !n.internal) out.push(n.address);
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n=================================================');
  console.log(' SAP KAHOOT  —  team meeting quiz platform');
  console.log('=================================================');
  console.log(` Host screen:    http://localhost:${PORT}/host.html`);
  console.log(` Admin/editor:   http://localhost:${PORT}/admin.html`);
  console.log(` Player join:    http://localhost:${PORT}/`);
  const ips = localIPs();
  if (ips.length) {
    console.log('\n Players on the same network can also join via:');
    for (const ip of ips) console.log(`   http://${ip}:${PORT}/`);
  }
  console.log('\n For VIRTUAL meetings (remote players), expose this server publicly:');
  console.log('   1) npx ngrok http ' + PORT + '   OR   cloudflared tunnel --url http://localhost:' + PORT);
  console.log('   2) Paste the https URL into the host screen "Public URL" field.');
  console.log('=================================================\n');
});
