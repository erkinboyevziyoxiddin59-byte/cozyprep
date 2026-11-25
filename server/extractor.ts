import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import mammoth from 'mammoth';
import path from 'path';
import WordExtractor from 'word-extractor';
import * as XLSX from 'xlsx';
import {
  createJob,
  createPackagedCollection,
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

function htmlToAnnotatedText(html: string): string {
  return html
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
    .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function extractWordText(buffer: Buffer, category: 'docx' | 'doc'): Promise<string> {
  if (category === 'docx') {
    try {
      const htmlRes = await mammoth.convertToHtml({ buffer });
      const annotated = htmlToAnnotatedText(htmlRes.value);
      if (annotated) return annotated;
    } catch {
      // Fallback to raw text or word-extractor
    }
    try {
      const rawRes = await mammoth.extractRawText({ buffer });
      if (rawRes.value.trim()) return rawRes.value.trim();
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
    if (text) return text;
  } catch {
    // Final fallback to mammoth if a .docx was named .doc
    const rawRes = await mammoth.extractRawText({ buffer });
    if (rawRes.value.trim()) return rawRes.value.trim();
  }

  return '';
}

function extractErrorStatusAndMessage(err: unknown): { code?: number; message: string; isTransient: boolean; isUnavailable503: boolean } {
  const raw = err instanceof Error ? err.message : String(err);
  let parsedMsg = raw;
  let code: number | undefined;

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const obj = JSON.parse(jsonMatch[0]) as { error?: { code?: number; message?: string; status?: string } };
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
    isUnavailable503,
  };
}

function formatFriendlyGeminiError(err: unknown): Error {
  const info = extractErrorStatusAndMessage(err);
  if (info.isUnavailable503) {
    return new Error(
      'Gemini AI is experiencing high demand right now (error 503). Please wait 30–60 seconds and try sending your file again.',
    );
  }
  if (info.code === 429 || info.message.toLowerCase().includes('resource_exhausted')) {
    return new Error(
      'Rate limit reached (429). Please wait a minute before uploading another large file.',
    );
  }
  return new Error(info.message);
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
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
        const baseMs = info.isUnavailable503 ? 1500 : 1000;
        const jitter = Math.floor(Math.random() * 500);
        const delayMs = baseMs * Math.pow(2, i) + jitter;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
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
      3,
    );
  } catch (primaryErr) {
    const info = extractErrorStatusAndMessage(primaryErr);
    if (info.isUnavailable503) {
      // Secondary fallback to Gemini Flash Lite during 503 high-demand spikes
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

  const parsed = JSON.parse((response.text ?? '{}').trim()) as ExcelSchemaDetection;
  return parsed;
}

function resolveAnswerKeyIndex(rawKey: string, options: string[]): number {
  const clean = rawKey.trim();
  if (!clean) return 0;

  const upper = clean.toUpperCase();
  const letterMap: Record<string, number> = { A: 0, B: 1, C: 2, D: 3, E: 4 };
  if (upper in letterMap && letterMap[upper] < options.length) {
    return letterMap[upper];
  }
  const num = Number.parseInt(clean, 10);
  if (Number.isFinite(num) && num >= 1 && num <= options.length) {
    return num - 1;
  }
  const exactIdx = options.findIndex((o) => o.trim().toLowerCase() === clean.toLowerCase());
  return exactIdx >= 0 ? exactIdx : 0;
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
    explanation: q.explanation,
  }));

  const response = await generateContentResilient({
    contents: `Translate every question, option, and explanation cleanly into ${targetLanguage}. Keep exact meaning and preserve array order and correctIndex.\n\n${JSON.stringify(payload)}`,
    responseMimeType: 'application/json',
    responseSchema: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          prompt: { type: Type.STRING },
          options: { type: Type.ARRAY, items: { type: Type.STRING } },
          correctIndex: { type: Type.INTEGER },
          explanation: { type: Type.STRING },
        },
        required: ['prompt', 'options', 'correctIndex', 'explanation'],
      },
    },
  });

  const translated = JSON.parse((response.text ?? '[]').trim()) as QuestionDraft[];
  return translated.map((q, idx) => {
    const fallback = batch[idx];
    const cleanOptions = (q.options || fallback.options).map((o) => o.trim()).filter(Boolean);
    const safeOptions = cleanOptions.length >= 2 ? cleanOptions : fallback.options;
    const safeCorrect = Math.min(Math.max(0, q.correctIndex ?? fallback.correctIndex), safeOptions.length - 1);
    return {
      prompt: q.prompt?.trim() || fallback.prompt,
      options: safeOptions,
      correctIndex: safeCorrect,
      explanation: q.explanation?.trim() || fallback.explanation,
    };
  });
}

function splitTextIntoOrderedChunks(text: string, maxChunkChars = 9000): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if (trimmed.length > maxChunkChars) {
      // Split oversized block by single lines
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
): Promise<{ questions: QuestionDraft[]; detectedLanguage: string }> {
  const keepOriginal = targetLanguage.toLowerCase() === 'original';

  const systemInstruction = [
    'You are a high-precision exam parser specialized in Word and Excel test banks.',
    keepOriginal
      ? 'CRITICAL RULE: Keep the EXACT original wording and language of every question and answer option verbatim as written in the source. Do NOT paraphrase, summarize, rewrite, or alter terminology. Only strip formatting prefixes like "1.", "A)", "*", "+", or "**" bold markers.'
      : `Extract every question and option faithfully, then translate all text cleanly into ${targetLanguage}.`,
    'All questions must be Multiple Choice with 2 to 5 options.',
    'How to recognize the correct answer in source files:',
    '1. If a question is followed by options with NO markers or answer key, check if the first option right after the question is consistently the correct answer (common test-bank layout: Question -> Correct Answer -> Distractors) OR if markers exist.',
    '2. If options have markers like **bold text**, *, +, ✓, or highlighted tags, that marked option is the correct answer.',
    '3. If an inline or bottom answer key (e.g., "Answer: B" or "Javob: A") is present, match it accurately.',
    'Set correctIndex to the exact 0-based index of the correct answer BEFORE any shuffling.',
    'Include a short, helpful 1-sentence explanation only if clear (or leave empty string "" if none is needed).',
    'Preserve the exact original order of questions.',
  ].join('\n');

  const response = await generateContentResilient({
    contents: `Extract all multiple-choice questions in exact order from this test bank chunk:\n\n${chunkText}`,
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
              explanation: { type: Type.STRING },
            },
            required: ['prompt', 'options', 'correctIndex', 'explanation'],
          },
        },
      },
      required: ['detectedLanguage', 'questions'],
    },
  });

  const parsed = JSON.parse((response.text ?? '{}').trim()) as {
    detectedLanguage?: string;
    questions?: QuestionDraft[];
  };

  const cleanQuestions = (parsed.questions || [])
    .filter((q) => q && typeof q.prompt === 'string' && Array.isArray(q.options) && q.options.length >= 2)
    .map((q) => {
      const cleanOpts = q.options
        .map((o) => String(o).replace(/^\*\*|\*\*$/g, '').trim())
        .filter(Boolean)
        .slice(0, 5);
      const safeOpts = cleanOpts.length >= 2 ? cleanOpts : ['Option A', 'Option B'];
      const rawIdx = Number.isInteger(q.correctIndex) ? q.correctIndex : 0;
      const safeIdx = Math.min(Math.max(0, rawIdx), safeOpts.length - 1);
      return shuffleOptions({
        prompt: q.prompt.replace(/^\*\*|\*\*$/g, '').trim(),
        options: safeOpts,
        correctIndex: safeIdx,
        explanation: typeof q.explanation === 'string' ? q.explanation.trim() : '',
      });
    });

  return {
    questions: cleanQuestions,
    detectedLanguage: parsed.detectedLanguage?.trim() || 'Original',
  };
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

      if (requestedLanguage !== 'Original') {
        const batchSize = 35;
        for (let i = 0; i < rawDrafts.length; i += batchSize) {
          const slice = rawDrafts.slice(i, i + batchSize);
          const translated = await translateQuestionBatch(slice, requestedLanguage);
          allQuestions.push(...translated);
          updateJob(jobId, { processedQuestions: allQuestions.length });
        }
      } else {
        allQuestions = rawDrafts;
        updateJob(jobId, { processedQuestions: allQuestions.length });
      }
    } else {
      // Unstructured vertical Excel sheet -> chunked verbatim parser
      const flatText = allSheetRows.map((r) => r.filter(Boolean).join(' | ')).join('\n');
      const chunks = splitTextIntoOrderedChunks(flatText, 12000);
      updateJob(jobId, { totalEstimated: chunks.length * 20 });
      for (const chunk of chunks) {
        const res = await extractTextChunkVerbatim(chunk, requestedLanguage);
        if (requestedLanguage === 'Original' && res.detectedLanguage !== 'Original') {
          detectedLanguage = res.detectedLanguage;
        }
        allQuestions.push(...res.questions);
        updateJob(jobId, { processedQuestions: allQuestions.length });
      }
    }
  } else {
    let sourceText = '';
    if (input.buffer && (category === 'docx' || category === 'doc')) {
      sourceText = await extractWordText(input.buffer, category);
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

    const chunks = splitTextIntoOrderedChunks(sourceText, 12000);
    updateJob(jobId, { totalEstimated: Math.max(1, chunks.length * 18) });

    for (const chunk of chunks) {
      const res = await extractTextChunkVerbatim(chunk, requestedLanguage);
      if (requestedLanguage === 'Original' && res.detectedLanguage !== 'Original') {
        detectedLanguage = res.detectedLanguage;
      }
      allQuestions.push(...res.questions);
      updateJob(jobId, {
        processedQuestions: allQuestions.length,
        totalEstimated: Math.max(allQuestions.length, chunks.length * 18),
      });
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
    questions: allQuestions,
  });

  updateJob(jobId, {
    status: 'completed',
    totalEstimated: allQuestions.length,
    processedQuestions: allQuestions.length,
    packagesCreated: packages.length,
    collectionId,
  });

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
