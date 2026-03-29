import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

import authRoutes from './routes/auth.js';
import questionRoutes from './routes/questions.js';
import leaderboardRoutes from './routes/leaderboard.js';
import { setupSocketHandlers } from './socket/socketHandlers.js';

dotenv.config();

const app = express();
const httpServer = createServer(app);

// CLIENT_URL can be a comma-separated list e.g. "https://app.vercel.app,http://localhost:5173"
// or "*" to allow all origins
const rawOrigins = process.env.CLIENT_URL || 'http://localhost:5173';
const allowedOrigins = rawOrigins.split(',').map(o => o.trim());

const corsOptions = {
  origin: (origin, cb) => {
    // Allow: no origin (curl/mobile), wildcard, or explicitly listed origin
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) {
      cb(null, true);
    } else {
      console.warn(`CORS blocked origin: ${origin}`);
      cb(null, false); // block silently instead of throwing
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
};

const io = new Server(httpServer, { cors: corsOptions });

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // handle preflight
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/questions', questionRoutes);
app.use('/api/leaderboard', leaderboardRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'BrainBattle server online 🧠' }));

setupSocketHandlers(io);

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/brainbattle')
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err));

const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
  console.log(`🚀 BrainBattle server running on port ${PORT}`);
});
