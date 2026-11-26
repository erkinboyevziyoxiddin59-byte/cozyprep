export type QuestionFormat = 'multiple_choice';
export type DeckQuestionType = 'multiple_choice';
export type StudyMode = 'quiz' | 'exam';
export type PracticeSource = 'web' | 'miniapp' | 'telegram_chat';
export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed';

export interface Question {
  id: string;
  deckId: string;
  orderIndex: number;
  prompt: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  format: QuestionFormat;
}

export interface ExamDeck {
  id: string;
  collectionId: string | null;
  partNumber: number;
  totalParts: number;
  rangeStart: number;
  rangeEnd: number;
  shareCode: string;
  title: string;
  description: string;
  language: string;
  questionType: DeckQuestionType;
  sourceFilename: string | null;
  telegramChatId: string | null;
  isSharedWithMe?: boolean;
  createdAt: string;
  questionCount?: number;
  lastScore?: {
    score: number;
    total: number;
    completedAt: string;
  } | null;
}

export interface TestCollection {
  id: string;
  title: string;
  sourceFilename: string | null;
  language: string;
  totalQuestions: number;
  packageCount: number;
  shareCode: string;
  telegramChatId: string | null;
  isSharedWithMe?: boolean;
  createdAt: string;
  packages: ExamDeck[];
}

export interface AttemptAnswer {
  questionId: string;
  selectedIndex: number;
  isCorrect: boolean;
}

export interface Attempt {
  id: string;
  deckId: string;
  mode: StudyMode;
  source: PracticeSource;
  score: number;
  total: number;
  durationSeconds: number;
  answers: AttemptAnswer[];
  completedAt: string;
}

export interface DeckDetail extends ExamDeck {
  questions: Question[];
  attempts: Attempt[];
}

export interface ExtractionJob {
  id: string;
  filename: string;
  language: string;
  status: JobStatus;
  totalEstimated: number;
  processedQuestions: number;
  packagesCreated: number;
  collectionId: string | null;
  telegramChatId: string | null;
  userKey: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface QuizProgress {
  deckId: string;
  userKey: string;
  mode: StudyMode;
  currentIndex: number;
  selectedMap: Record<string, number>;
  elapsedSeconds: number;
  updatedAt: string;
}

export interface TelegramStatus {
  configured: boolean;
  botUsername: string | null;
  botFirstName: string | null;
  webhookUrl: string | null;
  webhookRegistered: boolean;
  webhookMatchesCurrentApp?: boolean;
  miniAppUrl: string;
  lastError?: string | null;
}
