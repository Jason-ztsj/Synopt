import MarkdownIt from 'markdown-it';
import katex from 'katex';
import { ValidationError } from './errors.js';
import { FIELD_LIMITS } from './validation.js';

const MAX_MATH_LENGTH = 2000;
const MAX_MATH_EXPRESSIONS = 50;

function safeKatex(source, displayMode) {
  if (source.length > MAX_MATH_LENGTH) {
    return '<span class="math-error">公式过长，无法预览</span>';
  }
  try {
    return katex.renderToString(source, {
      displayMode,
      throwOnError: false,
      errorColor: '#ff8a5b',
      strict: 'error',
      trust: false,
      maxSize: 10,
      maxExpand: 1000,
      output: 'html'
    });
  } catch {
    return '<span class="math-error">公式无法渲染</span>';
  }
}

function mathPlugin(md) {
  md.inline.ruler.after('escape', 'math_inline', (state, silent) => {
    if (state.src[state.pos] !== '$' || state.src[state.pos + 1] === '$') return false;
    let end = state.pos + 1;
    while ((end = state.src.indexOf('$', end)) !== -1) {
      let escapes = 0;
      for (let index = end - 1; index >= 0 && state.src[index] === '\\'; index -= 1) escapes += 1;
      if (escapes % 2 === 0) break;
      end += 1;
    }
    if (end === -1) return false;
    const content = state.src.slice(state.pos + 1, end);
    if (!content.trim() || /\n/.test(content)) return false;
    if (!silent) {
      const token = state.push('math_inline', 'math', 0);
      token.content = content.trim();
    }
    state.pos = end + 1;
    return true;
  });

  md.block.ruler.after('blockquote', 'math_block', (state, startLine, endLine, silent) => {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const maximum = state.eMarks[startLine];
    const firstLine = state.src.slice(start, maximum);
    if (!firstLine.startsWith('$$')) return false;
    if (silent) return true;

    let content = firstLine.slice(2);
    let nextLine = startLine;
    let closed = content.endsWith('$$') && content.length > 2;
    if (closed) content = content.slice(0, -2);
    while (!closed && ++nextLine < endLine) {
      const lineStart = state.bMarks[nextLine] + state.tShift[nextLine];
      const lineEnd = state.eMarks[nextLine];
      const line = state.src.slice(lineStart, lineEnd);
      if (line.endsWith('$$')) {
        content += `\n${line.slice(0, -2)}`;
        closed = true;
      } else {
        content += `\n${line}`;
      }
    }
    if (!closed) return false;
    const token = state.push('math_block', 'math', 0);
    token.block = true;
    token.content = content.trim();
    token.map = [startLine, nextLine + 1];
    state.line = nextLine + 1;
    return true;
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });

  md.renderer.rules.math_inline = (tokens, index) => safeKatex(tokens[index].content, false);
  md.renderer.rules.math_block = (tokens, index) => `<div class="math-block">${safeKatex(tokens[index].content, true)}</div>\n`;
}

export function createMarkdownRenderer() {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false,
    breaks: false,
    maxNesting: 20
  });
  md.disable('image');
  md.use(mathPlugin);

  const defaultLinkOpen = md.renderer.rules.link_open
    ?? ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
  md.renderer.rules.link_open = (tokens, index, options, env, self) => {
    const token = tokens[index];
    token.attrSet('rel', 'ugc nofollow noopener');
    return defaultLinkOpen(tokens, index, options, env, self);
  };
  return md;
}

const renderer = createMarkdownRenderer();

export function renderMarkdown(value) {
  const source = typeof value === 'string' ? value : '';
  if (source.length > FIELD_LIMITS.discussion) {
    throw new ValidationError(`讨论正文不能超过 ${FIELD_LIMITS.discussion.toLocaleString('zh-CN')} 个字符`);
  }
  const mathMarkers = source.match(/\$/g)?.length ?? 0;
  if (mathMarkers > MAX_MATH_EXPRESSIONS * 2) {
    throw new ValidationError(`每条讨论最多包含 ${MAX_MATH_EXPRESSIONS} 个公式`);
  }
  return renderer.render(source);
}

export { MAX_MATH_EXPRESSIONS, MAX_MATH_LENGTH };

