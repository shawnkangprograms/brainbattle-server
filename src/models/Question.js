import mongoose from 'mongoose';

const questionSchema = new mongoose.Schema({
  question: { type: String, required: true },
  correct_answer: { type: String, required: true },
  incorrect_answers: [{ type: String, required: true }],
  category: { type: String, required: true },
  difficulty: { type: String, enum: ['easy', 'medium', 'hard'], required: true },
  type: { type: String, default: 'multiple' },
  source: { type: String, default: 'admin' }, // 'admin' | 'opentdb'
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model('Question', questionSchema);
