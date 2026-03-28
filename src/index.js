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

// Support multiple client origins (comma-separated in CLIENT_URL env var)
const allowedOrigins = (process.env.CLIENT_URL || 'http://localhost:5173')
  .split(',').map(o => o.trim());

const corsOptions = {
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, curl) and listed origins
    if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      cb(null, true);
    } else {
      cb(new Error(`CORS blocked: ${origin}`));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true,
};

const io = new Server(httpServer, {
  cors: corsOptions,
});

app.use(cors(corsOptions));
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/questions', questionRoutes);
app.use('/api/leaderboard', leaderboardRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'BrainBattle server online 🧠' }));

// Socket.io
setupSocketHandlers(io);

// MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/brainbattle')
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err));

const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
  console.log(`🚀 BrainBattle server running on port ${PORT}`);
});
