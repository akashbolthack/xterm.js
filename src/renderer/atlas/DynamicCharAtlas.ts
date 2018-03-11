/**
 * Copyright (c) 2017 The xterm.js authors. All rights reserved.
 * @license MIT
 */

import { DIM_OPACITY, IGlyphIdentifier, INVERTED_DEFAULT_COLOR } from './Types';
import { ICharAtlasConfig } from '../../shared/atlas/Types';
import BaseCharAtlas from './BaseCharAtlas';
import { clearColor } from '../../shared/atlas/CharAtlasGenerator';

// In practice we're probably never going to exhaust a texture this large. For debugging purposes,
// however, it can be useful to set this to a really tiny value, to verify that LRU eviction works.
const TEXTURE_WIDTH = 1024;
const TEXTURE_HEIGHT = 1024;

type GlyphCacheKey = string;

/**
 * Removes and returns the oldest element in a map.
 */
function mapShift<K, V>(map: Map<K, V>): [K, V] {
  // Map guarantees insertion-order iteration.
  const entry = map.entries().next().value;
  if (entry === undefined) {
    return undefined;
  }
  map.delete(entry[0]);
  return entry;
}

function getGlyphCacheKey(glyph: IGlyphIdentifier): GlyphCacheKey {
  return `${glyph.bg}_${glyph.fg}_${glyph.bold ? 0 : 1}${glyph.dim ? 0 : 1}${glyph.char}`;
}

export default class DynamicCharAtlas extends BaseCharAtlas {
  // An ordered map that we're using to keep track of where each glyph is in the atlas texture.
  // It's ordered so that we can determine when to remove the old entries.
  private _cacheMap: Map<GlyphCacheKey, number> = new Map();

  // The texture that the atlas is drawn to
  private _cacheCanvas: HTMLCanvasElement;
  private _cacheCtx: CanvasRenderingContext2D;

  // A temporary canvas that glyphs are drawn to before being transfered over to the atlas.
  private _tmpCanvas: HTMLCanvasElement;
  private _tmpCtx: CanvasRenderingContext2D;

  // The number of characters stored in the atlas by width/height
  private _capacity: number;
  private _width: number;
  private _height: number;

  constructor(document: Document, private _config: ICharAtlasConfig) {
    super();
    this._cacheCanvas = document.createElement('canvas');
    this._cacheCanvas.width = TEXTURE_WIDTH;
    this._cacheCanvas.height = TEXTURE_HEIGHT;
    // The canvas needs alpha because we use clearColor to convert the background color to alpha.
    this._cacheCtx = this._cacheCanvas.getContext('2d', {alpha: true});

    this._tmpCanvas = document.createElement('canvas');
    this._tmpCanvas.width = this._config.scaledCharWidth;
    this._tmpCanvas.height = this._config.scaledCharHeight;
    this._tmpCtx = this._tmpCanvas.getContext('2d', {alpha: true});

    this._width = Math.floor(TEXTURE_WIDTH / this._config.scaledCharWidth);
    this._height = Math.floor(TEXTURE_HEIGHT / this._config.scaledCharHeight);
    this._capacity = this._width * this._height;

    // This is useful for debugging
    // document.body.appendChild(this._cacheCanvas);
  }

  public draw(
    ctx: CanvasRenderingContext2D,
    glyph: IGlyphIdentifier,
    x: number,
    y: number,
  ): boolean {
    const glyphKey = getGlyphCacheKey(glyph);
    const index = this._cacheMap.get(glyphKey);
    if (index != null) {
      // move to end of insertion order, so this can behave like an LRU cache
      this._cacheMap.delete(glyphKey);
      this._cacheMap.set(glyphKey, index);
      this._drawFromCache(ctx, index, x, y);
      return true;
    } else if (this._canCache(glyph)) {
      let index;
      if (this._cacheMap.size < this._capacity) {
        index = this._cacheMap.size;
      } else {
        index = mapShift(this._cacheMap)[1];
      }
      this._drawToCache(glyph, index);
      this._cacheMap.set(glyphKey, index);
      this._drawFromCache(ctx, index, x, y);
      return true;
    } else {
      return false;
    }
  }

  private _canCache(glyph: IGlyphIdentifier): boolean {
    // Only cache ascii and extended characters for now, to be safe. In the future, we could do
    // something more complicated to determine the expected width of a character.
    //
    // If we switch the renderer over to webgl at some point, we may be able to use blending modes
    // to draw overlapping glyphs from the atlas:
    // https://github.com/servo/webrender/issues/464#issuecomment-255632875
    // https://webglfundamentals.org/webgl/lessons/webgl-text-texture.html
    return glyph.char.charCodeAt(0) < 256;
  }

  private _toCoordinates(index: number): [number, number] {
    return [
      (index % this._width) * this._config.scaledCharWidth,
      Math.floor(index / this._width) * this._config.scaledCharHeight
    ];
  }

  private _drawFromCache(
    ctx: CanvasRenderingContext2D,
    index: number,
    x: number,
    y: number
  ): void {
    const [cacheX, cacheY] = this._toCoordinates(index);
    ctx.drawImage(
      this._cacheCanvas,
      cacheX,
      cacheY,
      this._config.scaledCharWidth,
      this._config.scaledCharHeight,
      x,
      y,
      this._config.scaledCharWidth,
      this._config.scaledCharHeight,
    );
  }

  // TODO: We do this (or something similar) in multiple places. We should split this off
  // into a shared function.
  private _drawToCache(glyph: IGlyphIdentifier, index: number): void {
    this._tmpCtx.save();
    // no need to clear _tmpCtx, since we're going to draw a fully opaque background

    // draw the background
    let backgroundColor = this._config.colors.background;
    if (glyph.bg === INVERTED_DEFAULT_COLOR) {
      backgroundColor = this._config.colors.foreground;
    } else if (glyph.bg < 256) {
      backgroundColor = this._config.colors.ansi[glyph.bg];
    }
    this._tmpCtx.fillStyle = backgroundColor.css;
    this._tmpCtx.fillRect(0, 0, this._config.scaledCharWidth, this._config.scaledCharHeight);

    // draw the foreground/glyph
    this._tmpCtx.font =
      `${this._config.fontSize * this._config.devicePixelRatio}px ${this._config.fontFamily}`;
    if (glyph.bold) {
      this._tmpCtx.font = `bold ${this._tmpCtx.font}`;
    }
    this._tmpCtx.textBaseline = 'top';

    if (glyph.fg === INVERTED_DEFAULT_COLOR) {
      this._tmpCtx.fillStyle = this._config.colors.background.css;
    } else if (glyph.fg < 256) {
      // 256 color support
      this._tmpCtx.fillStyle = this._config.colors.ansi[glyph.fg].css;
    } else {
      this._tmpCtx.fillStyle = this._config.colors.foreground.css;
    }

    // Apply alpha to dim the character
    if (glyph.dim) {
      this._tmpCtx.globalAlpha = DIM_OPACITY;
    }
    // Draw the character
    this._tmpCtx.fillText(glyph.char, 0, 0);
    this._tmpCtx.restore();

    // clear the background from the character to avoid issues with drawing over the previous
    // character if it extends past it's bounds
    const imageData = this._tmpCtx.getImageData(
      0, 0, this._config.scaledCharWidth, this._config.scaledCharHeight,
    );
    clearColor(imageData, backgroundColor);

    // copy the data from _tmpCanvas to _cacheCanvas
    const [x, y] = this._toCoordinates(index);
    // putImageData doesn't do any blending, so it will overwrite any existing cache entry for us
    this._cacheCtx.putImageData(imageData, x, y);
  }
}
