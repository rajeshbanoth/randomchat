class EnhancedMatchingEngine {
  constructor() {
    this.waitingUsers = new Map();
    this.userScores = new Map();
    this.blockedPairs = new Map();
    this.matchHistory = new Map();
    this.compatibilityCache = new Map();
    this.userPreferences = new Map();
    
    // Enhanced configuration
    this.config = {
      // Matching thresholds
      minCompatibility: 65,
      minVideoCompatibility: 70,
      
      // Weights
      interestWeight: 0.35,
      demographicWeight: 0.25,
      chatModeWeight: 0.30,
      behaviorWeight: 0.10,
      
      // Bonuses and penalties
      videoModeBonus: 0.20,
      videoTextPenalty: 0.15,
      premiumBonus: 0.15,
      sameGenderBonus: 0.10,
      ageRangeBonus: 0.10,
      
      // Timing
      maxWaitTime: 45000,
      priorityTime: 15000,
      
      // Limits
      maxAgeDifference: 25,
      optimalAgeDifference: 5,
      maxHistoryPenalty: 0.30,
      
      // Debug mode
      debug: true
    };
    
    console.log('🎯 Enhanced Matching Engine initialized');
  }

  addUser(userId, criteria) {
    if (!userId || !criteria) {
      console.log('❌ Invalid user data for matching');
      return null;
    }
    
    const userData = {
      ...criteria,
      userId: userId,
      joinedAt: Date.now(),
      attempts: (criteria.attempts || 0) + 1,
      lastMatch: null,
      searchMode: criteria.profile?.chatMode || 'text',
      preferences: criteria.preferences || {}
    };
    
    this.waitingUsers.set(userId, userData);
    
    // Store preferences separately for quick access
    this.userPreferences.set(userId, {
      chatMode: criteria.profile?.chatMode || 'text',
      gender: criteria.profile?.gender,
      age: criteria.profile?.age,
      interests: criteria.profile?.interests || [],
      genderPreference: criteria.profile?.genderPreference || 'any',
      ageRange: criteria.profile?.ageRange || { min: 18, max: 60 }
    });
    
    // Pre-compute compatibility scores
    this.precomputeCompatibility(userId);
    
    if (this.config.debug) {
      console.log(`✅ Added user ${userId} (${userData.searchMode}) to matching engine`);
    }
    
    return userData;
  }

  removeUser(userId) {
    if (!userId) return;
    
    this.waitingUsers.delete(userId);
    this.userScores.delete(userId);
    this.userPreferences.delete(userId);
    
    // Remove from other users' compatibility maps
    this.waitingUsers.forEach((data, id) => {
      if (this.userScores.has(id)) {
        this.userScores.get(id).delete(userId);
      }
    });
    
    // Clear cache entries
    for (const key of this.compatibilityCache.keys()) {
      if (key.includes(userId)) {
        this.compatibilityCache.delete(key);
      }
    }
    
    if (this.config.debug) {
      console.log(`❌ Removed user ${userId} from matching engine`);
    }
  }

  precomputeCompatibility(userId) {
    const user = this.waitingUsers.get(userId);
    if (!user) return;
    
    const scores = new Map();
    const userPrefs = this.userPreferences.get(userId);
    
    this.waitingUsers.forEach((otherUser, otherId) => {
      if (otherId === userId) return;
      
      // Skip blocked pairs
      if (this.isBlocked(userId, otherId)) {
        scores.set(otherId, 0);
        return;
      }
      
      // Quick compatibility check based on preferences
      if (!this.checkBasicCompatibility(userPrefs, this.userPreferences.get(otherId))) {
        scores.set(otherId, 0);
        return;
      }
      
      // Calculate detailed compatibility
      const compatibility = this.calculateCompatibility(user, otherUser);
      scores.set(otherId, compatibility);
      
      // Also update the other user's scores
      if (!this.userScores.has(otherId)) {
        this.userScores.set(otherId, new Map());
      }
      this.userScores.get(otherId).set(userId, compatibility);
    });
    
    this.userScores.set(userId, scores);
    
    if (this.config.debug && scores.size > 0) {
      console.log(`📊 Precomputed scores for ${userId}: ${scores.size} potential matches`);
    }
  }

  checkBasicCompatibility(prefsA, prefsB) {
    if (!prefsA || !prefsB) return false;
    
    // Check gender preference
    if (prefsA.genderPreference !== 'any' && prefsB.gender && 
        prefsA.genderPreference !== prefsB.gender) {
      return false;
    }
    
    if (prefsB.genderPreference !== 'any' && prefsA.gender && 
        prefsB.genderPreference !== prefsA.gender) {
      return false;
    }
    
    // Check age range
    if (prefsA.ageRange && prefsB.age) {
      if (prefsB.age < prefsA.ageRange.min || prefsB.age > prefsA.ageRange.max) {
        return false;
      }
    }
    
    if (prefsB.ageRange && prefsA.age) {
      if (prefsA.age < prefsB.ageRange.min || prefsA.age > prefsB.ageRange.max) {
        return false;
      }
    }
    
    // Check chat mode compatibility (video users prefer video)
    if (prefsA.chatMode === 'video' && prefsB.chatMode === 'text') {
      // Video users can match with text users, but with penalty
      return true;
    }
    
    return true;
  }

  findMatch(userId) {
    const user = this.waitingUsers.get(userId);
    if (!user) {
      if (this.config.debug) console.log(`❌ User ${userId} not found for matching`);
      return null;
    }
    
    const userMode = user.searchMode || 'text';
    const isVideoUser = userMode === 'video';
    const scores = this.userScores.get(userId);
    
    if (!scores || scores.size === 0) {
      if (this.config.debug) console.log(`⚠️ No scores for ${userId}`);
      return null;
    }
    
    // Get minimum compatibility threshold
    const minScore = isVideoUser ? this.config.minVideoCompatibility : this.config.minCompatibility;
    
    if (this.config.debug) {
      console.log(`🔍 Finding match for ${userId} (${userMode}), min score: ${minScore}`);
      console.log(`   Waiting users: ${this.waitingUsers.size}`);
    }
    
    // Filter and sort matches
    const potentialMatches = Array.from(scores.entries())
      .filter(([partnerId, score]) => {
        if (score < minScore) return false;
        
        const partner = this.waitingUsers.get(partnerId);
        if (!partner) return false;
        
        const partnerMode = partner.searchMode || 'text';
        
        // For video users, prioritize video partners
        if (isVideoUser && partnerMode === 'video') {
          return true;
        }
        
        return true;
      })
      .sort((a, b) => b[1] - a[1]);
    
    if (potentialMatches.length === 0) {
      if (this.config.debug) console.log(`   No potential matches found`);
      return null;
    }
    
    if (this.config.debug) {
      console.log(`   Found ${potentialMatches.length} potential matches`);
      potentialMatches.slice(0, 3).forEach(([id, score]) => {
        const partner = this.waitingUsers.get(id);
        console.log(`   - ${id}: ${score.toFixed(1)}% (${partner?.searchMode || 'text'})`);
      });
    }
    
    // Apply priority adjustments
    const prioritizedMatches = this.applyPriority(userId, potentialMatches);
    
    if (prioritizedMatches.length === 0) {
      if (this.config.debug) console.log(`   No matches after priority adjustment`);
      return null;
    }
    
    // Pick the best match
    const [partnerId, finalScore] = prioritizedMatches[0];
    const partner = this.waitingUsers.get(partnerId);
    const partnerMode = partner.searchMode || 'text';
    const matchMode = (userMode === 'video' && partnerMode === 'video') ? 'video' : 'text';
    
    if (this.config.debug) {
      console.log(`🎯 Selected match: ${partnerId} (${partnerMode}) - ${finalScore.toFixed(1)}%`);
    }
    
    // Record match
    this.recordMatch(userId, partnerId);
    
    return {
      partnerId,
      score: finalScore,
      matchType: this.getMatchType(finalScore),
      mode: matchMode,
      compatibility: Math.round(finalScore)
    };
  }

  findVideoMatch(userId) {
    const user = this.waitingUsers.get(userId);
    if (!user || (user.searchMode || 'text') !== 'video') {
      return null;
    }
    
    const scores = this.userScores.get(userId);
    if (!scores) return null;
    
    if (this.config.debug) {
      console.log(`🎥 Looking for video match for ${userId}`);
    }
    
    // Filter for video users only
    const videoMatches = Array.from(scores.entries())
      .filter(([partnerId, score]) => {
        if (score < this.config.minVideoCompatibility) return false;
        
        const partner = this.waitingUsers.get(partnerId);
        if (!partner) return false;
        
        const partnerMode = partner.searchMode || 'text';
        return partnerMode === 'video';
      })
      .sort((a, b) => b[1] - a[1]);
    
    if (videoMatches.length === 0) {
      if (this.config.debug) console.log(`   No video matches found`);
      return null;
    }
    
    if (this.config.debug) {
      console.log(`   Found ${videoMatches.length} video matches`);
    }
    
    // Apply priority for video matches
    const prioritizedMatches = this.applyPriority(userId, videoMatches);
    
    if (prioritizedMatches.length === 0) {
      return null;
    }
    
    const [partnerId, finalScore] = prioritizedMatches[0];
    
    this.recordMatch(userId, partnerId);
    
    return {
      partnerId,
      score: finalScore,
      matchType: this.getMatchType(finalScore),
      mode: 'video',
      compatibility: Math.round(finalScore)
    };
  }

  calculateCompatibility(userA, userB) {
    const cacheKey = `${userA.userId}_${userB.userId}`;
    if (this.compatibilityCache.has(cacheKey)) {
      return this.compatibilityCache.get(cacheKey);
    }
    
    let score = 50; // Base score
    
    // Interest compatibility (35%)
    const interestScore = this.calculateInterestScore(userA.profile, userB.profile);
    score += interestScore * this.config.interestWeight * 50;
    
    // Demographic compatibility (25%)
    const demographicScore = this.calculateDemographicScore(userA.profile, userB.profile);
    score += demographicScore * this.config.demographicWeight * 50;
    
    // Chat mode compatibility (30%)
    const chatModeScore = this.calculateChatModeScore(userA, userB);
    score += chatModeScore * this.config.chatModeWeight * 50;
    
    // Behavior compatibility (10%)
    const behaviorScore = this.calculateBehaviorScore(userA, userB);
    score += behaviorScore * this.config.behaviorWeight * 50;
    
    // Apply bonuses and penalties
    const adjustments = this.calculateAdjustments(userA, userB);
    score *= (1 + adjustments);
    
    // Ensure score is between 0-100
    const finalScore = Math.min(100, Math.max(0, Math.round(score * 10) / 10));
    
    this.compatibilityCache.set(cacheKey, finalScore);
    return finalScore;
  }

  calculateInterestScore(profileA, profileB) {
    const interestsA = profileA.interests || [];
    const interestsB = profileB.interests || [];
    
    if (interestsA.length === 0 && interestsB.length === 0) return 0.5;
    
    const setA = new Set(interestsA.map(i => i.toLowerCase().trim()));
    const setB = new Set(interestsB.map(i => i.toLowerCase().trim()));
    
    const common = new Set([...setA].filter(x => setB.has(x)));
    const union = new Set([...setA, ...setB]);
    
    // Jaccard similarity
    const jaccard = union.size === 0 ? 0 : common.size / union.size;
    
    // Boost for having common interests
    const commonBoost = common.size > 0 ? 0.3 : 0;
    
    return Math.min(1, jaccard * 0.7 + commonBoost);
  }

  calculateDemographicScore(profileA, profileB) {
    let score = 0.5;
    
    // Age compatibility
    if (profileA.age && profileB.age) {
      const ageDiff = Math.abs(profileA.age - profileB.age);
      
      if (ageDiff <= this.config.optimalAgeDifference) {
        score += 0.3; // Perfect age match
      } else if (ageDiff <= this.config.maxAgeDifference) {
        // Linear decrease
        const agePenalty = (ageDiff - this.config.optimalAgeDifference) / 
                          (this.config.maxAgeDifference - this.config.optimalAgeDifference);
        score += 0.3 * (1 - agePenalty);
      }
    }
    
    // Gender preference matching
    if (profileA.genderPreference && profileB.gender) {
      if (profileA.genderPreference === 'any' || 
          profileA.genderPreference === profileB.gender) {
        score += 0.15;
      }
    }
    
    if (profileB.genderPreference && profileA.gender) {
      if (profileB.genderPreference === 'any' || 
          profileB.genderPreference === profileA.gender) {
        score += 0.15;
      }
    }
    
    // Same gender bonus
    if (profileA.gender && profileB.gender && 
        profileA.gender === profileB.gender &&
        profileA.gender !== 'not-specified') {
      score += this.config.sameGenderBonus;
    }
    
    return Math.min(1, score);
  }

  calculateChatModeScore(userA, userB) {
    const modeA = userA.searchMode || userA.profile?.chatMode || 'text';
    const modeB = userB.searchMode || userB.profile?.chatMode || 'text';
    
    // Perfect match for video
    if (modeA === 'video' && modeB === 'video') {
      return 1.0;
    }
    
    // Good match for text
    if (modeA === 'text' && modeB === 'text') {
      return 0.8;
    }
    
    // Mixed modes - penalized but allowed
    return 0.4;
  }

  calculateBehaviorScore(userA, userB) {
    let score = 0.5;
    
    // Wait time priority
    const waitA = Date.now() - userA.joinedAt;
    const waitB = Date.now() - userB.joinedAt;
    const avgWait = (waitA + waitB) / 2;
    
    if (avgWait > 5000) {
      const waitBoost = Math.min(0.3, avgWait / this.config.priorityTime);
      score += waitBoost;
    }
    
    // Failed attempts priority
    const attemptsA = userA.attempts || 0;
    const attemptsB = userB.attempts || 0;
    const avgAttempts = (attemptsA + attemptsB) / 2;
    
    if (avgAttempts > 0) {
      const attemptBoost = Math.min(0.2, avgAttempts * 0.05);
      score += attemptBoost;
    }
    
    return Math.min(1, score);
  }

  calculateAdjustments(userA, userB) {
    let adjustment = 0;
    
    // Premium user bonus
    if (userA.profile.priority > 1 || userB.profile.priority > 1) {
      adjustment += this.config.premiumBonus;
    }
    
    // Video mode bonus
    const modeA = userA.searchMode || userA.profile?.chatMode || 'text';
    const modeB = userB.searchMode || userB.profile?.chatMode || 'text';
    
    if (modeA === 'video' && modeB === 'video') {
      adjustment += this.config.videoModeBonus;
    }
    
    // Video-text mismatch penalty
    if ((modeA === 'video' && modeB === 'text') || 
        (modeA === 'text' && modeB === 'video')) {
      adjustment -= this.config.videoTextPenalty;
    }
    
    // Age range bonus
    const profileA = userA.profile;
    const profileB = userB.profile;
    
    if (profileA.ageRange && profileB.age && 
        profileB.age >= profileA.ageRange.min && 
        profileB.age <= profileA.ageRange.max) {
      adjustment += this.config.ageRangeBonus / 2;
    }
    
    if (profileB.ageRange && profileA.age && 
        profileA.age >= profileB.ageRange.min && 
        profileA.age <= profileB.ageRange.max) {
      adjustment += this.config.ageRangeBonus / 2;
    }
    
    // History penalty
    const historyKey = `${userA.userId}_${userB.userId}`;
    const historyCount = this.matchHistory.get(historyKey) || 0;
    
    if (historyCount > 0) {
      const penalty = Math.min(this.config.maxHistoryPenalty, historyCount * 0.1);
      adjustment -= penalty;
    }
    
    return Math.max(-0.3, Math.min(0.3, adjustment));
  }

  applyPriority(userId, matches) {
    const user = this.waitingUsers.get(userId);
    if (!user) return matches;
    
    return matches.map(([partnerId, score]) => {
      const partner = this.waitingUsers.get(partnerId);
      if (!partner) return [partnerId, score];
      
      let priorityScore = score;
      
      // Wait time boost
      const waitA = Date.now() - user.joinedAt;
      const waitB = Date.now() - partner.joinedAt;
      const avgWait = (waitA + waitB) / 2;
      
      if (avgWait > 10000) {
        const waitBoost = Math.min(0.4, avgWait / this.config.maxWaitTime);
        priorityScore *= (1 + waitBoost);
      }
      
      // Priority based on user priority (premium)
      const userPriority = user.profile.priority || 1;
      const partnerPriority = partner.profile.priority || 1;
      const avgPriority = (userPriority + partnerPriority) / 2;
      
      priorityScore *= avgPriority;
      
      return [partnerId, priorityScore];
    }).sort((a, b) => b[1] - a[1]);
  }

  recordMatch(userId, partnerId) {
    const key1 = `${userId}_${partnerId}`;
    const key2 = `${partnerId}_${userId}`;
    
    this.matchHistory.set(key1, (this.matchHistory.get(key1) || 0) + 1);
    this.matchHistory.set(key2, (this.matchHistory.get(key2) || 0) + 1);
    
    // Update user attempts
    const user = this.waitingUsers.get(userId);
    const partner = this.waitingUsers.get(partnerId);
    
    if (user) user.attempts = (user.attempts || 0) + 1;
    if (partner) partner.attempts = (partner.attempts || 0) + 1;
  }

  getMatchType(score) {
    if (score >= 85) return 'excellent';
    if (score >= 70) return 'good';
    if (score >= 60) return 'fair';
    return 'basic';
  }

  blockUser(userId, blockUserId) {
    if (!this.blockedPairs.has(userId)) {
      this.blockedPairs.set(userId, new Set());
    }
    this.blockedPairs.get(userId).add(blockUserId);
    
    // Remove compatibility scores
    if (this.userScores.has(userId)) {
      this.userScores.get(userId).delete(blockUserId);
    }
    if (this.userScores.has(blockUserId)) {
      this.userScores.get(blockUserId).delete(userId);
    }
    
    if (this.config.debug) {
      console.log(`🚫 User ${userId} blocked ${blockUserId}`);
    }
  }

  isBlocked(userId, otherId) {
    return this.blockedPairs.get(userId)?.has(otherId) || 
           this.blockedPairs.get(otherId)?.has(userId);
  }

  getStats() {
    const videoUsers = Array.from(this.waitingUsers.values())
      .filter(user => (user.searchMode || user.profile?.chatMode || 'text') === 'video').length;
    
    const textUsers = Array.from(this.waitingUsers.values())
      .filter(user => (user.searchMode || user.profile?.chatMode || 'text') === 'text').length;
    
    let totalCompatibility = 0;
    let compatibilityCount = 0;
    
    this.userScores.forEach(scores => {
      scores.forEach(score => {
        totalCompatibility += score;
        compatibilityCount++;
      });
    });
    
    const avgCompatibility = compatibilityCount > 0 ? 
      Math.round(totalCompatibility / compatibilityCount) : 0;
    
    return {
      waitingUsers: this.waitingUsers.size,
      videoUsers,
      textUsers,
      totalMatches: Array.from(this.matchHistory.values()).reduce((a, b) => a + b, 0) / 2,
      averageCompatibility: avgCompatibility,
      blockedPairs: Array.from(this.blockedPairs.values()).reduce((sum, set) => sum + set.size, 0),
      cacheSize: this.compatibilityCache.size,
      scoreCount: compatibilityCount
    };
  }

  // Debug method to see all waiting users
  debugWaitingUsers() {
    console.log('\n=== WAITING USERS DEBUG ===');
    console.log(`Total waiting: ${this.waitingUsers.size}`);
    
    this.waitingUsers.forEach((user, id) => {
      console.log(`\nUser: ${id}`);
      console.log(`  Mode: ${user.searchMode || 'text'}`);
      console.log(`  Age: ${user.profile?.age || 'N/A'}`);
      console.log(`  Gender: ${user.profile?.gender || 'N/A'}`);
      console.log(`  Interests: ${user.profile?.interests?.join(', ') || 'None'}`);
      console.log(`  Waiting: ${Math.floor((Date.now() - user.joinedAt) / 1000)}s`);
      
      const scores = this.userScores.get(id);
      if (scores && scores.size > 0) {
        console.log(`  Potential matches: ${scores.size}`);
        const top3 = Array.from(scores.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([pid, score]) => `${pid}: ${score.toFixed(1)}%`);
        console.log(`  Top matches: ${top3.join(', ')}`);
      } else {
        console.log(`  No potential matches`);
      }
    });
    
    console.log('===========================\n');
  }
}

module.exports = EnhancedMatchingEngine;