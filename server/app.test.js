import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";
import { db } from "./db.js";
import { hashPassword } from "./auth.js";

const app = createApp();

beforeAll(async () => {
  const hash = await hashPassword("quiz123");
  db.prepare("INSERT OR IGNORE INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)")
    .run("Тестовый организатор", "test-organizer@quizroom.local", hash, "ORGANIZER");
  db.prepare("INSERT OR IGNORE INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)")
    .run("Тестовый участник", "test-player@quizroom.local", hash, "PARTICIPANT");
});

afterAll(() => {
  const organizer = db.prepare("SELECT id FROM users WHERE email = ?").get("test-organizer@quizroom.local");
  if (organizer) {
    db.prepare("DELETE FROM quizzes WHERE organizer_id = ? AND (title LIKE 'Тестовый квиз %' OR title LIKE 'Гостевой тест %')")
      .run(organizer.id);
  }
  db.prepare("DELETE FROM users WHERE email LIKE '%@guest.quizroom.local' AND id NOT IN (SELECT user_id FROM session_players)").run();
});

async function login(email) {
  const response = await request(app).post("/api/auth/login").send({ email, password: "quiz123" });
  return response.body.token;
}

describe("QuizRoom API", () => {
  it("отвечает на health-check", async () => {
    const response = await request(app).get("/api/health");
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });

  it("авторизует пользователя", async () => {
    const response = await request(app).post("/api/auth/login").send({ email: "test-organizer@quizroom.local", password: "quiz123" });
    expect(response.status).toBe(200);
    expect(response.body.user.role).toBe("ORGANIZER");
    expect(response.body.token).toBeTruthy();
  });

  it("создаёт квиз и вопрос", async () => {
    const token = await login("test-organizer@quizroom.local");
    const quizResponse = await request(app).post("/api/quizzes").set("Authorization", `Bearer ${token}`).send({
      title: `Тестовый квиз ${Date.now()}`,
      category: "Тест",
      questionTime: 15
    });
    expect(quizResponse.status).toBe(201);
    const questionResponse = await request(app)
      .post(`/api/quizzes/${quizResponse.body.quiz.id}/questions`)
      .set("Authorization", `Bearer ${token}`)
      .send({ text: "Два плюс два?", type: "SINGLE", options: ["3", "4"], correctAnswers: [1], explanation: "Два и ещё два дают четыре." });
    expect(questionResponse.status).toBe(201);
    expect(questionResponse.body.quiz.questions).toHaveLength(1);
    expect(questionResponse.body.quiz.questions[0].correctAnswers).toEqual([1]);
    expect(questionResponse.body.quiz.questions[0].explanation).toBe("Два и ещё два дают четыре.");
  });

  it("создаёт гостевого участника для активной комнаты", async () => {
    const organizer = db.prepare("SELECT id FROM users WHERE email = ?").get("test-organizer@quizroom.local");
    const quiz = db.prepare("INSERT INTO quizzes (organizer_id, title) VALUES (?, ?)")
      .run(organizer.id, `Гостевой тест ${Date.now()}`);
    const roomCode = String(Date.now()).slice(-6);
    db.prepare("INSERT INTO quiz_sessions (quiz_id, room_code) VALUES (?, ?)").run(quiz.lastInsertRowid, roomCode);
    const response = await request(app).post("/api/auth/guest").send({ name: "Гость", roomCode });
    expect(response.status).toBe(201);
    expect(response.body.user.role).toBe("PARTICIPANT");
    expect(response.body.user.isGuest).toBe(true);
    expect(response.body.roomCode).toBe(roomCode);
  });

  it("не разрешает участнику управлять квизами", async () => {
    const token = await login("test-player@quizroom.local");
    const response = await request(app).get("/api/quizzes").set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(403);
  });
});
