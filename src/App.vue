<script setup>
import { computed, ref } from 'vue'
import { useMapApp } from './composables/useMapApp'
import announcement from './data/announcements.json'

// App.vue 保留页面结构，所有交互状态和业务动作都由组合函数提供。
const {
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
  navigationAutoCompleteEnabled,
  navigationAutoCompleteRadius,
  navigationConnectionLabel,
  navigationConnectionStatus,
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
} = useMapApp()

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
</script>

<template>
  <main class="app-shell">
    <div ref="mapElement" class="map-canvas" />

    <header class="topbar glass-panel">
      <div class="brand-block topbar-brand">
        <img class="brand-mark" :src="publicAssetUrl('/logo.png')" alt="MaaNTE" />
        <div>
          <p class="eyebrow">MaaNTE Map</p>
          <h1>MaaNTE在线地图工具</h1>
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
                      <img v-if="category.iconUrl" :src="publicAssetUrl(category.iconUrl)" alt="" />
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
          <label v-if="realtimeNavigationEnabled" class="switch-row">
            <span><b>到达自动完成</b><small>圈内已完成点半透明显示</small></span>
            <input v-model="navigationAutoCompleteEnabled" type="checkbox" /><i />
          </label>
          <div v-if="realtimeNavigationEnabled && navigationAutoCompleteEnabled" class="navigation-endpoint-row">
            <span><b>完成半径</b><small>{{ navigationAutoCompleteRadius }} 坐标单位</small></span>
            <div class="navigation-endpoint-fields">
              <label>
                <span>半径</span>
                <input v-model.number="navigationAutoCompleteRadius" type="number" min="0.1" max="20" step="0.1" inputmode="decimal" @change="applyNavigationAutoCompleteRadius" />
              </label>
            </div>
          </div>
          <div v-if="realtimeNavigationEnabled" class="navigation-endpoint-row">
            <span><b>监听地址</b><small>{{ navigationWebSocketUrl }}</small></span>
            <div class="navigation-endpoint-fields">
              <label>
                <span>IP</span>
                <input v-model.trim="navigationHost" type="text" inputmode="url" autocomplete="off" @change="applyNavigationEndpoint" />
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
        <div class="route-auto-planner">
          <label>
            <span>自动规划数量</span>
            <input v-model.number="autoRouteLimit" type="number" min="1" max="100" step="1" inputmode="numeric" />
          </label>
          <button
            type="button"
            :disabled="!canCreateAutoRoute"
            :title="canCreateAutoRoute ? '' : '需要实时定位，并至少有 1 个当前可见未完成点位'"
            @click="createAutoRoute"
          >
            自动规划
          </button>
          <small>{{ autoRouteCandidates.length }} 个可选点</small>
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
        <span>坐标</span><code>{{ selectedLocation.lat.toFixed(6) }}, {{ selectedLocation.lng.toFixed(6) }}</code><small>复制</small>
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
      <span>LAT {{ coordinates.lat.toFixed(2) }}</span><span>LNG {{ coordinates.lng.toFixed(2) }}</span>
      <span class="navigation-status" :class="`navigation-status--${navigationConnectionStatus}`">NAVI {{ navigationConnectionLabel }}</span>
      <span v-if="navigationState.position">POS {{ navigationState.position.pixelX.toFixed(0) }}, {{ navigationState.position.pixelY.toFixed(0) }}</span>
      <span v-if="navigationState.angle !== null">ANGLE {{ navigationState.angle.toFixed(1) }}°</span>
    </div>
    <div v-if="editorMode" class="editor-tip glass-panel">编辑模式：点击地图空白处添加点位</div>
    <div v-if="statusMessage" class="status-toast glass-panel">{{ statusMessage }}</div>

    <div v-if="editorFormOpen" class="modal-backdrop" @click.self="editorFormOpen = false">
      <form class="editor-form glass-panel" @submit.prevent="saveLocation">
        <div class="sidebar-heading"><h2>{{ editingLocationId ? '编辑点位' : '新建点位' }}</h2><button type="button" class="close-button" @click="editorFormOpen = false">×</button></div>
        <label>点位 ID<input v-model.trim="locationForm.locationId" :disabled="!!editingLocationId" placeholder="留空自动生成 local ID" /></label>
        <label>名称<input v-model="locationForm.name" required /></label>
        <label>区域<select v-model="locationForm.district">
          <option v-for="district in districtOptions" :key="district" :value="district">{{ district }}</option>
        </select></label>
        <div class="form-grid"><label>LAT<input v-model.number="locationForm.lat" type="number" step="any" /></label><label>LNG<input v-model.number="locationForm.lng" type="number" step="any" /></label></div>
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
