import { buildCreationPrompt, validatePromptConfig } from './prompt-builder.js';

const drafts = new Map();
const $ = id => document.getElementById(id);
const escapeHTML = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const copy = value => JSON.parse(JSON.stringify(value));

function freshDraft(project) {
  return {
    formatVersion:2, name: 'New pixel art', description: '', width: project.width, height: project.height,
    paletteMode: 'auto', maxColors: 16, palette: [...project.palette], style: '',
    animations: [{ name: 'Idle', frameCount: 1, fps: 8 }],
  };
}

function presetAnimations(preset) {
  if (preset === 'motion') return [{ name: 'Idle', frameCount: 4, fps: 8 }, { name: 'Walk', frameCount: 6, fps: 8 }];
  if (preset === 'rpg-character') return ['right', 'up', 'down'].flatMap(direction => [
    { name: `Attack ${direction}`, frameCount: 5, fps: 8 },
    { name: `Walk ${direction}`, frameCount: 4, fps: 8 },
    { name: `Idle ${direction}`, frameCount: 2, fps: 8 },
  ]);
  if (preset === 'directions') return ['right', 'up', 'down'].flatMap(direction => [
    { name: `Idle ${direction}`, frameCount: 2, fps: 8 },
    { name: `Walk ${direction}`, frameCount: 4, fps: 8 },
  ]);
  return [{ name: 'Idle', frameCount: 1, fps: 8 }];
}

function promptFileName(name) {
  const safeName = name.normalize('NFKD').replace(/[^a-z0-9-_]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 80);
  return `${safeName || 'pixel-art'}-prompt.txt`;
}

/** Build a new-art prompt without reading or changing any existing pixels. */
/**
 * `skills` (optional): prompt skills from plugins, [{ key, title, description, instructions, pluginName, animations?, width?, height? }].
 * The chosen skill's instructions are added to the prompt; its animations and size fill in the plan.
 */
export function openPromptBuilder({ project, documentId, openDialog, openImport, openImageGenerator, toast, initial, skills = [] }) {
  const key = documentId || 'current';
  const draft = initial
    ? { ...freshDraft(project), ...copy(initial) }
    : copy(drafts.get(key) || freshDraft(project));
  draft.palette = [...project.palette];
  drafts.set(key, draft);

  openDialog('Start with an idea', `
    <form id="prompt-builder-form" class="prompt-builder" novalidate>
      <div class="prompt-builder-body">
        <p class="prompt-intro">Describe new pixel art and plan its animations. Your prompt includes the complete PXA format guide, so you can start without an example.</p>
        ${openImageGenerator ? '<button type="button" class="button prompt-image-model" id="prompt-image-model">Or draw it with an image model (OpenAI, Gemini or any chatbot) →</button>' : ''}
        <div class="prompt-brief-grid">
          <label class="field"><span class="field-label">Project name</span><input id="prompt-name" maxlength="120" required autocomplete="off"></label>
          <label class="field prompt-description-field"><span class="field-label">What would you like to create?</span><textarea id="prompt-description" rows="3" maxlength="6000" required placeholder="A tiny pirate with a red coat and a curved sword, viewed from above…"></textarea></label>
        </div>
        <div class="prompt-spec-grid">
          <label class="field"><span class="field-label">Width · pixels</span><input id="prompt-width" type="number" min="1" max="256" step="1" required inputmode="numeric"></label>
          <label class="field"><span class="field-label">Height · pixels</span><input id="prompt-height" type="number" min="1" max="256" step="1" required inputmode="numeric"></label>
          <label class="field prompt-palette-field"><span class="field-label">Palette</span><select id="prompt-palette-mode"><option value="auto">AI chooses colors</option><option value="current">Use current palette</option></select></label>
          <label class="field prompt-color-limit" id="prompt-color-limit-field"><span class="field-label">Max. colors</span><input id="prompt-max-colors" type="number" min="1" max="64" step="1" required inputmode="numeric"></label>
        </div>
        <label class="field"><span class="field-label">PXA format</span><select id="prompt-format-version"><option value="2">PXA 2 · reusable parts and shapes</option><option value="1">PXA 1 · legacy pixel data</option></select></label>
        ${skills.length ? `<label class="field prompt-skill-field"><span class="field-label">Prompt skill · from plugins</span><select id="prompt-skill"><option value="">None</option>${skills.map(skill => `<option value="${escapeHTML(skill.key)}" title="From ${escapeHTML(skill.pluginName)}">${escapeHTML(skill.title)}</option>`).join('')}</select></label><p id="prompt-skill-help" class="prompt-section-help" hidden></p>` : ''}
        <div id="prompt-current-palette" class="prompt-current-palette" hidden>
          <div class="prompt-palette-swatches" aria-hidden="true">${draft.palette.map(color => `<span style="--prompt-color:${escapeHTML(color)}" title="${escapeHTML(color.toUpperCase())}"></span>`).join('')}</div>
          <p>${draft.palette.length} fixed colors from “${escapeHTML(project.name)}”, in their existing order. The artwork is not included.</p>
        </div>
        <details class="prompt-style-details">
          <summary>Style and perspective <span>Optional</span></summary>
          <label class="field"><span class="field-label">Art direction</span><textarea id="prompt-style" rows="2" maxlength="2000" placeholder="Top-down view, light from the upper left, a dark one-pixel outline, and room around the sprite."></textarea></label>
        </details>

        <section class="prompt-animation-section" aria-labelledby="prompt-animations-heading">
          <div class="prompt-section-heading"><h3 id="prompt-animations-heading">Animations</h3><span id="prompt-animation-count"></span></div>
          <p class="prompt-section-help">Top to bottom is the exact animation order. Spritesheet rows follow this order; frames run left to right.</p>
          <div class="prompt-preset-bar">
            <label class="field"><span class="field-label">Quick start</span><select id="prompt-preset"><option value="">Choose a preset…</option><option value="single">Single sprite</option><option value="motion">Idle + walk</option><option value="directions">Three directions</option><option value="rpg-character">RPG character</option></select></label>
            <button id="prompt-apply-preset" class="button" type="button" disabled>Apply preset</button>
            <button id="prompt-use-current" class="text-button" type="button">Use current animation list</button>
          </div>
          <ol id="prompt-animation-list" class="prompt-animation-list" aria-label="Requested animations in order"></ol>
          <div class="prompt-animation-footer"><button id="prompt-add-animation" class="button" type="button">${icon('plus')} Add animation</button><span>Use the arrows to change the order.</span></div>
        </section>

        <p id="prompt-summary" class="prompt-summary"></p>
        <p id="prompt-error" class="prompt-error" role="alert" hidden></p>
        <details id="prompt-preview-details" class="prompt-preview-details">
          <summary><span>Preview complete prompt</span><span id="prompt-character-count"></span>${icon('chevron')}</summary>
          <label class="field"><span class="sr-only">Complete AI prompt</span><textarea id="prompt-output" readonly spellcheck="false" aria-label="Complete AI prompt" placeholder="Describe your artwork to preview the complete prompt, including the pixel-data format guide."></textarea></label>
        </details>
        <p class="prompt-next-step"><strong>Next:</strong> copy the prompt into ChatGPT. Bring its complete PXA response back using <strong>Paste result</strong>.</p>
      </div>
      <div class="prompt-builder-actions">
        <button id="prompt-paste-result" class="button" type="button" title="Paste AI pixel data into Pixel Studio">Paste result</button>
        <button id="prompt-download" class="button prompt-download" type="button" title="Download prompt as a text file" aria-label="Download prompt as a text file">${icon('import')}<span>Download .txt</span></button>
        <button id="prompt-copy" class="button primary" type="submit">${icon('copy')}<span>Copy prompt</span></button>
      </div>
    </form>`, 'AI PROMPT BUILDER');
  $('modal').classList.add('wide', 'prompt-builder-modal');

  const form = $('prompt-builder-form');
  const list = $('prompt-animation-list');
  const fields = {
    formatVersion:'prompt-format-version', name: 'prompt-name', description: 'prompt-description', width: 'prompt-width', height: 'prompt-height',
    paletteMode: 'prompt-palette-mode', maxColors: 'prompt-max-colors', style: 'prompt-style',
  };
  for (const [property, id] of Object.entries(fields)) $(id).value = draft[property];
  const chosenSkill = () => skills.find(skill => skill.key === draft.skill) || null;
  if ($('prompt-skill')) $('prompt-skill').value = chosenSkill() ? draft.skill : '';
  let showErrors = false;

  function readDraft() {
    for (const [property, id] of Object.entries(fields)) draft[property] = $(id).value;
    if ($('prompt-skill')) draft.skill = $('prompt-skill').value;
    draft.animations = [...list.children].map(row => ({
      name: row.querySelector('.prompt-animation-name').value,
      frameCount: row.querySelector('.prompt-animation-frames').value,
      fps: row.querySelector('.prompt-animation-fps').value,
    }));
    drafts.set(key, draft);
  }

  function config() {
    return {
      ...draft, formatVersion:Number(draft.formatVersion), width: Number(draft.width), height: Number(draft.height), maxColors: Number(draft.maxColors),
      animations: draft.animations.map(animation => ({ ...animation, frameCount: Number(animation.frameCount), fps: Number(animation.fps) })),
      skill: chosenSkill() ? { title: chosenSkill().title, instructions: chosenSkill().instructions } : undefined,
    };
  }

  function renderRows() {
    list.innerHTML = draft.animations.map((animation, index) => `
      <li class="prompt-animation-row" data-index="${index}">
        <span class="prompt-row-number" aria-label="Animation order ${index + 1}">${String(index + 1).padStart(2, '0')}</span>
        <label class="field prompt-animation-name-field"><span class="field-label">Name</span><input id="prompt-animation-name-${index}" class="prompt-animation-name" value="${escapeHTML(animation.name)}" maxlength="80" required autocomplete="off" aria-label="Animation ${index + 1} name"></label>
        <label class="field"><span class="field-label">Frames</span><input class="prompt-animation-frames" type="number" min="1" max="256" step="1" required inputmode="numeric" value="${escapeHTML(animation.frameCount)}" aria-label="Animation ${index + 1} frame count"></label>
        <label class="field"><span class="field-label">FPS</span><input class="prompt-animation-fps" type="number" min="1" max="60" step="any" required inputmode="decimal" value="${escapeHTML(animation.fps)}" aria-label="Animation ${index + 1} frames per second"></label>
        <div class="prompt-row-actions" role="group" aria-label="Animation ${index + 1} order and removal">
          <button class="icon-button" data-row-action="up" type="button" title="Move animation ${index + 1} up" aria-label="Move animation ${index + 1} up"${index === 0 ? ' disabled' : ''}>${icon('up')}</button>
          <button class="icon-button" data-row-action="down" type="button" title="Move animation ${index + 1} down" aria-label="Move animation ${index + 1} down"${index === draft.animations.length - 1 ? ' disabled' : ''}>${icon('down')}</button>
          <button class="icon-button" data-row-action="remove" type="button" title="Remove animation ${index + 1}" aria-label="Remove animation ${index + 1}"${draft.animations.length === 1 ? ' disabled' : ''}>${icon('trash')}</button>
        </div>
      </li>`).join('');
    $('prompt-add-animation').disabled = draft.animations.length >= 100;
  }

  function update() {
    readDraft();
    const useCurrentPalette = draft.paletteMode === 'current';
    $('prompt-color-limit-field').hidden = useCurrentPalette;
    $('prompt-max-colors').disabled = useCurrentPalette;
    $('prompt-current-palette').hidden = !useCurrentPalette;
    $('prompt-apply-preset').disabled = !$('prompt-preset').value;
    $('prompt-copy').innerHTML = `${icon('copy')}<span>Copy prompt</span>`;
    const count = draft.animations.length;
    const total = draft.animations.reduce((sum, animation) => sum + (Number(animation.frameCount) || 0), 0);
    $('prompt-animation-count').textContent = `${count} animation${count === 1 ? '' : 's'} · ${total} frame${total === 1 ? '' : 's'}`;
    $('prompt-summary').textContent = `${draft.width || '—'} × ${draft.height || '—'} pixels · ${count} animation${count === 1 ? '' : 's'} · ${total} frame${total === 1 ? '' : 's'} · ${useCurrentPalette ? `${draft.palette.length} fixed colors` : `up to ${draft.maxColors || '—'} colors`}`;
    try {
      const normalized = validatePromptConfig(config());
      const text = buildCreationPrompt(normalized);
      $('prompt-output').value = text;
      $('prompt-character-count').textContent = `${text.length.toLocaleString()} characters`;
      $('prompt-error').hidden = true;
      return text;
    } catch (error) {
      $('prompt-output').value = '';
      $('prompt-character-count').textContent = 'Complete the brief';
      $('prompt-error').textContent = error.message;
      $('prompt-error').hidden = !showErrors;
      return null;
    }
  }

  function validatedPrompt() {
    showErrors = true;
    const text = update();
    if (!form.reportValidity()) return null;
    if (!text) $('prompt-error').scrollIntoView({ block: 'nearest' });
    return text;
  }

  $('prompt-skill')?.addEventListener('change', () => {
    readDraft();
    const skill = chosenSkill();
    $('prompt-skill-help').hidden = !skill;
    $('prompt-skill-help').textContent = skill?.description || '';
    if (!skill || (!skill.animations && !skill.width && !skill.height)) return;
    if (skill.animations) draft.animations = copy(skill.animations);
    for (const property of ['width', 'height']) if (skill[property]) { draft[property] = skill[property]; $(fields[property]).value = skill[property]; }
    renderRows();
    toast(`“${skill.title}” filled in its size and animations. Everything stays editable.`);
  });
  form.addEventListener('input', update);
  form.addEventListener('change', update);
  list.addEventListener('click', event => {
    const button = event.target.closest('[data-row-action]');
    if (!button || button.disabled) return;
    readDraft();
    const index = Number(button.closest('.prompt-animation-row').dataset.index);
    let focusIndex = index;
    if (button.dataset.rowAction === 'remove') {
      if (draft.animations.length <= 1) return;
      draft.animations.splice(index, 1);
      focusIndex = Math.min(index, draft.animations.length - 1);
    } else {
      const target = index + (button.dataset.rowAction === 'up' ? -1 : 1);
      if (target < 0 || target >= draft.animations.length) return;
      [draft.animations[index], draft.animations[target]] = [draft.animations[target], draft.animations[index]];
      focusIndex = target;
    }
    renderRows(); update();
    $(`prompt-animation-name-${focusIndex}`).focus();
  });
  $('prompt-add-animation').onclick = () => {
    readDraft();
    if (draft.animations.length >= 100) return;
    const names = new Set(draft.animations.map(animation => animation.name.trim().toLowerCase()));
    let number = draft.animations.length + 1;
    while (names.has(`animation ${number}`)) number++;
    draft.animations.push({ name: `Animation ${number}`, frameCount: 4, fps: 8 });
    renderRows(); update();
    const input = $(`prompt-animation-name-${draft.animations.length - 1}`);
    input.focus(); input.select();
  };
  $('prompt-apply-preset').onclick = () => {
    if (!$('prompt-preset').value) return;
    readDraft();
    draft.animations = presetAnimations($('prompt-preset').value);
    $('prompt-preset').value = '';
    renderRows(); update();
    toast('Animation preset applied. Names, frame counts, and order are editable.');
  };
  $('prompt-use-current').onclick = () => {
    readDraft();
    draft.animations = project.animations.map(animation => ({ name: animation.name, frameCount: animation.frames.length, fps: animation.fps }));
    renderRows(); update();
    toast('Animation names, frame counts, and FPS copied. No artwork is included.');
  };
  form.onsubmit = async event => {
    event.preventDefault();
    const text = validatedPrompt();
    if (!text) return;
    const button = $('prompt-copy');
    button.disabled = true;
    try {
      await navigator.clipboard.writeText(text);
      if ($('prompt-builder-form') !== form) return;
      button.innerHTML = `${icon('check')}<span>Copied</span>`;
      toast('Prompt copied. Paste it into ChatGPT, then bring the PXA response back here.');
    } catch {
      if ($('prompt-builder-form') !== form) return;
      $('prompt-preview-details').open = true;
      $('prompt-output').focus(); $('prompt-output').select();
      toast('Prompt selected. Press Ctrl/⌘ C to copy it.');
    } finally { button.disabled = false; }
  };
  $('prompt-download').onclick = () => {
    const text = validatedPrompt();
    if (!text) return;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = promptFileName(draft.name);
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast('Prompt downloaded as a text file.');
  };
  $('prompt-paste-result').onclick = () => { readDraft(); openImport(); };
  if (openImageGenerator) $('prompt-image-model').onclick = () => { readDraft(); openImageGenerator(); };
  renderRows(); update();
  if (initial?.skill && chosenSkill()) $('prompt-skill').dispatchEvent(new Event('change', { bubbles: true }));
  else if (chosenSkill()) { $('prompt-skill-help').hidden = !chosenSkill().description; $('prompt-skill-help').textContent = chosenSkill().description; }
  $('prompt-description').focus();
}
