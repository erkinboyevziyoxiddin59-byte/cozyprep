import crypto from 'crypto';
import type { Request } from 'express';
import * as XLSX from 'xlsx';
import type { DeckDetail, Question, TelegramStatus, TestCollection } from '../src/types.ts';
import {
  completeLinkCode,
  getCollectionById,
  getCollectionByShareCode,
  getDeckById,
  getDeckByShareCode,
  getTelegramSession,
  listCollections,
  saveSharedCollectionForUser,
  saveSharedDeckForUser,
  upsertTelegramSession,
} from './db.ts';
import { isSupportedWordOrExcel, startExtractionJob } from './extractor.ts';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const TRANSLATION_LANGUAGES = ['English', 'Uzbek', 'Russian', 'Spanish', 'Turkish', 'German'];

export function getBotToken(): string | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  return token && token.length > 10 ? token : null;
}

export function getWebhookSecret(): string | null {
  const explicit = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (explicit) {
    return explicit;
  }
  const token = getBotToken();
  if (!token) {
    return null;
  }
  return crypto.createHmac('sha256', token).update('cozyprep-webhook-secret').digest('hex').slice(0, 32);
}

export function verifyWebhookSecretHeader(headerValue: string | undefined): boolean {
  const expected = getWebhookSecret();
  if (!expected || !headerValue) {
    return false;
  }
  const a = Buffer.from(headerValue);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

let lastKnownBaseUrl: string | null = null;

export function resolvePublicBaseUrl(req?: Request): string {
  if (req) {
    const rawHost =
      (req.headers['x-forwarded-host'] as string)?.split(',')[0]?.trim() || req.get('host');
    if (rawHost) {
      const isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(rawHost);
      if (!isLocal) {
        const rawProto =
          (req.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim() ||
          req.protocol ||
          'https';
        const resolved = `${rawProto === 'http' ? 'https' : rawProto}://${rawHost}`.replace(/\/+$/, '');
        if (resolved.startsWith('https://')) {
          lastKnownBaseUrl = resolved;
        }
        return resolved;
      }
    }
  }
  if (lastKnownBaseUrl) {
    return lastKnownBaseUrl;
  }
  const envUrl = process.env.APP_URL?.trim();
  if (envUrl && envUrl !== 'MY_APP_URL' && envUrl.startsWith('http')) {
    return envUrl.replace(/\/+$/, '');
  }
  return 'http://localhost:3000';
}

async function callTelegram<T = unknown>(
  method: string,
  payload?: Record<string, unknown>,
  retries = 2,
): Promise<{ ok: boolean; result?: T; description?: string }> {
  const token = getBotToken();
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set in server secrets.');
  }
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    });
    const json = (await res.json()) as {
      ok: boolean;
      result?: T;
      description?: string;
      error_code?: number;
      parameters?: { retry_after?: number };
    };
    if (json.ok) {
      return json;
    }
    if (json.error_code === 429 && attempt < retries) {
      const waitSec = Math.min(10, Math.max(1, json.parameters?.retry_after ?? 2));
      await new Promise((r) => setTimeout(r, waitSec * 1000));
      continue;
    }
    throw new Error(json.description || `Telegram API ${method} failed`);
  }
  throw new Error(`Telegram API ${method} failed`);
}

async function sendTelegramDocument(
  chatId: string,
  filename: string,
  buffer: Buffer,
  caption?: string,
): Promise<void> {
  const token = getBotToken();
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set in server secrets.');
  }
  const form = new FormData();
  form.append('chat_id', chatId);
  if (caption) {
    form.append('caption', caption.slice(0, 1024));
  }
  const blob = new Blob([new Uint8Array(buffer)], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  form.append('document', blob, filename);

  const res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendDocument`, {
    method: 'POST',
    body: form,
  });
  const json = (await res.json()) as { ok: boolean; description?: string };
  if (!json.ok) {
    throw new Error(json.description || 'Failed to send package file to Telegram');
  }
}

function buildQuestionsWorkbookBuffer(
  sheetTitle: string,
  questions: Question[],
): Buffer {
  const rows: string[][] = [['#', 'Question', 'Correct Answer', 'Option 2', 'Option 3', 'Option 4', 'Option 5']];
  questions.forEach((q, idx) => {
    const correct = q.options[q.correctIndex] ?? q.options[0] ?? '';
    const wrongs = q.options.filter((_, i) => i !== q.correctIndex);
    rows.push([
      String(idx + 1),
      q.prompt,
      correct,
      wrongs[0] ?? '',
      wrongs[1] ?? '',
      wrongs[2] ?? '',
      wrongs[3] ?? '',
    ]);
  });
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const safeSheetName = sheetTitle.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'Questions';
  XLSX.utils.book_append_sheet(wb, ws, safeSheetName);
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

let cachedBotUsername: string | null = null;

async function getBotUsernameCached(): Promise<string | null> {
  if (cachedBotUsername) return cachedBotUsername;
  try {
    const res = await callTelegram<{ username?: string }>('getMe');
    cachedBotUsername = res.result?.username ?? null;
    return cachedBotUsername;
  } catch {
    return null;
  }
}

let cachedWebhookUrl: string | null = null;
let cachedWebhookAt = 0;
let autoSyncPromise: Promise<void> | null = null;
let lastAutoSyncAt = 0;

function isSafeRemoteHttpsHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    return false;
  }
  return true;
}

export async function mirrorShareBundleToRegisteredWebhook(
  bundle: {
    collection?: Partial<TestCollection> | null;
    packages: DeckDetail[];
    userKey?: string | null;
    telegramChatId?: string | null;
  },
  currentBaseUrl: string,
): Promise<boolean> {
  if (!getBotToken() || bundle.packages.length === 0) return false;
  try {
    let hookUrl = cachedWebhookUrl;
    if (!hookUrl || Date.now() - cachedWebhookAt > 60_000) {
      const hookRes = await callTelegram<{ url?: string }>('getWebhookInfo');
      hookUrl = hookRes.result?.url || null;
      cachedWebhookUrl = hookUrl;
      cachedWebhookAt = Date.now();
    }
    if (!hookUrl || !hookUrl.startsWith('https://')) return false;
    const parsedHook = new URL(hookUrl);
    if (!isSafeRemoteHttpsHost(parsedHook.hostname)) return false;
    const hookOrigin = parsedHook.origin.replace(/\/+$/, '');
    const localOrigin = currentBaseUrl.replace(/\/+$/, '');
    if (hookOrigin === localOrigin) return true;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(`${hookOrigin}/api/share/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...bundle, skipMirror: true }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    return res.ok;
  } catch {
    return false;
  }
}

export async function ensureWebhookForPublicHost(req?: Request): Promise<void> {
  if (!getBotToken()) return;
  const baseUrl = resolvePublicBaseUrl(req);
  if (!baseUrl.startsWith('https://')) return;
  try {
    const parsed = new URL(baseUrl);
    if (!isSafeRemoteHttpsHost(parsed.hostname) || parsed.hostname.startsWith('ais-dev-')) {
      return;
    }
  } catch {
    return;
  }

  if (Date.now() - lastAutoSyncAt < 60_000) return;
  if (autoSyncPromise) {
    await autoSyncPromise;
    return;
  }

  autoSyncPromise = (async () => {
    try {
      lastAutoSyncAt = Date.now();
      const expectedWebhookUrl = `${baseUrl}/api/telegram/webhook`;
      const hookRes = await callTelegram<{ url?: string }>('getWebhookInfo');
      const currentUrl = hookRes.result?.url || null;
      cachedWebhookUrl = currentUrl;
      cachedWebhookAt = Date.now();
      if (currentUrl !== expectedWebhookUrl) {
        await setupTelegramWebhook(req);
      }
    } catch {
      // Ignore transient auto-sync error
    } finally {
      autoSyncPromise = null;
    }
  })();

  await autoSyncPromise;
}

export async function getTelegramStatus(
  req?: Request,
  options?: { autoSync?: boolean },
): Promise<TelegramStatus> {
  if (options?.autoSync) {
    await ensureWebhookForPublicHost(req);
  }
  const baseUrl = resolvePublicBaseUrl(req);
  const miniAppUrl = `${baseUrl}/miniapp`;
  const expectedWebhookUrl = `${baseUrl}/api/telegram/webhook`;
  const token = getBotToken();

  if (!token) {
    return {
      configured: false,
      botUsername: null,
      botFirstName: null,
      webhookUrl: null,
      webhookRegistered: false,
      webhookMatchesCurrentApp: false,
      miniAppUrl,
      lastError: null,
    };
  }

  try {
    const [meRes, hookRes] = await Promise.all([
      callTelegram<{ username?: string; first_name?: string }>('getMe'),
      callTelegram<{ url?: string }>('getWebhookInfo'),
    ]);
    cachedBotUsername = meRes.result?.username ?? null;
    const currentUrl = hookRes.result?.url || null;
    cachedWebhookUrl = currentUrl;
    cachedWebhookAt = Date.now();
    return {
      configured: true,
      botUsername: meRes.result?.username ?? null,
      botFirstName: meRes.result?.first_name ?? null,
      webhookUrl: currentUrl,
      webhookRegistered: Boolean(currentUrl && currentUrl.includes('/api/telegram/webhook')),
      webhookMatchesCurrentApp: Boolean(currentUrl && currentUrl === expectedWebhookUrl),
      miniAppUrl,
      lastError: null,
    };
  } catch (err) {
    return {
      configured: true,
      botUsername: null,
      botFirstName: null,
      webhookUrl: null,
      webhookRegistered: false,
      webhookMatchesCurrentApp: false,
      miniAppUrl,
      lastError: err instanceof Error ? err.message : 'Unable to reach Telegram Bot API',
    };
  }
}

export async function setupTelegramWebhook(req?: Request): Promise<TelegramStatus> {
  const baseUrl = resolvePublicBaseUrl(req);
  if (!baseUrl.startsWith('https://')) {
    throw new Error(
      `Telegram webhooks require an HTTPS public URL. Current URL (${baseUrl}) is not HTTPS.`,
    );
  }
  const webhookUrl = `${baseUrl}/api/telegram/webhook`;
  const miniAppUrl = `${baseUrl}/miniapp`;
  const secretToken = getWebhookSecret();

  await callTelegram('setWebhook', {
    url: webhookUrl,
    secret_token: secretToken ?? undefined,
    allowed_updates: ['message', 'callback_query'],
  });

  await callTelegram('setChatMenuButton', {
    menu_button: {
      type: 'web_app',
      text: 'Open Study App',
      web_app: { url: miniAppUrl },
    },
  });

  return getTelegramStatus(req);
}

export function verifyTelegramInitData(initData: string): {
  valid: boolean;
  chatId?: string;
  username?: string | null;
  firstName?: string | null;
} {
  const token = getBotToken();
  if (!token || !initData) {
    return { valid: false };
  }

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) {
    return { valid: false };
  }

  const pairs: string[] = [];
  params.forEach((value, key) => {
    if (key !== 'hash') {
      pairs.push(`${key}=${value}`);
    }
  });
  pairs.sort();
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { valid: false };
  }

  const userRaw = params.get('user');
  if (!userRaw) {
    return { valid: true };
  }
  try {
    const user = JSON.parse(userRaw) as { id?: number; username?: string; first_name?: string };
    return {
      valid: true,
      chatId: user.id ? String(user.id) : undefined,
      username: user.username ?? null,
      firstName: user.first_name ?? null,
    };
  } catch {
    return { valid: true };
  }
}

function clampText(text: string, maxLen: number): string {
  const clean = text.trim();
  if (clean.length <= maxLen) {
    return clean;
  }
  return `${clean.slice(0, maxLen - 1).trimEnd()}…`;
}

export async function sendQuizToChat(
  chatId: string,
  deckId: string,
  offset = 0,
  limit = 10,
  baseUrl?: string,
): Promise<{ sentCount: number; remainingCount: number; deckTitle: string }> {
  const deck = getDeckById(deckId);
  if (!deck) {
    throw new Error('Exam package not found.');
  }
  if (deck.questions.length === 0) {
    throw new Error('This exam package has no questions.');
  }

  const slice = deck.questions.slice(offset, offset + limit);
  if (slice.length === 0) {
    throw new Error('No more questions left in this package.');
  }

  if (offset === 0) {
    await callTelegram('sendMessage', {
      chat_id: chatId,
      text: `Starting package: ${deck.title}\nLanguage: ${deck.language} · ${deck.questions.length} multiple-choice questions\nTap an option on each poll to see right/wrong immediately.`,
    });
  }

  for (let i = 0; i < slice.length; i++) {
    const q = slice[i];
    const questionNumber = offset + i + 1;
    const promptText = clampText(`Q${questionNumber}/${deck.questions.length}: ${q.prompt}`, 300);

    // Ensure Telegram poll options are non-empty, <= 100 chars, and distinct
    const seen = new Set<string>();
    const options = q.options.slice(0, 10).map((opt, idx) => {
      let val = clampText(opt || `Option ${idx + 1}`, 100) || `Option ${idx + 1}`;
      if (seen.has(val.toLowerCase())) {
        const suffix = ` (${idx + 1})`;
        val = `${clampText(val, 100 - suffix.length)}${suffix}`;
      }
      seen.add(val.toLowerCase());
      return val;
    });
    const safeCorrect = Math.min(Math.max(0, q.correctIndex), options.length - 1);
    const explanation = q.explanation ? clampText(q.explanation, 200) : undefined;

    await callTelegram('sendPoll', {
      chat_id: chatId,
      question: promptText,
      options,
      type: 'quiz',
      correct_option_id: safeCorrect,
      explanation,
      is_anonymous: false,
    });

    if (i < slice.length - 1) {
      await new Promise((r) => setTimeout(r, 350));
    }
  }

  const remainingCount = Math.max(0, deck.questions.length - (offset + slice.length));
  const resolvedBase = baseUrl || resolvePublicBaseUrl();
  const canUseWebApp = resolvedBase.startsWith('https://');
  const botUsername = await getBotUsernameCached();

  const inlineButtons: Array<Array<Record<string, unknown>>> = [];
  if (remainingCount > 0) {
    inlineButtons.push([
      {
        text: `Send Next ${Math.min(limit, remainingCount)} Questions`,
        callback_data: `quiz_page:${deck.id}:${offset + slice.length}`,
      },
    ]);
  }
  if (canUseWebApp) {
    inlineButtons.push([
      {
        text: 'Open Package in Mini App',
        web_app: { url: `${resolvedBase}/miniapp?deckId=${deck.id}` },
      },
    ]);
  }
  if (botUsername && deck.shareCode) {
    const deepLink = `https://t.me/${botUsername}?start=pkg_${deck.shareCode}`;
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(deepLink)}&text=${encodeURIComponent(`Try this quiz package: ${deck.title}`)}`;
    inlineButtons.push([{ text: 'Share Package with Someone', url: shareUrl }]);
  }
  inlineButtons.push([{ text: 'Download Package (.xlsx)', callback_data: `dl_pkg:${deck.id}` }]);

  if (inlineButtons.length > 0) {
    await callTelegram('sendMessage', {
      chat_id: chatId,
      text:
        remainingCount > 0
          ? `Sent ${slice.length} questions (${remainingCount} remaining in this package).`
          : `All ${deck.questions.length} quiz questions in this package delivered!`,
      reply_markup: { inline_keyboard: inlineButtons },
    });
  }

  return {
    sentCount: slice.length,
    remainingCount,
    deckTitle: deck.title,
  };
}

async function downloadTelegramFile(fileId: string): Promise<Buffer> {
  const token = getBotToken();
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is not configured.');
  }
  const fileInfo = await callTelegram<{ file_path?: string; file_size?: number }>('getFile', {
    file_id: fileId,
  });
  const filePath = fileInfo.result?.file_path;
  if (!filePath) {
    throw new Error('Telegram did not return a downloadable file path.');
  }
  if (fileInfo.result?.file_size && fileInfo.result.file_size > 18 * 1024 * 1024) {
    throw new Error('File exceeds the 18 MB limit.');
  }

  const downloadUrl = new URL(`${TELEGRAM_API_BASE}/file/bot${token}/${filePath}`);
  if (downloadUrl.hostname !== 'api.telegram.org') {
    throw new Error('Blocked unexpected download host.');
  }

  const res = await fetch(downloadUrl.toString());
  if (!res.ok) {
    throw new Error(`Failed to download file from Telegram (HTTP ${res.status}).`);
  }
  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

function buildLanguageKeyboard() {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [
    [{ text: 'Keep Original Language (Exact Text)', callback_data: 'lang:Original' }],
  ];
  for (let i = 0; i < TRANSLATION_LANGUAGES.length; i += 2) {
    rows.push(
      TRANSLATION_LANGUAGES.slice(i, i + 2).map((lang) => ({
        text: `Translate: ${lang}`,
        callback_data: `lang:${lang}`,
      })),
    );
  }
  return { inline_keyboard: rows };
}

export interface TelegramUpdatePayload {
  message?: {
    chat: { id: number };
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
    photo?: Array<{ file_id: string; file_size?: number }>;
  };
  callback_query?: {
    id: string;
    from: { id: number; username?: string; first_name?: string };
    message?: { chat: { id: number }; message_id: number };
    data?: string;
  };
}

async function sendSharedDeckCard(
  chatId: string,
  sharedDeck: DeckDetail,
  baseUrl: string,
  canUseWebApp: boolean,
): Promise<void> {
  saveSharedDeckForUser(chatId, sharedDeck.id);
  const buttons: Array<Array<Record<string, unknown>>> = [
    [{ text: 'Start Quiz Here in Chat (10 per batch)', callback_data: `quiz:${sharedDeck.id}` }],
    [{ text: 'Download Package (.xlsx)', callback_data: `dl_pkg:${sharedDeck.id}` }],
    [{ text: 'My Saved Tests', callback_data: 'list_decks' }],
  ];
  if (canUseWebApp) {
    buttons.unshift([
      {
        text: 'Open & Solve in Mini App',
        web_app: { url: `${baseUrl}/miniapp?share=${sharedDeck.shareCode}` },
      },
    ]);
  }
  await callTelegram('sendMessage', {
    chat_id: chatId,
    text:
      `Shared Quiz Package: "${sharedDeck.title}"\n` +
      `${sharedDeck.questions.length} multiple-choice questions · ${sharedDeck.language}\n\n` +
      `Saved to your CozyPrep tests! Choose how to study or download this package:`,
    reply_markup: { inline_keyboard: buttons },
  });
}

async function sendSharedCollectionCard(
  chatId: string,
  sharedCol: TestCollection,
  baseUrl: string,
  canUseWebApp: boolean,
): Promise<void> {
  if (sharedCol.id && sharedCol.packages.some((p) => p.collectionId === sharedCol.id)) {
    saveSharedCollectionForUser(chatId, sharedCol.id);
  }
  for (const pkg of sharedCol.packages) {
    saveSharedDeckForUser(chatId, pkg.id);
  }
  const buttons: Array<Array<Record<string, unknown>>> = [
    [{ text: `Choose Part (${sharedCol.packageCount} Packages)`, callback_data: `col_parts:${sharedCol.id}` }],
    [{ text: 'Download Full Test (.xlsx)', callback_data: `dl_col:${sharedCol.id}` }],
    [{ text: 'My Saved Tests', callback_data: 'list_decks' }],
  ];
  if (canUseWebApp) {
    buttons.unshift([
      {
        text: `Open Test (${sharedCol.packageCount} Packages)`,
        web_app: { url: `${baseUrl}/miniapp?shareCol=${sharedCol.shareCode}` },
      },
    ]);
  }
  await callTelegram('sendMessage', {
    chat_id: chatId,
    text:
      `Shared Test Bank: "${sharedCol.title}"\n` +
      `${sharedCol.totalQuestions} multiple-choice questions across ${sharedCol.packageCount} package(s) · ${sharedCol.language}\n\n` +
      `Saved to your CozyPrep tests! Open in Mini App, pick a part in chat, or download the file:`,
    reply_markup: { inline_keyboard: buttons },
  });
}

async function tryDeliverSharedArg(
  chatId: string,
  arg: string,
  baseUrl: string,
  canUseWebApp: boolean,
): Promise<'delivered' | 'not_found' | 'not_share'> {
  const trimmed = arg.trim();
  if (!trimmed) return 'not_share';
  const lower = trimmed.toLowerCase();

  if (lower.startsWith('pkg_')) {
    const code = trimmed.slice(4).trim();
    const deck = getDeckByShareCode(code);
    if (deck) {
      await sendSharedDeckCard(chatId, deck, baseUrl, canUseWebApp);
      return 'delivered';
    }
    const colFallback = getCollectionByShareCode(code);
    if (colFallback && colFallback.packages.length > 0) {
      await sendSharedCollectionCard(chatId, colFallback, baseUrl, canUseWebApp);
      return 'delivered';
    }
    return 'not_found';
  }

  if (lower.startsWith('col_')) {
    const code = trimmed.slice(4).trim();
    const col = getCollectionByShareCode(code);
    if (col && col.packages.length > 0) {
      await sendSharedCollectionCard(chatId, col, baseUrl, canUseWebApp);
      return 'delivered';
    }
    const deckFallback = getDeckByShareCode(code);
    if (deckFallback) {
      await sendSharedDeckCard(chatId, deckFallback, baseUrl, canUseWebApp);
      return 'delivered';
    }
    return 'not_found';
  }

  if (!lower.startsWith('link_') && /^[A-Za-z0-9_-]{6,64}$/.test(trimmed)) {
    const deck = getDeckByShareCode(trimmed);
    if (deck) {
      await sendSharedDeckCard(chatId, deck, baseUrl, canUseWebApp);
      return 'delivered';
    }
    const col = getCollectionByShareCode(trimmed);
    if (col && col.packages.length > 0) {
      await sendSharedCollectionCard(chatId, col, baseUrl, canUseWebApp);
      return 'delivered';
    }
  }

  return 'not_share';
}

export async function handleTelegramUpdate(update: TelegramUpdatePayload, baseUrl: string): Promise<void> {
  const canUseWebApp = baseUrl.startsWith('https://');

  if (update.message) {
    const msg = update.message;
    const chatId = String(msg.chat.id);
    const username = msg.from?.username ?? null;
    const firstName = msg.from?.first_name ?? null;

    upsertTelegramSession(chatId, { username, firstName });

    const startMatch = msg.text?.match(/^\/start(?:@\S+)?(?:\s+(.*))?$/i);
    if (startMatch) {
      const arg = (startMatch[1] || '').trim();
      const shareResult = await tryDeliverSharedArg(chatId, arg, baseUrl, canUseWebApp);
      if (shareResult === 'delivered') {
        return;
      }
      if (shareResult === 'not_found') {
        await callTelegram('sendMessage', {
          chat_id: chatId,
          text:
            arg.toLowerCase().startsWith('pkg_')
              ? 'That shared quiz package could not be found or was removed.'
              : 'That shared test could not be found or was removed.',
        });
        return;
      }

      const argLower = arg.toLowerCase();
      let linkMsg = '';
      if (argLower.startsWith('link_')) {
        const code = arg.slice(5).trim().toUpperCase();
        const ok = completeLinkCode(code, { chatId, username, firstName });
        if (ok) {
          linkMsg = '\n\nYour Web Studio is now linked to this Telegram chat!';
        }
      }

      const buttons: Array<Array<Record<string, unknown>>> = [];
      if (canUseWebApp) {
        buttons.push([{ text: 'Open', web_app: { url: `${baseUrl}/miniapp` } }]);
      } else {
        buttons.push([{ text: 'Open', url: baseUrl }]);
      }
      buttons.push([{ text: 'My Saved Tests', callback_data: 'list_decks' }]);

      const greeting = firstName ? `, ${escapeHtml(firstName)}` : '';
      await callTelegram('sendMessage', {
        chat_id: chatId,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        text:
          `Welcome to CozyPrep${greeting}!\n\n` +
          `Send me any Word (.docx, .doc, .rtf) or Excel (.xlsx, .xls, .ods) test file. ` +
          `I keep your exact question and answer wording, shuffle the options, split large files into ordered 50-question packages inside one test page, and work in the background.\n\n` +
          `CozyPrep Web & Mini App: <a href="${escapeHtml(baseUrl)}">Open</a>\n` +
          `Your Telegram Chat ID: <code>${escapeHtml(chatId)}</code>${escapeHtml(linkMsg)}`,
        reply_markup: { inline_keyboard: buttons },
      });
      return;
    }

    if (msg.text && (msg.text === '/quizzes' || msg.text === '/tests')) {
      await sendDeckListToChat(chatId, baseUrl);
      return;
    }

    if (msg.document) {
      const doc = msg.document;
      if (!isSupportedWordOrExcel(doc.file_name, doc.mime_type)) {
        await callTelegram('sendMessage', {
          chat_id: chatId,
          text: 'Please send a Word (.docx, .doc, .rtf) or Excel (.xlsx, .xls, .ods) test file.',
        });
        return;
      }
      if (doc.file_size && doc.file_size > 18 * 1024 * 1024) {
        await callTelegram('sendMessage', {
          chat_id: chatId,
          text: 'That file is larger than 18 MB. Please send a smaller Word or Excel file.',
        });
        return;
      }
      upsertTelegramSession(chatId, {
        pendingFileId: doc.file_id,
        pendingFileName: doc.file_name || 'test-file.xlsx',
        pendingMimeType: doc.mime_type || 'application/octet-stream',
        state: 'awaiting_language',
      });

      await callTelegram('sendMessage', {
        chat_id: chatId,
        text:
          `Received "${doc.file_name || 'your file'}".\n` +
          `Choose whether to keep the exact original wording or translate it:`,
        reply_markup: buildLanguageKeyboard(),
      });
      return;
    }

    if (msg.photo && msg.photo.length > 0) {
      await callTelegram('sendMessage', {
        chat_id: chatId,
        text: 'To keep your questions 100% exact and split large sets into 50-question packages, please send a Word (.docx, .doc) or Excel (.xlsx, .xls) file instead of a photo.',
      });
      return;
    }

    if (msg.text) {
      const shareResult = await tryDeliverSharedArg(chatId, msg.text, baseUrl, canUseWebApp);
      if (shareResult === 'delivered') {
        return;
      }
      if (shareResult === 'not_found') {
        await callTelegram('sendMessage', {
          chat_id: chatId,
          text: 'That shared code was not found on this server yet. Ask the sender to open Share in CozyPrep to sync it, or check the code.',
        });
        return;
      }

      await callTelegram('sendMessage', {
        chat_id: chatId,
        text: 'Send me a Word (.docx, .doc) or Excel (.xlsx, .xls) test file to turn it into 50-question multiple-choice packages, paste a share code (pkg_... / col_...), or use /quizzes to view saved packages.',
      });
    }
    return;
  }

  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = String(cb.message?.chat.id ?? cb.from.id);
    const messageId = cb.message?.message_id;
    const data = cb.data || '';

    await callTelegram('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});

    if (data === 'list_decks') {
      await sendDeckListToChat(chatId, baseUrl);
      return;
    }

    if (data.startsWith('lang:')) {
      const language = data.slice('lang:'.length) || 'Original';
      const session = getTelegramSession(chatId);
      if (!session?.pendingFileId) {
        await callTelegram('sendMessage', {
          chat_id: chatId,
          text: 'Please send a Word or Excel file first so I can extract your questions.',
        });
        return;
      }

      const fileName = session.pendingFileName || 'test-file';
      if (messageId) {
        await callTelegram('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text:
            `Processing "${fileName}" in the background (${language === 'Original' ? 'exact original text' : `translating to ${language}`})...\n` +
            `You can close Telegram or the Mini App—I will reply here as soon as your 50-question packages are ready!`,
        }).catch(() => {});
      }

      try {
        const buffer = await downloadTelegramFile(session.pendingFileId);
        const pendingMime = session.pendingMimeType || undefined;

        upsertTelegramSession(chatId, {
          pendingFileId: null,
          pendingFileName: null,
          pendingMimeType: null,
          state: 'idle',
        });

        startExtractionJob(
          {
            buffer,
            filename: fileName,
            mimeType: pendingMime,
            language,
            telegramChatId: chatId,
            userKey: chatId,
          },
          {
            onComplete: async (finishedJob, packages) => {
              const totalQ = packages.reduce((sum, p) => sum + p.questions.length, 0);
              const botUsername = await getBotUsernameCached();
              const col = finishedJob.collectionId ? getCollectionById(finishedJob.collectionId) : null;
              const buttons: Array<Array<Record<string, unknown>>> = [];

              if (canUseWebApp && col) {
                buttons.push([
                  {
                    text: `Open Test (${packages.length} Packages) in Mini App`,
                    web_app: { url: `${baseUrl}/miniapp?collectionId=${col.id}` },
                  },
                ]);
              } else if (canUseWebApp) {
                buttons.push([
                  {
                    text: 'Open Packages in Mini App',
                    web_app: { url: `${baseUrl}/miniapp?deckId=${packages[0].id}` },
                  },
                ]);
              }

              if (botUsername && col?.shareCode) {
                const colLink = `https://t.me/${botUsername}?start=col_${col.shareCode}`;
                buttons.push([
                  {
                    text: `Share Whole Test (${packages.length} Packages)`,
                    url: `https://t.me/share/url?url=${encodeURIComponent(colLink)}&text=${encodeURIComponent(`Practice "${col.title}" (${totalQ} questions)`)}`,
                  },
                ]);
              }

              packages.slice(0, 6).forEach((pkg) => {
                const row: Array<Record<string, unknown>> = [
                  {
                    text: `Quiz Part ${pkg.partNumber} (${pkg.questions.length}q)`,
                    callback_data: `quiz:${pkg.id}`,
                  },
                ];
                if (botUsername && pkg.shareCode) {
                  const link = `https://t.me/${botUsername}?start=pkg_${pkg.shareCode}`;
                  row.push({
                    text: `Share Part ${pkg.partNumber}`,
                    url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(`Practice ${pkg.title}`)}`,
                  });
                }
                buttons.push(row);
              });

              const summaryLines = packages
                .map((p) => `• Part ${p.partNumber}: Questions ${p.rangeStart}–${p.rangeEnd} (${p.questions.length}q)`)
                .slice(0, 12)
                .join('\n');

              await callTelegram('sendMessage', {
                chat_id: chatId,
                text:
                  `Finished "${fileName}"!\n` +
                  `${totalQ} multiple-choice questions split into ${packages.length} ordered package(s):\n\n` +
                  `${summaryLines}` +
                  (packages.length > 12 ? `\n...and ${packages.length - 12} more inside the test page.` : ''),
                reply_markup: { inline_keyboard: buttons },
              });
            },
            onError: async (_job, err) => {
              await callTelegram('sendMessage', {
                chat_id: chatId,
                text: `Could not extract "${fileName}": ${err.message}`,
              });
            },
          },
        );
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'Unable to download file.';
        await callTelegram('sendMessage', {
          chat_id: chatId,
          text: `Could not start extraction: ${reason}`,
        });
      }
      return;
    }

    if (data.startsWith('col_parts:')) {
      const colId = data.slice('col_parts:'.length);
      const col = getCollectionById(colId);
      if (!col || col.packages.length === 0) {
        await callTelegram('sendMessage', {
          chat_id: chatId,
          text: 'That test file could not be found.',
        });
        return;
      }
      const botUsername = await getBotUsernameCached();
      const keyboard: Array<Array<Record<string, unknown>>> = [];
      if (canUseWebApp) {
        keyboard.push([
          {
            text: `Open All ${col.packageCount} Packages in Mini App`,
            web_app: { url: `${baseUrl}/miniapp?collectionId=${col.id}` },
          },
        ]);
      }
      if (botUsername && col.shareCode) {
        const colLink = `https://t.me/${botUsername}?start=col_${col.shareCode}`;
        keyboard.push([
          {
            text: `Share Whole Test (${col.packageCount} Packages)`,
            url: `https://t.me/share/url?url=${encodeURIComponent(colLink)}&text=${encodeURIComponent(`Practice "${col.title}" (${col.totalQuestions} questions)`)}`,
          },
        ]);
      }
      keyboard.push([{ text: 'Download Full Test (.xlsx)', callback_data: `dl_col:${col.id}` }]);
      col.packages.slice(0, 12).forEach((pkg) => {
        const row: Array<Record<string, unknown>> = [
          {
            text: `Part ${pkg.partNumber} (Q${pkg.rangeStart}–${pkg.rangeEnd})`,
            callback_data: `quiz:${pkg.id}`,
          },
        ];
        if (botUsername && pkg.shareCode) {
          const link = `https://t.me/${botUsername}?start=pkg_${pkg.shareCode}`;
          row.push({
            text: `Share Part ${pkg.partNumber}`,
            url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(`Practice ${pkg.title}`)}`,
          });
        }
        keyboard.push(row);
      });
      await callTelegram('sendMessage', {
        chat_id: chatId,
        text: `${col.title} (${col.totalQuestions} questions · ${col.packageCount} packages)\nPick a package to start or share:`,
        reply_markup: { inline_keyboard: keyboard },
      });
      return;
    }

    if (data.startsWith('dl_pkg:')) {
      const deckId = data.slice('dl_pkg:'.length);
      const deck = getDeckById(deckId);
      if (!deck) {
        await callTelegram('sendMessage', { chat_id: chatId, text: 'That package could not be found.' });
        return;
      }
      const safeName = `${deck.title.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60) || 'package'}.xlsx`;
      const buf = buildQuestionsWorkbookBuffer(deck.title, deck.questions);
      await sendTelegramDocument(
        chatId,
        safeName,
        buf,
        `${deck.title} (${deck.questions.length} questions · saved in your CozyPrep library)`,
      );
      return;
    }

    if (data.startsWith('dl_col:')) {
      const colId = data.slice('dl_col:'.length);
      const col = getCollectionById(colId);
      if (!col || col.packages.length === 0) {
        await callTelegram('sendMessage', { chat_id: chatId, text: 'That test file could not be found.' });
        return;
      }
      const allQ: Question[] = [];
      for (const p of col.packages) {
        const detail = getDeckById(p.id);
        if (detail) allQ.push(...detail.questions);
      }
      const safeName = `${col.title.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60) || 'test'}.xlsx`;
      const buf = buildQuestionsWorkbookBuffer(col.title, allQ);
      await sendTelegramDocument(
        chatId,
        safeName,
        buf,
        `${col.title} (${allQ.length} questions across ${col.packageCount} packages · saved in your CozyPrep library)`,
      );
      return;
    }

    if (data.startsWith('quiz:')) {
      const deckId = data.slice('quiz:'.length);
      await sendQuizToChat(chatId, deckId, 0, 10, baseUrl);
      return;
    }

    if (data.startsWith('quiz_page:')) {
      const [, deckId, offsetStr] = data.split(':');
      const offset = Number.parseInt(offsetStr || '0', 10) || 0;
      await sendQuizToChat(chatId, deckId, offset, 10, baseUrl);
    }
  }
}

async function sendDeckListToChat(chatId: string, baseUrl: string) {
  const collections = listCollections({ chatId }).slice(0, 10);
  if (collections.length === 0) {
    await callTelegram('sendMessage', {
      chat_id: chatId,
      text: 'You have no saved tests yet. Send me a Word or Excel file to build 50-question packages, or open a shared package link!',
    });
    return;
  }

  const canUseWebApp = baseUrl.startsWith('https://');
  const botUsername = await getBotUsernameCached();
  const keyboard: Array<Array<Record<string, unknown>>> = collections.map((col) => {
    if (col.packageCount > 1) {
      return [
        {
          text: `${clampText(col.title, 28)} (${col.totalQuestions}q · ${col.packageCount} parts)`,
          callback_data: `col_parts:${col.id}`,
        },
      ];
    }
    const pkg = col.packages[0];
    const row: Array<Record<string, unknown>> = [
      {
        text: `Quiz: ${clampText(col.title, 26)} (${col.totalQuestions}q)`,
        callback_data: `quiz:${pkg.id}`,
      },
    ];
    if (botUsername && pkg.shareCode) {
      const link = `https://t.me/${botUsername}?start=pkg_${pkg.shareCode}`;
      row.push({
        text: 'Share',
        url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(`Practice "${pkg.title}" (${col.totalQuestions} questions)`)}`,
      });
    }
    return row;
  });

  if (canUseWebApp) {
    keyboard.push([{ text: 'Open CozyPrep Mini App', web_app: { url: `${baseUrl}/miniapp` } }]);
  }

  await callTelegram('sendMessage', {
    chat_id: chatId,
    text: 'Choose a test file to start, share, or open in the Mini App:',
    reply_markup: { inline_keyboard: keyboard },
  });
}
