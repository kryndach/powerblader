// Fullscreen Mode, Auto-Center Viewport Scroll & Turbo Speed (1x/2x/4x/8x)
const VALID_SPEEDS = [1, 2, 4, 8];

export function createViewportAndSpeedController(state, ui) {
  state.turboMultiplier = 1;
  state.holdTurboActive = false;

  const dropTarget = document.getElementById('dropTarget');
  const canvasWrap = document.getElementById('canvasWrap');
  const fullscreenBtn = document.getElementById('fullscreenBtn');
  const centerViewBtn = document.getElementById('centerViewBtn');
  const speedBtns = Array.from(document.querySelectorAll('.speed-btn'));

  const floatingBtn = document.createElement('button');
  floatingBtn.id = 'floatingCenterBtn';
  floatingBtn.type = 'button';
  floatingBtn.className = 'floating-center-btn hidden';
  floatingBtn.textContent = 'Center Game View';
  floatingBtn.title = 'Scroll back to center the NES screen';
  document.body.appendChild(floatingBtn);

  function getEffectiveSpeed() {
    if (state.holdTurboActive) {
      return Math.max(4, state.turboMultiplier || 1);
    }
    return state.turboMultiplier || 1;
  }

  function updateSpeedButtonsUI() {
    const eff = getEffectiveSpeed();
    for (const btn of speedBtns) {
      const m = Number(btn.getAttribute('data-speed') || '1');
      btn.classList.toggle('active-toggle', m === eff);
    }
  }

  function broadcastSpeedIfOnline(effSpeed) {
    if (state.ws && state.ws.readyState === 1 && state.peerConnected) {
      state.ws.send(JSON.stringify({ type: 'speed_ctrl', mult: effSpeed }));
    }
  }

  function setSpeedMultiplier(mult, options = {}) {
    const clean = VALID_SPEEDS.includes(Number(mult)) ? Number(mult) : 1;
    state.turboMultiplier = clean;
    updateSpeedButtonsUI();

    if (options.broadcast !== false) {
      broadcastSpeedIfOnline(getEffectiveSpeed());
    }
    if (options.showBanner !== false) {
      const msg =
        clean === 1
          ? 'GAME SPEED: 1x (NORMAL)'
          : `TURBO SPEED: ${clean}x FAST-FORWARD`;
      ui.showScreenBanner(msg, clean === 1 ? 'ok' : 'warn', 1800);
      ui.logDebug(msg);
    }
  }

  function setHoldTurbo(active) {
    const next = Boolean(active);
    if (state.holdTurboActive === next) return;
    state.holdTurboActive = next;
    updateSpeedButtonsUI();
    broadcastSpeedIfOnline(getEffectiveSpeed());
  }

  for (const btn of speedBtns) {
    btn.addEventListener('click', () => {
      const m = Number(btn.getAttribute('data-speed') || '1');
      setSpeedMultiplier(m, { broadcast: true, showBanner: true });
    });
  }

  function isFullscreenActive() {
    return Boolean(
      document.fullscreenElement ||
        (dropTarget && dropTarget.classList.contains('is-fullscreen'))
    );
  }

  function syncFullscreenButtonUI() {
    const active = isFullscreenActive();
    if (fullscreenBtn) {
      fullscreenBtn.textContent = active ? 'Exit Full' : 'Full';
      fullscreenBtn.classList.toggle('active-toggle', active);
    }
  }

  async function toggleFullscreen() {
    if (!dropTarget) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (dropTarget.requestFullscreen) {
        await dropTarget.requestFullscreen();
      } else {
        dropTarget.classList.toggle('is-fullscreen');
      }
    } catch {
      dropTarget.classList.toggle('is-fullscreen');
    }
    syncFullscreenButtonUI();
  }

  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && dropTarget) {
      dropTarget.classList.remove('is-fullscreen');
    }
    syncFullscreenButtonUI();
  });

  function centerGameScreen(options = {}) {
    if (isFullscreenActive()) return;
    const target = canvasWrap || dropTarget;
    if (!target) return;
    const smooth = options.smooth !== false;
    requestAnimationFrame(() => {
      const rect = target.getBoundingClientRect();
      const viewH = window.innerHeight || document.documentElement.clientHeight;
      const offset = rect.top + window.scrollY - (viewH - rect.height) / 2;
      window.scrollTo({
        top: Math.max(0, Math.round(offset)),
        behavior: smooth ? 'smooth' : 'auto'
      });
    });
  }

  function checkScrollFloatingButton() {
    if (isFullscreenActive() || !canvasWrap) {
      floatingBtn.classList.add('hidden');
      return;
    }
    const rect = canvasWrap.getBoundingClientRect();
    const viewH = window.innerHeight || document.documentElement.clientHeight;
    const centerDelta = Math.abs(rect.top + rect.height / 2 - viewH / 2);
    floatingBtn.classList.toggle('hidden', centerDelta < 110);
  }

  window.addEventListener('scroll', checkScrollFloatingButton, {
    passive: true
  });
  window.addEventListener('resize', checkScrollFloatingButton, {
    passive: true
  });

  if (fullscreenBtn) {
    fullscreenBtn.addEventListener('click', toggleFullscreen);
  }
  if (centerViewBtn) {
    centerViewBtn.addEventListener('click', () =>
      centerGameScreen({ smooth: true })
    );
  }
  floatingBtn.addEventListener('click', () =>
    centerGameScreen({ smooth: true })
  );

  updateSpeedButtonsUI();
  syncFullscreenButtonUI();

  return {
    getEffectiveSpeed,
    setSpeedMultiplier,
    setHoldTurbo,
    toggleFullscreen,
    centerGameScreen
  };
}
