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

    if (input.value.trim()) {
      const disclosure = editor.closest('details');
      if (disclosure && !disclosure.open) {
        const renderWhenOpened = () => {
          if (!disclosure.open) return;
          disclosure.removeEventListener('toggle', renderWhenOpened);
          renderPreview();
        };
        disclosure.addEventListener('toggle', renderWhenOpened);
      } else {
        renderPreview();
      }
    }
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
    const pendingLabel = form.dataset.submitPendingLabel || '正在发布回应……';
    const successLabel = form.dataset.submitSuccessLabel || '发布成功，正在刷新讨论……';
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
      setFormStatus(pendingLabel);

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
        setFormStatus(successLabel);
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

  function setupAccountMenu(menu) {
    const toggle = menu.querySelector('[data-account-menu-toggle]');
    const panel = menu.querySelector('[data-account-menu-panel]');
    if (!toggle || !panel) return;

    const menuItems = () => Array.from(panel.querySelectorAll('[role="menuitem"]')).filter((item) => !item.disabled && !item.hidden);

    function setOpen(open, { focus = false, focusLast = false } = {}) {
      panel.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      if (open && focus) {
        const items = menuItems();
        (focusLast ? items.at(-1) : items[0])?.focus();
      }
    }

    toggle.addEventListener('click', () => setOpen(panel.hidden));
    toggle.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      setOpen(true, { focus: true, focusLast: event.key === 'ArrowUp' || event.key === 'End' });
    });

    panel.addEventListener('keydown', (event) => {
      const items = menuItems();
      const currentIndex = items.indexOf(document.activeElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        toggle.focus();
        return;
      }
      if (event.key === 'Tab') {
        window.setTimeout(() => {
          if (!menu.contains(document.activeElement)) setOpen(false);
        });
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      let nextIndex;
      if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = items.length - 1;
      else if (event.key === 'ArrowDown') nextIndex = (currentIndex + 1 + items.length) % items.length;
      else nextIndex = (currentIndex - 1 + items.length) % items.length;
      items[nextIndex]?.focus();
    });

    panel.addEventListener('click', (event) => {
      if (event.target.closest('a[role="menuitem"]')) setOpen(false);
    });

    document.addEventListener('pointerdown', (event) => {
      if (!menu.contains(event.target)) setOpen(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !panel.hidden) {
        setOpen(false);
        toggle.focus();
      }
    });
  }

  function setupConfirmationForm(form) {
    form.addEventListener('submit', (event) => {
      const message = form.dataset.confirmMessage;
      if (message && !window.confirm(message)) event.preventDefault();
    });
  }

  function setupTypedConfirmation(form) {
    const expected = form.dataset.confirmValue || '';
    const input = form.querySelector('[data-confirmation-input]');
    const requiredCheck = form.querySelector('[data-confirmation-check]');
    const submit = form.querySelector('[data-danger-submit]');
    const status = form.querySelector('[data-confirmation-status]');
    if (!input || !submit) return;

    function update() {
      const textMatches = input.value === expected;
      const checked = !requiredCheck || requiredCheck.checked;
      submit.disabled = !(textMatches && checked);
      if (!input.value) {
        if (status) status.textContent = '';
      } else if (!textMatches) {
        if (status) status.textContent = '输入的内容与确认文字不一致。';
        status?.classList.add('is-error');
      } else if (!checked) {
        if (status) status.textContent = '请勾选不可恢复确认。';
        status?.classList.add('is-error');
      } else {
        if (status) status.textContent = '确认文字已匹配。';
        status?.classList.remove('is-error');
      }
    }

    input.addEventListener('input', update);
    requiredCheck?.addEventListener('change', update);
    update();
  }

  function setupAvatarForm(form) {
    const input = form.querySelector('[data-avatar-input]');
    const preview = form.querySelector('[data-avatar-preview]');
    const label = form.querySelector('[data-avatar-file-label]');
    const status = form.querySelector('[data-avatar-status]');
    if (!input) return;
    let selectionSequence = 0;

    function setStatus(message, isError = false) {
      if (!status) return;
      status.textContent = message;
      status.classList.toggle('is-error', isError);
    }

    function rejectFile(message) {
      input.value = '';
      if (label) label.textContent = '选择图片';
      setStatus(message, true);
    }

    input.addEventListener('change', () => {
      const sequence = ++selectionSequence;
      const file = input.files?.[0];
      if (!file) {
        if (label) label.textContent = '选择图片';
        setStatus('');
        return;
      }
      const extensionLooksSupported = /\.(?:jpe?g|png|webp)$/i.test(file.name || '');
      if (file.type && !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) && !extensionLooksSupported) {
        rejectFile('头像必须是 JPEG、PNG 或 WebP 图片。');
        return;
      }
      if (file.size > 2 * 1024 * 1024) {
        rejectFile('头像不能超过 2 MiB。');
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        if (sequence !== selectionSequence || typeof reader.result !== 'string') return;
        const image = new Image();
        image.onload = () => {
          if (sequence !== selectionSequence) return;
          if (image.naturalWidth !== image.naturalHeight) {
            rejectFile('头像必须为正方形。');
            return;
          }
          if (image.naturalWidth < 128 || image.naturalWidth > 1024) {
            rejectFile('头像尺寸必须在 128×128 至 1024×1024 像素之间。');
            return;
          }
          if (preview) {
            const previewImage = document.createElement('img');
            previewImage.src = reader.result;
            previewImage.alt = '';
            preview.replaceChildren(previewImage);
          }
          if (label) label.textContent = file.name;
          setStatus(`已选择 ${image.naturalWidth}×${image.naturalHeight} 像素图片，保存后生效。`);
        };
        image.onerror = () => {
          if (sequence === selectionSequence) rejectFile('无法读取这张图片，请重新选择。');
        };
        image.src = reader.result;
      };
      reader.onerror = () => {
        if (sequence === selectionSequence) rejectFile('无法读取这张图片，请重新选择。');
      };
      reader.readAsDataURL(file);
    });
  }

  const BROWSER_NOTIFICATION_KEY = 'tongjian:browser-notifications';
  const BROWSER_NOTIFICATION_FAILURE_KEY = 'tongjian:browser-notification-failure';

  function readLocalSetting(key, fallback = '') {
    try {
      return window.localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  }

  function writeLocalSetting(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  function setupBrowserNotificationSettings(panel) {
    const button = panel.querySelector('[data-browser-notification-button]');
    const status = panel.querySelector('[data-browser-notification-status]');
    if (!button || !status) return;

    function render() {
      if (!window.isSecureContext || !('Notification' in window)) {
        button.disabled = true;
        button.textContent = '当前环境不可用';
        status.textContent = window.isSecureContext
          ? '当前浏览器不支持系统通知。'
          : '局域网 HTTP 地址不是安全上下文；请使用 HTTPS 后再启用。';
        return;
      }
      button.disabled = false;
      const locallyEnabled = readLocalSetting(BROWSER_NOTIFICATION_KEY) === 'enabled';
      const displayFailure = readLocalSetting(BROWSER_NOTIFICATION_FAILURE_KEY);
      if (Notification.permission === 'denied') {
        button.disabled = true;
        button.textContent = '已被浏览器拒绝';
        status.textContent = '请在浏览器的站点设置中重新允许通知。';
      } else if (Notification.permission === 'granted' && locallyEnabled) {
        button.textContent = '停用浏览器通知';
        status.textContent = '已启用；仅在同见页面打开期间显示。';
      } else {
        button.textContent = '启用浏览器通知';
        status.textContent = displayFailure === 'constructor-unavailable'
          ? '当前浏览器虽已授权，但不支持由打开的网页直接显示系统通知；此设备已自动停用。'
          : Notification.permission === 'granted'
          ? '浏览器已授权，但这台设备上的同见通知已停用。'
          : '点击后浏览器才会请求通知权限。';
      }
    }

    button.addEventListener('click', async () => {
      if (!window.isSecureContext || !('Notification' in window)) return;
      const locallyEnabled = readLocalSetting(BROWSER_NOTIFICATION_KEY) === 'enabled';
      if (Notification.permission === 'granted' && locallyEnabled) {
        writeLocalSetting(BROWSER_NOTIFICATION_KEY, 'disabled');
      } else {
        writeLocalSetting(BROWSER_NOTIFICATION_FAILURE_KEY, '');
        const permission = Notification.permission === 'default'
          ? await Notification.requestPermission()
          : Notification.permission;
        if (permission === 'granted') writeLocalSetting(BROWSER_NOTIFICATION_KEY, 'enabled');
      }
      window.dispatchEvent(new CustomEvent('tongjian:browser-notification-setting'));
      render();
    });

    window.addEventListener('tongjian:browser-notification-setting', render);
    window.addEventListener('storage', (event) => {
      if ([BROWSER_NOTIFICATION_KEY, BROWSER_NOTIFICATION_FAILURE_KEY].includes(event.key)) render();
    });
    render();
  }

  function setupNotificationPoller(poller) {
    const endpoint = poller.dataset.notificationEndpoint;
    if (!endpoint || !window.fetch) return;
    const tabId = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    const seenKey = 'tongjian:notification-fingerprints';
    const leaseKey = 'tongjian:notification-display-lease';
    const channel = 'BroadcastChannel' in window ? new BroadcastChannel('tongjian:notifications') : null;
    let timer;
    let stopped = false;
    let initialPoll = true;
    let fingerprints;
    try {
      const parsed = JSON.parse(readLocalSetting(seenKey, '[]'));
      fingerprints = new Set(Array.isArray(parsed) ? parsed.slice(-120) : []);
    } catch {
      fingerprints = new Set();
    }

    channel?.addEventListener('message', (event) => {
      if (event.data?.type === 'shown' && event.data.fingerprint) fingerprints.add(event.data.fingerprint);
    });

    function updateUnreadCount(value) {
      const count = Math.max(0, Number(value) || 0);
      document.querySelectorAll('[data-notification-count]').forEach((node) => {
        node.textContent = count > 99 ? '99+' : String(count);
        node.hidden = count === 0;
        node.setAttribute('aria-label', `${count} 条未读通知`);
      });
      document.querySelectorAll('[data-notification-count-text]').forEach((node) => {
        node.textContent = String(count);
      });
    }

    function notificationFingerprint(item) {
      const count = Number(item.count ?? item.eventCount ?? item.event_count ?? 1) || 1;
      const updatedAt = item.updatedAt || item.updated_at || item.createdAt || item.created_at || '';
      return `${item.id}:${count}:${updatedAt}`;
    }

    function claimDisplayLease() {
      const now = Date.now();
      try {
        const current = JSON.parse(readLocalSetting(leaseKey, '{}'));
        if (current.owner && current.owner !== tabId && Number(current.expiresAt) > now) return false;
        if (!writeLocalSetting(leaseKey, JSON.stringify({ owner: tabId, expiresAt: now + 15000 }))) {
          return true;
        }
        const claimed = JSON.parse(readLocalSetting(leaseKey, '{}'));
        return claimed.owner === tabId;
      } catch {
        return true;
      }
    }

    function releaseDisplayLease() {
      try {
        const current = JSON.parse(readLocalSetting(leaseKey, '{}'));
        if (current.owner === tabId) {
          writeLocalSetting(leaseKey, JSON.stringify({ owner: tabId, expiresAt: 0 }));
        }
      } catch {
        // A malformed or unavailable local store cannot keep a valid lease.
      }
    }

    function remember(fingerprint) {
      fingerprints.add(fingerprint);
      const recent = Array.from(fingerprints).slice(-120);
      writeLocalSetting(seenKey, JSON.stringify(recent));
      channel?.postMessage({ type: 'shown', fingerprint });
    }

    function baselineNotifications(items) {
      let changed = false;
      items.forEach((item) => {
        if (!item || item.id == null) return;
        const fingerprint = notificationFingerprint(item);
        if (fingerprints.has(fingerprint)) return;
        fingerprints.add(fingerprint);
        changed = true;
      });
      if (changed) writeLocalSetting(seenKey, JSON.stringify(Array.from(fingerprints).slice(-120)));
    }

    function showBrowserNotifications(items) {
      if (!window.isSecureContext || !('Notification' in window) || Notification.permission !== 'granted'
        || readLocalSetting(BROWSER_NOTIFICATION_KEY) !== 'enabled') {
        baselineNotifications(items);
        return;
      }
      const unseenItems = items.filter((item) => {
        if (!item || item.id == null || item.readAt || item.read_at || item.isRead || item.is_read) return false;
        return !fingerprints.has(notificationFingerprint(item));
      });
      if (unseenItems.length === 0) return;
      if (!claimDisplayLease()) return;
      let displayed = 0;
      let constructorFailed = false;
      unseenItems.forEach((item) => {
        const fingerprint = notificationFingerprint(item);
        try {
          const notification = new Notification(item.title || '同见新通知', {
            body: item.summary || item.body || item.message || '',
            tag: `tongjian-${item.id}`,
            renotify: true
          });
          // Some mobile browsers expose Notification and permission APIs but
          // still reject the page-level constructor. Only mark the event as
          // shown after a notification was actually created.
          remember(fingerprint);
          displayed += 1;
          const link = item.link || item.url || item.targetUrl || item.target_url;
          if (link) notification.onclick = () => {
            window.focus();
            window.location.assign(link);
            notification.close();
          };
        } catch {
          // Notification support can still be restricted by an OS-level policy.
          constructorFailed = true;
        }
      });
      if (constructorFailed && displayed === 0) {
        releaseDisplayLease();
        writeLocalSetting(BROWSER_NOTIFICATION_KEY, 'disabled');
        writeLocalSetting(BROWSER_NOTIFICATION_FAILURE_KEY, 'constructor-unavailable');
        window.dispatchEvent(new CustomEvent('tongjian:browser-notification-setting'));
      }
    }

    async function poll() {
      if (stopped) return;
      try {
        const response = await fetch(endpoint, { headers: { Accept: 'application/json' }, cache: 'no-store' });
        if (response.status === 401 || response.status === 403) {
          stopped = true;
          return;
        }
        if (!response.ok) throw new Error('notification poll unavailable');
        const payload = await response.json();
        updateUnreadCount(payload.unreadCount ?? payload.unread_count ?? payload.count ?? 0);
        const items = payload.notifications || payload.newNotifications || payload.new_notifications || payload.items || [];
        if (Array.isArray(items)) {
          if (initialPoll) baselineNotifications(items);
          else showBrowserNotifications(items);
        }
        initialPoll = false;
      } catch {
        // The account pages remain usable during a transient polling failure.
      }
      if (!stopped) timer = window.setTimeout(poll, 30000);
    }

    document.addEventListener('visibilitychange', () => {
      if (!stopped && document.visibilityState === 'visible') {
        window.clearTimeout(timer);
        timer = window.setTimeout(poll, 200);
      }
    });
    window.addEventListener('pagehide', () => {
      window.clearTimeout(timer);
      channel?.close();
    }, { once: true });
    timer = window.setTimeout(poll, 500);
  }

  document.querySelectorAll('[data-license-picker]').forEach(setupLicensePicker);
  document.querySelectorAll('[data-markdown-editor]').forEach(setupMarkdownEditor);
  document.querySelectorAll('[data-discussion-form]').forEach(setupDiscussionForm);
  document.querySelectorAll('[data-validation-watch]').forEach(setupValidationWatch);
  document.querySelectorAll('[data-vote-form]').forEach(setupVoteForm);

  function setupValuePicker(group) {
    const videoId = group.dataset.videoId;
    const csrf = group.dataset.csrf;
    const opts = Array.from(group.querySelectorAll('[data-tier]'));
    const count = {
      high: group.querySelector('[data-value-high]'),
      medium: group.querySelector('[data-value-medium]'),
      low: group.querySelector('[data-value-low]'),
      recommend: group.querySelector('[data-recommend]')
    };
    let pendingTier = 0;
    const hoverCapable = window.matchMedia && window.matchMedia('(hover: hover)').matches;

    const refresh = (state) => {
      if (count.high) count.high.textContent = String(state.high);
      if (count.medium) count.medium.textContent = String(state.medium);
      if (count.low) count.low.textContent = String(state.low);
      if (count.recommend) count.recommend.textContent = `${state.recommend}%`;
      opts.forEach((btn) => btn.classList.toggle('is-active', Number(btn.dataset.tier) === state.viewerTier));
      group.dataset.viewerTier = String(state.viewerTier);
    };

    const current = () => ({
      high: Number(group.dataset.high || 0),
      medium: Number(group.dataset.medium || 0),
      low: Number(group.dataset.low || 0),
      recommend: Number(group.dataset.recommend || 0),
      viewerTier: Number(group.dataset.viewerTier || 0)
    });

    refresh(current());

    async function vote(tier) {
      try {
        const response = await fetch(`/videos/${videoId}/vote`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body: new URLSearchParams({ _csrf: csrf, value: String(tier) }).toString()
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.error || '评价失败');
        group.dataset.high = String(result.valueHighCount);
        group.dataset.medium = String(result.valueMediumCount);
        group.dataset.low = String(result.valueLowCount);
        group.dataset.recommend = String(result.recommendationPercent);
        refresh({ high: result.valueHighCount, medium: result.valueMediumCount, low: result.valueLowCount, recommend: result.recommendationPercent, viewerTier: result.viewerValueTier });
        pendingTier = 0;
        group.classList.remove('revealed');
      } catch (error) {
        if (count.recommend) count.recommend.textContent = error.message || '评价失败';
      }
    }

    opts.forEach((btn) => {
      const tier = Number(btn.dataset.tier);
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        if (!hoverCapable && !group.classList.contains('revealed')) {
          group.classList.add('revealed');
          pendingTier = tier;
          opts.forEach((b) => b.classList.toggle('is-confirm', Number(b.dataset.tier) === pendingTier));
          return;
        }
        const active = tier === Number(group.dataset.viewerTier || 0);
        vote(active ? 0 : tier);
      });
    });
  }

  document.querySelectorAll('[data-value-picker]').forEach(setupValuePicker);
  document.querySelectorAll('[data-reply-toggle]').forEach(setupReplyComposer);
  document.querySelectorAll('[data-account-menu]').forEach(setupAccountMenu);
  document.querySelectorAll('[data-confirm-message]').forEach(setupConfirmationForm);
  document.querySelectorAll('[data-typed-confirmation]').forEach(setupTypedConfirmation);
  document.querySelectorAll('[data-avatar-form]').forEach(setupAvatarForm);
  document.querySelectorAll('[data-browser-notification-settings]').forEach(setupBrowserNotificationSettings);
  document.querySelectorAll('[data-notification-poller]').forEach(setupNotificationPoller);
  setupSidebar();
  setupCoverPicker();
  openLinkedDiscussion();
})();
