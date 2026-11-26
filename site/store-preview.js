(() => {
  const root = document.querySelector('[data-store-demo]');
  if (!root) return;
  const paper = root.querySelector('.store-paper');
  const station = root.querySelector('.store-station');
  const count = root.querySelector('[data-count]');
  const title = root.querySelector('[data-paper-title]');
  const review = root.querySelector('[data-review]');
  const announcement = root.querySelector('[data-announcement]');
  const play = root.querySelector('[data-play]');
  const controls = root.querySelector('[data-store-controls]');
  const sceneButtons = [...root.querySelectorAll('[data-scene]')];
  const slots = [...root.querySelectorAll('[data-stamp]')];
  const rows = [...root.querySelectorAll('[data-field]')];
  const tools = slots.map(slot => slot.querySelector('.store-tool'));
  const impressions = rows.map(row => row.querySelector('.store-impression'));
  const stocked = root.querySelectorAll('.store-slot[data-saved]').length;
  const topics = ['start date', 'travel'];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const effects = new Set();
  let mode = 'idle';
  let interacted = false;
  let start = 0;
  let elapsed = 0;
  let next = 0;
  let timer = 0;

  function animate(element, frames, options) {
    if (reduced.matches) return;
    const effect = element.animate(frames, options);
    effects.add(effect);
    effect.finished.then(
      () => effects.delete(effect),
      () => effects.delete(effect),
    );
    return effect;
  }

  function announce(message) {
    announcement.textContent = message;
  }

  function setRack(saved) {
    count.textContent = stocked + saved;
    slots.forEach((slot, index) => {
      const taken = index < saved;
      slot.toggleAttribute('data-saved', taken);
      slot.setAttribute('aria-label', (taken ? 'Saved answer for ' : 'Open slot for ') + topics[index]);
    });
  }

  function showPaper(scene, slide = false) {
    title.textContent = 'Application ' + (scene + 1);
    rows[1].hidden = scene === 0;
    rows.forEach(row => { row.dataset.entry = 'empty'; });
    review.hidden = true;
    sceneButtons.forEach((button, index) => {
      button.setAttribute('aria-pressed', String(index === scene));
    });
    if (slide) animate(paper, [
      { transform: 'translate(31px, -8px) rotate(6deg) scale(.96)', opacity: .35 },
      { transform: 'translate(-4px, 1px) rotate(-1.5deg)', opacity: 1, offset: .76 },
      { transform: 'none', opacity: 1 },
    ], { duration: 310, easing: 'ease-out' });
  }

  function write(index) {
    rows[index].dataset.entry = 'written';
    animate(impressions[index], [
      { clipPath: 'inset(0 100% 0 0)' },
      { clipPath: 'inset(0)' },
    ], { duration: 510, easing: 'steps(12, end)' });
  }

  function center(element) {
    const box = element.getBoundingClientRect();
    return [box.left + box.width / 2, box.top + box.height / 2];
  }

  function transient(mark, className, text, frames, duration) {
    if (reduced.matches) return;
    const [x, y] = center(mark);
    const desk = station.getBoundingClientRect();
    const element = document.createElement('span');
    element.className = className;
    element.textContent = text;
    element.setAttribute('aria-hidden', 'true');
    element.style.left = x - desk.left + 'px';
    element.style.top = y - desk.top + 'px';
    station.append(element);
    const remove = () => element.remove();
    const effect = animate(element, frames, { duration, easing: 'ease-out' });
    if (effect) effect.finished.then(remove, remove);
    else remove();
  }

  function capture(index) {
    const mark = impressions[index];
    const [x, y] = center(mark);
    const [toX, toY] = center(slots[index]);
    const dx = toX - x;
    const dy = toY - y;
    transient(mark, 'store-flying', mark.textContent, [
      { transform: 'translate(-50%, -50%)' },
      { transform: 'translate(calc(-50% + ' + dx * .48 + 'px), calc(-50% + ' + (dy * .4 - 24) + 'px)) rotate(9deg)', offset: .45 },
      { transform: 'translate(calc(-50% + ' + dx + 'px), calc(-50% + ' + dy + 'px)) scale(.45)', opacity: .35 },
    ], 460);
  }

  function pulseSlot(index) {
    animate(slots[index], [
      { boxShadow: '0 0 0 0 transparent' },
      { boxShadow: '0 0 0 2px var(--brass), 0 0 12px var(--brass)', offset: .22 },
      { boxShadow: '0 0 0 0 transparent' },
    ], { duration: 480, easing: 'ease-out' });
  }

  function save(index, message) {
    setRack(index + 1);
    pulseSlot(index);
    animate(tools[index], [
      { transform: 'translateY(-12px) scale(.72) rotate(10deg)', opacity: .35 },
      { transform: 'translateY(1px) scale(1.07, .91)', opacity: 1, offset: .72 },
      { transform: 'none', opacity: 1 },
    ], { duration: 290, easing: 'ease-out' });
    animate(count, [{ transform: 'translateY(-3px) scale(1.25)' }, { transform: 'none' }], { duration: 330 });
    announce(message);
  }

  function swing(index) {
    pulseSlot(index);
    const tool = tools[index].getBoundingClientRect();
    const mark = impressions[index].getBoundingClientRect();
    const x = mark.left + (mark.width - tool.width) / 2 - tool.left;
    const y = mark.top + mark.height / 2 - tool.bottom;
    const translate = (dx, dy) => 'translate(' + dx + 'px, ' + dy + 'px)';
    animate(tools[index], [
      { transform: 'none', easing: 'ease-out' },
      { transform: translate(x * .57, y * .4 - 23) + ' rotate(-17deg) scale(1.12)', offset: .3, easing: 'ease-in' },
      { transform: translate(x, y) + ' scale(1.09, .76)', offset: .48, easing: 'ease-out' },
      { transform: translate(x, y - 23) + ' rotate(5deg)', offset: .66, easing: 'ease-in-out' },
      { transform: 'none' },
    ], { duration: 500 });
  }

  function print(index) {
    rows[index].dataset.entry = 'stamped';
    animate(impressions[index], [
      { transform: 'scale(1.23, .77)', opacity: .6 },
      { transform: 'scale(.94, 1.08)', opacity: 1, offset: .45 },
      { transform: 'none', opacity: 1 },
    ], { duration: 245, easing: 'ease-out' });
    animate(paper, [
      { transform: 'translateY(2px) rotate(-.5deg)' },
      { transform: 'translateY(-1px) rotate(.3deg)' },
      { transform: 'none' },
    ], { duration: 200, easing: 'ease-out' });
    transient(impressions[index], 'store-spark', '', [
      { transform: 'scale(.4) rotate(-8deg)', opacity: 1 },
      { transform: 'scale(1.15)', opacity: .9, offset: .37 },
      { transform: 'scale(1.85) rotate(9deg)', opacity: 0 },
    ], 305);
  }

  function ready() {
    review.hidden = false;
    animate(review, [
      { transform: 'translateY(4px) scale(.94)', opacity: 0 },
      { transform: 'translateY(0) scale(1.05)', opacity: 1, offset: .72 },
      { transform: 'none', opacity: 1 },
    ], { duration: 300, easing: 'ease-out' });
    announce('Application three. The agent pulls two matching answers from the Job Apply Store. Ready for review.');
  }

  const beats = [
    [0, () => { setRack(0); showPaper(0, true); }],
    [350, () => write(0)],
    [940, () => capture(0)],
    [1400, () => save(0, 'Start date added to the Job Apply Store. 11 saved answers.')],
    [2280, () => showPaper(1, true)],
    [2650, () => swing(0)],
    [2890, () => print(0)],
    [3450, () => write(1)],
    [4040, () => capture(1)],
    [4500, () => save(1, 'Travel answer added to the Job Apply Store. 12 saved answers.')],
    [5350, () => showPaper(2, true)],
    [5720, () => swing(0)],
    [5960, () => print(0)],
    [6210, () => swing(1)],
    [6450, () => print(1)],
    [6880, ready],
  ];
  const end = 8050;

  function stop() {
    clearTimeout(timer);
    for (const effect of effects) effect.cancel();
    effects.clear();
  }

  function setMode(value) {
    mode = value;
    play.textContent = {
      idle: 'Play animation',
      playing: 'Pause',
      paused: 'Resume',
      finished: 'Replay',
    }[value];
  }

  function still(scene, speak) {
    stop();
    setMode('idle');
    showPaper(scene);
    setRack(scene === 0 ? 0 : 2);
    rows[0].dataset.entry = scene === 0 ? 'written' : 'stamped';
    rows[1].dataset.entry = scene === 1 ? 'written' : 'stamped';
    review.hidden = scene !== 2;
    if (speak) announce([
      'First application. The Store already has ten answers. Start date is a new answer.',
      'Second application. Start date stamped in. The new travel answer is saved, for a total of twelve.',
      'Third application. Two matching answers stamped in from the Job Apply Store. Ready for review.',
    ][scene]);
  }

  function tick() {
    const now = performance.now() - start;
    while (next < beats.length && beats[next][0] <= now) {
      beats[next][1]();
      next++;
    }
    if (now >= end) {
      setMode('finished');
      return;
    }
    timer = setTimeout(tick, Math.max(0, (beats[next]?.[0] ?? end) - now));
  }

  function playSequence() {
    if (mode === 'paused') {
      for (const effect of effects) effect.play();
    } else {
      stop();
      next = 0;
      elapsed = 0;
    }
    start = performance.now() - elapsed;
    setMode('playing');
    tick();
  }

  play.addEventListener('click', () => {
    interacted = true;
    if (mode !== 'playing') {
      playSequence();
      return;
    }
    clearTimeout(timer);
    elapsed = performance.now() - start;
    for (const effect of effects) effect.pause();
    setMode('paused');
  });

  sceneButtons.forEach((button, scene) => button.addEventListener('click', () => {
    interacted = true;
    still(scene, true);
  }));

  root.addEventListener('sectionplay', () => {
    if (!reduced.matches && !interacted) playSequence();
  }, { once: true });

  reduced.addEventListener('change', event => {
    if (event.matches) {
      for (const effect of effects) effect.cancel();
    }
  });

  controls.hidden = false;
})();
