# MaaNTE 在线地图工具

基于 Vue 3、Leaflet 和 Vite 的本地交互式地图。

## 启动

```powershell
npm install
npm run dev
```

开发服务器默认运行在 `http://127.0.0.1:5173`

## 本地数据

地图数据维护在 `src/data/map-data.json`，不再从第三方接口同步。文件包括：

- `map`：底图像素尺寸、瓦片尺寸、世界原点像素与缩放比例。
- `categories`：本地分类定义。分类可通过 `isHidden: true` 暂时从浏览界面隐藏。
- `locations`：点位数据，支持多类型、描述、标签和截图。
- `routes`：路线与有序路段。

历史导入快照已经通过 Python 脚本清洗。脚本也可以重复执行，用于删除误加入的冗余字段：

```powershell
npm run clean:locations
```

## 编辑地图

通过 `npm run dev` 启动本地开发服务器后，点击页面右上角的“编辑地图”：

1. 点击地图空白处新建点位。
2. 在点位详情中编辑或删除点位。
3. 一个点位可以选择多个类型，也可以添加可复用的自定义类型。
4. 点位可以上传多张截图，详情页支持预览。
5. 路线面板可以新建路线，再依次点击标点建立路段。

本地点位编辑结果写回 `src/data/map-data.json`，截图保存在 `public/images/uploads/`。保存或删除点位后，本次会话的变更会累计到编辑工具栏的“导出点位修改”中；生产构建和 GitHub Pages 等静态部署还会在每次操作后自动导出仅包含该次新增、修改或删除内容的点位修改 JSON。开启编辑模式后可通过“导入点位修改”同步应用。路线编辑会保存在浏览器本地存储中，并可通过路线面板导入或导出 JSON 文件。

如果删除的是本次会话刚创建的点位，该点位会直接从累计修改中移除，不生成删除记录；仅由该点位使用的本次新建分类也会一并移除。

探索进度保存在浏览器本地存储中。页面右上角的探索进度区域支持导入或导出完成记录 JSON，便于在不同浏览器或设备间迁移。

在分类和“区域筛选”中分别选择一个或多个标签、区域，即可直接点击“一键完成”，将所有已选区域内命中任一已选标签的点位标记为已完成。点位会自动去重；开启“传送点保持开启”时附带显示的传送点不会计入标签选择。

开启实时定位后，可打开“到达自动完成”并设置完成半径。玩家位置进入半径后会记录当前筛选可见且尚未完成的点位，离开半径后自动写入完成记录；已完成点位平时隐藏，重新进入半径时会半透明显示。

隐藏分类仍然会出现在编辑表单的“类型（可多选）”列表中，用于继续维护点位数据。隐藏分类不会出现在浏览侧边栏、地图标记、点位详情标签和探索进度中。当前暂时隐藏“异象委托”和“资源”分组下的所有类型。

编辑表单中的“搜索关键词（可选）”用于补充搜索命中词，不是点位类型。关键词使用英文逗号分隔，不会出现在分类侧边栏中。

## 开发说明

### 目录结构

- `src/App.vue`：地图界面、筛选、编辑器和路线交互。
- `src/data/map-data.json`：可编辑的地图数据快照。
- `src/data/locations.js`：地图坐标转换。
- `vite.config.js`：Vite 配置，以及仅在开发服务器中启用的本地写入接口。

### 分类字段

每个 `categories` 条目包含以下字段：

- `id`：稳定标识，点位通过 `types` 数组引用它。
- `group`、`label`：侧边栏分组和显示名称。
- `icon`、`color`：地图标记样式。
- `isDefault`：保留的导入字段。
- `isHidden`：可选。设为 `true` 时仅在编辑器中保留，不进入浏览界面。

暂时隐藏分类时不要删除分类或点位数据；设置 `isHidden: true` 即可。恢复展示时移除该字段或改为 `false`。

通过编辑器添加的自定义类型会写入 `categories`，并自动勾选到当前点位。新增时必须填写稳定的类型 ID，并可以选择已有标记大类；也可以填写“新建大类（可选）”，将类型归入新的侧边栏分组。若填写的 ID 已存在，编辑器会依次追加 `-2`、`-3` 等数字后缀。后续编辑其他点位时可以直接复用。

### 本地接口

`npm run dev` 会通过 Vite 中间件提供两个仅用于本地编辑的接口：

- `GET /api/map-data`：读取最新的 `src/data/map-data.json`。
- `POST /api/map-data`：写回地图数据。
- `POST /api/upload-image`：把点位截图写入 `public/images/uploads/`。

`npm run build` 生成的静态站点不包含写入能力。

### 修改流程

1. 运行 `npm install` 安装依赖。
2. 运行 `npm run dev`，在浏览器中检查交互和编辑写入。
3. 修改分类或点位后，按需运行 `npm run clean:locations` 统一数据格式。
4. 提交前运行 `npm run build` 和 `npm run qa`。

## 坐标与扩图

点位持久化为游戏世界坐标。渲染时使用固定变换：

```text
pixelX = worldOriginPixel.x + lng * pixelsPerWorldUnit
pixelY = worldOriginPixel.y - lat * pixelsPerWorldUnit
```

当前配置为 `44 px / 世界坐标单位`，世界原点位于像素 `(11264, 11264)`。

扩图时不要按新图片尺寸重新缩放已有点位：

- 向右或向下追加 `512 × 512` 瓦片：只更新 `map.width` 或 `map.height`。
- 向左追加瓦片：增加 `map.worldOriginPixel.x`。
- 向上追加瓦片：增加 `map.worldOriginPixel.y`。

这样旧点位不会因为底图尺寸变化而漂移。

## 验证

```powershell
npm run build
npm run qa
```

## MaaNTE 实时定位

页面会自动连接 `ws://127.0.0.1:8765`，接收 MaaNTE 的 Navi 定位状态，并在地图上展示玩家位置箭头、像素坐标和朝向角度。

在 MaaNTE 中运行 `MapLocator.json` 提供的 `NaviWebSocket` 节点即可同时启动 NCC 定位、方向预测和本地广播。

需要使用其他地址时，在构建前设置 `VITE_MAANTE_NAVI_WEBSOCKET_URL`。消息格式如下：

```json
{
  "type": "navi-state",
  "version": 1,
  "position": {
    "pixelX": 5788,
    "pixelY": 8902,
    "score": 0.82,
    "mode": "local",
    "sourceWidth": 11264,
    "sourceHeight": 11264
  },
  "angle": 123.4,
  "angleConfidence": 0.96,
  "timestamp": 1770000000.0
}
```
