import { compositeFrame, getAnimationLayers, getLayerPixels } from '../../domain/project.js';

export function compareProjects(before, after) {
  const oldLayers = new Map(before.layers.map((layer, index) => [layer.id, { layer, index }]));
  const changedLayers = new Set();
  const movedLayers = new Set();
  const changedAnimations = new Set();
  const frameChanges = [];
  const changes = { pixels: 0, visiblePixels: 0, frames: 0, layers: 0, animations: 0, cels: 0, colorsAdded: after.palette.length - before.palette.length, layersAdded: 0, layersRemoved: 0, layersRenamed: 0, layersMoved: 0 };
  after.layers.forEach((layer, index) => {
    const old = oldLayers.get(layer.id);
    if (!old) { changes.layersAdded += 1; changedLayers.add(layer.id); }
    else {
      if (old.layer.name !== layer.name) { changes.layersRenamed += 1; changedLayers.add(layer.id); }
      if (old.index !== index) { movedLayers.add(layer.id); changedLayers.add(layer.id); }
      if (old.layer.visible !== layer.visible || old.layer.locked !== layer.locked || old.layer.group !== layer.group) changedLayers.add(layer.id);
    }
  });
  after.animations.forEach((animation,index) => {
    const oldOrder = getAnimationLayers(before,before.animations[index]).map(layer => layer.id);
    getAnimationLayers(after,animation).forEach((layer,position) => {
      if (oldLayers.has(layer.id) && oldOrder.indexOf(layer.id) !== position) {
        movedLayers.add(layer.id); changedLayers.add(layer.id); changedAnimations.add(animation.id);
      }
    });
  });
  after.animations.forEach((animation, animationIndex) => animation.frames.forEach((frame, frameIndex) => {
    const original = before.animations[animationIndex].frames[frameIndex];
    const oldOrder=getAnimationLayers(before,before.animations[animationIndex],original).map(l=>l.id);
    getAnimationLayers(after,animation,frame).forEach((layer,index)=>{
      if(oldLayers.has(layer.id) && oldOrder.indexOf(layer.id)!==index){changedLayers.add(layer.id);movedLayers.add(layer.id);changedAnimations.add(animation.id);}
    });
    let pixels = 0;
    let minX = after.width;
    let minY = after.height;
    let maxX = -1;
    let maxY = -1;
    const layerIds = [];
    const mark = index => {
      const x = index % after.width;
      const y = Math.floor(index / after.width);
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    };
    for (const layer of after.layers) {
      const previous = oldLayers.has(layer.id) ? getLayerPixels(original, layer.id) : null;
      const next = getLayerPixels(frame, layer.id);
      let count = 0;
      for (let index = 0; index < next.length; index += 1) {
        if ((previous ? previous[index] : -1) !== next[index]) { count += 1; mark(index); }
      }
      if (count) { pixels += count; layerIds.push(layer.id); changedLayers.add(layer.id); changes.cels += 1; }
    }
    const oldComposite = compositeFrame(before, original);
    const newComposite = compositeFrame(after, frame);
    let visiblePixels = 0;
    for (let index = 0; index < newComposite.length; index += 1) {
      const oldColor = oldComposite[index] === -1 ? null : before.palette[oldComposite[index]];
      const newColor = newComposite[index] === -1 ? null : after.palette[newComposite[index]];
      if (oldColor !== newColor) { visiblePixels += 1; mark(index); }
    }
    changes.pixels += pixels;
    changes.visiblePixels += visiblePixels;
    if (pixels || visiblePixels) {
      changedAnimations.add(animation.id);
      frameChanges.push({
        animationId: animation.id, animationName: animation.name, animationIndex,
        frameId: frame.id, frameIndex, pixels, visiblePixels, layers: layerIds.length, layerIds,
        bounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
      });
    }
  }));
  changes.frames = frameChanges.length;
  changes.layers = changedLayers.size;
  changes.layersMoved = movedLayers.size;
  changes.animations = changedAnimations.size;
  changes.parts = (after.parts || []).filter(p => JSON.stringify(p) !== JSON.stringify(before.parts?.find(old => old.id === p.id))).length;
  changes.compositions = after.animations.reduce((n,a,ai) => n + a.frames.reduce((m,f,fi) => m + f.cels.filter(c => JSON.stringify(c.source) !== JSON.stringify(before.animations[ai].frames[fi].cels.find(old => old.layerId === c.layerId)?.source)).length,0),0);
  return { changes, frameChanges, changedLayerIds: [...changedLayers] };
}

