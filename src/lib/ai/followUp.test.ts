import { describe, expect, it } from 'vitest';

import { parseFollowUpReply } from './followUp';

describe('parseFollowUpReply', () => {
  it('takes a bare SEARCH line as a query', () => {
    expect(parseFollowUpReply('SEARCH: baptism in the Didache')).toEqual({
      kind: 'search',
      query: 'baptism in the Didache',
    });
  });

  it('strips quotes around the query', () => {
    expect(parseFollowUpReply('SEARCH: "baptism in the Didache"')).toEqual({
      kind: 'search',
      query: 'baptism in the Didache',
    });
  });

  it('keeps a cited answer even if it mentions a search', () => {
    const text = 'The sources describe baptism as immersion [1].\nSEARCH: ignored';
    expect(parseFollowUpReply(text)).toEqual({ kind: 'answer', text });
  });

  it('treats a short lead-in plus a SEARCH line as a search offer', () => {
    expect(parseFollowUpReply('The current snippets do not say.\nSEARCH: Didache baptism')).toEqual({
      kind: 'search',
      query: 'Didache baptism',
    });
  });
});
