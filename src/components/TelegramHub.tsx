import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  Copy,
  ExternalLink,
  Link2,
  Loader2,
  RefreshCw,
  Send,
  Smartphone,
} from 'lucide-react';
import type { ExamDeck, TelegramStatus } from '../types.ts';
import {
  checkBotLinkCode,
  createBotLinkCode,
  fetchTelegramStatus,
  registerTelegramWebhook,
  sendQuizToTelegram,
} from '../lib/api.ts';

interface TelegramHubProps {
  decks: ExamDeck[];
  linkedChatId: string;
  onChatIdChange: (chatId: string) => void;
  onOpenMiniAppFullscreen: () => void;
}

export function TelegramHub({
  decks,
  linkedChatId,
  onChatIdChange,
  onOpenMiniAppFullscreen,
}: TelegramHubProps) {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [registering, setRegistering] = useState(false);
  const [selectedDeckId, setSelectedDeckId] = useState<string>(decks[0]?.id ?? '');
  const [sendingQuiz, setSendingQuiz] = useState(false);
  const [linkCode, setLinkCode] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    if (!selectedDeckId && decks[0]?.id) {
      setSelectedDeckId(decks[0].id);
    }
  }, [decks, selectedDeckId]);

  async function loadStatus() {
    setLoadingStatus(true);
    try {
      const s = await fetchTelegramStatus();
      setStatus(s);
    } catch {
      // keep previous status
    } finally {
      setLoadingStatus(false);
    }
  }

  useEffect(() => {
    void loadStatus();
  }, []);

  useEffect(() => {
    if (!linkCode) return;
    const timer = window.setInterval(async () => {
      try {
        const res = await checkBotLinkCode(linkCode);
        if (res.linked && res.chatId) {
          onChatIdChange(res.chatId);
          setLinkCode(null);
          setFeedback({
            type: 'ok',
            text: `Linked Telegram chat ${res.firstName ? `for ${res.firstName}` : ''} (${res.chatId}).`,
          });
        }
      } catch {
        // ignore transient poll error
      }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [linkCode, onChatIdChange]);

  async function handleSetupWebhook() {
    setFeedback(null);
    setRegistering(true);
    try {
      const next = await registerTelegramWebhook();
      setStatus(next);
      setFeedback({
        type: 'ok',
        text: 'Telegram Bot webhook and Mini App menu button are registered and live.',
      });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Unable to register webhook.',
      });
    } finally {
      setRegistering(false);
    }
  }

  async function handleGenerateLinkCode() {
    setFeedback(null);
    try {
      const code = await createBotLinkCode();
      setLinkCode(code);
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Could not create link code.',
      });
    }
  }

  async function handleSendQuiz(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);
    if (!selectedDeckId) {
      setFeedback({ type: 'err', text: 'Create or choose a test deck first.' });
      return;
    }
    if (!linkedChatId.trim()) {
      setFeedback({
        type: 'err',
        text: 'Enter your Telegram Chat ID or link your chat with /start first.',
      });
      return;
    }

    setSendingQuiz(true);
    try {
      const result = await sendQuizToTelegram({
        deckId: selectedDeckId,
        chatId: linkedChatId.trim(),
      });
      setFeedback({
        type: 'ok',
        text: `Sent ${result.sentCount} interactive quiz polls for "${result.deckTitle}" to Telegram!${
          result.remainingCount > 0 ? ` (${result.remainingCount} more ready via Next Batch button in chat)` : ''
        }`,
      });
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'Failed to send quiz to Telegram.',
      });
    } finally {
      setSendingQuiz(false);
    }
  }

  const miniAppUrl = status?.miniAppUrl || `${window.location.origin}/miniapp`;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
      {/* Left Column: Bot Connection & Quiz Dispatcher */}
      <div className="lg:col-span-7 space-y-6">
        <div>
          <h1 className="font-display text-3xl font-semibold text-[#1F2421] text-balance">
            Telegram Bot & Mini App
          </h1>
          <p className="mt-2 text-base text-[#5F6660]">
            Send files directly to your Telegram bot to generate tests, answer native Quiz Polls right in chat, or study inside the linked Mini App.
          </p>
        </div>

        {/* Bot Connection Card */}
        <div className="bg-white border border-[#E6E1D6] rounded-2xl p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-xl font-semibold text-[#1F2421]">
                Bot Connection
              </h2>
              <p className="text-xs text-[#5F6660] mt-0.5">
                {loadingStatus
                  ? 'Checking Telegram Bot configuration...'
                  : status?.configured
                    ? status.botUsername
                      ? `Connected bot: @${status.botUsername}`
                      : 'Bot token found on server'
                    : 'Waiting for TELEGRAM_BOT_TOKEN in Settings > Secrets'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void loadStatus()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#E6E1D6] text-xs font-medium text-[#5F6660] hover:text-[#1F2421] hover:bg-[#FBF9F5] cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Refresh
            </button>
          </div>

          {!loadingStatus && !status?.configured && (
            <div className="rounded-xl bg-[#FEF6E7] border border-[#D97706]/25 p-4 space-y-2 text-sm text-[#1F2421]">
              <p className="font-semibold">Quick 2-step setup with @BotFather</p>
              <ol className="list-decimal list-inside space-y-1 text-xs text-[#5F6660] leading-relaxed">
                <li>Message <strong className="text-[#1F2421]">@BotFather</strong> in Telegram and run <code className="font-mono">/newbot</code> to get your bot token.</li>
                <li>Add <code className="font-mono">TELEGRAM_BOT_TOKEN</code> in AI Studio <strong className="text-[#1F2421]">Settings &gt; Secrets</strong>, then click Refresh above.</li>
                <li>Click <strong className="text-[#1F2421]">Connect Webhook & Mini App</strong> below once your token is active.</li>
              </ol>
            </div>
          )}

          {status?.configured && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[#FBF9F5] border border-[#E6E1D6] p-4">
                <div className="space-y-0.5">
                  <p className="text-sm font-semibold text-[#1F2421]">
                    {status.webhookMatchesCurrentApp
                      ? 'Webhook & Mini App Active'
                      : status.webhookRegistered
                        ? 'Webhook Points to Another URL'
                        : 'Webhook Not Registered Yet'}
                  </p>
                  <p className="text-xs text-[#5F6660] break-all">
                    {status.webhookUrl || 'Click Connect Webhook to point Telegram updates to this app.'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleSetupWebhook}
                  disabled={registering}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#2F6F5E] text-white text-xs font-semibold hover:bg-[#25594B] disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {registering ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Connecting...
                    </>
                  ) : status.webhookMatchesCurrentApp ? (
                    'Re-sync Webhook'
                  ) : status.webhookRegistered ? (
                    'Switch Webhook to This App'
                  ) : (
                    'Connect Webhook & Mini App'
                  )}
                </button>
              </div>

              {status.lastError && (
                <p className="text-xs text-[#C2414B]">{status.lastError}</p>
              )}

              {/* One-tap Link Chat */}
              <div className="pt-2 border-t border-[#E6E1D6] space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-medium text-[#5F6660]">
                    Link your Telegram Chat to send quizzes directly
                  </span>
                  {status.botUsername && (
                    <button
                      type="button"
                      onClick={handleGenerateLinkCode}
                      className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#2F6F5E] hover:underline cursor-pointer"
                    >
                      <Link2 className="w-3.5 h-3.5" />
                      Generate 1-Tap Link
                    </button>
                  )}
                </div>

                {linkCode && status.botUsername && (
                  <div className="rounded-xl bg-[#ECF4F1] border border-[#2F6F5E]/25 p-3.5 flex flex-wrap items-center justify-between gap-3">
                    <div className="text-xs text-[#1F2421]">
                      Tap below in Telegram and press <strong>Start</strong> to link automatically:
                    </div>
                    <a
                      href={`https://t.me/${status.botUsername}?start=link_${linkCode}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#2F6F5E] text-white text-xs font-semibold hover:bg-[#25594B]"
                    >
                      Open @{status.botUsername}
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Mini App URL Copy Row */}
          <div className="pt-2 border-t border-[#E6E1D6] space-y-2">
            <span className="block text-xs font-medium text-[#5F6660]">
              Linked Telegram Mini App URL (for @BotFather /setmenubutton)
            </span>
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={miniAppUrl}
                className="flex-1 rounded-xl border border-[#E6E1D6] bg-[#FBF9F5] px-3.5 py-2 font-mono text-xs text-[#1F2421]"
              />
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(miniAppUrl.trim());
                  setCopiedUrl(true);
                  setTimeout(() => setCopiedUrl(false), 2000);
                }}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-[#E6E1D6] bg-white text-xs font-medium text-[#1F2421] hover:bg-[#F3EFE6] whitespace-nowrap shrink-0 cursor-pointer"
              >
                {copiedUrl ? <CheckCircle2 className="w-3.5 h-3.5 text-[#2F6F5E]" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedUrl ? 'Copied' : 'Copy'}
              </button>
            </div>
            {miniAppUrl.includes('ais-dev-') && (
              <p className="text-xs text-[#D97706]">
                You are currently on the private dev preview URL. Publish or share the app first, then copy the public Shared App URL for @BotFather.
              </p>
            )}
          </div>
        </div>

        {/* Send Quiz to Chat Card */}
        <form
          onSubmit={handleSendQuiz}
          className="bg-white border border-[#E6E1D6] rounded-2xl p-6 space-y-4"
        >
          <div>
            <h2 className="font-display text-xl font-semibold text-[#1F2421]">
              Send Quiz to Telegram Chat
            </h2>
            <p className="text-xs text-[#5F6660] mt-0.5">
              Pushes native Telegram Quiz Polls to your chat—tap an answer to immediately see right or wrong.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label htmlFor="tg-deck" className="block text-xs font-medium text-[#5F6660]">
                Choose Test Deck
              </label>
              <select
                id="tg-deck"
                value={selectedDeckId}
                onChange={(e) => setSelectedDeckId(e.target.value)}
                className="w-full rounded-xl border border-[#E6E1D6] bg-[#FBF9F5] px-3.5 py-2.5 text-sm text-[#1F2421] focus:outline-none focus:border-[#2F6F5E]"
              >
                {decks.length === 0 ? (
                  <option value="">No decks yet</option>
                ) : (
                  decks.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.title} ({d.questionCount ?? 0}q · {d.language})
                    </option>
                  ))
                )}
              </select>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="tg-chat-id" className="block text-xs font-medium text-[#5F6660]">
                Your Telegram Chat ID (shown when you send /start)
              </label>
              <input
                id="tg-chat-id"
                type="text"
                value={linkedChatId}
                onChange={(e) => onChatIdChange(e.target.value)}
                placeholder="e.g. 123456789"
                className="w-full rounded-xl border border-[#E6E1D6] bg-[#FBF9F5] px-3.5 py-2.5 font-mono text-sm text-[#1F2421] focus:outline-none focus:border-[#2F6F5E]"
              />
            </div>
          </div>

          {feedback && (
            <div
              className={`rounded-xl px-4 py-3 text-sm border ${
                feedback.type === 'ok'
                  ? 'bg-[#ECF4F1] border-[#2F6F5E]/30 text-[#1F2421]'
                  : 'bg-[#FCEEEF] border-[#C2414B]/30 text-[#C2414B]'
              }`}
            >
              {feedback.text}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <button
              type="button"
              onClick={onOpenMiniAppFullscreen}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#2F6F5E] hover:underline cursor-pointer"
            >
              <Smartphone className="w-4 h-4" />
              Open Fullscreen Mini App View
            </button>
            <button
              type="submit"
              disabled={sendingQuiz || decks.length === 0}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#2F6F5E] text-white text-sm font-semibold hover:bg-[#25594B] disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
            >
              {sendingQuiz ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Sending polls...
                </>
              ) : (
                <>
                  <Send className="w-4 h-4" />
                  Send Quiz to Telegram
                </>
              )}
            </button>
          </div>
        </form>
      </div>

      {/* Right Column: Live Linked Mini App Preview */}
      <div className="lg:col-span-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold text-[#1F2421]">
            Live Mini App Preview
          </h2>
          <button
            type="button"
            onClick={onOpenMiniAppFullscreen}
            className="text-xs font-medium text-[#2F6F5E] hover:underline cursor-pointer"
          >
            Open /miniapp
          </button>
        </div>

        <div className="bg-white border border-[#E6E1D6] rounded-3xl p-3 max-w-[390px] mx-auto shadow-sm">
          <div className="rounded-2xl overflow-hidden border border-[#E6E1D6] bg-[#FBF9F5] h-[620px]">
            <iframe
              title="CozyPrep Telegram Mini App Preview"
              src="/miniapp"
              className="w-full h-full border-0"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
