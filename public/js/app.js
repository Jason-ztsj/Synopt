(() => {
  'use strict';

  const LICENSES = {
    cc0: {
      code: 'CC0 1.0',
      name: 'CC0 1.0 通用（公共领域贡献）',
      description: '你在法律允许的范围内尽可能放弃版权及相关权利。任何人都可以复制、修改、传播和使用，无需署名。',
      note: '同见仍会展示创作者名称，但作品使用者无需署名。',
      url: 'https://creativecommons.org/publicdomain/zero/1.0/deed.zh-hans'
    },
    by: {
      code: 'CC BY 4.0',
      name: '知识共享 署名 4.0 国际许可协议',
      description: '他人可以复制、传播、修改并将作品用于商业用途，但必须标明创作者。',
      note: '发布后，请在使用作品时保留创作者署名。',
      url: 'https://creativecommons.org/licenses/by/4.0/deed.zh-hans'
    },
    byNc: {
      code: 'CC BY-NC 4.0',
      name: '知识共享 署名—非商业性使用 4.0',
      description: '他人可以复制、传播和修改作品，但必须标明创作者，且不得用于商业目的。',
      note: '允许再创作，不允许商业使用。',
      url: 'https://creativecommons.org/licenses/by-nc/4.0/deed.zh-hans'
    },
    byNd: {
      code: 'CC BY-ND 4.0',
      name: '知识共享 署名—禁止演绎 4.0',
      description: '他人可以复制和传播原作，包括用于商业目的，但必须标明创作者且不得修改作品。',
      note: '允许商业使用，但只可原样分享。',
      url: 'https://creativecommons.org/licenses/by-nd/4.0/deed.zh-hans'
    },
    byNcNd: {
      code: 'CC BY-NC-ND 4.0',
      name: '知识共享 署名—非商业性使用—禁止演绎 4.0',
      description: '他人可以复制和传播原作，但必须标明创作者，不得用于商业目的，也不得修改作品。',
      note: '只允许非商业地原样分享，并须保留署名。',
      url: 'https://creativecommons.org/licenses/by-nc-nd/4.0/deed.zh-hans'
    }
  };

  function setupLicensePicker(picker) {
    const attribution = picker.querySelector('input[name="attribution"]');
    const nonCommercial = picker.querySelector('input[name="nonCommercial"]');
    const noDerivatives = picker.querySelector('input[name="noDerivatives"]');
    const code = picker.querySelector('[data-license-code]');
    const name = picker.querySelector('[data-license-name]');
    const description = picker.querySelector('[data-license-description]');
    const note = picker.querySelector('[data-license-note]');
    const link = picker.querySelector('[data-license-link]');

    if (!attribution || !nonCommercial || !noDerivatives) return;

    function updateLicense() {
      if (!attribution.checked) {
        nonCommercial.checked = false;
        noDerivatives.checked = false;
      }

      nonCommercial.disabled = !attribution.checked;
      noDerivatives.disabled = !attribution.checked;

      let selected;
      if (!attribution.checked) selected = LICENSES.cc0;
      else if (nonCommercial.checked && noDerivatives.checked) selected = LICENSES.byNcNd;
      else if (nonCommercial.checked) selected = LICENSES.byNc;
      else if (noDerivatives.checked) selected = LICENSES.byNd;
      else selected = LICENSES.by;

      if (code) code.textContent = selected.code;
      if (name) name.textContent = selected.name;
      if (description) description.textContent = selected.description;
      if (note) note.textContent = selected.note;
      if (link) link.href = selected.url;
    }

    [attribution, nonCommercial, noDerivatives].forEach((input) => {
      input.addEventListener('change', updateLicense);
    });

    updateLicense();
  }

  function setupMarkdownEditor(editor) {
    const input = editor.querySelector('[data-markdown-input]');
    const preview = editor.querySelector('[data-markdown-preview]');
    const status = editor.querySelector('[data-preview-status]');
    const endpoint = editor.dataset.previewEndpoint || '/api/markdown-preview';
    let debounceTimer;
    let activeController;
    let requestSequence = 0;

    if (!input || !preview) return;

    function setStatus(message, className = '') {
      if (!status) return;
      status.textContent = message;
      status.classList.toggle('is-loading', className === 'is-loading');
      status.classList.toggle('is-error', className === 'is-error');
    }

    async function renderPreview() {
      const body = input.value;
      const sequence = ++requestSequence;

      if (!body.trim()) {
        activeController?.abort();
        preview.innerHTML = '<p class="editor__placeholder">你的格式化内容会显示在这里。</p>';
        preview.removeAttribute('aria-busy');
        setStatus('等待输入');
        return;
      }

      activeController?.abort();
      activeController = new AbortController();
      preview.setAttribute('aria-busy', 'true');
      setStatus('正在生成…', 'is-loading');

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Accept': 'application/json, text/html',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ body }),
          signal: activeController.signal
        });

        const contentType = response.headers.get('content-type') || '';
        const payload = contentType.includes('application/json')
          ? await response.json()
          : { html: await response.text() };

        if (!response.ok) {
          throw new Error(payload.message || payload.error || '预览请求失败');
        }

        if (sequence !== requestSequence) return;
        const html = payload.html ?? payload.renderedHtml ?? payload.rendered ?? '';
        preview.innerHTML = html || '<p class="editor__placeholder">没有可预览的内容。</p>';
        setStatus('预览已更新');
      } catch (error) {
        if (error.name === 'AbortError') return;
        if (sequence !== requestSequence) return;
        setStatus('预览暂不可用', 'is-error');
      } finally {
        if (sequence === requestSequence) preview.removeAttribute('aria-busy');
      }
    }

    input.addEventListener('input', () => {
      window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(renderPreview, 150);
    });

    if (input.value.trim()) renderPreview();
  }

  function parseRetryAfter(value) {
    if (!value) return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
    const date = Date.parse(value);
    if (Number.isNaN(date)) return 0;
    return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  }

  function setupDiscussionForm(form) {
    const button = form.querySelector('[data-discussion-submit]');
    const status = form.querySelector('[data-discussion-status]');
    const input = form.querySelector('[name="body"]');
    const originalButtonHtml = button?.innerHTML || '发布讨论';
    let cooldownTimer;

    function setFormStatus(message, isError = false) {
      if (!status) return;
      status.textContent = message;
      status.classList.toggle('is-error', isError);
    }

    function beginCooldown(seconds) {
      let remaining = Math.max(1, Math.ceil(seconds || 1));
      window.clearInterval(cooldownTimer);
      if (button) button.disabled = true;
      setFormStatus(`发送过于频繁，请 ${remaining} 秒后再试。`, true);

      const update = () => {
        if (button) button.textContent = `请等待 ${remaining} 秒`;
        remaining -= 1;

        if (remaining < 0) {
          window.clearInterval(cooldownTimer);
          if (button) {
            button.disabled = false;
            button.innerHTML = originalButtonHtml;
          }
          setFormStatus('现在可以再次发布。');
        }
      };

      update();
      cooldownTimer = window.setInterval(update, 1000);
    }

    form.addEventListener('submit', async (event) => {
      if (!window.fetch || !form.checkValidity()) return;
      event.preventDefault();

      if (button) button.disabled = true;
      setFormStatus('正在发布回应……');

      try {
        const response = await fetch(form.action, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
          },
          body: new URLSearchParams(new FormData(form)).toString()
        });

        const contentType = response.headers.get('content-type') || '';
        let payload = {};
        if (contentType.includes('application/json')) {
          payload = await response.json().catch(() => ({}));
        }

        if (response.status === 429) {
          const retryAfter = parseRetryAfter(response.headers.get('retry-after'))
            || Number(payload.retryAfterSeconds || payload.retryAfter || payload.remainingSeconds)
            || 30;
          beginCooldown(retryAfter);
          return;
        }

        if (!response.ok) {
          throw new Error(payload.message || payload.error || '发布失败，请检查内容后重试。');
        }

        if (input) input.value = '';
        setFormStatus('发布成功，正在刷新讨论……');
        window.setTimeout(() => window.location.reload(), 250);
      } catch (error) {
        if (button) {
          button.disabled = false;
          button.innerHTML = originalButtonHtml;
        }
        setFormStatus(error.message || '网络连接失败，请稍后重试。', true);
      }
    });
  }

  function setupValidationWatch(panel) {
    const endpoint = panel.dataset.statusUrl;
    const label = panel.querySelector('[data-validation-label]');
    let stopped = !endpoint || !['pending', 'validating', 'validation_failed'].includes(panel.dataset.currentStatus);
    let timer;

    async function poll() {
      if (stopped || document.visibilityState === 'hidden') return;
      try {
        const response = await fetch(endpoint, {
          headers: { Accept: 'application/json' },
          cache: 'no-store'
        });
        if (response.status === 401 || response.status === 404) {
          stopped = true;
          return;
        }
        if (!response.ok) throw new Error('validation status unavailable');
        const result = await response.json();
        if (label && result.label) label.textContent = result.label;
        if (result.status && result.status !== panel.dataset.currentStatus) {
          panel.dataset.currentStatus = result.status;
          if (result.ready || result.terminal) {
            stopped = true;
            window.location.reload();
            return;
          }
        }
      } catch {
        // A transient network failure must not change the media's validation state.
      }
      if (!stopped) timer = window.setTimeout(poll, 1500);
    }

    const resume = () => {
      if (!stopped && document.visibilityState === 'visible') {
        window.clearTimeout(timer);
        timer = window.setTimeout(poll, 150);
      }
    };
    document.addEventListener('visibilitychange', resume);
    timer = window.setTimeout(poll, 750);
  }

  function setupSidebar() {
    const toggle = document.querySelector('[data-sidebar-toggle]');
    const scrim = document.querySelector('[data-sidebar-scrim]');
    if (!toggle) return;
    const setOpen = (open) => {
      document.body.classList.toggle('sidebar-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      if (scrim) scrim.hidden = !open;
    };
    toggle.addEventListener('click', () => setOpen(!document.body.classList.contains('sidebar-open')));
    scrim?.addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') setOpen(false);
    });
  }

  function setupVoteForm(form) {
    form.addEventListener('submit', async (event) => {
      if (!window.fetch) return;
      event.preventDefault();
      const button = form.querySelector('button');
      if (!button) return;
      button.disabled = true;
      try {
        const response = await fetch(form.action, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
          },
          body: new URLSearchParams(new FormData(form)).toString()
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || '投票失败');
        const group = form.closest('.reaction-group, .discussion-actions') || form.parentElement;
        group?.querySelectorAll('[data-upvotes]').forEach((node) => { node.textContent = String(result.upvotes); });
        group?.querySelectorAll('[data-downvotes]').forEach((node) => { node.textContent = String(result.downvotes); });
        group?.querySelectorAll('[data-vote-form]').forEach((voteForm) => {
          const voteButton = voteForm.querySelector('button[type="submit"]');
          const voteInput = voteForm.querySelector('input[name="value"]');
          if (!voteButton || !voteInput) return;
          const isUp = voteForm.dataset.voteKind === 'up';
          const active = isUp ? result.viewerVote === 1 : result.viewerVote === -1;
          voteButton.classList.toggle('is-active', active);
          voteButton.classList.toggle('is-negative', active && !isUp);
          voteInput.value = active ? '0' : (isUp ? '1' : '-1');
        });
      } catch {
        form.submit();
        return;
      } finally {
        button.disabled = false;
      }
    });
  }

  function openLinkedDiscussion() {
    if (!location.hash.startsWith('#discussion-')) return;
    const target = document.querySelector(location.hash);
    if (!target) return;
    let parent = target;
    while (parent) {
      if (parent.matches?.('[data-discussion-details]')) parent.open = true;
      parent = parent.parentElement;
    }
  }

  function setupReplyComposer(button) {
    const panelId = button.getAttribute('aria-controls');
    const panel = panelId ? document.getElementById(panelId) : null;
    const closeButton = panel?.querySelector('[data-reply-close]');
    if (!panel) return;

    function setOpen(open, { focus = true } = {}) {
      if (open) {
        document.querySelectorAll('[data-reply-composer]:not([hidden])').forEach((otherPanel) => {
          if (otherPanel === panel) return;
          otherPanel.hidden = true;
          const otherButton = document.querySelector(`[aria-controls="${CSS.escape(otherPanel.id)}"]`);
          otherButton?.setAttribute('aria-expanded', 'false');
          if (otherButton) otherButton.textContent = '回复';
        });
      }

      panel.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
      button.textContent = open ? '取消回复' : '回复';
      if (open && focus) panel.querySelector('input[name="title"], textarea[name="body"]')?.focus();
    }

    button.addEventListener('click', () => setOpen(panel.hidden));
    closeButton?.addEventListener('click', () => {
      setOpen(false, { focus: false });
      button.focus();
    });
  }

  function setupCoverPicker() {
    document.querySelectorAll('.cover-upload input[type="file"]').forEach((input) => {
      input.addEventListener('change', () => {
        const button = input.closest('.cover-upload')?.querySelector('.button');
        if (button) button.textContent = input.files?.[0]?.name || '选择图片';
      });
    });
  }

  document.querySelectorAll('[data-license-picker]').forEach(setupLicensePicker);
  document.querySelectorAll('[data-markdown-editor]').forEach(setupMarkdownEditor);
  document.querySelectorAll('[data-discussion-form]').forEach(setupDiscussionForm);
  document.querySelectorAll('[data-validation-watch]').forEach(setupValidationWatch);
  document.querySelectorAll('[data-vote-form]').forEach(setupVoteForm);
  document.querySelectorAll('[data-reply-toggle]').forEach(setupReplyComposer);
  setupSidebar();
  setupCoverPicker();
  openLinkedDiscussion();
})();
