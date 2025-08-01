const Session = require("../models/Session");
const Question = require("../models/Question");
const { generateFeedback } = require("./aiController");
const { calculateRemainingTime } = require("../utils/timerUtils");
const stringSimilarity = require('string-similarity');
const axios = require('axios');
const API_BASE = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 5000}`;

// @desc    Create a new session and linked questions
// @route   POST /api/sessions/create
// @access  Private
exports.createSession = async (req, res) => {
  try {
    const { role, experience, topicsToFocus, description, questions } =
      req.body;
    const userId = req.user._id; // Assuming you have a middleware setting req.user

    const session = await Session.create({
      user: userId,
      role,
      experience,
      topicsToFocus,
      description,
    });

    const questionDocs = await Promise.all(
      questions.map(async (q) => {
        const question = await Question.create({
          session: session._id,
          question: q.question,
          answer: q.answer,
          type: q.type, // Save the type field
        });
        return question._id;
      })
    );

    session.questions = questionDocs;
    await session.save();

    res.status(201).json({ success: true, session });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

// @desc    Get all sessions for the logged-in user
// @route   GET /api/sessions/my-sessions
// @access  Private
exports.getMySessions = async (req, res) => {
  try {
    const sessions = await Session.find({ user: req.user.id })
      .sort({ createdAt: -1 })
      .populate("questions");
    res.status(200).json(sessions);
  } catch (error) {
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

// @desc    Get a session by ID with populated questions
// @route   GET /api/sessions/:id
// @access  Private
exports.getSessionById = async (req, res) => {
  try {
    const session = await Session.findById(req.params.id).populate("questions");

    if (!session) {
      return res
        .status(404)
        .json({ success: false, message: "Session not found" });
    }

    // Calculate remaining time
    const remainingTime = calculateRemainingTime(session.timerStartTime, session.timerDuration);
    
    res.status(200).json({ 
      success: true, 
      session: {
        ...session.toObject(),
        remainingTime
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

// @desc    Delete a session and its questions
// @route   DELETE /api/sessions/:id
// @access  Private
exports.deleteSession = async (req, res) => {
  try {
    const session = await Session.findById(req.params.id);

    if (!session) {
      return res.status(404).json({ message: "Session not found" });
    }

    // Check if the logged-in user owns this session
    if (session.user.toString() !== req.user.id) {
      return res
        .status(401)
        .json({ message: "Not authorized to delete this session" });
    }

    // First, delete all questions linked to this session
    await Question.deleteMany({ session: session._id });

    // Then, delete the session
    await session.deleteOne();

    res.status(200).json({ message: "Session deleted successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server Error" });
  }
};

// @desc    Submit all answers and lock the session
// @route   POST /api/sessions/:id/submit
// @access  Private
exports.finalSubmitSession = async (req, res) => {
  try {
    const { answers } = req.body;

    // Allow submission even with no answers - feedback will handle this case
    if (!answers || typeof answers !== 'object') {
      answers = {};
    }
    
    console.log('=== DEBUG: Request body answers ===');
    console.log('Answers from request body:', answers);
    console.log('Number of answers in request:', Object.keys(answers).length);
    console.log('=== END DEBUG ===');

    const session = await Session.findById(req.params.id).populate("questions");
    if (!session) {
      return res.status(404).json({ message: "Session not found" });
    }
    
    console.log('=== DEBUG: Database questions ===');
    session.questions.forEach((q, index) => {
      console.log(`DB Question ${index + 1}:`, {
        questionId: q._id,
        hasUserAnswer: !!q.userAnswer,
        userAnswerLength: q.userAnswer ? q.userAnswer.length : 0,
        userAnswerPreview: q.userAnswer ? q.userAnswer.substring(0, 50) + '...' : 'EMPTY'
      });
    });
    console.log('=== END DEBUG ===');

    // Check if already submitted
    if (session.isFinalSubmitted) {
      return res.status(400).json({ message: "Session already submitted" });
    }

    // Check ownership
    if (session.user.toString() !== req.user.id) {
      return res.status(403).json({ message: "Not authorized to submit this session" });
    }

    // Validate and update answers
    const updates = [];
    for (const question of session.questions) {
      const userAnswer = answers[question._id];
      if (userAnswer) {
        updates.push(
          Question.findByIdAndUpdate(
            question._id,
            { userAnswer },
            { new: true }
          )
        );
      }
    }

    await Promise.all(updates);

    // Calculate submission time
    const submissionTime = Math.floor((new Date() - new Date(session.timerStartTime)) / 1000);
    
    // Lock session
    session.isFinalSubmitted = true;
    session.submissionTime = submissionTime;
    await session.save();

    // Calculate scoring based on correct answers
    let correctAnswers = 0;
    let totalQuestions = session.questions.length;
    let answeredQuestions = 0;
    
    const token = req.headers.authorization;
    await Promise.all(session.questions.map(async (q) => {
      // Get the user answer from the database (updated question) or from request body
      const userAnswer = q.userAnswer || answers[q._id] || "";
      if (!userAnswer || userAnswer.trim() === "") return; // Skip empty answers
      
      answeredQuestions++;
      console.log(`Checking answer for question ${q._id}:`, {
        question: q.question.substring(0, 50) + '...',
        userAnswer: userAnswer.substring(0, 50) + '...',
        correctAnswer: q.answer.substring(0, 50) + '...'
      });
      
      try {
        const aiRes = await axios.post(
          `${API_BASE}/api/ai/check-answer`,
          {
            question: q.question,
            userAnswer,
            correctAnswer: q.answer
          },
          {
            headers: { Authorization: token }
          }
        );
        
        console.log(`AI response for question ${q._id}:`, aiRes.data);
        
        if (aiRes.data && aiRes.data.isCorrect) {
          correctAnswers++;
          console.log(`✅ Question ${q._id} marked as correct`);
        } else {
          console.log(`❌ Question ${q._id} marked as incorrect`);
        }
      } catch (err) {
        console.error(`AI check failed for question ${q._id}:`, err.message);
        // If AI fails, use a more flexible assessment as fallback
        const userAnswerLower = userAnswer.toLowerCase().trim();
        
        // Extract key technical terms and concepts that indicate understanding
        const technicalTerms = ['javascript', 'java', 'python', 'react', 'node', 'express', 'mongodb', 'sql', 'api', 'http', 'json', 'html', 'css', 'git', 'docker', 'kubernetes', 'aws', 'azure', 'database', 'server', 'client', 'frontend', 'backend', 'fullstack', 'microservices', 'rest', 'graphql', 'authentication', 'authorization', 'encryption', 'security', 'testing', 'deployment', 'ci/cd', 'agile', 'scrum', 'oop', 'functional', 'async', 'promise', 'callback', 'closure', 'hoisting', 'prototype', 'inheritance', 'polymorphism', 'encapsulation', 'abstraction', 'interface', 'abstract', 'static', 'final', 'volatile', 'synchronized', 'thread', 'process', 'memory', 'garbage', 'collection', 'algorithm', 'data structure', 'array', 'linked list', 'stack', 'queue', 'tree', 'graph', 'hash', 'map', 'set', 'sort', 'search', 'binary', 'linear', 'recursion', 'iteration', 'complexity', 'big o', 'time', 'space'];
        
        const userWords = userAnswerLower.split(/\s+/);
        
        // Check for technical term presence (indicates understanding)
        const userTechnicalTerms = userWords.filter(word => 
          technicalTerms.includes(word.toLowerCase())
        );
        
        // Check for meaningful answer length and content
        const meaningfulWords = userWords.filter(word => word.length > 3);
        const hasSubstantialContent = meaningfulWords.length >= 3;
        const hasTechnicalKnowledge = userTechnicalTerms.length >= 1;
        
        // More lenient assessment - if user shows technical knowledge or substantial content
        if (hasTechnicalKnowledge || hasSubstantialContent) {
          correctAnswers++;
          console.log(`✅ Question ${q._id} marked as correct (fallback: technical terms: ${userTechnicalTerms.length}, content words: ${meaningfulWords.length})`);
        } else {
          console.log(`❌ Question ${q._id} marked as incorrect (fallback: insufficient content or technical terms)`);
        }
      }
    }));
    
    // Calculate percentage score
    const percentageScore = totalQuestions > 0 ? Math.round((correctAnswers / totalQuestions) * 100) : 0;

    // Prepare questions array for feedback (include all questions even with empty answers)
    const questionsForFeedback = session.questions.map(q => ({
      question: q.question,
      answer: q.answer,
      userAnswer: q.userAnswer || answers[q._id] || ""
    }));

    // Generate feedback using AI
    const feedbackPrompt = require('../utils/prompts').feedbackPrompt;
    const prompt = feedbackPrompt(session.role, session.experience, session.topicsToFocus, questionsForFeedback, submissionTime);
    
    // Debug log to see what data is being sent
    console.log('=== DEBUG: Questions for feedback ===');
    console.log('Total questions:', session.questions.length);
    console.log('Answered questions:', answeredQuestions);
    console.log('Correct answers:', correctAnswers);
    console.log('Percentage score:', percentageScore);
    questionsForFeedback.forEach((q, index) => {
      console.log(`Question ${index + 1}:`, {
        question: q.question.substring(0, 50) + '...',
        userAnswer: q.userAnswer ? q.userAnswer.substring(0, 50) + '...' : 'EMPTY',
        hasAnswer: q.userAnswer && q.userAnswer.trim() !== '',
        answerLength: q.userAnswer ? q.userAnswer.length : 0,
        questionId: session.questions[index]._id
      });
    });
    console.log('=== END DEBUG ===');
    
    // Call AI directly
    let feedbackResponse = null;
    try {
      const { GoogleGenAI } = require("@google/genai");
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-2.0-flash-lite",
        contents: prompt,
      });
      
      let rawText = response.text;
      const cleanedText = rawText
        .replace(/^```json\s*/, "")
        .replace(/```$/, "")
        .trim();
      feedbackResponse = JSON.parse(cleanedText);
    } catch (aiError) {
      console.error("AI feedback generation failed:", aiError);
      // Create fallback feedback
      feedbackResponse = {
        skillsBreakdown: [
          { skill: "Technical Knowledge", score: 0 },
          { skill: "Problem Solving", score: 0 },
          { skill: "Communication", score: 0 },
          { skill: "Code Quality", score: 0 },
          { skill: "System Design", score: 0 }
        ],
        strengths: ["Session completed successfully"],
        areasForImprovement: ["AI feedback generation failed", "Please try again later"],
        summary: "Session completed. AI feedback generation encountered an error."
      };
    }

    // Calculate skill scores based on performance
    const calculateSkillScores = (percentageScore, answeredCount, totalQuestions) => {
      const baseScore = Math.floor(percentageScore / 20); // Convert percentage to 0-5 scale
      const maxScore = Math.min(5, Math.max(0, baseScore));
      
      return [
        { skill: "Technical Knowledge", score: maxScore },
        { skill: "Problem Solving", score: maxScore },
        { skill: "Communication", score: maxScore },
        { skill: "Code Quality", score: maxScore },
        { skill: "System Design", score: maxScore }
      ];
    };
    
    // Generate strengths and areas for improvement based on performance
    const generateStrengths = (percentageScore, answeredCount, totalQuestions) => {
      if (percentageScore === 0) return [];
      if (percentageScore >= 80) return ["Excellent understanding of concepts", "Strong problem-solving skills", "Good communication of ideas"];
      if (percentageScore >= 60) return ["Good grasp of fundamentals", "Shows potential for growth", "Demonstrates learning ability"];
      if (percentageScore >= 40) return ["Made effort to answer questions", "Shows initiative", "Has basic understanding"];
      return ["Attempted to answer questions", "Shows willingness to learn"];
    };
    
    const generateAreasForImprovement = (percentageScore, answeredCount, totalQuestions) => {
      if (percentageScore === 0) return ["No answers were provided", "Complete all questions to get meaningful feedback"];
      if (percentageScore >= 80) return ["Continue practicing advanced concepts", "Focus on edge cases", "Work on time management"];
      if (percentageScore >= 60) return ["Review fundamental concepts", "Practice more coding problems", "Improve explanation clarity"];
      if (percentageScore >= 40) return ["Study core concepts more thoroughly", "Practice more questions", "Focus on accuracy"];
      return ["Study the basics more thoroughly", "Practice answering all questions", "Focus on understanding concepts"];
    };
    
    const generateSummary = (percentageScore, answeredCount, totalQuestions, correctAnswers) => {
      if (answeredCount === 0) {
        return "No answers were provided for this session. Please complete all questions to receive proper feedback.";
      }
      
      const scoreDescription = percentageScore >= 90 ? "excellent" : 
                             percentageScore >= 80 ? "very good" : 
                             percentageScore >= 70 ? "good" : 
                             percentageScore >= 60 ? "fair" : 
                             percentageScore >= 40 ? "needs improvement" : "poor";
      
      return `You answered ${answeredCount} out of ${totalQuestions} questions with ${correctAnswers} correct answers (${percentageScore}% accuracy). Your performance is ${scoreDescription}. ${answeredCount < totalQuestions ? "Consider answering all questions for a complete assessment." : ""}`;
    };
    
    // Update feedback with calculated scores
    if (feedbackResponse) {
      feedbackResponse.skillsBreakdown = calculateSkillScores(percentageScore, answeredQuestions, totalQuestions);
      feedbackResponse.strengths = generateStrengths(percentageScore, answeredQuestions, totalQuestions);
      feedbackResponse.areasForImprovement = generateAreasForImprovement(percentageScore, answeredQuestions, totalQuestions);
      feedbackResponse.summary = generateSummary(percentageScore, answeredQuestions, totalQuestions, correctAnswers);
    }

    // Ensure feedback is always set with proper scoring
    if (!feedbackResponse) {
      const fallbackScore = Math.floor(percentageScore / 20);
      const maxScore = Math.min(5, Math.max(0, fallbackScore));
      
      feedbackResponse = {
        skillsBreakdown: [
          { skill: "Technical Knowledge", score: maxScore },
          { skill: "Problem Solving", score: maxScore },
          { skill: "Communication", score: maxScore },
          { skill: "Code Quality", score: maxScore },
          { skill: "System Design", score: maxScore }
        ],
        strengths: percentageScore > 0 ? ["Session completed successfully"] : [],
        areasForImprovement: percentageScore === 0 ? ["No answers were provided", "Complete all questions to get meaningful feedback"] : ["Feedback generation failed", "Please try again later"],
        summary: percentageScore === 0 ? "No answers were provided for this session. Please complete all questions to receive proper feedback." : `Session completed with ${percentageScore}% accuracy. Feedback generation encountered an error.`
      };
    }
    
    // Save feedback to session
    session.feedback = feedbackResponse;
    await session.save();
    
    // Debug log
    console.log("Feedback saved to session:", session._id);
    console.log("Feedback data:", feedbackResponse);

    res.status(200).json({ message: "Submitted successfully", score: percentageScore, feedback: feedbackResponse });
  } catch (error) {
    console.error("Final submit error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// @desc    Save user feedback for a session
// @route   POST /api/sessions/:id/user-feedback
// @access  Private
exports.saveUserFeedback = async (req, res) => {
  try {
    const { userFeedback } = req.body;
    const session = await Session.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ message: "Session not found" });
    }
    if (session.user.toString() !== req.user.id) {
      return res.status(403).json({ message: "Not authorized to update feedback for this session" });
    }
    session.userFeedback = userFeedback;
    await session.save();
    res.status(200).json({ message: "User feedback saved successfully", userFeedback });
  } catch (error) {
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// @desc    Upload a PDF file for a session and save its info
// @route   POST /api/sessions/upload-pdf
// @access  Private
exports.uploadSessionPDF = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No PDF file uploaded' });
    }
    // Save PDF info to session if sessionId is provided
    const { sessionId } = req.body;
    let session = null;
    if (sessionId) {
      session = await Session.findById(sessionId);
      if (!session) {
        return res.status(404).json({ message: 'Session not found' });
      }
      session.pdf = {
        fileName: req.file.filename,
        fileUrl: `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`,
        originalName: req.file.originalname
      };
      await session.save();
    }
    res.status(200).json({
      fileName: req.file.filename,
      fileUrl: `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`,
      originalName: req.file.originalname
    });
  } catch (error) {
    res.status(500).json({ message: 'Failed to upload PDF', error: error.message });
  }
};