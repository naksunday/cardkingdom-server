/**
 * TienLenEngine.js
 * Server-side Tiến Lên (Southern Vietnamese card game) rules engine.
 *
 * Rules enforced:
 *  - Valid hand types: Single, Pair, Triple, Quad, Sequence (3+ same-rank combos for pairs/triples)
 *  - 2s can be beaten by Quads or Sequences of 4+ pairs
 *  - Play must beat the current table lead
 *  - Turn rotation (clockwise)
 *  - First turn of the game must include 3♠ (lowest card)
 *  - Automatic win detection when a player empties their hand
 */

const { buildDeck, shuffle, compareCards, cardPower } = require('../utils/CardDeck');

const HandType = {
  SINGLE: 'single',
  PAIR: 'pair',
  TRIPLE: 'triple',
  SEQUENCE: 'sequence',          // straight of 3+ cards
  PAIR_SEQUENCE: 'pair_sequence',// consecutive pairs (3+ pairs)
  QUAD: 'quad',                  // 4 of a kind — beats a 2
  INVALID: 'invalid',
};

/** Classify an array of card objects.  Returns { type, power } or {type:INVALID}. */
function classifyHand(cards) {
  if (!cards || cards.length === 0) return { type: HandType.INVALID };
  const sorted = [...cards].sort(compareCards);
  const n = sorted.length;

  // --- Single ---
  if (n === 1) return { type: HandType.SINGLE, power: cardPower(sorted[0]), cards: sorted };

  // --- All same rank? ---
  const allSameRank = sorted.every(c => c.rank === sorted[0].rank);
  if (allSameRank) {
    if (n === 2) return { type: HandType.PAIR, power: cardPower(sorted[1]), cards: sorted };
    if (n === 3) return { type: HandType.TRIPLE, power: cardPower(sorted[2]), cards: sorted };
    if (n === 4) return { type: HandType.QUAD, power: cardPower(sorted[3]), cards: sorted };
    return { type: HandType.INVALID }; // 5 of same rank impossible
  }

  // --- Sequence (straight) ---
  if (n >= 3) {
    const isSeq = sorted.every((c, i) => i === 0 || c.rank === sorted[i - 1].rank + 1);
    // Sequences cannot contain 2s (rank 12)
    const has2 = sorted.some(c => c.rank === 12);
    if (isSeq && !has2) {
      return { type: HandType.SEQUENCE, power: cardPower(sorted[n - 1]), length: n, cards: sorted };
    }
  }

  // --- Consecutive pairs (pair sequence, 3+ pairs = 6+ cards) ---
  if (n >= 6 && n % 2 === 0) {
    const pairs = [];
    for (let i = 0; i < n; i += 2) {
      if (sorted[i].rank !== sorted[i + 1].rank) break;
      pairs.push(sorted[i].rank);
    }
    if (pairs.length === n / 2) {
      const consecutive = pairs.every((r, i) => i === 0 || r === pairs[i - 1] + 1);
      if (consecutive) {
        return { type: HandType.PAIR_SEQUENCE, power: cardPower(sorted[n - 1]), pairCount: pairs.length, cards: sorted };
      }
    }
  }

  return { type: HandType.INVALID };
}

/** Return true if `challenger` beats `current` play on the table. */
function beats(current, challenger) {
  if (!current) return true; // no one on table — anything goes

  const ct = current.type;
  const cht = challenger.type;

  // A 2 can only be beaten by a Quad or Pair-Sequence (4+ pairs)
  if (ct === HandType.SINGLE && current.cards[0].rank === 12) {
    if (cht === HandType.QUAD) return true;
    if (cht === HandType.PAIR_SEQUENCE && challenger.pairCount >= 4) return true;
    return false;
  }

  // Types must match (except special beats above)
  if (ct !== cht) return false;

  // Sequences must be the same length
  if (ct === HandType.SEQUENCE && current.length !== challenger.length) return false;
  if (ct === HandType.PAIR_SEQUENCE && current.pairCount !== challenger.pairCount) return false;

  return challenger.power > current.power;
}

class TienLenEngine {
  constructor(playerIds) {
    this.playerIds = [...playerIds];      // ordered list of player IDs
    this.hands = {};                      // playerId -> [cards]
    this.currentTurnIdx = 0;             // index into playerIds
    this.tablePlay = null;               // { playerId, classified }
    this.tableLeadIdx = null;            // who last played (idx)
    this.passedCount = 0;                // consecutive passes
    this.roundNumber = 0;
    this.started = false;
    this.finished = false;
    this.rankings = [];                  // finish order
    this.firstTurn = true;
  }

  /** Deal cards. Returns { [playerId]: [cards] } for the server to send privately. */
  deal() {
    const deck = shuffle(buildDeck());
    const cardsPerPlayer = 13;
    this.hands = {};
    this.playerIds.forEach((id, i) => {
      this.hands[id] = deck.slice(i * cardsPerPlayer, (i + 1) * cardsPerPlayer);
    });

    // Determine starter: player with lowest card (3♠ = rank 0, suit 0 is lowest)
    let lowestPlayer = 0;
    let lowestCard = { rank: 99, suit: 99 };
    this.playerIds.forEach((pid, idx) => {
      for (const c of this.hands[pid]) {
        if (c.rank < lowestCard.rank || (c.rank === lowestCard.rank && c.suit < lowestCard.suit)) {
          lowestCard = c;
          lowestPlayer = idx;
        }
      }
    });

    this.lowestCard = lowestCard;
    this.currentTurnIdx = lowestPlayer;
    this.tableLeadIdx = this.currentTurnIdx;
    this.started = true;
    this.firstTurn = true;

    return this.hands;
  }

  get currentPlayer() { return this.playerIds[this.currentTurnIdx]; }

  /** Attempt a play. Returns { ok, reason, events } */
  playCards(playerId, cardObjects) {
    if (!this.started || this.finished) return { ok: false, reason: 'Game not active' };
    if (playerId !== this.currentPlayer) return { ok: false, reason: 'Not your turn' };

    // Validate the player actually holds these cards
    const hand = this.hands[playerId];
    for (const c of cardObjects) {
      const idx = hand.findIndex(h => h.rank === c.rank && h.suit === c.suit);
      if (idx === -1) return { ok: false, reason: 'Card not in hand' };
    }

    const classified = classifyHand(cardObjects);
    if (classified.type === HandType.INVALID) return { ok: false, reason: 'Invalid hand type' };

    // First turn of the entire game must include the lowest card held in the game
    if (this.firstTurn && this.lowestCard) {
      const hasLowest = cardObjects.some(c => c.rank === this.lowestCard.rank && c.suit === this.lowestCard.suit);
      if (!hasLowest) return { ok: false, reason: 'First play must include your lowest card' };
    }

    // Must beat the table
    if (!beats(this.tablePlay, classified)) {
      return { ok: false, reason: 'Does not beat the current play' };
    }

    // Remove cards from hand
    for (const c of cardObjects) {
      const idx = hand.findIndex(h => h.rank === c.rank && h.suit === c.suit);
      hand.splice(idx, 1);
    }

    this.tablePlay = classified;
    this.tableLeadIdx = this.currentTurnIdx;
    this.passedCount = 0;
    this.firstTurn = false;

    const events = [{ event: 'play', playerId, cards: cardObjects, handType: classified.type }];

    // Check win
    if (hand.length === 0) {
      this.rankings.push(playerId);
      const remaining = this.playerIds.filter(p => this.hands[p].length > 0 || !this.rankings.includes(p));
      if (this.playerIds.length - this.rankings.length <= 1) {
        // Last player remaining is the loser
        const loser = this.playerIds.find(p => !this.rankings.includes(p));
        if (loser) this.rankings.push(loser);
        this.finished = true;
        events.push({ event: 'game_over', rankings: this.rankings });
      } else {
        events.push({ event: 'player_finished', playerId, rank: this.rankings.length });
      }
    }

    if (!this.finished) this._advanceTurn();
    return { ok: true, events };
  }

  /** Pass the turn. Returns { ok, reason, events } */
  pass(playerId) {
    if (!this.started || this.finished) return { ok: false, reason: 'Game not active' };
    if (playerId !== this.currentPlayer) return { ok: false, reason: 'Not your turn' };
    if (!this.tablePlay) return { ok: false, reason: 'Cannot pass when you are the lead' };
    // Cannot pass if you are the table lead
    if (this.tableLeadIdx === this.currentTurnIdx) return { ok: false, reason: 'You are the lead — must play' };

    this.passedCount++;
    const events = [{ event: 'pass', playerId }];

    const activePlayers = this.playerIds.filter(p => this.hands[p] && this.hands[p].length > 0);
    // Everyone else passed → table lead becomes new free lead
    if (this.passedCount >= activePlayers.length - 1) {
      this.tablePlay = null;
      this.passedCount = 0;
      this.currentTurnIdx = this.tableLeadIdx;
      events.push({ event: 'new_round_lead', playerId: this.currentPlayer });
    } else {
      this._advanceTurn();
    }
    return { ok: true, events };
  }

  _advanceTurn() {
    do {
      this.currentTurnIdx = (this.currentTurnIdx + 1) % this.playerIds.length;
    } while (this.hands[this.currentPlayer]?.length === 0);
  }

  getPublicState() {
    const handCounts = {};
    this.playerIds.forEach(p => { handCounts[p] = this.hands[p]?.length ?? 0; });
    return {
      currentPlayer: this.currentPlayer,
      tablePlay: this.tablePlay ? { type: this.tablePlay.type, cards: this.tablePlay.cards } : null,
      handCounts,
      rankings: this.rankings,
      finished: this.finished,
    };
  }
}

module.exports = { TienLenEngine, classifyHand, beats, HandType };
