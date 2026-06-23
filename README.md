# SAP Kahoot — Team Meeting Quiz Platform

A self-hosted, Kahoot-style real-time quiz platform built for team meetings. Players join from any device on the same network using a 6-digit PIN.

Branded with the **SAP color palette** (see `temp.pdf`).

---

## Features

- **4 question types** — Quiz (multiple choice), True/False, Poll, Word Cloud — matching the Kahoot session in `Kahoot_AI_Icebreaker_Session.md`.
- **Multi-device** — host screen on a laptop/TV, players join via phone or laptop.
- **Real-time** — Socket.io keeps everything in sync. Live answer counts, leaderboards, podium.
- **QR code** — host screen shows a scannable QR so players join without typing.
- **Music & sound effects** — lobby music, question-start chime, ticking clock, correct/wrong stings, podium fanfare. Toggle from the host top bar.
- **Built-in editor** — create/edit/delete quizzes from the browser at `/admin.html`. Quizzes persist to `data/quizzes.json`.
- **Pre-seeded** — the "Are You Smarter Than a Chatbot?" quiz from your MD file is included out of the box.
- **Score logic** — Kahoot-style: faster correct answers score more. Double-point questions supported.
- **Public-URL field** on the host screen — paste your tunnel URL when hosting a virtual meeting; the QR code regenerates to point there.

---

## Hosting a VIRTUAL meeting (players joining remotely)

Your laptop running `npm start` only serves `localhost` + your local LAN by default. Remote players (Teams/Zoom call attendees) cannot reach that. You have three options — pick the easiest one for your situation.

### Option 1 — ngrok tunnel (fastest, free)

In a second terminal, with the server running:

```bash
npx ngrok http 3000
```

ngrok prints a public `https://xxxxx.ngrok-free.app` URL. Open the **host screen** in your browser, paste that URL into the **Public URL** field, and press Tab. The QR code and the on-screen URL update instantly. Remote players scan the QR or open the link — done.

> First time only: create a free ngrok account, run `ngrok config add-authtoken <token>`. Free tier is plenty for a 25-minute session.

### Option 2 — Cloudflare Tunnel (no signup)

```bash
# install cloudflared once (https://github.com/cloudflare/cloudflared/releases)
cloudflared tunnel --url http://localhost:3000
```

It prints a `https://xxx.trycloudflare.com` URL — paste it into the host screen's Public URL field, same as ngrok.

### Option 3 — Deploy to a host

Push the project to **Render**, **Railway**, **Fly.io**, or any VM. Build command: `npm install`. Start command: `npm start`. No code changes needed — the public URL just works, no tunnel required.

### Tips for virtual meetings

- **Share your screen** with the host view (`/host.html`) so everyone sees the question + QR + leaderboard.
- **Read the question aloud** for accessibility.
- The **QR code** + the visible URL + the PIN make joining trivial: scan, type a nickname, play.
- Test the tunnel **before** the meeting — try joining from your phone on cellular (Wi-Fi off) to confirm it works outside your network.

---

## Quick start

```bash
npm install
npm start
```

The server prints three URLs:

```
 Host screen:    http://localhost:3000/host.html
 Admin/editor:   http://localhost:3000/admin.html
 Player join:    http://localhost:3000/
```

It also prints your machine's LAN IP — share that URL with players on the same Wi-Fi:

```
 Players on the same network can also join via:
   http://192.168.1.42:3000/
```

---

## Running a session

1. **(Optional) Edit questions** at `http://localhost:3000/admin.html`.
2. **Open the host screen** on the meeting room display: `http://localhost:3000/host.html`.
3. Pick the quiz and click **Create game** — a 6-digit PIN is shown.
4. **Players join** at `http://<your-IP>:3000/` and enter the PIN + nickname.
5. Host clicks **Start ▶** to fire the first question. Use **Next ▶** after each reveal, or **Show leaderboard** between questions.
6. After the last question, the **podium** is shown automatically.

### Letting players join from their phones

Players' phones must be on the same network as the host machine **unless you use a public tunnel** — see the "Hosting a VIRTUAL meeting" section above.

### Firewall (Windows)

If players on your LAN can't reach `http://<your-IP>:3000/`, allow Node through the Windows Firewall the first time it asks, or open TCP port 3000 inbound.

---

## Project layout

```
server.js                  # Express + Socket.io server, game state machine, /qr endpoint
data/seed.js               # Default quiz (AI Ice-Breaker session)
data/quizzes.json          # Persistent quiz store (auto-created)
public/
  styles.css               # SAP-palette shared styles
  sounds.js                # WebAudio sound engine (music + SFX, no files needed)
  index.html               # Player view (phone-friendly)
  host.html                # Host / big-screen view (QR + Public URL field)
  admin.html               # Quiz editor
```

---

## Question types

| Type        | Players see                       | Scoring                                      |
| ----------- | --------------------------------- | -------------------------------------------- |
| `quiz`      | 4 colored tiles, one is correct   | Speed-weighted; `points: 'double'` supported |
| `truefalse` | True / False tiles                | Speed-weighted                               |
| `poll`      | 2–4 tiles, no correct answer      | No points (opinion)                          |
| `wordcloud` | Single text input (40 chars max)  | No points; answers shown as a word cloud     |

---

## Tech

- Node.js, Express, Socket.io
- Vanilla HTML/CSS/JS on the client — no build step, no framework
- SAP color palette baked in via CSS variables in `public/styles.css`
