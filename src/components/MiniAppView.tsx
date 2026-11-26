import { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  ExternalLink,
  FolderOpen,
  Link2,
  Loader2,
  Plus,
  Send,
  Share2,
  Trophy,
  UserCheck,
  X,
} from 'lucide-react';
import type {
  Attempt,
  DeckDetail,
  ExamDeck,
  ExtractionJob,
  StudyMode,
  TestCollection,
} from '../types.ts';
import {
  bindTelegramId,
  extractShareTargetFromParams,
  fetchAllProgress,
  fetchCollectionDetail,
  fetchCollections,
  fetchDeckDetail,
  fetchJobs,
  fetchRecentAttempts,
  getRawBrowserKey,
  getUserKey,
  implementShareInput,
  implementSharedCollection,
  implementSharedDeck,
  sendQuizToTelegram,
  startExtraction,
  verifyMiniAppInitData,
} from '../lib/api.ts';
import { PracticeRunner } from './PracticeRunner.tsx';
import { ShareModal, type ShareTarget } from './ShareModal.tsx';

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        ready: () => void;
        expand: () => void;
        openTelegramLink?: (url: string) => void;
        initData?: string;
        initDataUnsafe?: {
          start_param?: string;
          user?: {
            id?: number;
            first_name?: string;
            username?: string;
          };
        };
      };
    };
  }
}

type MiniTab = 'decks' | 'quiz' | 'results';

type ProgressSummary = Record<
  string,
  { currentIndex: number; answeredCount: number; mode: StudyMode; updatedAt: string }
>;

export function MiniAppView({ onSwitchToWeb }: { onSwitchToWeb?: () => void }) {
  const [tab, setTab] = useState<MiniTab>('decks');
  const [collections, setCollections] = useState<TestCollection[]>([]);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<ExtractionJob[]>([]);
  const [progressMap, setProgressMap] = useState<ProgressSummary>({});
  const [activeDeck, setActiveDeck] = useState<DeckDetail | null>(null);
  const [attempts, setAttempts] = useState<
    Array<Attempt & { deckTitle: string; deckLanguage: string }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [chatId, setChatId] = useState<string>(
    () => localStorage.getItem('cozyprep_chat_id') || '',
  );
  const [tgIdInput, setTgIdInput] = useState<string>(
    () => localStorage.getItem('cozyprep_chat_id') || '',
  );
  const [editingTgId, setEditingTgId] = useState(false);
  const [firstName, setFirstName] = useState<string | null>(null);
  const [isInsideTelegram, setIsInsideTelegram] = useState(false);
  const [toast, setToast] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [sendingDeckId, setSendingDeckId] = useState<string | null>(null);
  const [dismissedJobIds, setDismissedJobIds] = useState<Record<string, boolean>>({});

  // Quick mobile upload sheet state (Word & Excel only, multiple choice only)
  const [showUploadSheet, setShowUploadSheet] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadLang, setUploadLang] = useState('Original');
  const [startingJob, setStartingJob] = useState(false);

  // Share modal & Open Shared Link sheet
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);
  const [showImportSheet, setShowImportSheet] = useState(false);
  const [importInput, setImportInput] = useState('');
  const [importingShare, setImportingShare] = useState(false);

  const prevActiveJobIdsRef = useRef<Set<string>>(new Set());
  const effectiveUserKey = chatId.trim() || getUserKey();

  const selectedCollection =
    collections.find((c) => c.id === selectedCollectionId) ?? null;

  async function refreshAll(verifiedChatId?: string, handleDeepLinks = false) {
    const cleanChat = verifiedChatId?.trim() || chatId.trim() || undefined;
    const rawKey = getRawBrowserKey();
    const progressKey = cleanChat || rawKey;
    setLoading(true);
    try {
      if (handleDeepLinks) {
        const params = new URLSearchParams(window.location.search);
        const startParam = window.Telegram?.WebApp?.initDataUnsafe?.start_param ?? null;
        const target = extractShareTargetFromParams(params, startParam);

        if (target.shareDeckCode) {
          try {
            const detail = await implementSharedDeck(target.shareDeckCode, {
              userKey: rawKey,
              chatId: cleanChat,
            });
            setActiveDeck(detail);
            setTab('quiz');
            setToast({
              type: 'ok',
              text: `Saved "${detail.title}" to your Mini App tests. Solve anytime — progress saves automatically.`,
            });
          } catch {
            // ignore invalid share code
          }
        } else if (target.shareCollectionCode) {
          try {
            const col = await implementSharedCollection(target.shareCollectionCode, {
              userKey: rawKey,
              chatId: cleanChat,
            });
            setSelectedCollectionId(col.id);
            setTab('decks');
            setToast({
              type: 'ok',
              text: `Saved "${col.title}" (${col.packageCount} packages) to your Mini App tests.`,
            });
          } catch {
            // ignore invalid shareCol code
          }
        } else if (target.collectionId) {
          try {
            const col = await fetchCollectionDetail(target.collectionId);
            setSelectedCollectionId(col.id);
            setTab('decks');
          } catch {
            // ignore
          }
        } else if (target.deckId) {
          try {
            const detail = await fetchDeckDetail(target.deckId);
            setActiveDeck(detail);
            setTab('quiz');
          } catch {
            // ignore
          }
        }
      }

      const [colList, recent, jobList, progress] = await Promise.all([
        fetchCollections({ chatId: cleanChat, userKey: rawKey }),
        fetchRecentAttempts({ chatId: cleanChat, userKey: rawKey }),
        fetchJobs({ userKey: progressKey, chatId: cleanChat }),
        fetchAllProgress(rawKey, cleanChat),
      ]);
      setCollections(colList);
      setAttempts(recent);
      setJobs(jobList);
      setProgressMap(progress);
    } catch {
      // ignore initial error
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const paramTgId = params.get('tgId')?.trim();
    const tg = window.Telegram?.WebApp;

    if (tg && (tg.initData || tg.initDataUnsafe?.user?.id)) {
      setIsInsideTelegram(true);
      tg.ready();
      tg.expand();

      if (tg.initData) {
        void verifyMiniAppInitData(tg.initData).then(async (res) => {
          if (res.valid && res.chatId) {
            setChatId(res.chatId);
            setTgIdInput(res.chatId);
            setFirstName(res.firstName ?? null);
            await bindTelegramId(res.chatId);
            void refreshAll(res.chatId, true);
          } else if (!res.botConfigured && tg.initDataUnsafe?.user?.id) {
            const unsafeId = String(tg.initDataUnsafe.user.id);
            setChatId(unsafeId);
            setTgIdInput(unsafeId);
            setFirstName(tg.initDataUnsafe.user.first_name ?? null);
            await bindTelegramId(unsafeId);
            void refreshAll(unsafeId, true);
          } else {
            void refreshAll(undefined, true);
          }
        });
      } else if (tg.initDataUnsafe?.user?.id) {
        const unsafeId = String(tg.initDataUnsafe.user.id);
        setChatId(unsafeId);
        setTgIdInput(unsafeId);
        setFirstName(tg.initDataUnsafe.user.first_name ?? null);
        void bindTelegramId(unsafeId).then(() => refreshAll(unsafeId, true));
      }
    } else if (paramTgId && /^-?\d{4,20}$/.test(paramTgId)) {
      setChatId(paramTgId);
      setTgIdInput(paramTgId);
      void bindTelegramId(paramTgId).then(() => refreshAll(paramTgId, true));
    } else {
      if (tg) {
        tg.ready();
        tg.expand();
      }
      void refreshAll(undefined, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll background jobs while any job is queued or processing
  useEffect(() => {
    const activeJobs = jobs.filter((j) => j.status === 'queued' || j.status === 'processing');
    activeJobs.forEach((j) => prevActiveJobIdsRef.current.add(j.id));

    if (activeJobs.length === 0) return;

    const timer = window.setInterval(() => {
      void fetchJobs({ userKey: effectiveUserKey, chatId: chatId.trim() || undefined })
        .then(async (latest) => {
          setJobs(latest);
          const newlyDone = latest.find(
            (j) =>
              prevActiveJobIdsRef.current.has(j.id) &&
              (j.status === 'completed' || j.status === 'failed'),
          );
          if (newlyDone) {
            prevActiveJobIdsRef.current.delete(newlyDone.id);
            const [colList, progress] = await Promise.all([
              fetchCollections({
                chatId: chatId.trim() || undefined,
                userKey: getRawBrowserKey(),
              }),
              fetchAllProgress(getRawBrowserKey(), chatId.trim() || undefined),
            ]);
            setCollections(colList);
            setProgressMap(progress);
            if (newlyDone.status === 'completed') {
              setToast({
                type: 'ok',
                text: `Ready! Built ${newlyDone.packagesCreated} package(s) (${newlyDone.processedQuestions} questions) from "${newlyDone.filename}".`,
              });
            } else if (newlyDone.error) {
              setToast({ type: 'err', text: newlyDone.error });
            }
          }
        })
        .catch(() => {});
    }, 1000);

    return () => window.clearInterval(timer);
  }, [jobs, effectiveUserKey, chatId]);

  async function openDeckInQuiz(deckId: string) {
    try {
      const detail = await fetchDeckDetail(deckId);
      setActiveDeck(detail);
      setTab('quiz');
    } catch (err) {
      setToast({
        type: 'err',
        text: err instanceof Error ? err.message : 'Unable to open package.',
      });
    }
  }

  async function handleSendToBotChat(deckId: string) {
    const cleanId = chatId.trim();
    if (!cleanId) {
      setToast({
        type: 'err',
        text: 'Link your Chat ID in the Telegram tab or open this Mini App from your Telegram bot.',
      });
      return;
    }
    setSendingDeckId(deckId);
    setToast(null);
    try {
      const res = await sendQuizToTelegram({ deckId, chatId: cleanId });
      setToast({
        type: 'ok',
        text: `Sent ${res.sentCount} quiz polls for "${res.deckTitle}"!${
          res.remainingCount > 0
            ? ` Tap Next Batch in chat for the remaining ${res.remainingCount}.`
            : ''
        }`,
      });
    } catch (err) {
      setToast({
        type: 'err',
        text: err instanceof Error ? err.message : 'Could not send quiz polls.',
      });
    } finally {
      setSendingDeckId(null);
    }
  }

  function handleSharePackage(deck: ExamDeck) {
    setShareTarget({ kind: 'deck', item: deck });
  }

  function handleShareCollection(col: TestCollection) {
    setShareTarget({ kind: 'collection', item: col });
  }

  async function handleImportShared(e: React.FormEvent) {
    e.preventDefault();
    if (!importInput.trim()) return;
    setImportingShare(true);
    setToast(null);
    try {
      const cleanChat = chatId.trim() || undefined;
      const result = await implementShareInput(importInput.trim(), {
        userKey: getRawBrowserKey(),
        chatId: cleanChat,
      });
      setShowImportSheet(false);
      setImportInput('');
      await refreshAll(cleanChat, false);
      if (result.kind === 'deck') {
        setActiveDeck(result.deck);
        setTab('quiz');
        setToast({
          type: 'ok',
          text: `Saved "${result.deck.title}" to your Mini App tests!`,
        });
      } else {
        setSelectedCollectionId(result.collection.id);
        setTab('decks');
        setToast({
          type: 'ok',
          text: `Saved "${result.collection.title}" (${result.collection.packageCount} packages) to your Mini App tests!`,
        });
      }
    } catch (err) {
      setToast({
        type: 'err',
        text: err instanceof Error ? err.message : 'Could not find that shared package or code.',
      });
    } finally {
      setImportingShare(false);
    }
  }

  async function handleQuickUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!uploadFile) return;
    setStartingJob(true);
    setToast(null);
    try {
      const job = await startExtraction({
        file: uploadFile,
        language: uploadLang,
        telegramChatId: chatId.trim() || undefined,
        userKey: effectiveUserKey,
      });
      setJobs((prev) => [job, ...prev]);
      setShowUploadSheet(false);
      setUploadFile(null);
      setSelectedCollectionId(null);
      setTab('decks');
      setToast({
        type: 'ok',
        text: `Processing "${job.filename}" in the background. You can close the Mini App anytime and return when ready.`,
      });
    } catch (err) {
      setToast({
        type: 'err',
        text: err instanceof Error ? err.message : 'File extraction could not start.',
      });
    } finally {
      setStartingJob(false);
    }
  }

  const visibleJobs = jobs.filter((j) => {
    if (dismissedJobIds[j.id]) return false;
    if (j.status === 'queued' || j.status === 'processing' || j.status === 'failed') return true;
    const ageMs = Date.now() - new Date(j.updatedAt).getTime();
    return ageMs < 15 * 60 * 1000;
  });

  return (
    <div className="min-h-screen bg-[#FBF9F5] text-[#1F2421] flex flex-col">
      {/* Compact 52px Mobile Header */}
      <header className="sticky top-0 z-30 h-13 px-4 bg-[#FBF9F5]/92 backdrop-blur-md border-b border-[#E6E1D6] flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-display text-lg font-semibold text-[#1F2421] truncate">
            CozyPrep{firstName ? ` · ${firstName}` : ''}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setShowUploadSheet(true)}
            className="inline-flex items-center gap-1 min-h-[36px] px-3 rounded-xl bg-[#2F6F5E] text-white text-xs font-semibold hover:bg-[#25594B] cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            Add File
          </button>
          {!isInsideTelegram && onSwitchToWeb && (
            <button
              type="button"
              onClick={onSwitchToWeb}
              aria-label="Open Web Studio"
              className="inline-flex items-center gap-1 min-h-[36px] px-2.5 rounded-xl border border-[#E6E1D6] bg-white text-xs font-medium text-[#5F6660] hover:text-[#1F2421] cursor-pointer"
            >
              Web
              <ExternalLink className="w-3 h-3" />
            </button>
          )}
        </div>
      </header>

      {/* Toast Notification */}
      {toast && (
        <div className="px-4 pt-3">
          <div
            className={`rounded-xl px-4 py-3 text-xs font-medium border flex items-center justify-between gap-2 ${
              toast.type === 'ok'
                ? 'bg-[#ECF4F1] border-[#2F6F5E]/30 text-[#1F2421]'
                : 'bg-[#FCEEEF] border-[#C2414B]/30 text-[#C2414B]'
            }`}
          >
            <span className="break-all">{toast.text}</span>
            <button
              type="button"
              onClick={() => setToast(null)}
              className="p-1 rounded-md hover:bg-black/5 cursor-pointer shrink-0"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Main Scrollable Content */}
      <main className="flex-1 px-4 pt-4 pb-24 max-w-2xl w-full mx-auto">
        {tab === 'decks' && (
          <div className="space-y-4">
            {!selectedCollection ? (
              <>
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <h1 className="font-display text-2xl font-semibold text-[#1F2421]">
                      My Tests
                    </h1>
                    <p className="text-xs text-[#5F6660] tabular-nums">
                      {collections.length} {collections.length === 1 ? 'test' : 'tests'}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowImportSheet(true)}
                    className="inline-flex items-center gap-1.5 min-h-[38px] px-3 rounded-xl border border-[#E6E1D6] bg-white text-xs font-semibold text-[#2F6F5E] hover:bg-[#ECF4F1] cursor-pointer"
                  >
                    <Link2 className="w-3.5 h-3.5" />
                    Open Shared Link
                  </button>
                </div>

                <div className="bg-white border border-[#E6E1D6] rounded-2xl px-4 py-3 space-y-2">
                  {chatId && !editingTgId ? (
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 min-w-0 text-xs text-[#1F2421]">
                        <UserCheck className="w-4 h-4 text-[#2F6F5E] shrink-0" />
                        <span className="truncate font-medium">
                          Telegram ID <span className="font-mono">{chatId}</span> · Saved on Web
                        </span>
                      </div>
                      {!isInsideTelegram && (
                        <button
                          type="button"
                          onClick={() => {
                            setTgIdInput(chatId);
                            setEditingTgId(true);
                          }}
                          className="text-xs font-semibold text-[#2F6F5E] hover:underline shrink-0 cursor-pointer"
                        >
                          Change
                        </button>
                      )}
                    </div>
                  ) : !isInsideTelegram ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const clean = tgIdInput.trim();
                        if (clean && !/^-?\d{4,20}$/.test(clean)) {
                          setToast({
                            type: 'err',
                            text: 'Please enter a numeric Telegram ID (e.g. 123456789).',
                          });
                          return;
                        }
                        if (!clean) {
                          localStorage.removeItem('cozyprep_chat_id');
                          setChatId('');
                          setEditingTgId(false);
                          void refreshAll(undefined, false);
                          return;
                        }
                        setChatId(clean);
                        setEditingTgId(false);
                        void bindTelegramId(clean).then(() => refreshAll(clean, false));
                      }}
                      className="flex items-center gap-2"
                    >
                      <input
                        type="text"
                        inputMode="numeric"
                        value={tgIdInput}
                        onChange={(e) => setTgIdInput(e.target.value)}
                        placeholder="Telegram ID (e.g. 123456789)"
                        className="flex-1 min-w-0 rounded-xl border border-[#E6E1D6] bg-[#FBF9F5] px-3 py-1.5 font-mono text-xs text-[#1F2421] focus:outline-none focus:border-[#2F6F5E]"
                      />
                      <button
                        type="submit"
                        className="px-3 py-1.5 rounded-xl bg-[#ECF4F1] border border-[#2F6F5E]/30 text-[#2F6F5E] text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        Sync ID
                      </button>
                      {editingTgId && (
                        <button
                          type="button"
                          onClick={() => setEditingTgId(false)}
                          className="p-1.5 rounded-lg text-[#5F6660] hover:bg-[#EFECE4] cursor-pointer"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </form>
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-[#5F6660]">
                      <UserCheck className="w-4 h-4 text-[#2F6F5E] shrink-0" />
                      <span>All tests and answers save automatically for your Telegram session.</span>
                    </div>
                  )}
                </div>

                {/* Background Extraction Jobs */}
                {visibleJobs.length > 0 && (
                  <div className="space-y-2">
                    {visibleJobs.map((job) => {
                      const isRunning = job.status === 'queued' || job.status === 'processing';
                      return (
                        <div
                          key={job.id}
                          className={`rounded-2xl border p-3.5 flex items-start justify-between gap-3 ${
                            job.status === 'failed'
                              ? 'bg-[#FCEEEF] border-[#C2414B]/30'
                              : job.status === 'completed'
                                ? 'bg-[#ECF4F1] border-[#2F6F5E]/30'
                                : 'bg-white border-[#E6E1D6]'
                          }`}
                        >
                          <div className="flex items-start gap-2.5 min-w-0">
                            {isRunning ? (
                              <Loader2 className="w-4 h-4 text-[#2F6F5E] animate-spin mt-0.5 shrink-0" />
                            ) : job.status === 'completed' ? (
                              <CheckCircle2 className="w-4 h-4 text-[#2F6F5E] mt-0.5 shrink-0" />
                            ) : (
                              <AlertCircle className="w-4 h-4 text-[#C2414B] mt-0.5 shrink-0" />
                            )}
                            <div className="min-w-0">
                              <p className="text-xs font-semibold text-[#1F2421] truncate">
                                {job.filename}
                              </p>
                              <p className="text-[11px] text-[#5F6660] tabular-nums mt-0.5">
                                {job.status === 'queued' && 'Queued for background extraction...'}
                                {job.status === 'processing' &&
                                  `Processing · ${job.processedQuestions} questions extracted so far (safe to close app)`}
                                {job.status === 'completed' &&
                                  `Completed · ${job.processedQuestions} questions split into ${job.packagesCreated} package(s)`}
                                {job.status === 'failed' && (job.error || 'Extraction failed')}
                              </p>
                            </div>
                          </div>
                          {!isRunning && (
                            <button
                              type="button"
                              onClick={() =>
                                setDismissedJobIds((prev) => ({ ...prev, [job.id]: true }))
                              }
                              aria-label="Dismiss status"
                              className="p-1 rounded-lg text-[#5F6660] hover:bg-black/5 cursor-pointer shrink-0"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {loading ? (
                  <div className="py-12 text-center text-sm text-[#5F6660]">
                    Loading your tests...
                  </div>
                ) : collections.length === 0 ? (
                  <div className="bg-white border border-[#E6E1D6] rounded-2xl p-6 text-center space-y-3">
                    <p className="font-display text-lg font-semibold text-[#1F2421]">
                      Your study desk is ready
                    </p>
                    <p className="text-sm text-[#5F6660]">
                      Tap Add File above, send a Word or Excel test file to your Telegram bot, or open a shared package link from a classmate.
                    </p>
                    <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => setShowUploadSheet(true)}
                        className="min-h-[44px] px-4 py-2 rounded-xl bg-[#2F6F5E] text-white text-xs font-semibold cursor-pointer"
                      >
                        Upload Word or Excel File
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowImportSheet(true)}
                        className="min-h-[44px] px-4 py-2 rounded-xl border border-[#E6E1D6] bg-[#FBF9F5] text-[#1F2421] text-xs font-semibold cursor-pointer"
                      >
                        Paste Shared Link / Code
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {collections.map((col) => {
                      const singlePkg = col.packageCount === 1 ? col.packages[0] : null;
                      const activePkg = col.packages.find((p) => {
                        const saved = progressMap[p.id];
                        return saved && (saved.answeredCount > 0 || saved.currentIndex > 0);
                      });
                      const savedForActive = activePkg ? progressMap[activePkg.id] : null;

                      return (
                        <div
                          key={col.id}
                          className="bg-white border border-[#E6E1D6] rounded-2xl p-4 space-y-3"
                        >
                          <div>
                            <h2 className="font-display text-lg font-semibold text-[#1F2421] leading-snug">
                              {col.title}
                            </h2>
                            <p className="mt-1 text-xs text-[#5F6660] tabular-nums">
                              {col.language} · {col.totalQuestions} questions · {col.packageCount}{' '}
                              {col.packageCount === 1 ? 'package' : 'packages'}
                              {col.isSharedWithMe ? ' · Shared with you' : ''}
                              {activePkg && savedForActive
                                ? ` · In progress: Part ${activePkg.partNumber} Q${savedForActive.currentIndex + 1}`
                                : ''}
                            </p>
                          </div>

                          <div className="flex items-center gap-2">
                            {singlePkg ? (
                              <>
                                <button
                                  type="button"
                                  onClick={() => void openDeckInQuiz(singlePkg.id)}
                                  className="flex-1 min-h-[44px] px-3 py-2 rounded-xl bg-[#2F6F5E] text-white text-xs font-semibold hover:bg-[#25594B] transition-colors cursor-pointer"
                                >
                                  {savedForActive
                                    ? `Resume (Q${Math.min(savedForActive.currentIndex + 1, singlePkg.questionCount ?? 1)}/${singlePkg.questionCount ?? 0})`
                                    : 'Solve in App'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void handleSendToBotChat(singlePkg.id)}
                                  disabled={sendingDeckId === singlePkg.id}
                                  className="min-h-[44px] px-3 py-2 rounded-xl border border-[#E6E1D6] bg-[#FBF9F5] text-[#1F2421] text-xs font-semibold hover:bg-[#EFECE4] inline-flex items-center justify-center gap-1.5 disabled:opacity-60 transition-colors cursor-pointer shrink-0"
                                >
                                  {sendingDeckId === singlePkg.id ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  ) : (
                                    <Send className="w-3.5 h-3.5 text-[#2F6F5E]" />
                                  )}
                                  Chat Quiz
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void handleSharePackage(singlePkg)}
                                  aria-label={`Share ${col.title}`}
                                  className="min-h-[44px] min-w-[44px] px-3 py-2 rounded-xl border border-[#E6E1D6] bg-[#FBF9F5] text-[#1F2421] hover:bg-[#EFECE4] inline-flex items-center justify-center transition-colors cursor-pointer shrink-0"
                                >
                                  <Share2 className="w-4 h-4 text-[#2F6F5E]" />
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  onClick={() => setSelectedCollectionId(col.id)}
                                  className="flex-1 min-h-[44px] px-3 py-2 rounded-xl bg-[#2F6F5E] text-white text-xs font-semibold hover:bg-[#25594B] inline-flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                                >
                                  <FolderOpen className="w-3.5 h-3.5" />
                                  Open Test ({col.packageCount} Packages)
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void handleShareCollection(col)}
                                  aria-label={`Share ${col.title}`}
                                  className="min-h-[44px] min-w-[44px] px-3 py-2 rounded-xl border border-[#E6E1D6] bg-[#FBF9F5] text-[#1F2421] hover:bg-[#EFECE4] inline-flex items-center justify-center transition-colors cursor-pointer shrink-0"
                                >
                                  <Share2 className="w-4 h-4 text-[#2F6F5E]" />
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            ) : (
              /* Single Test Page showing all ordered 50-question packages inside */
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedCollectionId(null)}
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-[#5F6660] hover:text-[#1F2421] min-h-[40px] px-2 -ml-2 rounded-lg cursor-pointer"
                  >
                    <ArrowLeft className="w-4 h-4" />
                    All Tests
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleShareCollection(selectedCollection)}
                    className="inline-flex items-center gap-1.5 min-h-[36px] px-3 rounded-xl border border-[#E6E1D6] bg-white text-xs font-semibold text-[#2F6F5E] cursor-pointer"
                  >
                    <Share2 className="w-3.5 h-3.5" />
                    Share Whole Test
                  </button>
                </div>

                <div className="bg-white border border-[#E6E1D6] rounded-2xl p-4">
                  <h1 className="font-display text-xl font-semibold text-[#1F2421] leading-snug">
                    {selectedCollection.title}
                  </h1>
                  <p className="mt-1 text-xs text-[#5F6660] tabular-nums">
                    {selectedCollection.language} · {selectedCollection.totalQuestions} questions ·{' '}
                    {selectedCollection.packageCount} ordered packages (up to 50 each)
                  </p>
                </div>

                <div className="space-y-3">
                  {selectedCollection.packages.map((pkg) => {
                    const saved = progressMap[pkg.id];
                    const qCount = pkg.questionCount ?? 0;
                    const canResume =
                      Boolean(saved) &&
                      qCount > 0 &&
                      (saved.answeredCount > 0 || saved.currentIndex > 0);
                    const btnLabel = canResume
                      ? `Resume (Q${Math.min(saved.currentIndex + 1, qCount)}/${qCount})`
                      : `Solve Part ${pkg.partNumber}`;

                    return (
                      <div
                        key={pkg.id}
                        className="bg-white border border-[#E6E1D6] rounded-2xl p-4 space-y-3"
                      >
                        <div>
                          <h2 className="font-display text-base font-semibold text-[#1F2421]">
                            Part {pkg.partNumber} of {pkg.totalParts} · Questions {pkg.rangeStart}–{pkg.rangeEnd}
                          </h2>
                          <p className="mt-0.5 text-xs text-[#5F6660] tabular-nums">
                            {qCount} questions
                            {pkg.lastScore
                              ? ` · Last ${pkg.lastScore.score}/${pkg.lastScore.total}`
                              : ''}
                          </p>
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => void openDeckInQuiz(pkg.id)}
                            className="flex-1 min-h-[44px] px-3 py-2 rounded-xl bg-[#2F6F5E] text-white text-xs font-semibold hover:bg-[#25594B] transition-colors cursor-pointer"
                          >
                            {btnLabel}
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleSendToBotChat(pkg.id)}
                            disabled={sendingDeckId === pkg.id}
                            className="min-h-[44px] px-3 py-2 rounded-xl border border-[#E6E1D6] bg-[#FBF9F5] text-[#1F2421] text-xs font-semibold hover:bg-[#EFECE4] inline-flex items-center justify-center gap-1.5 disabled:opacity-60 transition-colors cursor-pointer shrink-0"
                          >
                            {sendingDeckId === pkg.id ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Send className="w-3.5 h-3.5 text-[#2F6F5E]" />
                            )}
                            Chat Quiz
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleSharePackage(pkg)}
                            aria-label={`Share Part ${pkg.partNumber}`}
                            className="min-h-[44px] min-w-[44px] px-3 py-2 rounded-xl border border-[#E6E1D6] bg-[#FBF9F5] text-[#1F2421] hover:bg-[#EFECE4] inline-flex items-center justify-center transition-colors cursor-pointer shrink-0"
                          >
                            <Share2 className="w-4 h-4 text-[#2F6F5E]" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'quiz' && (
          <div>
            {activeDeck ? (
              <PracticeRunner
                deck={activeDeck}
                userKey={effectiveUserKey}
                source="miniapp"
                variant="miniapp"
                onExit={() => {
                  if (activeDeck.collectionId) {
                    setSelectedCollectionId(activeDeck.collectionId);
                  }
                  setTab('decks');
                  void fetchAllProgress(getRawBrowserKey(), chatId.trim() || undefined)
                    .then(setProgressMap)
                    .catch(() => {});
                }}
                onDeckUpdated={(updated) => setActiveDeck(updated)}
                onSharePackage={() => void handleSharePackage(activeDeck)}
                onSendToTelegram={() => void handleSendToBotChat(activeDeck.id)}
                onAttemptSaved={() => void refreshAll(chatId || undefined)}
              />
            ) : (
              <div className="bg-white border border-[#E6E1D6] rounded-2xl p-6 text-center space-y-3">
                <p className="text-sm text-[#5F6660]">Pick a test package first to start practicing.</p>
                <button
                  type="button"
                  onClick={() => setTab('decks')}
                  className="min-h-[44px] px-5 py-2 rounded-xl bg-[#2F6F5E] text-white text-sm font-semibold cursor-pointer"
                >
                  Browse Tests
                </button>
              </div>
            )}
          </div>
        )}

        {tab === 'results' && (
          <div className="space-y-4">
            <h1 className="font-display text-2xl font-semibold text-[#1F2421]">
              Recent Study Results
            </h1>

            {attempts.length === 0 ? (
              <div className="bg-white border border-[#E6E1D6] rounded-2xl p-6 text-center text-sm text-[#5F6660]">
                Complete a quiz or timed exam to see your score history here.
              </div>
            ) : (
              <div className="bg-white border border-[#E6E1D6] rounded-2xl divide-y divide-[#E6E1D6]">
                {attempts.map((a) => {
                  const pct = Math.round((a.score / a.total) * 100);
                  return (
                    <div key={a.id} className="p-4 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-[#1F2421] truncate">
                          {a.deckTitle}
                        </p>
                        <p className="text-xs text-[#5F6660] mt-0.5">
                          {a.mode === 'exam' ? 'Timed Exam' : 'Cozy Quiz'} · {a.deckLanguage}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="font-mono tabular-nums text-sm font-semibold text-[#2F6F5E]">
                          {a.score}/{a.total}
                        </p>
                        <p className="font-mono tabular-nums text-xs text-[#5F6660]">{pct}%</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </main>

      {/* Bottom Thumb-Zone Navigation (16 height = 64px) */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 bg-white/92 backdrop-blur-md border-t border-[#E6E1D6]">
        <div className="max-w-2xl mx-auto grid grid-cols-3 h-16 pb-safe">
          <button
            type="button"
            onClick={() => setTab('decks')}
            className={`flex flex-col items-center justify-center min-h-[44px] transition-colors cursor-pointer ${
              tab === 'decks' ? 'text-[#2F6F5E]' : 'text-[#5F6660]'
            }`}
          >
            <BookOpen className="w-5 h-5" />
            <span className="text-[11px] font-medium mt-1">Tests</span>
          </button>
          <button
            type="button"
            onClick={() => setTab('quiz')}
            className={`flex flex-col items-center justify-center min-h-[44px] transition-colors cursor-pointer ${
              tab === 'quiz' ? 'text-[#2F6F5E]' : 'text-[#5F6660]'
            }`}
          >
            <CheckCircle2 className="w-5 h-5" />
            <span className="text-[11px] font-medium mt-1">Quiz</span>
          </button>
          <button
            type="button"
            onClick={() => setTab('results')}
            className={`flex flex-col items-center justify-center min-h-[44px] transition-colors cursor-pointer ${
              tab === 'results' ? 'text-[#2F6F5E]' : 'text-[#5F6660]'
            }`}
          >
            <Trophy className="w-5 h-5" />
            <span className="text-[11px] font-medium mt-1">Results</span>
          </button>
        </div>
      </nav>

      {/* Mobile Bottom Sheet for Word / Excel Upload */}
      {showUploadSheet && (
        <div className="fixed inset-0 z-50 bg-[#1F2421]/50 backdrop-blur-xs flex items-end justify-center">
          <form
            onSubmit={handleQuickUpload}
            className="bg-white w-full max-w-xl rounded-t-3xl p-5 space-y-4 border-t border-[#E6E1D6]"
          >
            <div className="w-10 h-1.5 bg-[#E6E1D6] rounded-full mx-auto" />
            <div className="flex items-center justify-between">
              <h2 className="font-display text-xl font-semibold text-[#1F2421]">
                Upload Word or Excel Test
              </h2>
              <button
                type="button"
                onClick={() => setShowUploadSheet(false)}
                className="w-9 h-9 rounded-lg flex items-center justify-center text-[#5F6660] cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-1.5">
              <input
                type="file"
                accept=".doc,.docx,.rtf,.xls,.xlsx,.xlsm,.ods"
                onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
                className="w-full text-sm text-[#5F6660] file:mr-3 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-[#ECF4F1] file:text-[#2F6F5E]"
              />
              <p className="text-[11px] text-[#5F6660]">
                Word (.docx, .doc, .rtf) & Excel (.xlsx, .xls, .ods) · Keeps exact wording · Splits into 50-question packages
              </p>
            </div>

            <div>
              <label
                htmlFor="miniapp-upload-lang"
                className="block text-xs font-medium text-[#5F6660] mb-1"
              >
                Language
              </label>
              <select
                id="miniapp-upload-lang"
                value={uploadLang}
                onChange={(e) => setUploadLang(e.target.value)}
                className="w-full rounded-xl border border-[#E6E1D6] bg-[#FBF9F5] px-3 py-2.5 text-sm text-[#1F2421]"
              >
                <option value="Original">Keep Original Language (Exact Text)</option>
                <option value="English">Translate to English</option>
                <option value="Uzbek">Translate to Uzbek</option>
                <option value="Russian">Translate to Russian</option>
                <option value="Spanish">Translate to Spanish</option>
                <option value="Turkish">Translate to Turkish</option>
                <option value="German">Translate to German</option>
              </select>
            </div>

            <button
              type="submit"
              disabled={!uploadFile || startingJob}
              className="w-full h-12 rounded-xl bg-[#2F6F5E] text-white font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer"
            >
              {startingJob ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Starting background job...
                </>
              ) : (
                'Build 50-Question Packages'
              )}
            </button>
          </form>
        </div>
      )}

      {/* Mobile Bottom Sheet for Opening a Shared Link / Code */}
      {showImportSheet && (
        <div className="fixed inset-0 z-50 bg-[#1F2421]/50 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4">
          <form
            onSubmit={handleImportShared}
            className="bg-white w-full max-w-md rounded-t-3xl sm:rounded-2xl p-5 space-y-4 border border-[#E6E1D6]"
          >
            <div className="w-10 h-1.5 bg-[#E6E1D6] rounded-full mx-auto sm:hidden" />
            <div className="flex items-center justify-between">
              <h2 className="font-display text-xl font-semibold text-[#1F2421]">
                Open Shared Package
              </h2>
              <button
                type="button"
                onClick={() => setShowImportSheet(false)}
                className="w-9 h-9 rounded-lg flex items-center justify-center text-[#5F6660] cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-xs text-[#5F6660] leading-relaxed">
              Paste a shared Telegram package link or code (like <code className="font-mono">pkg_ABCD1234</code>). It will be saved permanently inside your Mini App tests.
            </p>

            <input
              type="text"
              value={importInput}
              onChange={(e) => setImportInput(e.target.value)}
              placeholder="Paste share link or pkg_... code"
              required
              className="w-full rounded-xl border border-[#E6E1D6] bg-[#FBF9F5] px-3.5 py-2.5 text-sm text-[#1F2421] focus:outline-none focus:border-[#2F6F5E]"
            />

            <button
              type="submit"
              disabled={!importInput.trim() || importingShare}
              className="w-full h-12 rounded-xl bg-[#2F6F5E] text-white font-semibold text-sm flex items-center justify-center gap-2 disabled:opacity-50 cursor-pointer"
            >
              {importingShare ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Saving to your tests...
                </>
              ) : (
                'Save & Open in Mini App'
              )}
            </button>
          </form>
        </div>
      )}

      {/* Interactive Share Sheet */}
      {shareTarget && (
        <ShareModal
          target={shareTarget}
          preferMiniAppPath={true}
          onClose={() => setShareTarget(null)}
        />
      )}
    </div>
  );
}
