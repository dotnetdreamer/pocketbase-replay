import { record } from '@rrweb/record';
import type { RecorderAdapter, ReplayEvent } from './types';

export const recorder: RecorderAdapter = {
  start: (emit, options) => record({
    emit: (event) => emit(event as ReplayEvent),
    recordCanvas: false,
    recordCrossOriginIframes: false,
    inlineImages: false,
    collectFonts: false,
    inlineStylesheet: true,
    maskAllInputs: true,
    maskInputFn: () => '*',
    maskTextSelector: ['[contenteditable]', '[data-replay-mask]', options.maskTextSelector].filter(Boolean).join(','),
    maskTextFn: () => '*',
    blockSelector: ['canvas', 'iframe', 'object', 'embed', 'video', 'audio', '[data-replay-block]', options.blockSelector].filter(Boolean).join(','),
    sampling: { mousemove: false, mouseInteraction: true, scroll: 150, input: 'last', media: 1000 },
    slimDOMOptions: { script: true, comment: true, headFavicon: true, headMetaDescKeywords: true, headMetaSocial: true, headMetaRobots: true, headMetaHttpEquiv: true, headMetaAuthorship: true, headMetaVerification: true },
    errorHandler: () => true,
  }),
  snapshot: () => record.takeFullSnapshot(),
};
