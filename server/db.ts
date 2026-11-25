import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type {
  Attempt,
  AttemptAnswer,
  DeckDetail,
  ExamDeck,
  ExtractionJob,
  JobStatus,
  PracticeSource,
  Question,
  QuizProgress,
  StudyMode,
  TestCollection,
} from '../src/types.ts';

const dataDir = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'cozyprep.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS collections (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source_filename TEXT,
    language TEXT NOT NULL DEFAULT 'Original',
    total_questions INTEGER NOT NULL DEFAULT 0,
    package_count INTEGER NOT NULL DEFAULT 0,
    telegram_chat_id TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS decks (
    id TEXT PRIMARY KEY,
    collection_id TEXT,
    part_number INTEGER NOT NULL DEFAULT 1,
    total_parts INTEGER NOT NULL DEFAULT 1,
    range_start INTEGER NOT NULL DEFAULT 1,
    range_end INTEGER NOT NULL DEFAULT 1,
    share_code TEXT UNIQUE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT 'Original',
    question_type TEXT NOT NULL DEFAULT 'multiple_choice',
    source_filename TEXT,
    telegram_chat_id TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,
    deck_id TEXT NOT NULL,
    order_index INTEGER NOT NULL,
    prompt TEXT NOT NULL,
    options_json TEXT NOT NULL,
    correct_index INTEGER NOT NULL,
    explanation TEXT NOT NULL DEFAULT '',
    format TEXT NOT NULL DEFAULT 'multiple_choice',
    FOREIGN KEY (deck_id) REFERENCES decks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY,
    deck_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    source TEXT NOT NULL,
    score INTEGER NOT NULL,
    total INTEGER NOT NULL,
    duration_seconds INTEGER NOT NULL DEFAULT 0,
    answers_json TEXT NOT NULL DEFAULT '[]',
    completed_at TEXT NOT NULL,
    FOREIGN KEY (deck_id) REFERENCES decks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'Original',
    status TEXT NOT NULL DEFAULT 'queued',
    total_estimated INTEGER NOT NULL DEFAULT 0,
    processed_questions INTEGER NOT NULL DEFAULT 0,
    packages_created INTEGER NOT NULL DEFAULT 0,
    collection_id TEXT,
    telegram_chat_id TEXT,
    user_key TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS quiz_progress (
    deck_id TEXT NOT NULL,
    user_key TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'quiz',
    current_index INTEGER NOT NULL DEFAULT 0,
    answers_map_json TEXT NOT NULL DEFAULT '{}',
    elapsed_seconds INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (deck_id, user_key),
    FOREIGN KEY (deck_id) REFERENCES decks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS telegram_sessions (
    chat_id TEXT PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    pending_file_id TEXT,
    pending_file_name TEXT,
    pending_mime_type TEXT,
    selected_language TEXT,
    selected_format TEXT,
    state TEXT NOT NULL DEFAULT 'idle',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bot_links (
    link_code TEXT PRIMARY KEY,
    chat_id TEXT,
    username TEXT,
    first_name TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS user_saved_decks (
    user_key TEXT NOT NULL,
    deck_id TEXT NOT NULL,
    saved_at TEXT NOT NULL,
    PRIMARY KEY (user_key, deck_id),
    FOREIGN KEY (deck_id) REFERENCES decks(id) ON DELETE CASCADE
  );
`);

// Safe schema migration for existing cozyprep.db files from v1
function ensureColumn(table: string, column: string, definition: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn('collections', 'share_code', 'TEXT');
ensureColumn('decks', 'collection_id', 'TEXT');
ensureColumn('decks', 'part_number', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('decks', 'total_parts', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('decks', 'range_start', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('decks', 'range_end', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('decks', 'share_code', 'TEXT');

function generateShareCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

// Backfill share codes for any pre-existing v1 decks & collections
const missingShareRows = db
  .prepare("SELECT id FROM decks WHERE share_code IS NULL OR share_code = ''")
  .all() as Array<{ id: string }>;
for (const r of missingShareRows) {
  db.prepare('UPDATE decks SET share_code = ? WHERE id = ?').run(generateShareCode(), r.id);
}

const missingColShareRows = db
  .prepare("SELECT id FROM collections WHERE share_code IS NULL OR share_code = ''")
  .all() as Array<{ id: string }>;
for (const r of missingColShareRows) {
  db.prepare('UPDATE collections SET share_code = ? WHERE id = ?').run(generateShareCode(), r.id);
}

// Remove the legacy starter Cell Biology sample deck if it exists so new users start clean
db.prepare("DELETE FROM decks WHERE source_filename = 'starter-biology-sample.xlsx'").run();
db.prepare("DELETE FROM collections WHERE source_filename = 'starter-biology-sample.xlsx'").run();

export interface TelegramSession {
  chatId: string;
  username: string | null;
  firstName: string | null;
  pendingFileId: string | null;
  pendingFileName: string | null;
  pendingMimeType: string | null;
  selectedLanguage: string | null;
  selectedFormat: string | null;
  state: string;
  updatedAt: string;
}

export interface QuestionDraft {
  prompt: string;
  options: string[];
  correctIndex: number;
  explanation: string;
}

export interface CreateDeckInput {
  collectionId?: string | null;
  partNumber?: number;
  totalParts?: number;
  rangeStart?: number;
  rangeEnd?: number;
  title: string;
  description: string;
  language: string;
  sourceFilename?: string | null;
  telegramChatId?: string | null;
  questions: QuestionDraft[];
}

export function shuffleOptions<T extends QuestionDraft>(q: T): T {
  const tagged = q.options.map((text, idx) => ({
    text,
    isCorrect: idx === q.correctIndex,
  }));
  for (let i = tagged.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    const tmp = tagged[i];
    tagged[i] = tagged[j];
    tagged[j] = tmp;
  }
  return {
    ...q,
    options: tagged.map((t) => t.text),
    correctIndex: Math.max(
      0,
      tagged.findIndex((t) => t.isCorrect),
    ),
  };
}


export function createDeck(input: CreateDeckInput): DeckDetail {
  const deckId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const shareCode = generateShareCode();

  const insertDeck = db.prepare(`
    INSERT INTO decks (
      id, collection_id, part_number, total_parts, range_start, range_end, share_code,
      title, description, language, question_type, source_filename, telegram_chat_id, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'multiple_choice', ?, ?, ?)
  `);

  const insertQuestion = db.prepare(`
    INSERT INTO questions (id, deck_id, order_index, prompt, options_json, correct_index, explanation, format)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'multiple_choice')
  `);

  const tx = db.transaction(() => {
    insertDeck.run(
      deckId,
      input.collectionId ?? null,
      input.partNumber ?? 1,
      input.totalParts ?? 1,
      input.rangeStart ?? 1,
      input.rangeEnd ?? input.questions.length,
      shareCode,
      input.title.trim() || 'Untitled Exam Package',
      input.description.trim(),
      input.language.trim() || 'Original',
      input.sourceFilename ?? null,
      input.telegramChatId ?? null,
      createdAt,
    );

    input.questions.forEach((q, idx) => {
      insertQuestion.run(
        crypto.randomUUID(),
        deckId,
        idx,
        q.prompt.trim(),
        JSON.stringify(q.options),
        q.correctIndex,
        (q.explanation || '').trim(),
      );
    });
  });

  tx();
  return getDeckById(deckId)!;
}

export function createPackagedCollection(input: {
  title: string;
  description: string;
  language: string;
  sourceFilename?: string | null;
  telegramChatId?: string | null;
  questions: QuestionDraft[];
}): { collectionId: string; packages: DeckDetail[] } {
  const PACKAGE_SIZE = 50;
  const collectionId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const totalQuestions = input.questions.length;
  const totalParts = Math.max(1, Math.ceil(totalQuestions / PACKAGE_SIZE));

  const collectionShareCode = generateShareCode();

  db.prepare(`
    INSERT INTO collections (id, title, source_filename, language, total_questions, package_count, share_code, telegram_chat_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    collectionId,
    input.title.trim() || 'Exam Collection',
    input.sourceFilename ?? null,
    input.language.trim() || 'Original',
    totalQuestions,
    totalParts,
    collectionShareCode,
    input.telegramChatId ?? null,
    createdAt,
  );

  const packages: DeckDetail[] = [];
  for (let part = 0; part < totalParts; part++) {
    const startIdx = part * PACKAGE_SIZE;
    const slice = input.questions.slice(startIdx, startIdx + PACKAGE_SIZE);
    const rangeStart = startIdx + 1;
    const rangeEnd = startIdx + slice.length;
    const partLabel =
      totalParts > 1 ? `${input.title.trim()} — Part ${part + 1} (Q${rangeStart}–${rangeEnd})` : input.title.trim();

    const pkg = createDeck({
      collectionId,
      partNumber: part + 1,
      totalParts,
      rangeStart,
      rangeEnd,
      title: partLabel,
      description: input.description,
      language: input.language,
      sourceFilename: input.sourceFilename,
      telegramChatId: input.telegramChatId,
      questions: slice,
    });
    packages.push(pkg);
  }

  return { collectionId, packages };
}

export function saveSharedDeckForUser(userKey: string, deckId: string): void {
  const cleanKey = userKey.trim();
  if (!cleanKey || !deckId) return;
  db.prepare(`
    INSERT INTO user_saved_decks (user_key, deck_id, saved_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_key, deck_id) DO NOTHING
  `).run(cleanKey, deckId, new Date().toISOString());
}

export function saveSharedCollectionForUser(userKey: string, collectionId: string): void {
  const cleanKey = userKey.trim();
  if (!cleanKey || !collectionId) return;
  const rows = db
    .prepare('SELECT id FROM decks WHERE collection_id = ?')
    .all(collectionId) as Array<{ id: string }>;
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO user_saved_decks (user_key, deck_id, saved_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_key, deck_id) DO NOTHING
  `);
  const tx = db.transaction(() => {
    for (const r of rows) {
      stmt.run(cleanKey, r.id, now);
    }
  });
  tx();
}

export function removeSavedDeckForUser(userKey: string, deckId: string): void {
  const cleanKey = userKey.trim();
  if (!cleanKey || !deckId) return;
  db.prepare('DELETE FROM user_saved_decks WHERE user_key = ? AND deck_id = ?').run(cleanKey, deckId);
}

export function listDecks(filters?: {
  search?: string;
  language?: string;
  chatId?: string;
  userKey?: string;
}): ExamDeck[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filters?.language && filters.language !== 'All') {
    where.push('d.language = ?');
    params.push(filters.language);
  }

  const chatId = filters?.chatId?.trim();
  const userKey = filters?.userKey?.trim();
  const keys = Array.from(new Set([chatId, userKey].filter((v): v is string => Boolean(v))));

  if (chatId) {
    const placeholders = keys.map(() => '?').join(', ');
    where.push(
      `(d.telegram_chat_id = ? OR EXISTS (SELECT 1 FROM user_saved_decks usd WHERE usd.deck_id = d.id AND usd.user_key IN (${placeholders})))`,
    );
    params.push(chatId, ...keys);
  }

  if (filters?.search && filters.search.trim()) {
    where.push('(LOWER(d.title) LIKE ? OR LOWER(d.description) LIKE ? OR LOWER(COALESCE(d.source_filename, "")) LIKE ?)');
    const q = `%${filters.search.trim().toLowerCase()}%`;
    params.push(q, q, q);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const savedSet = new Set<string>();
  if (keys.length > 0) {
    const placeholders = keys.map(() => '?').join(', ');
    const savedRows = db
      .prepare(`SELECT deck_id FROM user_saved_decks WHERE user_key IN (${placeholders})`)
      .all(...keys) as Array<{ deck_id: string }>;
    savedRows.forEach((r) => savedSet.add(r.deck_id));
  }

  const rows = db
    .prepare(`
      SELECT
        d.id,
        d.collection_id,
        d.part_number,
        d.total_parts,
        d.range_start,
        d.range_end,
        d.share_code,
        d.title,
        d.description,
        d.language,
        d.source_filename,
        d.telegram_chat_id,
        d.created_at,
        (SELECT COUNT(*) FROM questions q WHERE q.deck_id = d.id) as question_count
      FROM decks d
      ${whereClause}
      ORDER BY d.created_at DESC, d.part_number ASC
    `)
    .all(...params) as Array<{
    id: string;
    collection_id: string | null;
    part_number: number;
    total_parts: number;
    range_start: number;
    range_end: number;
    share_code: string;
    title: string;
    description: string;
    language: string;
    source_filename: string | null;
    telegram_chat_id: string | null;
    created_at: string;
    question_count: number;
  }>;

  const latestAttemptStmt = db.prepare(`
    SELECT score, total, completed_at
    FROM attempts
    WHERE deck_id = ?
    ORDER BY completed_at DESC
    LIMIT 1
  `);

  return rows.map((row) => {
    const attempt = latestAttemptStmt.get(row.id) as
      | { score: number; total: number; completed_at: string }
      | undefined;

    const isSharedWithMe =
      savedSet.has(row.id) && (!chatId || row.telegram_chat_id !== chatId);

    return {
      id: row.id,
      collectionId: row.collection_id,
      partNumber: row.part_number ?? 1,
      totalParts: row.total_parts ?? 1,
      rangeStart: row.range_start ?? 1,
      rangeEnd: row.range_end ?? row.question_count,
      shareCode: row.share_code,
      title: row.title,
      description: row.description,
      language: row.language,
      questionType: 'multiple_choice',
      sourceFilename: row.source_filename,
      telegramChatId: row.telegram_chat_id,
      isSharedWithMe,
      createdAt: row.created_at,
      questionCount: row.question_count,
      lastScore: attempt
        ? {
            score: attempt.score,
            total: attempt.total,
            completedAt: attempt.completed_at,
          }
        : null,
    };
  });
}

export function listCollections(filters?: {
  search?: string;
  language?: string;
  chatId?: string;
  userKey?: string;
}): TestCollection[] {
  const packages = listDecks(filters);
  const colRows = db
    .prepare('SELECT id, title, source_filename, language, total_questions, package_count, share_code, telegram_chat_id, created_at FROM collections')
    .all() as Array<{
    id: string;
    title: string;
    source_filename: string | null;
    language: string;
    total_questions: number;
    package_count: number;
    share_code: string | null;
    telegram_chat_id: string | null;
    created_at: string;
  }>;

  const colMetaMap = new Map(colRows.map((c) => [c.id, c]));
  const grouped = new Map<string, TestCollection>();

  for (const pkg of packages) {
    const key = pkg.collectionId || `single_${pkg.id}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.packages.push(pkg);
      existing.totalQuestions = existing.packages.reduce(
        (sum, p) => sum + (p.questionCount ?? 0),
        0,
      );
      existing.packageCount = existing.packages.length;
      if (pkg.isSharedWithMe) existing.isSharedWithMe = true;
    } else {
      const meta = pkg.collectionId ? colMetaMap.get(pkg.collectionId) : undefined;
      grouped.set(key, {
        id: meta?.id || pkg.collectionId || pkg.id,
        title: meta?.title || pkg.title.replace(/\s+—\s+Part\s+\d+\s+\(Q[^)]+\)$/i, ''),
        sourceFilename: meta?.source_filename ?? pkg.sourceFilename,
        language: meta?.language || pkg.language,
        totalQuestions: pkg.questionCount ?? 0,
        packageCount: 1,
        shareCode: meta?.share_code || pkg.shareCode,
        telegramChatId: meta?.telegram_chat_id ?? pkg.telegramChatId,
        isSharedWithMe: pkg.isSharedWithMe,
        createdAt: meta?.created_at || pkg.createdAt,
        packages: [pkg],
      });
    }
  }

  return Array.from(grouped.values())
    .map((c) => ({
      ...c,
      packages: c.packages.sort((a, b) => a.partNumber - b.partNumber),
    }))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function getCollectionById(collectionId: string): TestCollection | null {
  const all = listCollections();
  return all.find((c) => c.id === collectionId) ?? null;
}

export function getCollectionByShareCode(shareCode: string): TestCollection | null {
  const code = shareCode.trim().toUpperCase();
  const row = db
    .prepare('SELECT id FROM collections WHERE UPPER(share_code) = ?')
    .get(code) as { id: string } | undefined;
  if (row) {
    return getCollectionById(row.id);
  }
  const byDeck = getDeckByShareCode(code);
  if (byDeck && byDeck.collectionId) {
    return getCollectionById(byDeck.collectionId);
  }
  return null;
}

export function deleteCollection(collectionId: string): boolean {
  const tx = db.transaction(() => {
    const res1 = db.prepare('DELETE FROM decks WHERE collection_id = ?').run(collectionId);
    const res2 = db.prepare('DELETE FROM collections WHERE id = ?').run(collectionId);
    const res3 = res1.changes === 0 && res2.changes === 0
      ? db.prepare('DELETE FROM decks WHERE id = ?').run(collectionId)
      : { changes: 0 };
    return res1.changes + res2.changes + res3.changes > 0;
  });
  return tx();
}

export function getDeckById(deckId: string): DeckDetail | null {
  const row = db
    .prepare(`
      SELECT id, collection_id, part_number, total_parts, range_start, range_end, share_code,
             title, description, language, source_filename, telegram_chat_id, created_at
      FROM decks
      WHERE id = ?
    `)
    .get(deckId) as
    | {
        id: string;
        collection_id: string | null;
        part_number: number;
        total_parts: number;
        range_start: number;
        range_end: number;
        share_code: string;
        title: string;
        description: string;
        language: string;
        source_filename: string | null;
        telegram_chat_id: string | null;
        created_at: string;
      }
    | undefined;

  if (!row) {
    return null;
  }

  const questionRows = db
    .prepare(`
      SELECT id, deck_id, order_index, prompt, options_json, correct_index, explanation
      FROM questions
      WHERE deck_id = ?
      ORDER BY order_index ASC
    `)
    .all(deckId) as Array<{
    id: string;
    deck_id: string;
    order_index: number;
    prompt: string;
    options_json: string;
    correct_index: number;
    explanation: string;
  }>;

  const attemptRows = db
    .prepare(`
      SELECT id, deck_id, mode, source, score, total, duration_seconds, answers_json, completed_at
      FROM attempts
      WHERE deck_id = ?
      ORDER BY completed_at DESC
      LIMIT 20
    `)
    .all(deckId) as Array<{
    id: string;
    deck_id: string;
    mode: StudyMode;
    source: PracticeSource;
    score: number;
    total: number;
    duration_seconds: number;
    answers_json: string;
    completed_at: string;
  }>;

  const questions: Question[] = questionRows.map((q) => ({
    id: q.id,
    deckId: q.deck_id,
    orderIndex: q.order_index,
    prompt: q.prompt,
    options: JSON.parse(q.options_json) as string[],
    correctIndex: q.correct_index,
    explanation: q.explanation,
    format: 'multiple_choice',
  }));

  const attempts: Attempt[] = attemptRows.map((a) => ({
    id: a.id,
    deckId: a.deck_id,
    mode: a.mode,
    source: a.source,
    score: a.score,
    total: a.total,
    durationSeconds: a.duration_seconds,
    answers: JSON.parse(a.answers_json) as AttemptAnswer[],
    completedAt: a.completed_at,
  }));

  return {
    id: row.id,
    collectionId: row.collection_id,
    partNumber: row.part_number ?? 1,
    totalParts: row.total_parts ?? 1,
    rangeStart: row.range_start ?? 1,
    rangeEnd: row.range_end ?? questions.length,
    shareCode: row.share_code,
    title: row.title,
    description: row.description,
    language: row.language,
    questionType: 'multiple_choice',
    sourceFilename: row.source_filename,
    telegramChatId: row.telegram_chat_id,
    createdAt: row.created_at,
    questionCount: questions.length,
    lastScore: attempts[0]
      ? {
          score: attempts[0].score,
          total: attempts[0].total,
          completedAt: attempts[0].completedAt,
        }
      : null,
    questions,
    attempts,
  };
}

export function getDeckByShareCode(shareCode: string): DeckDetail | null {
  const row = db
    .prepare('SELECT id FROM decks WHERE UPPER(share_code) = ?')
    .get(shareCode.trim().toUpperCase()) as { id: string } | undefined;
  return row ? getDeckById(row.id) : null;
}

export function reshuffleDeckOptions(deckId: string): DeckDetail | null {
  const deck = getDeckById(deckId);
  if (!deck) return null;

  const updateStmt = db.prepare(
    'UPDATE questions SET options_json = ?, correct_index = ? WHERE id = ?',
  );
  const tx = db.transaction(() => {
    for (const q of deck.questions) {
      const shuffled = shuffleOptions({
        prompt: q.prompt,
        options: q.options,
        correctIndex: q.correctIndex,
        explanation: q.explanation,
      });
      updateStmt.run(JSON.stringify(shuffled.options), shuffled.correctIndex, q.id);
    }
  });
  tx();
  return getDeckById(deckId);
}

export function updateDeck(
  deckId: string,
  payload: {
    title?: string;
    description?: string;
    language?: string;
    telegramChatId?: string | null;
    questions?: Array<{
      id?: string;
      prompt: string;
      options: string[];
      correctIndex: number;
      explanation: string;
    }>;
  },
): DeckDetail | null {
  const existing = getDeckById(deckId);
  if (!existing) {
    return null;
  }

  const updateDeckStmt = db.prepare(`
    UPDATE decks
    SET title = ?, description = ?, language = ?, telegram_chat_id = ?
    WHERE id = ?
  `);

  const deleteQuestionsStmt = db.prepare('DELETE FROM questions WHERE deck_id = ?');
  const insertQuestionStmt = db.prepare(`
    INSERT INTO questions (id, deck_id, order_index, prompt, options_json, correct_index, explanation, format)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'multiple_choice')
  `);

  const tx = db.transaction(() => {
    updateDeckStmt.run(
      payload.title !== undefined ? payload.title.trim() || existing.title : existing.title,
      payload.description !== undefined ? payload.description.trim() : existing.description,
      payload.language !== undefined ? payload.language.trim() || existing.language : existing.language,
      payload.telegramChatId !== undefined ? payload.telegramChatId : existing.telegramChatId,
      deckId,
    );

    if (payload.questions) {
      deleteQuestionsStmt.run(deckId);
      payload.questions.forEach((q, idx) => {
        const cleanOptions = q.options.map((o) => o.trim()).filter(Boolean);
        const safeOptions = cleanOptions.length >= 2 ? cleanOptions.slice(0, 5) : ['Option A', 'Option B'];
        const safeCorrect = Math.min(Math.max(0, q.correctIndex), safeOptions.length - 1);
        insertQuestionStmt.run(
          q.id || crypto.randomUUID(),
          deckId,
          idx,
          q.prompt.trim(),
          JSON.stringify(safeOptions),
          safeCorrect,
          (q.explanation || '').trim(),
        );
      });
    }
  });

  tx();
  return getDeckById(deckId);
}

export function deleteDeck(deckId: string): boolean {
  const res = db.prepare('DELETE FROM decks WHERE id = ?').run(deckId);
  return res.changes > 0;
}

export function recordAttempt(input: {
  deckId: string;
  mode: StudyMode;
  source: PracticeSource;
  score: number;
  total: number;
  durationSeconds: number;
  answers: AttemptAnswer[];
}): Attempt {
  const id = crypto.randomUUID();
  const completedAt = new Date().toISOString();

  db.prepare(`
    INSERT INTO attempts (id, deck_id, mode, source, score, total, duration_seconds, answers_json, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.deckId,
    input.mode,
    input.source,
    input.score,
    input.total,
    Math.max(0, Math.round(input.durationSeconds)),
    JSON.stringify(input.answers),
    completedAt,
  );

  return {
    id,
    deckId: input.deckId,
    mode: input.mode,
    source: input.source,
    score: input.score,
    total: input.total,
    durationSeconds: Math.max(0, Math.round(input.durationSeconds)),
    answers: input.answers,
    completedAt,
  };
}

export function getRecentAttempts(limit = 30): Array<Attempt & { deckTitle: string; deckLanguage: string }> {
  const rows = db
    .prepare(`
      SELECT a.id, a.deck_id, a.mode, a.source, a.score, a.total, a.duration_seconds, a.answers_json, a.completed_at,
             d.title as deck_title, d.language as deck_language
      FROM attempts a
      JOIN decks d ON d.id = a.deck_id
      ORDER BY a.completed_at DESC
      LIMIT ?
    `)
    .all(limit) as Array<{
    id: string;
    deck_id: string;
    mode: StudyMode;
    source: PracticeSource;
    score: number;
    total: number;
    duration_seconds: number;
    answers_json: string;
    completed_at: string;
    deck_title: string;
    deck_language: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    deckId: r.deck_id,
    deckTitle: r.deck_title,
    deckLanguage: r.deck_language,
    mode: r.mode,
    source: r.source,
    score: r.score,
    total: r.total,
    durationSeconds: r.duration_seconds,
    answers: JSON.parse(r.answers_json) as AttemptAnswer[],
    completedAt: r.completed_at,
  }));
}

// --- Background Jobs ---

export function createJob(input: {
  filename: string;
  language: string;
  telegramChatId?: string | null;
  userKey?: string | null;
}): ExtractionJob {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO jobs (
      id, filename, language, status, total_estimated, processed_questions,
      packages_created, collection_id, telegram_chat_id, user_key, error, created_at, updated_at
    ) VALUES (?, ?, ?, 'queued', 0, 0, 0, NULL, ?, ?, NULL, ?, ?)
  `).run(id, input.filename, input.language, input.telegramChatId ?? null, input.userKey ?? null, now, now);

  return getJobById(id)!;
}

export function updateJob(
  jobId: string,
  patch: Partial<{
    status: JobStatus;
    totalEstimated: number;
    processedQuestions: number;
    packagesCreated: number;
    collectionId: string | null;
    error: string | null;
  }>,
): ExtractionJob | null {
  const existing = getJobById(jobId);
  if (!existing) return null;

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE jobs
    SET status = ?, total_estimated = ?, processed_questions = ?, packages_created = ?,
        collection_id = ?, error = ?, updated_at = ?
    WHERE id = ?
  `).run(
    patch.status ?? existing.status,
    patch.totalEstimated ?? existing.totalEstimated,
    patch.processedQuestions ?? existing.processedQuestions,
    patch.packagesCreated ?? existing.packagesCreated,
    patch.collectionId !== undefined ? patch.collectionId : existing.collectionId,
    patch.error !== undefined ? patch.error : existing.error,
    now,
    jobId,
  );
  return getJobById(jobId);
}

export function getJobById(jobId: string): ExtractionJob | null {
  const r = db
    .prepare('SELECT * FROM jobs WHERE id = ?')
    .get(jobId) as Record<string, unknown> | undefined;
  return r ? mapJobRow(r) : null;
}

export function listRecentJobs(filters?: { userKey?: string; chatId?: string }): ExtractionJob[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filters?.userKey && filters?.chatId) {
    where.push('(user_key = ? OR telegram_chat_id = ?)');
    params.push(filters.userKey, filters.chatId);
  } else if (filters?.userKey) {
    where.push('(user_key = ? OR user_key IS NULL)');
    params.push(filters.userKey);
  } else if (filters?.chatId) {
    where.push('telegram_chat_id = ?');
    params.push(filters.chatId);
  }

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM jobs ${clause} ORDER BY created_at DESC LIMIT 12`)
    .all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapJobRow);
}

function mapJobRow(r: Record<string, unknown>): ExtractionJob {
  return {
    id: String(r.id),
    filename: String(r.filename),
    language: String(r.language),
    status: r.status as JobStatus,
    totalEstimated: Number(r.total_estimated ?? 0),
    processedQuestions: Number(r.processed_questions ?? 0),
    packagesCreated: Number(r.packages_created ?? 0),
    collectionId: (r.collection_id as string | null) ?? null,
    telegramChatId: (r.telegram_chat_id as string | null) ?? null,
    userKey: (r.user_key as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

// --- Quiz Progress Auto-Save & Resume ---

export function saveQuizProgress(input: {
  deckId: string;
  userKey: string;
  mode: StudyMode;
  currentIndex: number;
  selectedMap: Record<string, number>;
  elapsedSeconds: number;
}): QuizProgress {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO quiz_progress (deck_id, user_key, mode, current_index, answers_map_json, elapsed_seconds, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(deck_id, user_key) DO UPDATE SET
      mode = excluded.mode,
      current_index = excluded.current_index,
      answers_map_json = excluded.answers_map_json,
      elapsed_seconds = excluded.elapsed_seconds,
      updated_at = excluded.updated_at
  `).run(
    input.deckId,
    input.userKey,
    input.mode,
    Math.max(0, input.currentIndex),
    JSON.stringify(input.selectedMap),
    Math.max(0, Math.round(input.elapsedSeconds)),
    now,
  );

  return getQuizProgress(input.deckId, input.userKey)!;
}

export function getQuizProgress(deckId: string, userKey: string): QuizProgress | null {
  const row = db
    .prepare(`
      SELECT deck_id, user_key, mode, current_index, answers_map_json, elapsed_seconds, updated_at
      FROM quiz_progress
      WHERE deck_id = ? AND user_key = ?
    `)
    .get(deckId, userKey) as
    | {
        deck_id: string;
        user_key: string;
        mode: StudyMode;
        current_index: number;
        answers_map_json: string;
        elapsed_seconds: number;
        updated_at: string;
      }
    | undefined;

  if (!row) return null;

  return {
    deckId: row.deck_id,
    userKey: row.user_key,
    mode: row.mode,
    currentIndex: row.current_index,
    selectedMap: JSON.parse(row.answers_map_json) as Record<string, number>,
    elapsedSeconds: row.elapsed_seconds,
    updatedAt: row.updated_at,
  };
}

export function listProgressForUser(userKey: string): Record<
  string,
  { currentIndex: number; answeredCount: number; mode: StudyMode; updatedAt: string }
> {
  const rows = db
    .prepare(`
      SELECT deck_id, mode, current_index, answers_map_json, updated_at
      FROM quiz_progress
      WHERE user_key = ?
    `)
    .all(userKey) as Array<{
    deck_id: string;
    mode: StudyMode;
    current_index: number;
    answers_map_json: string;
    updated_at: string;
  }>;

  const map: Record<
    string,
    { currentIndex: number; answeredCount: number; mode: StudyMode; updatedAt: string }
  > = {};
  for (const r of rows) {
    const parsed = JSON.parse(r.answers_map_json) as Record<string, number>;
    const answeredCount = Object.keys(parsed).length;
    if (answeredCount > 0 || r.current_index > 0) {
      map[r.deck_id] = {
        currentIndex: r.current_index,
        answeredCount,
        mode: r.mode,
        updatedAt: r.updated_at,
      };
    }
  }
  return map;
}

export function clearQuizProgress(deckId: string, userKey: string): void {
  db.prepare('DELETE FROM quiz_progress WHERE deck_id = ? AND user_key = ?').run(deckId, userKey);
}

// --- Telegram Sessions & Link Codes ---

export function upsertTelegramSession(
  chatId: string,
  patch: Partial<Omit<TelegramSession, 'chatId' | 'updatedAt'>>,
): TelegramSession {
  const existing = getTelegramSession(chatId);
  const now = new Date().toISOString();

  const merged: TelegramSession = {
    chatId,
    username: patch.username !== undefined ? patch.username : (existing?.username ?? null),
    firstName: patch.firstName !== undefined ? patch.firstName : (existing?.firstName ?? null),
    pendingFileId: patch.pendingFileId !== undefined ? patch.pendingFileId : (existing?.pendingFileId ?? null),
    pendingFileName:
      patch.pendingFileName !== undefined ? patch.pendingFileName : (existing?.pendingFileName ?? null),
    pendingMimeType:
      patch.pendingMimeType !== undefined ? patch.pendingMimeType : (existing?.pendingMimeType ?? null),
    selectedLanguage:
      patch.selectedLanguage !== undefined ? patch.selectedLanguage : (existing?.selectedLanguage ?? null),
    selectedFormat:
      patch.selectedFormat !== undefined ? patch.selectedFormat : (existing?.selectedFormat ?? null),
    state: patch.state !== undefined ? patch.state : (existing?.state ?? 'idle'),
    updatedAt: now,
  };

  db.prepare(`
    INSERT INTO telegram_sessions (
      chat_id, username, first_name, pending_file_id, pending_file_name,
      pending_mime_type, selected_language, selected_format, state, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      pending_file_id = excluded.pending_file_id,
      pending_file_name = excluded.pending_file_name,
      pending_mime_type = excluded.pending_mime_type,
      selected_language = excluded.selected_language,
      selected_format = excluded.selected_format,
      state = excluded.state,
      updated_at = excluded.updated_at
  `).run(
    merged.chatId,
    merged.username,
    merged.firstName,
    merged.pendingFileId,
    merged.pendingFileName,
    merged.pendingMimeType,
    merged.selectedLanguage,
    merged.selectedFormat,
    merged.state,
    merged.updatedAt,
  );

  return merged;
}

export function getTelegramSession(chatId: string): TelegramSession | null {
  const row = db
    .prepare(`
      SELECT chat_id, username, first_name, pending_file_id, pending_file_name,
             pending_mime_type, selected_language, selected_format, state, updated_at
      FROM telegram_sessions
      WHERE chat_id = ?
    `)
    .get(chatId) as
    | {
        chat_id: string;
        username: string | null;
        first_name: string | null;
        pending_file_id: string | null;
        pending_file_name: string | null;
        pending_mime_type: string | null;
        selected_language: string | null;
        selected_format: string | null;
        state: string;
        updated_at: string;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    chatId: row.chat_id,
    username: row.username,
    firstName: row.first_name,
    pendingFileId: row.pending_file_id,
    pendingFileName: row.pending_file_name,
    pendingMimeType: row.pending_mime_type,
    selectedLanguage: row.selected_language,
    selectedFormat: row.selected_format,
    state: row.state,
    updatedAt: row.updated_at,
  };
}

export function createLinkCode(): string {
  const code = crypto.randomBytes(4).toString('hex').toUpperCase();
  db.prepare(`
    INSERT INTO bot_links (link_code, chat_id, username, first_name, created_at)
    VALUES (?, NULL, NULL, NULL, ?)
  `).run(code, new Date().toISOString());
  return code;
}

export function completeLinkCode(
  code: string,
  info: { chatId: string; username?: string | null; firstName?: string | null },
): boolean {
  const res = db
    .prepare(`
      UPDATE bot_links
      SET chat_id = ?, username = ?, first_name = ?
      WHERE link_code = ?
    `)
    .run(info.chatId, info.username ?? null, info.firstName ?? null, code);
  return res.changes > 0;
}

export function getLinkStatus(code: string): {
  linked: boolean;
  chatId: string | null;
  username: string | null;
  firstName: string | null;
} | null {
  const row = db
    .prepare(`
      SELECT chat_id, username, first_name
      FROM bot_links
      WHERE link_code = ?
    `)
    .get(code) as
    | { chat_id: string | null; username: string | null; first_name: string | null }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    linked: Boolean(row.chat_id),
    chatId: row.chat_id,
    username: row.username,
    firstName: row.first_name,
  };
}
