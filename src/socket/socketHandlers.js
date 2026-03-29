import { getQuestionsForGame } from '../routes/questions.js';
import User from '../models/User.js';
import GameResult from '../models/GameResult.js';

// In-memory room store
const rooms = new Map();

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function setupSocketHandlers(io) {
  io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);

    // Create room
    socket.on('create_room', ({ username, userId, mode, category, difficulty, timerSeconds, questionCount }) => {
      const roomCode = generateRoomCode();
      const room = {
        code: roomCode,
        host: socket.id,
        mode: mode || 'classic',
        category: category || 'General Knowledge',
        difficulty: difficulty || 'medium',
        timerSeconds: timerSeconds || 15,
        questionCount: questionCount || 10,
        players: [{
          id: socket.id,
          userId: userId || null,
          username,
          score: 0,
          streak: 0,
          bestStreak: 0,
          correct: 0,
          total: 0,
          eliminated: false,
          answered: false,
          answerTime: null,
        }],
        questions: [],
        currentQuestion: -1,
        status: 'lobby', // lobby | playing | results
        messages: [],
        timer: null,
      };
      rooms.set(roomCode, room);
      socket.join(roomCode);
      socket.emit('room_created', { roomCode, room: sanitizeRoom(room) });
      console.log(`🏠 Room created: ${roomCode} by ${username}`);
    });

    // Join room
    socket.on('join_room', ({ roomCode, username, userId }) => {
      const room = rooms.get(roomCode);
      if (!room) return socket.emit('error', { message: 'Room not found' });
      if (room.status !== 'lobby') return socket.emit('error', { message: 'Game already in progress' });
      if (room.players.length >= 20) return socket.emit('error', { message: 'Room is full (max 20)' });
      if (room.players.find(p => p.username === username))
        return socket.emit('error', { message: 'Username already taken in this room' });

      const player = {
        id: socket.id,
        userId: userId || null,
        username,
        score: 0,
        streak: 0,
        bestStreak: 0,
        correct: 0,
        total: 0,
        eliminated: false,
        answered: false,
        answerTime: null,
      };
      room.players.push(player);
      socket.join(roomCode);

      socket.emit('room_joined', { roomCode, room: sanitizeRoom(room) });
      io.to(roomCode).emit('player_joined', { player: sanitizePlayer(player), players: room.players.map(sanitizePlayer) });
      console.log(`👤 ${username} joined room ${roomCode}`);
    });

    // Chat message
    socket.on('send_message', ({ roomCode, username, message }) => {
      const room = rooms.get(roomCode);
      if (!room) return;
      const msg = { username, message, timestamp: Date.now() };
      room.messages.push(msg);
      if (room.messages.length > 100) room.messages.shift();
      io.to(roomCode).emit('new_message', msg);
    });

    // Host: start game
    socket.on('start_game', async ({ roomCode }) => {
      const room = rooms.get(roomCode);
      if (!room || room.host !== socket.id) return;
      if (room.players.length < 1) return socket.emit('error', { message: 'No players in room' });

      try {
        room.status = 'playing';
        room.questions = await getQuestionsForGame(room.category, room.difficulty, room.questionCount);
        if (!room.questions.length) return socket.emit('error', { message: 'Could not load questions' });

        io.to(roomCode).emit('game_started', { totalQuestions: room.questions.length });
        setTimeout(() => sendQuestion(io, room, roomCode), 1000);
      } catch (err) {
        socket.emit('error', { message: 'Failed to start game: ' + err.message });
      }
    });

    // Submit answer
    socket.on('submit_answer', ({ roomCode, answer }) => {
      const room = rooms.get(roomCode);
      if (!room || room.status !== 'playing') return;

      const player = room.players.find(p => p.id === socket.id);
      if (!player || player.answered || player.eliminated) return;

      const q = room.questions[room.currentQuestion];
      if (!q) return;

      player.answered = true;
      player.answerTime = Date.now();
      player.total++;

      const isCorrect = answer === q.correct_answer;
      const timeElapsed = (player.answerTime - room.questionStartTime) / 1000;
      const timeBonus = Math.max(0, Math.round((room.timerSeconds - timeElapsed) / room.timerSeconds * 300));

      console.log(`📝 ${player.username} answered: "${answer}" | correct: "${q.correct_answer}" | isCorrect: ${isCorrect} | mode: ${room.mode}`);

      if (isCorrect) {
        // CORRECT — never eliminate, regardless of mode
        player.streak++;
        player.bestStreak = Math.max(player.bestStreak, player.streak);
        player.correct++;
        const streakBonus = Math.min(player.streak * 50, 200);
        const gained = 500 + timeBonus + streakBonus;
        player.score += gained;
        socket.emit('answer_result', { correct: true, points: gained, timeBonus, streakBonus, streak: player.streak });
      } else {
        // WRONG — eliminate only in sudden death
        player.streak = 0;
        socket.emit('answer_result', { correct: false, points: 0, correctAnswer: q.correct_answer });
        if (room.mode === 'sudden_death') {
          player.eliminated = true;
          // Delay the eliminated event so client can show the wrong-answer reveal first
          setTimeout(() => {
            socket.emit('eliminated', { correctAnswer: q.correct_answer });
            io.to(roomCode).emit('player_eliminated', { username: player.username });
          }, 1800);
        }
      }

      // Advance when all NON-eliminated players have answered
      const activePlayers = room.players.filter(p => !p.eliminated);
      const allAnswered = activePlayers.every(p => p.answered);
      if (allAnswered) {
        clearTimeout(room.timer);
        showResults(io, room, roomCode);
      }
    });

    // Host controls
    socket.on('kick_player', ({ roomCode, username }) => {
      const room = rooms.get(roomCode);
      if (!room || room.host !== socket.id) return;
      const target = room.players.find(p => p.username === username);
      if (target) {
        io.to(target.id).emit('kicked');
        room.players = room.players.filter(p => p.username !== username);
        io.to(roomCode).emit('player_left', { username, players: room.players.map(sanitizePlayer) });
      }
    });

    socket.on('skip_question', ({ roomCode }) => {
      const room = rooms.get(roomCode);
      if (!room || room.host !== socket.id) return;
      clearTimeout(room.timer);
      showResults(io, room, roomCode);
    });

    socket.on('end_game', ({ roomCode }) => {
      const room = rooms.get(roomCode);
      if (!room || room.host !== socket.id) return;
      clearTimeout(room.timer);
      finishGame(io, room, roomCode);
    });

    socket.on('update_settings', ({ roomCode, settings }) => {
      const room = rooms.get(roomCode);
      if (!room || room.host !== socket.id) return;
      Object.assign(room, settings);
      io.to(roomCode).emit('settings_updated', { settings });
    });

    // Disconnect
    socket.on('disconnect', () => {
      rooms.forEach((room, roomCode) => {
        const idx = room.players.findIndex(p => p.id === socket.id);
        if (idx !== -1) {
          const username = room.players[idx].username;
          room.players.splice(idx, 1);
          io.to(roomCode).emit('player_left', { username, players: room.players.map(sanitizePlayer) });

          if (room.players.length === 0) {
            clearTimeout(room.timer);
            rooms.delete(roomCode);
          } else if (room.host === socket.id && room.players.length > 0) {
            room.host = room.players[0].id;
            io.to(room.host).emit('host_transferred');
          }
        }
      });
      console.log(`🔌 Client disconnected: ${socket.id}`);
    });
  });
}

function sendQuestion(io, room, roomCode) {
  room.currentQuestion++;
  if (room.currentQuestion >= room.questions.length) {
    return finishGame(io, room, roomCode);
  }

  // Reset answered states for NON-eliminated players only
  // Eliminated players keep answered=true so they never block the "all answered" check
  room.players.forEach(p => {
    if (!p.eliminated) {
      p.answered = false;
      p.answerTime = null;
    }
  });
  room.questionStartTime = Date.now();
  console.log(`📢 Q${room.currentQuestion + 1} | Mode: ${room.mode} | Active: ${room.players.filter(p=>!p.eliminated).map(p=>p.username).join(', ')} | Eliminated: ${room.players.filter(p=>p.eliminated).map(p=>p.username).join(', ') || 'none'}`);

  const q = room.questions[room.currentQuestion];
  const answers = shuffleArray([q.correct_answer, ...q.incorrect_answers]);

  io.to(roomCode).emit('question', {
    questionIndex: room.currentQuestion,
    totalQuestions: room.questions.length,
    question: q.question,
    answers,
    category: q.category,
    difficulty: q.difficulty,
    timerSeconds: room.timerSeconds,
  });

  room.timer = setTimeout(() => {
    showResults(io, room, roomCode);
  }, room.timerSeconds * 1000);
}

function showResults(io, room, roomCode) {
  const q = room.questions[room.currentQuestion];
  const leaderboard = [...room.players]
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ username: p.username, score: p.score, rank: i + 1, eliminated: p.eliminated }));

  io.to(roomCode).emit('question_results', {
    correctAnswer: q.correct_answer,
    leaderboard,
    questionIndex: room.currentQuestion,
  });

  const activePlayers = room.players.filter(p => !p.eliminated);
  const eliminatedPlayers = room.players.filter(p => p.eliminated);
  const totalPlayers = room.players.length;

  // Sudden death ends only when:
  // - More than 1 player started AND only 1 (or 0) remain active, OR
  // - All players are eliminated (everyone got it wrong on same question)
  const suddenDeathOver =
    room.mode === 'sudden_death' &&
    eliminatedPlayers.length > 0 &&        // at least someone was actually eliminated
    (activePlayers.length <= 1 ||           // only 1 survivor
     activePlayers.length === 0);           // everyone eliminated on same question

  if (suddenDeathOver) {
    setTimeout(() => finishGame(io, room, roomCode), 3500);
    return;
  }

  setTimeout(() => sendQuestion(io, room, roomCode), 4000);
}

async function finishGame(io, room, roomCode) {
  room.status = 'results';
  const finalRanking = [...room.players]
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({
      username: p.username,
      score: p.score,
      rank: i + 1,
      correct: p.correct,
      total: p.total,
      bestStreak: p.bestStreak,
      accuracy: p.total > 0 ? Math.round((p.correct / p.total) * 100) : 0,
    }));

  io.to(roomCode).emit('game_over', { finalRanking });

  // Save results to DB
  try {
    await GameResult.create({
      roomCode,
      mode: room.mode,
      players: finalRanking.map((p, i) => ({
        username: p.username,
        score: p.score,
        correctAnswers: p.correct,
        totalAnswers: p.total,
        bestStreak: p.bestStreak,
        rank: i + 1,
      })),
      category: room.category,
      difficulty: room.difficulty,
      totalQuestions: room.questions.length,
    });

    // Update registered user stats
    for (const player of room.players) {
      if (player.userId) {
        const rank = finalRanking.findIndex(p => p.username === player.username) + 1;
        await User.findByIdAndUpdate(player.userId, {
          $inc: {
            'stats.totalGames': 1,
            'stats.totalWins': rank === 1 ? 1 : 0,
            'stats.totalScore': player.score,
            'stats.correctAnswers': player.correct,
            'stats.totalAnswers': player.total,
          },
          $max: { 'stats.bestStreak': player.bestStreak },
        });
      }
    }
  } catch (err) {
    console.error('Failed to save game results:', err.message);
  }
}

function sanitizeRoom(room) {
  return {
    code: room.code,
    host: room.host,
    mode: room.mode,
    category: room.category,
    difficulty: room.difficulty,
    timerSeconds: room.timerSeconds,
    questionCount: room.questionCount,
    status: room.status,
    players: room.players.map(sanitizePlayer),
  };
}

function sanitizePlayer(p) {
  return { id: p.id, username: p.username, score: p.score, streak: p.streak, eliminated: p.eliminated };
}
