<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import L from 'leaflet'
import { useMapApp } from './composables/useMapApp'
import { MAP_HEIGHT, MAP_WIDTH, TILE_SIZE, gameToMapLatLng, mapPixelToGame, mapPixelToMapLatLng } from './data/locations'
import { INITIAL_ZOOM, MIN_ZOOM } from './constants/mapApp'
import announcement from './data/announcements.json'

// App.vue 保留页面结构，所有交互状态和业务动作都由组合函数提供。
const {
  activeCategories,
  activeDistricts,
  activeRoute,
  activeRouteId,
  addCustomType,
  applyNavigationEndpoint,
  beginClearCompleted,
  bulkCompleteCategoryIds,
  bulkIncompleteCount,
  cancelClearCompleted,
  cancelSegment,
  categoryLookup,
  centerNavigationEnabled,
  clearNavigationRoute,
  clearCategories,
  clearCompleted,
  clearCompletedConfirming,
  clearDistricts,
  collapsibleGroupLabels,
  collapsedCategoryGroups,
  completeDistrictCategory,
  completedCount,
  completedIds,
  completedImportInput,
  coordinates,
  copyCoordinates,
  createRoute,
  deleteLocation,
  deleteRoute,
  deleteSegment,
  districtFilterOpen,
  districtOptions,
  editorCategories,
  editorCategoryGroups,
  editorFormOpen,
  editorMode,
  editingLocationId,
  editingSegment,
  editSegment,
  exportCompleted,
  exportPendingLocationChanges,
  exportRoutes,
  favoriteCount,
  favoriteIds,
  filteredLocations,
  finishSegment,
  getSegmentPoints,
  getVisibleTypes,
  groupedCategories,
  hasActiveDistricts,
  importCompleted,
  importLocationChanges,
  importRoutes,
  isAddingSegment,
  isCategoryGroupCollapsed,
  isGroupFullySelected,
  isGroupPartiallySelected,
  isLocalEditor,
  keepTeleportEnabled,
  locationChangesImportInput,
  locationForm,
  mapElement,
  mapView,
  mergeAdjacentLocationsEnabled,
  navigationConnectionLabel,
  navigationConnectionStatus,
  navigationHost,
  navigationPort,
  navigationRouteSendEnabled,
  navigationState,
  navigationWildcardHostWarning,
  navigationWildcardHostWarningMessage,
  navigationWebSocketUrl,
  openEditLocation,
  pendingLocationChangeCount,
  pendingLocationFilterCount,
  previewImage,
  progress,
  publicAssetUrl,
  query,
  realtimeNavigationEnabled,
  renderRouteArrows,
  resetView,
  routeImportInput,
  routePanelOpen,
  routes,
  saveLocation,
  searchInput,
  selectAllCategories,
  selectedLocation,
  segmentPoints,
  sendRouteToNavigation,
  sendSegmentToNavigation,
  showFavoritesOnly,
  showIncompleteOnly,
  showPendingLocationChangesOnly,
  sidebarCollapsed,
  sidebarFooterOpen,
  startNavigationRoute,
  startSegment,
  statusMessage,
  stopNavigationRoute,
  toggleCategory,
  toggleCategoryGroup,
  toggleCategoryGroupSelection,
  toggleCompleted,
  toggleDistrict,
  toggleFavorite,
  toggleRouteVisibility,
  toggleSegmentVisibility,
  toggleTeleportProtection,
  uploadImages,
  visibleCounts,
  visibleLocationIds,
} = useMapApp()

const navigationGameCoordinates = computed(() => {
  const explicitPosition = navigationState.value.gamePosition
  if (Number.isFinite(explicitPosition?.x) && Number.isFinite(explicitPosition?.y)) {
    return explicitPosition
  }

  const pixelPosition = navigationState.value.position
  if (!pixelPosition) return null

  return {
    ...mapPixelToGame(pixelPosition),
    ...(Number.isFinite(explicitPosition?.z) ? { z: explicitPosition.z } : {}),
  }
})

const hudGameCoordinates = computed(() => navigationGameCoordinates.value || {
  x: coordinates.value.x,
  y: coordinates.value.y,
})

const announcementPanelOpen = ref(true)

const normalizeAnnouncementUrl = (value) => {
  if (typeof value !== 'string') {
    return ''
  }

  const trimmedValue = value.trim()

  if (!/^https?:\/\//i.test(trimmedValue)) {
    return ''
  }

  try {
    const url = new URL(trimmedValue)

    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : ''
  } catch {
    return ''
  }
}

const announcementItems = computed(() =>
  (announcement.items || []).map((item) => ({
    ...item,
    quickUrl: normalizeAnnouncementUrl(item.url || item.body),
  })),
)

const pictureInPictureWindow = ref(null)
const pictureInPictureError = ref('')
let pictureInPictureMap = null
let pictureInPictureMarkerLayer = null
let pictureInPictureNavigationMarker = null
let pictureInPictureViewFrame = 0

const isPictureInPictureOpen = computed(() =>
  Boolean(pictureInPictureWindow.value && !pictureInPictureWindow.value.closed),
)

const isDocumentPictureInPictureSupported = computed(() =>
  typeof window !== 'undefined' && 'documentPictureInPicture' in window,
)

const pictureInPictureButtonLabel = computed(() =>
  isPictureInPictureOpen.value ? '关闭小窗' : '悬浮小窗',
)

const injectPictureInPictureStyles = (doc) => {
  const copiedStyleNodes = [...document.querySelectorAll('link[rel="stylesheet"], style')]
    .map((node) => node.cloneNode(true))
  const style = doc.createElement('style')
  style.textContent = `
    :root {
      color: #f5fffd;
      background: #071112;
      font-family: 'Microsoft YaHei UI', 'Microsoft YaHei', Arial, sans-serif;
      font-synthesis: none;
      text-rendering: optimizeLegibility;
    }

    * {
      box-sizing: border-box;
    }

    body {
      width: 100vw;
      min-width: 0;
      height: 100vh;
      margin: 0;
      overflow: hidden;
      background: #000;
    }

    #pip-map {
      width: 100vw;
      height: 100vh;
      background: #000;
    }

    #pip-map::after {
      position: absolute;
      z-index: 400;
      inset: 0;
      pointer-events: none;
      content: '';
      background:
        linear-gradient(90deg, rgba(0, 0, 0, 0.3), transparent 22%, transparent 78%, rgba(0, 0, 0, 0.3)),
        linear-gradient(rgba(0, 0, 0, 0.2), transparent 18%, transparent 82%, rgba(0, 0, 0, 0.22));
    }

    .pip-map-status {
      position: absolute;
      z-index: 1000;
      left: 8px;
      bottom: 8px;
      padding: 5px 7px;
      color: #b8fff2;
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 4px;
      background: rgba(0, 0, 0, 0.72);
      font-size: 11px;
      font-weight: 800;
      pointer-events: none;
    }

    .leaflet-control-container {
      display: none;
    }
  `
  doc.head.replaceChildren(...copiedStyleNodes, style)
}

const getPrimaryCategory = (location) => {
  const visibleTypes = getVisibleTypes(location)
  const activeType = visibleTypes.find((type) => activeCategories.value.has(type))

  return categoryLookup.value[activeType || visibleTypes[0]]
}

const categoryIconHtml = (category) => {
  const src = category?.iconUrl || (category?.icon?.startsWith('/') ? category.icon : null)
  return src ? `<img src="${publicAssetUrl(src)}" alt="" />` : category?.icon || '·'
}

const createPictureInPictureMarkerIcon = (location) => {
  const category = getPrimaryCategory(location)
  const completed = completedIds.value.has(location.id)
  const selected = selectedLocation.value?.id === location.id
  const extraCount = Math.max(getVisibleTypes(location).length - 1, 0)

  return L.divIcon({
    className: 'marker-shell',
    html: `
      <div class="map-marker ${completed ? 'map-marker--completed' : ''} ${selected ? 'map-marker--selected' : ''}"
        style="--marker-color:${category?.color || '#8adfd6'}">
        <span>${categoryIconHtml(category)}</span>
        ${extraCount ? `<b>+${extraCount}</b>` : ''}
      </div>
    `,
    iconSize: [36, 44],
    iconAnchor: [18, 42],
  })
}

const createPictureInPictureNavigationIcon = () => L.divIcon({
  className: 'navigation-arrow-shell',
  html: `<div class="navigation-arrow"><img src="${publicAssetUrl('/images/map_webview_pointer.png')}" alt=""></div>`,
  iconSize: [30, 35],
  iconAnchor: [15, 18],
})

const getPictureInPictureTargetView = () => {
  const state = navigationState.value
  if (state.position) {
    return {
      center: mapPixelToMapLatLng(state.position),
      zoom: mapView.value?.zoom ?? INITIAL_ZOOM,
    }
  }

  if (mapView.value) {
    return {
      center: [mapView.value.center.lat, mapView.value.center.lng],
      zoom: mapView.value.zoom,
    }
  }

  return null
}

const syncPictureInPictureView = () => {
  pictureInPictureViewFrame = 0
  if (!pictureInPictureMap) return
  const targetView = getPictureInPictureTargetView()
  if (!targetView) return

  pictureInPictureMap.setView(targetView.center, targetView.zoom, {
    animate: false,
    noMoveStart: true,
  })
  pictureInPictureMap.invalidateSize({ animate: false, pan: false })
}

const schedulePictureInPictureViewSync = () => {
  if (!pictureInPictureMap || pictureInPictureViewFrame) return
  pictureInPictureViewFrame = requestAnimationFrame(syncPictureInPictureView)
}

const renderPictureInPictureMarkers = () => {
  if (!pictureInPictureMap || !pictureInPictureMarkerLayer) return
  pictureInPictureMarkerLayer.clearLayers()
  filteredLocations.value.forEach((location) => {
    L.marker(gameToMapLatLng(location), {
      icon: createPictureInPictureMarkerIcon(location),
      title: location.name,
      interactive: false,
      keyboard: false,
    }).addTo(pictureInPictureMarkerLayer)
  })
}

const createPictureInPictureMarkerLayer = () =>
  mergeAdjacentLocationsEnabled.value && L.markerClusterGroup
    ? L.markerClusterGroup({
        chunkedLoading: true,
        maxClusterRadius: 52,
        disableClusteringAtZoom: 0,
        showCoverageOnHover: false,
      })
    : L.layerGroup()

const rebuildPictureInPictureMarkerLayer = () => {
  if (!pictureInPictureMap) return
  pictureInPictureMarkerLayer?.clearLayers()
  pictureInPictureMarkerLayer?.remove()
  pictureInPictureMarkerLayer = createPictureInPictureMarkerLayer().addTo(pictureInPictureMap)
  renderPictureInPictureMarkers()
}

const renderPictureInPictureNavigation = () => {
  if (!pictureInPictureMap) return
  const state = navigationState.value
  if (!state.position) {
    pictureInPictureNavigationMarker?.remove()
    pictureInPictureNavigationMarker = null
    return
  }

  const latlng = mapPixelToMapLatLng(state.position)
  if (!pictureInPictureNavigationMarker) {
    pictureInPictureNavigationMarker = L.marker(latlng, {
      icon: createPictureInPictureNavigationIcon(),
      interactive: false,
      keyboard: false,
      zIndexOffset: 1000000,
    }).addTo(pictureInPictureMap)
  } else {
    pictureInPictureNavigationMarker.setLatLng(latlng)
  }

  const markerElement = pictureInPictureNavigationMarker.getElement()
  const arrowElement = markerElement?.querySelector('.navigation-arrow')
  const arrowImage = markerElement?.querySelector('.navigation-arrow img')
  arrowElement?.classList.toggle('navigation-arrow--angle-missing', state.angle === null)
  if (arrowImage && Number.isFinite(state.angle)) {
    arrowImage.style.transform = `translateZ(0) rotate(${state.angle}deg)`
  }
  schedulePictureInPictureViewSync()
}

const renderPictureInPictureStatus = () => {
  const pipWindow = pictureInPictureWindow.value
  if (!pipWindow || pipWindow.closed) return
  const status = pipWindow.document.querySelector('.pip-map-status')
  if (status) {
    status.textContent = `NAVI ${navigationConnectionLabel.value}`
  }
}

const syncPictureInPictureMap = () => {
  const pipWindow = pictureInPictureWindow.value
  if (!pipWindow || pipWindow.closed) {
    pictureInPictureWindow.value = null
    return
  }

  syncPictureInPictureView()
  renderPictureInPictureMarkers()
  renderPictureInPictureNavigation()
  renderPictureInPictureStatus()
}

const destroyPictureInPictureMap = () => {
  if (pictureInPictureViewFrame) {
    cancelAnimationFrame(pictureInPictureViewFrame)
    pictureInPictureViewFrame = 0
  }
  pictureInPictureNavigationMarker?.remove()
  pictureInPictureNavigationMarker = null
  pictureInPictureMarkerLayer = null
  pictureInPictureMap?.remove()
  pictureInPictureMap = null
}

const bindPictureInPictureDragGuard = (mapContainer, pipWindow) => {
  const blockHoverMove = (event) => {
    if (event.buttons === 0) {
      event.stopImmediatePropagation()
    }
  }

  const stopDrag = () => {
    pictureInPictureMap?.dragging.disable()
    pictureInPictureMap?.dragging.enable()
  }

  mapContainer.addEventListener('pointermove', blockHoverMove, true)
  mapContainer.addEventListener('mousemove', blockHoverMove, true)
  pipWindow.addEventListener('pointerup', stopDrag)
  pipWindow.addEventListener('mouseup', stopDrag)
  pipWindow.addEventListener('blur', stopDrag)
}

const initializePictureInPictureMap = (pipWindow) => {
  const { document: doc } = pipWindow
  doc.body.replaceChildren()

  const mapContainer = doc.createElement('div')
  mapContainer.id = 'pip-map'
  const status = doc.createElement('div')
  status.className = 'pip-map-status'
  mapContainer.append(status)
  doc.body.append(mapContainer)
  bindPictureInPictureDragGuard(mapContainer, pipWindow)

  const bounds = L.latLngBounds([-MAP_HEIGHT, 0], [0, MAP_WIDTH])
  pictureInPictureMap = L.map(mapContainer, {
    crs: L.CRS.Simple,
    minZoom: MIN_ZOOM,
    maxZoom: 1,
    maxBounds: bounds.pad(0.18),
    zoomControl: false,
    attributionControl: false,
    fadeAnimation: false,
    zoomAnimation: false,
    markerZoomAnimation: false,
  })
  L.tileLayer(publicAssetUrl('/tiles/{z}/{x}/{y}.jpg'), {
    bounds,
    minZoom: MIN_ZOOM,
    maxNativeZoom: 0,
    maxZoom: 1,
    noWrap: true,
    tileSize: TILE_SIZE,
    keepBuffer: 10,
    updateWhenIdle: false,
    updateWhenZooming: false,
    updateInterval: 80,
  }).addTo(pictureInPictureMap)
  pictureInPictureMarkerLayer = createPictureInPictureMarkerLayer().addTo(pictureInPictureMap)
  if (mapView.value) syncPictureInPictureView()
  else pictureInPictureMap.setView(bounds.getCenter(), INITIAL_ZOOM)
  syncPictureInPictureMap()
  const refreshSize = () => {
    pictureInPictureMap?.invalidateSize({ animate: false, pan: false })
    schedulePictureInPictureViewSync()
  }
  requestAnimationFrame(refreshSize)
  pipWindow.addEventListener('resize', refreshSize)
}

const toggleDocumentPictureInPicture = async () => {
  pictureInPictureError.value = ''

  if (isPictureInPictureOpen.value) {
    destroyPictureInPictureMap()
    pictureInPictureWindow.value.close()
    pictureInPictureWindow.value = null
    return
  }

  if (!isDocumentPictureInPictureSupported.value) {
    pictureInPictureError.value = '当前浏览器不支持 Document Picture-in-Picture。'
    return
  }

  try {
    const pipWindow = await window.documentPictureInPicture.requestWindow({
      width: 320,
      height: 260,
      preferInitialWindowPlacement: true,
    })

    pictureInPictureWindow.value = pipWindow
    injectPictureInPictureStyles(pipWindow.document)
    initializePictureInPictureMap(pipWindow)

    pipWindow.addEventListener('pagehide', () => {
      if (pictureInPictureWindow.value === pipWindow) {
        destroyPictureInPictureMap()
        pictureInPictureWindow.value = null
      }
    })
  } catch (error) {
    pictureInPictureError.value = error?.name === 'NotAllowedError'
      ? '请通过点击按钮打开悬浮小窗。'
      : '悬浮小窗打开失败。'
  }
}

watch(mapView, schedulePictureInPictureViewSync, { deep: true })
watch([navigationConnectionLabel, navigationConnectionStatus], renderPictureInPictureStatus)
watch(navigationState, renderPictureInPictureNavigation, { deep: true })
watch([filteredLocations, completedIds, selectedLocation, activeCategories], renderPictureInPictureMarkers, { deep: true })
watch(mergeAdjacentLocationsEnabled, rebuildPictureInPictureMarkerLayer)

onBeforeUnmount(() => {
  destroyPictureInPictureMap()
  if (isPictureInPictureOpen.value) {
    pictureInPictureWindow.value.close()
  }
})
</script>

<template>
  <main class="app-shell">
    <div ref="mapElement" class="map-canvas" />

    <header class="topbar glass-panel">
      <div class="brand-block topbar-brand">
        <img class="brand-mark" :src="publicAssetUrl('/logo.png')" alt="MaaNTE" />
        <div class="brand-copy">
          <p class="eyebrow">MaaNTE Map</p>
          <div class="brand-title-row">
            <details class="brand-map-menu">
              <summary>
                <h1>MaaNTE在线地图工具</h1>
                <span class="brand-map-menu__hint">前往其它地图站</span>
              </summary>
              <div class="brand-map-menu__panel">
                <a href="https://pph.maante.org/" target="_blank" rel="noopener noreferrer">粉爪大劫案在线地图</a>
                <a href="https://999.maante.org/" target="_blank" rel="noopener noreferrer">九百九十九夜在线地图</a>
              </div>
            </details>
          </div>
        </div>
      </div>
      <div class="topbar-search">
        <label class="search-box">
        <span class="search-icon">⌕</span>
        <input ref="searchInput" v-model="query" type="search" placeholder="搜索地点、区域或关键词..." />
        <kbd>/</kbd>
        </label>
      </div>
      <div class="toolbar topbar-tools">
        <button :class="{ 'toolbar-button--active': editorMode }" type="button" @click="editorMode = !editorMode">
          {{ editorMode ? '编辑已开启' : '编辑地图' }}
        </button>
        <button v-if="editorMode" type="button" @click="locationChangesImportInput?.click()">导入点位修改</button>
        <button v-if="editorMode" type="button" :disabled="!pendingLocationChangeCount" @click="exportPendingLocationChanges">
          导出点位修改<span v-if="pendingLocationChangeCount">（{{ pendingLocationChangeCount }}）</span>
        </button>
        <button
          v-if="editorMode"
          type="button"
          :class="{ 'toolbar-button--active': showPendingLocationChangesOnly }"
          :disabled="!pendingLocationFilterCount"
          @click="showPendingLocationChangesOnly = !showPendingLocationChangesOnly"
        >
          当前修改<span v-if="pendingLocationFilterCount">（{{ pendingLocationFilterCount }}）</span>
        </button>
        <input ref="locationChangesImportInput" class="toolbar-file-input" type="file" accept="application/json,.json" @change="importLocationChanges" />
        <button :class="{ 'toolbar-button--active': routePanelOpen }" type="button" @click="routePanelOpen = !routePanelOpen">
          路线
        </button>
        <div class="progress-block">
          <div class="progress-copy"><span>探索进度</span><strong>{{ progress }}%</strong></div>
          <div class="progress-track"><i :style="{ width: `${progress}%` }" /></div>
          <div class="progress-footer">
            <small>{{ completedCount }} / {{ visibleLocationIds.size }} 已完成</small>
            <button v-if="!clearCompletedConfirming" type="button" class="text-button progress-clear-button" :disabled="!completedIds.size" @click="beginClearCompleted">清空</button>
          </div>
          <div class="progress-file-actions">
            <button type="button" @click="completedImportInput?.click()">导入</button>
            <button type="button" @click="exportCompleted">导出</button>
            <input ref="completedImportInput" type="file" accept="application/json,.json" @change="importCompleted" />
          </div>
          <div v-if="clearCompletedConfirming" class="progress-confirm-popover glass-panel">
            <span class="progress-confirm-copy">确认清空？</span>
            <div class="progress-confirm-actions">
              <button type="button" class="progress-action-button progress-action-button--danger" @click="clearCompleted">确认</button>
              <button type="button" class="progress-action-button" @click="cancelClearCompleted">取消</button>
            </div>
          </div>
        </div>
      </div>
    </header>

    <aside class="sidebar glass-panel" :class="{ 'sidebar--collapsed': sidebarCollapsed }">
      <button class="sidebar-toggle" type="button" @click="sidebarCollapsed = !sidebarCollapsed">
        {{ sidebarCollapsed ? '›' : '‹' }}
      </button>
      <div class="sidebar-content">
        <div class="sidebar-categories">
          <div class="sidebar-heading">
            <div><p class="eyebrow">MARKER CATEGORIES</p><h2>标记分类</h2></div>
            <div class="filter-actions">
              <button type="button" class="text-button" @click="selectAllCategories">全选</button>
              <button type="button" class="text-button" @click="clearCategories">清空</button>
            </div>
          </div>
          <div class="category-list">
            <div class="category-group-block">
              <p class="category-group">收藏</p>
              <div class="category-group-items">
                <button
                  class="category-button"
                  :class="{ 'category-button--muted': !showFavoritesOnly }"
                  type="button"
                  @click="showFavoritesOnly = !showFavoritesOnly"
                >
                  <span class="category-icon" :style="{ '--category-color': '#f1c75b' }">★</span>
                  <span>已收藏</span><small>{{ favoriteCount }}</small>
                </button>
              </div>
            </div>
            <template v-for="group in groupedCategories" :key="group.label">
              <div class="category-group-block" :class="{ 'category-group-block--collapsed': isCategoryGroupCollapsed(group.label) }">
                <button
                  v-if="collapsibleGroupLabels.has(group.label)"
                  class="category-group-toggle"
                  type="button"
                  @click="toggleCategoryGroup(group.label)"
                >
                  <span class="category-group-heading">
                    <span class="category-group-title">{{ group.label }}</span>
                  </span>
                  <span class="category-group-meta">
                    <button
                      class="category-select-all category-select-all--inline"
                      :class="{
                        'category-select-all--active': isGroupFullySelected(group),
                        'category-select-all--partial': isGroupPartiallySelected(group),
                      }"
                      type="button"
                      :aria-checked="isGroupFullySelected(group) ? 'true' : isGroupPartiallySelected(group) ? 'mixed' : 'false'"
                      role="checkbox"
                      @click.stop="toggleCategoryGroupSelection(group)"
                    >
                      <span>全选</span>
                      <span class="category-select-all__box" aria-hidden="true">
                        <i v-if="isGroupFullySelected(group)" class="category-select-all__check" />
                        <i v-else-if="isGroupPartiallySelected(group)" class="category-select-all__dash" />
                      </span>
                    </button>
                    <small>{{ group.categories.length }}</small>
                    <i>{{ isCategoryGroupCollapsed(group.label) ? '▸' : '▾' }}</i>
                  </span>
                </button>
                <p v-else class="category-group">{{ group.label }}</p>
                <div v-show="!isCategoryGroupCollapsed(group.label)" class="category-group-items">
                  <button v-for="category in group.categories" :key="category.id" class="category-button"
                    :class="{ 'category-button--muted': !activeCategories.has(category.id) }" type="button" @click="toggleCategory(category.id)">
                    <span class="category-icon" :style="{ '--category-color': category.color }">
                      <img v-if="category.iconUrl || category.icon?.startsWith('/')" :src="publicAssetUrl(category.iconUrl || category.icon)" alt="" />
                      <template v-else>{{ category.icon }}</template>
                    </span>
                    <span>{{ category.label }}</span><small>{{ visibleCounts[category.id] }}</small>
                  </button>
                </div>
              </div>
            </template>
          </div>
        </div>
        <div class="sidebar-footer">
          <button class="sidebar-footer__toggle" type="button" @click="sidebarFooterOpen = !sidebarFooterOpen">
            <span><b>设置选项</b><small>{{ sidebarFooterOpen ? '点击收起设置' : '点击展开设置' }}</small></span>
            <i>{{ sidebarFooterOpen ? '▾' : '▸' }}</i>
          </button>
          <div v-show="sidebarFooterOpen" class="sidebar-footer__body">
          <div class="sidebar-expander">
            <button class="sidebar-expander__toggle" type="button" @click="districtFilterOpen = !districtFilterOpen">
              <span><b>区域筛选</b><small>{{ hasActiveDistricts ? `${activeDistricts.size} 项已选` : '按区域筛选点位' }}</small></span>
              <i>{{ districtFilterOpen ? '▾' : '▸' }}</i>
            </button>
            <div v-show="districtFilterOpen" class="sidebar-expander__body">
              <div class="district-list">
                <button
                  v-for="district in districtOptions"
                  :key="district"
                  class="district-button"
                  :class="{ 'district-button--active': activeDistricts.has(district) }"
                  type="button"
                  @click="toggleDistrict(district)"
                >
                  {{ district }}
                </button>
              </div>
              <div class="sidebar-expander__actions">
                <button type="button" class="text-button" :disabled="!hasActiveDistricts" @click="clearDistricts">清空区域</button>
                <button
                  type="button"
                  class="text-button"
                  :disabled="!bulkIncompleteCount"
                  :title="bulkCompleteCategoryIds.length && hasActiveDistricts ? '' : '请选择至少一个普通标签和一个区域'"
                  @click="completeDistrictCategory"
                >
                  一键完成<span v-if="bulkCompleteCategoryIds.length && hasActiveDistricts">（{{ bulkIncompleteCount }}）</span>
                </button>
              </div>
            </div>
          </div>
          <label class="switch-row">
            <span><b>传送点保持开启</b><small>清空分类时仍显示传送点</small></span>
            <input :checked="keepTeleportEnabled" type="checkbox" @change="toggleTeleportProtection" /><i />
          </label>
          <label class="switch-row">
            <span><b>合并相邻点位</b><small>开启后邻近标记会聚合显示</small></span>
            <input v-model="mergeAdjacentLocationsEnabled" type="checkbox" /><i />
          </label>
          <label class="switch-row">
            <span><b>仅显示未完成</b><small>隐藏已经探索的标记</small></span>
            <input v-model="showIncompleteOnly" type="checkbox" /><i />
          </label>
          <label class="switch-row">
            <span><b>实时定位</b><small>开启后监听本地导航数据</small></span>
            <input v-model="realtimeNavigationEnabled" type="checkbox" /><i />
          </label>
          <label v-if="realtimeNavigationEnabled" class="switch-row">
            <span><b>箭头保持居中</b><small>自动将导航箭头保持在窗口中心</small></span>
            <input v-model="centerNavigationEnabled" type="checkbox" /><i />
          </label>
          <div v-if="realtimeNavigationEnabled" class="navigation-endpoint-row">
            <span><b>监听地址</b><small>{{ navigationWebSocketUrl }}</small></span>
            <p class="navigation-endpoint-warning">除非明确知道此项用途，否则请保持默认设置。</p>
            <div class="navigation-endpoint-fields">
              <label>
                <span>IP</span>
                <input
                  v-model.trim="navigationHost"
                  type="text"
                  inputmode="url"
                  autocomplete="off"
                  :class="{ 'is-danger': navigationWildcardHostWarning }"
                  @change="applyNavigationEndpoint"
                />
              </label>
              <label>
                <span>端口</span>
                <input v-model.trim="navigationPort" type="number" min="1" max="65535" step="1" inputmode="numeric" @change="applyNavigationEndpoint" />
              </label>
            </div>
          </div>
          <div class="filter-summary">{{ filteredLocations.length }} 个标记显示中</div>
          </div>
        </div>
      </div>
    </aside>

    <div class="right-panel-stack">
      <aside class="announcement-panel glass-panel">
        <button
          class="announcement-panel__toggle"
          type="button"
          :aria-expanded="announcementPanelOpen"
          @click="announcementPanelOpen = !announcementPanelOpen"
        >
          <span>
            <p class="eyebrow">ANNOUNCEMENT</p>
            <h2>{{ announcement.title }}</h2>
          </span>
          <i>{{ announcementPanelOpen ? '-' : '+' }}</i>
        </button>
        <div v-show="announcementPanelOpen" class="announcement-panel__body">
          <p v-if="announcement.subtitle" class="announcement-panel__summary">{{ announcement.subtitle }}</p>
          <div class="announcement-list">
            <article v-for="item in announcementItems" :key="item.title" class="announcement-item">
              <h3>{{ item.title }}</h3>
              <a
                v-if="item.quickUrl"
                class="announcement-item__link"
                :href="item.quickUrl"
                target="_blank"
                rel="noopener noreferrer"
              >
                {{ item.body || item.quickUrl }}
              </a>
              <p v-else>{{ item.body }}</p>
            </article>
          </div>
          <small v-if="announcement.updatedAt" class="announcement-panel__date">更新：{{ announcement.updatedAt }}</small>
        </div>
      </aside>

      <aside v-if="routePanelOpen" class="route-panel glass-panel">
        <div class="sidebar-heading">
          <div><p class="eyebrow">ROUTES</p><h2>路线规划</h2></div>
          <button v-if="editorMode" type="button" class="text-button" @click="createRoute">+ 新建</button>
        </div>
        <div class="route-file-actions">
          <button type="button" @click="routeImportInput?.click()">导入 JSON</button>
          <button type="button" :disabled="!routes.length" @click="exportRoutes">导出 JSON</button>
          <input ref="routeImportInput" type="file" accept="application/json,.json" @change="importRoutes" />
        </div>
        <div class="route-list">
          <button v-for="route in routes" :key="route.id" type="button" :class="{ active: activeRouteId === route.id, hidden: route.isHidden }" @click="toggleRouteVisibility(route)">
            <span>{{ route.name }}</span><small>{{ route.isHidden ? '已隐藏' : `${route.segments.length} 个路段` }}</small>
          </button>
        </div>
        <template v-if="activeRoute">
          <div class="route-heading">
            <b>{{ activeRoute.name }}</b>
            <button v-if="editorMode" type="button" @click="deleteRoute(activeRoute)">删除路线</button>
          </div>
          <div class="route-file-actions">
            <button type="button" :disabled="!navigationRouteSendEnabled" @click="sendRouteToNavigation(activeRoute)">发送整条路线</button>
            <button type="button" :disabled="!navigationRouteSendEnabled" @click="startNavigationRoute">开始</button>
            <button type="button" :disabled="!navigationRouteSendEnabled" @click="stopNavigationRoute">暂停</button>
            <button type="button" :disabled="!navigationRouteSendEnabled" @click="clearNavigationRoute">清空服务端</button>
          </div>
          <small v-if="navigationState.route" class="route-server-status">
            服务端：{{ navigationState.route.status }} {{ navigationState.route.currentIndex || 0 }}/{{ navigationState.route.waypoints?.length || 0 }}
          </small>
          <div v-if="isAddingSegment" class="segment-editor">
            <span>{{ editingSegment ? `正在编辑：${editingSegment.name}` : '新路段' }}：{{ segmentPoints.length }} 个点</span>
            <button type="button" @click="segmentPoints = segmentPoints.slice(0, -1); renderRouteArrows()">撤销</button>
            <button type="button" @click="cancelSegment">取消</button>
            <button type="button" :disabled="segmentPoints.length < 2" @click="finishSegment">{{ editingSegment ? '保存' : '完成' }}</button>
          </div>
          <button v-else-if="editorMode" class="add-segment-button" type="button" @click="startSegment">+ 添加路段</button>
          <div class="segment-list">
            <button v-for="segment in activeRoute.segments" :key="segment.id" type="button" :class="{ hidden: segment.isHidden }" @click="toggleSegmentVisibility(segment)">
              <span>{{ segment.name }}</span><small>{{ segment.isHidden ? '已隐藏' : `${getSegmentPoints(segment).length} 个点` }}</small>
              <i @click.stop="sendSegmentToNavigation(segment)">发送</i>
              <i v-if="editorMode" @click.stop="editSegment(segment)">编辑</i>
              <i v-if="editorMode" @click.stop="deleteSegment(segment)">×</i>
            </button>
          </div>
        </template>
        <p v-else class="empty-copy">选择路线后可查看路段。</p>
      </aside>
    </div>

    <section v-if="selectedLocation" class="detail-card glass-panel">
      <button class="close-button" type="button" aria-label="关闭详情" @click="selectedLocation = null">×</button>
      <div v-if="selectedLocation.images.length" class="image-gallery">
        <img v-for="image in selectedLocation.images" :key="image" :src="publicAssetUrl(image)" :alt="selectedLocation.name" @click="previewImage = image" />
      </div>
      <p class="eyebrow">{{ selectedLocation.district }}</p>
      <h2>{{ selectedLocation.name }}</h2>
      <p v-if="selectedLocation.description" class="detail-description">{{ selectedLocation.description }}</p>
      <div class="tag-row">
        <span v-for="type in getVisibleTypes(selectedLocation)" :key="type">{{ categoryLookup[type]?.label || type }}</span>
        <span v-for="tag in selectedLocation.tags" :key="tag"># {{ tag }}</span>
      </div>
      <button class="coordinate-row" type="button" @click="copyCoordinates">
        <span>游戏坐标</span><code>{{ selectedLocation.x.toFixed(3) }}, {{ selectedLocation.y.toFixed(3) }}</code><small>复制</small>
      </button>
      <div v-if="editorMode" class="detail-actions">
        <button type="button" @click="openEditLocation(selectedLocation)">编辑</button>
        <button type="button" class="danger-button" @click="deleteLocation(selectedLocation)">删除</button>
      </div>
      <div v-else class="detail-actions">
        <button type="button" :class="{ 'action-button--active': favoriteIds.has(selectedLocation.id) }" @click="toggleFavorite(selectedLocation.id)">
          {{ favoriteIds.has(selectedLocation.id) ? '★ 已收藏' : '☆ 收藏' }}
        </button>
        <button type="button" class="primary-action" :class="{ 'primary-action--done': completedIds.has(selectedLocation.id) }" @click="toggleCompleted(selectedLocation.id)">
          {{ completedIds.has(selectedLocation.id) ? '✓ 已完成' : '标记完成' }}
        </button>
      </div>
    </section>

    <div class="map-hud glass-panel">
      <button type="button" @click="resetView">重置视野</button>
      <button type="button" :class="{ 'map-hud-button--active': isPictureInPictureOpen }" @click="toggleDocumentPictureInPicture">
        {{ pictureInPictureButtonLabel }}
      </button>
      <span class="game-coordinate">
        XYZ
        {{ hudGameCoordinates.x.toFixed(0) }},
        {{ hudGameCoordinates.y.toFixed(0) }},
        {{ Number.isFinite(hudGameCoordinates.z) ? hudGameCoordinates.z.toFixed(0) : '--' }}
      </span>
      <span class="navigation-status" :class="`navigation-status--${navigationConnectionStatus}`">NAVI {{ navigationConnectionLabel }}</span>
      <span v-if="pictureInPictureError" class="map-hud-error">{{ pictureInPictureError }}</span>
    </div>
    <div v-if="editorMode" class="editor-tip glass-panel">编辑模式：点击地图空白处添加点位</div>
    <div v-if="statusMessage" class="status-toast glass-panel">{{ statusMessage }}</div>
    <div v-if="navigationWildcardHostWarning" class="navigation-wildcard-modal" role="alert" aria-live="assertive">
      <div class="navigation-wildcard-modal__panel">
        {{ navigationWildcardHostWarningMessage }}
      </div>
    </div>

    <div v-if="editorFormOpen" class="modal-backdrop" @click.self="editorFormOpen = false">
      <form class="editor-form glass-panel" @submit.prevent="saveLocation">
        <div class="sidebar-heading"><h2>{{ editingLocationId ? '编辑点位' : '新建点位' }}</h2><button type="button" class="close-button" @click="editorFormOpen = false">×</button></div>
        <label>点位 ID<input v-model.trim="locationForm.locationId" :disabled="!!editingLocationId" placeholder="留空自动生成 local ID" /></label>
        <label>名称<input v-model="locationForm.name" required /></label>
        <label>区域<select v-model="locationForm.district">
          <option v-for="district in districtOptions" :key="district" :value="district">{{ district }}</option>
        </select></label>
        <div class="form-grid"><label>游戏 X<input v-model.number="locationForm.x" type="number" step="any" /></label><label>游戏 Y<input v-model.number="locationForm.y" type="number" step="any" /></label></div>
        <label>描述<textarea v-model="locationForm.description" rows="3" /></label>
        <label>搜索关键词（可选）<input v-model="locationForm.tagsText" placeholder="使用英文逗号分隔，用于辅助搜索" /></label>
        <fieldset><legend>类型（可多选）</legend><div class="type-picker">
          <label v-for="category in editorCategories" :key="category.id" :data-category-id="category.id" :data-category-group="category.group"><input v-model="locationForm.types" type="checkbox" :value="category.id" />{{ category.label }}</label>
        </div>
        <div class="custom-type-editor">
          <p>添加自定义类型</p>
          <div class="custom-type-row">
            <label>类型 ID<input v-model="locationForm.customTypeId" placeholder="输入稳定 ID，例如 witch-house" @keydown.enter.prevent="addCustomType" /></label>
            <label>类型名称<input v-model="locationForm.customTypeText" placeholder="输入自定义类型名称" @keydown.enter.prevent="addCustomType" /></label>
            <label>归属大类<select v-model="locationForm.customTypeGroup" aria-label="选择标记大类">
              <option disabled value="">请选择大类</option>
              <option v-for="group in editorCategoryGroups" :key="group" :value="group">{{ group }}</option>
            </select></label>
            <label>或新建大类<input v-model="locationForm.customTypeNewGroup" placeholder="新建大类（可选）" @keydown.enter.prevent="addCustomType" /></label>
          </div>
          <button type="button" :disabled="!locationForm.customTypeId.trim() || !locationForm.customTypeText.trim() || (!locationForm.customTypeGroup && !locationForm.customTypeNewGroup.trim())" @click="addCustomType">+ 添加类型</button>
        </div></fieldset>
        <label>截图<input type="file" accept="image/*" multiple @change="uploadImages" /></label>
        <div v-if="locationForm.images.length" class="form-images">
          <span v-for="(image, index) in locationForm.images" :key="image"><img :src="publicAssetUrl(image)" alt="" /><button type="button" @click="locationForm.images.splice(index, 1)">×</button></span>
        </div>
        <div class="detail-actions editor-form-actions"><button type="button" @click="editorFormOpen = false">取消</button><button class="primary-action" type="submit">{{ isLocalEditor ? '保存' : '导出修改 JSON' }}</button></div>
      </form>
    </div>

    <div v-if="previewImage" class="image-preview" @click="previewImage = ''"><img :src="publicAssetUrl(previewImage)" alt="点位截图" @click.stop /></div>
  </main>
</template>
