import crypto from 'crypto';
import type { Request } from 'express';
import type { TelegramStatus } from '../src/types.ts';
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

export function resolvePublicBaseUrl(req?: Request): string {
  const envUrl = process.env.APP_URL?.trim();
  if (envUrl && envUrl !== 'MY_APP_URL' && envUrl.startsWith('http')) {
    return envUrl.replace(/\/+$/, '');
  }
  if (req) {
    const proto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim() || req.protocol || 'https';
    const host = (req.headers['x-forwarded-host'] as string)?.split(',')[0]?.trim() || req.get('host');
    if (host) {
      return `${proto}://${host}`.replace(/\/+$/, '');
    }
  }
  return 'http://localhost:3000';
}

async function callTelegram<T = unknown>(
  method: string,
  payload?: Record<string, unknown>,
): Promise<{ ok: boolean; result?: T; description?: string }> {
  const token = getBotToken();
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set in server secrets.');
  }
  const res = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  const json = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!json.ok) {
    throw new Error(json.description || `Telegram API ${method} failed`);
  }
  return json;
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

export async function getTelegramStatus(req?: Request): Promise<TelegramStatus> {
  const baseUrl = resolvePublicBaseUrl(req);
  const miniAppUrl = `${baseUrl}/miniapp`;
  const token = getBotToken();

  if (!token) {
    return {
      configured: false,
      botUsername: null,
      botFirstName: null,
      webhookUrl: null,
      webhookRegistered: false,
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
    return {
      configured: true,
      botUsername: meRes.result?.username ?? null,
      botFirstName: meRes.result?.first_name ?? null,
      webhookUrl: currentUrl,
      webhookRegistered: Boolean(currentUrl && currentUrl.includes('/api/telegram/webhook')),
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
    const options = q.options.slice(0, 10).map((opt) => clampText(opt, 100));
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
      await new Promise((r) => setTimeout(r, 250));
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

export async function handleTelegramUpdate(update: TelegramUpdatePayload, baseUrl: string): Promise<void> {
  const canUseWebApp = baseUrl.startsWith('https://');

  if (update.message) {
    const msg = update.message;
    const chatId = String(msg.chat.id);
    const username = msg.from?.username ?? null;
    const firstName = msg.from?.first_name ?? null;

    upsertTelegramSession(chatId, { username, firstName });

    if (msg.text && msg.text.startsWith('/start')) {
      const arg = msg.text.replace('/start', '').trim();

      if (arg.startsWith('pkg_')) {
        const shareCode = arg.replace('pkg_', '').trim().toUpperCase();
        const sharedDeck = getDeckByShareCode(shareCode);
        if (sharedDeck) {
          saveSharedDeckForUser(chatId, sharedDeck.id);
          const buttons: Array<Array<Record<string, unknown>>> = [
            [{ text: 'Start Quiz Here in Chat (10 per batch)', callback_data: `quiz:${sharedDeck.id}` }],
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
              `Added to your CozyPrep library! Choose how you want to solve it:`,
            reply_markup: { inline_keyboard: buttons },
          });
          return;
        }
        await callTelegram('sendMessage', {
          chat_id: chatId,
          text: 'That shared quiz package could not be found or was removed.',
        });
        return;
      }

      if (arg.startsWith('col_')) {
        const shareCode = arg.replace('col_', '').trim().toUpperCase();
        const sharedCol = getCollectionByShareCode(shareCode);
        if (sharedCol && sharedCol.packages.length > 0) {
          saveSharedCollectionForUser(chatId, sharedCol.id);
          const buttons: Array<Array<Record<string, unknown>>> = [
            [{ text: `Choose Part (${sharedCol.packageCount} Packages)`, callback_data: `col_parts:${sharedCol.id}` }],
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
              `Added to your CozyPrep library! Open it in the Mini App or pick a package in chat:`,
            reply_markup: { inline_keyboard: buttons },
          });
          return;
        }
        await callTelegram('sendMessage', {
          chat_id: chatId,
          text: 'That shared test could not be found or was removed.',
        });
        return;
      }

      let linkMsg = '';
      if (arg.startsWith('link_')) {
        const code = arg.replace('link_', '').trim().toUpperCase();
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
      await callTelegram('sendMessage', {
        chat_id: chatId,
        text: 'Send me a Word (.docx, .doc) or Excel (.xlsx, .xls) test file to turn it into 50-question multiple-choice packages, or use /quizzes to view saved packages.',
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
        });
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
  const keyboard: Array<Array<Record<string, unknown>>> = collections.map((col) => {
    if (col.packageCount > 1) {
      return [
        {
          text: `${clampText(col.title, 28)} (${col.totalQuestions}q · ${col.packageCount} parts)`,
          callback_data: `col_parts:${col.id}`,
        },
      ];
    }
    return [
      {
        text: `Quiz: ${clampText(col.title, 30)} (${col.totalQuestions}q)`,
        callback_data: `quiz:${col.packages[0].id}`,
      },
    ];
  });

  if (canUseWebApp) {
    keyboard.push([{ text: 'Open CozyPrep Mini App', web_app: { url: `${baseUrl}/miniapp` } }]);
  }

  await callTelegram('sendMessage', {
    chat_id: chatId,
    text: 'Choose a test file to view its 50-question packages or open the Mini App:',
    reply_markup: { inline_keyboard: keyboard },
  });
}
