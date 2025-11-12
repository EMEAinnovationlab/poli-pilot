// /js/project_settings.js
export async function applyProjectSettings() {
  try {
    const res = await fetch('/project-settings');
    const data = await res.json();
    if (!res.ok || !data?.ok) throw new Error(data.error || 'Failed to fetch settings');

    const s = data.settings || {};
    const secondary = s.tool_secondary_name || '';

    // Update all brand subtitles (e.g. <span class="brand-subtitle">...</span>)
    document.querySelectorAll('.brand-subtitle').forEach(el => {
      el.textContent = secondary;
    });

    // Optionally update document title
    if (s.project_name) {
      document.title = s.project_name;
    }
  } catch (err) {
    console.warn('⚠️ Could not load project settings:', err);
  }
}


