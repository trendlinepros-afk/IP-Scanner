'use strict';

/* global window, document, NT */

// Runs after app.js and every view module have registered themselves.
window.addEventListener('DOMContentLoaded', () => {
  NT.init().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Boot failed', err);
    if (window.NT) NT.toast(`Startup error: ${err.message}`, 'err', 6000);
  });
});
