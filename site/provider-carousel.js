(() => {
  const carousel = document.querySelector('[data-provider-carousel]');
  if (!carousel) return;

  const track = carousel.querySelector('.provider-track');
  const list = track.firstElementChild;
  const duplicate = list.cloneNode(true);
  duplicate.setAttribute('aria-hidden', 'true');
  track.append(duplicate);
  carousel.setAttribute('data-ready', '');

  let drag;
  carousel.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    const motion = track.getAnimations()[0];
    if (!motion) return;

    motion.pause();
    drag = { motion, x: event.clientX, time: motion.currentTime ?? 0 };
    carousel.setPointerCapture(event.pointerId);
  });

  carousel.addEventListener('pointermove', event => {
    if (!drag || !event.isPrimary || drag.motion.playState !== 'paused') return;
    const period = drag.motion.effect.getTiming().duration;
    const width = list.getBoundingClientRect().width;
    const time = drag.time + (event.clientX - drag.x) * period / width;
    drag.motion.currentTime = (time % period + period) % period;
  });

  carousel.addEventListener('lostpointercapture', () => {
    if (drag?.motion.playState === 'paused') drag.motion.play();
    drag = undefined;
  });
})();
