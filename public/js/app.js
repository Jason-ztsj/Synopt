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

  function formatFileSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 1) return '0 B';
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MiB`;
  }

  function setupFilePicker(input) {
    const drop = input.closest('[data-file-drop]');
    const title = drop?.querySelector('[data-file-title]');
    const detail = drop?.querySelector('[data-file-detail]');
    const defaultTitle = title?.textContent || '';
    const defaultDetail = detail?.textContent || '';

    function showSelectedFile() {
      const file = input.files?.[0];
      input.setCustomValidity('');

      if (!file) {
        if (title) title.textContent = defaultTitle;
        if (detail) detail.textContent = defaultDetail;
        return;
      }

      const isMp4Name = file.name.toLowerCase().endsWith('.mp4');
      if (!isMp4Name) {
        input.setCustomValidity('请选择扩展名为 .mp4 的视频文件。');
        input.reportValidity();
      }

      if (title) title.textContent = file.name;
      if (detail) detail.textContent = `${formatFileSize(file.size)} · ${isMp4Name ? 'MP4 已选择' : '文件格式不正确'}`;
    }

    input.addEventListener('change', showSelectedFile);

    if (drop) {
      ['dragenter', 'dragover'].forEach((eventName) => {
        drop.addEventListener(eventName, () => drop.classList.add('is-dragging'));
      });
      ['dragleave', 'drop'].forEach((eventName) => {
        drop.addEventListener(eventName, () => drop.classList.remove('is-dragging'));
      });
    }
  }

  function setupUploadForm(form) {
    const button = form.querySelector('[data-submit-button]');
    const status = form.querySelector('[data-upload-status]');

    form.addEventListener('submit', () => {
      if (!form.checkValidity()) return;
      if (status) {
        status.classList.remove('is-error');
        status.textContent = '正在上传并校验视频，请不要关闭这个页面……';
      }
      window.setTimeout(() => {
        if (button) {
          button.disabled = true;
          button.textContent = '正在发布…';
        }
      }, 0);
    });
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

  document.querySelectorAll('[data-license-picker]').forEach(setupLicensePicker);
  document.querySelectorAll('[data-file-input]').forEach(setupFilePicker);
  document.querySelectorAll('[data-upload-form]').forEach(setupUploadForm);
  document.querySelectorAll('[data-markdown-editor]').forEach(setupMarkdownEditor);
  document.querySelectorAll('[data-discussion-form]').forEach(setupDiscussionForm);
})();
