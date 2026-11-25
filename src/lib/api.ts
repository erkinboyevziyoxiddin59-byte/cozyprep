import type {
  Attempt,
  AttemptAnswer,
  DeckDetail,
  ExamDeck,
  ExtractionJob,
  PracticeSource,
  QuizProgress,
  StudyMode,
  TelegramStatus,
  TestCollection,
} from '../types.ts';

async function parseJson<T>(res: Response): Promise<T> {
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

export function getUserKey(): string {
  const chatId = localStorage.getItem('cozyprep_chat_id')?.trim();
  if (chatId) return chatId;
  let key = localStorage.getItem('cozyprep_user_key')?.trim();
  if (!key) {
    key = `web_${crypto.randomUUID()}`;
    localStorage.setItem('cozyprep_user_key', key);
  }
  return key;
}

export async function fetchCollections(params?: {
  search?: string;
  language?: string;
  chatId?: string;
  userKey?: string;
}): Promise<TestCollection[]> {
  const query = new URLSearchParams();
  if (params?.search) query.set('search', params.search);
  if (params?.language && params.language !== 'All') query.set('language', params.language);
  if (params?.chatId) query.set('chatId', params.chatId);
  if (params?.userKey) query.set('userKey', params.userKey);
  const qs = query.toString();
  const res = await fetch(`/api/collections${qs ? `?${qs}` : ''}`);
  const data = await parseJson<{ collections: TestCollection[] }>(res);
  return data.collections;
}

export async function fetchCollectionDetail(collectionId: string): Promise<TestCollection> {
  const res = await fetch(`/api/collections/${encodeURIComponent(collectionId)}`);
  const data = await parseJson<{ collection: TestCollection }>(res);
  return data.collection;
}

export async function fetchCollectionByShare(shareCode: string): Promise<TestCollection> {
  const res = await fetch(`/api/collections/by-share/${encodeURIComponent(shareCode)}`);
  const data = await parseJson<{ collection: TestCollection }>(res);
  return data.collection;
}

export async function implementSharedCollection(
  shareCode: string,
  payload: { userKey?: string; chatId?: string },
): Promise<TestCollection> {
  const res = await fetch(`/api/collections/by-share/${encodeURIComponent(shareCode)}/implement`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await parseJson<{ collection: TestCollection }>(res);
  return data.collection;
}

export async function deleteCollectionById(collectionId: string): Promise<void> {
  const res = await fetch(`/api/collections/${encodeURIComponent(collectionId)}`, {
    method: 'DELETE',
  });
  await parseJson<{ ok: boolean }>(res);
}

export async function fetchDecks(params?: {
  search?: string;
  language?: string;
  chatId?: string;
  userKey?: string;
}): Promise<ExamDeck[]> {
  const query = new URLSearchParams();
  if (params?.search) query.set('search', params.search);
  if (params?.language && params.language !== 'All') query.set('language', params.language);
  if (params?.chatId) query.set('chatId', params.chatId);
  if (params?.userKey) query.set('userKey', params.userKey);
  const qs = query.toString();
  const res = await fetch(`/api/decks${qs ? `?${qs}` : ''}`);
  const data = await parseJson<{ decks: ExamDeck[] }>(res);
  return data.decks;
}

export async function fetchDeckDetail(deckId: string): Promise<DeckDetail> {
  const res = await fetch(`/api/decks/${encodeURIComponent(deckId)}`);
  const data = await parseJson<{ deck: DeckDetail }>(res);
  return data.deck;
}

export async function fetchDeckByShare(shareCode: string): Promise<DeckDetail> {
  const res = await fetch(`/api/decks/by-share/${encodeURIComponent(shareCode)}`);
  const data = await parseJson<{ deck: DeckDetail }>(res);
  return data.deck;
}

export async function implementSharedDeck(
  shareCode: string,
  payload: { userKey?: string; chatId?: string },
): Promise<DeckDetail> {
  const res = await fetch(`/api/decks/by-share/${encodeURIComponent(shareCode)}/implement`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await parseJson<{ deck: DeckDetail }>(res);
  return data.deck;
}

export async function removeSavedDeck(
  deckId: string,
  params: { userKey?: string; chatId?: string },
): Promise<void> {
  const q = new URLSearchParams();
  if (params.userKey) q.set('userKey', params.userKey);
  if (params.chatId) q.set('chatId', params.chatId);
  await fetch(`/api/decks/${encodeURIComponent(deckId)}/saved?${q.toString()}`, {
    method: 'DELETE',
  });
}

export async function reshuffleDeck(deckId: string): Promise<DeckDetail> {
  const res = await fetch(`/api/decks/${encodeURIComponent(deckId)}/shuffle`, {
    method: 'POST',
  });
  const data = await parseJson<{ deck: DeckDetail }>(res);
  return data.deck;
}

export async function updateDeckDetail(
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
): Promise<DeckDetail> {
  const res = await fetch(`/api/decks/${encodeURIComponent(deckId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await parseJson<{ deck: DeckDetail }>(res);
  return data.deck;
}

export async function deleteDeckById(deckId: string): Promise<void> {
  const res = await fetch(`/api/decks/${encodeURIComponent(deckId)}`, {
    method: 'DELETE',
  });
  await parseJson<{ ok: boolean }>(res);
}

export async function startExtraction(input: {
  file?: File | null;
  rawText?: string;
  language: string;
  customTitle?: string;
  telegramChatId?: string;
  userKey?: string;
}): Promise<ExtractionJob> {
  const form = new FormData();
  if (input.file) {
    form.append('file', input.file);
  }
  if (input.rawText) {
    form.append('rawText', input.rawText);
  }
  form.append('language', input.language);
  if (input.customTitle) {
    form.append('customTitle', input.customTitle);
  }
  if (input.telegramChatId) {
    form.append('telegramChatId', input.telegramChatId);
  }
  if (input.userKey) {
    form.append('userKey', input.userKey);
  }

  const res = await fetch('/api/tests/extract', {
    method: 'POST',
    body: form,
  });
  const data = await parseJson<{ job: ExtractionJob }>(res);
  return data.job;
}

export async function fetchJobs(params?: {
  userKey?: string;
  chatId?: string;
}): Promise<ExtractionJob[]> {
  const q = new URLSearchParams();
  if (params?.userKey) q.set('userKey', params.userKey);
  if (params?.chatId) q.set('chatId', params.chatId);
  const qs = q.toString();
  const res = await fetch(`/api/jobs${qs ? `?${qs}` : ''}`);
  const data = await parseJson<{ jobs: ExtractionJob[] }>(res);
  return data.jobs;
}

export async function fetchAllProgress(userKey: string): Promise<
  Record<string, { currentIndex: number; answeredCount: number; mode: StudyMode; updatedAt: string }>
> {
  const res = await fetch(`/api/progress?userKey=${encodeURIComponent(userKey)}`);
  const data = await parseJson<{
    progress: Record<
      string,
      { currentIndex: number; answeredCount: number; mode: StudyMode; updatedAt: string }
    >;
  }>(res);
  return data.progress;
}

export async function fetchDeckProgress(
  deckId: string,
  userKey: string,
): Promise<QuizProgress | null> {
  const res = await fetch(
    `/api/decks/${encodeURIComponent(deckId)}/progress?userKey=${encodeURIComponent(userKey)}`,
  );
  const data = await parseJson<{ progress: QuizProgress | null }>(res);
  return data.progress;
}

export async function saveDeckProgress(
  deckId: string,
  payload: {
    userKey: string;
    mode: StudyMode;
    currentIndex: number;
    selectedMap: Record<string, number>;
    elapsedSeconds: number;
  },
): Promise<void> {
  await fetch(`/api/decks/${encodeURIComponent(deckId)}/progress`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function clearDeckProgress(deckId: string, userKey: string): Promise<void> {
  await fetch(
    `/api/decks/${encodeURIComponent(deckId)}/progress?userKey=${encodeURIComponent(userKey)}`,
    { method: 'DELETE' },
  );
}

export async function saveAttempt(
  deckId: string,
  payload: {
    userKey?: string;
    mode: StudyMode;
    source: PracticeSource;
    score: number;
    total: number;
    durationSeconds: number;
    answers: AttemptAnswer[];
  },
): Promise<Attempt> {
  const res = await fetch(`/api/decks/${encodeURIComponent(deckId)}/attempts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await parseJson<{ attempt: Attempt }>(res);
  return data.attempt;
}

export async function fetchRecentAttempts(): Promise<
  Array<Attempt & { deckTitle: string; deckLanguage: string }>
> {
  const res = await fetch('/api/attempts/recent');
  const data = await parseJson<{
    attempts: Array<Attempt & { deckTitle: string; deckLanguage: string }>;
  }>(res);
  return data.attempts;
}

export async function fetchTelegramStatus(): Promise<TelegramStatus> {
  const res = await fetch('/api/telegram/status');
  return parseJson<TelegramStatus>(res);
}

export async function registerTelegramWebhook(): Promise<TelegramStatus> {
  const res = await fetch('/api/telegram/setup-webhook', { method: 'POST' });
  return parseJson<TelegramStatus>(res);
}

export async function createBotLinkCode(): Promise<string> {
  const res = await fetch('/api/telegram/link-code', { method: 'POST' });
  const data = await parseJson<{ code: string }>(res);
  return data.code;
}

export async function checkBotLinkCode(code: string): Promise<{
  linked: boolean;
  chatId: string | null;
  username: string | null;
  firstName: string | null;
}> {
  const res = await fetch(`/api/telegram/link-code/${encodeURIComponent(code)}`);
  return parseJson(res);
}

export async function sendQuizToTelegram(payload: {
  deckId: string;
  chatId: string;
  offset?: number;
}): Promise<{ sentCount: number; remainingCount: number; deckTitle: string }> {
  const res = await fetch('/api/telegram/send-quiz', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseJson(res);
}

export async function verifyMiniAppInitData(initData: string): Promise<{
  valid: boolean;
  chatId?: string;
  username?: string | null;
  firstName?: string | null;
}> {
  const res = await fetch('/api/telegram/verify-miniapp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData }),
  });
  return parseJson(res);
}

export function buildPackageShareUrl(
  deck: Pick<ExamDeck, 'id' | 'shareCode'>,
  botUsername?: string | null,
): string {
  if (botUsername && deck.shareCode) {
    return `https://t.me/${botUsername}?start=pkg_${deck.shareCode}`;
  }
  return `${window.location.origin}/miniapp?share=${encodeURIComponent(deck.shareCode || deck.id)}`;
}

export function buildCollectionShareUrl(
  collection: Pick<TestCollection, 'id' | 'shareCode'>,
  botUsername?: string | null,
): string {
  if (botUsername && collection.shareCode) {
    return `https://t.me/${botUsername}?start=col_${collection.shareCode}`;
  }
  return `${window.location.origin}/miniapp?shareCol=${encodeURIComponent(collection.shareCode || collection.id)}`;
}
