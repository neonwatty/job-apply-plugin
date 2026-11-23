(() => {
  const pending = Array.from(document.querySelectorAll('[data-section-animation]'));
  const header = document.querySelector('.site-header');
  let settleTimer;

  function playVisibleSection() {
    if (document.hidden) return;
    const topEdge = header.getBoundingClientRect().bottom;
    const bottomEdge = window.innerHeight;
    const index = pending.findIndex(preview => {
      const { top, bottom, height } = preview.getBoundingClientRect();
      const visible = Math.min(bottom, bottomEdge) - Math.max(top, topEdge);
      return height > 0 && visible >= .6 * Math.min(height, bottomEdge - topEdge);
    });
    if (index === -1) return;

    const [preview] = pending.splice(index, 1);
    preview.dispatchEvent(new Event('sectionplay'));
  }

  function schedulePlayback() {
    clearTimeout(settleTimer);
    if (!pending.length) return;
    settleTimer = setTimeout(playVisibleSection, 120);
  }

  // Scrollend includes the snap itself. Debounce scroll events on older browsers.
  if ('onscrollend' in document) {
    document.addEventListener('scroll', () => clearTimeout(settleTimer), { passive: true });
    document.addEventListener('scrollend', playVisibleSection);
  } else {
    document.addEventListener('scroll', schedulePlayback, { passive: true });
  }
  window.addEventListener('resize', schedulePlayback);
  window.addEventListener('pageshow', schedulePlayback);
  document.addEventListener('visibilitychange', schedulePlayback);
  schedulePlayback();
})();
