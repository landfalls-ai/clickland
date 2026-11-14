import { describe, expect, it } from 'vitest';
import { splitMarkers, viewIds } from '@/lib/markers';

describe('assistant view markers', () => {
  it('splits text around each marker, in order', () => {
    const text = 'Errors spiked.\n[[clickland:view:vw_abc123]]\nAnd the traces:\n[[clickland:view:vw_Def456]] done';
    expect(splitMarkers(text)).toEqual([
      { type: 'text', text: 'Errors spiked.\n' },
      { type: 'view', id: 'vw_abc123' },
      { type: 'text', text: '\nAnd the traces:\n' },
      { type: 'view', id: 'vw_Def456' },
      { type: 'text', text: ' done' },
    ]);
  });

  it('keeps text with no marker as one segment and drops blank text between markers', () => {
    expect(splitMarkers('just words')).toEqual([{ type: 'text', text: 'just words' }]);
    expect(splitMarkers('[[clickland:view:vw_a]]\n\n[[clickland:view:vw_b]]')).toEqual([
      { type: 'view', id: 'vw_a' },
      { type: 'view', id: 'vw_b' },
    ]);
  });

  it('hides a marker still arriving while the answer streams', () => {
    expect(splitMarkers('Here it is: [[clickland:vi', true)).toEqual([{ type: 'text', text: 'Here it is: ' }]);
    expect(splitMarkers('Here it is: [[clickland:view:vw_ab', true)).toEqual([{ type: 'text', text: 'Here it is: ' }]);
    // Once the answer is done, an unfinished marker is just text.
    expect(splitMarkers('Here it is: [[clickland:vi')).toEqual([{ type: 'text', text: 'Here it is: [[clickland:vi' }]);
  });

  it('ignores look-alikes', () => {
    expect(splitMarkers('[[clickland:view:abc]] [[other:view:vw_x]]')).toEqual([
      { type: 'text', text: '[[clickland:view:abc]] [[other:view:vw_x]]' },
    ]);
  });

  it('lists each view id once', () => {
    expect(viewIds('[[clickland:view:vw_a]] x [[clickland:view:vw_b]] [[clickland:view:vw_a]]')).toEqual([
      'vw_a',
      'vw_b',
    ]);
  });
});
