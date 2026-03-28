import express from 'express';
import axios from 'axios';
import Question from '../models/Question.js';

const router = express.Router();

const CATEGORY_MAP = {
  'Science & Nature': 17,
  'History & Geography': 23,
  'Pop Culture & Entertainment': 11,
  'Sports': 21,
  'Technology': 18,
  'General Knowledge': 9,
};

const DIFFICULTY_MAP = { easy: 'easy', medium: 'medium', hard: 'hard' };

// Fetch from OpenTDB (admin preview)
router.get('/fetch-opentdb', async (req, res) => {
  try {
    const { category = 'General Knowledge', difficulty = 'medium', amount = 10 } = req.query;
    const categoryId = CATEGORY_MAP[category] || 9;
    const diff = DIFFICULTY_MAP[difficulty] || 'medium';
    const url = `https://opentdb.com/api.php?amount=${amount}&category=${categoryId}&difficulty=${diff}&type=multiple&encode=url3986`;
    const response = await axios.get(url, { timeout: 8000 });

    if (response.data.response_code !== 0)
      return res.status(400).json({ error: 'Failed to fetch questions from OpenTDB' });

    const questions = response.data.results.map(q => ({
      question: decodeURIComponent(q.question),
      correct_answer: decodeURIComponent(q.correct_answer),
      incorrect_answers: q.incorrect_answers.map(a => decodeURIComponent(a)),
      category: decodeURIComponent(q.category),
      difficulty: q.difficulty,
      source: 'opentdb',
    }));
    res.json({ questions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get admin questions
router.get('/admin', async (req, res) => {
  try {
    const { category, difficulty } = req.query;
    const filter = {};
    if (category) filter.category = category;
    if (difficulty) filter.difficulty = difficulty;
    const questions = await Question.find(filter).sort('-createdAt');
    res.json({ questions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add admin question
router.post('/admin', async (req, res) => {
  try {
    const { question, correct_answer, incorrect_answers, category, difficulty } = req.body;
    if (!question || !correct_answer || !incorrect_answers || incorrect_answers.length < 3)
      return res.status(400).json({ error: 'All question fields required with 3 incorrect answers' });

    const q = await Question.create({ question, correct_answer, incorrect_answers, category, difficulty, source: 'admin' });
    res.json({ question: q });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete admin question
router.delete('/admin/:id', async (req, res) => {
  try {
    await Question.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Used by socket game engine ──────────────────────────────────────────────
export async function getQuestionsForGame(category, difficulty, amount = 10) {
  // 1. Try OpenTDB
  try {
    const categoryId = CATEGORY_MAP[category] || 9;
    const diff = DIFFICULTY_MAP[difficulty] || 'medium';
    const url = `https://opentdb.com/api.php?amount=${amount}&category=${categoryId}&difficulty=${diff}&type=multiple&encode=url3986`;
    const response = await axios.get(url, { timeout: 8000 });

    if (response.data.response_code === 0 && response.data.results.length > 0) {
      console.log(`✅ Loaded ${response.data.results.length} questions from OpenTDB`);
      return response.data.results.map(q => ({
        question: decodeURIComponent(q.question),
        correct_answer: decodeURIComponent(q.correct_answer),
        incorrect_answers: q.incorrect_answers.map(a => decodeURIComponent(a)),
        category: decodeURIComponent(q.category),
        difficulty: q.difficulty,
      }));
    }
    console.log(`⚠️  OpenTDB response_code: ${response.data.response_code}`);
  } catch (e) {
    console.log(`⚠️  OpenTDB unreachable (${e.message}) — using fallback`);
  }

  // 2. Fallback to MongoDB
  let dbQuestions = await Question.find(difficulty ? { difficulty } : {}).lean();
  if (dbQuestions.length < amount) {
    dbQuestions = await Question.find({}).lean();
  }
  if (dbQuestions.length > 0) {
    console.log(`📦 Using ${dbQuestions.length} DB questions`);
    return dbQuestions.sort(() => Math.random() - 0.5).slice(0, amount);
  }

  // 3. Last resort — built-in hardcoded questions
  console.log('📝 Using built-in questions');
  return getBuiltInQuestions(difficulty, amount);
}

function getBuiltInQuestions(difficulty = 'medium', amount = 10) {
  const all = [
    // Easy
    { question: "What is the capital of France?", correct_answer: "Paris", incorrect_answers: ["London", "Berlin", "Madrid"], difficulty: "easy", category: "Geography" },
    { question: "Which planet is closest to the Sun?", correct_answer: "Mercury", incorrect_answers: ["Venus", "Earth", "Mars"], difficulty: "easy", category: "Science" },
    { question: "How many sides does a hexagon have?", correct_answer: "6", incorrect_answers: ["5", "7", "8"], difficulty: "easy", category: "Math" },
    { question: "What is the chemical symbol for water?", correct_answer: "H2O", incorrect_answers: ["CO2", "NaCl", "O2"], difficulty: "easy", category: "Science" },
    { question: "Who painted the Mona Lisa?", correct_answer: "Leonardo da Vinci", incorrect_answers: ["Picasso", "Michelangelo", "Raphael"], difficulty: "easy", category: "Art" },
    { question: "What is the largest ocean on Earth?", correct_answer: "Pacific Ocean", incorrect_answers: ["Atlantic Ocean", "Indian Ocean", "Arctic Ocean"], difficulty: "easy", category: "Geography" },
    { question: "How many legs does a spider have?", correct_answer: "8", incorrect_answers: ["6", "10", "4"], difficulty: "easy", category: "Animals" },
    { question: "What color are ripe bananas?", correct_answer: "Yellow", incorrect_answers: ["Green", "Red", "Orange"], difficulty: "easy", category: "General" },
    { question: "How many days are in a week?", correct_answer: "7", incorrect_answers: ["5", "6", "8"], difficulty: "easy", category: "General" },
    { question: "Which animal is known as man's best friend?", correct_answer: "Dog", incorrect_answers: ["Cat", "Horse", "Rabbit"], difficulty: "easy", category: "Animals" },
    { question: "What shape is a stop sign?", correct_answer: "Octagon", incorrect_answers: ["Circle", "Triangle", "Square"], difficulty: "easy", category: "General" },
    { question: "How many months are in a year?", correct_answer: "12", incorrect_answers: ["10", "11", "13"], difficulty: "easy", category: "General" },
    // Medium
    { question: "What is the speed of light (approximate)?", correct_answer: "300,000 km/s", incorrect_answers: ["150,000 km/s", "500,000 km/s", "100,000 km/s"], difficulty: "medium", category: "Science" },
    { question: "In what year did World War II end?", correct_answer: "1945", incorrect_answers: ["1943", "1944", "1946"], difficulty: "medium", category: "History" },
    { question: "What is the powerhouse of the cell?", correct_answer: "Mitochondria", incorrect_answers: ["Nucleus", "Ribosome", "Chloroplast"], difficulty: "medium", category: "Science" },
    { question: "Who wrote Romeo and Juliet?", correct_answer: "William Shakespeare", incorrect_answers: ["Charles Dickens", "Jane Austen", "Mark Twain"], difficulty: "medium", category: "Literature" },
    { question: "What is the largest continent?", correct_answer: "Asia", incorrect_answers: ["Africa", "North America", "Europe"], difficulty: "medium", category: "Geography" },
    { question: "How many bones are in the adult human body?", correct_answer: "206", incorrect_answers: ["198", "212", "223"], difficulty: "medium", category: "Science" },
    { question: "What currency does Japan use?", correct_answer: "Yen", incorrect_answers: ["Won", "Yuan", "Ringgit"], difficulty: "medium", category: "General" },
    { question: "Who invented the telephone?", correct_answer: "Alexander Graham Bell", incorrect_answers: ["Thomas Edison", "Nikola Tesla", "Guglielmo Marconi"], difficulty: "medium", category: "History" },
    { question: "What is the largest planet in our solar system?", correct_answer: "Jupiter", incorrect_answers: ["Saturn", "Uranus", "Neptune"], difficulty: "medium", category: "Science" },
    { question: "What does HTML stand for?", correct_answer: "HyperText Markup Language", incorrect_answers: ["High Tech Modern Language", "HyperText Modern Links", "Hyper Transfer Markup Language"], difficulty: "medium", category: "Technology" },
    { question: "What is the square root of 144?", correct_answer: "12", incorrect_answers: ["11", "13", "14"], difficulty: "medium", category: "Math" },
    { question: "Who was the first man to walk on the moon?", correct_answer: "Neil Armstrong", incorrect_answers: ["Buzz Aldrin", "Yuri Gagarin", "John Glenn"], difficulty: "medium", category: "History" },
    { question: "What is the longest river in the world?", correct_answer: "Nile", incorrect_answers: ["Amazon", "Yangtze", "Mississippi"], difficulty: "medium", category: "Geography" },
    { question: "What does CPU stand for?", correct_answer: "Central Processing Unit", incorrect_answers: ["Core Processing Unit", "Computer Personal Unit", "Central Program Utility"], difficulty: "medium", category: "Technology" },
    // Hard
    { question: "What is the chemical symbol for gold?", correct_answer: "Au", incorrect_answers: ["Go", "Gd", "Ag"], difficulty: "hard", category: "Science" },
    { question: "In what year was the Magna Carta signed?", correct_answer: "1215", incorrect_answers: ["1066", "1415", "1314"], difficulty: "hard", category: "History" },
    { question: "Which country has the most natural lakes?", correct_answer: "Canada", incorrect_answers: ["Russia", "USA", "Finland"], difficulty: "hard", category: "Geography" },
    { question: "What is the half-life of Carbon-14?", correct_answer: "5,730 years", incorrect_answers: ["1,000 years", "10,000 years", "50,000 years"], difficulty: "hard", category: "Science" },
    { question: "Who developed the theory of general relativity?", correct_answer: "Albert Einstein", incorrect_answers: ["Isaac Newton", "Niels Bohr", "Max Planck"], difficulty: "hard", category: "Science" },
    { question: "What is the smallest country in the world?", correct_answer: "Vatican City", incorrect_answers: ["Monaco", "San Marino", "Liechtenstein"], difficulty: "hard", category: "Geography" },
    { question: "Which programmer created Linux?", correct_answer: "Linus Torvalds", incorrect_answers: ["Bill Gates", "Dennis Ritchie", "Ken Thompson"], difficulty: "hard", category: "Technology" },
    { question: "What year did the Berlin Wall fall?", correct_answer: "1989", incorrect_answers: ["1987", "1991", "1985"], difficulty: "hard", category: "History" },
    { question: "What is the most abundant gas in Earth's atmosphere?", correct_answer: "Nitrogen", incorrect_answers: ["Oxygen", "Carbon Dioxide", "Argon"], difficulty: "hard", category: "Science" },
    { question: "What is the Pythagorean theorem?", correct_answer: "a² + b² = c²", incorrect_answers: ["a + b = c", "a² - b² = c²", "a² × b² = c²"], difficulty: "hard", category: "Math" },
  ];

  const filtered = all.filter(q => q.difficulty === difficulty);
  const pool = filtered.length >= amount ? filtered : all;
  return pool.sort(() => Math.random() - 0.5).slice(0, amount);
}

export default router;
