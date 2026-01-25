class TrackingEngine {
  constructor() {
    this.userSessions = new Map();
    this.chatMetrics = new Map();
    this.messageCorpus = new Map();
    this.topicModels = new Map();
  }

  // Track user message for behavior analysis
  trackMessage(userId, message) {
    if (!this.userSessions.has(userId)) {
      this.userSessions.set(userId, {
        messageCount: 0,
        totalCharacters: 0,
        responseTimes: [],
        topics: new Set(),
        sentimentScores: [],
        lastMessageTime: Date.now()
      });
    }

    const session = this.userSessions.get(userId);
    session.messageCount++;
    session.totalCharacters += message.length;
    
    // Calculate response time if not first message
    const currentTime = Date.now();
    if (session.lastMessageTime) {
      const responseTime = (currentTime - session.lastMessageTime) / 1000;
      session.responseTimes.push(responseTime);
      
      // Keep only last 100 response times
      if (session.responseTimes.length > 100) {
        session.responseTimes.shift();
      }
    }
    session.lastMessageTime = currentTime;

    // Analyze message content
    const analysis = this.analyzeMessage(message);
    session.topics.add(...analysis.topics);
    session.sentimentScores.push(analysis.sentiment);

    // Update message corpus for topic modeling
    this.updateMessageCorpus(userId, message, analysis);

    return analysis;
  }

  // Analyze message content
  analyzeMessage(message) {
    const topics = this.extractTopics(message);
    const sentiment = this.analyzeSentiment(message);
    const complexity = this.calculateComplexity(message);
    const questionCount = (message.match(/\?/g) || []).length;

    return {
      topics,
      sentiment,
      complexity,
      questionCount,
      length: message.length,
      wordCount: message.split(/\s+/).length,
      hasEmojis: this.containsEmojis(message)
    };
  }

  // Extract topics from message
  extractTopics(message) {
    const topicKeywords = {
      technology: ['code', 'programming', 'computer', 'tech', 'ai', 'machine learning'],
      sports: ['game', 'sport', 'team', 'player', 'score', 'win'],
      entertainment: ['movie', 'music', 'show', 'celebrity', 'actor'],
      food: ['eat', 'food', 'restaurant', 'cook', 'recipe'],
      travel: ['travel', 'vacation', 'trip', 'destination'],
      relationships: ['friend', 'family', 'relationship', 'love'],
      hobbies: ['hobby', 'craft', 'art', 'music', 'reading']
    };

    const topics = [];
    const lowerMessage = message.toLowerCase();

    for (const [topic, keywords] of Object.entries(topicKeywords)) {
      if (keywords.some(keyword => lowerMessage.includes(keyword))) {
        topics.push(topic);
      }
    }

    return topics;
  }

  // Basic sentiment analysis
  analyzeSentiment(message) {
    const positiveWords = ['good', 'great', 'awesome', 'excellent', 'happy', 'love', 'like'];
    const negativeWords = ['bad', 'terrible', 'awful', 'hate', 'dislike', 'sad', 'angry'];

    let score = 0;
    const words = message.toLowerCase().split(/\s+/);

    words.forEach(word => {
      if (positiveWords.includes(word)) score += 1;
      if (negativeWords.includes(word)) score -= 1;
    });

    // Normalize to -1 to 1
    return Math.max(-1, Math.min(1, score / Math.max(1, words.length * 0.1)));
  }

  // Calculate message complexity
  calculateComplexity(message) {
    const words = message.split(/\s+/);
    if (words.length === 0) return 0;

    const avgWordLength = message.replace(/\s+/g, '').length / words.length;
    const sentenceCount = (message.match(/[.!?]+/g) || []).length;
    const complexWordCount = words.filter(word => word.length > 6).length;

    return Math.min(1, (avgWordLength * 0.1 + complexWordCount / words.length * 2) / 3);
  }

  // Check if message contains emojis
  containsEmojis(message) {
    const emojiRegex = /[\p{Emoji_Presentation}\p{Emoji}\uFE0F]/gu;
    return emojiRegex.test(message);
  }

  // Update message corpus
  updateMessageCorpus(userId, message, analysis) {
    if (!this.messageCorpus.has(userId)) {
      this.messageCorpus.set(userId, []);
    }

    const corpus = this.messageCorpus.get(userId);
    corpus.push({
      message,
      analysis,
      timestamp: Date.now()
    });

    // Keep only last 1000 messages
    if (corpus.length > 1000) {
      corpus.shift();
    }
  }

  // Get user behavior profile
  getUserBehaviorProfile(userId) {
    const session = this.userSessions.get(userId);
    if (!session) {
      return {
        averageMessageLength: 50,
        averageResponseTime: 30,
        topicDiversity: 0.5,
        engagementScore: 0.5,
        sentimentAverage: 0,
        questionRate: 0.1
      };
    }

    const avgMessageLength = session.totalCharacters / session.messageCount;
    const avgResponseTime = session.responseTimes.length > 0 
      ? session.responseTimes.reduce((a, b) => a + b, 0) / session.responseTimes.length 
      : 30;
    const topicDiversity = Math.min(1, session.topics.size / 10);
    const sentimentAverage = session.sentimentScores.length > 0
      ? session.sentimentScores.reduce((a, b) => a + b, 0) / session.sentimentScores.length
      : 0;

    // Calculate engagement score
    const messagesPerMinute = session.messageCount / 
      ((Date.now() - session.lastMessageTime + 60000) / 60000);
    const engagementScore = Math.min(1, messagesPerMinute / 5);

    // Calculate question rate
    const corpus = this.messageCorpus.get(userId) || [];
    const questions = corpus.filter(item => item.analysis.questionCount > 0);
    const questionRate = corpus.length > 0 ? questions.length / corpus.length : 0.1;

    return {
      averageMessageLength: avgMessageLength,
      averageResponseTime: avgResponseTime,
      topicDiversity,
      engagementScore,
      sentimentAverage,
      questionRate,
      totalMessages: session.messageCount,
      uniqueTopics: session.topics.size
    };
  }

  // Get conversation compatibility between two users
  getConversationCompatibility(userIdA, userIdB) {
    const behaviorA = this.getUserBehaviorProfile(userIdA);
    const behaviorB = this.getUserBehaviorProfile(userIdB);

    let compatibility = 0.5;

    // Message length compatibility
    const lengthDiff = Math.abs(behaviorA.averageMessageLength - behaviorB.averageMessageLength);
    compatibility += 0.2 * (1 - Math.min(1, lengthDiff / 100));

    // Response time compatibility
    const responseDiff = Math.abs(behaviorA.averageResponseTime - behaviorB.averageResponseTime);
    compatibility += 0.2 * (1 - Math.min(1, responseDiff / 60));

    // Topic diversity compatibility
    const topicDiff = Math.abs(behaviorA.topicDiversity - behaviorB.topicDiversity);
    compatibility += 0.15 * (1 - topicDiff);

    // Sentiment compatibility
    const sentimentDiff = Math.abs(behaviorA.sentimentAverage - behaviorB.sentimentAverage);
    compatibility += 0.15 * (1 - sentimentDiff);

    // Question rate compatibility
    const questionDiff = Math.abs(behaviorA.questionRate - behaviorB.questionRate);
    compatibility += 0.1 * (1 - questionDiff);

    return Math.min(1, Math.max(0, compatibility));
  }

  // Get conversation suggestions
  getConversationSuggestions(userId, partnerId) {
    const userBehavior = this.getUserBehaviorProfile(userId);
    const partnerBehavior = this.getUserBehaviorProfile(partnerId);
    const suggestions = [];

    // Suggest based on topic diversity
    if (userBehavior.topicDiversity < 0.3) {
      suggestions.push("Try discussing different topics to keep the conversation interesting");
    }

    // Suggest based on question rate
    if (userBehavior.questionRate < 0.1) {
      suggestions.push("Ask more questions to show interest in your partner");
    }

    // Suggest based on message length
    if (userBehavior.averageMessageLength < 20 && partnerBehavior.averageMessageLength > 50) {
      suggestions.push("Try providing more detailed responses to match your partner's conversation style");
    }

    return suggestions;
  }

  // Get analytics for admin
  getAnalytics() {
    const users = Array.from(this.userSessions.keys());
    const stats = {
      totalUsers: users.length,
      totalMessages: users.reduce((sum, userId) => {
        const session = this.userSessions.get(userId);
        return sum + (session?.messageCount || 0);
      }, 0),
      averageMessageLength: 0,
      averageResponseTime: 0,
      mostCommonTopics: this.getMostCommonTopics(),
      userEngagement: this.calculateOverallEngagement()
    };

    // Calculate averages
    let totalLength = 0;
    let totalResponseTime = 0;
    let userCount = 0;

    users.forEach(userId => {
      const behavior = this.getUserBehaviorProfile(userId);
      totalLength += behavior.averageMessageLength;
      totalResponseTime += behavior.averageResponseTime;
      userCount++;
    });

    stats.averageMessageLength = userCount > 0 ? totalLength / userCount : 0;
    stats.averageResponseTime = userCount > 0 ? totalResponseTime / userCount : 0;

    return stats;
  }

  // Get most common topics across all users
  getMostCommonTopics() {
    const topicCounts = new Map();
    
    this.userSessions.forEach(session => {
      session.topics.forEach(topic => {
        topicCounts.set(topic, (topicCounts.get(topic) || 0) + 1);
      });
    });

    return Array.from(topicCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([topic, count]) => ({ topic, count }));
  }

  // Calculate overall engagement score
  calculateOverallEngagement() {
    const users = Array.from(this.userSessions.values());
    if (users.length === 0) return 0;

    const totalEngagement = users.reduce((sum, session) => {
      const messagesPerMinute = session.messageCount / 
        ((Date.now() - session.lastMessageTime + 60000) / 60000);
      return sum + Math.min(1, messagesPerMinute / 5);
    }, 0);

    return totalEngagement / users.length;
  }
}

module.exports = TrackingEngine;