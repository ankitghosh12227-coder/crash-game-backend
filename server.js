// server.js
const { WebSocketServer } = require('ws');

const PORT = 8080;
const wss = new WebSocketServer({ port: PORT });

console.log(`[SERVER] Stairway Crash backend running on ws://localhost:${PORT}`);

let gameState = 'IDLE'; // IDLE, STARTING, RUNNING, CRASHED
let currentMultiplier = 1.00;
let crashPoint = 1.00;
let roundStartTime = 0;
let loopInterval = null;

const players = new Map();
let nextPlayerId = 1;

function generateCrashPoint() {
  const r = Math.random() * 100;
  if (r < 3) return 1.00; // 3% instant house edge
  return Math.max(1.00, Number((97 / (100 - r)).toFixed(2)));
}

function broadcast(data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(payload);
    }
  });
}

function startCountdown() {
  gameState = 'STARTING';
  let countdown = 5; // 5 seconds betting window

  broadcast({
    type: 'ROUND_STARTING',
    countdown: countdown
  });

  const timer = setInterval(() => {
    countdown--;
    if (countdown > 0) {
      broadcast({ type: 'COUNTDOWN', countdown });
    } else {
      clearInterval(timer);
      startRound();
    }
  }, 1000);
}

function startRound() {
  gameState = 'RUNNING';
  crashPoint = generateCrashPoint();
  currentMultiplier = 1.00;
  roundStartTime = Date.now();

  console.log(`[ROUND STARTED] Predetermined Crash Point: ${crashPoint}x`);

  broadcast({
    type: 'ROUND_STARTED'
  });

  loopInterval = setInterval(() => {
    const elapsedSeconds = (Date.now() - roundStartTime) / 1000;
    currentMultiplier = Number(Math.exp(0.065 * elapsedSeconds).toFixed(2));

    broadcast({
      type: 'TICK',
      multiplier: currentMultiplier
    });

    if (currentMultiplier >= crashPoint) {
      triggerCrash();
    }
  }, 50);
}

function triggerCrash() {
  clearInterval(loopInterval);
  gameState = 'CRASHED';

  console.log(`[ROUND CRASHED] Lightning struck at ${crashPoint}x`);

  players.forEach((player, ws) => {
    if (player.activeBet && !player.activeBet.cashedOut) {
      player.activeBet = null;
      ws.send(JSON.stringify({ type: 'BET_LOST', balance: player.balance }));
    }
  });

  broadcast({
    type: 'ROUND_CRASHED',
    crashMultiplier: crashPoint
  });

  // 3-second cooldown before starting the next round
  setTimeout(() => {
    gameState = 'IDLE';
    startCountdown();
  }, 3000);
}

wss.on('connection', (ws) => {
  const player = {
    id: nextPlayerId++,
    balance: 1000.00,
    activeBet: null
  };
  players.set(ws, player);

  console.log(`[CONNECT] Player ${player.id} joined the room.`);

  ws.send(JSON.stringify({
    type: 'INIT',
    id: player.id,
    balance: player.balance,
    gameState: gameState,
    multiplier: currentMultiplier
  }));

  if (gameState === 'IDLE') {
    startCountdown();
  }

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'PLACE_BET') {
        const betAmount = parseFloat(data.amount);

        if (gameState !== 'STARTING' && gameState !== 'IDLE') {
          return ws.send(JSON.stringify({ type: 'ERROR', message: 'Round already in progress. Wait for next round.' }));
        }
        if (isNaN(betAmount) || betAmount <= 0 || betAmount > player.balance) {
          return ws.send(JSON.stringify({ type: 'ERROR', message: 'Invalid bet amount.' }));
        }

        player.balance -= betAmount;
        player.activeBet = {
          amount: betAmount,
          cashedOut: false
        };

        console.log(`[BET] Player ${player.id} placed bet: $${betAmount}`);

        ws.send(JSON.stringify({
          type: 'BET_ACCEPTED',
          amount: betAmount,
          balance: player.balance
        }));
      }

      if (data.type === 'CASH_OUT') {
        if (gameState !== 'RUNNING') return;
        if (!player.activeBet || player.activeBet.cashedOut) return;

        player.activeBet.cashedOut = true;
        const winAmount = Number((player.activeBet.amount * currentMultiplier).toFixed(2));
        player.balance += winAmount;

        console.log(`[CASHOUT] Player ${player.id} cashed out at ${currentMultiplier}x (Won: $${winAmount})`);

        ws.send(JSON.stringify({
          type: 'CASH_OUT_SUCCESS',
          winAmount: winAmount,
          multiplier: currentMultiplier,
          balance: player.balance
        }));

        player.activeBet = null;
      }
    } catch (err) {
      console.error('[ERROR] Failed to parse message:', err);
    }
  });

  ws.on('close', () => {
    console.log(`[DISCONNECT] Player ${player.id} left.`);
    players.delete(ws);
  });
});