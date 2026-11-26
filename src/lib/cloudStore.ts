import type { User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  type DocumentData,
  getDoc,
  getDocs,
  query,
  type QuerySnapshot,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import type {
  Attempt,
  DeckDetail,
  ExamDeck,
  PracticeSource,
  Question,
  QuizProgress,
  StudyMode,
  TestCollection,
} from '../types.ts';
import { db, handleFirestoreError, OperationType } from './firebase.ts';

const VAULT_STORAGE_KEY = 'cozyprep_vault_v1';

interface LocalVault {
  collections: Record<string, TestCollection>;
  decks: Record<string, DeckDetail>;
  progress: Record<string, QuizProgress>;
  attempts: Array<Attempt & { deckTitle: string; deckLanguage: string }>;
}

function emptyVault(): LocalVault {
  return { collections: {}, decks: {}, progress: {}, attempts: [] };
}

export function readLocalVault(): LocalVault {
  try {
    const raw = localStorage.getItem(VAULT_STORAGE_KEY);
    if (!raw) return emptyVault();
    const parsed = JSON.parse(raw) as Partial<LocalVault>;
    return {
      collections: parsed.collections ?? {},
      decks: parsed.decks ?? {},
      progress: parsed.progress ?? {},
      attempts: Array.isArray(parsed.attempts) ? parsed.attempts : [],
    };
  } catch {
    return emptyVault();
  }
}

function writeLocalVault(vault: LocalVault): void {
  try {
    localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(vault));
  } catch {
    // Ignore storage quota errors cleanly
  }
}

export function saveDeckToLocalVault(deck: DeckDetail, collectionMeta?: TestCollection): void {
  const vault = readLocalVault();
  vault.decks[deck.id] = deck;
  const colId = deck.collectionId || `single_${deck.id}`;
  const existingCol = vault.collections[colId];
  const summary: ExamDeck = {
    id: deck.id,
    collectionId: colId,
    partNumber: deck.partNumber,
    totalParts: deck.totalParts,
    rangeStart: deck.rangeStart,
    rangeEnd: deck.rangeEnd,
    shareCode: deck.shareCode,
    title: deck.title,
    description: deck.description,
    language: deck.language,
    questionType: deck.questionType,
    sourceFilename: deck.sourceFilename,
    telegramChatId: deck.telegramChatId,
    isSharedWithMe: deck.isSharedWithMe,
    createdAt: deck.createdAt,
    questionCount: deck.questions.length,
    lastScore: deck.lastScore,
  };

  if (existingCol) {
    const otherPkgs = existingCol.packages.filter((p) => p.id !== deck.id);
    const nextPkgs = [...otherPkgs, summary].sort((a, b) => a.partNumber - b.partNumber);
    vault.collections[colId] = {
      ...existingCol,
      packages: nextPkgs,
      packageCount: nextPkgs.length,
      totalQuestions: nextPkgs.reduce((sum, p) => sum + (p.questionCount ?? 0), 0),
      isSharedWithMe: existingCol.isSharedWithMe || deck.isSharedWithMe,
    };
  } else if (collectionMeta) {
    vault.collections[colId] = collectionMeta;
  } else {
    vault.collections[colId] = {
      id: colId,
      title: deck.title.replace(/\s+—\s+Part\s+\d+\s+\(Q[^)]+\)$/i, ''),
      sourceFilename: deck.sourceFilename,
      language: deck.language,
      totalQuestions: deck.questions.length,
      packageCount: 1,
      shareCode: deck.shareCode,
      telegramChatId: deck.telegramChatId,
      isSharedWithMe: deck.isSharedWithMe,
      createdAt: deck.createdAt,
      packages: [summary],
    };
  }
  writeLocalVault(vault);
}

export function saveCollectionToLocalVault(col: TestCollection, decks?: DeckDetail[]): void {
  const vault = readLocalVault();
  vault.collections[col.id] = col;
  if (decks) {
    for (const d of decks) {
      vault.decks[d.id] = d;
    }
  }
  writeLocalVault(vault);
}

export function removeCollectionFromLocalVault(collectionId: string): void {
  const vault = readLocalVault();
  const col = vault.collections[collectionId];
  if (col) {
    for (const p of col.packages) {
      delete vault.decks[p.id];
      delete vault.progress[p.id];
    }
  }
  for (const [id, d] of Object.entries(vault.decks)) {
    if (d.collectionId === collectionId || id === collectionId) {
      delete vault.decks[id];
      delete vault.progress[id];
    }
  }
  delete vault.collections[collectionId];
  writeLocalVault(vault);
}

export function removeDeckFromLocalVault(deckId: string): void {
  const vault = readLocalVault();
  const deck = vault.decks[deckId];
  delete vault.decks[deckId];
  delete vault.progress[deckId];
  if (deck?.collectionId && vault.collections[deck.collectionId]) {
    const col = vault.collections[deck.collectionId];
    const remaining = col.packages.filter((p) => p.id !== deckId);
    if (remaining.length === 0) {
      delete vault.collections[deck.collectionId];
    } else {
      vault.collections[deck.collectionId] = {
        ...col,
        packages: remaining,
        packageCount: remaining.length,
        totalQuestions: remaining.reduce((s, p) => s + (p.questionCount ?? 0), 0),
      };
    }
  }
  writeLocalVault(vault);
}

export function saveProgressToLocalVault(progress: QuizProgress): void {
  const vault = readLocalVault();
  vault.progress[progress.deckId] = progress;
  writeLocalVault(vault);
}

export function clearProgressInLocalVault(deckId: string): void {
  const vault = readLocalVault();
  delete vault.progress[deckId];
  writeLocalVault(vault);
}

export function saveAttemptToLocalVault(
  attempt: Attempt & { deckTitle: string; deckLanguage: string },
): void {
  const vault = readLocalVault();
  vault.attempts = [attempt, ...vault.attempts.filter((a) => a.id !== attempt.id)].slice(0, 50);
  delete vault.progress[attempt.deckId];
  if (vault.decks[attempt.deckId]) {
    vault.decks[attempt.deckId] = {
      ...vault.decks[attempt.deckId],
      lastScore: {
        score: attempt.score,
        total: attempt.total,
        completedAt: attempt.completedAt,
      },
    };
  }
  writeLocalVault(vault);
}

// --- Firestore Helpers ---

function safeId(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
  return cleaned || `id_${Date.now()}`;
}

function safeShareCode(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '').toUpperCase().slice(0, 64);
  return cleaned.length >= 4 ? cleaned : `CP${Date.now().toString(36).toUpperCase()}`;
}

function timestampToIso(val: unknown): string {
  if (val instanceof Timestamp) {
    return val.toDate().toISOString();
  }
  if (typeof val === 'string' && val) {
    return val;
  }
  return new Date().toISOString();
}

export function canUseCloudSync(user: User | null): user is User {
  return Boolean(user && user.uid && user.emailVerified);
}

function sanitizeQuestionsForFirestore(questions: Question[]): Array<{
  id: string;
  orderIndex: number;
  prompt: string;
  options: string[];
  correctIndex: number;
  explanation: string;
}> {
  return questions.slice(0, 50).map((q, idx) => ({
    id: safeId(q.id || `q_${idx}`),
    orderIndex: typeof q.orderIndex === 'number' ? q.orderIndex : idx,
    prompt: String(q.prompt || '').slice(0, 2000),
    options: (Array.isArray(q.options) ? q.options : ['Option A', 'Option B'])
      .slice(0, 6)
      .map((o) => String(o).slice(0, 500)),
    correctIndex: Math.max(0, Math.min(Number(q.correctIndex ?? 0), Math.max(0, (q.options?.length ?? 2) - 1))),
    explanation: String(q.explanation || '').slice(0, 1000),
  }));
}

export async function saveCollectionBundleToFirestore(
  user: User,
  col: TestCollection,
  decks: DeckDetail[],
  options?: { overwrite?: boolean },
): Promise<void> {
  if (!canUseCloudSync(user) || decks.length === 0) return;

  const uid = safeId(user.uid);
  const colId = safeId(col.id);
  const colRef = doc(db, 'users', uid, 'collections', colId);

  const validDecks = decks
    .map((d) => ({
      deck: d,
      safeQuestions: sanitizeQuestionsForFirestore(d.questions),
    }))
    .filter((item) => item.safeQuestions.length > 0);
  if (validDecks.length === 0) return;

  try {
    const existingCol = await getDoc(colRef);
    if (existingCol.exists() && !options?.overwrite) {
      return;
    }

    const totalQ = Math.max(
      0,
      Math.min(20000, validDecks.reduce((s, item) => s + item.safeQuestions.length, 0)),
    );
    const pkgCount = Math.max(1, Math.min(400, validDecks.length));

    const batch = writeBatch(db);
    if (!existingCol.exists()) {
      batch.set(colRef, {
        id: colId,
        ownerUid: uid,
        title: (col.title || 'Untitled Test').slice(0, 240),
        sourceFilename: col.sourceFilename ? col.sourceFilename.slice(0, 240) : null,
        language: (col.language || 'Original').slice(0, 64),
        totalQuestions: totalQ,
        packageCount: pkgCount,
        shareCode: safeShareCode(col.shareCode || colId),
        isSharedWithMe: Boolean(col.isSharedWithMe),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      batch.update(colRef, {
        title: (col.title || 'Untitled Test').slice(0, 240),
        totalQuestions: totalQ,
        packageCount: pkgCount,
        updatedAt: serverTimestamp(),
      });
    }

    for (const { deck: d, safeQuestions } of validDecks) {
      const deckId = safeId(d.id);
      const deckRef = doc(db, 'users', uid, 'decks', deckId);

      const rangeStart = Math.max(1, d.rangeStart || 1);
      const rangeEnd = Math.max(rangeStart, d.rangeEnd || rangeStart + safeQuestions.length - 1);
      const existingDeck = options?.overwrite ? await getDoc(deckRef) : null;

      if (existingDeck?.exists()) {
        batch.update(deckRef, {
          title: (d.title || 'Exam Package').slice(0, 240),
          description: (d.description || '').slice(0, 500),
          language: (d.language || 'Original').slice(0, 64),
          questions: safeQuestions,
          updatedAt: serverTimestamp(),
        });
      } else {
        batch.set(deckRef, {
          id: deckId,
          ownerUid: uid,
          collectionId: colId,
          partNumber: Math.max(1, Math.min(400, d.partNumber || 1)),
          totalParts: Math.max(1, Math.min(400, d.totalParts || decks.length)),
          rangeStart,
          rangeEnd,
          shareCode: safeShareCode(d.shareCode || deckId),
          title: (d.title || 'Exam Package').slice(0, 240),
          description: (d.description || '').slice(0, 500),
          language: (d.language || 'Original').slice(0, 64),
          sourceFilename: d.sourceFilename ? d.sourceFilename.slice(0, 240) : null,
          isSharedWithMe: Boolean(d.isSharedWithMe ?? col.isSharedWithMe),
          questions: safeQuestions,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    }

    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `users/${uid}/collections/${colId}`);
  }
}

export async function updateDeckInFirestore(user: User, deck: DeckDetail): Promise<void> {
  if (!canUseCloudSync(user)) return;
  const uid = safeId(user.uid);
  const deckId = safeId(deck.id);
  const path = `users/${uid}/decks/${deckId}`;
  try {
    const ref = doc(db, 'users', uid, 'decks', deckId);
    const snap = await getDoc(ref);
    if (!snap.exists()) return;
    await updateDoc(ref, {
      title: (deck.title || 'Exam Package').slice(0, 240),
      description: (deck.description || '').slice(0, 500),
      language: (deck.language || 'Original').slice(0, 64),
      questions: sanitizeQuestionsForFirestore(deck.questions),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function deleteCollectionInFirestore(
  user: User,
  collectionId: string,
  packageIds: string[],
): Promise<void> {
  if (!canUseCloudSync(user)) return;
  const uid = safeId(user.uid);
  const colId = safeId(collectionId);
  try {
    const batch = writeBatch(db);
    for (const pid of packageIds) {
      batch.delete(doc(db, 'users', uid, 'decks', safeId(pid)));
      batch.delete(doc(db, 'users', uid, 'progress', safeId(pid)));
    }
    batch.delete(doc(db, 'users', uid, 'collections', colId));
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `users/${uid}/collections/${colId}`);
  }
}

export async function deleteDeckInFirestore(user: User, deckId: string): Promise<void> {
  if (!canUseCloudSync(user)) return;
  const uid = safeId(user.uid);
  const safeDeckId = safeId(deckId);
  try {
    await deleteDoc(doc(db, 'users', uid, 'decks', safeDeckId));
    await deleteDoc(doc(db, 'users', uid, 'progress', safeDeckId)).catch(() => {});
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `users/${uid}/decks/${safeDeckId}`);
  }
}

export async function saveProgressToFirestore(
  user: User,
  progress: QuizProgress,
): Promise<void> {
  if (!canUseCloudSync(user)) return;
  const uid = safeId(user.uid);
  const deckId = safeId(progress.deckId);
  const path = `users/${uid}/progress/${deckId}`;
  try {
    const entries = Object.entries(progress.selectedMap || {}).slice(0, 60);
    const cleanMap: Record<string, number> = {};
    for (const [k, v] of entries) {
      cleanMap[String(k).slice(0, 128)] = Number(v);
    }
    await setDoc(doc(db, 'users', uid, 'progress', deckId), {
      deckId,
      ownerUid: uid,
      mode: progress.mode === 'exam' ? 'exam' : 'quiz',
      currentIndex: Math.max(0, Math.min(50, Math.round(progress.currentIndex))),
      selectedMap: cleanMap,
      elapsedSeconds: Math.max(0, Math.min(86400, Math.round(progress.elapsedSeconds))),
      updatedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

export async function clearProgressInFirestore(user: User, deckId: string): Promise<void> {
  if (!canUseCloudSync(user)) return;
  const uid = safeId(user.uid);
  const safeDeckId = safeId(deckId);
  try {
    await deleteDoc(doc(db, 'users', uid, 'progress', safeDeckId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `users/${uid}/progress/${safeDeckId}`);
  }
}

export async function saveAttemptToFirestore(
  user: User,
  attempt: Attempt & { deckTitle: string; deckLanguage: string },
): Promise<void> {
  if (!canUseCloudSync(user)) return;
  const uid = safeId(user.uid);
  const attemptId = safeId(attempt.id);
  const path = `users/${uid}/attempts/${attemptId}`;
  try {
    await setDoc(doc(db, 'users', uid, 'attempts', attemptId), {
      id: attemptId,
      ownerUid: uid,
      deckId: safeId(attempt.deckId),
      deckTitle: (attempt.deckTitle || 'Exam Package').slice(0, 240),
      deckLanguage: (attempt.deckLanguage || 'Original').slice(0, 64),
      mode: attempt.mode === 'exam' ? 'exam' : 'quiz',
      source: attempt.source || 'web',
      score: Math.max(0, Math.min(50, Math.round(attempt.score))),
      total: Math.max(1, Math.min(50, Math.round(attempt.total))),
      durationSeconds: Math.max(0, Math.min(86400, Math.round(attempt.durationSeconds))),
      completedAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, path);
  }
}

export async function loadCloudDataForUser(user: User): Promise<{
  collections: TestCollection[];
  decksById: Record<string, DeckDetail>;
  progressSummary: Record<
    string,
    { currentIndex: number; answeredCount: number; mode: StudyMode; updatedAt: string }
  >;
  progressByDeckId: Record<string, QuizProgress>;
  attempts: Array<Attempt & { deckTitle: string; deckLanguage: string }>;
}> {
  if (!canUseCloudSync(user)) {
    return {
      collections: [],
      decksById: {},
      progressSummary: {},
      progressByDeckId: {},
      attempts: [],
    };
  }

  const uid = safeId(user.uid);
  const colPath = `users/${uid}/collections`;
  const deckPath = `users/${uid}/decks`;
  const progPath = `users/${uid}/progress`;
  const attPath = `users/${uid}/attempts`;

  let colDocs: QuerySnapshot<DocumentData>;
  let deckDocs: QuerySnapshot<DocumentData>;
  let progDocs: QuerySnapshot<DocumentData>;
  let attDocs: QuerySnapshot<DocumentData>;

  try {
    colDocs = await getDocs(query(collection(db, colPath), where('ownerUid', '==', uid)));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, colPath);
  }

  try {
    deckDocs = await getDocs(query(collection(db, deckPath), where('ownerUid', '==', uid)));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, deckPath);
  }

  try {
    progDocs = await getDocs(query(collection(db, progPath), where('ownerUid', '==', uid)));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, progPath);
  }

  try {
    attDocs = await getDocs(query(collection(db, attPath), where('ownerUid', '==', uid)));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, attPath);
  }

  const attempts: Array<Attempt & { deckTitle: string; deckLanguage: string }> = attDocs.docs
    .map((d) => {
      const data = d.data();
      return {
        id: String(data.id || d.id),
        deckId: String(data.deckId),
        deckTitle: String(data.deckTitle || 'Exam Package'),
        deckLanguage: String(data.deckLanguage || 'Original'),
        mode: (data.mode === 'exam' ? 'exam' : 'quiz') as StudyMode,
        source: (data.source || 'web') as PracticeSource,
        score: Number(data.score ?? 0),
        total: Number(data.total ?? 1),
        durationSeconds: Number(data.durationSeconds ?? 0),
        answers: [],
        completedAt: timestampToIso(data.completedAt),
      };
    })
    .sort((a, b) => new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime());

  const latestAttemptByDeck = new Map<string, Attempt>();
  for (const a of attempts) {
    if (!latestAttemptByDeck.has(a.deckId)) {
      latestAttemptByDeck.set(a.deckId, a);
    }
  }

  const decksById: Record<string, DeckDetail> = {};
  const decksByCol = new Map<string, ExamDeck[]>();

  for (const docSnap of deckDocs.docs) {
    const data = docSnap.data();
    const deckId = String(data.id || docSnap.id);
    const colId = String(data.collectionId || `single_${deckId}`);
    const rawQuestions = Array.isArray(data.questions) ? data.questions : [];
    const questions: Question[] = rawQuestions.map((q: Record<string, unknown>, idx: number) => ({
      id: String(q.id || `q_${idx}`),
      deckId,
      orderIndex: Number(q.orderIndex ?? idx),
      prompt: String(q.prompt || ''),
      options: Array.isArray(q.options) ? q.options.map(String) : [],
      correctIndex: Number(q.correctIndex ?? 0),
      explanation: String(q.explanation || ''),
      format: 'multiple_choice',
    }));

    const latest = latestAttemptByDeck.get(deckId);
    const lastScore = latest
      ? { score: latest.score, total: latest.total, completedAt: latest.completedAt }
      : null;

    const detail: DeckDetail = {
      id: deckId,
      collectionId: colId,
      partNumber: Number(data.partNumber ?? 1),
      totalParts: Number(data.totalParts ?? 1),
      rangeStart: Number(data.rangeStart ?? 1),
      rangeEnd: Number(data.rangeEnd ?? questions.length),
      shareCode: String(data.shareCode || deckId),
      title: String(data.title || 'Exam Package'),
      description: String(data.description || ''),
      language: String(data.language || 'Original'),
      questionType: 'multiple_choice',
      sourceFilename: (data.sourceFilename as string | null) ?? null,
      telegramChatId: null,
      isSharedWithMe: Boolean(data.isSharedWithMe),
      createdAt: timestampToIso(data.createdAt),
      questionCount: questions.length,
      lastScore,
      questions,
      attempts: attempts.filter((a) => a.deckId === deckId),
    };
    decksById[deckId] = detail;

    const list = decksByCol.get(colId) || [];
    list.push({
      id: detail.id,
      collectionId: detail.collectionId,
      partNumber: detail.partNumber,
      totalParts: detail.totalParts,
      rangeStart: detail.rangeStart,
      rangeEnd: detail.rangeEnd,
      shareCode: detail.shareCode,
      title: detail.title,
      description: detail.description,
      language: detail.language,
      questionType: 'multiple_choice',
      sourceFilename: detail.sourceFilename,
      telegramChatId: null,
      isSharedWithMe: detail.isSharedWithMe,
      createdAt: detail.createdAt,
      questionCount: questions.length,
      lastScore,
    });
    decksByCol.set(colId, list);
  }

  const collections: TestCollection[] = colDocs.docs
    .map((docSnap) => {
      const data = docSnap.data();
      const colId = String(data.id || docSnap.id);
      const pkgs = (decksByCol.get(colId) || []).sort((a, b) => a.partNumber - b.partNumber);
      return {
        id: colId,
        title: String(data.title || 'Test File'),
        sourceFilename: (data.sourceFilename as string | null) ?? null,
        language: String(data.language || 'Original'),
        totalQuestions: pkgs.reduce((sum, p) => sum + (p.questionCount ?? 0), 0) || Number(data.totalQuestions ?? 0),
        packageCount: pkgs.length || Number(data.packageCount ?? 1),
        shareCode: String(data.shareCode || colId),
        telegramChatId: null,
        isSharedWithMe: Boolean(data.isSharedWithMe),
        createdAt: timestampToIso(data.createdAt),
        packages: pkgs,
      };
    })
    .filter((c) => c.packages.length > 0)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const progressSummary: Record<
    string,
    { currentIndex: number; answeredCount: number; mode: StudyMode; updatedAt: string }
  > = {};
  const progressByDeckId: Record<string, QuizProgress> = {};

  for (const docSnap of progDocs.docs) {
    const data = docSnap.data();
    const deckId = String(data.deckId || docSnap.id);
    const selectedMap = (data.selectedMap as Record<string, number>) || {};
    const updatedAt = timestampToIso(data.updatedAt);
    const mode: StudyMode = data.mode === 'exam' ? 'exam' : 'quiz';
    const currentIndex = Number(data.currentIndex ?? 0);
    progressByDeckId[deckId] = {
      deckId,
      userKey: uid,
      mode,
      currentIndex,
      selectedMap,
      elapsedSeconds: Number(data.elapsedSeconds ?? 0),
      updatedAt,
    };
    const answeredCount = Object.keys(selectedMap).length;
    if (answeredCount > 0 || currentIndex > 0) {
      progressSummary[deckId] = {
        currentIndex,
        answeredCount,
        mode,
        updatedAt,
      };
    }
  }

  // Keep local vault synchronized with cloud
  const vault = readLocalVault();
  for (const c of collections) {
    vault.collections[c.id] = c;
  }
  for (const [id, d] of Object.entries(decksById)) {
    vault.decks[id] = d;
  }
  for (const [id, p] of Object.entries(progressByDeckId)) {
    vault.progress[id] = p;
  }
  if (attempts.length > 0) {
    const seen = new Set(attempts.map((a) => a.id));
    vault.attempts = [...attempts, ...vault.attempts.filter((a) => !seen.has(a.id))].slice(0, 50);
  }
  writeLocalVault(vault);

  return { collections, decksById, progressSummary, progressByDeckId, attempts };
}

// --- Direct Web-Link Sharing via Firestore `/shares/{shareCode}` ---

export async function publishShareBundleToFirestore(
  user: User,
  params: {
    kind: 'deck' | 'collection';
    shareCode: string;
    collectionId: string;
    title: string;
    sourceFilename?: string | null;
    language: string;
    packages: DeckDetail[];
  },
): Promise<void> {
  if (!canUseCloudSync(user) || params.packages.length === 0) return;

  const uid = safeId(user.uid);
  const rawCode = safeShareCode(params.shareCode.replace(/^(?:pkg_|col_)/i, ''));
  const bundleCode = `${params.kind === 'deck' ? 'pkg_' : 'col_'}${rawCode}`;
  const shareRef = doc(db, 'shares', bundleCode);
  const totalQ = Math.max(
    1,
    Math.min(20000, params.packages.reduce((s, p) => s + p.questions.length, 0)),
  );

  try {
    const existing = await getDoc(shareRef);
    if (existing.exists() && existing.data()?.ownerUid !== uid) {
      // Share bundle already exists under its original publisher; reuse the live share link safely.
      return;
    }

    const batch = writeBatch(db);

    if (existing.exists()) {
      batch.update(shareRef, {
        title: (params.title || 'Shared Test').slice(0, 240),
        totalQuestions: totalQ,
        packageCount: Math.max(1, Math.min(400, params.packages.length)),
        updatedAt: serverTimestamp(),
      });
    } else {
      batch.set(shareRef, {
        shareCode: bundleCode,
        kind: params.kind,
        ownerUid: uid,
        title: (params.title || 'Shared Test').slice(0, 240),
        sourceFilename: params.sourceFilename ? params.sourceFilename.slice(0, 240) : null,
        language: (params.language || 'Original').slice(0, 64),
        totalQuestions: totalQ,
        packageCount: Math.max(1, Math.min(400, params.packages.length)),
        collectionId: safeId(params.collectionId),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    for (const pkg of params.packages) {
      const deckId = safeId(pkg.id);
      const pkgRef = doc(db, 'shares', bundleCode, 'packages', deckId);
      const safeQuestions = sanitizeQuestionsForFirestore(pkg.questions);
      if (safeQuestions.length === 0) continue;

      const existingPkg = existing.exists() ? await getDoc(pkgRef) : null;
      if (existingPkg?.exists()) {
        batch.update(pkgRef, {
          title: (pkg.title || 'Exam Package').slice(0, 240),
          description: (pkg.description || '').slice(0, 500),
          questions: safeQuestions,
        });
      } else {
        const rangeStart = Math.max(1, pkg.rangeStart || 1);
        const rangeEnd = Math.max(rangeStart, pkg.rangeEnd || rangeStart + safeQuestions.length - 1);
        batch.set(pkgRef, {
          id: deckId,
          parentShareCode: bundleCode,
          ownerUid: uid,
          collectionId: safeId(params.collectionId),
          partNumber: Math.max(1, Math.min(400, pkg.partNumber || 1)),
          totalParts: Math.max(1, Math.min(400, pkg.totalParts || params.packages.length)),
          rangeStart,
          rangeEnd,
          shareCode: safeShareCode(pkg.shareCode || deckId),
          title: (pkg.title || 'Exam Package').slice(0, 240),
          description: (pkg.description || '').slice(0, 500),
          language: (pkg.language || 'Original').slice(0, 64),
          sourceFilename: pkg.sourceFilename ? pkg.sourceFilename.slice(0, 240) : null,
          questions: safeQuestions,
          createdAt: serverTimestamp(),
        });
      }
    }

    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `shares/${bundleCode}`);
  }
}

export async function fetchShareBundleFromFirestore(rawCodeOrUrl: string): Promise<{
  kind: 'deck' | 'collection';
  collection: TestCollection;
  packages: DeckDetail[];
} | null> {
  const match = rawCodeOrUrl
    .trim()
    .match(/(?:pkg_|col_|share=|shareCol=|start=|startapp=)([A-Za-z0-9_-]+)/i);
  const extracted = match && match[1] ? match[1] : rawCodeOrUrl.trim();
  const bareCode = extracted.replace(/^(?:pkg_|col_)/i, '').trim().toUpperCase();
  if (!bareCode || bareCode.length < 4) return null;

  const isColHint = /(?:col_|shareCol=)/i.test(rawCodeOrUrl);
  const candidates = isColHint
    ? [`col_${bareCode}`, `pkg_${bareCode}`]
    : [`pkg_${bareCode}`, `col_${bareCode}`];

  for (const shareDocId of candidates) {
    try {
      const shareRef = doc(db, 'shares', shareDocId);
      const snap = await getDoc(shareRef);
      if (!snap.exists()) continue;
      const meta = snap.data();

      const pkgsPath = `shares/${shareDocId}/packages`;
      const pkgsSnap = await getDocs(
        query(collection(db, pkgsPath), where('parentShareCode', '==', shareDocId)),
      );
      if (pkgsSnap.empty) continue;

      const colId = String(meta.collectionId || `shared_${shareDocId}`);
      const packages: DeckDetail[] = pkgsSnap.docs
        .map((pDoc) => {
          const d = pDoc.data();
          const deckId = String(d.id || pDoc.id);
          const rawQ = Array.isArray(d.questions) ? d.questions : [];
          const questions: Question[] = rawQ.map((q: Record<string, unknown>, idx: number) => ({
            id: String(q.id || `q_${idx}`),
            deckId,
            orderIndex: Number(q.orderIndex ?? idx),
            prompt: String(q.prompt || ''),
            options: Array.isArray(q.options) ? q.options.map(String) : [],
            correctIndex: Number(q.correctIndex ?? 0),
            explanation: String(q.explanation || ''),
            format: 'multiple_choice',
          }));
          return {
            id: deckId,
            collectionId: colId,
            partNumber: Number(d.partNumber ?? 1),
            totalParts: Number(d.totalParts ?? 1),
            rangeStart: Number(d.rangeStart ?? 1),
            rangeEnd: Number(d.rangeEnd ?? questions.length),
            shareCode: String(d.shareCode || bareCode),
            title: String(d.title || 'Shared Package'),
            description: String(d.description || ''),
            language: String(d.language || 'Original'),
            questionType: 'multiple_choice' as const,
            sourceFilename: (d.sourceFilename as string | null) ?? null,
            telegramChatId: null,
            isSharedWithMe: true,
            createdAt: timestampToIso(d.createdAt),
            questionCount: questions.length,
            lastScore: null,
            questions,
            attempts: [],
          };
        })
        .sort((a, b) => a.partNumber - b.partNumber);

      const testCollection: TestCollection = {
        id: colId,
        title: String(meta.title || 'Shared Test'),
        sourceFilename: (meta.sourceFilename as string | null) ?? null,
        language: String(meta.language || 'Original'),
        totalQuestions: packages.reduce((s, p) => s + p.questions.length, 0),
        packageCount: packages.length,
        shareCode: String(meta.shareCode || shareDocId).replace(/^(?:pkg_|col_)/i, ''),
        telegramChatId: null,
        isSharedWithMe: true,
        createdAt: timestampToIso(meta.createdAt),
        packages: packages.map((p) => ({
          id: p.id,
          collectionId: colId,
          partNumber: p.partNumber,
          totalParts: p.totalParts,
          rangeStart: p.rangeStart,
          rangeEnd: p.rangeEnd,
          shareCode: p.shareCode,
          title: p.title,
          description: p.description,
          language: p.language,
          questionType: p.questionType,
          sourceFilename: p.sourceFilename,
          telegramChatId: null,
          isSharedWithMe: true,
          createdAt: p.createdAt,
          questionCount: p.questions.length,
          lastScore: null,
        })),
      };

      return {
        kind: meta.kind === 'collection' ? 'collection' : 'deck',
        collection: testCollection,
        packages,
      };
    } catch (err) {
      // Log and continue to next candidate
      console.warn('Firestore share lookup note:', err);
    }
  }
  return null;
}
