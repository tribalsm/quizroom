import { io } from "socket.io-client";

const baseUrl = process.env.SMOKE_URL || "http://localhost:3001";

async function login(email) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "quiz123" })
  });
  if (!response.ok) throw new Error(`Не удалось войти как ${email}`);
  return response.json();
}

function connected(socket) {
  return new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function nextEvent(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

const organizer = await login("organizer@quizroom.local");
const participant = await login("player@quizroom.local");
const quizResponse = await fetch(`${baseUrl}/api/quizzes`, { headers: { Authorization: `Bearer ${organizer.token}` } });
const { quizzes } = await quizResponse.json();
const quiz = quizzes.find((item) => item.title === "Разминка: мир технологий");
if (!quiz) throw new Error("Демонстрационный квиз не найден");

const host = io(baseUrl, { auth: { token: organizer.token }, transports: ["websocket"] });
const player = io(baseUrl, { auth: { token: participant.token }, transports: ["websocket"] });

try {
  await Promise.all([connected(host), connected(player)]);
  const created = await emitAck(host, "host:create", { quizId: quiz.id });
  if (created.error) throw new Error(created.error);
  const joined = await emitAck(player, "player:join", { code: created.room.code });
  if (joined.error) throw new Error(joined.error);

  const questionForPlayer = nextEvent(player, "quiz:question");
  const started = await emitAck(host, "host:start", { code: created.room.code });
  if (started.error) throw new Error(started.error);
  const question = await questionForPlayer;

  const answer = await emitAck(player, "player:answer", { code: created.room.code, questionId: question.id, answers: [0] });
  if (answer.error || answer.points <= 0) throw new Error(answer.error || "Баллы не начислены");

  const reconnected = io(baseUrl, { auth: { token: participant.token }, transports: ["websocket"] });
  try {
    await connected(reconnected);
    const resumed = await emitAck(reconnected, "room:resume", { code: created.room.code });
    if (!resumed.ok || resumed.role !== "player" || !resumed.resume?.question?.alreadyAnswered) {
      throw new Error("Состояние участника после переподключения не восстановлено");
    }
  } finally {
    reconnected.disconnect();
  }

  const finishedForPlayer = nextEvent(player, "quiz:finished");
  const finished = await emitAck(host, "host:finish", { code: created.room.code });
  const final = await finishedForPlayer;
  const playerResult = final.leaderboard.find((row) => row.userId === participant.user.id);
  if (!finished.ok || !playerResult || playerResult.score <= 0 || !final.stats?.playerCount) throw new Error("Итоговый рейтинг сформирован неверно");
  console.log(`Socket.IO smoke-test пройден: комната ${created.room.code}, ${playerResult.score} баллов`);
} finally {
  host.disconnect();
  player.disconnect();
}
