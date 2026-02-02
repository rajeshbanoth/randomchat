"use strict";

const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const MatchingEngine = require("./matching-engine");
const nodemailer = require("nodemailer");
const {
  generateTicketNumber,
  getEstimatedResponse,
  generateUserEmailHTML,
  generateSupportEmailHTML,
} = require("./functions/email");
// --- Config ---
const SOCKET_ORIGIN = process.env.SOCKET_ORIGIN || "http://localhost:3000";

const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://13.60.191.64",
  "https://winkcc.vercel.app",
  "https://blinkchatapp.vercel.app/",
  "https://omeglechatapp.vercel.app",
];

const PORT = process.env.PORT || 5000;
const INACTIVE_THRESHOLD_MS = 5 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

console.log(`[Server] Starting server with config:`, {
  PORT,
  SOCKET_ORIGIN,
  INACTIVE_THRESHOLD_MS,
  CLEANUP_INTERVAL_MS,
});

// --- App / Server / IO ---
const app = express();
const server = http.createServer(app);

console.log(
  `[Server] Creating Socket.IO server with CORS origin: ${SOCKET_ORIGIN}`,
);
const io = socketIo(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"],
  allowEIO3: true,
});

console.log(`[Server] Setting up CORS middleware`);
app.use(
  cors({
    origin: function (origin, callback) {
      // allow requests with no origin (mobile apps, curl, etc)
      if (!origin) return callback(null, true);

      if (ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  }),
);

app.use(express.json());

// Configure Nodemailer transporter
// const transporter = nodemailer.createTransport({
//   host: process.env.SMTP_HOST || 'smtp.gmail.com',
//   port: process.env.SMTP_PORT || 587,
//   secure: false,
//   auth: {
//     user: process.env.SMTP_USER,
//     pass: process.env.SMTP_PASS
//   },
//   tls: {
//     rejectUnauthorized: false
//   }
// });

// Email Transport - Recommended for Zoho personal/free accounts
// Email Transport
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Verify on startup - add this immediately after creating transporter
transporter.verify((error, success) => {
  if (error) {
    console.error("❌ SMTP Verification Failed:", error);
    console.error("Full error object:", JSON.stringify(error, null, 2));
  } else {
    console.log("✅ SMTP connection verified! Ready to send via Zoho.");
  }
});

// --- Core state ---
console.log(`[Server] Initializing data structures`);
const matchingEngine = new MatchingEngine();
const activeUsers = new Map();
const userPairs = new Map();
const messageHistory = new Map();
const videoCalls = new Map();
const typingUsers = new Map();
const waitingVideoRequests = new Map();
const userSessions = new Map();
const videoCallMessages = new Map();
const activeRooms = new Map();

console.log(`[Server] State initialized:`, {
  activeUsers: activeUsers.size,
  userPairs: userPairs.size,
  matchingEngine: matchingEngine.constructor.name,
});

// --- Helpers ---
function safeEmit(sock, event, payload) {
  try {
    if (!sock || !sock.connected) {
      console.warn(`[safeEmit] Socket not connected for event: ${event}`);
      return false;
    }

    console.log(`[safeEmit] Emitting event: ${event} to socket: ${sock.id}`, {
      payload:
        typeof payload === "object"
          ? { ...payload, socketId: sock.id }
          : payload,
    });

    sock.emit(event, payload);
    return true;
  } catch (err) {
    console.error(`[safeEmit] Error emitting event (event=${event}):`, err);
    return false;
  }
}

// --- Pure helpers (easy to unit-test) ---
function calculateCompatibility(user1 = {}, user2 = {}) {
  console.log(`[calculateCompatibility] Calculating compatibility between:`, {
    user1: user1.username || user1.id,
    user2: user2.username || user2.id,
  });

  try {
    if (!user1 || !user2) {
      console.warn(
        `[calculateCompatibility] Missing user data, returning default 50`,
      );
      return 50;
    }

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

    const finalScore = Math.min(Math.max(Math.round(score), 0), 100);
    console.log(`[calculateCompatibility] Final score: ${finalScore}`, {
      ageDiff,
      sharedInterests,
      scoreComponents: { ageScore: score - 50 - sharedInterests * 5 },
    });

    return finalScore;
  } catch (err) {
    console.error("[calculateCompatibility] Error:", err);
    return 50;
  }
}

function getSharedInterests(interests1 = [], interests2 = []) {
  console.log(`[getSharedInterests] Getting shared interests between:`, {
    interests1Length: interests1.length,
    interests2Length: interests2.length,
  });

  try {
    if (!Array.isArray(interests1) || !Array.isArray(interests2)) {
      console.warn(`[getSharedInterests] Invalid interests arrays`);
      return [];
    }

    const s2 = new Set(
      interests2.map((i) => `${i || ""}`.toLowerCase().trim()),
    );
    const shared = interests1.filter((i) =>
      s2.has(`${i || ""}`.toLowerCase().trim()),
    );

    console.log(
      `[getSharedInterests] Found ${shared.length} shared interests:`,
      shared,
    );
    return shared;
  } catch (err) {
    console.error("[getSharedInterests] Error:", err);
    return [];
  }
}

// --- Register User ---
function registerUser(socket, userData = {}) {
  console.log(`[registerUser] Registering user for socket: ${socket.id}`, {
    userData: { ...userData, socketId: socket.id },
  });

  try {
    if (!socket) {
      console.error(`[registerUser] Socket required`);
      throw new Error("Socket required");
    }

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

    console.log(`[registerUser] Creating user profile:`, {
      username: profile.username,
      chatMode: profile.chatMode,
      isPremium: profile.isPremium,
    });

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
      `[registerUser] Successfully registered: ${socket.id} as ${profile.username}`,
      {
        totalUsers: activeUsers.size,
        chatMode: profile.chatMode,
      },
    );
    return profile;
  } catch (err) {
    console.error("[registerUser] Error:", err);
    safeEmit(socket, "register-error", { success: false, error: err.message });
    throw err;
  }
}

// --- Start Search (Updated for Video) ---
function startSearch(socketId, options = {}) {
  console.log(`[startSearch] Starting search for socket: ${socketId}`, {
    options,
    timestamp: Date.now(),
  });

  try {
    const userWrapper = activeUsers.get(socketId);
    if (!userWrapper) {
      console.error(`[startSearch] User not found: ${socketId}`);
      throw new Error("User not registered");
    }

    console.log(`[startSearch] User data ${options}`);

    const socket = userWrapper.socket;
    const chatMode = options.mode || "text";
    // 🔑 SAVE chat mode on user profile (VERY IMPORTANT)
userWrapper.profile.chatMode = chatMode;


    console.log(`[startSearch] User details:`, {
      username: userWrapper.profile.username,
      currentStatus: userWrapper.status,
      currentPartner: userWrapper.partnerId,
      chatMode,
    });

    // If already chatting — disconnect first
    if (userWrapper.partnerId) {
      console.log(
        `[startSearch] User has existing partner, disconnecting first: ${userWrapper.partnerId}`,
      );
      disconnectPair(socketId, userWrapper.partnerId, "new_search");
    }

    userWrapper.status = "searching";
    userWrapper.searchStart = Date.now();
    userWrapper.attempts = (userWrapper.attempts || 0) + 1;

    // Clear previous interval
    if (userWrapper.matchingInterval) {
      console.log(
        `[startSearch] Clearing previous matching interval for: ${socketId}`,
      );
      clearInterval(userWrapper.matchingInterval);
      userWrapper.matchingInterval = null;
    }

    // Add to matching engine with chat mode
    console.log(`[startSearch] Adding user to matching engine:`, {
      userId: socketId,
      chatMode,
      profile: userWrapper.profile.username,
    });

    matchingEngine.addUser(socketId, {
      userId: socketId,
      profile: userWrapper.profile,
      chatMode: chatMode,
      timestamp: Date.now(),
    });

    // Try immediate match
    console.log(`[startSearch] Attempting immediate match for: ${socketId}`);
    const matched = attemptImmediateMatch(socketId);

    console.info(`[startSearch] Search started for ${socketId} (${chatMode})`, {
      matchedImmediately: matched,
      totalSearching: Array.from(activeUsers.values()).filter(
        (u) => u.status === "searching",
      ).length,
    });

    return true;
  } catch (err) {
    console.error("[startSearch] Error:", err, {
      socketId,
      stack: err.stack,
    });

    const s = activeUsers.get(socketId)?.socket;
    if (s) safeEmit(s, "search-error", { message: err.message });
    return false;
  }
}

// --- Attempt Immediate Match (Updated) ---
function attemptImmediateMatch(userId) {
  console.log(`[attemptImmediateMatch] Attempting immediate match for: ${userId}`);

  try {
    const user = activeUsers.get(userId);
    if (!user || user.status !== "searching") {
      console.warn(`[attemptImmediateMatch] User not found or not searching: ${userId}`);
      return false;
    }

    console.log(user,"checking userer")

    const userChatMode = user.profile.chatMode; // "video" | "text"
    console.log(`[attemptImmediateMatch] User chat mode: ${userChatMode}`);

    let match = null;

    // 🔒 STRICT MODE MATCHING
    if (userChatMode === "video") {
      console.log(`[attemptImmediateMatch] Searching VIDEO-only partner`);
      match = matchingEngine.findVideoMatch(userId);
    } else {
      console.log(`[attemptImmediateMatch] Searching TEXT-only partner`);
      match = matchingEngine.findMatch(userId);
    }


    if (match && match.partnerId) {
  const partner = activeUsers.get(match.partnerId);

  // 🚫 HARD BLOCK mixed mode
  if (!partner || partner.profile.chatMode !== userChatMode) {
    console.warn(
      "[STRICT MODE BLOCK]",
      userChatMode,
      "≠",
      partner?.profile?.chatMode
    );
    return false;
  }

  console.log("[STRICT MODE PASS] Matching users:", {
    user: userId,
    partner: match.partnerId,
    mode: userChatMode,
  });

  instantMatch(
    userId,
    match.partnerId,
    match.score || 50,
    userChatMode
  );

  return true;
}


    // if (match && match.partnerId) {
    //   console.log(`[attemptImmediateMatch] Match found`, match);

    //   instantMatch(
    //     userId,
    //     match.partnerId,
    //     match.score || 50,
    //     userChatMode
    //   );

    //   return true;
    // }

    // ⏳ No match → continue searching
    console.log(`[attemptImmediateMatch] No match found, starting interval`);
    startMatchingInterval(userId);

    safeEmit(user.socket, "searching", {
      usersOnline: activeUsers.size,
      estimatedWait: userChatMode === "video" ? 8 : 5,
      message: `Searching for ${userChatMode} partner...`,
    });

    return false;
  } catch (err) {
    console.error("[attemptImmediateMatch] Error:", err);
    return false;
  }
}


// Start matching interval for a user
function startMatchingInterval(userId) {
  console.log(
    `[startMatchingInterval] Starting matching interval for: ${userId}`,
  );

  try {
    const user = activeUsers.get(userId);
    if (!user || user.status !== "searching") {
      console.warn(
        `[startMatchingInterval] User not in searching state: ${userId}`,
      );
      return;
    }

    if (user.matchingInterval) {
      console.log(
        `[startMatchingInterval] Clearing existing interval for: ${userId}`,
      );
      clearInterval(user.matchingInterval);
    }

    user.matchingInterval = setInterval(() => {
      console.log(`[startMatchingInterval] Interval check for: ${userId}`);
      attemptImmediateMatch(userId);
    }, 5000); // Try to match every 5 seconds

    console.log(`[startMatchingInterval] Interval started for: ${userId}`);
  } catch (err) {
    console.error("[startMatchingInterval] Error:", err);
  }
}

// --- Instant Match (Updated for Video) ---
function instantMatch(
  userId1,
  userId2,
  compatibility = 50,
  matchMode = "text",
) {
  console.log(`[instantMatch] Creating match between:`, {
    userId1,
    userId2,
    compatibility,
    matchMode,
  });

  try {
    const user1 = activeUsers.get(userId1);
    const user2 = activeUsers.get(userId2);

    if (!user1 || !user2) {
      console.error(`[instantMatch] One or both users not found:`, {
        user1Exists: !!user1,
        user2Exists: !!user2,
      });
      return false;
    }

    if (user1.status !== "searching" || user2.status !== "searching") {
      console.warn(`[instantMatch] Users not in searching state:`, {
        user1Status: user1.status,
        user2Status: user2.status,
      });
      return false;
    }

    const roomId = `room_${Date.now()}_${uuidv4().slice(0, 8)}`;
    console.log(`[instantMatch] Creating room: ${roomId}`);

    // Set up pairing
    userPairs.set(userId1, userId2);
    userPairs.set(userId2, userId1);

    user1.status = "chatting";
    user1.partnerId = userId2;
    user1.roomId = roomId;

    user2.status = "chatting";
    user2.partnerId = userId1;
    user2.roomId = roomId;

    // Create room
    activeRooms.set(roomId, {
      users: [userId1, userId2],
      callId: null,
      createdAt: Date.now(),
      mode: matchMode,
    });

    // Clean up matching intervals
    [user1, user2].forEach((u) => {
      if (u.matchingInterval) {
        console.log(
          `[instantMatch] Clearing matching interval for: ${u.socket.id}`,
        );
        clearInterval(u.matchingInterval);
        u.matchingInterval = null;
      }
      console.log(
        `[instantMatch] Removing user from matching engine: ${u.socket.id}`,
      );
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

    // Emit matched event
    console.log(`[instantMatch] Emitting matched events`);
    safeEmit(user1.socket, "matched", matchInfo1);
    safeEmit(user2.socket, "matched", matchInfo2);

    // For video matches, notify both clients to start video call
    if (matchMode === "video") {
      console.log(`[instantMatch] Setting up video call for room: ${roomId}`);

      // Create video call record
      const callId = uuidv4();
      const videoCall = {
        callId,
        caller: userId1,
        callee: userId2,
        status: "pending",
        timestamp: Date.now(),
        roomId,
        sdp: null,
        answerSdp: null,
      };

      videoCalls.set(userId1, videoCall);
      videoCalls.set(userId2, { ...videoCall });
      activeRooms.get(roomId).callId = callId;

      // Dispatch custom event for video match (frontend can listen to this)
      console.log(`[instantMatch] Emitting video-match-ready events`);
      user1.socket.emit("video-match-ready", {
        callId,
        partnerId: userId2,
        partnerProfile: user2.profile,
        roomId,
        timestamp: Date.now(),
      });

      user2.socket.emit("video-match-ready", {
        callId,
        partnerId: userId1,
        partnerProfile: user1.profile,
        roomId,
        timestamp: Date.now(),
      });

      console.info(`[instantMatch] Video call setup complete:`, {
        callId,
        roomId,
        caller: userId1,
        callee: userId2,
      });
    }

    console.info(`[instantMatch] Match created successfully:`, {
      userId1: user1.profile.username,
      userId2: user2.profile.username,
      roomId,
      matchMode,
      compatibility,
      sharedInterestsCount: sharedInterests.length,
    });

    return true;
  } catch (err) {
    console.error("[instantMatch] Error:", err, {
      userId1,
      userId2,
      stack: err.stack,
    });
    return false;
  }
}

// --- WebRTC Signaling Handlers (Fixed) ---

function handleWebRTCOffer(socket, data) {
  const { to, sdp, metadata, callId: providedCallId, roomId } = data; // ADD roomId parameter
  const from = socket.id;

  console.log(`[handleWebRTCOffer] Received offer:`, {
    from,
    to,
    providedCallId,
    roomId, // LOG roomId
    sdpType: sdp?.type,
    metadata,
  });

  try {
    const user = activeUsers.get(from);
    const partner = activeUsers.get(to);

    if (!user || !partner) {
      console.error(`[handleWebRTCOffer] User or partner not found:`, {
        userExists: !!user,
        partnerExists: !!partner,
      });
      safeEmit(socket, "webrtc-error", { error: "User or partner not found" });
      return;
    }

    // Verify they are paired
    if (user.partnerId !== to || partner.partnerId !== from) {
      console.warn(`[handleWebRTCOffer] Users are not paired:`, {
        userPartnerId: user.partnerId,
        expectedPartnerId: to,
        partnerPartnerId: partner.partnerId,
        expectedPartnerIdForPartner: from,
      });
      safeEmit(socket, "webrtc-error", { error: "Users are not paired" });
      return;
    }

    const callId = providedCallId || uuidv4();
    const videoCall = {
      callId,
      caller: from,
      callee: to,
      status: "offered",
      timestamp: Date.now(),
      sdp: sdp,
      roomId: roomId || user.roomId, // USE roomId from data or fallback to user.roomId
      metadata: metadata || {},
    };

    // Store call info
    console.log(`[handleWebRTCOffer] Storing call info for: ${callId}`, {
      roomId: videoCall.roomId,
    });
    videoCalls.set(from, videoCall);
    videoCalls.set(to, { ...videoCall, status: "incoming" });

    // Update room
    if (user.roomId && activeRooms.has(user.roomId)) {
      activeRooms.get(user.roomId).callId = callId;
      console.log(
        `[handleWebRTCOffer] Updated room ${user.roomId} with callId: ${callId}`,
      );
    }

    // Forward to partner WITH ROOMID
    console.log(`[handleWebRTCOffer] Forwarding offer to partner: ${to}`, {
      callId,
      roomId: videoCall.roomId,
    });
    const forwarded = safeEmit(partner.socket, "webrtc-offer", {
      from,
      sdp,
      callId,
      roomId: videoCall.roomId, // CRITICAL: Include roomId here
      metadata,
      timestamp: Date.now(),
    });

    console.log(
      `[handleWebRTCOffer] Offer forwarding result: ${forwarded ? "success" : "failed"}`,
      {
        callId,
        roomId: videoCall.roomId,
        fromSocket: from,
        toSocket: to,
      },
    );
  } catch (err) {
    console.error("[handleWebRTCOffer] Error:", err, {
      from,
      to,
      stack: err.stack,
    });
    safeEmit(socket, "webrtc-error", { error: err.message });
  }
}

function handleWebRTCAnswer(socket, data) {
  const { to, sdp, callId, roomId } = data; // Make sure roomId is included
  const from = socket.id;

  console.log(`[handleWebRTCAnswer] Received answer:`, {
    from,
    to,
    callId,
    roomId,
    sdpType: sdp?.type,
    timestamp: Date.now(),
  });

  try {
    const user = activeUsers.get(from);
    const partner = activeUsers.get(to);

    if (!user || !partner) {
      console.error(`[handleWebRTCAnswer] User or partner not found:`, {
        userExists: !!user,
        partnerExists: !!partner,
        userId: from,
        partnerId: to,
      });
      safeEmit(socket, "webrtc-error", {
        error: "User or partner not found",
        callId,
        roomId,
      });
      return;
    }

    // Verify they are paired
    if (user.partnerId !== to || partner.partnerId !== from) {
      console.warn(`[handleWebRTCAnswer] Users are not properly paired:`, {
        userPartnerId: user.partnerId,
        expectedPartnerId: to,
        partnerPartnerId: partner.partnerId,
        expectedPartnerIdForPartner: from,
        roomId: user.roomId,
      });

      // Check if they share the same room
      if (user.roomId === partner.roomId && user.roomId) {
        console.log(
          `[handleWebRTCAnswer] Users share same room, allowing answer`,
        );
      } else {
        safeEmit(socket, "webrtc-error", {
          error: "Users are not properly paired",
          callId,
          roomId,
        });
        return;
      }
    }

    // Update call status for both users - FIXED LOGIC
    let callUpdated = false;
    for (const [userId, call] of videoCalls.entries()) {
      // Check if the call involves BOTH users (from and to)
      if (
        call.callId === callId &&
        ((call.caller === from && call.callee === to) ||
          (call.caller === to && call.callee === from))
      ) {
        console.log(`[handleWebRTCAnswer] Found matching call:`, {
          callId,
          caller: call.caller,
          callee: call.callee,
          from,
          to,
          currentUserId: userId,
        });

        call.status = "answered";
        call.answerSdp = sdp;
        call.answerTimestamp = Date.now();

        // Ensure roomId is set
        if (!call.roomId && roomId) {
          call.roomId = roomId;
          console.log(`[handleWebRTCAnswer] Set roomId for call: ${roomId}`);
        }

        videoCalls.set(userId, call);
        callUpdated = true;

        // Also update partner's call record
        const partnerId = call.caller === from ? call.callee : call.caller;
        if (videoCalls.has(partnerId)) {
          const partnerCall = videoCalls.get(partnerId);
          partnerCall.status = "answered";
          partnerCall.answerSdp = sdp;
          partnerCall.answerTimestamp = Date.now();

          // Ensure roomId is set for partner too
          if (!partnerCall.roomId && roomId) {
            partnerCall.roomId = roomId;
            console.log(
              `[handleWebRTCAnswer] Set roomId for partner call: ${roomId}`,
            );
          }

          videoCalls.set(partnerId, partnerCall);
          console.log(
            `[handleWebRTCAnswer] Updated partner's call record: ${partnerId}`,
            {
              roomId: partnerCall.roomId,
              status: partnerCall.status,
            },
          );
        } else {
          // Create partner call record if it doesn't exist
          const newPartnerCall = {
            callId,
            caller: call.caller,
            callee: call.callee,
            status: "answered",
            timestamp: Date.now(),
            answerTimestamp: Date.now(),
            sdp: call.sdp,
            answerSdp: sdp,
            roomId: roomId || call.roomId,
            metadata: call.metadata || {},
          };
          videoCalls.set(partnerId, newPartnerCall);
          console.log(
            `[handleWebRTCAnswer] Created missing partner call record: ${partnerId}`,
            newPartnerCall,
          );
        }
        break;
      }
    }

    if (!callUpdated) {
      console.warn(
        `[handleWebRTCAnswer] Call ${callId} not found, creating new record`,
      );

      // Determine caller and callee based on who sent the answer
      // If 'from' is answering, then 'to' must be the caller
      const caller = to; // The one who received the answer is the original caller
      const callee = from; // The one sending the answer is the callee

      // Create new call record
      const newCall = {
        callId,
        caller,
        callee,
        status: "answered",
        timestamp: Date.now(),
        answerTimestamp: Date.now(),
        sdp: null, // No offer SDP in this case (we don't have it)
        answerSdp: sdp,
        roomId: roomId || user.roomId || partner.roomId,
        metadata: {},
      };

      videoCalls.set(from, newCall);
      videoCalls.set(to, { ...newCall });
      console.log(`[handleWebRTCAnswer] Created new call record:`, newCall);

      // Update room with call info
      if (user.roomId && activeRooms.has(user.roomId)) {
        const room = activeRooms.get(user.roomId);
        if (!room.callId) {
          room.callId = callId;
          console.log(
            `[handleWebRTCAnswer] Updated room ${user.roomId} with callId: ${callId}`,
          );
        }
      }
    }

    // Forward answer to caller WITH ROOMID
    console.log(`[handleWebRTCAnswer] Forwarding answer to: ${to}`, {
      callId,
      roomId: roomId || user.roomId || partner.roomId,
      fromSocket: from,
      toSocket: to,
    });

    const forwarded = safeEmit(partner.socket, "webrtc-answer", {
      from,
      sdp,
      callId,
      roomId: roomId || user.roomId || partner.roomId, // CRITICAL: Include roomId
      timestamp: Date.now(),
    });

    console.log(
      `[handleWebRTCAnswer] Answer forwarding result: ${forwarded ? "success" : "failed"}`,
      {
        callId,
        roomId,
        fromSocket: from,
        toSocket: to,
      },
    );

    // Update room with call info if needed (in case it wasn't updated earlier)
    if (user.roomId && activeRooms.has(user.roomId)) {
      const room = activeRooms.get(user.roomId);
      if (!room.callId) {
        room.callId = callId;
        console.log(
          `[handleWebRTCAnswer] Updated room ${user.roomId} with callId: ${callId}`,
        );
      }
    }

    // Log current state for debugging
    console.log(`[handleWebRTCAnswer] Current call state:`, {
      callId,
      userCall: videoCalls.get(from),
      partnerCall: videoCalls.get(to),
      roomId: activeRooms.get(user.roomId),
    });
  } catch (err) {
    console.error("[handleWebRTCAnswer] Error:", err, {
      from,
      to,
      callId,
      roomId,
      stack: err.stack,
    });
    safeEmit(socket, "webrtc-error", {
      error: err.message,
      callId,
      roomId,
    });
  }
}
function handleWebRTCIceCandidate(socket, data) {
  const { to, candidate } = data;
  const from = socket.id;

  console.log(`[handleWebRTCIceCandidate] Received ICE candidate:`, {
    from,
    to,
    candidateType: candidate?.type,
    candidateProtocol: candidate?.protocol,
  });

  try {
    const partner = activeUsers.get(to);
    if (!partner) {
      console.warn(`[handleWebRTCIceCandidate] Partner ${to} not found`);
      return;
    }

    // Forward ICE candidate to partner
    console.log(
      `[handleWebRTCIceCandidate] Forwarding ICE candidate to: ${to}`,
    );
    const forwarded = safeEmit(partner.socket, "webrtc-ice-candidate", {
      from,
      candidate,
      timestamp: Date.now(),
    });

    if (!forwarded) {
      console.warn(
        `[handleWebRTCIceCandidate] Failed to forward ICE candidate to: ${to}`,
      );
    }
  } catch (err) {
    console.error("[handleWebRTCIceCandidate] Error:", err, {
      from,
      to,
      stack: err.stack,
    });
  }
}

function handleWebRTCEnd(socket, data) {
  const { to, reason = "user_ended" } = data;
  const from = socket.id;

  console.log(`[handleWebRTCEnd] Ending call:`, {
    from,
    to,
    reason,
  });

  try {
    const partner = activeUsers.get(to);
    if (partner) {
      console.log(`[handleWebRTCEnd] Notifying partner: ${to}`);
      safeEmit(partner.socket, "webrtc-end", {
        from,
        reason,
        timestamp: Date.now(),
      });
    } else {
      console.warn(`[handleWebRTCEnd] Partner ${to} not found`);
    }

    // Clean up video call records for both users
    const user = activeUsers.get(from);
    if (user) {
      const call = videoCalls.get(from);
      if (call) {
        console.log(`[handleWebRTCEnd] Cleaning up call records:`, {
          callId: call.callId,
          caller: call.caller,
          callee: call.callee,
        });

        // Also remove partner's call record
        videoCalls.delete(call.caller);
        videoCalls.delete(call.callee);

        // Clear callId from room
        if (call.roomId && activeRooms.has(call.roomId)) {
          activeRooms.get(call.roomId).callId = null;
          console.log(
            `[handleWebRTCEnd] Cleared callId from room: ${call.roomId}`,
          );
        }
      } else {
        console.log(`[handleWebRTCEnd] No call record found for: ${from}`);
      }
    }

    console.log(`[handleWebRTCEnd] Call end processed for ${from} -> ${to}`);
  } catch (err) {
    console.error("[handleWebRTCEnd] Error:", err, {
      from,
      to,
      reason,
      stack: err.stack,
    });
  }
}

function handleWebRTCReject(socket, data) {
  const { to, reason } = data;
  const from = socket.id;

  console.log(`[handleWebRTCReject] Rejecting call:`, {
    from,
    to,
    reason,
  });

  try {
    const partner = activeUsers.get(to);
    if (!partner) {
      console.warn(`[handleWebRTCReject] Partner ${to} not found`);
      return;
    }

    // Update video call status
    const call = videoCalls.get(from) || videoCalls.get(to);
    if (call) {
      console.log(`[handleWebRTCReject] Updating call status to rejected:`, {
        callId: call.callId,
        previousStatus: call.status,
      });

      call.status = "rejected";
      call.reason = reason;
      call.endTimestamp = Date.now();
    }

    // Forward rejection
    console.log(`[handleWebRTCReject] Forwarding rejection to: ${to}`);
    safeEmit(partner.socket, "webrtc-reject", {
      from,
      reason,
      timestamp: Date.now(),
    });
  } catch (err) {
    console.error("[handleWebRTCReject] Error:", err, {
      from,
      to,
      reason,
      stack: err.stack,
    });
  }
}

// --- Video Call Status Updates ---
function handleVideoCallStatus(socket, data) {
  const { to, status, callId } = data;
  const from = socket.id;

  console.log(`[handleVideoCallStatus] Updating call status:`, {
    from,
    to,
    callId,
    status,
  });

  try {
    const partner = activeUsers.get(to);
    if (!partner) {
      console.warn(`[handleVideoCallStatus] Partner ${to} not found`);
      return;
    }

    console.log(`[handleVideoCallStatus] Forwarding status update to: ${to}`);
    safeEmit(partner.socket, "video-call-status", {
      from,
      callId,
      status,
      timestamp: Date.now(),
    });
  } catch (err) {
    console.error("[handleVideoCallStatus] Error:", err, {
      from,
      to,
      callId,
      status,
      stack: err.stack,
    });
  }
}

function handleCallToggleMedia(socket, data) {
  const { to, mediaType, enabled } = data;
  const from = socket.id;

  console.log(`[handleCallToggleMedia] Media toggle:`, {
    from,
    to,
    mediaType,
    enabled,
  });

  try {
    const partner = activeUsers.get(to);
    if (!partner) {
      console.warn(`[handleCallToggleMedia] Partner ${to} not found`);
      return;
    }

    console.log(`[handleCallToggleMedia] Forwarding media toggle to: ${to}`);
    safeEmit(partner.socket, "call-toggle-media", {
      from,
      mediaType,
      enabled,
      timestamp: Date.now(),
    });
  } catch (err) {
    console.error("[handleCallToggleMedia] Error:", err, {
      from,
      to,
      mediaType,
      enabled,
      stack: err.stack,
    });
  }
}

function handleScreenShareStatus(socket, data) {
  const { to, isSharing } = data;
  const from = socket.id;

  console.log(`[handleScreenShareStatus] Screen share status:`, {
    from,
    to,
    isSharing,
  });

  try {
    const partner = activeUsers.get(to);
    if (!partner) {
      console.warn(`[handleScreenShareStatus] Partner ${to} not found`);
      return;
    }

    console.log(
      `[handleScreenShareStatus] Forwarding screen share status to: ${to}`,
    );
    safeEmit(partner.socket, "screen-share-status", {
      from,
      isSharing,
      timestamp: Date.now(),
    });
  } catch (err) {
    console.error("[handleScreenShareStatus] Error:", err, {
      from,
      to,
      isSharing,
      stack: err.stack,
    });
  }
}

// --- Disconnect Pair (Updated) ---
function disconnectPair(userId1, userId2, reason = "manual") {
  console.log(`[disconnectPair] Disconnecting pair:`, {
    userId1,
    userId2,
    reason,
  });

  try {
    const user1 = activeUsers.get(userId1);
    const user2 = activeUsers.get(userId2);

    console.log(`[disconnectPair] User states:`, {
      user1Exists: !!user1,
      user2Exists: !!user2,
      user1Status: user1?.status,
      user2Status: user2?.status,
    });

    // Clear typing
    [userId1, userId2].forEach((uid) => {
      if (typingUsers.has(uid)) {
        console.log(`[disconnectPair] Clearing typing for: ${uid}`);
        clearTimeout(typingUsers.get(uid).timeout);
        typingUsers.delete(uid);
      }
    });

    // Clear video calls
    const call1 = videoCalls.get(userId1);
    const call2 = videoCalls.get(userId2);

    console.log(`[disconnectPair] Video calls found:`, {
      call1Exists: !!call1,
      call2Exists: !!call2,
    });

    if (call1) {
      console.log(`[disconnectPair] Removing video call:`, {
        callId: call1.callId,
        caller: call1.caller,
        callee: call1.callee,
      });

      videoCalls.delete(call1.caller);
      videoCalls.delete(call1.callee);
    }

    if (call2) {
      videoCalls.delete(call2.caller);
      videoCalls.delete(call2.callee);
    }

    // Clear waiting requests
    for (const [callId, req] of waitingVideoRequests.entries()) {
      if (
        req.caller === userId1 ||
        req.callee === userId1 ||
        req.caller === userId2 ||
        req.callee === userId2
      ) {
        console.log(`[disconnectPair] Removing waiting request: ${callId}`);
        waitingVideoRequests.delete(callId);
      }
    }

    // Clear room
    const roomId = user1?.roomId || user2?.roomId;
    if (roomId && activeRooms.has(roomId)) {
      console.log(`[disconnectPair] Removing room: ${roomId}`);
      const room = activeRooms.get(roomId);
      if (room.callId) {
        console.log(
          `[disconnectPair] Removing video call messages for: ${room.callId}`,
        );
        videoCallMessages.delete(room.callId);
      }
      activeRooms.delete(roomId);
    }

    userPairs.delete(userId1);
    userPairs.delete(userId2);

    console.log(`[disconnectPair] User pairs after delete:`, {
      userId1InPairs: userPairs.has(userId1),
      userId2InPairs: userPairs.has(userId2),
    });

    // Reset user states
    [user1, user2].forEach((user) => {
      if (user) {
        console.log(
          `[disconnectPair] Resetting user state: ${user.socket.id}`,
          {
            previousPartnerId: user.partnerId,
            previousRoomId: user.roomId,
            previousStatus: user.status,
          },
        );

        user.partnerId = null;
        user.roomId = null;
        user.status = "ready";

        if (user.matchingInterval) {
          console.log(
            `[disconnectPair] Clearing matching interval for: ${user.socket.id}`,
          );
          clearInterval(user.matchingInterval);
          user.matchingInterval = null;
        }
      }
    });

    // Remove from matching engine
    console.log(`[disconnectPair] Removing users from matching engine`);
    matchingEngine.removeUser(userId1);
    matchingEngine.removeUser(userId2);

    console.info(`[disconnectPair] Successfully disconnected pair:`, {
      userId1,
      userId2,
      reason,
      remainingPairs: userPairs.size / 2,
    });

    return true;
  } catch (err) {
    console.error("[disconnectPair] Error:", err, {
      userId1,
      userId2,
      reason,
      stack: err.stack,
    });
    return false;
  }
}

// Typing handlers

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

// --- Update Stats ---
function updateStats() {
  console.log(`[updateStats] Updating stats`);

  try {
    const onlineCount = Array.from(activeUsers.values()).filter(
      (u) => u.status === "ready" || u.status === "searching",
    ).length;

    const activeVideoCalls =
      Array.from(videoCalls.values()).filter(
        (call) => call.status === "answered" || call.status === "offered",
      ).length / 2;

    const stats = {
      online: onlineCount,
      timestamp: Date.now(),
      activeChats: Array.from(userPairs.keys()).length / 2,
      videoCalls: activeVideoCalls,
      typingUsers: Array.from(typingUsers.keys()).length,
      searching: Array.from(activeUsers.values()).filter(
        (u) => u.status === "searching",
      ).length,
    };

    console.log(`[updateStats] Broadcasting stats:`, stats);
    
    // BOTH events for compatibility
    io.emit("stats", stats);  // Main event your client listens for
    io.emit("stats-updated", stats);  // Backup event
    
  } catch (err) {
    console.error("[updateStats] Error:", err);
  }
}

//     socket.on("message", (data) => {
//       sendMessage(socket.id, data);
//     });
// --- Socket.IO Event Handlers (Updated) ---
io.on("connection", (socket) => {
  console.info(`[Socket.IO] New connection: ${socket.id}`, {
    remoteAddress: socket.handshake.address,
    headers: socket.handshake.headers,
    timestamp: new Date().toISOString(),
  });

  try {
    userSessions.set(socket.id, {
      connectedAt: Date.now(),
      lastActivity: Date.now(),
      remoteAddress: socket.handshake.address,
    });

    // Heartbeat
    socket.conn.on("heartbeat", () => {
      const s = userSessions.get(socket.id);
      if (s) {
        s.lastActivity = Date.now();
        console.log(`[Socket.IO] Heartbeat for: ${socket.id}`);
      }
    });



        // Send initial stats to the newly connected client
    const initialStats = {
      online: Array.from(activeUsers.values()).filter(
        (u) => u.status === "ready" || u.status === "searching",
      ).length,
      timestamp: Date.now(),
      activeChats: Array.from(userPairs.keys()).length / 2,
      videoCalls: Array.from(videoCalls.values()).filter(
        (c) => c.status === "answered"
      ).length / 2,
      searching: Array.from(activeUsers.values()).filter(
        (u) => u.status === "searching",
      ).length,
    };
    
    console.log(`[Socket.IO] Sending initial stats to ${socket.id}:`, initialStats);
    safeEmit(socket, "stats", initialStats);


    // Core events
    socket.on("register", (userData) => {
      console.log(`[Socket.IO] Register event from: ${socket.id}`, {
        userData: { ...userData, socketId: socket.id },
      });
      try {
        registerUser(socket, userData);
      } catch (e) {
        console.error("[Socket.IO register] Error:", e);
      }
    });

    socket.on("search", (options) => {
      console.log(`[Socket.IO] Search event from: ${socket.id}`, {
        options,
        timestamp: Date.now(),
      });
      startSearch(socket.id, options);
    });

    socket.on("message", (data) => {
      console.log(`[Socket.IO] Message event from: ${socket.id}`, {
        data: { ...data, timestamp: Date.now() },
      });

      sendMessage(socket.id, data);
      // ... existing message handler ...
    });

    socket.on("typing", () => {
      console.log(`[Socket.IO] Typing event from: ${socket.id}`);
      typingStart(socket.id);
    });

    socket.on("typingStopped", () => {
      console.log(`[Socket.IO] TypingStopped event from: ${socket.id}`);
      typingStop(socket.id);
    });

    socket.on("next", (data) => {
      console.log(`[Socket.IO] Next event from: ${socket.id}`, {
        data,
        timestamp: Date.now(),
      });

      try {
        const user = activeUsers.get(socket.id);
        if (!user) {
          console.warn(`[Socket.IO next] User not found: ${socket.id}`);
          safeEmit(socket, "next-error", { message: "User not found" });
          return;
        }

        if (user.partnerId) {
          console.log(
            `[Socket.IO next] User has partner, disconnecting: ${user.partnerId}`,
          );
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

        // Re-add to matching
        setTimeout(() => {
          if (
            !activeUsers.has(socket.id) ||
            !activeUsers.get(socket.id).socket.connected
          ) {
            console.warn(
              `[Socket.IO next] User disconnected, skipping re-search`,
            );
            return;
          }

          const u = activeUsers.get(socket.id);
          u.status = "searching";
          u.searchStart = Date.now();
          u.attempts = (u.attempts || 0) + 1;
          u.partnerId = null;

          if (u.matchingInterval) {
            clearInterval(u.matchingInterval);
            u.matchingInterval = null;
          }

          console.log(
            `[Socket.IO next] Re-adding user to matching engine: ${socket.id}`,
          );
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
        console.error("[Socket.IO next handler] Error:", err, {
          socketId: socket.id,
          stack: err.stack,
        });
        safeEmit(socket, "next-error", { message: err.message });
      }
    });

    socket.on("disconnect-partner", (data) => {
      console.log(`[Socket.IO] disconnect-partner event from: ${socket.id}`, {
        data,
        timestamp: Date.now(),
      });

      try {
        const user = activeUsers.get(socket.id);
        if (user && user.partnerId) {
          const partnerId = user.partnerId;
          console.log(
            `[Socket.IO disconnect-partner] Disconnecting partner: ${partnerId}`,
          );

          const partner = activeUsers.get(partnerId);
          if (partner && partner.socket && partner.socket.connected)
            safeEmit(partner.socket, "partnerDisconnected", {
              reason: "manual_disconnect",
              timestamp: Date.now(),
            });
          disconnectPair(socket.id, partnerId, data?.reason || "user_request");
        }
      } catch (err) {
        console.error("[Socket.IO disconnect-partner handler] Error:", err);
      }
    });

    // ======================
    // WEBRTC SIGNALING EVENTS
    // ======================

    socket.on("webrtc-offer", (data) => {
      console.log(`[Socket.IO] webrtc-offer event from: ${socket.id}`);
      handleWebRTCOffer(socket, data);
    });

    socket.on("webrtc-answer", (data) => {
      console.log(`[Socket.IO] webrtc-answer event from: ${socket.id}`);
      handleWebRTCAnswer(socket, data);
    });

    socket.on("webrtc-ice-candidate", (data) => {
      console.log(`[Socket.IO] webrtc-ice-candidate event from: ${socket.id}`);
      handleWebRTCIceCandidate(socket, data);
    });

    socket.on("webrtc-end", (data) => {
      console.log(`[Socket.IO] webrtc-end event from: ${socket.id}`);
      handleWebRTCEnd(socket, data);
    });

    socket.on("webrtc-reject", (data) => {
      console.log(`[Socket.IO] webrtc-reject event from: ${socket.id}`);
      handleWebRTCReject(socket, data);
    });

    socket.on("video-call-status", (data) => {
      console.log(`[Socket.IO] video-call-status event from: ${socket.id}`);
      handleVideoCallStatus(socket, data);
    });

    socket.on("call-toggle-media", (data) => {
      console.log(`[Socket.IO] call-toggle-media event from: ${socket.id}`);
      handleCallToggleMedia(socket, data);
    });

    socket.on("screen-share-status", (data) => {
      console.log(`[Socket.IO] screen-share-status event from: ${socket.id}`);
      handleScreenShareStatus(socket, data);
    });

    // Video call request
    socket.on("video-call-request", (data = {}) => {
      console.log(`[Socket.IO] video-call-request event from: ${socket.id}`, {
        data,
        timestamp: Date.now(),
      });

      try {
        const u = activeUsers.get(socket.id);
        if (!u || !u.partnerId) {
          console.warn(
            `[Socket.IO video-call-request] No partner found for: ${socket.id}`,
          );
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

        console.log(
          `[Socket.IO video-call-request] Creating video call request:`,
          {
            callId,
            caller: socket.id,
            callee: u.partnerId,
            roomId: u.roomId,
          },
        );

        waitingVideoRequests.set(callId, videoCall);

        if (partner && partner.socket && partner.socket.connected) {
          console.log(
            `[Socket.IO video-call-request] Sending request to partner: ${u.partnerId}`,
          );
          safeEmit(partner.socket, "video-call-request", {
            callId,
            from: socket.id,
            callerName: u.profile.username,
            timestamp: Date.now(),
          });
        }

        // Timeout after 30 seconds
        setTimeout(() => {
          if (waitingVideoRequests.has(callId)) {
            console.log(
              `[Socket.IO video-call-request] Request timeout: ${callId}`,
            );
            waitingVideoRequests.delete(callId);
            safeEmit(socket, "video-call-timeout", { callId });
            console.info(`[Socket.IO video-call-request] timed out ${callId}`);
          }
        }, 30000);
      } catch (err) {
        console.error("[Socket.IO video-call-request] Error:", err);
      }
    });

    // Get partner info
    socket.on("get-partner-info", () => {
      console.log(`[Socket.IO] get-partner-info event from: ${socket.id}`);

      try {
        const u = activeUsers.get(socket.id);
        if (!u || !u.partnerId) {
          console.warn(
            `[Socket.IO get-partner-info] No partner found for: ${socket.id}`,
          );
          safeEmit(socket, "partner-info", { error: "No partner found" });
          return;
        }

        const partner = activeUsers.get(u.partnerId);
        if (!partner) {
          console.warn(
            `[Socket.IO get-partner-info] Partner not found: ${u.partnerId}`,
          );
          safeEmit(socket, "partner-info", { error: "Partner not found" });
          return;
        }

        const callInfo = videoCalls.get(socket.id);

        console.log(
          `[Socket.IO get-partner-info] Sending partner info to: ${socket.id}`,
        );
        safeEmit(socket, "partner-info", {
          partnerId: u.partnerId,
          profile: partner.profile,
          isTyping: typingUsers.has(u.partnerId),
          lastSeen: userSessions.get(u.partnerId)?.lastActivity || Date.now(),
          compatibility: calculateCompatibility(u.profile, partner.profile),
          roomId: u.roomId,
          videoCall: callInfo || null,
        });
      } catch (err) {
        console.error("[Socket.IO get-partner-info] Error:", err);
      }
    });

    // Get stats
    socket.on("get-stats", () => {
      console.log(`[Socket.IO] get-stats event from: ${socket.id}`);

      try {
        const onlineCount = Array.from(activeUsers.values()).filter(
          (u) => u.status === "ready" || u.status === "searching",
        ).length;

        const stats = matchingEngine.getStats ? matchingEngine.getStats() : {};

        console.log(`[Socket.IO get-stats] Sending stats to: ${socket.id}`);
        safeEmit(socket, "stats", {
          online: onlineCount,
          searching: Array.from(activeUsers.values()).filter(
            (u) => u.status === "searching",
          ).length,
          inChat: Array.from(userPairs.keys()).length / 2,
          videoCalls:
            Array.from(videoCalls.values()).filter(
              (c) => c.status === "answered",
            ).length / 2,
          matchingStats: stats,
          typingUsers: Array.from(typingUsers.keys()).length,
        });
      } catch (err) {
        console.error("[Socket.IO get-stats] Error:", err);
      }
    });

    // Heartbeat
    socket.on("heartbeat", () => {
      console.log(`[Socket.IO] heartbeat event from: ${socket.id}`);
      const s = userSessions.get(socket.id);
      if (s) s.lastActivity = Date.now();
      safeEmit(socket, "heartbeat-response", { timestamp: Date.now() });
    });

    // Error handler
    socket.on("error", (error) => {
      console.error(`[Socket.IO] socket error ${socket.id}:`, error);
    });

    // Disconnect
    socket.on("disconnect", (reason) => {
      console.info(`[Socket.IO] disconnect ${socket.id}: ${reason}`, {
        reason,
        timestamp: new Date().toISOString(),
        sessionDuration: userSessions.get(socket.id)
          ? Date.now() - userSessions.get(socket.id).connectedAt
          : 0,
      });

      try {
        const u = activeUsers.get(socket.id);
        if (u && u.partnerId) {
          console.log(
            `[Socket.IO disconnect] User has partner, notifying: ${u.partnerId}`,
          );
          const p = activeUsers.get(u.partnerId);
          if (p && p.socket && p.socket.connected) {
            safeEmit(p.socket, "partnerDisconnected", {
              reason: "disconnected",
              timestamp: Date.now(),
              autoConnect: p.autoConnect || false,
            });
          }
          disconnectPair(socket.id, u.partnerId, "disconnected");
        }

        // Clean up user
        console.log(
          `[Socket.IO disconnect] Cleaning up user data for: ${socket.id}`,
        );
        if (u) {
          activeUsers.delete(socket.id);
          messageHistory.delete(socket.id);
          videoCalls.delete(socket.id);
          userPairs.delete(socket.id);
          typingUsers.delete(socket.id);
          matchingEngine.removeUser(socket.id);
        }

        userSessions.delete(socket.id);
        updateStats();

        console.info(
          `[Socket.IO disconnect] Cleanup complete for: ${socket.id}`,
          {
            remainingUsers: activeUsers.size,
            remainingSessions: userSessions.size,
          },
        );
      } catch (err) {
        console.error("[Socket.IO disconnect handler] Error:", err);
      }
    });

    console.log(`[Socket.IO] All event handlers registered for: ${socket.id}`);
  } catch (err) {
    console.error("[Socket.IO connection handler] Error:", err, {
      socketId: socket.id,
      stack: err.stack,
    });
  }
});

// --- HTTP Endpoints (Added Video Specific) ---
// Contact form submission endpoint
app.post("/api/contact", async (req, res) => {
  const requestId =
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8); // short unique ID per request

  console.log(
    `[CONTACT:${requestId}] New contact request received from IP: ${req.ip || "unknown"}`,
  );

  try {
    const { name, email, contactReason, subject, message, priority } = req.body;

    // ── 1. Log incoming payload (sanitized - no full message)
    console.log(`[CONTACT:${requestId}] Payload:`, {
      name: name || "(missing)",
      email: email || "(missing)",
      contactReason: contactReason || "(missing)",
      subject: subject || "(missing)",
      priority: priority || "(missing)",
      messageLength: message ? message.length : 0,
    });

    // ── 2. Validation
    if (
      !name ||
      !email ||
      !contactReason ||
      !subject ||
      !message ||
      !priority
    ) {
      console.warn(`[CONTACT:${requestId}] Validation failed: missing fields`);
      return res.status(400).json({
        success: false,
        message: "All fields are required",
      });
    }

    if (!/\S+@\S+\.\S+/.test(email)) {
      console.warn(`[CONTACT:${requestId}] Invalid email format: ${email}`);
      return res.status(400).json({
        success: false,
        message: "Please provide a valid email address",
      });
    }

    if (message.length < 20) {
      console.warn(
        `[CONTACT:${requestId}] Message too short (${message.length} chars)`,
      );
      return res.status(400).json({
        success: false,
        message: "Message must be at least 20 characters long",
      });
    }

    const ticketNumber = generateTicketNumber();
    const estimatedResponse = getEstimatedResponse(priority);
    const userIP =
      req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";

    console.log(
      `[CONTACT:${requestId}] Ticket created: ${ticketNumber} | Priority: ${priority} | Est. response: ${estimatedResponse} | IP: ${userIP}`,
    );

    // ── 3. Prepare emails
    const userMailOptions = {
      from: "rajibanavath@zohomail.in",
      to: "rajibanavath@zohomail.in",
      subject: `We've received your message - ${ticketNumber}`,
      html: generateUserEmailHTML(req.body, ticketNumber, estimatedResponse),
    };

    const supportMailOptions = {
      from: "rajibanavath@zohomail.in",
      to: "rajibanavath@zohomail.in",
      subject: `New Support Ticket: ${ticketNumber} - ${subject}`,
      html: generateSupportEmailHTML({ ...req.body, ip: userIP }, ticketNumber),
    };

    console.log(`[CONTACT:${requestId}] Preparing to send:`);
    console.log(`  → User email    : ${email}`);
    console.log(`  → Support email  : ${supportMailOptions.to}`);
    console.log(
      `  → From           : ${process.env.SMTP_USER || "(SMTP_USER not set)"}`,
    );

    // ── 4. Actually send emails
    console.log(`[CONTACT:${requestId}] Sending user confirmation email...`);
    await transporter.sendMail(userMailOptions);
    console.log(`[CONTACT:${requestId}] User email sent successfully`);

    console.log(`[CONTACT:${requestId}] Sending support team notification...`);
    await transporter.sendMail(supportMailOptions);
    console.log(
      `[CONTACT:${requestId}] Support notification sent successfully`,
    );

    // ── 5. Success response
    console.log(
      `[CONTACT:${requestId}] SUCCESS - Ticket ${ticketNumber} processed`,
    );

    res.json({
      success: true,
      message: "Message sent successfully!",
      data: {
        ticketNumber,
        estimatedResponse,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error(`[CONTACT:${requestId}] ERROR during processing:`, {
      message: error.message,
      code: error.code,
      command: error.command,
      stack: error.stack
        ? error.stack.split("\n").slice(0, 4).join("\n")
        : undefined, // first 4 lines only
    });

    // More specific diagnostics
    if (error.code === "EAUTH") {
      console.error(`[CONTACT:${requestId}] SMTP Authentication failed`);
      console.error(`  → Check SMTP_USER and SMTP_PASS in .env`);
      console.error(
        `  → Current SMTP_USER: ${process.env.SMTP_USER ? "set" : "MISSING"}`,
      );
      console.error(
        `  → SMTP_PASS length: ${process.env.SMTP_PASS ? process.env.SMTP_PASS.length : "MISSING"}`,
      );
    } else if (error.code === "ECONNECTION") {
      console.error(
        `[CONTACT:${requestId}] SMTP Connection failed - check host/port/firewall`,
      );
      console.error(`  → Host: ${process.env.SMTP_HOST || "smtp.gmail.com"}`);
      console.error(`  → Port: ${process.env.SMTP_PORT || 587}`);
    } else if (error.code === "EENVELOPE") {
      console.error(`[CONTACT:${requestId}] Invalid recipient address`);
    } else if (error.response) {
      console.error(
        `[CONTACT:${requestId}] SMTP server response:`,
        error.response,
      );
    }

    res.status(500).json({
      success: false,
      message: "Failed to send message. Please try again later.",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
      requestId, // helpful for user to report
    });
  }
});
// Health endpoint
app.get("/health", (req, res) => {
  console.log(`[HTTP] GET /health from: ${req.ip}`, {
    headers: req.headers,
    timestamp: new Date().toISOString(),
  });

  try {
    const stats = {
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      users: activeUsers.size,
      pairs: Array.from(userPairs.keys()).length / 2,
      videoCalls:
        Array.from(videoCalls.values()).filter((c) => c.status === "answered")
          .length / 2,
      rooms: activeRooms.size,
      waitingRequests: waitingVideoRequests.size,
      typingUsers: Array.from(typingUsers.keys()).length,
      memory: process.memoryUsage(),
    };

    console.log(`[HTTP] Health check response:`, stats);
    res.json(stats);
  } catch (err) {
    console.error("[HTTP /health] Error:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

// Video call info
app.get("/video/call/:callId", (req, res) => {
  const { callId } = req.params;
  console.log(`[HTTP] GET /video/call/${callId} from: ${req.ip}`);

  try {
    // Find call
    let callInfo = null;
    for (const [userId, call] of videoCalls.entries()) {
      if (call.callId === callId) {
        callInfo = call;
        break;
      }
    }

    if (!callInfo) {
      console.warn(`[HTTP /video/call] Call not found: ${callId}`);
      return res.status(404).json({ error: "Call not found" });
    }

    const user1 = activeUsers.get(callInfo.caller);
    const user2 = activeUsers.get(callInfo.callee);

    const response = {
      callId,
      caller: user1?.profile || null,
      callee: user2?.profile || null,
      status: callInfo.status,
      timestamp: callInfo.timestamp,
      duration: callInfo.endTimestamp
        ? (callInfo.endTimestamp - callInfo.timestamp) / 1000
        : (Date.now() - callInfo.timestamp) / 1000,
      roomId: callInfo.roomId,
      sdpPresent: !!callInfo.sdp,
      answerPresent: !!callInfo.answerSdp,
    };

    console.log(`[HTTP /video/call] Response for ${callId}:`, response);
    res.json(response);
  } catch (err) {
    console.error("[HTTP /video/call] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// WebRTC config endpoint (CRITICAL - provides ICE servers)
app.get("/webrtc/config", (req, res) => {
  console.log(`[HTTP] GET /webrtc/config from: ${req.ip}`);

  try {
    const iceServers = [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun2.l.google.com:19302" },
      { urls: "stun:stun3.l.google.com:19302" },
      { urls: "stun:stun4.l.google.com:19302" },
      {
        urls: "turn:openrelay.metered.ca:80",
        username: "openrelayproject",
        credential: "openrelayproject",
      },
      {
        urls: "turn:openrelay.metered.ca:443",
        username: "openrelayproject",
        credential: "openrelayproject",
      },
      {
        urls: "turn:openrelay.metered.ca:443?transport=tcp",
        username: "openrelayproject",
        credential: "openrelayproject",
      },
    ];

    const config = {
      iceServers,
      iceTransportPolicy: "all",
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
      iceCandidatePoolSize: 10,
      sdpSemantics: "unified-plan",
    };

    console.log(
      `[HTTP /webrtc/config] Sending config with ${iceServers.length} ICE servers`,
    );
    res.json(config);
  } catch (err) {
    console.error("[HTTP /webrtc/config] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Admin stats
app.get("/admin/stats", (req, res) => {
  console.log(`[HTTP] GET /admin/stats from: ${req.ip}`);

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
        Array.from(videoCalls.values()).filter((c) => c.status === "answered")
          .length / 2,
      searchingUsers: Array.from(activeUsers.values()).filter(
        (u) => u.status === "searching",
      ).length,
      waitingVideoRequests: waitingVideoRequests.size,
      activeRooms: activeRooms.size,
      userSessions: userSessions.size,
      typingUsers: Array.from(typingUsers.keys()).length,
      matchingEngineStats: matchingEngine.getStats
        ? matchingEngine.getStats()
        : {},
      uptime: process.uptime(),
      serverTime: new Date().toISOString(),
      memoryUsage: process.memoryUsage(),
    };

    console.log(`[HTTP /admin/stats] Sending admin stats`);
    res.json(stats);
  } catch (err) {
    console.error("[HTTP /admin/stats] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Get room info
app.get("/room/:roomId", (req, res) => {
  const { roomId } = req.params;
  console.log(`[HTTP] GET /room/${roomId} from: ${req.ip}`);

  try {
    const room = activeRooms.get(roomId);
    if (!room) {
      console.warn(`[HTTP /room] Room not found: ${roomId}`);
      return res.status(404).json({ error: "Room not found" });
    }

    const response = {
      roomId: req.params.roomId,
      users: room.users,
      callId: room.callId,
      createdAt: room.createdAt,
      mode: room.mode,
      user1: activeUsers.get(room.users[0])?.profile || null,
      user2: activeUsers.get(room.users[1])?.profile || null,
      callStatus: room.callId ? videoCalls.get(room.users[0])?.status : null,
    };

    console.log(`[HTTP /room] Response for ${roomId}:`, response);
    res.json(response);
  } catch (err) {
    console.error("[HTTP /room] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Middleware for logging all HTTP requests
app.use((req, res, next) => {
  const start = Date.now();
  console.log(`[HTTP] ${req.method} ${req.url} from: ${req.ip}`);

  res.on("finish", () => {
    const duration = Date.now() - start;
    console.log(
      `[HTTP] ${req.method} ${req.url} ${res.statusCode} - ${duration}ms`,
    );
  });

  next();
});

// Cleanup inactive users
console.log(
  `[Server] Setting up cleanup interval every ${CLEANUP_INTERVAL_MS}ms`,
);
setInterval(() => {
  console.log(`[Server] Running cleanup interval`);

  try {
    const now = Date.now();
    let inactiveCount = 0;

    for (const [userId, session] of userSessions.entries()) {
      if (now - session.lastActivity > INACTIVE_THRESHOLD_MS) {
        console.info(`[Server cleanup] Removing inactive user ${userId}`, {
          inactiveFor: now - session.lastActivity,
          lastActivity: new Date(session.lastActivity).toISOString(),
        });

        const user = activeUsers.get(userId);
        if (user && user.partnerId) {
          disconnectPair(userId, user.partnerId, "inactive");
        }

        // Full cleanup
        if (user) {
          activeUsers.delete(userId);
          messageHistory.delete(userId);
          videoCalls.delete(userId);
          userPairs.delete(userId);
          typingUsers.delete(userId);
          matchingEngine.removeUser(userId);
        }

        userSessions.delete(userId);
        inactiveCount++;
      }
    }

    if (inactiveCount > 0) {
      console.info(`[Server cleanup] Removed ${inactiveCount} inactive users`);
    }

    // Clean up old waiting video requests
    for (const [callId, request] of waitingVideoRequests.entries()) {
      if (now - request.timestamp > 30000) {
        // 30 seconds
        console.log(`[Server cleanup] Removing old video request: ${callId}`);
        waitingVideoRequests.delete(callId);
      }
    }

    // Update stats after cleanup
    updateStats();
  } catch (err) {
    console.error("[Server cleanup interval] Error:", err);
  }
}, CLEANUP_INTERVAL_MS);

// Log server start
server.on("listening", () => {
  const address = server.address();
  console.info(`[Server] Server is listening on port ${address.port}`, {
    address: address.address,
    port: address.port,
    family: address.family,
  });
});

server.on("error", (error) => {
  console.error(`[Server] Server error:`, error);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.info("[Server] SIGTERM received, shutting down gracefully");

  // Close all socket connections
  io.close(() => {
    console.log("[Server] Socket.IO closed");
  });

  // Close HTTP server
  server.close(() => {
    console.log("[Server] HTTP server closed");
    process.exit(0);
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    console.error("[Server] Force shutdown after timeout");
    process.exit(1);
  }, 10000);
});

// --- Start Server ---
console.log(`[Server] Starting server on port ${PORT}`);
server.listen(PORT, () => {
  console.info(`[Server] Server running on port ${PORT}`);
  console.info(`[Server] Health: http://localhost:${PORT}/health`);
  console.info(
    `[Server] WebRTC Config: http://localhost:${PORT}/webrtc/config`,
  );
  console.info(`[Server] Admin Stats: http://localhost:${PORT}/admin/stats`);
});

module.exports = {
  app,
  server,
  io,
  activeUsers,
  userPairs,
  messageHistory,
  videoCalls,
  typingUsers,
  waitingVideoRequests,
  userSessions,
  videoCallMessages,
  activeRooms,
  // Export helper functions for testing
  registerUser,
  startSearch,
  instantMatch,
  disconnectPair,
  calculateCompatibility,
  getSharedInterests,
};
