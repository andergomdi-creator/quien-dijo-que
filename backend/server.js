'use strict';

/**
 * ¿Quién dijo qué? — servidor Node.js + Socket.io (todo en memoria)
 *
 * Flujo de fases:  lobby -> answering -> voting <-> result -> over
 *
 * EVENTOS  cliente -> servidor
 *   host:create            ({}, cb)                 crea sala
 *   host:rejoin            ({code, hostKey}, cb)    el host recupera su sala tras una desconexión
 *   host:start             ({}, cb)                 empieza la partida (3-8 jugadores)
 *   host:skipWaiting       ()                       fuerza el paso a la fase de votos
 *   host:next              ()                       cierra votación / salta el resultado
 *   host:playAgain         ()                       vuelve al lobby con los mismos jugadores
 *   player:join            ({code, name}, cb)       un jugador entra en la sala
 *   player:submitAnswers   ({answers:[...]}, cb)    envía las respuestas (ligadas a socket.id)
 *   player:vote            ({targetId}, cb)         vota quién cree que escribió la respuesta
 *
 * EVENTOS  servidor -> cliente
 *   room:state             estado público de la sala (jugadores, fase, puntuaciones)
 *   game:answering         {questions,total}
 *   game:item              respuesta a votar (a los jugadores se les envía `isMine`, nunca el autor)
 *   game:voteProgress      {votesIn, votesNeeded}   (solo host)
 *   game:result            resultado de la ronda, votos y puntos
 *   game:over              {ranking}
 *   game:aborted           {reason}
 *   room:closed            {reason}
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');

// ───────────────────────── Configuración ─────────────────────────
const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || '*'; // p.ej. https://mi-juego.vercel.app (varias separadas por coma)

const CONFIG = {
  MIN_PLAYERS: 3,
  MAX_PLAYERS: 8,
  QUESTIONS_PER_GAME: 10,
  POINTS_CORRECT: 100,
  POINTS_FOOL_ALL: 150,
  VOTE_SECONDS: 30,
  RESULT_SECONDS: 8,
  MAX_NAME_LEN: 14,
  MAX_ANSWER_LEN: 140,
  // false: se revela UNA respuesta por pregunta (10 rondas, autores rotados).
  // true : se revelan TODAS las respuestas de TODOS (10 x nº jugadores rondas).
  REVEAL_ALL_ANSWERS: process.env.REVEAL_ALL_ANSWERS === 'true',
  HOST_GRACE_MS: 2 * 60 * 1000,
  ROOM_MAX_AGE_MS: 6 * 60 * 60 * 1000,
};

const QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8'));

// ───────────────────────── Express + Socket.io ─────────────────────────
const app = express();
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

// Solo para pruebas en local: sirve ../frontend si existe (http://localhost:3000)
const FRONT_DIR = path.join(__dirname, '..', 'frontend');
if (fs.existsSync(FRONT_DIR)) app.use(express.static(FRONT_DIR));

const server = http.createServer(app);
const origins = FRONTEND_URL === '*' ? '*' : FRONTEND_URL.split(',').map((s) => s.trim());
const io = new Server(server, {
  cors: { origin: origins, methods: ['GET', 'POST'] },
  pingInterval: 10000,
  pingTimeout: 30000, // los móviles con la pantalla apagada tardan en responder
});

// ───────────────────────── Utilidades ─────────────────────────
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // sin I ni O para evitar confusiones

const ack = (cb) => (typeof cb === 'function' ? cb : () => {});
const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generateCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function randomKey() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

const connectedPlayers = (room) => [...room.players.values()].filter((p) => p.connected);
const nameOf = (room, id) => room.players.get(id)?.name ?? '???';

function ranking(room) {
  return [...room.players.values()]
    .map((p) => ({ id: p.id, name: p.name, score: p.score, connected: p.connected }))
    .sort((a, b) => b.score - a.score);
}

function stateOf(room) {
  return {
    code: room.code,
    phase: room.phase,
    minPlayers: CONFIG.MIN_PLAYERS,
    maxPlayers: CONFIG.MAX_PLAYERS,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      score: p.score,
      answered: room.answers.has(p.id),
    })),
  };
}

const broadcast = (room) => io.to(room.code).emit('room:state', stateOf(room));

/** Emite al host y guarda la "vista" para poder reponerla si recarga la página. */
function emitHost(room, event, payload) {
  room.hostView = { event, payload };
  io.to(room.hostId).emit(event, payload);
}

function closeRoom(room, reason) {
  clearTimeout(room.timer);
  clearTimeout(room.hostTimeout);
  io.to(room.code).emit('room:closed', { reason });
  io.in(room.code).socketsLeave(room.code);
  rooms.delete(room.code);
}

// Limpieza de salas antiguas
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (now - room.createdAt > CONFIG.ROOM_MAX_AGE_MS) closeRoom(room, 'La sala ha caducado');
  }
}, 10 * 60 * 1000).unref();

function getHostRoom(socket) {
  const r = rooms.get(socket.data.code);
  return r && r.hostId === socket.id ? r : null;
}
function getPlayerRoom(socket) {
  const r = rooms.get(socket.data.code);
  return r && r.players.has(socket.id) ? r : null;
}

// ───────────────────────── Lógica del juego ─────────────────────────
function startAnswering(room) {
  clearTimeout(room.timer);
  room.phase = 'answering';
  room.answers.clear();
  room.items = [];
  room.current = -1;
  room.players.forEach((p) => (p.score = 0));
  room.questions = shuffle(QUESTIONS).slice(0, CONFIG.QUESTIONS_PER_GAME);

  const payload = { questions: room.questions, total: room.questions.length };
  room.hostView = { event: 'game:answering', payload };
  io.to(room.code).emit('game:answering', payload);
  broadcast(room);
}

function maybeFinishAnswering(room) {
  if (room.phase !== 'answering') return;
  const online = connectedPlayers(room);
  if (online.length > 0 && online.every((p) => room.answers.has(p.id))) beginVoting(room);
}

/** Construye las rondas de revelación. Cada item guarda authorId (nunca se envía a los clientes). */
function buildItems(room) {
  const authors = [...room.players.values()].filter((p) => room.answers.has(p.id));
  if (authors.length < 2) return [];

  let items = [];
  if (CONFIG.REVEAL_ALL_ANSWERS) {
    room.questions.forEach((_, qi) => authors.forEach((p) => items.push({ qi, authorId: p.id })));
  } else {
    let pool = [];
    room.questions.forEach((_, qi) => {
      if (!pool.length) pool = shuffle(authors.map((p) => p.id)); // rotación: reparte autores de forma equilibrada
      items.push({ qi, authorId: pool.pop() });
    });
  }

  return shuffle(
    items
      .map((it) => ({ ...it, question: room.questions[it.qi], answer: room.answers.get(it.authorId)[it.qi] }))
      .filter((it) => it.answer) // descarta respuestas vacías
  );
}

function beginVoting(room) {
  room.items = buildItems(room);
  room.current = -1;
  if (!room.items.length) {
    room.phase = 'lobby';
    room.hostView = null;
    io.to(room.code).emit('game:aborted', { reason: 'No hubo suficientes respuestas para jugar.' });
    broadcast(room);
    return;
  }
  nextItem(room);
}

function nextItem(room) {
  clearTimeout(room.timer);
  room.current += 1;
  if (room.current >= room.items.length) return endGame(room);
  showItem(room);
}

function showItem(room) {
  const item = room.items[room.current];
  room.phase = 'voting';
  room.votes = new Map();

  const candidates = [...room.players.values()].map((p) => ({ id: p.id, name: p.name }));
  const base = {
    index: room.current + 1,
    total: room.items.length,
    question: item.question,
    answer: item.answer,
    candidates,
    remainingMs: CONFIG.VOTE_SECONDS * 1000,
  };

  emitHost(room, 'game:item', { ...base, votesNeeded: connectedPlayers(room).length });
  connectedPlayers(room).forEach((p) =>
    io.to(p.id).emit('game:item', { ...base, isMine: p.id === item.authorId })
  );
  broadcast(room);

  room.timer = setTimeout(() => closeVoting(room), CONFIG.VOTE_SECONDS * 1000 + 500);
}

function maybeCloseVoting(room) {
  if (room.phase !== 'voting') return;
  const online = connectedPlayers(room);
  if (online.length === 0 || online.every((p) => room.votes.has(p.id))) closeVoting(room);
}

function closeVoting(room) {
  if (room.phase !== 'voting') return;
  clearTimeout(room.timer);
  const item = room.items[room.current];
  const allVotes = [...room.votes.values()];

  // REGLA DE AUTO-VOTO: los votos del propio autor (auto === true) no puntúan
  // y se excluyen por completo del cálculo de "engañar a todos".
  const validVotes = allVotes.filter((v) => !v.auto);
  const correctVotes = validVotes.filter((v) => v.targetId === item.authorId);

  const delta = {};
  correctVotes.forEach((v) => {
    delta[v.voterId] = (delta[v.voterId] || 0) + CONFIG.POINTS_CORRECT;
  });

  // Bonus: ningún OTRO jugador acierta (y al menos uno votó, para no premiar el AFK).
  const fooledAll = validVotes.length > 0 && correctVotes.length === 0;
  if (fooledAll) delta[item.authorId] = (delta[item.authorId] || 0) + CONFIG.POINTS_FOOL_ALL;

  Object.entries(delta).forEach(([id, pts]) => {
    const p = room.players.get(id);
    if (p) p.score += pts;
  });

  room.phase = 'result';
  const payload = {
    index: room.current + 1,
    total: room.items.length,
    question: item.question,
    answer: item.answer,
    author: { id: item.authorId, name: nameOf(room, item.authorId) },
    votes: allVotes.map((v) => ({
      voterId: v.voterId,
      voterName: nameOf(room, v.voterId),
      targetId: v.targetId,
      targetName: nameOf(room, v.targetId),
      auto: v.auto,
      correct: !v.auto && v.targetId === item.authorId,
    })),
    fooledAll,
    delta,
    scores: ranking(room),
    nextInMs: CONFIG.RESULT_SECONDS * 1000,
  };
  room.hostView = { event: 'game:result', payload };
  io.to(room.code).emit('game:result', payload);
  broadcast(room);

  room.timer = setTimeout(() => nextItem(room), CONFIG.RESULT_SECONDS * 1000);
}

function endGame(room) {
  clearTimeout(room.timer);
  room.phase = 'over';
  const payload = { ranking: ranking(room) };
  room.hostView = { event: 'game:over', payload };
  io.to(room.code).emit('game:over', payload);
  broadcast(room);
}

// ───────────────────────── Eventos de Socket.io ─────────────────────────
io.on('connection', (socket) => {
  // ---- HOST ----
  socket.on('host:create', (_data, cb) => {
    cb = ack(cb);
    const code = generateCode();
    const room = {
      code,
      hostId: socket.id,
      hostKey: randomKey(),
      hostTimeout: null,
      createdAt: Date.now(),
      phase: 'lobby',
      players: new Map(), // socket.id -> {id,name,connected,score}
      questions: [],
      answers: new Map(), // socket.id -> string[]  (anónimo: solo se vincula al socket.id)
      items: [],
      current: -1,
      votes: new Map(),
      timer: null,
      hostView: null,
    };
    rooms.set(code, room);
    socket.data = { role: 'host', code };
    socket.join(code);
    cb({ ok: true, code, hostKey: room.hostKey });
  });

  socket.on('host:rejoin', ({ code, hostKey } = {}, cb) => {
    cb = ack(cb);
    const room = rooms.get(clean(code, 4).toUpperCase());
    if (!room || room.hostKey !== hostKey) return cb({ ok: false, error: 'Sala no encontrada' });
    clearTimeout(room.hostTimeout);
    room.hostId = socket.id;
    socket.data = { role: 'host', code: room.code };
    socket.join(room.code);
    cb({ ok: true, code: room.code });
    socket.emit('room:state', stateOf(room));
    if (room.hostView) socket.emit(room.hostView.event, room.hostView.payload);
  });

  socket.on('host:start', (_data, cb) => {
    cb = ack(cb);
    const room = getHostRoom(socket);
    if (!room) return cb({ ok: false, error: 'No eres el host' });
    if (room.phase !== 'lobby') return cb({ ok: false, error: 'La partida ya ha empezado' });
    const n = connectedPlayers(room).length;
    if (n < CONFIG.MIN_PLAYERS) return cb({ ok: false, error: `Hacen falta al menos ${CONFIG.MIN_PLAYERS} jugadores` });
    if (n > CONFIG.MAX_PLAYERS) return cb({ ok: false, error: `Máximo ${CONFIG.MAX_PLAYERS} jugadores` });
    // Quita a los desconectados antes de empezar
    room.players.forEach((p, id) => !p.connected && room.players.delete(id));
    startAnswering(room);
    cb({ ok: true });
  });

  socket.on('host:skipWaiting', () => {
    const room = getHostRoom(socket);
    if (room && room.phase === 'answering') beginVoting(room);
  });

  socket.on('host:next', () => {
    const room = getHostRoom(socket);
    if (!room) return;
    if (room.phase === 'voting') closeVoting(room);
    else if (room.phase === 'result') nextItem(room);
  });

  socket.on('host:playAgain', () => {
    const room = getHostRoom(socket);
    if (!room || room.phase !== 'over') return;
    room.players.forEach((p, id) => {
      if (!p.connected) room.players.delete(id);
      else p.score = 0;
    });
    room.phase = 'lobby';
    room.answers.clear();
    room.hostView = null;
    broadcast(room);
  });

  // ---- JUGADORES ----
  socket.on('player:join', ({ code, name } = {}, cb) => {
    cb = ack(cb);
    const room = rooms.get(clean(code, 4).toUpperCase());
    if (!room) return cb({ ok: false, error: 'Sala no encontrada' });
    if (room.phase !== 'lobby') return cb({ ok: false, error: 'La partida ya ha empezado' });
    if (room.players.size >= CONFIG.MAX_PLAYERS) return cb({ ok: false, error: 'La sala está llena' });

    const cleanName = clean(name, CONFIG.MAX_NAME_LEN);
    if (!cleanName) return cb({ ok: false, error: 'Escribe un nombre' });
    const taken = [...room.players.values()].some(
      (p) => p.id !== socket.id && p.name.toLowerCase() === cleanName.toLowerCase()
    );
    if (taken) return cb({ ok: false, error: 'Ese nombre ya está cogido' });

    room.players.set(socket.id, { id: socket.id, name: cleanName, connected: true, score: 0 });
    socket.data = { role: 'player', code: room.code };
    socket.join(room.code);
    cb({ ok: true, code: room.code, id: socket.id });
    broadcast(room);
  });

  socket.on('player:submitAnswers', ({ answers } = {}, cb) => {
    cb = ack(cb);
    const room = getPlayerRoom(socket);
    if (!room || room.phase !== 'answering') return cb({ ok: false, error: 'Ahora no se puede responder' });
    if (!Array.isArray(answers) || answers.length !== room.questions.length) {
      return cb({ ok: false, error: 'Respuestas no válidas' });
    }
    room.answers.set(socket.id, answers.map((a) => clean(a, CONFIG.MAX_ANSWER_LEN)));
    cb({ ok: true });
    broadcast(room);
    maybeFinishAnswering(room);
  });

  socket.on('player:vote', ({ targetId } = {}, cb) => {
    cb = ack(cb);
    const room = getPlayerRoom(socket);
    if (!room || room.phase !== 'voting') return cb({ ok: false, error: 'Ahora no se puede votar' });
    if (room.votes.has(socket.id)) return cb({ ok: false, error: 'Ya has votado' });

    const item = room.items[room.current];
    // Validación en servidor: si quien vota es el autor de la respuesta
    // (voto.socketId === autor.socketId) es un AUTO-VOTO, se vote a quien se vote.
    const isAuto = socket.id === item.authorId;
    if (!isAuto && !room.players.has(targetId)) return cb({ ok: false, error: 'Jugador no válido' });

    room.votes.set(socket.id, {
      voterId: socket.id,
      targetId: isAuto ? socket.id : targetId,
      auto: isAuto,
    });
    cb({ ok: true, auto: isAuto });

    io.to(room.hostId).emit('game:voteProgress', {
      votesIn: room.votes.size,
      votesNeeded: connectedPlayers(room).length,
    });
    maybeCloseVoting(room);
  });

  // ---- DESCONEXIÓN ----
  socket.on('disconnect', () => {
    const room = rooms.get(socket.data?.code);
    if (!room) return;

    if (room.hostId === socket.id) {
      room.hostTimeout = setTimeout(() => closeRoom(room, 'El host se ha desconectado'), CONFIG.HOST_GRACE_MS);
      return;
    }

    const player = room.players.get(socket.id);
    if (!player) return;
    if (room.phase === 'lobby') room.players.delete(socket.id);
    else player.connected = false;

    broadcast(room);
    maybeFinishAnswering(room);
    maybeCloseVoting(room);
  });
});

server.listen(PORT, () => console.log(`Servidor escuchando en el puerto ${PORT} · ${QUESTIONS.length} preguntas cargadas`));
