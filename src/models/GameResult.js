import mongoose from 'mongoose';

const gameResultSchema = new mongoose.Schema({
  roomCode: { type: String, required: true },
  mode: { type: String, enum: ['classic', 'sudden_death'], required: true },
  players: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    username: String,
    score: Number,
    correctAnswers: Number,
    totalAnswers: Number,
    bestStreak: Number,
    rank: Number,
  }],
  category: String,
  difficulty: String,
  totalQuestions: Number,
  playedAt: { type: Date, default: Date.now },
});

export default mongoose.model('GameResult', gameResultSchema);
