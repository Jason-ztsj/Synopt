const LICENSES = Object.freeze({
  'CC0-1.0': Object.freeze({
    id: 'CC0-1.0',
    code: 'CC0 1.0',
    name: 'CC0 1.0 通用',
    url: 'https://creativecommons.org/publicdomain/zero/1.0/deed.zh-hans',
    summary: '创作者尽可能放弃此作品的版权及相关权利，将其贡献给公共领域。任何人都可以自由复制、修改、传播和使用，无需署名。',
    cc0: true
  }),
  'CC-BY-4.0': Object.freeze({
    id: 'CC-BY-4.0',
    code: 'CC BY 4.0',
    name: '知识共享 署名 4.0 国际许可协议',
    url: 'https://creativecommons.org/licenses/by/4.0/deed.zh-hans',
    summary: '他人可以复制、传播、修改并将作品用于商业用途，但必须标明创作者。',
    cc0: false
  }),
  'CC-BY-NC-4.0': Object.freeze({
    id: 'CC-BY-NC-4.0',
    code: 'CC BY-NC 4.0',
    name: '知识共享 署名—非商业性使用 4.0 国际许可协议',
    url: 'https://creativecommons.org/licenses/by-nc/4.0/deed.zh-hans',
    summary: '他人可以复制、传播和修改作品，但必须标明创作者，且不得用于商业目的。',
    cc0: false
  }),
  'CC-BY-ND-4.0': Object.freeze({
    id: 'CC-BY-ND-4.0',
    code: 'CC BY-ND 4.0',
    name: '知识共享 署名—禁止演绎 4.0 国际许可协议',
    url: 'https://creativecommons.org/licenses/by-nd/4.0/deed.zh-hans',
    summary: '他人可以复制和传播原作，包括用于商业目的，但必须标明创作者且不得修改作品。',
    cc0: false
  }),
  'CC-BY-NC-ND-4.0': Object.freeze({
    id: 'CC-BY-NC-ND-4.0',
    code: 'CC BY-NC-ND 4.0',
    name: '知识共享 署名—非商业性使用—禁止演绎 4.0 国际许可协议',
    url: 'https://creativecommons.org/licenses/by-nc-nd/4.0/deed.zh-hans',
    summary: '他人可以复制和传播原作，但必须标明创作者，不得用于商业目的，也不得修改作品。',
    cc0: false
  })
});

export function checkboxIsOn(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
}

export function normalizeLicense(input = {}) {
  const attribution = checkboxIsOn(input.attribution);
  if (!attribution) return LICENSES['CC0-1.0'];
  const nonCommercial = checkboxIsOn(input.nonCommercial ?? input.non_commercial);
  const noDerivatives = checkboxIsOn(input.noDerivatives ?? input.no_derivatives);
  if (nonCommercial && noDerivatives) return LICENSES['CC-BY-NC-ND-4.0'];
  if (nonCommercial) return LICENSES['CC-BY-NC-4.0'];
  if (noDerivatives) return LICENSES['CC-BY-ND-4.0'];
  return LICENSES['CC-BY-4.0'];
}

export function getLicense(id) {
  return LICENSES[id] ?? null;
}

export { LICENSES };

