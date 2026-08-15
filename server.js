const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// SQLite Adatbázis inicializálása
const db = new Database('game.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS leaderboard (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playerName TEXT NOT NULL,
    score INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

app.use(express.static('public'));

const games = {};
let onlineUsers = [];

// Botnevek gyűjteménye (Eltávolítva a "(Bot)" utótag)
const BOT_NAMES = [
  "Maris", "Pista", "Csibész", "Vándor", 
  "Gépész", "Napsugár", "Kiscsillag", "Józsibá", 
  "Vasutas", "Betyár", "Sárkány", "Mester"
];

function getRandomBotName(existingPlayers) {
  const existingNames = existingPlayers.map(p => p.name);
  const availableNames = BOT_NAMES.filter(name => !existingNames.includes(name));
  
  if (availableNames.length > 0) {
    return availableNames[Math.floor(Math.random() * availableNames.length)];
  }
  return `Bot ${existingPlayers.length + 1}`;
}

function evaluateMultiplayerRound(players) {
  const choices = players.map(p => p.choice);
  const uniqueChoices = [...new Set(choices)];

  if (uniqueChoices.length === 3 || uniqueChoices.length === 1) {
    return {
      type: 'draw',
      message: uniqueChoices.length === 3 
        ? 'Döntetlen! Mindhárom szimbólum (Kő, Papír, Olló) jelen volt.' 
        : `Döntetlen! Mindenki ezt mutatta: ${translateChoice(uniqueChoices[0])}.`,
      winners: []
    };
  }

  const c1 = uniqueChoices[0];
  const c2 = uniqueChoices[1];
  let winningChoice = '';

  if ((c1 === 'ko' && c2 === 'ollo') || (c1 === 'ollo' && c2 === 'ko')) winningChoice = 'ko';
  else if ((c1 === 'papir' && c2 === 'ko') || (c1 === 'ko' && c2 === 'papir')) winningChoice = 'papir';
  else if ((c1 === 'ollo' && c2 === 'papir') || (c1 === 'papir' && c2 === 'ollo')) winningChoice = 'ollo';

  const losingChoice = uniqueChoices.find(c => c !== winningChoice);
  const winners = players.filter(p => p.choice === winningChoice);

  winners.forEach(w => w.score++);

  const winnerNames = winners.map(w => w.name).join(', ');
  const message = `${winnerNames} nyerte a kört! (${translateChoice(winningChoice)} üti a következőt: ${translateChoice(losingChoice)})`;

  return { type: 'win', message, winners };
}

function translateChoice(choice) {
  if (choice === 'ko') return 'Kő';
  if (choice === 'papir') return 'Papír';
  if (choice === 'ollo') return 'Olló';
  return choice;
}

function broadcastOnlineUsers() {
  io.emit('online-users-list', onlineUsers.map(u => u.name));
}

function getLeaderboard() {
  const stmt = db.prepare('SELECT playerName, score FROM leaderboard ORDER BY score DESC, id ASC LIMIT 10');
  return stmt.all();
}

function broadcastLeaderboard() {
  io.emit('leaderboard-updated', getLeaderboard());
}

function saveScoresToLeaderboard(players) {
  const insert = db.prepare('INSERT INTO leaderboard (playerName, score) VALUES (?, ?)');
  const insertMany = db.transaction((playerList) => {
    for (const p of playerList) {
      if (!p.isBot && p.score > 0) {
        insert.run(p.name, p.score);
      }
    }
  });
  insertMany(players);
  broadcastLeaderboard();
}

function makeBotChoices(game) {
  const options = ['ko', 'papir', 'ollo'];
  game.players.forEach(p => {
    if (p.isBot && p.choice === null) {
      p.choice = options[Math.floor(Math.random() * options.length)];
    }
  });
}

function checkAndEvaluateRound(roomId) {
  const game = games[roomId];
  if (!game) return;

  const allChosen = game.players.every(p => p.choice !== null);

  if (allChosen) {
    const result = evaluateMultiplayerRound(game.players);
    game.players.forEach(p => p.choice = null);

    if (game.currentRound >= game.maxRounds) {
      game.status = 'befejezve';
      
      const maxScore = Math.max(...game.players.map(p => p.score));
      const overallWinners = game.players.filter(p => p.score === maxScore).map(p => p.name).join(', ');

      saveScoresToLeaderboard(game.players);

      io.to(roomId).emit('game-over', {
        game,
        roundResult: result.message,
        finalMessage: `A játék véget ért! Végső győztes(ek): ${overallWinners} (${maxScore} pont)`
      });

      io.emit('games-list', getPublicGamesList());
    } else {
      game.currentRound++;
      io.to(roomId).emit('round-ended', { 
        game, 
        roundResult: result.message, 
        winners: result.winners 
      });
    }
  } else {
    const chosenCount = game.players.filter(p => p.choice !== null).length;
    io.to(roomId).emit('player-chose', { 
      chosenCount, 
      totalPlayers: game.players.length 
    });
  }
}

io.on('connection', (socket) => {
  socket.emit('games-list', getPublicGamesList());
  socket.emit('online-users-list', onlineUsers.map(u => u.name));
  socket.emit('leaderboard-updated', getLeaderboard());

  socket.on('user-login', ({ playerName }) => {
    const existingIndex = onlineUsers.findIndex(u => u.id === socket.id);
    if (existingIndex !== -1) {
      onlineUsers[existingIndex].name = playerName;
    } else {
      onlineUsers.push({ id: socket.id, name: playerName });
    }
    broadcastOnlineUsers();
  });

  socket.on('create-game', ({ playerName }) => {
    const roomId = 'szoba_' + Math.floor(1000 + Math.random() * 9000);

    games[roomId] = {
      roomId,
      hostId: socket.id,
      status: 'játékosokra vár',
      currentRound: 1,
      maxRounds: 5,
      botCount: 0,
      players: [
        { id: socket.id, name: playerName, score: 0, choice: null, isBot: false }
      ]
    };

    socket.join(roomId);
    socket.emit('game-created', { roomId });
    io.to(roomId).emit('game-updated', games[roomId]);
    io.emit('games-list', getPublicGamesList());
  });

  socket.on('add-bot', ({ roomId }) => {
    const game = games[roomId];
    if (game && game.hostId === socket.id && game.status === 'játékosokra vár') {
      game.botCount++;
      const botId = `bot_${Date.now()}_${game.botCount}`;
      const botName = getRandomBotName(game.players);
      
      game.players.push({
        id: botId,
        name: botName,
        score: 0,
        choice: null,
        isBot: true
      });
      
      io.to(roomId).emit('game-updated', game);
      io.emit('games-list', getPublicGamesList());
    }
  });

  socket.on('join-game', ({ roomId, playerName }) => {
    const game = games[roomId];
    if (!game || game.status !== 'játékosokra vár') {
      socket.emit('game-cancelled', {
        message: 'Ehhez a játékhoz nem lehet csatlakozni, mert már elindult vagy megszűnt.'
      });
      return;
    }

    game.players.push({ id: socket.id, name: playerName, score: 0, choice: null, isBot: false });
    
    socket.join(roomId);
    io.to(roomId).emit('game-updated', game);
    io.emit('games-list', getPublicGamesList());
  });

  socket.on('start-game', ({ roomId }) => {
    const game = games[roomId];
    if (game && game.hostId === socket.id && game.players.length >= 2) {
      game.status = 'folyamatban';
      game.currentRound = 1;
      io.to(roomId).emit('game-updated', game);
      io.emit('games-list', getPublicGamesList());
    }
  });

  socket.on('restart-game', ({ roomId }) => {
    const game = games[roomId];
    if (game && game.hostId === socket.id) {
      game.status = 'folyamatban';
      game.currentRound = 1;
      game.players.forEach(p => {
        p.score = 0;
        p.choice = null;
      });

      io.to(roomId).emit('game-restarted', game);
      io.emit('games-list', getPublicGamesList());
    }
  });

  socket.on('make-choice', ({ roomId, choice }) => {
    const game = games[roomId];
    if (!game || game.status !== 'folyamatban') return;

    const player = game.players.find(p => p.id === socket.id);
    if (player) {
      player.choice = choice;
    }

    makeBotChoices(game);
    checkAndEvaluateRound(roomId);
  });

  socket.on('cancel-game', ({ roomId }) => {
    handleLeave(socket, roomId);
  });

  socket.on('disconnect', () => {
    onlineUsers = onlineUsers.filter(u => u.id !== socket.id);
    broadcastOnlineUsers();

    for (const roomId in games) {
      const game = games[roomId];
      if (game && game.players.some(p => p.id === socket.id)) {
        handleLeave(socket, roomId);
      }
    }
  });
});

function handleLeave(socket, roomId) {
  const game = games[roomId];
  if (game) {
    socket.to(roomId).emit('game-cancelled', {
      message: 'A játékot az egyik játékos megszakította. Visszakerültél a főoldalra.'
    });

    socket.emit('game-cancelled', {
      message: 'A játékot sikeresen megszakítottad. Visszakerültél a főoldalra.'
    });

    delete games[roomId];
    io.emit('games-list', getPublicGamesList());
  }
}

function getPublicGamesList() {
  return Object.values(games).map(g => ({
    roomId: g.roomId,
    hostName: g.players[0].name,
    playerCount: g.players.length,
    status: g.status
  }));
}
  
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`A szerver fut a ${PORT} porton`);
});
