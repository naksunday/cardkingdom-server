/**
 * server.js  (v2 — Full Online Multiplayer)
 * CardKingdom WebSocket Game Server
 *
 * New in v2:
 *  - Player accounts: register / login / token auth
 *  - Quick match (ELO matchmaking)
 *  - In-game chat (UTF-8 / Khmer ✅)
 *  - Friend invites
 *  - Bet coins (winner takes pot)
 *  - Leaderboard REST endpoint
 *  - ELO rating updates after each match
 *
 * Full message protocol documented in README.md
 */

const http    = require('http');
const WebSocket = require('ws');
const { RoomManager }       = require('./RoomManager');
const { MatchmakingQueue }  = require('./MatchmakingQueue');
const { AuthService }       = require('./services/AuthService');

const PORT = process.env.PORT || 3000;

// ── HTTP server (serves leaderboard REST + WS upgrade) ───────────────────────
const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET' && req.url.startsWith('/leaderboard')) {
    const params = new URL(req.url, `http://localhost`).searchParams;
    const gameType = params.get('gameType') || 'tien_len';
    const limit    = parseInt(params.get('limit') || '20', 10);
    res.end(JSON.stringify({ leaderboard: AuthService.getLeaderboard(gameType, limit) }));
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.end(JSON.stringify({ status: 'ok', version: '2.0.0', rooms: roomManager.rooms.size }));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'Not found' }));
});

const wss = new WebSocket.Server({ server: httpServer });
const roomManager      = new RoomManager();
const matchmakingQueue = new MatchmakingQueue(roomManager);

// Track connected clients: ws -> { playerId, playerName, elo, token }
const clients = new Map();

httpServer.listen(PORT, () => {
  console.log(`\n🃏 CardKingdom Server v2.0 running on port ${PORT}`);
  console.log(`   WebSocket:   ws://localhost:${PORT}`);
  console.log(`   Leaderboard: http://localhost:${PORT}/leaderboard`);
  console.log(`   Health:      http://localhost:${PORT}/health`);
  console.log(`   Share via ngrok: npx ngrok http ${PORT}\n`);
});

// ── WebSocket connections ─────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { send(ws, { type: 'error', reason: 'Invalid JSON' }); return; }
    handleMessage(ws, msg);
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if (!client) return;

    matchmakingQueue.dequeue(client.playerId);

    const room = roomManager.getRoomByPlayer(client.playerId);
    if (room) {
      room.broadcast({ type: 'player_left', playerId: client.playerId, playerName: client.playerName }, client.playerId);
      roomManager.leaveRoom(client.playerId);
      broadcastRoomList();
    }
    clients.delete(ws);
    console.log(`[WS] ${client.playerName} disconnected`);
  });

  ws.on('error', (err) => console.error('[WS] Error:', err.message));
});

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastRoomList() {
  const payload = JSON.stringify({ type: 'room_list', rooms: roomManager.listPublicRooms() });
  for (const clientWs of clients.keys()) {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(payload);
    }
  }
}

// ── Message handler ───────────────────────────────────────────────────────────
function handleMessage(ws, msg) {
  const { type } = msg;

  // ── Auth messages (no login required) ──────────────────────────────────────
  if (type === 'register') {
    const result = AuthService.register({
      username: msg.username,
      password: msg.password,
      email: msg.email || '',
    });
    return send(ws, { type: 'register_result', ...result });
  }

  if (type === 'login') {
    const result = AuthService.login({ username: msg.username, password: msg.password });
    if (result.ok) {
      clients.set(ws, {
        playerId: result.player.id,
        playerName: result.player.username,
        elo: result.player.elo,
        token: result.token,
      });
      console.log(`[Auth] ${result.player.username} logged in (ELO ${result.player.elo})`);
    }
    return send(ws, { type: 'login_result', ...result });
  }

  // Legacy guest connect (no account)
  if (type === 'connect_player') {
    const { playerId, playerName } = msg;
    if (!playerId || !playerName) return send(ws, { type: 'error', reason: 'connect_player requires playerId and playerName' });
    clients.set(ws, { playerId, playerName, elo: 1200, token: null });
    console.log(`[WS] ${playerName} (guest) connected`);
    return send(ws, { type: 'connected', playerId, serverVersion: '2.0.0' });
  }

  // ── All other messages require identification ───────────────────────────────
  const client = clients.get(ws);
  if (!client) return send(ws, { type: 'error', reason: 'Send connect_player or login first' });
  const { playerId, playerName } = client;

  if (type === 'ping') return send(ws, { type: 'pong', timestamp: Date.now() });

  // ── Matchmaking ─────────────────────────────────────────────────────────────
  if (type === 'quick_match') {
    const result = matchmakingQueue.enqueue({
      playerId, playerName,
      elo: client.elo || 1200,
      gameType: msg.gameType,
      ws,
    });
    return send(ws, { type: 'quick_match_result', ...result });
  }

  if (type === 'cancel_match') {
    matchmakingQueue.dequeue(playerId);
    return send(ws, { type: 'match_cancelled' });
  }

  // ── Room Management ──────────────────────────────────────────────────────────
  if (type === 'create_room') {
    try {
      const room = roomManager.createRoom({
        gameType: msg.gameType, hostId: playerId, hostName: playerName,
        pin: msg.pin || null, maxPlayers: msg.maxPlayers || 4,
        betAmount: msg.betAmount || 0,
      });
      room.getPlayer(playerId).ws = ws;
      console.log(`[Room] ${playerName} created ${room.code} (${room.gameType}) bet:${room.betAmount || 0}`);
      send(ws, { type: 'room_created', room: room.publicInfo() });
      broadcastRoomList();
      return;
    } catch (err) { return send(ws, { type: 'error', reason: err.message }); }
  }

  if (type === 'join_room') {
    const result = roomManager.joinRoom({ code: msg.code, playerId, playerName, pin: msg.pin || null, ws });
    if (!result.ok) return send(ws, { type: 'error', reason: result.reason });
    send(ws, { type: 'room_joined', room: result.room.publicInfo(), reconnected: result.reconnected });
    result.room.broadcast({ type: 'room_updated', room: result.room.publicInfo() }, playerId);
    broadcastRoomList();
    return;
  }

  if (type === 'leave_room') {
    const room = roomManager.getRoomByPlayer(playerId);
    if (room) {
      room.broadcast({ type: 'player_left', playerId, playerName }, playerId);
      roomManager.leaveRoom(playerId);
      broadcastRoomList();
    }
    return send(ws, { type: 'room_left' });
  }

  if (type === 'list_rooms') return send(ws, { type: 'room_list', rooms: roomManager.listPublicRooms() });

  if (type === 'set_ready') {
    const room = roomManager.getRoomByPlayer(playerId);
    if (!room) return send(ws, { type: 'error', reason: 'Not in a room' });
    const player = room.getPlayer(playerId);
    if (player) player.ready = !!msg.ready;
    room.broadcastAll({ type: 'room_updated', room: room.publicInfo() });
    return;
  }

  if (type === 'start_game') {
    const room = roomManager.getRoomByPlayer(playerId);
    if (!room) return send(ws, { type: 'error', reason: 'Not in a room' });
    if (room.hostId !== playerId) return send(ws, { type: 'error', reason: 'Only the host can start' });
    const result = roomManager.startGame(room.code);
    if (!result.ok) return send(ws, { type: 'error', reason: result.reason });
    broadcastRoomList();
    return;
  }

  if (type === 'add_bot') {
    const room = roomManager.getRoomByPlayer(playerId);
    if (!room) return send(ws, { type: 'error', reason: 'Not in a room' });
    if (room.hostId !== playerId) return send(ws, { type: 'error', reason: 'Only the host can add bots' });
    const result = roomManager.addBot(room.code);
    if (!result.ok) return send(ws, { type: 'error', reason: result.reason });
    room.broadcastAll({ type: 'room_updated', room: room.publicInfo() });
    broadcastRoomList();
    return;
  }

  if (type === 'remove_bot') {
    const room = roomManager.getRoomByPlayer(playerId);
    if (!room) return send(ws, { type: 'error', reason: 'Not in a room' });
    if (room.hostId !== playerId) return send(ws, { type: 'error', reason: 'Only the host can remove bots' });
    const result = roomManager.removeBot(room.code);
    if (!result.ok) return send(ws, { type: 'error', reason: result.reason });
    room.broadcastAll({ type: 'room_updated', room: room.publicInfo() });
    broadcastRoomList();
    return;
  }

  // ── Gameplay ─────────────────────────────────────────────────────────────────
  if (type === 'play_cards' || type === 'pass_turn' || type === 'play_card') {
    const room = roomManager.getRoomByPlayer(playerId);
    if (!room || !room.engine) return send(ws, { type: 'error', reason: 'Game not started' });

    let result;
    if (type === 'play_cards')  result = room.engine.playCards(playerId, msg.cards || []);
    else if (type === 'pass_turn') result = room.engine.pass(playerId);
    else result = room.engine.playCard(playerId, msg.card);

    if (!result.ok) return send(ws, { type: 'play_result', ok: false, reason: result.reason });

    const state = room.engine.getPublicState();
    room.broadcastAll({ type: 'play_result', ok: true, events: result.events, gameState: state });

    // Game over — update ELO + coins
    if (state.finished) {
      room.state = 'finished';
      const rankings = state.rankings;
      AuthService.recordMatchResult(rankings, rankings);

      // Bet payout: winner gets pot
      if (room.betAmount > 0) {
        const pot = room.betAmount * room.players.length;
        AuthService.addCoins(rankings[0], pot);
        room.players.forEach(p => {
          if (p.id !== rankings[0]) AuthService.addCoins(p.id, -room.betAmount);
        });
      }
    }
    return;
  }

  // ── Chat (UTF-8 + Khmer ✅) ──────────────────────────────────────────────────
  if (type === 'send_chat') {
    const room = roomManager.getRoomByPlayer(playerId);
    if (!room) return;
    const text = String(msg.text || '').slice(0, 100); // max 100 chars
    if (!text.trim()) return;
    room.broadcastAll({ type: 'chat', playerId, playerName, text, timestamp: Date.now() });
    return;
  }

  // ── Emotes ────────────────────────────────────────────────────────────────────
  if (type === 'send_emote') {
    const room = roomManager.getRoomByPlayer(playerId);
    if (room) room.broadcast({ type: 'emote', playerId, playerName, emote: msg.emote });
    return;
  }

  // ── Friend Invite ─────────────────────────────────────────────────────────────
  if (type === 'invite_friend') {
    const room = roomManager.getRoomByPlayer(playerId);
    if (!room) return send(ws, { type: 'error', reason: 'Not in a room' });
    // Find friend's ws
    for (const [friendWs, c] of clients.entries()) {
      if (c.playerName.toLowerCase() === (msg.friendName || '').toLowerCase()) {
        send(friendWs, {
          type: 'friend_invite',
          fromId: playerId, fromName: playerName,
          roomCode: room.code, gameType: room.gameType,
        });
        return send(ws, { type: 'invite_sent', to: msg.friendName });
      }
    }
    return send(ws, { type: 'error', reason: 'Friend not found or offline' });
  }

  // ── Leaderboard (via WS) ──────────────────────────────────────────────────────
  if (type === 'get_leaderboard') {
    return send(ws, {
      type: 'leaderboard',
      leaderboard: AuthService.getLeaderboard(msg.gameType || 'tien_len', msg.limit || 20),
    });
  }

  send(ws, { type: 'error', reason: `Unknown message type: ${type}` });
}
