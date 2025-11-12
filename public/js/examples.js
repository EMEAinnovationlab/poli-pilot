// examples.js
export function openExamples(examplesContainer, examplesToggle) {
  if (!examplesContainer) return;
  examplesContainer.style.removeProperty('max-height');
  examplesContainer.style.removeProperty('opacity');
  examplesContainer.style.removeProperty('overflow');
  examplesContainer.classList.remove('hide');
  if (examplesToggle) examplesToggle.classList.add('hide');
}

export function closeExamples(examplesContainer, examplesToggle, { animate = true, scroll = true } = {}) {
  if (!examplesContainer) return;
  const smoothScrollToBottom = () => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });

  if (examplesContainer.classList.contains('hide')) {
    if (examplesToggle) examplesToggle.classList.remove('hide');
    if (scroll) smoothScrollToBottom();
    return;
  }
  if (!animate) {
    examplesContainer.classList.add('hide');
    if (examplesToggle) examplesToggle.classList.remove('hide');
    if (scroll) smoothScrollToBottom();
    return;
  }
  examplesContainer.style.overflow = 'hidden';
  const startHeight = examplesContainer.scrollHeight + 'px';
  examplesContainer.style.maxHeight = startHeight;
  examplesContainer.style.opacity = '1';
  requestAnimationFrame(() => {
    examplesContainer.classList.add('is-closing');
    examplesContainer.style.maxHeight = '0px';
    examplesContainer.style.opacity = '0';
  });
  const done = () => {
    examplesContainer.classList.add('hide');
    if (examplesToggle) examplesToggle.classList.remove('hide');
    examplesContainer.classList.remove('is-closing');
    examplesContainer.style.removeProperty('max-height');
    examplesContainer.style.removeProperty('opacity');
    examplesContainer.style.removeProperty('overflow');
    examplesContainer.removeEventListener('transitionend', done);
    if (scroll) smoothScrollToBottom();
  };
  examplesContainer.addEventListener('transitionend', done);
}

export function attachExampleFillHandlers({ exampleCards, input, closeExamplesFn, autoGrowTextarea }) {
  if (!exampleCards) return;
  exampleCards.forEach(card => {
    card.addEventListener('click', () => {
      const text = card.getAttribute('data-prompt') || '';
      if (!text.trim()) return;
      if (input) {
        input.value = text;
        autoGrowTextarea();
        input.focus();
        input.selectionStart = input.selectionEnd = input.value.length;
      }
      closeExamplesFn({ animate: true, scroll: true });
    });
  });
}
