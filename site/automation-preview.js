(() => {
  const preview = document.querySelector('[data-automation-preview]');
  if (!preview) return;

  const cards = Array.from(preview.querySelectorAll('[data-task-level]'), card => ({
    card,
    owner: card.querySelector('[data-owner]'),
    level: Number(card.dataset.taskLevel),
  }));
  const submit = cards.find(({ card }) => card.hasAttribute('data-submit-task'));
  const slider = preview.querySelector('[data-automation-level]');
  const modeLabels = Array.from(preview.querySelector('.automation-level-labels').children);
  const result = preview.querySelector('[data-automation-result]');
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const messages = [
    'The agent fills in basic facts.',
    'The agent also answers the screening questions.',
    'Submit application moved to the Agent tray.',
  ];
  let submitTimer;
  let playbackTimer;

  function assign(task, delegated) {
    task.card.toggleAttribute('data-delegated', delegated);
    task.owner.textContent = delegated ? ' · Agent' : ' · You';
  }

  function showLevel(level, animate, announce = true) {
    clearTimeout(submitTimer);
    submitTimer = undefined;
    // The other YOLO cards finish sliding before the final card begins.
    const delaySubmit = level === 2 && animate && !motion.matches && !submit.card.hasAttribute('data-delegated');
    slider.value = level;
    slider.setAttribute('aria-valuetext', modeLabels[level].textContent);
    for (const [index, label] of modeLabels.entries()) {
      label.toggleAttribute('data-current', index === level);
    }
    for (const task of cards) {
      assign(task, task.level <= level && (task !== submit || !delaySubmit));
    }
    if (delaySubmit) {
      submitTimer = setTimeout(() => {
        submitTimer = undefined;
        assign(submit, true);
        if (announce) result.textContent = messages[2];
      }, 570);
    } else if (announce) {
      result.textContent = messages[level];
    }
  }

  function startPlayback() {
    showLevel(0, true, false);
    playbackTimer = setTimeout(() => {
      showLevel(1, true, false);
      playbackTimer = setTimeout(() => {
        playbackTimer = undefined;
        showLevel(2, true);
      }, 900);
    }, 720);
  }

  function takeControl() {
    preview.removeEventListener('sectionplay', startPlayback);
    clearTimeout(playbackTimer);
    playbackTimer = undefined;
  }

  slider.addEventListener('focus', takeControl);
  slider.addEventListener('input', () => {
    takeControl();
    showLevel(slider.valueAsNumber, true);
  });

  motion.addEventListener('change', () => {
    if (!motion.matches) return;
    const isAnimating = playbackTimer !== undefined || submitTimer !== undefined;
    takeControl();
    if (isAnimating) showLevel(2, false);
  });

  preview.querySelector('[data-automation-controls]').hidden = false;
  if (!motion.matches) preview.addEventListener('sectionplay', startPlayback, { once: true });
})();
