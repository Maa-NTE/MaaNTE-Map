import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import L from 'leaflet'
import 'leaflet.markercluster'
import {
  initialMapData,
  MAP_CONFIG,
  MAP_HEIGHT,
  MAP_WIDTH,
  TILE_SIZE,
  mapPixelToMapLatLng,
  mapLatLngToWorld,
  worldToMapLatLng,
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
  NAVIGATION_AUTO_COMPLETE_UPDATE_INTERVAL,
  NAVIGATION_CENTER_MAX_STEP_PX,
  NAVIGATION_CENTER_SMOOTHING,
  NAVIGATION_CENTER_TOLERANCE_PX,
  NAVIGATION_AUTO_COMPLETE_DEFAULT_RADIUS,
  NAVIGATION_AUTO_COMPLETE_MAX_RADIUS,
  NAVIGATION_AUTO_COMPLETE_MIN_RADIUS,
  NAVIGATION_RECONNECT_DELAY,
  ROUTES_STORAGE_KEY,
} from '../constants/mapApp'
import { clone, publicAssetUrl } from '../utils/assets'
import {
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
    if (/�/.test(label) && label.endsWith('图')) return '全地图'
    if (/^[鍏ㄥ湴鍥?]+$/.test(label)) return '全地图'
    if (/^全.*图$/.test(label)) return '全地图'
    return label
  }

  function normalizeAutoCompleteRadius(value) {
    const radius = Number(value)
    if (!Number.isFinite(radius)) return NAVIGATION_AUTO_COMPLETE_DEFAULT_RADIUS
    return Math.min(
      Math.max(radius, NAVIGATION_AUTO_COMPLETE_MIN_RADIUS),
      NAVIGATION_AUTO_COMPLETE_MAX_RADIUS,
    )
  }

  function normalizeAutoRouteLimit(value) {
    const limit = Math.trunc(Number(value))
    if (!Number.isFinite(limit)) return 20
    return Math.min(Math.max(limit, 1), 100)
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
  const navigationAutoCompleteEnabled = ref(storedMarkerFilters?.navigationAutoCompleteEnabled === true)
  const navigationAutoCompleteRadius = ref(normalizeAutoCompleteRadius(storedMarkerFilters?.navigationAutoCompleteRadius))
  const defaultNavigationEndpoint = parseNavigationWebSocketUrl(DEFAULT_NAVIGATION_WEBSOCKET_URL)
  const navigationProtocol = ref(normalizeNavigationProtocol(storedMarkerFilters?.navigationProtocol || defaultNavigationEndpoint.protocol))
  const navigationHost = ref(normalizeNavigationHost(storedMarkerFilters?.navigationHost || defaultNavigationEndpoint.host))
  const navigationPort = ref(normalizeNavigationPort(storedMarkerFilters?.navigationPort || defaultNavigationEndpoint.port))
  const coordinates = ref({ lat: 0, lng: 0 })
  const navigationWorldPosition = ref(null)
  const sidebarCollapsed = ref(false)
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
  const autoRouteLimit = ref(20)
  const routeImportInput = ref(null)
  const completedImportInput = ref(null)
  const locationChangesImportInput = ref(null)
  const collapsedCategoryGroups = ref(initialCollapsedCategoryGroups)
  const navigationConnection = ref('disconnected')
  const navigationState = ref({
    position: null,
    angle: null,
    angleConfidence: 0,
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
  const navigationWebSocketUrl = computed(() => `${normalizeNavigationProtocol(navigationProtocol.value)}://${normalizeNavigationHost(navigationHost.value)}:${normalizeNavigationPort(navigationPort.value)}`)

  const emptyLocationForm = () => ({
    locationId: '',
    name: '',
    types: [],
    district: '全地图',
    lat: 0,
    lng: 0,
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
  let navigationAutoCompleteRadiusCircle
  let navigationSocket
  let navigationReconnectTimer
  let navigationClientStopped = false
  let navigationDisplayAngle = null
  let navigationFollowFrame = 0
  let navigationFollowLatLng = null
  let navigationRenderFrame = 0
  let pendingNavigationState = null
  let navigationAutoCompleteLastUpdate = 0
  const navigationAutoCompleteEnteredIds = ref(new Set())
  const navigationAutoCompleteNearbyIds = ref(new Set())
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

  function isLocationWithinAutoCompleteRadius(location) {
    return navigationAutoCompleteEnabled.value && navigationAutoCompleteNearbyIds.value.has(location.id)
  }

  function isLocationVisibleByStaticFilters(location) {
    const keyword = query.value.trim().toLowerCase()
    const categoryVisible = location.types.some((type) => activeCategories.value.has(type))
    const districtLabel = normalizeDistrictLabel(location.district)
    const districtVisible = !activeDistricts.value.size
      || activeDistricts.value.has(districtLabel)
      || (districtLabel === '全地图' && isTeleportLocation(location))
    const favoriteVisible = !showFavoritesOnly.value || favoriteIds.value.has(location.id)
    const pendingVisible = !showPendingLocationChangesOnly.value || pendingLocationChangeIds.value.has(location.id)
    const typeLabels = location.types.map((type) => categoryLookup.value[type]?.label || type)
    const text = `${location.name} ${districtLabel} ${location.tags.join(' ')} ${typeLabels.join(' ')}`.toLowerCase()
    return categoryVisible && districtVisible && favoriteVisible && pendingVisible && (!keyword || text.includes(keyword))
  }

  const filteredLocations = computed(() => {
    return locations.value.filter((location) => {
      const completed = completedIds.value.has(location.id)
      const completedInAutoCompleteRadius = completed && isLocationWithinAutoCompleteRadius(location)
      const incompleteVisible = !showIncompleteOnly.value || !completed || completedInAutoCompleteRadius
      const autoCompleteVisible = !navigationAutoCompleteEnabled.value || !completed || completedInAutoCompleteRadius
      return isLocationVisibleByStaticFilters(location) && incompleteVisible && autoCompleteVisible
    })
  })

  const visibleCounts = computed(() =>
    Object.fromEntries(visibleCategories.value.map((category) => [
      category.id,
      locations.value.filter((location) => location.types.includes(category.id)).length,
    ])),
  )
  const autoRouteCandidates = computed(() => getAutoRouteCandidates())
  const canCreateAutoRoute = computed(() => (
    Boolean(navigationWorldPosition.value)
    && Number.isFinite(Number(autoRouteLimit.value))
    && Number(autoRouteLimit.value) >= 1
    && autoRouteCandidates.value.length > 0
  ))

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
      navigationAutoCompleteEnabled: navigationAutoCompleteEnabled.value,
      navigationAutoCompleteRadius: normalizeAutoCompleteRadius(navigationAutoCompleteRadius.value),
      navigationProtocol: normalizeNavigationProtocol(navigationProtocol.value),
      navigationHost: normalizeNavigationHost(navigationHost.value),
      navigationPort: normalizeNavigationPort(navigationPort.value),
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
    const blobUrl = URL.createObjectURL(new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' }))
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
    return category?.iconUrl
      ? `<img src="${publicAssetUrl(category.iconUrl)}" alt="" />`
      : category?.icon || '·'
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
      map.flyTo(worldToMapLatLng(location), Math.max(map.getZoom(), -2), { duration: 0.45 })
    }
  }

  function addRouteMarker(locationId) {
    if (!isAddingSegment.value) return
    const location = locationLookup.value[locationId]
    if (!location || segmentPoints.value.at(-1)?.locationId === locationId) return
    segmentPoints.value = [...segmentPoints.value, {
      locationId,
      lat: location.lat,
      lng: location.lng,
    }]
    renderRouteArrows()
  }

  function addRouteCoordinate(point) {
    if (!isAddingSegment.value) return
    const previous = segmentPoints.value.at(-1)
    if (previous && previous.lat === point.lat && previous.lng === point.lng) return
    segmentPoints.value = [...segmentPoints.value, {
      lat: Number(point.lat.toFixed(6)),
      lng: Number(point.lng.toFixed(6)),
    }]
    renderRouteArrows()
  }

  function renderMarkers() {
    if (!markerLayer) return
    markerLayer.clearLayers()
    markerLookup.clear()
    filteredLocations.value.forEach((location) => {
      const marker = L.marker(worldToMapLatLng(location), {
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
    const start = worldToMapLatLng(from)
    const end = worldToMapLatLng(to)
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
      return location ? { locationId: point, lat: location.lat, lng: location.lng } : null
    }
    if (!point || typeof point !== 'object') return null
    const location = point.locationId ? locationLookup.value[point.locationId] : null
    const lat = Number(location?.lat ?? point.lat)
    const lng = Number(location?.lng ?? point.lng)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    return {
      ...(point.locationId ? { locationId: String(point.locationId) } : {}),
      lat,
      lng,
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
    return `${index + 1}. ${normalized.lat.toFixed(2)}, ${normalized.lng.toFixed(2)}`
  }

  function updateSegmentPoint(index, latlng) {
    const point = mapLatLngToWorld(latlng)
    segmentPoints.value = segmentPoints.value.map((item, pointIndex) => (
      pointIndex === index
        ? { lat: Number(point.lat.toFixed(6)), lng: Number(point.lng.toFixed(6)) }
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
    const marker = L.marker(worldToMapLatLng(point), {
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
        L.circleMarker(worldToMapLatLng(point), {
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
    const image = navigationMarker?.getElement()?.querySelector('.navigation-arrow img')
    if (image) image.style.transform = `rotate(${navigationDisplayAngle}deg)`
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

  function hideAutoCompleteRadiusCircle() {
    navigationAutoCompleteRadiusCircle?.remove()
    navigationAutoCompleteRadiusCircle = null
  }

  function renderAutoCompleteRadiusCircle(latlng) {
    if (!map || !navigationAutoCompleteEnabled.value || !latlng) {
      hideAutoCompleteRadiusCircle()
      return
    }

    const radius = normalizeAutoCompleteRadius(navigationAutoCompleteRadius.value)
    navigationAutoCompleteRadius.value = radius
    const circleRadius = radius * MAP_CONFIG.pixelsPerWorldUnit

    if (!navigationAutoCompleteRadiusCircle) {
      navigationAutoCompleteRadiusCircle = L.circle(latlng, {
        radius: circleRadius,
        interactive: false,
        className: 'navigation-auto-complete-radius',
        color: '#a3efe2',
        weight: 1.5,
        opacity: 0.82,
        fillColor: '#a3efe2',
        fillOpacity: 0.08,
      }).addTo(map)
      return
    }

    navigationAutoCompleteRadiusCircle.setLatLng(latlng)
    navigationAutoCompleteRadiusCircle.setRadius(circleRadius)
  }

  function updateAutoCompleteNearbyLocations(position, { force = false } = {}) {
    if (!navigationAutoCompleteEnabled.value || !position) {
      if (navigationAutoCompleteNearbyIds.value.size) navigationAutoCompleteNearbyIds.value = new Set()
      return
    }

    const now = window.performance?.now?.() ?? Date.now()
    if (!force && now - navigationAutoCompleteLastUpdate < NAVIGATION_AUTO_COMPLETE_UPDATE_INTERVAL) return
    navigationAutoCompleteLastUpdate = now

    const currentLat = Number(position.lat)
    const currentLng = Number(position.lng)
    if (!Number.isFinite(currentLat) || !Number.isFinite(currentLng)) return

    const radius = normalizeAutoCompleteRadius(navigationAutoCompleteRadius.value)
    navigationAutoCompleteRadius.value = radius
    const radiusSquared = radius ** 2
    const nearbyIds = new Set(locations.value.filter((location) => {
      if (!isLocationVisibleByStaticFilters(location)) return false
      const lat = Number(location.lat)
      const lng = Number(location.lng)
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false
      return (lat - currentLat) ** 2 + (lng - currentLng) ** 2 <= radiusSquared
    }).map((location) => location.id))

    const previousNearbyKey = [...navigationAutoCompleteNearbyIds.value].sort().join('|')
    const nextNearbyKey = [...nearbyIds].sort().join('|')
    if (nextNearbyKey !== previousNearbyKey) {
      navigationAutoCompleteNearbyIds.value = nearbyIds
    }

    const nextEnteredIds = new Set(navigationAutoCompleteEnteredIds.value)
    const previouslyEnteredKey = [...nextEnteredIds].sort().join('|')
    const nearbyIncompleteIds = [...nearbyIds].filter((locationId) => !completedIds.value.has(locationId))
    const newlyCompleted = []
    navigationAutoCompleteEnteredIds.value.forEach((locationId) => {
      if (completedIds.value.has(locationId)) {
        nextEnteredIds.delete(locationId)
        return
      }

      const location = locationLookup.value[locationId]
      if (!location) {
        nextEnteredIds.delete(locationId)
        return
      }

      const lat = Number(location.lat)
      const lng = Number(location.lng)
      const isOutside = !Number.isFinite(lat)
        || !Number.isFinite(lng)
        || (lat - currentLat) ** 2 + (lng - currentLng) ** 2 > radiusSquared
      if (!isOutside) return

      newlyCompleted.push(location)
      nextEnteredIds.delete(locationId)
    })

    nearbyIncompleteIds.forEach((locationId) => nextEnteredIds.add(locationId))
    const nextEnteredKey = [...nextEnteredIds].sort().join('|')
    if (nextEnteredKey !== previouslyEnteredKey) {
      navigationAutoCompleteEnteredIds.value = nextEnteredIds
    }

    if (!newlyCompleted.length) return

    const next = new Set(completedIds.value)
    newlyCompleted.forEach((location) => next.add(location.id))
    completedIds.value = next
    localStorage.setItem(COMPLETED_STORAGE_KEY, JSON.stringify([...next]))
    showStatus(`离开附近，自动完成 ${newlyCompleted.length} 个点位`)
  }

  function renderNavigationArrow({ forceAutoComplete = false } = {}) {
    if (!map || !navigationState.value.position) {
      navigationMarker?.setOpacity(0)
      navigationWorldPosition.value = null
      if (navigationAutoCompleteNearbyIds.value.size) navigationAutoCompleteNearbyIds.value = new Set()
      hideAutoCompleteRadiusCircle()
      stopNavigationFollow()
      return
    }
    const latlng = L.latLng(mapPixelToMapLatLng(navigationState.value.position))
    const worldPosition = mapLatLngToWorld(latlng)
    if (!navigationMarker) {
      navigationMarker = L.marker(latlng, {
        icon: createNavigationIcon(),
        interactive: false,
        keyboard: false,
        zIndexOffset: 1000000,
      }).addTo(map)
    }
    navigationMarker.setLatLng(latlng)
    navigationMarker.setOpacity(1)
    centerNavigationMarker(latlng)
    renderAutoCompleteRadiusCircle(latlng)
    coordinates.value = worldPosition
    navigationWorldPosition.value = worldPosition
    updateAutoCompleteNearbyLocations(worldPosition, { force: forceAutoComplete })
    const arrow = navigationMarker.getElement()?.querySelector('.navigation-arrow')
    if (arrow) {
      arrow.classList.toggle('navigation-arrow--angle-missing', navigationState.value.angle === null)
    }
    updateNavigationMarkerAngle(navigationState.value.angle)
  }

  function clearNavigationState() {
    if (navigationRenderFrame) {
      window.cancelAnimationFrame(navigationRenderFrame)
      navigationRenderFrame = 0
    }
    pendingNavigationState = null
    navigationState.value = {
      position: null,
      angle: null,
      angleConfidence: 0,
    }
    navigationDisplayAngle = null
    navigationWorldPosition.value = null
    navigationAutoCompleteEnteredIds.value = new Set()
    navigationAutoCompleteNearbyIds.value = new Set()
    navigationAutoCompleteLastUpdate = 0
    hideAutoCompleteRadiusCircle()
    renderNavigationArrow()
  }

  function flushNavigationState() {
    navigationRenderFrame = 0
    if (!pendingNavigationState) return
    navigationState.value = pendingNavigationState
    pendingNavigationState = null
    renderNavigationArrow()
  }

  function scheduleNavigationRender(nextState) {
    pendingNavigationState = nextState
    if (!navigationRenderFrame) {
      navigationRenderFrame = window.requestAnimationFrame(flushNavigationState)
    }
  }

  function handleNavigationMessage(event) {
    try {
      const payload = JSON.parse(event.data)
      if (payload.type !== 'navi-state' || payload.version !== 1) return
      const pixelX = Number(payload.position?.pixelX)
      const pixelY = Number(payload.position?.pixelY)
      const sourceWidth = Number(payload.position?.sourceWidth)
      const sourceHeight = Number(payload.position?.sourceHeight)
      const angle = Number(payload.angle)
      scheduleNavigationRender({
        position: Number.isFinite(pixelX) && Number.isFinite(pixelY)
          ? {
              pixelX,
              pixelY,
              sourceWidth: Number.isFinite(sourceWidth) && sourceWidth > 0 ? sourceWidth : MAP_WIDTH,
              sourceHeight: Number.isFinite(sourceHeight) && sourceHeight > 0 ? sourceHeight : MAP_HEIGHT,
            }
          : null,
        angle: payload.angle !== null && Number.isFinite(angle) ? angle : null,
        angleConfidence: Number(payload.angleConfidence) || 0,
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
    persistMarkerFilters()
    if (realtimeNavigationEnabled.value) {
      disconnectNavigationSocket()
      connectNavigationSocket()
    }
  }

  function applyNavigationAutoCompleteRadius() {
    navigationAutoCompleteRadius.value = normalizeAutoCompleteRadius(navigationAutoCompleteRadius.value)
    persistMarkerFilters()
  }

  function focusSegment(segment) {
    if (!map) return
    const points = getSegmentPoints(segment).map(worldToMapLatLng)
    if (points.length) map.flyToBounds(L.latLngBounds(points), { padding: [80, 80], duration: 0.45 })
  }

  function fitLocationsBounds(targetLocations) {
    if (!map || !targetLocations.length) return
    if (targetLocations.length === 1) {
      map.flyTo(worldToMapLatLng(targetLocations[0]), -1, { duration: 0.45 })
      return
    }
    const points = targetLocations.map(worldToMapLatLng)
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
            ? { lat: point.lat, lng: point.lng }
            : point
        ))
        delete segment.markerIds
      })
    })
  }

  function normalizeLocationChanges(payload) {
    if (!payload || payload.type !== 'location-changes') throw new Error('invalid location changes')
    const categories = Array.isArray(payload.categories)
      ? payload.categories
          .filter((category) => category && typeof category === 'object' && typeof category.id === 'string')
          .map((category) => ({
            ...category,
            group: normalizeCategoryGroup(category),
          }))
      : []
    const upsertLocations = Array.isArray(payload.upsertLocations)
      ? payload.upsertLocations.filter((location) => location && typeof location === 'object' && typeof location.id === 'string')
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
      const changes = normalizeLocationChanges(JSON.parse(await file.text()))
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
    } catch {
      showStatus('点位修改 JSON 格式无效')
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
    navigator.clipboard?.writeText(`${selectedLocation.value.lat.toFixed(6)}, ${selectedLocation.value.lng.toFixed(6)}`)
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
      lat: Number(form.lat),
      lng: Number(form.lng),
      description: form.description.trim(),
      tags: form.tagsText.split(',').map((tag) => tag.trim()).filter(Boolean),
      images: [...form.images],
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
  function getAutoRouteCandidates() {
    return filteredLocations.value.filter((location) => {
      if (completedIds.value.has(location.id)) return false
      const lat = Number(location.lat)
      const lng = Number(location.lng)
      return Number.isFinite(lat) && Number.isFinite(lng)
    })
  }

  function distanceBetweenPoints(a, b) {
    return Math.hypot(Number(a.lat) - Number(b.lat), Number(a.lng) - Number(b.lng))
  }

  function buildNearestNeighborRoute(start, candidates, limit) {
    const remaining = candidates.slice()
    const route = []
    let cursor = start
    const count = Math.min(normalizeAutoRouteLimit(limit), remaining.length)

    while (route.length < count && remaining.length) {
      let nearestIndex = 0
      let nearestDistance = distanceBetweenPoints(cursor, remaining[0])
      for (let index = 1; index < remaining.length; index += 1) {
        const distance = distanceBetweenPoints(cursor, remaining[index])
        if (distance < nearestDistance) {
          nearestIndex = index
          nearestDistance = distance
        }
      }
      const [next] = remaining.splice(nearestIndex, 1)
      route.push(next)
      cursor = next
    }

    return route
  }

  function routeLengthFromStart(start, points) {
    let length = 0
    let cursor = start
    points.forEach((point) => {
      length += distanceBetweenPoints(cursor, point)
      cursor = point
    })
    return length
  }

  function optimizeRouteWithTwoOpt(start, points) {
    const route = points.slice()
    if (route.length < 3) return route

    let improved = true
    while (improved) {
      improved = false
      for (let i = 0; i < route.length - 1; i += 1) {
        for (let k = i + 1; k < route.length; k += 1) {
          const previous = routeLengthFromStart(start, route)
          const candidate = [
            ...route.slice(0, i),
            ...route.slice(i, k + 1).reverse(),
            ...route.slice(k + 1),
          ]
          if (routeLengthFromStart(start, candidate) + 1e-9 < previous) {
            route.splice(0, route.length, ...candidate)
            improved = true
          }
        }
      }
    }

    return route
  }

  function formatAutoRouteTimestamp(date = new Date()) {
    const pad = (value) => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  async function createAutoRoute() {
    const start = navigationWorldPosition.value
    if (!start) {
      showStatus('请先开启实时定位')
      return
    }

    autoRouteLimit.value = normalizeAutoRouteLimit(autoRouteLimit.value)
    const candidates = getAutoRouteCandidates()
    if (!candidates.length) {
      showStatus('当前筛选下没有可规划的未完成点位')
      return
    }

    const nearest = buildNearestNeighborRoute(start, candidates, autoRouteLimit.value)
    const optimized = optimizeRouteWithTwoOpt(start, nearest)
    const now = Date.now()
    const points = [
      {
        lat: Number(start.lat.toFixed(6)),
        lng: Number(start.lng.toFixed(6)),
      },
      ...optimized.map((location) => ({
        locationId: location.id,
        lat: Number(location.lat),
        lng: Number(location.lng),
      })),
    ]
    const route = {
      id: `route-${now}`,
      name: `自动规划 ${formatAutoRouteTimestamp()}`,
      isHidden: false,
      segments: [{
        id: `segment-${now}`,
        name: '当前位置出发',
        isHidden: false,
        points,
      }],
    }

    cancelSegment()
    mapData.value.routes.push(route)
    activeRouteId.value = route.id
    routePanelOpen.value = true
    await persistMapData()
    renderRouteArrows()
    showStatus(`已规划 ${optimized.length} 个点位`)
  }

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
  watch(navigationAutoCompleteEnabled, () => {
    persistMarkerFilters()
    if (!navigationAutoCompleteEnabled.value) {
      navigationAutoCompleteEnteredIds.value = new Set()
      navigationAutoCompleteNearbyIds.value = new Set()
      navigationAutoCompleteLastUpdate = 0
      hideAutoCompleteRadiusCircle()
    }
    renderNavigationArrow({ forceAutoComplete: true })
    nextTick(renderMarkers)
  })
  watch(navigationAutoCompleteRadius, () => {
    persistMarkerFilters()
    navigationAutoCompleteLastUpdate = 0
    renderNavigationArrow({ forceAutoComplete: true })
    nextTick(renderMarkers)
  })
  watch(districtFilterOpen, persistMarkerFilters)
  watch(collapsedCategoryGroups, persistMarkerFilters, { deep: true })

  onMounted(async () => {
    await loadLatestMapData()
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
    map.on('mousemove', ({ latlng }) => { coordinates.value = mapLatLngToWorld(latlng) })
    map.on('click', ({ latlng }) => {
      selectedLocation.value = null
      if (isAddingSegment.value) addRouteCoordinate(mapLatLngToWorld(latlng))
      else if (editorMode.value) openCreateLocation(mapLatLngToWorld(latlng))
      renderMarkers()
    })
    map.on('moveend', persistMapView)
    if (!restoreMapView()) resetView()
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
    navigationSocket?.close()
    if (navigationRenderFrame) window.cancelAnimationFrame(navigationRenderFrame)
    stopNavigationFollow(false)
    navigationMarker?.remove()
    hideAutoCompleteRadiusCircle()
    window.removeEventListener('keydown', handleKeydown)
    map?.remove()
  })

  return {
    activeCategories,
    activeDistricts,
    activeRoute,
    activeRouteId,
    addCustomType,
    applyNavigationAutoCompleteRadius,
    applyNavigationEndpoint,
    autoRouteCandidates,
    autoRouteLimit,
    beginClearCompleted,
    bulkCompleteCategoryIds,
    bulkIncompleteCount,
    cancelClearCompleted,
    cancelSegment,
    categoryLookup,
    centerNavigationEnabled,
    canCreateAutoRoute,
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
    createAutoRoute,
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
    mergeAdjacentLocationsEnabled,
    moveSegmentPoint,
    navigationConnectionLabel,
    navigationConnectionStatus,
    navigationAutoCompleteEnabled,
    navigationAutoCompleteRadius,
    navigationHost,
    navigationPort,
    navigationState,
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
    showFavoritesOnly,
    showIncompleteOnly,
    showPendingLocationChangesOnly,
    sidebarCollapsed,
    startSegment,
    statusMessage,
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
