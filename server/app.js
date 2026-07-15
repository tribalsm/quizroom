import express from "express";
import cors from "cors";
import multer from "multer";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, getQuizWithQuestions, mapQuiz, publicUser } from "./db.js";
import { comparePassword, createToken, hashPassword, requireAuth, requireRole } from "./auth.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uploadsDir = path.join(rootDir, "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    callback(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extension}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => callback(null, file.mimetype.startsWith("image/"))
});

function quizOwner(req, res, next) {
  const quiz = db.prepare("SELECT * FROM quizzes WHERE id = ?").get(Number(req.params.id || req.params.quizId));
  if (!quiz || quiz.organizer_id !== req.user.id) return res.status(404).json({ error: "Квиз не найден" });
  req.quiz = quiz;
  next();
}

function validateQuestion(payload) {
  const text = String(payload.text || "").trim();
  const type = payload.type === "MULTIPLE" ? "MULTIPLE" : "SINGLE";
  const options = Array.isArray(payload.options) ? payload.options.map((option) => String(option).trim()).filter(Boolean) : [];
  const correctAnswers = [...new Set((Array.isArray(payload.correctAnswers) ? payload.correctAnswers : []).map(Number))];
  if (!text) return { error: "Введите текст вопроса" };
  if (options.length < 2 || options.length > 8) return { error: "Добавьте от 2 до 8 вариантов" };
  if (!correctAnswers.length || correctAnswers.some((index) => index < 0 || index >= options.length)) return { error: "Отметьте правильный ответ" };
  if (type === "SINGLE" && correctAnswers.length !== 1) return { error: "Для одиночного выбора нужен один правильный ответ" };
  return {
    value: {
      text,
      type,
      options,
      correctAnswers,
      imageUrl: payload.imageUrl || null,
      explanation: String(payload.explanation || "").trim().slice(0, 600)
    }
  };
}

export function createApp() {
  const app = express();
  app.use(cors({ origin: process.env.CLIENT_URL || "http://localhost:5173" }));
  app.use(express.json({ limit: "1mb" }));
  app.use("/uploads", express.static(uploadsDir));

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  app.post("/api/auth/register", async (req, res) => {
    const name = String(req.body.name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const role = req.body.role === "ORGANIZER" ? "ORGANIZER" : "PARTICIPANT";
    if (name.length < 2) return res.status(400).json({ error: "Имя должно содержать минимум 2 символа" });
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "Введите корректный email" });
    if (password.length < 6) return res.status(400).json({ error: "Пароль должен содержать минимум 6 символов" });
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) return res.status(409).json({ error: "Пользователь уже существует" });
    const passwordHash = await hashPassword(password);
    const result = db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)")
      .run(name, email, passwordHash, role);
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json({ token: createToken(user), user: publicUser(user) });
  });

  app.post("/api/auth/login", async (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user || !(await comparePassword(String(req.body.password || ""), user.password_hash))) {
      return res.status(401).json({ error: "Неверный email или пароль" });
    }
    res.json({ token: createToken(user), user: publicUser(user) });
  });

  app.post("/api/auth/guest", (req, res) => {
    const name = String(req.body.name || "").trim().slice(0, 40);
    const roomCode = String(req.body.roomCode || "").replace(/\D/g, "").slice(0, 6);
    if (name.length < 2) return res.status(400).json({ error: "Введите имя минимум из 2 символов" });
    const session = db.prepare("SELECT status FROM quiz_sessions WHERE room_code = ?").get(roomCode);
    if (!session) return res.status(404).json({ error: "Комната не найдена" });
    if (session.status === "FINISHED") return res.status(409).json({ error: "Квиз уже завершён" });
    const guestId = crypto.randomUUID();
    const result = db.prepare("INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'PARTICIPANT')")
      .run(name, `${guestId}@guest.quizroom.local`, `guest-${guestId}`);
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid);
    res.status(201).json({ token: createToken(user), user: publicUser(user), roomCode });
  });

  app.get("/api/auth/me", requireAuth, (req, res) => res.json({ user: req.user }));

  app.get("/api/quizzes", requireAuth, requireRole("ORGANIZER"), (req, res) => {
    const quizzes = db.prepare(`
      SELECT q.*, COUNT(questions.id) AS question_count
      FROM quizzes q LEFT JOIN questions ON questions.quiz_id = q.id
      WHERE q.organizer_id = ? GROUP BY q.id ORDER BY q.updated_at DESC
    `).all(req.user.id).map(mapQuiz);
    res.json({ quizzes });
  });

  app.post("/api/quizzes", requireAuth, requireRole("ORGANIZER"), (req, res) => {
    const title = String(req.body.title || "").trim();
    if (!title) return res.status(400).json({ error: "Введите название квиза" });
    const questionTime = Math.min(120, Math.max(5, Number(req.body.questionTime) || 20));
    const points = Math.min(10000, Math.max(100, Number(req.body.pointsPerQuestion) || 1000));
    const result = db.prepare(`
      INSERT INTO quizzes (organizer_id, title, description, category, rules, question_time, points_per_question)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(req.user.id, title, String(req.body.description || ""), String(req.body.category || "Общее"), String(req.body.rules || ""), questionTime, points);
    res.status(201).json({ quiz: getQuizWithQuestions(result.lastInsertRowid, true) });
  });

  app.get("/api/quizzes/:id", requireAuth, requireRole("ORGANIZER"), quizOwner, (req, res) => {
    res.json({ quiz: getQuizWithQuestions(req.quiz.id, true) });
  });

  app.put("/api/quizzes/:id", requireAuth, requireRole("ORGANIZER"), quizOwner, (req, res) => {
    const title = String(req.body.title || req.quiz.title).trim();
    const questionTime = Math.min(120, Math.max(5, Number(req.body.questionTime) || req.quiz.question_time));
    const points = Math.min(10000, Math.max(100, Number(req.body.pointsPerQuestion) || req.quiz.points_per_question));
    db.prepare(`
      UPDATE quizzes SET title = ?, description = ?, category = ?, rules = ?, question_time = ?, points_per_question = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(title, String(req.body.description ?? req.quiz.description), String(req.body.category ?? req.quiz.category), String(req.body.rules ?? req.quiz.rules), questionTime, points, req.quiz.id);
    res.json({ quiz: getQuizWithQuestions(req.quiz.id, true) });
  });

  app.delete("/api/quizzes/:id", requireAuth, requireRole("ORGANIZER"), quizOwner, (req, res) => {
    db.prepare("DELETE FROM quizzes WHERE id = ?").run(req.quiz.id);
    res.status(204).end();
  });

  app.post("/api/quizzes/:quizId/questions", requireAuth, requireRole("ORGANIZER"), quizOwner, (req, res) => {
    const parsed = validateQuestion(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const nextPosition = db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM questions WHERE quiz_id = ?")
      .get(req.quiz.id).position;
    const value = parsed.value;
    db.prepare(`
      INSERT INTO questions (quiz_id, text, image_url, type, options_json, correct_answers_json, explanation, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.quiz.id, value.text, value.imageUrl, value.type, JSON.stringify(value.options), JSON.stringify(value.correctAnswers), value.explanation, nextPosition);
    res.status(201).json({ quiz: getQuizWithQuestions(req.quiz.id, true) });
  });

  app.put("/api/quizzes/:quizId/questions/:questionId", requireAuth, requireRole("ORGANIZER"), quizOwner, (req, res) => {
    const question = db.prepare("SELECT * FROM questions WHERE id = ? AND quiz_id = ?").get(Number(req.params.questionId), req.quiz.id);
    if (!question) return res.status(404).json({ error: "Вопрос не найден" });
    const parsed = validateQuestion(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const value = parsed.value;
    db.prepare(`UPDATE questions SET text = ?, image_url = ?, type = ?, options_json = ?, correct_answers_json = ?, explanation = ? WHERE id = ?`)
      .run(value.text, value.imageUrl, value.type, JSON.stringify(value.options), JSON.stringify(value.correctAnswers), value.explanation, question.id);
    res.json({ quiz: getQuizWithQuestions(req.quiz.id, true) });
  });

  app.delete("/api/quizzes/:quizId/questions/:questionId", requireAuth, requireRole("ORGANIZER"), quizOwner, (req, res) => {
    db.prepare("DELETE FROM questions WHERE id = ? AND quiz_id = ?").run(Number(req.params.questionId), req.quiz.id);
    res.json({ quiz: getQuizWithQuestions(req.quiz.id, true) });
  });

  app.post("/api/uploads", requireAuth, requireRole("ORGANIZER"), upload.single("image"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Выберите изображение" });
    res.status(201).json({ url: `/uploads/${req.file.filename}` });
  });

  app.get("/api/history", requireAuth, (req, res) => {
    if (req.user.role === "ORGANIZER") {
      const sessions = db.prepare(`
        SELECT s.id, s.room_code, s.status, s.started_at, s.finished_at, q.title,
          COUNT(sp.id) AS player_count,
          (SELECT u.name FROM session_players top_sp JOIN users u ON u.id = top_sp.user_id WHERE top_sp.session_id = s.id ORDER BY top_sp.score DESC LIMIT 1) AS winner
        FROM quiz_sessions s JOIN quizzes q ON q.id = s.quiz_id
        LEFT JOIN session_players sp ON sp.session_id = s.id
        WHERE q.organizer_id = ? GROUP BY s.id ORDER BY s.created_at DESC
      `).all(req.user.id);
      return res.json({ sessions });
    }
    const sessions = db.prepare(`
      SELECT s.id, s.room_code, s.status, s.started_at, s.finished_at, q.title, sp.score,
        (SELECT COUNT(*) FROM answers a WHERE a.session_id = s.id AND a.user_id = ? AND a.is_correct = 1) AS correct_count
      FROM session_players sp JOIN quiz_sessions s ON s.id = sp.session_id JOIN quizzes q ON q.id = s.quiz_id
      WHERE sp.user_id = ? ORDER BY sp.joined_at DESC
    `).all(req.user.id, req.user.id);
    res.json({ sessions });
  });

  const distDir = path.join(rootDir, "dist");
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get("/{*splat}", (_req, res) => res.sendFile(path.join(distDir, "index.html")));
  }

  app.use((error, _req, res, _next) => {
    console.error(error);
    if (error instanceof multer.MulterError) return res.status(400).json({ error: "Изображение слишком большое" });
    res.status(500).json({ error: "Внутренняя ошибка сервера" });
  });
  return app;
}
