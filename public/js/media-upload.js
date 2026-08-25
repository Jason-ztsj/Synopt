const form = globalThis.document?.querySelector('[data-upload-form]');

if (form) {
  const input = form.querySelector('[data-file-input]');
  const drop = form.querySelector('[data-file-drop]');
  const title = form.querySelector('[data-file-title]');
  const detail = form.querySelector('[data-file-detail]');
  const analysis = form.querySelector('[data-media-analysis]');
  const analysisTitle = form.querySelector('[data-media-analysis-title]');
  const analysisDetail = form.querySelector('[data-media-analysis-detail]');
  const button = form.querySelector('[data-submit-button]');
  const status = form.querySelector('[data-upload-status]');
  const maxUploadBytes = Number(form.dataset.maxUploadBytes || 0);
  const defaultTitle = title?.textContent || '';
  const defaultDetail = detail?.textContent || '';
  const originalButtonHtml = button?.innerHTML || '确认并发布';
  const requests = new Map();
  let worker = null;
  let requestNumber = 0;
  let selectionNumber = 0;
  let selected = null;
  let submitting = false;
  let inspectionController = null;
  let submissionController = null;

  function abortError() {
    const error = new Error('媒体处理已取消。');
    error.name = 'AbortError';
    error.code = 'MEDIA_JOB_CANCELED';
    return error;
  }

  function failWorker(instance, event) {
    event?.preventDefault?.();
    const error = new Error(event?.message || '媒体处理线程意外停止。');
    for (const [id, pending] of requests) {
      if (pending.worker !== instance) continue;
      requests.delete(id);
      pending.cleanup();
      pending.reject(error);
    }
    instance.terminate();
    if (worker === instance) worker = null;
  }

  function ensureWorker() {
    if (worker) return worker;
    const instance = new Worker('/static/js/media-worker.js', { type: 'module' });
    instance.addEventListener('message', (event) => {
      const message = event.data ?? {};
      const pending = requests.get(message.id);
      if (!pending || pending.worker !== instance) return;
      if (message.type === 'progress') {
        pending.onProgress?.(message.progress);
        return;
      }
      requests.delete(message.id);
      pending.cleanup();
      if (message.type === 'result') pending.resolve(message.result);
      else pending.reject(Object.assign(new Error(message.error || '媒体处理失败'), { code: message.code }));
    });
    instance.addEventListener('error', (event) => failWorker(instance, event));
    instance.addEventListener('messageerror', (event) => failWorker(instance, event));
    worker = instance;
    return instance;
  }

  function askWorker(type, file, options = {}) {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(abortError());
        return;
      }
      const id = `media-${++requestNumber}`;
      let instance;
      try {
        instance = ensureWorker();
      } catch (error) {
        reject(error);
        return;
      }
      const onAbort = () => {
        if (!requests.delete(id)) return;
        cleanup();
        try {
          instance.postMessage({ id, type: 'cancel' });
        } catch {
          // The worker may already have stopped; the local promise is still canceled.
        }
        reject(abortError());
      };
      const cleanup = () => options.signal?.removeEventListener('abort', onAbort);
      requests.set(id, { resolve, reject, onProgress: options.onProgress, cleanup, worker: instance });
      options.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        instance.postMessage({ id, type, file, targetContainer: options.targetContainer });
      } catch (error) {
        requests.delete(id);
        cleanup();
        reject(error);
      }
    });
  }

  function formatFileSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 1) return '0 B';
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
    return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MiB`;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    const rounded = Math.round(seconds);
    const minutes = Math.floor(rounded / 60);
    const remainder = rounded % 60;
    return minutes ? `${minutes}:${String(remainder).padStart(2, '0')}` : `${remainder} 秒`;
  }

  function codecLabel(codec) {
    return ({ avc: 'H.264', hevc: 'HEVC', vp8: 'VP8', vp9: 'VP9', av1: 'AV1', aac: 'AAC', opus: 'Opus', mp3: 'MP3', flac: 'FLAC' })[codec]
      ?? String(codec || '无音频');
  }

  function safeRedirectPath(value) {
    if (
      typeof value !== 'string'
      || value.length > 2048
      || !value.startsWith('/')
      || value.startsWith('//')
      || value.includes('\\')
      || /[\u0000-\u001f\u007f]/.test(value)
    ) return null;
    return value;
  }

  function setStatus(message, isError = false) {
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('is-error', isError);
  }

  function setAnalysis(kind, heading, message) {
    if (!analysis) return;
    analysis.hidden = false;
    analysis.dataset.state = kind;
    if (analysisTitle) analysisTitle.textContent = heading;
    if (analysisDetail) analysisDetail.textContent = message;
  }

  function resetSelection() {
    selected = null;
    input?.setCustomValidity('');
    if (title) title.textContent = defaultTitle;
    if (detail) detail.textContent = defaultDetail;
    if (analysis) analysis.hidden = true;
    setStatus('');
  }

  async function inspectSelection() {
    const currentSelection = ++selectionNumber;
    inspectionController?.abort();
    inspectionController = null;
    const file = input?.files?.[0];
    input?.setCustomValidity('');
    selected = null;
    if (!file) {
      resetSelection();
      return;
    }
    if (title) title.textContent = file.name;
    if (detail) detail.textContent = `${formatFileSize(file.size)} · 正在读取容器与轨道…`;
    setAnalysis('working', '正在分析媒体', '文件只在你的浏览器中读取，此时尚未上传。');
    if (button) button.disabled = true;
    const controller = new AbortController();
    inspectionController = controller;

    try {
      if (maxUploadBytes > 0 && file.size > maxUploadBytes) {
        throw new Error(`文件超过 ${formatFileSize(maxUploadBytes)} 的上传上限。`);
      }
      const probe = await askWorker('probe', file, { signal: controller.signal });
      if (currentSelection !== selectionNumber) return;
      selected = { file, probe };
      const audio = probe.audioCodec ? ` + ${codecLabel(probe.audioCodec)}` : ' · 无音频';
      const codecInfo = `${codecLabel(probe.videoCodec)}${audio}`;
      const operation = probe.plan.remuxRequired
        ? `将无损重封装为 ${probe.plan.container.toUpperCase()}`
        : '容器已经符合发布规范';
      const dimensions = `${probe.width}×${probe.height}`;
      const duration = formatDuration(probe.duration);
      const compatible = probe.plan.compatibility === 'guaranteed';
      setAnalysis(
        compatible ? 'ready' : 'warning',
        compatible ? codecInfo : '该视频兼容性较差',
        `${compatible ? '' : `${codecInfo} · `}${dimensions}${duration ? ` · ${duration}` : ''} · ${operation}${compatible ? '' : '；部分浏览器或设备可能无法播放'}`
      );
      if (detail) detail.textContent = `${formatFileSize(file.size)} · 检测完成`;
    } catch (error) {
      if (currentSelection !== selectionNumber) return;
      if (error?.name === 'AbortError') return;
      selected = null;
      input?.setCustomValidity(error.message || '无法处理这个媒体文件。');
      setAnalysis('error', '不能发布这个文件', error.message || '无法识别媒体格式。');
      if (detail) detail.textContent = `${formatFileSize(file.size)} · 格式不受支持`;
    } finally {
      if (inspectionController === controller) inspectionController = null;
      if (currentSelection === selectionNumber && button) button.disabled = false;
    }
  }

  input?.addEventListener('change', inspectSelection);
  if (drop) {
    ['dragenter', 'dragover'].forEach((eventName) => {
      drop.addEventListener(eventName, () => drop.classList.add('is-dragging'));
    });
    ['dragleave', 'drop'].forEach((eventName) => {
      drop.addEventListener(eventName, () => drop.classList.remove('is-dragging'));
    });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitting || !form.checkValidity()) {
      form.reportValidity();
      return;
    }
    if (!selected || selected.file !== input?.files?.[0]) {
      input?.setCustomValidity('请等待媒体分析完成后再发布。');
      form.reportValidity();
      return;
    }

    submitting = true;
    if (button) {
      button.disabled = true;
      button.textContent = selected.probe.plan.remuxRequired ? '正在无损重封装…' : '正在上传…';
    }
    input.disabled = true;
    const controller = new AbortController();
    submissionController = controller;

    const csrfToken = form.querySelector('input[name="_csrf"]')?.value || '';

    async function uploadChunked(uploadBody, canonicalName) {
      const csrfHeaders = { 'x-csrf-token': csrfToken };
      const createResponse = await fetch('/videos/media-session', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...csrfHeaders },
        body: JSON.stringify({
          totalBytes: uploadBody.size,
          fileName: canonicalName,
          sourceFilename: selected.file.name,
          mimeType: selected.probe.plan.mediaType,
          container: selected.probe.container,
          videoCodec: selected.probe.videoCodec,
          audioCodec: selected.probe.audioCodec || null,
          operation: selected.probe.plan.remuxRequired ? 'remux' : 'direct'
        }),
        credentials: 'same-origin',
        signal: controller.signal
      });
      const sessionPayload = await createResponse.json().catch(() => ({}));
      if (!createResponse.ok || !sessionPayload.sessionId) {
        throw new Error(sessionPayload.error || '无法创建分片上传会话。');
      }
      const { sessionId, chunkSize, totalBytes } = sessionPayload;
      let uploaded = 0;
      for (let offset = 0; offset < uploadBody.size; offset += chunkSize) {
        const chunk = uploadBody.slice(offset, Math.min(offset + chunkSize, uploadBody.size));
        const index = Math.floor(offset / chunkSize);
        const chunkResponse = await fetch(`/videos/media-session/${sessionId}/chunks/${index}`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream', ...csrfHeaders },
          body: chunk,
          credentials: 'same-origin',
          signal: controller.signal
        });
        if (!chunkResponse.ok) {
          const errorPayload = await chunkResponse.json().catch(() => ({}));
          throw new Error(errorPayload.error || '分片上传失败。');
        }
        uploaded += chunk.size;
        setStatus(`正在分片上传：${Math.round((uploaded / totalBytes) * 100)}%`);
      }
      const completeResponse = await fetch(`/videos/media-session/${sessionId}/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...csrfHeaders },
        body: JSON.stringify({}),
        credentials: 'same-origin',
        signal: controller.signal
      });
      if (!completeResponse.ok) {
        const errorPayload = await completeResponse.json().catch(() => ({}));
        throw new Error(errorPayload.error || '分片组装失败。');
      }
      const body = new FormData(form);
      body.set('mediaSessionId', sessionId);
      body.set('sourceFilename', selected.file.name);
      body.set('clientContainer', selected.probe.container);
      body.set('clientVideoCodec', selected.probe.videoCodec);
      body.set('clientAudioCodec', selected.probe.audioCodec || 'none');
      body.set('clientOperation', selected.probe.plan.remuxRequired ? 'remux' : 'direct');
      setStatus('正在提交发布信息；上传后还会由服务器完整验证……');
      if (button) button.textContent = '正在发布…';
      const response = await fetch(form.action, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body,
        credentials: 'same-origin',
        redirect: 'error',
        signal: controller.signal
      });
      const contentType = response.headers.get('content-type') || '';
      const payload = contentType.includes('application/json') ? await response.json().catch(() => ({})) : {};
      const redirectPath = safeRedirectPath(payload.redirect);
      if (response.ok && redirectPath) {
        submissionController = null;
        window.location.assign(redirectPath);
        return;
      }
      if (response.ok) throw new Error('服务器已接收文件，但没有返回可用的发布页地址。');
      throw new Error(payload.error || '服务器没有接受这个媒体文件。');
    }

    try {
      let uploadBody = selected.file.slice(
        0,
        selected.file.size,
        selected.probe.plan.mediaType
      );
      if (selected.probe.plan.remuxRequired) {
        setStatus('正在浏览器中复制音视频码流，不会重新编码，请不要关闭页面……');
        const remuxed = await askWorker('remux', selected.file, {
          targetContainer: selected.probe.plan.container,
          onProgress(progress) {
            const percent = Math.max(0, Math.min(100, Math.round(progress * 100)));
            setStatus(`正在无损重封装：${percent}%`);
          },
          signal: controller.signal
        });
        uploadBody = new Blob([remuxed.buffer], { type: selected.probe.plan.mediaType });
      }

      if (maxUploadBytes > 0 && uploadBody.size > maxUploadBytes) {
        throw new Error('重封装后的文件超过上传上限，请换用更小的源文件。');
      }

      const baseName = selected.file.name.replace(/\.[^.]*$/, '') || 'video';
      const canonicalName = `${baseName}${selected.probe.plan.extension}`;

      const DIRECT_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
      if (uploadBody.size > DIRECT_UPLOAD_MAX_BYTES) {
        setStatus('正在分片上传；单次请求不会超过隧道上限……');
        if (button) button.textContent = '正在分片上传…';
        await uploadChunked(uploadBody, canonicalName);
        return;
      }

      const body = new FormData(form);
      body.set('video', uploadBody, canonicalName);
      body.set('sourceFilename', selected.file.name);
      body.set('clientContainer', selected.probe.container);
      body.set('clientVideoCodec', selected.probe.videoCodec);
      body.set('clientAudioCodec', selected.probe.audioCodec || 'none');
      body.set('clientOperation', selected.probe.plan.remuxRequired ? 'remux' : 'direct');
      setStatus('正在上传规范化媒体；上传后还会由服务器完整验证……');
      if (button) button.textContent = '正在上传…';

      const response = await fetch(form.action, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body,
        credentials: 'same-origin',
        redirect: 'error',
        signal: controller.signal
      });
      const contentType = response.headers.get('content-type') || '';
      const payload = contentType.includes('application/json')
        ? await response.json().catch(() => ({}))
        : {};
      const redirectPath = safeRedirectPath(payload.redirect);
      if (response.ok && redirectPath) {
        submissionController = null;
        window.location.assign(redirectPath);
        return;
      }
      if (response.ok) throw new Error('服务器已接收文件，但没有返回可用的发布页地址。');
      throw new Error(payload.error || '服务器没有接受这个媒体文件。');
    } catch (error) {
      if (submissionController === controller) submissionController = null;
      submitting = false;
      if (input) input.disabled = false;
      if (button) {
        button.disabled = false;
        button.innerHTML = originalButtonHtml;
      }
      setStatus(error.message || '媒体处理或上传失败，请稍后重试。', true);
    }
  });

  window.addEventListener('pagehide', () => {
    inspectionController?.abort();
    submissionController?.abort();
    worker?.terminate();
    worker = null;
  }, { once: true });
}
