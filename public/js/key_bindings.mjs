// Customizable Key Bindings, Fast A/B (Z<->X) Swap & Interactive Modal UI
const INPUT_BITS = {
  A: 1, B: 2, SELECT: 4, START: 8, UP: 16, DOWN: 32, LEFT: 64, RIGHT: 128,
  C: 256, X: 512, Y: 1024, Z: 2048
};

const STORAGE_KEY = 'nes_key_bindings_v1';

const ACTIONS = [
  { id: 'UP', label: 'D-Pad Up', bit: INPUT_BITS.UP },
  { id: 'DOWN', label: 'D-Pad Down', bit: INPUT_BITS.DOWN },
  { id: 'LEFT', label: 'D-Pad Left', bit: INPUT_BITS.LEFT },
  { id: 'RIGHT', label: 'D-Pad Right', bit: INPUT_BITS.RIGHT },
  { id: 'A', label: 'Button A / Arcade Btn 1', bit: INPUT_BITS.A },
  { id: 'B', label: 'Button B / Arcade Btn 2', bit: INPUT_BITS.B },
  { id: 'C', label: 'Button C (Sega) / L / Arcade 3', bit: INPUT_BITS.C },
  { id: 'X', label: 'Button X / Arcade Btn 4', bit: INPUT_BITS.X },
  { id: 'Y', label: 'Button Y / Arcade Btn 5', bit: INPUT_BITS.Y },
  { id: 'Z', label: 'Button Z / R / Arcade Btn 6', bit: INPUT_BITS.Z },
  { id: 'SELECT', label: 'Select / Mode / Coin', bit: INPUT_BITS.SELECT },
  { id: 'START', label: 'Start', bit: INPUT_BITS.START },
  { id: 'TURBO', label: 'Hold Fast-Forward (4x)', bit: 0 }
];

const DEFAULT_BINDINGS = {
  UP: ['KeyW', 'ArrowUp'],
  DOWN: ['KeyS', 'ArrowDown'],
  LEFT: ['KeyA', 'ArrowLeft'],
  RIGHT: ['KeyD', 'ArrowRight'],
  A: ['KeyZ', 'KeyJ'],
  B: ['KeyX', 'KeyK'],
  C: ['KeyC', 'KeyL'],
  X: ['KeyQ', 'KeyU'],
  Y: ['KeyE', 'KeyI'],
  Z: ['KeyR', 'KeyO'],
  SELECT: ['ShiftLeft', 'ShiftRight'],
  START: ['Enter', 'Space'],
  TURBO: ['Backquote', 'Tab']
};

export function formatKeyCode(code) {
  if (!code) return 'None';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const map = {
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', ControlLeft: 'L-Ctrl',
    ControlRight: 'R-Ctrl', AltLeft: 'L-Alt', AltRight: 'R-Alt',
    Space: 'Space', Enter: 'Enter', Backquote: '`', Tab: 'Tab',
    Backspace: 'Bksp', Semicolon: ';', Quote: "'", Comma: ',', Period: '.',
    Slash: '/', Backslash: '\\', BracketLeft: '[', BracketRight: ']'
  };
  return map[code] || code;
}

export function createKeyBindingsManager(state, ui) {
  let bindings = cloneDefaults();
  let codeToBit = new Map();
  let turboCodes = new Set();
  let listeningTarget = null;
  let modalEl = null;

  function cloneDefaults() {
    const out = {};
    for (const k of Object.keys(DEFAULT_BINDINGS)) {
      out[k] = DEFAULT_BINDINGS[k].slice();
    }
    return out;
  }

  function loadSavedBindings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      for (const act of ACTIONS) {
        if (Array.isArray(parsed[act.id]) && parsed[act.id].length >= 2) {
          bindings[act.id] = [
            String(parsed[act.id][0] || ''),
            String(parsed[act.id][1] || '')
          ];
        }
      }
    } catch {}
  }

  function saveBindings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(bindings));
    } catch {}
  }

  function rebuildLookupTables() {
    codeToBit = new Map();
    turboCodes = new Set();
    for (const act of ACTIONS) {
      const pair = bindings[act.id] || [];
      for (const code of pair) {
        if (!code) continue;
        if (act.id === 'TURBO') turboCodes.add(code);
        else if (act.bit) codeToBit.set(code, act.bit);
      }
    }
    updateLabelsAndHints();
    renderModalRows();
  }

  function updateLabelsAndHints() {
    const aKey = formatKeyCode(bindings.A[0]);
    const bKey = formatKeyCode(bindings.B[0]);
    const swapBtn = document.getElementById('swapAbBtn');
    if (swapBtn) {
      swapBtn.textContent = `A/B: ${aKey}/${bKey}`;
      swapBtn.classList.toggle('active-toggle', bindings.A[0] === 'KeyX');
    }
    const hintEl = document.getElementById('bezelKeyHint');
    if (hintEl) {
      const cKey = formatKeyCode(bindings.C ? bindings.C[0] : 'KeyC');
      const u = formatKeyCode(bindings.UP[0]);
      const l = formatKeyCode(bindings.LEFT[0]);
      const d = formatKeyCode(bindings.DOWN[0]);
      const r = formatKeyCode(bindings.RIGHT[0]);
      const sel = formatKeyCode(bindings.SELECT[0]);
      const sta = formatKeyCode(bindings.START[0]);
      const trb = formatKeyCode(bindings.TURBO[0]);
      hintEl.innerHTML =
        `Move: <span class="kbd">${u}${l}${d}${r}</span> ` +
        `A/B/C: <span class="kbd">${aKey}</span>/` +
        `<span class="kbd">${bKey}</span>/<span class="kbd">${cKey}</span> ` +
        `Sel/Sta: <span class="kbd">${sel}</span>/` +
        `<span class="kbd">${sta}</span> ` +
        `Turbo: <span class="kbd">${trb}</span> ` +
        `Save/Load: <span class="kbd">F6</span>/<span class="kbd">F8</span>`;
    }
  }

  function swapAbKeys() {
    const tmp = bindings.A.slice();
    bindings.A = bindings.B.slice();
    bindings.B = tmp;
    saveBindings();
    rebuildLookupTables();
    const aKey = formatKeyCode(bindings.A[0]);
    const bKey = formatKeyCode(bindings.B[0]);
    ui.showScreenBanner(`SWAPPED A/B: A=${aKey}, B=${bKey}`, 'ok', 2200);
    ui.logDebug(`Swapped A/B bindings -> A=${aKey}, B=${bKey}`);
  }

  function resetToDefaults() {
    bindings = cloneDefaults();
    listeningTarget = null;
    saveBindings();
    rebuildLookupTables();
    ui.showScreenBanner('KEY BINDINGS RESET TO DEFAULTS', 'ok', 2200);
  }

  function assignKeyToSlot(actionId, slotIdx, newCode) {
    for (const act of ACTIONS) {
      for (let i = 0; i < 2; i++) {
        if (bindings[act.id][i] === newCode) {
          bindings[act.id][i] = bindings[actionId][slotIdx];
        }
      }
    }
    bindings[actionId][slotIdx] = newCode;
    listeningTarget = null;
    saveBindings();
    rebuildLookupTables();
  }

  function buildModalIfNeeded() {
    if (modalEl) return;
    modalEl = document.createElement('div');
    modalEl.id = 'keyBindsModal';
    modalEl.className = 'keybinds-backdrop hidden';
    modalEl.innerHTML = `
      <div class="keybinds-card">
        <div class="keybinds-hdr">
          <span>CONTROLLER KEY BINDINGS</span>
          <button type="button" id="kbCloseBtn">Close (ESC)</button>
        </div>
        <div class="keybinds-sub">
          Click any key slot below, then press a keyboard key to bind it.
        </div>
        <div class="keybinds-list" id="kbRowsContainer"></div>
        <div class="keybinds-actions">
          <button type="button" id="kbSwapAbBtn">Swap A &lt;-&gt; B</button>
          <button type="button" id="kbResetBtn">Reset Defaults</button>
        </div>
      </div>`;
    document.body.appendChild(modalEl);

    modalEl.addEventListener('click', (e) => {
      if (e.target === modalEl) closeModal();
    });
    modalEl.querySelector('#kbCloseBtn').addEventListener('click', closeModal);
    modalEl.querySelector('#kbSwapAbBtn').addEventListener('click', swapAbKeys);
    modalEl.querySelector('#kbResetBtn').addEventListener(
      'click', resetToDefaults
    );
    renderModalRows();
  }

  function renderModalRows() {
    if (!modalEl) return;
    const container = modalEl.querySelector('#kbRowsContainer');
    if (!container) return;
    container.innerHTML = '';
    for (const act of ACTIONS) {
      const row = document.createElement('div');
      row.className = 'kb-row';
      const lbl = document.createElement('span');
      lbl.className = 'kb-label';
      lbl.textContent = act.label;
      const slotsWrap = document.createElement('div');
      slotsWrap.className = 'kb-slots';
      for (let s = 0; s < 2; s++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        const isListening =
          listeningTarget &&
          listeningTarget.actionId === act.id &&
          listeningTarget.slotIdx === s;
        btn.className = isListening ? 'kb-slot listening' : 'kb-slot';
        btn.textContent = isListening
          ? 'Press key...'
          : formatKeyCode(bindings[act.id][s]);
        btn.addEventListener('click', () => {
          listeningTarget = { actionId: act.id, slotIdx: s };
          renderModalRows();
        });
        slotsWrap.appendChild(btn);
      }
      row.appendChild(lbl);
      row.appendChild(slotsWrap);
      container.appendChild(row);
    }
  }

  function openModal() {
    buildModalIfNeeded();
    listeningTarget = null;
    renderModalRows();
    modalEl.classList.remove('hidden');
  }

  function closeModal() {
    listeningTarget = null;
    if (modalEl) modalEl.classList.add('hidden');
  }

  function handleModalKeydown(e) {
    if (!modalEl || modalEl.classList.contains('hidden')) return false;
    e.preventDefault();
    e.stopPropagation();
    if (e.code === 'Escape') {
      if (listeningTarget) {
        listeningTarget = null;
        renderModalRows();
      } else {
        closeModal();
      }
      return true;
    }
    if (listeningTarget) {
      assignKeyToSlot(
        listeningTarget.actionId,
        listeningTarget.slotIdx,
        e.code
      );
      return true;
    }
    return true;
  }

  loadSavedBindings();
  rebuildLookupTables();

  const swapBtn = document.getElementById('swapAbBtn');
  if (swapBtn) swapBtn.addEventListener('click', swapAbKeys);
  const keysBtn = document.getElementById('keysBtn');
  if (keysBtn) keysBtn.addEventListener('click', openModal);

  return {
    getBitForCode: (code) => codeToBit.get(code),
    isTurboHoldCode: (code) => turboCodes.has(code),
    handleModalKeydown,
    swapAbKeys,
    openModal,
    closeModal
  };
}
