import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Clock,
  RotateCcw,
  Send,
  Share2,
  Shuffle,
  XCircle,
} from 'lucide-react';
import type {
  AttemptAnswer,
  DeckDetail,
  PracticeSource,
  StudyMode,
} from '../types.ts';
import {
  clearDeckProgress,
  fetchDeckProgress,
  reshuffleDeck,
  saveAttempt,
  saveDeckProgress,
} from '../lib/api.ts';

interface PracticeRunnerProps {
  deck: DeckDetail;
  userKey: string;
  source: PracticeSource;
  variant?: 'web' | 'miniapp';
  initialMode?: StudyMode;
  onExit: () => void;
  onDeckUpdated?: (deck: DeckDetail) => void;
  onSendToTelegram?: () => void;
  onSharePackage?: () => void;
  onAttemptSaved?: () => void;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function PracticeRunner({
  deck,
  userKey,
  source,
  variant = 'web',
  initialMode = 'quiz',
  onExit,
  onDeckUpdated,
  onSendToTelegram,
  onSharePackage,
  onAttemptSaved,
}: PracticeRunnerProps) {
  const [mode, setMode] = useState<StudyMode>(initialMode);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedMap, setSelectedMap] = useState<Record<string, number>>({});
  const [finished, setFinished] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [saving, setSaving] = useState(false);
  const [resumedBanner, setResumedBanner] = useState<string | null>(null);
  const [shuffling, setShuffling] = useState(false);
  const loadedDeckRef = useRef<string | null>(null);

  const questions = deck.questions;
  const total = questions.length;
  const examTimeLimitSeconds = useMemo(() => Math.max(60, total * 45), [total]);

  // Restore saved mid-quiz progress when opening a package
  useEffect(() => {
    let active = true;
    loadedDeckRef.current = null;
    setFinished(false);
    setResumedBanner(null);

    void fetchDeckProgress(deck.id, userKey)
      .then((saved) => {
        if (!active) return;
        if (saved && (Object.keys(saved.selectedMap).length > 0 || saved.currentIndex > 0)) {
          setMode(saved.mode);
          setCurrentIndex(Math.min(Math.max(0, saved.currentIndex), Math.max(0, total - 1)));
          setSelectedMap(saved.selectedMap);
          setElapsedSeconds(saved.elapsedSeconds);
          setResumedBanner(
            `Resumed from Question ${Math.min(saved.currentIndex + 1, total)} of ${total}`,
          );
        } else {
          setMode(initialMode);
          setCurrentIndex(0);
          setSelectedMap({});
          setElapsedSeconds(0);
        }
        loadedDeckRef.current = deck.id;
      })
      .catch(() => {
        if (!active) return;
        setCurrentIndex(0);
        setSelectedMap({});
        setElapsedSeconds(0);
        loadedDeckRef.current = deck.id;
      });

    return () => {
      active = false;
    };
  }, [deck.id, userKey, total, initialMode]);

  // Auto-save progress on every selection, step, or mode change
  useEffect(() => {
    if (loadedDeckRef.current !== deck.id || finished || total === 0) return;
    if (Object.keys(selectedMap).length === 0 && currentIndex === 0) return;

    const timer = window.setTimeout(() => {
      void saveDeckProgress(deck.id, {
        userKey,
        mode,
        currentIndex,
        selectedMap,
        elapsedSeconds,
      }).catch(() => {});
    }, 180);

    return () => window.clearTimeout(timer);
  }, [deck.id, userKey, mode, currentIndex, selectedMap, elapsedSeconds, finished, total]);

  useEffect(() => {
    if (finished || total === 0) return;
    const timer = window.setInterval(() => {
      setElapsedSeconds((prev) => {
        const next = prev + 1;
        if (mode === 'exam' && next >= examTimeLimitSeconds) {
          window.clearInterval(timer);
          void finalizeAttempt(selectedMap, next);
        }
        return next;
      });
    }, 1000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished, mode, total, examTimeLimitSeconds, selectedMap]);

  if (total === 0) {
    return (
      <div className="bg-white border border-[#E6E1D6] rounded-2xl p-8 text-center">
        <h2 className="font-display text-2xl font-semibold text-[#1F2421]">No questions in this package yet</h2>
        <p className="mt-2 text-sm text-[#5F6660]">Upload a Word or Excel file to build questions first.</p>
        <button
          type="button"
          onClick={onExit}
          className="mt-6 px-5 py-2.5 rounded-xl bg-[#2F6F5E] text-white text-sm font-medium hover:bg-[#25594B] transition-colors cursor-pointer"
        >
          Back to Library
        </button>
      </div>
    );
  }

  const currentQuestion = questions[currentIndex] || questions[0];
  const currentSelection = selectedMap[currentQuestion.id];
  const hasAnsweredCurrent = currentSelection !== undefined;

  async function finalizeAttempt(answersSnapshot: Record<string, number>, duration: number) {
    if (finished) return;
    setFinished(true);

    const attemptAnswers: AttemptAnswer[] = questions.map((q) => {
      const chosen = answersSnapshot[q.id] ?? -1;
      return {
        questionId: q.id,
        selectedIndex: chosen,
        isCorrect: chosen === q.correctIndex,
      };
    });
    const score = attemptAnswers.filter((a) => a.isCorrect).length;

    setSaving(true);
    try {
      await saveAttempt(deck.id, {
        userKey,
        mode,
        source,
        score,
        total,
        durationSeconds: duration,
        answers: attemptAnswers,
      });
      onAttemptSaved?.();
    } catch {
      // Non-blocking save failure; results remain visible on screen
    } finally {
      setSaving(false);
    }
  }

  function handleSelectOption(optionIdx: number) {
    if (finished) return;
    if (mode === 'quiz' && hasAnsweredCurrent) {
      return;
    }
    setResumedBanner(null);
    setSelectedMap((prev) => ({
      ...prev,
      [currentQuestion.id]: optionIdx,
    }));
  }

  async function handleRestart(shuffleFirst = false) {
    setResumedBanner(null);
    await clearDeckProgress(deck.id, userKey).catch(() => {});
    if (shuffleFirst) {
      setShuffling(true);
      try {
        const updated = await reshuffleDeck(deck.id);
        onDeckUpdated?.(updated);
      } finally {
        setShuffling(false);
      }
    }
    setCurrentIndex(0);
    setSelectedMap({});
    setFinished(false);
    setElapsedSeconds(0);
  }

  const answeredCount = Object.keys(selectedMap).length;
  const correctCount = questions.reduce((acc, q) => {
    return selectedMap[q.id] === q.correctIndex ? acc + 1 : acc;
  }, 0);

  if (finished) {
    const accuracy = Math.round((correctCount / total) * 100);
    return (
      <div className={variant === 'miniapp' ? 'space-y-4 pb-6' : 'max-w-3xl mx-auto space-y-6'}>
        <div className="bg-white border border-[#E6E1D6] rounded-2xl p-6 sm:p-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-medium text-[#5F6660]">
                {mode === 'quiz' ? 'Cozy Quiz Complete' : 'Timed Exam Complete'} · {deck.language}
              </p>
              <h2 className="mt-1 font-display text-2xl sm:text-3xl font-semibold text-[#1F2421]">
                {deck.title}
              </h2>
            </div>
            <div className="text-right">
              <div className="font-mono tabular-nums text-3xl font-semibold text-[#2F6F5E]">
                {correctCount}/{total}
              </div>
              <p className="text-xs text-[#5F6660] tabular-nums">
                {accuracy}% accuracy · {formatDuration(elapsedSeconds)}
              </p>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={shuffling}
              onClick={() => void handleRestart(true)}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#2F6F5E] text-white text-sm font-medium hover:bg-[#25594B] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Shuffle className="w-4 h-4" />
              {shuffling ? 'Shuffling...' : 'Practice Again (Shuffled)'}
            </button>
            {onSharePackage && (
              <button
                type="button"
                onClick={onSharePackage}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-[#E6E1D6] bg-[#FBF9F5] text-[#1F2421] text-sm font-medium hover:bg-[#F3EFE6] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Share2 className="w-4 h-4 text-[#2F6F5E]" />
                Share Package
              </button>
            )}
            {onSendToTelegram && (
              <button
                type="button"
                onClick={onSendToTelegram}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-[#E6E1D6] bg-[#FBF9F5] text-[#1F2421] text-sm font-medium hover:bg-[#F3EFE6] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Send className="w-4 h-4 text-[#2F6F5E]" />
                Send Quiz to Telegram
              </button>
            )}
            <button
              type="button"
              onClick={onExit}
              className="px-4 py-2.5 rounded-xl text-sm font-medium text-[#5F6660] hover:text-[#1F2421] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Back to Packages
            </button>
            {saving && <span className="text-xs text-[#5F6660]">Saving score...</span>}
          </div>
        </div>

        <div className="space-y-3">
          <h3 className="font-display text-lg font-semibold text-[#1F2421]">Answer Review</h3>
          {questions.map((q, idx) => {
            const chosen = selectedMap[q.id];
            const isRight = chosen === q.correctIndex;
            return (
              <div key={q.id} className="bg-white border border-[#E6E1D6] rounded-2xl p-5 space-y-2.5">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-semibold text-[#1F2421] leading-relaxed">
                    {idx + 1}. {q.prompt}
                  </p>
                  {isRight ? (
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-[#2F6F5E] shrink-0">
                      <CheckCircle2 className="w-4 h-4" />
                      Correct
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-[#C2414B] shrink-0">
                      <XCircle className="w-4 h-4" />
                      Missed
                    </span>
                  )}
                </div>
                <div className="text-xs text-[#5F6660] space-y-1">
                  <p>
                    Your answer:{' '}
                    <span className={isRight ? 'text-[#2F6F5E] font-medium' : 'text-[#C2414B] font-medium'}>
                      {chosen !== undefined ? q.options[chosen] : 'No answer selected'}
                    </span>
                  </p>
                  {!isRight && (
                    <p>
                      Correct answer:{' '}
                      <span className="text-[#2F6F5E] font-medium">{q.options[q.correctIndex]}</span>
                    </p>
                  )}
                  {q.explanation && (
                    <p className="pt-1 text-[#5F6660] leading-relaxed">{q.explanation}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  const remainingExamSeconds = Math.max(0, examTimeLimitSeconds - elapsedSeconds);
  const progressPercent = Math.round(((currentIndex + 1) / total) * 100);

  return (
    <div className={variant === 'miniapp' ? 'space-y-4 pb-4' : 'max-w-3xl mx-auto space-y-5'}>
      {/* Mode & Top Progress Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={onExit}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-[#5F6660] hover:text-[#1F2421] min-h-[40px] px-2 -ml-2 rounded-lg transition-colors cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          Packages
        </button>

        <div className="flex items-center gap-1 p-1 bg-[#EFECE4] rounded-xl">
          <button
            type="button"
            onClick={() => setMode('quiz')}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              mode === 'quiz'
                ? 'bg-white text-[#1F2421] shadow-xs'
                : 'text-[#5F6660] hover:text-[#1F2421]'
            }`}
          >
            Cozy Quiz
          </button>
          <button
            type="button"
            onClick={() => setMode('exam')}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              mode === 'exam'
                ? 'bg-white text-[#1F2421] shadow-xs'
                : 'text-[#5F6660] hover:text-[#1F2421]'
            }`}
          >
            Timed Exam
          </button>
        </div>

        <div className="flex items-center gap-3">
          {onSharePackage && (
            <button
              type="button"
              onClick={onSharePackage}
              title="Share this 50-question package"
              className="inline-flex items-center gap-1 text-xs font-medium text-[#2F6F5E] hover:underline cursor-pointer"
            >
              <Share2 className="w-3.5 h-3.5" />
              Share
            </button>
          )}
          <div className="flex items-center gap-1.5 font-mono tabular-nums text-xs font-medium text-[#5F6660]">
            <Clock className="w-3.5 h-3.5 text-[#D97706]" />
            <span>
              {mode === 'exam'
                ? `Left ${formatDuration(remainingExamSeconds)}`
                : formatDuration(elapsedSeconds)}
            </span>
          </div>
        </div>
      </div>

      {resumedBanner && (
        <div className="rounded-xl bg-[#ECF4F1] border border-[#2F6F5E]/25 px-4 py-2.5 flex items-center justify-between gap-2 text-xs text-[#1F2421]">
          <span>{resumedBanner} · Progress saves automatically</span>
          <button
            type="button"
            onClick={() => void handleRestart(false)}
            className="inline-flex items-center gap-1 font-semibold text-[#2F6F5E] hover:underline cursor-pointer shrink-0"
          >
            <RotateCcw className="w-3 h-3" />
            Start Over
          </button>
        </div>
      )}

      {/* Main Question Card */}
      <div className="bg-white border border-[#E6E1D6] rounded-2xl p-5 sm:p-7 space-y-5">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-[#5F6660]">
            <span className="truncate max-w-[65%]">{deck.title}</span>
            <span className="font-mono tabular-nums">
              Question {currentIndex + 1} of {total}
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-[#EFECE4] overflow-hidden">
            <div
              className="h-full bg-[#2F6F5E] transition-all duration-200 ease-out"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>

        <h2 className="font-display text-xl sm:text-2xl font-semibold text-[#1F2421] leading-snug">
          {currentQuestion.prompt}
        </h2>

        <div className="space-y-2.5">
          {currentQuestion.options.map((option, idx) => {
            const isSelected = currentSelection === idx;
            const isCorrectOption = idx === currentQuestion.correctIndex;
            const showQuizOutcome = mode === 'quiz' && hasAnsweredCurrent;

            let cardStyle =
              'border-[#E6E1D6] bg-[#FBF9F5] hover:bg-[#F3EFE6] text-[#1F2421]';
            let statusNode: React.ReactNode = null;

            if (showQuizOutcome) {
              if (isCorrectOption) {
                cardStyle = 'border-[#2F6F5E] bg-[#ECF4F1] text-[#1F2421]';
                statusNode = (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-[#2F6F5E] shrink-0">
                    <CheckCircle2 className="w-4 h-4" />
                    Correct
                  </span>
                );
              } else if (isSelected && !isCorrectOption) {
                cardStyle = 'border-[#C2414B] bg-[#FCEEEF] text-[#1F2421]';
                statusNode = (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-[#C2414B] shrink-0">
                    <XCircle className="w-4 h-4" />
                    Wrong
                  </span>
                );
              } else {
                cardStyle = 'border-[#E6E1D6] bg-white text-[#5F6660] opacity-70';
              }
            } else if (isSelected) {
              cardStyle = 'border-[#2F6F5E] bg-[#ECF4F1] text-[#1F2421]';
              statusNode = (
                <span className="text-xs font-semibold text-[#2F6F5E] shrink-0">Selected</span>
              );
            }

            const letter = String.fromCharCode(65 + idx);

            return (
              <button
                key={`${currentQuestion.id}-${idx}`}
                type="button"
                onClick={() => handleSelectOption(idx)}
                disabled={mode === 'quiz' && hasAnsweredCurrent}
                className={`w-full min-h-[48px] px-4 py-3.5 rounded-xl border text-left flex items-center justify-between gap-3 transition-colors duration-150 cursor-pointer disabled:cursor-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2F6F5E] ${cardStyle}`}
              >
                <span className="flex items-start gap-3 text-sm sm:text-base font-medium leading-snug">
                  <span className="font-mono text-xs font-semibold text-[#5F6660] mt-0.5 shrink-0">
                    {letter}.
                  </span>
                  <span>{option}</span>
                </span>
                {statusNode}
              </button>
            );
          })}
        </div>

        {/* Cozy Explanation Reveal in Instant Quiz Mode */}
        {mode === 'quiz' && hasAnsweredCurrent && (
          <div
            className={`rounded-xl p-4 border text-sm leading-relaxed ${
              currentSelection === currentQuestion.correctIndex
                ? 'bg-[#ECF4F1] border-[#2F6F5E]/25 text-[#1F2421]'
                : 'bg-[#FEF6E7] border-[#D97706]/25 text-[#1F2421]'
            }`}
          >
            <p className="font-semibold">
              {currentSelection === currentQuestion.correctIndex
                ? 'Well done — that is right.'
                : `Not quite — the answer is ${currentQuestion.options[currentQuestion.correctIndex]}.`}
            </p>
            {currentQuestion.explanation && (
              <p className="mt-1 text-[#5F6660]">{currentQuestion.explanation}</p>
            )}
          </div>
        )}

        {/* Navigation Footer */}
        <div className="pt-2 flex flex-wrap items-center justify-between gap-3 border-t border-[#E6E1D6]">
          <button
            type="button"
            onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}
            disabled={currentIndex === 0}
            className="inline-flex items-center gap-1.5 min-h-[44px] px-4 py-2 rounded-xl border border-[#E6E1D6] text-sm font-medium text-[#1F2421] hover:bg-[#F3EFE6] disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-4 h-4" />
            Previous
          </button>

          <div className="flex items-center gap-2">
            {currentIndex < total - 1 ? (
              <button
                type="button"
                onClick={() => setCurrentIndex((i) => Math.min(total - 1, i + 1))}
                className="inline-flex items-center gap-1.5 min-h-[44px] px-5 py-2 rounded-xl bg-[#2F6F5E] text-white text-sm font-medium hover:bg-[#25594B] transition-colors cursor-pointer"
              >
                Next Question
                <ArrowRight className="w-4 h-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void finalizeAttempt(selectedMap, elapsedSeconds)}
                className="inline-flex items-center gap-1.5 min-h-[44px] px-5 py-2 rounded-xl bg-[#2F6F5E] text-white text-sm font-medium hover:bg-[#25594B] transition-colors cursor-pointer"
              >
                Finish & See Score
                <CheckCircle2 className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Question Navigator Strip */}
      <div className="bg-white border border-[#E6E1D6] rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {questions.map((q, idx) => {
            const answered = selectedMap[q.id] !== undefined;
            const isCurrent = idx === currentIndex;
            return (
              <button
                key={q.id}
                type="button"
                onClick={() => setCurrentIndex(idx)}
                className={`w-8 h-8 rounded-lg font-mono text-xs font-semibold tabular-nums transition-colors cursor-pointer ${
                  isCurrent
                    ? 'bg-[#2F6F5E] text-white'
                    : answered
                      ? 'bg-[#ECF4F1] text-[#2F6F5E] border border-[#2F6F5E]/30'
                      : 'bg-[#FBF9F5] text-[#5F6660] border border-[#E6E1D6]'
                }`}
              >
                {idx + 1}
              </button>
            );
          })}
        </div>
        <span className="text-xs text-[#5F6660] tabular-nums">
          {answeredCount}/{total} answered
        </span>
      </div>
    </div>
  );
}
