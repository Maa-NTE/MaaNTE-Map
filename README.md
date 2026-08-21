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
- `map.tileUrl`：MapSource 仓库的瓦片模板。生产构建默认读取
  `https://raw.githubusercontent.com/Maa-NTE/MapSource/main/tiles/{z}/{x}/{y}.jpg`；
  本地开发通过 Vite 映射到同一份 sibling `MapSource/tiles`，可用
  `VITE_MAP_TILE_URL` 覆盖。
- `categories`：本地分类定义。分类可通过 `isHidden: true` 暂时从浏览界面隐藏。
- `locations`：点位数据，支持多类型、描述、标签和截图。
- `routes`：路线与有序路段。

历史导入快照已经通过 Python 脚本清洗。脚本也可以重复执行，用于删除误加入的冗余字段：

```powershell
npm run clean:locations
```

## 编辑地图

点击页面右上角的“编辑地图”：

1. 点击地图空白处新建点位。
2. 在点位详情中编辑或删除点位。
3. 一个点位可以选择多个类型，也可以添加可复用的自定义类型。
4. 点位可以上传多张截图，详情页支持预览。
5. 路线面板可以新建路线，再依次点击标点建立路段。

图片会先在浏览器内暂存，保存点位时按点位 ID 和图片内容哈希生成稳定路径。通过本地开发服务器编辑时，点位会写回 `src/data/map-data.json`，截图会写入 `public/images/locations/<点位 ID>/`；取消表单或移除尚未保存的图片不会产生孤儿文件。

保存或删除点位后，本次会话的变更会累计到编辑工具栏的“导出点位修改包”中。生产构建和 GitHub Pages 等静态部署中，点位表单的“确认”只会暂存当前修改；可以连续编辑多个点位，最后从顶部工具栏一次性导出修改包。导出的 ZIP 同时包含 `location-changes.json` 和本次修改引用的图片，可直接交给仓库合并脚本处理，不依赖服务端上传接口。开启编辑模式后可导入旧版点位 JSON 或新版 ZIP 修改包。路线编辑仍保存在浏览器本地存储中，并可通过路线面板导入或导出 JSON 文件。

在仓库根目录合并修改包：

```powershell
npm run merge:locations -- C:/Users/owo/Downloads/MaaNTE-location-changes-2026-07-16.zip
git status --short
```

合并脚本会先校验图片路径、格式、大小和 SHA-256，再统一更新地图数据与 `public/images/locations/`。旧版 `location-changes.json` 仍可继续合并；使用 `--dry-run` 可以只检查和查看统计而不写入文件。

如果删除的是本次会话刚创建的点位，该点位会直接从累计修改中移除，不生成删除记录；仅由该点位使用的本次新建分类也会一并移除。

探索进度保存在浏览器本地存储中。页面右上角的探索进度区域支持导入或导出完成记录 JSON，便于在不同浏览器或设备间迁移。

在分类和“区域筛选”中分别选择一个或多个标签、区域，即可直接点击“一键完成”，将所有已选区域内命中任一已选标签的点位标记为已完成。点位会自动去重；开启“传送点保持开启”时附带显示的传送点不会计入标签选择。

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

`npm run dev` 会通过 Vite 中间件提供仅用于本地编辑的接口：

- `GET /api/map-data`：读取最新的 `src/data/map-data.json`。
- `POST /api/map-data`：写回地图数据。
- `POST /api/location-image?path=...`：校验内容哈希后把点位截图写入 `public/images/locations/`。
- `DELETE /api/location-image?path=...`：清理本次会话已移除且不再使用的点位截图。
- `POST /api/upload-image`：保留的旧版截图上传接口。

`npm run build` 生成的静态站点不会直接写仓库文件，而是生成可由 `merge:locations` 合并的修改包。

### 修改流程

1. 运行 `npm install` 安装依赖。
2. 运行 `npm run dev`，在浏览器中检查交互和编辑写入。
3. 修改分类或点位后，按需运行 `npm run clean:locations` 统一数据格式。
4. 提交前运行 `npm run build`、`npm run qa:location-bundle`、`npm run qa:static-location-bundle` 和 `npm run qa`。

## 坐标与扩图

点位和路线持久化为游戏真实坐标 `x/y`。渲染时使用
`src/data/navi-coordinate-calibration.json` 中的标定点解出二维仿射变换：

```text
[pixelX, pixelY] = affine([gameX, gameY])
```

仿射变换同时处理平移、缩放、轻微旋转和剪切。定位服务和路线下发使用
`13056 × 13056` 的 MapLocator 像素坐标；Leaflet 坐标仅用于页面内部渲染。

坐标转换关系如下：

```text
游戏真实坐标 ⇄ 标定像素坐标 ⇄ Leaflet CRS.Simple 坐标
```

更新标定文件后，点位、路线、鼠标坐标和 WebSocket 路径点会统一使用新的变换。
本次 `13-bigworldmap-1` 相对旧 44×44 图从左侧扩 1 个瓦片、顶部扩 7 个瓦片，
右侧扩 6 个瓦片，底部不变。对未变化区域做像素配准后，旧图内容在新图中的有效
偏移约为 `(466, 3477)` 全分辨率像素，即定位坐标原点增加 `(233, 1738)`；
`mapLocatorSourceWidth/Height` 从 `11264` 更新为 `13056`。已有真实坐标未修改。

原始大图和压缩分层瓦片位于独立的
[`Maa-NTE/MapSource`](https://github.com/Maa-NTE/MapSource) 仓库，Map 仓库只保留
瓦片地址引用。`13-bigworldmap-2` 仅用于本地拼图对比，输出到 `output/map_bigworld_13-2.png`，
不会进入 Git。

## 验证

```powershell
npm run build
npm run qa:location-bundle
npm run qa:static-location-bundle
npm run qa
```

## MaaNTE 实时定位

页面默认连接 `ws://127.0.0.1:14514`，接收 MaaNTE 的 Navi 定位状态，并在地图上展示玩家位置箭头、像素坐标和朝向角度。

在 MaaNTE 中运行 `MapLocator.json` 提供的 `NaviWebSocket` 节点即可同时启动 NCC 定位、方向预测和本地广播。

需要使用其他地址时，在构建前设置 `VITE_MAANTE_NAVI_WEBSOCKET_URL`。消息格式如下：

完整的双向消息、路线控制和错误响应定义见 [地图站 WebSocket 接口文档](docs/websocket-api.md)。

```json
{
  "type": "navi-state",
  "version": 1,
  "position": {
    "pixelX": 5788,
    "pixelY": 8902,
    "score": 0.82,
    "mode": "local",
    "sourceWidth": 13056,
    "sourceHeight": 13056
  },
  "angle": 123.4,
  "angleConfidence": 0.96,
  "timestamp": 1770000000.0
}
```
