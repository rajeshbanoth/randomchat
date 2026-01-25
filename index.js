// server.js
"use strict";

const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const MatchingEngine = require("./matching-engine"); // keep as-is

// --- Config ---
const SOCKET_ORIGIN = process.env.SOCKET_ORIGIN || "http://localhost:3000";
const PORT = process.env.PORT || 5000;
const INACTIVE_THRESHOLD_MS = 5 * 60 * 1000; // 5 min
const CLEANUP_INTERVAL_MS = 60 * 1000; // 1 min

// --- App / Server / IO ---
const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
  cors: {
    origin: SOCKET_ORIGIN,
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"],
  allowEIO3: true,
});

app.use(cors({ origin: SOCKET_ORIGIN, credentials: true }));
app.use(express.json());

// --- Core state (exported for tests) ---
const matchingEngine = new MatchingEngine();

const activeUsers = new Map(); // socket.id -> { socket, profile, status, partnerId, ... }
const userPairs = new Map(); // socket.id -> partnerId
const messageHistory = new Map(); // socket.id -> [{...}]
const videoCalls = new Map(); // socket.id -> {callId, partnerId, ...}
const typingUsers = new Map(); // userId -> { lastTyped, timeout }
const waitingVideoRequests = new Map();
const userSessions = new Map();
const videoCallMessages = new Map();
const activeRooms = new Map();

// --- Helpers ---
function safeEmit(sock, event, payload) {
  try {
    if (!sock || !sock.connected) return false;
    sock.emit(event, payload);
    return true;
  } catch (err) {
    console.error(`safeEmit error (event=${event}):`, err);
    return false;
  }
}

function makeMockSocket(id = `mock-${Date.now()}`) {
  // Minimal mock socket for tests
  const events = [];
  return {
    id,
    connected: true,
    emitted: events,
    emit: (event, payload) => events.push({ event, payload }),
    disconnect: () => {
      /* mark disconnected in tests if needed */
    },
  };
}

// --- Pure helpers (easy to unit-test) ---
function calculateCompatibility(user1 = {}, user2 = {}) {
  try {
    if (!user1 || !user2) return 50;
    let score = 50;
    const age1 = user1.age || 25;
    const age2 = user2.age || 25;
    const ageDiff = Math.abs(age1 - age2);
    if (ageDiff <= 5) score += 15;
    else if (ageDiff <= 10) score += 5;

    if (user1.genderPreference && user1.genderPreference !== "any") {
      if (user1.genderPreference === user2.gender) score += 10;
    }
    if (user2.genderPreference && user2.genderPreference !== "any") {
      if (user2.genderPreference === user1.gender) score += 10;
    }

    const interests1 = Array.isArray(user1.interests) ? user1.interests : [];
    const interests2 = Array.isArray(user2.interests) ? user2.interests : [];
    const sharedInterests = interests1.filter((i) =>
      interests2.includes(i),
    ).length;
    score += Math.min(sharedInterests * 5, 25);

    return Math.min(Math.max(Math.round(score), 0), 100);
  } catch (err) {
    console.error("calculateCompatibility error:", err);
    return 50;
  }
}

function getSharedInterests(interests1 = [], interests2 = []) {
  try {
    if (!Array.isArray(interests1) || !Array.isArray(interests2)) return [];
    const s2 = new Set(
      interests2.map((i) => `${i || ""}`.toLowerCase().trim()),
    );
    return interests1.filter((i) => s2.has(`${i || ""}`.toLowerCase().trim()));
  } catch (err) {
    console.error("getSharedInterests error:", err);
    return [];
  }
}

// --- Core functions (exported so tests can call them) ---
function registerUser(socket, userData = {}) {
  try {
    if (!socket) throw new Error("Socket required");
    // basic validation + defaults
    const username =
      `${(userData.username || "").trim()}` ||
      `User_${socket.id.substring(0, 6)}`;
    const profile = {
      id: socket.id,
      username,
      gender: userData.gender || "not-specified",
      age: Number(userData.age) || 25,
      interests: Array.isArray(userData.interests) ? userData.interests : [],
      chatMode: userData.chatMode || "text",
      genderPreference: userData.genderPreference || "any",
      ageRange: userData.ageRange || { min: 18, max: 60 },
      isPremium: !!userData.isPremium,
      avatar: userData.avatar || null,
      bio: userData.bio || "",
      createdAt: Date.now(),
      priority: userData.isPremium ? 1.5 : 1.0,
    };

    activeUsers.set(socket.id, {
      socket,
      profile,
      status: "ready",
      searchStart: null,
      attempts: 0,
      partnerId: null,
      matchingInterval: null,
      roomId: null,
      autoConnect: true,
    });

    safeEmit(socket, "registered", {
      success: true,
      userId: socket.id,
      profile,
      estimatedWait: profile.chatMode === "video" ? 5 : 3,
      message: "Registration successful",
    });

    updateStats();
    console.info(
      `[registerUser] ${socket.id} registered as ${profile.username}`,
    );
    return profile;
  } catch (err) {
    console.error("[registerUser] error:", err);
    safeEmit(socket, "register-error", { success: false, error: err.message });
    throw err;
  }
}

function startSearch(socketId, options = {}) {
  try {
    const userWrapper = activeUsers.get(socketId);
    if (!userWrapper) throw new Error("User not registered");
    const socket = userWrapper.socket;

    // If already chatting — disconnect first (safe)
    if (userWrapper.partnerId) {
      disconnectPair(socketId, userWrapper.partnerId, "new_search");
    }

    userWrapper.status = "searching";
    userWrapper.searchStart = Date.now();
    userWrapper.attempts = (userWrapper.attempts || 0) + 1;

    // Clear previous interval
    if (userWrapper.matchingInterval) {
      clearInterval(userWrapper.matchingInterval);
      userWrapper.matchingInterval = null;
    }

    matchingEngine.addUser(socketId, {
      userId: socketId,
      profile: userWrapper.profile,
      chatMode: userWrapper.profile.chatMode,
      timestamp: Date.now(),
    });

    // Try immediate match
    attemptImmediateMatch(socketId);

    console.info(
      `[startSearch] ${socketId} searching for ${userWrapper.profile.chatMode}`,
    );
    return true;
  } catch (err) {
    console.error("[startSearch] error:", err);
    const s = activeUsers.get(socketId)?.socket;
    if (s) safeEmit(s, "search-error", { message: err.message });
    return false;
  }
}

function sendMessage(socketId, data = {}) {
  try {
    const sender = activeUsers.get(socketId);
    if (!sender) throw new Error("Sender not registered");
    if (!sender.partnerId) throw new Error("No partner to send message");

    const partner = activeUsers.get(sender.partnerId);
    if (!partner) throw new Error("Partner not found");

    if (!data || typeof data.text !== "string")
      throw new Error("Invalid message");

    const text = data.text.trim().substring(0, 1000);
    if (!text) throw new Error("Empty message");

    const message = {
      text,
      from: socketId,
      timestamp: Date.now(),
      senderName: sender.profile.username,
      messageId: uuidv4(),
    };

    // Save history
    if (!messageHistory.has(socketId)) messageHistory.set(socketId, []);
    messageHistory.get(socketId).push(message);

    // Emit
    safeEmit(partner.socket, "message", message);
    safeEmit(sender.socket, "message-sent", {
      messageId: message.messageId,
      timestamp: message.timestamp,
    });

    console.info(
      `[sendMessage] ${socketId} -> ${sender.partnerId}: ${text.substring(0, 40)}`,
    );
    return message;
  } catch (err) {
    console.error("[sendMessage] error:", err);
    const s = activeUsers.get(socketId)?.socket;
    if (s) safeEmit(s, "message-error", { error: err.message });
    return null;
  }
}

function typingStart(socketId) {
  try {
    const user = activeUsers.get(socketId);
    if (!user || !user.partnerId) return false;
    const partner = activeUsers.get(user.partnerId);
    if (!partner) return false;

    // reset timeout
    if (typingUsers.has(socketId))
      clearTimeout(typingUsers.get(socketId).timeout);

    const timeout = setTimeout(() => {
      typingUsers.delete(socketId);
      safeEmit(partner.socket, "partnerTypingStopped", {
        userId: socketId,
        timestamp: Date.now(),
      });
    }, 3000);

    typingUsers.set(socketId, {
      lastTyped: Date.now(),
      timeout,
      isTyping: true,
    });

    safeEmit(partner.socket, "partnerTyping", {
      userId: socketId,
      username: user.profile.username,
      timestamp: Date.now(),
      action: "typing_started",
    });
    return true;
  } catch (err) {
    console.error("[typingStart] error:", err);
    return false;
  }
}

function typingStop(socketId) {
  try {
    const user = activeUsers.get(socketId);
    if (!user || !user.partnerId) return false;
    const partner = activeUsers.get(user.partnerId);
    if (!partner) return false;

    if (typingUsers.has(socketId)) {
      clearTimeout(typingUsers.get(socketId).timeout);
      typingUsers.delete(socketId);
    }

    safeEmit(partner.socket, "partnerTypingStopped", {
      userId: socketId,
      timestamp: Date.now(),
      action: "typing_stopped",
    });
    return true;
  } catch (err) {
    console.error("[typingStop] error:", err);
    return false;
  }
}

function attemptImmediateMatch(userId) {
  try {
    const user = activeUsers.get(userId);
    if (!user || user.status !== "searching") return false;

    let match = null;
    if (user.profile.chatMode === "video") {
      match = matchingEngine.findVideoMatch(userId) || null;
    }
    if (!match) match = matchingEngine.findMatch(userId) || null;

    if (match && match.partnerId) {
      instantMatch(
        userId,
        match.partnerId,
        match.score || 50,
        match.mode || user.profile.chatMode,
      );
      return true;
    }

    // else start interval
    startMatchingInterval(userId);
    safeEmit(user.socket, "searching", {
      usersOnline: activeUsers.size,
      estimatedWait: user.profile.chatMode === "video" ? 8 : 5,
      message: `Searching for ${user.profile.chatMode} partner...`,
    });
    return false;
  } catch (err) {
    console.error("[attemptImmediateMatch] error:", err);
    return false;
  }
}

function instantMatch(
  userId1,
  userId2,
  compatibility = 50,
  matchMode = "text",
) {
  try {
    const user1 = activeUsers.get(userId1);
    const user2 = activeUsers.get(userId2);
    if (!user1 || !user2) return false;
    if (user1.status !== "searching" || user2.status !== "searching")
      return false;

    const roomId = `room_${Date.now()}_${uuidv4().slice(0, 8)}`;

    userPairs.set(userId1, userId2);
    userPairs.set(userId2, userId1);

    user1.status = "chatting";
    user1.partnerId = userId2;
    user1.roomId = roomId;

    user2.status = "chatting";
    user2.partnerId = userId1;
    user2.roomId = roomId;

    activeRooms.set(roomId, {
      users: [userId1, userId2],
      callId: null,
      createdAt: Date.now(),
    });

    [user1, user2].forEach((u) => {
      if (u.matchingInterval) {
        clearInterval(u.matchingInterval);
        u.matchingInterval = null;
      }
      matchingEngine.removeUser(u.socket.id);
    });

    const sharedInterests = getSharedInterests(
      user1.profile.interests,
      user2.profile.interests,
    );

    const matchInfo1 = {
      partnerId: userId2,
      profile: user2.profile,
      compatibility: calculateCompatibility(user1.profile, user2.profile),
      sharedInterests,
      matchTime: Date.now(),
      matchMode,
      roomId,
    };

    const matchInfo2 = {
      partnerId: userId1,
      profile: user1.profile,
      compatibility: calculateCompatibility(user2.profile, user1.profile),
      sharedInterests,
      matchTime: Date.now(),
      matchMode,
      roomId,
    };

    safeEmit(user1.socket, "matched", matchInfo1);
    safeEmit(user2.socket, "matched", matchInfo2);

    // Auto-video call if both want video
    if (
      matchMode === "video" &&
      user1.profile.chatMode === "video" &&
      user2.profile.chatMode === "video"
    ) {
      setTimeout(() => {
        try {
          const callId = uuidv4();
          const videoCall = {
            callId,
            caller: userId1,
            callee: userId2,
            status: "auto-started",
            timestamp: Date.now(),
            roomId,
          };
          videoCalls.set(userId1, videoCall);
          videoCalls.set(userId2, { ...videoCall });
          activeRooms.get(roomId).callId = callId;
          videoCallMessages.set(callId, []);
          safeEmit(user1.socket, "video-call-auto-start", {
            callId,
            partnerId: userId2,
            timestamp: Date.now(),
          });
          safeEmit(user2.socket, "video-call-auto-start", {
            callId,
            partnerId: userId1,
            timestamp: Date.now(),
          });
        } catch (e) {
          console.error("[instantMatch:video-start] error:", e);
        }
      }, 1000);
    }

    console.info(
      `[instantMatch] ${userId1} ↔ ${userId2} (${matchMode}, room=${roomId})`,
    );
    return true;
  } catch (err) {
    console.error("[instantMatch] error:", err);
    return false;
  }
}

function startMatchingInterval(userId) {
  try {
    const user = activeUsers.get(userId);
    if (!user || user.status !== "searching") return;
    if (user.matchingInterval) clearInterval(user.matchingInterval);

    let attemptCount = 0;
    const maxAttempts = 15;

    user.matchingInterval = setInterval(() => {
      try {
        if (!activeUsers.has(userId) || user.status !== "searching") {
          clearInterval(user.matchingInterval);
          user.matchingInterval = null;
          return;
        }

        attemptCount++;
        if (attemptCount > maxAttempts) {
          clearInterval(user.matchingInterval);
          user.matchingInterval = null;
          safeEmit(user.socket, "search-timeout", {
            message: "No match found. Try again later.",
            attempts: user.attempts,
          });
          return;
        }

        let match = null;
        if (user.profile.chatMode === "video")
          match = matchingEngine.findVideoMatch(userId) || null;
        if (!match) match = matchingEngine.findMatch(userId) || null;

        if (match) {
          clearInterval(user.matchingInterval);
          user.matchingInterval = null;
          instantMatch(
            userId,
            match.partnerId,
            match.score || 50,
            match.mode || user.profile.chatMode,
          );
        } else {
          const elapsed = Math.floor((Date.now() - user.searchStart) / 1000);
          safeEmit(user.socket, "searching-update", {
            elapsed,
            estimatedWait: Math.max(1, 30 - elapsed),
            usersOnline: activeUsers.size,
            message: `Searching... ${elapsed}s elapsed`,
          });
        }
      } catch (innerErr) {
        console.error("[startMatchingInterval:inner] error:", innerErr);
      }
    }, 2000);
  } catch (err) {
    console.error("[startMatchingInterval] error:", err);
  }
}

function disconnectPair(userId1, userId2, reason = "manual") {
  try {
    const user1 = activeUsers.get(userId1);
    const user2 = activeUsers.get(userId2);

    // clear typing
    [userId1, userId2].forEach((uid) => {
      if (typingUsers.has(uid)) {
        clearTimeout(typingUsers.get(uid).timeout);
        typingUsers.delete(uid);
      }
    });

    // clear video calls & waiting requests
    videoCalls.delete(userId1);
    videoCalls.delete(userId2);
    for (const [callId, r] of waitingVideoRequests.entries()) {
      if (
        r.caller === userId1 ||
        r.callee === userId1 ||
        r.caller === userId2 ||
        r.callee === userId2
      ) {
        waitingVideoRequests.delete(callId);
      }
    }

    const roomId = user1?.roomId || user2?.roomId;
    if (roomId && activeRooms.has(roomId)) {
      const room = activeRooms.get(roomId);
      if (room.callId) videoCallMessages.delete(room.callId);
      activeRooms.delete(roomId);
    }

    userPairs.delete(userId1);
    userPairs.delete(userId2);

    if (user1) {
      user1.partnerId = null;
      user1.roomId = null;
      if (user1.matchingInterval) {
        clearInterval(user1.matchingInterval);
        user1.matchingInterval = null;
      }
      // optionally set to ready or searching depending on policy
      user1.status = "ready";
    }
    if (user2) {
      user2.partnerId = null;
      user2.roomId = null;
      if (user2.matchingInterval) {
        clearInterval(user2.matchingInterval);
        user2.matchingInterval = null;
      }
      user2.status = "ready";
    }

    matchingEngine.removeUser(userId1);
    matchingEngine.removeUser(userId2);

    console.info(`[disconnectPair] ${userId1} -/-> ${userId2} (${reason})`);
    return true;
  } catch (err) {
    console.error("[disconnectPair] error:", err);
    return false;
  }
}

function cleanupUser(userId) {
  try {
    const user = activeUsers.get(userId);
    if (!user) {
      // still remove other artifacts
      messageHistory.delete(userId);
      userSessions.delete(userId);
      typingUsers.delete(userId);
      videoCalls.delete(userId);
      userPairs.delete(userId);
      return;
    }

    if (user.matchingInterval) {
      clearInterval(user.matchingInterval);
      user.matchingInterval = null;
    }

    activeUsers.delete(userId);
    messageHistory.delete(userId);
    videoCalls.delete(userId);
    userPairs.delete(userId);
    userSessions.delete(userId);

    if (typingUsers.has(userId)) {
      clearTimeout(typingUsers.get(userId).timeout);
      typingUsers.delete(userId);
    }

    matchingEngine.removeUser(userId);

    console.info(`[cleanupUser] ${userId} cleaned`);
    return true;
  } catch (err) {
    console.error("[cleanupUser] error:", err);
    return false;
  }
}

function updateStats() {
  try {
    const onlineCount = Array.from(activeUsers.values()).filter(
      (u) => u.status === "ready" || u.status === "searching",
    ).length;
    io.emit("stats-updated", {
      online: onlineCount,
      timestamp: Date.now(),
      activeChats: Array.from(userPairs.keys()).length / 2,
      videoCalls:
        Array.from(videoCalls.values()).filter(
          (call) => call.status === "accepted",
        ).length / 2,
      typingUsers: Array.from(typingUsers.keys()).length,
    });
  } catch (err) {
    console.error("[updateStats] error:", err);
  }
}

// --- Periodic cleanup for inactive sessions ---
setInterval(() => {
  try {
    const now = Date.now();
    for (const [userId, session] of userSessions.entries()) {
      if (now - session.lastActivity > INACTIVE_THRESHOLD_MS) {
        console.info(`[cleanup interval] Removing inactive user ${userId}`);
        const user = activeUsers.get(userId);
        if (user && user.partnerId) {
          disconnectPair(userId, user.partnerId, "inactive");
        }
        cleanupUser(userId);
      }
    }
  } catch (err) {
    console.error("[cleanup interval] error:", err);
  }
}, CLEANUP_INTERVAL_MS);

// --- Socket.IO event wiring (keeps handler minimal & testable) ---
io.on("connection", (socket) => {
  try {
    console.info(`[io] Connected: ${socket.id}`);
    userSessions.set(socket.id, {
      connectedAt: Date.now(),
      lastActivity: Date.now(),
    });

    socket.conn.on &&
      socket.conn.on("heartbeat", () => {
        const s = userSessions.get(socket.id);
        if (s) s.lastActivity = Date.now();
        safeEmit(socket, "heartbeat");
      });

    socket.on("register", (userData) => {
      try {
        registerUser(socket, userData);
      } catch (e) {
        /* already handled in registerUser */
      }
    });

    socket.on("search", (options) => {
      startSearch(socket.id, options);
    });

    socket.on("message", (data) => {
      sendMessage(socket.id, data);
    });

    socket.on("typing", () => typingStart(socket.id));
    socket.on("typingStopped", () => typingStop(socket.id));
    socket.on("message-sent", () => {
      if (typingUsers.has(socket.id)) {
        clearTimeout(typingUsers.get(socket.id).timeout);
        typingUsers.delete(socket.id);
      }
    });

    socket.on("next", (data) => {
      try {
        const user = activeUsers.get(socket.id);
        if (!user) {
          safeEmit(socket, "next-error", { message: "User not found" });
          return;
        }
        // notify and disconnect partner if any
        if (user.partnerId) {
          const partner = activeUsers.get(user.partnerId);
          if (partner && partner.socket && partner.socket.connected) {
            safeEmit(partner.socket, "partnerDisconnected", {
              reason: "next_requested",
              message: "Partner switched to next user",
              timestamp: Date.now(),
            });
          }
          disconnectPair(socket.id, user.partnerId, "next_requested");
        }

        // re-add to matching after a small delay
        setTimeout(() => {
          if (
            !activeUsers.has(socket.id) ||
            !activeUsers.get(socket.id).socket.connected
          )
            return;
          const u = activeUsers.get(socket.id);
          u.status = "searching";
          u.searchStart = Date.now();
          u.attempts = (u.attempts || 0) + 1;
          u.partnerId = null;
          if (u.matchingInterval) {
            clearInterval(u.matchingInterval);
            u.matchingInterval = null;
          }
          matchingEngine.addUser(socket.id, {
            userId: socket.id,
            profile: u.profile,
            chatMode: u.profile.chatMode,
            timestamp: Date.now(),
          });
          safeEmit(u.socket, "searching", {
            usersOnline: activeUsers.size,
            estimatedWait: u.profile.chatMode === "video" ? 8 : 5,
            message: `Searching for new ${u.profile.chatMode} partner...`,
            autoConnect: data?.autoConnect || false,
          });
          attemptImmediateMatch(socket.id);
        }, 500);
      } catch (err) {
        console.error("[next handler] error:", err);
        safeEmit(socket, "next-error", { message: err.message });
      }
    });

    socket.on("disconnect-partner", (data) => {
      try {
        const user = activeUsers.get(socket.id);
        if (user && user.partnerId) {
          const partnerId = user.partnerId;
          const partner = activeUsers.get(partnerId);
          if (partner && partner.socket && partner.socket.connected)
            safeEmit(partner.socket, "partnerDisconnected", {
              reason: "manual_disconnect",
              timestamp: Date.now(),
            });
          disconnectPair(socket.id, partnerId, data?.reason || "user_request");
        }
      } catch (err) {
        console.error("[disconnect-partner handler] error:", err);
      }
    });

    socket.on("cancel-search", () => {
      try {
        const u = activeUsers.get(socket.id);
        if (!u) return;
        if (u.status === "searching") {
          u.status = "ready";
          u.searchStart = null;
          if (u.matchingInterval) {
            clearInterval(u.matchingInterval);
            u.matchingInterval = null;
          }
          matchingEngine.removeUser(socket.id);
          safeEmit(socket, "search-cancelled", {
            message: "Search cancelled successfully",
            timestamp: Date.now(),
          });
        }
      } catch (err) {
        console.error("[cancel-search] error:", err);
      }
    });

    socket.on("set-auto-connect", (data = {}) => {
      const u = activeUsers.get(socket.id);
      if (u) {
        u.autoConnect = !!data.enabled;
        safeEmit(socket, "auto-connect-set", { enabled: u.autoConnect });
      }
    });

    socket.on("get-partner-info", () => {
      try {
        const u = activeUsers.get(socket.id);
        if (!u || !u.partnerId) {
          safeEmit(socket, "partner-info", { error: "No partner found" });
          return;
        }
        const partner = activeUsers.get(u.partnerId);
        if (!partner) {
          safeEmit(socket, "partner-info", { error: "Partner not found" });
          return;
        }
        safeEmit(socket, "partner-info", {
          partnerId: u.partnerId,
          profile: partner.profile,
          isTyping: typingUsers.has(u.partnerId),
          lastSeen: userSessions.get(u.partnerId)?.lastActivity || Date.now(),
          compatibility: calculateCompatibility(u.profile, partner.profile),
          roomId: u.roomId,
          videoCall: videoCalls.get(socket.id) || null,
        });
      } catch (err) {
        console.error("[get-partner-info] error:", err);
      }
    });

    socket.on("video-call-request", (data = {}) => {
      try {
        const u = activeUsers.get(socket.id);
        if (!u || !u.partnerId) {
          safeEmit(socket, "video-call-error", { error: "No partner found" });
          return;
        }
        const partner = activeUsers.get(u.partnerId);
        const callId = data.callId || uuidv4();
        const videoCall = {
          callId,
          caller: socket.id,
          callee: u.partnerId,
          status: "requested",
          timestamp: Date.now(),
          roomId: u.roomId,
        };
        waitingVideoRequests.set(callId, videoCall);
        if (partner && partner.socket && partner.socket.connected)
          safeEmit(partner.socket, "video-call-request", {
            callId,
            from: socket.id,
            callerName: u.profile.username,
            timestamp: Date.now(),
          });
        setTimeout(() => {
          if (waitingVideoRequests.has(callId)) {
            waitingVideoRequests.delete(callId);
            console.info(`[video-call-request] timed out ${callId}`);
          }
        }, 30000);
      } catch (err) {
        console.error("[video-call-request] error:", err);
      }
    });

    // Add these WebRTC signaling handlers in your socket.io connection section
    // Place this after the existing socket.on handlers

    // ======================
    // WEBRTC SIGNALING APIS
    // ======================

    socket.on("webrtc-offer", (data) => {
      try {
        const { to, sdp, metadata } = data;
        const from = socket.id;

        console.log(`[webrtc-offer] ${from} -> ${to}`);

        const user = activeUsers.get(from);
        const partner = activeUsers.get(to);

        if (!user || !partner) {
          safeEmit(socket, "webrtc-error", {
            error: "User or partner not found",
          });
          return;
        }

        // Verify they are actually paired
        if (user.partnerId !== to || partner.partnerId !== from) {
          safeEmit(socket, "webrtc-error", { error: "Users are not paired" });
          return;
        }

        // Create or update video call record
        const callId = data.callId || uuidv4();
        const videoCall = {
          callId,
          caller: from,
          callee: to,
          status: "offered",
          timestamp: Date.now(),
          sdp: sdp,
          roomId: user.roomId,
          metadata: metadata || {},
        };

        videoCalls.set(from, videoCall);
        videoCalls.set(to, { ...videoCall, status: "incoming" });

        // Update room with call info
        if (user.roomId && activeRooms.has(user.roomId)) {
          activeRooms.get(user.roomId).callId = callId;
        }

        // Forward offer to partner
        safeEmit(partner.socket, "webrtc-offer", {
          from,
          sdp,
          callId,
          metadata,
          timestamp: Date.now(),
        });
      } catch (err) {
        console.error("[webrtc-offer] error:", err);
        safeEmit(socket, "webrtc-error", { error: err.message });
      }
    });

    socket.on("webrtc-answer", (data) => {
      try {
        const { to, sdp } = data;
        const from = socket.id;

        console.log(`[webrtc-answer] ${from} -> ${to} (call accepted)`);

        const user = activeUsers.get(from);
        const partner = activeUsers.get(to);

        if (!user || !partner) {
          safeEmit(socket, "webrtc-error", {
            error: "User or partner not found",
          });
          return;
        }

        // Update video call status
        const call = videoCalls.get(from) || videoCalls.get(to);
        if (call) {
          call.status = "accepted";
          call.answerSdp = sdp;
          call.answerTimestamp = Date.now();

          // Update both entries
          videoCalls.set(from, call);
          videoCalls.set(to, call);
        }

        // Forward answer to caller
        safeEmit(partner.socket, "webrtc-answer", {
          from,
          sdp,
          callId: call?.callId,
          timestamp: Date.now(),
        });
      } catch (err) {
        console.error("[webrtc-answer] error:", err);
        safeEmit(socket, "webrtc-error", { error: err.message });
      }
    });

    socket.on("webrtc-ice-candidate", (data) => {
      try {
        const { to, candidate } = data;
        const from = socket.id;

        const partner = activeUsers.get(to);
        if (!partner) return;

        // Forward ICE candidate to partner
        safeEmit(partner.socket, "webrtc-ice-candidate", {
          from,
          candidate,
          timestamp: Date.now(),
        });
      } catch (err) {
        console.error("[webrtc-ice-candidate] error:", err);
      }
    });

    socket.on("webrtc-reject", (data) => {
      try {
        const { to, reason } = data;
        const from = socket.id;

        console.log(`[webrtc-reject] ${from} -> ${to}: ${reason}`);

        const partner = activeUsers.get(to);
        if (!partner) return;

        // Update video call status
        const call = videoCalls.get(from) || videoCalls.get(to);
        if (call) {
          call.status = "rejected";
          call.reason = reason;
          call.endTimestamp = Date.now();
        }

        // Forward rejection to partner
        safeEmit(partner.socket, "webrtc-reject", {
          from,
          reason,
          timestamp: Date.now(),
        });
      } catch (err) {
        console.error("[webrtc-reject] error:", err);
      }
    });

    socket.on("webrtc-end", (data) => {
      try {
        const { to, reason } = data;
        const from = socket.id;

        console.log(`[webrtc-end] ${from} -> ${to}: ${reason}`);

        const partner = activeUsers.get(to);
        if (partner) {
          safeEmit(partner.socket, "webrtc-end", {
            from,
            reason,
            timestamp: Date.now(),
          });
        }

        // Clean up video call records
        videoCalls.delete(from);
        videoCalls.delete(to);

        // Clear callId from room
        const user = activeUsers.get(from);
        if (user?.roomId && activeRooms.has(user.roomId)) {
          activeRooms.get(user.roomId).callId = null;
        }
      } catch (err) {
        console.error("[webrtc-end] error:", err);
      }
    });

    // New: Video call status update
    socket.on("video-call-status", (data) => {
      try {
        const { callId, status, to } = data;
        const from = socket.id;

        const partner = activeUsers.get(to);
        if (partner) {
          safeEmit(partner.socket, "video-call-status", {
            from,
            callId,
            status,
            timestamp: Date.now(),
          });
        }
      } catch (err) {
        console.error("[video-call-status] error:", err);
      }
    });

    // New: Toggle audio/video during call
    socket.on("call-toggle-media", (data) => {
      try {
        const { to, mediaType, enabled } = data;
        const from = socket.id;

        const partner = activeUsers.get(to);
        if (partner) {
          safeEmit(partner.socket, "call-toggle-media", {
            from,
            mediaType,
            enabled,
            timestamp: Date.now(),
          });
        }
      } catch (err) {
        console.error("[call-toggle-media] error:", err);
      }
    });

    // New: Screen sharing status
    socket.on("screen-share-status", (data) => {
      try {
        const { to, isSharing } = data;
        const from = socket.id;

        const partner = activeUsers.get(to);
        if (partner) {
          safeEmit(partner.socket, "screen-share-status", {
            from,
            isSharing,
            timestamp: Date.now(),
          });
        }
      } catch (err) {
        console.error("[screen-share-status] error:", err);
      }
    });

    // New: Get call statistics
    socket.on("get-call-stats", () => {
      try {
        const user = activeUsers.get(socket.id);
        if (!user || !user.partnerId) return;

        const partner = activeUsers.get(user.partnerId);
        if (!partner) return;

        const call = videoCalls.get(socket.id);
        const partnerCall = videoCalls.get(user.partnerId);

        safeEmit(socket, "call-stats", {
          callInfo: call,
          partnerCallInfo: partnerCall,
          connectionQuality: 95, // Mock value - you can implement real metrics
          timestamp: Date.now(),
        });
      } catch (err) {
        console.error("[get-call-stats] error:", err);
      }
    });

    // New: Reconnect to call
    socket.on("call-reconnect", (data) => {
      try {
        const { to, callId } = data;
        const from = socket.id;

        const partner = activeUsers.get(to);
        if (!partner) return;

        const call = videoCalls.get(from) || videoCalls.get(to);
        if (!call || call.callId !== callId) return;

        call.status = "reconnecting";
        call.lastReconnect = Date.now();

        safeEmit(partner.socket, "call-reconnect", {
          from,
          callId,
          timestamp: Date.now(),
        });
      } catch (err) {
        console.error("[call-reconnect] error:", err);
      }
    });

    // ======================
    // HTTP ENDPOINTS FOR VIDEO
    // ======================

    socket.on("get-stats", () => {
      try {
        const onlineCount = Array.from(activeUsers.values()).filter(
          (u) => u.status === "ready" || u.status === "searching",
        ).length;
        const stats = matchingEngine.getStats();
        safeEmit(socket, "stats", {
          online: onlineCount,
          searching: Array.from(activeUsers.values()).filter(
            (u) => u.status === "searching",
          ).length,
          inChat: Array.from(userPairs.keys()).length / 2,
          videoCalls:
            Array.from(videoCalls.values()).filter(
              (c) => c.status === "accepted",
            ).length / 2,
          matchingStats: stats,
          typingUsers: Array.from(typingUsers.keys()).length,
        });
      } catch (err) {
        console.error("[get-stats] error:", err);
      }
    });

    socket.on("heartbeat", () => {
      const s = userSessions.get(socket.id);
      if (s) s.lastActivity = Date.now();
      safeEmit(socket, "heartbeat-response", { timestamp: Date.now() });
    });

    socket.on("disconnect", (reason) => {
      console.info(`[io] disconnect ${socket.id}: ${reason}`);
      try {
        const u = activeUsers.get(socket.id);
        if (u && u.partnerId) {
          const p = activeUsers.get(u.partnerId);
          if (p && p.socket && p.socket.connected)
            safeEmit(p.socket, "partnerDisconnected", {
              reason: "disconnected",
              timestamp: Date.now(),
              autoConnect: p.autoConnect || false,
            });
          disconnectPair(socket.id, u.partnerId, "disconnected");
        }
        cleanupUser(socket.id);
        updateStats();
      } catch (err) {
        console.error("[disconnect] handler error:", err);
      }
    });

    socket.on("error", (error) => {
      console.error(`[io] socket error ${socket.id}:`, error);
    });
  } catch (err) {
    console.error("[io.connection] error:", err);
  }
});

// --- HTTP endpoints ---
app.get("/health", (req, res) => {
  try {
    res.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      users: activeUsers.size,
      pairs: Array.from(userPairs.keys()).length / 2,
      videoCalls:
        Array.from(videoCalls.values()).filter((c) => c.status === "accepted")
          .length / 2,
      rooms: activeRooms.size,
      waitingRequests: waitingVideoRequests.size,
      typingUsers: Array.from(typingUsers.keys()).length,
    });
  } catch (err) {
    console.error("[health] error:", err);
    res.status(500).json({ status: "error" });
  }
});

// Get video call info
app.get("/video/call/:callId", (req, res) => {
  try {
    const { callId } = req.params;

    // Find call by callId
    let callInfo = null;
    for (const [userId, call] of videoCalls.entries()) {
      if (call.callId === callId) {
        callInfo = call;
        break;
      }
    }

    if (!callInfo) {
      return res.status(404).json({ error: "Call not found" });
    }

    const user1 = activeUsers.get(callInfo.caller);
    const user2 = activeUsers.get(callInfo.callee);

    res.json({
      callId,
      caller: user1?.profile || null,
      callee: user2?.profile || null,
      status: callInfo.status,
      timestamp: callInfo.timestamp,
      duration: callInfo.endTimestamp
        ? (callInfo.endTimestamp - callInfo.timestamp) / 1000
        : (Date.now() - callInfo.timestamp) / 1000,
      roomId: callInfo.roomId,
    });
  } catch (err) {
    console.error("[GET /video/call] error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get active video calls
app.get("/admin/video-calls", (req, res) => {
  try {
    const activeCalls = [];
    const seenCallIds = new Set();

    for (const [userId, call] of videoCalls.entries()) {
      if (seenCallIds.has(call.callId)) continue;

      seenCallIds.add(call.callId);

      const user1 = activeUsers.get(call.caller);
      const user2 = activeUsers.get(call.callee);

      activeCalls.push({
        callId: call.callId,
        status: call.status,
        caller: user1?.profile?.username || "Unknown",
        callee: user2?.profile?.username || "Unknown",
        startTime: new Date(call.timestamp).toISOString(),
        duration: Math.floor((Date.now() - call.timestamp) / 1000),
        roomId: call.roomId,
      });
    }

    res.json({
      totalActive: activeCalls.filter((c) => c.status === "accepted").length,
      totalOffered: activeCalls.filter((c) => c.status === "offered").length,
      calls: activeCalls,
    });
  } catch (err) {
    console.error("[GET /admin/video-calls] error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get ICE servers configuration (for TURN/STUN)
app.get("/webrtc/config", (req, res) => {
  try {
    // You can add your own TURN servers here for production
    const iceServers = [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" },
      { urls: "stun:stun3.l.google.com:19302" },
      { urls: "stun:stun4.l.google.com:19302" },
    ];

    // Add custom TURN servers from environment variables if available
    if (
      process.env.TURN_SERVER_URL &&
      process.env.TURN_USERNAME &&
      process.env.TURN_CREDENTIAL
    ) {
      iceServers.push({
        urls: process.env.TURN_SERVER_URL,
        username: process.env.TURN_USERNAME,
        credential: process.env.TURN_CREDENTIAL,
      });
    }

    res.json({
      iceServers,
      iceTransportPolicy: "all",
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
      iceCandidatePoolSize: 10,
    });
  } catch (err) {
    console.error("[GET /webrtc/config] error:", err);
    res.status(500).json({ error: err.message });
  }
});
app.get("/admin/stats", (req, res) => {
  try {
    const videoUsers = Array.from(activeUsers.values()).filter(
      (u) => u.profile?.chatMode === "video",
    ).length;
    const textUsers = Array.from(activeUsers.values()).filter(
      (u) => u.profile?.chatMode === "text",
    ).length;
    const stats = {
      totalUsers: activeUsers.size,
      videoUsers,
      textUsers,
      activeChats: Array.from(userPairs.keys()).length / 2,
      videoCalls:
        Array.from(videoCalls.values()).filter((c) => c.status === "accepted")
          .length / 2,
      searchingUsers: Array.from(activeUsers.values()).filter(
        (u) => u.status === "searching",
      ).length,
      waitingVideoRequests: waitingVideoRequests.size,
      activeRooms: activeRooms.size,
      userSessions: userSessions.size,
      typingUsers: Array.from(typingUsers.keys()).length,
      matchingEngineStats:
        typeof matchingEngine.getStats === "function"
          ? matchingEngine.getStats()
          : {},
      uptime: process.uptime(),
      serverTime: new Date().toISOString(),
    };
    res.json(stats);
  } catch (err) {
    console.error("[admin/stats] error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/room/:roomId", (req, res) => {
  try {
    const room = activeRooms.get(req.params.roomId);
    if (!room) return res.status(404).json({ error: "Room not found" });
    res.json({
      roomId: req.params.roomId,
      users: room.users,
      callId: room.callId,
      createdAt: room.createdAt,
      user1: activeUsers.get(room.users[0])?.profile || null,
      user2: activeUsers.get(room.users[1])?.profile || null,
    });
  } catch (err) {
    console.error("[room] error:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- Start server ---
server.listen(PORT, () => {
  console.info(`Server running on port ${PORT}`);
  console.info(`Health: http://localhost:${PORT}/health`);
});

// --- Exports for tests ---
module.exports = {
  app,
  server,
  io,
  // state
  activeUsers,
  userPairs,
  messageHistory,
  videoCalls,
  typingUsers,
  waitingVideoRequests,
  userSessions,
  videoCallMessages,
  activeRooms,
  // functions
  registerUser,
  startSearch,
  sendMessage,
  typingStart,
  typingStop,
  attemptImmediateMatch,
  instantMatch,
  startMatchingInterval,
  disconnectPair,
  cleanupUser,
  calculateCompatibility,
  getSharedInterests,
  updateStats,
  safeEmit,
  makeMockSocket,
};
