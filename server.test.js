"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { afterEach, test } = require("node:test");
const { io: createClient } = require("socket.io-client");
const {
  createSocketServer,
  getApiBaseUrl,
  getIceServers,
  parseAllowedOrigins,
  parsePort
} = require("./server");

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(({ io }) => new Promise((resolve) => io.close(resolve))));
});

async function startTestServer(options = {}) {
  const server = createSocketServer({
    allowedOrigins: ["http://localhost:3000"],
    apiBaseUrl: "http://laravel.test/api",
    fetchImpl: mockLaravelFetch(),
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    ...options
  });
  servers.push(server);

  await new Promise((resolve, reject) => {
    server.httpServer.once("error", reject);
    server.httpServer.listen(0, "127.0.0.1", resolve);
  });

  return `http://127.0.0.1:${server.httpServer.address().port}`;
}

function mockLaravelFetch({ deniedConversationId, mismatchedPeerConversationId } = {}) {
  return async (url, options) => {
    const token = options.headers.Authorization.replace("Bearer ", "");
    const userId = Number(token.split("-").at(-1));
    const pathname = new URL(url).pathname;

    if (pathname.endsWith("/auth/socket-identity")) {
      return Response.json({ id: userId, name: `User ${userId}`, phone: `+1555000000${userId}` });
    }

    if (pathname.endsWith("/friends")) {
      const friendId = userId === 1 ? 2 : 1;
      return Response.json({ data: [{ id: friendId, name: `User ${friendId}`, phone: `+1555000000${friendId}` }] });
    }

    if (pathname.includes("/socket-access")) {
      const conversationId = Number(pathname.split("/").at(-2));

      if (conversationId === deniedConversationId) {
        return Response.json({ message: "Not found." }, { status: 404 });
      }

      const peerId = conversationId === mismatchedPeerConversationId
        ? 3
        : userId === 1 ? 2 : 1;
      return Response.json({ conversation_id: conversationId, peer_id: peerId });
    }

    return Response.json({ message: "Not found." }, { status: 404 });
  };
}

async function connectClient(baseUrl, userId) {
  const client = createClient(baseUrl, {
    auth: { token: `a-valid-sanctum-token-for-user-${userId}` },
    transports: ["websocket"],
    reconnection: false,
    timeout: 2000
  });
  await new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("connect_error", reject);
  });
  return client;
}

function waitForEvent(client, event) {
  return new Promise((resolve) => client.once(event, resolve));
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        resolve({ statusCode: response.statusCode, body: JSON.parse(body) });
      });
    }).on("error", reject);
  });
}

test("health endpoint reports the server as ready", async () => {
  const baseUrl = await startTestServer();

  assert.deepEqual(await getJson(`${baseUrl}/health`), {
    statusCode: 200,
    body: { status: "ok" }
  });
});

test("unknown HTTP paths return a JSON 404", async () => {
  const baseUrl = await startTestServer();

  assert.deepEqual(await getJson(`${baseUrl}/unknown`), {
    statusCode: 404,
    body: { error: "Not found" }
  });
});

test("socket clients can ping and receive a timestamped pong", async () => {
  const baseUrl = await startTestServer();
  const client = createClient(baseUrl, {
    auth: { token: "a-valid-sanctum-token-for-user-1" },
    transports: ["websocket"]
  });

  try {
    await new Promise((resolve, reject) => {
      client.once("connect", resolve);
      client.once("connect_error", reject);
    });

    const pong = new Promise((resolve) => client.once("server:pong", resolve));
    client.emit("client:ping");
    const response = await pong;

    assert.equal(typeof response.timestamp, "string");
    assert.equal(Number.isNaN(Date.parse(response.timestamp)), false);
  } finally {
    client.close();
  }
});

test("call invites cannot target a friend outside the selected conversation", async () => {
  const baseUrl = await startTestServer({
    fetchImpl: mockLaravelFetch({ mismatchedPeerConversationId: 42 })
  });
  const caller = await connectClient(baseUrl, 1);
  const callee = await connectClient(baseUrl, 2);

  try {
    const joined = waitForEvent(caller, "conversation:joined");
    caller.emit("conversation:join", { conversation_id: 42 });
    await joined;

    const rejected = waitForEvent(caller, "call:error");
    caller.emit("call:invite", {
      call_id: "test-call-id-222222",
      conversation_id: 42,
      target_user_id: 2,
      media_type: "audio"
    });
    assert.deepEqual(await rejected, {
      call_id: "test-call-id-222222",
      message: "Conversation access denied."
    });
  } finally {
    caller.close();
    callee.close();
  }
});

test("socket connections from origins outside the allowlist are rejected", async () => {
  const baseUrl = await startTestServer();
  const client = createClient(baseUrl, {
    transports: ["websocket"],
    extraHeaders: { Origin: "https://untrusted.example" },
    reconnection: false,
    timeout: 2000
  });

  try {
    await assert.rejects(new Promise((resolve, reject) => {
      client.once("connect", resolve);
      client.once("connect_error", reject);
    }));
  } finally {
    client.close();
  }
});

test("configuration rejects malformed origins and ports", () => {
  assert.throws(() => parseAllowedOrigins("https://example.com/path"), /without paths/);
  assert.throws(() => parsePort("not-a-port"), /Invalid PORT/);
  assert.throws(() => getApiBaseUrl("file:///api"), /HTTP\(S\).*ending in \/api/);
  assert.deepEqual(getIceServers({
    stunUrls: "stun:stun.example.test:3478",
    turnUrls: "turn:relay.example.test:3478,turns:relay.example.test:5349",
    turnUsername: "daylight",
    turnCredential: "secret"
  }), [
    { urls: "stun:stun.example.test:3478" },
    {
      urls: ["turn:relay.example.test:3478", "turns:relay.example.test:5349"],
      username: "daylight",
      credential: "secret"
    }
  ]);
  assert.throws(() => getIceServers({
    stunUrls: "stun:stun.example.test:3478",
    turnUrls: "turn:relay.example.test:3478"
  }), /TURN_SERVER_USERNAME and TURN_SERVER_CREDENTIAL/);
});

test("socket authentication rejects missing or invalid tokens", async () => {
  const baseUrl = await startTestServer({
    apiBaseUrl: "http://laravel.test/api",
    fetchImpl: mockLaravelFetch()
  });
  const client = createClient(baseUrl, {
    auth: { token: "short" },
    transports: ["websocket"],
    reconnection: false,
    timeout: 2000
  });

  try {
    await assert.rejects(waitForConnection(client), /Authentication required/);
  } finally {
    client.close();
  }
});

function waitForConnection(client) {
  return new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("connect_error", reject);
  });
}

test("friends receive online presence updates and an initial presence snapshot", async () => {
  const baseUrl = await startTestServer({
    apiBaseUrl: "http://laravel.test/api",
    fetchImpl: mockLaravelFetch()
  });
  const first = createClient(baseUrl, {
    auth: { token: "a-valid-sanctum-token-for-user-1" },
    transports: ["websocket"],
    reconnection: false,
    timeout: 2000
  });
  const firstSnapshot = waitForEvent(first, "presence:sync");
  await waitForConnection(first);
  let second;

  try {
    assert.deepEqual(await firstSnapshot, [{ user_id: 2, is_online: false }]);

    const online = waitForEvent(first, "presence:update");
    second = createClient(baseUrl, {
      auth: { token: "a-valid-sanctum-token-for-user-2" },
      transports: ["websocket"],
      reconnection: false,
      timeout: 2000
    });
    const secondSnapshot = waitForEvent(second, "presence:sync");
    await waitForConnection(second);
    assert.deepEqual(await online, { user_id: 2, is_online: true });

    assert.deepEqual(await secondSnapshot, [{ user_id: 1, is_online: true }]);

    const offline = waitForEvent(first, "presence:update");
    second.disconnect();
    assert.deepEqual(await offline, { user_id: 2, is_online: false });
  } finally {
    first.close();
    second?.close();
  }
});

test("authorized conversation members receive typing updates without trusting client user IDs", async () => {
  const baseUrl = await startTestServer({
    apiBaseUrl: "http://laravel.test/api",
    fetchImpl: mockLaravelFetch()
  });
  const first = await connectClient(baseUrl, 1);
  const second = await connectClient(baseUrl, 2);

  try {
    const firstJoined = waitForEvent(first, "conversation:joined");
    const secondJoined = waitForEvent(second, "conversation:joined");
    first.emit("conversation:join", { conversation_id: 42 });
    second.emit("conversation:join", { conversation_id: 42 });
    assert.deepEqual(await firstJoined, { conversation_id: 42 });
    assert.deepEqual(await secondJoined, { conversation_id: 42 });

    const typing = waitForEvent(second, "conversation:typing");
    first.emit("conversation:typing", { conversation_id: 42, user_id: 999 });
    assert.deepEqual(await typing, {
      conversation_id: 42,
      user_id: 1,
      name: "User 1"
    });

    const stopped = waitForEvent(second, "conversation:stop-typing");
    first.emit("conversation:stop-typing", { conversation_id: 42 });
    assert.deepEqual(await stopped, { conversation_id: 42, user_id: 1 });
  } finally {
    first.close();
    second.close();
  }
});

test("socket server does not join a conversation rejected by Laravel", async () => {
  const baseUrl = await startTestServer({
    apiBaseUrl: "http://laravel.test/api",
    fetchImpl: mockLaravelFetch({ deniedConversationId: 43 })
  });
  const client = await connectClient(baseUrl, 1);
  const friend = await connectClient(baseUrl, 2);

  try {
    const error = waitForEvent(client, "server:error");
    client.emit("conversation:join", { conversation_id: 43 });
    assert.deepEqual(await error, { message: "You do not have access to this conversation." });

    let receivedTyping = false;
    friend.once("conversation:typing", () => {
      receivedTyping = true;
    });
    client.emit("conversation:typing", { conversation_id: 43 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(receivedTyping, false);
  } finally {
    client.close();
    friend.close();
  }
});

test("friends can establish an authorized one-to-one call and relay WebRTC signals", async () => {
  const baseUrl = await startTestServer();
  const caller = await connectClient(baseUrl, 1);
  const callee = await connectClient(baseUrl, 2);

  try {
    const iceConfig = waitForEvent(callee, "call:config");
    callee.emit("call:ready", { enabled: true });
    assert.deepEqual(await iceConfig, {
      ice_servers: [{ urls: "stun:stun.l.google.com:19302" }]
    });
    const joined = waitForEvent(caller, "conversation:joined");
    caller.emit("conversation:join", { conversation_id: 42 });
    await joined;

    const invite = waitForEvent(callee, "call:invite");
    caller.emit("call:invite", {
      call_id: "test-call-id-123456",
      conversation_id: 42,
      target_user_id: 2,
      media_type: "video"
    });
    assert.deepEqual(await invite, {
      call_id: "test-call-id-123456",
      conversation_id: 42,
      caller_id: 1,
      caller_name: "User 1",
      media_type: "video"
    });

    const accepted = waitForEvent(caller, "call:accepted");
    callee.emit("call:accept", { call_id: "test-call-id-123456" });
    assert.deepEqual(await accepted, { call_id: "test-call-id-123456" });

    const signal = waitForEvent(callee, "call:signal");
    caller.emit("call:signal", {
      call_id: "test-call-id-123456",
      signal: { type: "offer", sdp: "test-sdp" }
    });
    assert.deepEqual(await signal, {
      call_id: "test-call-id-123456",
      signal: { type: "offer", sdp: "test-sdp" }
    });

    const ended = waitForEvent(callee, "call:ended");
    caller.emit("call:end", { call_id: "test-call-id-123456" });
    assert.deepEqual(await ended, { call_id: "test-call-id-123456" });
  } finally {
    caller.close();
    callee.close();
  }
});

test("call signaling requires an enabled friend in the authorized conversation", async () => {
  const baseUrl = await startTestServer();
  const caller = await connectClient(baseUrl, 1);
  const callee = await connectClient(baseUrl, 2);

  try {
    callee.emit("call:ready", { enabled: true });
    const rejected = waitForEvent(caller, "call:error");
    caller.emit("call:invite", {
      call_id: "test-call-id-123456",
      conversation_id: 42,
      target_user_id: 2,
      media_type: "audio"
    });
    assert.deepEqual(await rejected, {
      call_id: "test-call-id-123456",
      message: "This call could not be started."
    });

    const joined = waitForEvent(caller, "conversation:joined");
    caller.emit("conversation:join", { conversation_id: 42 });
    await joined;

    const invalidPeer = waitForEvent(caller, "call:error");
    caller.emit("call:invite", {
      call_id: "test-call-id-654321",
      conversation_id: 42,
      target_user_id: 1,
      media_type: "audio"
    });
    assert.deepEqual(await invalidPeer, {
      call_id: "test-call-id-654321",
      message: "This call could not be started."
    });

    callee.emit("call:ready", { enabled: false });
    const unavailable = waitForEvent(caller, "call:unavailable");
    caller.emit("call:invite", {
      call_id: "test-call-id-111111",
      conversation_id: 42,
      target_user_id: 2,
      media_type: "audio"
    });
    assert.equal((await unavailable).call_id, "test-call-id-111111");
  } finally {
    caller.close();
    callee.close();
  }
});
