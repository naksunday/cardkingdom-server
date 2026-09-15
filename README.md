# CardKingdom Multiplayer Server 🃏

Real-time WebSocket server for **Tiến Lên** and **Katte** — lets players on any
device/location play together over the internet.

---

## Quick Start (Play with Friends — Same PC)

```bash
cd Server
npm install
node server.js
```

Server runs at **ws://localhost:3000**

---

## Play Over the Internet (Different Houses)

### Option A — ngrok (free, instant, no account needed)

```bash
# Terminal 1 — run server
node server.js

# Terminal 2 — expose it
npx ngrok http 3000
```

Copy the `wss://xxxxxxxx.ngrok.io` URL and send it to your friend.
In Unity → Lobby → paste the URL in the **Server URL** field → Connect.

### Option B — Deploy to Render.com (always online, free tier)

1. Push the `Server/` folder to a GitHub repo.
2. Go to [render.com](https://render.com) → New → Web Service.
3. Connect your repo, set:
   - **Build command**: `npm install`
   - **Start command**: `node server.js`
4. Done — you get a permanent `wss://yourapp.onrender.com` URL.

---

## Protocol (JSON over WebSocket)

### Client → Server

| Message type      | Fields                                 | Description                 |
|-------------------|----------------------------------------|-----------------------------|
| `connect_player`  | `playerId`, `playerName`               | Handshake (required first)  |
| `create_room`     | `gameType`, `pin?`, `maxPlayers?`      | Create a new room           |
| `join_room`       | `code`, `pin?`                         | Join by room code           |
| `leave_room`      | —                                      | Leave current room          |
| `list_rooms`      | —                                      | List public rooms           |
| `set_ready`       | `ready`                                | Toggle ready state          |
| `start_game`      | —                                      | Host starts the game        |
| `play_cards`      | `cards:[{rank,suit}]`                  | Tiến Lên — play cards       |
| `pass_turn`       | —                                      | Tiến Lên — pass             |
| `play_card`       | `card:{rank,suit}`                     | Katte — play one card       |
| `send_emote`      | `emote`                                | Send a reaction             |
| `ping`            | —                                      | Keepalive                   |

### Card Format

```json
{ "rank": 0-12, "suit": 0-3 }
```

- Rank: `0=3, 1=4, …, 10=K, 11=A, 12=2`
- Suit: `0=Spades, 1=Clubs, 2=Diamonds, 3=Hearts`

### Server → Client

| Message type    | Description                                   |
|-----------------|-----------------------------------------------|
| `connected`     | Confirmed handshake, server version           |
| `room_created`  | Room info after creation                      |
| `room_joined`   | Room info after joining                       |
| `room_updated`  | Player joined/left/ready changed              |
| `room_list`     | Array of public rooms                         |
| `game_started`  | `yourHand` (private) + initial `gameState`    |
| `game_state`    | Public game state update                      |
| `play_result`   | `ok`, `reason`, `events[]`, new `gameState`   |
| `emote`         | Player sent a reaction                        |
| `player_left`   | A player disconnected                         |
| `host_changed`  | Host was promoted to someone else             |
| `error`         | Server-side error with `reason`               |
| `pong`          | Response to `ping`                            |

---

## File Structure

```
Server/
├── server.js            ← WebSocket entry point
├── RoomManager.js       ← Room lifecycle & player management
├── package.json
├── engines/
│   ├── TienLenEngine.js ← Full Tiến Lên rules (validated server-side)
│   └── KatteEngine.js   ← Full Katte rules (follow-suit, trick resolution)
└── utils/
    └── CardDeck.js      ← Shared deck/card utilities

Unity/
└── Assets/Scripts/Network/
    ├── NetworkLobbyClient.cs  ← WebSocket client + UnityEvents
    └── NetworkLobbyUI.cs      ← Lobby UI controller
```

---

## Anti-Cheat

All rules are enforced **100% server-side**:

- ✅ Cards are validated against the player's actual server-side hand
- ✅ Hand type classification happens on the server
- ✅ "Beats" logic checked before any play is accepted
- ✅ Turn order enforced — playing out of turn returns an error
- ✅ First-turn 3♠ requirement for Tiến Lên

Clients only send card selections; the server decides if they are legal.
