(() => {
  const width = 640;
  const extraHeight = 288;
  const height = 492 + extraHeight;
  const center = width / 2;
  const spacing = 56;
  const rows = 8;
  const floor = 422 + extraHeight;
  const radius = 10.5;
  const pegScale = 1.42;
  const entryTime = 190;
  const bounceTime = 100;
  const fallTime = entryTime + rows * bounceTime;
  const settleTime = 135;
  const dropTime = fallTime + settleTime;
  const glowIntroTime = 1050;
  const blinkPeriod = 1850;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const colors = {
    'red': '#e73339',
    'enamel': '#ad1025',
    'coral': '#ff7f7e',
    'gold': '#ffbf27',
    'win-dark': '#c78a1d',
    'win-light': '#ffe799',
    'amber': '#df8700',
    'light': '#fff8e8',
    'cream': '#ffedcc',
    'tan': '#e7ba78',
    'shadow': '#531520',
    'silver': '#c0b3a6',
    'steel': '#605a56',
    'peg-light': '#4a4649',
    'peg-mid': '#211e22',
    'peg-rim': '#fffefa',
    'peg-dark': '#101013',
  };
  const sequence = {
    single: ['LLRLLLRL', 'RRLRRRLR', 'RLLRRLRR'],
    stream: [
      'LLRLLLRL', 'RRLRRRLR', 'RLLLRLLR', 'LRRLRRRL', 'LLLRLLLL', 'RLRRRRRR', 'LLLLLLLL',
      'RRRRRRRR', 'RLRLRRLR', 'LLRLLRLL', 'RRRLRRLR', 'LRLLRLRL', 'RRRRLRRR', 'RLLLLLLL',
      'LLLLLLLL', 'RRRRRRRR', 'LLRLLRLR', 'RRLRLRRL', 'RLLLLLRL', 'LRRRRRRL', 'LLLLLRLL',
      'RRRRRRLR', 'LRRLLLLR', 'LRRLRRLR', 'LRLLLLLR', 'RRLRRLRR', 'RLLRRLRR', 'LRRLRLLR',
    ],
  };

  const deck = document.createElement('canvas');
  deck.width = width * 2;
  deck.height = height * 2;
  const backdrop = deck.getContext('2d');
  if (!backdrop) return;
  backdrop.scale(2, 2);

  function peg(row, column) {
    return { x: center + (column - row / 2) * spacing, y: 139 + row * (29 + extraHeight / rows) };
  }

  function makeDrops(variant) {
    const occupancy = Array(rows + 1).fill(0);
    const routes = sequence[variant];
    const interval = variant === 'single' ? 1180 : 77;
    return routes.map((route, index) => {
      let column = 0;
      const contacts = Array.from(route, (letter, row) => {
        const { x, y } = peg(row, column);
        const direction = letter === 'R' ? 1 : -1;
        if (letter === 'R') column++;
        return { x: x + direction * 10, y: y - 17, pegX: x, pegY: y, direction };
      });
      const count = occupancy[column]++;
      const x = center + (column - rows / 2) * spacing;
      const finalPause = variant === 'stream' && index === routes.length - 1 ? 110 : 0;
      return {
        contacts, pocketX: x, x: x + [0, -13, 13][count % 3],
        y: floor - radius - (count % 3 ? 12 : 0) - Math.floor(count / 3) * 23,
        delay: index * interval + finalPause,
      };
    });
  }

  function pointAt(drop, time) {
    const first = drop.contacts[0];
    if (time < entryTime) {
      const fraction = time / entryTime;
      return { x: center + (first.x - center) * fraction, y: 96 + (first.y - 96) * fraction ** 2 };
    }
    if (time >= fallTime) {
      const fraction = Math.min((time - fallTime) / settleTime, 1);
      return {
        x: drop.pocketX + (drop.x - drop.pocketX) * fraction,
        y: drop.y - 14 * Math.sin(Math.PI * fraction) * (1 - fraction),
      };
    }
    const row = Math.floor((time - entryTime) / bounceTime);
    const from = drop.contacts[row];
    const to = drop.contacts[row + 1] ?? { x: drop.pocketX, y: drop.y };
    const t = (time - entryTime) / bounceTime - row;
    return {
      x: from.x * (1 - t) ** 2 + 2 * (from.x + from.direction * 26) * t * (1 - t) + to.x * t ** 2,
      y: from.y * (1 - t) ** 2 + 2 * (from.y - 15) * t * (1 - t) + to.y * t ** 2,
    };
  }

  function disc(target, x, y, radius, fill) {
    target.beginPath();
    target.arc(x, y, radius, 0, Math.PI * 2);
    target.fillStyle = fill;
    target.fill();
  }

  function plate(target, x, y, w, h, r, fill) {
    target.beginPath();
    target.roundRect(x, y, w, h, r);
    target.fillStyle = fill;
    target.fill();
  }

  function glaze(target, from, to, stops) {
    const gradient = target.createLinearGradient(0, from, 0, to);
    stops.forEach(([position, color]) => gradient.addColorStop(position, color));
    return gradient;
  }

  function drawDeck() {
    const target = backdrop;
    target.clearRect(0, 0, width, height);

    const cabinet = new Path2D(
      'M19 174 Q20 110 70 91 Q61 57 99 46 Q127 38 159 59 Q167 24 216 27 Q242 28 265 44 Q282 10 320 10 Q358 10 375 44 Q398 28 424 27 Q473 24 481 59 Q513 38 541 46 Q579 57 570 91 Q620 110 621 174 ' +
      `L621 ${434 + extraHeight} Q621 ${469 + extraHeight} 589 ${469 + extraHeight} H51 Q19 ${469 + extraHeight} 19 ${434 + extraHeight} Z`,
    );
    const inset = new Path2D(
      'M43 179 Q43 126 96 105 Q170 75 267 78 Q290 79 320 72 Q350 79 373 78 Q470 75 544 105 Q597 126 597 179 ' +
      `L597 ${409 + extraHeight} Q597 ${438 + extraHeight} 572 ${438 + extraHeight} H68 Q43 ${438 + extraHeight} 43 ${409 + extraHeight} Z`,
    );

    target.save();
    target.translate(0, extraHeight);
    target.save();
    target.globalAlpha = .18;
    target.filter = 'blur(6px)';
    plate(target, 38, 466, 564, 14, 7, colors.shadow);
    target.restore();

    for (const x of [59, 524]) {
      plate(target, x, 447, 57, 36, 11, colors.enamel);
      plate(target, x + 1, 467, 55, 7, 4, colors.amber);
      plate(target, x + 1, 466, 55, 4, 2, colors.gold);
    }
    target.restore();

    target.fillStyle = glaze(target, 12, 469 + extraHeight, [[0, colors.coral], [.26, colors.red], [.78, colors.red], [1, colors.enamel]]);
    target.fill(cabinet);

    target.save();
    target.clip(cabinet);
    target.fillStyle = colors.enamel;
    for (let i = 0; i < 5; i++) {
      target.beginPath();
      target.moveTo(center, 148);
      target.lineTo(30 + i * 132, -5);
      target.lineTo(81 + i * 132, -5);
      target.closePath();
      target.fill();
    }
    target.restore();

    target.lineJoin = 'round';
    target.lineWidth = 5;
    target.strokeStyle = colors.gold;
    target.stroke(cabinet);

    target.fillStyle = glaze(target, 75, 440 + extraHeight, [[0, colors.light], [.54, colors.cream], [1, colors.tan]]);
    target.fill(inset);
    target.lineWidth = 7;
    target.strokeStyle = colors.amber;
    target.stroke(inset);
    target.save();
    target.translate(0, -1.7);
    target.lineWidth = 4;
    target.strokeStyle = colors.gold;
    target.stroke(inset);
    target.restore();

    const chute = new Path2D('M286 68 Q286 51 303 51 H337 Q354 51 354 68 L348 88 Q345 101 339 111 H301 Q295 101 292 88 Z');
    target.fillStyle = glaze(target, 48, 113, [[0, colors.shadow], [.71, colors.tan], [1, colors.cream]]);
    target.fill(chute);
    target.lineWidth = 5;
    target.strokeStyle = colors.gold;
    target.stroke(chute);
    // The strip at the base of the chute overlaps the door frame, leaving a visible opening.
    plate(target, center - 16, 105, 32, 10, 3, colors.cream);

    for (let row = 0; row < rows; row++) {
      for (let column = 0; column <= row; column++) {
        const { x, y } = peg(row, column);
        target.save();
        target.globalAlpha = .24;
        disc(target, x + 3.5, y + 5.5, 7.5 * pegScale, colors.steel);
        target.restore();
        const enamel = glaze(target, y - 7.1 * pegScale, y + 7.1 * pegScale, [
          [0, colors['peg-light']], [.29, colors['peg-mid']], [1, colors['peg-dark']],
        ]);
        disc(target, x, y, 7.1 * pegScale, colors['peg-rim']);
        disc(target, x, y, 5.5 * pegScale, enamel);
      }
    }
  }

  function drawGlow(ctx, pulse) {
    ctx.save();
    ctx.translate(0, extraHeight);
    const originY = 390;
    const spread = 84 + pulse * 19;
    const bloom = ctx.createRadialGradient(center, originY, 10, center, originY, spread);
    bloom.addColorStop(0, colors.light);
    bloom.addColorStop(.22, colors.gold);
    bloom.addColorStop(.68, colors.amber);
    bloom.addColorStop(1, 'transparent');

    ctx.beginPath();
    ctx.rect(center - 112, 276, 224, 153);
    ctx.clip();
    ctx.globalAlpha = .07 + pulse * .22;
    disc(ctx, center, originY, spread, bloom);

    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let ray = -2; ray <= 2; ray++) {
      const angle = -Math.PI / 2 + ray * .47;
      const inner = 53;
      const outer = inner + 11 + pulse * (17 - Math.abs(ray) * 3);
      ctx.moveTo(center + Math.cos(angle) * inner, originY + Math.sin(angle) * inner);
      ctx.lineTo(center + Math.cos(angle) * outer, originY + Math.sin(angle) * outer);
    }
    ctx.lineWidth = 3.55;
    ctx.globalAlpha = pulse * .18;
    ctx.strokeStyle = colors.amber;
    ctx.stroke();
    ctx.lineWidth = 1.8 + pulse;
    ctx.globalAlpha = pulse * .82;
    ctx.strokeStyle = colors.light;
    ctx.stroke();
    ctx.restore();
  }

  function drawWinningGold(ctx, x, y, w, h, radius, pulse) {
    plate(ctx, x, y, w, h, radius, colors['win-dark']);
    ctx.save();
    ctx.globalAlpha = pulse;
    plate(ctx, x, y, w, h, radius, colors['win-light']);
    ctx.restore();
  }

  function drawSlots(ctx, labelFontSize, hit, pulse) {
    ctx.save();
    ctx.translate(0, extraHeight);
    for (let slot = 0; slot <= rows; slot++) {
      const x = center + (slot - rows / 2) * spacing;
      const target = slot === rows / 2;
      const rim = target ? colors.gold : slot % 2 ? colors.coral : colors.red;
      const recess = target ? colors.amber : slot % 2 ? colors.red : colors.enamel;
      plate(ctx, x - 26, 365, 52, 64, 9, rim);
      if (target && hit) {
        drawWinningGold(ctx, x - 22, 371, 44, 54, 7, pulse);
      } else {
        plate(ctx, x - 22, 371, 44, 54, 7, glaze(ctx, 371, 425, [[0, recess], [.88, rim]]));
      }
    }

    for (const side of [-1, 1]) {
      for (const offset of [107, 125, 143]) {
        const x = center + side * offset;
        disc(ctx, x, 444, 6.5, colors.shadow);
        disc(ctx, x, 443, 4.8, hit ? colors['win-dark'] : colors.amber);
        if (hit) {
          ctx.save();
          ctx.globalAlpha = pulse;
          disc(ctx, x, 443, 4.8, colors['win-light']);
          ctx.restore();
        }
      }
    }

    plate(ctx, center - 93, 431, 186, 33, 16, colors.shadow);
    if (hit) {
      drawWinningGold(ctx, center - 95, 427, 190, 33, 16, pulse);
    } else {
      plate(ctx, center - 95, 427, 190, 33, 16, colors.gold);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = colors.shadow;
    ctx.font = '500 ' + labelFontSize + 'px system-ui, sans-serif';
    ctx.fillText('CALLBACK', center, 444, 172);
    ctx.restore();
  }

  function drawBall(ctx, { x, y }) {
    ctx.save();
    ctx.globalAlpha = .26;
    disc(ctx, x + 3, y + 4, radius, colors.shadow);
    ctx.restore();
    const shine = ctx.createRadialGradient(x - 3.5, y - 4.6, .5, x, y, radius);
    shine.addColorStop(0, colors.light);
    shine.addColorStop(.36, colors.silver);
    shine.addColorStop(.82, colors.steel);
    shine.addColorStop(1, colors.silver);
    disc(ctx, x, y, radius, shine);
  }

  drawDeck();

  for (const panel of document.querySelectorAll('[data-plinko]')) {
    const canvas = panel.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;

    const mode = panel.dataset.plinko;
    const isStream = mode === 'stream';
    const drops = makeDrops(mode);
    const finish = drops.at(-1).delay + dropTime;
    const winAt = isStream ? finish - settleTime : Infinity;
    const end = isStream ? winAt + glowIntroTime : finish;
    const playButton = panel.querySelector('[data-play]');
    const glowButton = panel.querySelector('[data-glow]');
    const status = panel.querySelector('[data-result]');
    const outcomeAt = isStream ? winAt : end;
    const outcome = isStream ? 'Callback!' : 'No callback';
    const sequenceLabel = isStream ? 'the stream of drops' : 'the single drops';
    let elapsed = 0;
    let sequenceFrame = 0;
    let glowFrame = 0;
    let glowPaused = false;
    let visible = true;
    let start;
    let labelFontSize = 20;

    function draw(glowPulse = 0) {
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(deck, 0, 0, width, height);
      const hit = elapsed >= winAt;
      const progress = hit ? Math.min(1, (elapsed - winAt) / glowIntroTime) : 1;
      const startingGlow = hit && !reducedMotion.matches && progress < 1;
      const pulse = startingGlow ? Math.sin(Math.PI * progress) ** 2 : glowPulse;
      if (hit) drawGlow(ctx, pulse);
      drawSlots(ctx, labelFontSize, hit, pulse);

      for (const drop of drops) {
        const age = elapsed - drop.delay;
        if (age < 0) continue;
        if (age >= entryTime && age < fallTime) {
          const descent = (age - entryTime) / bounceTime;
          const contact = drop.contacts[Math.floor(descent)];
          const flash = Math.max(0, 1 - (descent % 1) * 2.4);
          ctx.globalAlpha = flash * .6;
          disc(ctx, contact.pegX, contact.pegY, 8 * pegScale + (1 - flash) * 15, colors.gold);
          ctx.globalAlpha = 1;
        }
        drawBall(ctx, pointAt(drop, age));
      }
    }

    function resize() {
      const size = canvas.getBoundingClientRect();
      if (!size.width) return;
      const scale = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(size.width * scale);
      canvas.height = Math.round(size.height * scale);
      labelFontSize = Math.max(20, Math.min(39, 14.5 * width / size.width));
      ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
      draw();
    }

    panel.hidden = false;
    resize();
    new ResizeObserver(resize).observe(canvas);

    function labelPlayButton(label) {
      playButton.textContent = label;
      playButton.setAttribute('aria-label', label + ' ' + sequenceLabel);
    }

    function syncGlow() {
      const running = !glowButton.hidden && !glowPaused && visible
        && !document.hidden && !reducedMotion.matches;
      if (!running) {
        if (glowFrame) {
          cancelAnimationFrame(glowFrame);
          glowFrame = 0;
          draw();
        }
        return;
      }
      if (glowFrame) return;

      let glowStart;
      let lastPaint = -Infinity;
      function blink(now) {
        glowStart ??= now;
        if (now - lastPaint >= 1000 / 30) {
          const phase = 2 * Math.PI * (now - glowStart) / blinkPeriod;
          draw((1 - Math.cos(phase)) / 2);
          lastPaint = now;
        }
        glowFrame = requestAnimationFrame(blink);
      }
      glowFrame = requestAnimationFrame(blink);
    }

    function stopGlow() {
      cancelAnimationFrame(glowFrame);
      glowFrame = 0;
      glowPaused = false;
      if (glowButton) {
        glowButton.hidden = true;
        glowButton.textContent = 'Pause glow';
      }
    }

    function tick(now) {
      start ??= now - elapsed;
      elapsed = Math.min(now - start, end);
      draw();
      if (elapsed >= outcomeAt && !status.textContent) status.textContent = outcome;
      if (elapsed < end) {
        sequenceFrame = requestAnimationFrame(tick);
        return;
      }
      sequenceFrame = 0;
      labelPlayButton('Replay');
      if (isStream) {
        glowButton.hidden = false;
        syncGlow();
      }
    }

    function play() {
      if (sequenceFrame || reducedMotion.matches) return;
      panel.removeEventListener('sectionplay', play);
      stopGlow();
      start = undefined;
      if (elapsed >= end) elapsed = 0;
      status.textContent = '';
      labelPlayButton('Pause');
      draw();
      sequenceFrame = requestAnimationFrame(tick);
    }

    playButton.addEventListener('click', () => {
      if (sequenceFrame) {
        cancelAnimationFrame(sequenceFrame);
        sequenceFrame = 0;
        labelPlayButton('Resume');
      } else {
        play();
      }
    });

    function applyMotionPreference() {
      playButton.hidden = reducedMotion.matches;
      if (reducedMotion.matches) {
        panel.removeEventListener('sectionplay', play);
        cancelAnimationFrame(sequenceFrame);
        sequenceFrame = 0;
        stopGlow();
        elapsed = end;
        status.textContent = outcome;
        labelPlayButton('Replay');
        draw();
      }
    }
    reducedMotion.addEventListener('change', applyMotionPreference);
    applyMotionPreference();

    if (!reducedMotion.matches) panel.addEventListener('sectionplay', play, { once: true });

    if (!isStream) continue;

    glowButton.addEventListener('click', () => {
      glowPaused = !glowPaused;
      glowButton.textContent = glowPaused ? 'Resume glow' : 'Pause glow';
      syncGlow();
    });
    document.addEventListener('visibilitychange', syncGlow);
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(([entry]) => {
        visible = entry.isIntersecting;
        syncGlow();
      }).observe(canvas);
    }
  }
})();
