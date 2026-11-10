// Servidor de salas: NÃO recebe vídeo. Só cria salas, ajuda os PCs a se
// encontrarem (sinalização WebRTC), repassa o chat e os comandos de controle.
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MAX_MEMBERS = 8;

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Assistir Juntos: servidor de salas no ar');
});
const io = new Server(httpServer, { cors: { origin: '*' } });

const rooms = new Map(); // código -> { host: socketId, members: Map(socketId -> nome) }
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  } while (rooms.has(code));
  return code;
}

const clean = (s, max) => String(s || '').trim().slice(0, max);
const memberList = (room) =>
  [...room.members].map(([id, name]) => ({ id, name, host: id === room.host }));

io.on('connection', (socket) => {
  let code = null;
  let myName = '';
  const room = () => (code ? rooms.get(code) : null);

  socket.on('create-room', (payload, cb) => {
    if (typeof cb !== 'function') return;
    if (code) return cb({ ok: false, error: 'Você já está em uma sala.' });
    myName = clean(payload && payload.name, 20) || 'Anfitrião';
    code = newCode();
    rooms.set(code, { host: socket.id, members: new Map([[socket.id, myName]]) });
    socket.join(code);
    cb({ ok: true, code, id: socket.id, members: memberList(rooms.get(code)) });
    console.log(`[sala ${code}] criada por ${myName}`);
  });

  socket.on('join-room', (payload, cb) => {
    if (typeof cb !== 'function') return;
    if (code) return cb({ ok: false, error: 'Você já está em uma sala.' });
    const wanted = clean(payload && payload.code, 8).toUpperCase();
    const r = rooms.get(wanted);
    if (!r) return cb({ ok: false, error: 'Sala não encontrada. Confira o código.' });
    if (r.members.size >= MAX_MEMBERS) return cb({ ok: false, error: 'Sala cheia.' });

    code = wanted;
    myName = clean(payload && payload.name, 20) || 'Convidado';
    r.members.set(socket.id, myName);
    socket.join(code);
    cb({ ok: true, code, id: socket.id, host: r.host, members: memberList(r) });
    io.to(r.host).emit('peer-joined', { id: socket.id, name: myName });
    io.to(code).emit('members', memberList(r));
    console.log(`[sala ${code}] ${myName} entrou (${r.members.size})`);
  });

  // Repassa ofertas/respostas/candidatos do WebRTC entre dois participantes
  socket.on('signal', (payload) => {
    const r = room();
    if (!r || !payload || !r.members.has(payload.to)) return;
    io.to(payload.to).emit('signal', { from: socket.id, data: payload.data });
  });

  socket.on('chat', (payload) => {
    const r = room();
    if (!r) return;
    const text = clean(payload && payload.text, 300);
    if (!text) return;
    io.to(code).emit('chat', {
      name: myName,
      text,
      system: !!(payload && payload.system) && r.host === socket.id, // só o anfitrião manda avisos
      ts: Date.now(),
    });
  });

  // Convidado pede play/pause/seek -> vai só para o anfitrião
  socket.on('control', (m) => {
    const r = room();
    if (!r || socket.id === r.host || !m) return;
    if (!['play', 'pause', 'seek'].includes(m.action)) return;
    const time = Number(m.time);
    io.to(r.host).emit('control', {
      action: m.action,
      time: Number.isFinite(time) ? time : 0,
      from: myName,
    });
  });

  // Anfitrião informa posição/duração/pausa para os convidados
  socket.on('state', (s) => {
    const r = room();
    if (!r || socket.id !== r.host || !s) return;
    socket.to(code).emit('state', { t: s.t, d: s.d, p: !!s.p });
  });

  socket.on('disconnect', () => {
    const r = room();
    if (!r) return;
    if (r.host === socket.id) {
      io.to(code).emit('room-closed');
      rooms.delete(code);
      console.log(`[sala ${code}] encerrada (anfitrião saiu)`);
    } else {
      r.members.delete(socket.id);
      io.to(r.host).emit('peer-left', { id: socket.id });
      io.to(code).emit('members', memberList(r));
      console.log(`[sala ${code}] ${myName} saiu (${r.members.size})`);
    }
  });
});

httpServer.listen(PORT, () => console.log(`Servidor de salas rodando na porta ${PORT}`));
