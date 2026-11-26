import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Bot, Check, Copy, Globe, Loader2, Send, Share2, X } from 'lucide-react';
import type { ExamDeck, TelegramStatus, TestCollection } from '../types.ts';
import {
  buildCollectionShareUrl,
  buildPackageShareUrl,
  buildWebCollectionShareUrl,
  buildWebPackageShareUrl,
  copyTextReliably,
  fetchTelegramStatus,
  publishShareForTarget,
  registerTelegramWebhook,
} from '../lib/api.ts';

export type ShareTarget =
  | { kind: 'deck'; item: ExamDeck }
  | { kind: 'collection'; item: TestCollection };

interface ShareModalProps {
  target: ShareTarget;
  preferMiniAppPath?: boolean;
  onClose: () => void;
}

export function ShareModal({
  target,
  preferMiniAppPath = false,
  onClose,
}: ShareModalProps) {
  const linkInputRef = useRef<HTMLInputElement | null>(null);
  const webLinkInputRef = useRef<HTMLInputElement | null>(null);
  const codeInputRef = useRef<HTMLInputElement | null>(null);

  const [telegramStatus, setTelegramStatus] = useState<TelegramStatus | null>(null);
  const [botLoaded, setBotLoaded] = useState(false);
  const [syncingShare, setSyncingShare] = useState(true);
  const [resolvedShareCode, setResolvedShareCode] = useState<string>(
    target.item.shareCode || target.item.id,
  );
  const [fixingWebhook, setFixingWebhook] = useState(false);
  const [webhookMsg, setWebhookMsg] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedWebLink, setCopiedWebLink] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  useEffect(() => {
    let active = true;
    setSyncingShare(true);

    void publishShareForTarget(target)
      .then((res) => {
        if (active && res.ok && res.shareCode) {
          setResolvedShareCode(res.shareCode);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setSyncingShare(false);
      });

    void fetchTelegramStatus({ autoSync: true })
      .then((status) => {
        if (!active) return;
        setTelegramStatus(status);
        setBotLoaded(true);
      })
      .catch(() => {
        if (!active) return;
        setTelegramStatus(null);
        setBotLoaded(true);
      });

    return () => {
      active = false;
    };
  }, [target]);

  const isDeck = target.kind === 'deck';
  const title = target.item.title;
  const botUsername = telegramStatus?.botUsername ?? null;
  const prefixedCode = `${isDeck ? 'pkg_' : 'col_'}${resolvedShareCode}`;

  const shareItem = { ...target.item, shareCode: resolvedShareCode };
  const primaryUrl = isDeck
    ? buildPackageShareUrl(shareItem as ExamDeck, botUsername, preferMiniAppPath)
    : buildCollectionShareUrl(shareItem as TestCollection, botUsername, preferMiniAppPath);

  const webUrl = isDeck
    ? buildWebPackageShareUrl(shareItem as ExamDeck, preferMiniAppPath)
    : buildWebCollectionShareUrl(shareItem as TestCollection, preferMiniAppPath);

  const hasBotLink = Boolean(botUsername);
  const isPrivateDevHost =
    typeof window !== 'undefined' && window.location.hostname.startsWith('ais-dev-');
  const webhookMismatch = Boolean(
    !isPrivateDevHost &&
      telegramStatus?.configured &&
      telegramStatus?.webhookMatchesCurrentApp === false,
  );

  const shareText = isDeck
    ? `Practice "${title}" (${target.item.questionCount ?? 0} questions) on CozyPrep:`
    : `Practice "${title}" (${target.item.totalQuestions} questions in ${target.item.packageCount} package(s)) on CozyPrep:`;

  const telegramShareHref = `https://t.me/share/url?url=${encodeURIComponent(primaryUrl)}&text=${encodeURIComponent(shareText)}`;

  const subtitle = isDeck
    ? `${target.item.questionCount ?? 0} multiple-choice questions · ${target.item.language}`
    : `${target.item.totalQuestions} questions across ${target.item.packageCount} package(s) · ${target.item.language}`;

  async function handleCopyPrimary() {
    const ok = await copyTextReliably(primaryUrl, linkInputRef.current);
    if (ok) {
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 2000);
    }
  }

  async function handleCopyWeb() {
    const ok = await copyTextReliably(webUrl, webLinkInputRef.current);
    if (ok) {
      setCopiedWebLink(true);
      window.setTimeout(() => setCopiedWebLink(false), 2000);
    }
  }

  async function handleCopyCode() {
    const ok = await copyTextReliably(prefixedCode, codeInputRef.current);
    if (ok) {
      setCopiedCode(true);
      window.setTimeout(() => setCopiedCode(false), 2000);
    }
  }

  async function handlePointWebhookHere() {
    setFixingWebhook(true);
    setWebhookMsg(null);
    try {
      const next = await registerTelegramWebhook();
      setTelegramStatus(next);
      await publishShareForTarget(target);
      setWebhookMsg('Bot webhook is now connected to this app.');
    } catch (err) {
      setWebhookMsg(err instanceof Error ? err.message : 'Unable to switch webhook.');
    } finally {
      setFixingWebhook(false);
    }
  }

  function handleTelegramShareClick(e: React.MouseEvent<HTMLAnchorElement>) {
    const tg = window.Telegram?.WebApp;
    if (tg?.openTelegramLink) {
      e.preventDefault();
      tg.openTelegramLink(telegramShareHref);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-[#1F2421]/45 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white border border-[#E6E1D6] rounded-t-3xl sm:rounded-2xl w-full max-w-md p-5 sm:p-6 space-y-4 max-h-[92vh] overflow-y-auto">
        <div className="w-10 h-1.5 bg-[#E6E1D6] rounded-full mx-auto sm:hidden" />

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#2F6F5E]">
              <Share2 className="w-3.5 h-3.5" />
              {hasBotLink
                ? isDeck
                  ? 'Share Package via Telegram Bot'
                  : 'Share Whole Test via Telegram Bot'
                : isDeck
                  ? 'Share Package Link'
                  : 'Share Whole Test Link'}
            </div>
            <h2 className="mt-1 font-display text-xl font-semibold text-[#1F2421] leading-snug">
              {title}
            </h2>
            <p className="mt-0.5 text-xs text-[#5F6660] tabular-nums">{subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close share dialog"
            className="w-9 h-9 rounded-lg flex items-center justify-center text-[#5F6660] hover:bg-[#EFECE4] cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {webhookMismatch && (
          <div className="rounded-xl bg-[#FEF6E7] border border-[#D97706]/30 px-3.5 py-3 space-y-2">
            <div className="flex items-start gap-2 text-xs text-[#1F2421]">
              <AlertTriangle className="w-4 h-4 text-[#D97706] shrink-0 mt-0.5" />
              <span>
                Your Telegram bot is currently pointing to another server URL, so tapping bot links may say the test wasn&apos;t found. Connect it to this app so shared links always find your tests.
              </span>
            </div>
            <button
              type="button"
              onClick={() => void handlePointWebhookHere()}
              disabled={fixingWebhook}
              className="w-full min-h-[36px] px-3 py-1.5 rounded-lg bg-[#D97706] text-white text-xs font-semibold hover:bg-[#B45309] disabled:opacity-60 inline-flex items-center justify-center gap-1.5 cursor-pointer"
            >
              {fixingWebhook ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Connecting Bot Here...
                </>
              ) : (
                'Connect Bot to This App'
              )}
            </button>
          </div>
        )}

        {webhookMsg && (
          <p className="text-xs font-medium text-[#2F6F5E] bg-[#ECF4F1] border border-[#2F6F5E]/25 rounded-xl px-3.5 py-2">
            {webhookMsg}
          </p>
        )}

        <p className="text-xs text-[#5F6660] leading-relaxed bg-[#FBF9F5] border border-[#E6E1D6] rounded-xl px-3.5 py-2.5">
          {syncingShare
            ? 'Preparing and syncing your test for sharing...'
            : hasBotLink
              ? `Opening this link launches @${botUsername} directly in Telegram chat, automatically saves this ${isDeck ? 'package' : 'test'} to the recipient's Telegram ID, and gives buttons in chat to download the Excel file or start practicing.`
              : botLoaded
                ? 'No Telegram bot token is connected yet, so this link opens directly in CozyPrep Web. Connect a bot in the Telegram Bot tab to generate t.me bot links.'
                : 'Loading share options...'}
        </p>

        {/* Primary Share Link */}
        <div className="space-y-1.5">
          <label htmlFor="share-link-input" className="flex items-center gap-1.5 text-xs font-medium text-[#5F6660]">
            {hasBotLink ? (
              <>
                <Bot className="w-3.5 h-3.5 text-[#2F6F5E]" />
                Telegram Bot Share Link
              </>
            ) : (
              <>
                <Globe className="w-3.5 h-3.5 text-[#2F6F5E]" />
                Direct Web Share Link
              </>
            )}
          </label>
          <div className="flex items-center gap-2">
            <input
              ref={linkInputRef}
              id="share-link-input"
              type="text"
              readOnly
              value={primaryUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 min-w-0 rounded-xl border border-[#E6E1D6] bg-[#FBF9F5] px-3 py-2 font-mono text-xs text-[#1F2421]"
            />
            <button
              type="button"
              onClick={() => void handleCopyPrimary()}
              className="min-h-[40px] px-3.5 py-2 rounded-xl bg-[#2F6F5E] text-white text-xs font-semibold hover:bg-[#25594B] inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              {copiedLink ? (
                <>
                  <Check className="w-3.5 h-3.5" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  Copy Link
                </>
              )}
            </button>
          </div>
        </div>

        {/* Send via Telegram */}
        <a
          href={telegramShareHref}
          target="_blank"
          rel="noreferrer"
          onClick={handleTelegramShareClick}
          className="w-full min-h-[44px] px-4 py-2.5 rounded-xl border border-[#E6E1D6] bg-[#FBF9F5] text-[#1F2421] text-sm font-semibold hover:bg-[#EFECE4] transition-colors inline-flex items-center justify-center gap-2"
        >
          <Send className="w-4 h-4 text-[#2F6F5E]" />
          {hasBotLink ? 'Send Bot Link in Telegram' : 'Send Web Link in Telegram'}
        </a>

        {/* Secondary Web Link when Bot Link is Primary */}
        {hasBotLink && (
          <div className="space-y-1.5">
            <label htmlFor="share-web-link-input" className="flex items-center gap-1.5 text-xs font-medium text-[#5F6660]">
              <Globe className="w-3.5 h-3.5 text-[#5F6660]" />
              Or Direct Web Link (Browser Only)
            </label>
            <div className="flex items-center gap-2">
              <input
                ref={webLinkInputRef}
                id="share-web-link-input"
                type="text"
                readOnly
                value={webUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="flex-1 min-w-0 rounded-xl border border-[#E6E1D6] bg-[#FBF9F5] px-3 py-2 font-mono text-xs text-[#1F2421]"
              />
              <button
                type="button"
                onClick={() => void handleCopyWeb()}
                className="min-h-[38px] px-3.5 py-2 rounded-xl border border-[#E6E1D6] bg-white text-xs font-semibold text-[#1F2421] hover:bg-[#F3EFE6] inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
              >
                {copiedWebLink ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-[#2F6F5E]" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    Copy
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* Copyable Short Share Code */}
        <div className="space-y-1.5">
          <label htmlFor="share-code-input" className="block text-xs font-medium text-[#5F6660]">
            Or Share Code (paste into bot chat or &quot;Open Shared Link&quot;)
          </label>
          <div className="flex items-center gap-2">
            <input
              ref={codeInputRef}
              id="share-code-input"
              type="text"
              readOnly
              value={prefixedCode}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 min-w-0 rounded-xl border border-[#E6E1D6] bg-[#FBF9F5] px-3 py-2 font-mono text-xs font-semibold text-[#1F2421]"
            />
            <button
              type="button"
              onClick={() => void handleCopyCode()}
              className="min-h-[38px] px-3.5 py-2 rounded-xl border border-[#E6E1D6] bg-white text-xs font-semibold text-[#1F2421] hover:bg-[#F3EFE6] inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              {copiedCode ? (
                <>
                  <Check className="w-3.5 h-3.5 text-[#2F6F5E]" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  Copy Code
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
