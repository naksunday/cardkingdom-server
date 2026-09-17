/**
 * AuthService.js
 * Player account registration, login, and JWT token validation.
 * Uses Supabase as the database backend.
 */

const crypto = require('crypto');

// ── Simple JWT (no external dep needed) ───────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'cardkingdom-secret-change-in-prod';

function base64url(str) {
  return Buffer.from(str).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signJWT(payload) {
  const header  = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body    = base64url(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86400 * 30 })); // 30 days
  const sig     = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyJWT(token) {
  try {
    const [header, body, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp < Math.floor(Date.now() / 1000)) return null; // expired
    return payload;
  } catch { return null; }
}

// ── Password hashing ──────────────────────────────────────────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.createHmac('sha256', salt).update(password).digest('hex');
  return `${salt}:${hash}`;
}

function checkPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const attempt = crypto.createHmac('sha256', salt).update(password).digest('hex');
  return attempt === hash;
}

// ── In-memory player store (replace with Supabase queries later) ─────────────
const players = new Map(); // username -> player object

class AuthService {
  register({ username, password, email }) {
    if (!username || username.length < 3)
      return { ok: false, reason: 'Username must be at least 3 characters' };
    if (!password || password.length < 6)
      return { ok: false, reason: 'Password must be at least 6 characters' };
    if (players.has(username.toLowerCase()))
      return { ok: false, reason: 'Username already taken' };

    const id = crypto.randomUUID().slice(0, 8);
    const player = {
      id,
      username,
      email: email || '',
      passwordHash: hashPassword(password),
      coins: 10000,
      exp: 0,
      level: 1,
      avatarIndex: 0,
      customAvatar: null,
      friends: [],
      elo: 1200,
      wins: 0,
      losses: 0,
      createdAt: new Date().toISOString(),
    };
    players.set(username.toLowerCase(), player);
    const token = signJWT({ id, username });
    return { ok: true, token, player: this._public(player) };
  }

  login({ username, password }) {
    const player = players.get(username.toLowerCase());
    if (!player) return { ok: false, reason: 'Username not found' };
    if (!checkPassword(password, player.passwordHash))
      return { ok: false, reason: 'Incorrect password' };
    const token = signJWT({ id: player.id, username: player.username });
    return { ok: true, token, player: this._public(player) };
  }

  validateToken(token) {
    const payload = verifyJWT(token);
    if (!payload) return null;
    return players.get(payload.username.toLowerCase()) || null;
  }

  getPlayer(username) {
    return players.get(username.toLowerCase()) || null;
  }

  getPlayerById(id) {
    if (!id) return null;
    return [...players.values()].find(p => p.id === id || p.id.toLowerCase() === id.toLowerCase()) || null;
  }

  getLeaderboard(gameType, limit = 20) {
    return [...players.values()]
      .sort((a, b) => b.elo - a.elo)
      .slice(0, limit)
      .map((p, i) => ({ rank: i + 1, ...this._public(p) }));
  }

  recordMatchResult(playerIds, rankings) {
    // ELO update: K=32
    const K = 32;
    const N = playerIds.length;
    const eloMap = {};

    playerIds.forEach(id => {
      const p = [...players.values()].find(pl => pl.id === id);
      if (p) eloMap[id] = { player: p, elo: p.elo };
    });

    rankings.forEach((winnerId, winnerRank) => {
      rankings.forEach((loserId, loserRank) => {
        if (winnerRank >= loserRank) return;
        const w = eloMap[winnerId];
        const l = eloMap[loserId];
        if (!w || !l) return;
        const expected = 1 / (1 + Math.pow(10, (l.elo - w.elo) / 400));
        w.elo += K * (1 - expected);
        l.elo += K * (0 - (1 - expected));
      });
    });

    // Apply ELO changes + update win/loss + grant EXP
    Object.values(eloMap).forEach(({ player, elo }, idx) => {
      player.elo = Math.max(100, Math.round(elo));
      if (rankings[0] === player.id) {
        player.wins++;
        this.addExp(player.id, 150);
      } else {
        player.losses++;
        this.addExp(player.id, 50);
      }
    });
  }

  addCoins(playerId, amount) {
    const p = this.getPlayerById(playerId);
    if (p) {
      p.coins = Math.max(0, (p.coins || 0) + amount);
      return p.coins;
    }
    return 0;
  }

  addExp(playerId, amount) {
    const p = this.getPlayerById(playerId);
    if (p) {
      p.exp = Math.max(0, (p.exp || 0) + amount);
      p.level = 1 + Math.floor(p.exp / 300);
      return { exp: p.exp, level: p.level };
    }
    return { exp: 0, level: 1 };
  }

  updateProfile(playerId, updates = {}) {
    const p = this.getPlayerById(playerId);
    if (!p) return null;

    if (typeof updates.coins === 'number') p.coins = Math.max(0, updates.coins);
    if (typeof updates.exp === 'number') {
      p.exp = Math.max(0, updates.exp);
      p.level = 1 + Math.floor(p.exp / 300);
    }
    if (typeof updates.avatarIndex === 'number') p.avatarIndex = updates.avatarIndex;
    if (updates.customAvatar !== undefined) p.customAvatar = updates.customAvatar;
    if (updates.username && updates.username.length >= 2) p.username = updates.username;

    return this._public(p);
  }

  addFriend(playerId, targetId) {
    if (!playerId || !targetId) return { ok: false, reason: 'Invalid player IDs' };
    if (playerId.toLowerCase() === targetId.toLowerCase()) return { ok: false, reason: 'Cannot add yourself as a friend' };

    const p = this.getPlayerById(playerId);
    const target = this.getPlayerById(targetId);

    if (!target) return { ok: false, reason: 'Player with ID ' + targetId + ' not found' };

    p.friends = p.friends || [];
    target.friends = target.friends || [];

    if (p.friends.includes(target.id)) return { ok: false, reason: 'Already in your friends list' };

    p.friends.push(target.id);
    if (!target.friends.includes(p.id)) target.friends.push(p.id);

    return { ok: true, friend: this._public(target) };
  }

  getFriends(playerId) {
    const p = this.getPlayerById(playerId);
    if (!p || !p.friends) return [];
    return p.friends
      .map(id => this.getPlayerById(id))
      .filter(Boolean)
      .map(f => this._public(f));
  }

  _public(player) {
    const exp = player.exp || 0;
    return {
      id: player.id,
      username: player.username,
      coins: player.coins ?? 10000,
      exp: exp,
      level: player.level || (1 + Math.floor(exp / 300)),
      avatarIndex: player.avatarIndex || 0,
      customAvatar: player.customAvatar || null,
      friendsCount: (player.friends || []).length,
      elo: player.elo || 1200,
      wins: player.wins || 0,
      losses: player.losses || 0,
    };
  }
}

module.exports = { AuthService: new AuthService(), verifyJWT, signJWT };
