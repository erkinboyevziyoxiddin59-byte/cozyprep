import { useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import type { DeckDetail } from '../types.ts';
import { updateDeckDetail } from '../lib/api.ts';

interface DeckEditorModalProps {
  deck: DeckDetail;
  onClose: () => void;
  onSaved: (updated: DeckDetail) => void;
}

interface EditableQuestion {
  id?: string;
  prompt: string;
  options: string[];
  correctIndex: number;
  explanation: string;
}

export function DeckEditorModal({ deck, onClose, onSaved }: DeckEditorModalProps) {
  const [title, setTitle] = useState(deck.title);
  const [description, setDescription] = useState(deck.description);
  const [language, setLanguage] = useState(deck.language);
  const [questions, setQuestions] = useState<EditableQuestion[]>(
    deck.questions.map((q) => ({
      id: q.id,
      prompt: q.prompt,
      options: [...q.options],
      correctIndex: q.correctIndex,
      explanation: q.explanation,
    })),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateQuestion(index: number, patch: Partial<EditableQuestion>) {
    setQuestions((prev) => prev.map((q, i) => (i === index ? { ...q, ...patch } : q)));
  }

  function updateOption(qIndex: number, optIndex: number, value: string) {
    setQuestions((prev) =>
      prev.map((q, i) => {
        if (i !== qIndex) return q;
        const nextOptions = q.options.map((opt, oi) => (oi === optIndex ? value : opt));
        return { ...q, options: nextOptions };
      }),
    );
  }

  function addQuestion() {
    setQuestions((prev) => [
      ...prev,
      {
        prompt: '',
        options: ['Option A', 'Option B', 'Option C', 'Option D'],
        correctIndex: 0,
        explanation: '',
      },
    ]);
  }

  function removeQuestion(index: number) {
    setQuestions((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const validQuestions = questions.filter((q) => q.prompt.trim().length > 0);
    if (validQuestions.length === 0) {
      setError('Keep at least one question with text.');
      return;
    }

    setSaving(true);
    try {
      const updated = await updateDeckDetail(deck.id, {
        title,
        description,
        language,
        questions: validQuestions,
      });
      onSaved(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save changes.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-[#1F2421]/45 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-[#FBF9F5] border border-[#E6E1D6] rounded-2xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden">
        <div className="px-6 py-4 bg-white border-b border-[#E6E1D6] flex items-center justify-between gap-4">
          <h2 className="font-display text-xl font-semibold text-[#1F2421]">Edit Exam Package</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close editor"
            className="w-9 h-9 rounded-lg flex items-center justify-center text-[#5F6660] hover:bg-[#EFECE4] hover:text-[#1F2421] cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSave} className="flex-1 overflow-y-auto p-6 space-y-6">
          <div className="bg-white border border-[#E6E1D6] rounded-xl p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2 space-y-1">
              <label className="text-xs font-medium text-[#5F6660]">Package Title</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                className="w-full rounded-xl border border-[#E6E1D6] bg-[#FBF9F5] px-3.5 py-2 text-sm text-[#1F2421] focus:outline-none focus:border-[#2F6F5E]"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-[#5F6660]">Language</label>
              <input
                type="text"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="w-full rounded-xl border border-[#E6E1D6] bg-[#FBF9F5] px-3.5 py-2 text-sm text-[#1F2421] focus:outline-none focus:border-[#2F6F5E]"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-[#5F6660]">Short Description</label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full rounded-xl border border-[#E6E1D6] bg-[#FBF9F5] px-3.5 py-2 text-sm text-[#1F2421] focus:outline-none focus:border-[#2F6F5E]"
              />
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-lg font-semibold text-[#1F2421]">
                Questions ({questions.length})
              </h3>
              <button
                type="button"
                onClick={addQuestion}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#ECF4F1] text-[#2F6F5E] text-xs font-semibold hover:bg-[#DCECE6] transition-colors cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                Add Question
              </button>
            </div>

            {questions.map((q, qIdx) => (
              <div key={qIdx} className="bg-white border border-[#E6E1D6] rounded-xl p-5 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs font-semibold text-[#5F6660]">
                    Question {qIdx + 1}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeQuestion(qIdx)}
                    className="inline-flex items-center gap-1 text-xs text-[#5F6660] hover:text-[#C2414B] cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete
                  </button>
                </div>

                <textarea
                  rows={2}
                  value={q.prompt}
                  onChange={(e) => updateQuestion(qIdx, { prompt: e.target.value })}
                  placeholder="Enter question text..."
                  className="w-full rounded-xl border border-[#E6E1D6] bg-[#FBF9F5] px-3.5 py-2 text-sm text-[#1F2421] focus:outline-none focus:border-[#2F6F5E]"
                />

                <div className="space-y-2">
                  <span className="block text-xs text-[#5F6660]">
                    Options (select the circle for the correct answer)
                  </span>
                  {q.options.map((opt, oIdx) => (
                    <div key={oIdx} className="flex items-center gap-2.5">
                      <input
                        type="radio"
                        name={`correct-${qIdx}`}
                        checked={q.correctIndex === oIdx}
                        onChange={() => updateQuestion(qIdx, { correctIndex: oIdx })}
                        className="w-4 h-4 accent-[#2F6F5E] cursor-pointer"
                      />
                      <input
                        type="text"
                        value={opt}
                        onChange={(e) => updateOption(qIdx, oIdx, e.target.value)}
                        className="flex-1 rounded-lg border border-[#E6E1D6] bg-[#FBF9F5] px-3 py-1.5 text-sm text-[#1F2421] focus:outline-none focus:border-[#2F6F5E]"
                      />
                    </div>
                  ))}
                </div>

                <div className="space-y-1">
                  <label className="text-xs text-[#5F6660]">Explanation (shown after answering)</label>
                  <input
                    type="text"
                    value={q.explanation}
                    onChange={(e) => updateQuestion(qIdx, { explanation: e.target.value })}
                    placeholder="Why is this answer correct?"
                    className="w-full rounded-lg border border-[#E6E1D6] bg-[#FBF9F5] px-3 py-1.5 text-sm text-[#1F2421] focus:outline-none focus:border-[#2F6F5E]"
                  />
                </div>
              </div>
            ))}
          </div>

          {error && (
            <div className="rounded-xl border border-[#C2414B]/30 bg-[#FCEEEF] px-4 py-3 text-sm text-[#C2414B]">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-sm font-medium text-[#5F6660] hover:text-[#1F2421] cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2.5 rounded-xl bg-[#2F6F5E] text-white text-sm font-semibold hover:bg-[#25594B] disabled:opacity-60 cursor-pointer"
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
