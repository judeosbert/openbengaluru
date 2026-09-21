/* Sign-in gate: an unauthenticated "Submit a sim" OR "Export area" click
 * lands here before its flow. Explains the Google sign-in requirement and
 * routes the branded CTA through the store's sign-in flow (signInFromGate —
 * success closes the gate and continues into the flow that asked for it:
 * export -> the export area, submit -> the wizard); veil-click / Cancel
 * just dismiss. Copy branches on the store's gate intent. */
import React from 'react';

const h = React.createElement;

/* The four-color Google "G" (standard sign-in button mark, 48 viewBox).
 * Exported — the Capture page's sign-in sheet reuses the same mark. */
export const G_MARK = h('svg', {
  viewBox: '0 0 48 48', width: 18, height: 18, 'aria-hidden': 'true',
},
h('path', {
  fill: '#EA4335',
  d: 'M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 '
    + '14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z',
}),
h('path', {
  fill: '#4285F4',
  d: 'M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 '
    + '5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z',
}),
h('path', {
  fill: '#FBBC05',
  d: 'M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C'
    + '.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z',
}),
h('path', {
  fill: '#34A853',
  d: 'M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 '
    + '2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z',
}));

export function SignInGate({ store }) {
  const isExport = store.signGate === 'export';
  return h('div', {
    className: 'modal-veil',
    onClick: (ev) => {
      if (ev.target === ev.currentTarget) store.closeSignGate();
    },
  },
  h('div', { className: 'modal signin-gate' },
    h('div', { className: 'step' },
      isExport ? 'EXPORT AREA FOR SUMO' : 'SUBMIT A SIMULATION'),
    h('h3', null,
      isExport ? 'Sign in to export' : 'Sign in to submit a sim'),
    h('p', { className: 'hint' }, isExport
      ? 'You need to sign in with Google to export a SUMO road network '
        + 'for your area.'
      : 'You need to sign in with Google to submit a simulation. '
        + 'Your Google account becomes the recorded author.'),
    h('button', { className: 'gbtn', onClick: store.signInFromGate },
      G_MARK, h('span', null, 'Sign in with Google')),
    h('div', { className: 'row' },
      h('button', { className: 'ghost', onClick: store.closeSignGate },
        'Cancel'))));
}
