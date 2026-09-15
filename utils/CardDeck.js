/**
 * CardDeck.js
 * Shared card utilities for all game engines.
 * Card value format: { suit: 0-3, rank: 0-12 }
 *   Suits: 0=Spades, 1=Clubs, 2=Diamonds, 3=Hearts  (Tien Len order)
 *   Ranks: 0=3, 1=4, ..., 9=Q, 10=K, 11=A, 12=2
 */

const SUITS = ['Spades', 'Clubs', 'Diamonds', 'Hearts'];
const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];

/**
 * Build a fresh 52-card deck.
 * @returns {Array<{suit:number, rank:number}>}
 */
function buildDeck() {
  const deck = [];
  for (let suit = 0; suit < 4; suit++) {
    for (let rank = 0; rank < 13; rank++) {
      deck.push({ suit, rank });
    }
  }
  return deck;
}

/**
 * Fisher-Yates shuffle (in-place, returns deck).
 */
function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/**
 * Compare two cards.  Returns negative if a < b, 0 if equal, positive if a > b.
 * Tien Len ordering: rank first, then suit.
 */
function compareCards(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  return a.suit - b.suit;
}

/**
 * Return a human-readable label for a card.
 */
function cardLabel(card) {
  return `${RANKS[card.rank]}${SUITS[card.suit][0]}`; // e.g. "3S", "2H"
}

/**
 * Compute the absolute power of a card (0 = 3♠, 51 = 2♥).
 */
function cardPower(card) {
  return card.rank * 4 + card.suit;
}

module.exports = { buildDeck, shuffle, compareCards, cardLabel, cardPower, SUITS, RANKS };
