import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';

const router = express.Router();

const generateToken = (userId) =>
  jwt.sign({ userId }, process.env.JWT_SECRET || 'secret', { expiresIn: '7d' });

// Register
router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password)
      return res.status(400).json({ error: 'All fields required' });

    const existing = await User.findOne({ $or: [{ username }, { email }] });
    if (existing) return res.status(400).json({ error: 'Username or email already taken' });

    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({ username, email, password: hashed });
    const token = generateToken(user._id);

    res.json({ token, user: { id: user._id, username: user.username, email: user.email, stats: user.stats } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !user.password) return res.status(400).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Invalid credentials' });

    const token = generateToken(user._id);
    res.json({ token, user: { id: user._id, username: user.username, email: user.email, stats: user.stats } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Guest login
router.post('/guest', async (req, res) => {
  try {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });

    const guestUser = { id: `guest_${Date.now()}`, username, isGuest: true, stats: {} };
    res.json({ user: guestUser, token: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify token
router.get('/me', async (req, res) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });

    const { userId } = jwt.verify(token, process.env.JWT_SECRET || 'secret');
    const user = await User.findById(userId).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });

    res.json({ user: { id: user._id, username: user.username, email: user.email, stats: user.stats } });
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
});

export default router;
