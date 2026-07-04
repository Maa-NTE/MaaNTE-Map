import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import L from 'leaflet'
import 'leaflet.markercluster'
import {
  initialMapData,
  MAP_HEIGHT,
  MAP_LOCATOR_SOURCE_HEIGHT,
  MAP_LOCATOR_SOURCE_WIDTH,
  MAP_WIDTH,
  TILE_SIZE,
  gameToMapLatLng,
  gameToMapPixel,
  legacyWorldToGame,
  mapLatLngToMapLocator,
  mapLatLngToGame,
  mapPixelToMapLatLng,
} from '../data/locations'
import {
  COLLAPSIBLE_CATEGORY_GROUP_LABELS,
  COMPLETED_STORAGE_KEY,
  DEFAULT_COLLAPSED_CATEGORY_GROUPS,
  DEFAULT_NAVIGATION_WEBSOCKET_URL,
  FAVORITES_STORAGE_KEY,
  INITIAL_ZOOM,
  MARKER_FILTERS_STORAGE_KEY,
  MIN_ZOOM,
  NAVIGATION_CENTER_MAX_STEP_PX,
  NAVIGATION_CENTER_SMOOTHING,
  NAVIGATION_CENTER_TOLERANCE_PX,
  NAVIGATION_RECONNECT_DELAY,
  ROUTES_STORAGE_KEY,
} from '../constants/mapApp'
import { clone, publicAssetUrl } from '../utils/assets'
import {
  isWildcardNavigationHost,
  normalizeNavigationHost,
  normalizeNavigationPort,
  normalizeNavigationProtocol,
  parseNavigationWebSocketUrl,
} from '../utils/navigationEndpoint'
import { readStoredIds, readStoredMapView, readStoredMarkerFilters } from '../utils/storage'

// 地图应用的主组合函数。App.vue 只关心模板，具体行为在这里按功能区维护。
export function useMapApp() {
  const mapData = ref(clone(initialMapData))
  const categories = computed(() => mapData.value.categories)
  const visibleCategories = computed(() => categories.value.filter((category) => !category.isHidden))
  const locations = computed(() => mapData.value.locations)
  const routes = computed(() => mapData.value.routes)
  const categoryLookup = computed(() => Object.fromEntries(categories.value.map((category) => [category.id, category])))
  const locationLookup = computed(() => Object.fromEntries(locations.value.map((location) => [location.id, location])))
  const bounds = L.latLngBounds([-MAP_HEIGHT, 0], [0, MAP_WIDTH])
  const isLocalEditor = import.meta.env.DEV

  function getInitialCategories() {
    return new Set(visibleCategories.value.map((category) => category.id))
  }

  function normalizeDistrictLabel(value) {
    const label = String(value || '').trim()
    if (!label) return ''
    if (label === '全地图') return '全地图'
    if (/\uFFFD/.test(label) && label.endsWith('图')) return '全地图'
    if (/^[鍏ㄥ湴鍥?]+$/.test(label)) return '全地图'
    if (/^全.*图$/.test(label)) return '全地图'
    return label
  }

  // 页面和筛选状态：只保存 UI 当前选择，不直接操作 Leaflet。
  const mapElement = ref(null)
  const searchInput = ref(null)
  const query = ref('')
  const storedMarkerFilters = readStoredMarkerFilters()
  const initialCategoryIds = new Set(visibleCategories.value.map((category) => category.id))
  const initialTeleportCategoryIds = new Set(
    visibleCategories.value
      .filter((category) => category.group === '传送点')
      .map((category) => category.id),
  )
  const initialKeepTeleportEnabled = typeof storedMarkerFilters?.keepTeleportEnabled === 'boolean'
    ? storedMarkerFilters.keepTeleportEnabled
    : true
  const initialMergeAdjacentLocationsEnabled = typeof storedMarkerFilters?.mergeAdjacentLocationsEnabled === 'boolean'
    ? storedMarkerFilters.mergeAdjacentLocationsEnabled
    : true
  const initialActiveCategories = (() => {
    if (!Array.isArray(storedMarkerFilters?.activeCategories)) return initialCategoryIds
    const nextCategories = new Set(storedMarkerFilters.activeCategories.filter((id) => initialCategoryIds.has(id)))
    if (initialKeepTeleportEnabled) {
      initialTeleportCategoryIds.forEach((id) => nextCategories.add(id))
    }
    return nextCategories
  })()
  const initialCategoryGroupLabels = new Set(categories.value.map((category) => category.group).filter(Boolean))
  const initialActiveDistricts = new Set(
    Array.isArray(storedMarkerFilters?.activeDistricts)
      ? storedMarkerFilters.activeDistricts.map((district) => normalizeDistrictLabel(district)).filter(Boolean)
      : [],
  )
  const initialCollapsedCategoryGroups = {
    ...DEFAULT_COLLAPSED_CATEGORY_GROUPS,
    ...(storedMarkerFilters?.collapsedCategoryGroups || {}),
  }
  const activeCategories = ref(initialActiveCategories)
  const activeDistricts = ref(initialActiveDistricts)
  const keepTeleportEnabled = ref(initialKeepTeleportEnabled)
  const mergeAdjacentLocationsEnabled = ref(initialMergeAdjacentLocationsEnabled)
  const selectedLocation = ref(null)
  const completedIds = ref(readStoredIds(COMPLETED_STORAGE_KEY))
  const favoriteIds = ref(readStoredIds(FAVORITES_STORAGE_KEY))
  const showFavoritesOnly = ref(storedMarkerFilters?.showFavoritesOnly === true)
  const pendingLocationChanges = ref({
    categories: [],
    upsertLocations: [],
    deletedLocationIds: [],
  })
  const sessionCreatedLocationIds = new Set()
  const sessionCreatedCategoryIds = new Set()
  const showIncompleteOnly = ref(storedMarkerFilters?.showIncompleteOnly === true)
  const realtimeNavigationEnabled = ref(storedMarkerFilters?.realtimeNavigationEnabled === true)
  const centerNavigationEnabled = ref(typeof storedMarkerFilters?.centerNavigationEnabled === 'boolean'
    ? storedMarkerFilters.centerNavigationEnabled
    : true)
  const defaultNavigationEndpoint = parseNavigationWebSocketUrl(DEFAULT_NAVIGATION_WEBSOCKET_URL)
  const navigationProtocol = ref(normalizeNavigationProtocol(storedMarkerFilters?.navigationProtocol || defaultNavigationEndpoint.protocol))
  const navigationHost = ref(normalizeNavigationHost(storedMarkerFilters?.navigationHost || defaultNavigationEndpoint.host))
  const navigationPort = ref(normalizeNavigationPort(storedMarkerFilters?.navigationPort || defaultNavigationEndpoint.port))
  const coordinates = ref({ pixelX: 0, pixelY: 0, x: 0, y: 0 })
  const mapView = ref(null)
  const sidebarCollapsed = ref(false)
  const sidebarFooterOpen = ref(storedMarkerFilters?.sidebarFooterOpen !== false)
  const districtFilterOpen = ref(storedMarkerFilters?.districtFilterOpen === true)
  const clearCompletedConfirming = ref(false)
  const editorMode = ref(false)
  const editorFormOpen = ref(false)
  const editingLocationId = ref(null)
  const showPendingLocationChangesOnly = ref(false)
  const previewImage = ref('')
  const statusMessage = ref('')
  const routePanelOpen = ref(false)
  const activeRouteId = ref(null)
  const isAddingSegment = ref(false)
  const editingSegmentId = ref(null)
  const segmentPoints = ref([])
  const routeImportInput = ref(null)
  const completedImportInput = ref(null)
  const locationChangesImportInput = ref(null)
  const collapsedCategoryGroups = ref(initialCollapsedCategoryGroups)
  const navigationConnection = ref('disconnected')
  const navigationState = ref({
    position: null,
    gamePosition: null,
    angle: null,
    angleConfidence: 0,
    route: null,
  })
  const navigationConnectionStatus = computed(() =>
    realtimeNavigationEnabled.value ? navigationConnection.value : 'disabled',
  )
  const navigationConnectionLabel = computed(() => ({
    disabled: 'OFF',
    connected: 'CONNECTED',
    connecting: 'CONNECTING',
    disconnected: 'OFFLINE',
  })[navigationConnectionStatus.value])
  const navigationWildcardHostWarning = computed(() => isWildcardNavigationHost(navigationHost.value))
  const navigationWildcardHostWarningMessage = '那我问你，你为什么要把他改成0.0.0.0？你知道0.0.0.0代表什么吗？不知道的话可以问一下豆包:('
  const navigationWebSocketUrl = computed(() => `${normalizeNavigationProtocol(navigationProtocol.value)}://${normalizeNavigationHost(navigationHost.value)}:${normalizeNavigationPort(navigationPort.value)}`)
  const navigationRouteSendEnabled = computed(() =>
    realtimeNavigationEnabled.value && navigationConnection.value === 'connected',
  )

  const emptyLocationForm = () => ({
    locationId: '',
    name: '',
    types: [],
    district: '全地图',
    x: 0,
    y: 0,
    description: '',
    tagsText: '',
    customTypeId: '',
    customTypeText: '',
    customTypeGroup: '',
    customTypeNewGroup: '',
    pendingCustomTypes: [],
    images: [],
  })
  const locationForm = ref(emptyLocationForm())
  const editorCategories = computed(() => [...categories.value, ...locationForm.value.pendingCustomTypes])
  const editorCategoryGroups = computed(() => [...new Set(editorCategories.value.map((category) => category.group))])

  // Leaflet 运行时对象：生命周期内创建，卸载时统一清理。
  let map
  let markerLayer
  let arrowLayer
  let navigationMarker
  let navigationSocket
  let navigationReconnectTimer
  let navigationClientStopped = false
  let navigationDisplayAngle = null
  let navigationFollowFrame = 0
  let navigationFollowLatLng = null
  let navigationRenderFrame = 0
  let pendingNavigationState = null
  let navigationArrowElement = null
  let navigationArrowImage = null
  let navigationMarkerVisible = false
  let navigationAngleMissing = null
  let districtAutoFitReady = false
  let mapViewPersistenceReady = false
  let skipNextDistrictAutoFit = false
  const markerLookup = new Map()

  // 统计和筛选派生数据：模板只消费这些计算结果。
  const activeRoute = computed(() => routes.value.find((route) => route.id === activeRouteId.value) || null)
  const editingSegment = computed(() => activeRoute.value?.segments.find((segment) => segment.id === editingSegmentId.value) || null)
  const getVisibleTypes = (location) => location.types.filter((type) => !categoryLookup.value[type]?.isHidden)
  const visibleLocationIds = computed(() => new Set(
    locations.value
      .filter((location) => getVisibleTypes(location).length)
      .map((location) => location.id),
  ))
  const completedCount = computed(() => [...completedIds.value].filter((id) => visibleLocationIds.value.has(id)).length)
  const favoriteCount = computed(() => [...favoriteIds.value].filter((id) => visibleLocationIds.value.has(id)).length)
  const progress = computed(() => Math.round((completedCount.value / Math.max(visibleLocationIds.value.size, 1)) * 100))
  const pendingLocationChangeCount = computed(() => (
    pendingLocationChanges.value.categories.length
    + pendingLocationChanges.value.upsertLocations.length
    + pendingLocationChanges.value.deletedLocationIds.length
  ))
  const pendingLocationChangeIds = computed(() => new Set(
    pendingLocationChanges.value.upsertLocations.map((location) => location.id),
  ))
  const pendingLocationFilterCount = computed(() => pendingLocationChangeIds.value.size)
  const districtOptions = computed(() => {
    const districts = [...new Set(locations.value.map((location) => normalizeDistrictLabel(location.district)).filter(Boolean))]
    return districts.sort((left, right) => {
      if (left === '全地图') return -1
      if (right === '全地图') return 1
      return left.localeCompare(right, 'zh-CN')
    })
  })
  const hasActiveDistricts = computed(() => activeDistricts.value.size > 0)
  const bulkCompleteCategoryIds = computed(() => (
    [...activeCategories.value].filter((id) => !teleportCategoryIds.value.includes(id))
  ))
  const bulkCompleteLocations = computed(() => {
    if (!activeDistricts.value.size || !bulkCompleteCategoryIds.value.length) return []
    const selectedCategoryIds = new Set(bulkCompleteCategoryIds.value)
    return locations.value.filter((location) => (
      activeDistricts.value.has(normalizeDistrictLabel(location.district))
      && location.types.some((type) => selectedCategoryIds.has(type))
    ))
  })
  const bulkIncompleteCount = computed(() => (
    bulkCompleteLocations.value.filter((location) => !completedIds.value.has(location.id)).length
  ))

  const filteredLocations = computed(() => {
    const keyword = query.value.trim().toLowerCase()
    return locations.value.filter((location) => {
      const categoryVisible = location.types.some((type) => activeCategories.value.has(type))
      const districtLabel = normalizeDistrictLabel(location.district)
      const districtVisible = !activeDistricts.value.size
        || activeDistricts.value.has(districtLabel)
        || (districtLabel === '全地图' && isTeleportLocation(location))
      const incompleteVisible = !showIncompleteOnly.value || !completedIds.value.has(location.id)
      const favoriteVisible = !showFavoritesOnly.value || favoriteIds.value.has(location.id)
      const pendingVisible = !showPendingLocationChangesOnly.value || pendingLocationChangeIds.value.has(location.id)
      const typeLabels = location.types.map((type) => categoryLookup.value[type]?.label || type)
      const text = `${location.name} ${districtLabel} ${location.tags.join(' ')} ${typeLabels.join(' ')}`.toLowerCase()
      return categoryVisible && districtVisible && incompleteVisible && favoriteVisible && pendingVisible && (!keyword || text.includes(keyword))
    })
  })

  const visibleCounts = computed(() =>
    Object.fromEntries(visibleCategories.value.map((category) => [
      category.id,
      locations.value.filter((location) => location.types.includes(category.id)).length,
    ])),
  )

  const groupedCategories = computed(() => {
    const groups = []
    visibleCategories.value.forEach((category) => {
      let group = groups.find((item) => item.label === category.group)
      if (!group) {
        group = { label: category.group, categories: [] }
        groups.push(group)
      }
      group.categories.push(category)
    })
    return groups
  })
  const teleportCategoryIds = computed(() =>
    visibleCategories.value.filter((category) => category.group === '传送点').map((category) => category.id),
  )
  const collapsibleGroupLabels = new Set(COLLAPSIBLE_CATEGORY_GROUP_LABELS)

  // 筛选持久化：负责读取和写回 localStorage。
  function restoreMarkerFilters() {
    const storedFilters = readStoredMarkerFilters()
    const validCategoryIds = new Set(visibleCategories.value.map((category) => category.id))

    keepTeleportEnabled.value = typeof storedFilters?.keepTeleportEnabled === 'boolean'
      ? storedFilters.keepTeleportEnabled
      : true
    mergeAdjacentLocationsEnabled.value = typeof storedFilters?.mergeAdjacentLocationsEnabled === 'boolean'
      ? storedFilters.mergeAdjacentLocationsEnabled
      : true
    showIncompleteOnly.value = storedFilters?.showIncompleteOnly === true
    showFavoritesOnly.value = storedFilters?.showFavoritesOnly === true
    realtimeNavigationEnabled.value = storedFilters?.realtimeNavigationEnabled === true
    centerNavigationEnabled.value = typeof storedFilters?.centerNavigationEnabled === 'boolean'
      ? storedFilters.centerNavigationEnabled
      : true
    navigationHost.value = normalizeNavigationHost(storedFilters?.navigationHost || defaultNavigationEndpoint.host)
    navigationPort.value = normalizeNavigationPort(storedFilters?.navigationPort || defaultNavigationEndpoint.port)

    if (Array.isArray(storedFilters?.activeCategories)) {
      const nextCategories = new Set(storedFilters.activeCategories.filter((id) => validCategoryIds.has(id)))
      if (keepTeleportEnabled.value) {
        teleportCategoryIds.value.forEach((id) => nextCategories.add(id))
      }
      activeCategories.value = nextCategories
    } else {
      activeCategories.value = getInitialCategories()
    }

    skipNextDistrictAutoFit = Array.isArray(storedFilters?.activeDistricts)
    activeDistricts.value = new Set(
      Array.isArray(storedFilters?.activeDistricts)
        ? storedFilters.activeDistricts.map((district) => normalizeDistrictLabel(district)).filter(Boolean)
        : [],
    )

    const storedCollapsedGroups = storedFilters?.collapsedCategoryGroups
    collapsedCategoryGroups.value = {
      ...DEFAULT_COLLAPSED_CATEGORY_GROUPS,
      ...(storedCollapsedGroups && typeof storedCollapsedGroups === 'object'
        ? Object.fromEntries(
            [...collapsibleGroupLabels].map((label) => [label, Boolean(storedCollapsedGroups[label])]),
          )
        : {}),
    }

    districtFilterOpen.value = storedFilters?.districtFilterOpen === true
  }

  function persistMarkerFilters() {
    const storedFilters = readStoredMarkerFilters()
    localStorage.setItem(MARKER_FILTERS_STORAGE_KEY, JSON.stringify({
      ...(storedFilters && typeof storedFilters === 'object' ? storedFilters : {}),
      activeCategories: [...activeCategories.value],
      activeDistricts: [...activeDistricts.value],
      keepTeleportEnabled: keepTeleportEnabled.value,
      mergeAdjacentLocationsEnabled: mergeAdjacentLocationsEnabled.value,
      showIncompleteOnly: showIncompleteOnly.value,
      showFavoritesOnly: showFavoritesOnly.value,
      realtimeNavigationEnabled: realtimeNavigationEnabled.value,
      centerNavigationEnabled: centerNavigationEnabled.value,
      navigationProtocol: normalizeNavigationProtocol(navigationProtocol.value),
      navigationHost: normalizeNavigationHost(navigationHost.value),
      navigationPort: normalizeNavigationPort(navigationPort.value),
      sidebarFooterOpen: sidebarFooterOpen.value,
      districtFilterOpen: districtFilterOpen.value,
      collapsedCategoryGroups: Object.fromEntries(
        [...collapsibleGroupLabels].map((label) => [label, Boolean(collapsedCategoryGroups.value[label])]),
      ),
    }))
  }

  function persistMapView() {
    if (!map || !mapViewPersistenceReady) return
    if (navigationFollowFrame) return

    const center = map.getCenter()
    const storedFilters = readStoredMarkerFilters()

    localStorage.setItem(MARKER_FILTERS_STORAGE_KEY, JSON.stringify({
      ...(storedFilters && typeof storedFilters === 'object' ? storedFilters : {}),
      mapView: {
        lat: Number(center.lat.toFixed(6)),
        lng: Number(center.lng.toFixed(6)),
        zoom: map.getZoom(),
      },
    }))
  }

  function showStatus(message) {
    statusMessage.value = message
    window.setTimeout(() => {
      if (statusMessage.value === message) statusMessage.value = ''
    }, 2600)
  }

  function hasReplacementCharacter(value) {
    if (typeof value === 'string') return value.includes('\uFFFD')
    if (Array.isArray(value)) return value.some((item) => hasReplacementCharacter(item))
    if (value && typeof value === 'object') return Object.values(value).some((item) => hasReplacementCharacter(item))
    return false
  }

  function assertNoReplacementCharacters(value) {
    if (hasReplacementCharacter(value)) throw new Error('replacement character detected')
  }

  function readStoredRoutes() {
    try {
      const storedRoutes = JSON.parse(localStorage.getItem(ROUTES_STORAGE_KEY) || 'null')
      return Array.isArray(storedRoutes) ? storedRoutes : null
    } catch {
      return null
    }
  }

  function persistRoutesLocally() {
    localStorage.setItem(ROUTES_STORAGE_KEY, JSON.stringify(routes.value))
  }

  function downloadJson(payload, filename) {
    assertNoReplacementCharacters(payload)
    const blobUrl = URL.createObjectURL(new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = blobUrl
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0)
  }

  async function loadLatestMapData() {
    if (!isLocalEditor) return
    try {
      const response = await fetch('/api/map-data')
      if (!response.ok) return
      mapData.value = await response.json()
    } catch {
      // 静态部署环境没有本地接口，继续使用打包时内置的数据快照。
    }
  }

  function normalizeLocationCoordinates(location) {
    if (!location || typeof location !== 'object') return null
    let x = Number(location.x)
    let y = Number(location.y)
    if ((!Number.isFinite(x) || !Number.isFinite(y))
      && Number.isFinite(Number(location.lat))
      && Number.isFinite(Number(location.lng))) {
      ;({ x, y } = legacyWorldToGame(location))
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    const normalized = {
      ...location,
      x: Number(x.toFixed(3)),
      y: Number(y.toFixed(3)),
    }
    delete normalized.lat
    delete normalized.lng
    return normalized
  }

  function normalizeCategoryGroup(category) {
    return String(category?.group || category?.groupLabel || '自定义')
  }

  function minimalCategoryForExport(category, forceLabel = false) {
    const group = normalizeCategoryGroup(category)
    const exported = {
      id: category.id,
      group,
    }
    if (forceLabel && category.label) exported.label = category.label
    if (!initialCategoryGroupLabels.has(group)) exported.isNewGroup = true
    return exported
  }

  function collectCategoriesForChanges(changes) {
    const exportedCategories = new Map()
    changes.categories?.forEach((category) => {
      if (category?.id) exportedCategories.set(category.id, minimalCategoryForExport(category, true))
    })
    changes.upsertLocations?.forEach((location) => {
      if (!Array.isArray(location.types)) return
      location.types.forEach((type) => {
        if (exportedCategories.has(type)) return
        const category = categoryLookup.value[type]
        if (category) exportedCategories.set(type, minimalCategoryForExport(category, sessionCreatedCategoryIds.has(type)))
      })
    })
    return [...exportedCategories.values()]
  }

  function exportLocationChanges(changes) {
    const payload = {
      version: 1,
      type: 'location-changes',
    }
    const exportCategories = collectCategoriesForChanges(changes)
    if (exportCategories.length) payload.categories = exportCategories
    if (changes.upsertLocations?.length) payload.upsertLocations = clone(changes.upsertLocations)
    if (changes.deletedLocationIds?.length) payload.deletedLocationIds = [...changes.deletedLocationIds]
    downloadJson(payload, `MaaNTE-location-changes-${new Date().toISOString().slice(0, 10)}.json`)
    showStatus('点位修改 JSON 已导出')
  }

  function queueLocationChanges(changes) {
    const pending = pendingLocationChanges.value
    changes.categories?.forEach((category) => {
      const index = pending.categories.findIndex((item) => item.id === category.id)
      if (index >= 0) pending.categories.splice(index, 1, clone(category))
      else pending.categories.push(clone(category))
    })
    changes.upsertLocations?.forEach((location) => {
      const index = pending.upsertLocations.findIndex((item) => item.id === location.id)
      if (index >= 0) pending.upsertLocations.splice(index, 1, clone(location))
      else pending.upsertLocations.push(clone(location))
      pending.deletedLocationIds = pending.deletedLocationIds.filter((id) => id !== location.id)
    })
    changes.deletedLocationIds?.forEach((id) => {
      pending.upsertLocations = pending.upsertLocations.filter((location) => location.id !== id)
      if (!pending.deletedLocationIds.includes(id)) pending.deletedLocationIds.push(id)
    })
  }

  function discardCreatedLocationChanges(locationId) {
    const pending = pendingLocationChanges.value
    pending.upsertLocations = pending.upsertLocations.filter((location) => location.id !== locationId)
    pending.deletedLocationIds = pending.deletedLocationIds.filter((id) => id !== locationId)

    const usedCategoryIds = new Set(locations.value.flatMap((location) => location.types))
    const unusedCreatedCategoryIds = new Set(
      [...sessionCreatedCategoryIds].filter((id) => !usedCategoryIds.has(id)),
    )
    if (!unusedCreatedCategoryIds.size) return

    pending.categories = pending.categories.filter((category) => !unusedCreatedCategoryIds.has(category.id))
    mapData.value.categories = categories.value.filter((category) => !unusedCreatedCategoryIds.has(category.id))
    unusedCreatedCategoryIds.forEach((id) => sessionCreatedCategoryIds.delete(id))
  }

  function exportPendingLocationChanges() {
    if (!pendingLocationChangeCount.value) return
    exportLocationChanges(pendingLocationChanges.value)
  }

  async function persistMapData({ staticChanges = null } = {}) {
    persistRoutesLocally()
    try {
      if (staticChanges) assertNoReplacementCharacters(staticChanges)
      assertNoReplacementCharacters(mapData.value)
    } catch {
      showStatus('保存失败：文本包含乱码字符 U+FFFD')
      return
    }
    if (staticChanges) queueLocationChanges(staticChanges)
    if (!isLocalEditor) {
      if (staticChanges) exportLocationChanges(staticChanges)
      return
    }
    try {
      const response = await fetch('/api/map-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mapData.value),
      })
      if (!response.ok) throw new Error('保存失败')
      showStatus('本地数据已保存')
    } catch {
      showStatus('本地数据保存失败')
    }
  }

  // 地图标记渲染：封装图标、聚合图层和点位选择。
  function getPrimaryCategory(location) {
    const visibleTypes = getVisibleTypes(location)
    const activeType = visibleTypes.find((type) => activeCategories.value.has(type))
    return categoryLookup.value[activeType || visibleTypes[0]]
  }

  function categoryIconHtml(category) {
    const src = category?.iconUrl || (category?.icon?.startsWith('/') ? category.icon : null)
    return src ? `<img src="${publicAssetUrl(src)}" alt="" />` : category?.icon || '·'
  }

  function markerHtml(location) {
    const category = getPrimaryCategory(location)
    const completed = completedIds.value.has(location.id)
    const selected = selectedLocation.value?.id === location.id
    const extraCount = Math.max(getVisibleTypes(location).length - 1, 0)
    return `
      <div class="map-marker ${completed ? 'map-marker--completed' : ''} ${selected ? 'map-marker--selected' : ''}"
        style="--marker-color:${category?.color || '#8adfd6'}">
        <span>${categoryIconHtml(category)}</span>
        ${extraCount ? `<b>+${extraCount}</b>` : ''}
      </div>
    `
  }

  function createIcon(location) {
    return L.divIcon({
      className: 'marker-shell',
      html: markerHtml(location),
      iconSize: [36, 44],
      iconAnchor: [18, 42],
    })
  }

  function createMarkerLayer() {
    return mergeAdjacentLocationsEnabled.value
      ? L.markerClusterGroup({
          chunkedLoading: true,
          maxClusterRadius: 52,
          disableClusteringAtZoom: 0,
          showCoverageOnHover: false,
        })
      : L.layerGroup()
  }

  function rebuildMarkerLayer() {
    if (!map) return
    markerLayer?.clearLayers()
    markerLayer?.remove()
    markerLayer = createMarkerLayer().addTo(map)
    renderMarkers()
  }

  function selectLocation(location, fly = true) {
    selectedLocation.value = location
    renderMarkers()
    if (fly && map) {
      map.flyTo(gameToMapLatLng(location), Math.max(map.getZoom(), -2), { duration: 0.45 })
    }
  }

  function addRouteMarker(locationId) {
    if (!isAddingSegment.value) return
    const location = locationLookup.value[locationId]
    if (!location || segmentPoints.value.at(-1)?.locationId === locationId) return
    segmentPoints.value = [...segmentPoints.value, {
      locationId,
      x: location.x,
      y: location.y,
    }]
    renderRouteArrows()
  }

  function addRouteCoordinate(point) {
    if (!isAddingSegment.value) return
    const previous = segmentPoints.value.at(-1)
    if (previous && previous.x === point.x && previous.y === point.y) return
    segmentPoints.value = [...segmentPoints.value, {
      x: Number(point.x.toFixed(3)),
      y: Number(point.y.toFixed(3)),
    }]
    renderRouteArrows()
  }

  function renderMarkers() {
    if (!markerLayer) return
    markerLayer.clearLayers()
    markerLookup.clear()
    filteredLocations.value.forEach((location) => {
      const marker = L.marker(gameToMapLatLng(location), {
        icon: createIcon(location),
        title: location.name,
        riseOnHover: true,
      }).on('click', () => {
        if (isAddingSegment.value) addRouteMarker(location.id)
        else selectLocation(location, false)
      })
      markerLayer.addLayer(marker)
      markerLookup.set(location.id, marker)
    })
  }

  // 路线绘制：把路线点转换成 Leaflet 图层和方向箭头。
  function drawArrow(from, to, color, temporary = false) {
    const start = gameToMapLatLng(from)
    const end = gameToMapLatLng(to)
    L.polyline([start, end], {
      color,
      weight: 3,
      opacity: temporary ? 0.7 : 0.9,
      dashArray: temporary ? '7 6' : undefined,
    }).addTo(arrowLayer)
    const mid = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2]
    const angle = -Math.atan2(end[0] - start[0], end[1] - start[1]) * 180 / Math.PI
    L.marker(mid, {
      interactive: false,
      icon: L.divIcon({
        className: 'route-arrow',
        html: `<i style="transform:rotate(${angle}deg);border-left-color:${color}"></i>`,
        iconSize: [10, 10],
        iconAnchor: [5, 5],
      }),
    }).addTo(arrowLayer)
  }

  function normalizeRoutePoint(point) {
    if (typeof point === 'string') {
      const location = locationLookup.value[point]
      return location ? { locationId: point, x: location.x, y: location.y } : null
    }
    if (!point || typeof point !== 'object') return null
    const location = point.locationId ? locationLookup.value[point.locationId] : null
    let x = Number(location?.x ?? point.x)
    let y = Number(location?.y ?? point.y)
    if ((!Number.isFinite(x) || !Number.isFinite(y))
      && Number.isFinite(Number(point.lat))
      && Number.isFinite(Number(point.lng))) {
      ;({ x, y } = legacyWorldToGame(point))
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    return {
      ...(point.locationId ? { locationId: String(point.locationId) } : {}),
      x,
      y,
    }
  }

  function getSegmentPoints(segment) {
    const points = Array.isArray(segment?.points) ? segment.points : segment?.markerIds
    return Array.isArray(points) ? points.map(normalizeRoutePoint).filter(Boolean) : []
  }

  function getRoutePointLabel(point, index) {
    const normalized = normalizeRoutePoint(point)
    if (!normalized) return `#${index + 1}`
    const location = normalized.locationId ? locationLookup.value[normalized.locationId] : null
    if (location) return `${index + 1}. ${location.name}`
    return `${index + 1}. ${normalized.x.toFixed(2)}, ${normalized.y.toFixed(2)}`
  }

  function updateSegmentPoint(index, latlng) {
    const point = mapLatLngToGame(latlng)
    segmentPoints.value = segmentPoints.value.map((item, pointIndex) => (
      pointIndex === index
        ? { x: Number(point.x.toFixed(3)), y: Number(point.y.toFixed(3)) }
        : item
    ))
  }

  function createRoutePointPopup(index) {
    const container = document.createElement('div')
    container.className = 'route-point-popup'
    const title = document.createElement('b')
    title.textContent = getRoutePointLabel(segmentPoints.value[index], index)
    container.appendChild(title)

    const actions = document.createElement('div')
    const actionItems = [
      ['up', '上移', index === 0],
      ['down', '下移', index === segmentPoints.value.length - 1],
      ['delete', '删除', false],
    ]
    actionItems.forEach(([action, label, disabled]) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = label
      button.disabled = disabled
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (action === 'up') moveSegmentPoint(index, -1)
        if (action === 'down') moveSegmentPoint(index, 1)
        if (action === 'delete') removeSegmentPoint(index)
      })
      actions.appendChild(button)
    })
    container.appendChild(actions)
    return container
  }

  function drawEditableRoutePoint(point, index, color) {
    const marker = L.marker(gameToMapLatLng(point), {
      draggable: true,
      title: getRoutePointLabel(point, index),
      icon: L.divIcon({
        className: 'route-point-handle',
        html: `<i style="border-color:${color};background:${color}">${index + 1}</i>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      }),
    }).addTo(arrowLayer)

    marker.bindPopup(createRoutePointPopup(index), {
      className: 'route-point-popup-shell',
      closeButton: false,
      offset: [0, -10],
    })
    marker.on('dragstart', () => marker.closePopup())
    marker.on('dragend', (event) => {
      updateSegmentPoint(index, event.target.getLatLng())
      renderRouteArrows()
    })
  }

  function drawRoutePath(points, color, temporary = false) {
    points.forEach((point, index) => {
      if (temporary) {
        drawEditableRoutePoint(point, index, color)
      } else {
        L.circleMarker(gameToMapLatLng(point), {
          className: 'route-point',
          color,
          fillColor: color,
          fillOpacity: 0.9,
          opacity: 1,
          radius: point.locationId ? 4 : 5,
          weight: 2,
        }).addTo(arrowLayer)
      }
      if (index > 0) drawArrow(points[index - 1], point, color, temporary)
    })
  }

  function normalizeRoutes(importedRoutes) {
    return importedRoutes.filter((route) => route && typeof route === 'object').map((route, routeIndex) => ({
      id: String(route.id || `route-${Date.now()}-${routeIndex}`),
      name: String(route.name || `路线 ${routeIndex + 1}`),
      isHidden: route.isHidden === true,
      segments: Array.isArray(route.segments) ? route.segments.filter((segment) => segment && typeof segment === 'object').map((segment, segmentIndex) => ({
        id: String(segment.id || `segment-${Date.now()}-${routeIndex}-${segmentIndex}`),
        name: String(segment.name || `路段 ${segmentIndex + 1}`),
        isHidden: segment.isHidden === true,
        points: getSegmentPoints(segment),
      })) : [],
    }))
  }

  function exportRoutes() {
    const payload = {
      version: 1,
      routes: normalizeRoutes(routes.value),
    }
    downloadJson(payload, `MaaNTE-routes-${new Date().toISOString().slice(0, 10)}.json`)
    showStatus('路线 JSON 已导出')
  }

  function routePointToNavigationWaypoint(point) {
    const normalized = normalizeRoutePoint(point)
    if (!normalized) return null
    const locatorPoint = gameToMapPixel(normalized)
    return {
      pixelX: Number(locatorPoint.pixelX.toFixed(3)),
      pixelY: Number(locatorPoint.pixelY.toFixed(3)),
    }
  }

  function buildNavigationWaypoints(points) {
    const waypoints = points.map(routePointToNavigationWaypoint).filter(Boolean)
    return waypoints.filter((point, index) => {
      const previous = waypoints[index - 1]
      return !previous || previous.pixelX !== point.pixelX || previous.pixelY !== point.pixelY
    })
  }

  function sendNavigationMessage(payload) {
    if (!realtimeNavigationEnabled.value) {
      showStatus('请先开启实时导航连接')
      return false
    }
    if (!navigationSocket || navigationSocket.readyState !== WebSocket.OPEN) {
      showStatus('导航 WebSocket 未连接')
      return false
    }
    navigationSocket.send(JSON.stringify(payload))
    return true
  }

  function sendNavigationWaypoints(points, label = '路径', start = true) {
    const waypoints = buildNavigationWaypoints(points)
    if (!waypoints.length) {
      showStatus(`${label}没有可发送的路径点`)
      return false
    }
    const ok = sendNavigationMessage({
      type: 'navi-route-set',
      sourceWidth: MAP_LOCATOR_SOURCE_WIDTH,
      sourceHeight: MAP_LOCATOR_SOURCE_HEIGHT,
      start,
      waypoints,
    })
    if (ok) showStatus(`已发送 ${waypoints.length} 个路径点到导航服务`)
    return ok
  }

  function sendRouteToNavigation(route = activeRoute.value, start = true) {
    if (!route) return false
    const points = route.segments
      .filter((segment) => !segment.isHidden)
      .flatMap((segment) => getSegmentPoints(segment))
    return sendNavigationWaypoints(points, route.name || '路线', start)
  }

  function sendSegmentToNavigation(segment, start = true) {
    if (!segment) return false
    return sendNavigationWaypoints(getSegmentPoints(segment), segment.name || '路段', start)
  }

  function startNavigationRoute() {
    if (sendNavigationMessage({ type: 'navi-route-start' })) showStatus('已发送开始寻路')
  }

  function stopNavigationRoute() {
    if (sendNavigationMessage({ type: 'navi-route-stop' })) showStatus('已发送暂停寻路')
  }

  function clearNavigationRoute() {
    if (sendNavigationMessage({ type: 'navi-route-clear' })) showStatus('已清空服务端路径')
  }

  async function importRoutes(event) {
    const [file] = event.target.files || []
    event.target.value = ''
    if (!file) return
    try {
      const payload = JSON.parse(await file.text())
      const importedRoutes = Array.isArray(payload) ? payload : payload.routes
      if (!Array.isArray(importedRoutes)) throw new Error('invalid routes')
      mapData.value.routes = normalizeRoutes(importedRoutes)
      activeRouteId.value = routes.value[0]?.id || null
      cancelSegment()
      await persistMapData()
      renderRouteArrows()
      showStatus(`已导入 ${routes.value.length} 条路线`)
    } catch {
      showStatus('路线 JSON 格式无效')
    }
  }

  function renderRouteArrows() {
    if (!arrowLayer) return
    arrowLayer.clearLayers()
    if (isAddingSegment.value) {
      drawRoutePath(segmentPoints.value, '#ffd27d', true)
      return
    }
    const colors = ['#ffd27d', '#8adfd6', '#e8a6ff', '#ff8a70', '#87a9ff']
    routes.value
      .filter((route) => !route.isHidden)
      .forEach((route, routeIndex) => {
        route.segments
          .filter((segment) => !segment.isHidden)
          .forEach((segment, segmentIndex) => {
            drawRoutePath(getSegmentPoints(segment), colors[(routeIndex + segmentIndex) % colors.length])
          })
      })
  }

  // 实时导航：维护 WebSocket 连接、箭头角度和地图跟随。
  function createNavigationIcon() {
    return L.divIcon({
      className: 'navigation-arrow-shell',
      html: `<div class="navigation-arrow"><img src="${publicAssetUrl('/images/map_webview_pointer.png')}" alt=""></div>`,
      iconSize: [30, 35],
      iconAnchor: [15, 18],
    })
  }

  function updateNavigationMarkerAngle(angle) {
    if (!Number.isFinite(angle)) return
    if (navigationDisplayAngle === null) {
      navigationDisplayAngle = angle
    } else {
      const delta = ((angle - navigationDisplayAngle + 540) % 360) - 180
      navigationDisplayAngle += delta
    }
    if (navigationArrowImage) {
      navigationArrowImage.style.transform = `translateZ(0) rotate(${navigationDisplayAngle}deg)`
    }
  }

  function cacheNavigationMarkerElements() {
    const markerElement = navigationMarker?.getElement()
    if (!markerElement) {
      navigationArrowElement = null
      navigationArrowImage = null
      return
    }
    if (!navigationArrowElement || !markerElement.contains(navigationArrowElement)) {
      navigationArrowElement = markerElement.querySelector('.navigation-arrow')
      navigationArrowImage = markerElement.querySelector('.navigation-arrow img')
    }
  }

  function stopNavigationFollow(persist = true) {
    if (navigationFollowFrame) {
      window.cancelAnimationFrame(navigationFollowFrame)
      navigationFollowFrame = 0
    }
    navigationFollowLatLng = null
    if (persist) persistMapView()
  }

  function stepNavigationFollow() {
    if (!centerNavigationEnabled.value || !map || !navigationFollowLatLng) {
      stopNavigationFollow(false)
      return
    }

    const size = map.getSize()
    const centerPoint = L.point(size.x / 2, size.y / 2)
    const targetPoint = map.latLngToContainerPoint(navigationFollowLatLng)
    const delta = targetPoint.subtract(centerPoint)
    const distance = Math.sqrt(delta.x ** 2 + delta.y ** 2)

    if (distance <= NAVIGATION_CENTER_TOLERANCE_PX) {
      stopNavigationFollow()
      return
    }

    const stepDistance = Math.min(
      (distance - NAVIGATION_CENTER_TOLERANCE_PX) * NAVIGATION_CENTER_SMOOTHING,
      NAVIGATION_CENTER_MAX_STEP_PX,
    )
    map.panBy(delta.multiplyBy(stepDistance / distance), { animate: false })
    navigationFollowFrame = window.requestAnimationFrame(stepNavigationFollow)
  }

  function centerNavigationMarker(latlng) {
    if (!centerNavigationEnabled.value || !map || !latlng) return
    navigationFollowLatLng = latlng
    if (!navigationFollowFrame) {
      navigationFollowFrame = window.requestAnimationFrame(stepNavigationFollow)
    }
  }

  function renderNavigationArrow(state = navigationState.value) {
    if (!map || !state.position) {
      if (navigationMarkerVisible) {
        navigationMarker?.setOpacity(0)
        navigationMarkerVisible = false
      }
      stopNavigationFollow()
      return
    }
    const latlng = mapPixelToMapLatLng(state.position)
    if (!navigationMarker) {
      navigationMarker = L.marker(latlng, {
        icon: createNavigationIcon(),
        interactive: false,
        keyboard: false,
        zIndexOffset: 1000000,
      }).addTo(map)
      navigationArrowElement = null
      navigationArrowImage = null
      navigationAngleMissing = null
    }
    cacheNavigationMarkerElements()
    navigationMarker.setLatLng(latlng)
    if (!navigationMarkerVisible) {
      navigationMarker.setOpacity(1)
      navigationMarkerVisible = true
    }
    centerNavigationMarker(latlng)
    const angleMissing = state.angle === null
    if (navigationArrowElement && navigationAngleMissing !== angleMissing) {
      navigationArrowElement.classList.toggle('navigation-arrow--angle-missing', angleMissing)
      navigationAngleMissing = angleMissing
    }
    updateNavigationMarkerAngle(state.angle)
  }

  function flushNavigationRender() {
    navigationRenderFrame = 0
    if (!pendingNavigationState) return
    navigationState.value = pendingNavigationState
    pendingNavigationState = null
    renderNavigationArrow()
  }

  function scheduleNavigationRender(state) {
    pendingNavigationState = state
    if (!navigationRenderFrame) {
      navigationRenderFrame = window.requestAnimationFrame(flushNavigationRender)
    }
  }

  function getCurrentNavigationState() {
    return pendingNavigationState || navigationState.value
  }

  function clearNavigationState() {
    if (navigationRenderFrame) {
      window.cancelAnimationFrame(navigationRenderFrame)
      navigationRenderFrame = 0
    }
    pendingNavigationState = null
    navigationAngleMissing = null
    navigationState.value = {
      position: null,
      gamePosition: null,
      angle: null,
      angleConfidence: 0,
      route: null,
    }
    navigationDisplayAngle = null
    renderNavigationArrow()
  }

  function handleNavigationMessage(event) {
    try {
      const payload = JSON.parse(event.data)
      if (payload.type === 'navi-route-ack') {
        if (payload.route) {
          const nextState = {
            ...getCurrentNavigationState(),
            route: payload.route,
          }
          if (pendingNavigationState) pendingNavigationState = nextState
          else navigationState.value = nextState
        }
        if (payload.message) showStatus(payload.message)
        return
      }
      if (payload.type === 'navi-error') {
        showStatus(payload.message || '导航服务返回错误')
        return
      }
      if (payload.type !== 'navi-state' || payload.version !== 1) return
      const positionPayload = payload.position && typeof payload.position === 'object'
        ? payload.position
        : payload
      const angle = Number(payload.angle)
      const gamePositionPayload = payload.gamePosition || positionPayload.gamePosition || {}
      const readCoordinate = (...values) => {
        for (const value of values) {
          if (value === null || value === undefined || value === '') continue
          const number = Number(value)
          if (Number.isFinite(number)) return number
        }
        return null
      }
      const gameX = readCoordinate(positionPayload.x, positionPayload.gameX, gamePositionPayload.x, payload.x)
      const gameY = readCoordinate(positionPayload.y, positionPayload.gameY, gamePositionPayload.y, payload.y)
      const gameZ = readCoordinate(positionPayload.z, positionPayload.gameZ, gamePositionPayload.z, payload.z)
      const receivedPixelX = readCoordinate(positionPayload.pixelX, payload.pixelX)
      const receivedPixelY = readCoordinate(positionPayload.pixelY, payload.pixelY)
      const receivedSourceWidth = readCoordinate(positionPayload.sourceWidth, payload.sourceWidth)
      const receivedSourceHeight = readCoordinate(positionPayload.sourceHeight, payload.sourceHeight)
      const sourceWidth = receivedSourceWidth > 0 ? receivedSourceWidth : MAP_LOCATOR_SOURCE_WIDTH
      const sourceHeight = receivedSourceHeight > 0 ? receivedSourceHeight : MAP_LOCATOR_SOURCE_HEIGHT
      const derivedPixel = (receivedPixelX === null || receivedPixelY === null)
        && gameX !== null
        && gameY !== null
        ? gameToMapPixel({ x: gameX, y: gameY })
        : null
      const pixelX = receivedPixelX ?? derivedPixel?.pixelX ?? null
      const pixelY = receivedPixelY ?? derivedPixel?.pixelY ?? null
      const currentState = getCurrentNavigationState()
      scheduleNavigationRender({
        position: pixelX !== null && pixelY !== null
          ? {
              pixelX,
              pixelY,
              sourceWidth: derivedPixel ? MAP_LOCATOR_SOURCE_WIDTH : sourceWidth,
              sourceHeight: derivedPixel ? MAP_LOCATOR_SOURCE_HEIGHT : sourceHeight,
            }
          : null,
        gamePosition: gameX !== null && gameY !== null
          ? { x: gameX, y: gameY, ...(gameZ !== null ? { z: gameZ } : {}) }
          : gameZ !== null ? { z: gameZ } : null,
        angle: payload.angle !== null && Number.isFinite(angle) ? angle : null,
        angleConfidence: Number(payload.angleConfidence) || 0,
        route: payload.route || currentState.route || null,
      })
    } catch {
      // 单条导航消息格式错误时忽略，避免中断后续本地数据流。
    }
  }

  function scheduleNavigationReconnect() {
    if (navigationClientStopped || !realtimeNavigationEnabled.value || navigationReconnectTimer) return
    navigationReconnectTimer = window.setTimeout(() => {
      navigationReconnectTimer = null
      connectNavigationSocket()
    }, NAVIGATION_RECONNECT_DELAY)
  }

  function disconnectNavigationSocket() {
    if (navigationReconnectTimer) {
      window.clearTimeout(navigationReconnectTimer)
      navigationReconnectTimer = null
    }
    const socket = navigationSocket
    navigationSocket = null
    if (socket) {
      socket.removeEventListener('message', handleNavigationMessage)
      socket.close()
    }
    navigationConnection.value = 'disconnected'
    clearNavigationState()
  }

  function connectNavigationSocket() {
    if (navigationClientStopped || !realtimeNavigationEnabled.value || navigationSocket) return
    if (navigationWildcardHostWarning.value) {
      navigationConnection.value = 'disconnected'
      showStatus(navigationWildcardHostWarningMessage)
      return
    }
    navigationConnection.value = 'connecting'
    const socket = new WebSocket(navigationWebSocketUrl.value)
    navigationSocket = socket
    socket.addEventListener('open', () => {
      if (navigationSocket === socket) navigationConnection.value = 'connected'
    })
    socket.addEventListener('message', handleNavigationMessage)
    socket.addEventListener('close', () => {
      if (navigationSocket !== socket) return
      navigationSocket = null
      navigationConnection.value = 'disconnected'
      scheduleNavigationReconnect()
    })
    socket.addEventListener('error', () => socket.close())
  }

  function applyNavigationEndpoint() {
    navigationProtocol.value = normalizeNavigationProtocol(navigationProtocol.value)
    navigationHost.value = normalizeNavigationHost(navigationHost.value)
    navigationPort.value = normalizeNavigationPort(navigationPort.value)
    if (navigationWildcardHostWarning.value) showStatus(navigationWildcardHostWarningMessage)
    persistMarkerFilters()
    if (realtimeNavigationEnabled.value) {
      disconnectNavigationSocket()
      connectNavigationSocket()
    }
  }

  function focusSegment(segment) {
    if (!map) return
    const points = getSegmentPoints(segment).map(gameToMapLatLng)
    if (points.length) map.flyToBounds(L.latLngBounds(points), { padding: [80, 80], duration: 0.45 })
  }

  function fitLocationsBounds(targetLocations) {
    if (!map || !targetLocations.length) return
    if (targetLocations.length === 1) {
      map.flyTo(gameToMapLatLng(targetLocations[0]), -1, { duration: 0.45 })
      return
    }
    const points = targetLocations.map(gameToMapLatLng)
    map.flyToBounds(L.latLngBounds(points).pad(0.1), { duration: 0.45 })
  }

  function isTeleportLocation(location) {
    return location.types.some((type) => teleportCategoryIds.value.includes(type))
  }

  // 侧栏筛选交互：分类、区域和批量完成。
  function toggleCategory(categoryId) {
    if (keepTeleportEnabled.value && teleportCategoryIds.value.includes(categoryId)) return
    const next = new Set(activeCategories.value)
    next.has(categoryId) ? next.delete(categoryId) : next.add(categoryId)
    activeCategories.value = next
  }

  function isGroupFullySelected(group) {
    return group.categories.every((category) => activeCategories.value.has(category.id))
  }

  function isGroupPartiallySelected(group) {
    const selectedCount = group.categories.filter((category) => activeCategories.value.has(category.id)).length
    return selectedCount > 0 && selectedCount < group.categories.length
  }

  function toggleCategoryGroupSelection(group) {
    const categoryIds = group.categories.map((category) => category.id)
    if (group.label === '传送点' && keepTeleportEnabled.value && isGroupFullySelected(group)) return

    const next = new Set(activeCategories.value)
    if (isGroupFullySelected(group)) {
      categoryIds.forEach((categoryId) => {
        if (!(keepTeleportEnabled.value && teleportCategoryIds.value.includes(categoryId))) {
          next.delete(categoryId)
        }
      })
    } else {
      categoryIds.forEach((categoryId) => next.add(categoryId))
    }
    activeCategories.value = next
  }

  function toggleDistrict(district) {
    const next = new Set(activeDistricts.value)
    next.has(district) ? next.delete(district) : next.add(district)
    activeDistricts.value = next
  }

  function clearDistricts() {
    activeDistricts.value = new Set()
  }

  function toggleCategoryGroup(groupLabel) {
    if (!collapsibleGroupLabels.has(groupLabel)) return
    collapsedCategoryGroups.value = {
      ...collapsedCategoryGroups.value,
      [groupLabel]: !collapsedCategoryGroups.value[groupLabel],
    }
  }

  function isCategoryGroupCollapsed(groupLabel) {
    return Boolean(collapsedCategoryGroups.value[groupLabel])
  }

  function selectAllCategories() {
    activeCategories.value = new Set(visibleCategories.value.map((category) => category.id))
  }

  function clearCategories() {
    activeCategories.value = new Set(keepTeleportEnabled.value ? teleportCategoryIds.value : [])
  }

  function toggleTeleportProtection() {
    keepTeleportEnabled.value = !keepTeleportEnabled.value
    if (!keepTeleportEnabled.value) return
    activeCategories.value = new Set([...activeCategories.value, ...teleportCategoryIds.value])
  }

  function toggleCompleted(locationId) {
    const next = new Set(completedIds.value)
    next.has(locationId) ? next.delete(locationId) : next.add(locationId)
    completedIds.value = next
    localStorage.setItem(COMPLETED_STORAGE_KEY, JSON.stringify([...next]))
  }

  function completeDistrictCategory() {
    if (!bulkIncompleteCount.value) return
    const newlyCompletedCount = bulkIncompleteCount.value
    const districtCopy = activeDistricts.value.size === 1
      ? `“${[...activeDistricts.value][0]}”区域内`
      : `${activeDistricts.value.size} 个已选区域内`
    const categoryCopy = bulkCompleteCategoryIds.value.length === 1
      ? `“${categoryLookup.value[bulkCompleteCategoryIds.value[0]]?.label || bulkCompleteCategoryIds.value[0]}”标签`
      : `${bulkCompleteCategoryIds.value.length} 个已选标签`
    if (!window.confirm(`将${districtCopy}命中${categoryCopy}的 ${newlyCompletedCount} 个点位标记为已完成？`)) return

    const next = new Set(completedIds.value)
    bulkCompleteLocations.value.forEach((location) => next.add(location.id))
    completedIds.value = next
    localStorage.setItem(COMPLETED_STORAGE_KEY, JSON.stringify([...next]))
    showStatus(`已完成 ${newlyCompletedCount} 个点位`)
  }

  function removeLocationReferencesFromRoutes(locationIds) {
    const deletedIds = new Set(locationIds)
    mapData.value.routes.forEach((route) => {
      route.segments.forEach((segment) => {
        segment.points = getSegmentPoints(segment).map((point) => (
          point.locationId && deletedIds.has(point.locationId)
            ? { x: point.x, y: point.y }
            : point
        ))
        delete segment.markerIds
      })
    })
  }

  function normalizeLocationChanges(payload) {
    if (!payload || payload.type !== 'location-changes') throw new Error('invalid location changes')
    assertNoReplacementCharacters(payload)
    const categories = Array.isArray(payload.categories)
      ? payload.categories
          .filter((category) => category && typeof category === 'object' && typeof category.id === 'string')
          .map((category) => ({
            ...category,
            group: normalizeCategoryGroup(category),
          }))
      : []
    const upsertLocations = Array.isArray(payload.upsertLocations)
      ? payload.upsertLocations
          .filter((location) => location && typeof location === 'object' && typeof location.id === 'string')
          .map(normalizeLocationCoordinates)
          .filter(Boolean)
      : []
    const deletedLocationIds = Array.isArray(payload.deletedLocationIds)
      ? payload.deletedLocationIds.filter((id) => typeof id === 'string' && id)
      : []
    return { categories, upsertLocations, deletedLocationIds }
  }

  async function importLocationChanges(event) {
    const [file] = event.target.files || []
    event.target.value = ''
    if (!file) return
    try {
      const changes = normalizeLocationChanges(JSON.parse((await file.text()).replace(/^\uFEFF/, '')))
      changes.categories.forEach((category) => {
        const index = categories.value.findIndex((item) => item.id === category.id)
        const { id, group, label, icon, iconUrl, color, isDefault, isHidden } = category
        if (index >= 0) {
          const current = categories.value[index]
          mapData.value.categories.splice(index, 1, {
            ...current,
            group,
            ...(label ? { label } : {}),
          })
        } else {
          mapData.value.categories.push({
            id,
            group,
            label: label || id,
            icon: icon || '·',
            ...(iconUrl ? { iconUrl } : {}),
            color: color || '#87a9ff',
            isDefault: Boolean(isDefault),
            ...(typeof isHidden === 'boolean' ? { isHidden } : {}),
          })
        }
      })
      changes.upsertLocations.forEach((location) => {
        const index = locations.value.findIndex((item) => item.id === location.id)
        if (index >= 0) mapData.value.locations.splice(index, 1, location)
        else mapData.value.locations.push(location)
      })
      if (changes.deletedLocationIds.length) {
        const deletedIds = new Set(changes.deletedLocationIds)
        mapData.value.locations = locations.value.filter((location) => !deletedIds.has(location.id))
        removeLocationReferencesFromRoutes(deletedIds)
        if (selectedLocation.value && deletedIds.has(selectedLocation.value.id)) selectedLocation.value = null
      }
      await persistMapData()
      renderMarkers()
      renderRouteArrows()
      showStatus(`已导入 ${changes.upsertLocations.length} 条点位修改，删除 ${changes.deletedLocationIds.length} 个点位`)
    } catch (error) {
      showStatus(error.message === 'replacement character detected'
        ? '导入失败：JSON 包含乱码字符 U+FFFD'
        : '点位修改 JSON 格式无效')
    }
  }

  function exportCompleted() {
    downloadJson({
      version: 1,
      completedIds: [...completedIds.value],
    }, `MaaNTE-completed-${new Date().toISOString().slice(0, 10)}.json`)
    showStatus('完成记录 JSON 已导出')
  }

  async function importCompleted(event) {
    const [file] = event.target.files || []
    event.target.value = ''
    if (!file) return
    try {
      const payload = JSON.parse(await file.text())
      const importedIds = Array.isArray(payload) ? payload : payload.completedIds
      if (!Array.isArray(importedIds)) throw new Error('invalid completed ids')
      const next = new Set(importedIds.filter((id) => typeof id === 'string' && id))
      completedIds.value = next
      localStorage.setItem(COMPLETED_STORAGE_KEY, JSON.stringify([...next]))
      clearCompletedConfirming.value = false
      showStatus(`已导入 ${next.size} 条完成记录`)
    } catch {
      showStatus('完成记录 JSON 格式无效')
    }
  }

  function toggleFavorite(locationId) {
  const next = new Set(favoriteIds.value)
  next.has(locationId) ? next.delete(locationId) : next.add(locationId)
  favoriteIds.value = next
  localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify([...next]))
  }

  function beginClearCompleted() {
    if (!completedIds.value.size) return
    clearCompletedConfirming.value = true
  }

  function cancelClearCompleted() {
    clearCompletedConfirming.value = false
  }

  function clearCompleted() {
    completedIds.value = new Set()
    localStorage.setItem(COMPLETED_STORAGE_KEY, JSON.stringify([]))
    clearCompletedConfirming.value = false
    showStatus('已清空完成记录')
  }

  function resetView() {
    map?.setView(bounds.getCenter(), INITIAL_ZOOM)
  }

  function updateMapView() {
    if (!map) return
    const center = map.getCenter()
    mapView.value = {
      center: { lat: center.lat, lng: center.lng },
      zoom: map.getZoom(),
    }
  }

  function restoreMapView() {
    if (!map) return false

    const storedMapView = readStoredMapView()
    if (!storedMapView) return false

    const center = L.latLng(storedMapView.lat, storedMapView.lng)
    if (!bounds.pad(0.18).contains(center)) return false

    const zoom = Math.min(Math.max(storedMapView.zoom, map.getMinZoom()), map.getMaxZoom())
    map.setView(center, zoom, { animate: false })
    return true
  }

  function copyCoordinates() {
    if (!selectedLocation.value) return
    navigator.clipboard?.writeText(`${selectedLocation.value.x.toFixed(3)}, ${selectedLocation.value.y.toFixed(3)}`)
    showStatus('坐标已复制')
  }

  // 点位编辑器：新增、编辑、删除和图片上传。
  function openCreateLocation(point) {
    editingLocationId.value = null
    locationForm.value = {
      ...emptyLocationForm(),
      ...point,
      district: districtOptions.value.includes(point?.district) ? point.district : '全地图',
      types: visibleCategories.value.length ? [visibleCategories.value[0].id] : [],
    }
    editorFormOpen.value = true
  }

  function openEditLocation(location) {
    editingLocationId.value = location.id
    locationForm.value = {
      ...emptyLocationForm(),
      ...clone(location),
      locationId: location.id,
      district: districtOptions.value.includes(normalizeDistrictLabel(location.district))
        ? normalizeDistrictLabel(location.district)
        : '全地图',
      tagsText: location.tags.join(', '),
      images: [...location.images],
    }
    editorFormOpen.value = true
  }

  function addCustomType() {
    const idPrefix = locationForm.value.customTypeId.trim()
    const label = locationForm.value.customTypeText.trim()
    const group = locationForm.value.customTypeNewGroup.trim() || locationForm.value.customTypeGroup
    if (!idPrefix || !label || !group) return
    let id = idPrefix
    let suffix = 2
    while (editorCategories.value.some((category) => category.id === id)) {
      id = `${idPrefix}-${suffix}`
      suffix += 1
    }
    const category = {
      id,
      group,
      label,
      icon: '·',
      color: '#87a9ff',
      isDefault: false,
    }
    locationForm.value.pendingCustomTypes.push(category)
    locationForm.value.types.push(category.id)
    locationForm.value.customTypeId = ''
    locationForm.value.customTypeText = ''
    locationForm.value.customTypeGroup = group
    locationForm.value.customTypeNewGroup = ''
  }

  async function saveLocation() {
    const form = locationForm.value
    if (!form.name.trim() || !form.types.length) {
      showStatus('请填写名称并选择至少一个类型')
      return
    }
    const isNewLocation = !editingLocationId.value
    const locationId = editingLocationId.value || form.locationId.trim() || `local-${Date.now()}`
    if (isNewLocation && locations.value.some((location) => location.id === locationId)) {
      showStatus('点位 ID 已存在')
      return
    }
    const addedCategories = clone(form.pendingCustomTypes)
    mapData.value.categories.push(...addedCategories)
    addedCategories.forEach((category) => sessionCreatedCategoryIds.add(category.id))
    const saved = {
      id: locationId,
      name: form.name.trim(),
      types: [...form.types],
      district: districtOptions.value.includes(form.district) ? form.district : '全地图',
      x: Number(form.x),
      y: Number(form.y),
      description: form.description.trim(),
      tags: form.tagsText.split(',').map((tag) => tag.trim()).filter(Boolean),
      images: [...form.images],
    }
    try {
      assertNoReplacementCharacters({ categories: addedCategories, location: saved })
    } catch {
      showStatus('保存失败：文本包含乱码字符 U+FFFD')
      mapData.value.categories = categories.value.filter((category) => !addedCategories.some((item) => item.id === category.id))
      return
    }
    const index = locations.value.findIndex((location) => location.id === saved.id)
    if (index >= 0) mapData.value.locations.splice(index, 1, saved)
    else mapData.value.locations.push(saved)
    if (isNewLocation) sessionCreatedLocationIds.add(saved.id)
    editorFormOpen.value = false
    selectedLocation.value = saved
    await persistMapData({
      staticChanges: {
        categories: addedCategories,
        upsertLocations: [saved],
      },
    })
    renderMarkers()
  }

  async function deleteLocation(location) {
    if (!window.confirm(`删除“${location.name}”？`)) return
    const wasCreatedThisSession = sessionCreatedLocationIds.has(location.id)
    mapData.value.locations = locations.value.filter((item) => item.id !== location.id)
    removeLocationReferencesFromRoutes([location.id])
    if (wasCreatedThisSession) {
      sessionCreatedLocationIds.delete(location.id)
      discardCreatedLocationChanges(location.id)
    }
    selectedLocation.value = null
    await persistMapData({
      staticChanges: wasCreatedThisSession ? null : { deletedLocationIds: [location.id] },
    })
    renderMarkers()
    renderRouteArrows()
    if (wasCreatedThisSession) showStatus('已删除新建点位，未保留修改记录')
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  async function uploadImages(event) {
    const files = [...event.target.files]
    for (const file of files) {
      try {
        const dataUrl = await readFileAsDataUrl(file)
        const response = await fetch('/api/upload-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataUrl, name: file.name }),
        })
        const data = await response.json()
        if (!data.ok) throw new Error(data.error)
        locationForm.value.images.push(data.path)
      } catch {
        showStatus('图片上传失败，请使用本地开发服务器')
      }
    }
    event.target.value = ''
  }

  // 路线编辑器：路线和路段的增删改以及导入导出。
  async function createRoute() {
    const name = window.prompt('路线名称')
    if (!name?.trim()) return
    const route = { id: `route-${Date.now()}`, name: name.trim(), segments: [] }
    mapData.value.routes.push(route)
    activeRouteId.value = route.id
    await persistMapData()
  }

  async function deleteRoute(route) {
    if (!window.confirm(`删除路线“${route.name}”？`)) return
    mapData.value.routes = routes.value.filter((item) => item.id !== route.id)
    activeRouteId.value = null
    await persistMapData()
    renderRouteArrows()
  }

  function startSegment() {
    if (!activeRoute.value) return
    isAddingSegment.value = true
    editingSegmentId.value = null
    segmentPoints.value = []
    selectedLocation.value = null
  }

  function editSegment(segment) {
    if (!activeRoute.value || !segment) return
    isAddingSegment.value = true
    editingSegmentId.value = segment.id
    segmentPoints.value = getSegmentPoints(segment)
    selectedLocation.value = null
    renderRouteArrows()
  }

  function cancelSegment() {
    isAddingSegment.value = false
    editingSegmentId.value = null
    segmentPoints.value = []
    renderRouteArrows()
  }

  function removeSegmentPoint(index) {
    segmentPoints.value = segmentPoints.value.filter((_, pointIndex) => pointIndex !== index)
    renderRouteArrows()
  }

  function moveSegmentPoint(index, offset) {
    const targetIndex = index + offset
    if (targetIndex < 0 || targetIndex >= segmentPoints.value.length) return
    const nextPoints = [...segmentPoints.value]
    ;[nextPoints[index], nextPoints[targetIndex]] = [nextPoints[targetIndex], nextPoints[index]]
    segmentPoints.value = nextPoints
    renderRouteArrows()
  }

  async function finishSegment() {
    if (!activeRoute.value || segmentPoints.value.length < 2) return
    if (editingSegment.value) {
      editingSegment.value.points = [...segmentPoints.value]
      isAddingSegment.value = false
      editingSegmentId.value = null
      segmentPoints.value = []
      await persistMapData()
      renderRouteArrows()
      return
    }
    const name = window.prompt('路段名称')
    if (!name?.trim()) return
    activeRoute.value.segments.push({
      id: `segment-${Date.now()}`,
      name: name.trim(),
      points: [...segmentPoints.value],
    })
    isAddingSegment.value = false
    editingSegmentId.value = null
    segmentPoints.value = []
    await persistMapData()
    renderRouteArrows()
  }

  async function deleteSegment(segment) {
    if (!activeRoute.value || !window.confirm(`删除路段“${segment.name}”？`)) return
    activeRoute.value.segments = activeRoute.value.segments.filter((item) => item.id !== segment.id)
    if (editingSegmentId.value === segment.id) cancelSegment()
    await persistMapData()
    renderRouteArrows()
  }

  async function toggleRouteVisibility(route) {
    if (activeRouteId.value !== route.id) {
      activeRouteId.value = route.id
      if (route.isHidden) {
        route.isHidden = false
        await persistMapData()
        renderRouteArrows()
      }
      return
    }
    route.isHidden = !route.isHidden
    await persistMapData()
    renderRouteArrows()
  }

  async function toggleSegmentVisibility(segment) {
    segment.isHidden = !segment.isHidden
    await persistMapData()
    renderRouteArrows()
  }

  // 组件生命周期：注册地图、快捷键、监听器并在卸载时释放资源。
  function handleKeydown(event) {
    if (event.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
      event.preventDefault()
      searchInput.value?.focus()
    }
    if (event.key === 'Escape') {
      previewImage.value = ''
      editorFormOpen.value = false
      selectedLocation.value = null
      clearCompletedConfirming.value = false
      searchInput.value?.blur()
    }
  }

  watch([filteredLocations, completedIds, () => selectedLocation.value?.id], () => nextTick(renderMarkers), { deep: true })
  watch(filteredLocations, (visibleLocations) => {
    if (selectedLocation.value && !visibleLocations.some((location) => location.id === selectedLocation.value.id)) {
      selectedLocation.value = null
    }
  })
  watch(activeDistricts, async () => {
    if (skipNextDistrictAutoFit) {
      skipNextDistrictAutoFit = false
      return
    }
    if (!districtAutoFitReady) return
    await nextTick()
    const focusLocations = filteredLocations.value.filter((location) => !isTeleportLocation(location))
    fitLocationsBounds(focusLocations.length ? focusLocations : filteredLocations.value)
  }, { deep: true })
  watch(activeDistricts, persistMarkerFilters, { deep: true })
  watch(activeRouteId, () => {
    if (isAddingSegment.value) {
      isAddingSegment.value = false
      editingSegmentId.value = null
      segmentPoints.value = []
    }
    nextTick(renderRouteArrows)
  })
  watch([() => [...activeCategories.value], keepTeleportEnabled, showIncompleteOnly, showFavoritesOnly], persistMarkerFilters)
  watch(editorMode, () => {
    if (!editorMode.value) showPendingLocationChangesOnly.value = false
  })
  watch(pendingLocationFilterCount, () => {
    if (!pendingLocationFilterCount.value) showPendingLocationChangesOnly.value = false
  })
  watch(mergeAdjacentLocationsEnabled, () => {
    persistMarkerFilters()
    rebuildMarkerLayer()
  })
  watch(realtimeNavigationEnabled, () => {
    persistMarkerFilters()
    if (realtimeNavigationEnabled.value) connectNavigationSocket()
    else {
      disconnectNavigationSocket()
    }
  })
  watch(centerNavigationEnabled, () => {
    persistMarkerFilters()
    if (!centerNavigationEnabled.value) stopNavigationFollow()
    renderNavigationArrow()
  })
  watch(navigationWildcardHostWarning, (hasWarning) => {
    if (hasWarning) showStatus(navigationWildcardHostWarningMessage)
  })
  watch(sidebarFooterOpen, persistMarkerFilters)
  watch(districtFilterOpen, persistMarkerFilters)
  watch(collapsedCategoryGroups, persistMarkerFilters, { deep: true })

  onMounted(async () => {
    await loadLatestMapData()
    mapData.value.locations = locations.value.map(normalizeLocationCoordinates).filter(Boolean)
    mapData.value.routes = normalizeRoutes(routes.value)
    const storedRoutes = readStoredRoutes()
    if (storedRoutes) mapData.value.routes = normalizeRoutes(storedRoutes)
    restoreMarkerFilters()
    map = L.map(mapElement.value, {
      crs: L.CRS.Simple,
      minZoom: MIN_ZOOM,
      maxZoom: 1,
      maxBounds: bounds.pad(0.18),
      zoomControl: false,
      attributionControl: false,
    })
    L.tileLayer(publicAssetUrl('/tiles/{z}/{x}/{y}.jpg'), {
      bounds,
      minZoom: MIN_ZOOM,
      maxNativeZoom: 0,
      maxZoom: 1,
      noWrap: true,
      tileSize: TILE_SIZE,
      keepBuffer: 3,
    }).addTo(map)
    L.control.zoom({ position: 'bottomright' }).addTo(map)
    markerLayer = createMarkerLayer().addTo(map)
    arrowLayer = L.layerGroup().addTo(map)
    map.on('mousemove', ({ latlng }) => {
      coordinates.value = {
        ...mapLatLngToMapLocator(latlng),
        ...mapLatLngToGame(latlng),
      }
    })
    map.on('click', ({ latlng }) => {
      selectedLocation.value = null
      if (isAddingSegment.value) addRouteCoordinate(mapLatLngToGame(latlng))
      else if (editorMode.value) openCreateLocation(mapLatLngToGame(latlng))
      renderMarkers()
    })
    map.on('moveend zoomend', () => {
      persistMapView()
      updateMapView()
    })
    if (!restoreMapView()) resetView()
    updateMapView()
    mapElement.value.dataset.minZoom = String(map.getMinZoom())
    mapElement.value.dataset.initialZoom = String(map.getZoom())
    renderMarkers()
    mapViewPersistenceReady = true
    persistMapView()
    districtAutoFitReady = true
    if (realtimeNavigationEnabled.value) connectNavigationSocket()
    window.addEventListener('keydown', handleKeydown)
  })

  onUnmounted(() => {
    navigationClientStopped = true
    if (navigationReconnectTimer) window.clearTimeout(navigationReconnectTimer)
    if (navigationRenderFrame) window.cancelAnimationFrame(navigationRenderFrame)
    navigationSocket?.close()
    stopNavigationFollow(false)
    navigationMarker?.remove()
    navigationArrowElement = null
    navigationArrowImage = null
    navigationMarkerVisible = false
    navigationAngleMissing = null
    window.removeEventListener('keydown', handleKeydown)
    map?.remove()
  })

  return {
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
    focusSegment,
    getRoutePointLabel,
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
    moveSegmentPoint,
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
    removeSegmentPoint,
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
  }
}
