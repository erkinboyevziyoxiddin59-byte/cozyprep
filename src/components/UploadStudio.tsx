import { useRef, useState } from 'react';
import { FileText, Loader2, Upload, X } from 'lucide-react';
import type { ExtractionJob } from '../types.ts';
import { getUserKey, startExtraction } from '../lib/api.ts';

interface UploadStudioProps {
  linkedChatId?: string | null;
  onJobStarted: (job: ExtractionJob) => void;
}

const OPTIONAL_LANGUAGES = ['English', 'Uzbek', 'Russian', 'Spanish', 'Turkish', 'German'];

const SAMPLE_TEST_TEXT = `What is the powerhouse of the eukaryotic cell? | Mitochondrion | Ribosome | Golgi body | Nucleus
Which gas makes up approximately 78% of Earth's atmosphere? | Nitrogen | Oxygen | Carbon Dioxide | Argon
What is the chemical symbol for gold? | Au | Ag | Gd | Go
In which year did the Berlin Wall fall? | 1989 | 1985 | 1991 | 1993`;

export function UploadStudio({ linkedChatId, onJobStarted }: UploadStudioProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [inputTab, setInputTab] = useState<'file' | 'paste'>('file');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [rawText, setRawText] = useState('');
  const [customTitle, setCustomTitle] = useState('');
  const [language, setLanguage] = useState('Original');
  const [customLanguage, setCustomLanguage] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveLanguage =
    language === 'Other' ? customLanguage.trim() || 'Original' : language;

  function handleFilePicked(file: File | null) {
    if (!file) return;
    setError(null);
    setSelectedFile(file);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (inputTab === 'file' && !selectedFile) {
      setError('Please choose a Word or Excel test file first.');
      return;
    }
    if (inputTab === 'paste' && !rawText.trim()) {
      setError('Please paste your test questions or rows.');
      return;
    }

    setSubmitting(true);
    try {
      const job = await startExtraction({
        file: inputTab === 'file' ? selectedFile : null,
        rawText: inputTab === 'paste' ? rawText : undefined,
        language: effectiveLanguage,
        customTitle: customTitle.trim() || undefined,
        telegramChatId: linkedChatId || undefined,
        userKey: getUserKey(),
      });
      onJobStarted(job);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start file extraction.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6">
        <h1 className="font-display text-3xl sm:text-4xl font-semibold text-[#1F2421] text-balance">
          Upload Word or Excel test banks
        </h1>
        <p className="mt-2 text-base text-[#5F6660] max-w-2xl">
          Your exact questions and answers stay verbatim while multiple-choice options are shuffled automatically. Large files split in exact order into 50-question packages and process in the background.
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="bg-white border border-[#E6E1D6] rounded-2xl p-6 sm:p-8 space-y-7"
      >
        {/* Step 1: Word or Excel Source */}
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-xl font-semibold text-[#1F2421]">
              1. Add your Word or Excel file
            </h2>
            <div className="flex items-center gap-1 p-1 bg-[#EFECE4] rounded-xl">
              <button
                type="button"
                onClick={() => setInputTab('file')}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  inputTab === 'file'
                    ? 'bg-white text-[#1F2421] shadow-xs'
                    : 'text-[#5F6660] hover:text-[#1F2421]'
                }`}
              >
                Word / Excel File
              </button>
              <button
                type="button"
                onClick={() => setInputTab('paste')}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  inputTab === 'paste'
                    ? 'bg-white text-[#1F2421] shadow-xs'
                    : 'text-[#5F6660] hover:text-[#1F2421]'
                }`}
              >
                Paste Rows
              </button>
            </div>
          </div>

          {inputTab === 'file' ? (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragging(false);
                const dropped = e.dataTransfer.files?.[0];
                if (dropped) handleFilePicked(dropped);
              }}
              className={`rounded-2xl border border-dashed p-7 text-center transition-colors ${
                isDragging
                  ? 'border-[#2F6F5E] bg-[#ECF4F1]'
                  : 'border-[#CFC8B8] bg-[#FBF9F5] hover:border-[#2F6F5E]/60'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".doc,.docx,.rtf,.xls,.xlsx,.xlsm,.ods"
                onChange={(e) => handleFilePicked(e.target.files?.[0] ?? null)}
                className="hidden"
              />

              {selectedFile ? (
                <div className="flex flex-col sm:flex-row items-center justify-between gap-4 text-left bg-white border border-[#E6E1D6] rounded-xl p-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-lg bg-[#ECF4F1] text-[#2F6F5E] flex items-center justify-center shrink-0">
                      <FileText className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-[#1F2421] truncate">
                        {selectedFile.name}
                      </p>
                      <p className="text-xs text-[#5F6660] tabular-nums">
                        {(selectedFile.size / 1024).toFixed(1)} KB · Multiple-choice · 50 per package
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedFile(null);
                      if (fileInputRef.current) fileInputRef.current.value = '';
                    }}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium text-[#5F6660] hover:text-[#C2414B] hover:bg-[#FCEEEF] transition-colors cursor-pointer shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                    Remove
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="w-11 h-11 rounded-xl bg-[#ECF4F1] text-[#2F6F5E] flex items-center justify-center mx-auto">
                    <Upload className="w-5 h-5" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-[#1F2421]">
                      Drop your Word or Excel test file here, or{' '}
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="text-[#2F6F5E] font-semibold underline underline-offset-4 hover:text-[#25594B] cursor-pointer"
                      >
                        browse files
                      </button>
                    </p>
                    <p className="mt-1 text-xs text-[#5F6660]">
                      Word (.docx, .doc, .rtf) and Excel (.xlsx, .xls, .ods) up to 20 MB
                    </p>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label htmlFor="raw-test-text" className="text-xs font-medium text-[#5F6660]">
                  Paste rows (e.g., Question | Correct Answer | Wrong 1 | Wrong 2 | Wrong 3)
                </label>
                <button
                  type="button"
                  onClick={() => setRawText(SAMPLE_TEST_TEXT)}
                  className="text-xs font-medium text-[#2F6F5E] hover:underline cursor-pointer"
                >
                  Insert sample rows
                </button>
              </div>
              <textarea
                id="raw-test-text"
                rows={7}
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                placeholder="Paste your questions and answers exactly as written..."
                className="w-full rounded-xl border border-[#E6E1D6] bg-[#FBF9F5] px-4 py-3 text-sm text-[#1F2421] placeholder:text-[#8E948E] focus:outline-none focus:border-[#2F6F5E]"
              />
            </div>
          )}
        </div>

        <hr className="border-[#E6E1D6]" />

        {/* Step 2: Language & Optional Title */}
        <div className="space-y-5">
          <h2 className="font-display text-xl font-semibold text-[#1F2421]">
            2. Language & package title
          </h2>

          <div className="space-y-2">
            <label className="block text-xs font-medium text-[#5F6660]">
              Text Language (keep exact original wording or optionally translate)
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setLanguage('Original')}
                className={`px-3.5 py-2 rounded-xl text-sm font-medium border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  language === 'Original'
                    ? 'bg-[#2F6F5E] border-[#2F6F5E] text-white'
                    : 'bg-[#FBF9F5] border-[#E6E1D6] text-[#1F2421] hover:bg-[#F3EFE6]'
                }`}
              >
                Keep Original Language (Exact Text)
              </button>
              {[...OPTIONAL_LANGUAGES, 'Other'].map((lang) => (
                <button
                  key={lang}
                  type="button"
                  onClick={() => setLanguage(lang)}
                  className={`px-3.5 py-2 rounded-xl text-sm font-medium border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    language === lang
                      ? 'bg-[#2F6F5E] border-[#2F6F5E] text-white'
                      : 'bg-[#FBF9F5] border-[#E6E1D6] text-[#1F2421] hover:bg-[#F3EFE6]'
                  }`}
                >
                  {lang}
                </button>
              ))}
            </div>
            {language === 'Other' && (
              <input
                type="text"
                value={customLanguage}
                onChange={(e) => setCustomLanguage(e.target.value)}
                placeholder="Type any target language for translation"
                className="mt-2 w-full sm:w-80 rounded-xl border border-[#E6E1D6] bg-[#FBF9F5] px-3.5 py-2 text-sm text-[#1F2421] focus:outline-none focus:border-[#2F6F5E]"
              />
            )}
          </div>

          <div className="space-y-2">
            <label htmlFor="deck-title" className="block text-xs font-medium text-[#5F6660]">
              Collection Title (optional — uses filename if left blank)
            </label>
            <input
              id="deck-title"
              type="text"
              value={customTitle}
              onChange={(e) => setCustomTitle(e.target.value)}
              placeholder="e.g. Anatomy Exam Bank (auto-split into 50-question parts)"
              className="w-full rounded-xl border border-[#E6E1D6] bg-[#FBF9F5] px-4 py-2.5 text-sm text-[#1F2421] placeholder:text-[#8E948E] focus:outline-none focus:border-[#2F6F5E]"
            />
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-[#C2414B]/30 bg-[#FCEEEF] px-4 py-3 text-sm text-[#C2414B]">
            {error}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-4 pt-2">
          <p className="text-xs text-[#5F6660]">
            Runs in the background — you can close the app anytime and return when finished.
          </p>
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-[#2F6F5E] text-white text-sm font-semibold hover:bg-[#25594B] disabled:opacity-60 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Starting background job...
              </>
            ) : (
              'Build 50-Question Packages'
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
