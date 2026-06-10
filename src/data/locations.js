import mapData from './map-data.json'

export const initialMapData = mapData
export const MAP_CONFIG = mapData.map
export const MAP_WIDTH = MAP_CONFIG.width
export const MAP_HEIGHT = MAP_CONFIG.height
export const TILE_SIZE = MAP_CONFIG.tileSize
export const MAP_LOCATOR_SOURCE_WIDTH = MAP_CONFIG.mapLocatorSourceWidth || 11264
export const MAP_LOCATOR_SOURCE_HEIGHT = MAP_CONFIG.mapLocatorSourceHeight || 11264

// Keep the transform stable when new tiles are appended. When expanding left or
// upward, update only worldOriginPixel by the number of prepended pixels.
export function worldToMapLatLng({ lat, lng }) {
  const x = MAP_CONFIG.worldOriginPixel.x + lng * MAP_CONFIG.pixelsPerWorldUnit
  const y = MAP_CONFIG.worldOriginPixel.y - lat * MAP_CONFIG.pixelsPerWorldUnit
  return [-y, x]
}

export function mapLatLngToWorld({ lat, lng }) {
  return {
    lat: (MAP_CONFIG.worldOriginPixel.y + lat) / MAP_CONFIG.pixelsPerWorldUnit,
    lng: (lng - MAP_CONFIG.worldOriginPixel.x) / MAP_CONFIG.pixelsPerWorldUnit,
  }
}

export function mapPixelToMapLatLng({ pixelX, pixelY, sourceWidth = MAP_WIDTH, sourceHeight = MAP_HEIGHT }) {
  return [
    -pixelY * MAP_HEIGHT / sourceHeight,
    pixelX * MAP_WIDTH / sourceWidth,
  ]
}

export function mapLatLngToMapLocator(
  { lat, lng },
  sourceWidth = MAP_LOCATOR_SOURCE_WIDTH,
  sourceHeight = MAP_LOCATOR_SOURCE_HEIGHT,
) {
  return {
    pixelX: lng * sourceWidth / MAP_WIDTH,
    pixelY: -lat * sourceHeight / MAP_HEIGHT,
  }
}
