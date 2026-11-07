import { createInPlaceEdit, setInPlaceScope, inPlaceRestriction, inPlaceDirty, inPlacePoint, beginInPlaceStroke, moveInPlaceStroke, finishInPlaceStroke, restoreInPlace, previewInPlaceEdit, prepareInPlaceEdit, PART_EDIT_TOOLS, inPlaceCanvasRect, inPlacePlacement, inPlaceMode, beginInPlaceSelection, moveInPlaceSelection, finishInPlaceSelection, selectAllInPlace, deselectInPlace, nudgeInPlaceSelection, clearInPlaceSelection, copyInPlaceSelection, pasteInPlace } from '../features/objects/in-place-edit.js';
import { mapPaletteColors, copyObject, copyObjects, pasteObject, objectPixelBounds } from '../domain/object-clipboard.js';
import { commitRasterEdits, writeCelPixels, cloneArtwork } from '../domain/artwork.js';
import { celObjects, isEmptyNode, reorderObject, reorderObjectContainer, updateObject, translateObject, forkObject, deleteObject, addObjectContainer, moveObjectToGroup, removeObjectContainer, objectBounds, hitTestObject, dropObject, resizeObject, frameObjects, orderObjects, translateObjects, deleteObjects, turnObjects, rotateObjects, tiltObjects } from '../domain/objects.js';
import { transformedSize } from '../domain/geometry.js';
import { resizeBox } from '../domain/resize.js';
import { renderObjectsPanel } from './objects-panel.js';
import { initPanelLayout } from './panel-layout.js';
import { openSharedPartEditor } from './shared-part-editor.js';
import { hasLockedInstances } from '../domain/artwork.js';
import { openPartLibrary, renderPartsStrip, PART_DRAG_TYPE } from './part-library.js';
import { placePartInFrames } from '../domain/parts.js';
import { PXA2_GUIDE } from '../formats/pxa-v2.js';
import { MAX_SIZE, MAX_TOTAL_PIXELS, MAX_COLORS, MAX_LAYERS, uid, getAnimationLayers, insertProjectLayer, makeLayeredFrame, getLayerPixels, compositeFrame, stripEmptyFrames, blankProject, validateProject, linePoints, rectanglePoints, ellipsePoints, floodFill, paletteFromRgba, mapRgbaToPalette, resizePixels, nearestColor } from '../domain/project.js';
import { inspectSheet, sliceSpritesheet, createSheetMetadata, validateSheetMetadata } from '../formats/spritesheet.js';
import { encodePixelProject, decodePixelProject } from '../formats/pxs.js';
import { encodeAIProject, decodeAIProject, AI_FORMAT_GUIDE } from '../formats/pxa.js';
import { selectionBounds, clampSelectionOffset, moveSelectedPixels, outlinePixels, moveMaskedPixels, maskBounds } from '../domain/selection.js';
import { brushPoints, snapLineEnd, transformPixels, copyPixels, pastePixels, replaceColor, connectedRegion, shadeIndex, ditherCell, pixelPerfectStep, repeatPixelChanges, changedIndices } from '../domain/toolbox.js';
import { createObjectFromPixels, splitIntoObjects, pixelIslands } from '../domain/object-create.js';
import { openProjectStore } from '../storage/workspace.js';
import { openPromptBuilder } from '../features/ai/prompt-dialog.js';
import { openAIEdit } from '../features/ai/edit-dialog.js';
import { initToolExtras, renderToolExtras, gradientStatus, unclampedDrawing, lineToolPoints, wrappedFootprint, wrappedIndex, beginGradient, moveGradient, drawCanvasOverlay, renderTileGhost } from './tool-extras.js';
import { initObjectPose, renderObjectPose, renderPivotMarker } from './object-pose.js';
import { initAnimatePanel, renderAnimatePanel } from './animate-panel.js';
import { initMotionModes, syncMotionMode, drawMotionOverlay } from './motion-modes.js';
import { initRigMode, syncRigMode, drawRigOverlay, toggleRigMode } from './rig-mode.js';
import { initEffectsPanel, renderEffectsPanel } from './effects-panel.js';
import { initPaletteTools } from './palette-tools.js';
import { initPaletteStudio } from './palette-studio.js';
import { instancePivot } from '../domain/geometry.js';

const $ = (id) => document.getElementById(id);
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escapeHTML = (value) => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clone = (value) => JSON.parse(JSON.stringify(value));
const STORAGE_KEY = 'pixel-studio.project.v1';
const TOOL_NAMES = {pencil:'Pencil',eraser:'Eraser',line:'Line',fill:'Flood fill',replace:'Replace color',eyedropper:'Eyedropper',rectangle:'Rectangle',ellipse:'Ellipse',object:'Select / move objects',select:'Select / move pixels',wand:'Magic wand',resize:'Transform',dither:'Dither brush',shade:'Shade',gradient:'Gradient'};
const TOOL_HINTS = {
  pencil:'Draw on the active pixel object. Hold Alt to pick a color.',
  eraser:'Erase on the active pixel object. Right-click also erases.',
  line:'Drag a straight line. Hold Shift for 45° steps.',
  fill:'Fill a connected area on the active pixel object.',
  gradient:'Drag from the start to the end of the gradient. Shift snaps to 45°. Uses only palette colours, from the active colour to the end colour.',
  replace:'Click a color to replace every match in this pixel object’s current frame.',
  eyedropper:'Pick a color from the visible artwork. Alt works with any tool.',
  rectangle:'Drag a rectangle. Hold Shift for a perfect square.',
  ellipse:'Drag an ellipse. Hold Shift for a perfect circle.',
  object:'Click to select a part; Shift/Ctrl-click or Ctrl/⌘+A selects several. Drag to move; double-click to edit its artwork in place. Arrow keys nudge.',
  select:'Drag to select. Drag inside to move; arrow keys nudge. Make object turns the selection into a movable object.',
  wand:'Click a shape to select it. Shift-click adds more. Then press Make object (Ctrl/⌘ G).',
  dither:'Paints a checkerboard pattern with the current color. Great for gradients and texture.',
  shade:'Click or drag to darken pixels one palette step. Right-click lightens.',
  resize:'Drag a handle to resize; Shift keeps the ratio. Keep area squashes without changing the area. Drag the round handle to rotate (Shift snaps to 15°); drag the blue diamond for a 3D turn: sideways turns ↔ about the Y axis, up or down tips ↕ about the X axis; , and . turn 90°. The shared artwork never changes. Shift-click selects several.',
};
const BRUSH_TOOLS = ['pencil','eraser','line','dither','shade'];
const SYMMETRY_TOOLS = [...BRUSH_TOOLS,'rectangle','ellipse'];
const FREEHAND_TOOLS = ['pencil','eraser','dither','shade'];
/** Pixel tools whose strokes repeat in every frame of the animation when the Edit switch is on All frames. */
const PAINT_TOOLS = ['pencil','eraser','line','rectangle','ellipse','fill','replace','dither','shade'];
const SELECT_TOOLS = ['select','wand'];
const state = {
  project: blankProject(), animationId: null, frameId: null, layerId: null,
  tool: 'pencil', color: 0, scale: 12, fit: true, grid: true, onion: false,
  filled: false, playing: true, previewIndex: 0, previewTime: 0, previewBackground: 0,
  inPlaceEdit:null, previewOverride:null, objectSelection:null, objectScope:'animation', collapsedGroups:new Set(), objectDrag:null,
  cursor: null, drawing: null, selection: null, lastPaint: null, shiftHeld: false, swap: false, swapFirst: null,
  brushSize: 1, brushShape: 'square', symmetry: 'none', pixelPerfect: false, wandMode: 'shape', resizeMode: 'free', transformScope: 'frame', clipboard: null, objectClipboard: null, objectMulti: null, lastClipboard: 'pixels',
  undo: [], redo: [], samples: [], sampleData: new Map(), saveTimer: null, storageAvailable: true, importSkipEmpty: true,
  documents: new Map(), openIds: [], documentId: null, panels: {tools:false,details:false}, panelSections: {}, sessionSaveError: false,
};
let toastTimer;
let projectStore;
let saveQueue = Promise.resolve();
let renderedDocumentId=null;

function currentAnimation() {
  return state.project.animations.find(a => a.id === state.animationId) || state.project.animations[0];
}
function currentFrame() {
  const animation = currentAnimation();
  return animation.frames.find(f => f.id === state.frameId) || animation.frames[0];
}
function currentLayer() {
  return state.project.layers.find(layer => layer.id === state.layerId) || preferredLayer();
}
function preferredLayer() { const layers = [...getAnimationLayers(state.project,currentAnimation(),currentFrame())].reverse(); return layers.find(layer=>layer.visible && !layer.locked) || layers.find(layer=>layer.visible) || layers[0]; }
function canEditPixels(frame=currentFrame()) {
  const layer=currentLayer();
  return layer.visible && !layer.locked && !hasLockedInstances(frame.cels.find(c=>c.layerId===layer.id));
}
function currentPixels() { return getLayerPixels(currentFrame(), currentLayer().id); }
function forEachFrame(action) { for (const animation of state.project.animations) for (const frame of animation.frames) action(frame); }
function totalFrames() { return state.project.animations.reduce((sum, animation) => sum + animation.frames.length, 0); }
function hasFrameCapacity() { return totalFrames() < 1024 && (totalFrames()+1) * state.project.layers.length * state.project.width * state.project.height <= MAX_TOTAL_PIXELS; }
function canAddFrame() { return currentAnimation().frames.length < 256 && hasFrameCapacity(); }
function canAddLayer() { return state.project.layers.length < MAX_LAYERS && totalFrames() * (state.project.layers.length+1) * state.project.width * state.project.height <= MAX_TOTAL_PIXELS; }
function maxZoom() { return Math.min(32, Math.floor(2048 / Math.max(state.project.width,state.project.height))); }
function normalizeSelection() {
  state.animationId = currentAnimation().id;
  state.frameId = currentFrame().id;
  state.layerId = currentLayer().id;
  if (state.selection && (state.selection.frameId!==state.frameId || state.selection.layerId!==state.layerId || state.selection.canvasWidth!==state.project.width || state.selection.canvasHeight!==state.project.height)) state.selection=null;
  const selected = state.objectSelection;
  if (selected && (selected.layerId!==state.layerId || (selected.key!=='@group' && !celObjects(currentFrame().cels.find(c=>c.layerId===selected.layerId)).some(n=>n.key===selected.key)))) state.objectSelection=null;
  if (state.objectMulti) {
    const items=state.objectSelection && sameItem(state.objectMulti.anchor,state.objectSelection) ? orderObjects(state.project,currentFrame(),state.objectMulti.items) : [];
    state.objectMulti=items.length>1 && items.some(item=>sameItem(item,state.objectSelection))?{...state.objectMulti,items}:null;
  }
  state.color = Math.min(state.color, state.project.palette.length - 1);
  state.previewIndex %= currentAnimation().frames.length;
  state.scale = Math.max(1,Math.min(maxZoom(),state.scale));
}
function snapshot() {
  return {project:clone(state.project),animationId:state.animationId,frameId:state.frameId,layerId:state.layerId,objectSelection:clone(state.objectSelection)};
}
function remember(before) {
  commitRasterEdits(before.project,state.project);
  state.project=validateProject(state.project);
  if (JSON.stringify(before.project) === JSON.stringify(state.project)) return false;
  state.undo.push(before);
  if (state.undo.length > 40) state.undo.shift();
  state.redo = [];
  normalizeSelection();
  scheduleSave();
  return true;
}
function mutate(action) {
  if(state.inPlaceEdit)throw new Error('Apply or cancel the canvas object edit before changing the project.');
  finishDrawing();
  const before = snapshot();
  try { action(); remember(before); }
  catch (error) { state.project=before.project; normalizeSelection(); renderAll(); throw error; }
  renderAll();
}
function restore(from, to) {
  finishDrawing();
  if (!from.length) return;
  to.push(snapshot());
  const previous = from.pop();
  state.project = previous.project;
  state.animationId = previous.animationId;
  state.frameId = previous.frameId;
  state.layerId = previous.layerId;
  state.objectSelection = previous.objectSelection || null;
  state.selection = null;
  state.swap = false;
  normalizeSelection();
  scheduleSave();
  renderAll();
  if (state.fit) fitCanvas();
}
function replaceProject(project, message) {
  if(state.inPlaceEdit)throw new Error('Apply or cancel the canvas object edit before opening another project.');
  const clean = validateProject(project);
  finishDrawing();
  if (state.documentId) saveNow();
  const document = makeDocument(clean);
  state.documents.set(document.id,document);
  state.openIds.push(document.id);
  activateDocument(document.id);
  scheduleSave();
  saveNow();
  if (message) toast(message);
}

function makeDocument(project, saved = {}) {
  return {id:saved.id || uid(),project,animationId:saved.animationId || project.animations[0].id,
    frameId:saved.frameId || project.animations[0].frames[0].id,layerId:saved.layerId || project.layers.at(-1).id,
    undo:[],redo:[],selection:null,objectSelection:saved.objectSelection || null,scale:12,fit:true,color:0,previewIndex:0,revision:0,savedRevision:-1,saveError:false};
}
function syncDocument() {
  const document = state.documents.get(state.documentId);
  if (!document) return null;
  for (const key of ['project','animationId','frameId','layerId','objectSelection','undo','redo','selection','scale','fit','color','previewIndex']) document[key]=state[key];
  return document;
}
function activateDocument(id) {
  const document=state.documents.get(id);
  if (!document) return;
  state.documentId=id;
  for (const key of ['project','animationId','frameId','layerId','objectSelection','undo','redo','selection','scale','fit','color','previewIndex']) state[key]=document[key];
  state.cursor=null; state.drawing=null; state.swap=false; state.swapFirst=null; state.previewTime=0;
  state.transformScope=state.selection?'selection':'frame';
  normalizeSelection(); renderAll(); renderSaveStatus();
  requestAnimationFrame(fitCanvas);
}
function switchDocument(id) {
  if(state.inPlaceEdit){toast('Apply or cancel the canvas object edit before switching projects.');return;}
  if (id===state.documentId) return;
  finishDrawing(); saveNow();
  activateDocument(id); persistSession();
}
function workspaceSession() { return {openIds:[...state.openIds],activeId:state.documentId,panels:{...state.panels},panelSections:{...state.panelSections}}; }
function queueSave(action) {
  const result=saveQueue.then(action);
  saveQueue=result.catch(()=>{});
  return result;
}
function persistSession() {
  if (!projectStore) return Promise.resolve(false);
  const session=workspaceSession();
  return queueSave(()=>projectStore.saveSession(session)).then(()=>{state.sessionSaveError=false;renderSaveStatus();return true;}).catch(()=>{state.sessionSaveError=true;renderSaveStatus();return false;});
}
function renderSaveStatus() {
  if(state.inPlaceEdit){$('save-status').textContent='Object draft · Apply to save';return;}
  const document=state.documents.get(state.documentId);
  if (!state.storageAvailable || state.sessionSaveError || document?.saveError) $('save-status').textContent='Export data to keep your work';
  else if (document && document.savedRevision!==document.revision) $('save-status').innerHTML='<i></i> Saving…';
  else $('save-status').innerHTML='<i></i> Saved on this device';
}
function revealActiveTab() {
  const tabList=$('project-tabs'),selected=tabList.querySelector('[aria-selected="true"]');
  if(!selected)return;
  const tab=selected.getBoundingClientRect(),list=tabList.getBoundingClientRect();
  if(tab.left<list.left)tabList.scrollLeft+=tab.left-list.left;
  else if(tab.right>list.right)tabList.scrollLeft+=tab.right-list.right;
}
function renderProjectTabs() {
  syncDocument();
  const tabList=$('project-tabs'), scroll=tabList.scrollLeft;
  tabList.innerHTML=state.openIds.map(id=>{
    const document=state.documents.get(id),active=id===state.documentId;
    const safeId=escapeHTML(id);
    return `<div class="project-tab${active?' active':''}" role="presentation"><button class="project-tab-select" id="project-tab-${safeId}" role="tab" aria-controls="workbench" aria-selected="${active}" tabindex="${active?0:-1}" data-document="${safeId}" title="${escapeHTML(document.project.name)}"><span class="project-tab-name">${escapeHTML(document.project.name)}</span></button><button class="project-tab-close" data-close-document="${safeId}" title="Close tab · keep saved on this device" aria-label="Close ${escapeHTML(document.project.name)}">${icon('close')}</button></div>`;
  }).join('');
  tabList.scrollLeft=scroll;
  if (renderedDocumentId!==state.documentId) {
    revealActiveTab();
    renderedDocumentId=state.documentId;
  }
  tabList.querySelectorAll('[data-document]').forEach(button=>button.onclick=()=>{switchDocument(button.dataset.document);$(`project-tab-${state.documentId}`)?.focus({preventScroll:true});});
  tabList.querySelectorAll('[data-close-document]').forEach(button=>button.onclick=()=>closeDocument(button.dataset.closeDocument));
  $('workbench').setAttribute('aria-labelledby',`project-tab-${state.documentId}`);
}
async function closeDocument(id) {
  finishDrawing(); syncDocument();
  const document=state.documents.get(id);
  if (!document || document.closing) return;
  document.closing=true;
  const revision=document.revision;
  const saved=await persistDocument(document);
  document.closing=false;
  if (!saved || !projectStore.available) {toast('This project could not be saved. Export its data before closing.');return;}
  if (id===state.documentId) {finishDrawing();syncDocument();}
  if (revision!==document.revision) {toast('The project changed while saving. Close the tab again to keep the latest changes.');return;}
  const index=state.openIds.indexOf(id),wasActive=id===state.documentId;
  state.openIds=state.openIds.filter(openId=>openId!==id);
  state.documents.delete(id);
  if (!state.openIds.length) {
    const fresh=makeDocument(blankProject('Untitled sprite'));
    state.documents.set(fresh.id,fresh);state.openIds.push(fresh.id);activateDocument(fresh.id);scheduleSave();saveNow();
  } else if (wasActive) activateDocument(state.openIds[Math.min(index,state.openIds.length-1)]);
  else renderProjectTabs();
  persistSession(); toast('Tab closed. Reopen it from Saved projects.');
}
async function savedProjectsDialog() {
  await saveNow();
  openDialog('Your saved projects','<p class="modal-body-text">Loading projects saved on this device…</p>','PROJECTS');
  try {
    const documents=await projectStore.listDocuments();
    if (!$('modal').open || $('modal-title').textContent!=='Your saved projects') return;
    $('modal-content').innerHTML=`<p class="modal-body-text">Projects stay on this device when you close their tabs. Export pixel data to take a backup or move to another device.</p><div class="saved-project-list">${documents.length?documents.map(document=>`<button class="saved-project-row" data-saved-document="${escapeHTML(document.id)}"><span><strong>${escapeHTML(document.name)}</strong><small>${document.width} × ${document.height} · ${document.animationCount} animation${document.animationCount===1?'':'s'} · ${document.frameCount} frame${document.frameCount===1?'':'s'}</small></span><span>${state.openIds.includes(document.id)?'Switch to tab':'Open project'}</span>${icon('chevron')}</button>`).join(''):'<p class="helper-text">Your first project will appear here after it saves.</p>'}</div>`;
    $('modal-content').querySelectorAll('[data-saved-document]').forEach(button=>button.onclick=async()=>{
      const id=button.dataset.savedDocument;
      button.disabled=true;
      try {
        if (!state.documents.has(id)) {
          const saved=await projectStore.getDocument(id);
          if (!saved) throw new Error('This saved project could not be read. Import a pixel data backup.');
          if (!state.documents.has(id)) {
            const document=makeDocument(saved.project,saved);document.savedRevision=0;
            state.documents.set(id,document);state.openIds.push(id);
          }
        }
        switchDocument(id);$('modal').close();persistSession();
      } catch(error) {button.disabled=false;toast(error.message);}
    });
  } catch { $('modal-content').innerHTML='<p class="modal-body-text">Saved projects are unavailable in this browser. Keep your work by exporting pixel data.</p>'; }
}
function renderPanelState() {
  for (const [name,id] of [['tools','toggle-tools-panel'],['details','toggle-details-panel']]) {
    $('workbench').classList.toggle(`${name}-collapsed`,state.panels[name]);
    $(id).setAttribute('aria-expanded',String(!state.panels[name]));
    $(id).classList.toggle('active',!state.panels[name]);
    $(id).title=`${state.panels[name]?'Show':'Hide'} ${name==='tools'?'toolbox':'animation and object panels'}`;
  }
}
function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3800);
}
function scheduleSave() {
  clearTimeout(state.saveTimer);
  const document=syncDocument();
  if(document) document.revision++;
  renderSaveStatus();
  state.saveTimer = setTimeout(saveNow, 300);
}
function persistDocument(document) {
  if (!projectStore || !document) return Promise.resolve(false);
  const revision=document.revision;
  const record={id:document.id,project:clone(document.project),animationId:document.animationId,frameId:document.frameId,layerId:document.layerId,objectSelection:document.objectSelection,updatedAt:Date.now()};
  return queueSave(()=>projectStore.saveDocument(record)).then(()=>{
    document.savedRevision=revision;document.saveError=false;state.storageAvailable=projectStore.available;renderSaveStatus();return true;
  }).catch(()=>{document.saveError=true;state.storageAvailable=projectStore.available;renderSaveStatus();return false;});
}
async function saveNow() {
  clearTimeout(state.saveTimer);
  const document=syncDocument();
  const saved=await persistDocument(document);
  if(saved) await persistSession();
  return saved;
}

function paintSprite(canvas, pixels, palette, background = false, width = state.project.width, height = state.project.height) {
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = false;
  if (background) {
    for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) {
      context.fillStyle = ((x + y) / 2) % 2 ? '#e7ebe4' : '#f3f5ef';
      context.fillRect(x, y, 2, 2);
    }
  }
  pixels.forEach((color, index) => {
    if (color < 0) return;
    context.fillStyle = palette[color];
    context.fillRect(index % width, Math.floor(index / width), 1, 1);
  });
}

function canvasPixels() { return state.inPlaceEdit?previewInPlaceEdit(state.inPlaceEdit.session):compositeFrame(state.project,currentFrame()); }
function renderCanvas() {
  const canvas = $('pixel-canvas');
  const width = state.project.width, height = state.project.height;
  const canvasWidth = width * state.scale, canvasHeight = height * state.scale;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(canvasWidth * ratio) || canvas.height !== Math.round(canvasHeight * ratio)) {
    canvas.width = Math.round(canvasWidth * ratio);
    canvas.height = Math.round(canvasHeight * ratio);
  }
  canvas.style.width = `${canvasWidth}px`;
  canvas.style.height = `${canvasHeight}px`;
  canvas.setAttribute('aria-label',`${width} by ${height} pixel drawing canvas. Choose a drawing tool and drag to draw.`);
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, canvasWidth, canvasHeight);
  for (let y = 0; y < height; y += 2) for (let x = 0; x < width; x += 2) {
    context.fillStyle = ((x + y) / 2) % 2 ? '#e4e9e1' : '#f2f4ed';
    context.fillRect(x * state.scale, y * state.scale, 2 * state.scale, 2 * state.scale);
  }
  const drawPixels = (pixels) => pixels.forEach((color, index) => {
    if (color < 0) return;
    context.fillStyle = state.project.palette[color];
    context.fillRect((index % width) * state.scale, Math.floor(index / width) * state.scale, state.scale, state.scale);
  });
  const animation = currentAnimation();
  if (!state.inPlaceEdit && state.onion && animation.frames.length > 1) {
    const index = animation.frames.findIndex(f => f.id === state.frameId);
    context.globalAlpha = 0.23;
    drawPixels(compositeFrame(state.project,animation.frames[(index - 1 + animation.frames.length) % animation.frames.length]));
    context.globalAlpha = 1;
  }
  drawPixels(canvasPixels());
  if(state.inPlaceEdit) {
    const {session}=state.inPlaceEdit, outline=inPlaceCanvasRect(session);
    const x=Math.max(0,outline.x),y=Math.max(0,outline.y);
    const right=Math.min(width,outline.x+outline.width),bottom=Math.min(height,outline.y+outline.height);
    context.fillStyle='#fffefb88';
    context.fillRect(0,0,canvasWidth,y*state.scale);context.fillRect(0,bottom*state.scale,canvasWidth,canvasHeight-bottom*state.scale);
    context.fillRect(0,y*state.scale,x*state.scale,(bottom-y)*state.scale);context.fillRect(right*state.scale,y*state.scale,canvasWidth-right*state.scale,(bottom-y)*state.scale);
    context.strokeStyle='#285b47';context.lineWidth=1.5;context.setLineDash([5,3]);
    context.strokeRect(outline.x*state.scale+.75,outline.y*state.scale+.75,outline.width*state.scale-1.5,outline.height*state.scale-1.5);context.setLineDash([]);
    const mode=inPlaceMode(session);
    if(mode!=='plain')drawOriginalCue(context,outline,inPlacePlacement(session),canvasWidth,mode==='baked'?'THIS FRAME, AS DRAWN':'ORIGINAL ARTWORK');
  }
  if (state.grid && state.scale >= 5) {
    context.beginPath();
    context.strokeStyle = '#273d2e18';
    context.lineWidth = 1 / ratio;
    for (let i = 1; i < width; i++) {
      const point = i * state.scale;
      context.moveTo(point, 0); context.lineTo(point, canvasHeight);
    }
    for (let i = 1; i < height; i++) {
      const point = i * state.scale;
      context.moveTo(0, point); context.lineTo(canvasWidth, point);
    }
    context.stroke();
  }
  if (state.symmetry!=='none' && SYMMETRY_TOOLS.includes(state.tool)) {
    context.beginPath();context.strokeStyle='#285b4777';context.lineWidth=1;context.setLineDash([5,5]);
    if (['x','both'].includes(state.symmetry)) {context.moveTo(canvasWidth/2,0);context.lineTo(canvasWidth/2,canvasHeight);}
    if (['y','both'].includes(state.symmetry)) {context.moveTo(0,canvasHeight/2);context.lineTo(canvasWidth,canvasHeight/2);}
    context.stroke();context.setLineDash([]);
  }
  const selectionRect=state.inPlaceEdit?(state.inPlaceEdit.session.selection && inPlaceCanvasRect(state.inPlaceEdit.session,state.inPlaceEdit.session.selection)):state.selection?.rect;
  if (!state.inPlaceEdit && state.selection?.mask) drawMaskOutline(context,state.selection.mask,width);
  else if (selectionRect) {
    const rect=selectionRect, x=rect.x*state.scale, y=rect.y*state.scale, w=rect.width*state.scale, h=rect.height*state.scale;
    context.lineWidth=1.5;
    context.strokeStyle='#ffffff'; context.setLineDash([]); context.strokeRect(x+0.75,y+0.75,w-1.5,h-1.5);
    context.strokeStyle='#285b47'; context.setLineDash([5,4]); context.strokeRect(x+0.75,y+0.75,w-1.5,h-1.5); context.setLineDash([]);
  }
  renderObjectHighlight();
  if (state.cursor && !['select','object','wand'].includes(state.tool)) {
    const tool=state.drawing?.tool || state.tool, sized=BRUSH_TOOLS.includes(tool);
    const from=shiftLineStart(tool);
    const points=brushPoints(from?linePoints(from.x,from.y,state.cursor.x,state.cursor.y):[state.cursor],sized?state.brushSize:1,sized?state.brushShape:'square',width,height,SYMMETRY_TOOLS.includes(tool)?state.symmetry:'none');
    const occupied=new Set(points.map(point=>`${point.x},${point.y}`));
    context.beginPath();
    for (const {x,y} of points) {
      const px=x*state.scale,py=y*state.scale,s=state.scale;
      if(!occupied.has(`${x-1},${y}`)){context.moveTo(px,py);context.lineTo(px,py+s);}
      if(!occupied.has(`${x+1},${y}`)){context.moveTo(px+s,py);context.lineTo(px+s,py+s);}
      if(!occupied.has(`${x},${y-1}`)){context.moveTo(px,py);context.lineTo(px+s,py);}
      if(!occupied.has(`${x},${y+1}`)){context.moveTo(px,py+s);context.lineTo(px+s,py+s);}
    }
    context.strokeStyle='#ffffff';context.lineWidth=3;context.stroke();
    context.strokeStyle='#285b47';context.lineWidth=1;context.stroke();
  }
  drawCanvasOverlay(context);
  drawMotionOverlay(context);
  drawRigOverlay(context);
  renderPivotMarker();
  renderTileGhost();
  $('zoom-value').textContent = `${state.scale * 100}%`;
  $('zoom-out').disabled = state.scale <= 1;
  $('zoom-in').disabled = state.scale >= maxZoom();
  $('resize-canvas').textContent = `${width} × ${height} ↗`;
}
/** Tint the wand selection and trace its edge with a white-and-green dashed outline. */
function drawMaskOutline(context,mask,width) {
  const s=state.scale, set=new Set(mask);
  context.fillStyle='#3d8a6a33';
  context.beginPath();
  for(const index of mask) {
    const x=index%width, y=(index-x)/width, px=x*s, py=y*s;
    context.fillRect(px,py,s,s);
    if(x===0 || !set.has(index-1)){context.moveTo(px,py);context.lineTo(px,py+s);}
    if(x===width-1 || !set.has(index+1)){context.moveTo(px+s,py);context.lineTo(px+s,py+s);}
    if(!set.has(index-width)){context.moveTo(px,py);context.lineTo(px+s,py);}
    if(!set.has(index+width)){context.moveTo(px,py+s);context.lineTo(px+s,py+s);}
  }
  context.lineWidth=1.5;context.strokeStyle='#ffffff';context.setLineDash([]);context.stroke();
  context.strokeStyle='#285b47';context.setLineDash([4,3]);context.stroke();context.setLineDash([]);
}
function placeHighlight(element,bounds) {
  const x=Math.max(0,bounds.x),y=Math.max(0,bounds.y),right=Math.min(state.project.width,bounds.x+bounds.width),bottom=Math.min(state.project.height,bounds.y+bounds.height);
  Object.assign(element.style,{left:`${x*state.scale-2}px`,top:`${y*state.scale-2}px`,width:`${Math.max(1,right-x)*state.scale+4}px`,height:`${Math.max(1,bottom-y)*state.scale+4}px`});
  element.classList.toggle('is-active',['object','resize'].includes(state.tool));
  return y;
}
function visibleObjectBounds(item) {
  const layer=state.project.layers.find(l=>l.id===item.layerId), cel=currentFrame().cels.find(c=>c.layerId===item.layerId);
  const node=cel && celObjects(cel).find(n=>n.key===item.key);
  if(!layer?.visible || node?.instance?.visible===false || (!node && item.key!=='@group'))return null;
  try{return {bounds:objectPixelBounds(state.project,cel,item.key),name:node?.instance?node.name:layer.name};}catch{return null;}
}
/** Bright, animated outline around each selected object; quieter while painting with other tools. */
function renderObjectHighlight() {
  const element=$('object-highlight'), items=state.inPlaceEdit?[]:selectedItems();
  element.parentElement.querySelectorAll('.object-highlight.is-extra').forEach(extra=>extra.remove());
  const primary=items.length?visibleObjectBounds(selectedObject()):null;
  element.hidden=!primary?.bounds;
  renderResizeHandles();
  for(const item of items) {
    if(sameItem(item,state.objectSelection))continue;
    const bounds=visibleObjectBounds(item)?.bounds;
    if(!bounds)continue;
    const extra=document.createElement('div');extra.className='object-highlight is-extra';extra.setAttribute('aria-hidden','true');
    element.after(extra);placeHighlight(extra,bounds);
  }
  if(!primary?.bounds)return;
  const y=placeHighlight(element,primary.bounds);
  element.classList.toggle('label-below',y*state.scale<22);
  $('object-highlight-label').textContent=items.length>1?`${primary.name} +${items.length-1}`:primary.name;
}
/** The selected instance when it can be resized: its node, target, part and on-canvas box. */
function resizableObject() {
  if(state.inPlaceEdit || !state.objectSelection)return null;
  const item=selectedObject(), cel=currentFrame().cels.find(c=>c.layerId===item.layerId), node=cel && celObjects(cel).find(n=>n.key===item.key);
  if(!node?.instance || node.instance.visible===false)return null;
  const part=state.project.parts.find(p=>p.id===node.instance.partId);
  return {item,node,part,target:objectTarget(item.layerId),box:objectBounds(state.project,node)};
}
function renderResizeHandles() {
  const element=$('resize-handles'), object=state.tool==='resize' && resizableObject();
  element.hidden=!object;
  if(!object)return;
  element.classList.toggle('is-rotated',Boolean(object.node.instance.angle || object.node.instance.tilt));
  const {box}=object, s=state.scale;
  Object.assign(element.style,{left:`${box.x*s}px`,top:`${box.y*s}px`,width:`${box.width*s}px`,height:`${box.height*s}px`});
}
function renderResizeOptions() {
  $('object-resize-options').hidden=state.tool!=='resize';
  if(state.tool!=='resize')return;
  $('object-resize-mode').value=state.resizeMode;
  const object=resizableObject();
  const angle=object?object.node.instance.angle || 0:0, count=transformItems().length;
  const tilted=Boolean(object?.node.instance.tilt);
  for(const id of ['object-resize-squash','object-resize-stretch','object-resize-reset'])$(id).disabled=!object || Boolean(angle) || tilted;
  for(const id of ['object-turn-left','object-turn-right','object-flip-x','object-flip-y','object-angle','object-angle-reset'])$(id).disabled=!count;
  if(document.activeElement!==$('object-angle'))$('object-angle').value=String(angle);
  $('object-angle-reset').disabled=!angle && count<2;
  if(!object){$('object-resize-size').textContent=count?`${count} objects · turn, flip and rotate apply to each`:'Click an object to select it.';return;}
  const own=transformedSize({...object.node.instance,width:undefined,height:undefined},object.part), w=own.width, h=own.height;
  const size=transformedSize(object.node.instance,object.part), {width,height}=size, percent=v=>Math.round(v*100);
  $('object-resize-size').textContent=(width===w && height===h?`${width} × ${height} px · original size`:`${width} × ${height} px · ${percent(width/w)}% × ${percent(height/h)}% of ${w} × ${h}`)
    +(angle?` · rotated ${angle}° (reset the angle to resize)`:'')+(tilted?' · 3D turned (make it flat in Object pose to resize)':'')+(count>1?` · ${count} objects selected`:'');
  $('object-resize-reset').disabled=Boolean(angle) || tilted || (width===w && height===h);
}
/** Start dragging a resize handle of the selected object. */
function beginResize(event,handle) {
  if(event.button!==0 || state.drawing)return;
  const object=resizableObject();
  if(!object)return;
  event.preventDefault();event.stopPropagation();
  if(handle==='rotate'){beginRotate(event,object);return;}
  if(handle==='tilt'){beginTilt(event,object);return;}
  const layer=state.project.layers.find(l=>l.id===object.item.layerId);
  if(layer.locked || object.node.instance.locked){toast('Unlock this object or its group before resizing it.');return;}
  $('pixel-canvas').setPointerCapture(event.pointerId);
  state.drawing={tool:'resize',pointerId:event.pointerId,origin:canvasPoint(event),before:snapshot(),target:object.target,key:object.item.key,handle,box:object.box,area:object.part.width*object.part.height};
}
/** Buttons: 1 px squash or stretch keeping the area and the bottom edge, or back to the part's own size. */
function stepResize(kind) {
  const object=resizableObject();
  if(!object){toast('Select an object to resize.');return;}
  const {box,part,node}=object;
  let next;
  if(kind==='reset') {
    const {width,height}=transformedSize({...node.instance,width:undefined,height:undefined},part);
    next={x:box.x+Math.floor((box.width-width)/2),y:box.y+box.height-height,width,height};
  } else next=resizeBox(box,'n',0,kind==='squash'?1:-1,{keepArea:true,area:part.width*part.height});
  try{mutate(()=>{state.project=resizeObject(state.project,object.target,object.item.key,next,state.objectScope);});renderAll();}
  catch(error){toast(error.message);}
}
/** Placed objects among the selection, which turn, flip and rotate apply to. */
function transformItems() {
  if(state.inPlaceEdit)return [];
  const frame=currentFrame();
  return selectedItems().filter(item=>celObjects(frame.cels.find(c=>c.layerId===item.layerId)).find(n=>n.key===item.key)?.instance);
}
/** Lossless quarter turn or flip of every selected placed object, each about its own centre. */
function turnSelection(turn,items=transformItems()) {
  finishDrawing();
  if(!items.length){toast('Select an object to turn or flip.');return;}
  try{mutate(()=>{state.project=turnObjects(state.project,objectTarget(),items,turn,state.objectScope);});}
  catch(error){toast(error.message);}
}
/** Set the free angle of the primary object (others turn by the same amount); 0 also resets every selected object. */
function setObjectAngle(angle) {
  finishDrawing();
  const items=transformItems(), object=resizableObject();
  if(!items.length || !Number.isFinite(angle))return;
  try{mutate(()=>{
    if(angle===0)for(const item of items){const op=celObjects(currentFrame().cels.find(c=>c.layerId===item.layerId)).find(n=>n.key===item.key).instance;if(op.angle)state.project=rotateObjects(state.project,objectTarget(),[item],-op.angle,state.objectScope);}
    else state.project=rotateObjects(state.project,objectTarget(),items,Math.round(angle)-(object?.node.instance.angle || 0),state.objectScope);
  });}catch(error){toast(error.message);}
}
/** Canvas coordinates with sub-pixel precision, for rotation. */
function canvasPosition(event) {
  const rect=$('pixel-canvas').getBoundingClientRect();
  return {x:(event.clientX-rect.left)/rect.width*state.project.width,y:(event.clientY-rect.top)/rect.height*state.project.height};
}
function beginRotate(event,object) {
  if(document.activeElement===$('object-angle'))$('object-angle').blur();
  const items=transformItems(), op=object.node.instance;
  const centre=instancePivot(op,object.part), at=canvasPosition(event);
  $('pixel-canvas').setPointerCapture(event.pointerId);
  state.drawing={tool:'rotate',pointerId:event.pointerId,before:snapshot(),items:items.length?items:[object.item],target:object.target,centre,start:Math.atan2(at.y-centre.y,at.x-centre.x),startAngle:op.angle || 0};
}
/** Drag the 3D turn handle: sideways turns about the Y axis, up or down tips about the X axis (the larger movement wins). */
function beginTilt(event,object) {
  const items=transformItems(), tilt=object.node.instance.tilt;
  $('pixel-canvas').setPointerCapture(event.pointerId);
  state.drawing={tool:'tilt',pointerId:event.pointerId,before:snapshot(),items:items.length?items:[object.item],target:object.target,origin:{x:event.clientX,y:event.clientY},start:{x:tilt?.x || 0,y:tilt?.y || 0}};
}
function moveTilt(drawing,event) {
  const dx=event.clientX-drawing.origin.x, dy=event.clientY-drawing.origin.y, sideways=Math.abs(dx)>=Math.abs(dy);
  // One degree per screen pixel; dragging the front down brings the top toward you (negative tip).
  let delta=sideways?{x:0,y:Math.round(dx)}:{x:-Math.round(dy),y:0};
  if(event.shiftKey){const axis=sideways?'y':'x';delta[axis]=Math.round((drawing.start[axis]+delta[axis])/15)*15-drawing.start[axis];}
  try{state.project=tiltObjects(drawing.before.project,drawing.target,drawing.items,delta,state.objectScope);renderResizeOptions();}
  catch(error){$('cursor-position').textContent=error.message;}
  const now=delta.x+drawing.start.x, turn=delta.y+drawing.start.y, wrap=v=>((((v%360)+540)%360)-180) || 0;
  $('cursor-position').textContent=sideways?`Turn ↔ ${wrap(turn)}°`:`Tip ↕ ${wrap(now)}°`;
}
/** Start of a Shift+click straight line: where the last pencil or eraser stroke ended. */
function shiftLineStart(tool=state.tool) {
  return state.shiftHeld && !state.drawing && FREEHAND_TOOLS.includes(tool) && state.lastPaint?.documentId===state.documentId ? state.lastPaint : null;
}
function renderTools() {
  document.querySelectorAll('[data-tool]').forEach(button => {
    const active = button.dataset.tool === state.tool;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active);
  });
  const sized=BRUSH_TOOLS.includes(state.tool), shaped=['rectangle','ellipse'].includes(state.tool);
  $('active-tool-name').textContent=TOOL_NAMES[state.tool];
  $('tool-hint').textContent=state.inPlaceEdit?(state.tool==='shade'?TOOL_HINTS.shade:state.tool==='select'?'Select pixels inside the object. Drag the selection to move it; Ctrl/⌘ C, X, V and Delete work on the draft.':'Draw inside or beyond the outline: painting past an edge extends the object. Shift-click draws a straight line. Esc cancels.'):TOOL_HINTS[state.tool];
  $('brush-options').hidden=!sized;
  $('filled-row').hidden=!shaped;
  $('symmetry-options').hidden=!SYMMETRY_TOOLS.includes(state.tool);
  $('pixel-perfect-row').hidden=state.tool!=='pencil' || Boolean(state.inPlaceEdit);
  $('pixel-perfect').checked=state.pixelPerfect;
  $('wand-options').hidden=state.tool!=='wand';
  $('wand-mode').value=state.wandMode;
  renderResizeOptions();
  $('brush-size').value=String(state.brushSize);
  $('brush-shape').value=state.brushShape;
  $('symmetry-mode').value=state.symmetry;
  $('filled-shape').checked=state.filled;
  renderToolExtras();
  const everyFrame=state.objectScope==='animation' && currentAnimation().frames.length>1 && (PAINT_TOOLS.includes(state.tool) || ['object','resize','gradient'].includes(state.tool));
  $('tool-status').textContent = TOOL_NAMES[state.tool] + (sized?` · ${state.brushSize}px`:'') + (state.filled && shaped ? ' · filled' : '') + (state.tool==='gradient'?` · ${gradientStatus()}`:'') + (state.tileMode?' · tile':'') + (everyFrame?' · all frames':'');
  for (const [id, active] of [['toggle-grid',state.grid],['toggle-onion',state.onion]]) {
    $(id).classList.toggle('active', active);
    $(id).setAttribute('aria-pressed', active);
  }
  $('undo').disabled = !(state.inPlaceEdit?state.inPlaceEdit.session.undo:state.undo).length;
  $('redo').disabled = !(state.inPlaceEdit?state.inPlaceEdit.session.redo:state.redo).length;
  $('pixel-canvas').style.cursor = state.tool === 'eyedropper' ? 'copy' : currentLayer().locked || !currentLayer().visible ? 'not-allowed' : state.tool==='select' && (state.inPlaceEdit?state.inPlaceEdit.session.selection:state.selection) ? 'grab' : state.tool==='wand' ? 'cell' : 'crosshair';
  renderTransformControls();
  renderInPlaceControls();
}
function selectColor(index) {
  if (state.swap && index >= 0) {
    if (state.swapFirst === null) {
      state.swapFirst = index;
      renderPalette();
      return;
    }
    if (state.swapFirst === index) { state.swapFirst = null; renderPalette(); return; }
    const first = state.swapFirst;
    mutate(() => {
      [state.project.palette[first], state.project.palette[index]] = [state.project.palette[index], state.project.palette[first]];
      state.swap = false;
      state.swapFirst = null;
      state.color = index;
    });
    toast('Colors swapped across every animation.');
    return;
  }
  state.color = index;
  if (state.tool === 'eraser' || state.tool === 'eyedropper') state.tool = 'pencil';
  renderPalette();
  renderTools();
}
function renderPalette() {
  const palette = state.project.palette;
  $('palette-count').textContent = palette.length;
  $('palette-grid').innerHTML = palette.map((color, index) => `<button class="swatch${state.color === index ? ' selected' : ''}${state.swap && state.swapFirst === index ? ' swap-target' : ''}" style="--swatch:${color}" title="Color ${index + 1}: ${color.toUpperCase()}" aria-label="Color ${index + 1}: ${color.toUpperCase()}" aria-pressed="${state.color === index}" data-color="${index}"></button>`).join('') + `<button class="swatch transparent${state.color === -1 ? ' selected' : ''}" data-color="-1" title="Transparent" aria-label="Transparent" aria-pressed="${state.color === -1}"><span>∕</span></button>`;
  $('palette-grid').querySelectorAll('[data-color]').forEach(button => button.addEventListener('click', () => selectColor(Number(button.dataset.color))));
  const color = palette[state.color];
  $('color-picker').disabled = !color;
  $('hex-color').disabled = !color;
  $('color-picker').value = color || '#ffffff';
  $('hex-color').value = color ? color.toUpperCase() : 'CLEAR';
  $('color-slot').textContent = color ? `${state.color + 1}`.padStart(2, '0') : '—';
  $('swap-colors').classList.toggle('active', state.swap);
  $('swap-colors').setAttribute('aria-pressed', state.swap);
  $('add-color').disabled = palette.length >= MAX_COLORS;
  $('palette-help').textContent = state.swap ? (state.swapFirst === null ? 'Choose the first color to swap.' : 'Now choose the second color.') : 'Edit a color to update it in every frame. Right-click a swatch for more.';
}
function editColor(value) {
  if (state.color < 0) return;
  let normalized = value.trim();
  if (!normalized.startsWith('#')) normalized = `#${normalized}`;
  if (!/^#[0-9a-f]{6}$/i.test(normalized)) { toast('Use a six-digit hex color, like #285B47.'); renderPalette(); return; }
  mutate(() => { state.project.palette[state.color] = normalized.toLowerCase(); });
}
function selectFrameAt(index) {
  const frames = currentAnimation().frames;
  if (!frames.length) return;
  finishDrawing();
  const i = (index + frames.length) % frames.length;
  state.frameId = frames[i].id; state.previewIndex = i; state.previewTime = 0;
  renderAll(); scheduleSave();
}
/** Compact thumbnails shown in the minimised Frames bar; reuses the full cards' painted canvases. */
function renderMiniFrames(animation, selectedIndex) {
  const strip = $('frame-mini-strip'), cards = $('frame-list').querySelectorAll('canvas');
  strip.innerHTML = animation.frames.map((frame, index) => `<button type="button" class="frame-mini${index === selectedIndex ? ' selected' : ''}" data-index="${index}" aria-label="Frame ${index + 1}" aria-pressed="${index === selectedIndex}" title="Frame ${index + 1} · ${frame.duration} ms"><canvas width="32" height="32"></canvas></button>`).join('');
  strip.querySelectorAll('.frame-mini').forEach((button, index) => {
    if (cards[index]) button.querySelector('canvas').getContext('2d').drawImage(cards[index], 0, 0);
    button.onclick = () => selectFrameAt(index);
  });
  $('frame-mini-position').textContent = `${selectedIndex + 1} / ${animation.frames.length}`;
  $('mini-prev-frame').disabled = $('mini-next-frame').disabled = animation.frames.length < 2;
  strip.querySelector('.selected')?.scrollIntoView({block:'nearest',inline:'nearest'});
}
function renderTimeline() {
  const animation = currentAnimation();
  const selectedIndex = animation.frames.findIndex(f => f.id === state.frameId);
  const scroll = $('frame-list').scrollLeft;
  $('frame-count').textContent = animation.frames.length;
  $('animation-name-label').textContent = `${animation.name} animation`;
  $('frame-position').textContent = `Frame ${selectedIndex + 1} of ${animation.frames.length}`;
  $('frame-list').innerHTML = animation.frames.map((frame, index) => `<button class="frame-card${frame.id === state.frameId ? ' selected' : ''}" data-frame="${escapeHTML(frame.id)}" aria-label="Select frame ${index + 1}" aria-pressed="${frame.id === state.frameId}"><canvas width="32" height="32"></canvas><span class="frame-number">${String(index + 1).padStart(2,'0')}</span><span class="frame-duration-label">${frame.duration} ms</span><span class="frame-marker"></span></button>`).join('');
  $('frame-list').querySelectorAll('[data-frame]').forEach((button, index) => {
    paintSprite(button.querySelector('canvas'), compositeFrame(state.project,animation.frames[index]), state.project.palette, true);
    button.addEventListener('click', () => {
      finishDrawing();
      state.frameId = button.dataset.frame;
      state.previewIndex = index;
      state.previewTime = 0;
      renderAll();
      scheduleSave();
    });
  });
  $('frame-list').scrollLeft = scroll;
  renderMiniFrames(animation, selectedIndex);
  $('delete-frame').disabled = animation.frames.length <= 1;
  $('move-frame-left').disabled = selectedIndex <= 0;
  $('move-frame-right').disabled = selectedIndex >= animation.frames.length - 1;
  $('add-frame').disabled = !canAddFrame();
  $('duplicate-frame').disabled = !canAddFrame();
  if(document.activeElement!==$('frame-duration')) $('frame-duration').value=currentFrame().duration;
}
function selectAnimation(id) {
  if (state.inPlaceEdit || id === state.animationId || !state.project.animations.some(a => a.id === id)) return;
  finishDrawing();
  state.animationId = id;
  state.frameId = currentAnimation().frames[0].id;
  state.previewIndex = 0;
  state.previewTime = 0;
  renderAll();
  scheduleSave();
}
function stepAnimation(delta) {
  const list = state.project.animations, index = list.findIndex(a => a.id === state.animationId);
  selectAnimation(list[(index + delta + list.length) % list.length].id);
}
function renderPreviewAnimations() {
  const list = state.project.animations, select = $('preview-animation');
  const options = list.map(a => `<option value="${escapeHTML(a.id)}">${escapeHTML(a.name)} · ${a.frames.length}f</option>`).join('');
  if (select.innerHTML !== options) select.innerHTML = options;
  select.value = state.animationId;
  const locked = Boolean(state.inPlaceEdit);
  select.disabled = locked || list.length < 2;
  $('preview-prev-animation').disabled = $('preview-next-animation').disabled = locked || list.length < 2;
}
function renderAnimations() {
  renderPreviewAnimations();
  $('animation-count').textContent = state.project.animations.length;
  $('animation-list').innerHTML = state.project.animations.map(animation => `<div class="animation-item${animation.id === state.animationId ? ' selected' : ''}" data-animation="${escapeHTML(animation.id)}"><button class="animation-select" aria-label="Select ${escapeHTML(animation.name)} animation" aria-pressed="${animation.id === state.animationId}"><span class="animation-dot"></span><span class="animation-label">${escapeHTML(animation.name)}</span><span class="animation-meta">${animation.frames.length}f</span></button><button class="icon-button mini animation-rename" title="Rename animation" aria-label="Rename ${escapeHTML(animation.name)} animation">${icon('pencil')}</button><button class="icon-button mini animation-delete" title="Delete animation" aria-label="Delete ${escapeHTML(animation.name)} animation"${state.project.animations.length <= 1 ? ' disabled' : ''}>${icon('trash')}</button></div>`).join('');
  $('animation-list').querySelectorAll('[data-animation]').forEach(item => {
    const id = item.dataset.animation;
    item.querySelector('.animation-select').addEventListener('click', () => selectAnimation(id));
    item.querySelector('.animation-rename').addEventListener('click', () => animationDialog(id));
    item.querySelector('.animation-delete').addEventListener('click', () => {
      if (state.project.animations.length <= 1) return;
      mutate(() => {
        state.project.animations = state.project.animations.filter(a => a.id !== id);
        normalizeSelection();
      });
      toast('Animation removed. Undo is available.');
    });
  });
  $('fps-input').value = currentAnimation().fps;
  $('add-animation').disabled = state.project.animations.length >= 100 || !hasFrameCapacity();
  $('duplicate-animation').disabled=!canDuplicateAnimation();
  $('mirror-animation').disabled=!canDuplicateAnimation();
  $('reverse-animation').disabled=currentAnimation().frames.length<2;
}
function selectedObject() {
  const layer=currentLayer(), children=celObjects(currentFrame().cels.find(c=>c.layerId===layer.id));
  return state.objectSelection || {layerId:layer.id,key:layer.group!==false?'@group':children.at(-1).key};
}
function sameItem(a,b) { return Boolean(a && b) && a.layerId===b.layerId && a.key===b.key; }
/** Every selected object, bottom to top: the primary selection plus Shift/Ctrl/⌘-clicked extras from any layer. */
function selectedItems() {
  const primary=state.objectSelection, multi=state.objectMulti;
  if(!primary)return [];
  return multi && sameItem(multi.anchor,primary)?multi.items:[primary];
}
/** The objects an action on `item` applies to: the whole multi-selection when it includes `item`. */
function itemsFor(item) {
  const items=selectedItems();
  return items.length>1 && items.some(i=>sameItem(i,item))?items:[item];
}
function setObjectSelection(items,primary=items.at(-1)) {
  state.layerId=primary.layerId;state.objectSelection={layerId:primary.layerId,key:primary.key};
  state.objectMulti=items.length>1?{anchor:{...state.objectSelection},items:items.map(i=>({layerId:i.layerId,key:i.key}))}:null;
}
/** Shift/Ctrl/⌘-click adds an object to the selection, or takes it out again. */
function toggleObjectItem(item) {
  finishDrawing();
  const current=selectedItems(), has=current.some(i=>sameItem(i,item));
  const items=has?current.filter(i=>!sameItem(i,item)):[...current,{layerId:item.layerId,key:item.key}];
  state.selection=null;
  if(!items.length){state.objectSelection=null;state.objectMulti=null;}
  else setObjectSelection(items,!has?item:sameItem(state.objectSelection,item)?items.at(-1):state.objectSelection);
  if(!['object','resize'].includes(state.tool))state.tool='object';
  normalizeSelection();renderAll();
}
/** Ctrl/⌘+A with the object tools: every object in this frame. */
function selectAllObjects() {
  const items=frameObjects(state.project,currentAnimation(),currentFrame()).flatMap(({layer,children})=>children.filter(n=>n.type!=='overrides').map(n=>({layerId:layer.id,key:n.key})));
  if(!items.length)return;
  finishDrawing();state.selection=null;setObjectSelection(items);renderAll();
  toast(`${items.length} object${items.length===1?'':'s'} selected.`);
}
function objectTarget(layerId=currentLayer().id) { return {animationId:currentAnimation().id,frameId:currentFrame().id,layerId}; }
function selectObject(item) {
  finishDrawing();state.layerId=item.layerId;state.objectSelection={layerId:item.layerId,key:item.key};state.objectMulti=null;state.selection=null;
  if((item.node?.instance || item.type==='instance' || item.key==='@group') && state.tool!=='resize')state.tool='object';
  normalizeSelection();renderAll();scheduleSave();
}
function renderLayers() {
  renderObjectsPanel({project:state.project,animation:currentAnimation(),frame:currentFrame(),selected:selectedObject(),selection:selectedItems(),scope:state.objectScope,collapsed:state.collapsedGroups,
    canPaste:Boolean(state.objectClipboard),onSelect:(item,additive)=>additive?toggleObjectItem(item):selectObject(item),onAction:objectAction,onDrop:dropObjectRow,paint:paintSprite});
  const selected=selectedObject(), node=celObjects(currentFrame().cels.find(c=>c.layerId===selected.layerId)).find(n=>n.key===selected.key);
  $('active-layer-name').textContent=node?.instance?node.name:currentLayer().name;
  $('active-layer-name').title=node?.instance?'Selected smart object':'Selected pixel object or group';
  // Parts and palette are replaced on every project change, so their identity is a cheap cache key.
  if(partsStripKey.parts!==state.project.parts || partsStripKey.palette!==state.project.palette) {
    partsStripKey={parts:state.project.parts,palette:state.project.palette};
    renderPartsStrip({project:state.project,paint:paintSprite,onOpen:id=>partLibrary(id),onPlace:id=>{try{placePartAt(id);}catch(error){toast(error.message);}}});
  }
}
let partsStripKey={};
function editSharedObject(item) {
  finishDrawing();
  const cel=currentFrame().cels.find(c=>c.layerId===item.layerId), op=cel.source?.ops.find(op=>op.type==='use' && op.id===item.key);
  if(!op)return;
  beginCanvasPartEdit(item,op.partId);
}
function beginCanvasPartEdit(item,partId) {
  if(state.inPlaceEdit)return;
  try {
    const session=createInPlaceEdit(state.project,{...objectTarget(item.layerId),instanceId:item.key},state.objectScope==='frame'?'frame':'shared');
    const bounds=objectBounds(state.project,{type:'instance',instance:session.instance});
    if(bounds.x>=state.project.width || bounds.y>=state.project.height || bounds.x+bounds.width<=0 || bounds.y+bounds.height<=0)throw new Error('Move this object onto the canvas or use the isolated editor.');
    const edit={session,documentId:state.documentId,revision:state.documents.get(state.documentId)?.revision,previousTool:state.tool,previousPlaying:state.playing,inert:new Map(),disabled:new Map(),error:null};
    state.inPlaceEdit=edit;state.tool='pencil';state.playing=false;state.selection=null;state.swap=false;state.swapFirst=null;
    state.cursor={x:Math.max(0,Math.min(state.project.width-1,bounds.x)),y:Math.max(0,Math.min(state.project.height-1,bounds.y))};
    for(const element of document.querySelectorAll('.app-header,#project-tabs,#new-project-tab,#open-saved-projects,#details-panel,.timeline,.transform-section,.account-section,.left-bottom,.floating-panel[data-home="details-panel"],.panel-splitter')) {
      edit.inert.set(element,element.inert);element.inert=true;
    }
    for(const element of document.querySelectorAll('[data-tool="object"],[data-tool="resize"],[data-tool="wand"],#make-object,#magic-outline,#resize-canvas,#toggle-onion,#color-picker,#hex-color,#add-color,#swap-colors')) {
      edit.disabled.set(element,element.disabled);element.disabled=true;
    }
    renderAll();renderSaveStatus();requestAnimationFrame(()=>{fitCanvas();$('pixel-canvas').focus({preventScroll:true});});
  } catch(error) {toast(error.message);}
}
/** While a rotated/resized object is edited as its original artwork: ghost of its placed pose plus a tag. */
function drawOriginalCue(context,outline,placement,canvasWidth,text) {
  const s=state.scale;
  if(placement) {
  context.save();
  context.translate((placement.x+placement.width/2)*s,(placement.y+placement.height/2)*s);context.rotate(placement.angle*Math.PI/180);
  context.strokeStyle='#ff2d87b0';context.lineWidth=1.5;context.setLineDash([2,4]);
  context.strokeRect(-placement.width*s/2,-placement.height*s/2,placement.width*s,placement.height*s);
  context.restore();
  }
  context.save();context.font='700 10px system-ui, sans-serif';
  const w=context.measureText(text).width+12, h=17;
  const x=Math.max(2,Math.min(canvasWidth-w-2,outline.x*s)), y=outline.y*s>=h+3?outline.y*s-h-3:Math.max(2,outline.y*s+3);
  context.fillStyle='#285b47';context.beginPath();context.roundRect?context.roundRect(x,y,w,h,4):context.rect(x,y,w,h);context.fill();
  context.fillStyle='#fff';context.textBaseline='middle';context.fillText(text,x+6,y+h/2+.5);
  context.restore();
}
function placementSummary(placement) {
  const parts=[];
  if(placement.angle)parts.push(`rotated ${placement.angle}°`);
  if(placement.resized)parts.push(`shown at ${placement.width} × ${placement.height}`);
  return parts.join(' and ');
}
function renderInPlaceControls() {
  const edit=state.inPlaceEdit;
  $('in-place-actions').hidden=!edit;
  $('workbench').classList.toggle('in-place-active',Boolean(edit));
  if(!edit)return;
  const {session}=edit,dirty=inPlaceDirty(session),restriction=inPlaceRestriction(session);
  for(const element of edit.disabled.keys())element.disabled=true;
  const animation=currentAnimation(),frameIndex=animation.frames.findIndex(f=>f.id===state.frameId);
  const placement=inPlacePlacement(session), mode=inPlaceMode(session), pose=placementSummary({...session.placed,...transformedSize(session.placed,session.images.get(session.partId)),angle:session.placed.angle || 0,resized:session.placed.width!==undefined || session.placed.height!==undefined});
  $('in-place-name').textContent=`${{original:'Editing original artwork of',baked:'Fixing pixels of'}[mode] || 'Editing'} ${session.partId} · ${animation.name}, frame ${frameIndex+1}`;
  const impact=session.scope==='shared'?`Updates all ${session.references.length} instance${session.references.length===1?'':'s'}.`:'Only this placement changes; other frames keep their artwork.';
  const note=mode==='original'?` Shown unrotated at its own size; in this frame it is ${placementSummary(placement)} (pink outline), which is kept. Choose “This frame only” to fix the pixels as drawn.`
    :mode==='baked'?` You edit the pixels exactly as this frame draws them (${pose}). Applying bakes them into this placement: it becomes its own artwork at 0°, other frames keep theirs.`:'';
  const text=`${mode==='baked'?'':impact}${note} ${dirty?'Unsaved draft.':'Draw inside the outline.'}`.trim();
  if($('in-place-impact').textContent!==text)$('in-place-impact').textContent=text;
  renderEditScope();
  $('in-place-apply').textContent=session.scope==='shared'?`Apply to ${session.references.length} instance${session.references.length===1?'':'s'}`:'Apply to this frame';
  $('in-place-apply').disabled=Boolean(restriction || !dirty || state.drawing);
  const error=restriction || edit.error;
  $('in-place-error').hidden=!error;
  if($('in-place-error').textContent!==(error || ''))$('in-place-error').textContent=error || '';
}
function restoreCanvasPartEdit(redo=false) {
  finishDrawing();restoreInPlace(state.inPlaceEdit.session,redo);state.inPlaceEdit.error=null;
  renderTools();renderCanvas();renderPreview();
}
function endCanvasPartEdit(apply) {
  if(!state.inPlaceEdit)return;
  finishDrawing();const edit=state.inPlaceEdit;
  let project;
  try {
    if(apply) {
      if(state.documentId!==edit.documentId || state.documents.get(edit.documentId)?.revision!==edit.revision || JSON.stringify(state.project)!==JSON.stringify(edit.session.sourceProject))throw new Error('The project changed. Cancel this draft and reopen the object.');
      project=prepareInPlaceEdit(edit.session);
    }
  } catch(error) {edit.error=error.message;renderInPlaceControls();return;}
  for(const [element,inert] of edit.inert)element.inert=inert;
  for(const [element,disabled] of edit.disabled)element.disabled=disabled;
  state.inPlaceEdit=null;state.tool=edit.previousTool;state.playing=edit.previousPlaying;state.previewTime=0;
  if(project)mutate(()=>{state.project=project;});else renderAll();
  renderSaveStatus();requestAnimationFrame(fitCanvas);
  if(apply)toast(edit.session.scope==='shared'?'Shared artwork updated. Undo restores the whole edit.':'This frame’s object updated. Other appearances are unchanged.');
}
function canvasPartKey(event,key) {
  const session=state.inPlaceEdit.session, command=event.ctrlKey || event.metaKey;
  if(command && key==='a'){event.preventDefault();selectAllPixels();return;}
  if(command && key==='c' && session.selection){event.preventDefault();copySelectionPixels();return;}
  if(command && key==='x' && session.selection){event.preventDefault();copySelectionPixels(true);return;}
  if(command && key==='v' && state.clipboard){event.preventDefault();pasteClipboardPixels();return;}
  if(!command && state.tool==='select' && session.selection) {
    const nudge={arrowleft:[-1,0],arrowright:[1,0],arrowup:[0,-1],arrowdown:[0,1]}[key];
    if(nudge){event.preventDefault();const step=event.shiftKey?8:1;inPlaceSelectionChange(s=>nudgeInPlaceSelection(s,nudge[0]*step,nudge[1]*step));return;}
    if(key==='delete' || key==='backspace'){event.preventDefault();clearSelectionPixels();return;}
    if(key==='escape' || key==='enter'){event.preventDefault();deselectPixels();return;}
  }
  if((event.ctrlKey || event.metaKey) && key==='z'){event.preventDefault();restoreCanvasPartEdit(event.shiftKey);return;}
  if((event.ctrlKey || event.metaKey) && key==='y'){event.preventDefault();restoreCanvasPartEdit(true);return;}
  if((event.ctrlKey || event.metaKey) && key==='enter'){event.preventDefault();endCanvasPartEdit(true);return;}
  if(key==='escape'){event.preventDefault();endCanvasPartEdit(false);return;}
  if(event.ctrlKey || event.metaKey){event.preventDefault();return;}
  const tool={b:'pencil',e:'eraser',l:'line',f:'fill',u:'replace',i:'eyedropper',r:'rectangle',c:'ellipse',s:'select',t:'dither',h:'shade'}[key];
  if(tool){event.preventDefault();state.tool=tool;renderTools();renderSelection();renderCanvas();return;}
  if(key==='g'){$('toggle-grid').click();return;}
  const move={arrowleft:[-1,0],arrowright:[1,0],arrowup:[0,-1],arrowdown:[0,1]}[key];
  if(move) {
    event.preventDefault();const cursor=state.cursor || {x:0,y:0};
    state.cursor={x:Math.max(0,Math.min(state.project.width-1,cursor.x+move[0])),y:Math.max(0,Math.min(state.project.height-1,cursor.y+move[1]))};renderCanvas();return;
  }
  if(key===' ' && !event.target.closest('button,a')) {
    event.preventDefault();if(state.tool==='eyedropper'){state.color=canvasPixels()[(state.cursor?.y || 0)*state.project.width+(state.cursor?.x || 0)];renderPalette();renderInPlaceControls();return;}
    try{const stroke=beginInPlaceStroke(state.inPlaceEdit.session,state.cursor || {x:0,y:0},{tool:state.tool,color:state.color,brushSize:state.brushSize,brushShape:state.brushShape,symmetry:state.symmetry,filled:state.filled});if(stroke)finishInPlaceStroke(state.inPlaceEdit.session,stroke);}
    catch(error){state.inPlaceEdit.error=error.message;}
    renderTools();renderCanvas();renderPreview();
  }
}
/** Where Place puts a part follows the Edit scope switch: every frame of the animation, or only this one. */
function partPlacementFrames() {
  const animation=currentAnimation();
  return state.objectScope==='animation'?animation.frames.map(f=>f.id):[state.frameId];
}
function partPlaceLabel() {
  const n=partPlacementFrames().length;
  return n>1?`Place in all ${n} frames`:`Place in frame ${currentAnimation().frames.findIndex(f=>f.id===state.frameId)+1}`;
}
/** Place a part centred on `at` (canvas pixel), or in the middle of the canvas, then select it for dragging. */
function placePartAt(partId,at=null) {
  if(state.inPlaceEdit)throw new Error('Apply or cancel the canvas object edit first.');
  const part=state.project.parts?.find(p=>p.id===partId);
  if(!part)throw new Error('That part no longer exists.');
  const x=at?at.x-Math.floor(part.width/2):Math.floor((state.project.width-part.width)/2);
  const y=at?at.y-Math.floor(part.height/2):Math.floor((state.project.height-part.height)/2);
  const layerId=currentLayer().id, frames=partPlacementFrames();
  mutate(()=>{
    const result=placePartInFrames(state.project,{animationId:currentAnimation().id,layerId,frameIds:frames},partId,x,y);
    state.project=result.project;state.objectSelection={layerId,key:result.instanceId};state.objectMulti=null;state.selection=null;state.tool='object';
  });
  toast(`${partId} placed${frames.length>1?` in ${frames.length} frames`:''}. Drag it into position.`);
}
function partLibrary(initialPart='') {
  if(finishDrawing())renderAll();
  if(state.inPlaceEdit){toast('Apply or cancel the canvas object edit first.');return;}
  openPartLibrary({getProject:()=>state.project,openDialog,paint:paintSprite,initialPart,selection:Boolean(state.selection),target:()=>objectTarget(),
    actions:{place:id=>placePartAt(id),placeLabel:partPlaceLabel,editArtwork:id=>{$('modal').close();editSharedPart(id);},
      change:project=>mutate(()=>{state.project=project;}),makeFromSelection:makeObjectDialog}});
}
function editSharedPart(partId) {
  const documentId=state.documentId,revision=state.documents.get(documentId)?.revision;
  openSharedPartEditor({project:clone(state.project),partId,animationId:currentAnimation().id,frameId:currentFrame().id,openDialog,onApply:project=>{
    if(state.documentId!==documentId || state.documents.get(documentId)?.revision!==revision)throw new Error('The project changed. Reopen this object before applying edits.');
    mutate(()=>{state.project=project;});toast('Shared artwork updated in every instance. Undo is available.');
  }});
}
function dropObjectRow(source,anchor,position) {
  finishDrawing();
  try {
    mutate(()=>{
      const result=dropObject(state.project,objectTarget(source.layerId),source,anchor,position,state.objectScope);
      state.project=result.project;state.layerId=result.layerId;state.objectSelection={layerId:result.layerId,key:result.key};
      if(position==='into')state.collapsedGroups.delete(anchor.layerId);
    });
  } catch(error){toast(error.message);}
}
function copyObjectItem(item,cut=false) {
  finishDrawing();
  try {
    const items=itemsFor(item);
    state.objectClipboard=copyObjects(state.project,objectTarget(item.layerId),items);state.lastClipboard='object';
    if(cut)objectAction('delete',item);else renderLayers();
    toast(`“${state.objectClipboard.name}” ${cut?'cut':'copied'}. Paste it into any frame, animation or project tab.`);
  } catch(error){toast(error.message);}
}
/** Paste the object clipboard next to the selection, in the current animation (or frame) of any project tab. */
function pasteObjectItem({independent=false,target=objectTarget(selectedObject().layerId),clip=state.objectClipboard,offset=0,scope=state.objectScope,fill=true,message}={}) {
  finishDrawing();
  if(!clip){toast('Copy an object first.');return;}
  try {
    mutate(()=>{
      const result=pasteObject(state.project,target,clip,{scope,independent,offset,fill});
      state.project=result.project;
      if(target.animationId===currentAnimation().id){setObjectSelection(result.items);if(clip.kind!=='container')state.tool='object';}
    });
    toast(message || `“${clip.name}” pasted${independent?' as an independent copy':''}${scope==='animation'?' into every frame of this animation':''}.`);
  } catch(error){toast(error.message);}
}
function duplicateObjectItem(item) {
  finishDrawing();
  try {
    const items=orderObjects(state.project,currentFrame(),itemsFor(item)), clip=copyObjects(state.project,objectTarget(item.layerId),items);
    pasteObjectItem({clip,target:objectTarget(items.at(-1).layerId),offset:clip.kind==='container'?0:2,fill:false,message:`“${clip.name}” duplicated.`});
  } catch(error){toast(error.message);}
}
function copyToAnimationDialog(item) {
  let clip;
  try{clip=copyObject(state.project,objectTarget(item.layerId),item.key);}catch(error){toast(error.message);return;}
  const animations=state.project.animations;
  openDialog('Copy to animation',`<form id="copy-to-form"><p class="modal-body-text">Place a copy of “${escapeHTML(clip.name)}” in another animation. Shared parts stay linked, so editing one updates both.</p><label class="field"><span class="field-label">Animation</span><select id="copy-to-animation">${animations.map(a=>`<option value="${escapeHTML(a.id)}"${a.id===currentAnimation().id?' disabled':''}>${escapeHTML(a.name)} · ${a.frames.length} frame${a.frames.length===1?'':'s'}</option>`).join('')}</select></label><label class="field"><span class="field-label">Frames</span><select id="copy-to-scope"><option value="animation">Every frame</option><option value="frame">First frame only</option></select></label><label class="check-row"><input id="copy-to-independent" type="checkbox"> Make an independent copy of shared parts</label><p class="helper-text">To paste into another project, use Copy, switch tabs, then Paste.</p><div class="modal-actions"><button class="button primary" type="submit">Copy object</button></div></form>`,'OBJECTS');
  const select=$('copy-to-animation'), first=[...select.options].find(o=>!o.disabled);
  if(!first){$('copy-to-form').innerHTML='<p class="modal-body-text">Add another animation first, or use Duplicate to copy within this one.</p>';return;}
  select.value=first.value;
  $('copy-to-form').onsubmit=event=>{
    event.preventDefault();
    const animation=animations.find(a=>a.id===select.value);
    $('modal').close();
    pasteObjectItem({clip,target:{animationId:animation.id,frameId:animation.frames[0].id,layerId:item.layerId},scope:$('copy-to-scope').value,independent:$('copy-to-independent').checked,message:`“${clip.name}” copied to ${animation.name}.`});
  };
}
function objectAction(action,item) {
  finishDrawing();
  if(action==='copy' || action==='cut'){copyObjectItem(item,action==='cut');return;}
  if(action==='paste' || action==='paste-independent'){pasteObjectItem({independent:action==='paste-independent'});return;}
  if(action==='duplicate'){duplicateObjectItem(item);return;}
  if(action==='copy-to'){copyToAnimationDialog(item);return;}
  if(action==='convert'){convertToObject(item);return;}
  const turn={'turn-right':'R90','turn-left':'R270','flip-x':'FX','flip-y':'FY'}[action];
  if(turn){turnSelection(turn,itemsFor(item));return;}
  if(action==='delete' && itemsFor(item).length>1) {
    const items=itemsFor(item);
    try{mutate(()=>{state.project=deleteObjects(state.project,objectTarget(item.layerId),items,state.objectScope);state.objectSelection=null;state.objectMulti=null;});toast(`${items.length} objects deleted.`);}
    catch(error){toast(error.message);}
    return;
  }
  if(action==='split'){splitObjectsDialog(item);return;}
  const target=objectTarget(item.layerId), layer=state.project.layers.find(l=>l.id===item.layerId);
  const node=celObjects(currentFrame().cels.find(c=>c.layerId===item.layerId)).find(n=>n.key===item.key);
  const wasEmpty=Boolean(node && isEmptyNode(currentFrame().cels.find(c=>c.layerId===item.layerId),node));
  try {
    if(action==='collapse'){if(state.objectSelection?.layerId===layer.id)state.objectSelection={layerId:layer.id,key:'@group'};state.collapsedGroups.has(layer.id)?state.collapsedGroups.delete(layer.id):state.collapsedGroups.add(layer.id);renderLayers();return;}
    if(action==='edit'){editSharedObject(item);return;}
    if(action==='isolated'){if(node?.instance)editSharedPart(node.instance.partId);return;}
    if(action==='rename'){renameObjectDialog(item,node);return;}
    if(action==='move-group'){moveObjectGroupDialog(item);return;}
    mutate(()=>{
      if(action==='visibility' || action==='lock') {
        const field=action==='visibility'?'visible':'locked';
        if(item.group || !node?.instance || (layer.group===false && ((field==='visible' && !layer.visible) || (field==='locked' && layer.locked))))layer[field]=!layer[field];
        else state.project=updateObject(state.project,target,item.key,{[field]:field==='visible'?node.instance.visible===false:!node.instance.locked},state.objectScope);
      } else if(action==='up' || action==='down') {
        const direction=action==='up'?1:-1, children=celObjects(currentFrame().cels.find(c=>c.layerId===layer.id));
        if(item.group || (layer.group===false && children.length===1))state.project=reorderObjectContainer(state.project,target,direction,state.objectScope);
        else state.project=reorderObject(state.project,target,item.key,direction,state.objectScope);
      } else if(action==='ungroup')layer.group=false;
      else if(action==='delete') {
        state.project=item.group?removeObjectContainer(state.project,layer.id):deleteObject(state.project,target,item.key,state.objectScope);
        if(!item.group && wasEmpty && state.project.layers.some(l=>l.id===layer.id))
          throw new Error(state.project.layers.length<2?'This is the last object row; draw on it, or add another object first.':'Nothing to delete in this frame. Set Edit to “All frames” to remove it from every frame.');
      }
      else if(action==='independent')state.project=forkObject(state.project,target,item.key,state.objectScope);
    });
  } catch(error) {toast(error.message);}
}
/** Turn the pixel selection (rectangle or wand mask) into a movable, reusable object. */
function makeObjectDialog() {
  finishDrawing();
  const selection=state.selection;
  if(state.inPlaceEdit)return;
  if(!selection){toast('Select pixels first: drag with Select (S) or click a shape with the Magic wand (W).');return;}
  if(!canEditPixels()){toast('Show and unlock this object before turning its pixels into an object.');return;}
  const layer=currentLayer(), frames=currentAnimation().frames.length, grouped=layer.group!==false;
  openDialog('Make object',`<form id="make-object-form"><p class="modal-body-text">The selected pixels become a movable object you can reuse, copy to other scenes and edit everywhere at once.</p><label class="field"><span class="field-label">Name</span><input id="make-object-name" value="${escapeHTML(uniqueLayerName('Object'))}" maxlength="80" required></label><label class="field"><span class="field-label">Frames</span><select id="make-object-scope"><option value="frame">This frame</option><option value="animation"${frames>1?'':' disabled'}>Every frame of “${escapeHTML(currentAnimation().name)}” (${frames})</option></select></label><p class="helper-text">${grouped?`The object stays in the group “${escapeHTML(layer.name)}”.`:'The object gets its own row above the pixels.'} Every-frame objects use the same selection area in each frame; identical frames share one part.</p><div class="modal-actions"><button type="button" id="make-object-cancel" class="button">Cancel</button><button type="submit" class="button primary">${icon('object-new')} Make object</button></div></form>`,'OBJECTS');
  $('make-object-cancel').onclick=()=>$('modal').close();
  const input=$('make-object-name');input.select();
  $('make-object-form').onsubmit=event=>{
    event.preventDefault();
    const name=input.value.trim(), scope=$('make-object-scope').value;
    if(!name)return;
    try {
      let result;
      mutate(()=>{
        result=createObjectFromPixels(state.project,objectTarget(selection.layerId),{rect:selection.rect,mask:selection.mask,name,scope});
        state.project=result.project;state.layerId=result.layerId;state.objectSelection={layerId:result.layerId,key:result.key};
        state.selection=null;state.transformScope='frame';state.tool='object';
      });
      $('modal').close();
      toast(`“${name}” is now an object${result.frames>1?` in ${result.frames} frames`:''}. Drag to move it; double-click to edit.`);
    } catch(error){toast(error.message);}
  };
}
/** Convert a whole pixel object into a smart object (part instance) in the current scope. */
function convertToObject(item) {
  const layer=state.project.layers.find(l=>l.id===item.layerId);
  const name=layer.group===false?layer.name:uniqueLayerName('Object');
  try {
    let result;
    mutate(()=>{
      const target=objectTarget(item.layerId), cel=currentFrame().cels.find(c=>c.layerId===item.layerId), node=celObjects(cel).find(n=>n.key===item.key);
      // Grouped pixels can sit under instances, so only that node's own pixels are converted.
      const mask=cel.source?pixelIslands(state.project,target,node.key).flatMap(island=>island.indices):undefined;
      result=createObjectFromPixels(state.project,target,{mask,name,scope:state.objectScope==='animation' && !cel.source?'animation':'frame'});
      state.project=result.project;state.layerId=result.layerId;state.objectSelection={layerId:result.layerId,key:result.key};state.tool='object';
      // When the original pixel row was fully converted it is gone, so the object can take its name.
      if(layer.group===false && !state.project.layers.some(l=>l.id===item.layerId))state.project.layers.find(l=>l.id===result.layerId).name=name;
    });
    toast(`“${name}” is now a reusable object${result.frames>1?` in ${result.frames} frames`:''}.`);
  } catch(error){toast(error.message);}
}
function splitObjectsDialog(item) {
  let islands;
  try{islands=pixelIslands(state.project,objectTarget(item.layerId),item.key);}catch(error){toast(error.message);return;}
  if(!islands.length){toast('There are no shapes to split here.');return;}
  const layer=state.project.layers.find(l=>l.id===item.layerId), counts=islands.map(i=>i.indices.length);
  openDialog('Split into objects',`<form id="split-form"><p class="modal-body-text">Found <strong id="split-count">${islands.length}</strong> separate shape${islands.length===1?'':'s'} in this frame. Each becomes its own movable object${layer.group===false?' inside a new group':` in “${escapeHTML(layer.name)}”`}.</p><div class="form-grid"><label class="field"><span class="field-label">Name</span><input id="split-name" value="Shape" maxlength="70" required></label><label class="field"><span class="field-label">Ignore shapes under</span><select id="split-min"><option value="1">Keep all</option><option value="2">2 pixels</option><option value="4">4 pixels</option><option value="9">9 pixels</option><option value="16">16 pixels</option></select></label></div><p class="helper-text">Diagonal neighbours count as one shape. Ignored specks stay as pixels.</p><div class="modal-actions"><button type="button" id="split-cancel" class="button">Cancel</button><button type="submit" class="button primary">${icon('split')} Split</button></div></form>`,'OBJECTS');
  $('split-cancel').onclick=()=>$('modal').close();
  $('split-min').onchange=()=>{$('split-count').textContent=counts.filter(n=>n>=Number($('split-min').value)).length;};
  $('split-form').onsubmit=event=>{
    event.preventDefault();
    const name=$('split-name').value.trim()||'Shape';
    try {
      let result;
      mutate(()=>{
        result=splitIntoObjects(state.project,objectTarget(item.layerId),item.key,{name,groupName:uniqueLayerName(`${layer.name} shapes`),minPixels:Number($('split-min').value)});
        state.project=result.project;state.layerId=result.layerId;state.objectSelection={layerId:result.layerId,key:result.keys[0]};state.tool='object';
        state.collapsedGroups.delete(result.layerId);
      });
      $('modal').close();toast(`Split into ${result.keys.length} object${result.keys.length===1?'':'s'}. Undo is available.`);
    } catch(error){toast(error.message);}
  };
}
function addObject(group=false) {
  try {mutate(()=>{const result=addObjectContainer(state.project,state.layerId,uniqueLayerName(group?'Group':'Pixels'),group);state.project=result.project;state.layerId=result.layerId;state.objectSelection=null;state.tool=group?'object':'pencil';});}
  catch(error){toast(error.message);}
}
function renameObjectDialog(item,node) {
  const layer=state.project.layers.find(l=>l.id===item.layerId), name=node?.instance?node.name:layer.name;
  openDialog('Rename object',`<form id="object-name-form"><label class="field"><span class="field-label">Name</span><input id="object-name-input" value="${escapeHTML(name)}" maxlength="80" required></label><div class="modal-actions"><button type="submit" class="button primary">Save name</button></div></form>`);
  $('object-name-form').onsubmit=event=>{event.preventDefault();const name=$('object-name-input').value.trim();if(!name)return;
    try{mutate(()=>{if(node?.instance)state.project=updateObject(state.project,objectTarget(item.layerId),item.key,{name},state.objectScope);else layer.name=name;});$('modal').close();}catch(error){toast(error.message);}};
}
function moveObjectGroupDialog(item) {
  const groups=state.project.layers.filter(l=>l.id!==item.layerId && !l.locked);
  openDialog('Move object',`<form id="object-group-form"><label class="field"><span class="field-label">Destination</span><select id="object-group-destination"><option value="@root">Ungrouped · new object stack</option>${groups.map(l=>`<option value="${escapeHTML(l.id)}">${escapeHTML(l.name)}${l.group===false?' · ungrouped':''}</option>`).join('')}</select></label><p class="helper-text">Moves this instance in ${state.objectScope==='animation'?'every frame of the current animation where it appears':'the current frame'}. Pixel overrides stay in their original group.</p><div class="modal-actions"><button class="button primary" type="submit">Move object</button></div></form>`);
  $('object-group-form').onsubmit=event=>{event.preventDefault();try{mutate(()=>{
    let destination=$('object-group-destination').value;
    if(destination==='@root'){const added=addObjectContainer(state.project,item.layerId,'Objects',false);state.project=added.project;destination=added.layerId;}
    state.project=moveObjectToGroup(state.project,objectTarget(item.layerId),item.key,destination,state.objectScope);state.layerId=destination;state.objectSelection={layerId:destination,key:item.key};
  });$('modal').close();}catch(error){toast(error.message);}};
}
function uniqueLayerName(base) {
  const names = new Set(state.project.layers.map(layer => layer.name.toLowerCase()));
  let name = base.slice(0,80), number = 2;
  while (names.has(name.toLowerCase())) { const suffix = ` ${number++}`; name = base.slice(0,80-suffix.length)+suffix; }
  return name;
}
function insertLayer(name, source = null) {
  if (!canAddLayer()) throw new Error('This project has reached its layer or pixel limit.');
  const layer = {id:uid(),name:uniqueLayerName(name),visible:source?.visible ?? true,locked:false,group:false};
  insertProjectLayer(state.project,layer,state.layerId,source?.id);
  state.layerId = layer.id;
  return layer;
}
/** The project and animation the Live Preview plays: a motion mode's candidate result, or the current one. */
function previewAnimation() {
  const project = state.previewOverride, animation = project?.animations.find(a => a.id === state.animationId);
  return animation ? { project, animation, playing: true } : { project: state.project, animation: currentAnimation(), playing: state.playing };
}
function renderPreview() {
  const { project, animation, playing } = previewAnimation();
  const index = playing ? state.previewIndex % animation.frames.length : animation.frames.findIndex(f => f.id === state.frameId);
  paintSprite($('preview-canvas'), state.inPlaceEdit?previewInPlaceEdit(state.inPlaceEdit.session,true):compositeFrame(project,animation.frames[Math.max(0,index)]), project.palette);
  $('preview-frame').textContent = `${Math.max(0,index) + 1} / ${animation.frames.length}`;
}
function renderPlaybackControls() {
  $('play-toggle').innerHTML = `${icon(state.playing ? 'pause' : 'play')}<span>${state.playing ? 'Pause' : 'Play'}</span>`;
  $('play-toggle').setAttribute('aria-label', state.playing ? 'Pause animation' : 'Play animation');
  document.querySelector('.live-badge').innerHTML = `<i></i> ${state.playing ? 'LIVE' : 'STILL'}`;
  document.querySelector('.live-badge').classList.toggle('paused', !state.playing);
}
/** Example projects as cards in the start screen; each opens a copy in a new tab. */
function renderSampleCards(container) {
  container.innerHTML = state.samples.map(sample => `<button type="button" class="start-sample" data-sample="${sample.id}" aria-label="Open ${escapeHTML(sample.name)} example" title="${escapeHTML(sample.name)} · ${sample.animations} animation${sample.animations === 1 ? '' : 's'}, ${sample.frames} frames"><canvas class="sample-thumb" width="32" height="32"></canvas><span>${escapeHTML(sample.name)}</span></button>`).join('')
    || '<p class="helper-text">Examples could not load.</p>';
  container.querySelectorAll('[data-sample]').forEach(button => {
    const project = state.sampleData.get(button.dataset.sample);
    paintSprite(button.querySelector('canvas'), compositeFrame(project,project.animations[0].frames[0]), project.palette, false, project.width, project.height);
    button.addEventListener('click', () => {
      try { replaceProject(clone(project), `${project.name} opened. Make it your own.`); $('modal').close(); }
      catch (error) { toast(error.message); }
    });
  });
}
function renderAll() {
  normalizeSelection();
  syncMotionMode();
  syncRigMode();
  if (document.activeElement !== $('project-name')) $('project-name').value = state.project.name;
  renderProjectTabs();renderPanelState();renderTools(); renderPalette(); renderTimeline(); renderAnimations(); renderLayers(); renderSelection(); renderCanvas(); renderPreview(); renderPlaybackControls();renderInPlaceControls();renderEditScope();renderAnimatePanel();renderEffectsPanel();
}
/**
 * The edit scope switch in the canvas toolbar. Normally it chooses between every frame of the current
 * animation and only this frame; while editing an object on canvas it chooses all copies or this frame.
 */
function renderEditScope() {
  const animation=currentAnimation(), index=animation.frames.findIndex(f=>f.id===state.frameId), session=state.inPlaceEdit?.session;
  const frameOnly=session?session.scope==='frame':state.objectScope==='frame';
  const copies=session?.references.length || 0;
  $('edit-scope-wide-label').textContent=session?'All copies':'All frames';
  $('edit-scope-wide-detail').textContent=session?`${copies} instance${copies===1?'':'s'}`:`${animation.name} · ${animation.frames.length}`;
  $('edit-scope-frame-detail').textContent=`Frame ${index+1}`;
  for(const button of $('edit-scope').querySelectorAll('[data-scope]')) {
    const on=(button.dataset.scope==='frame')===frameOnly;
    button.classList.toggle('active',on);button.setAttribute('aria-checked',String(on));button.tabIndex=on?0:-1;
    button.title=button.dataset.scope==='frame'
      ?(session?'Change only this placement, in this frame (you can fix pixels a rotation drew badly)':`Drawing and object changes affect only frame ${index+1}`)
      :(session?`Change the shared artwork: every copy of ${session.partId} updates`:`Drawing and object changes repeat in all ${animation.frames.length} frames of ${animation.name}`);
  }
  $('workbench').classList.toggle('scope-frame',frameOnly);
}
function setEditScope(frameOnly) {
  finishDrawing();
  if(state.inPlaceEdit) {
    try{setInPlaceScope(state.inPlaceEdit.session,frameOnly?'frame':'shared');state.inPlaceEdit.error=null;}
    catch(error){toast(error.message);}
    renderInPlaceControls();renderCanvas();renderPreview();
  } else {
    state.objectScope=frameOnly?'frame':'animation';
    renderLayers();renderTools();
  }
  renderEditScope();
}
function fitCanvas() {
  if (!state.fit) return;
  const stage = $('canvas-stage');
  const style = getComputedStyle(stage);
  const availableWidth = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 18;
  const availableHeight = stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - 18;
  state.scale = Math.max(1, Math.min(maxZoom(), Math.floor(Math.min(availableWidth/state.project.width,availableHeight/state.project.height))));
  renderCanvas();
}
function setZoom(scale) {
  state.fit = false;
  state.scale = Math.max(1, Math.min(maxZoom(), scale));
  renderCanvas();
}

function renderSelection() {
  $('selection-actions').hidden=!SELECT_TOOLS.includes(state.tool);
  $('make-object').hidden=Boolean(state.inPlaceEdit);
  if(state.inPlaceEdit) {
    const rect=state.inPlaceEdit.session.selection;
    $('selection-info').textContent=rect?`${rect.width} × ${rect.height} pixels · ${state.inPlaceEdit.session.partId}`:'Drag a rectangle to select pixels in this object.';
    for(const id of ['clear-selection','deselect-selection','copy-selection','cut-selection'])$(id).disabled=!rect;
    $('paste-selection').disabled=!state.clipboard;
    renderTransformControls();return;
  }
  const selection=state.selection;
  $('selection-info').textContent=selection ? (selection.mask?`${selection.mask.length} pixel${selection.mask.length===1?'':'s'} · ${currentLayer().name}`:`${selection.rect.width} × ${selection.rect.height} pixels · ${currentLayer().name}`) : state.tool==='wand'?'Click a shape to select it. Shift-click adds more.':'Drag a rectangle to select pixels on this layer.';
  $('make-object').disabled=!selection || !canEditPixels();
  $('clear-selection').disabled=!selection || !canEditPixels();
  $('deselect-selection').disabled=!selection;
  $('copy-selection').disabled=!selection;
  $('cut-selection').disabled=!selection || !canEditPixels();
  $('paste-selection').disabled=!state.clipboard || !canEditPixels();
  renderTransformControls();
}
function renderTransformControls() {
  if(state.transformScope==='selection' && !state.selection) state.transformScope='frame';
  $('transform-scope').value=state.transformScope;
  $('transform-scope').querySelector('[value="selection"]').disabled=!state.selection;
  const rect=state.transformScope==='selection'?state.selection.rect:{x:0,y:0,width:state.project.width,height:state.project.height};
  const item=selectedObject(), node=celObjects(currentFrame().cels.find(c=>c.layerId===item.layerId)).find(n=>n.key===item.key);
  const smart=state.tool==='object' && Boolean(node?.instance);
  const editable=canEditPixels() && !smart;
  const canRotate=rect.height<=state.project.width && rect.width<=state.project.height;
  $('flip-horizontal').disabled=!editable;$('flip-vertical').disabled=!editable;
  $('rotate-left').disabled=!editable || !canRotate;$('rotate-right').disabled=!editable || !canRotate;
  renderObjectPose();
  $('transform-help').textContent=smart?'Select pixel artwork to transform pixels. Use Part library to rotate or flip a part instance.':!editable?'Show the pixel object and unlock its group and objects to transform it.':!canRotate?'Flips affect the active pixel object. Select a smaller area to rotate without cropping.':state.transformScope==='selection'?'Transforms the selection on the active pixel object.':'Transforms pixels in this container; other containers stay in place.';
}
/** In-place edits change only the draft part; the result of `change` is shown without touching the project. */
function inPlaceSelectionChange(change) {
  finishDrawing();
  try{change(state.inPlaceEdit.session);state.inPlaceEdit.error=null;}catch(error){state.inPlaceEdit.error=error.message;}
  renderTools();renderSelection();renderCanvas();renderPreview();
}
function selectAllPixels() {
  if(state.inPlaceEdit){state.tool='select';inPlaceSelectionChange(selectAllInPlace);return;}
  finishDrawing();state.tool='select';
  state.selection={rect:{x:0,y:0,width:state.project.width,height:state.project.height},frameId:state.frameId,layerId:state.layerId,canvasWidth:state.project.width,canvasHeight:state.project.height};
  state.transformScope='selection';renderAll();
}
function copySelectionPixels(cut=false) {
  finishDrawing();
  if(state.inPlaceEdit) {
    const copied=copyInPlaceSelection(state.inPlaceEdit.session);
    if(!copied)return;
    state.clipboard=copied;state.lastClipboard='pixels';
    if(cut)inPlaceSelectionChange(clearInPlaceSelection);else renderSelection();
    toast(cut?'Selection cut from the object draft.':'Selection copied. Paste it into this object or anywhere else.');return;
  }
  if (!state.selection || (cut && !canEditPixels())) return;
  state.lastClipboard='pixels';
  const copied=copyPixels(maskedPixels(currentPixels()),state.project.width,state.project.height,state.selection.rect);
  state.clipboard={...copied,palette:[...state.project.palette],x:state.selection.rect.x,y:state.selection.rect.y};
  if(cut) clearSelectionPixels();
  renderSelection();toast(cut?'Selection cut. Paste it into any frame, layer, or project.':'Selection copied. Paste it into any frame, layer, or project.');
}
function pasteClipboardPixels() {
  finishDrawing();
  const clipboard=state.clipboard;
  if (!clipboard) {toast('Select and copy some pixels first.');return;}
  if(state.inPlaceEdit) {
    // Drafts cannot add palette colors, so unknown colors use their nearest match.
    const palette=state.inPlaceEdit.session.sourceProject.palette, {mapping}=mapPaletteColors(palette,clipboard.palette,clipboard.pixels);
    const pixels=clipboard.pixels.map(color=>{
      if(color<0)return -1;
      const index=mapping.get(color);
      return index<palette.length?index:nearestColor(...clipboard.palette[color].slice(1).match(/.{2}/g).map(c=>parseInt(c,16)),palette);
    });
    state.tool='select';inPlaceSelectionChange(session=>pasteInPlace(session,{...clipboard,pixels}));
    if(!state.inPlaceEdit.error)toast('Pixels pasted into the object. Drag the selection to position it.');
    return;
  }
  if(!canEditPixels()){toast('Select visible pixel artwork and unlock its objects before pasting.');return;}
  try {
    const palette=[...state.project.palette];
    const samePalette=palette.length===clipboard.palette.length && palette.every((color,index)=>color.toLowerCase()===clipboard.palette[index].toLowerCase());
    const mapping=new Map();
    for (const sourceIndex of new Set(clipboard.pixels.filter(color=>color>=0))) {
      if (samePalette) {mapping.set(sourceIndex,sourceIndex);continue;}
      const color=clipboard.palette[sourceIndex];
      let index=palette.findIndex(existing=>existing.toLowerCase()===color.toLowerCase());
      if(index<0 && palette.length<MAX_COLORS){palette.push(color);index=palette.length-1;}
      if(index<0) {
        const channels=color.slice(1).match(/.{2}/g).map(channel=>parseInt(channel,16));
        index=nearestColor(...channels,palette);
      }
      mapping.set(sourceIndex,index);
    }
    const pixels=clipboard.pixels.map(color=>color<0?-1:mapping.get(color));
    const point=state.selection?.rect || {x:clipboard.x,y:clipboard.y};
    const result=pastePixels(currentPixels(),state.project.width,state.project.height,{...clipboard,pixels},point.x,point.y);
    mutate(()=>{
      state.project.palette=palette;currentFrame().cels.find(cel=>cel.layerId===state.layerId).pixels=result.pixels;
      state.tool='select';state.selection={rect:result.selection,frameId:state.frameId,layerId:state.layerId,canvasWidth:state.project.width,canvasHeight:state.project.height};
      state.transformScope='selection';
    });
    toast('Pixels pasted. Drag the selection to position it.');
  } catch(error) {toast(error.message);}
}
function transformArtwork(operation) {
  finishDrawing();
  if(!canEditPixels()) return;
  const selected=selectedObject(), node=celObjects(currentFrame().cels.find(c=>c.layerId===selected.layerId)).find(n=>n.key===selected.key);
  if(state.tool==='object' && node?.instance)return;
  const scope=state.transformScope;
  const rect=scope==='selection'?state.selection?.rect:{x:0,y:0,width:state.project.width,height:state.project.height};
  if(!rect) return;
  const frames=scope==='project'?state.project.animations.flatMap(animation=>animation.frames):scope==='animation'?currentAnimation().frames:[currentFrame()];
  if(frames.some(frame=>!canEditPixels(frame))){toast('Unlock objects in the selected frames before transforming their pixels.');return;}
  try {
    const changes=frames.map(frame=>({frame,result:transformPixels(getLayerPixels(frame,state.layerId),state.project.width,state.project.height,rect,operation)}));
    mutate(()=>{
      for(const {frame,result} of changes)frame.cels.find(cel=>cel.layerId===state.layerId).pixels=result.pixels;
      if(scope==='selection'){state.selection.rect=changes[0].result.selection;delete state.selection.mask;}
    });
    toast(`Transformed ${frames.length} frame${frames.length===1?'':'s'} on “${currentLayer().name}”. Undo is available.`);
  } catch(error){toast(error.message);}
}
/** Pixels outside a wand selection become transparent; rectangle selections keep everything. */
function maskedPixels(pixels) {
  const mask=state.selection?.mask;
  if(!mask)return pixels;
  const result=Array(pixels.length).fill(-1);
  for(const index of mask)result[index]=pixels[index];
  return result;
}
function selectionContains(point) {
  if(state.selection?.mask)return state.selection.mask.includes(point.y*state.project.width+point.x);
  const rect=state.selection?.rect;
  return rect && point.x>=rect.x && point.x<rect.x+rect.width && point.y>=rect.y && point.y<rect.y+rect.height;
}
function beginSelection(event,point,cel) {
  const previousSelection=state.selection?clone(state.selection):null;
  const moving=selectionContains(point);
  state.drawing={pointerId:event.pointerId,tool:'select',kind:moving?'move':'marquee',origin:point,last:point,before:snapshot(),cel,base:[...cel.pixels],rect:moving?{...state.selection.rect}:null,mask:moving?state.selection.mask:null,previousSelection};
  if (!moving) state.selection={rect:selectionBounds(point.x,point.y,point.x,point.y,state.project.width,state.project.height),frameId:state.frameId,layerId:state.layerId,canvasWidth:state.project.width,canvasHeight:state.project.height};
  state.transformScope='selection';
  renderSelection(); renderCanvas();
}
function updateSelection(point) {
  const drawing=state.drawing;
  if (drawing.kind==='move' && drawing.mask) {
    const result=moveMaskedPixels(drawing.base,state.project.width,state.project.height,drawing.mask,point.x-drawing.origin.x,point.y-drawing.origin.y);
    drawing.cel.pixels=result.pixels; state.selection.rect=result.selection; state.selection.mask=result.mask;
  } else if (drawing.kind==='move') {
    const result=moveSelectedPixels(drawing.base,state.project.width,state.project.height,drawing.rect,point.x-drawing.origin.x,point.y-drawing.origin.y);
    drawing.cel.pixels=result.pixels; state.selection.rect=result.selection;
  } else {
    state.selection.rect=selectionBounds(drawing.origin.x,drawing.origin.y,point.x,point.y,state.project.width,state.project.height);
  }
  renderSelection();
}
function nudgeSelection(dx,dy) {
  if (!state.selection || !canEditPixels()) return;
  const offset=clampSelectionOffset(state.selection.rect,dx,dy,state.project.width,state.project.height);
  if (!offset.dx && !offset.dy) return;
  mutate(()=>{
    const mask=state.selection.mask;
    const result=mask?moveMaskedPixels(currentPixels(),state.project.width,state.project.height,mask,offset.dx,offset.dy):moveSelectedPixels(currentPixels(),state.project.width,state.project.height,state.selection.rect,offset.dx,offset.dy);
    currentFrame().cels.find(cel=>cel.layerId===state.layerId).pixels=result.pixels;
    state.selection.rect=result.selection;
    if(mask)state.selection.mask=result.mask;
  });
}
function clearSelectionPixels() {
  if(state.inPlaceEdit){inPlaceSelectionChange(clearInPlaceSelection);return;}
  if (!state.selection || !canEditPixels()) return;
  mutate(()=>{
    const rect=state.selection.rect,pixels=currentPixels();
    if(state.selection.mask){for(const index of state.selection.mask)pixels[index]=-1;return;}
    for(let y=rect.y;y<rect.y+rect.height;y++) for(let x=rect.x;x<rect.x+rect.width;x++) pixels[y*state.project.width+x]=-1;
  });
}
function deselectPixels() { if(state.inPlaceEdit){inPlaceSelectionChange(deselectInPlace);return;} finishDrawing(); state.selection=null; state.transformScope='frame';renderAll(); }
function magicOutlineDialog() {
  if (!canAddLayer()) { toast('This project has reached its layer or pixel limit.'); return; }
  const selectedColor=state.color>=0?state.color:0;
  openDialog('A perfect outline. Every frame.',`<form id="outline-form"><p class="modal-body-text">Trace the visible artwork in every animation automatically. The outline goes on its own editable layer beneath your artwork.</p><label class="field"><span class="field-label">Outline color</span><select id="outline-color">${state.project.palette.map((color,index)=>`<option value="${index}"${index===selectedColor?' selected':''}>Color ${index+1} · ${color.toUpperCase()}</option>`).join('')}</select></label><div class="form-grid"><label class="field"><span class="field-label">Thickness</span><select id="outline-thickness"><option value="1">1 pixel</option><option value="2">2 pixels</option><option value="3">3 pixels</option></select></label><label class="field"><span class="field-label">Corners</span><select id="outline-corners"><option value="4">Crisp · 4 neighbors</option><option value="8">Full · 8 neighbors</option></select></label></div><p class="helper-text">Uses the silhouette of all visible layers. Hidden artwork is ignored. Leave a little room around the sprite: outlines stay inside the canvas.</p><div class="modal-actions"><button id="cancel-outline" type="button" class="button">Cancel</button><button type="submit" class="button primary">${icon('spark')} Outline all ${totalFrames()} frames</button></div></form>`,'MAGIC OUTLINE');
  $('cancel-outline').onclick=()=>$('modal').close();
  $('outline-form').onsubmit=event=>{
    event.preventDefault();
    const color=Number($('outline-color').value),thickness=Number($('outline-thickness').value),diagonal=$('outline-corners').value==='8';
    const outlined=[];
    forEachFrame(frame=>outlined.push({frame,pixels:outlinePixels(compositeFrame(state.project,frame),state.project.width,state.project.height,color,thickness,diagonal)}));
    if (!outlined.some(item=>item.pixels.some(pixel=>pixel>=0))) { toast('No room for an outline. Add some canvas space around your visible artwork.'); return; }
    mutate(()=>{
      const layer=insertLayer('Magic outline');
      const index=state.project.layers.findIndex(item=>item.id===layer.id);
      state.project.layers.splice(index,1); state.project.layers.unshift(layer);
      for (const animation of state.project.animations) {
        if (animation.layerOrder) animation.layerOrder = [layer.id,...animation.layerOrder.filter(id=>id!==layer.id)];
        for(const frame of animation.frames)if(frame.layerOrder)frame.layerOrder=[layer.id,...frame.layerOrder.filter(id=>id!==layer.id)];
      }
      outlined.forEach(({frame,pixels})=>{frame.cels.find(cel=>cel.layerId===layer.id).pixels=pixels;});
    });
    $('modal').close(); toast(`Outlined ${totalFrames()} frames on a separate layer. Undo is available.`);
  };
}

function canvasPoint(event, clamp = false) {
  const rect = $('pixel-canvas').getBoundingClientRect();
  let x = Math.floor((event.clientX - rect.left) / rect.width * state.project.width);
  let y = Math.floor((event.clientY - rect.top) / rect.height * state.project.height);
  if (clamp) { x = Math.max(0, Math.min(state.project.width-1,x)); y = Math.max(0, Math.min(state.project.height-1,y)); }
  return {x,y};
}
function inside(point) { return point.x >= 0 && point.x < state.project.width && point.y >= 0 && point.y < state.project.height; }
function drawPoints(points, color) {
  const pixels = state.drawing?.cel.pixels || currentPixels();
  const tool=state.drawing?.tool || state.tool,sized=BRUSH_TOOLS.includes(tool);
  const size=sized?state.brushSize:1, shape=sized?state.brushShape:'square', symmetry=SYMMETRY_TOOLS.includes(tool)?state.symmetry:'none';
  let footprint=unclampedDrawing(state.drawing)?wrappedFootprint(points,size,shape,symmetry):brushPoints(points,size,shape,state.project.width,state.project.height,symmetry);
  if(tool==='shade') {
    // Each pixel shifts one palette step per stroke, however often the brush passes over it.
    const touched=state.drawing?.touched || new Set();
    for(const point of footprint) {
      const index=point.y*state.project.width+point.x;
      if(touched.has(index))continue;
      touched.add(index);state.drawing?.footprint?.add(index);
      if(pixels[index]>=0)pixels[index]=shadeIndex(state.project.palette,pixels[index],state.drawing?.shade || -1);
    }
    return;
  }
  if(tool==='dither')footprint=footprint.filter(point=>ditherCell(point.x,point.y));
  for (const point of footprint) {const index=point.y*state.project.width+point.x;pixels[index]=color;state.drawing?.footprint?.add(index);}
}
/** Freehand pencil step; pixel-perfect mode removes the doubled pixel at each stair-step corner. */
function drawFreehand(drawing,from,to) {
  const pixelPerfect=drawing.tool==='pencil' && state.pixelPerfect && state.brushSize===1 && state.symmetry==='none';
  if(!pixelPerfect){drawPoints(linePoints(from.x,from.y,to.x,to.y),drawing.color);return;}
  for(const point of linePoints(from.x,from.y,to.x,to.y)) {
    const removed=pixelPerfectStep(drawing.path,point);
    const at=wrappedIndex(point);
    drawing.cel.pixels[at]=drawing.color;drawing.footprint.add(at);
    if(removed){const index=wrappedIndex(removed);drawing.cel.pixels[index]=drawing.base[index];drawing.footprint.delete(index);}
  }
}
/** Magic wand: select the clicked shape or color region; Shift adds to the current selection. */
function wandSelect(point,cel,add) {
  const width=state.project.width, region=connectedRegion(cel.pixels,width,state.project.height,point.x,point.y,state.wandMode);
  const previous=add && state.selection?.layerId===state.layerId && state.selection.frameId===state.frameId ? (state.selection.mask || rectIndices(state.selection.rect)) : [];
  if(!region){if(!add){state.selection=null;}renderSelection();renderCanvas();if(!add)toast('Click artwork to select a shape. That pixel is transparent.');return;}
  const mask=[...new Set([...previous,...region.indices])].sort((a,b)=>a-b);
  state.selection={rect:maskBounds(mask,width),mask,frameId:state.frameId,layerId:state.layerId,canvasWidth:width,canvasHeight:state.project.height};
  state.transformScope='selection';
  renderSelection();renderTransformControls();renderCanvas();
}
function rectIndices(rect) {
  const indices=[];
  for(let y=rect.y;y<rect.y+rect.height;y++) for(let x=rect.x;x<rect.x+rect.width;x++) indices.push(y*state.project.width+x);
  return indices;
}
function beginObjectMove(event,point,hit) {
  const additive=['object','resize'].includes(state.tool) && (event.shiftKey || event.ctrlKey || event.metaKey);
  if(!hit){if(!additive){state.objectSelection=null;renderAll();}return;}
  if(additive){toggleObjectItem(hit);return;}
  const items=selectedItems(), together=items.length>1 && items.some(item=>sameItem(item,hit));
  if(together){finishDrawing();state.selection=null;setObjectSelection(items,hit);renderAll();}
  else selectObject(hit);
  if(!together && hit.type!=='instance')return;
  if(!together) {
    const layer=currentLayer(), op=currentFrame().cels.find(c=>c.layerId===layer.id).source.ops.find(op=>op.type==='use'&&op.id===hit.key);
    if(layer.locked || op.locked){toast('Unlock this object or its group before moving it.');return;}
  }
  $('pixel-canvas').setPointerCapture(event.pointerId);
  state.drawing={tool:'object',pointerId:event.pointerId,origin:point,last:point,before:snapshot(),target:objectTarget(),key:hit.key,items:together?items:null};
}
function doubleClickObject(event) {
  if(state.inPlaceEdit || state.tool!=='object')return;
  const point=canvasPoint(event), hit=hitTestObject(state.project,currentAnimation(),currentFrame(),point.x,point.y);
  if(hit?.type==='instance'){event.preventDefault();finishDrawing();selectObject(hit);editSharedObject(hit);}
}
/** Clicking empty stage around the canvas with the object tool clears the object selection. */
function deselectObjectOutside(event) {
  if(event.button!==0 || event.target===$('pixel-canvas') || state.drawing || state.inPlaceEdit || !['object','resize'].includes(state.tool) || !state.objectSelection)return;
  state.objectSelection=null;renderAll();
}
function pointerDown(event) {
  if (event.button !== 0 && event.button !== 2) return;
  if (state.drawing) return;
  const point = canvasPoint(event);
  if (!inside(point)) { if(event.button===0 && ['object','resize'].includes(state.tool) && !state.inPlaceEdit && state.objectSelection){state.objectSelection=null;renderAll();} return; }
  event.preventDefault();
  $('pixel-canvas').focus({preventScroll:true});
  $('pixel-canvas').setPointerCapture(event.pointerId);
  const tool = event.altKey ? 'eyedropper' : event.button === 2 && state.tool!=='shade' ? 'eraser' : state.tool;
  const shade = event.button === 2 ? 1 : -1;
  state.cursor = point;
  if (tool === 'eyedropper') {
    state.color = canvasPixels()[point.y * state.project.width + point.x];
    renderPalette(); renderCanvas();
    if ($('pixel-canvas').hasPointerCapture(event.pointerId)) $('pixel-canvas').releasePointerCapture(event.pointerId);
    return;
  }
  if(state.inPlaceEdit) {
    try {
      const from=event.shiftKey?shiftLineStart(tool):null;
      const stroke=tool==='select'?beginInPlaceSelection(state.inPlaceEdit.session,point):beginInPlaceStroke(state.inPlaceEdit.session,point,{tool,from,shade,color:tool==='eraser'?-1:tool==='shade'?0:state.color,brushSize:state.brushSize,brushShape:state.brushShape,symmetry:state.symmetry,filled:state.filled});
      if(stroke){state.inPlaceEdit.error=null;state.drawing={...stroke,tool,pointerId:event.pointerId,kind:tool==='select'?'part-select':'part-edit'};}
      else if($('pixel-canvas').hasPointerCapture(event.pointerId))$('pixel-canvas').releasePointerCapture(event.pointerId);
    } catch(error) {state.inPlaceEdit.error=error.message;if($('pixel-canvas').hasPointerCapture(event.pointerId))$('pixel-canvas').releasePointerCapture(event.pointerId);}
    renderInPlaceControls();renderSelection();renderCanvas();renderPreview();return;
  }
  const hit=hitTestObject(state.project,currentAnimation(),currentFrame(),point.x,point.y);
  const selected=selectedObject(), selectedNode=celObjects(currentFrame().cels.find(c=>c.layerId===selected.layerId)).find(n=>n.key===selected.key);
  if(tool==='object' || tool==='resize' || (hit?.type==='instance' && !['select','wand','eyedropper','eraser'].includes(tool) && ((!state.objectSelection && hit.layerId===currentLayer().id) || selectedNode?.instance))) {
    if($('pixel-canvas').hasPointerCapture(event.pointerId))$('pixel-canvas').releasePointerCapture(event.pointerId);
    beginObjectMove(event,point,hit);return;
  }
  const layer = currentLayer();
  if(hasLockedInstances(currentFrame().cels.find(c=>c.layerId===layer.id))){toast('Unlock objects in this group before painting local pixel edits.');if($('pixel-canvas').hasPointerCapture(event.pointerId))$('pixel-canvas').releasePointerCapture(event.pointerId);return;}
  if (!layer.visible || layer.locked) {
    toast(`“${layer.name}” is ${layer.locked ? 'locked. Unlock it' : 'hidden. Show it'} before drawing.`);
    if ($('pixel-canvas').hasPointerCapture(event.pointerId)) $('pixel-canvas').releasePointerCapture(event.pointerId);
    return;
  }
  const cel = currentFrame().cels.find(cel => cel.layerId === layer.id);
  if (tool==='select') { beginSelection(event,point,cel); return; }
  if (tool==='wand') { if($('pixel-canvas').hasPointerCapture(event.pointerId))$('pixel-canvas').releasePointerCapture(event.pointerId); wandSelect(point,cel,event.shiftKey); return; }
  if (tool==='gradient') {
    try{state.drawing=beginGradient({pointerId:event.pointerId,tool,origin:point,last:point,before:snapshot(),cel,base:[...cel.pixels]});}
    catch(error){toast(error.message);if($('pixel-canvas').hasPointerCapture(event.pointerId))$('pixel-canvas').releasePointerCapture(event.pointerId);}
    renderCanvas();return;
  }
  state.drawing = {pointerId:event.pointerId,tool,origin:point,last:point,before:snapshot(),cel,base:[...cel.pixels],color:tool === 'eraser' ? -1 : state.color,shade,touched:new Set(),footprint:new Set(),path:[{...point}]};
  if (tool === 'fill') floodFill(cel.pixels, point.x, point.y, state.drawing.color, state.project.width, state.project.height);
  else if(tool==='replace') {state.drawing.replaceFrom=cel.pixels[point.y*state.project.width+point.x];cel.pixels=replaceColor(cel.pixels,state.project.width,state.project.height,state.drawing.replaceFrom,state.drawing.color);}
  else {
    const from=event.shiftKey?shiftLineStart(tool):null;
    drawPoints(from?linePoints(from.x,from.y,point.x,point.y):[point], state.drawing.color);
  }
  renderCanvas(); renderPreview();
}
function pointerMove(event) {
  state.shiftHeld=event.shiftKey;
  const point = canvasPoint(event, !!state.drawing && !unclampedDrawing(state.drawing));
  state.cursor = inside(point) ? point : null;
  $('cursor-position').textContent = state.cursor ? `X ${String(point.x).padStart(2,'0')}   Y ${String(point.y).padStart(2,'0')}` : 'X —   Y —';
  const drawing = state.drawing;
  if (drawing && event.pointerId === drawing.pointerId) {
    if(drawing.kind==='part-select') {
      moveInPlaceSelection(state.inPlaceEdit.session,drawing,point);
      renderSelection();
    } else if(drawing.kind==='part-edit') {
      moveInPlaceStroke(state.inPlaceEdit.session,drawing,point,event.shiftKey);
      renderInPlaceControls();
    } else if(drawing.tool==='resize') {
      const raw=canvasPoint(event), box=resizeBox(drawing.box,drawing.handle,raw.x-drawing.origin.x,raw.y-drawing.origin.y,{keepArea:state.resizeMode==='area',keepRatio:event.shiftKey,area:drawing.area});
      try{state.project=resizeObject(drawing.before.project,drawing.target,drawing.key,box,state.objectScope);renderResizeOptions();}
      catch(error){$('cursor-position').textContent=error.message;}
    } else if(drawing.tool==='rotate') {
      const at=canvasPosition(event);
      let delta=Math.round((Math.atan2(at.y-drawing.centre.y,at.x-drawing.centre.x)-drawing.start)*180/Math.PI);
      if(event.shiftKey)delta=Math.round((drawing.startAngle+delta)/15)*15-drawing.startAngle;
      try{state.project=rotateObjects(drawing.before.project,drawing.target,drawing.items,delta,state.objectScope);renderResizeOptions();}
      catch(error){$('cursor-position').textContent=error.message;}
    } else if(drawing.tool==='tilt') {
      moveTilt(drawing,event);
    } else if(drawing.tool==='object') {
      try{state.project=drawing.items?translateObjects(drawing.before.project,drawing.target,drawing.items,point.x-drawing.origin.x,point.y-drawing.origin.y,state.objectScope).project:translateObject(drawing.before.project,drawing.target,drawing.key,point.x-drawing.origin.x,point.y-drawing.origin.y,state.objectScope);}
      catch(error){$('cursor-position').textContent=error.message;}
    } else if (drawing.tool==='select') {
      updateSelection(point);
    } else if (FREEHAND_TOOLS.includes(drawing.tool)) {
      drawFreehand(drawing, drawing.last, point);
    } else if(drawing.tool==='line') {
      drawing.cel.pixels=[...drawing.base];drawing.footprint.clear();
      const end=event.shiftKey?snapLineEnd(drawing.origin,point):point;
      drawPoints(lineToolPoints(drawing.origin,end),drawing.color);
    } else if(drawing.tool==='gradient') {
      moveGradient(drawing,point,event);
    } else if (drawing.tool === 'rectangle' || drawing.tool === 'ellipse') {
      drawing.cel.pixels = [...drawing.base];drawing.footprint.clear();
      let end = point;
      if (event.shiftKey) {
        const dx = point.x - drawing.origin.x, dy = point.y - drawing.origin.y;
        const length = Math.max(Math.abs(dx), Math.abs(dy));
        const sx = Math.sign(dx) || 1, sy = Math.sign(dy) || 1;
        const bound = Math.min(length, sx > 0 ? state.project.width-1-drawing.origin.x : drawing.origin.x, sy > 0 ? state.project.height-1-drawing.origin.y : drawing.origin.y);
        end = {x:drawing.origin.x + sx*bound, y:drawing.origin.y + sy*bound};
      }
      const getPoints = drawing.tool === 'rectangle' ? rectanglePoints : ellipsePoints;
      drawPoints(getPoints(drawing.origin.x, drawing.origin.y, end.x, end.y, state.filled, state.project.width, state.project.height), drawing.color);
    }
    drawing.last = point;
    renderPreview();
  }
  renderCanvas();
}
function pointerEnd(event) {
  if (!state.drawing || event.pointerId !== state.drawing.pointerId) return;
  finishDrawing(event.type === 'pointercancel');
  if (event.pointerType !== 'mouse') state.cursor = null;
  renderAll();
}
/** With the Edit switch on All frames, a finished paint stroke changes the same pixels in every frame of the animation. Returns frames skipped because of locked objects. */
function repeatStrokeInAnimation(drawing) {
  if(state.objectScope!=='animation' || !PAINT_TOOLS.includes(drawing.tool) || !drawing.cel)return 0;
  const {width,height,palette}=state.project;
  let skipped=0;
  for(const frame of currentAnimation().frames) {
    const cel=frame.cels.find(c=>c.layerId===drawing.cel.layerId);
    if(!cel || cel===drawing.cel)continue;
    if(hasLockedInstances(cel)){skipped++;continue;}
    // Fill and Replace depend on each frame's colors: Fill repeats the filled area, Replace swaps the color in every frame.
    cel.pixels=drawing.tool==='replace'?replaceColor(cel.pixels,width,height,drawing.replaceFrom,drawing.color)
      :repeatPixelChanges(drawing.tool==='fill'?changedIndices(drawing.base,drawing.cel.pixels):drawing.footprint,drawing.cel.pixels,cel.pixels,drawing.tool==='shade'?v=>v<0?v:shadeIndex(palette,v,drawing.shade):null);
  }
  return skipped;
}
function finishDrawing(cancel = false) {
  const drawing = state.drawing;
  if (!drawing) return false;
  state.drawing = null;
  if(!cancel && FREEHAND_TOOLS.includes(drawing.tool))state.lastPaint={...drawing.last,documentId:state.documentId};
  if(drawing.kind==='part-select' || drawing.kind==='part-edit') {
    (drawing.kind==='part-select'?finishInPlaceSelection:finishInPlaceStroke)(state.inPlaceEdit.session,drawing,cancel);
    if($('pixel-canvas').hasPointerCapture(drawing.pointerId))$('pixel-canvas').releasePointerCapture(drawing.pointerId);
    renderTools();renderCanvas();renderPreview();return true;
  }
  if (cancel) {
    if(['object','resize','rotate','tilt'].includes(drawing.tool))state.project=drawing.before.project;
    else drawing.cel.pixels = drawing.base;
    if (drawing.tool==='select') state.selection=drawing.previousSelection;
  }
  else {
    try { if(drawing.finish)drawing.finish(); const skipped=repeatStrokeInAnimation(drawing); remember(drawing.before); if(skipped)toast(`Painted every frame except ${skipped} with locked objects.`); }
    catch(error) { state.project=drawing.before.project; normalizeSelection(); toast(`Could not apply stroke: ${error.message}`); }
  }
  if ($('pixel-canvas').hasPointerCapture(drawing.pointerId)) $('pixel-canvas').releasePointerCapture(drawing.pointerId);
  return true;
}

function addFrame(duplicate = false) {
  if (!canAddFrame()) { toast('This project has reached its frame limit.'); return; }
  mutate(() => {
    const animation = currentAnimation();
    const index = animation.frames.findIndex(frame => frame.id === state.frameId);
    const sourceDuration = currentFrame().duration;
    const frame = makeLayeredFrame(state.project,duplicate ? currentFrame() : undefined);
    frame.duration = duplicate ? sourceDuration : Math.round(1000 / animation.fps);
    animation.frames.splice(index + 1, 0, frame);
    state.frameId = frame.id;
    state.previewIndex = index + 1;
  });
  $('frame-list').querySelector('.selected')?.scrollIntoView({block:'nearest',inline:'nearest'});
}
function deleteFrame() {
  if (currentAnimation().frames.length <= 1) return;
  mutate(() => {
    const animation = currentAnimation();
    const index = animation.frames.findIndex(frame => frame.id === state.frameId);
    animation.frames.splice(index, 1);
    state.frameId = animation.frames[Math.min(index,animation.frames.length-1)].id;
  });
}
function moveFrame(direction) {
  const frames = currentAnimation().frames;
  const index = frames.findIndex(frame => frame.id === state.frameId);
  const target = index + direction;
  if (target < 0 || target >= frames.length) return;
  mutate(() => { [frames[index],frames[target]] = [frames[target],frames[index]]; });
}
function canDuplicateAnimation() {
  const count=totalFrames()+currentAnimation().frames.length;
  return state.project.animations.length<100 && count<=1024 && count*state.project.layers.length*state.project.width*state.project.height<=MAX_TOTAL_PIXELS;
}
function uniqueAnimationName(base) {
  const names=new Set(state.project.animations.map(animation=>animation.name.toLowerCase()));
  const name=base.slice(0,72);
  let candidate=name,index=2;
  while(names.has(candidate.toLowerCase())) candidate=`${name} ${index++}`;
  return candidate;
}
function duplicateAnimation(operation=null, name=null) {
  finishDrawing();
  if(!canDuplicateAnimation()){toast('This project has reached its animation or pixel limit.');return;}
  const source=currentAnimation(),copy=clone(source);
  copy.id=uid();copy.name=name || uniqueAnimationName(`${source.name} copy`);
  copy.frames.forEach(frame=>{
    frame.id=uid();
    if(operation) for(const cel of frame.cels) writeCelPixels(cel,transformPixels(cel.pixels,state.project.width,state.project.height,null,operation).pixels,state.project.width);
  });
  mutate(()=>{
    const index=state.project.animations.findIndex(animation=>animation.id===source.id);
    state.project.animations.splice(index+1,0,copy);state.animationId=copy.id;state.frameId=copy.frames[0].id;
    state.selection=null;state.previewIndex=0;state.previewTime=0;
  });
  toast(`${operation?'Mirrored':'Copied'} all ${copy.frames.length} frames and every object into “${copy.name}”.`);
}
function mirrorAnimationDialog() {
  if(!canDuplicateAnimation()) return;
  const source=currentAnimation();
  const alternate=source.name.replace(/(^|[\s_-])(right|left)(?=$|[\s_-])/i,(_,prefix,direction)=>`${prefix}${direction.toLowerCase()==='right'?'left':'right'}`);
  const name=uniqueAnimationName(alternate===source.name?`${source.name} mirrored`:alternate);
  openDialog('Mirror this animation',`<form id="mirror-animation-form"><p class="modal-body-text">Create a mirrored copy of all ${source.frames.length} frames, including every object and each frame’s timing.</p><label class="field"><span class="field-label">New animation name</span><input id="mirror-animation-name" value="${escapeHTML(name)}" maxlength="80" required autocomplete="off"></label><label class="field"><span class="field-label">Mirror direction</span><select id="mirror-animation-axis"><option value="flip-h">Left ↔ right</option><option value="flip-v">Top ↔ bottom</option></select></label><div class="modal-actions"><button type="button" id="cancel-mirror" class="button">Cancel</button><button type="submit" class="button primary">Create mirrored animation</button></div></form>`,'ANIMATION');
  $('cancel-mirror').onclick=()=>$('modal').close();
  $('mirror-animation-name').oninput=()=>$('mirror-animation-name').setCustomValidity('');
  $('mirror-animation-form').onsubmit=event=>{
    event.preventDefault();
    const chosen=$('mirror-animation-name').value.trim();
    if(!chosen) return;
    if(state.project.animations.some(animation=>animation.name.toLowerCase()===chosen.toLowerCase())) {
      $('mirror-animation-name').setCustomValidity('Choose a name that is not used by another animation.');$('mirror-animation-name').reportValidity();return;
    }
    duplicateAnimation($('mirror-animation-axis').value,chosen);$('modal').close();
  };
  $('mirror-animation-name').focus();$('mirror-animation-name').select();
}
function reverseAnimation() {
  if(currentAnimation().frames.length<2) return;
  mutate(()=>{currentAnimation().frames.reverse();state.previewIndex=currentAnimation().frames.findIndex(frame=>frame.id===state.frameId);state.previewTime=0;});
  toast('Frame order reversed. Frame timing stays with each frame.');
}
function togglePlay() {
  state.playing = !state.playing;
  state.previewIndex = currentAnimation().frames.findIndex(frame => frame.id === state.frameId);
  state.previewTime = 0;
  renderPlaybackControls(); renderPreview();
}
function animationTick(time) {
  const { animation, playing } = previewAnimation();
  if (playing && !document.hidden) {
    if (!state.previewTime) state.previewTime = time;
    let changed = false;
    let duration = animation.frames[state.previewIndex % animation.frames.length].duration || 1000 / animation.fps;
    let steps = 0;
    while (time - state.previewTime >= duration && steps < 1024) {
      state.previewTime += duration;
      state.previewIndex = (state.previewIndex + 1) % animation.frames.length;
      duration = animation.frames[state.previewIndex].duration || 1000 / animation.fps;
      changed = true;
      steps++;
    }
    if (changed) renderPreview();
  } else state.previewTime = 0;
  requestAnimationFrame(animationTick);
}

function openDialog(title, content, eyebrow = 'PIXEL STUDIO') {
  if (finishDrawing()) renderAll();
  $('modal').dispatchEvent(new Event('pixel-studio:dialog-replace'));
  $('modal').classList.remove('wide','start-modal','part-library-modal','prompt-builder-modal','ai-edit-modal','shared-part-modal','palette-studio-modal');
  $('modal-title').textContent = title;
  $('modal-eyebrow').textContent = eyebrow;
  $('modal-content').innerHTML = content;
  $('modal').setAttribute('aria-labelledby', 'modal-title');
  if (!$('modal').open) $('modal').showModal();
}
function promptBuilderDialog(initial) {
  openPromptBuilder({project:state.project,documentId:state.documentId,openDialog,openImport:importAITextDialog,toast,initial});
}
function aiEditDialog() {
  if (finishDrawing()) renderAll();
  const sourceRevision = state.documents.get(state.documentId)?.revision;
  openAIEdit({
    layerId: currentLayer().id, selection: state.selection?.rect || null,
    project: state.project, animationId: currentAnimation().id, frameId: currentFrame().id,
    documentId: state.documentId, openDialog, toast,
    onApply(proposedProject, sourceProject, documentId) {
      if (state.documentId !== documentId || state.documents.get(documentId)?.revision !== sourceRevision || JSON.stringify(state.project) !== JSON.stringify(sourceProject)) {
        throw new Error('This project changed after the edit started. Open AI edit again to work from the latest artwork.');
      }
      const clean = validateProject(proposedProject);
      mutate(() => { state.project = clean; state.selection = null; state.previewTime = 0; });
      toast('AI edit applied. Undo restores your previous artwork.');
    },
  });
}
function animationDialog(id = null) {
  const existing = state.project.animations.find(a => a.id === id);
  if (!existing && (state.project.animations.length >= 100 || !hasFrameCapacity())) { toast('This project has reached its animation or frame limit.'); return; }
  const name = existing?.name || `Animation ${state.project.animations.length + 1}`;
  openDialog(existing ? 'Rename animation' : 'A new little motion', `<form id="animation-form"><p class="modal-body-text">${existing ? 'Give this animation a name that makes sense to you.' : 'Each animation has its own frames and playback speed.'}</p><label class="field"><span class="field-label">Animation name</span><input id="new-animation-name" value="${escapeHTML(name)}" maxlength="80" required autocomplete="off"></label>${existing ? '' : '<label class="check-row"><input id="animation-copy" type="checkbox" checked><span>Start with a copy of the current frame</span></label>'}<div class="modal-actions"><button type="button" class="button" id="cancel-animation">Cancel</button><button type="submit" class="button primary">${existing ? 'Save name' : 'Create animation'}</button></div></form>`, 'ANIMATIONS');
  $('cancel-animation').onclick = () => $('modal').close();
  $('animation-form').onsubmit = (event) => {
    event.preventDefault();
    const chosenName = $('new-animation-name').value.trim();
    if (!chosenName) return;
    if (state.project.animations.some(a => a.id !== id && a.name.toLowerCase() === chosenName.toLowerCase())) {
      $('new-animation-name').setCustomValidity('An animation with this name already exists.');
      $('new-animation-name').reportValidity();
      return;
    }
    const copy = $('animation-copy')?.checked;
    mutate(() => {
      if (existing) existing.name = chosenName;
      else {
        const frame = makeLayeredFrame(state.project,copy ? currentFrame() : undefined);
        const animation = {id:uid(),name:chosenName,fps:8,frames:[frame],...(copy && currentAnimation().layerOrder ? {layerOrder:[...currentAnimation().layerOrder]} : {})};
        state.project.animations.push(animation);
        state.animationId = animation.id;
        state.frameId = frame.id;
        state.previewIndex = 0;
      }
    });
    $('modal').close();
  };
  $('new-animation-name').oninput = () => $('new-animation-name').setCustomValidity('');
  $('new-animation-name').focus();
  $('new-animation-name').select();
}
function dimensionFields(prefix, width, height) {
  const sizes = [16,24,32,48,64,96,128];
  const preset = width === height && sizes.includes(width) ? String(width) : 'custom';
  return `<div class="canvas-size-fields"><label class="field"><span class="field-label">Canvas size</span><select id="${prefix}-preset">${sizes.map(size=>`<option value="${size}"${preset === String(size) ? ' selected' : ''}>${size} × ${size}</option>`).join('')}<option value="custom"${preset === 'custom' ? ' selected' : ''}>Custom dimensions</option></select></label><div class="form-grid"><label class="field"><span class="field-label">Width (pixels)</span><input id="${prefix}-width" type="number" min="1" max="${MAX_SIZE}" step="1" value="${width}" required></label><label class="field"><span class="field-label">Height (pixels)</span><input id="${prefix}-height" type="number" min="1" max="${MAX_SIZE}" step="1" value="${height}" required></label></div></div>`;
}
function bindDimensionFields(prefix, onChange = () => {}) {
  $(`${prefix}-preset`).onchange = event => {
    if (event.target.value !== 'custom') $(`${prefix}-width`).value = $(`${prefix}-height`).value = event.target.value;
    onChange();
  };
  for (const axis of ['width','height']) $(`${prefix}-${axis}`).oninput = () => { $(`${prefix}-preset`).value = 'custom'; onChange(); };
}
function readDimensions(prefix) {
  const width = Number($(`${prefix}-width`).value), height = Number($(`${prefix}-height`).value);
  if (![width,height].every(value => Number.isInteger(value) && value >= 1 && value <= MAX_SIZE)) throw new Error(`Width and height must be whole numbers from 1 to ${MAX_SIZE}.`);
  return {width,height};
}
function resizeDialog() {
  openDialog('A little more room', `<form id="resize-form"><p class="modal-body-text">Resize every frame in every animation. Rectangular canvases work too.</p>${dimensionFields('resize',state.project.width,state.project.height)}<label class="field"><span class="field-label">How to resize</span><select id="resize-mode"><option value="canvas">Resize canvas · center, pad or crop</option><option value="scale">Scale artwork · nearest-neighbor pixels</option></select></label><p class="helper-text">Canvas resize keeps each original pixel the same size. Scaling resizes your artwork. Resizing bakes reusable cels into pixels; Undo restores the original structure.</p><div class="modal-actions"><button type="button" class="button" id="cancel-resize">Cancel</button><button type="submit" class="button primary">Resize all frames</button></div></form>`, 'CANVAS SIZE');
  bindDimensionFields('resize');
  $('cancel-resize').onclick = () => $('modal').close();
  $('resize-form').onsubmit = event => {
    event.preventDefault();
    try {
      const {width,height} = readDimensions('resize');
      if (width * height * totalFrames() * state.project.layers.length > MAX_TOTAL_PIXELS) throw new Error('There are too many layers and frames for this canvas size. Use a smaller size or fewer layers or frames.');
      const oldWidth = state.project.width, oldHeight = state.project.height, mode = $('resize-mode').value;
      mutate(() => {
        forEachFrame(frame => { for (const cel of frame.cels) cel.pixels = resizePixels(cel.pixels,oldWidth,oldHeight,width,height,mode); });
        state.project.width = width; state.project.height = height;
        state.cursor = null; state.fit = true;
      });
      fitCanvas(); $('modal').close(); toast(`Every frame now has a ${width} × ${height} canvas.`);
    } catch (error) { toast(error.message); }
  };
}
function newProjectDialog({welcome=false}={}) {
  openDialog(welcome?'Welcome to Pixel Studio':'Start something new', `<div class="start-screen"><section class="start-blank"><form id="new-project-form"><p class="modal-body-text">Choose your canvas. What will you make?</p><label class="field"><span class="field-label">Project name</span><input id="new-project-name" value="Untitled sprite" maxlength="80" required autocomplete="off"></label>${dimensionFields('new',32,32)}<label class="check-row"><input id="keep-palette" type="checkbox" checked><span>Keep my current color palette</span></label><p class="helper-text">Opens in a new tab. Your other projects stay open.</p><div class="notice"><strong>Start from an idea</strong><p>Build a prompt with the pixel format and your animation plan. No example artwork needed.</p><button type="button" id="new-project-prompt" class="text-button">Build an AI prompt ↗</button></div><div class="modal-actions"><button type="button" class="button" id="cancel-new">${welcome?'Keep exploring':'Cancel'}</button><button type="submit" class="button primary">Create project</button></div></form></section><section class="start-examples" aria-labelledby="start-examples-title"><div class="start-examples-head"><h3 id="start-examples-title" class="start-heading">Or open an example</h3><button type="button" id="download-samples" class="text-button">Data files ↗</button></div><div id="start-sample-list" class="start-sample-list"></div></section></div>`, welcome?'WELCOME':'NEW PROJECT');
  $('modal').classList.add('start-modal');
  renderSampleCards($('start-sample-list'));
  $('download-samples').onclick = samplesDialog;
  bindDimensionFields('new');
  $('cancel-new').onclick = () => $('modal').close();
  $('new-project-prompt').onclick=()=>{
    try {
      const {width,height}=readDimensions('new');
      promptBuilderDialog({name:$('new-project-name').value.trim() || 'New pixel art',width,height,paletteMode:$('keep-palette').checked?'current':'auto'});
    } catch(error) {toast(error.message);}
  };
  $('new-project-form').onsubmit = event => {
    event.preventDefault();
    const name = $('new-project-name').value.trim();
    if (!name) return;
    const {width,height} = readDimensions('new');
    const project = blankProject(name,width,height);
    if ($('keep-palette').checked) project.palette = [...state.project.palette];
    replaceProject(project, 'A fresh canvas, ready for your first pixel.');
    $('modal').close();
  };
  $('new-project-name').focus();
  $('new-project-name').select();
}
function importDialog() {
  openDialog('Bring your pixels in', `<p class="modal-body-text">Pick up a project, paste AI pixel data, or slice a whole animation sheet.</p><div class="import-choices"><button class="choice-card" id="choose-data">${icon('file')}<span><strong>Pixel data file</strong><small>AI text .pxa, compact .pxs, or legacy .pixel.json.</small></span>${icon('chevron')}</button><button class="choice-card" id="choose-ai-text">${icon('select')}<span><strong>Paste AI pixel data</strong><small>Turn an AI response into editable pixels and animations.</small></span>${icon('chevron')}</button><button class="choice-card" id="choose-png">${icon('image')}<span><strong>PNG image</strong><small>A new sprite, frame, or pixel object.</small></span>${icon('chevron')}</button><button class="choice-card" id="choose-sheet">${icon('grid')}<span><strong>Spritesheet PNG</strong><small>Rows become animations. Columns become frames.</small></span>${icon('chevron')}</button></div>${skipEmptyControl('import-skip-empty')}<p class="helper-text">Fully transparent frames and empty animation rows are skipped. Uncheck to preserve intentional blank frames. Artwork on hidden layers is kept in pixel data.</p><div class="notice">Everything is edited in your browser. Your images and project files are not uploaded.</div>`, 'IMPORT');
  bindSkipEmpty('import-skip-empty');
  $('choose-data').onclick = () => { $('modal').close(); $('data-file-input').click(); };
  $('choose-ai-text').onclick = importAITextDialog;
  $('choose-png').onclick = () => { $('modal').close(); $('png-file-input').click(); };
  $('choose-sheet').onclick = () => { $('modal').close(); $('sheet-file-input').click(); };
}
function skipEmptyControl(id) {
  return `<label class="check-row"><input id="${id}" type="checkbox"${state.importSkipEmpty?' checked':''}><span>Skip empty frames</span></label>`;
}
function bindSkipEmpty(id) { $(id).onchange = event => { state.importSkipEmpty=event.target.checked; }; }
async function readPixelData(bytes, expectedFormat='auto') {
  const binary = [80,88,83,84].every((value,index)=>bytes[index]===value);
  if (binary || expectedFormat==='binary') return decodePixelProject(bytes);
  const text=new TextDecoder().decode(bytes);
  const firstLine=text.split(/\r?\n/).map(line=>line.trim()).find(line=>line && !line.startsWith('#')) || '';
  if (expectedFormat==='ai' || /^PXA\s/.test(firstLine)) return decodeAIProject(text);
  let input;
  try { input=JSON.parse(text); }
  catch { throw new Error('Choose a Pixel Studio .pxa or .pxs file, or a legacy .pixel.json file. This data could not be read.'); }
  return validateProject(input);
}
function acceptImportedProject(clean) {
  const {project,skippedFrames,skippedAnimations} = state.importSkipEmpty ? stripEmptyFrames(clean) : {project:clean,skippedFrames:0,skippedAnimations:0};
  const skipped = skippedFrames ? ` Skipped ${skippedFrames} empty frame${skippedFrames===1?'':'s'}${skippedAnimations?` and ${skippedAnimations} empty animation${skippedAnimations===1?'':'s'}`:''}.` : '';
  replaceProject(project, `${project.name} imported with objects, animations, and colors.${skipped}`);
}
function importAITextDialog() {
  openDialog('From a prompt to pixels', `<p class="modal-body-text">Paste the complete <strong>PXA 1</strong> response from ChatGPT. To create new artwork, use <button id="import-build-prompt" class="text-button">AI prompt</button> to describe it and plan its animations. For edits, Export → AI pixel data → Copy AI prompt includes your current artwork.</p><form id="import-ai-form"><label class="field"><span class="field-label">AI pixel data</span><textarea id="ai-import-text" class="ai-text-input" spellcheck="false" autocapitalize="off" placeholder="PXA 1&#10;SIZE 32 32&#10;…" required></textarea></label>${skipEmptyControl('ai-skip-empty')}<p class="helper-text">Layers, colors, and animations are validated before opening a new project tab. Your other projects stay open. Uncheck “Skip empty frames” to keep deliberate blank frames.</p><p id="ai-import-error" class="sheet-error" role="alert" hidden></p><div class="modal-actions"><button type="button" id="cancel-ai-import" class="button">Cancel</button><button class="button primary" type="submit">Import AI pixel data</button></div></form>`, 'AI PIXEL DATA');
  bindSkipEmpty('ai-skip-empty');
  $('import-build-prompt').onclick=()=>promptBuilderDialog();
  $('cancel-ai-import').onclick=()=>$('modal').close();
  $('import-ai-form').onsubmit=event=>{
    event.preventDefault();
    try {
      let text=$('ai-import-text').value.trim();
      if (/^```(?:pxa|text|plaintext)?\s*\n/i.test(text) && /\n```\s*$/.test(text)) text=text.replace(/^```(?:pxa|text|plaintext)?\s*\n/i,'').replace(/\n```\s*$/,'');
      acceptImportedProject(decodeAIProject(text));
      $('modal').close();
    } catch(error) { $('ai-import-error').textContent=error.message; $('ai-import-error').hidden=false; }
  };
  $('ai-import-text').focus();
}
const PROJECT_FILE=/\.(pxa|pxs|pixel|json)$/i;
function hasFiles(event) { return [...(event.dataTransfer?.types || [])].includes('Files'); }
function showFileDrop(show) {
  $('file-drop-hint').hidden=!show;
}
/** Open dropped projects in new tabs, one after another; a dropped PNG uses the PNG import dialog. */
async function openDroppedFiles(files) {
  if(state.inPlaceEdit){toast('Apply or cancel the canvas object edit before opening files.');return;}
  const projects=files.filter(file=>PROJECT_FILE.test(file.name)), png=files.find(file=>/\.png$/i.test(file.name) || file.type==='image/png');
  if(!projects.length && !png){toast('Drop a .pxa, .pxs or .pixel.json project, or a PNG image.');return;}
  for(const file of projects)await importData(file);
  if(png && !$('modal').open)await importPng(png);
}
function bindFileDrop() {
  const stage=$('canvas-stage');
  let depth=0;
  stage.addEventListener('dragenter',event=>{if(!hasFiles(event))return;event.preventDefault();depth++;showFileDrop(true);});
  stage.addEventListener('dragover',event=>{if(!hasFiles(event))return;event.preventDefault();event.dataTransfer.dropEffect='copy';});
  stage.addEventListener('dragleave',event=>{if(!hasFiles(event))return;depth=Math.max(0,depth-1);if(!depth)showFileDrop(false);});
  // Parts dragged from the sidebar: place where they are dropped.
  const isPart=event=>[...event.dataTransfer.types].includes(PART_DRAG_TYPE);
  stage.addEventListener('dragover',event=>{if(!isPart(event))return;event.preventDefault();event.dataTransfer.dropEffect='copy';stage.classList.add('part-drop-target');});
  stage.addEventListener('dragleave',event=>{if(isPart(event) && !stage.contains(event.relatedTarget))stage.classList.remove('part-drop-target');});
  stage.addEventListener('drop',event=>{
    if(!isPart(event))return;
    event.preventDefault();stage.classList.remove('part-drop-target');
    try{placePartAt(event.dataTransfer.getData(PART_DRAG_TYPE),canvasPoint(event));}catch(error){toast(error.message);}
  });
  stage.addEventListener('drop',event=>{
    if(!hasFiles(event))return;
    event.preventDefault();depth=0;showFileDrop(false);
    openDroppedFiles([...event.dataTransfer.files]);
  });
  // A file dropped beside the canvas should not navigate away from the editor.
  for(const type of ['dragover','drop'])window.addEventListener(type,event=>{if(hasFiles(event) && !stage.contains(event.target))event.preventDefault();});
}
async function importData(file) {
  try {
    if (file.size > 25 * 1024 * 1024) throw new Error('Please choose a pixel data file smaller than 25 MB.');
    const format=/\.pxs$/i.test(file.name)?'binary':/\.pxa$/i.test(file.name)?'ai':'auto';
    acceptImportedProject(await readPixelData(new Uint8Array(await file.arrayBuffer()),format));
  } catch (error) { showImportError(error.message); }
}
function showImportError(message) {
  openDialog('Could not import this file', `<p class="modal-body-text">${escapeHTML(message)}</p><div class="notice">Your current project is still here, unchanged.</div><div class="modal-actions"><button id="try-import" class="button primary">Choose another file</button></div>`, 'IMPORT');
  $('try-import').onclick = importDialog;
}
async function decodePng(file) {
  let url;
  try {
    if (file.size > 25 * 1024 * 1024) throw new Error('Please choose a PNG smaller than 25 MB.');
    const header = new Uint8Array(await file.slice(0,24).arrayBuffer());
    if (header.length < 24 || ![137,80,78,71,13,10,26,10].every((n,i) => header[i] === n)) throw new Error('This file is not a PNG image. Please choose a .png file.');
    const headerView = new DataView(header.buffer);
    const width = headerView.getUint32(16), height = headerView.getUint32(20);
    if (width > 16384 || height > 16384 || width * height > 32 * 1024 * 1024) throw new Error('Please use a PNG under 32 megapixels, with no edge larger than 16,384 pixels.');
    url = URL.createObjectURL(file);
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally { if (url) URL.revokeObjectURL(url); }
}
async function importPng(file) {
  try {
    const image = await decodePng(file);
    const targetWidth = image.width <= MAX_SIZE ? image.width : state.project.width;
    const targetHeight = image.height <= MAX_SIZE ? image.height : state.project.height;
    const defaultSizing = image.width <= targetWidth && image.height <= targetHeight ? 'actual' : 'fit';
    openDialog('Make it fit your canvas', `<p class="modal-body-text">${escapeHTML(file.name)} · ${image.width} × ${image.height} pixels</p><div class="png-import-preview"><canvas id="png-import-canvas"></canvas></div><label class="field"><span class="field-label">Import into</span><select id="png-destination"><option value="project">New project · use the PNG colors</option><option value="frame">New frame · on the selected layer</option><option value="layer">New layer · in the current frame</option></select></label><div id="png-dimensions">${dimensionFields('png',targetWidth,targetHeight)}</div><label class="field"><span class="field-label">Image sizing</span><select id="png-sizing"><option value="fit"${defaultSizing === 'fit' ? ' selected' : ''}>Fit inside the canvas · sharp nearest-neighbor scaling</option><option value="actual"${defaultSizing === 'actual' ? ' selected' : ''}>Keep original pixels · center and crop if needed</option></select></label>${skipEmptyControl('png-skip-empty')}<p class="helper-text">A new layer or frame uses your current canvas and fixed palette. PNGs contain one flattened image. Transparency is preserved; partially transparent pixels become solid or clear.</p><p id="png-import-error" class="sheet-error" role="alert" hidden></p><div class="modal-actions"><button id="cancel-png" class="button">Cancel</button><button id="confirm-png" class="button primary">Import PNG</button></div>`, 'PNG IMPORT');
    bindSkipEmpty('png-skip-empty');
    let rgba, canvasSize;
    const updatePreview = () => {
      $('png-import-error').hidden = true;
      try { canvasSize = $('png-destination').value !== 'project' ? {width:state.project.width,height:state.project.height} : readDimensions('png'); }
      catch { $('confirm-png').disabled = true; return; }
      $('confirm-png').disabled = false;
      const {width:canvasWidth,height:canvasHeight} = canvasSize;
      const canvas = $('png-import-canvas');
      canvas.width = canvasWidth; canvas.height = canvasHeight;
      const context = canvas.getContext('2d', {willReadFrequently:true});
      context.imageSmoothingEnabled = false;
      const ratio = $('png-sizing').value === 'fit' ? Math.min(canvasWidth / image.width, canvasHeight / image.height) : 1;
      const width = Math.max(1,Math.round(image.width * ratio)), height = Math.max(1,Math.round(image.height * ratio));
      context.drawImage(image, Math.floor((canvasWidth-width)/2), Math.floor((canvasHeight-height)/2), width, height);
      rgba = context.getImageData(0,0,canvasWidth,canvasHeight).data;
    };
    bindDimensionFields('png',updatePreview);
    $('png-destination').onchange = () => { $('png-dimensions').hidden = $('png-destination').value !== 'project'; updatePreview(); };
    $('png-sizing').onchange = updatePreview;
    $('cancel-png').onclick = () => $('modal').close();
    $('confirm-png').onclick = () => {
      try {
        const {width,height} = canvasSize, destination=$('png-destination').value;
        const palette=destination==='project' ? paletteFromRgba(rgba,MAX_COLORS) : state.project.palette;
        const pixels=mapRgbaToPalette(rgba,palette,width,height);
        if (state.importSkipEmpty && pixels.every(color=>color<0)) throw new Error('This PNG is fully transparent at this size. Nothing was imported. Uncheck “Skip empty frames” to keep it.');
        if (destination === 'frame') {
          if (!canAddFrame()) throw new Error('This project has reached its frame or pixel limit.');
          if (!canEditPixels()) throw new Error('Select visible pixel artwork and unlock its objects before importing a frame.');
          mutate(() => {
            const frame = makeLayeredFrame(state.project);
            frame.cels.find(cel=>cel.layerId===state.layerId).pixels=pixels;
            frame.duration = Math.round(1000/currentAnimation().fps);
            const index = currentAnimation().frames.findIndex(f => f.id === state.frameId);
            currentAnimation().frames.splice(index + 1, 0, frame);
            state.frameId = frame.id; state.previewIndex = index + 1;
          });
          toast('PNG added as a frame on the selected layer.');
        } else if (destination === 'layer') {
          if (!canAddLayer()) throw new Error('This project has reached its layer or pixel limit.');
          mutate(() => {
            const layer=insertLayer(file.name.replace(/\.png$/i,'').slice(0,80) || 'Imported layer');
            currentFrame().cels.find(cel=>cel.layerId===layer.id).pixels=pixels;
          });
          toast('PNG added on a new layer in the current frame.');
        } else {
          const project = blankProject(file.name.replace(/\.png$/i,'').slice(0,80) || 'Imported sprite',width,height);
          project.palette=palette;
          project.animations[0].frames[0].cels[0].pixels=pixels;
          replaceProject(project, 'PNG imported on Layer 1. Every pixel is ready to edit.');
        }
        $('modal').close();
      } catch(error) { $('png-import-error').textContent=error.message; $('png-import-error').hidden=false; }
    };
    updatePreview();
  } catch (error) { showImportError(error.message || 'The PNG could not be decoded.'); }
}

async function importSpritesheet(file) {
  try {
    const image = await decodePng(file);
    const bestCell = (length, preferred) => {
      if (length % preferred === 0) return preferred;
      return [32,16,64,24,48,96,128].find(size => length % size === 0) || Math.min(length,MAX_SIZE);
    };
    let metadata = null, timingChanged = false, geometry = null, rowDrafts = [];
    openDialog('Every row has a story', `<p class="modal-body-text">${escapeHTML(file.name)} · ${image.width} × ${image.height} pixels. Each row becomes an animation; each column becomes a frame.</p><div class="sheet-preview-wrap"><canvas id="sheet-preview" aria-label="Spritesheet slicing preview"></canvas></div><div class="form-grid"><label class="field"><span class="field-label">Cell width (PNG pixels)</span><input id="sheet-cell-width" type="number" min="1" max="2048" value="${bestCell(image.width,state.project.width)}" step="1"></label><label class="field"><span class="field-label">Cell height (PNG pixels)</span><input id="sheet-cell-height" type="number" min="1" max="2048" value="${bestCell(image.height,state.project.height)}" step="1"></label><label class="field"><span class="field-label">PNG pixel scale</span><input id="sheet-scale" type="number" min="1" max="16" value="1" step="1"></label><label class="field"><span class="field-label">Default playback (FPS)</span><input id="sheet-fps" type="number" min="1" max="60" value="8" step="1"></label></div><div id="sheet-summary" class="sheet-summary"></div><p id="sheet-error" class="sheet-error" role="alert" hidden></p><div class="sheet-metadata-row"><button id="load-sheet-metadata" class="button small">${icon('file')} Load metadata</button><span id="sheet-metadata-name" class="helper-text">Optional .sheet.json file restores names and timing.</span><input id="sheet-metadata-input" type="file" accept=".json,application/json" hidden></div><div class="sheet-row-heading"><span>Row</span><span>Animation name</span><span>Frames</span></div><div id="sheet-rows" class="sheet-row-list"></div>${skipEmptyControl('sheet-skip-empty')}<p class="helper-text">Frames start in column 1. Empty cells anywhere in the selected range and empty rows are skipped by default. Uncheck to keep intentional blank frames.</p><div class="modal-actions"><button id="cancel-sheet" class="button">Cancel</button><button id="confirm-sheet" class="button primary">Import spritesheet</button></div>`, 'SPRITESHEET IMPORT');
    $('modal').classList.add('wide');
    bindSkipEmpty('sheet-skip-empty');
    const readRows = () => [...$('sheet-rows').querySelectorAll('.sheet-row')].map(row => ({name:row.querySelector('.sheet-name').value.trim(),frameCount:Number(row.querySelector('.sheet-frames').value)}));
    const drawSheet = () => {
      const canvas = $('sheet-preview');
      const ratio = Math.min(3,540/image.width,220/image.height);
      canvas.width = Math.max(1,Math.round(image.width*ratio));
      canvas.height = Math.max(1,Math.round(image.height*ratio));
      const context = canvas.getContext('2d');
      context.imageSmoothingEnabled = false;
      context.drawImage(image,0,0,canvas.width,canvas.height);
      if (!geometry) return;
      context.strokeStyle = '#285b47'; context.lineWidth = 1;
      context.beginPath();
      for (let col=1;col<geometry.columns;col++) { const x=col*geometry.pngCellWidth*canvas.width/image.width;context.moveTo(x,0);context.lineTo(x,canvas.height); }
      for (let row=1;row<geometry.rows;row++) { const y=row*geometry.pngCellHeight*canvas.height/image.height;context.moveTo(0,y);context.lineTo(canvas.width,y); }
      context.stroke();
    };
    const updateGrid = (preserveRows = true) => {
      if (preserveRows && $('sheet-rows').children.length) rowDrafts = readRows();
      try {
        const pngCellWidth = Number($('sheet-cell-width').value), pngCellHeight = Number($('sheet-cell-height').value), scale = Number($('sheet-scale').value);
        if (!Number.isInteger(scale) || scale < 1 || scale > 16) throw new Error('PNG pixel scale must be a whole number from 1 to 16.');
        if (!Number.isInteger(pngCellWidth/scale) || !Number.isInteger(pngCellHeight/scale) || image.width%scale || image.height%scale) throw new Error('The image and cell dimensions must divide evenly by the PNG pixel scale.');
        const cellWidth = pngCellWidth/scale, cellHeight = pngCellHeight/scale;
        geometry = {...inspectSheet(image.width/scale,image.height/scale,cellWidth,cellHeight),cellWidth,cellHeight,pngCellWidth,pngCellHeight,scale};
        $('sheet-summary').textContent = `${geometry.rows} animation row${geometry.rows===1?'':'s'} × ${geometry.columns} frame column${geometry.columns===1?'':'s'} · ${cellWidth} × ${cellHeight} canvas`;
        $('sheet-error').hidden = true; $('confirm-sheet').disabled = false;
        $('sheet-rows').innerHTML = Array.from({length:geometry.rows},(_,index) => {
          const name = rowDrafts[index]?.name || `Animation ${index+1}`;
          const count = Math.max(1,Math.min(geometry.columns,rowDrafts[index]?.frameCount || geometry.columns));
          return `<div class="sheet-row"><span>${String(index+1).padStart(2,'0')}</span><input class="sheet-name" value="${escapeHTML(name)}" maxlength="80" aria-label="Animation name for row ${index+1}"><input class="sheet-frames" type="number" min="1" max="${geometry.columns}" value="${count}" step="1" aria-label="Frame count for row ${index+1}"></div>`;
        }).join('');
      } catch (error) {
        geometry = null; $('sheet-summary').textContent = 'Choose the width and height of one frame.';
        $('sheet-error').textContent = error.message; $('sheet-error').hidden = false; $('confirm-sheet').disabled = true;
      }
      drawSheet();
    };
    for (const id of ['sheet-cell-width','sheet-cell-height','sheet-scale']) $(id).oninput = () => {
      metadata = null;
      $('sheet-metadata-name').textContent = 'Custom grid · load metadata to restore exact timing.';
      updateGrid();
    };
    $('sheet-fps').oninput = () => { timingChanged = true; if (metadata) $('sheet-metadata-name').textContent = 'Metadata names retained. New FPS will apply to all frames.'; };
    $('load-sheet-metadata').onclick = () => $('sheet-metadata-input').click();
    $('sheet-metadata-input').onchange = async event => {
      const metadataFile = event.target.files[0]; event.target.value = '';
      if (!metadataFile) return;
      try {
        if (metadataFile.size > 1024*1024) throw new Error('Please choose a spritesheet metadata file smaller than 1 MB.');
        const parsed = validateSheetMetadata(JSON.parse(await metadataFile.text()),image.width,image.height);
        metadata = parsed; timingChanged = false;
        $('sheet-cell-width').value = parsed.cellWidth;
        $('sheet-cell-height').value = parsed.cellHeight;
        $('sheet-scale').value = parsed.scale;
        $('sheet-fps').value = parsed.animations[0].fps;
        rowDrafts = parsed.animations.map(animation => ({name:animation.name,frameCount:animation.frameCount}));
        $('sheet-metadata-name').textContent = `${metadataFile.name} · names and timings restored`;
        updateGrid(false);
      } catch (error) { $('sheet-error').textContent = `Metadata: ${error.message}`; $('sheet-error').hidden = false; }
    };
    $('cancel-sheet').onclick = () => $('modal').close();
    $('confirm-sheet').onclick = () => {
      try {
        if (!geometry) throw new Error('Choose a valid cell size first.');
        const rows = readRows(), fps = Number($('sheet-fps').value);
        if (!Number.isInteger(fps) || fps<1 || fps>60) throw new Error('Choose an FPS from 1 to 60.');
        if (rows.some(row => !row.name || !Number.isInteger(row.frameCount) || row.frameCount<1 || row.frameCount>geometry.columns)) throw new Error('Give each row a name and a valid frame count.');
        const imageWidth = image.width/geometry.scale, imageHeight = image.height/geometry.scale;
        const canvas = document.createElement('canvas'); canvas.width = imageWidth; canvas.height = imageHeight;
        const context = canvas.getContext('2d',{willReadFrequently:true}); context.imageSmoothingEnabled = false;
        context.drawImage(image,0,0,imageWidth,imageHeight);
        const rgba = context.getImageData(0,0,imageWidth,imageHeight).data;
        const restoreTiming = metadata && !timingChanged;
        const project = sliceSpritesheet(rgba,imageWidth,imageHeight,{
          cellWidth:geometry.cellWidth,cellHeight:geometry.cellHeight,
          name:metadata?.name || file.name.replace(/\.png$/i,'').slice(0,80) || 'Imported spritesheet',
          animationNames:rows.map(row=>row.name),frameCounts:rows.map(row=>row.frameCount),fps,palette:metadata?.palette,
          skipEmptyFrames:state.importSkipEmpty,
          animationFps:restoreTiming?metadata.animations.map(animation=>animation.fps):[],
          frameDurations:restoreTiming?metadata.animations.map(animation=>animation.durations):[]
        });
        const importedFrames=project.animations.reduce((count,animation)=>count+animation.frames.length,0);
        const skipped=rows.reduce((count,row)=>count+row.frameCount,0)-importedFrames;
        replaceProject(project, `Spritesheet imported: ${project.animations.length} animations, ${importedFrames} frames.${skipped?` Skipped ${skipped} empty frames.`:''}`);
        $('modal').close();
      } catch (error) { $('sheet-error').textContent = error.message; $('sheet-error').hidden = false; }
    };
    updateGrid(false);
  } catch (error) { showImportError(error.message || 'The spritesheet could not be decoded.'); }
}

function fileName(name) {
  return name.normalize('NFKD').replace(/[^a-z0-9-_]+/gi,'-').replace(/^-+|-+$/g,'').toLowerCase().slice(0,80) || 'pixel-sprite';
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function exportData(version = state.project.version === 3 ? 2 : 1) {
  try {
    downloadBlob(new Blob([encodeAIProject(state.project,{version})],{type:'text/plain;charset=utf-8'}), `${fileName(state.project.name)}.pxa`);
    toast('AI pixel data exported. All layers and animations are included.');
  } catch(error) { toast(`Could not export: ${error.message}`); }
}
async function exportBinaryData() {
  try {
    const project = validateProject(state.project);
    const bytes = await encodePixelProject(project);
    downloadBlob(new Blob([bytes],{type:'application/octet-stream'}), `${fileName(project.name)}.pxs`);
    toast('Pixel data exported, including every layer, animation, and color.');
  } catch (error) { toast(`Could not export: ${error.message}`); }
}
function exportDialog() {
  openDialog('Take your pixels with you', `<div class="export-tabs" role="tablist" aria-label="Export format"><button id="export-ai-tab" class="export-tab active" role="tab" aria-selected="true">${icon('file')} AI pixel data</button><button id="export-data-tab" class="export-tab" role="tab" aria-selected="false">${icon('file')} Compact file</button><button id="export-png-tab" class="export-tab" role="tab" aria-selected="false">${icon('image')} PNG image</button><button id="export-sheet-tab" class="export-tab" role="tab" aria-selected="false">${icon('grid')} Spritesheet</button></div><div id="export-options"></div>`, 'EXPORT');
  const activate = (name) => {
    for (const type of ['ai','data','png','sheet']) {
      $(`export-${type}-tab`).classList.toggle('active',type===name);
      $(`export-${type}-tab`).setAttribute('aria-selected',type===name);
    }
    $('modal').classList.add('wide');
  };
  const scaleOptions = () => [1,2,3,4,8,16].map(scale=>`<option value="${scale}">${scale}× · ${state.project.width*scale} × ${state.project.height*scale} per frame</option>`).join('');
  const aiView = () => {
    activate('ai');
    let version=state.project.version===3?2:1;
    let data=encodeAIProject(state.project,{version});
    $('export-options').innerHTML=`<p class="modal-body-text">PXA 2 preserves reusable parts, placements and local edits. PXA 1 exports raster pixels and timings; shared instances and optional grouping are baked into pixels. Files with custom stack orders require a reader supporting ORDER and FRAMEORDER. Use PXA 2 to preserve the complete object structure.</p><label class="field"><span class="field-label">PXA version</span><select id="pxa-export-version"><option value="2">PXA 2 · editable parts</option><option value="1">PXA 1 · raster copy</option></select></label><label class="field"><span class="field-label">${escapeHTML(fileName(state.project.name))}.pxa</span><textarea id="ai-export-text" class="ai-data-preview" readonly spellcheck="false" aria-label="AI pixel data"></textarea></label><p class="ai-data-stats">${data.length.toLocaleString()} characters · ${totalFrames()} frames · ${state.project.layers.length} layers · no JSON</p><div class="notice"><strong>Edit with ChatGPT:</strong> copy the AI prompt, add your request, then paste the response into Import → Paste AI pixel data. “Copy AI prompt” includes the format guide and this project; it does not send anything automatically. Starting something new? <button id="export-build-prompt" class="text-button">Build a creation prompt</button> with no example needed.</div><div class="modal-actions ai-export-actions"><button id="copy-ai-data" class="button">Copy data</button><button id="copy-ai-prompt" class="button">Copy AI prompt</button><button id="download-ai-data" class="button primary">${icon('import')} Download .pxa</button></div>`;
    $('ai-export-text').value=data;
    $('pxa-export-version').value=String(version);
    $('pxa-export-version').onchange=()=>{version=Number($('pxa-export-version').value);data=encodeAIProject(state.project,{version});$('ai-export-text').value=data;document.querySelector('.ai-data-stats').textContent=`${data.length.toLocaleString()} characters · ${totalFrames()} frames · ${state.project.layers.length} layers`;};
    const copyText=async(text,message)=>{
      try { await navigator.clipboard.writeText(text); toast(message); }
      catch { $('ai-export-text').value=text; $('ai-export-text').focus(); $('ai-export-text').select(); toast('Text selected. Press Ctrl/⌘ C to copy it.'); }
    };
    $('copy-ai-data').onclick=()=>copyText(data,'AI pixel data copied.');
    $('export-build-prompt').onclick=()=>promptBuilderDialog();
    $('copy-ai-prompt').onclick=()=>copyText(`Edit this Pixel Studio project. My request: [describe the change here].\nReturn one complete PXA ${version} document, without Markdown fences or explanation. Preserve unrelated artwork, layers, animations, frame durations, and palette entries.\n\n${version===2?PXA2_GUIDE:AI_FORMAT_GUIDE}\n\nPROJECT TO EDIT\n${data}`,'AI prompt copied. Add your request in ChatGPT.');
    $('download-ai-data').onclick=()=>{exportData(version);$('modal').close();};
  };
  const dataView = () => {
    activate('data');
    const totalFrames = state.project.animations.reduce((n,a) => n + a.frames.length,0);
    $('export-options').innerHTML = `<div class="export-summary">${icon('file')}<strong>${escapeHTML(fileName(state.project.name))}.pxs</strong><span>${state.project.palette.length} colors · ${state.project.layers.length} layers · ${state.project.animations.length} animations · ${totalFrames} frames</span></div><p class="modal-body-text">A compact binary project file with your fixed palette, all layers (including hidden ones), named animations, frame timings, and exact pixel data. Lossless compression keeps downloads small.</p><div class="notice">PXS saves a raster copy of each container, including its stack order. Shared instances, object settings, and optional grouping are baked into pixels; use PXA 2 to keep them editable. Animation and frame order require an updated PXS reader. When importing, uncheck “Skip empty frames” to preserve deliberate blank frames.</div><div class="modal-actions"><button id="download-data" class="button primary">${icon('import')} Download pixel data</button></div>`;
    $('download-data').onclick = () => { exportBinaryData(); $('modal').close(); };
  };
  const pngView = () => {
    activate('png');
    $('export-options').innerHTML = `<p class="modal-body-text">Visible objects are combined into sharp pixels on a transparent background. Export PXA 2 to keep editable objects and groups.</p><label class="field"><span class="field-label">What to export</span><select id="png-scope"><option value="frame">Current frame · ${escapeHTML(currentAnimation().name)}</option><option value="animation">Current animation · horizontal spritesheet</option><option value="project">All animations · one row per animation</option></select></label><label class="field"><span class="field-label">Pixel scale</span><select id="png-scale">${scaleOptions()}</select></label><div class="notice" id="png-export-info">Exports the selected frame as a transparent PNG.</div><div class="modal-actions"><button id="download-png" class="button primary">${icon('import')} Download PNG</button></div>`;
    $('png-scope').onchange = () => {
      $('png-export-info').textContent = {frame:'Exports the selected frame as a transparent PNG.',animation:'Frames run left to right in animation order. Use pixel data to keep animation names and timing.',project:'Each animation occupies one row, in the order shown. Shorter rows have transparent cells. Use pixel data to preserve all animation metadata.'}[$('png-scope').value];
    };
    $('download-png').onclick = () => exportPng($('png-scope').value,Number($('png-scale').value));
  };
  const sheetView = () => {
    activate('sheet');
    $('export-options').innerHTML = `<p class="modal-body-text"><strong>Rows = animations. Columns = frames.</strong> Visible objects are combined. The sheet follows the order in your animation list and timeline.</p><div class="sheet-export-preview"><canvas id="sheet-export-canvas" aria-label="Export spritesheet preview"></canvas></div><div class="form-grid"><label class="field"><span class="field-label">Animations</span><select id="sheet-export-scope"><option value="project">All animations</option><option value="animation">Current animation · ${escapeHTML(currentAnimation().name)}</option></select></label><label class="field"><span class="field-label">Pixel scale</span><select id="sheet-export-scale">${scaleOptions()}</select></label></div><div id="sheet-export-summary" class="sheet-summary"></div><div class="notice">Shorter rows are padded with transparent cells. Metadata restores names, frame counts, palette, and timing; editable objects and groups are saved in PXA 2. Empty cells are skipped by default on import.</div><div class="modal-actions sheet-download-actions"><button id="download-sheet-metadata" class="button">${icon('file')} Download metadata</button><button id="download-sheet-png" class="button primary">${icon('import')} Download spritesheet PNG</button></div>`;
    const update = () => {
      try {
      const scope = $('sheet-export-scope').value, scale = Number($('sheet-export-scale').value);
      const project = {...state.project,animations:scope === 'animation' ? [currentAnimation()] : state.project.animations};
      const metadata = createSheetMetadata(project,scale);
      const source = makeExportCanvas(scope,1);
      const canvas = $('sheet-export-canvas');
      canvas.width = source.width; canvas.height = source.height;
      canvas.getContext('2d').drawImage(source,0,0);
      $('sheet-export-summary').textContent = `${metadata.rows} rows × ${metadata.columns} columns · ${metadata.columns*metadata.cellWidth} × ${metadata.rows*metadata.cellHeight} PNG · ${metadata.cellWidth} × ${metadata.cellHeight} cells`;
      $('download-sheet-png').disabled = false; $('download-sheet-metadata').disabled = false;
      } catch (error) {
        $('sheet-export-summary').textContent = error.message;
        $('download-sheet-png').disabled = true; $('download-sheet-metadata').disabled = true;
      }
    };
    $('sheet-export-scope').onchange = update; $('sheet-export-scale').onchange = update;
    $('download-sheet-png').onclick = () => exportPng($('sheet-export-scope').value,Number($('sheet-export-scale').value),true);
    $('download-sheet-metadata').onclick = () => {
      try {
        const scope = $('sheet-export-scope').value, scale = Number($('sheet-export-scale').value);
        const project = {...state.project,animations:scope === 'animation' ? [currentAnimation()] : state.project.animations};
        const metadata = createSheetMetadata(project,scale);
        downloadBlob(new Blob([JSON.stringify(metadata,null,2)],{type:'application/json'}),`${pngBaseName(scope,scale)}.sheet.json`);
        toast('Spritesheet metadata exported. Keep it with the PNG.');
      } catch (error) { toast(error.message); }
    };
    update();
  };
  $('export-ai-tab').onclick = aiView;
  $('export-data-tab').onclick = dataView;
  $('export-png-tab').onclick = pngView;
  $('export-sheet-tab').onclick = sheetView;
  aiView();
}
function makeExportCanvas(scope, scale) {
  const rows = scope === 'frame' ? [[currentFrame()]] : scope === 'animation' ? [currentAnimation().frames] : state.project.animations.map(a => a.frames);
  const columns = Math.max(...rows.map(row => row.length));
  const frameWidth = state.project.width, frameHeight = state.project.height;
  const width = columns * frameWidth * scale, height = rows.length * frameHeight * scale;
  if (width > 16384 || height > 16384 || width * height > 32 * 1024 * 1024) {
    throw new Error('This spritesheet is too large at this scale. Choose a smaller scale or export one animation.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  context.imageSmoothingEnabled = false;
  rows.forEach((frames,y) => frames.forEach((frame,x) => compositeFrame(state.project,frame).forEach((color,index) => {
    if (color < 0) return;
    context.fillStyle = state.project.palette[color];
    context.fillRect((x*frameWidth+index%frameWidth)*scale,(y*frameHeight+Math.floor(index/frameWidth))*scale,scale,scale);
  })));
  return canvas;
}
function pngBaseName(scope,scale) {
  const animationName = scope === 'project' ? 'all-animations' : fileName(currentAnimation().name);
  const suffix = scope === 'frame' ? `frame-${currentAnimation().frames.findIndex(f=>f.id===state.frameId)+1}` : 'spritesheet';
  return `${fileName(state.project.name)}-${animationName}-${suffix}${scale>1?`-${scale}x`:''}`;
}
async function exportPng(scope, scale, keepOpen = false) {
  try {
    const canvas = makeExportCanvas(scope,scale);
    const blob = await new Promise(resolve => canvas.toBlob(resolve,'image/png'));
    if (!blob) throw new Error('The browser could not create this image. Try a smaller export.');
    downloadBlob(blob,`${pngBaseName(scope,scale)}.png`);
    if (!keepOpen) $('modal').close();
    toast(`PNG exported at ${canvas.width} × ${canvas.height} pixels.`);
  } catch (error) { toast(error.message); }
}
function samplesDialog() {
  openDialog('Little things, ready to go', `<p class="modal-body-text">${state.samples.length} sample projects, including a PXA 2 example with reusable parts. Download a file and use Import → Pixel data file to load it again.</p><label class="field"><span class="field-label">Data format</span><select id="sample-file-format"><option value="ai">AI pixel text · .pxa</option><option value="binary">Compressed binary · .pxs</option></select></label><div class="download-list" id="sample-downloads"></div>`, 'SAMPLE FILES');
  const render=()=>{ $('sample-downloads').innerHTML=state.samples.map(sample=>{const file=$('sample-file-format').value==='ai'?sample.aiFile:(sample.binaryFile||sample.file);return `<a class="download-row" href="./samples/${file}" download="${file}"><img width="48" height="48" src="./samples/${sample.thumbnail||sample.id}.png" alt=""><span><strong>${escapeHTML(sample.name)}</strong><small>${sample.animations} animations · ${sample.frames} frames</small></span>${icon('import')}</a>`;}).join(''); };
  $('sample-file-format').onchange=render;
  render();
}
function helpDialog() {
  const shortcuts = [['V','Select / move objects'],['B','Pencil'],['E','Eraser'],['L','Straight line'],['F','Flood fill'],['N','Gradient · ⇧ snaps to 45°'],['U','Replace color'],['I / Alt','Pick a color'],['R','Square / rectangle'],['C','Circle / ellipse'],['S','Select / move pixels'],['W','Magic wand · ⇧ adds'],['T','Dither brush'],['H','Shade · right-click lightens'],['K','Transform · resize, squash, rotate, flip'],['J','Skeleton: rig parts into bones and pose them'],[', / .','Turn selected objects 90° (Transform)'],['Shift-click','Select several objects (Object / Transform)'],['⌘ / Ctrl + G','Make object from selection'],['[ / ]','Smaller / larger brush'],['⌘ / Ctrl + A','Select all pixels'],['⌘ / Ctrl + C / X / V','Copy / cut / paste pixels, or the selected object'],['⌘ / Ctrl + ⇧ + V','Paste object as an independent copy'],['⌘ / Ctrl + D','Duplicate selected object'],['⇧ + click','Straight pencil / eraser line from the last stroke'],['Arrows / ⇧ + arrows','Nudge selection by 1 / 8 pixels'],['Delete','Clear selected pixels'],['Enter / Esc','Deselect pixels'],['Shift + drag','Square, circle, or 45° line'],['Drag object rows','Reorder, or drop into a group'],['Right-click object row','Object menu'],['G','Toggle grid'],['O','Onion skin'],['Space','Play / pause preview'],['D','Duplicate frame'],['← / →','Previous / next frame'],['+ / −','Zoom in / out'],['0','Fit canvas'],['⌘ / Ctrl + Z','Undo'],['⌘ / Ctrl + ⇧ + Z','Redo'],['⌘ / Ctrl + S','Export pixel data']];
  openDialog('Small canvas. Handy shortcuts.', `<p class="modal-body-text">Draw with a mouse, pen, or finger. Right-click to erase. Brush size and symmetry live below the tools; flip and rotate actions live in Transform. Use the palette picker to recolor a slot in every frame, or Swap to exchange two colors. AI prompt creates a complete generation brief with the pixel format and an ordered animation plan, even from an empty project.</p><div class="shortcut-grid">${shortcuts.map(([key,action])=>`<span>${action}</span><kbd>${key}</kbd>`).join('')}</div><div class="notice">Each project tab has its own artwork and Undo history. New projects and imports open in new tabs. Close a tab and reopen it from Saved projects; projects autosave on this device. Collapse individual panel headings, or hide either sidebar with the buttons above the canvas.</div><p class="helper-text">Tools edit the active pixel object. Transform can affect one frame or the active pixel object across an animation or project. Mirror animation copies each frame’s placements while retaining shared part definitions. Set individual frame holds in milliseconds below the timeline. Choose Object (V) to select and move part instances; double-click one to edit its shared artwork in every appearance. Object edits default to the current animation. Groups are optional; use Ungroup to expose their objects. Export PXA 2 for editable objects and timings; PNGs combine visible artwork.</p>`, 'QUICK GUIDE');
}
function accountDialog() {
  if (['127.0.0.1','localhost','[::1]'].includes(location.hostname)) { aiEditDialog(); return; }
  openDialog('AI in Pixel Studio', `<p class="modal-body-text">Use your own Codex ChatGPT account in the local edition. Describe an edit, review the result, then apply it with Undo available.</p><div class="notice"><strong>Local Codex edition</strong><p>Download and unzip Pixel Studio, then run <code>npm start</code> in its folder or open <strong>Start-Pixel-Studio.command</strong> on your Mac. Requires Node.js 20+ and the Codex CLI signed in with ChatGPT.</p><a class="button primary" href="./downloads/pixel-studio-local.zip" download>Download local edition</a></div><p class="modal-body-text">To move your current artwork to localhost, export a .pxa or .pxs file here and import it there. Each address keeps its own saved projects.</p><div class="modal-actions"><button id="account-ai-edit" class="button primary">Review an AI edit</button><button id="account-ai-export" class="button">Build a creation prompt</button></div><details class="prompt-style-details"><summary>Website sign-in</summary><p class="modal-body-text">Sign in to this website with your ChatGPT account. Using your plan for automatic generation on the hosted website requires a separate approved connection.</p><a class="button chatgpt-signin" href="/signin-with-chatgpt?return_to=%2F" target="_top" data-oai-siwc-button>Continue with ChatGPT</a><p><a class="text-button" href="/signout-with-chatgpt?return_to=%2F" target="_top">Sign out of Pixel Studio</a></p><a href="https://developers.openai.com/siwc/quickstart" target="_blank" rel="noopener noreferrer">About ChatGPT plan connections ↗</a></details>`, 'AI CONNECTION');
  $('account-ai-edit').onclick=aiEditDialog;
  $('account-ai-export').onclick=()=>promptBuilderDialog();
}

function bindEvents() {
  bindFileDrop();
  const mathsDeps={state,$,icon,escapeHTML,mutate,snapshot,remember,renderAll,renderCanvas,renderPreview,renderTools,toast,openDialog,paintSprite,finishDrawing,
    currentAnimation,currentFrame,currentLayer,selectedObject,selectedItems,transformItems,resizableObject,objectTarget,canEditPixels,canvasPixels,canvasPosition,normalizeSelection,selectObject,selectFrameAt,addFrame,undo:()=>restore(state.undo,state.redo)};
  initToolExtras(mathsDeps);initObjectPose(mathsDeps);initMotionModes(mathsDeps);initRigMode(mathsDeps);initAnimatePanel(mathsDeps);initEffectsPanel(mathsDeps);initPaletteTools(mathsDeps);initPaletteStudio(mathsDeps);
  // Holding Shift previews the straight line a pencil or eraser click will draw.
  const trackShift=event=>{if(state.shiftHeld!==event.shiftKey){state.shiftHeld=event.shiftKey;if(state.cursor)renderCanvas();}};
  window.addEventListener('keydown',trackShift);window.addEventListener('keyup',trackShift);
  window.addEventListener('blur',()=>{state.shiftHeld=false;});
  $('prompt-builder-button').onclick=()=>promptBuilderDialog();
  $('ai-edit-button').onclick=aiEditDialog;
  $('edit-animation-ai').onclick=aiEditDialog;
  $('new-project-tab').onclick=()=>newProjectDialog();
  $('open-saved-projects').onclick=savedProjectsDialog;
  $('project-tabs').addEventListener('keydown',event=>{
    if(!event.target.closest('[role="tab"]') || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();event.stopPropagation();
    const index=state.openIds.indexOf(state.documentId);
    const target=event.key==='Home'?0:event.key==='End'?state.openIds.length-1:(index+(event.key==='ArrowRight'?1:-1)+state.openIds.length)%state.openIds.length;
    switchDocument(state.openIds[target]);$(`project-tab-${state.documentId}`)?.focus();
  });
  for(const [name,id] of [['tools','toggle-tools-panel'],['details','toggle-details-panel']]) $(id).onclick=()=>{
    state.panels[name]=!state.panels[name];renderPanelState();persistSession();requestAnimationFrame(fitCanvas);
  };
  document.querySelectorAll('details[data-panel]').forEach(panel=>{
    if(typeof state.panelSections[panel.dataset.panel]==='boolean')panel.open=state.panelSections[panel.dataset.panel];
    panel.addEventListener('toggle',()=>{if(panel.classList.contains('is-floating'))return;state.panelSections[panel.dataset.panel]=panel.open;persistSession();});
  });
  document.querySelectorAll('[data-tool]').forEach(button => button.addEventListener('click', () => {
    finishDrawing();
    state.tool = button.dataset.tool;
    if (!SELECT_TOOLS.includes(state.tool) && state.tool!=='gradient') state.selection=null;
    state.swap = false;
    renderTools(); renderPalette(); renderSelection(); renderCanvas();
  }));
  $('brush-size').onchange=event=>{finishDrawing();state.brushSize=Math.max(1,Math.min(8,Number(event.target.value)||1));renderTools();renderCanvas();};
  $('brush-shape').onchange=event=>{finishDrawing();state.brushShape=event.target.value;renderTools();renderCanvas();};
  $('symmetry-mode').onchange=event=>{finishDrawing();state.symmetry=event.target.value;renderTools();renderCanvas();};
  $('transform-scope').onchange=event=>{finishDrawing();state.transformScope=event.target.value;renderTransformControls();};
  $('flip-horizontal').onclick=()=>transformArtwork('flip-h');
  $('flip-vertical').onclick=()=>transformArtwork('flip-v');
  $('rotate-left').onclick=()=>transformArtwork('rotate-ccw');
  $('rotate-right').onclick=()=>transformArtwork('rotate-cw');
  $('select-all').onclick=selectAllPixels;
  $('make-object').onclick=makeObjectDialog;
  $('pixel-perfect').onchange=event=>{state.pixelPerfect=event.target.checked;renderTools();};
  $('wand-mode').onchange=event=>{state.wandMode=event.target.value;renderTools();};
  $('object-resize-mode').onchange=event=>{state.resizeMode=event.target.value;renderTools();};
  $('object-resize-squash').onclick=()=>stepResize('squash');
  $('object-resize-stretch').onclick=()=>stepResize('stretch');
  $('object-resize-reset').onclick=()=>stepResize('reset');
  $('object-turn-left').onclick=()=>turnSelection('R270');
  $('object-turn-right').onclick=()=>turnSelection('R90');
  $('object-flip-x').onclick=()=>turnSelection('FX');
  $('object-flip-y').onclick=()=>turnSelection('FY');
  $('object-angle').onchange=event=>{setObjectAngle(Number(event.target.value));renderResizeOptions();};
  $('object-angle').onblur=()=>renderResizeOptions();
  $('object-angle-reset').onclick=()=>setObjectAngle(0);
  for(const handle of document.querySelectorAll('.resize-handle'))handle.addEventListener('pointerdown',event=>beginResize(event,handle.dataset.handle));
  $('copy-selection').onclick=()=>copySelectionPixels();
  $('cut-selection').onclick=()=>copySelectionPixels(true);
  $('paste-selection').onclick=pasteClipboardPixels;
  $('filled-shape').onchange = event => { state.filled = event.target.checked; renderTools(); };
  $('color-picker').onchange = event => editColor(event.target.value);
  $('hex-color').onchange = event => editColor(event.target.value);
  $('hex-color').onkeydown = event => { if (event.key === 'Enter') event.target.blur(); };
  $('add-color').onclick = () => {
    if (state.project.palette.length >= MAX_COLORS) return;
    mutate(() => { state.project.palette.push('#e8b875'); state.color = state.project.palette.length - 1; });
    toast('Color added. Pick a new shade or edit its hex code.');
  };
  $('swap-colors').onclick = () => { state.swap = !state.swap; state.swapFirst = null; renderPalette(); };
  $('project-name').onchange = event => {
    const name = event.target.value.trim() || 'Untitled sprite';
    mutate(() => { state.project.name = name; });
    event.target.value = name;
  };
  $('project-name').onkeydown = event => { if (event.key === 'Enter') event.target.blur(); };
  $('undo').onclick = () => state.inPlaceEdit?restoreCanvasPartEdit():restore(state.undo,state.redo);
  $('redo').onclick = () => state.inPlaceEdit?restoreCanvasPartEdit(true):restore(state.redo,state.undo);
  $('in-place-cancel').onclick=()=>endCanvasPartEdit(false);
  $('in-place-apply').onclick=()=>endCanvasPartEdit(true);
  for(const button of $('edit-scope').querySelectorAll('[data-scope]'))button.onclick=()=>setEditScope(button.dataset.scope==='frame');
  $('edit-scope').addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;
    event.preventDefault();const frameOnly=['ArrowRight','ArrowDown'].includes(event.key);
    setEditScope(frameOnly);$('edit-scope').querySelector(`[data-scope="${frameOnly?'frame':'wide'}"]`).focus();
  });
  $('toggle-grid').onclick = () => { state.grid = !state.grid; renderTools(); renderCanvas(); };
  $('toggle-onion').onclick = () => { state.onion = !state.onion; renderTools(); renderCanvas(); };
  $('zoom-in').onclick = () => setZoom(state.scale + 2);
  $('zoom-out').onclick = () => setZoom(state.scale - 2);
  $('zoom-fit').onclick = () => { state.fit = true; fitCanvas(); };
  $('pixel-canvas').addEventListener('pointerdown',pointerDown);
  $('canvas-stage').addEventListener('pointerdown',deselectObjectOutside);
  $('pixel-canvas').addEventListener('dblclick',doubleClickObject);
  $('pixel-canvas').addEventListener('pointermove',pointerMove);
  $('pixel-canvas').addEventListener('pointerup',pointerEnd);
  $('pixel-canvas').addEventListener('pointercancel',pointerEnd);
  $('pixel-canvas').addEventListener('lostpointercapture', event => {
    if (state.drawing && event.pointerId === state.drawing.pointerId) pointerEnd(event);
  });
  $('pixel-canvas').addEventListener('pointerleave',() => {
    if (!state.drawing) { state.cursor = null; $('cursor-position').textContent = 'X —   Y —'; renderCanvas(); }
  });
  $('pixel-canvas').addEventListener('contextmenu',event => event.preventDefault());
  $('add-frame').onclick = () => addFrame(false);
  $('duplicate-frame').onclick = () => addFrame(true);
  $('delete-frame').onclick = deleteFrame;
  $('move-frame-left').onclick = () => moveFrame(-1);
  $('move-frame-right').onclick = () => moveFrame(1);
  $('add-animation').onclick = () => animationDialog();
  $('duplicate-animation').onclick=()=>duplicateAnimation();
  $('mirror-animation').onclick=mirrorAnimationDialog;
  $('reverse-animation').onclick=reverseAnimation;
  $('frame-duration').onchange=event=>{
    const duration=Number(event.target.value);
    if(!Number.isInteger(duration) || duration<1 || duration>60000){toast('Frame duration must be 1–60,000 milliseconds.');event.target.value=currentFrame().duration;return;}
    mutate(()=>{currentFrame().duration=duration;state.previewTime=0;});
  };
  $('manage-parts').onclick=()=>partLibrary();
  $('open-part-library').onclick=()=>partLibrary();
  $('mini-prev-frame').onclick=()=>selectFrameAt(currentAnimation().frames.findIndex(f=>f.id===state.frameId)-1);
  $('mini-next-frame').onclick=()=>selectFrameAt(currentAnimation().frames.findIndex(f=>f.id===state.frameId)+1);
  $('add-pixel-object').onclick=()=>addObject(false);
  $('add-object-group').onclick=()=>addObject(true);
  $('outline-objects').onclick=magicOutlineDialog;
  $('magic-outline').onclick = magicOutlineDialog;
  $('clear-selection').onclick = clearSelectionPixels;
  $('deselect-selection').onclick = deselectPixels;
  $('play-toggle').onclick = togglePlay;
  $('preview-animation').onchange = event => selectAnimation(event.target.value);
  $('preview-prev-animation').onclick = () => stepAnimation(-1);
  $('preview-next-animation').onclick = () => stepAnimation(1);
  $('fps-input').onchange = event => {
    const fps = Math.max(1,Math.min(60,Math.round(Number(event.target.value) || 8)));
    const animation=currentAnimation(),ratio=animation.fps/fps;
    const durations=animation.frames.map(frame=>Math.round(frame.duration*ratio));
    if(durations.some(duration=>duration<1 || duration>60000)) {
      event.target.value=animation.fps;
      toast('That speed would put a frame outside 1–60,000 ms. Adjust its hold first.');
      return;
    }
    mutate(() => { animation.frames.forEach((frame,index)=>{frame.duration=durations[index];});animation.fps=fps; });
    state.previewTime = 0;
  };
  $('fps-input').title='Adjust playback speed. Custom frame holds scale proportionally.';
  $('preview-background').onclick = () => {
    state.previewBackground = (state.previewBackground + 1) % 3;
    $('preview-stage').dataset.background = ['sage','light','dark'][state.previewBackground];
  };
  $('new-project').onclick = () => newProjectDialog();
  $('resize-canvas').onclick = resizeDialog;
  $('import-button').onclick = importDialog;
  $('export-button').onclick = exportDialog;
  $('help-button').onclick = helpDialog;
  $('shortcuts-button').onclick = helpDialog;
  $('account-button').onclick = accountDialog;
  $('close-modal').onclick = () => $('modal').close();
  $('modal').addEventListener('click',event => {
    if (event.target !== $('modal')) return;
    const rect = $('modal').getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('modal').close();
  });
  $('data-file-input').onchange = async event => {
    const file = event.target.files[0]; event.target.value = '';
    if (file) await importData(file);
  };
  $('png-file-input').onchange = async event => {
    const file = event.target.files[0]; event.target.value = '';
    if (file) await importPng(file);
  };
  $('sheet-file-input').onchange = async event => {
    const file = event.target.files[0]; event.target.value = '';
    if (file) await importSpritesheet(file);
  };
  document.addEventListener('keydown',event => {
    if (state.drawing) {
      if (event.key === 'Escape') { event.preventDefault(); finishDrawing(true); renderAll(); }
      return;
    }
    if ($('modal').open || event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
    const key = event.key.toLowerCase();
    if(state.inPlaceEdit){canvasPartKey(event,key);return;}
    if ((event.ctrlKey || event.metaKey) && key === 'z') { event.preventDefault(); event.shiftKey ? restore(state.redo,state.undo) : restore(state.undo,state.redo); return; }
    if ((event.ctrlKey || event.metaKey) && key === 'y') { event.preventDefault(); restore(state.redo,state.undo); return; }
    if ((event.ctrlKey || event.metaKey) && key === 's') { event.preventDefault(); exportData(); return; }
    if ((event.ctrlKey || event.metaKey) && key === 'a' && ['object','resize'].includes(state.tool)) {event.preventDefault();selectAllObjects();return;}
    if ((event.ctrlKey || event.metaKey) && key === 'a') {event.preventDefault();selectAllPixels();return;}
    if ((event.ctrlKey || event.metaKey) && key === 'g') {event.preventDefault();makeObjectDialog();return;}
    if ((event.ctrlKey || event.metaKey) && key === 'c' && state.selection) {event.preventDefault();copySelectionPixels();return;}
    if ((event.ctrlKey || event.metaKey) && key === 'x' && state.selection) {event.preventDefault();copySelectionPixels(true);return;}
    // Without a pixel selection, copy commands act on the selected object.
    if ((event.ctrlKey || event.metaKey) && (key === 'c' || key === 'x') && !event.shiftKey) {event.preventDefault();copyObjectItem(selectedObject(),key==='x');return;}
    if ((event.ctrlKey || event.metaKey) && key === 'd') {event.preventDefault();duplicateObjectItem(selectedObject());return;}
    if ((event.ctrlKey || event.metaKey) && key === 'v' && state.objectClipboard && (state.lastClipboard==='object' || !state.clipboard)) {event.preventDefault();pasteObjectItem({independent:event.shiftKey});return;}
    if ((event.ctrlKey || event.metaKey) && key === 'v' && state.clipboard) {event.preventDefault();pasteClipboardPixels();return;}
    if (event.ctrlKey || event.metaKey) return;
    if (event.target.closest('button,a') && (key==='enter' || key===' ')) return;
    if(state.tool==='object' || state.tool==='resize') {
      const item=selectedObject(), node=celObjects(currentFrame().cels.find(c=>c.layerId===item.layerId)).find(n=>n.key===item.key);
      const delta={arrowleft:[-1,0],arrowright:[1,0],arrowup:[0,-1],arrowdown:[0,1]}[key];
      const many=selectedItems().length>1;
      if(delta && many){event.preventDefault();const step=event.shiftKey?8:1;try{mutate(()=>{state.project=translateObjects(state.project,objectTarget(),selectedItems(),delta[0]*step,delta[1]*step,state.objectScope).project;});}catch(error){toast(error.message);}return;}
      if((key==='delete' || key==='backspace') && many){event.preventDefault();objectAction('delete',item);return;}
      if(state.tool==='resize' && (key===',' || key==='.')){event.preventDefault();turnSelection(key===','?'R270':'R90');return;}
      if(delta && node?.instance){event.preventDefault();const step=event.shiftKey?8:1;try{mutate(()=>{state.project=translateObject(state.project,objectTarget(item.layerId),item.key,delta[0]*step,delta[1]*step,state.objectScope);});}catch(error){toast(error.message);}return;}
      if(key==='enter' && node?.instance && !many){event.preventDefault();editSharedObject(item);return;}
      if((key==='delete' || key==='backspace') && node?.instance){event.preventDefault();objectAction('delete',{...item,node});return;}
    }
    if (SELECT_TOOLS.includes(state.tool) && state.selection) {
      const nudge={arrowleft:[-1,0],arrowright:[1,0],arrowup:[0,-1],arrowdown:[0,1]}[key];
      if (nudge) { event.preventDefault(); const step=event.shiftKey?8:1; nudgeSelection(nudge[0]*step,nudge[1]*step); return; }
      if (key==='delete' || key==='backspace') { event.preventDefault(); clearSelectionPixels(); return; }
      if (key==='escape' || key==='enter') { event.preventDefault(); deselectPixels(); return; }
    }
    if (key==='escape' && state.objectSelection && !state.inPlaceEdit) { event.preventDefault(); state.objectSelection=null; renderAll(); return; }
    const tool = {v:'object',b:'pencil',e:'eraser',l:'line',f:'fill',n:'gradient',u:'replace',i:'eyedropper',r:'rectangle',c:'ellipse',s:'select',w:'wand',t:'dither',h:'shade',k:'resize'}[key];
    if (tool) { state.tool = tool; if(!SELECT_TOOLS.includes(tool) && tool!=='gradient')state.selection=null; renderTools(); renderSelection(); renderCanvas(); return; }
    if (key === 'j') { event.preventDefault(); toggleRigMode(); return; }
    if (key === 'g') $('toggle-grid').click();
    else if((key==='[' || key===']') && BRUSH_TOOLS.includes(state.tool)){event.preventDefault();state.brushSize=Math.max(1,Math.min(8,state.brushSize+(key===']'?1:-1)));renderTools();renderCanvas();}
    else if (key === 'o') $('toggle-onion').click();
    else if (key === 'd') addFrame(true);
    else if (key === ' ' && !event.repeat) { event.preventDefault(); togglePlay(); }
    else if (key === '+' || key === '=') setZoom(state.scale+2);
    else if (key === '-') setZoom(state.scale-2);
    else if (key === '0') { state.fit = true; fitCanvas(); }
    else if (key === '?') helpDialog();
    else if (key === 'arrowleft' || key === 'arrowright') {
      event.preventDefault();
      const frames = currentAnimation().frames;
      const index = frames.findIndex(frame => frame.id === state.frameId);
      state.frameId = frames[(index + (key === 'arrowleft' ? -1 : 1) + frames.length) % frames.length].id;
      state.previewIndex = frames.findIndex(frame => frame.id === state.frameId);
      renderAll();
    }
  });
  window.addEventListener('beforeunload',event=>{if(state.inPlaceEdit && inPlaceDirty(state.inPlaceEdit.session)){event.preventDefault();event.returnValue='';}});
  window.addEventListener('pagehide',() => { finishDrawing(); saveNow(); });
  document.addEventListener('visibilitychange',() => { state.previewTime=0;if(document.hidden){finishDrawing();saveNow();} });
  new ResizeObserver(fitCanvas).observe($('canvas-stage'));
  new ResizeObserver(revealActiveTab).observe($('project-tabs'));
}

async function init() {
  try {
    const response = await fetch('./samples/index.json');
    if (!response.ok) throw new Error('Sample list unavailable');
    const samples = await response.json();
    const loaded = await Promise.all(samples.map(async sample => {
      const response = await fetch(`./samples/${sample.file}`);
      if (!response.ok) throw new Error(`${sample.name} unavailable`);
      const project = await readPixelData(new Uint8Array(await response.arrayBuffer()));
      state.sampleData.set(sample.id, project);
      return sample;
    }));
    state.samples = loaded;
    state.project = clone(state.sampleData.get('panda'));
  } catch {
    toast('Sample files could not load. Your blank canvas is ready.');
  }
  projectStore=await openProjectStore();
  state.storageAvailable=projectStore.available;
  let session=null;
  try {session=await projectStore.loadSession();}catch{state.storageAvailable=false;}
  if(session) {
    state.panels={tools:!!session.panels?.tools,details:!!session.panels?.details};
    state.panelSections=session.panelSections || {};
    const restored=await Promise.allSettled(session.openIds.map(id=>projectStore.getDocument(id)));
    restored.forEach(result=>{
      if(result.status!=='fulfilled' || !result.value)return;
      const saved=result.value,document=makeDocument(saved.project,saved);document.savedRevision=0;
      state.documents.set(document.id,document);state.openIds.push(document.id);
    });
  }
  if(!state.openIds.length) {
    let saved=null;
    if(!session)try {saved=JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');if(saved?.project)state.project=validateProject(saved.project);} catch{saved=null;}
    const document=makeDocument(state.project,saved || {});
    state.documents.set(document.id,document);state.openIds.push(document.id);
  }
  const active=state.documents.get(session?.activeId) || state.documents.get(state.openIds[0]);
  state.documentId=active.id;
  for(const key of ['project','animationId','frameId','layerId','objectSelection','undo','redo','selection','scale','fit','color','previewIndex'])state[key]=active[key];
  normalizeSelection();
  bindEvents(); renderAll();
  initPanelLayout({onLayout:()=>requestAnimationFrame(()=>fitCanvas())});
  requestAnimationFrame(() => { fitCanvas(); requestAnimationFrame(animationTick); });
  // First visit: offer examples and a blank canvas; the panda sample stays open behind it.
  if(!session && !localStorage.getItem(STORAGE_KEY) && state.samples.length)newProjectDialog({welcome:true});
  saveNow();
}

init();
