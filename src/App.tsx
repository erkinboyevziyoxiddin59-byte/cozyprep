import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  Edit3,
  FolderOpen,
  Link2,
  Loader2,
  Play,
  Search,
  Send,
  Share2,
  Trash2,
  Upload,
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
} from './types.ts';
import {
  bindTelegramId,
  deleteCollectionById,
  deleteDeckById,
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
} from './lib/api.ts';
import { DeckEditorModal } from './components/DeckEditorModal.tsx';
import { MiniAppView } from './components/MiniAppView.tsx';
import { PracticeRunner } from './components/PracticeRunner.tsx';
import { ShareModal, type ShareTarget } from './components/ShareModal.tsx';
import { TelegramHub } from './components/TelegramHub.tsx';
import { UploadStudio } from './components/UploadStudio.tsx';

type WebTab = 'library' | 'upload' | 'practice' | 'telegram';

type ProgressSummary = Record<
  string,
  { currentIndex: number; answeredCount: number; mode: StudyMode; updatedAt: string }
>;

export default function App() {
  const [isMiniAppRoute, setIsMiniAppRoute] = useState<boolean>(() => {
    const pathMatch = window.location.pathname.startsWith('/miniapp');
    const queryMatch = new URLSearchParams(window.location.search).get('mode') === 'miniapp';
    const tgInit = Boolean(window.Telegram?.WebApp?.initData);
    return pathMatch || queryMatch || tgInit;
  });

  const [tab, setTab] = useState<WebTab>('library');
  const [collections, setCollections] = useState<TestCollection[]>([]);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<ExtractionJob[]>([]);
  const [progressMap, setProgressMap] = useState<ProgressSummary>({});
  const [attempts, setAttempts] = useState<
    Array<Attempt & { deckTitle: string; deckLanguage: string }>
  >([]);
  const [loadingDecks, setLoadingDecks] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [languageFilter, setLanguageFilter] = useState('All');

  const [activeDeck, setActiveDeck] = useState<DeckDetail | null>(null);
  const [editingDeck, setEditingDeck] = useState<DeckDetail | null>(null);

  const [linkedChatId, setLinkedChatId] = useState<string>(
    () => localStorage.getItem('cozyprep_chat_id') || '',
  );
  const [tgIdInput, setTgIdInput] = useState<string>(
    () => localStorage.getItem('cozyprep_chat_id') || '',
  );
  const [editingTgId, setEditingTgId] = useState(false);
  const [sendModalDeck, setSendModalDeck] = useState<ExamDeck | null>(null);
  const [sendingTelegram, setSendingTelegram] = useState(false);
  const [bannerMessage, setBannerMessage] = useState<{ type: 'ok' | 'err'; text: string } | null>(
    null,
  );
  const [dismissedJobIds, setDismissedJobIds] = useState<Record<string, boolean>>({});
  const [heroImgFailed, setHeroImgFailed] = useState(false);
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importInput, setImportInput] = useState('');
  const [importingShare, setImportingShare] = useState(false);

  const prevActiveJobIdsRef = useRef<Set<string>>(new Set());
  const effectiveUserKey = linkedChatId.trim() || getUserKey();

  const allDecks = useMemo(
    () => collections.flatMap((c) => c.packages),
    [collections],
  );

  const selectedCollection = useMemo(
    () => collections.find((c) => c.id === selectedCollectionId) ?? null,
    [collections, selectedCollectionId],
  );

  async function refreshData(handleDeepLinks = false, overrideChatId?: string) {
    setLoadingDecks(true);
    try {
      const cleanChat = (overrideChatId !== undefined ? overrideChatId : linkedChatId).trim() || undefined;
      const rawKey = getRawBrowserKey();
      const progressKey = cleanChat || rawKey;

      if (handleDeepLinks) {
        const params = new URLSearchParams(window.location.search);
        const paramTgId = params.get('tgId')?.trim();
        let activeChat = cleanChat;
        if (paramTgId && /^-?\d{4,20}$/.test(paramTgId)) {
          activeChat = paramTgId;
          setLinkedChatId(paramTgId);
          setTgIdInput(paramTgId);
          await bindTelegramId(paramTgId);
        }

        const startParam = window.Telegram?.WebApp?.initDataUnsafe?.start_param ?? null;
        const target = extractShareTargetFromParams(params, startParam);

        if (target.shareDeckCode) {
          try {
            const shared = await implementSharedDeck(target.shareDeckCode, {
              userKey: rawKey,
              chatId: activeChat,
            });
            setActiveDeck(shared);
            setTab('practice');
            setBannerMessage({
              type: 'ok',
              text: `Saved "${shared.title}" to your tests. You can solve it anytime and resume automatically.`,
            });
          } catch {
            // ignore invalid share param
          }
        } else if (target.shareCollectionCode) {
          try {
            const col = await implementSharedCollection(target.shareCollectionCode, {
              userKey: rawKey,
              chatId: activeChat,
            });
            setSelectedCollectionId(col.id);
            setTab('library');
            setBannerMessage({
              type: 'ok',
              text: `Saved "${col.title}" (${col.packageCount} packages) to your library.`,
            });
          } catch {
            // ignore invalid shareCol param
          }
        } else if (target.collectionId) {
          try {
            const col = await fetchCollectionDetail(target.collectionId);
            setSelectedCollectionId(col.id);
            setTab('library');
          } catch {
            // ignore
          }
        } else if (target.deckId) {
          try {
            const detail = await fetchDeckDetail(target.deckId);
            setActiveDeck(detail);
            setTab('practice');
          } catch {
            // ignore
          }
        }
      }

      const activeChat = (overrideChatId !== undefined ? overrideChatId : linkedChatId).trim() || undefined;
      const [colList, recent, jobList, progress] = await Promise.all([
        fetchCollections({ chatId: activeChat, userKey: rawKey }),
        fetchRecentAttempts({ chatId: activeChat, userKey: rawKey }),
        fetchJobs({ userKey: activeChat || rawKey, chatId: activeChat }),
        fetchAllProgress(rawKey, activeChat),
      ]);
      setCollections(colList);
      setAttempts(recent);
      setJobs(jobList);
      setProgressMap(progress);
    } catch {
      // handled cleanly via empty/error state
    } finally {
      setLoadingDecks(false);
    }
  }

  useEffect(() => {
    if (!isMiniAppRoute) {
      void refreshData(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMiniAppRoute]);

  // Poll background extraction jobs every 2 seconds while active
  useEffect(() => {
    if (isMiniAppRoute) return;
    const activeJobs = jobs.filter((j) => j.status === 'queued' || j.status === 'processing');
    activeJobs.forEach((j) => prevActiveJobIdsRef.current.add(j.id));

    if (activeJobs.length === 0) return;

    const timer = window.setInterval(() => {
      const cleanChat = linkedChatId.trim() || undefined;
      const rawKey = getRawBrowserKey();
      void fetchJobs({
        userKey: effectiveUserKey,
        chatId: cleanChat,
      })
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
              fetchCollections({ chatId: cleanChat, userKey: rawKey }),
              fetchAllProgress(rawKey, cleanChat),
            ]);
            setCollections(colList);
            setProgressMap(progress);
            if (newlyDone.status === 'completed') {
              setBannerMessage({
                type: 'ok',
                text: `Ready! Built "${newlyDone.filename}" (${newlyDone.processedQuestions} questions in ${newlyDone.packagesCreated} ordered package(s)).`,
              });
            } else if (newlyDone.error) {
              setBannerMessage({ type: 'err', text: newlyDone.error });
            }
          }
        })
        .catch(() => {});
    }, 1000);

    return () => window.clearInterval(timer);
  }, [jobs, isMiniAppRoute, effectiveUserKey, linkedChatId]);

  function handleChatIdChange(nextId: string) {
    const clean = nextId.trim();
    setLinkedChatId(clean);
    setTgIdInput(clean);
    if (clean) {
      void bindTelegramId(clean).then(() => refreshData(false, clean));
    } else {
      localStorage.removeItem('cozyprep_chat_id');
      void refreshData(false, '');
    }
  }

  function switchToMiniApp() {
    window.history.pushState({}, '', '/miniapp');
    setIsMiniAppRoute(true);
  }

  function switchToWeb() {
    window.history.pushState({}, '', '/');
    setIsMiniAppRoute(false);
    void refreshData();
  }

  const availableLanguages = useMemo(() => {
    const langs = new Set<string>(['All']);
    collections.forEach((c) => langs.add(c.language));
    return Array.from(langs);
  }, [collections]);

  const filteredCollections = useMemo(() => {
    return collections.filter((c) => {
      const matchesLang = languageFilter === 'All' || c.language === languageFilter;
      const q = searchQuery.trim().toLowerCase();
      const matchesSearch =
        !q ||
        c.title.toLowerCase().includes(q) ||
        (c.sourceFilename || '').toLowerCase().includes(q) ||
        c.language.toLowerCase().includes(q);
      return matchesLang && matchesSearch;
    });
  }, [collections, languageFilter, searchQuery]);

  const visibleJobs = useMemo(() => {
    return jobs.filter((j) => {
      if (dismissedJobIds[j.id]) return false;
      if (j.status === 'queued' || j.status === 'processing' || j.status === 'failed') return true;
      const ageMs = Date.now() - new Date(j.updatedAt).getTime();
      return ageMs < 15 * 60 * 1000;
    });
  }, [jobs, dismissedJobIds]);

  async function openPractice(deckId: string) {
    try {
      const detail = await fetchDeckDetail(deckId);
      setActiveDeck(detail);
      setTab('practice');
    } catch (err) {
      setBannerMessage({
        type: 'err',
        text: err instanceof Error ? err.message : 'Unable to open exam package.',
      });
    }
  }

  async function openEditor(deckId: string) {
    try {
      const detail = await fetchDeckDetail(deckId);
      setEditingDeck(detail);
    } catch (err) {
      setBannerMessage({
        type: 'err',
        text: err instanceof Error ? err.message : 'Unable to load package for editing.',
      });
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
    setBannerMessage(null);
    try {
      const cleanChat = linkedChatId.trim() || undefined;
      const result = await implementShareInput(importInput.trim(), {
        userKey: getRawBrowserKey(),
        chatId: cleanChat,
      });
      setShowImportModal(false);
      setImportInput('');
      await refreshData(false);
      if (result.kind === 'deck') {
        setActiveDeck(result.deck);
        setTab('practice');
        setBannerMessage({
          type: 'ok',
          text: `Saved "${result.deck.title}" to your tests!`,
        });
      } else {
        setSelectedCollectionId(result.collection.id);
        setTab('library');
        setBannerMessage({
          type: 'ok',
          text: `Saved "${result.collection.title}" (${result.collection.packageCount} packages) to your tests!`,
        });
      }
    } catch (err) {
      setBannerMessage({
        type: 'err',
        text: err instanceof Error ? err.message : 'Could not find that shared package or code.',
      });
    } finally {
      setImportingShare(false);
    }
  }

  async function handleDeleteDeck(deck: ExamDeck) {
    try {
      await deleteDeckById(deck.id);
      if (activeDeck?.id === deck.id) {
        setActiveDeck(null);
      }
      await refreshData();
    } catch (err) {
      setBannerMessage({
        type: 'err',
        text: err instanceof Error ? err.message : 'Could not delete package.',
      });
    }
  }

  async function handleDeleteCollection(col: TestCollection) {
    try {
      await deleteCollectionById(col.id);
      if (selectedCollectionId === col.id) {
        setSelectedCollectionId(null);
      }
      if (activeDeck && activeDeck.collectionId === col.id) {
        setActiveDeck(null);
      }
      await refreshData();
      setBannerMessage({ type: 'ok', text: `Deleted "${col.title}" and its packages.` });
    } catch (err) {
      setBannerMessage({
        type: 'err',
        text: err instanceof Error ? err.message : 'Could not delete test file.',
      });
    }
  }

  async function handleConfirmSendModal(e: React.FormEvent) {
    e.preventDefault();
    if (!sendModalDeck) return;
    if (!linkedChatId.trim()) {
      setBannerMessage({
        type: 'err',
        text: 'Please enter your Telegram Chat ID first.',
      });
      return;
    }
    setSendingTelegram(true);
    try {
      const res = await sendQuizToTelegram({
        deckId: sendModalDeck.id,
        chatId: linkedChatId.trim(),
      });
      setSendModalDeck(null);
      setBannerMessage({
        type: 'ok',
        text: `Sent ${res.sentCount} interactive quiz polls for "${res.deckTitle}" to Telegram!${
          res.remainingCount > 0
            ? ` (${res.remainingCount} more ready via Next Batch button in chat)`
            : ''
        }`,
      });
    } catch (err) {
      setBannerMessage({
        type: 'err',
        text: err instanceof Error ? err.message : 'Could not send quiz to Telegram.',
      });
    } finally {
      setSendingTelegram(false);
    }
  }

  if (isMiniAppRoute) {
    return <MiniAppView onSwitchToWeb={switchToWeb} />;
  }

  return (
    <div className="min-h-screen bg-[#FBF9F5] text-[#1F2421] flex flex-col">
      {/* Top Bar Contract: 3 exact zones separated by gap-8 */}
      <header className="sticky top-0 z-30 bg-[#FBF9F5]/92 backdrop-blur-md border-b border-[#E6E1D6]">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between gap-8">
          {/* Zone 1: Single-line Wordmark */}
          <button
            type="button"
            onClick={() => {
              setSelectedCollectionId(null);
              setTab('library');
            }}
            className="font-display text-xl font-semibold tracking-tight text-[#1F2421] whitespace-nowrap shrink-0 cursor-pointer"
          >
            CozyPrep
          </button>

          {/* Zone 2: 4 single-line text nav links */}
          <nav className="hidden md:flex items-center gap-7 text-sm font-medium">
            {[
              { id: 'library', label: 'Library' },
              { id: 'upload', label: 'Upload Test' },
              { id: 'practice', label: 'Practice' },
              { id: 'telegram', label: 'Telegram Bot' },
            ].map((item) => {
              const isActive = tab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    if (item.id === 'practice' && !activeDeck && allDecks[0]) {
                      void openPractice(allDecks[0].id);
                    } else {
                      if (item.id === 'library') setSelectedCollectionId(null);
                      setTab(item.id as WebTab);
                    }
                  }}
                  className={`py-1 whitespace-nowrap shrink-0 border-b-2 transition-colors cursor-pointer ${
                    isActive
                      ? 'text-[#1F2421] border-[#2F6F5E]'
                      : 'text-[#5F6660] border-transparent hover:text-[#1F2421]'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>

          {/* Zone 3: 1 Primary CTA */}
          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={() => setTab('upload')}
              className="px-4 py-2 rounded-xl bg-[#2F6F5E] text-white text-sm font-medium hover:bg-[#25594B] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              New Test
            </button>
          </div>
        </div>

        {/* Mobile Nav Strip */}
        <div className="md:hidden px-4 pb-2 flex items-center gap-4 overflow-x-auto text-xs font-medium">
          {[
            { id: 'library', label: 'Library' },
            { id: 'upload', label: 'Upload Test' },
            { id: 'practice', label: 'Practice' },
            { id: 'telegram', label: 'Telegram Bot' },
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                if (item.id === 'library') setSelectedCollectionId(null);
                setTab(item.id as WebTab);
              }}
              className={`py-1.5 whitespace-nowrap shrink-0 border-b-2 ${
                tab === item.id
                  ? 'text-[#1F2421] border-[#2F6F5E]'
                  : 'text-[#5F6660] border-transparent'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-6 py-8 sm:py-10 space-y-8">
        {bannerMessage && (
          <div
            className={`rounded-xl px-4 py-3 text-sm border flex items-center justify-between gap-4 ${
              bannerMessage.type === 'ok'
                ? 'bg-[#ECF4F1] border-[#2F6F5E]/30 text-[#1F2421]'
                : 'bg-[#FCEEEF] border-[#C2414B]/30 text-[#C2414B]'
            }`}
          >
            <span className="break-all">{bannerMessage.text}</span>
            <button
              type="button"
              onClick={() => setBannerMessage(null)}
              className="p-1 rounded-lg hover:bg-black/5 cursor-pointer shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {tab === 'library' && (
          <div className="space-y-10">
            {!selectedCollection ? (
              <>
                {/* Editorial Welcome Hero */}
                <section className="bg-white border border-[#E6E1D6] rounded-3xl overflow-hidden grid grid-cols-1 lg:grid-cols-12 items-stretch">
                  <div className="lg:col-span-7 p-7 sm:p-10 flex flex-col justify-center space-y-5">
                    <p className="text-xs font-medium text-[#5F6660]">
                      Morning Study Desk · Word & Excel Test Banks + Telegram Quiz Bot
                    </p>
                    <h1 className="font-display text-3xl sm:text-4xl lg:text-[2.6rem] font-semibold text-[#1F2421] leading-tight text-balance">
                      Prepare for exams calmly with exact test packages
                    </h1>
                    <p className="text-base text-[#5F6660] max-w-xl leading-relaxed">
                      Upload a Word or Excel test file here or send it to your Telegram bot. Questions keep their exact wording, options shuffle automatically, large files organize into 50-question packages inside one test page, and progress saves as you go.
                    </p>
                    <div className="flex flex-wrap items-center gap-3 pt-1">
                      <button
                        type="button"
                        onClick={() => setTab('upload')}
                        className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-[#2F6F5E] text-white text-sm font-semibold hover:bg-[#25594B] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <Upload className="w-4 h-4" />
                        Upload Word / Excel
                      </button>
                      <button
                        type="button"
                        onClick={() => setTab('telegram')}
                        className="inline-flex items-center gap-2 px-5 py-3 rounded-xl border border-[#E6E1D6] bg-[#FBF9F5] text-[#1F2421] text-sm font-medium hover:bg-[#EFECE4] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <Send className="w-4 h-4 text-[#2F6F5E]" />
                        Open Telegram Hub
                      </button>
                    </div>
                  </div>

                  <div className="lg:col-span-5 min-h-[240px] bg-[#EFECE4]">
                    {!heroImgFailed ? (
                      <img
                        src="/src/assets/images/cozy_study_desk_1795595372220.jpg"
                        alt="Open study notebook with handwritten notes and a warm cup of tea on a sunlit linen desk"
                        referrerPolicy="no-referrer"
                        onError={() => setHeroImgFailed(true)}
                        className="w-full h-full lg:h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full min-h-[240px] bg-gradient-to-br from-[#ECF4F1] via-[#FBF9F5] to-[#EFECE4] flex flex-col items-center justify-center p-8 text-center">
                        <BookOpen className="w-10 h-10 text-[#2F6F5E] mb-2" />
                        <p className="font-display text-lg font-medium text-[#1F2421]">
                          CozyPrep Study Desk
                        </p>
                      </div>
                    )}
                  </div>
                </section>

                {/* Background Extraction Jobs */}
                {visibleJobs.length > 0 && (
                  <section className="space-y-3">
                    <h2 className="font-display text-lg font-semibold text-[#1F2421]">
                      Background File Processing
                    </h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {visibleJobs.map((job) => {
                        const isRunning = job.status === 'queued' || job.status === 'processing';
                        return (
                          <div
                            key={job.id}
                            className={`rounded-2xl border p-4 flex items-start justify-between gap-3 ${
                              job.status === 'failed'
                                ? 'bg-[#FCEEEF] border-[#C2414B]/30'
                                : job.status === 'completed'
                                  ? 'bg-[#ECF4F1] border-[#2F6F5E]/30'
                                  : 'bg-white border-[#E6E1D6]'
                            }`}
                          >
                            <div className="flex items-start gap-3 min-w-0">
                              {isRunning ? (
                                <Loader2 className="w-4 h-4 text-[#2F6F5E] animate-spin mt-0.5 shrink-0" />
                              ) : job.status === 'completed' ? (
                                <CheckCircle2 className="w-4 h-4 text-[#2F6F5E] mt-0.5 shrink-0" />
                              ) : (
                                <AlertCircle className="w-4 h-4 text-[#C2414B] mt-0.5 shrink-0" />
                              )}
                              <div className="min-w-0">
                                <p className="text-sm font-semibold text-[#1F2421] truncate">
                                  {job.filename}
                                </p>
                                <p className="text-xs text-[#5F6660] tabular-nums mt-0.5">
                                  {job.status === 'queued' && 'Queued · Starting background parser...'}
                                  {job.status === 'processing' &&
                                    `Processing · ${job.processedQuestions} questions extracted · Auto-splitting into 50-question packages`}
                                  {job.status === 'completed' &&
                                    `Completed · ${job.processedQuestions} questions in ${job.packagesCreated} package(s)`}
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
                                aria-label="Dismiss background job"
                                className="p-1 rounded-lg text-[#5F6660] hover:bg-black/5 cursor-pointer shrink-0"
                              >
                                <X className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                )}

                {/* Library Controls & Collection Grid (1 Card per Uploaded File) */}
                <section className="space-y-5">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-display text-2xl font-semibold text-[#1F2421] mr-2">
                        Your Test Files
                      </h2>
                      {availableLanguages.length > 1 && (
                        <div className="flex items-center gap-1 p-1 bg-[#EFECE4] rounded-xl">
                          {availableLanguages.map((lang) => (
                            <button
                              key={lang}
                              type="button"
                              onClick={() => setLanguageFilter(lang)}
                              className={`px-3 py-1 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                                languageFilter === lang
                                  ? 'bg-white text-[#1F2421] shadow-xs'
                                  : 'text-[#5F6660] hover:text-[#1F2421]'
                              }`}
                            >
                              {lang}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2.5 w-full sm:w-auto">
                      {linkedChatId && !editingTgId ? (
                        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bg-[#ECF4F1] border border-[#2F6F5E]/25 text-xs font-medium text-[#1F2421]">
                          <UserCheck className="w-3.5 h-3.5 text-[#2F6F5E]" />
                          <span className="font-mono">{linkedChatId}</span>
                          <button
                            type="button"
                            onClick={() => {
                              setTgIdInput(linkedChatId);
                              setEditingTgId(true);
                            }}
                            className="text-[#2F6F5E] font-semibold hover:underline cursor-pointer"
                          >
                            Edit
                          </button>
                        </div>
                      ) : editingTgId ? (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            const clean = tgIdInput.trim();
                            if (clean && !/^-?\d{4,20}$/.test(clean)) {
                              setBannerMessage({
                                type: 'err',
                                text: 'Please enter a valid numeric Telegram ID (e.g. 123456789).',
                              });
                              return;
                            }
                            setEditingTgId(false);
                            handleChatIdChange(clean);
                          }}
                          className="inline-flex items-center gap-1.5"
                        >
                          <input
                            type="text"
                            inputMode="numeric"
                            value={tgIdInput}
                            onChange={(e) => setTgIdInput(e.target.value)}
                            placeholder="Telegram ID"
                            className="w-36 px-3 py-1.5 rounded-xl border border-[#E6E1D6] bg-white font-mono text-xs text-[#1F2421] focus:outline-none focus:border-[#2F6F5E]"
                          />
                          <button
                            type="submit"
                            className="px-3 py-1.5 rounded-xl bg-[#2F6F5E] text-white text-xs font-semibold cursor-pointer"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingTgId(false)}
                            aria-label="Cancel Telegram ID edit"
                            className="p-1.5 rounded-lg text-[#5F6660] hover:bg-[#EFECE4] cursor-pointer"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </form>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setEditingTgId(true)}
                          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-[#2F6F5E]/35 bg-[#ECF4F1] text-xs font-semibold text-[#2F6F5E] hover:bg-[#DFECE7] whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          <UserCheck className="w-3.5 h-3.5" />
                          Sync Telegram ID
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setShowImportModal(true)}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-[#E6E1D6] bg-white text-xs font-semibold text-[#2F6F5E] hover:bg-[#ECF4F1] whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <Link2 className="w-3.5 h-3.5" />
                        Open Shared Link
                      </button>
                      <div className="relative flex-1 sm:w-60">
                        <Search className="w-4 h-4 text-[#5F6660] absolute left-3.5 top-1/2 -translate-y-1/2" />
                        <input
                          type="text"
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          placeholder="Search test files..."
                          className="w-full pl-9 pr-3.5 py-2 rounded-xl border border-[#E6E1D6] bg-white text-sm text-[#1F2421] placeholder:text-[#8E948E] focus:outline-none focus:border-[#2F6F5E]"
                        />
                      </div>
                    </div>
                  </div>

                  {loadingDecks ? (
                    <div className="py-12 text-center text-sm text-[#5F6660]">
                      Loading your tests...
                    </div>
                  ) : filteredCollections.length === 0 ? (
                    <div className="bg-white border border-[#E6E1D6] rounded-2xl p-10 text-center space-y-3">
                      <p className="font-display text-xl font-semibold text-[#1F2421]">
                        {collections.length === 0
                          ? 'No tests uploaded yet'
                          : 'No matching test files found'}
                      </p>
                      <p className="text-sm text-[#5F6660] max-w-md mx-auto">
                        {collections.length === 0
                          ? 'Upload your first Word or Excel test file to split it into ordered 50-question packages, or open a shared package link.'
                          : 'Clear your search filter or upload a new test file.'}
                      </p>
                      {collections.length === 0 && (
                        <div className="pt-2">
                          <button
                            type="button"
                            onClick={() => setTab('upload')}
                            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#2F6F5E] text-white text-sm font-semibold hover:bg-[#25594B] cursor-pointer"
                          >
                            <Upload className="w-4 h-4" />
                            Upload Word / Excel File
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                      {filteredCollections.map((col) => {
                        const singlePkg = col.packageCount === 1 ? col.packages[0] : null;
                        const activePkg = col.packages.find((p) => {
                          const saved = progressMap[p.id];
                          return saved && (saved.answeredCount > 0 || saved.currentIndex > 0);
                        });
                        const savedForActive = activePkg ? progressMap[activePkg.id] : null;

                        return (
                          <article
                            key={col.id}
                            className="bg-white border border-[#E6E1D6] rounded-2xl p-6 flex flex-col justify-between gap-5"
                          >
                            <div className="space-y-2">
                              <p className="text-xs text-[#5F6660] tabular-nums">
                                {col.language} · {col.totalQuestions} questions · {col.packageCount}{' '}
                                {col.packageCount === 1 ? 'package' : 'packages'}
                                {col.isSharedWithMe ? ' · Shared' : ''}
                              </p>
                              <h3 className="font-display text-xl font-semibold text-[#1F2421] leading-snug">
                                {col.title}
                              </h3>
                              <p className="text-sm text-[#5F6660] leading-relaxed">
                                {activePkg && savedForActive
                                  ? `In progress: Part ${activePkg.partNumber} (Question ${savedForActive.currentIndex + 1})`
                                  : col.packageCount > 1
                                    ? `Organized into ${col.packageCount} ordered parts (up to 50 questions each).`
                                    : singlePkg?.lastScore
                                      ? `Best score: ${singlePkg.lastScore.score}/${singlePkg.lastScore.total}`
                                      : 'Multiple-choice questions with shuffled options.'}
                              </p>
                            </div>

                            <div className="pt-3 border-t border-[#E6E1D6] flex items-center justify-between gap-2">
                              {singlePkg ? (
                                <button
                                  type="button"
                                  onClick={() => void openPractice(singlePkg.id)}
                                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#2F6F5E] text-white text-xs font-semibold hover:bg-[#25594B] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                                >
                                  <Play className="w-3.5 h-3.5" />
                                  {savedForActive
                                    ? `Resume (Q${Math.min(savedForActive.currentIndex + 1, singlePkg.questionCount ?? 1)}/${singlePkg.questionCount ?? 0})`
                                    : 'Practice'}
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setSelectedCollectionId(col.id)}
                                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#2F6F5E] text-white text-xs font-semibold hover:bg-[#25594B] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                                >
                                  <FolderOpen className="w-3.5 h-3.5" />
                                  Open Test ({col.packageCount} Packages)
                                </button>
                              )}

                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() =>
                                    singlePkg
                                      ? void handleSharePackage(singlePkg)
                                      : void handleShareCollection(col)
                                  }
                                  title="Copy shareable link"
                                  className="p-2 rounded-lg text-[#5F6660] hover:text-[#2F6F5E] hover:bg-[#ECF4F1] transition-colors cursor-pointer"
                                >
                                  <Share2 className="w-4 h-4" />
                                </button>
                                {singlePkg && (
                                  <>
                                    <button
                                      type="button"
                                      onClick={() => setSendModalDeck(singlePkg)}
                                      title="Send quiz to Telegram"
                                      className="p-2 rounded-lg text-[#5F6660] hover:text-[#2F6F5E] hover:bg-[#ECF4F1] transition-colors cursor-pointer"
                                    >
                                      <Send className="w-4 h-4" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => void openEditor(singlePkg.id)}
                                      title="Edit questions"
                                      className="p-2 rounded-lg text-[#5F6660] hover:text-[#1F2421] hover:bg-[#EFECE4] transition-colors cursor-pointer"
                                    >
                                      <Edit3 className="w-4 h-4" />
                                    </button>
                                  </>
                                )}
                                <button
                                  type="button"
                                  onClick={() => void handleDeleteCollection(col)}
                                  title="Delete test file"
                                  className="p-2 rounded-lg text-[#5F6660] hover:text-[#C2414B] hover:bg-[#FCEEEF] transition-colors cursor-pointer"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </div>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  )}
                </section>

                {/* Recent Study Log */}
                {attempts.length > 0 && (
                  <section className="space-y-3">
                    <h2 className="font-display text-xl font-semibold text-[#1F2421]">
                      Recent Practice Log
                    </h2>
                    <div className="bg-white border border-[#E6E1D6] rounded-2xl divide-y divide-[#E6E1D6]">
                      {attempts.slice(0, 6).map((a) => (
                        <div
                          key={a.id}
                          className="px-5 py-3.5 flex flex-wrap items-center justify-between gap-3 text-sm"
                        >
                          <div className="min-w-0">
                            <span className="font-medium text-[#1F2421]">{a.deckTitle}</span>
                            <span className="text-xs text-[#5F6660] ml-2">
                              {a.mode === 'exam' ? 'Timed Exam' : 'Cozy Quiz'} ·{' '}
                              {a.source === 'miniapp' ? 'Mini App' : 'Web Studio'}
                            </span>
                          </div>
                          <span className="font-mono tabular-nums text-xs font-semibold text-[#2F6F5E]">
                            {a.score}/{a.total} ({Math.round((a.score / a.total) * 100)}%)
                          </span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
              </>
            ) : (
              /* Dedicated Single Test File Page containing all ordered 50-question packages */
              <div className="space-y-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => setSelectedCollectionId(null)}
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-[#5F6660] hover:text-[#1F2421] px-2 -ml-2 py-1.5 rounded-lg cursor-pointer"
                  >
                    <ArrowLeft className="w-4 h-4" />
                    Back to Test Files
                  </button>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleShareCollection(selectedCollection)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-[#E6E1D6] bg-white text-xs font-semibold text-[#2F6F5E] hover:bg-[#ECF4F1] cursor-pointer"
                    >
                      <Share2 className="w-3.5 h-3.5" />
                      Share Whole Test ({selectedCollection.packageCount} Packages)
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDeleteCollection(selectedCollection)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-[#E6E1D6] bg-white text-xs font-medium text-[#C2414B] hover:bg-[#FCEEEF] cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Delete Test
                    </button>
                  </div>
                </div>

                <div className="bg-white border border-[#E6E1D6] rounded-2xl p-6 sm:p-7">
                  <p className="text-xs text-[#5F6660] tabular-nums">
                    {selectedCollection.language} · {selectedCollection.totalQuestions} total questions ·{' '}
                    {selectedCollection.packageCount} ordered packages (up to 50 questions each)
                  </p>
                  <h1 className="mt-1 font-display text-2xl sm:text-3xl font-semibold text-[#1F2421]">
                    {selectedCollection.title}
                  </h1>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                  {selectedCollection.packages.map((pkg) => {
                    const saved = progressMap[pkg.id];
                    const qCount = pkg.questionCount ?? 0;
                    const canResume =
                      Boolean(saved) &&
                      qCount > 0 &&
                      (saved.answeredCount > 0 || saved.currentIndex > 0);
                    const ctaLabel = canResume
                      ? `Resume (Q${Math.min(saved.currentIndex + 1, qCount)}/${qCount})`
                      : `Practice Part ${pkg.partNumber}`;

                    return (
                      <article
                        key={pkg.id}
                        className="bg-white border border-[#E6E1D6] rounded-2xl p-5 flex flex-col justify-between gap-4"
                      >
                        <div className="space-y-1.5">
                          <p className="text-xs text-[#5F6660] tabular-nums">
                            Part {pkg.partNumber} of {pkg.totalParts} · Questions {pkg.rangeStart}–{pkg.rangeEnd}
                          </p>
                          <h2 className="font-display text-lg font-semibold text-[#1F2421] leading-snug">
                            Questions {pkg.rangeStart}–{pkg.rangeEnd}
                          </h2>
                          <p className="text-xs text-[#5F6660] tabular-nums">
                            {qCount} questions
                            {pkg.lastScore
                              ? ` · Best ${pkg.lastScore.score}/${pkg.lastScore.total}`
                              : ''}
                          </p>
                        </div>

                        <div className="pt-3 border-t border-[#E6E1D6] flex items-center justify-between gap-2">
                          <button
                            type="button"
                            onClick={() => void openPractice(pkg.id)}
                            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#2F6F5E] text-white text-xs font-semibold hover:bg-[#25594B] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                          >
                            <Play className="w-3.5 h-3.5" />
                            {ctaLabel}
                          </button>

                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => void handleSharePackage(pkg)}
                              title="Copy shareable package link"
                              className="p-2 rounded-lg text-[#5F6660] hover:text-[#2F6F5E] hover:bg-[#ECF4F1] transition-colors cursor-pointer"
                            >
                              <Share2 className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setSendModalDeck(pkg)}
                              title="Send quiz to Telegram"
                              className="p-2 rounded-lg text-[#5F6660] hover:text-[#2F6F5E] hover:bg-[#ECF4F1] transition-colors cursor-pointer"
                            >
                              <Send className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => void openEditor(pkg.id)}
                              title="Edit questions"
                              className="p-2 rounded-lg text-[#5F6660] hover:text-[#1F2421] hover:bg-[#EFECE4] transition-colors cursor-pointer"
                            >
                              <Edit3 className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleDeleteDeck(pkg)}
                              title="Delete package"
                              className="p-2 rounded-lg text-[#5F6660] hover:text-[#C2414B] hover:bg-[#FCEEEF] transition-colors cursor-pointer"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'upload' && (
          <UploadStudio
            linkedChatId={linkedChatId || null}
            onJobStarted={(job) => {
              setJobs((prev) => [job, ...prev]);
              setSelectedCollectionId(null);
              setTab('library');
              setBannerMessage({
                type: 'ok',
                text: `Started background processing for "${job.filename}". You can keep studying or close the app — your 50-question packages will appear inside one test file page automatically.`,
              });
            }}
          />
        )}

        {tab === 'practice' && (
          <div>
            {activeDeck ? (
              <PracticeRunner
                deck={activeDeck}
                userKey={effectiveUserKey}
                source="web"
                variant="web"
                onExit={() => {
                  if (activeDeck.collectionId) {
                    setSelectedCollectionId(activeDeck.collectionId);
                  }
                  setTab('library');
                  void fetchAllProgress(getRawBrowserKey(), linkedChatId.trim() || undefined)
                    .then(setProgressMap)
                    .catch(() => {});
                }}
                onDeckUpdated={(updated) => setActiveDeck(updated)}
                onSharePackage={() => void handleSharePackage(activeDeck)}
                onSendToTelegram={() => setSendModalDeck(activeDeck)}
                onAttemptSaved={() => void refreshData()}
              />
            ) : (
              <div className="bg-white border border-[#E6E1D6] rounded-2xl p-10 text-center space-y-4">
                <h2 className="font-display text-2xl font-semibold text-[#1F2421]">
                  Pick a package to begin
                </h2>
                <p className="text-sm text-[#5F6660]">
                  Choose a test file from your library or upload a new Word or Excel test file.
                </p>
                <button
                  type="button"
                  onClick={() => setTab('library')}
                  className="px-5 py-2.5 rounded-xl bg-[#2F6F5E] text-white text-sm font-medium cursor-pointer"
                >
                  Go to Library
                </button>
              </div>
            )}
          </div>
        )}

        {tab === 'telegram' && (
          <TelegramHub
            decks={allDecks}
            linkedChatId={linkedChatId}
            onChatIdChange={handleChatIdChange}
            onOpenMiniAppFullscreen={switchToMiniApp}
          />
        )}
      </main>

      {/* Edit Deck Modal */}
      {editingDeck && (
        <DeckEditorModal
          deck={editingDeck}
          onClose={() => setEditingDeck(null)}
          onSaved={(updated) => {
            setEditingDeck(null);
            if (activeDeck?.id === updated.id) {
              setActiveDeck(updated);
            }
            void refreshData();
            setBannerMessage({ type: 'ok', text: `Saved changes to "${updated.title}".` });
          }}
        />
      )}

      {/* Quick Send Quiz to Telegram Modal */}
      {sendModalDeck && (
        <div className="fixed inset-0 z-50 bg-[#1F2421]/45 backdrop-blur-xs flex items-center justify-center p-4">
          <form
            onSubmit={handleConfirmSendModal}
            className="bg-white border border-[#E6E1D6] rounded-2xl w-full max-w-md p-6 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h2 className="font-display text-xl font-semibold text-[#1F2421]">
                Send Quiz to Telegram
              </h2>
              <button
                type="button"
                onClick={() => setSendModalDeck(null)}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-[#5F6660] hover:bg-[#EFECE4] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-sm text-[#5F6660]">
              Send <strong className="text-[#1F2421]">{sendModalDeck.title}</strong> as interactive Quiz Polls (10 per batch) to your Telegram chat.
            </p>

            <div className="space-y-1.5">
              <label htmlFor="modal-chat-id" className="block text-xs font-medium text-[#5F6660]">
                Telegram Chat ID (message /start to your bot to get yours)
              </label>
              <input
                id="modal-chat-id"
                type="text"
                value={linkedChatId}
                onChange={(e) => handleChatIdChange(e.target.value)}
                placeholder="e.g. 123456789"
                required
                className="w-full rounded-xl border border-[#E6E1D6] bg-[#FBF9F5] px-3.5 py-2.5 font-mono text-sm text-[#1F2421] focus:outline-none focus:border-[#2F6F5E]"
              />
            </div>

            <div className="flex items-center justify-between gap-3 pt-2">
              <button
                type="button"
                onClick={() => {
                  setSendModalDeck(null);
                  setTab('telegram');
                }}
                className="text-xs font-medium text-[#2F6F5E] hover:underline cursor-pointer"
              >
                Bot Setup & 1-Tap Link
              </button>
              <button
                type="submit"
                disabled={sendingTelegram}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#2F6F5E] text-white text-sm font-semibold hover:bg-[#25594B] disabled:opacity-60 cursor-pointer"
              >
                {sendingTelegram ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Sending...
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4" />
                    Send Polls
                  </>
                )}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Open Shared Link / Code Modal */}
      {showImportModal && (
        <div className="fixed inset-0 z-50 bg-[#1F2421]/45 backdrop-blur-xs flex items-center justify-center p-4">
          <form
            onSubmit={handleImportShared}
            className="bg-white border border-[#E6E1D6] rounded-2xl w-full max-w-md p-6 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h2 className="font-display text-xl font-semibold text-[#1F2421]">
                Open Shared Package
              </h2>
              <button
                type="button"
                onClick={() => setShowImportModal(false)}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-[#5F6660] hover:bg-[#EFECE4] cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-sm text-[#5F6660]">
              Paste a shared package link or share code (such as <code className="font-mono">pkg_ABCD1234</code>). It will be saved to your tests and synced to your Mini App.
            </p>

            <input
              type="text"
              value={importInput}
              onChange={(e) => setImportInput(e.target.value)}
              placeholder="Paste share link or pkg_... code"
              required
              className="w-full rounded-xl border border-[#E6E1D6] bg-[#FBF9F5] px-3.5 py-2.5 text-sm text-[#1F2421] focus:outline-none focus:border-[#2F6F5E]"
            />

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowImportModal(false)}
                className="px-4 py-2 rounded-xl border border-[#E6E1D6] text-xs font-semibold text-[#5F6660] cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!importInput.trim() || importingShare}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#2F6F5E] text-white text-xs font-semibold hover:bg-[#25594B] disabled:opacity-50 cursor-pointer"
              >
                {importingShare ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    Saving...
                  </>
                ) : (
                  'Save & Open'
                )}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Interactive Share Modal */}
      {shareTarget && (
        <ShareModal
          target={shareTarget}
          onClose={() => setShareTarget(null)}
        />
      )}
    </div>
  );
}
