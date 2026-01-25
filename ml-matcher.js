const tf = require('@tensorflow/tfjs-node');
const natural = require('natural');

class MLMatchingEngine {
  constructor() {
    this.userEmbeddings = new Map();
    this.interestEmbeddings = new Map();
    this.similarityModel = null;
    this.classifier = null;
    this.isTraining = false;
    
    // Initialize NLP tools
    this.tokenizer = new natural.WordTokenizer();
    this.tfidf = new natural.TfIdf();
    this.sentimentAnalyzer = new natural.SentimentAnalyzer();
    
    this.loadOrTrainModel();
  }

  // Generate user embedding from profile
  generateUserEmbedding(userProfile) {
    const features = [];
    
    // Demographic features (normalized)
    if (userProfile.age) {
      features.push(userProfile.age / 100); // Normalize age
    }
    
    if (userProfile.gender) {
      // One-hot encoding for gender
      const genderMap = { 'male': [1, 0, 0], 'female': [0, 1, 0], 'other': [0, 0, 1] };
      features.push(...(genderMap[userProfile.gender] || [0, 0, 1]));
    }
    
    // Interest embeddings
    const interestVector = this.generateInterestEmbedding(userProfile.interests || []);
    features.push(...interestVector);
    
    // Personality traits
    const personality = userProfile.personalityTraits || {};
    features.push(
      personality.openness || 0.5,
      personality.conscientiousness || 0.5,
      personality.extraversion || 0.5,
      personality.agreeableness || 0.5,
      personality.neuroticism || 0.5
    );
    
    // Chat behavior features
    const behavior = userProfile.behavior || {};
    features.push(
      (behavior.averageMessageLength || 50) / 200, // Normalize
      (behavior.averageResponseTime || 30) / 120,  // Normalize
      behavior.engagementScore || 0.5,
      behavior.sentimentAverage || 0
    );
    
    // Convert to tensor
    return tf.tensor2d([features]);
  }

  // Generate interest embedding using TF-IDF
  generateInterestEmbedding(interests) {
    const allInterests = Array.from(this.interestEmbeddings.keys());
    if (allInterests.length === 0) {
      return Array(50).fill(0); // Return empty embedding
    }
    
    // Create TF-IDF vector
    const vector = Array(allInterests.length).fill(0);
    interests.forEach(interest => {
      const index = allInterests.indexOf(interest);
      if (index !== -1) {
        vector[index] = 1;
      }
    });
    
    return vector.slice(0, 50); // Limit to 50 dimensions
  }

  // Calculate cosine similarity between two users
  async calculateSimilarity(userIdA, userIdB) {
    const embeddingA = this.userEmbeddings.get(userIdA);
    const embeddingB = this.userEmbeddings.get(userIdB);
    
    if (!embeddingA || !embeddingB) {
      return 0.5; // Default similarity
    }
    
    // Calculate cosine similarity
    const dotProduct = tf.sum(tf.mul(embeddingA, embeddingB));
    const normA = tf.norm(embeddingA);
    const normB = tf.norm(embeddingB);
    const similarity = dotProduct.div(normA.mul(normB));
    
    const similarityValue = (await similarity.data())[0];
    return isNaN(similarityValue) ? 0.5 : similarityValue;
  }

  // Predict chat success probability
  async predictChatSuccess(userIdA, userIdB) {
    if (!this.classifier) {
      return 0.7; // Default probability
    }
    
    try {
      const features = await this.extractPredictionFeatures(userIdA, userIdB);
      const prediction = this.classifier.predict(features);
      const probability = (await prediction.data())[0];
      
      return Math.max(0, Math.min(1, probability));
    } catch (error) {
      console.error('Prediction error:', error);
      return 0.7;
    }
  }

  // Extract features for prediction
  async extractPredictionFeatures(userIdA, userIdB) {
    const similarity = await this.calculateSimilarity(userIdA, userIdB);
    const userA = this.getUserProfile(userIdA);
    const userB = this.getUserProfile(userIdB);
    
    const features = [
      similarity,
      userA?.behavior?.engagementScore || 0.5,
      userB?.behavior?.engagementScore || 0.5,
      Math.abs((userA?.personalityTraits?.extraversion || 0.5) - 
               (userB?.personalityTraits?.extraversion || 0.5)),
      Math.abs((userA?.personalityTraits?.agreeableness || 0.5) - 
               (userB?.personalityTraits?.agreeableness || 0.5))
    ];
    
    return tf.tensor2d([features]);
  }

  // Train model on successful chat data
  async trainModel(trainingData) {
    if (this.isTraining) return;
    
    this.isTraining = true;
    console.log('Training ML model...');
    
    try {
      // Prepare training data
      const { features, labels } = this.prepareTrainingData(trainingData);
      
      // Create model
      this.classifier = tf.sequential({
        layers: [
          tf.layers.dense({ inputShape: [features.shape[1]], units: 64, activation: 'relu' }),
          tf.layers.dropout({ rate: 0.2 }),
          tf.layers.dense({ units: 32, activation: 'relu' }),
          tf.layers.dropout({ rate: 0.2 }),
          tf.layers.dense({ units: 1, activation: 'sigmoid' })
        ]
      });
      
      // Compile model
      this.classifier.compile({
        optimizer: tf.train.adam(0.001),
        loss: 'binaryCrossentropy',
        metrics: ['accuracy']
      });
      
      // Train model
      await this.classifier.fit(features, labels, {
        epochs: 50,
        batchSize: 32,
        validationSplit: 0.2,
        callbacks: {
          onEpochEnd: (epoch, logs) => {
            if (epoch % 10 === 0) {
              console.log(`Epoch ${epoch}: loss = ${logs.loss.toFixed(4)}, accuracy = ${logs.acc.toFixed(4)}`);
            }
          }
        }
      });
      
      console.log('Model training complete');
      
      // Save model
      await this.saveModel();
      
    } catch (error) {
      console.error('Training error:', error);
    } finally {
      this.isTraining = false;
    }
  }

  // Prepare training data from chat history
  prepareTrainingData(trainingData) {
    const featuresArray = [];
    const labelsArray = [];
    
    trainingData.forEach(record => {
      const { userA, userB, success, chatDuration, messageCount } = record;
      
      // Extract features
      const features = [
        userA.engagementScore || 0.5,
        userB.engagementScore || 0.5,
        Math.abs(userA.personalityTraits?.extraversion || 0.5 - 
                 userB.personalityTraits?.extraversion || 0.5),
        Math.abs(userA.personalityTraits?.agreeableness || 0.5 - 
                 userB.personalityTraits?.agreeableness || 0.5),
        chatDuration / 3600000, // Convert ms to hours
        messageCount / 100 // Normalize
      ];
      
      featuresArray.push(features);
      labelsArray.push(success ? 1 : 0);
    });
    
    return {
      features: tf.tensor2d(featuresArray),
      labels: tf.tensor2d(labelsArray, [labelsArray.length, 1])
    };
  }

  // Find optimal matches using ML
  async findOptimalMatches(userId, candidateIds, k = 5) {
    const userEmbedding = this.userEmbeddings.get(userId);
    if (!userEmbedding) return candidateIds.slice(0, k);
    
    const similarities = await Promise.all(
      candidateIds.map(async candidateId => {
        const similarity = await this.calculateSimilarity(userId, candidateId);
        const successProb = await this.predictChatSuccess(userId, candidateId);
        
        // Combined score (weighted)
        return {
          candidateId,
          score: (similarity * 0.6 + successProb * 0.4) * 100
        };
      })
    );
    
    // Sort by score and return top k
    return similarities
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(item => item.candidateId);
  }

  // Update user embedding
  updateUserEmbedding(userId, newData) {
    const currentEmbedding = this.userEmbeddings.get(userId);
    const newEmbedding = this.generateUserEmbedding(newData);
    
    // Exponential moving average for smooth updates
    if (currentEmbedding) {
      const updated = tf.add(
        tf.mul(currentEmbedding, 0.7),
        tf.mul(newEmbedding, 0.3)
      );
      this.userEmbeddings.set(userId, updated);
    } else {
      this.userEmbeddings.set(userId, newEmbedding);
    }
  }

  // Get user profile from database (placeholder)
  getUserProfile(userId) {
    // In production, this would fetch from database
    return {};
  }

  // Load or train model
  async loadOrTrainModel() {
    try {
      // Try to load pre-trained model
      await this.loadModel();
      console.log('ML model loaded successfully');
    } catch (error) {
      console.log('No pre-trained model found, will train when data is available');
    }
  }

  // Load pre-trained model
  async loadModel() {
    // Implementation for loading saved model
    // This would typically load from file system or cloud storage
  }

  // Save trained model
  async saveModel() {
    // Implementation for saving model
  }

  // Get model info
  getModelInfo() {
    return {
      isTrained: this.classifier !== null,
      embeddingSize: this.userEmbeddings.size,
      lastTrainingTime: this.lastTrainingTime,
      accuracy: this.lastAccuracy
    };
  }
}

module.exports = MLMatchingEngine;