// The widget states on an English page (PM-1184): the same scenario as widget-states.mjs, with <html lang="en">.
//
//   npm run build -w @projectman/feedback-widget
//   npm run shots -- apps/feedback-widget/shots/widget-states-en.mjs --widths 1512,390
import { run } from './widget-states.mjs';

export default (context) => run(context, 'en');
