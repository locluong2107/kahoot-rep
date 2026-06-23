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
// /qr?url=<encoded url>  -> SVG QR code, used by the host screen
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
 *   pin, hostId, quizId, quiz, state: 'lobby'|'question'|'reveal'|'leaderboard'|'finished',
 *   currentIndex, players: { socketId -> { name, score, lastAnswer, lastDelta, streak } },
 *   answers: Map<socketId, {choice, time}>, questionStartAt, timerHandle
 * }
 */
const games = {};

function newPin() {
  // 6-digit pin
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
  // strip correct flags for clients
  const base = {
    type: q.type,
    text: q.text,
    time: q.time || 20,
  };
  if (q.type === 'quiz') {
    base.options = q.options.map(o => ({ text: o.text }));
  } else if (q.type === 'truefalse') {
    base.options = [{ text: 'True' }, { text: 'False' }];
  } else if (q.type === 'poll') {
    base.options = q.options.map(o => ({ text: o.text }));
  } else if (q.type === 'wordcloud') {
    base.options = [];
  }
  return base;
}

function clearTimer(game) {
  if (game.timerHandle) {
    clearTimeout(game.timerHandle);
    game.timerHandle = null;
  }
}

function endQuestion(game) {
  clearTimer(game);
  const q = game.quiz.questions[game.currentIndex];
  const answers = game.answers;

  // tally
  const tally = {};
  const words = [];
  let correctIndex = null;
  if (q.type === 'quiz') {
    correctIndex = q.options.findIndex(o => o.correct);
    q.options.forEach((_, i) => (tally[i] = 0));
  } else if (q.type === 'truefalse') {
    correctIndex = q.answer === true ? 0 : 1;
    tally[0] = 0;
    tally[1] = 0;
  } else if (q.type === 'poll') {
    q.options.forEach((_, i) => (tally[i] = 0));
  }

  const maxTime = (q.time || 20) * 1000;

  for (const [sid, a] of answers.entries()) {
    const player = game.players[sid];
    if (!player) continue;
    if (q.type === 'wordcloud') {
      const w = String(a.text || '').trim().slice(0, 40);
      if (w) words.push({ name: player.name, word: w });
    } else {
      tally[a.choice] = (tally[a.choice] || 0) + 1;
      let delta = 0;
      if (q.type === 'quiz' || q.type === 'truefalse') {
        if (a.choice === correctIndex) {
          // Kahoot-style: full points - half * (time used / total)
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
  }

  game.state = 'reveal';
  const result = {
    type: q.type,
    text: q.text,
    options: q.type === 'wordcloud' ? [] : (q.type === 'truefalse' ? ['True', 'False'] : q.options.map(o => o.text)),
    tally,
    correctIndex,
    words,
    totalAnswers: answers.size,
    totalPlayers: Object.keys(game.players).length,
  };

  io.to(game.pin).emit('question:reveal', result);

  // send per-player personal result
  for (const sid of Object.keys(game.players)) {
    const p = game.players[sid];
    const a = answers.get(sid);
    const isCorrect = a && (q.type === 'quiz' || q.type === 'truefalse') && a.choice === correctIndex;
    io.to(sid).emit('player:result', {
      answered: !!a,
      isCorrect: isCorrect || false,
      score: p.score,
      delta: p.lastDelta || 0,
      rank: 0, // filled below
      type: q.type,
    });
  }
  // recompute ranks
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

  const ms = (q.time || 20) * 1000;
  game.timerHandle = setTimeout(() => endQuestion(game), ms + 500);
}

// ---------- socket.io ----------
io.on('connection', socket => {
  // HOST creates a game
  socket.on('host:create', ({ quizId }, cb) => {
    const quiz = store.quizzes.find(q => q.id === quizId);
    if (!quiz) return cb && cb({ error: 'quiz not found' });
    const pin = newPin();
    const game = {
      pin,
      hostId: socket.id,
      quizId,
      quiz,
      state: 'lobby',
      currentIndex: -1,
      players: {},
      answers: new Map(),
    };
    games[pin] = game;
    socket.join(pin);
    socket.data.role = 'host';
    socket.data.pin = pin;
    cb && cb({ pin, quiz: { title: quiz.title, questions: quiz.questions.length } });
    io.to(pin).emit('state', gameSnapshot(game));
  });

  // PLAYER joins
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

  // HOST advances
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

  socket.on('host:end', () => {
    const pin = socket.data.pin;
    const game = games[pin];
    if (!game || game.hostId !== socket.id) return;
    clearTimer(game);
    io.to(pin).emit('game:ended', {});
    delete games[pin];
  });

  // PLAYER answers
  socket.on('player:answer', ({ choice, text }) => {
    const pin = socket.data.pin;
    const game = games[pin];
    if (!game || game.state !== 'question') return;
    if (!game.players[socket.id]) return;
    if (game.answers.has(socket.id)) return; // one answer per question
    const elapsed = Date.now() - game.questionStartAt;
    game.answers.set(socket.id, {
      choice: typeof choice === 'number' ? choice : null,
      text: text || null,
      time: elapsed,
    });
    socket.emit('player:answered', { ok: true });
    io.to(pin).emit('answers:count', {
      answered: game.answers.size,
      total: Object.keys(game.players).length,
    });
    // auto-end when everyone has answered
    if (game.answers.size >= Object.keys(game.players).length) {
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
