// SAP Kahoot - real-time team quiz server
// Run: npm install && npm start
// Players join from any device on the same network at http://<host-IP>:3000

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

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
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
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
 *   players: { socketId -> { name, score, lastAnswer, lastDelta, streak } },
 *   // For quiz/truefalse/poll: answers.get(sid) = { choice, time }
 *   // For wordcloud:           answers.get(sid) = { words: [], done: boolean }
 *   answers, questionStartAt, timerHandle
 * }
 */
const games = {};

function newPin() {
  let pin;
  do {
    pin = String(Math.floor(100000 + Math.random() * 900000));
  } while (games[pin]);
  return pin;
}

function gameSnapshot(game) {
  return {
    pin: game.pin,
    state: game.state,
    quizTitle: game.quiz.title,
    currentIndex: game.currentIndex,
    totalQuestions: game.quiz.questions.length,
    players: Object.values(game.players).map(p => ({ name: p.name, score: p.score })),
  };
}

function publicQuestion(q) {
  const base = { type: q.type, text: q.text, time: q.time || 20 };
  if (q.type === 'quiz')      base.options = q.options.map(o => ({ text: o.text }));
  else if (q.type === 'truefalse') base.options = [{ text: 'True' }, { text: 'False' }];
  else if (q.type === 'poll') base.options = q.options.map(o => ({ text: o.text }));
  else if (q.type === 'wordcloud') base.options = [];
  return base;
}

function clearTimer(game) {
  if (game.timerHandle) {
    clearTimeout(game.timerHandle);
    game.timerHandle = null;
  }
}

// Count how many players have a "final" answer for this question.
// For wordcloud: only those who pressed Done. For others: anyone who picked.
function countAnswered(game) {
  const q = game.quiz.questions[game.currentIndex];
  let n = 0;
  for (const a of game.answers.values()) {
    if (q.type === 'wordcloud') { if (a.done) n++; }
    else { n++; }
  }
  return n;
}

// Normalize a word so "AI", "ai!", "Ai." all bucket together for the cloud.
function normalizeWord(raw) {
  let w = String(raw || '').trim().toLowerCase();
  w = w.replace(/[\s ]+/g, ' ');
  w = w.replace(/[.,!?;:"'()\[\]{}]/g, '');
  // very light stem: trailing 's' (only on words ≥ 4 chars)
  if (w.length >= 4 && w.endsWith('s')) w = w.slice(0, -1);
  return w;
}

// Build a frequency map for the word cloud, preserving the most-common original casing.
function aggregateWords(game) {
  const counts = {};
  const display = {};
  for (const [sid, a] of game.answers.entries()) {
    if (!a.words) continue;
    for (const raw of a.words) {
      const key = normalizeWord(raw);
      if (!key) continue;
      counts[key] = (counts[key] || 0) + 1;
      // keep the original spelling of the first occurrence
      if (!display[key]) display[key] = String(raw).trim();
    }
  }
  return Object.keys(counts).map(k => ({ word: display[k], count: counts[k] }));
}

// Live tally emitter — broadcasts to the host (and anyone watching) during the question.
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
      type: q.type,
      tally,
      totalPlayers: Object.keys(game.players).length,
      answered: countAnswered(game),
    });
  } else if (q.type === 'wordcloud') {
    io.to(game.pin).emit('live:wordcloud', {
      words: aggregateWords(game),
      totalPlayers: Object.keys(game.players).length,
      donePlayers: countAnswered(game),
    });
  }
}

function endQuestion(game) {
  clearTimer(game);
  const q = game.quiz.questions[game.currentIndex];
  const answers = game.answers;

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

  for (const [sid, a] of answers.entries()) {
    const player = game.players[sid];
    if (!player) continue;
    if (q.type === 'wordcloud') continue; // aggregated below
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

  // word cloud aggregation
  const words = q.type === 'wordcloud' ? aggregateWords(game) : [];

  // total submissions (for the answered/total display)
  const totalAnswered = countAnswered(game);

  game.state = 'reveal';
  const result = {
    type: q.type,
    text: q.text,
    options: q.type === 'wordcloud'
      ? []
      : (q.type === 'truefalse' ? ['True', 'False'] : q.options.map(o => o.text)),
    tally,
    correctIndex,
    words,
    totalAnswers: totalAnswered,
    totalPlayers: Object.keys(game.players).length,
    isScored: q.type === 'quiz' || q.type === 'truefalse',
  };

  io.to(game.pin).emit('question:reveal', result);

  // per-player personal result
  for (const sid of Object.keys(game.players)) {
    const p = game.players[sid];
    const a = answers.get(sid);
    const answeredAny = !!a && (
      q.type === 'wordcloud' ? (a.words && a.words.length > 0) : (typeof a.choice === 'number')
    );
    const isCorrect = answeredAny && (q.type === 'quiz' || q.type === 'truefalse') && a.choice === correctIndex;
    io.to(sid).emit('player:result', {
      answered: answeredAny,
      isCorrect: isCorrect || false,
      score: p.score,
      delta: p.lastDelta || 0,
      type: q.type,
      isScored: q.type === 'quiz' || q.type === 'truefalse',
    });
  }
  // rank — only meaningful for scored content, but harmless to send always
  const ranked = Object.entries(game.players).sort((a, b) => b[1].score - a[1].score);
  ranked.forEach(([sid, p], i) => {
    io.to(sid).emit('player:rank', { rank: i + 1, total: ranked.length, score: p.score });
  });

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
  emitLiveUpdate(game); // initial zeroes

  const ms = (q.time || 20) * 1000;
  game.timerHandle = setTimeout(() => endQuestion(game), ms + 500);
}

// Reset the game back to lobby for a brand-new session, keeping the host attached.
function startNewSession(game) {
  clearTimer(game);
  game.state = 'lobby';
  game.currentIndex = -1;
  game.players = {};
  game.answers = new Map();
  io.to(game.pin).emit('session:reset', { pin: game.pin });
  io.to(game.pin).emit('state', gameSnapshot(game));
}

// ---------- socket.io ----------
io.on('connection', socket => {
  socket.on('host:create', ({ quizId }, cb) => {
    const quiz = store.quizzes.find(q => q.id === quizId);
    if (!quiz) return cb && cb({ error: 'quiz not found' });
    const pin = newPin();
    const game = {
      pin, hostId: socket.id, quizId, quiz,
      state: 'lobby', currentIndex: -1,
      players: {}, answers: new Map(),
    };
    games[pin] = game;
    socket.join(pin);
    socket.data.role = 'host';
    socket.data.pin = pin;
    cb && cb({ pin, quiz: { title: quiz.title, questions: quiz.questions.length } });
    io.to(pin).emit('state', gameSnapshot(game));
  });

  socket.on('player:join', ({ pin, name }, cb) => {
    const game = games[pin];
    if (!game) return cb && cb({ error: 'Game not found. Check the PIN.' });
    if (game.state !== 'lobby') return cb && cb({ error: 'Game already started.' });
    name = String(name || '').trim().slice(0, 24);
    if (!name) return cb && cb({ error: 'Name required.' });
    if (Object.values(game.players).some(p => p.name.toLowerCase() === name.toLowerCase())) {
      return cb && cb({ error: 'Name already taken.' });
    }
    game.players[socket.id] = { name, score: 0, streak: 0 };
    socket.join(pin);
    socket.data.role = 'player';
    socket.data.pin = pin;
    socket.data.name = name;
    cb && cb({ ok: true, name });
    io.to(pin).emit('player:joined', { name, count: Object.keys(game.players).length });
    io.to(pin).emit('state', gameSnapshot(game));
  });

  socket.on('host:next', () => {
    const pin = socket.data.pin;
    const game = games[pin];
    if (!game || game.hostId !== socket.id) return;
    if (game.state === 'lobby' || game.state === 'leaderboard' || game.state === 'reveal') {
      game.currentIndex++;
      if (game.currentIndex >= game.quiz.questions.length) {
        game.state = 'finished';
        const ranked = Object.values(game.players).sort((a, b) => b.score - a.score);
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
    const ranked = Object.values(game.players).sort((a, b) => b.score - a.score).slice(0, 10);
    io.to(pin).emit('leaderboard', { players: ranked });
    io.to(pin).emit('state', gameSnapshot(game));
  });

  socket.on('host:skip', () => {
    const pin = socket.data.pin;
    const game = games[pin];
    if (!game || game.hostId !== socket.id) return;
    if (game.state === 'question') endQuestion(game);
  });

  // Go back to the previous question. Rolls back any score earned on the question
  // we're leaving so players don't get double-counted when it's re-played.
  socket.on('host:back', () => {
    const pin = socket.data.pin;
    const game = games[pin];
    if (!game || game.hostId !== socket.id) return;
    // Determine which question to revert. If we're showing reveal/leaderboard
    // we go back to the *current* one. If mid-question, we go back to the
    // previous one. In both cases we undo the score of whatever was just played.
    let target;
    if (game.state === 'reveal' || game.state === 'leaderboard') {
      target = game.currentIndex;            // re-play the question we just revealed
    } else if (game.state === 'question') {
      target = game.currentIndex - 1;        // step back to the prior question
    } else {
      return; // lobby / finished — nothing to go back to
    }
    if (target < 0) return;

    // Undo the score delta from the question we're leaving (whichever index was last scored).
    const leavingIndex = game.currentIndex;
    if (leavingIndex >= 0 && leavingIndex < game.quiz.questions.length) {
      for (const p of Object.values(game.players)) {
        if (typeof p.lastDelta === 'number' && p.lastDelta > 0) {
          p.score -= p.lastDelta;
          if (p.score < 0) p.score = 0;
        }
        p.lastDelta = 0;
        p.lastAnswer = null;
      }
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

  // Start a brand-new session with a (possibly different) quiz. Same host, fresh PIN.
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
      players: {}, answers: new Map(),
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
    if (!game.players[socket.id]) return;
    const q = game.quiz.questions[game.currentIndex];
    const elapsed = Date.now() - game.questionStartAt;

    if (q.type === 'wordcloud') {
      // multi-submit: accumulate words, no auto-end until player presses Done
      let entry = game.answers.get(socket.id);
      if (!entry) {
        entry = { words: [], done: false };
        game.answers.set(socket.id, entry);
      }
      if (entry.done) return;
      const word = String(text || '').trim().slice(0, 40);
      if (!word) return;
      if (entry.words.length >= 20) return; // soft cap to prevent abuse
      entry.words.push(word);
      socket.emit('player:answered', { ok: true, count: entry.words.length });
    } else {
      if (game.answers.has(socket.id)) return; // one answer per question
      game.answers.set(socket.id, {
        choice: typeof choice === 'number' ? choice : null,
        time: elapsed,
      });
      socket.emit('player:answered', { ok: true });
    }

    emitLiveUpdate(game);
    io.to(pin).emit('answers:count', {
      answered: countAnswered(game),
      total: Object.keys(game.players).length,
    });

    // Auto-end when every player has finalized.
    if (countAnswered(game) >= Object.keys(game.players).length) {
      setTimeout(() => {
        if (games[pin] && games[pin].state === 'question') endQuestion(games[pin]);
      }, 500);
    }
  });

  // Player presses Done on a word-cloud question
  socket.on('player:wordDone', () => {
    const pin = socket.data.pin;
    const game = games[pin];
    if (!game || game.state !== 'question') return;
    if (!game.players[socket.id]) return;
    const q = game.quiz.questions[game.currentIndex];
    if (q.type !== 'wordcloud') return;
    let entry = game.answers.get(socket.id);
    if (!entry) {
      entry = { words: [], done: true };
      game.answers.set(socket.id, entry);
    } else {
      entry.done = true;
    }
    socket.emit('player:wordDoneAck', { count: entry.words.length });
    emitLiveUpdate(game);
    io.to(pin).emit('answers:count', {
      answered: countAnswered(game),
      total: Object.keys(game.players).length,
    });
    if (countAnswered(game) >= Object.keys(game.players).length) {
      setTimeout(() => {
        if (games[pin] && games[pin].state === 'question') endQuestion(games[pin]);
      }, 500);
    }
  });

  socket.on('disconnect', () => {
    const pin = socket.data.pin;
    const game = games[pin];
    if (!game) return;
    if (socket.data.role === 'player' && game.players[socket.id]) {
      const name = game.players[socket.id].name;
      delete game.players[socket.id];
      game.answers.delete(socket.id);
      io.to(pin).emit('player:left', { name, count: Object.keys(game.players).length });
      io.to(pin).emit('state', gameSnapshot(game));
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
  for (const name of Object.keys(nets)) {
    for (const n of nets[name]) {
      if (n.family === 'IPv4' && !n.internal) out.push(n.address);
    }
  }
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
  console.log('   1) Quick option:  npx ngrok http ' + PORT + '   (or: cloudflared tunnel --url http://localhost:' + PORT + ')');
  console.log('   2) Paste the resulting https URL into the host screen "Public URL" field.');
  console.log('   The QR code on the host screen will update to that public URL automatically.');
  console.log('=================================================\n');
});
