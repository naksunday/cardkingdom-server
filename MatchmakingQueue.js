/**
 * MatchmakingQueue.js
 * Auto-pairs players of similar ELO into a game room.
 *
 * Flow:
 *   1. Client sends { type: "quick_match", gameType }
 *   2. Player is added to the queue for that game type
 *   3. When enough players are found within ELO range → room is auto-created
 *   4. All matched players receive { type: "match_found", room }
 *
 * ELO range: starts at ±200, expands by 100 every 10 seconds of waiting
 */

const ELO_START_RANGE  = 200;
const ELO_EXPAND_RATE  = 100;  // expand by this per tick
const ELO_EXPAND_EVERY = 10000; // ms
const TICK_INTERVAL    = 2000;  // check queue every 2s

const MIN_PLAYERS = { tien_len: 2, katte: 4 };
const MAX_PLAYERS = { tien_len: 4, katte: 4 };

class MatchmakingQueue {
  constructor(roomManager) {
    this.roomManager = roomManager;
    // queues: { tien_len: [{playerId, playerName, elo, ws, joinedAt}], katte: [...] }
    this.queues = { tien_len: [], katte: [] };
    this._interval = setInterval(() => this._tick(), TICK_INTERVAL);
    console.log('[Matchmaking] Queue ready');
  }

  /** Add player to queue. Returns { ok, reason }. */
  enqueue({ playerId, playerName, elo = 1200, gameType, ws }) {
    const q = this.queues[gameType];
    if (!q) return { ok: false, reason: `Unknown game type: ${gameType}` };
    if (q.find(p => p.playerId === playerId))
      return { ok: false, reason: 'Already in queue' };

    q.push({ playerId, playerName, elo, gameType, ws, joinedAt: Date.now() });
    console.log(`[Matchmaking] ${playerName} (ELO ${elo}) joined ${gameType} queue (${q.length} waiting)`);
    return { ok: true };
  }

  /** Remove player from all queues (e.g. they disconnected). */
  dequeue(playerId) {
    for (const q of Object.values(this.queues)) {
      const idx = q.findIndex(p => p.playerId === playerId);
      if (idx !== -1) { q.splice(idx, 1); return; }
    }
  }

  /** Periodic match check. */
  _tick() {
    for (const [gameType, q] of Object.entries(this.queues)) {
      if (q.length < MIN_PLAYERS[gameType]) continue;
      this._tryMatch(gameType, q);
    }
  }

  _tryMatch(gameType, q) {
    const now = Date.now();

    // Sort by ELO
    q.sort((a, b) => a.elo - b.elo);

    const needed = MIN_PLAYERS[gameType];

    // Sliding window: try to find `needed` players within ELO range
    for (let i = 0; i <= q.length - needed; i++) {
      const anchor = q[i];
      const waitSec = (now - anchor.joinedAt) / 1000;
      const range = ELO_START_RANGE + Math.floor(waitSec / (ELO_EXPAND_EVERY / 1000)) * ELO_EXPAND_RATE;

      const group = [anchor];
      for (let j = i + 1; j < q.length && group.length < needed; j++) {
        if (Math.abs(q[j].elo - anchor.elo) <= range) {
          group.push(q[j]);
        }
      }

      if (group.length >= needed) {
        // Remove from queue
        for (const p of group) {
          const idx = q.indexOf(p);
          if (idx !== -1) q.splice(idx, 1);
        }
        this._createMatch(gameType, group);
        return; // restart next tick
      }
    }
  }

  _createMatch(gameType, players) {
    const hostId   = players[0].playerId;
    const hostName = players[0].playerName;

    const room = this.roomManager.createRoom({
      gameType,
      hostId,
      hostName,
      pin: null,
      maxPlayers: players.length,
    });

    // Add remaining players
    for (let i = 1; i < players.length; i++) {
      const p = players[i];
      this.roomManager.joinRoom({
        code: room.code,
        playerId: p.playerId,
        playerName: p.playerName,
        pin: null,
        ws: p.ws,
      });
    }

    // Update ws references
    room.getPlayer(hostId).ws = players[0].ws;

    // Notify all matched players
    const info = room.publicInfo();
    for (const p of players) {
      if (p.ws && p.ws.readyState === 1) {
        p.ws.send(JSON.stringify({ type: 'match_found', room: info }));
      }
    }

    // Auto-start
    const result = this.roomManager.startGame(room.code);
    if (!result.ok) {
      console.error('[Matchmaking] Auto-start failed:', result.reason);
    }

    console.log(`[Matchmaking] Match created: ${room.code} (${gameType}) with ${players.map(p => p.playerName).join(', ')}`);
  }

  destroy() { clearInterval(this._interval); }
}

module.exports = { MatchmakingQueue };
