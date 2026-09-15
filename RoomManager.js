/**
 * RoomManager.js
 * Manages game rooms: creation, joining, starting, and cleanup.
 *
 * Room lifecycle:
 *   waiting → playing → finished
 */

const { v4: uuidv4 } = require('uuid');
const { TienLenEngine } = require('./engines/TienLenEngine');
const { KatteEngine } = require('./engines/KatteEngine');

const GAME_TYPES = { TIEN_LEN: 'tien_len', KATTE: 'katte' };
const MAX_PLAYERS = { [GAME_TYPES.TIEN_LEN]: 4, [GAME_TYPES.KATTE]: 4 };
const MIN_PLAYERS = { [GAME_TYPES.TIEN_LEN]: 2, [GAME_TYPES.KATTE]: 4 };

/** Generate a short room code like TL-1024 */
function generateCode(gameType) {
  const prefix = gameType === GAME_TYPES.TIEN_LEN ? 'TL' : 'KT';
  const num = Math.floor(1000 + Math.random() * 8999);
  return `${prefix}-${num}`;
}

class Room {
  constructor({ gameType, hostId, hostName, pin, maxPlayers, betAmount }) {
    this.id = uuidv4();
    this.code = generateCode(gameType);
    this.gameType = gameType;
    this.hostId = hostId;
    this.pin = pin || null;         // optional PIN (4 digits)
    this.maxPlayers = Math.min(maxPlayers || MAX_PLAYERS[gameType], MAX_PLAYERS[gameType]);
    this.state = 'waiting';         // waiting | playing | finished
    this.players = [];              // [{ id, name, ws, ready }]
    this.engine = null;
    this.betAmount = betAmount || 0;   // coins each player bets; winner takes all
    this.createdAt = Date.now();

    // Add host immediately
    this.addPlayer(hostId, hostName, null);
  }

  addPlayer(id, name, ws) {
    this.players.push({ id, name, ws, ready: false });
  }

  removePlayer(id) {
    this.players = this.players.filter(p => p.id !== id);
  }

  getPlayer(id) { return this.players.find(p => p.id === id); }

  get playerIds() { return this.players.map(p => p.id); }

  isFull() { return this.players.length >= this.maxPlayers; }

  broadcast(msg, excludeId = null) {
    const raw = JSON.stringify(msg);
    for (const p of this.players) {
      if (p.id !== excludeId && p.ws && p.ws.readyState === 1 /* OPEN */) {
        p.ws.send(raw);
      }
    }
  }

  broadcastAll(msg) { this.broadcast(msg, null); }

  /** Send to a single player. */
  send(playerId, msg) {
    const p = this.getPlayer(playerId);
    if (p && p.ws && p.ws.readyState === 1) {
      p.ws.send(JSON.stringify(msg));
    }
  }

  publicInfo() {
    return {
      code: this.code,
      gameType: this.gameType,
      state: this.state,
      playerCount: this.players.length,
      maxPlayers: this.maxPlayers,
      hasPin: !!this.pin,
      betAmount: this.betAmount || 0,
      players: this.players.map(p => ({ id: p.id, name: p.name, ready: p.ready })),
    };
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map(); // code -> Room
    this.playerRoom = new Map(); // playerId -> roomCode

    // Clean up empty/finished rooms every 10 minutes
    setInterval(() => this._cleanup(), 10 * 60 * 1000);
  }

  createRoom(opts) {
    if (!Object.values(GAME_TYPES).includes(opts.gameType)) {
      throw new Error(`Unknown game type: ${opts.gameType}`);
    }
    if (opts.pin && !/^\d{4}$/.test(opts.pin)) {
      throw new Error('PIN must be exactly 4 digits');
    }
    const room = new Room(opts);
    this.rooms.set(room.code, room);
    this.playerRoom.set(opts.hostId, room.code);
    return room;
  }

  getRoom(code) { return this.rooms.get(code) || null; }

  getRoomByPlayer(playerId) {
    const code = this.playerRoom.get(playerId);
    return code ? this.rooms.get(code) : null;
  }

  joinRoom({ code, playerId, playerName, pin, ws }) {
    const room = this.rooms.get(code);
    if (!room) return { ok: false, reason: 'Room not found' };
    if (room.state !== 'waiting') return { ok: false, reason: 'Game already started' };
    if (room.isFull()) return { ok: false, reason: 'Room is full' };
    if (room.pin && room.pin !== pin) return { ok: false, reason: 'Incorrect PIN' };

    // If player is reconnecting
    const existing = room.getPlayer(playerId);
    if (existing) {
      existing.ws = ws;
      this.playerRoom.set(playerId, code);
      return { ok: true, room, reconnected: true };
    }

    room.addPlayer(playerId, playerName, ws);
    this.playerRoom.set(playerId, code);
    return { ok: true, room, reconnected: false };
  }

  leaveRoom(playerId) {
    const room = this.getRoomByPlayer(playerId);
    if (!room) return;
    room.removePlayer(playerId);
    this.playerRoom.delete(playerId);

    if (room.players.length === 0) {
      this.rooms.delete(room.code);
    } else if (room.hostId === playerId) {
      // Promote next player to host
      room.hostId = room.players[0].id;
      room.broadcastAll({ type: 'host_changed', newHostId: room.hostId });
    }
  }

  /** Start game — deal cards and send private hands. Returns events to broadcast. */
  startGame(code) {
    const room = this.rooms.get(code);
    if (!room) return { ok: false, reason: 'Room not found' };
    if (room.state !== 'waiting') return { ok: false, reason: 'Already started' };
    if (room.players.length < MIN_PLAYERS[room.gameType]) {
      return { ok: false, reason: `Need at least ${MIN_PLAYERS[room.gameType]} players` };
    }

    if (room.gameType === GAME_TYPES.TIEN_LEN) {
      room.engine = new TienLenEngine(room.playerIds);
    } else {
      if (room.players.length !== 4) return { ok: false, reason: 'Katte needs exactly 4 players' };
      room.engine = new KatteEngine(room.playerIds);
    }

    const hands = room.engine.deal();
    room.state = 'playing';

    // Send each player their private hand
    for (const pid of room.playerIds) {
      room.send(pid, { type: 'game_started', yourHand: hands[pid], gameState: room.engine.getPublicState() });
    }

    room.broadcastAll({ type: 'game_state', gameState: room.engine.getPublicState() });
    return { ok: true };
  }

  listPublicRooms() {
    const list = [];
    for (const room of this.rooms.values()) {
      if (!room.pin && room.state === 'waiting') {
        list.push(room.publicInfo());
      }
    }
    return list;
  }

  _cleanup() {
    const now = Date.now();
    for (const [code, room] of this.rooms.entries()) {
      const age = now - room.createdAt;
      const isEmpty = room.players.length === 0;
      const isFinished = room.state === 'finished';
      const isStale = age > 2 * 60 * 60 * 1000; // 2 hours
      if (isEmpty || isFinished || isStale) {
        this.rooms.delete(code);
      }
    }
  }
}

module.exports = { RoomManager, GAME_TYPES };
