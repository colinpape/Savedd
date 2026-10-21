/**
 * Follow-up conversation under an AI answer.
 *
 * The model answers from the snippets it already has. If those are not
 * enough, it names one search. That search runs only when the reader
 * clicks it, and it does not replace the results already on the page.
 */
import { useEffect, useRef, useState } from 'react';
import { Loader2, Search } from 'lucide-react';

import { CitedText } from '@/components/AIAnswerCard';
import { UnifiedResultCard } from '@/components/UnifiedResultCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useEngineAIStatus } from '@/hooks/useEngineAIStatus';
import { buildEvidence } from '@/hooks/useAIAnswer';
import { useAppContext } from '@/hooks/useAppContext';
import { getAIConfig, resolveAIConfig } from '@/lib/aiConfig';
import {
  buildFollowUpMessages,
  followUpUserContent,
  newEvidenceUserContent,
  parseFollowUpReply,
} from '@/lib/ai/followUp';
import { ENGINE_PROXY_PROVIDER, getAIProvider } from '@/lib/ai/registry';
import { runSideSearch } from '@/lib/ai/sideSearch';
import type { AIAnswer, AIChatMessage, AIEvidenceItem } from '@/lib/ai/types';
import type { SearchResult } from '@/lib/providers/types';
import { cn } from '@/lib/utils';

const MAX_QUESTION = 500;
const MAX_SEARCHES = 3;

type ThreadItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string; evidence: AIEvidenceItem[] }
  | {
      id: string;
      kind: 'need-search';
      followUp: string;
      searchQuery: string;
      phase: 'offer' | 'searching' | 'answering' | 'done' | 'empty' | 'error';
      results: SearchResult[];
      error?: string;
    };

interface AIFollowUpProps {
  query: string;
  answer: AIAnswer;
  evidence: AIEvidenceItem[];
  className?: string;
}

export function AIFollowUp({ query, answer, evidence, className }: AIFollowUpProps) {
  const { config } = useAppContext();
  const { status: engineStatus } = useEngineAIStatus();
  const [draft, setDraft] = useState('');
  const [items, setItems] = useState<ThreadItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const idRef = useRef(0);

  useEffect(() => () => abortRef.current?.abort(), []);

  const nextId = () => {
    idRef.current += 1;
    return `follow-${idRef.current}`;
  };

  const complete = async (messages: AIChatMessage[], signal: AbortSignal): Promise<string> => {
    const resolved = resolveAIConfig(getAIConfig(), engineStatus);
    if (resolved.tier === 'unavailable') throw new Error('AI is not available.');
    const provider = resolved.tier === 'engine'
      ? ENGINE_PROXY_PROVIDER
      : getAIProvider(resolved.providerId);
    if (!provider) throw new Error('AI is not available.');
    const reply = await provider.answer(resolved.endpoint || provider.defaultEndpoint, resolved.apiKey, {
      query,
      evidence,
      model: resolved.model || 'auto',
      signal,
      messages,
    });
    return reply.text;
  };

  const historyFrom = (thread: ThreadItem[]): AIChatMessage[] => {
    const history: AIChatMessage[] = [];
    for (const item of thread) {
      if (item.kind === 'user') history.push({ role: 'user', content: followUpUserContent(item.text) });
      if (item.kind === 'assistant') history.push({ role: 'assistant', content: item.text });
      if (item.kind === 'need-search') history.push({ role: 'assistant', content: `SEARCH: ${item.searchQuery}` });
    }
    return history.slice(-8);
  };

  const ask = async (question: string) => {
    const text = question.trim().slice(0, MAX_QUESTION);
    if (!text || busy) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const userItem: ThreadItem = { id: nextId(), kind: 'user', text };
    const thread = [...items, userItem];
    setItems(thread);
    setDraft('');
    setBusy(true);
    setError(null);
    try {
      const messages = buildFollowUpMessages({
        originalQuery: query,
        originalEvidence: evidence,
        originalAnswer: answer.text,
        history: historyFrom(items),
        nextUser: followUpUserContent(text),
      });
      const raw = await complete(messages, controller.signal);
      if (controller.signal.aborted) return;
      const parsed = parseFollowUpReply(raw);
      const searches = thread.filter((item) => item.kind === 'need-search').length;
      if (parsed.kind === 'search' && searches < MAX_SEARCHES) {
        setItems((prev) => [...prev, {
          id: nextId(),
          kind: 'need-search',
          followUp: text,
          searchQuery: parsed.query,
          phase: 'offer',
          results: [],
        }]);
      } else {
        setItems((prev) => [...prev, {
          id: nextId(),
          kind: 'assistant',
          text: parsed.kind === 'answer' ? parsed.text : raw,
          evidence,
        }]);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : 'The follow-up failed.');
      }
    } finally {
      if (abortRef.current === controller) setBusy(false);
    }
  };

  const runSearch = async (item: Extract<ThreadItem, { kind: 'need-search' }>) => {
    if (busy || (item.phase !== 'offer' && item.phase !== 'error')) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError(null);
    setItems((prev) => prev.map((entry) => (
      entry.id === item.id && entry.kind === 'need-search'
        ? { ...entry, phase: 'searching', error: undefined }
        : entry
    )));
    try {
      const results = await runSideSearch({
        query: item.searchQuery,
        disabledProviders: config.disabledProviders,
        privacyMode: config.privacyMode,
        languages: config.languageFilter,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const pack = buildEvidence(results, getAIConfig().includeNostr);
      if (pack.length === 0) {
        setItems((prev) => prev.map((entry) => (
          entry.id === item.id && entry.kind === 'need-search'
            ? { ...entry, phase: 'empty', results }
            : entry
        )));
        return;
      }
      setItems((prev) => prev.map((entry) => (
        entry.id === item.id && entry.kind === 'need-search'
          ? { ...entry, phase: 'answering', results }
          : entry
      )));
      const messages = buildFollowUpMessages({
        originalQuery: query,
        originalEvidence: evidence,
        originalAnswer: answer.text,
        history: historyFrom(items),
        nextUser: newEvidenceUserContent(item.followUp, pack),
      });
      const raw = await complete(messages, controller.signal);
      if (controller.signal.aborted) return;
      const parsed = parseFollowUpReply(raw);
      setItems((prev) => {
        const marked = prev.map((entry) => (
          entry.id === item.id && entry.kind === 'need-search'
            ? { ...entry, phase: 'done' as const, results }
            : entry
        ));
        const searches = marked.filter((entry) => entry.kind === 'need-search').length;
        if (parsed.kind === 'search' && searches < MAX_SEARCHES) {
          return [...marked, {
            id: nextId(),
            kind: 'need-search' as const,
            followUp: item.followUp,
            searchQuery: parsed.query,
            phase: 'offer' as const,
            results: [],
          }];
        }
        return [...marked, {
          id: nextId(),
          kind: 'assistant' as const,
          text: parsed.kind === 'answer' ? parsed.text : raw,
          evidence: pack,
        }];
      });
    } catch (err) {
      if (!controller.signal.aborted) {
        const message = err instanceof Error ? err.message : 'The search failed.';
        setItems((prev) => prev.map((entry) => (
          entry.id === item.id && entry.kind === 'need-search'
            ? { ...entry, phase: 'error', error: message }
            : entry
        )));
      }
    } finally {
      if (abortRef.current === controller) setBusy(false);
    }
  };

  return (
    <div className={cn('p-4 rounded-xl border border-primary/20 bg-primary/[0.03] space-y-3', className)}>
      {items.map((item) => {
        if (item.kind === 'user') {
          return (
            <p key={item.id} className="text-sm text-foreground/90">
              <span className="text-xs font-semibold text-primary mr-2">You</span>
              {item.text}
            </p>
          );
        }
        if (item.kind === 'assistant') {
          return (
            <CitedText
              key={item.id}
              text={item.text}
              evidence={item.evidence}
              className="text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap break-words"
            />
          );
        }
        return (
          <div key={item.id} className="space-y-3">
            <p className="text-sm text-muted-foreground">
              The current results don&rsquo;t cover this.
            </p>
            {item.phase === 'offer' || item.phase === 'error' ? (
              <button
                type="button"
                onClick={() => void runSearch(item)}
                disabled={busy}
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline disabled:opacity-50"
              >
                <Search className="w-3.5 h-3.5 shrink-0" />
                Search for &ldquo;{item.searchQuery}&rdquo;
              </button>
            ) : (
              <p className="text-xs text-muted-foreground inline-flex items-center gap-1.5">
                {(item.phase === 'searching' || item.phase === 'answering') && (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                )}
                {item.phase === 'searching' && `Searching for “${item.searchQuery}”`}
                {item.phase === 'answering' && 'Writing an answer from that search…'}
                {item.phase === 'done' && `Results for “${item.searchQuery}”`}
                {item.phase === 'empty' && `No pages found for “${item.searchQuery}”.`}
              </p>
            )}
            {item.error && (
              <p className="text-xs text-amber-700 dark:text-amber-500">{item.error}</p>
            )}
            {item.results.slice(0, 5).map((result) => (
              <UnifiedResultCard key={result.id} result={result} />
            ))}
          </div>
        );
      })}

      {error && <p className="text-xs text-amber-700 dark:text-amber-500">{error}</p>}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void ask(draft);
        }}
        className="flex gap-2"
      >
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Ask a follow-up"
          maxLength={MAX_QUESTION}
          disabled={busy}
          aria-label="Ask a follow-up"
        />
        <Button type="submit" size="sm" disabled={busy || draft.trim().length === 0}>
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Ask'}
        </Button>
      </form>
    </div>
  );
}
