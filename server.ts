import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import type { AttemptAnswer, PracticeSource, StudyMode } from './src/types.ts';
import {
  clearQuizProgress,
  createLinkCode,
  deleteCollection,
  deleteDeck,
  getCollectionById,
  getCollectionByShareCode,
  getDeckById,
  getDeckByShareCode,
  getJobById,
  getLinkStatus,
  getQuizProgress,
  getRecentAttempts,
  listCollections,
  listDecks,
  listProgressForUser,
  listRecentJobs,
  recordAttempt,
  removeSavedDeckForUser,
  reshuffleDeckOptions,
  saveQuizProgress,
  saveSharedCollectionForUser,
  saveSharedDeckForUser,
  updateDeck,
} from './server/db.ts';
import { isSupportedWordOrExcel, startExtractionJob } from './server/extractor.ts';
import {
  getTelegramStatus,
  handleTelegramUpdate,
  resolvePublicBaseUrl,
  sendQuizToChat,
  setupTelegramWebhook,
  verifyTelegramInitData,
  verifyWebhookSecretHeader,
  type TelegramUpdatePayload,
} from './server/telegram.ts';

const PORT = 3000;

const ALLOWED_EXTENSIONS = new Set([
  '.docx',
  '.doc',
  '.rtf',
  '.xlsx',
  '.xls',
  '.xlsm',
  '.xlsb',
  '.ods',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext) && !isSupportedWordOrExcel(file.originalname, file.mimetype)) {
      cb(
        new Error(
          `Only Word (.docx, .doc, .rtf) and Excel (.xlsx, .xls, .ods) files are supported (got ${ext || file.mimetype}).`,
        ),
      );
      return;
    }
    cb(null, true);
  },
});

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/api/collections', (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const language = typeof req.query.language === 'string' ? req.query.language : undefined;
    const chatId = typeof req.query.chatId === 'string' ? req.query.chatId : undefined;
    const userKey = typeof req.query.userKey === 'string' ? req.query.userKey : undefined;
    const collections = listCollections({ search, language, chatId, userKey });
    res.json({ collections });
  });

  app.get('/api/collections/by-share/:code', (req, res) => {
    const collection = getCollectionByShareCode(req.params.code);
    if (!collection) {
      res.status(404).json({ error: 'Shared test collection not found.' });
      return;
    }
    res.json({ collection });
  });

  app.post('/api/collections/by-share/:code/implement', (req, res) => {
    const collection = getCollectionByShareCode(req.params.code);
    if (!collection) {
      res.status(404).json({ error: 'Shared test collection not found.' });
      return;
    }
    const body = req.body as { userKey?: string; chatId?: string };
    const keys = [body.userKey, body.chatId].map((k) => (k || '').trim()).filter(Boolean);
    for (const k of keys) {
      saveSharedCollectionForUser(k, collection.id);
    }
    res.json({ collection: getCollectionById(collection.id) ?? collection });
  });

  app.get('/api/collections/:id', (req, res) => {
    const collection = getCollectionById(req.params.id);
    if (!collection) {
      res.status(404).json({ error: 'Test file not found.' });
      return;
    }
    res.json({ collection });
  });

  app.delete('/api/collections/:id', (req, res) => {
    const deleted = deleteCollection(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Test file not found.' });
      return;
    }
    res.json({ ok: true });
  });

  app.get('/api/decks', (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search : undefined;
    const language = typeof req.query.language === 'string' ? req.query.language : undefined;
    const chatId = typeof req.query.chatId === 'string' ? req.query.chatId : undefined;
    const userKey = typeof req.query.userKey === 'string' ? req.query.userKey : undefined;
    const decks = listDecks({ search, language, chatId, userKey });
    res.json({ decks });
  });

  app.get('/api/decks/by-share/:code', (req, res) => {
    const deck = getDeckByShareCode(req.params.code);
    if (!deck) {
      res.status(404).json({ error: 'Shared package not found.' });
      return;
    }
    res.json({ deck });
  });

  app.post('/api/decks/by-share/:code/implement', (req, res) => {
    const deck = getDeckByShareCode(req.params.code);
    if (!deck) {
      res.status(404).json({ error: 'Shared package not found.' });
      return;
    }
    const body = req.body as { userKey?: string; chatId?: string };
    const keys = [body.userKey, body.chatId].map((k) => (k || '').trim()).filter(Boolean);
    for (const k of keys) {
      saveSharedDeckForUser(k, deck.id);
    }
    res.json({ deck });
  });

  app.delete('/api/decks/:id/saved', (req, res) => {
    const userKey = typeof req.query.userKey === 'string' ? req.query.userKey.trim() : '';
    const chatId = typeof req.query.chatId === 'string' ? req.query.chatId.trim() : '';
    if (userKey) removeSavedDeckForUser(userKey, req.params.id);
    if (chatId) removeSavedDeckForUser(chatId, req.params.id);
    res.json({ ok: true });
  });

  app.get('/api/decks/:id', (req, res) => {
    const deck = getDeckById(req.params.id);
    if (!deck) {
      res.status(404).json({ error: 'Exam package not found.' });
      return;
    }
    res.json({ deck });
  });

  app.post('/api/decks/:id/shuffle', (req, res) => {
    const shuffled = reshuffleDeckOptions(req.params.id);
    if (!shuffled) {
      res.status(404).json({ error: 'Exam package not found.' });
      return;
    }
    res.json({ deck: shuffled });
  });

  app.put('/api/decks/:id', (req, res) => {
    const body = req.body as {
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
    };
    const updated = updateDeck(req.params.id, body);
    if (!updated) {
      res.status(404).json({ error: 'Exam package not found.' });
      return;
    }
    res.json({ deck: updated });
  });

  app.delete('/api/decks/:id', (req, res) => {
    const deleted = deleteDeck(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Exam package not found.' });
      return;
    }
    res.json({ ok: true });
  });

  // --- Quiz Progress Auto-Save & Resume ---
  app.get('/api/progress', (req, res) => {
    const userKey = typeof req.query.userKey === 'string' ? req.query.userKey.trim() : '';
    if (!userKey) {
      res.json({ progress: {} });
      return;
    }
    res.json({ progress: listProgressForUser(userKey) });
  });

  app.get('/api/decks/:id/progress', (req, res) => {
    const userKey = typeof req.query.userKey === 'string' ? req.query.userKey.trim() : '';
    if (!userKey) {
      res.json({ progress: null });
      return;
    }
    const progress = getQuizProgress(req.params.id, userKey);
    res.json({ progress });
  });

  app.put('/api/decks/:id/progress', (req, res) => {
    const deck = getDeckById(req.params.id);
    if (!deck) {
      res.status(404).json({ error: 'Exam package not found.' });
      return;
    }
    const body = req.body as {
      userKey?: string;
      mode?: StudyMode;
      currentIndex?: number;
      selectedMap?: Record<string, number>;
      elapsedSeconds?: number;
    };
    const userKey = (body.userKey || '').trim();
    if (!userKey) {
      res.status(400).json({ error: 'Missing userKey.' });
      return;
    }
    const saved = saveQuizProgress({
      deckId: deck.id,
      userKey,
      mode: body.mode === 'exam' ? 'exam' : 'quiz',
      currentIndex: Number(body.currentIndex ?? 0),
      selectedMap: body.selectedMap ?? {},
      elapsedSeconds: Number(body.elapsedSeconds ?? 0),
    });
    res.json({ progress: saved });
  });

  app.delete('/api/decks/:id/progress', (req, res) => {
    const userKey = typeof req.query.userKey === 'string' ? req.query.userKey.trim() : '';
    if (userKey) {
      clearQuizProgress(req.params.id, userKey);
    }
    res.json({ ok: true });
  });

  app.post('/api/decks/:id/attempts', (req, res) => {
    const deck = getDeckById(req.params.id);
    if (!deck) {
      res.status(404).json({ error: 'Exam package not found.' });
      return;
    }

    const body = req.body as {
      userKey?: string;
      mode?: StudyMode;
      source?: PracticeSource;
      score?: number;
      total?: number;
      durationSeconds?: number;
      answers?: AttemptAnswer[];
    };

    const mode: StudyMode = body.mode === 'exam' ? 'exam' : 'quiz';
    const source: PracticeSource =
      body.source === 'miniapp' || body.source === 'telegram_chat' ? body.source : 'web';
    const total = Math.max(1, Number(body.total ?? deck.questions.length));
    const score = Math.min(total, Math.max(0, Number(body.score ?? 0)));
    const durationSeconds = Math.max(0, Number(body.durationSeconds ?? 0));
    const answers = Array.isArray(body.answers) ? body.answers : [];

    const attempt = recordAttempt({
      deckId: deck.id,
      mode,
      source,
      score,
      total,
      durationSeconds,
      answers,
    });

    if (body.userKey) {
      clearQuizProgress(deck.id, body.userKey);
    }

    res.status(201).json({ attempt });
  });

  app.get('/api/attempts/recent', (_req, res) => {
    const attempts = getRecentAttempts(25);
    res.json({ attempts });
  });

  // --- Background File Extraction Jobs ---
  app.get('/api/jobs', (req, res) => {
    const userKey = typeof req.query.userKey === 'string' ? req.query.userKey.trim() : undefined;
    const chatId = typeof req.query.chatId === 'string' ? req.query.chatId.trim() : undefined;
    res.json({ jobs: listRecentJobs({ userKey, chatId }) });
  });

  app.get('/api/jobs/:id', (req, res) => {
    const job = getJobById(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Extraction job not found.' });
      return;
    }
    res.json({ job });
  });

  app.post('/api/tests/extract', upload.single('file'), (req, res) => {
    try {
      const body = req.body as {
        language?: string;
        customTitle?: string;
        rawText?: string;
        telegramChatId?: string;
        userKey?: string;
      };

      if (!req.file && !body.rawText?.trim()) {
        res.status(400).json({ error: 'Please upload a Word or Excel file (or paste test text).' });
        return;
      }

      if (!process.env.GEMINI_API_KEY?.trim() || process.env.GEMINI_API_KEY === 'MY_GEMINI_API_KEY') {
        res.status(400).json({
          error: 'GEMINI_API_KEY is not configured. Please add your Gemini API key in Settings > Secrets.',
        });
        return;
      }

      const job = startExtractionJob({
        buffer: req.file?.buffer,
        filename: req.file?.originalname || 'Pasted Test Notes',
        mimeType: req.file?.mimetype,
        rawText: body.rawText,
        language: (body.language || 'Original').trim(),
        customTitle: body.customTitle,
        telegramChatId: body.telegramChatId?.trim() || null,
        userKey: body.userKey?.trim() || body.telegramChatId?.trim() || null,
      });

      res.status(202).json({ job });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to start extraction job.';
      res.status(400).json({ error: message });
    }
  });

  // --- Telegram Routes ---
  app.get('/api/telegram/status', async (req, res) => {
    const status = await getTelegramStatus(req);
    res.json(status);
  });

  app.post('/api/telegram/setup-webhook', async (req, res) => {
    try {
      const status = await setupTelegramWebhook(req);
      res.json(status);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to register webhook.';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/telegram/link-code', (_req, res) => {
    const code = createLinkCode();
    res.status(201).json({ code });
  });

  app.get('/api/telegram/link-code/:code', (req, res) => {
    const status = getLinkStatus(req.params.code.toUpperCase());
    if (!status) {
      res.status(404).json({ error: 'Link code not found.' });
      return;
    }
    res.json(status);
  });

  app.post('/api/telegram/send-quiz', async (req, res) => {
    try {
      const { deckId, chatId, offset } = req.body as {
        deckId?: string;
        chatId?: string;
        offset?: number;
      };
      if (!deckId || !chatId) {
        res.status(400).json({ error: 'Both deckId and Telegram chatId are required.' });
        return;
      }
      const cleanChatId = String(chatId).trim();
      if (!/^-?\d{4,20}$/.test(cleanChatId)) {
        res.status(400).json({ error: 'Please enter a valid numeric Telegram Chat ID.' });
        return;
      }

      const baseUrl = resolvePublicBaseUrl(req);
      const result = await sendQuizToChat(cleanChatId, deckId, Number(offset || 0), 10, baseUrl);
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send quiz to Telegram.';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/telegram/verify-miniapp', (req, res) => {
    const { initData } = req.body as { initData?: string };
    if (!initData) {
      res.status(400).json({ valid: false, error: 'Missing initData.' });
      return;
    }
    const result = verifyTelegramInitData(initData);
    res.json(result);
  });

  app.post('/api/telegram/webhook', async (req, res) => {
    const secretHeader = req.header('X-Telegram-Bot-Api-Secret-Token');
    if (!verifyWebhookSecretHeader(secretHeader)) {
      res.status(401).json({ error: 'Invalid webhook secret token.' });
      return;
    }

    const update = req.body as TelegramUpdatePayload;
    const baseUrl = resolvePublicBaseUrl(req);
    res.status(200).json({ ok: true });

    handleTelegramUpdate(update, baseUrl).catch((err) => {
      console.error('Telegram update handling error:', err);
    });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : 'Unexpected server error.';
    res.status(400).json({ error: message });
  });

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexPath = path.join(distDir, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(404).send('Build output not found. Run npm run build first.');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`CozyPrep server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
