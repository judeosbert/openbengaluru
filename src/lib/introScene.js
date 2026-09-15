/* Intro backdrop scene mapping: the INTRO_ROADS fractions were designed on
 * a 16:9 box (design/landing.html), so the canvas cover-fits that fixed
 * reference box over the viewport — one uniform scale, overflow cropped.
 * At exactly 16:9 the scale is viewport/ref and every coordinate reduces
 * to the original full-viewport fraction math (desktop unchanged); on
 * other aspects the scene keeps its shape instead of stretching. Pure
 * math — DOM-free (test/lib-purity.test.js). */

export const SCENE_REF_W = 1600;
export const SCENE_REF_H = 900;

export const sceneScale = (w, h) => Math.max(w / SCENE_REF_W, h / SCENE_REF_H);
export const sceneX = (f, w, s) => (f - 0.5) * SCENE_REF_W * s + w / 2;
export const sceneY = (f, h, s) => (f - 0.5) * SCENE_REF_H * s + h / 2;
export const sceneLenX = (f, s) => f * SCENE_REF_W * s;
export const sceneLenY = (f, s) => f * SCENE_REF_H * s;
