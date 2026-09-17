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

function getClientByPlayerId(playerId) {
  if (!playerId) return null;
  const targetId = playerId.toString().toLowerCase().trim();
  const player = AuthService.getPlayerById(playerId);
  const realId = player ? (player.id || '').toLowerCase().trim() : targetId;
  const realName = player ? (player.username || '').toLowerCase().trim() : '';

  for (const [ws, c] of clients.entries()) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    const cId = (c.playerId || '').toString().toLowerCase().trim();
    const cName = (c.playerName || '').toString().toLowerCase().trim();
    if (cId === targetId || cId === realId || (realName && cName === realName) || cName === targetId) {
      return { ws, client: c };
    }
  }
  return null;
}

function broadcastPresenceToFriends(playerId, status, currentRoomCode = null, gameType = null) {
  const player = AuthService.getPlayerById(playerId);
  if (!player || !player.friends || player.friends.length === 0) return;
  const presenceMsg = {
    type: 'friend_presence_updated',
    friendId: player.id,
    name: player.username,
    status: status, // 'online_lobby' | 'playing' | 'offline'
    currentRoomCode: currentRoomCode || null,
    gameType: gameType || null,
    avatarIndex: player.avatarIndex || 0,
    customAvatar: player.customAvatar || null,
    coins: player.coins || 0,
    level: player.level || 1,
    vipLevel: Math.min(10, Math.max(1, Math.floor((player.level || 1) / 5) + 1))
  };
  player.friends.forEach(frId => {
    const onlineFr = getClientByPlayerId(frId);
    if (onlineFr) {
      send(onlineFr.ws, presenceMsg);
    }
  });
}

// ── WebSocket connections ─────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  // Send immediate welcome handshake confirmation
  send(ws, { type: 'connected', serverVersion: '2.0.0' });

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

    // Broadcast offline presence to friends
    broadcastPresenceToFriends(client.playerId, 'offline');

    clients.delete(ws);
    console.log(`[WS] ${client.playerName} (${client.playerId}) disconnected`);
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

  // Legacy guest connect or sync profile
  if (type === 'connect_player' || type === 'sync_profile') {
    const { playerId, playerName, avatarIndex, customAvatar, coins, exp } = msg;
    if (!playerId) return send(ws, { type: 'error', reason: 'connect_player requires playerId' });
    const name = playerName || 'Player';
    const av = typeof avatarIndex === 'number' ? avatarIndex : 0;

    let playerRecord = AuthService.getPlayerById(playerId);
    if (!playerRecord) {
      playerRecord = {
        id: playerId,
        username: name,
        coins: typeof coins === 'number' ? coins : 10000,
        exp: typeof exp === 'number' ? exp : 0,
        level: 1 + Math.floor((exp || 0) / 300),
        avatarIndex: av,
        customAvatar: customAvatar || null,
        friends: [],
        elo: 1200,
        wins: 0,
        losses: 0,
        createdAt: new Date().toISOString(),
      };
      // Register in AuthService
      AuthService.updateProfile(playerId, playerRecord) || (playerRecord = AuthService._public(playerRecord));
    } else {
      const updates = {};
      if (typeof coins === 'number') updates.coins = coins;
      if (typeof exp === 'number') updates.exp = exp;
      if (typeof avatarIndex === 'number') updates.avatarIndex = avatarIndex;
      if (customAvatar !== undefined) updates.customAvatar = customAvatar;
      if (name) updates.username = name;
      playerRecord = AuthService.updateProfile(playerId, updates) || playerRecord;
    }

    clients.set(ws, {
      playerId,
      playerName: playerRecord.username || name,
      avatarIndex: playerRecord.avatarIndex ?? av,
      customAvatar: playerRecord.customAvatar || null,
      coins: playerRecord.coins ?? 10000,
      exp: playerRecord.exp ?? 0,
      level: playerRecord.level ?? 1,
      elo: playerRecord.elo ?? 1200,
      status: 'online_lobby',
      currentRoomCode: null,
      gameType: null,
      token: null,
    });

    broadcastPresenceToFriends(playerId, 'online_lobby');

    console.log(`[WS] ${playerRecord.username} (ID:${playerId}, av:${playerRecord.avatarIndex}, coins:${playerRecord.coins}) connected & synced`);
    return send(ws, {
      type: 'profile_synced',
      playerId,
      playerName: playerRecord.username,
      coins: playerRecord.coins,
      exp: playerRecord.exp,
      level: playerRecord.level,
      avatarIndex: playerRecord.avatarIndex,
      customAvatar: playerRecord.customAvatar,
      serverVersion: '2.0.0',
    });
  }

  // ── All other messages require identification ───────────────────────────────
  const client = clients.get(ws);
  if (!client) return send(ws, { type: 'error', reason: 'Send connect_player or login first' });
  const { playerId, playerName } = client;
  const avatarIndex = typeof msg.avatarIndex === 'number' ? msg.avatarIndex : (client.avatarIndex || 0);

  if (type === 'ping') return send(ws, { type: 'pong', timestamp: Date.now() });

  // ── Profile Real-time Update ────────────────────────────────────────────────
  if (type === 'update_profile') {
    const updates = {};
    if (typeof msg.avatarIndex === 'number') {
      client.avatarIndex = msg.avatarIndex;
      updates.avatarIndex = msg.avatarIndex;
    }
    if (msg.customAvatar !== undefined) {
      client.customAvatar = msg.customAvatar;
      updates.customAvatar = msg.customAvatar;
    }
    if (msg.playerName) {
      client.playerName = msg.playerName;
      updates.username = msg.playerName;
    }
    if (typeof msg.coins === 'number') {
      client.coins = msg.coins;
      updates.coins = msg.coins;
    }
    if (typeof msg.exp === 'number') {
      client.exp = msg.exp;
      updates.exp = msg.exp;
    }

    const updated = AuthService.updateProfile(playerId, updates);

    // If player is in a room, broadcast update to everyone in the room
    const room = roomManager.getRoomByPlayer(playerId);
    if (room) {
      const p = room.getPlayer(playerId);
      if (p) {
        p.name = client.playerName;
        p.avatarIndex = client.avatarIndex;
        p.customAvatar = client.customAvatar;
      }
      room.broadcastAll({
        type: 'player_profile_changed',
        playerId,
        playerName: client.playerName,
        avatarIndex: client.avatarIndex,
        customAvatar: client.customAvatar,
      });
    }

    return send(ws, {
      type: 'profile_updated',
      ok: true,
      profile: updated || client,
    });
  }

  // ── Friends API (Real-Time) ──────────────────────────────────────────────────
  if (type === 'get_friends') {
    const friendList = AuthService.getFriends(playerId);
    const enriched = friendList.map(fr => {
      const frClient = getClientByPlayerId(fr.id);
      let status = 'offline';
      let currentRoomCode = null;
      let gameType = null;
      if (frClient) {
        status = frClient.client.status || 'online_lobby';
        currentRoomCode = frClient.client.currentRoomCode || null;
        gameType = frClient.client.gameType || null;
      }
      return {
        id: fr.id,
        name: fr.username,
        vipLevel: Math.min(10, Math.max(1, Math.floor((fr.level || 1) / 5) + 1)),
        coins: fr.coins || 0,
        level: fr.level || 1,
        avatarIndex: fr.avatarIndex || 0,
        customAvatar: fr.customAvatar || null,
        status: status,
        currentRoomCode: currentRoomCode,
        gameType: gameType,
      };
    });
    return send(ws, { type: 'friends_list', friends: enriched });
  }

  // ── Friends API (Real-Time Requests & Confirmation) ─────────────────────────

  if (type === 'add_friend' || type === 'send_friend_request') {
    const targetId = msg.targetId || msg.friendId;
    const result = AuthService.sendFriendRequest(playerId, targetId);
    if (!result.ok) {
      return send(ws, { type: 'send_friend_request_result', ok: false, reason: result.reason });
    }

    // Direct friendship occurred (both requested each other)
    if (result.friend) {
      const frClient = getClientByPlayerId(result.friend.id);
      let frStatus = frClient ? (frClient.client.status || 'online_lobby') : 'offline';
      let rCode = frClient ? frClient.client.currentRoomCode : null;
      let gType = frClient ? frClient.client.gameType : null;

      const friendPayload = {
        id: result.friend.id,
        name: result.friend.username,
        vipLevel: Math.min(10, Math.max(1, Math.floor((result.friend.level || 1) / 5) + 1)),
        coins: result.friend.coins || 0,
        level: result.friend.level || 1,
        avatarIndex: result.friend.avatarIndex || 0,
        customAvatar: result.friend.customAvatar || null,
        status: frStatus,
        currentRoomCode: rCode,
        gameType: gType,
      };

      if (frClient) {
        send(frClient.ws, {
          type: 'friend_request_accepted',
          friend: {
            id: playerId,
            name: client.playerName,
            vipLevel: Math.min(10, Math.max(1, Math.floor((client.level || 1) / 5) + 1)),
            coins: client.coins || 0,
            level: client.level || 1,
            avatarIndex: client.avatarIndex || 0,
            customAvatar: client.customAvatar || null,
            status: client.status || 'online_lobby',
            currentRoomCode: client.currentRoomCode || null,
            gameType: client.gameType || null,
          }
        });
      }

      send(ws, {
        type: 'friend_request_accepted',
        friend: friendPayload,
        message: `You and ${result.friend.username} are now friends!`
      });

      broadcastPresenceToFriends(playerId, client.status || 'online_lobby', client.currentRoomCode, client.gameType);
      if (frClient) {
        broadcastPresenceToFriends(result.friend.id, frStatus, rCode, gType);
      }
      return;
    }

    // Pending friend request
    const targetOnline = getClientByPlayerId(result.target.id);
    if (targetOnline) {
      send(targetOnline.ws, {
        type: 'friend_request_received',
        fromPlayer: {
          id: playerId,
          name: client.playerName,
          avatarIndex: client.avatarIndex || 0,
          customAvatar: client.customAvatar || null,
          vipLevel: Math.min(10, Math.max(1, Math.floor((client.level || 1) / 5) + 1)),
          level: client.level || 1,
          coins: client.coins || 0,
        }
      });
    }

    return send(ws, {
      type: 'send_friend_request_result',
      ok: true,
      targetId: result.target.id,
      message: `Friend request sent to ${result.target.username} (${result.target.id})! Waiting for confirmation... ✉️`
    });
  }

  if (type === 'accept_friend_request') {
    const fromId = msg.fromId || msg.friendId || msg.targetId;
    const result = AuthService.acceptFriendRequest(playerId, fromId);
    if (!result.ok) {
      return send(ws, { type: 'accept_friend_request_result', ok: false, reason: result.reason });
    }

    const frClient = getClientByPlayerId(result.friend.id);
    let frStatus = frClient ? (frClient.client.status || 'online_lobby') : 'offline';
    let rCode = frClient ? frClient.client.currentRoomCode : null;
    let gType = frClient ? frClient.client.gameType : null;

    const friendPayload = {
      id: result.friend.id,
      name: result.friend.username,
      vipLevel: Math.min(10, Math.max(1, Math.floor((result.friend.level || 1) / 5) + 1)),
      coins: result.friend.coins || 0,
      level: result.friend.level || 1,
      avatarIndex: result.friend.avatarIndex || 0,
      customAvatar: result.friend.customAvatar || null,
      status: frStatus,
      currentRoomCode: rCode,
      gameType: gType,
    };

    if (frClient) {
      send(frClient.ws, {
        type: 'friend_request_accepted',
        friend: {
          id: playerId,
          name: client.playerName,
          vipLevel: Math.min(10, Math.max(1, Math.floor((client.level || 1) / 5) + 1)),
          coins: client.coins || 0,
          level: client.level || 1,
          avatarIndex: client.avatarIndex || 0,
          customAvatar: client.customAvatar || null,
          status: client.status || 'online_lobby',
          currentRoomCode: client.currentRoomCode || null,
          gameType: client.gameType || null,
        }
      });
    }

    send(ws, {
      type: 'friend_request_accepted',
      friend: friendPayload,
      message: `Accepted friend request from ${result.friend.username}!`
    });

    broadcastPresenceToFriends(playerId, client.status || 'online_lobby', client.currentRoomCode, client.gameType);
    if (frClient) {
      broadcastPresenceToFriends(result.friend.id, frStatus, rCode, gType);
    }
    return;
  }

  if (type === 'decline_friend_request') {
    const fromId = msg.fromId || msg.friendId || msg.targetId;
    const result = AuthService.declineFriendRequest(playerId, fromId);
    return send(ws, { type: 'decline_friend_request_result', ok: result.ok, declinedId: result.declinedId });
  }

  if (type === 'get_friend_requests') {
    const pendingRequests = AuthService.getFriendRequests(playerId);
    return send(ws, {
      type: 'friend_requests_list',
      requests: pendingRequests.map(r => ({
        id: r.id,
        name: r.username,
        avatarIndex: r.avatarIndex || 0,
        customAvatar: r.customAvatar || null,
        coins: r.coins || 0,
        level: r.level || 1,
        vipLevel: Math.min(10, Math.max(1, Math.floor((r.level || 1) / 5) + 1)),
      }))
    });
  }

  if (type === 'invite_friend') {
    const targetId = msg.friendId || msg.targetId;
    const target = getClientByPlayerId(targetId);
    if (!target) {
      return send(ws, {
        type: 'invite_friend_result',
        ok: false,
        friendId: targetId,
        reason: 'Friend is currently offline.',
      });
    }

    const currentRoom = roomManager.getRoomByPlayer(playerId);
    const roomCode = msg.roomCode || (currentRoom ? currentRoom.code : '');
    const gameType = msg.gameType || (currentRoom ? currentRoom.gameType : 'tienlen');
    const betAmount = typeof msg.betAmount === 'number' ? msg.betAmount : (currentRoom ? currentRoom.betAmount : 0);

    send(target.ws, {
      type: 'friend_invite_received',
      fromPlayerId: playerId,
      fromPlayerName: client.playerName,
      avatarIndex: client.avatarIndex,
      roomCode: roomCode,
      gameType: gameType,
      betAmount: betAmount,
    });

    return send(ws, {
      type: 'invite_friend_result',
      ok: true,
      friendId: targetId,
      message: `Invitation sent to ${target.client.playerName}! ✉️`,
    });
  }

  if (type === 'remove_friend') {
    const targetId = msg.friendId || msg.targetId;
    const result = AuthService.removeFriend(playerId, targetId);
    return send(ws, { type: 'remove_friend_result', ok: result.ok, removedId: result.removedId });
  }

  // ── Matchmaking ─────────────────────────────────────────────────────────────
  if (type === 'quick_match') {
    const result = matchmakingQueue.enqueue({
      playerId, playerName,
      avatarIndex,
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
        hostAvatarIndex: avatarIndex,
        pin: msg.pin || null, maxPlayers: msg.maxPlayers || 4,
        betAmount: msg.betAmount || 0,
      });
      room.getPlayer(playerId).ws = ws;
      console.log(`[Room] ${playerName} created ${room.code} (${room.gameType}) bet:${room.betAmount || 0} avatar:${avatarIndex}`);
      
      client.status = 'playing';
      client.currentRoomCode = room.code;
      client.gameType = room.gameType;
      broadcastPresenceToFriends(playerId, 'playing', room.code, room.gameType);

      send(ws, { type: 'room_created', room: room.publicInfo() });
      broadcastRoomList();
      return;
    } catch (err) { return send(ws, { type: 'error', reason: err.message }); }
  }

  if (type === 'join_room') {
    const result = roomManager.joinRoom({ code: msg.code, playerId, playerName, pin: msg.pin || null, ws, avatarIndex });
    if (!result.ok) return send(ws, { type: 'error', reason: result.reason });

    client.status = 'playing';
    client.currentRoomCode = result.room.code;
    client.gameType = result.room.gameType;
    broadcastPresenceToFriends(playerId, 'playing', result.room.code, result.room.gameType);

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
    client.status = 'online_lobby';
    client.currentRoomCode = null;
    client.gameType = null;
    broadcastPresenceToFriends(playerId, 'online_lobby');
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
    scheduleBotTurn(room);
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

      // Broadcast real-time Coins & EXP to all human players in room
      room.players.forEach(p => {
        const record = AuthService.getPlayerById(p.id);
        if (record && p.ws && p.ws.readyState === WebSocket.OPEN) {
          send(p.ws, {
            type: 'profile_updated',
            coins: record.coins,
            exp: record.exp,
            level: record.level,
            reason: p.id === rankings[0] ? 'Victory Pot!' : 'Match Completed',
          });
        }
      });
    } else {
      scheduleBotTurn(room);
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

// ── Bot AI Automation ─────────────────────────────────────────────────────────
function scheduleBotTurn(room) {
  if (!room || !room.engine || room.state !== 'playing' || room.engine.finished) return;
  const currentPid = room.engine.currentPlayer;
  if (!currentPid || !currentPid.startsWith('bot_')) return;

  setTimeout(() => {
    if (!room || !room.engine || room.state !== 'playing' || room.engine.finished) return;
    if (room.engine.currentPlayer !== currentPid) return;

    const move = findBotMove(room.engine, currentPid);
    let result;
    if (move && move.length > 0) {
      result = room.engine.playCards(currentPid, move);
    } else {
      result = room.engine.pass(currentPid);
    }

    if (result && result.ok) {
      const state = room.engine.getPublicState();
      room.broadcastAll({ type: 'play_result', ok: true, events: result.events, gameState: state });

      if (state.finished) {
        room.state = 'finished';
        const rankings = state.rankings;
        AuthService.recordMatchResult(rankings, rankings);
        if (room.betAmount > 0) {
          const pot = room.betAmount * room.players.length;
          AuthService.addCoins(rankings[0], pot);
          room.players.forEach(p => {
            if (p.id !== rankings[0]) AuthService.addCoins(p.id, -room.betAmount);
          });
        }
      } else {
        scheduleBotTurn(room);
      }
    }
  }, 1000);
}

function findBotMove(engine, botId) {
  const hand = engine.hands ? engine.hands[botId] : null;
  if (!hand || hand.length === 0) return null;

  const sortedHand = [...hand].sort((a, b) => {
    const pA = (a.rank === 12 ? 100 : a.rank) * 4 + a.suit;
    const pB = (b.rank === 12 ? 100 : b.rank) * 4 + b.suit;
    return pA - pB;
  });

  const tablePlay = engine.tablePlay;

  // Free lead
  if (!tablePlay) {
    if (engine.firstTurn && engine.lowestCard) {
      return [engine.lowestCard];
    }
    return [sortedHand[0]];
  }

  // Beat Single
  if (tablePlay.type === 'single') {
    const target = tablePlay.cards[0];
    const targetPower = (target.rank === 12 ? 100 : target.rank) * 4 + target.suit;
    for (const card of sortedHand) {
      const p = (card.rank === 12 ? 100 : card.rank) * 4 + card.suit;
      if (p > targetPower) {
        return [card];
      }
    }
    return null;
  }

  // Beat Pair
  if (tablePlay.type === 'pair') {
    const targetMax = tablePlay.cards[1] || tablePlay.cards[0];
    const targetPower = (targetMax.rank === 12 ? 100 : targetMax.rank) * 4 + targetMax.suit;
    for (let i = 0; i < sortedHand.length - 1; i++) {
      if (sortedHand[i].rank === sortedHand[i + 1].rank) {
        const pair = [sortedHand[i], sortedHand[i + 1]];
        const p = (pair[1].rank === 12 ? 100 : pair[1].rank) * 4 + pair[1].suit;
        if (p > targetPower) {
          return pair;
        }
      }
    }
    return null;
  }

  // Beat Triple
  if (tablePlay.type === 'triple') {
    const targetMax = tablePlay.cards[2] || tablePlay.cards[0];
    const targetPower = (targetMax.rank === 12 ? 100 : targetMax.rank) * 4 + targetMax.suit;
    for (let i = 0; i < sortedHand.length - 2; i++) {
      if (sortedHand[i].rank === sortedHand[i + 1].rank && sortedHand[i].rank === sortedHand[i + 2].rank) {
        const triple = [sortedHand[i], sortedHand[i + 1], sortedHand[i + 2]];
        const p = (triple[2].rank === 12 ? 100 : triple[2].rank) * 4 + triple[2].suit;
        if (p > targetPower) {
          return triple;
        }
      }
    }
    return null;
  }

  return null; // Pass
}
