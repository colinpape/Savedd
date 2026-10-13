/**
 * Follow-up turns on an AI answer.
 *
 * A follow-up is answered from the evidence already in the conversation.
 * If that evidence is not enough, the model names one search instead of
 * guessing. The page runs that search only after the reader clicks it,
 * and the original result list is left alone.
 */
import type { AIChatMessage, AIEvidenceItem } from './types';
import { ANSWER_SYSTEM_PROMPT, buildEvidencePrompt } from './prompts';

const SEARCH_LINE = /^SEARCH:\s*(.+?)\s*$/i;

export function followUpUserContent(question: string): string {
  return `Follow-up question. Answer ONLY from the evidence already in this conversation.

If that evidence is enough, answer directly and cite with the same [n] numbers.

If it does not contain what this question needs, do not guess and do not use outside knowledge. Reply with exactly one line and nothing else:
SEARCH: <a short web search query that would find the missing information>

QUESTION:
${question.trim()}`;
}

/** The evidence block for a search the reader chose to run. */
export function newEvidenceUserContent(question: string, evidence: AIEvidenceItem[]): string {
  return `${buildEvidencePrompt(question, evidence)}

This evidence is from a new search for the follow-up above. Answer that follow-up from this evidence only. If it is still not enough, reply with exactly one line: SEARCH: <query>`;
}

export function buildFollowUpMessages(args: {
  originalQuery: string;
  originalEvidence: AIEvidenceItem[];
  originalAnswer: string;
  history: AIChatMessage[];
  nextUser: string;
}): AIChatMessage[] {
  return [
    { role: 'system', content: ANSWER_SYSTEM_PROMPT },
    { role: 'user', content: buildEvidencePrompt(args.originalQuery, args.originalEvidence) },
    { role: 'assistant', content: args.originalAnswer },
    ...args.history,
    { role: 'user', content: args.nextUser },
  ];
}

export type FollowUpReply =
  | { kind: 'answer'; text: string }
  | { kind: 'search'; query: string };

function cleanSearchQuery(line: string): string {
  return line
    .replace(/^SEARCH:\s*/i, '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

/**
 * A reply is a search offer only when that is essentially the whole reply.
 * An answer that happens to mention a search stays an answer.
 */
export function parseFollowUpReply(text: string): FollowUpReply {
  const trimmed = text.trim();
  const lines = trimmed.split('\n').map((line) => line.trim()).filter(Boolean);
  const searchLines = lines.filter((line) => SEARCH_LINE.test(line));
  const other = lines.filter((line) => !SEARCH_LINE.test(line));
  const query = searchLines.length === 1 ? cleanSearchQuery(searchLines[0]) : '';
  const searchOnly = searchLines.length === 1
    && query.length > 0
    && (other.length === 0 || (other.join(' ').length < 140 && !/\[\d+\]/.test(trimmed)));
  if (searchOnly) return { kind: 'search', query };
  return { kind: 'answer', text: trimmed };
}
