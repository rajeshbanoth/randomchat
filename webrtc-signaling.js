class WebRTCSignaling {
  constructor() {
    this.sessions = new Map();
  }

  createSession(userId) {
    const session = {
      userId,
      offer: null,
      answer: null,
      candidates: [],
      createdAt: new Date(),
    };
    this.sessions.set(userId, session);
    return session;
  }

  setOffer(userId, offer) {
    const session = this.sessions.get(userId) || this.createSession(userId);
    session.offer = offer;
    return session;
  }

  setAnswer(userId, answer) {
    const session = this.sessions.get(userId);
    if (session) {
      session.answer = answer;
    }
    return session;
  }

  addCandidate(userId, candidate) {
    const session = this.sessions.get(userId);
    if (session) {
      session.candidates.push(candidate);
    }
    return session;
  }

  getSession(userId) {
    return this.sessions.get(userId);
  }

  removeSession(userId) {
    this.sessions.delete(userId);
  }
}

module.exports = { WebRTCSignaling };
