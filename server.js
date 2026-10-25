"use strict";

// Load .env from the app directory, regardless of where PM2 launched us from.
// Falls back to default CWD lookup if the explicit path is wrong.
const path = require("node:path");
const dotenvResult = require("dotenv").config({
  path: process.env.ENV_FILE || path.join(__dirname, ".env"),
});
if (dotenvResult.error && dotenvResult.error.code !== "ENOENT") {
  console.error("Failed to load .env:", dotenvResult.error.message);
}

const http = require("node:http");
const { Server } = require("socket.io");

const DEFAULT_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:8081",
  "http://localhost:19006",
];

function getApiBaseUrl(value = process.env.LARAVEL_API_URL || "https://api.sanjakarobar.com/api") {
  const trimmed = String(value).trim();
  let parsedUrl;

  try {
    parsedUrl = new URL(trimmed);
  } catch {
    throw new Error(`Invalid LARAVEL_API_URL: ${JSON.stringify(value)}`);
  }

  const normalizedPath = parsedUrl.pathname.replace(/\/+$/, "");
  if (
    !["http:", "https:"].includes(parsedUrl.protocol) ||
    !normalizedPath.endsWith("/api")
  ) {
    throw new Error(
      `LARAVEL_API_URL must be an HTTP(S) URL ending in /api (got ${JSON.stringify(value)})`
    );
  }

  return trimmed.replace(/\/+$/, "");
}

function parseAllowedOrigins(value = process.env.CORS_ORIGINS) {
  if (value === undefined || value === "") {
    return DEFAULT_ORIGINS;
  }

  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => {
      let parsedOrigin;

      try {
        parsedOrigin = new URL(origin);
      } catch {
        throw new Error(`Invalid CORS origin: ${origin}`);
      }

      if (
        !["http:", "https:"].includes(parsedOrigin.protocol) ||
        parsedOrigin.origin !== origin
      ) {
        throw new Error(`CORS entries must be origins without paths: ${origin}`);
      }

      return origin;
    });
}

function getIceServers({
  stunUrls = process.env.STUN_SERVER_URLS || "stun:stun.l.google.com:19302",
  turnUrls = process.env.TURN_SERVER_URLS || "",
  turnUsername = process.env.TURN_SERVER_USERNAME || "",
  turnCredential = process.env.TURN_SERVER_CREDENTIAL || "",
} = {}) {
  const urls = (value, label) =>
    value
      .split(",")
      .map((url) => url.trim())
      .filter(Boolean)
      .map((url) => {
        if (!/^(stun|stuns|turn|turns):[^\s]+$/i.test(url)) {
          throw new Error(`Invalid ${label} URL: ${url}`);
        }
        return url;
      });

  const stunServerUrls = urls(stunUrls, "STUN");
  if (!stunServerUrls.every((url) => /^(stun|stuns):/i.test(url))) {
    throw new Error("STUN_SERVER_URLS may contain only stun: or stuns: URLs");
  }

  const servers = stunServerUrls.map((url) => ({ urls: url }));
  const turnServerUrls = urls(turnUrls, "TURN");

  if (turnServerUrls.length > 0) {
    if (!turnServerUrls.every((url) => /^(turn|turns):/i.test(url))) {
      throw new Error("TURN_SERVER_URLS may contain only turn: or turns: URLs");
    }
    if (!turnUsername || !turnCredential) {
      throw new Error(
        "TURN_SERVER_USERNAME and TURN_SERVER_CREDENTIAL are required when TURN_SERVER_URLS is set"
      );
    }
    servers.push({
      urls: turnServerUrls,
      username: turnUsername,
      credential: turnCredential,
    });
  } else if (turnUsername || turnCredential) {
    throw new Error("TURN_SERVER_URLS is required when TURN credentials are set");
  }

  if (servers.length === 0) {
    throw new Error("At least one STUN or TURN server must be configured");
  }
  return servers;
}

function parsePort(value = process.env.PORT || "3001") {
  const port = Number(value);

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT value: ${value}`);
  }

  return port;
}

function createSocketServer({
  allowedOrigins = parseAllowedOrigins(),
  apiBaseUrl = getApiBaseUrl(),
  iceServers = getIceServers(),
  fetchImpl = globalThis.fetch,
} = {}) {
  const originSet = new Set(allowedOrigins);
  const connectedUsers = new Map();
  const calls = new Map();
  const callsByUser = new Map();

  const httpServer = http.createServer((request, response) => {
    let pathname;
    try {
      pathname = new URL(request.url || "/", "http://localhost").pathname;
    } catch {
      response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "Bad request" }));
      return;
    }

    if (request.method === "GET" && pathname === "/") {
      const body = JSON.stringify({
        service: "socket-server",
        status: "ok",
        health: "/health",
        socket: "/socket.io/",
      });
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
      });
      response.end(body);
      return;
    }

    // /health — self-contained, no dependencies, always answerable.
    if (request.method === "GET" && pathname === "/health") {
      const body = JSON.stringify({ status: "ok" });
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
      });
      response.end(body);
      return;
    }

    response.writeHead(404, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify({ error: "Not found" }));
  });

  const io = new Server(httpServer, {
    allowRequest(request, callback) {
      const origin = request.headers.origin;
      callback(null, !origin || originSet.has(origin));
    },
    cors: {
      origin(origin, callback) {
        if (!origin || originSet.has(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error("Origin not allowed"));
      },
      methods: ["GET", "POST"],
    },
  });

  async function apiGet(apiPath, token) {
    const response = await fetchImpl(`${apiBaseUrl}${apiPath}`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      const error = new Error(
        `Laravel API rejected socket request (${response.status})`
      );
      error.status = response.status;
      throw error;
    }

    return response.json();
  }

  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;

    if (typeof token !== "string" || token.length < 20 || token.length > 512) {
      next(new Error("Authentication required"));
      return;
    }

    try {
      const [user, friendResponse] = await Promise.all([
        apiGet("/auth/socket-identity", token),
        apiGet("/friends", token),
      ]);
      const userId = Number(user.id);
      const friends = friendResponse.data;

      if (!Number.isSafeInteger(userId) || !Array.isArray(friends)) {
        throw new Error("Laravel returned an invalid socket identity or friend list");
      }

      socket.data.user = { id: userId, name: user.name };
      socket.data.friendIds = friends
        .map((friend) => Number(friend.id))
        .filter(
          (friendId) =>
            Number.isSafeInteger(friendId) && friendId !== userId
        );
      next();
    } catch (error) {
      if (error.status === 401) {
        next(new Error("Authentication failed"));
        return;
      }
      console.error("Socket authentication failed:", error.message);
      next(new Error("Unable to authenticate with the Laravel API"));
    }
  });

  io.on("connection", (socket) => {
    const { id: userId } = socket.data.user;
    const userRoom = `user:${userId}`;
    const userSockets = connectedUsers.get(userId) || new Set();
    const becameOnline = userSockets.size === 0;
    const typingTimers = new Map();
    socket.data.callingEnabled = false;

    function finishCall(call, event, payload = {}) {
      removeCall(call);
      io.to(`user:${call.callerUserId}`).emit(event, { call_id: call.id, ...payload });
      io.to(`user:${call.targetUserId}`).emit(event, { call_id: call.id, ...payload });
    }

    function removeCall(call) {
      clearTimeout(call.timeout);
      calls.delete(call.id);
      if (callsByUser.get(call.callerUserId) === call.id) {
        callsByUser.delete(call.callerUserId);
      }
      if (callsByUser.get(call.targetUserId) === call.id) {
        callsByUser.delete(call.targetUserId);
      }
    }

    function validCallId(value) {
      return typeof value === "string" && /^[a-zA-Z0-9-]{16,64}$/.test(value);
    }

    function getCall(callId) {
      return validCallId(callId) ? calls.get(callId) : undefined;
    }

    userSockets.add(socket.id);
    connectedUsers.set(userId, userSockets);
    socket.join(userRoom);

    socket.emit(
      "presence:sync",
      socket.data.friendIds.map((friendId) => ({
        user_id: friendId,
        is_online: (connectedUsers.get(friendId)?.size || 0) > 0,
      }))
    );

    if (becameOnline) {
      for (const friendId of socket.data.friendIds) {
        io.to(`user:${friendId}`).emit("presence:update", {
          user_id: userId,
          is_online: true,
        });
      }
    }

    function stopTyping(conversationId) {
      const timeout = typingTimers.get(conversationId);
      if (timeout) {
        clearTimeout(timeout);
        typingTimers.delete(conversationId);
      }
      if (socket.rooms.has(`conversation:${conversationId}`)) {
        socket
          .to(`conversation:${conversationId}`)
          .emit("conversation:stop-typing", {
            conversation_id: conversationId,
            user_id: userId,
          });
      }
    }

    socket.on("client:ping", () => {
      socket.emit("server:pong", { timestamp: new Date().toISOString() });
    });

    socket.on("conversation:join", async (payload) => {
      const conversationId = Number(payload?.conversation_id);

      if (!Number.isSafeInteger(conversationId) || conversationId < 1) {
        socket.emit("server:error", { message: "Invalid conversation." });
        return;
      }

      try {
        const access = await apiGet(
          `/conversations/${conversationId}/socket-access`,
          socket.handshake.auth.token
        );

        if (Number(access.conversation_id) !== conversationId) {
          socket.emit("server:error", { message: "Conversation access denied." });
          return;
        }

        socket.join(`conversation:${conversationId}`);
        socket.emit("conversation:joined", {
          conversation_id: conversationId,
        });
      } catch (error) {
        if (error.status === 401) {
          socket.emit("server:error", {
            message: "Your session has expired. Sign in again.",
          });
          socket.disconnect(true);
          return;
        }
        if (error.status === 404 || error.status === 403) {
          socket.emit("server:error", {
            message: "You do not have access to this conversation.",
          });
          return;
        }
        console.error("Conversation authorization failed:", error.message);
        socket.emit("server:error", {
          message: "Could not authorize the conversation.",
        });
      }
    });

    socket.on("conversation:leave", (payload) => {
      const conversationId = Number(payload?.conversation_id);

      if (Number.isSafeInteger(conversationId) && conversationId > 0) {
        stopTyping(conversationId);
        socket.leave(`conversation:${conversationId}`);
      }
    });

    socket.on("conversation:typing", (payload) => {
      const conversationId = Number(payload?.conversation_id);

      if (
        !Number.isSafeInteger(conversationId) ||
        !socket.rooms.has(`conversation:${conversationId}`)
      ) {
        return;
      }

      socket.to(`conversation:${conversationId}`).emit("conversation:typing", {
        conversation_id: conversationId,
        user_id: userId,
        name: socket.data.user.name,
      });
      clearTimeout(typingTimers.get(conversationId));
      typingTimers.set(
        conversationId,
        setTimeout(() => stopTyping(conversationId), 4000)
      );
    });

    socket.on("conversation:stop-typing", (payload) => {
      const conversationId = Number(payload?.conversation_id);

      if (
        !Number.isSafeInteger(conversationId) ||
        !socket.rooms.has(`conversation:${conversationId}`)
      ) {
        return;
      }

      stopTyping(conversationId);
    });

    socket.on("call:ready", (payload) => {
      socket.data.callingEnabled = payload?.enabled === true;
      if (socket.data.callingEnabled) {
        socket.emit("call:config", { ice_servers: iceServers });
      }
    });

    socket.on("call:invite", async (payload) => {
      const callId = payload?.call_id;
      const conversationId = Number(payload?.conversation_id);
      const targetUserId = Number(payload?.target_user_id);
      const mediaType = payload?.media_type;

      if (
        !validCallId(callId) ||
        calls.has(callId) ||
        !Number.isSafeInteger(conversationId) ||
        conversationId < 1 ||
        !Number.isSafeInteger(targetUserId) ||
        targetUserId < 1 ||
        targetUserId === userId ||
        !socket.data.friendIds.includes(targetUserId) ||
        !["audio", "video"].includes(mediaType) ||
        !socket.rooms.has(`conversation:${conversationId}`)
      ) {
        socket.emit("call:error", {
          call_id: callId,
          message: "This call could not be started.",
        });
        return;
      }

      if (callsByUser.has(userId) || callsByUser.has(targetUserId)) {
        socket.emit("call:busy", { call_id: callId, user_id: targetUserId });
        return;
      }

      const call = {
        id: callId,
        conversationId,
        callerUserId: userId,
        callerSocketId: socket.id,
        targetUserId,
        targetSocketIds: new Set(),
        acceptedSocketId: null,
        timeout: null,
      };
      calls.set(callId, call);
      callsByUser.set(userId, callId);
      callsByUser.set(targetUserId, callId);

      try {
        const access = await apiGet(
          `/conversations/${conversationId}/socket-access`,
          socket.handshake.auth.token
        );
        if (
          Number(access.conversation_id) !== conversationId ||
          Number(access.peer_id) !== targetUserId
        ) {
          removeCall(call);
          socket.emit("call:error", {
            call_id: callId,
            message: "Conversation access denied.",
          });
          return;
        }
      } catch (error) {
        removeCall(call);
        if (error.status === 401) {
          socket.emit("server:error", {
            message: "Your session has expired. Sign in again.",
          });
          socket.disconnect(true);
          return;
        }
        if (error.status === 403 || error.status === 404) {
          socket.emit("call:error", {
            call_id: callId,
            message: "You do not have access to this conversation.",
          });
          return;
        }
        console.error("Call authorization failed:", error.message);
        socket.emit("call:error", {
          call_id: callId,
          message: "Could not authorize this call.",
        });
        return;
      }

      if (calls.get(callId) !== call) return;
      let targetSockets;
      try {
        targetSockets = await io.in(`user:${targetUserId}`).fetchSockets();
      } catch (error) {
        removeCall(call);
        console.error("Call recipient lookup failed:", error.message);
        socket.emit("call:error", {
          call_id: callId,
          message: "Could not reach your friend for this call.",
        });
        return;
      }
      if (calls.get(callId) !== call) return;

      const availableSockets = targetSockets.filter(
        (targetSocket) => targetSocket.data.callingEnabled
      );
      if (availableSockets.length === 0) {
        removeCall(call);
        socket.emit("call:unavailable", {
          call_id: callId,
          user_id: targetUserId,
        });
        return;
      }

      call.targetSocketIds = new Set(
        availableSockets.map((targetSocket) => targetSocket.id)
      );
      call.timeout = setTimeout(() => {
        finishCall(call, "call:timeout");
      }, 30_000);

      for (const targetSocket of availableSockets) {
        targetSocket.emit("call:invite", {
          call_id: callId,
          conversation_id: conversationId,
          caller_id: userId,
          caller_name: socket.data.user.name,
          media_type: mediaType,
        });
      }
    });

    socket.on("call:accept", (payload) => {
      const call = getCall(payload?.call_id);
      if (
        !call ||
        call.targetUserId !== userId ||
        !call.targetSocketIds.has(socket.id) ||
        call.acceptedSocketId
      )
        return;

      clearTimeout(call.timeout);
      call.timeout = null;
      call.acceptedSocketId = socket.id;
      io.to(call.callerSocketId).emit("call:accepted", { call_id: call.id });
      for (const targetSocketId of call.targetSocketIds) {
        if (targetSocketId !== socket.id) {
          io.to(targetSocketId).emit("call:answered-elsewhere", {
            call_id: call.id,
          });
        }
      }
    });

    socket.on("call:reject", (payload) => {
      const call = getCall(payload?.call_id);
      if (
        !call ||
        call.targetUserId !== userId ||
        !call.targetSocketIds.has(socket.id) ||
        call.acceptedSocketId
      )
        return;
      finishCall(call, "call:rejected");
    });

    socket.on("call:cancel", (payload) => {
      const call = getCall(payload?.call_id);
      if (
        !call ||
        call.callerSocketId !== socket.id ||
        call.acceptedSocketId
      )
        return;
      finishCall(call, "call:ended");
    });

    socket.on("call:end", (payload) => {
      const call = getCall(payload?.call_id);
      if (
        !call ||
        (call.callerSocketId !== socket.id &&
          call.acceptedSocketId !== socket.id)
      )
        return;
      finishCall(call, "call:ended");
    });

    socket.on("call:signal", (payload) => {
      const call = getCall(payload?.call_id);
      const signal = payload?.signal;
      const isCaller = call?.callerSocketId === socket.id;
      const isAcceptedTarget = call?.acceptedSocketId === socket.id;

      if (
        !call ||
        !call.acceptedSocketId ||
        (!isCaller && !isAcceptedTarget) ||
        !signal ||
        typeof signal !== "object" ||
        Array.isArray(signal)
      )
        return;

      let serialized;
      try {
        serialized = JSON.stringify(signal);
      } catch {
        return;
      }
      if (serialized.length > 64_000) return;

      const destination = isCaller
        ? call.acceptedSocketId
        : call.callerSocketId;
      io.to(destination).emit("call:signal", { call_id: call.id, signal });
    });

    socket.on("disconnecting", () => {
      for (const conversationId of typingTimers.keys()) {
        stopTyping(conversationId);
      }
    });

    socket.on("disconnect", () => {
      for (const callId of new Set([callsByUser.get(userId)])) {
        const call = calls.get(callId);
        if (!call) continue;

        if (
          call.callerSocketId === socket.id ||
          call.acceptedSocketId === socket.id
        ) {
          finishCall(call, "call:ended");
        } else {
          call.targetSocketIds.delete(socket.id);
          if (call.targetSocketIds.size === 0 && !call.acceptedSocketId) {
            finishCall(call, "call:unavailable");
          }
        }
      }

      const sockets = connectedUsers.get(userId);
      if (!sockets) return;

      sockets.delete(socket.id);
      if (sockets.size === 0) {
        connectedUsers.delete(userId);
        for (const friendId of socket.data.friendIds) {
          io.to(`user:${friendId}`).emit("presence:update", {
            user_id: userId,
            is_online: false,
          });
        }
      }
    });
  });

  return { httpServer, io, connectedUsers };
}

/**
 * Programmatic liveness check — pings the running server's own /health endpoint.
 * Use this from monitoring / startup scripts. It is NOT an HTTP handler.
 */
async function healthCheck(port = parsePort()) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function startServer() {
  // Validate config BEFORE binding a port. If any of these throws,
  // the process fails to start cleanly instead of binding a half-ready server.
  const port = parsePort();
  const host = process.env.HOST || "0.0.0.0";

  const { httpServer, io } = createSocketServer();

  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  console.info(`Socket server listening on ${host}:${address.port}`);

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      io.close(() => process.exit(0));
    });
  }

  return { httpServer, io };
}

if (require.main === module) {
  startServer().catch((error) => {
    console.error("Failed to start socket server:", error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  createSocketServer,
  getApiBaseUrl,
  getIceServers,
  parseAllowedOrigins,
  parsePort,
  startServer,
  healthCheck,
};