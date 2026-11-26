import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import mammoth from 'mammoth';
import path from 'path';
import WordExtractor from 'word-extractor';
import * as XLSX from 'xlsx';
import {
  createJob,
  createPackagedCollection,
  getCollectionById,
  shuffleOptions,
  updateJob,
  type QuestionDraft,
} from './db.ts';
import type { DeckDetail, ExtractionJob } from '../src/types.ts';

export interface ExtractionInput {
  buffer?: Buffer;
  filename?: string;
  mimeType?: string;
  rawText?: string;
  language: string; // 'Original' or target language e.g. 'Uzbek', 'English', 'Russian'
  customTitle?: string;
  telegramChatId?: string | null;
  userKey?: string | null;
}

type FileCategory = 'excel' | 'docx' | 'doc' | 'rtf' | 'text';

function getGenAIClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error(
      'GEMINI_API_KEY is not configured. Please add your Gemini API key in Settings > Secrets.',
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export function isSupportedWordOrExcel(filename?: string, mimeType?: string): boolean {
  const ext = path.extname(filename || '').toLowerCase();
  const mime = (mimeType || '').toLowerCase();
  if (
    ext === '.xlsx' ||
    ext === '.xls' ||
    ext === '.xlsm' ||
    ext === '.xlsb' ||
    ext === '.ods' ||
    ext === '.docx' ||
    ext === '.doc' ||
    ext === '.rtf'
  ) {
    return true;
  }
  if (
    mime.includes('spreadsheet') ||
    mime.includes('excel') ||
    mime.includes('wordprocessingml') ||
    mime === 'application/msword' ||
    mime === 'application/rtf' ||
    mime === 'text/rtf'
  ) {
    return true;
  }
  return false;
}

function classifyUpload(filename?: string, mimeType?: string): FileCategory {
  const ext = path.extname(filename || '').toLowerCase();
  const mime = (mimeType || '').toLowerCase();

  if (
    ext === '.xlsx' ||
    ext === '.xls' ||
    ext === '.xlsm' ||
    ext === '.xlsb' ||
    ext === '.ods' ||
    mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mime === 'application/vnd.ms-excel' ||
    mime === 'application/vnd.oasis.opendocument.spreadsheet'
  ) {
    return 'excel';
  }
  if (
    ext === '.docx' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return 'docx';
  }
  if (ext === '.doc' || mime === 'application/msword') {
    return 'doc';
  }
  if (ext === '.rtf' || mime === 'application/rtf' || mime === 'text/rtf') {
    return 'rtf';
  }
  return 'text';
}

function decodePlainTextBuffer(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le').trim();
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(buffer.length - 2);
    for (let i = 2; i + 1 < buffer.length; i += 2) {
      swapped[i - 2] = buffer[i + 1];
      swapped[i - 1] = buffer[i];
    }
    return swapped.toString('utf16le').trim();
  }
  return buffer.toString('utf8').replace(/^\uFEFF/, '').trim();
}

function stripRtfText(rtf: string): string {
  return rtf
    .replace(/\{\\([a-zA-Z0-9*]+)[^{}]*\}/g, ' ')
    .replace(/\\par[d]?/g, '\n')
    .replace(/\\tab/g, ' ')
    .replace(/\\'([0-9a-fA-F]{2})/g, (_m, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\[a-zA-Z]+-?\d*\s?/g, '')
    .replace(/[{}]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function htmlToAnnotatedText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
      .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**')
      .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(td|th)>/gi, ' | ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractTablesFromHtml(html: string): string[][][] {
  const tables: string[][][] = [];
  const tableMatches = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  for (const tableHtml of tableMatches) {
    const rows: string[][] = [];
    const trMatches = tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    for (const tr of trMatches) {
      const cells: string[] = [];
      const tdMatches = tr.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || [];
      for (const td of tdMatches) {
        const annotated = decodeHtmlEntities(
          td
            .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
            .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**')
            .replace(/<[^>]+>/g, ' '),
        )
          .replace(/\s+/g, ' ')
          .trim();
        cells.push(annotated);
      }
      if (cells.some((c) => c.length > 0)) {
        rows.push(cells);
      }
    }
    if (rows.length >= 2) {
      tables.push(rows);
    }
  }
  return tables;
}

async function extractWordContent(
  buffer: Buffer,
  category: 'docx' | 'doc',
): Promise<{ text: string; html: string }> {
  if (category === 'docx') {
    let html = '';
    try {
      const htmlRes = await mammoth.convertToHtml({ buffer });
      html = htmlRes.value || '';
      const annotated = htmlToAnnotatedText(html);
      if (annotated) return { text: annotated, html };
    } catch {
      // Fallback to raw text or word-extractor
    }
    try {
      const rawRes = await mammoth.extractRawText({ buffer });
      if (rawRes.value.trim()) return { text: rawRes.value.trim(), html };
    } catch {
      // Fallback to word-extractor
    }
  }

  try {
    const extractor = new WordExtractor();
    const doc = await extractor.extract(buffer);
    const text = [doc.getBody(), doc.getTextboxes(), doc.getFootnotes(), doc.getEndnotes()]
      .map((part) => part.trim())
      .filter(Boolean)
      .join('\n\n');
    if (text) return { text, html: '' };
  } catch {
    const rawRes = await mammoth.extractRawText({ buffer });
    if (rawRes.value.trim()) return { text: rawRes.value.trim(), html: '' };
  }

  return { text: '', html: '' };
}

// --- Deterministic Fast-Path Parsers (Zero AI limits, Instant Verbatim) ---

function isIndexValue(val: string): boolean {
  return /^\d{1,4}[.)]?$/.test(val.trim());
}

function isAnswerKeyValue(val: string): boolean {
  const clean = val.trim().toUpperCase();
  return /^[A-E1-5]$/.test(clean) || /^(OPT|OPTION|VARIANT|ANSWER)?\s*[A-E1-5]$/.test(clean);
}

function resolveAnswerKeyIndex(rawKey: string, options: string[]): number {
  const clean = rawKey.trim();
  if (!clean) return 0;

  const upper = clean.toUpperCase().replace(/^(ANSWER|KEY|JAVOB|ОТВЕТ)[:.\s-]*/i, '').trim();
  const letterMap: Record<string, number> = { A: 0, B: 1, C: 2, D: 3, E: 4 };
  if (upper in letterMap && letterMap[upper] < options.length) {
    return letterMap[upper];
  }
  const num = Number.parseInt(upper, 10);
  if (Number.isFinite(num) && num >= 1 && num <= options.length) {
    return num - 1;
  }
  const exactIdx = options.findIndex((o) => o.trim().toLowerCase() === clean.toLowerCase());
  return exactIdx >= 0 ? exactIdx : 0;
}

function stripOptionMarker(raw: string): { text: string; isMarked: boolean } {
  const trimmed = raw.trim();
  const hasBold = /^\*\*[\s\S]+\*\*$/.test(trimmed) || (trimmed.includes('**') && trimmed.replace(/\*\*/g, '').trim().length > 0);
  let clean = trimmed.replace(/\*\*/g, '').trim();
  let isMarked = hasBold;

  if (/^[*+✓✔☑]\s*/.test(clean)) {
    isMarked = true;
    clean = clean.replace(/^[*+✓✔☑]\s*/, '').trim();
  }
  // Remove leading A) / a. / 1) / - markers only if followed by space or parenthesis
  clean = clean.replace(/^[A-Ea-e1-5][).:\]]\s+/, '').trim();
  if (/^[*+✓✔☑]\s*/.test(clean)) {
    isMarked = true;
    clean = clean.replace(/^[*+✓✔☑]\s*/, '').trim();
  }
  return { text: clean, isMarked };
}

function looksLikeHeaderRow(row: string[]): boolean {
  const nonEmpty = row.map((c) => c.trim()).filter(Boolean);
  if (nonEmpty.length < 2) return false;
  // Real questions often end in '?' or exceed 35 chars; never treat them as headers
  if (nonEmpty.some((c) => c.endsWith('?') || c.length > 35)) {
    return false;
  }
  const hasQuestionHeader = nonEmpty.some((c) =>
    /^(question|questions|savol|savollar|вопрос|вопросы|soru|pregunta|prompt|item|test)$/i.test(c),
  );
  const hasAnswerOrOptionHeader = nonEmpty.some((c) =>
    /^(correct|correct\s*answer|answer|answer\s*key|key|javob|kalit|ответ|верный|option\s*[a-e1-5]?|variant\s*[a-e1-5]?|вариант\s*[a-e1-5]?|distractor\s*\d*|wrong\s*\d*|[a-e])$/i.test(
      c,
    ),
  );
  return hasQuestionHeader && hasAnswerOrOptionHeader;
}

function tryParseTableRowsDeterministically(rawRows: string[][]): QuestionDraft[] | null {
  if (rawRows.length < 2) return null;

  const hasHeader = looksLikeHeaderRow(rawRows[0]);
  const header = hasHeader ? rawRows[0].map((c) => c.toLowerCase().trim()) : [];
  const dataRows = hasHeader ? rawRows.slice(1) : rawRows;
  if (dataRows.length === 0) return null;

  // Check if column 0 is purely a row index (1, 2, 3...)
  const sample = dataRows.slice(0, Math.min(15, dataRows.length));
  const col0IsIndex =
    sample.length >= 2 &&
    sample.every((r) => isIndexValue(r[0] || '')) &&
    sample.some((r) => (r[1] || '').trim().length > 3);

  let qCol = col0IsIndex ? 1 : 0;
  if (hasHeader) {
    const foundQ = header.findIndex((h) => /\b(question|savol|вопрос|soru|pregunta|prompt)\b/.test(h));
    if (foundQ >= 0) qCol = foundQ;
  }

  // Gather candidate columns after qCol (or excluding qCol and index col)
  const maxCols = Math.max(...dataRows.map((r) => r.length));
  if (maxCols - qCol < 3) {
    return null; // need at least Question + 2 options
  }

  // Check if there's an explicit Answer Key column (by header or by single-letter pattern)
  let answerKeyCol = -1;
  if (hasHeader) {
    answerKeyCol = header.findIndex(
      (h, idx) =>
        idx !== qCol &&
        /\b(key|kalit|answer\s*key|correct\s*letter|correct\s*option|верный|ответ|javob)\b/.test(h) &&
        !header.some((other) => /\b(distractor|wrong|incorrect)\b/.test(other) && other === h),
    );
  }
  if (answerKeyCol < 0) {
    for (let col = qCol + 3; col < maxCols; col++) {
      const nonEmpty = sample.map((r) => (r[col] || '').trim()).filter(Boolean);
      if (nonEmpty.length >= Math.max(2, Math.floor(sample.length * 0.7)) && nonEmpty.every(isAnswerKeyValue)) {
        answerKeyCol = col;
        break;
      }
    }
  }

  // Optional explanation column from header
  const explanationCol = hasHeader
    ? header.findIndex((h) => /\b(explanation|izoh|note|comment|пояснение)\b/.test(h))
    : -1;

  // Determine option columns
  const optionCols: number[] = [];
  for (let col = 0; col < maxCols; col++) {
    if (col === qCol || col === answerKeyCol || col === explanationCol) continue;
    if (col0IsIndex && col === 0) continue;
    if (col < qCol) continue; // options follow question column
    const nonEmptyCount = sample.filter((r) => (r[col] || '').trim().length > 0).length;
    if (nonEmptyCount > 0) {
      optionCols.push(col);
    }
  }

  if (optionCols.length < 2 || optionCols.length > 6) {
    return null;
  }

  const parsed: QuestionDraft[] = [];
  for (const row of dataRows) {
    const prompt = (row[qCol] || '').replace(/^\*\*|\*\*$/g, '').trim();
    if (!prompt || prompt.length < 2) continue;

    const rawOpts = optionCols
      .map((col) => (row[col] || '').trim())
      .filter(Boolean)
      .slice(0, 5);
    if (rawOpts.length < 2) continue;

    const processedOpts = rawOpts.map(stripOptionMarker);
    const options = processedOpts.map((o) => o.text).filter(Boolean);
    if (options.length < 2) continue;

    let correctIndex = 0;
    const markedIdx = processedOpts.findIndex((o) => o.isMarked);
    if (answerKeyCol >= 0 && (row[answerKeyCol] || '').trim()) {
      correctIndex = resolveAnswerKeyIndex(row[answerKeyCol], options);
    } else if (markedIdx >= 0) {
      correctIndex = markedIdx;
    } else {
      // Standard "Question | Correct Answer | Distractor 1 | Distractor 2 ..." layout
      correctIndex = 0;
    }

    const explanation = explanationCol >= 0 ? (row[explanationCol] || '').trim() : '';

    parsed.push(
      shuffleOptions({
        prompt,
        options,
        correctIndex: Math.min(Math.max(0, correctIndex), options.length - 1),
        explanation,
      }),
    );
  }

  return parsed.length >= 1 ? parsed : null;
}

function tryParseMarkedTextDeterministically(text: string): QuestionDraft[] | null {
  const lines = text.split('\n').map((l) => l.trim());

  // Case 1: Pipe-delimited lines ("Question | Correct | Wrong1 | Wrong2 | Wrong3")
  const pipeLines = lines.filter((l) => l.includes('|') && l.split('|').length >= 3);
  if (pipeLines.length >= 2 && pipeLines.length >= lines.filter(Boolean).length * 0.5) {
    const rows = pipeLines.map((l) => l.split('|').map((c) => c.trim()));
    const fromTable = tryParseTableRowsDeterministically(rows);
    if (fromTable && fromTable.length >= 2) return fromTable;
  }

  // Case 2: Numbered questions with lettered options (A/B/C/D) and explicit marker (**bold**, *, +, ✓, or Answer: X)
  const blocks: Array<{ prompt: string; rawOptions: string[]; answerKey?: string }> = [];
  let currentPrompt: string[] = [];
  let currentOpts: string[] = [];
  let currentKey: string | undefined;

  const flushBlock = () => {
    const p = currentPrompt.join(' ').replace(/^\d+[.)]\s+/, '').replace(/^\*\*|\*\*$/g, '').trim();
    if (p && currentOpts.length >= 2) {
      blocks.push({ prompt: p, rawOptions: currentOpts, answerKey: currentKey });
    }
    currentPrompt = [];
    currentOpts = [];
    currentKey = undefined;
  };

  for (const line of lines) {
    if (!line) {
      if (currentOpts.length >= 2) {
        flushBlock();
      }
      continue;
    }

    const ansMatch = line.match(/^(?:answer|correct|key|javob|to['’]?g['’]?ri\s*javob|ответ|верный\s*ответ)\s*[:=-]\s*(.+)$/i);
    if (ansMatch && currentPrompt.length > 0) {
      currentKey = ansMatch[1].trim();
      continue;
    }

    const isQuestionStart = /^\d{1,4}[.)]\s+\S/.test(line);
    const isLetterOption = /^(?:[*+✓✔☑]\s*)?(?:\*\*)?[A-Ea-e][).:\]]\s+\S/.test(line);
    const isMarkedOption = /^[*+✓✔☑]\s+\S/.test(line);

    if (isQuestionStart && !isLetterOption) {
      if (currentOpts.length >= 2) {
        flushBlock();
      } else if (currentPrompt.length > 0 && currentOpts.length === 0) {
        currentPrompt = [];
      }
      currentPrompt.push(line);
      continue;
    }

    if (isLetterOption || (isMarkedOption && currentPrompt.length > 0)) {
      currentOpts.push(line);
      continue;
    }

    if (currentOpts.length >= 2) {
      flushBlock();
      currentPrompt.push(line);
    } else {
      currentPrompt.push(line);
    }
  }
  flushBlock();

  if (blocks.length < 3) return null;

  // Verify every block (or >=80% of blocks) has a clear correct-answer marker or key so we never guess wrong
  let confirmedCorrectCount = 0;
  const drafts: QuestionDraft[] = [];

  for (const b of blocks) {
    const processed = b.rawOptions.slice(0, 5).map(stripOptionMarker);
    const options = processed.map((o) => o.text).filter(Boolean);
    if (options.length < 2) continue;

    let correctIndex = -1;
    if (b.answerKey) {
      correctIndex = resolveAnswerKeyIndex(b.answerKey, options);
      confirmedCorrectCount++;
    } else {
      const markedIdx = processed.findIndex((o) => o.isMarked);
      if (markedIdx >= 0) {
        correctIndex = markedIdx;
        confirmedCorrectCount++;
      }
    }

    if (correctIndex < 0) correctIndex = 0;
    drafts.push(
      shuffleOptions({
        prompt: b.prompt,
        options,
        correctIndex,
        explanation: '',
      }),
    );
  }

  if (drafts.length >= 3 && confirmedCorrectCount >= Math.ceil(drafts.length * 0.8)) {
    return drafts;
  }
  return null;
}

// --- Resilient Gemini API Helpers ---

function extractErrorStatusAndMessage(err: unknown): {
  code?: number;
  message: string;
  isTransient: boolean;
  shouldFallbackModel: boolean;
} {
  const raw = err instanceof Error ? err.message : String(err);
  let parsedMsg = raw;
  let code: number | undefined;

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const obj = JSON.parse(jsonMatch[0]) as {
        error?: { code?: number; message?: string; status?: string };
      };
      if (obj?.error) {
        code = obj.error.code;
        if (obj.error.message) parsedMsg = obj.error.message;
      }
    }
  } catch {
    // keep raw message
  }

  const lower = `${raw} ${parsedMsg}`.toLowerCase();
  const isUnavailable503 =
    code === 503 ||
    lower.includes('503') ||
    lower.includes('unavailable') ||
    lower.includes('high demand') ||
    lower.includes('overloaded');
  const isRateLimit429 =
    code === 429 ||
    lower.includes('429') ||
    lower.includes('resource_exhausted') ||
    lower.includes('quota');
  const isNetwork =
    lower.includes('fetch failed') ||
    lower.includes('econnreset') ||
    lower.includes('etimedout') ||
    lower.includes('socket hang up');

  return {
    code,
    message: parsedMsg,
    isTransient: isUnavailable503 || isRateLimit429 || isNetwork,
    shouldFallbackModel: isUnavailable503 || isRateLimit429,
  };
}

function formatFriendlyGeminiError(err: unknown): Error {
  const info = extractErrorStatusAndMessage(err);
  if (info.code === 503 || info.message.toLowerCase().includes('high demand')) {
    return new Error(
      'AI servers are temporarily busy (error 503). Please wait 30 seconds and try again.',
    );
  }
  if (info.code === 429 || info.message.toLowerCase().includes('resource_exhausted')) {
    return new Error(
      'AI rate limit reached (error 429). Wait a moment and retry, or send a structured Excel/Word table file.',
    );
  }
  return new Error(info.message);
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 2): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const info = extractErrorStatusAndMessage(err);
      if (
        info.message.includes('API_KEY_INVALID') ||
        info.message.includes('PERMISSION_DENIED') ||
        info.message.includes('GEMINI_API_KEY is not configured') ||
        !info.isTransient
      ) {
        throw err;
      }
      if (i < attempts) {
        const baseMs = info.shouldFallbackModel ? 1200 : 800;
        const jitter = Math.floor(Math.random() * 400);
        await new Promise((resolve) => setTimeout(resolve, baseMs * Math.pow(2, i) + jitter));
      }
    }
  }
  throw lastErr;
}

async function generateContentResilient(params: {
  contents: string;
  systemInstruction?: string;
  responseMimeType?: string;
  responseSchema?: unknown;
}) {
  const ai = getGenAIClient();
  const buildConfig = (useThinking: boolean) => ({
    ...(params.systemInstruction ? { systemInstruction: params.systemInstruction } : {}),
    ...(useThinking ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {}),
    ...(params.responseMimeType ? { responseMimeType: params.responseMimeType } : {}),
    ...(params.responseSchema ? { responseSchema: params.responseSchema } : {}),
  });

  try {
    return await withRetry(
      () =>
        ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: params.contents,
          config: buildConfig(true),
        }),
      2,
    );
  } catch (primaryErr) {
    const info = extractErrorStatusAndMessage(primaryErr);
    if (info.shouldFallbackModel) {
      try {
        return await withRetry(
          () =>
            ai.models.generateContent({
              model: 'gemini-3.1-flash-lite',
              contents: params.contents,
              config: buildConfig(false),
            }),
          2,
        );
      } catch (fallbackErr) {
        throw formatFriendlyGeminiError(fallbackErr);
      }
    }
    throw formatFriendlyGeminiError(primaryErr);
  }
}

function safeJsonParseObject<T>(rawText: string | undefined, fallback: T): T {
  const raw = (rawText ?? '').trim();
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Strip markdown fences if present
    const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try {
      return JSON.parse(unfenced) as T;
    } catch {
      return fallback;
    }
  }
}

function salvageTruncatedQuestions(rawText: string | undefined): QuestionDraft[] {
  const raw = (rawText ?? '').trim();
  if (!raw) return [];
  // Extract individual complete question objects if outer JSON array/object was truncated
  const matches = raw.match(/\{[^{}]*"prompt"\s*:\s*"[\s\S]*?"options"\s*:\s*\[[\s\S]*?\]\s*,\s*"correctIndex"\s*:\s*\d+[^{}]*\}/g);
  if (!matches) return [];
  const recovered: QuestionDraft[] = [];
  for (const m of matches) {
    try {
      const obj = JSON.parse(m) as { prompt?: string; options?: string[]; correctIndex?: number };
      if (obj.prompt && Array.isArray(obj.options) && obj.options.length >= 2) {
        recovered.push({
          prompt: obj.prompt,
          options: obj.options,
          correctIndex: Number.isInteger(obj.correctIndex) ? (obj.correctIndex as number) : 0,
          explanation: '',
        });
      }
    } catch {
      // skip incomplete object
    }
  }
  return recovered;
}

interface ExcelSchemaDetection {
  isStructuredTable: boolean;
  hasHeaderRow: boolean;
  questionCol: number;
  layoutMode: 'first_option_correct' | 'answer_key_column';
  correctCol: number;
  optionCols: number[];
  answerKeyCol: number;
  explanationCol: number;
  detectedLanguage: string;
}

async function detectExcelSchema(sampleRows: string[][]): Promise<ExcelSchemaDetection> {
  const formattedSample = sampleRows
    .slice(0, 10)
    .map((r, idx) => `Row ${idx}: ${r.map((c, ci) => `[Col ${ci}] ${c}`).join(' | ')}`)
    .join('\n');

  const response = await generateContentResilient({
    contents: `Inspect these sample rows from an Excel exam spreadsheet and identify the column structure:\n\n${formattedSample}`,
    systemInstruction: [
      'You inspect Excel exam spreadsheets to identify which column holds the question and which columns hold the options and correct answer.',
      'Common pattern A ("first_option_correct"): One column is the question, the very next column is ALWAYS the correct answer, and the following 2-4 columns are incorrect distractors (with no separate answer key column).',
      'Common pattern B ("answer_key_column"): One column is the question, 2-5 columns are options (A/B/C/D), and another column contains the answer key (like "A", "B", "1", "2", or exact text).',
      'If each row does NOT represent one question with columns for options (for example, questions are stacked vertically across rows in 1 column), set isStructuredTable=false.',
      'Use -1 when answerKeyCol or explanationCol is not present.',
    ].join('\n'),
    responseMimeType: 'application/json',
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        isStructuredTable: { type: Type.BOOLEAN },
        hasHeaderRow: { type: Type.BOOLEAN },
        questionCol: { type: Type.INTEGER },
        layoutMode: { type: Type.STRING },
        correctCol: { type: Type.INTEGER },
        optionCols: {
          type: Type.ARRAY,
          items: { type: Type.INTEGER },
        },
        answerKeyCol: { type: Type.INTEGER },
        explanationCol: { type: Type.INTEGER },
        detectedLanguage: { type: Type.STRING },
      },
      required: [
        'isStructuredTable',
        'hasHeaderRow',
        'questionCol',
        'layoutMode',
        'correctCol',
        'optionCols',
        'answerKeyCol',
        'explanationCol',
        'detectedLanguage',
      ],
    },
  });

  return safeJsonParseObject<ExcelSchemaDetection>(response.text, {
    isStructuredTable: false,
    hasHeaderRow: false,
    questionCol: 0,
    layoutMode: 'first_option_correct',
    correctCol: 1,
    optionCols: [],
    answerKeyCol: -1,
    explanationCol: -1,
    detectedLanguage: 'Original',
  });
}

async function translateQuestionBatch(
  batch: QuestionDraft[],
  targetLanguage: string,
): Promise<QuestionDraft[]> {
  const payload = batch.map((q, idx) => ({
    idx,
    prompt: q.prompt,
    options: q.options,
    correctIndex: q.correctIndex,
  }));

  const response = await generateContentResilient({
    contents: `Translate every question and option cleanly into ${targetLanguage}. Keep exact meaning and preserve array order and correctIndex.\n\n${JSON.stringify(payload)}`,
    responseMimeType: 'application/json',
    responseSchema: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          prompt: { type: Type.STRING },
          options: { type: Type.ARRAY, items: { type: Type.STRING } },
          correctIndex: { type: Type.INTEGER },
        },
        required: ['prompt', 'options', 'correctIndex'],
      },
    },
  });

  const translated = safeJsonParseObject<Array<{ prompt?: string; options?: string[]; correctIndex?: number }>>(
    response.text,
    [],
  );

  return batch.map((fallback, idx) => {
    const q = translated[idx];
    if (!q) return fallback;
    const cleanOptions = (q.options || fallback.options).map((o) => o.trim()).filter(Boolean);
    const safeOptions = cleanOptions.length >= 2 ? cleanOptions : fallback.options;
    const safeCorrect = Math.min(
      Math.max(0, q.correctIndex ?? fallback.correctIndex),
      safeOptions.length - 1,
    );
    return {
      prompt: q.prompt?.trim() || fallback.prompt,
      options: safeOptions,
      correctIndex: safeCorrect,
      explanation: fallback.explanation,
    };
  });
}

function splitTextIntoOrderedChunks(text: string, maxChunkChars = 4500): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if (trimmed.length > maxChunkChars) {
      const lines = trimmed.split('\n');
      for (const line of lines) {
        if ((current + '\n' + line).length > maxChunkChars && current.trim()) {
          chunks.push(current.trim());
          current = line;
        } else {
          current = current ? `${current}\n${line}` : line;
        }
      }
      continue;
    }

    if ((current + '\n\n' + trimmed).length > maxChunkChars && current.trim()) {
      chunks.push(current.trim());
      current = trimmed;
    } else {
      current = current ? `${current}\n\n${trimmed}` : trimmed;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }
  return chunks;
}

async function extractTextChunkVerbatim(
  chunkText: string,
  targetLanguage: string,
  allowSubSplit = true,
): Promise<{ questions: QuestionDraft[]; detectedLanguage: string }> {
  const keepOriginal = targetLanguage.toLowerCase() === 'original';

  const systemInstruction = [
    'You are a fast, exact exam parser for Word and Excel test banks.',
    keepOriginal
      ? 'Keep the EXACT original wording and language of every question and option verbatim. Do NOT paraphrase or rewrite. Strip only list prefixes like "1.", "A)", "*", "+", or "**" bold markers.'
      : `Extract every question and option faithfully, then translate all text cleanly into ${targetLanguage}.`,
    'Output multiple-choice questions only (2 to 5 options).',
    'Detect the correct answer index (0-based):',
    '1. Look for **bold**, *, +, ✓ markers or an inline/bottom answer key (e.g. "Answer: B", "Javob: A").',
    '2. If no markers or answer key exist, check if the first option right after each question is the correct answer (Question -> Correct -> Distractors layout).',
    'Preserve exact question order. Do not add extra commentary.',
  ].join('\n');

  const response = await generateContentResilient({
    contents: `Extract all multiple-choice questions in order:\n\n${chunkText}`,
    systemInstruction,
    responseMimeType: 'application/json',
    responseSchema: {
      type: Type.OBJECT,
      properties: {
        detectedLanguage: { type: Type.STRING },
        questions: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              prompt: { type: Type.STRING },
              options: { type: Type.ARRAY, items: { type: Type.STRING } },
              correctIndex: { type: Type.INTEGER },
            },
            required: ['prompt', 'options', 'correctIndex'],
          },
        },
      },
      required: ['detectedLanguage', 'questions'],
    },
  });

  let parsed = safeJsonParseObject<{
    detectedLanguage?: string;
    questions?: Array<{ prompt?: string; options?: string[]; correctIndex?: number }>;
  }>(response.text, {});

  if (!parsed.questions || parsed.questions.length === 0) {
    const salvaged = salvageTruncatedQuestions(response.text);
    if (salvaged.length > 0) {
      parsed = { detectedLanguage: parsed.detectedLanguage || 'Original', questions: salvaged };
    } else if (allowSubSplit && chunkText.length > 1800) {
      // If JSON truncated on a dense chunk, split into two smaller halves cleanly
      const subChunks = splitTextIntoOrderedChunks(chunkText, Math.floor(chunkText.length / 2));
      if (subChunks.length > 1) {
        const allSub: QuestionDraft[] = [];
        let lang = 'Original';
        for (const sub of subChunks) {
          const subRes = await extractTextChunkVerbatim(sub, targetLanguage, false);
          if (subRes.detectedLanguage !== 'Original') lang = subRes.detectedLanguage;
          allSub.push(...subRes.questions);
        }
        return { questions: allSub, detectedLanguage: lang };
      }
    }
  }

  const cleanQuestions = (parsed.questions || [])
    .filter(
      (q) =>
        q &&
        typeof q.prompt === 'string' &&
        Array.isArray(q.options) &&
        q.options.length >= 2,
    )
    .map((q) => {
      const cleanOpts = q.options!
        .map((o) => String(o).replace(/^\*\*|\*\*$/g, '').trim())
        .filter(Boolean)
        .slice(0, 5);
      const safeOpts = cleanOpts.length >= 2 ? cleanOpts : ['Option A', 'Option B'];
      const rawIdx = Number.isInteger(q.correctIndex) ? (q.correctIndex as number) : 0;
      const safeIdx = Math.min(Math.max(0, rawIdx), safeOpts.length - 1);
      return shuffleOptions({
        prompt: q.prompt!.replace(/^\*\*|\*\*$/g, '').trim(),
        options: safeOpts,
        correctIndex: safeIdx,
        explanation: '',
      });
    });

  return {
    questions: cleanQuestions,
    detectedLanguage: parsed.detectedLanguage?.trim() || 'Original',
  };
}

async function runChunksParallelOrdered(
  chunks: string[],
  requestedLanguage: string,
  concurrency: number,
  onProgress: (processedCount: number) => void,
): Promise<{ questions: QuestionDraft[]; detectedLanguage: string }> {
  const results: Array<{ questions: QuestionDraft[]; detectedLanguage: string }> = new Array(chunks.length);
  let nextIdx = 0;
  let processed = 0;

  async function worker() {
    while (true) {
      const current = nextIdx++;
      if (current >= chunks.length) break;
      const res = await extractTextChunkVerbatim(chunks[current], requestedLanguage);
      results[current] = res;
      processed += res.questions.length;
      onProgress(processed);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, chunks.length) }, () => worker());
  await Promise.all(workers);

  const combined: QuestionDraft[] = [];
  let detectedLanguage = 'Original';
  for (const r of results) {
    if (!r) continue;
    if (detectedLanguage === 'Original' && r.detectedLanguage !== 'Original') {
      detectedLanguage = r.detectedLanguage;
    }
    combined.push(...r.questions);
  }
  return { questions: combined, detectedLanguage };
}

async function translateInParallelIfNeeded(
  drafts: QuestionDraft[],
  requestedLanguage: string,
  jobId: string,
): Promise<QuestionDraft[]> {
  if (requestedLanguage.toLowerCase() === 'original') {
    return drafts;
  }
  const batchSize = 35;
  const batches: QuestionDraft[][] = [];
  for (let i = 0; i < drafts.length; i += batchSize) {
    batches.push(drafts.slice(i, i + batchSize));
  }
  const results: QuestionDraft[][] = new Array(batches.length);
  let nextIdx = 0;
  let translatedCount = 0;

  async function worker() {
    while (true) {
      const idx = nextIdx++;
      if (idx >= batches.length) break;
      const out = await translateQuestionBatch(batches[idx], requestedLanguage);
      results[idx] = out;
      translatedCount += out.length;
      updateJob(jobId, { processedQuestions: translatedCount });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(3, batches.length) }, () => worker()),
  );
  return results.flat();
}

async function processExtractionPipeline(
  jobId: string,
  input: ExtractionInput,
): Promise<{ collectionId: string; packages: DeckDetail[] }> {
  updateJob(jobId, { status: 'processing' });

  const category = input.buffer ? classifyUpload(input.filename, input.mimeType) : 'text';
  const requestedLanguage = input.language.trim() || 'Original';
  let detectedLanguage = requestedLanguage === 'Original' ? 'Original' : requestedLanguage;
  let allQuestions: QuestionDraft[] = [];

  if (input.buffer && category === 'excel') {
    const workbook = XLSX.read(input.buffer, { type: 'buffer', cellText: true, cellDates: true });
    const allSheetRows: string[][] = [];

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        blankrows: false,
        defval: '',
      });
      for (const row of rows) {
        const cleaned = row.map((cell) => String(cell ?? '').replace(/\s+/g, ' ').trim());
        if (cleaned.some((c) => c.length > 0)) {
          allSheetRows.push(cleaned);
        }
      }
    }

    if (allSheetRows.length === 0) {
      throw new Error('The uploaded Excel spreadsheet appears to be empty.');
    }

    // 1. Instant deterministic structured Excel parser (zero AI rate limits!)
    const deterministicExcel = tryParseTableRowsDeterministically(allSheetRows);
    if (deterministicExcel && deterministicExcel.length >= 1) {
      updateJob(jobId, {
        totalEstimated: deterministicExcel.length,
        processedQuestions: deterministicExcel.length,
      });
      allQuestions = await translateInParallelIfNeeded(deterministicExcel, requestedLanguage, jobId);
    } else {
      // 2. Fallback to Gemini schema detection or chunked extraction
      const schema = await detectExcelSchema(allSheetRows.slice(0, 10));
      if (requestedLanguage === 'Original' && schema.detectedLanguage) {
        detectedLanguage = schema.detectedLanguage;
      }

      if (schema.isStructuredTable && schema.optionCols.length >= 2) {
        const dataRows = schema.hasHeaderRow ? allSheetRows.slice(1) : allSheetRows;
        updateJob(jobId, { totalEstimated: dataRows.length });

        const rawDrafts: QuestionDraft[] = [];
        for (const row of dataRows) {
          const prompt = (row[schema.questionCol] || '').trim();
          if (!prompt) continue;

          let options: string[] = [];
          let correctIndex = 0;

          if (schema.layoutMode === 'first_option_correct') {
            const correctCol = schema.correctCol >= 0 ? schema.correctCol : schema.optionCols[0];
            const correctText = (row[correctCol] || '').trim();
            const distractors = schema.optionCols
              .filter((col) => col !== correctCol)
              .map((col) => (row[col] || '').trim())
              .filter(Boolean);

            if (!correctText || distractors.length === 0) continue;
            options = [correctText, ...distractors];
            correctIndex = 0;
          } else {
            options = schema.optionCols.map((col) => (row[col] || '').trim()).filter(Boolean);
            if (options.length < 2) continue;
            const keyText = schema.answerKeyCol >= 0 ? row[schema.answerKeyCol] || '' : '';
            correctIndex = resolveAnswerKeyIndex(keyText, options);
          }

          const explanation =
            schema.explanationCol >= 0 ? (row[schema.explanationCol] || '').trim() : '';

          rawDrafts.push(
            shuffleOptions({
              prompt,
              options: options.slice(0, 5),
              correctIndex,
              explanation,
            }),
          );
        }

        allQuestions = await translateInParallelIfNeeded(rawDrafts, requestedLanguage, jobId);
        updateJob(jobId, { processedQuestions: allQuestions.length });
      } else {
        const flatText = allSheetRows.map((r) => r.filter(Boolean).join(' | ')).join('\n');
        const fastVertical = tryParseMarkedTextDeterministically(flatText);
        if (fastVertical && fastVertical.length >= 3) {
          updateJob(jobId, {
            totalEstimated: fastVertical.length,
            processedQuestions: fastVertical.length,
          });
          allQuestions = await translateInParallelIfNeeded(fastVertical, requestedLanguage, jobId);
        } else {
          const chunks = splitTextIntoOrderedChunks(flatText, 4500);
          updateJob(jobId, { totalEstimated: chunks.length * 14 });
          const res = await runChunksParallelOrdered(chunks, requestedLanguage, 3, (count) => {
            updateJob(jobId, { processedQuestions: count });
          });
          if (requestedLanguage === 'Original' && res.detectedLanguage !== 'Original') {
            detectedLanguage = res.detectedLanguage;
          }
          allQuestions = res.questions;
        }
      }
    }
  } else {
    let sourceText = '';
    let wordHtml = '';

    if (input.buffer && (category === 'docx' || category === 'doc')) {
      const content = await extractWordContent(input.buffer, category);
      sourceText = content.text;
      wordHtml = content.html;
    } else if (input.buffer && category === 'rtf') {
      sourceText = stripRtfText(decodePlainTextBuffer(input.buffer));
    } else if (input.buffer) {
      sourceText = decodePlainTextBuffer(input.buffer);
    } else if (input.rawText) {
      sourceText = input.rawText.trim();
    }

    if (!sourceText) {
      throw new Error('The uploaded file contains no readable text.');
    }

    // 1. Instant deterministic Word table parser
    if (wordHtml) {
      const tables = extractTablesFromHtml(wordHtml);
      const tableQuestions: QuestionDraft[] = [];
      for (const tbl of tables) {
        const parsed = tryParseTableRowsDeterministically(tbl);
        if (parsed) tableQuestions.push(...parsed);
      }
      if (tableQuestions.length >= 3) {
        updateJob(jobId, {
          totalEstimated: tableQuestions.length,
          processedQuestions: tableQuestions.length,
        });
        allQuestions = await translateInParallelIfNeeded(tableQuestions, requestedLanguage, jobId);
      }
    }

    // 2. Instant deterministic marked-MCQ text parser (if bold/*/+ or Answer: key is present)
    if (allQuestions.length === 0) {
      const deterministicText = tryParseMarkedTextDeterministically(sourceText);
      if (deterministicText && deterministicText.length >= 3) {
        updateJob(jobId, {
          totalEstimated: deterministicText.length,
          processedQuestions: deterministicText.length,
        });
        allQuestions = await translateInParallelIfNeeded(deterministicText, requestedLanguage, jobId);
      }
    }

    // 3. Fast parallel Gemini extractor for unstructured / unmarked Word files
    if (allQuestions.length === 0) {
      const chunks = splitTextIntoOrderedChunks(sourceText, 4500);
      updateJob(jobId, { totalEstimated: Math.max(1, chunks.length * 14) });
      const res = await runChunksParallelOrdered(chunks, requestedLanguage, 3, (count) => {
        updateJob(jobId, {
          processedQuestions: count,
          totalEstimated: Math.max(count, chunks.length * 14),
        });
      });
      if (requestedLanguage === 'Original' && res.detectedLanguage !== 'Original') {
        detectedLanguage = res.detectedLanguage;
      }
      allQuestions = res.questions;
    }
  }

  if (allQuestions.length === 0) {
    throw new Error('No multiple-choice questions could be extracted from that file.');
  }

  const baseName = (input.filename || 'Exam Deck').replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  const title = input.customTitle?.trim() || baseName || 'Exam Deck';

  const { collectionId, packages } = createPackagedCollection({
    title,
    description: `${allQuestions.length} multiple-choice questions extracted verbatim with shuffled answers.`,
    language: requestedLanguage === 'Original' ? detectedLanguage : requestedLanguage,
    sourceFilename: input.filename || 'pasted-notes.txt',
    telegramChatId: input.telegramChatId ?? null,
    userKey: input.userKey ?? null,
    questions: allQuestions,
  });

  updateJob(jobId, {
    status: 'completed',
    totalEstimated: allQuestions.length,
    processedQuestions: allQuestions.length,
    packagesCreated: packages.length,
    collectionId,
  });

  // Automatically mirror newly generated tests to the registered Telegram webhook server
  void import('./telegram.ts')
    .then(({ mirrorShareBundleToRegisteredWebhook, resolvePublicBaseUrl }) => {
      const col = getCollectionById(collectionId);
      return mirrorShareBundleToRegisteredWebhook(
        {
          collection: col,
          packages,
          userKey: input.userKey ?? null,
          telegramChatId: input.telegramChatId ?? null,
        },
        resolvePublicBaseUrl(),
      );
    })
    .catch(() => {});

  return { collectionId, packages };
}

export function startExtractionJob(
  input: ExtractionInput,
  callbacks?: {
    onComplete?: (job: ExtractionJob, packages: DeckDetail[]) => Promise<void> | void;
    onError?: (job: ExtractionJob, error: Error) => Promise<void> | void;
  },
): ExtractionJob {
  const filename = input.filename || 'Pasted Test Notes';
  const language = input.language.trim() || 'Original';

  const job = createJob({
    filename,
    language,
    telegramChatId: input.telegramChatId ?? null,
    userKey: input.userKey ?? null,
  });

  setImmediate(() => {
    void processExtractionPipeline(job.id, input)
      .then(async ({ packages }) => {
        const finished = updateJob(job.id, { status: 'completed' }) ?? job;
        if (callbacks?.onComplete) {
          await callbacks.onComplete(finished, packages);
        }
      })
      .catch(async (err) => {
        const errorObj = err instanceof Error ? err : new Error(String(err));
        const failed = updateJob(job.id, {
          status: 'failed',
          error: errorObj.message,
        }) ?? job;
        if (callbacks?.onError) {
          await callbacks.onError(failed, errorObj);
        }
      });
  });

  return job;
}
