// strapline.js
export function injectStraplineStyles({ uppercase, letterSpacing, fontSize, color }) {
  if (document.getElementById('assistant-styles-strapline')) return;
  const style = document.createElement('style');
  style.id = 'assistant-styles-strapline';
  style.textContent = `
    .msg.assistant .strapline {
      display: flex; align-items: center; gap: 10px; margin-bottom: 8px; user-select: none;
    }
    .msg.assistant .strapline img { width: 24px; height: 24px; border-radius: 50%; display: block; }
    .msg.assistant .strapline .label {
      font-weight: 600; ${uppercase ? 'text-transform: uppercase;' : ''}
      letter-spacing: ${letterSpacing}; font-size: ${fontSize}; color: ${color};
    }
  `;
  document.head.appendChild(style);
}

export function renderAssistantHeader(assistantDiv, straplineText, iconUrl, fallback = 'POLI PILOT') {
  let header = assistantDiv.querySelector('.strapline');
  if (!header) {
    header = document.createElement('div');
    header.className = 'strapline';
    const img = document.createElement('img');
    img.src = iconUrl;
    img.alt = 'Assistant';
    const label = document.createElement('span');
    label.className = 'label';
    header.appendChild(img);
    header.appendChild(label);
    // header first, body underneath
    assistantDiv.insertBefore(header, assistantDiv.firstChild || null);
  }
  const labelEl = header.querySelector('.label');
  if (labelEl) labelEl.textContent = straplineText || fallback;
}

export function getOrCreateContentContainer(assistantDiv) {
  let content = assistantDiv.querySelector('.content');
  if (!content) {
    content = document.createElement('div');
    content.className = 'content';
    assistantDiv.appendChild(content);
  }
  return content;
}
