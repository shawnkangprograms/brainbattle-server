import express from 'express';
import User from '../models/User.js';
import GameResult from '../models/GameResult.js';

const router = express.Router();

// Global all-time leaderboard
router.get('/global', async (req, res) => {
  try {
    const users = await User.find({ isGuest: { $ne: true } })
      .select('username stats')
      .sort({ 'stats.totalScore': -1 })
      .limit(50);

    const leaderboard = users.map((u, i) => ({
      rank: i + 1,
      username: u.username,
      totalScore: u.stats.totalScore,
      totalWins: u.stats.totalWins,
      totalGames: u.stats.totalGames,
      accuracy: u.stats.totalAnswers > 0
        ? Math.round((u.stats.correctAnswers / u.stats.totalAnswers) * 100)
        : 0,
      bestStreak: u.stats.bestStreak,
    }));

    res.json({ leaderboard });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Recent games
router.get('/recent', async (req, res) => {
  try {
    const games = await GameResult.find().sort('-playedAt').limit(20);
    res.json({ games });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
