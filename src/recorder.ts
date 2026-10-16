import { record } from '@rrweb/record';
import { blockedContentFilter, insideBlocked } from './blocked';
import { startDevtools } from './devtools';
import type { RecorderAdapter, ReplayEvent } from './types';

export const recorder: RecorderAdapter = {
  start: (emit, options) => {
    const blockSelector = ['canvas', 'iframe', 'object', 'embed', 'video', 'audio', '[data-replay-block]', options.blockSelector].filter(Boolean).join(',');
    // rrweb still sends some content from inside blocked elements, such as a same-origin iframe's document, so every
    // node an event names is checked against the page. rr-block is rrweb's own class for blocked elements.
    const blocking = `${blockSelector},.rr-block`;
    const unblocked = blockedContentFilter((id) => insideBlocked(record.mirror.getNode(id), blocking, document));
    const stop = record({
      emit: (event) => { const kept = unblocked(event as ReplayEvent); if (kept) emit(kept); },
      recordCanvas: false,
      recordCrossOriginIframes: false,
      inlineImages: false,
      collectFonts: false,
      inlineStylesheet: true,
      maskAllInputs: true,
      maskInputFn: () => '*',
      maskTextSelector: ['[contenteditable]', '[data-replay-mask]', options.maskTextSelector].filter(Boolean).join(','),
      maskTextFn: () => '*',
      blockSelector,
      sampling: { mousemove: false, mouseInteraction: true, scroll: 150, input: 'last', media: 1000 },
      slimDOMOptions: { script: true, comment: true, headFavicon: true, headMetaDescKeywords: true, headMetaSocial: true, headMetaRobots: true, headMetaHttpEquiv: true, headMetaAuthorship: true, headMetaVerification: true },
      errorHandler: () => true,
    });
    if (!stop) return undefined;
    // Started after rrweb's first full snapshot, which the engine waits for before it keeps any event.
    let stopDevtools: (() => void) | undefined;
    try { stopDevtools = startDevtools(emit, options); } catch { /* Activity capture is optional. */ }
    return () => {
      try { stopDevtools?.(); } catch { /* Cleanup must not reach the app. */ }
      stop();
    };
  },
  snapshot: () => record.takeFullSnapshot(),
};
