import { MathfieldElement } from '/assets/mathlive/mathlive.min.mjs';

const MATHLIVE_ASSET_ROOT = '/assets/mathlive';

// Configure MathLive before any field is created. Assets stay local and its
// own keyboard/menu labels follow the page language.
MathfieldElement.fontsDirectory = `${MATHLIVE_ASSET_ROOT}/fonts`;
MathfieldElement.soundsDirectory = `${MATHLIVE_ASSET_ROOT}/sounds`;
MathfieldElement.locale = 'zh-cn';

function isEscaped(value, index) {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function findClosingDelimiter(value, start, delimiter) {
  for (let cursor = start; cursor < value.length; cursor += 1) {
    if (delimiter === '$' && value[cursor] === '\n') return -1;
    if (value[cursor] !== '$' || isEscaped(value, cursor)) continue;

    if (delimiter === '$$') {
      if (value[cursor + 1] === '$') return cursor;
      continue;
    }

    if (value[cursor - 1] !== '$' && value[cursor + 1] !== '$') return cursor;
  }
  return -1;
}

function formulaRanges(value) {
  const ranges = [];

  for (let cursor = 0; cursor < value.length; cursor += 1) {
    if (value[cursor] !== '$' || isEscaped(value, cursor)) continue;

    const delimiter = value[cursor + 1] === '$' ? '$$' : '$';
    const contentStart = cursor + delimiter.length;
    const closing = findClosingDelimiter(value, contentStart, delimiter);
    if (closing < 0) continue;

    ranges.push({
      start: cursor,
      end: closing + delimiter.length,
      contentStart,
      contentEnd: closing,
      latex: value.slice(contentStart, closing),
      mode: delimiter === '$$' ? 'block' : 'inline'
    });
    cursor = closing + delimiter.length - 1;
  }

  return ranges;
}

function formulaAtSelection(value, selectionStart, selectionEnd) {
  const ranges = formulaRanges(value);

  if (selectionStart === selectionEnd) {
    return ranges.find((range) => (
      selectionStart >= range.start && selectionStart <= range.end
    )) || null;
  }

  return ranges.find((range) => (
    selectionStart < range.end && selectionEnd > range.start
  )) || null;
}

function blockReplacement(value, start, end, latex) {
  const leadingBreak = start > 0 && value[start - 1] !== '\n' ? '\n' : '';
  const trailingBreak = end < value.length && value[end] !== '\n' ? '\n' : '';
  return `${leadingBreak}$$\n${latex}\n$$${trailingBreak}`;
}

function setupFormulaEditor(root) {
  const inputPane = root.closest('.editor__pane');
  const input = inputPane?.querySelector('[data-markdown-input]');
  const dialog = root.querySelector('[data-formula-dialog]');
  const fieldHost = root.querySelector('[data-formula-field-host]');
  const title = root.querySelector('[data-formula-title]');
  const status = root.querySelector('[data-formula-status]');
  const commitButton = root.querySelector('[data-formula-commit]');
  const modeButtons = [...root.querySelectorAll('[data-formula-mode]')];

  if (!input || !dialog || !fieldHost || !commitButton) return;

  let mathfield = null;
  let mode = 'inline';
  let editRange = { start: 0, end: 0 };
  let selectionBeforeOpen = { start: 0, end: 0 };
  let editingExistingFormula = false;

  function dialogFocusableElements() {
    return [...dialog.querySelectorAll(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), math-field, [tabindex]:not([tabindex="-1"])'
    )].filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
  }

  function handleDialogKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelEditing();
      return;
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      commitFormula();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = dialogFocusableElements();
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function ensureMathfield() {
    if (mathfield) return mathfield;
    mathfield = new MathfieldElement();
    mathfield.className = 'formula-field';
    mathfield.setAttribute('aria-label', '可视化公式输入框');
    mathfield.mathVirtualKeyboardPolicy = 'manual';
    mathfield.smartFence = true;
    mathfield.smartSuperscript = true;
    mathfield.placeholder = '\\text{在此输入公式}';
    mathfield.addEventListener('input', () => setStatus(''));
    fieldHost.replaceChildren(mathfield);
    // MathLive handles physical keys inside its open shadow root. Escape does
    // not cross that boundary, so listen at the shadow root as well as on the
    // surrounding dialog to preserve normal modal keyboard behaviour.
    mathfield.shadowRoot?.addEventListener('keydown', handleDialogKeydown, { capture: true });
    return mathfield;
  }

  function setStatus(message, isError = false) {
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('is-error', isError);
  }

  function setMode(nextMode) {
    mode = nextMode === 'block' ? 'block' : 'inline';
    modeButtons.forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.formulaMode === mode));
    });
  }

  function keyboard() {
    return window.mathVirtualKeyboard;
  }

  function syncKeyboardGeometry() {
    const virtualKeyboard = keyboard();
    const visible = Boolean(!dialog.hidden && virtualKeyboard?.visible);
    const height = visible ? Math.max(0, Math.ceil(virtualKeyboard.boundingRect?.height || 0)) : 0;
    dialog.classList.toggle('formula-dialog--keyboard-open', height > 0);
    dialog.style.setProperty('--formula-keyboard-height', `${height}px`);
  }

  function showKeyboard() {
    const virtualKeyboard = keyboard();
    if (!virtualKeyboard) return;
    // Keep the keyboard at document level so its own fixed layout spans the
    // viewport. The formula overlay deliberately sits just below it.
    virtualKeyboard.container = document.body;
    virtualKeyboard.show({ animate: false });
    window.requestAnimationFrame(syncKeyboardGeometry);
  }

  function hideKeyboard() {
    const virtualKeyboard = keyboard();
    if (virtualKeyboard?.visible) virtualKeyboard.hide({ animate: false });
    syncKeyboardGeometry();
  }

  function showDialog() {
    dialog.hidden = false;
    document.body.classList.add('formula-dialog-open');
  }

  function hideDialog() {
    hideKeyboard();
    dialog.hidden = true;
    if (!document.querySelector('[data-formula-dialog]:not([hidden])')) {
      document.body.classList.remove('formula-dialog-open');
    }
  }

  function restoreTextareaSelection(start = selectionBeforeOpen.start, end = selectionBeforeOpen.end) {
    input.focus();
    input.setSelectionRange(start, end);
  }

  function cancelEditing() {
    hideDialog();
    restoreTextareaSelection();
  }

  function openEditor(requestedMode) {
    const field = ensureMathfield();
    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? start;
    const existing = formulaAtSelection(input.value, start, end);
    const selectedText = input.value.slice(start, end);

    selectionBeforeOpen = { start, end };
    editingExistingFormula = Boolean(existing);
    editRange = existing
      ? { start: existing.start, end: existing.end }
      : { start, end };

    setMode(existing?.mode || requestedMode);
    field.setValue(existing ? existing.latex : selectedText, {
      silenceNotifications: true
    });
    field.executeCommand('moveToMathfieldEnd');

    if (title) {
      title.textContent = existing
        ? `编辑${mode === 'block' ? '独立' : '行内'}公式`
        : `插入${mode === 'block' ? '独立' : '行内'}公式`;
    }
    commitButton.textContent = existing ? '更新 Markdown 中的公式' : '插入到 Markdown';
    setStatus(existing ? '已载入光标所在的公式。' : (selectedText ? '已将选中内容载入公式编辑器。' : ''));
    showDialog();
    window.requestAnimationFrame(() => {
      field.focus();
      showKeyboard();
    });
  }

  function commitFormula() {
    const field = ensureMathfield();
    const latex = field.getValue('latex-without-placeholders').trim();
    if (!latex) {
      setStatus('请先输入公式内容。', true);
      field.focus();
      return;
    }

    const replacement = mode === 'block'
      ? blockReplacement(input.value, editRange.start, editRange.end, latex)
      : `$${latex}$`;
    const nextValue = input.value.slice(0, editRange.start)
      + replacement
      + input.value.slice(editRange.end);
    const maximumLength = input.maxLength > -1 ? input.maxLength : Number.POSITIVE_INFINITY;

    if (nextValue.length > maximumLength) {
      setStatus(`插入后会超过 ${maximumLength} 字符的讨论上限。`, true);
      return;
    }

    input.value = nextValue;
    const cursor = editRange.start + replacement.length;
    hideDialog();
    restoreTextareaSelection(cursor, cursor);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    editingExistingFormula = false;
  }

  root.querySelectorAll('[data-formula-open]').forEach((button) => {
    button.addEventListener('click', () => openEditor(button.dataset.formulaOpen));
  });

  modeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      setMode(button.dataset.formulaMode);
      if (title) {
        title.textContent = `${editingExistingFormula ? '编辑' : '插入'}${mode === 'block' ? '独立' : '行内'}公式`;
      }
      ensureMathfield().focus();
    });
  });

  root.querySelectorAll('[data-formula-cancel]').forEach((button) => {
    button.addEventListener('click', cancelEditing);
  });
  commitButton.addEventListener('click', commitFormula);

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    cancelEditing();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) cancelEditing();
  });
  dialog.addEventListener('keydown', handleDialogKeydown, { capture: true });
  keyboard()?.addEventListener('geometrychange', syncKeyboardGeometry);
  keyboard()?.addEventListener('virtual-keyboard-toggle', syncKeyboardGeometry);

  root.hidden = false;
}

document.querySelectorAll('[data-formula-editor]').forEach(setupFormulaEditor);
