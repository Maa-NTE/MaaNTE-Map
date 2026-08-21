import mapData from './map-data.json'
import coordinateCalibration from './navi-coordinate-calibration.json'

export const initialMapData = mapData
export const MAP_CONFIG = mapData.map
export const MAP_WIDTH = MAP_CONFIG.width
export const MAP_HEIGHT = MAP_CONFIG.height
export const TILE_SIZE = MAP_CONFIG.tileSize
// Production tiles live in MapSource; local development serves the sibling
// MapSource checkout through Vite so it cannot silently fall back to old tiles.
export const MAP_TILE_URL = import.meta.env.VITE_MAP_TILE_URL
  || (import.meta.env.DEV ? '/mapsource-tiles/{z}/{x}/{y}.jpg' : MAP_CONFIG.tileUrl)
export const MAP_LOCATOR_SOURCE_WIDTH =
  coordinateCalibration.sourceWidth || MAP_CONFIG.mapLocatorSourceWidth || 13056
export const MAP_LOCATOR_SOURCE_HEIGHT =
  coordinateCalibration.sourceHeight || MAP_CONFIG.mapLocatorSourceHeight || 13056

function solveAffine(points) {
  if (!Array.isArray(points) || points.length < 3) throw new Error('至少需要 3 个坐标标定点')
  const [first, second, third] = points
  const [x1, y1] = first.raw
  const [x2, y2] = second.raw
  const [x3, y3] = third.raw
  const determinant = x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2)
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
    throw new Error('坐标标定点共线，无法建立仿射变换')
  }

  function coefficients(index) {
    const value1 = first.map[index]
    const value2 = second.map[index]
    const value3 = third.map[index]
    return {
      x: (value1 * (y2 - y3) + value2 * (y3 - y1) + value3 * (y1 - y2)) / determinant,
      y: (value1 * (x3 - x2) + value2 * (x1 - x3) + value3 * (x2 - x1)) / determinant,
      offset: (
        value1 * (x2 * y3 - x3 * y2)
        + value2 * (x3 * y1 - x1 * y3)
        + value3 * (x1 * y2 - x2 * y1)
      ) / determinant,
    }
  }

  const mapX = coefficients(0)
  const mapY = coefficients(1)
  const inverseDeterminant = mapX.x * mapY.y - mapX.y * mapY.x
  if (!Number.isFinite(inverseDeterminant) || Math.abs(inverseDeterminant) < 1e-12) {
    throw new Error('坐标标定矩阵不可逆')
  }

  return {
    mapX,
    mapY,
    inverseDeterminant,
  }
}

export const COORDINATE_CALIBRATION = coordinateCalibration
const affine = solveAffine(coordinateCalibration.points)

export function gameToMapPixel({ x, y }) {
  const gameX = Number(x)
  const gameY = Number(y)
  return {
    pixelX: affine.mapX.x * gameX + affine.mapX.y * gameY + affine.mapX.offset,
    pixelY: affine.mapY.x * gameX + affine.mapY.y * gameY + affine.mapY.offset,
  }
}

export function mapPixelToGame({
  pixelX,
  pixelY,
  sourceWidth = MAP_LOCATOR_SOURCE_WIDTH,
  sourceHeight = MAP_LOCATOR_SOURCE_HEIGHT,
}) {
  const calibratedX = Number(pixelX) * MAP_LOCATOR_SOURCE_WIDTH / Number(sourceWidth)
  const calibratedY = Number(pixelY) * MAP_LOCATOR_SOURCE_HEIGHT / Number(sourceHeight)
  const shiftedX = calibratedX - affine.mapX.offset
  const shiftedY = calibratedY - affine.mapY.offset
  return {
    x: (shiftedX * affine.mapY.y - affine.mapX.y * shiftedY) / affine.inverseDeterminant,
    y: (affine.mapX.x * shiftedY - shiftedX * affine.mapY.x) / affine.inverseDeterminant,
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

export function gameToMapLatLng(point) {
  return mapPixelToMapLatLng({
    ...gameToMapPixel(point),
    sourceWidth: MAP_LOCATOR_SOURCE_WIDTH,
    sourceHeight: MAP_LOCATOR_SOURCE_HEIGHT,
  })
}

export function mapLatLngToGame(latlng) {
  return mapPixelToGame(mapLatLngToMapLocator(latlng))
}

// 仅用于读取坐标重构前导出的点位/路线文件。
export function legacyWorldToGame({ lat, lng }) {
  return mapPixelToGame({
    pixelX: MAP_LOCATOR_SOURCE_WIDTH / 2 + Number(lng) * 22,
    pixelY: MAP_LOCATOR_SOURCE_HEIGHT / 2 - Number(lat) * 22,
  })
}
