import { describe, expect, it } from 'vitest';
import { commentMentions } from './mentions';

describe('comment mentions', () => {
  it('matches complete handles, case-insensitively, deduplicating and excluding the author', () => {
    expect(
      commentMentions(
        '@QA @qa (@fe-1) @owner @unknown @fe-10 @qa_extra @qaé',
        ['qa', 'fe-1', 'owner'],
        'owner',
      ),
    ).toEqual(['qa', 'fe-1']);
  });
  it('ignores email addresses and handles inside words, including Unicode words', () => {
    expect(commentMentions('alice@qa.test first.last+tag@qa.test é@qa word@qa @@qa', ['qa'], null)).toEqual(
      [],
    );
  });
});
