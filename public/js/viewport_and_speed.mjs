// Fullscreen Mode, Auto-Center Viewport Scroll, Turbo Speed & NES Overclock
import { setNesOverclockEnabled } from '../../src/jsnes_ppu_patches.mjs';
const VALID_SPEEDS = [1, 2, 4, 8];

export function createViewportAndSpeedController(state, ui, romSync = null) {
  state.turboMultiplier = 1;
  state.holdTurboActive = false;

  const dropTarget = document.getElementById('dropTarget');
  const canvasWrap = document.getElementById('canvasWrap');
  const fullscreenBtn = document.getElementById('fullscreenBtn');
  const centerViewBtn = document.getElementById('centerViewBtn');
  const overclockBtn = document.getElementById('overclockToggleBtn');
  const speedBtns = Array.from(document.querySelectorAll('.speed-btn'));

  try {
    const savedOc = localStorage.getItem('nes_overclock_enabled');
    state.nesOverclockMode = savedOc === '0' ? 0 : savedOc === '2' ? 2 : 1;
  } catch {
    state.nesOverclockMode = 1;
  }
  state.nesOverclockEnabled = state.nesOverclockMode > 0;

  const floatingBtn = document.createElement('button');
  floatingBtn.id = 'floatingCenterBtn';
  floatingBtn.type = 'button';
  floatingBtn.className = 'floating-center-btn hidden';
  floatingBtn.textContent = 'Center Game View';
  floatingBtn.title = 'Scroll back to center the game screen';
  document.body.appendChild(floatingBtn);

  function computeRawSpeed() {
    if (state.holdTurboActive) {
      return Math.max(4, state.turboMultiplier || 1);
    }
    return state.turboMultiplier || 1;
  }

  function getEffectiveSpeed() {
    return computeRawSpeed();
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
    state.holdTurboActive = false;
    state.turboMultiplier = clean;
    updateSpeedButtonsUI();
    if (options.broadcast !== false) {
      broadcastSpeedIfOnline(clean);
    }
    if (options.showBanner !== false) {
      const msg =
        clean === 1
          ? 'GAME SPEED: 1x (CONTROLS ACTIVE)'
          : `TURBO ${clean}x: FAST-FORWARD (CONTROLS LOCKED)`;
      ui.showScreenBanner(msg, clean === 1 ? 'ok' : 'warn', 1800);
      ui.logDebug(msg);
    }
  }

  function setHoldTurbo(active) {
    const next = Boolean(active);
    if (state.holdTurboActive === next) return;
    state.holdTurboActive = next;
    const targetEff = getEffectiveSpeed();
    updateSpeedButtonsUI();
    broadcastSpeedIfOnline(targetEff);
    const msg =
      targetEff === 1
        ? 'GAME SPEED: 1x (CONTROLS ACTIVE)'
        : `TURBO ${targetEff}x: FAST-FORWARD (CONTROLS LOCKED)`;
    ui.showScreenBanner(msg, targetEff === 1 ? 'ok' : 'warn', 1600);
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

  function parseOcMode(val) {
    if (val === 2 || val === '2' || val === 'max') return 2;
    if (val === true || val === 1 || val === '1' || val === 'on') return 1;
    return 0;
  }

  function syncOverclockButtonUI() {
    if (!overclockBtn) return;
    const mode = state.nesOverclockMode ?? (state.nesOverclockEnabled ? 1 : 0);
    overclockBtn.textContent =
      mode === 2 ? 'OC: MAX' : mode === 1 ? 'OC: ON' : 'OC: OFF';
    overclockBtn.classList.toggle('active-toggle', mode > 0);
  }

  function applyOverclockToCore() {
    const mode = state.nesOverclockMode ?? (state.nesOverclockEnabled ? 1 : 0);
    if (state.nes && state.nes.ppu) {
      setNesOverclockEnabled(state.nes, mode);
      state.engine?.shadowRollback?.setOverclockMode?.(mode);
    }
    syncOverclockButtonUI();
  }

  function setOverclockEnabled(enabledOrMode, options = {}) {
    const mode = parseOcMode(enabledOrMode);
    state.nesOverclockMode = mode;
    state.nesOverclockEnabled = mode > 0;
    if (options.persist !== false) {
      try {
        localStorage.setItem('nes_overclock_enabled', String(mode));
      } catch {}
    }
    applyOverclockToCore();
    if (options.showBanner !== false) {
      const msg = mode === 2
        ? 'NES OVERCLOCK: MAX (FORCE +360sc ANTI-LAG)'
        : mode === 1
          ? 'NES OVERCLOCK: ON (SMART ANTI-LAG)'
          : 'NES OVERCLOCK: OFF (ACCURATE)';
      ui.showScreenBanner(msg, mode > 0 ? 'warn' : 'ok', 2200);
      ui.logDebug(msg);
    }
    if (
      options.syncPeer !== false &&
      romSync &&
      state.ws &&
      state.ws.readyState === 1 &&
      state.peerConnected &&
      state.engine &&
      state.nes &&
      state.nes.ppu
    ) {
      romSync.sendStateSyncToPeer({ resetToZero: false });
    }
  }

  if (overclockBtn) {
    overclockBtn.addEventListener('click', () => {
      const cur = state.nesOverclockMode ?? (state.nesOverclockEnabled ? 1 : 0);
      const nextMode = cur === 1 ? 2 : cur === 2 ? 0 : 1;
      setOverclockEnabled(nextMode, {
        persist: true,
        syncPeer: true,
        showBanner: true
      });
    });
  }

  updateSpeedButtonsUI();
  syncFullscreenButtonUI();
  syncOverclockButtonUI();

  return {
    getEffectiveSpeed,
    setSpeedMultiplier,
    setHoldTurbo,
    toggleFullscreen,
    centerGameScreen,
    applyOverclockToCore,
    setOverclockEnabled
  };
}
