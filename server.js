const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const WORDS = require('./words');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// { "ABCD": { code, hostId, phase, players: [...], game: null | {...} } }
// Gracz: { id, token, socketId, name, connected, away, alive, graceTimer }
//   id       – PUBLICZNY, stały identyfikator gracza (widzą go wszyscy w stanie pokoju)
//   token    – TAJNY klucz do powrotu do gry (nigdy go nie rozsyłamy)
//   socketId – aktualne połączenie (zmienia się po odświeżeniu strony)
//   away     – połączenie padło i czekamy chwilę na powrót
//   connected– czy gracz "jest w grze" (false dopiero po upływie czasu na powrót)
const rooms = {};

const MAX_PLAYERS = 12;
const MIN_PLAYERS = 3;
const MAX_CLUE_LENGTH = 25;

// Ile czasu dajemy rozłączonemu graczowi na powrót (odświeżenie strony, chwilowy brak zasięgu),
// zanim uznamy go za nieobecnego i gra pójdzie dalej bez niego.
const GRACE_MS = Number(process.env.GRACE_MS) || 20000;

function generateCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms[code]);
  return code;
}

function cleanName(name) {
  return String(name || '').trim().slice(0, 20);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Ujednolica tekst przed porównaniem: małe litery, bez polskich znaków, pojedyncze spacje.
// Dzięki temu "PILKA  nozna" zostanie uznane za "piłka nożna".
function normalizeGuess(s) {
  return String(s)
    .toLowerCase()
    .replace(/ł/g, 'l') // "ł" nie rozkłada się w Unicode, trzeba je zamienić ręcznie
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // usuwa ogonki i kreski (ą→a, ś→s…)
    .replace(/\s+/g, ' ')
    .trim();
}

// Na starcie uczestników musi być więcej niż impostorów.
function maxImpostors(playerCount) {
  return Math.min(3, Math.floor((playerCount - 1) / 2));
}

// ---------- POMOCNIKI ----------

function isAlive(room, id) {
  const p = room.players.find((pl) => pl.id === id);
  return !!p && p.alive;
}

// Czy gracz może teraz podać wskazówkę? (żyje i jest w grze)
function isActive(room, id) {
  const p = room.players.find((pl) => pl.id === id);
  return !!p && p.alive && p.connected;
}

// Kim jest gracz za tym połączeniem? Zwraca { room, player } albo null.
function playerOf(socket) {
  const room = rooms[socket.data.roomCode];
  if (!room) return null;
  const player = room.players.find((p) => p.id === socket.data.playerId);
  return player ? { room, player } : null;
}

// Dodaje nowego gracza do pokoju i podpina do niego to połączenie
function addPlayer(room, socket, name) {
  let id;
  do {
    id = crypto.randomBytes(4).toString('hex');
  } while (room.players.some((p) => p.id === id));

  const player = {
    id,
    token: crypto.randomBytes(16).toString('hex'),
    socketId: socket.id,
    name,
    connected: true,
    away: false,
    alive: true,
    graceTimer: null,
  };
  room.players.push(player);
  socket.join(room.code);
  socket.data.roomCode = room.code;
  socket.data.playerId = id;
  return player;
}

// Wysyła graczowi PRYWATNIE jego rolę (używane przy starcie gry i przy powrocie do gry)
function sendRole(room, player) {
  const g = room.game;
  if (!g || !player.socketId) return;
  const isImpostor = g.impostorIds.includes(player.id);
  io.to(player.socketId).emit('game:role', {
    role: isImpostor ? 'impostor' : 'crew',
    category: isImpostor ? g.category : null, // kategoria TYLKO dla impostorów
    word: isImpostor ? null : g.word, // hasło TYLKO dla uczestników
  });
}

function destroyRoom(room) {
  for (const p of room.players) {
    if (p.graceTimer) clearTimeout(p.graceTimer);
  }
  delete rooms[room.code];
}

// ---------- TURY WSKAZÓWEK ----------

// Przechodzi do następnego aktywnego gracza.
// Jeśli kolejka się skończyła – zaczyna się głosowanie.
function advanceTurn(room) {
  const g = room.game;
  do {
    g.turnIndex++;
  } while (g.turnIndex < g.order.length && !isActive(room, g.order[g.turnIndex]));

  if (g.turnIndex >= g.order.length) {
    room.phase = 'voting';
    g.votes = {}; // { idGłosującego: idGłosowanego }
  }
}

// Rozpoczyna nową rundę wskazówek
function startClueRound(room) {
  const g = room.game;
  g.round += 1;
  g.notice = null;
  if (g.round > 1) g.order.push(g.order.shift()); // w kolejnych rundach zaczyna kto inny
  g.turnIndex = -1;
  room.phase = 'clues';
  advanceTurn(room);
}

// ---------- KONIEC GRY ----------

// Sprawdza, czy ktoś już wygrał (po wyrzuceniu gracza). Zwraca { winner, reason } albo null.
function evaluateWinner(room) {
  const g = room.game;
  const aliveImpostors = g.impostorIds.filter((id) => isAlive(room, id)).length;
  const aliveCrew = room.players.filter((p) => p.alive && !g.impostorIds.includes(p.id)).length;

  if (aliveImpostors === 0) return { winner: 'crew', reason: 'impostors_out' }; // wszyscy impostorzy wyrzuceni
  if (aliveCrew <= aliveImpostors) return { winner: 'impostors', reason: 'majority' }; // tyle samo (lub mniej) uczestników
  return null;
}

function endGame(room, winner, reason) {
  room.game.winner = winner;
  room.game.endReason = reason; // 'impostors_out' | 'majority' | 'guess'
  room.phase = 'ended';
}

// ---------- GŁOSOWANIE ----------

// Jeśli wszyscy żywi i będący w grze gracze już zagłosowali – liczymy głosy
function checkVotingComplete(room) {
  const g = room.game;
  const voters = room.players.filter((p) => p.alive && p.connected);
  if (voters.every((p) => g.votes[p.id])) {
    resolveVoting(room);
  }
}

function resolveVoting(room) {
  const g = room.game;

  // Liczymy głosy na każdego gracza
  const tally = {};
  for (const target of Object.values(g.votes)) {
    tally[target] = (tally[target] || 0) + 1;
  }

  // Kto ma najwięcej głosów? Przy remisie na szczycie nikt nie odpada.
  const counts = Object.values(tally);
  const max = counts.length ? Math.max(...counts) : 0;
  const top = Object.keys(tally).filter((id) => tally[id] === max);
  const tie = top.length !== 1;
  const ejectedId = tie ? null : top[0];

  if (ejectedId) {
    room.players.find((p) => p.id === ejectedId).alive = false;
  }

  g.lastResult = {
    votes: Object.entries(g.votes).map(([voterId, targetId]) => ({ voterId, targetId })),
    tally,
    tie,
    ejectedId,
    ejectedWasImpostor: ejectedId ? g.impostorIds.includes(ejectedId) : null,
  };

  // WARUNKI KOŃCA GRY
  const w = evaluateWinner(room);
  if (w) endGame(room, w.winner, w.reason);
  else room.phase = 'result';
}

// ---------- STAN PUBLICZNY ----------

// Tylko to, co WOLNO zobaczyć wszystkim.
// Tokenów, ról i hasła tu NIE MA. Hasło i role pojawiają się dopiero w "reveal" – i tylko gdy gra jest zakończona.
function publicRoomState(room) {
  const g = room.game;
  const finished = room.phase === 'ended';
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase, // 'lobby' -> 'clues' -> 'voting' -> 'result' -> ... -> 'ended'
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      away: p.away,
      alive: p.alive,
    })),
    impostorCount: g ? g.impostorIds.filter((id) => isAlive(room, id)).length : null,
    round: g ? g.round : null,
    order: g ? g.order : [],
    currentPlayerId: g && room.phase === 'clues' ? g.order[g.turnIndex] : null,
    clues: g ? g.clues : [],
    voted: g && room.phase === 'voting' ? Object.keys(g.votes) : [], // KTO zagłosował (ale nie na kogo!)
    notice: g ? g.notice : null, // ogłoszenie o strzale w hasło
    result: g && (room.phase === 'result' || finished) ? g.lastResult : null,
    reveal: g && finished
      ? { word: g.word, category: g.category, impostorIds: g.impostorIds, winner: g.winner, endReason: g.endReason }
      : null,
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit('room:update', publicRoomState(room));
}

// ---------- ROZŁĄCZENIA I POWROTY ----------

// Wywoływane, gdy gracz nie wrócił w czasie GRACE_MS (albo sam wyszedł z pokoju).
// Dopiero tu "naprawdę" przestajemy go liczyć jako obecnego.
function finalizeDisconnect(room, player) {
  player.graceTimer = null;
  if (rooms[room.code] !== room) return; // pokój już nie istnieje
  if (player.socketId) return; // gracz zdążył wrócić

  player.away = false;

  if (room.phase === 'lobby') {
    room.players = room.players.filter((p) => p !== player);
  } else {
    // W trakcie gry nie usuwamy gracza (psułoby to liczenie), tylko oznaczamy jako nieobecnego.
    player.connected = false;

    // Jeśli właśnie była jego kolej – przeskakujemy dalej, żeby gra nie utknęła
    if (room.phase === 'clues' && room.game.order[room.game.turnIndex] === player.id) {
      advanceTurn(room);
    }
    // Jeśli czekaliśmy na jego głos – może już wszyscy pozostali zagłosowali
    if (room.phase === 'voting') {
      checkVotingComplete(room);
    }
  }

  if (room.players.length === 0 || room.players.every((p) => !p.connected)) {
    destroyRoom(room);
    return;
  }
  if (room.hostId === player.id) {
    const next = room.players.find((p) => p.connected);
    if (next) room.hostId = next.id;
  }
  broadcastRoom(room);
}

io.on('connection', (socket) => {
  socket.on('room:create', ({ name }, reply) => {
    name = cleanName(name);
    if (!name) return reply({ error: 'Podaj imię.' });

    const code = generateCode();
    const room = { code, hostId: null, phase: 'lobby', players: [], game: null };
    rooms[code] = room;

    const player = addPlayer(room, socket, name);
    room.hostId = player.id;

    reply({ ok: true, you: player.id, token: player.token, code });
    broadcastRoom(room);
  });

  socket.on('room:join', ({ name, code }, reply) => {
    name = cleanName(name);
    code = String(code || '').trim().toUpperCase();

    if (!name) return reply({ error: 'Podaj imię.' });
    const room = rooms[code];
    if (!room) return reply({ error: 'Nie ma takiego pokoju.' });
    if (room.phase !== 'lobby') return reply({ error: 'Gra już trwa.' });
    if (room.players.length >= MAX_PLAYERS) return reply({ error: 'Pokój jest pełny.' });
    if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return reply({ error: 'Ktoś już ma takie imię.' });
    }

    const player = addPlayer(room, socket, name);

    reply({ ok: true, you: player.id, token: player.token, code });
    broadcastRoom(room);
  });

  // POWRÓT DO GRY – po odświeżeniu strony albo odzyskaniu połączenia
  socket.on('room:rejoin', ({ code, token }, reply) => {
    code = String(code || '').trim().toUpperCase();
    token = String(token || '');

    const room = rooms[code];
    if (!room) return reply({ error: 'Ten pokój już nie istnieje.' });
    const player = token ? room.players.find((p) => p.token && p.token === token) : null;
    if (!player) return reply({ error: 'Nie ma Cię już w tym pokoju.' });

    // Wracamy – przestajemy odliczać czas na powrót
    if (player.graceTimer) {
      clearTimeout(player.graceTimer);
      player.graceTimer = null;
    }

    // Jeśli to samo konto było otwarte w innym miejscu – to nowe połączenie przejmuje miejsce
    const oldSocketId = player.socketId;
    player.socketId = socket.id;
    player.connected = true;
    player.away = false;
    if (oldSocketId && oldSocketId !== socket.id) {
      const old = io.sockets && io.sockets.sockets && io.sockets.sockets.get(oldSocketId);
      if (old) {
        old.data.roomCode = null;
        old.data.playerId = null;
        old.disconnect(true);
      }
    }

    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.playerId = player.id;

    sendRole(room, player); // jeśli gra trwa, od razu dostaje swoją rolę z powrotem
    reply({ ok: true, you: player.id, code: room.code });
    broadcastRoom(room);
  });

  // WYJŚCIE Z POKOJU – świadome, więc bez czekania na powrót
  socket.on('room:leave', (_payload, reply) => {
    const ctx = playerOf(socket);
    if (ctx) {
      const { room, player } = ctx;
      if (player.graceTimer) {
        clearTimeout(player.graceTimer);
        player.graceTimer = null;
      }
      player.socketId = null;
      player.token = null; // nie można już wrócić na to miejsce
      socket.leave(room.code);
      socket.data.roomCode = null;
      socket.data.playerId = null;
      finalizeDisconnect(room, player);
    }
    if (typeof reply === 'function') reply({ ok: true });
  });

  // START GRY – tylko gospodarz
  socket.on('game:start', ({ impostors }, reply) => {
    const ctx = playerOf(socket);
    if (!ctx) return reply({ error: 'Nie jesteś w żadnym pokoju.' });
    const { room, player } = ctx;
    if (room.hostId !== player.id) return reply({ error: 'Tylko gospodarz może zacząć grę.' });
    if (room.phase !== 'lobby') return reply({ error: 'Gra już trwa.' });

    const n = room.players.length;
    if (n < MIN_PLAYERS) return reply({ error: `Potrzeba co najmniej ${MIN_PLAYERS} graczy.` });

    const count = Number(impostors);
    const max = maxImpostors(n);
    if (!Number.isInteger(count) || count < 1 || count > max) {
      return reply({ error: `Przy ${n} graczach może być od 1 do ${max} impostorów.` });
    }

    const category = randomFrom(Object.keys(WORDS));
    const word = randomFrom(WORDS[category]);
    const impostorIds = shuffle(room.players.map((p) => p.id)).slice(0, count);

    // Całą tajną część trzymamy tylko na serwerze
    room.game = {
      category,
      word,
      impostorIds,
      order: shuffle(room.players.map((p) => p.id)),
      turnIndex: -1,
      round: 0,
      clues: [], // { round, playerId, text }
      votes: {},
      lastResult: null,
      winner: null,
      endReason: null,
      notice: null,
    };
    for (const p of room.players) p.alive = true;

    // Każdemu graczowi wysyłamy PRYWATNIE jego rolę
    for (const p of room.players) sendRole(room, p);

    startClueRound(room);
    reply({ ok: true });
    broadcastRoom(room);
  });

  // WSKAZÓWKA – tylko gracz, którego jest kolej
  socket.on('game:clue', ({ text }, reply) => {
    const ctx = playerOf(socket);
    if (!ctx || ctx.room.phase !== 'clues') return reply({ error: 'Teraz nie można podawać wskazówek.' });
    const { room, player } = ctx;

    const g = room.game;
    if (g.order[g.turnIndex] !== player.id) return reply({ error: 'To nie jest Twoja kolej.' });

    text = String(text || '').trim();
    if (!text) return reply({ error: 'Wpisz wskazówkę.' });
    if (!/^\S+$/.test(text)) return reply({ error: 'Wskazówka musi być jednym słowem.' });
    if (text.length > MAX_CLUE_LENGTH) return reply({ error: `Maksymalnie ${MAX_CLUE_LENGTH} znaków.` });

    // Uczestnik nie może podać samego hasła.
    // Impostora NIE sprawdzamy – odrzucenie jego słowa zdradziłoby mu, że trafił w hasło.
    const isImpostor = g.impostorIds.includes(player.id);
    if (!isImpostor && text.toLowerCase() === g.word.toLowerCase()) {
      return reply({ error: 'Nie możesz użyć samego hasła jako wskazówki.' });
    }

    g.clues.push({ round: g.round, playerId: player.id, text });
    advanceTurn(room);

    reply({ ok: true });
    broadcastRoom(room);
  });

  // GŁOS – każdy żywy gracz, raz, na kogoś innego
  socket.on('game:vote', ({ targetId }, reply) => {
    const ctx = playerOf(socket);
    if (!ctx || ctx.room.phase !== 'voting') return reply({ error: 'Teraz nie ma głosowania.' });
    const { room, player } = ctx;

    const g = room.game;
    if (!player.alive) return reply({ error: 'Wyrzuceni gracze nie głosują.' });
    if (g.votes[player.id]) return reply({ error: 'Już zagłosowałeś.' });

    const target = room.players.find((p) => p.id === targetId);
    if (!target || !target.alive) return reply({ error: 'Nie ma takiego gracza w grze.' });
    if (target.id === player.id) return reply({ error: 'Nie możesz głosować na siebie.' });

    g.votes[player.id] = target.id;
    checkVotingComplete(room);

    reply({ ok: true });
    broadcastRoom(room);
  });

  // ZGADYWANIE HASŁA – tylko żywy impostor, w SWOJEJ turze, zamiast podawania wskazówki
  socket.on('game:guess', ({ guess }, reply) => {
    const ctx = playerOf(socket);
    if (!ctx || !ctx.room.game || ctx.room.phase !== 'clues') {
      return reply({ error: 'Hasło można zgadywać tylko w swojej turze.' });
    }
    const { room, player } = ctx;
    const g = room.game;
    if (!g.impostorIds.includes(player.id)) return reply({ error: 'Tylko impostor może zgadywać hasło.' });
    if (!player.alive) return reply({ error: 'Zostałeś już wyrzucony z gry.' });
    if (g.order[g.turnIndex] !== player.id) return reply({ error: 'Hasło możesz zgadywać tylko w swojej turze.' });

    const text = String(guess || '').trim().slice(0, 40);
    if (!text) return reply({ error: 'Wpisz hasło.' });

    // TRAFIONE -> impostorzy wygrywają od razu
    if (normalizeGuess(text) === normalizeGuess(g.word)) {
      g.notice = { type: 'correct_guess', playerId: player.id, guess: text };
      g.lastResult = null;
      endGame(room, 'impostors', 'guess');
      reply({ ok: true, correct: true });
      broadcastRoom(room);
      return;
    }

    // POMYŁKA -> ten impostor odpada z gry (inaczej mógłby strzelać bez końca).
    // Strzał zastępuje jego wskazówkę, więc jego tura się kończy i gra idzie dalej.
    player.alive = false;
    g.notice = { type: 'wrong_guess', playerId: player.id, guess: text };

    const w = evaluateWinner(room);
    if (w) {
      g.lastResult = null;
      endGame(room, w.winner, w.reason);
    } else {
      advanceTurn(room);
    }

    reply({ ok: true, correct: false });
    broadcastRoom(room);
  });

  // NASTĘPNA RUNDA – tylko gospodarz, po wynikach głosowania
  socket.on('game:next', (_payload, reply) => {
    const ctx = playerOf(socket);
    if (!ctx) return reply({ error: 'Nie jesteś w żadnym pokoju.' });
    const { room, player } = ctx;
    if (room.hostId !== player.id) return reply({ error: 'Tylko gospodarz może zacząć następną rundę.' });
    if (room.phase !== 'result') return reply({ error: 'Teraz nie można zacząć następnej rundy.' });

    startClueRound(room);
    reply({ ok: true });
    broadcastRoom(room);
  });

  // ZAGRAJ PONOWNIE – tylko gospodarz, po zakończeniu gry (wracamy do lobby)
  socket.on('game:reset', (_payload, reply) => {
    const ctx = playerOf(socket);
    if (!ctx) return reply({ error: 'Nie jesteś w żadnym pokoju.' });
    const { room, player } = ctx;
    if (room.hostId !== player.id) return reply({ error: 'Tylko gospodarz może zacząć od nowa.' });
    if (room.phase !== 'ended') return reply({ error: 'Gra jeszcze trwa.' });

    room.players = room.players.filter((p) => p.connected); // nieobecni odpadają
    for (const p of room.players) p.alive = true;
    room.game = null;
    room.phase = 'lobby';

    reply({ ok: true });
    broadcastRoom(room);
  });

  // PRZERWANE POŁĄCZENIE – nie wyrzucamy od razu, dajemy czas na powrót
  socket.on('disconnect', () => {
    const ctx = playerOf(socket);
    if (!ctx) return;
    const { room, player } = ctx;

    // To mogło być stare połączenie, które padło dopiero PO tym, jak gracz wrócił na nowym
    if (player.socketId !== socket.id) return;

    player.socketId = null;
    player.away = true;
    player.graceTimer = setTimeout(() => finalizeDisconnect(room, player), GRACE_MS);
    broadcastRoom(room); // pozostali widzą, że ktoś ma problem z połączeniem
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serwer działa na http://localhost:${PORT}`);
});
