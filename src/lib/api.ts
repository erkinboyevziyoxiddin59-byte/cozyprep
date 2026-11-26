import type {
  Attempt,
  AttemptAnswer,
  DeckDetail,
  ExamDeck,
  ExtractionJob,
  PracticeSource,
  QuizProgress,
  StudyMode,
  TelegramStatus,
  TestCollection,
} from '../types.ts';
import {
  clearProgressInFirestore,
  clearProgressInLocalVault,
  deleteCollectionInFirestore,
  deleteDeckInFirestore,
  fetchShareBundleFromFirestore,
  loadCloudDataForUser,
  publishShareBundleToFirestore,
  readLocalVault,
  removeCollectionFromLocalVault,
  removeDeckFromLocalVault,
  saveAttemptToFirestore,
  saveAttemptToLocalVault,
  saveCollectionBundleToFirestore,
  saveCollectionToLocalVault,
  saveDeckToLocalVault,
  saveProgressToFirestore,
  saveProgressToLocalVault,
  updateDeckInFirestore,
} from './cloudStore.ts';
import { auth } from './firebase.ts';

async function parseJson<T>(res: Response): Promise<T> {
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

export function getRawBrowserKey(): string {
  let key = localStorage.getItem('cozyprep_user_key')?.trim();
  if (!key) {
    key = `web_${crypto.randomUUID()}`;
    localStorage.setItem('cozyprep_user_key', key);
  }
  return key;
}

export function getUserKey(): string {
  const chatId = localStorage.getItem('cozyprep_chat_id')?.trim();
  if (chatId) return chatId;
  return getRawBrowserKey();
}

function mergeCollections(lists: TestCollection[][]): TestCollection[] {
  const map = new Map<string, TestCollection>();
  for (const list of lists) {
    for (const col of list) {
      if (!col || !col.id || col.packages.length === 0) continue;
      const existing = map.get(col.id);
      if (!existing || col.packages.length > existing.packages.length) {
        map.set(col.id, col);
      }
    }
  }
  return Array.from(map.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

export async function syncCollectionToBackups(
  col: TestCollection,
  options?: { overwrite?: boolean },
): Promise<void> {
  const vault = readLocalVault();
  const details: DeckDetail[] = [];

  for (const pkg of col.packages) {
    if (vault.decks[pkg.id]?.questions?.length) {
      details.push(vault.decks[pkg.id]);
    } else {
      try {
        const res = await fetch(`/api/decks/${encodeURIComponent(pkg.id)}`);
        if (res.ok) {
          const data = (await res.json()) as { deck: DeckDetail };
          details.push(data.deck);
        }
      } catch {
        // ignore transient fetch failure
      }
    }
  }

  if (details.length > 0) {
    saveCollectionToLocalVault(col, details);
    const user = auth.currentUser;
    if (user) {
      await saveCollectionBundleToFirestore(user, col, details, options).catch(() => {});
    }
  } else {
    saveCollectionToLocalVault(col);
  }
}

export async function fetchCollections(params?: {
  search?: string;
  language?: string;
  chatId?: string;
  userKey?: string;
}): Promise<TestCollection[]> {
  const query = new URLSearchParams();
  if (params?.search) query.set('search', params.search);
  if (params?.language && params.language !== 'All') query.set('language', params.language);
  if (params?.chatId) query.set('chatId', params.chatId);
  if (params?.userKey) query.set('userKey', params.userKey);
  const qs = query.toString();

  const [serverCols, cloudData] = await Promise.all([
    fetch(`/api/collections${qs ? `?${qs}` : ''}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ collections: TestCollection[] }>) : { collections: [] }))
      .then((d) => d.collections)
      .catch(() => [] as TestCollection[]),
    auth.currentUser
      ? loadCloudDataForUser(auth.currentUser).catch(() => null)
      : Promise.resolve(null),
  ]);

  const vault = readLocalVault();
  const activeChat = params?.chatId?.trim();
  const localCols = Object.values(vault.collections).filter((c) => {
    if (!activeChat) return true;
    return !c.telegramChatId || c.telegramChatId === activeChat || c.isSharedWithMe;
  });
  const cloudCols = cloudData?.collections ?? [];

  // Push any server-created collections that aren't yet in Firestore/localVault up to cloud
  const cloudIds = new Set(cloudCols.map((c) => c.id));
  for (const sc of serverCols) {
    if (!vault.collections[sc.id] || (auth.currentUser && !cloudIds.has(sc.id))) {
      void syncCollectionToBackups(sc);
    }
  }

  // Automatically sync tests between browser storage, active server, and registered bot webhook
  const mergedForSync = mergeCollections([serverCols, localCols]).slice(0, 15);
  for (const col of mergedForSync) {
    if (!hydratedServerCollectionIds.has(col.id)) {
      hydratedServerCollectionIds.add(col.id);
      void publishShareForTarget({ kind: 'collection', item: col }).catch(() => {});
    }
  }
  if (!autoSyncedWebhookOnce) {
    autoSyncedWebhookOnce = true;
    void fetchTelegramStatus({ autoSync: true }).catch(() => {});
  }

  // If user is signed in and has local-only collections created before signing in, push them up too
  if (auth.currentUser) {
    for (const lc of localCols) {
      if (!cloudIds.has(lc.id)) {
        void syncCollectionToBackups(lc);
      }
    }
  }

  let merged = mergeCollections([serverCols, cloudCols, localCols]);
  if (params?.language && params.language !== 'All') {
    merged = merged.filter((c) => c.language === params.language);
  }
  if (params?.search?.trim()) {
    const q = params.search.trim().toLowerCase();
    merged = merged.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        (c.sourceFilename || '').toLowerCase().includes(q) ||
        c.language.toLowerCase().includes(q),
    );
  }
  return merged;
}

export async function fetchCollectionDetail(collectionId: string): Promise<TestCollection> {
  try {
    const res = await fetch(`/api/collections/${encodeURIComponent(collectionId)}`);
    if (res.ok) {
      const data = (await res.json()) as { collection: TestCollection };
      void syncCollectionToBackups(data.collection);
      return data.collection;
    }
  } catch {
    // fallback below
  }

  if (auth.currentUser) {
    const cloud = await loadCloudDataForUser(auth.currentUser).catch(() => null);
    const found = cloud?.collections.find((c) => c.id === collectionId);
    if (found) return found;
  }

  const vault = readLocalVault();
  if (vault.collections[collectionId]) {
    return vault.collections[collectionId];
  }
  throw new Error('Test file not found.');
}

export async function fetchCollectionByShare(shareCode: string): Promise<TestCollection> {
  try {
    const res = await fetch(`/api/collections/by-share/${encodeURIComponent(shareCode)}`);
    if (res.ok) {
      const data = (await res.json()) as { collection: TestCollection };
      return data.collection;
    }
  } catch {
    // fallback to Firestore
  }
  const cloudShare = await fetchShareBundleFromFirestore(shareCode);
  if (cloudShare) return cloudShare.collection;
  throw new Error('Shared test collection not found.');
}

export async function implementSharedCollection(
  shareCode: string,
  payload: { userKey?: string; chatId?: string },
): Promise<TestCollection> {
  let serverCol: TestCollection | null = null;
  try {
    const res = await fetch(`/api/collections/by-share/${encodeURIComponent(shareCode)}/implement`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const data = (await res.json()) as { collection: TestCollection };
      serverCol = { ...data.collection, isSharedWithMe: true };
    }
  } catch {
    // fallback to Firestore
  }

  if (serverCol) {
    await syncCollectionToBackups(serverCol, { overwrite: false });
    return serverCol;
  }

  const cloudShare = await fetchShareBundleFromFirestore(shareCode);
  if (cloudShare) {
    saveCollectionToLocalVault(cloudShare.collection, cloudShare.packages);
    if (auth.currentUser) {
      await saveCollectionBundleToFirestore(
        auth.currentUser,
        cloudShare.collection,
        cloudShare.packages,
      ).catch(() => {});
    }
    return cloudShare.collection;
  }

  throw new Error('Shared test collection not found.');
}

export async function deleteCollectionById(collectionId: string): Promise<void> {
  const vault = readLocalVault();
  const col = vault.collections[collectionId];
  const pkgIds = col ? col.packages.map((p) => p.id) : [];

  removeCollectionFromLocalVault(collectionId);
  if (auth.currentUser) {
    await deleteCollectionInFirestore(auth.currentUser, collectionId, pkgIds).catch(() => {});
  }

  try {
    await fetch(`/api/collections/${encodeURIComponent(collectionId)}`, {
      method: 'DELETE',
    });
  } catch {
    // ignore if already removed on ephemeral disk
  }
}

export async function fetchDecks(params?: {
  search?: string;
  language?: string;
  chatId?: string;
  userKey?: string;
}): Promise<ExamDeck[]> {
  const cols = await fetchCollections(params);
  return cols.flatMap((c) => c.packages);
}

export async function fetchDeckDetail(deckId: string): Promise<DeckDetail> {
  try {
    const res = await fetch(`/api/decks/${encodeURIComponent(deckId)}`);
    if (res.ok) {
      const data = (await res.json()) as { deck: DeckDetail };
      saveDeckToLocalVault(data.deck);
      return data.deck;
    }
  } catch {
    // fallback below
  }

  if (auth.currentUser) {
    const cloud = await loadCloudDataForUser(auth.currentUser).catch(() => null);
    if (cloud?.decksById[deckId]) {
      saveDeckToLocalVault(cloud.decksById[deckId]);
      return cloud.decksById[deckId];
    }
  }

  const vault = readLocalVault();
  if (vault.decks[deckId]) {
    return vault.decks[deckId];
  }
  throw new Error('Exam package not found.');
}

export async function fetchDeckByShare(shareCode: string): Promise<DeckDetail> {
  try {
    const res = await fetch(`/api/decks/by-share/${encodeURIComponent(shareCode)}`);
    if (res.ok) {
      const data = (await res.json()) as { deck: DeckDetail };
      return data.deck;
    }
  } catch {
    // fallback
  }
  const cloudShare = await fetchShareBundleFromFirestore(shareCode);
  if (cloudShare && cloudShare.packages[0]) {
    return cloudShare.packages[0];
  }
  throw new Error('Shared package not found.');
}

export async function implementSharedDeck(
  shareCode: string,
  payload: { userKey?: string; chatId?: string },
): Promise<DeckDetail> {
  let serverDeck: DeckDetail | null = null;
  try {
    const res = await fetch(`/api/decks/by-share/${encodeURIComponent(shareCode)}/implement`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const data = (await res.json()) as { deck: DeckDetail };
      serverDeck = { ...data.deck, isSharedWithMe: true };
    }
  } catch {
    // fallback to Firestore
  }

  if (serverDeck) {
    saveDeckToLocalVault(serverDeck);
    if (auth.currentUser) {
      const colId = serverDeck.collectionId || `single_${serverDeck.id}`;
      const colMeta: TestCollection = {
        id: colId,
        title: serverDeck.title.replace(/\s+—\s+Part\s+\d+\s+\(Q[^)]+\)$/i, ''),
        sourceFilename: serverDeck.sourceFilename,
        language: serverDeck.language,
        totalQuestions: serverDeck.questions.length,
        packageCount: 1,
        shareCode: serverDeck.shareCode,
        telegramChatId: null,
        isSharedWithMe: true,
        createdAt: serverDeck.createdAt,
        packages: [serverDeck],
      };
      await saveCollectionBundleToFirestore(auth.currentUser, colMeta, [serverDeck]).catch(() => {});
    }
    return serverDeck;
  }

  const cloudShare = await fetchShareBundleFromFirestore(shareCode);
  if (cloudShare && cloudShare.packages[0]) {
    saveCollectionToLocalVault(cloudShare.collection, cloudShare.packages);
    if (auth.currentUser) {
      await saveCollectionBundleToFirestore(
        auth.currentUser,
        cloudShare.collection,
        cloudShare.packages,
      ).catch(() => {});
    }
    return cloudShare.packages[0];
  }

  throw new Error('Shared package not found.');
}

export async function implementShareInput(
  input: string,
  payload: { userKey?: string; chatId?: string },
): Promise<
  | { kind: 'deck'; deck: DeckDetail }
  | { kind: 'collection'; collection: TestCollection }
> {
  try {
    const res = await fetch('/api/share/implement', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, ...payload }),
    });
    if (res.ok) {
      const data = (await res.json()) as
        | { kind: 'deck'; deck: DeckDetail }
        | { kind: 'collection'; collection: TestCollection };
      if (data.kind === 'deck') {
        const sharedDeck = { ...data.deck, isSharedWithMe: true };
        saveDeckToLocalVault(sharedDeck);
        if (auth.currentUser) {
          const colId = sharedDeck.collectionId || `single_${sharedDeck.id}`;
          await saveCollectionBundleToFirestore(
            auth.currentUser,
            {
              id: colId,
              title: sharedDeck.title.replace(/\s+—\s+Part\s+\d+\s+\(Q[^)]+\)$/i, ''),
              sourceFilename: sharedDeck.sourceFilename,
              language: sharedDeck.language,
              totalQuestions: sharedDeck.questions.length,
              packageCount: 1,
              shareCode: sharedDeck.shareCode,
              telegramChatId: null,
              isSharedWithMe: true,
              createdAt: sharedDeck.createdAt,
              packages: [sharedDeck],
            },
            [sharedDeck],
          ).catch(() => {});
        }
        return { kind: 'deck', deck: sharedDeck };
      }
      const sharedCol = { ...data.collection, isSharedWithMe: true };
      await syncCollectionToBackups(sharedCol);
      return { kind: 'collection', collection: sharedCol };
    }
  } catch {
    // fallback to Firestore
  }

  const cloudShare = await fetchShareBundleFromFirestore(input);
  if (cloudShare) {
    saveCollectionToLocalVault(cloudShare.collection, cloudShare.packages);
    if (auth.currentUser) {
      await saveCollectionBundleToFirestore(
        auth.currentUser,
        cloudShare.collection,
        cloudShare.packages,
      ).catch(() => {});
    }
    if (cloudShare.kind === 'deck' && cloudShare.packages.length === 1) {
      return { kind: 'deck', deck: cloudShare.packages[0] };
    }
    return { kind: 'collection', collection: cloudShare.collection };
  }

  throw new Error('Shared package or test code could not be found.');
}

const hydratedServerCollectionIds = new Set<string>();
let autoSyncedWebhookOnce = false;

export async function publishShareForTarget(
  target:
    | { kind: 'deck'; item: ExamDeck }
    | { kind: 'collection'; item: TestCollection },
): Promise<{ ok: boolean; shareCode?: string }> {
  const vault = readLocalVault();
  const chatId = localStorage.getItem('cozyprep_chat_id')?.trim() || undefined;
  const userKey = getUserKey();

  if (target.kind === 'deck') {
    const detail =
      vault.decks[target.item.id]?.questions?.length
        ? vault.decks[target.item.id]
        : await fetchDeckDetail(target.item.id);
    const parentCol = detail.collectionId ? vault.collections[detail.collectionId] : undefined;

    let serverShareCode = detail.shareCode || detail.id;
    try {
      const res = await fetch('/api/share/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collection: parentCol ?? null,
          packages: [detail],
          userKey,
          chatId,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          collection?: TestCollection | null;
          packages?: DeckDetail[];
        };
        if (data.packages?.[0]?.shareCode) {
          serverShareCode = data.packages[0].shareCode;
        }
      }
    } catch {
      // ignore transient error
    }

    const user = auth.currentUser;
    if (user) {
      await publishShareBundleToFirestore(user, {
        kind: 'deck',
        shareCode: serverShareCode,
        collectionId: detail.collectionId || `single_${detail.id}`,
        title: detail.title,
        sourceFilename: detail.sourceFilename,
        language: detail.language,
        packages: [detail],
      }).catch(() => {});
    }
    return { ok: true, shareCode: serverShareCode };
  }

  const details: DeckDetail[] = [];
  for (const pkg of target.item.packages) {
    try {
      const d = vault.decks[pkg.id]?.questions?.length
        ? vault.decks[pkg.id]
        : await fetchDeckDetail(pkg.id);
      if (d.questions.length > 0) {
        details.push(d);
      }
    } catch {
      // skip missing
    }
  }
  if (details.length === 0) return { ok: false };

  let serverShareCode = target.item.shareCode || target.item.id;
  try {
    const res = await fetch('/api/share/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        collection: target.item,
        packages: details,
        userKey,
        chatId,
      }),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        collection?: TestCollection | null;
        packages?: DeckDetail[];
      };
      if (data.collection?.shareCode) {
        serverShareCode = data.collection.shareCode;
      } else if (data.packages?.[0]?.shareCode) {
        serverShareCode = data.packages[0].shareCode;
      }
    }
  } catch {
    // ignore transient error
  }

  const user = auth.currentUser;
  if (user) {
    await publishShareBundleToFirestore(user, {
      kind: 'collection',
      shareCode: serverShareCode,
      collectionId: target.item.id,
      title: target.item.title,
      sourceFilename: target.item.sourceFilename,
      language: target.item.language,
      packages: details,
    }).catch(() => {});
  }
  return { ok: true, shareCode: serverShareCode };
}

export async function removeSavedDeck(
  deckId: string,
  params: { userKey?: string; chatId?: string },
): Promise<void> {
  removeDeckFromLocalVault(deckId);
  if (auth.currentUser) {
    await deleteDeckInFirestore(auth.currentUser, deckId).catch(() => {});
  }
  const q = new URLSearchParams();
  if (params.userKey) q.set('userKey', params.userKey);
  if (params.chatId) q.set('chatId', params.chatId);
  await fetch(`/api/decks/${encodeURIComponent(deckId)}/saved?${q.toString()}`, {
    method: 'DELETE',
  }).catch(() => {});
}

export async function reshuffleDeck(deckId: string): Promise<DeckDetail> {
  try {
    const res = await fetch(`/api/decks/${encodeURIComponent(deckId)}/shuffle`, {
      method: 'POST',
    });
    if (res.ok) {
      const data = (await res.json()) as { deck: DeckDetail };
      saveDeckToLocalVault(data.deck);
      if (auth.currentUser) {
        void updateDeckInFirestore(auth.currentUser, data.deck).catch(() => {});
      }
      return data.deck;
    }
  } catch {
    // fallback below
  }

  const deck = await fetchDeckDetail(deckId);
  const shuffledQuestions = deck.questions.map((q) => {
    const tagged = q.options.map((text, idx) => ({
      text,
      isCorrect: idx === q.correctIndex,
    }));
    for (let i = tagged.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = tagged[i];
      tagged[i] = tagged[j];
      tagged[j] = tmp;
    }
    return {
      ...q,
      options: tagged.map((t) => t.text),
      correctIndex: Math.max(0, tagged.findIndex((t) => t.isCorrect)),
    };
  });
  const nextDeck: DeckDetail = { ...deck, questions: shuffledQuestions };
  saveDeckToLocalVault(nextDeck);
  if (auth.currentUser) {
    await updateDeckInFirestore(auth.currentUser, nextDeck).catch(() => {});
  }
  return nextDeck;
}

export async function updateDeckDetail(
  deckId: string,
  payload: {
    title?: string;
    description?: string;
    language?: string;
    telegramChatId?: string | null;
    questions?: Array<{
      id?: string;
      prompt: string;
      options: string[];
      correctIndex: number;
      explanation: string;
    }>;
  },
): Promise<DeckDetail> {
  try {
    const res = await fetch(`/api/decks/${encodeURIComponent(deckId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const data = (await res.json()) as { deck: DeckDetail };
      saveDeckToLocalVault(data.deck);
      if (auth.currentUser) {
        void updateDeckInFirestore(auth.currentUser, data.deck).catch(() => {});
      }
      return data.deck;
    }
  } catch {
    // fallback below
  }

  const existing = await fetchDeckDetail(deckId);
  const updated: DeckDetail = {
    ...existing,
    title: payload.title !== undefined ? payload.title.trim() || existing.title : existing.title,
    description: payload.description !== undefined ? payload.description.trim() : existing.description,
    language: payload.language !== undefined ? payload.language.trim() || existing.language : existing.language,
    questions: payload.questions
      ? payload.questions.map((q, idx) => ({
          id: q.id || existing.questions[idx]?.id || `q_${idx}`,
          deckId,
          orderIndex: idx,
          prompt: q.prompt.trim(),
          options: q.options.map((o) => o.trim()).filter(Boolean),
          correctIndex: q.correctIndex,
          explanation: (q.explanation || '').trim(),
          format: 'multiple_choice',
        }))
      : existing.questions,
  };
  saveDeckToLocalVault(updated);
  if (auth.currentUser) {
    await updateDeckInFirestore(auth.currentUser, updated).catch(() => {});
  }
  return updated;
}

export async function deleteDeckById(deckId: string): Promise<void> {
  removeDeckFromLocalVault(deckId);
  if (auth.currentUser) {
    await deleteDeckInFirestore(auth.currentUser, deckId).catch(() => {});
  }
  try {
    await fetch(`/api/decks/${encodeURIComponent(deckId)}`, {
      method: 'DELETE',
    });
  } catch {
    // ignore
  }
}

export async function startExtraction(input: {
  file?: File | null;
  rawText?: string;
  language: string;
  customTitle?: string;
  telegramChatId?: string;
  userKey?: string;
}): Promise<ExtractionJob> {
  const form = new FormData();
  if (input.file) {
    form.append('file', input.file);
  }
  if (input.rawText) {
    form.append('rawText', input.rawText);
  }
  form.append('language', input.language);
  if (input.customTitle) {
    form.append('customTitle', input.customTitle);
  }
  if (input.telegramChatId) {
    form.append('telegramChatId', input.telegramChatId);
  }
  if (input.userKey) {
    form.append('userKey', input.userKey);
  }

  const res = await fetch('/api/tests/extract', {
    method: 'POST',
    body: form,
  });
  const data = await parseJson<{ job: ExtractionJob }>(res);
  return data.job;
}

export async function fetchJobs(params?: {
  userKey?: string;
  chatId?: string;
}): Promise<ExtractionJob[]> {
  const q = new URLSearchParams();
  if (params?.userKey) q.set('userKey', params.userKey);
  if (params?.chatId) q.set('chatId', params.chatId);
  const qs = q.toString();
  const res = await fetch(`/api/jobs${qs ? `?${qs}` : ''}`);
  const data = await parseJson<{ jobs: ExtractionJob[] }>(res);
  return data.jobs;
}

function getActiveChatId(): string | undefined {
  const val = localStorage.getItem('cozyprep_chat_id')?.trim();
  return val || undefined;
}

export async function fetchAllProgress(userKey: string, chatId?: string): Promise<
  Record<string, { currentIndex: number; answeredCount: number; mode: StudyMode; updatedAt: string }>
> {
  const vault = readLocalVault();
  const merged: Record<
    string,
    { currentIndex: number; answeredCount: number; mode: StudyMode; updatedAt: string }
  > = {};

  for (const [deckId, p] of Object.entries(vault.progress)) {
    const answeredCount = Object.keys(p.selectedMap || {}).length;
    if (answeredCount > 0 || p.currentIndex > 0) {
      merged[deckId] = {
        currentIndex: p.currentIndex,
        answeredCount,
        mode: p.mode,
        updatedAt: p.updatedAt,
      };
    }
  }

  const activeChat = chatId?.trim() || getActiveChatId();
  const q = new URLSearchParams({ userKey });
  if (activeChat) q.set('chatId', activeChat);

  const [serverProg, cloudData] = await Promise.all([
    fetch(`/api/progress?${q.toString()}`)
      .then((r) =>
        r.ok
          ? (r.json() as Promise<{
              progress: Record<
                string,
                { currentIndex: number; answeredCount: number; mode: StudyMode; updatedAt: string }
              >;
            }>)
          : { progress: {} },
      )
      .then((d) => d.progress)
      .catch(() => ({})),
    auth.currentUser
      ? loadCloudDataForUser(auth.currentUser).catch(() => null)
      : Promise.resolve(null),
  ]);

  Object.assign(merged, serverProg, cloudData?.progressSummary ?? {});
  return merged;
}

export async function fetchDeckProgress(
  deckId: string,
  userKey: string,
  chatId?: string,
): Promise<QuizProgress | null> {
  const vault = readLocalVault();
  let best: QuizProgress | null = vault.progress[deckId] ?? null;

  if (auth.currentUser) {
    const cloud = await loadCloudDataForUser(auth.currentUser).catch(() => null);
    const cloudProg = cloud?.progressByDeckId[deckId];
    if (
      cloudProg &&
      (!best || new Date(cloudProg.updatedAt).getTime() >= new Date(best.updatedAt).getTime())
    ) {
      best = cloudProg;
    }
  }

  try {
    const activeChat = chatId?.trim() || getActiveChatId();
    const q = new URLSearchParams({ userKey });
    if (activeChat) q.set('chatId', activeChat);
    const res = await fetch(`/api/decks/${encodeURIComponent(deckId)}/progress?${q.toString()}`);
    if (res.ok) {
      const data = (await res.json()) as { progress: QuizProgress | null };
      if (
        data.progress &&
        (!best ||
          new Date(data.progress.updatedAt).getTime() > new Date(best.updatedAt).getTime())
      ) {
        best = data.progress;
      }
    }
  } catch {
    // ignore
  }

  return best;
}

export async function saveDeckProgress(
  deckId: string,
  payload: {
    userKey: string;
    mode: StudyMode;
    currentIndex: number;
    selectedMap: Record<string, number>;
    elapsedSeconds: number;
  },
): Promise<void> {
  const activeChat = getActiveChatId();
  const progress: QuizProgress = {
    deckId,
    userKey: activeChat || payload.userKey,
    mode: payload.mode,
    currentIndex: payload.currentIndex,
    selectedMap: payload.selectedMap,
    elapsedSeconds: payload.elapsedSeconds,
    updatedAt: new Date().toISOString(),
  };
  saveProgressToLocalVault(progress);

  if (auth.currentUser) {
    void saveProgressToFirestore(auth.currentUser, progress).catch(() => {});
  }

  await fetch(`/api/decks/${encodeURIComponent(deckId)}/progress`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, chatId: activeChat }),
  }).catch(() => {});
}

export async function clearDeckProgress(deckId: string, userKey: string): Promise<void> {
  clearProgressInLocalVault(deckId);
  if (auth.currentUser) {
    void clearProgressInFirestore(auth.currentUser, deckId).catch(() => {});
  }
  const activeChat = getActiveChatId();
  const q = new URLSearchParams({ userKey });
  if (activeChat) q.set('chatId', activeChat);
  await fetch(
    `/api/decks/${encodeURIComponent(deckId)}/progress?${q.toString()}`,
    { method: 'DELETE' },
  ).catch(() => {});
}

export async function saveAttempt(
  deckId: string,
  payload: {
    userKey?: string;
    mode: StudyMode;
    source: PracticeSource;
    score: number;
    total: number;
    durationSeconds: number;
    answers: AttemptAnswer[];
  },
): Promise<Attempt> {
  clearProgressInLocalVault(deckId);
  if (auth.currentUser) {
    void clearProgressInFirestore(auth.currentUser, deckId).catch(() => {});
  }

  const activeChat = getActiveChatId();
  const vault = readLocalVault();
  const deckMeta = vault.decks[deckId];
  let attempt: Attempt = {
    id: crypto.randomUUID(),
    deckId,
    mode: payload.mode,
    source: payload.source,
    score: payload.score,
    total: payload.total,
    durationSeconds: payload.durationSeconds,
    answers: payload.answers,
    completedAt: new Date().toISOString(),
  };

  try {
    const res = await fetch(`/api/decks/${encodeURIComponent(deckId)}/attempts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, telegramChatId: activeChat }),
    });
    if (res.ok) {
      const data = (await res.json()) as { attempt: Attempt };
      attempt = data.attempt;
    }
  } catch {
    // fallback to local + Firestore
  }

  const richAttempt = {
    ...attempt,
    deckTitle: deckMeta?.title || 'Exam Package',
    deckLanguage: deckMeta?.language || 'Original',
  };
  saveAttemptToLocalVault(richAttempt);
  if (auth.currentUser) {
    await saveAttemptToFirestore(auth.currentUser, richAttempt).catch(() => {});
  }
  return attempt;
}

export async function fetchRecentAttempts(params?: {
  chatId?: string;
  userKey?: string;
}): Promise<Array<Attempt & { deckTitle: string; deckLanguage: string }>> {
  const vault = readLocalVault();
  const q = new URLSearchParams();
  const activeChat = params?.chatId?.trim() || getActiveChatId();
  if (activeChat) q.set('chatId', activeChat);
  if (params?.userKey) q.set('userKey', params.userKey);
  const qs = q.toString();

  const [serverList, cloudData] = await Promise.all([
    fetch(`/api/attempts/recent${qs ? `?${qs}` : ''}`)
      .then((r) =>
        r.ok
          ? (r.json() as Promise<{
              attempts: Array<Attempt & { deckTitle: string; deckLanguage: string }>;
            }>)
          : { attempts: [] },
      )
      .then((d) => d.attempts)
      .catch(() => [] as Array<Attempt & { deckTitle: string; deckLanguage: string }>),
    auth.currentUser
      ? loadCloudDataForUser(auth.currentUser).catch(() => null)
      : Promise.resolve(null),
  ]);

  const byId = new Map<string, Attempt & { deckTitle: string; deckLanguage: string }>();
  for (const list of [vault.attempts, serverList, cloudData?.attempts ?? []]) {
    for (const a of list) {
      byId.set(a.id, a);
    }
  }
  return Array.from(byId.values())
    .sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime())
    .slice(0, 30);
}

export async function fetchTelegramStatus(options?: { autoSync?: boolean }): Promise<TelegramStatus> {
  const canAutoSync =
    Boolean(options?.autoSync) &&
    typeof window !== 'undefined' &&
    window.location.protocol === 'https:' &&
    !window.location.hostname.startsWith('ais-dev-');
  const res = await fetch(`/api/telegram/status${canAutoSync ? '?autoSync=1' : ''}`);
  return parseJson<TelegramStatus>(res);
}

export async function registerTelegramWebhook(): Promise<TelegramStatus> {
  const res = await fetch('/api/telegram/setup-webhook', { method: 'POST' });
  return parseJson<TelegramStatus>(res);
}

export async function createBotLinkCode(): Promise<string> {
  const res = await fetch('/api/telegram/link-code', { method: 'POST' });
  const data = await parseJson<{ code: string }>(res);
  return data.code;
}

export async function checkBotLinkCode(code: string): Promise<{
  linked: boolean;
  chatId: string | null;
  username: string | null;
  firstName: string | null;
}> {
  const res = await fetch(`/api/telegram/link-code/${encodeURIComponent(code)}`);
  return parseJson(res);
}

export async function sendQuizToTelegram(payload: {
  deckId: string;
  chatId: string;
  offset?: number;
}): Promise<{ sentCount: number; remainingCount: number; deckTitle: string }> {
  const res = await fetch('/api/telegram/send-quiz', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseJson(res);
}

export async function bindTelegramId(chatId: string): Promise<void> {
  const cleanChat = chatId.trim();
  if (!cleanChat) return;
  localStorage.setItem('cozyprep_chat_id', cleanChat);
  await fetch('/api/telegram/bind-id', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userKey: getRawBrowserKey(), chatId: cleanChat }),
  }).catch(() => {});
}

export async function verifyMiniAppInitData(initData: string): Promise<{
  valid: boolean;
  botConfigured?: boolean;
  chatId?: string;
  username?: string | null;
  firstName?: string | null;
}> {
  const res = await fetch('/api/telegram/verify-miniapp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData }),
  });
  return parseJson(res);
}

export function buildWebPackageShareUrl(
  deck: Pick<ExamDeck, 'id' | 'shareCode'>,
  preferMiniApp = false,
): string {
  const code = encodeURIComponent(deck.shareCode || deck.id);
  const path = preferMiniApp ? '/miniapp' : '/';
  return `${window.location.origin}${path}?share=${code}`;
}

export function buildWebCollectionShareUrl(
  collection: Pick<TestCollection, 'id' | 'shareCode'>,
  preferMiniApp = false,
): string {
  const code = encodeURIComponent(collection.shareCode || collection.id);
  const path = preferMiniApp ? '/miniapp' : '/';
  return `${window.location.origin}${path}?shareCol=${code}`;
}

export function buildPackageShareUrl(
  deck: Pick<ExamDeck, 'id' | 'shareCode'>,
  botUsername?: string | null,
  preferMiniApp = false,
): string {
  const cleanBot = (botUsername || '').replace(/^@/, '').trim();
  const code = encodeURIComponent(deck.shareCode || deck.id);
  if (cleanBot) {
    return `https://t.me/${cleanBot}?start=pkg_${code}`;
  }
  return buildWebPackageShareUrl(deck, preferMiniApp);
}

export function buildCollectionShareUrl(
  collection: Pick<TestCollection, 'id' | 'shareCode'>,
  botUsername?: string | null,
  preferMiniApp = false,
): string {
  const cleanBot = (botUsername || '').replace(/^@/, '').trim();
  const code = encodeURIComponent(collection.shareCode || collection.id);
  if (cleanBot) {
    return `https://t.me/${cleanBot}?start=col_${code}`;
  }
  return buildWebCollectionShareUrl(collection, preferMiniApp);
}

export function extractShareTargetFromParams(
  params: URLSearchParams,
  telegramStartParam?: string | null,
): {
  shareDeckCode?: string;
  shareCollectionCode?: string;
  collectionId?: string;
  deckId?: string;
} {
  const shareDeck = params.get('share');
  const shareCol = params.get('shareCol');
  const collectionId = params.get('collectionId');
  const deckId = params.get('deckId');

  if (shareDeck) return { shareDeckCode: shareDeck };
  if (shareCol) return { shareCollectionCode: shareCol };

  const startVal =
    telegramStartParam?.trim() ||
    params.get('tgWebAppStartParam')?.trim() ||
    params.get('start')?.trim() ||
    params.get('startapp')?.trim() ||
    '';

  if (startVal) {
    if (/^pkg_/i.test(startVal)) {
      return { shareDeckCode: startVal.slice(4).trim() };
    }
    if (/^col_/i.test(startVal)) {
      return { shareCollectionCode: startVal.slice(4).trim() };
    }
  }

  if (collectionId) return { collectionId };
  if (deckId) return { deckId };
  return {};
}

export async function copyTextReliably(
  text: string,
  inputEl?: HTMLInputElement | null,
): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall back to execCommand below for iframes and Telegram WebViews
  }

  try {
    if (inputEl) {
      inputEl.focus();
      inputEl.select();
      inputEl.setSelectionRange(0, text.length);
      if (document.execCommand('copy')) {
        return true;
      }
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
