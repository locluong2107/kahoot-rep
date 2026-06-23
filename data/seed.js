// Seeds the quiz store with the AI Ice-Breaker session from Kahoot_AI_Icebreaker_Session.md
module.exports = function seed() {
  return {
    quizzes: [
      {
        id: 'ai-icebreaker',
        title: 'Are You Smarter Than a Chatbot?',
        subtitle: 'AI at Work — Community Talk Ice-Breaker',
        questions: [
          // --- POLLS ---
          {
            type: 'poll',
            text: 'How would you describe your current relationship with AI at work?',
            time: 30,
            options: [
              { text: "We're practically married 💍" },
              { text: "It's complicated 😅" },
              { text: 'Still in the "getting to know each other" phase' },
              { text: "I'm playing hard to get" },
            ],
          },
          {
            type: 'poll',
            text: "What's your biggest AI WIN at work so far?",
            time: 30,
            options: [
              { text: 'Saved me from writing something mind-numbing' },
              { text: 'Made me look smarter in a meeting' },
              { text: 'Actually helped me understand something complex' },
              { text: 'Still waiting for my first win...' },
            ],
          },
          {
            type: 'poll',
            text: "What's your #1 AI frustration?",
            time: 30,
            options: [
              { text: 'It confidently made something up' },
              { text: "I don't know what to ask it" },
              { text: 'It writes like a LinkedIn robot' },
              { text: "My company hasn't approved the tools yet" },
            ],
          },
          // --- WORD CLOUDS ---
          {
            type: 'wordcloud',
            text: 'In ONE word — what comes to mind when you hear "AI at work"?',
            time: 45,
          },
          {
            type: 'wordcloud',
            text: 'Name ONE task you would happily let AI handle for you FOREVER',
            time: 45,
          },
          // --- QUIZ ---
          {
            type: 'quiz',
            text: 'When an AI confidently tells you something completely made up, that is called...?',
            time: 20,
            options: [
              { text: 'A hallucination', correct: true },
              { text: 'A creative interpretation' },
              { text: 'Premium content' },
              { text: "A consultant's first draft" },
            ],
          },
          {
            type: 'quiz',
            text: 'You ask AI to "write a report." It writes a 10-page essay on the history of reports. What should you have done?',
            time: 25,
            options: [
              { text: 'Been more specific in your prompt', correct: true },
              { text: 'Blamed the intern' },
              { text: 'Accept it, print it, submit it' },
              { text: 'Switch back to Excel' },
            ],
          },
          {
            type: 'truefalse',
            text: 'AI "understands" everything it tells you',
            time: 15,
            answer: false,
          },
          {
            type: 'quiz',
            text: 'An AI Agent is different from a basic chatbot because it can...',
            time: 25,
            options: [
              { text: 'Plan and execute multi-step tasks autonomously', correct: true },
              { text: 'Feel emotions (allegedly)' },
              { text: 'Remember your birthday' },
              { text: 'Work overtime without complaining' },
            ],
          },
          {
            type: 'quiz',
            text: 'RAG stands for... (hint: it is not a cleaning cloth)',
            time: 20,
            options: [
              { text: 'Retrieval-Augmented Generation', correct: true },
              { text: 'Really Awesome GPT' },
              { text: 'Randomly Answering Guesses' },
              { text: 'Research And Generate' },
            ],
          },
          {
            type: 'quiz',
            text: 'Which of these is NOT a good use of AI in finance?',
            time: 30,
            points: 'double',
            options: [
              { text: 'Summarizing earnings call transcripts' },
              { text: 'Auto-categorizing expense reports' },
              { text: 'Letting AI approve a payment with no human review', correct: true },
              { text: 'Drafting variance commentary for review' },
            ],
          },
          {
            type: 'quiz',
            text: 'What is a "token" in AI? (Not the crypto kind)',
            time: 20,
            options: [
              { text: 'A unit of text AI processes — roughly a word', correct: true },
              { text: 'The currency you pay for ChatGPT' },
              { text: 'An access badge for the AI data center' },
              { text: 'A loyalty reward from your AI subscription' },
            ],
          },
          {
            type: 'quiz',
            text: 'AI drafts a budget summary for your area — but the OpEx figure is €50K off. What is the most likely cause?',
            time: 30,
            points: 'double',
            options: [
              { text: 'The context window was too small to process the full report' },
              { text: 'The model hallucinated — it generated a plausible-sounding number, not a fact-checked one', correct: true },
              { text: "The prompt wasn't specific enough" },
              { text: 'The model needs to be fine-tuned on your financial data' },
            ],
          },
        ],
      },
    ],
  };
};
