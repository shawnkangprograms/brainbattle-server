import { getQuestionsForGame } from '../routes/questions.js';
import User from '../models/User.js';
import GameResult from '../models/GameResult.js';

// In-memory room store
const rooms = new Map();

// O(1) socket -> roomCode lookup — prevents iterating all rooms on every disconnect
const socketRoomMap = new Map();

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
    console.log(`Client connected: ${socket.id}`);

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
          disconnected: false,
          answered: false,
          answerTime: null,
        }],
        questions: [],
        currentQuestion: -1,
        status: 'lobby',
        messages: [],
        timer: null,
        // Guard: prevents showResults from being called twice for the same question
        // (race between timer firing and last player submitting at the same instant)
        showingResults: false,
      };
      rooms.set(roomCode, room);
      socketRoomMap.set(socket.id, roomCode);
      socket.join(roomCode);
      socket.emit('room_created', { roomCode, room: sanitizeRoom(room) });
      console.log(`Room created: ${roomCode} by ${username}`);
    });

    // Join room (also handles reconnection for disconnected players)
    socket.on('join_room', ({ roomCode, username, userId }) => {
      const room = rooms.get(roomCode);
      if (!room) return socket.emit('error', { message: 'Room not found' });

      // --- Reconnection: player was in this game but lost connection ---
      const disconnectedPlayer = room.players.find(p => p.username === username && p.disconnected);
      if (disconnectedPlayer && room.status === 'playing') {
        disconnectedPlayer.id = socket.id;
        disconnectedPlayer.disconnected = false;
        // Keep answered=true so they don't block the current question's allAnswered check
        // (they missed the question while disconnected)
        socketRoomMap.set(socket.id, roomCode);
        socket.join(roomCode);
        socket.emit('reconnect_to_game', {
          roomCode,
          score: disconnectedPlayer.score,
          eliminated: disconnectedPlayer.eliminated,
          totalQuestions: room.questions.length,
          questionIndex: room.currentQuestion,
        });
        io.to(roomCode).emit('player_joined', {
          player: sanitizePlayer(disconnectedPlayer),
          players: room.players.map(sanitizePlayer),
        });
        console.log(`${username} reconnected to room ${roomCode}`);
        return;
      }

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
        disconnected: false,
        answered: false,
        answerTime: null,
      };
      room.players.push(player);
      socketRoomMap.set(socket.id, roomCode);
      socket.join(roomCode);

      socket.emit('room_joined', { roomCode, room: sanitizeRoom(room) });
      io.to(roomCode).emit('player_joined', { player: sanitizePlayer(player), players: room.players.map(sanitizePlayer) });
      console.log(`${username} joined room ${roomCode}`);
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
    // Client must send the questionIndex it believes is current — we reject stale answers
    // that arrive after the question has already advanced (prevents wrong-question scoring)
    socket.on('submit_answer', ({ roomCode, answer, questionIndex }) => {
      const room = rooms.get(roomCode);
      if (!room || room.status !== 'playing') return;

      // Reject stale answer from a previous question
      if (questionIndex !== undefined && questionIndex !== room.currentQuestion) return;

      const player = room.players.find(p => p.id === socket.id);
      if (!player || player.answered || player.eliminated || player.disconnected) return;

      const q = room.questions[room.currentQuestion];
      if (!q) return;

      player.answered = true;
      player.answerTime = Date.now();
      player.total++;

      const isCorrect = answer === q.correct_answer;
      const timeElapsed = (player.answerTime - room.questionStartTime) / 1000;
      const timeBonus = Math.max(0, Math.round((room.timerSeconds - timeElapsed) / room.timerSeconds * 300));

      console.log(`${player.username} answered | correct: ${isCorrect} | mode: ${room.mode}`);

      if (isCorrect) {
        player.streak++;
        player.bestStreak = Math.max(player.bestStreak, player.streak);
        player.correct++;
        const streakBonus = Math.min(player.streak * 50, 200);
        const gained = 500 + timeBonus + streakBonus;
        player.score += gained;
        socket.emit('answer_result', { correct: true, points: gained, timeBonus, streakBonus, streak: player.streak });
      } else {
        player.streak = 0;
        socket.emit('answer_result', { correct: false, points: 0, correctAnswer: q.correct_answer });
        if (room.mode === 'sudden_death') {
          player.eliminated = true;
          setTimeout(() => {
            socket.emit('eliminated', { correctAnswer: q.correct_answer });
            io.to(roomCode).emit('player_eliminated', { username: player.username });
          }, 1800);
        }
      }

      // Advance when all active (non-eliminated, non-disconnected) players have answered
      const activePlayers = room.players.filter(p => !p.eliminated && !p.disconnected);
      const allAnswered = activePlayers.length === 0 || activePlayers.every(p => p.answered);
      if (allAnswered && !room.showingResults) {
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
        socketRoomMap.delete(target.id);
        io.to(roomCode).emit('player_left', { username, players: room.players.map(sanitizePlayer) });
      }
    });

    socket.on('skip_question', ({ roomCode }) => {
      const room = rooms.get(roomCode);
      if (!room || room.host !== socket.id) return;
      if (!room.showingResults) {
        clearTimeout(room.timer);
        showResults(io, room, roomCode);
      }
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
      const roomCode = socketRoomMap.get(socket.id);
      socketRoomMap.delete(socket.id);

      if (!roomCode) {
        console.log(`Client disconnected (no room): ${socket.id}`);
        return;
      }

      const room = rooms.get(roomCode);
      if (!room) return;

      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx === -1) return;

      const player = room.players[idx];
      const username = player.username;

      if (room.status === 'playing') {
        // During gameplay: keep the player in the room but mark as disconnected.
        // This prevents a brief network hiccup from kicking them permanently.
        // Mark answered=true so they don't permanently block the allAnswered check.
        player.disconnected = true;
        player.answered = true;

        io.to(roomCode).emit('player_left', { username, players: room.players.map(sanitizePlayer) });

        // If all remaining connected+active players have now answered, advance
        const activePlayers = room.players.filter(p => !p.eliminated && !p.disconnected);
        if (activePlayers.length === 0) {
          // No connected players left — end the game
          clearTimeout(room.timer);
          finishGame(io, room, roomCode);
        } else if (activePlayers.every(p => p.answered) && !room.showingResults) {
          clearTimeout(room.timer);
          showResults(io, room, roomCode);
        }

        // Transfer host if the disconnecting player was host
        if (room.host === socket.id) {
          const newHost = room.players.find(p => !p.disconnected);
          if (newHost) {
            room.host = newHost.id;
            io.to(newHost.id).emit('host_transferred');
          }
        }
      } else {
        // Lobby or results: remove permanently
        room.players.splice(idx, 1);
        io.to(roomCode).emit('player_left', { username, players: room.players.map(sanitizePlayer) });

        if (room.players.length === 0) {
          clearTimeout(room.timer);
          rooms.delete(roomCode);
        } else if (room.host === socket.id) {
          room.host = room.players[0].id;
          io.to(room.host).emit('host_transferred');
        }
      }

      console.log(`Client disconnected: ${socket.id} (${username})`);
    });
  });
}

function sendQuestion(io, room, roomCode) {
  // Reset the results guard so the new question can call showResults
  room.showingResults = false;

  room.currentQuestion++;
  if (room.currentQuestion >= room.questions.length) {
    return finishGame(io, room, roomCode);
  }

  // Reset answered for connected, non-eliminated players only.
  // Eliminated and disconnected players stay answered=true so they never block the check.
  room.players.forEach(p => {
    if (!p.eliminated && !p.disconnected) {
      p.answered = false;
      p.answerTime = null;
    }
  });
  room.questionStartTime = Date.now();

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

  // Set server-side timer. showResults is guarded so it can only fire once per question.
  room.timer = setTimeout(() => {
    showResults(io, room, roomCode);
  }, room.timerSeconds * 1000);

  const active = room.players.filter(p => !p.eliminated && !p.disconnected).map(p => p.username);
  console.log(`Q${room.currentQuestion + 1} | Active: ${active.join(', ') || 'none'}`);
}

function showResults(io, room, roomCode) {
  // Critical guard: prevents double-invocation from the "all answered" path
  // and the server timer firing at nearly the same moment.
  // Without this, two sendQuestion() calls would be scheduled, skipping questions
  // and causing stale answers to be processed against the wrong question.
  if (room.showingResults) return;
  room.showingResults = true;

  const q = room.questions[room.currentQuestion];
  const leaderboard = [...room.players]
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ username: p.username, score: p.score, rank: i + 1, eliminated: p.eliminated, disconnected: p.disconnected }));

  io.to(roomCode).emit('question_results', {
    correctAnswer: q.correct_answer,
    leaderboard,
    questionIndex: room.currentQuestion,
  });

  const activePlayers = room.players.filter(p => !p.eliminated && !p.disconnected);
  const eliminatedPlayers = room.players.filter(p => p.eliminated);

  const suddenDeathOver =
    room.mode === 'sudden_death' &&
    eliminatedPlayers.length > 0 &&
    (activePlayers.length <= 1 || activePlayers.length === 0);

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

    // Update registered user stats in parallel
    const registeredPlayers = room.players.filter(p => p.userId);
    await Promise.all(registeredPlayers.map(player => {
      const rank = finalRanking.findIndex(p => p.username === player.username) + 1;
      return User.findByIdAndUpdate(player.userId, {
        $inc: {
          'stats.totalGames': 1,
          'stats.totalWins': rank === 1 ? 1 : 0,
          'stats.totalScore': player.score,
          'stats.correctAnswers': player.correct,
          'stats.totalAnswers': player.total,
        },
        $max: { 'stats.bestStreak': player.bestStreak },
      });
    }));
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
  return {
    id: p.id,
    username: p.username,
    score: p.score,
    streak: p.streak,
    eliminated: p.eliminated,
    disconnected: p.disconnected || false,
  };
}
