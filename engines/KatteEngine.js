/**
 * KatteEngine.js
 * Server-side Katte (Cambodian trick-taking card game) rules engine.
 *
 * Rules:
 *  - 4 players, 52 cards dealt 13 each
 *  - 6 rounds (the 6 highest-value rounds count)
 *  - Each round: lead player plays one card, others must follow suit if possible
 *  - Highest card of the led suit wins the trick (no trump)
 *  - Player who wins the trick leads the next one
 *  - Scoring: each trick = 1 point; player with most points wins
 */

const { buildDeck, shuffle, compareCards } = require('../utils/CardDeck');

class KatteEngine {
  constructor(playerIds) {
    if (playerIds.length !== 4) throw new Error('Katte requires exactly 4 players');
    this.playerIds = [...playerIds];
    this.hands = {};
    this.trickNumber = 0;          // 0-based, max 13 tricks total
    this.totalTricks = 13;
    this.currentTrick = [];        // [{playerId, card}]
    this.leadSuit = null;
    this.scores = {};
    this.playerIds.forEach(p => { this.scores[p] = 0; });
    this.currentTurnIdx = 0;
    this.started = false;
    this.finished = false;
    this.trickHistory = [];
  }

  deal() {
    const deck = shuffle(buildDeck());
    this.hands = {};
    this.playerIds.forEach((id, i) => {
      this.hands[id] = deck.slice(i * 13, (i + 1) * 13);
    });
    this.started = true;
    this.currentTurnIdx = 0; // first player leads first trick
    return this.hands;
  }

  get currentPlayer() { return this.playerIds[this.currentTurnIdx]; }

  /** Play a card. Returns { ok, reason, events } */
  playCard(playerId, card) {
    if (!this.started || this.finished) return { ok: false, reason: 'Game not active' };
    if (playerId !== this.currentPlayer) return { ok: false, reason: 'Not your turn' };

    const hand = this.hands[playerId];
    const cardIdx = hand.findIndex(c => c.rank === card.rank && c.suit === card.suit);
    if (cardIdx === -1) return { ok: false, reason: 'Card not in hand' };

    // Follow-suit rule
    if (this.leadSuit !== null) {
      const hasSuit = hand.some(c => c.suit === this.leadSuit);
      if (hasSuit && card.suit !== this.leadSuit) {
        return { ok: false, reason: 'Must follow suit' };
      }
    }

    // Remove card from hand
    hand.splice(cardIdx, 1);
    if (this.currentTrick.length === 0) this.leadSuit = card.suit;
    this.currentTrick.push({ playerId, card });

    const events = [{ event: 'card_played', playerId, card }];

    // Trick complete?
    if (this.currentTrick.length === this.playerIds.length) {
      const winner = this._resolveTrick();
      this.scores[winner]++;
      this.trickHistory.push({ trick: [...this.currentTrick], winner });
      events.push({ event: 'trick_won', winner, trick: [...this.currentTrick] });

      this.currentTrick = [];
      this.leadSuit = null;
      this.trickNumber++;

      if (this.trickNumber >= this.totalTricks) {
        this.finished = true;
        const rankedPlayers = [...this.playerIds].sort((a, b) => this.scores[b] - this.scores[a]);
        events.push({ event: 'game_over', scores: { ...this.scores }, rankings: rankedPlayers });
      } else {
        // Winner leads next trick
        this.currentTurnIdx = this.playerIds.indexOf(winner);
        events.push({ event: 'next_trick', currentPlayer: this.currentPlayer });
      }
    } else {
      this._advanceTurn();
      events.push({ event: 'next_turn', currentPlayer: this.currentPlayer });
    }

    return { ok: true, events };
  }

  _resolveTrick() {
    // Winner = highest card of led suit
    const ledCards = this.currentTrick.filter(p => p.card.suit === this.leadSuit);
    ledCards.sort((a, b) => compareCards(b.card, a.card));
    return ledCards[0].playerId;
  }

  _advanceTurn() {
    this.currentTurnIdx = (this.currentTurnIdx + 1) % this.playerIds.length;
  }

  getPublicState() {
    const handCounts = {};
    this.playerIds.forEach(p => { handCounts[p] = this.hands[p]?.length ?? 0; });
    return {
      currentPlayer: this.currentPlayer,
      trickNumber: this.trickNumber,
      currentTrick: this.currentTrick,
      scores: { ...this.scores },
      finished: this.finished,
      handCounts,
    };
  }
}

module.exports = { KatteEngine };
