import { blankProject, getAnimationLayers, makeLayeredFrame } from '../../src/domain/project.js';

export function fixture(width = 8, height = 8) {
  const project = blankProject('Test sprite', width, height);
  project.palette = ['#123456', '#abcdef', '#ffeedd'];
  project.layers = [
    { id: 'background', name: 'Background', visible: true, locked: true },
    { id: 'artwork', name: 'Artwork', visible: true, locked: false },
  ];
  project.animations = [
    { id: 'idle', name: 'Idle', fps: 7.5, frames: [makeLayeredFrame(project), makeLayeredFrame(project)] },
    { id: 'walk', name: 'Walk', fps: 8, frames: [makeLayeredFrame(project)] },
  ];
  for (const animation of project.animations) {
    animation.frames.forEach((frame, index) => {
      frame.id = `${animation.id}-${index}`;
      frame.duration = 125 + index * 25;
      frame.cels[1].pixels[2 * width + 2] = 0;
    });
  }
  return project;
}

export const selection = { x: 1, y: 1, width: 3, height: 3 };
export const options = {
  mode: 'inpaint', scope: 'frame', animationId: 'idle', frameId: 'idle-0', layerId: 'artwork',
  selection, instruction: 'Add a golden crown.',
};

/** File formats regenerate IDs; compare every persisted artwork property instead. */
export function artwork(project) {
  return {
    name: project.name, width: project.width, height: project.height, palette: project.palette,
    layers: project.layers.map(({ name, visible, locked }) => ({ name, visible, locked })),
    animations: project.animations.map(animation => ({
      name: animation.name, fps: animation.fps,
      layerOrder: getAnimationLayers(project,animation).map(layer => project.layers.indexOf(layer)),
      frames: animation.frames.map(frame => ({ duration: frame.duration,
        cels: project.layers.map(layer => frame.cels.find(cel => cel.layerId === layer.id).pixels),
      })),
    })),
  };
}
