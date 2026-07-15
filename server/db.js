import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(projectRoot, "data");
fs.mkdirSync(dataDir, { recursive: true });

const databasePath = process.env.DATABASE_PATH || path.join(dataDir, "quiz-live.db");
export const db = new Database(databasePath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('ORGANIZER', 'PARTICIPANT')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS quizzes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organizer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'Общее',
    rules TEXT NOT NULL DEFAULT '',
    question_time INTEGER NOT NULL DEFAULT 20,
    points_per_question INTEGER NOT NULL DEFAULT 1000,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    image_url TEXT,
    type TEXT NOT NULL CHECK (type IN ('SINGLE', 'MULTIPLE')),
    options_json TEXT NOT NULL,
    correct_answers_json TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS quiz_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    room_code TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'LOBBY' CHECK (status IN ('LOBBY', 'ACTIVE', 'FINISHED')),
    current_question INTEGER NOT NULL DEFAULT -1,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS session_players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES quiz_sessions(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    score INTEGER NOT NULL DEFAULT 0,
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(session_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES quiz_sessions(id) ON DELETE CASCADE,
    question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    answers_json TEXT NOT NULL,
    is_correct INTEGER NOT NULL DEFAULT 0,
    points INTEGER NOT NULL DEFAULT 0,
    response_ms INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(session_id, question_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_questions_quiz ON questions(quiz_id, position);
  CREATE INDEX IF NOT EXISTS idx_sessions_quiz ON quiz_sessions(quiz_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_players_session ON session_players(session_id, score DESC);
`);

const questionColumns = new Set(db.prepare("PRAGMA table_info(questions)").all().map((column) => column.name));
if (!questionColumns.has("explanation")) {
  db.exec("ALTER TABLE questions ADD COLUMN explanation TEXT NOT NULL DEFAULT ''");
}

export function parseJson(value, fallback = []) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isGuest: user.email.endsWith("@guest.quizroom.local")
  };
}

export function mapQuestion(row, includeAnswers = false) {
  if (!row) return null;
  const question = {
    id: row.id,
    quizId: row.quiz_id,
    text: row.text,
    imageUrl: row.image_url,
    type: row.type,
    options: parseJson(row.options_json),
    position: row.position
  };
  if (includeAnswers) {
    question.correctAnswers = parseJson(row.correct_answers_json);
    question.explanation = row.explanation || "";
  }
  return question;
}

export function mapQuiz(row) {
  if (!row) return null;
  return {
    id: row.id,
    organizerId: row.organizer_id,
    title: row.title,
    description: row.description,
    category: row.category,
    rules: row.rules,
    questionTime: row.question_time,
    pointsPerQuestion: row.points_per_question,
    questionCount: Number(row.question_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function getQuizWithQuestions(quizId, includeAnswers = false) {
  const row = db.prepare(`
    SELECT q.*, COUNT(questions.id) AS question_count
    FROM quizzes q
    LEFT JOIN questions ON questions.quiz_id = q.id
    WHERE q.id = ?
    GROUP BY q.id
  `).get(quizId);
  if (!row) return null;
  return {
    ...mapQuiz(row),
    questions: db.prepare("SELECT * FROM questions WHERE quiz_id = ? ORDER BY position, id")
      .all(quizId)
      .map((question) => mapQuestion(question, includeAnswers))
  };
}

export function leaderboard(sessionId) {
  return db.prepare(`
    SELECT u.id AS user_id, u.name, sp.score,
      (SELECT COUNT(*) FROM answers a WHERE a.session_id = sp.session_id AND a.user_id = sp.user_id AND a.is_correct = 1) AS correct_count
    FROM session_players sp
    JOIN users u ON u.id = sp.user_id
    WHERE sp.session_id = ?
    ORDER BY sp.score DESC, sp.joined_at ASC
  `).all(sessionId).map((row, index) => ({
    rank: index + 1,
    userId: row.user_id,
    name: row.name,
    score: row.score,
    correctCount: row.correct_count
  }));
}

export function questionStats(sessionId, questionId) {
  const question = db.prepare("SELECT options_json FROM questions WHERE id = ?").get(questionId);
  const options = parseJson(question?.options_json);
  const answers = db.prepare(`
    SELECT answers_json, is_correct, response_ms
    FROM answers WHERE session_id = ? AND question_id = ?
  `).all(sessionId, questionId);
  const playerCount = db.prepare("SELECT COUNT(*) AS count FROM session_players WHERE session_id = ?")
    .get(sessionId).count;
  const distribution = Array(options.length).fill(0);
  for (const answer of answers) {
    for (const index of parseJson(answer.answers_json)) {
      if (Number.isInteger(index) && index >= 0 && index < distribution.length) distribution[index] += 1;
    }
  }
  const correctCount = answers.filter((answer) => answer.is_correct).length;
  const averageResponseMs = answers.length
    ? Math.round(answers.reduce((sum, answer) => sum + answer.response_ms, 0) / answers.length)
    : 0;
  return {
    playerCount,
    answerCount: answers.length,
    correctCount,
    accuracy: answers.length ? Math.round(correctCount / answers.length * 100) : 0,
    averageResponseMs,
    distribution
  };
}

export function sessionStats(sessionId) {
  const summary = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM session_players WHERE session_id = ?) AS player_count,
      COUNT(a.id) AS answer_count,
      COALESCE(SUM(a.is_correct), 0) AS correct_count,
      COALESCE(AVG(a.response_ms), 0) AS average_response_ms
    FROM answers a WHERE a.session_id = ?
  `).get(sessionId, sessionId);
  const questionCount = db.prepare(`
    SELECT COUNT(*) AS count FROM questions q
    JOIN quiz_sessions s ON s.quiz_id = q.quiz_id WHERE s.id = ?
  `).get(sessionId).count;
  const hardest = db.prepare(`
    SELECT q.text, COUNT(a.id) AS answer_count, ROUND(AVG(a.is_correct) * 100) AS accuracy
    FROM questions q
    JOIN quiz_sessions s ON s.quiz_id = q.quiz_id
    LEFT JOIN answers a ON a.question_id = q.id AND a.session_id = s.id
    WHERE s.id = ?
    GROUP BY q.id HAVING COUNT(a.id) > 0
    ORDER BY accuracy ASC, q.position ASC LIMIT 1
  `).get(sessionId);
  return {
    playerCount: Number(summary.player_count || 0),
    questionCount: Number(questionCount || 0),
    answerCount: Number(summary.answer_count || 0),
    correctCount: Number(summary.correct_count || 0),
    accuracy: summary.answer_count ? Math.round(summary.correct_count / summary.answer_count * 100) : 0,
    averageResponseMs: Math.round(summary.average_response_ms || 0),
    hardestQuestion: hardest ? { text: hardest.text, accuracy: Number(hardest.accuracy || 0) } : null
  };
}
