import "dotenv/config";
import http from "node:http";
import { Server } from "socket.io";
import { createApp } from "./app.js";
import { socketAuth } from "./auth.js";
import { attachRealtime } from "./realtime.js";

const port = Number(process.env.PORT) || 3001;
const app = createApp();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CLIENT_URL || "http://localhost:5173" }
});

io.use(socketAuth);
attachRealtime(io);

server.listen(port, () => {
  console.log(`QuizRoom server: http://localhost:${port}`);
});
